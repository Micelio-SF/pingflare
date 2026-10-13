import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getGroupWithStatusBySlug } from '$lib/server/db/groups';
import { getPublicIncidents } from '$lib/server/db/public-incidents';

export const load: PageServerLoad = async ({ params, platform }) => {
	if (!platform?.env?.DB) throw error(500, 'Database not available');
	const requestId = crypto.randomUUID();
	const startedAt = Date.now();
	const db = platform.env.DB;
	const group = await getGroupWithStatusBySlug(db, params.slug, requestId);
	if (!group || !group.is_public) throw error(404, 'Group not found');
	const { activeIncidents, pastIncidents } = await getPublicIncidents(db, requestId, group.id);
	console.info({
		event: 'status_data_completed',
		request_id: requestId,
		page: 'group',
		monitors: group.monitors.length,
		duration_ms: Date.now() - startedAt
	});
	return { group, activeIncidents, pastIncidents };
};
