import { getMonitorHistory, type DailyCounts } from './history';
import type { D1Database } from '@cloudflare/workers-types';
import type { Monitor, Check } from '$lib/types/monitor';
import type {
	DailyStatus,
	StatusMonitor,
	Incident,
	IncidentUpdate,
	IncidentsByDate,
	CreateIncidentInput,
	AddIncidentUpdateInput
} from '$lib/types/status';

// ============================================
// Monitor Status Functions
// ============================================

/**
 * Get last check for a monitor
 */
export async function getLastCheck(db: D1Database, monitorId: string): Promise<Check | null> {
	return db
		.prepare('SELECT * FROM checks WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 1')
		.bind(monitorId)
		.first<Check>();
}

/**
 * Get 90-day daily status for a monitor
 */
export async function getDailyStatus(db: D1Database, monitorId: string): Promise<DailyStatus[]> {
	return (await getMonitorHistory(db, monitorId)).dailyStatus;
}

export async function getUptime90d(db: D1Database, monitorId: string): Promise<number> {
	return (await getMonitorHistory(db, monitorId)).uptime90d;
}

/**
 * Get all monitors with status data (for admin)
 */
export async function getAllMonitorsForStatusPage(db: D1Database): Promise<StatusMonitor[]> {
	const monitors = await db.prepare('SELECT * FROM monitors ORDER BY name ASC').all<Monitor>();

	const statusMonitors: StatusMonitor[] = await Promise.all(
		monitors.results.map(async (monitor) => {
			const [lastCheck, history] = await Promise.all([
				getLastCheck(db, monitor.id),
				getMonitorHistory(db, monitor.id)
			]);

			return {
				id: monitor.id,
				name: monitor.name,
				group_id: monitor.group_id,
				current_status:
					lastCheck?.status === 'down' && lastCheck.observed_status === null
						? 'degraded'
						: (lastCheck?.status ?? null),
				uptime_90d: history.uptime90d,
				daily_status: history.dailyStatus
			};
		})
	);

	return statusMonitors;
}

/**
 * Aggregate daily status from raw checks (run once per day)
 */
export async function aggregateDailyStatus(db: D1Database): Promise<void> {
	// Get yesterday's date
	const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const dateStr = yesterday.toISOString().split('T')[0];

	// Aggregate for each monitor
	const aggregates = await db
		.prepare(
			`
			SELECT
				monitor_id,
				COUNT(*) as total_checks,
				SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) as up_checks,
				SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) as down_checks,
				SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) as degraded_checks,
				SUM(CASE WHEN observed_status = 'down' AND status = 'degraded' THEN 1 ELSE 0 END) AS unconfirmed_checks,
				SUM(CASE WHEN is_slow = 1 AND status = 'degraded' THEN 1 ELSE 0 END) AS slow_checks,
				SUM(CASE WHEN observed_status IS NULL AND status = 'down' THEN 1 ELSE 0 END) AS legacy_down_checks
			FROM checks
			WHERE checked_at >= ? AND checked_at < DATETIME(?, '+1 day')
			GROUP BY monitor_id
		`
		)
		.bind(dateStr + ' 00:00:00', dateStr)
		.all<DailyCounts>();

	for (const agg of aggregates.results) {
		const downtimeMinutes = Math.round((agg.down_checks / agg.total_checks) * 24 * 60);

		await db
			.prepare(
				`
				INSERT INTO daily_status (monitor_id, date, total_checks, up_checks, down_checks, degraded_checks,
				    downtime_minutes, unconfirmed_checks, slow_checks, legacy_down_checks, inferred_isolated_checks)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
				ON CONFLICT(monitor_id, date) DO UPDATE SET
					total_checks = excluded.total_checks,
					up_checks = excluded.up_checks,
					down_checks = excluded.down_checks,
					degraded_checks = excluded.degraded_checks,
					downtime_minutes = excluded.downtime_minutes,
					unconfirmed_checks = excluded.unconfirmed_checks,
					slow_checks = excluded.slow_checks,
					legacy_down_checks = excluded.legacy_down_checks,
					inferred_isolated_checks = excluded.inferred_isolated_checks
			`
			)
			.bind(
				agg.monitor_id,
				dateStr,
				agg.total_checks,
				agg.up_checks,
				agg.down_checks,
				agg.degraded_checks,
				downtimeMinutes,
				agg.unconfirmed_checks,
				agg.slow_checks,
				agg.legacy_down_checks
			)
			.run();
	}
}

// ============================================
// Incident Functions
// ============================================

/**
 * Get all incidents with their updates and group names
 */
export async function getAllIncidents(db: D1Database): Promise<Incident[]> {
	const incidents = await db
		.prepare(
			`
			SELECT i.*, g.name as group_name
			FROM incidents i
			LEFT JOIN monitor_groups g ON i.group_id = g.id
			ORDER BY i.created_at DESC
		`
		)
		.all<Omit<Incident, 'updates'>>();

	const incidentsWithUpdates: Incident[] = await Promise.all(
		incidents.results.map(async (incident) => {
			const updates = await db
				.prepare('SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC')
				.bind(incident.id)
				.all<IncidentUpdate>();

			return { ...incident, updates: updates.results };
		})
	);

	return incidentsWithUpdates;
}

/**
 * Get active (unresolved) incidents with group names
 */
