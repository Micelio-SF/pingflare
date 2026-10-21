import { expect, it } from 'bun:test';
import type { Handle } from '@sveltejs/kit';
import { handle } from './hooks.server';

it('returns the router 404 for scanner paths without reading D1 or session cookies', async () => {
	const response = new Response('Not found', { status: 404 });
	const event = {
		route: { id: null },
		url: new URL('https://status.micelio.ai/sonicui/7/sslvpn-portal/'),
		request: new Request('https://status.micelio.ai/sonicui/7/sslvpn-portal/'),
		locals: {},
		cookies: {
			get() {
				throw new Error('Unexpected session lookup');
			}
		},
		platform: {
			env: {
				DB: {
					prepare() {
						throw new Error('Unexpected D1 query');
					}
				}
			}
		}
	} as unknown as Parameters<Handle>[0]['event'];
	const result = await handle({ event, resolve: async () => response });
	expect(result).toBe(response);
	expect(result.status).toBe(404);
});

it.each([{ Cookie: 'session=secret' }, { Accept: 'application/json' }])(
	'keeps public cache isolated from adapter lookups for ineligible requests (%j)',
	async (headers) => {
		const pending: Promise<unknown>[] = [];
		function cache() {
			const entries = new Map<string, Response>();
			return {
				async match(request: Request) {
					return entries.get(request.url)?.clone();
				},
				async put(request: Request, response: Response) {
					entries.set(request.url, response.clone());
				}
			} as unknown as Cache;
		}
		const adapterCache = cache();
		const namedCache = cache();
		const platform = {
			env: {
				DB: {
					prepare() {
						throw new Error('Unexpected D1 query');
					}
				}
			},
			context: {
				waitUntil(promise: Promise<unknown>) {
					pending.push(promise);
				}
			},
			caches: {
				default: adapterCache,
				async open() {
					return namedCache;
				}
			}
		};
		let loads = 0;
		async function run(request: Request) {
			const event = {
				route: { id: '/' },
				url: new URL(request.url),
				request,
				locals: {},
				platform
			} as unknown as Parameters<Handle>[0]['event'];
			const result = await handle({
				event,
				resolve: async () => {
					loads++;
					return new Response(`live ${loads}`, { headers: { 'Content-Type': 'text/html' } });
				}
			});
			await Promise.all(pending);
			return result;
		}
		const publicRequest = new Request('https://status.micelio.ai/', {
			headers: { Accept: 'text/html' }
		});
		await run(publicRequest);
		expect(await (await run(publicRequest)).text()).toBe('live 1');
		const ineligibleRequest = new Request(publicRequest.url, { headers });
		expect(await adapterCache.match(ineligibleRequest)).toBeUndefined();
		expect(await (await run(ineligibleRequest)).text()).toBe('live 2');
		expect(loads).toBe(2);
	}
);
