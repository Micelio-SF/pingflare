import { describe, it, expect, mock } from 'bun:test';
import { validateScript, executeScript } from './script';

describe('validateScript', () => {
	it('should return valid for a proper JSON DSL script', () => {
		const script = JSON.stringify({
			steps: [
				{
					name: 'check_health',
					request: {
						method: 'GET',
						url: 'https://api.example.com/health'
					}
				}
			]
		});
		const result = validateScript(script);
		expect(result.valid).toBe(true);
	});

	it('should return valid for script with assertions', () => {
		const script = JSON.stringify({
			steps: [
				{
					name: 'check_api',
					request: {
						method: 'GET',
						url: 'https://api.example.com/status'
					},
					assert: [
						{ check: 'status', equals: 200 },
						{ check: 'json.healthy', equals: true }
					]
				}
			]
		});
		const result = validateScript(script);
		expect(result.valid).toBe(true);
	});

	it('should return valid for multi-step script with variable extraction', () => {
		const script = JSON.stringify({
			steps: [
				{
					name: 'login',
					request: {
						method: 'POST',
						url: 'https://api.example.com/login',
						headers: { 'Content-Type': 'application/json' },
						body: { user: 'test', pass: 'secret' }
					},
					extract: {
						token: 'json.token'
					}
				},
				{
					name: 'get_data',
					request: {
						method: 'GET',
						url: 'https://api.example.com/data',
						headers: { Authorization: 'Bearer ${token}' }
					},
					assert: [{ check: 'status', equals: 200 }]
				}
			]
		});
		const result = validateScript(script);
		expect(result.valid).toBe(true);
	});

	it('should return invalid for empty script', () => {
		const result = validateScript('');
		expect(result.valid).toBe(false);
	});

	it('should return invalid for invalid JSON', () => {
		const script = '{ invalid json }';
		const result = validateScript(script);
		expect(result.valid).toBe(false);
	});

	it('should return invalid for missing steps array', () => {
		const script = JSON.stringify({ name: 'test' });
		const result = validateScript(script);
		expect(result.valid).toBe(false);
		expect(result.error).toContain('steps');
	});

	it('should return invalid for empty steps array', () => {
		const script = JSON.stringify({ steps: [] });
		const result = validateScript(script);
		expect(result.valid).toBe(false);
		expect(result.error).toContain('at least one step');
	});

	it('should return invalid for step without name', () => {
		const script = JSON.stringify({
			steps: [
				{
					request: {
						method: 'GET',
						url: 'https://api.example.com/health'
					}
				}
			]
		});
		const result = validateScript(script);
		expect(result.valid).toBe(false);
		expect(result.error).toContain('name');
	});

	it('should return invalid for step without URL', () => {
		const script = JSON.stringify({
			steps: [
				{
					name: 'check',
					request: {
						method: 'GET'
					}
				}
			]
		});
		const result = validateScript(script);
		expect(result.valid).toBe(false);
		expect(result.error).toContain('URL');
	});

	it('should return invalid for step without method', () => {
		const script = JSON.stringify({
			steps: [
				{
					name: 'check',
					request: {
						url: 'https://api.example.com/health'
					}
				}
			]
		});
		const result = validateScript(script);
		expect(result.valid).toBe(false);
		expect(result.error).toContain('method');
	});

	it('should accept all HTTP methods', () => {
		const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
		for (const method of methods) {
			const script = JSON.stringify({
				steps: [
					{
						name: 'test',
						request: { method, url: 'https://example.com' }
					}
				]
			});
			const result = validateScript(script);
			expect(result.valid).toBe(true);
		}
	});

	it('should return valid for script with assertion severity', () => {
		const script = JSON.stringify({
			steps: [
				{
					name: 'check_api',
					request: {
						method: 'GET',
						url: 'https://api.example.com/status'
					},
					assert: [
						{ check: 'status', equals: 200, severity: 'down' },
						{ check: 'responseTime', lessThan: 500, severity: 'degraded' }
					]
				}
			]
		});
		const result = validateScript(script);
		expect(result.valid).toBe(true);
	});

	it('should return valid for script with responseTime assertion', () => {
		const script = JSON.stringify({
			steps: [
				{
					name: 'performance_check',
					request: {
						method: 'GET',
						url: 'https://api.example.com/health'
					},
					assert: [{ check: 'responseTime', lessThan: 1000 }]
				}
			]
		});
		const result = validateScript(script);
		expect(result.valid).toBe(true);
	});
});