export async function getActiveIncidents(db: D1Database): Promise<Incident[]> {
	const incidents = await db
		.prepare(
			`
			SELECT i.*, g.name as group_name
			FROM incidents i
			LEFT JOIN monitor_groups g ON i.group_id = g.id
			WHERE i.status != 'resolved'
			ORDER BY i.created_at DESC
		`
		)
		.all<Omit<Incident, 'updates'>>();

	const incidentsWithUpdates: Incident[] = await Promise.all(
		incidents.results.map(async (incident) => {
			const updates = await db
				.prepare('SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC')
				.bind(incident.id)
				.all<IncidentUpdate>();

			return { ...incident, updates: updates.results };
		})
	);

	return incidentsWithUpdates;
}

/**
 * Get recent incidents (past 7 days) grouped by date with group names
 */
export async function getRecentIncidentsByDate(
	db: D1Database,
	days: number = 7
): Promise<IncidentsByDate[]> {
	const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

	const incidents = await db
		.prepare(
			`
			SELECT i.*, g.name as group_name
			FROM incidents i
			LEFT JOIN monitor_groups g ON i.group_id = g.id
			WHERE i.created_at > ?
			ORDER BY i.created_at DESC
		`
		)
		.bind(cutoff)
		.all<Omit<Incident, 'updates'>>();

	// Get updates for all incidents
	const incidentsWithUpdates: Incident[] = await Promise.all(
		incidents.results.map(async (incident) => {
			const updates = await db
				.prepare('SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC')
				.bind(incident.id)
				.all<IncidentUpdate>();

			return { ...incident, updates: updates.results };
		})
	);

	// Group by date
	const byDateMap = new Map<string, Incident[]>();

	// Initialize all days
	for (let i = 0; i < days; i++) {
		const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
		const dateStr = date.toISOString().split('T')[0];
		byDateMap.set(dateStr, []);
	}

	// Group incidents
	for (const incident of incidentsWithUpdates) {
		const dateStr = incident.created_at.split('T')[0];
		const existing = byDateMap.get(dateStr) || [];
		existing.push(incident);
		byDateMap.set(dateStr, existing);
	}

	// Convert to array
	const result: IncidentsByDate[] = [];
	for (const [date, incidents] of byDateMap) {
		const d = new Date(date);
		result.push({
			date,
			dateFormatted: d.toLocaleDateString('en-US', {
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			}),
			incidents
		});
	}

	return result.sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Get a single incident by ID
 */
export async function getIncidentById(db: D1Database, id: string): Promise<Incident | null> {
	const incident = await db
		.prepare('SELECT * FROM incidents WHERE id = ?')
		.bind(id)
		.first<Omit<Incident, 'updates'>>();

	if (!incident) return null;

	const updates = await db
		.prepare('SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY created_at DESC')
		.bind(id)
		.all<IncidentUpdate>();

	return { ...incident, updates: updates.results };
}

/**
 * Create a new incident with initial update
 */
export async function createIncident(
	db: D1Database,
	input: CreateIncidentInput
): Promise<Incident> {
	const incidentId = crypto.randomUUID();
	const updateId = crypto.randomUUID();
	const now = new Date().toISOString();

	await db
		.prepare(
			'INSERT INTO incidents (id, title, status, group_id, created_at) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(incidentId, input.title, input.status, input.group_id, now)
		.run();

	await db
		.prepare(
			'INSERT INTO incident_updates (id, incident_id, status, message, created_at) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(updateId, incidentId, input.status, input.message, now)
		.run();

	// Get group name
	const group = await db
		.prepare('SELECT name FROM monitor_groups WHERE id = ?')
		.bind(input.group_id)
		.first<{ name: string }>();

	return {
		id: incidentId,
		title: input.title,
		status: input.status,
		group_id: input.group_id,
		group_name: group?.name,
		created_at: now,
		resolved_at: null,
		updates: [
			{
				id: updateId,
				incident_id: incidentId,
				status: input.status,
				message: input.message,
				created_at: now
			}
		]
	};
}

/**
 * Add an update to an incident
 */
export async function addIncidentUpdate(
	db: D1Database,
	incidentId: string,
	input: AddIncidentUpdateInput
): Promise<IncidentUpdate> {
	const updateId = crypto.randomUUID();
	const now = new Date().toISOString();

	await db
		.prepare(
			'INSERT INTO incident_updates (id, incident_id, status, message, created_at) VALUES (?, ?, ?, ?, ?)'
		)
		.bind(updateId, incidentId, input.status, input.message, now)
		.run();

	// Update incident status
	const resolvedAt = input.status === 'resolved' ? now : null;
	await db
		.prepare('UPDATE incidents SET status = ?, resolved_at = COALESCE(?, resolved_at) WHERE id = ?')
		.bind(input.status, resolvedAt, incidentId)
		.run();

	return {
		id: updateId,
		incident_id: incidentId,
		status: input.status,
		message: input.message,
		created_at: now
	};
}

/**
 * Delete an incident
 */
export async function deleteIncident(db: D1Database, id: string): Promise<void> {
	await db.prepare('DELETE FROM incidents WHERE id = ?').bind(id).run();
}

/**
 * Clean up old daily status records (keep N days)
 */
export async function cleanupOldDailyStatus(db: D1Database, keepDays: number): Promise<void> {
	const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
	await db.prepare('DELETE FROM daily_status WHERE date < ?').bind(cutoff).run();
}
