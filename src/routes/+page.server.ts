import type { PageServerLoad } from './$types';
import { getPublicIncidents } from '$lib/server/db/public-incidents';
import { getPublicGroupSummaries } from '$lib/server/db/groups';
import type { Incident } from '$lib/types/status';
import type { GroupSummary } from '$lib/types/group';

export const load: PageServerLoad = async ({ platform }) => {
	if (!platform?.env?.DB) {
		return { groups: [] as GroupSummary[], activeIncidents: [] as Incident[] };
	}
	const requestId = crypto.randomUUID();
	const startedAt = Date.now();
	const [groups, { activeIncidents }] = await Promise.all([
		getPublicGroupSummaries(platform.env.DB, requestId),
		getPublicIncidents(platform.env.DB, requestId)
	]);
	console.info({
		event: 'status_data_completed',
		request_id: requestId,
		page: 'overview',
		groups: groups.length,
		monitors: groups.reduce((sum, group) => sum + group.monitors.length, 0),
		duration_ms: Date.now() - startedAt
	});
	return { groups, activeIncidents };
};
