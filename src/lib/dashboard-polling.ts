const STATUS_REFRESH_MS = 30_000;
const UPTIME_REFRESH_MS = 5 * 60_000;

export function startDashboardPolling(
	load: (includeUptime: boolean) => Promise<boolean>,
	page: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> = document
): () => void {
	let lastUptimeRefresh: number | null = null;
	let inFlight = false;
	let stopped = false;

	async function refresh() {
		if (stopped || page.hidden || inFlight) return;
		inFlight = true;
		const includeUptime =
			lastUptimeRefresh === null || Date.now() - lastUptimeRefresh >= UPTIME_REFRESH_MS;
		try {
			if (await load(includeUptime)) {
				if (includeUptime) lastUptimeRefresh = Date.now();
			}
		} finally {
			inFlight = false;
		}
	}

	function onVisibilityChange() {
		void refresh();
	}

	void refresh();
	const interval = setInterval(() => void refresh(), STATUS_REFRESH_MS);
	page.addEventListener('visibilitychange', onVisibilityChange);
	return () => {
		stopped = true;
		clearInterval(interval);
		page.removeEventListener('visibilitychange', onVisibilityChange);
	};
}
