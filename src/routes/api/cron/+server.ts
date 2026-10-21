import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runCronChecks } from '$lib/server/cron';
import { timingSafeEqualString } from '$lib/server/crypto';

export const GET: RequestHandler = async ({ platform, request }) => {
	const cronSecret = platform?.env?.CRON_SECRET;
	const providedSecret = request.headers.get('X-Cron-Secret');
	if (!cronSecret || !providedSecret || !timingSafeEqualString(providedSecret, cronSecret)) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}
	if (!platform?.env?.DB) {
		return json({ error: 'Database not available' }, { status: 500 });
	}
	return json(await runCronChecks(platform.env.DB));
};
