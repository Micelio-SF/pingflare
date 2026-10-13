import type { D1Database } from '@cloudflare/workers-types';
import type {
	MonitorGroup,
	GroupWithStatus,
	CreateGroupInput,
	UpdateGroupInput
} from '$lib/types/group';
import type { StatusMonitor } from '$lib/types/status';
import { getOverallStatus } from '$lib/types/status';
import { getMonitorHistory, DAILY_COUNTS_SQL, historyCutoff } from './history';
import { readD1 } from './diagnostics';
import type { GroupSummary } from '$lib/types/group';

// ============================================
// Group CRUD Operations
// ============================================

export async function getAllGroups(db: D1Database): Promise<MonitorGroup[]> {
	const result = await db
		.prepare('SELECT * FROM monitor_groups ORDER BY display_order ASC, name ASC')
		.all<MonitorGroup>();
	return result.results;
}

export async function getGroupById(db: D1Database, id: string): Promise<MonitorGroup | null> {
	return db.prepare('SELECT * FROM monitor_groups WHERE id = ?').bind(id).first<MonitorGroup>();
}

export async function createGroup(db: D1Database, input: CreateGroupInput): Promise<MonitorGroup> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const slug = input.slug || generateSlug(input.name);

	// Get max display_order
	const maxOrder = await db
		.prepare('SELECT MAX(display_order) as max_order FROM monitor_groups')
		.first<{ max_order: number | null }>();
	const displayOrder = (maxOrder?.max_order ?? -1) + 1;

	await db
		.prepare(
			'INSERT INTO monitor_groups (id, name, slug, description, is_public, display_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
		)
		.bind(
			id,
			input.name,
			slug,
			input.description ?? null,
			input.is_public ? 1 : 0,
			displayOrder,
			now
		)
		.run();

	return {
		id,
		name: input.name,
		slug,
		description: input.description ?? null,
		is_public: input.is_public ? 1 : 0,
		display_order: displayOrder,
		created_at: now
	};
}

