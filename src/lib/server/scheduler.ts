import { runCronChecks, runDailyMaintenance } from './cron';

interface SchedulerEnv {
	DB: D1Database;
	MONITOR_SHARD_INDEX?: string;
	MONITOR_SHARD_COUNT?: string;
}

export async function scheduled(controller: ScheduledController, env: SchedulerEnv): Promise<void> {
	if (controller.cron === '0 0 * * *') return maintenanceScheduled(controller, env);
	const runId = crypto.randomUUID();
	console.info({
		event: 'scheduled_started',
		run_id: runId,
		scheduled_time: controller.scheduledTime,
		cron: controller.cron
	});
	try {
		const result = await runCronChecks(env.DB, {
			shardIndex: Number(env.MONITOR_SHARD_INDEX ?? '0'),
			shardCount: Number(env.MONITOR_SHARD_COUNT ?? '1')
		});
		console.info({
			event: 'scheduled_completed',
			run_id: runId,
			checked: result.checked,
			successful: result.successful,
			failed: result.failed
		});
		if (result.failed) throw new Error('Some monitor checks could not be persisted');
	} catch (error) {
		console.error({
			event: 'scheduled_failed',
			run_id: runId,
			error_type: error instanceof Error ? error.name : 'UnknownError'
		});
		throw error;
	}
}

export async function maintenanceScheduled(
	controller: ScheduledController,
	env: SchedulerEnv
): Promise<void> {
	if (controller.cron !== '0 0 * * *') return;
	const runId = crypto.randomUUID();
	console.info({
		event: 'maintenance_started',
		run_id: runId,
		scheduled_time: controller.scheduledTime
	});
	try {
		await runDailyMaintenance(env.DB);
		console.info({ event: 'maintenance_completed', run_id: runId });
	} catch (error) {
		console.error({
			event: 'maintenance_failed',
			run_id: runId,
			error_type: error instanceof Error ? error.name : 'UnknownError'
		});
		throw error;
	}
}
