import { afterEach, describe, expect, it } from 'bun:test';
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
			expect(sqlite.query('SELECT COUNT(*) AS count FROM checks').get()).toEqual({ count: 2 });
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
