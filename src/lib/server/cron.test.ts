import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { runCronChecks } from './cron';
import { scheduled } from './scheduler';

const databases: Database[] = [];
afterEach(() => {
	for (const database of databases.splice(0)) database.close();
});

function fixture() {
	const sqlite = new Database(':memory:');
	databases.push(sqlite);
	sqlite.exec(
		readFileSync(new URL('../../../migrations/0001_schema.sql', import.meta.url), 'utf8')
	);
	sqlite.exec(
		readFileSync(
			new URL('../../../migrations/0007_check_confirmation.sql', import.meta.url),
			'utf8'
		)
	);
	const script = JSON.stringify({
		steps: [
			{
				name: 'health',
				request: { method: 'GET', url: 'https://example.com' },
				assert: [{ check: 'status', equals: 200 }]
			}
		]
	});
	const insert = sqlite.query(
		'INSERT INTO monitors(id,name,script,interval_seconds,active) VALUES (?,?,?,?,?)'
	);
	for (const id of ['g', 'a', 'e', 'b', 'f', 'c', 'd']) {
		insert.run(id, id, script, 0, 1);
		sqlite
			.query(
				"INSERT INTO checks(monitor_id,status,checked_at) VALUES (?,'up','2000-01-01 00:00:00')"
			)
			.run(id);
	}
	insert.run('inactive', 'inactive', script, 0, 0);
	let calls = 0;
	const db = {
		prepare(sql: string) {
			calls++;
			let bindings: (string | number | null)[] = [];
			const statement = {
				bind(...values: (string | number | null)[]) {
					bindings = values;
					return statement;
				},
				async all() {
					return { results: sqlite.query(sql).all(...bindings), success: true };
				},
				async first() {
					return sqlite.query(sql).get(...bindings);
				},
				async run() {
					const result = sqlite.query(sql).run(...bindings);
					return { success: true, meta: { changes: result.changes } };
				}
			};
			return statement;
		}
	} as unknown as D1Database;
	return { sqlite, db, calls: () => calls };
}

async function withHealthyFetch<T>(run: () => Promise<T>) {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = originalFetch;
	}
}

