import { isMonitorDue } from './scheduling';
import { getActiveMonitorsWithLastCheck, insertCheck, cleanupOldChecks } from './db/monitors';
import { runCheck } from './checkers';
import { sendNotifications } from './notifications';
import { aggregateDailyStatus, cleanupOldDailyStatus } from './db/status';
import type { MonitorStatus } from '$lib/types/monitor';

interface CronOptions {
	shardIndex?: number;
	shardCount?: number;
}

export async function runCronChecks(db: D1Database, options: CronOptions = {}) {
	const { shardIndex = 0, shardCount = 1 } = options;
	if (
		!Number.isInteger(shardCount) ||
		shardCount < 1 ||
		!Number.isInteger(shardIndex) ||
		shardIndex < 0 ||
		shardIndex >= shardCount
	) {
		throw new Error('Invalid monitor shard configuration');
	}
	const startedAt = Date.now();
	const runId = crypto.randomUUID();
	const activeMonitors = await getActiveMonitorsWithLastCheck(db);
	const monitors = activeMonitors.filter((_, index) => index % shardCount === shardIndex);

	if (monitors.length === 0) {
		return {
			message: 'No active monitors',
			checked: 0,
			skipped: 0,
			successful: 0,
			failed: 0,
			results: []
		};
	}

	const results = await Promise.allSettled(
		monitors.map(async (monitor) => {
			if (!isMonitorDue(monitor.last_checked_at ?? undefined, monitor.interval_seconds, Date.now()))
				return null;
			const previousStatus: MonitorStatus | null = monitor.previous_status;

			const result = await runCheck(monitor);
			console.info({
				event: 'monitor_completed',
				run_id: runId,
				monitor_id: monitor.id,
				status: result.status,
				status_code: result.statusCode,
				duration_ms: result.responseTimeMs
			});
			await insertCheck(
				db,
				monitor.id,
				result.status,
				result.responseTimeMs,
				result.statusCode,
				result.errorMessage,
				null // checked_from - could add colo info later
			);

			// Send notifications on status change
			if (previousStatus !== result.status) {
				try {
					await sendNotifications(
						db,
						monitor,
						previousStatus,
						result.status,
						null, // incident tracking to be implemented
						'mailto:admin@pingflare.app'
					);
				} catch (err) {
					console.error(`Failed to send notifications for ${monitor.name}:`, err);
				}
			}

			return {
				monitorId: monitor.id,
				name: monitor.name,
				...result
			};
		})
	);

	const successful = results.filter((r) => r.status === 'fulfilled' && r.value !== null).length;
	const failed = results.filter((r) => r.status === 'rejected').length;

	const checkResults = results.map((r) => {
		if (r.status === 'fulfilled') {
			return r.value;
		}
		return { error: r.reason?.message || 'Unknown error' };
	});

	console.info({
		event: 'cron_completed',
		shard_index: shardIndex,
		shard_count: shardCount,
		run_id: runId,
		successful,
		failed,
		skipped: monitors.length - successful - failed,
		duration_ms: Date.now() - startedAt
	});
	for (const [index, result] of results.entries()) {
		if (result.status === 'rejected')
			console.error({
				event: 'monitor_failed',
				run_id: runId,
				monitor_id: monitors[index].id,
				error_type: result.reason instanceof Error ? result.reason.name : 'UnknownError'
			});
	}
	return {
		message: 'Checks completed',
		checked: successful + failed,
		skipped: monitors.length - successful - failed,
		successful,
		failed,
		results: checkResults
	};
}

export async function runDailyMaintenance(db: D1Database): Promise<void> {
	await aggregateDailyStatus(db);
	await cleanupOldChecks(db, 7);
	await cleanupOldDailyStatus(db, 365);
}
