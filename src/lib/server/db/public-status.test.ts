import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';
import { getMonitorHistory, historyCutoff, DAILY_COUNTS_SQL } from './history';
import {
	getPublicGroupSummaries,
	getGroupWithStatusBySlug,
	getPublicGroupsWithStatus,
	getAllGroupsWithStatus
} from './groups';
import { getPublicIncidents, groupIncidentDates } from './public-incidents';
import { readD1 } from './diagnostics';
import { aggregateDailyStatus } from './status';
import { getUptime24h } from './monitors';
import { GET as getMonitors } from '../../../routes/api/monitors/+server';

const databases: Database[] = [];
let info: ReturnType<typeof spyOn<typeof console, 'info'>>;
beforeEach(() => {
	info = spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
	for (const database of databases.splice(0)) database.close();
	info.mockRestore();
});

function fixture(beforeConfirmation?: (sqlite: Database) => void) {
	const sqlite = new Database(':memory:');
	databases.push(sqlite);
	sqlite.exec(
		readFileSync(new URL('../../../../migrations/0001_schema.sql', import.meta.url), 'utf8')
	);
	beforeConfirmation?.(sqlite);
	sqlite.exec(
		readFileSync(
			new URL('../../../../migrations/0007_check_confirmation.sql', import.meta.url),
			'utf8'
		)
	);
	sqlite.exec(`INSERT INTO monitor_groups(id,name,slug,is_public) VALUES
  ('public','Public','public',1),('private','Private','private',0),('empty','Empty','empty',1);
  INSERT INTO monitors(id,name,script,group_id) VALUES
  ('one','One','{}','public'),('two','Two','{}','public'),('secret','Secret','{}','private');`);
	let calls = 0;
	const db = {
		prepare(sql: string) {
			let bindings: (string | number | null)[] = [];
			const stmt = {
				bind(...values: (string | number | null)[]) {
					bindings = values;
					return stmt;
				},
				async all() {
					calls++;
					const results = sqlite.query(sql).all(...bindings);
					return { results, success: true, meta: { duration: 2, rows_read: 100, rows_written: 0 } };
				},
				async first() {
					calls++;
					return sqlite.query(sql).get(...bindings);
				},
				async run() {
					calls++;
					const result = sqlite.query(sql).run(...bindings);
					return { success: true, meta: { changes: result.changes } };
				}
			};
			return stmt;
		}
	} as unknown as D1Database;
	return { sqlite, db, calls: () => calls };
}

function day(offset: number) {
	const now = new Date();
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset))
		.toISOString()
		.slice(0, 10);
}