describe('cron partitions', () => {
	it('notifies a recovery from the newest check when timestamps are tied', async () => {
		const { sqlite, db } = fixture();
		sqlite.exec("UPDATE monitors SET active = 0 WHERE id != 'a';");
		sqlite.exec(`INSERT INTO checks(monitor_id,status,checked_at) VALUES
			('a','up','2001-01-01 00:00:00'),('a','down','2001-01-01 00:00:00');
			INSERT INTO notification_channels(id,type,name,config) VALUES
			('webhook','webhook','Recovery','{"url":"https://notify.example.com","method":"POST"}');
			INSERT INTO monitor_notifications(monitor_id,channel_id) VALUES ('a','webhook');`);
		const notifications: Record<string, unknown>[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (input, init) => {
			if (String(input) === 'https://notify.example.com') {
				notifications.push(JSON.parse(String(init?.body)));
			}
			return new Response(null, { status: 200 });
		}) as typeof fetch;
		try {
			const result = await runCronChecks(db);
			expect(result.successful).toBe(1);
			expect(notifications).toHaveLength(1);
			expect(notifications[0]).toMatchObject({
				monitor_id: 'a',
				previous_status: 'down',
				status: 'up'
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
	it('checks every active monitor exactly once across stable shards despite insertion order', async () => {
		const { sqlite, db } = fixture();
		const partitions: string[][] = [];
		await withHealthyFetch(async () => {
			for (let shardIndex = 0; shardIndex < 3; shardIndex++) {
				const before = sqlite.query('SELECT MAX(id) AS id FROM checks').get() as { id: number };
				const result = await runCronChecks(db, { shardIndex, shardCount: 3 });
				const written = sqlite
					.query('SELECT monitor_id FROM checks WHERE id > ? ORDER BY monitor_id')
					.all(before.id) as { monitor_id: string }[];
				partitions.push(written.map((row) => row.monitor_id));
				expect(result.checked).toBe(written.length);
				expect(result.failed).toBe(0);
			}
		});
		expect(partitions).toEqual([
			['a', 'd', 'g'],
			['b', 'e'],
			['c', 'f']
		]);
	});

	it('uses the latest persisted timestamp to skip a monitor before its interval is due', async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(
			"UPDATE monitors SET active = 0 WHERE id != 'a'; UPDATE monitors SET interval_seconds = 3600 WHERE id = 'a';"
		);
		sqlite
			.query("INSERT INTO checks(monitor_id,status,checked_at) VALUES ('a','up',?)")
			.run(new Date().toISOString());
		const result = await withHealthyFetch(() => runCronChecks(db));
		expect(result.checked).toBe(0);
		expect(result.skipped).toBe(1);
		expect(
			sqlite.query("SELECT COUNT(*) AS count FROM checks WHERE monitor_id = 'a'").get()
		).toEqual({ count: 2 });
	});

	it('persists sibling results when one monitor cannot save its check', async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(`CREATE TRIGGER reject_one_check BEFORE INSERT ON checks
			WHEN NEW.monitor_id = 'a' BEGIN SELECT RAISE(ABORT, 'write unavailable'); END;`);
		const result = await withHealthyFetch(() => runCronChecks(db));
		expect(result.checked).toBe(7);
		expect(result.successful).toBe(6);
		expect(result.failed).toBe(1);
		expect(
			sqlite
				.query("SELECT COUNT(*) AS count FROM checks WHERE checked_at != '2000-01-01 00:00:00'")
				.get()
		).toEqual({ count: 6 });
	});

	it.each([
		{ shardIndex: 0, shardCount: 0 },
		{ shardIndex: -1, shardCount: 3 },
		{ shardIndex: 3, shardCount: 3 },
		{ shardIndex: 0.5, shardCount: 3 },
		{ shardIndex: 0, shardCount: 1.5 }
	])('rejects invalid partition options before reading the database: %j', async (options) => {
		const { db, calls } = fixture();
		await expect(runCronChecks(db, options)).rejects.toThrow();
		expect(calls()).toBe(0);
	});
});

describe('failure confirmation', () => {
	it('preserves each failed POST attempt, confirms on the next cron, and notifies public transitions', async () => {
		const { sqlite, db } = fixture();
		const script = JSON.stringify({
			steps: [{ name: 'write', request: { method: 'POST', url: 'https://probe.example.com' } }]
		});
		sqlite.exec("UPDATE monitors SET active = 0 WHERE id != 'a'");
		sqlite
			.query("UPDATE monitors SET script = ?, interval_seconds = 300 WHERE id = 'a'")
			.run(script);
		sqlite.exec(`INSERT INTO notification_channels(id,type,name,config) VALUES
			('webhook','webhook','Changes','{"url":"https://notify.example.com","method":"POST"}');
			INSERT INTO monitor_notifications(monitor_id,channel_id) VALUES ('a','webhook');`);
		let now = Date.now();
		const startedAt = now;
		const clock = spyOn(Date, 'now').mockImplementation(() => now);
		const originalFetch = globalThis.fetch;
		const requests: string[] = [];
		const notifications: Record<string, unknown>[] = [];
		let isHealthy = false;
		globalThis.fetch = (async (input, init) => {
			if (String(input) === 'https://notify.example.com') {
				notifications.push(JSON.parse(String(init?.body)));
				return new Response(null, { status: 200 });
			}
			requests.push(init?.method ?? 'GET');
			if (!isHealthy) throw new Error('Network timeout');
			return new Response(null, { status: 200, headers: { 'cf-ray': 'abcdef-SCL' } });
		}) as typeof fetch;
		try {
			await runCronChecks(db);
			expect(requests).toEqual(['POST']);
			expect(notifications).toHaveLength(0);
			expect(
				sqlite
					.query(
						"SELECT status,observed_status FROM checks WHERE monitor_id = 'a' ORDER BY id DESC LIMIT 1"
					)
					.get()
			).toEqual({ status: 'degraded', observed_status: 'down' });
			now = startedAt + 29000;
			expect((await runCronChecks(db)).checked).toBe(0);
			now = startedAt + 60000;
			await runCronChecks(db);
			expect(requests).toEqual(['POST', 'POST']);
			expect(notifications).toMatchObject([{ previous_status: 'degraded', status: 'down' }]);
			now += 60000;
			isHealthy = true;
			await runCronChecks(db);
			expect(requests).toEqual(['POST', 'POST', 'POST']);
			expect(notifications).toMatchObject([
				{ previous_status: 'degraded', status: 'down' },
				{ previous_status: 'down', status: 'up' }
			]);
			expect(
				sqlite
					.query(
						"SELECT status,observed_status,error_message FROM checks WHERE monitor_id = 'a' AND observed_status IS NOT NULL ORDER BY id"
					)
					.all()
			).toEqual([
				{
					status: 'degraded',
					observed_status: 'down',
					error_message: expect.stringContaining('Network timeout')
				},
				{
					status: 'down',
					observed_status: 'down',
					error_message: expect.stringContaining('Network timeout')
				},
				{ status: 'up', observed_status: 'up', error_message: null }
			]);
			expect(
				sqlite
					.query("SELECT cf_ray FROM checks WHERE monitor_id = 'a' ORDER BY id DESC LIMIT 1")
					.get()
			).toEqual({ cf_ray: 'abcdef-SCL' });
		} finally {
			globalThis.fetch = originalFetch;
			clock.mockRestore();
		}
	});

	it.each([
		{ label: 'a successful check', status: 'up', observed: 'up', age: 60000 },
		{ label: 'a slow check', status: 'degraded', observed: 'degraded', age: 60000 },
		{ label: 'an unclassified historical failure', status: 'down', observed: null, age: 60000 },
		{ label: 'a monitoring gap', status: 'degraded', observed: 'down', age: 3600000 }
	])('does not confirm a failure after $label', async ({ status, observed, age }) => {
		const { sqlite, db } = fixture();
		const now = Date.now();
		sqlite.exec("UPDATE monitors SET active = 0 WHERE id != 'a'");
		const insert = sqlite.query(
			'INSERT INTO checks(monitor_id,status,observed_status,checked_at) VALUES (?,?,?,?)'
		);
		insert.run(
			'a',
			'degraded',
			'down',
			new Date(now - age - 60000).toISOString().replace('T', ' ').slice(0, 19)
		);
		insert.run(
			'a',
			status,
			observed,
			new Date(now - age).toISOString().replace('T', ' ').slice(0, 19)
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error('Network timeout');
		}) as typeof fetch;
		try {
			await runCronChecks(db);
			expect(
				sqlite
					.query(
						"SELECT status,observed_status FROM checks WHERE monitor_id = 'a' ORDER BY id DESC LIMIT 1"
					)
					.get()
			).toEqual({ status: 'degraded', observed_status: 'down' });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('does not announce a recovery when an unconfirmed failure succeeds on the next cron', async () => {
		const { sqlite, db } = fixture();
		sqlite.exec("UPDATE monitors SET active = 0 WHERE id != 'a'");
		sqlite
			.query(
				"INSERT INTO checks(monitor_id,status,observed_status,checked_at) VALUES ('a','degraded','down',?)"
			)
			.run(new Date(Date.now() - 60000).toISOString().replace('T', ' ').slice(0, 19));
		sqlite.exec(`INSERT INTO notification_channels(id,type,name,config) VALUES
			('webhook','webhook','Changes','{"url":"https://notify.example.com","method":"POST"}');
			INSERT INTO monitor_notifications(monitor_id,channel_id) VALUES ('a','webhook');`);
		const originalFetch = globalThis.fetch;
		const requests: string[] = [];
		globalThis.fetch = (async (input) => {
			requests.push(String(input));
			return new Response(null, { status: 200 });
		}) as typeof fetch;
		try {
			await runCronChecks(db);
			expect(requests).toEqual(['https://example.com']);
			expect(
				sqlite
					.query(
						"SELECT status,observed_status FROM checks WHERE monitor_id = 'a' ORDER BY id DESC LIMIT 1"
					)
					.get()
			).toEqual({ status: 'up', observed_status: 'up' });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('schedules from attempt start when a slow request crosses the next minute', async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(
			"UPDATE monitors SET active = 0 WHERE id != 'a'; UPDATE monitors SET interval_seconds = 60 WHERE id = 'a'"
		);
		let now = Math.floor(Date.now() / 1000) * 1000;
		const startedAt = now;
		const clock = spyOn(Date, 'now').mockImplementation(() => now);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			now += 15000;
			return new Response(null, { status: 200 });
		}) as typeof fetch;
		try {
			await runCronChecks(db);
			const check = sqlite
				.query("SELECT checked_at FROM checks WHERE monitor_id = 'a' ORDER BY id DESC LIMIT 1")
				.get() as { checked_at: string };
			const timestamp = check.checked_at.includes('T')
				? check.checked_at
				: check.checked_at.replace(' ', 'T') + 'Z';
			expect(Date.parse(timestamp)).toBe(startedAt);
			now = startedAt + 60000;
			expect((await runCronChecks(db)).checked).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
			clock.mockRestore();
		}
	});
});

describe('scheduled lifecycle', () => {
	function controller(cron: string) {
		return { cron, scheduledTime: Date.now(), noRetry() {} } as ScheduledController;
	}

	it('executes the configured shard directly without a cron secret', async () => {
		const { sqlite, db } = fixture();
		await withHealthyFetch(() =>
			scheduled(controller('* * * * *'), {
				DB: db,
				MONITOR_SHARD_INDEX: '1',
				MONITOR_SHARD_COUNT: '3'
			})
		);
		expect(
			sqlite
				.query(
					"SELECT monitor_id FROM checks WHERE checked_at != '2000-01-01 00:00:00' ORDER BY monitor_id"
				)
				.all()
		).toEqual([{ monitor_id: 'b' }, { monitor_id: 'e' }]);
	});

	it('aggregates yesterday and cleans old history on the daily trigger without health requests', async () => {
		const { sqlite, db } = fixture();
		const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
		const insert = sqlite.query('INSERT INTO checks(monitor_id,status,checked_at) VALUES (?,?,?)');
		insert.run('a', 'up', yesterday + ' 01:00:00');
		insert.run('a', 'down', yesterday + ' 02:00:00');
		const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
		const thirtyOneDaysAgo = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
		insert.run('a', 'up', tenDaysAgo + ' 01:00:00');
		insert.run('a', 'up', thirtyOneDaysAgo + ' 01:00:00');
		sqlite.exec(
			"INSERT INTO daily_status(monitor_id,date,total_checks) VALUES ('a','2000-01-01',1)"
		);
		const originalFetch = globalThis.fetch;
		let requests = 0;
		globalThis.fetch = (async () => {
			requests++;
			throw new Error('Daily maintenance must not run health checks');
		}) as typeof fetch;
		try {
			await scheduled(controller('0 0 * * *'), { DB: db });
			expect(requests).toBe(0);
			expect(
				sqlite.query('SELECT date,total_checks,up_checks,down_checks FROM daily_status').all()
			).toEqual([{ date: yesterday, total_checks: 2, up_checks: 1, down_checks: 1 }]);
			expect(sqlite.query('SELECT COUNT(*) AS count FROM checks').get()).toEqual({ count: 3 });
			expect(
				sqlite
					.query('SELECT COUNT(*) AS count FROM checks WHERE checked_at LIKE ?')
					.get(tenDaysAgo + '%')
			).toEqual({ count: 1 });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
