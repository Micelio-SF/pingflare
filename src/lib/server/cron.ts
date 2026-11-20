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
			const attemptStartedAt = Date.now();
			const interval = monitor.previous_observed_status === 'down' ? 30 : monitor.interval_seconds;
			if (!isMonitorDue(monitor.last_checked_at ?? undefined, interval, attemptStartedAt))
				return null;
			const previousStatus: MonitorStatus | null = monitor.previous_status;

			const result = await runCheck(monitor);
			const previousStartedAt = monitor.last_checked_at
				? Date.parse(monitor.last_checked_at.replace(' ', 'T').replace(/Z?$/, 'Z'))
				: NaN;
			// Confirmation expires after two scheduled ticks plus the request timeout.
			const confirmsFailure =
				monitor.previous_observed_status === 'down' &&
				attemptStartedAt - previousStartedAt >= 30_000 &&
				attemptStartedAt - previousStartedAt <= 120_000 + monitor.timeout_ms;
			const publicStatus =
				result.status === 'down' && !confirmsFailure ? 'degraded' : result.status;
			// CF-Ray identifies the edge that answered the probe, not the cron execution location.
			const checkedFrom = result.cfRay?.match(/-([a-z]{3})$/i)?.[1].toUpperCase() ?? null;
			console.info({
				event: 'monitor_completed',
				run_id: runId,
				monitor_id: monitor.id,
				status: publicStatus,
				observed_status: result.status,
				cf_ray: result.cfRay ?? null,
				edge_colo: checkedFrom,
				status_code: result.statusCode,
				duration_ms: result.responseTimeMs
			});
			await insertCheck(
				db,
				monitor.id,
				publicStatus,
				result.responseTimeMs,
				result.statusCode,
				result.errorMessage,
				checkedFrom,
				result.status,
				result.cfRay ?? null,
				runId,
				new Date(attemptStartedAt).toISOString().replace('T', ' ').slice(0, 19),
				result.isSlow ?? false
			);

			// Send notifications on status change
			const unconfirmedRecovery =
				previousStatus === 'degraded' &&
				monitor.previous_observed_status === 'down' &&
				publicStatus === 'up';
			if (previousStatus !== publicStatus && !unconfirmedRecovery) {
				try {
					await sendNotifications(
						db,
						monitor,
						previousStatus,
						publicStatus,
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
				...result,
				status: publicStatus,
				observedStatus: result.status
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
	await cleanupOldChecks(db, 30);
	await cleanupOldDailyStatus(db, 365);
}
