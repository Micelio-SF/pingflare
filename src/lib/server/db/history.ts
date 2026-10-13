import type { D1Database } from '@cloudflare/workers-types';
import type { DailyStatus } from '$lib/types/status';
import { readD1 } from './diagnostics';

export interface DailyCounts {
	monitor_id: string;
	date: string;
	total_checks: number;
	up_checks: number;
	down_checks: number;
	degraded_checks: number;
	downtime_minutes: number;
}

// Completed daily aggregates are authoritative; raw checks supply days not aggregated yet.
// This preserves history after raw retention cleanup without counting overlapping days twice.
// Check aggregate existence per grouped day, rather than performing an index lookup per raw check.
export const DAILY_COUNTS_SQL = `
 SELECT d.monitor_id, d.date, d.total_checks, d.up_checks, d.down_checks,
        d.degraded_checks, d.downtime_minutes
 FROM daily_status d JOIN monitors m ON m.id = d.monitor_id
 WHERE d.date >= ? AND SCOPE
 UNION ALL
 SELECT c.monitor_id, DATE(c.checked_at) AS date, COUNT(*) AS total_checks,
        SUM(c.status = 'up') AS up_checks, SUM(c.status = 'down') AS down_checks,
        SUM(c.status = 'degraded') AS degraded_checks,
        ROUND(1440.0 * SUM(c.status = 'down') / COUNT(*)) AS downtime_minutes
 FROM checks c JOIN monitors m ON m.id = c.monitor_id
 WHERE c.checked_at >= ? AND SCOPE
 GROUP BY c.monitor_id, DATE(c.checked_at)
 HAVING NOT EXISTS (SELECT 1 FROM daily_status d
                    WHERE d.monitor_id = c.monitor_id AND d.date = DATE(c.checked_at))`;

export function historyCutoff(now = new Date()): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 89))
		.toISOString()
		.slice(0, 10);
}

export function calculateUptime(rows: Pick<DailyCounts, 'total_checks' | 'up_checks'>[]): number {
	const total = rows.reduce((sum, row) => sum + row.total_checks, 0);
	const up = rows.reduce((sum, row) => sum + row.up_checks, 0);
	return total ? Math.round((up / total) * 10000) / 100 : 100;
}

export async function getMonitorHistory(db: D1Database, monitorId: string, requestId?: string) {
	const cutoff = historyCutoff();
	const rows = await readD1<DailyCounts>(
		db,
		'monitor_history',
		DAILY_COUNTS_SQL.replaceAll('SCOPE', 'm.id = ?'),
		[cutoff, monitorId, cutoff + ' 00:00:00', monitorId],
		requestId
	);
	const byDate = new Map(rows.map((row) => [row.date, row]));
	const start = Date.parse(cutoff + 'T00:00:00Z');
	const dailyStatus: DailyStatus[] = Array.from({ length: 90 }, (_, index) => {
		const date = new Date(start + index * 86400000).toISOString().slice(0, 10);
		const row = byDate.get(date);
		return {
			date,
			status: !row?.total_checks
				? 'none'
				: row.down_checks > 0
					? 'down'
					: row.degraded_checks > 0
						? 'degraded'
						: 'up',
			downtime_minutes: row?.downtime_minutes ?? 0
		};
	});
	return { dailyStatus, uptime90d: calculateUptime(rows) };
}
