import { describe, expect, it } from 'bun:test';
import { cachePublicResponse } from './public-cache';

function fixture() {
	const entries = new Map<string, Response>();
	const pending: Promise<unknown>[] = [];
	let loads = 0;
	let matches = 0;
	const cache = {
		async match(request: Request) {
			matches++;
			return entries.get(request.url)?.clone();
		},
		async put(request: Request, response: Response) {
			entries.set(request.url, response.clone());
		}
	} as unknown as Cache;
	return {
		cache,
		entries,
		get loads() {
			return loads;
		},
		get matches() {
			return matches;
		},
		async run(
			request: Request,
			response = new Response('healthy', {
				headers: { 'Content-Type': 'text/html' }
			})
		) {
			const result = await cachePublicResponse(
				request,
				cache,
				(promise) => pending.push(promise),
				async () => {
					loads++;
					return response;
				}
			);
			await Promise.all(pending);
			return result;
		}
	};
}

function request(path = '/', init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	if (!headers.has('Accept')) headers.set('Accept', 'text/html');
	return new Request(`https://status.micelio.ai${path}`, { ...init, headers });
}

describe('public response cache', () => {
	it.each([
		['/', 'text/html'],
		['/status/micelio', 'text/html; charset=utf-8'],
		['/api/public/status', 'application/json']
	])(
		'reuses anonymous %s responses for sixty seconds without loading again',
		async (path, contentType) => {
			const state = fixture();
			const req = request(path);
			const fresh = await state.run(
				req,
				new Response('healthy', { headers: { 'Content-Type': contentType } })
			);
			const cached = await state.run(req);
			expect(await fresh.text()).toBe('healthy');
			expect(await cached.text()).toBe('healthy');
			expect(state.loads).toBe(1);
			const [[key, stored]] = [...state.entries];
			expect(key).toBe(req.url);
			expect(stored.headers.get('Cache-Control')).toContain('s-maxage=60');
			expect(fresh.headers.get('Cache-Control')).toBe('private, no-store');
			expect(cached.headers.get('Cache-Control')).toBe('private, no-store');
		}
	);

	it.each([
		request('/dashboard'),
		request('/login'),
		request('/status/micelio/unknown'),
		request('/api/public/other'),
		request('/?filter=all'),
		request('/', { method: 'POST' }),
		request('/', { method: 'HEAD' }),
		request('/', { headers: { Accept: 'application/json' } }),
		request('/', { headers: { Accept: 'text/html, application/json' } }),
		request('/', { headers: { Accept: 'text/x-component' } }),
		request('/', { headers: { Cookie: 'session=secret' } }),
		request('/', { headers: { Authorization: 'Bearer secret' } }),
		request('/', { headers: { Range: 'bytes=0-10' } })
	])('bypasses cache for request %s', async (req) => {
		const state = fixture();
		const response = new Response('live');
		expect(await state.run(req, response)).toBe(response);
		expect(state.matches).toBe(0);
		expect(state.entries.size).toBe(0);
	});

	it.each([
		new Response('error', { status: 500, headers: { 'Content-Type': 'text/html' } }),
		new Response(null, { status: 302, headers: { Location: '/login' } }),
		new Response('private', {
			headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'session=secret' }
		}),
		...['private', 'no-store', 'no-cache'].map(
			(directive) =>
				new Response('private', {
					headers: { 'Content-Type': 'text/html', 'Cache-Control': `max-age=120, ${directive}` }
				})
		),
		new Response('varies', { headers: { 'Content-Type': 'text/html', Vary: 'Cookie' } }),
		new Response('varies', { headers: { 'Content-Type': 'text/html', Vary: '*' } }),
		new Response('{}', { headers: { 'Content-Type': 'application/json' } })
	])('preserves unsafe responses without caching them', async (response) => {
		const state = fixture();
		expect(await state.run(request(), response)).toBe(response);
		expect(state.entries.size).toBe(0);
	});

	it('does not store an HTML response at the public JSON endpoint', async () => {
		const state = fixture();
		const response = new Response('<html>error</html>', {
			headers: { 'Content-Type': 'text/html' }
		});
		expect(await state.run(request('/api/public/status'), response)).toBe(response);
		expect(state.entries.size).toBe(0);
	});

	it('caches supported representation variation but keeps hostnames isolated', async () => {
		const state = fixture();
		await state.run(
			request(),
			new Response('healthy', {
				headers: { 'Content-Type': 'text/html', Vary: 'Accept, Accept-Encoding' }
			})
		);
		const otherHost = new Request('https://other.example/', { headers: { Accept: 'text/html' } });
		expect(await (await state.run(otherHost, new Response('other'))).text()).toBe('other');
		expect(state.loads).toBe(2);
	});

	it.each(['match', 'put'] as const)(
		'serves live responses if cache %s fails',
		async (operation) => {
			const pending: Promise<unknown>[] = [];
			const cache = {
				async match() {
					if (operation === 'match') throw new Error('cache unavailable');
				},
				async put() {
					if (operation === 'put') throw new Error('cache unavailable');
				}
			} as unknown as Cache;
			const response = await cachePublicResponse(
				request(),
				cache,
				(promise) => pending.push(promise),
				async () => new Response('healthy', { headers: { 'Content-Type': 'text/html' } })
			);
			await Promise.all(pending);
			expect(await response.text()).toBe('healthy');
		}
	);
});
