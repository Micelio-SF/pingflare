import type { D1Database } from '@cloudflare/workers-types';

export async function readD1<T>(
	db: D1Database,
	operation: string,
	sql: string,
	bindings: (string | number | null)[] = [],
	requestId?: string
): Promise<T[]> {
	const startedAt = Date.now();
	try {
		const result = await db
			.prepare(sql)
			.bind(...bindings)
			.all<T>();
		console.info({
			event: 'd1_query_completed',
			request_id: requestId,
			operation,
			duration_ms: Date.now() - startedAt,
			sql_duration_ms: result.meta.timings?.sql_duration_ms ?? result.meta.duration,
			rows_read: result.meta.rows_read,
			rows_written: result.meta.rows_written,
			rows_returned: result.results.length
		});
		return result.results;
	} catch (error) {
		console.error({
			event: 'd1_query_failed',
			request_id: requestId,
			operation,
			duration_ms: Date.now() - startedAt,
			error_type: error instanceof Error ? error.name : 'UnknownError'
		});
		throw error;
	}
}