function generateSlug(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

export async function updateGroup(
	db: D1Database,
	id: string,
	input: UpdateGroupInput
): Promise<void> {
	const updates: string[] = [];
	const values: (string | number)[] = [];

	if (input.name !== undefined) {
		updates.push('name = ?');
		values.push(input.name);
	}
	if (input.slug !== undefined) {
		updates.push('slug = ?');
		values.push(input.slug);
	}
	if (input.description !== undefined) {
		updates.push('description = ?');
		values.push(input.description);
	}
	if (input.is_public !== undefined) {
		updates.push('is_public = ?');
		values.push(input.is_public ? 1 : 0);
	}
	if (input.display_order !== undefined) {
		updates.push('display_order = ?');
		values.push(input.display_order);
	}

	if (updates.length === 0) return;

	values.push(id);
	await db
		.prepare(`UPDATE monitor_groups SET ${updates.join(', ')} WHERE id = ?`)
		.bind(...values)
		.run();
}

export async function deleteGroup(
	db: D1Database,
	id: string
): Promise<{ success: boolean; error?: string }> {
	// Check if group has monitors
	const monitorCount = await db
		.prepare('SELECT COUNT(*) as count FROM monitors WHERE group_id = ?')
		.bind(id)
		.first<{ count: number }>();

	if (monitorCount && monitorCount.count > 0) {
		return {
			success: false,
			error: 'Cannot delete group with monitors. Move or delete monitors first.'
		};
	}

	await db.prepare('DELETE FROM monitor_groups WHERE id = ?').bind(id).run();
	return { success: true };
}

export async function getGroupMonitorCount(db: D1Database, groupId: string): Promise<number> {
	const result = await db
		.prepare('SELECT COUNT(*) as count FROM monitors WHERE group_id = ?')
		.bind(groupId)
		.first<{ count: number }>();
	return result?.count ?? 0;
}

// ============================================
// Group Status Operations
// ============================================

export async function getPublicGroups(db: D1Database): Promise<MonitorGroup[]> {
	const result = await db
		.prepare(
			'SELECT * FROM monitor_groups WHERE is_public = 1 ORDER BY display_order ASC, name ASC'
		)
		.all<MonitorGroup>();
	return result.results;
}

export async function getGroupBySlug(db: D1Database, slug: string): Promise<MonitorGroup | null> {
	return db.prepare('SELECT * FROM monitor_groups WHERE slug = ?').bind(slug).first<MonitorGroup>();
}

export async function getPublicGroupsWithStatus(db: D1Database): Promise<GroupWithStatus[]> {
	// Get public groups
	const groups = await db
		.prepare(
			'SELECT * FROM monitor_groups WHERE is_public = 1 ORDER BY display_order ASC, name ASC'
		)
		.all<MonitorGroup>();

	return Promise.all(groups.results.map((group) => getGroupWithStatus(db, group)));
}

export async function getGroupWithStatusBySlug(
	db: D1Database,
	slug: string,
	requestId?: string
): Promise<GroupWithStatus | null> {
	const [group] = await readD1<MonitorGroup>(
		db,
		'public_group',
		'SELECT * FROM monitor_groups WHERE slug = ? AND is_public = 1',
		[slug],
		requestId
	);
	if (!group) return null;
	return getGroupWithStatus(db, group, requestId);
}

export async function getAllGroupsWithStatus(db: D1Database): Promise<GroupWithStatus[]> {
	const groups = await getAllGroups(db);
	return Promise.all(groups.map((group) => getGroupWithStatus(db, group)));
}

async function getGroupWithStatus(
	db: D1Database,
	group: MonitorGroup,
	requestId?: string
): Promise<GroupWithStatus> {
	const monitors = await readD1<Omit<StatusMonitor, 'daily_status' | 'uptime_90d'>>(
		db,
		'group_monitor_status',
		`SELECT m.id, m.name, m.group_id,
   (SELECT status FROM checks WHERE monitor_id = m.id ORDER BY checked_at DESC LIMIT 1) AS current_status
   FROM monitors m WHERE group_id = ? ORDER BY name`,
		[group.id],
		requestId
	);
	const statusMonitors: StatusMonitor[] = await Promise.all(
		monitors.map(async (monitor) => {
			const history = await getMonitorHistory(db, monitor.id, requestId);
			return {
				id: monitor.id,
				name: monitor.name,
				group_id: monitor.group_id,
				current_status: monitor.current_status,
				uptime_90d: history.uptime90d,
				daily_status: history.dailyStatus
			};
		})
	);

	// Calculate overall status and average uptime
	const overallStatus = getOverallStatus(statusMonitors);
	const avgUptime =
		statusMonitors.length > 0
			? statusMonitors.reduce((sum, m) => sum + m.uptime_90d, 0) / statusMonitors.length
			: 100;

	return {
		...group,
		monitors: statusMonitors,
		overall_status: overallStatus,
		uptime_90d: Math.round(avgUptime * 100) / 100
	};
}

// ============================================
// Default Group Handling
// ============================================

export async function getOrCreateDefaultGroup(db: D1Database): Promise<MonitorGroup> {
	// Check if default group exists
	let defaultGroup = await db
		.prepare("SELECT * FROM monitor_groups WHERE name = 'General'")
		.first<MonitorGroup>();

	if (!defaultGroup) {
		defaultGroup = await createGroup(db, { name: 'General', description: 'Default monitor group' });
	}

	return defaultGroup;
}

export async function getPublicGroupSummaries(
	db: D1Database,
	requestId: string
): Promise<GroupSummary[]> {
	const scope = 'm.group_id IN (SELECT id FROM monitor_groups WHERE is_public = 1)';
	const cutoff = historyCutoff();
	const [groups, monitors, totals] = await Promise.all([
		readD1<MonitorGroup>(
			db,
			'public_groups',
			'SELECT * FROM monitor_groups WHERE is_public = 1 ORDER BY display_order, name',
			[],
			requestId
		),
		readD1<Omit<StatusMonitor, 'daily_status' | 'uptime_90d'>>(
			db,
			'public_monitor_status',
			`SELECT m.id, m.name, m.group_id,
    (SELECT status FROM checks WHERE monitor_id = m.id ORDER BY checked_at DESC LIMIT 1) AS current_status
    FROM monitors m WHERE ${scope} ORDER BY m.name`,
			[],
			requestId
		),
		readD1<{ monitor_id: string; total_checks: number; up_checks: number }>(
			db,
			'public_uptime_totals',
			`SELECT monitor_id, SUM(total_checks) AS total_checks, SUM(up_checks) AS up_checks
    FROM (${DAILY_COUNTS_SQL.replaceAll('SCOPE', scope)}) GROUP BY monitor_id`,
			[cutoff, cutoff + ' 00:00:00'],
			requestId
		)
	]);
	const uptimes = new Map(
		totals.map((row) => [
			row.monitor_id,
			row.total_checks ? Math.round((row.up_checks / row.total_checks) * 10000) / 100 : 100
		])
	);
	const byGroup = new Map<string | null, GroupSummary['monitors']>();
	for (const monitor of monitors) {
		const list = byGroup.get(monitor.group_id) ?? [];
		list.push({ ...monitor, uptime_90d: uptimes.get(monitor.id) ?? 100 });
		byGroup.set(monitor.group_id, list);
	}
	return groups.map((group) => {
		const monitors = byGroup.get(group.id) ?? [];
		return {
			...group,
			monitors,
			overall_status: getOverallStatus(monitors),
			uptime_90d: monitors.length
				? Math.round((monitors.reduce((sum, m) => sum + m.uptime_90d, 0) / monitors.length) * 100) /
					100
				: 100
		};
	});
}