describe('historical check confirmation migration', () => {
	it.each([
		{
			name: 'one failure between successes',
			statuses: ['up', 'down', 'up'],
			seconds: [0, 60, 120],
			confirmed: 0,
			isolated: 1,
			legacy: 0,
			bars: ['up']
		},
		{
			name: 'a consecutive pair',
			statuses: ['up', 'down', 'down', 'up'],
			seconds: [0, 60, 120, 180],
			confirmed: 2,
			isolated: 0,
			legacy: 0,
			bars: ['down']
		},
		{
			name: 'failures separated by a success',
			statuses: ['up', 'down', 'up', 'down', 'up'],
			seconds: [0, 60, 120, 180, 240],
			confirmed: 0,
			isolated: 2,
			legacy: 0,
			bars: ['up']
		},
		{
			name: 'failures separated by a degraded response',
			statuses: ['up', 'down', 'degraded', 'down', 'up'],
			seconds: [0, 60, 120, 180, 240],
			confirmed: 0,
			isolated: 2,
			legacy: 0,
			bars: ['degraded']
		},
		{
			name: 'a pair inserted out of chronological order',
			statuses: ['up', 'down', 'up', 'down'],
			seconds: [0, 120, 180, 60],
			confirmed: 2,
			isolated: 0,
			legacy: 0,
			bars: ['down']
		},
		{
			name: 'a pair across midnight',
			statuses: ['up', 'down', 'down', 'up'],
			seconds: [86280, 86340, 86400, 86460],
			confirmed: 2,
			isolated: 0,
			legacy: 0,
			bars: ['down', 'down']
		},
		{
			name: 'a long monitoring gap',
			statuses: ['up', 'down', 'down', 'up'],
			seconds: [0, 60, 600, 660],
			confirmed: 0,
			isolated: 2,
			legacy: 0,
			bars: ['up']
		},
		{
			name: 'tied timestamps ordered by insertion',
			statuses: ['up', 'down', 'up', 'down', 'up'],
			seconds: [0, 60, 60, 120, 180],
			confirmed: 0,
			isolated: 2,
			legacy: 0,
			bars: ['up']
		},
		{
			name: 'duplicate attempts below the confirmation minimum',
			statuses: ['up', 'down', 'down', 'up'],
			seconds: [0, 60, 60, 120],
			confirmed: 0,
			isolated: 2,
			legacy: 0,
			bars: ['up']
		},
		{
			name: 'missing context at both edges',
			statuses: ['down', 'up', 'down'],
			seconds: [0, 60, 120],
			confirmed: 0,
			isolated: 0,
			legacy: 2,
			bars: ['degraded']
		},
		{
			name: 'a confirmed pair at the retention edges',
			statuses: ['down', 'down'],
			seconds: [0, 60],
			confirmed: 2,
			isolated: 0,
			legacy: 0,
			bars: ['down']
		}
	])(
		'classifies $name without deleting or rewriting the observed evidence',
		async ({ statuses, seconds, confirmed, isolated, legacy, bars }) => {
			const date = day(-3);
			let original: unknown[] = [];
			const { sqlite, db } = fixture((database) => {
				database.exec("INSERT INTO monitors(id,name,script) VALUES ('history','History','{}')");
				const insert = database.query(
					"INSERT INTO checks(monitor_id,status,error_message,checked_at) VALUES ('history',?,?,?)"
				);
				for (const [index, status] of statuses.entries()) {
					const timestamp = new Date(Date.parse(date + 'T00:00:00Z') + seconds[index] * 1000)
						.toISOString()
						.replace('T', ' ')
						.slice(0, 19);
					insert.run(status, status === 'down' ? 'Original timeout' : null, timestamp);
				}
				original = database
					.query('SELECT id,monitor_id,status,error_message,checked_at FROM checks ORDER BY id')
					.all();
			});
			expect(
				sqlite
					.query(
						'SELECT id,monitor_id,COALESCE(observed_status,status) AS status,error_message,checked_at FROM checks ORDER BY id'
					)
					.all()
			).toEqual(original);
			const history = await getMonitorHistory(db, 'history');
			const populated = history.dailyStatus.filter((row) => row.total_checks > 0);
			expect(populated.map((row) => row.status)).toEqual(bars);
			expect(populated.reduce((sum, row) => sum + row.confirmed_down_checks, 0)).toBe(confirmed);
			expect(populated.reduce((sum, row) => sum + row.unconfirmed_checks, 0)).toBe(isolated);
			expect(populated.reduce((sum, row) => sum + row.legacy_down_checks, 0)).toBe(legacy);
			expect(history.uptime90d).toBe(
				Math.round(((statuses.length - confirmed - legacy) / statuses.length) * 10000) / 100
			);
		}
	);

	it('does not confirm failures from different monitors', async () => {
		const date = day(-3);
		const { db } = fixture((sqlite) => {
			sqlite.exec(
				"INSERT INTO monitors(id,name,script) VALUES ('first','First','{}'),('second','Second','{}')"
			);
			const insert = sqlite.query(
				'INSERT INTO checks(monitor_id,status,checked_at) VALUES (?,?,?)'
			);
			for (const monitor of ['first', 'second']) {
				insert.run(monitor, 'up', date + ' 00:00:00');
				insert.run(monitor, 'down', date + (monitor === 'first' ? ' 00:01:00' : ' 00:02:00'));
				insert.run(monitor, 'up', date + ' 00:03:00');
			}
		});
		for (const monitor of ['first', 'second']) {
			const history = await getMonitorHistory(db, monitor);
			expect(history.uptime90d).toBe(100);
			expect(history.dailyStatus.find((row) => row.date === date)).toMatchObject({
				status: 'up',
				total_checks: 3,
				unconfirmed_checks: 1,
				confirmed_down_checks: 0
			});
		}
	});

	it('rebuilds fully retained aggregates but preserves partial and missing sequences with explicit inference', async () => {
		const date = day(-3);
		const { sqlite, db } = fixture((database) => {
			const monitor = database.query("INSERT INTO monitors(id,name,script) VALUES (?,?,'{}')");
			for (const id of ['complete', 'partial', 'single', 'multiple', 'unknown'])
				monitor.run(id, id);
			const check = database.query(
				'INSERT INTO checks(monitor_id,status,checked_at) VALUES (?,?,?)'
			);
			for (const id of ['complete', 'partial']) {
				for (const [index, status] of ['up', 'down', 'up'].entries())
					check.run(id, status, date + ` 00:0${index}:00`);
			}
			const aggregate = database.query(
				'INSERT INTO daily_status(monitor_id,date,total_checks,up_checks,down_checks,degraded_checks,downtime_minutes) VALUES (?,?,?,?,?,0,?)'
			);
			aggregate.run('complete', date, 3, 2, 1, 480);
			aggregate.run('partial', date, 100, 98, 2, 2);
			aggregate.run('single', date, 1440, 1439, 1, 1);
			aggregate.run('multiple', date, 1440, 1438, 2, 2);
			aggregate.run('unknown', date, 10, 9, 1, 144);
		});
		const complete = await getMonitorHistory(db, 'complete');
		expect(complete.uptime90d).toBe(100);
		expect(complete.dailyStatus.find((row) => row.date === date)).toMatchObject({
			status: 'up',
			total_checks: 3,
			unconfirmed_checks: 1,
			inferred_isolated_checks: 0,
			legacy_down_checks: 0
		});
		const partial = await getMonitorHistory(db, 'partial');
		// Classify the retained singleton without replacing the 100-check total or guessing the other failure.
		expect(partial.uptime90d).toBe(99);
		expect(partial.dailyStatus.find((row) => row.date === date)).toMatchObject({
			status: 'degraded',
			total_checks: 100,
			unconfirmed_checks: 1,
			legacy_down_checks: 1,
			confirmed_down_checks: 0
		});
		const inferred = await getMonitorHistory(db, 'single');
		expect(inferred.uptime90d).toBe(100);
		expect(inferred.dailyStatus.find((row) => row.date === date)).toMatchObject({
			status: 'up',
			total_checks: 1440,
			unconfirmed_checks: 1,
			inferred_isolated_checks: 1,
			legacy_down_checks: 0,
			downtime_minutes: 0
		});
		const multiple = await getMonitorHistory(db, 'multiple');
		expect(multiple.dailyStatus.find((row) => row.date === date)).toMatchObject({
			status: 'degraded',
			unconfirmed_checks: 0,
			inferred_isolated_checks: 0,
			legacy_down_checks: 2,
			confirmed_down_checks: 0
		});
		const unknown = await getMonitorHistory(db, 'unknown');
		expect(unknown.uptime90d).toBe(90);
		expect(unknown.dailyStatus.find((row) => row.date === date)).toMatchObject({
			status: 'degraded',
			inferred_isolated_checks: 0,
			legacy_down_checks: 1
		});
		sqlite.exec('DELETE FROM checks');
		expect(await getMonitorHistory(db, 'complete')).toEqual(complete);
		expect(await getMonitorHistory(db, 'single')).toEqual(inferred);
	});
});

