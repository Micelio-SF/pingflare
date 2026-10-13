/** D1's CURRENT_TIMESTAMP is UTC but omits the timezone marker. */
export function isMonitorDue(
	checkedAt: string | undefined,
	intervalSeconds: number,
	now: number
): boolean {
	if (!checkedAt) return true;
	const timestamp = checkedAt.includes('T') ? checkedAt : checkedAt.replace(' ', 'T') + 'Z';
	const lastCheckedMs = Date.parse(timestamp);
	return !Number.isFinite(lastCheckedMs) || now - lastCheckedMs >= intervalSeconds * 1000;
}