describe('executeScript', () => {
	it('should return down status when assertion with severity=down fails', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ healthy: true }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		try {
			const script = JSON.stringify({
				steps: [
					{
						name: 'check_status',
						request: {
							method: 'GET',
							url: 'https://api.example.com/health'
						},
						assert: [{ check: 'status', equals: 200, severity: 'down' }]
					}
				]
			});
			const result = await executeScript(script);
			expect(result.status).toBe('down');
			expect(result.errorMessage).toContain('assertion');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should return degraded status when assertion with default severity fails', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ healthy: false }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		try {
			const script = JSON.stringify({
				steps: [
					{
						name: 'check_health',
						request: {
							method: 'GET',
							url: 'https://api.example.com/health'
						},
						assert: [{ check: 'json.healthy', equals: true }]
					}
				]
			});
			const result = await executeScript(script);
			expect(result.status).toBe('degraded');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should return degraded status when assertion with severity=degraded fails', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ count: 5 }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		try {
			const script = JSON.stringify({
				steps: [
					{
						name: 'check_count',
						request: {
							method: 'GET',
							url: 'https://api.example.com/data'
						},
						assert: [{ check: 'json.count', greaterThan: 10, severity: 'degraded' }]
					}
				]
			});
			const result = await executeScript(script);
			expect(result.status).toBe('degraded');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should allow responseTime assertion', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response('OK', {
					status: 200
				})
			)
		);

		try {
			const script = JSON.stringify({
				steps: [
					{
						name: 'check_performance',
						request: {
							method: 'GET',
							url: 'https://api.example.com/health'
						},
						assert: [{ check: 'responseTime', lessThan: 10000 }]
					}
				]
			});
			const result = await executeScript(script);
			expect(result.status).toBe('up');
			expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should return down when both down and degraded severity assertions fail', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ healthy: false }), {
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		try {
			const script = JSON.stringify({
				steps: [
					{
						name: 'multi_check',
						request: {
							method: 'GET',
							url: 'https://api.example.com/health'
						},
						assert: [
							{ check: 'status', equals: 200, severity: 'down' },
							{ check: 'json.healthy', equals: true, severity: 'degraded' }
						]
					}
				]
			});
			const result = await executeScript(script);
			expect(result.status).toBe('down');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('should return up when all assertions pass', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ healthy: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			)
		);

		try {
			const script = JSON.stringify({
				steps: [
					{
						name: 'full_check',
						request: {
							method: 'GET',
							url: 'https://api.example.com/health'
						},
						assert: [
							{ check: 'status', equals: 200, severity: 'down' },
							{ check: 'json.healthy', equals: true }
						]
					}
				]
			});
			const result = await executeScript(script);
			expect(result.status).toBe('up');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe('response resource limits', () => {
	it('does not consume bodies for status-only checks', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				new ReadableStream({
					pull(controller) {
						controller.error(new Error('Body must not be read'));
					}
				}),
				{ status: 200 }
			)) as typeof fetch;
		try {
			const result = await executeScript(
				JSON.stringify({
					steps: [
						{
							name: 'status',
							request: { method: 'GET', url: 'https://example.com' },
							assert: [{ check: 'status', equals: 200 }]
						}
					]
				})
			);
			expect(result.status).toBe('up');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('rejects oversized bodies before JSON parsing', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response('x'.repeat(1024 * 1024 + 1))) as typeof fetch;
		try {
			const result = await executeScript(
				JSON.stringify({
					steps: [
						{
							name: 'json',
							request: { method: 'GET', url: 'https://example.com' },
							assert: [{ check: 'json.status', equals: 'up' }]
						}
					]
				})
			);
			expect(result.status).toBe('down');
			expect(result.errorMessage).toContain('1 MiB');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe('streamed body assertions', () => {
	const encoder = new TextEncoder();

	function streamedResponse(chunks: Uint8Array[]) {
		let reads = 0;
		let ended = false;
		let cancelled = false;
		const response = new Response(
			new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						if (reads < chunks.length) controller.enqueue(chunks[reads++]);
						else {
							ended = true;
							controller.close();
						}
					},
					cancel() {
						cancelled = true;
					}
				},
				{ highWaterMark: 0 }
			)
		);
		return { response, state: () => ({ reads, ended, cancelled }) };
	}

	async function checkResponse(response: Response, assertions: unknown[], extract?: object) {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () => response) as typeof fetch;
		try {
			return await executeScript(
				JSON.stringify({
					steps: [
						{
							name: 'stream',
							request: { method: 'GET', url: 'https://example.com' },
							assert: assertions,
							extract
						}
					]
				})
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	}

	it('cancels the remaining body only after all tokens match across UTF-8 chunk boundaries', async () => {
		const text = encoder.encode('Micelio acción');
		const accentedByte = text.indexOf(0xc3);
		const stream = streamedResponse([
			text.slice(0, accentedByte + 1),
			text.slice(accentedByte + 1),
			encoder.encode(' trailing body that is unnecessary')
		]);
		const result = await checkResponse(stream.response, [
			{ check: 'status', equals: 200 },
			{ check: 'body', contains: 'Micelio' },
			{ check: 'body', contains: 'acción', severity: 'down' }
		]);
		expect(result.status).toBe('up');
		expect(stream.state()).toEqual({ reads: 2, ended: false, cancelled: true });
	});

	it('reads through EOF when a required token is absent and preserves failure severity', async () => {
		const stream = streamedResponse(['Micelio', ' finished'].map((text) => encoder.encode(text)));
		const result = await checkResponse(stream.response, [
			{ check: 'body', contains: 'Micelio' },
			{ check: 'body', contains: 'missing', severity: 'down' }
		]);
		expect(result.status).toBe('down');
		expect(result.errorMessage).toContain('missing');
		expect(stream.state().ended).toBe(true);
	});

	it.each([
		{
			name: 'negative body assertion',
			chunks: ['ready', ' failure'],
			assertions: [
				{ check: 'body', contains: 'ready' },
				{ check: 'body', notContains: 'failure' }
			],
			status: 'degraded'
		},
		{
			name: 'full-body equality',
			chunks: ['ready', ' completed'],
			assertions: [
				{ check: 'body', contains: 'ready' },
				{ check: 'body', equals: 'ready completed' }
			],
			status: 'up'
		},
		{
			name: 'multiple operators on a body assertion',
			chunks: ['ready', ' completed'],
			assertions: [{ check: 'body', contains: 'ready', equals: 'ready completed' }],
			status: 'up'
		},
		{
			name: 'JSON assertion',
			chunks: ['{"message":"ready",', '"healthy":true}'],
			assertions: [
				{ check: 'body', contains: 'ready' },
				{ check: 'json.healthy', equals: true }
			],
			status: 'up'
		},
		{
			name: 'JSON extraction',
			chunks: ['{"message":"ready",', '"token":"secret"}'],
			assertions: [{ check: 'body', contains: 'ready' }],
			extract: { token: 'json.token' },
			status: 'up'
		}
	])('retains full body consumption for $name', async ({ chunks, assertions, extract, status }) => {
		const stream = streamedResponse(chunks.map((text) => encoder.encode(text)));
		const result = await checkResponse(stream.response, assertions, extract);
		expect(result.status).toBe(status);
		expect(stream.state().ended).toBe(true);
	});

	it('enforces the byte limit while searching for a missing token', async () => {
		const stream = streamedResponse([new Uint8Array(1024 * 1024), encoder.encode('x')]);
		const result = await checkResponse(stream.response, [{ check: 'body', contains: 'missing' }]);
		expect(result.status).toBe('down');
		expect(result.errorMessage).toContain('1 MiB');
		expect(stream.state().cancelled).toBe(true);
	});
});
