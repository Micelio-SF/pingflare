import type { D1Database } from '@cloudflare/workers-types';
import type { Incident, IncidentUpdate, IncidentsByDate } from '$lib/types/status';
import { readD1 } from './diagnostics';

const incidentDate = new Intl.DateTimeFormat('en-US', {
	weekday: 'long',
	month: 'long',
	day: 'numeric',
	year: 'numeric',
	timeZone: 'UTC'
});

export function groupIncidentDates(incidents: Incident[], now = new Date()): IncidentsByDate[] {
	const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
	const byDate = new Map<string, Incident[]>();
	for (const incident of incidents) {
		const date = incident.created_at.slice(0, 10);
		const list = byDate.get(date) ?? [];
		list.push(incident);
		byDate.set(date, list);
	}
	return Array.from({ length: 7 }, (_, index) => {
		const date = new Date(today - index * 86400000);
		const dateStr = date.toISOString().slice(0, 10);
		return {
			date: dateStr,
			dateFormatted: incidentDate.format(date),
			incidents: byDate.get(dateStr) ?? []
		};
	});
}

export async function getPublicIncidents(db: D1Database, requestId: string, groupId?: string) {
	const now = new Date();
	const cutoff =
		new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 6))
			.toISOString()
			.slice(0, 10) + ' 00:00:00';
	const filter = `g.is_public = 1 ${groupId ? 'AND i.group_id = ?' : ''}
  AND (i.status != 'resolved' ${groupId ? 'OR i.created_at >= ?' : ''})`;
	const bindings = groupId ? [groupId, cutoff] : [];
	const [incidents, updates] = await Promise.all([
		readD1<Omit<Incident, 'updates'>>(
			db,
			'public_incidents',
			`SELECT i.*, g.name AS group_name FROM incidents i JOIN monitor_groups g ON g.id = i.group_id
    WHERE ${filter} ORDER BY i.created_at DESC`,
			bindings,
			requestId
		),
		readD1<IncidentUpdate>(
			db,
			'public_incident_updates',
			`SELECT u.* FROM incident_updates u JOIN incidents i ON i.id = u.incident_id
    JOIN monitor_groups g ON g.id = i.group_id
    WHERE ${filter} ORDER BY u.created_at DESC`,
			bindings,
			requestId
		)
	]);
	const byIncident = new Map<string, IncidentUpdate[]>();
	for (const update of updates) {
		const list = byIncident.get(update.incident_id) ?? [];
		list.push(update);
		byIncident.set(update.incident_id, list);
	}
	const withUpdates = incidents.map((incident) => ({
		...incident,
		updates: byIncident.get(incident.id) ?? []
	}));
	return {
		activeIncidents: withUpdates.filter((incident) => incident.status !== 'resolved'),
		pastIncidents: groupId ? groupIncidentDates(withUpdates, now) : []
	};
}