describe('public status data', () => {
	it('publishes only daily colors and downtime while retaining isolated and inferred evidence for admins', async () => {
		const { sqlite, db } = fixture();
		const insert = sqlite.query(`INSERT INTO daily_status
			(monitor_id,date,total_checks,up_checks,down_checks,degraded_checks,downtime_minutes,
			unconfirmed_checks,inferred_isolated_checks,legacy_down_checks)
			VALUES ('one',?,?,?,?,?,?,?,?,?)`);
		insert.run(day(-3), 100, 98, 2, 0, 29, 0, 0, 2);
		insert.run(day(-2), 1440, 1439, 0, 1, 0, 1, 1, 0);
		insert.run(day(-1), 1, 0, 0, 1, 0, 1, 0, 0);
		const publicGroups = await getPublicGroupsWithStatus(db);
		const publicDetail = await getGroupWithStatusBySlug(db, 'public');
		for (const group of [
			publicGroups.find((candidate) => candidate.id === 'public'),
			publicDetail
		]) {
			const monitor = group?.monitors.find((candidate) => candidate.id === 'one');
			expect(monitor?.daily_status.filter((row) => row.status !== 'none')).toEqual([
				{ date: day(-3), status: 'degraded', downtime_minutes: 29 },
				{ date: day(-2), status: 'up', downtime_minutes: 0 },
				{ date: day(-1), status: 'up', downtime_minutes: 0 }
			]);
		}
		const adminGroups = await getAllGroupsWithStatus(db);
		const adminMonitor = adminGroups
			.find((group) => group.id === 'public')
			?.monitors.find((monitor) => monitor.id === 'one');
		expect(adminMonitor?.daily_status.find((row) => row.date === day(-3))).toMatchObject({
			status: 'degraded',
			total_checks: 100,
			legacy_down_checks: 2,
			confirmed_down_checks: 0
		});
		expect(adminMonitor?.daily_status.find((row) => row.date === day(-2))).toMatchObject({
			status: 'up',
			unconfirmed_checks: 1,
			inferred_isolated_checks: 1
		});
		expect(adminMonitor?.daily_status.find((row) => row.date === day(-1))).toMatchObject({
			status: 'up',
			unconfirmed_checks: 1,
			inferred_isolated_checks: 0
		});
	});

	it('shows an isolated failure as a green day while retaining its detail and live degraded state', async () => {
		const { sqlite, db } = fixture();
		const yesterday = day(-1);
		sqlite
			.query(
				"INSERT INTO checks(monitor_id,status,observed_status,checked_at,error_message) VALUES ('one','degraded','down',?,'Network timeout')"
			)
			.run(yesterday + ' 23:59:00');
		const history = await getMonitorHistory(db, 'one');
		expect(history.uptime90d).toBe(100);
		expect(history.dailyStatus.find((row) => row.date === yesterday)).toMatchObject({
			status: 'up',
			total_checks: 1,
			unconfirmed_checks: 1,
			confirmed_down_checks: 0,
			legacy_down_checks: 0,
			other_degraded_checks: 0
		});
		const detail = await getGroupWithStatusBySlug(db, 'public');
		expect(detail?.monitors.find((monitor) => monitor.id === 'one')?.current_status).toBe(
			'degraded'
		);
		await aggregateDailyStatus(db);
		sqlite.exec('DELETE FROM checks');
		expect(await getMonitorHistory(db, 'one')).toEqual(history);
	});

	it('keeps slow, soft assertion, and unconfirmed checks visible without reducing availability after aggregation', async () => {
		const { sqlite, db } = fixture();
		const yesterday = day(-1);
		const insert = sqlite.query(
			'INSERT INTO checks(monitor_id,status,observed_status,checked_at,is_slow) VALUES (?,?,?,?,?)'
		);
		insert.run('one', 'up', 'up', yesterday + ' 01:00:00', 0);
		insert.run('one', 'degraded', 'down', yesterday + ' 02:00:00', 0);
		insert.run('one', 'degraded', 'degraded', yesterday + ' 03:00:00', 1);
		insert.run('one', 'down', 'down', yesterday + ' 04:00:00', 0);
		insert.run('one', 'down', null, yesterday + ' 05:00:00', 0);
		insert.run('two', 'degraded', 'down', yesterday + ' 02:00:00', 0);
		insert.run('two', 'degraded', 'degraded', yesterday + ' 03:00:00', 1);
		insert.run('two', 'degraded', 'degraded', yesterday + ' 04:00:00', 0);
		const history = await getMonitorHistory(db, 'one');
		expect(history.uptime90d).toBe(60);
		expect(history.dailyStatus.find((row) => row.date === yesterday)).toMatchObject({
			status: 'down',
			total_checks: 5,
			confirmed_down_checks: 1,
			unconfirmed_checks: 1,
			slow_checks: 1,
			legacy_down_checks: 1,
			other_degraded_checks: 0
		});
		const degradedHistory = await getMonitorHistory(db, 'two');
		expect(degradedHistory.uptime90d).toBe(100);
		expect(degradedHistory.dailyStatus.find((row) => row.date === yesterday)).toMatchObject({
			status: 'degraded',
			total_checks: 3,
			confirmed_down_checks: 0,
			unconfirmed_checks: 1,
			slow_checks: 1,
			legacy_down_checks: 0,
			other_degraded_checks: 1
		});
		const overview = (await getPublicGroupSummaries(db, 'overview')).find(
			(group) => group.id === 'public'
		)!;
		const detail = await getGroupWithStatusBySlug(db, 'public', 'detail');
		expect(overview.uptime_90d).toBe(80);
		expect(detail?.uptime_90d).toBe(80);
		await aggregateDailyStatus(db);
		sqlite.exec('DELETE FROM checks');
		expect(await getMonitorHistory(db, 'one')).toEqual(history);
		expect(await getMonitorHistory(db, 'two')).toEqual(degradedHistory);
		expect(
			(await getPublicGroupSummaries(db, 'aggregated')).find((group) => group.id === 'public')
				?.uptime_90d
		).toBe(80);
	});

	it('computes admin availability in one read, counting degraded checks within the monitor window', async () => {
		const now = Date.parse('2026-11-20T12:00:00Z');
		const clock = spyOn(Date, 'now').mockReturnValue(now);
		try {
			const { sqlite, db, calls } = fixture();
			const insert = sqlite.query(
				'INSERT INTO checks(monitor_id,status,checked_at) VALUES (?,?,?)'
			);
			for (const status of ['up', 'degraded', 'degraded', 'down'])
				insert.run('one', status, '2026-11-20 11:59:00');
			insert.run('one', 'down', '2026-11-19 11:59:59');
			insert.run('one', 'down', '2026-11-19 12:00:00');
			insert.run('two', 'down', '2026-11-20 11:59:00');
			expect(await getUptime24h(db, 'one')).toBe(75);
			expect(calls()).toBe(1);
			expect(await getUptime24h(db, 'secret')).toBe(100);
		} finally {
			clock.mockRestore();
		}
	});

	it('preserves aggregate history after raw cleanup and avoids overlap double counting', async () => {
		const { sqlite, db } = fixture();
		const insert =
			sqlite.query(`INSERT INTO daily_status(monitor_id,date,total_checks,up_checks,down_checks,degraded_checks,downtime_minutes)
   VALUES ('one',?,?,?, ?,0,0)`);
		insert.run(day(-20), 100, 90, 10);
		insert.run(day(-1), 10, 10, 0);
		insert.run(day(-90), 100, 0, 100);
		sqlite
			.query("INSERT INTO checks(monitor_id,status,checked_at) VALUES ('one',?,?)")
			.run('up', day(-1) + ' 10:00:00');
		sqlite
			.query("INSERT INTO checks(monitor_id,status,checked_at) VALUES ('one',?,?)")
			.run('down', day(0) + ' 10:00:00');
		const history = await getMonitorHistory(db, 'one');
		expect(history.uptime90d).toBe(90.09); // 100 up / 111 total
		expect(history.dailyStatus).toHaveLength(90);
		expect(history.dailyStatus[0].date).toBe(day(-89));
		expect(history.dailyStatus.find((row) => row.date === day(-20))?.status).toBe('down');
		expect(history.dailyStatus.at(-1)?.status).toBe('degraded');
		expect(history.dailyStatus[0].status).toBe('none');
	});

	it('preserves a missing aggregate day between completed days and counts UTC boundaries once', async () => {
		const { sqlite, db } = fixture();
		const aggregate = sqlite.query(`INSERT INTO daily_status
   (monitor_id,date,total_checks,up_checks,down_checks,degraded_checks)
   VALUES ('one',?,10,10,0,0)`);
		aggregate.run(day(-4));
		aggregate.run(day(-2));
		const check = sqlite.query(
			"INSERT INTO checks(monitor_id,status,checked_at) VALUES ('one',?,?)"
		);
		check.run('down', day(-4) + ' 12:00:00'); // Ignored: this day is already aggregated.
		check.run('down', day(-3) + ' 00:00:00');
		check.run('up', day(-3) + ' 23:59:59');
		check.run('down', day(-2) + ' 00:00:00'); // Must not leak into the preceding day.
		const history = await getMonitorHistory(db, 'one');
		expect(history.uptime90d).toBe(95.45); // 21 up / 22 total
		expect(history.dailyStatus.find((row) => row.date === day(-3))).toMatchObject({
			status: 'degraded',
			downtime_minutes: 720
		});
		expect(history.dailyStatus.find((row) => row.date === day(-2))?.status).toBe('up');
	});

	it('uses indexed timestamp ranges for missing days instead of scanning every retained check', () => {
		const { sqlite } = fixture();
		const sql = DAILY_COUNTS_SQL.replaceAll('SCOPE', 'm.id = ?');
		const plan = sqlite
			.query('EXPLAIN QUERY PLAN ' + sql)
			.all(day(-89), 'one', day(-89) + ' 00:00:00', 'one') as { detail: string }[];
		expect(
			plan.some(
				(row) =>
					row.detail.includes('idx_checks_monitor_time') &&
					row.detail.includes('monitor_id=? AND checked_at>? AND checked_at<?')
			)
		).toBe(true);
	});

	it('reads raw history for monitors without aggregates while excluding days outside the window', async () => {
		const { sqlite, db } = fixture();
		const check = sqlite.query(
			"INSERT INTO checks(monitor_id,status,checked_at) VALUES ('one',?,?)"
		);
		check.run('down', day(-90) + ' 23:59:59');
		check.run('down', day(-89) + ' 00:00:00');
		check.run('up', day(-20) + ' 12:00:00');
		check.run('up', day(0) + ' 00:00:00');
		const history = await getMonitorHistory(db, 'one');
		expect(history.uptime90d).toBe(66.67);
		expect(history.dailyStatus[0].status).toBe('degraded');
		expect(history.dailyStatus.at(-1)?.status).toBe('up');
		expect((await getMonitorHistory(db, 'two')).uptime90d).toBe(100);
	});

	it('loads all public summaries in three queries and omits histories and private monitors', async () => {
		const { sqlite, db, calls } = fixture();
		sqlite.exec("INSERT INTO checks(monitor_id,status) VALUES ('one','down'),('secret','down')");
		const groups = await getPublicGroupSummaries(db, 'request');
		expect(calls()).toBe(3);
		expect(groups.map((group) => group.id)).toEqual(['empty', 'public']);
		const group = groups.find((group) => group.id === 'public')!;
		expect(group.monitors).toHaveLength(2);
		expect(group.overall_status).toBe('degraded');
		expect(group.uptime_90d).toBe(50);
		expect(group.monitors.every((monitor) => !('daily_status' in monitor))).toBe(true);
		expect(groups[0].uptime_90d).toBe(100);
	});

	it('uses the same uptime and current status for overview and detail', async () => {
		const { sqlite, db } = fixture();
		sqlite
			.query(
				`INSERT INTO daily_status(monitor_id,date,total_checks,up_checks,down_checks,degraded_checks)
   VALUES ('one',?,10,8,2,0)`
			)
			.run(day(-30));
		sqlite.exec("INSERT INTO checks(monitor_id,status) VALUES ('one','degraded')");
		const overview = (await getPublicGroupSummaries(db, 'overview')).find(
			(group) => group.id === 'public'
		)!;
		const detail = await getGroupWithStatusBySlug(db, 'public', 'detail');
		expect(detail?.uptime_90d).toBe(overview.uptime_90d);
		expect(detail?.overall_status).toBe(overview.overall_status);
		expect(detail?.monitors[0].daily_status).toHaveLength(90);
		expect(await getGroupWithStatusBySlug(db, 'private')).toBeNull();
	});

	it('fetches seven days of incidents and their updates in two queries, retaining old active incidents', async () => {
		const { sqlite, db, calls } = fixture();
		const incident = sqlite.query(
			'INSERT INTO incidents(id,title,status,group_id,created_at) VALUES (?,?,?,?,?)'
		);
		incident.run('recent', 'Recent', 'resolved', 'public', day(-6) + ' 00:00:00');
		incident.run('old', 'Old', 'resolved', 'public', day(-7) + ' 23:59:59');
		incident.run('active', 'Active', 'investigating', 'public', day(-30) + ' 12:00:00');
		incident.run('secret', 'Private', 'investigating', 'private', day(0) + ' 12:00:00');
		sqlite.exec(`INSERT INTO incident_updates(id,incident_id,status,message,created_at) VALUES
   ('u1','recent','investigating','Earlier','2026-01-01 10:00:00'),
   ('u2','recent','resolved','Latest','2026-01-01 11:00:00')`);
		const result = await getPublicIncidents(db, 'request', 'public');
		expect(calls()).toBe(2);
		expect(result.activeIncidents.map((i) => i.id)).toEqual(['active']);
		expect(result.pastIncidents).toHaveLength(7);
		expect(result.pastIncidents.at(-1)?.incidents[0].updates.map((u) => u.id)).toEqual([
			'u2',
			'u1'
		]);
		expect(result.pastIncidents.flatMap((d) => d.incidents).map((i) => i.id)).toEqual(['recent']);
		const root = await getPublicIncidents(db, 'root');
		expect(root.activeIncidents.map((i) => i.id)).toEqual(['active']);
	});

	it('uses UTC calendar windows across year boundaries', () => {
		const now = new Date('2026-01-01T00:01:00Z');
		expect(historyCutoff(now)).toBe('2025-10-04');
		const dates = groupIncidentDates([], now);
		expect(dates[0].date).toBe('2026-01-01');
		expect(dates.at(-1)?.date).toBe('2025-12-26');
	});

	it('logs query metadata with correlation and no SQL or bound values', async () => {
		const { db } = fixture();
		await readD1(db, 'lookup', 'SELECT ? AS value', ['private-value'], 'request');
		const logged = info.mock.calls.at(-1)?.[0];
		expect(logged).toMatchObject({
			event: 'd1_query_completed',
			request_id: 'request',
			operation: 'lookup',
			sql_duration_ms: 2,
			rows_read: 100,
			rows_written: 0,
			rows_returned: 1
		});
		expect(JSON.stringify(logged)).not.toContain('private-value');
		expect(JSON.stringify(logged)).not.toContain('SELECT');
	});
});

