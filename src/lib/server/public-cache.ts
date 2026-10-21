const TTL_SECONDS = 60;

/** Cache only anonymous public representations; authenticated and parameterized requests stay live. */
export async function cachePublicResponse(
	request: Request,
	cache: Cache,
	waitUntil: (promise: Promise<unknown>) => void,
	load: () => Promise<Response>
): Promise<Response> {
	const url = new URL(request.url);
	const isJson = url.pathname === '/api/public/status';
	const isPage = url.pathname === '/' || /^\/status\/[^/]+$/.test(url.pathname);
	const accept = request.headers.get('Accept') || '';
	const acceptsHtml = accept.includes('text/html') && !accept.includes('application/json');
	if (
		request.method !== 'GET' ||
		url.search ||
		['Cookie', 'Authorization', 'Range'].some((header) => request.headers.has(header)) ||
		(!isJson && (!isPage || !acceptsHtml))
	) {
		return load();
	}

	const key = new Request(url.toString(), { method: 'GET' });
	try {
		const cached = await cache.match(key);
		if (cached) return liveResponse(cached);
	} catch {
		// Cache availability must not determine status-page availability.
	}

	const response = await load();
	const contentType = response.headers.get('Content-Type') || '';
	const cacheControl = response.headers.get('Cache-Control') || '';
	const vary = (response.headers.get('Vary') || '')
		.toLowerCase()
		.split(',')
		.map((header) => header.trim())
		.filter(Boolean);
	if (
		response.status !== 200 ||
		response.headers.has('Set-Cookie') ||
		/\b(private|no-store|no-cache)\b/i.test(cacheControl) ||
		vary.some((header) => !['accept', 'accept-encoding'].includes(header)) ||
		!contentType.includes(isJson ? 'application/json' : 'text/html')
	) {
		return response;
	}

	const publicResponse = new Response(response.body, response);
	publicResponse.headers.set('Cache-Control', `public, max-age=0, s-maxage=${TTL_SECONDS}`);
	waitUntil(
		cache.put(key, publicResponse.clone()).catch(() => {
			console.warn({ event: 'public_cache_write_failed' });
		})
	);
	return liveResponse(publicResponse);
}

function liveResponse(response: Response): Response {
	const live = new Response(response.body, response);
	// Only our explicit Cache API entry may be shared; disable the adapter/CDN cache.
	live.headers.set('Cache-Control', 'private, no-store');
	return live;
}
