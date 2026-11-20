import type { D1Database } from '@cloudflare/workers-types';
import type { DiagnosticDailyStatus } from '$lib/types/status';
import { readD1 } from './diagnostics';

export interface DailyCounts {
	monitor_id: string;
	date: string;
	total_checks: number;
	up_checks: number;
	down_checks: number;
	degraded_checks: number;
	downtime_minutes: number;
	unconfirmed_checks: number;
	slow_checks: number;
	legacy_down_checks: number;
	inferred_isolated_checks: number;
}

// Completed daily aggregates are authoritative; raw checks supply days not aggregated yet.
// This preserves history after raw retention cleanup without counting overlapping days twice.
// Enumerate missing calendar days before visiting checks so aggregated raw days are never scanned.
// CROSS JOIN fixes the loop order: monitor -> missing day -> indexed check range.
export const DAILY_COUNTS_SQL = `
 SELECT d.monitor_id, d.date, d.total_checks, d.up_checks, d.down_checks,
        d.degraded_checks, d.downtime_minutes, d.unconfirmed_checks,
        d.slow_checks, d.legacy_down_checks, d.inferred_isolated_checks
 FROM daily_status d JOIN monitors m ON m.id = d.monitor_id
 WHERE d.date >= ? AND SCOPE
 UNION ALL
 SELECT m.id AS monitor_id, days.date, COUNT(*) AS total_checks,
        SUM(c.status = 'up') AS up_checks, SUM(c.status = 'down') AS down_checks,
        SUM(c.status = 'degraded') AS degraded_checks,
        ROUND(1440.0 * SUM(c.status = 'down') / COUNT(*)) AS downtime_minutes,
        SUM(COALESCE(c.observed_status = 'down' AND c.status = 'degraded', 0)) AS unconfirmed_checks,
        SUM(c.is_slow = 1 AND c.status = 'degraded') AS slow_checks,
        SUM(c.observed_status IS NULL AND c.status = 'down') AS legacy_down_checks,
        0 AS inferred_isolated_checks
 FROM monitors m CROSS JOIN (
   WITH RECURSIVE calendar(date) AS (
     SELECT DATE(?)
     UNION ALL
     SELECT DATE(date, '+1 day') FROM calendar WHERE date < DATE('now')
   ) SELECT date FROM calendar
 ) days CROSS JOIN checks c
 WHERE SCOPE
   AND NOT EXISTS (SELECT 1 FROM daily_status d
                   WHERE d.monitor_id = m.id AND d.date = days.date)
   AND c.monitor_id = m.id
   AND c.checked_at >= days.date || ' 00:00:00'
   AND c.checked_at < DATETIME(days.date, '+1 day')
 GROUP BY m.id, days.date`;

export function historyCutoff(now = new Date()): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 89))
		.toISOString()
		.slice(0, 10);
}

export function calculateUptime(rows: Pick<DailyCounts, 'total_checks' | 'down_checks'>[]): number {
	const total = rows.reduce((sum, row) => sum + row.total_checks, 0);
	const down = rows.reduce((sum, row) => sum + row.down_checks, 0);
	return total ? Math.round(((total - down) / total) * 10000) / 100 : 100;
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
	const dailyStatus: DiagnosticDailyStatus[] = Array.from({ length: 90 }, (_, index) => {
		const date = new Date(start + index * 86400000).toISOString().slice(0, 10);
		const row = byDate.get(date);
		return {
			date,
			status: !row?.total_checks
				? 'none'
				: row.down_checks - row.legacy_down_checks > 0
					? 'down'
					: row.legacy_down_checks > 0 || row.degraded_checks > row.unconfirmed_checks
						? 'degraded'
						: 'up',
			downtime_minutes: row?.downtime_minutes ?? 0,
			total_checks: row?.total_checks ?? 0,
			confirmed_down_checks: (row?.down_checks ?? 0) - (row?.legacy_down_checks ?? 0),
			unconfirmed_checks: row?.unconfirmed_checks ?? 0,
			slow_checks: row?.slow_checks ?? 0,
			legacy_down_checks: row?.legacy_down_checks ?? 0,
			inferred_isolated_checks: row?.inferred_isolated_checks ?? 0,
			other_degraded_checks: Math.max(
				0,
				(row?.degraded_checks ?? 0) - (row?.unconfirmed_checks ?? 0) - (row?.slow_checks ?? 0)
			)
		};
	});
	return { dailyStatus, uptime90d: calculateUptime(rows) };
}