describe('admin monitor list refresh', () => {
	function event(db: D1Database, query = '', authenticated = true) {
		return {
			url: new URL('https://status.micelio.ai/api/monitors' + query),
			locals: { user: authenticated ? { id: 'admin', role: 'admin' } : null },
			platform: { env: { DB: db } }
		} as unknown as Parameters<typeof getMonitors>[0];
	}

	it('refreshes current states without availability reads when opted out, preserving the full default', async () => {
		const { sqlite, db, calls } = fixture();
		const insert = sqlite.query('INSERT INTO checks(monitor_id,status,checked_at) VALUES (?,?,?)');
		const now = new Date().toISOString();
		insert.run('one', 'up', now);
		insert.run('one', 'down', now);
		insert.run('two', 'degraded', now);
		const response = await getMonitors(event(db, '?include_uptime=false'));
		expect(response.status).toBe(200);
		const current = await response.json();
		expect(calls()).toBeLessThanOrEqual(4);
		expect(
			current.every((monitor: { uptime_24h: number | null }) => monitor.uptime_24h === null)
		).toBe(true);
		expect(current.find((monitor: { id: string }) => monitor.id === 'two')).toMatchObject({
			current_status: 'degraded',
			last_check: { status: 'degraded' }
		});
		const full = await (await getMonitors(event(db))).json();
		expect(full.find((monitor: { id: string }) => monitor.id === 'one').uptime_24h).toBe(50);
		expect(full.find((monitor: { id: string }) => monitor.id === 'secret').uptime_24h).toBe(100);
		expect(
			full.map((monitor: Record<string, unknown>) => ({ ...monitor, uptime_24h: null }))
		).toEqual(current);
	});

	it('keeps the lightweight refresh authenticated without touching D1', async () => {
		const { db, calls } = fixture();
		const response = await getMonitors(event(db, '?include_uptime=false', false));
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Unauthorized' });
		expect(calls()).toBe(0);
	});
});
