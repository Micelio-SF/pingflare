import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import type { D1Database } from '@cloudflare/workers-types';
import { getMonitorHistory, historyCutoff } from './history';
import { getPublicGroupSummaries, getGroupWithStatusBySlug } from './groups';
import { getPublicIncidents, groupIncidentDates } from './public-incidents';
import { readD1 } from './diagnostics';

const databases: Database[] = [];
let info: ReturnType<typeof spyOn<typeof console, 'info'>>;
beforeEach(() => {
	info = spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
	for (const database of databases.splice(0)) database.close();
	info.mockRestore();
});

function fixture() {
	const sqlite = new Database(':memory:');
	databases.push(sqlite);
	sqlite.exec(
		readFileSync(new URL('../../../../migrations/0001_schema.sql', import.meta.url), 'utf8')
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

describe('public status data', () => {
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
		expect(history.dailyStatus.at(-1)?.status).toBe('down');
		expect(history.dailyStatus[0].status).toBe('none');
	});

	it('loads all public summaries in three queries and omits histories and private monitors', async () => {
		const { sqlite, db, calls } = fixture();
		sqlite.exec("INSERT INTO checks(monitor_id,status) VALUES ('one','down'),('secret','down')");
		const groups = await getPublicGroupSummaries(db, 'request');
		expect(calls()).toBe(3);
		expect(groups.map((group) => group.id)).toEqual(['empty', 'public']);
		const group = groups.find((group) => group.id === 'public')!;
		expect(group.monitors).toHaveLength(2);
		expect(group.overall_status).toBe('partial_outage');
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
