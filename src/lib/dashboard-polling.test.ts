import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { startDashboardPolling } from './dashboard-polling';

class Page extends EventTarget {
	hidden = false;

	setHidden(hidden: boolean) {
		this.hidden = hidden;
		this.dispatchEvent(new Event('visibilitychange'));
	}
}

let now: number;
let timer: () => void;
let intervalMs: number | undefined;
let stop: (() => void) | undefined;
let clock: ReturnType<typeof spyOn<typeof Date, 'now'>>;
let interval: ReturnType<typeof spyOn<typeof globalThis, 'setInterval'>>;
let clear: ReturnType<typeof spyOn<typeof globalThis, 'clearInterval'>>;

beforeEach(() => {
	now = 0;
	clock = spyOn(Date, 'now').mockImplementation(() => now);
	interval = spyOn(globalThis, 'setInterval').mockImplementation((callback, delay) => {
		timer = callback as () => void;
		intervalMs = delay;
		return 1 as unknown as ReturnType<typeof setInterval>;
	});
	clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
});

afterEach(() => {
	stop?.();
	stop = undefined;
	clock.mockRestore();
	interval.mockRestore();
	clear.mockRestore();
});

async function tick(timestamp: number) {
	now = timestamp;
	timer();
	await Promise.resolve();
}

describe('dashboard polling', () => {
	it('refreshes status every 30 seconds and availability every five minutes, then cleans up', async () => {
		const page = new Page();
		const removeListener = spyOn(page, 'removeEventListener');
		const load = mock<(includeUptime: boolean) => Promise<boolean>>(async () => true);
		stop = startDashboardPolling(load, page);
		await Promise.resolve();
		expect(intervalMs).toBe(30_000);
		for (let time = 30_000; time < 300_000; time += 30_000) await tick(time);
		expect(load.mock.calls.map(([includeUptime]) => includeUptime)).toEqual([
			true,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false,
			false
		]);
		await tick(300_000);
		expect(load.mock.calls.at(-1)).toEqual([true]);
		stop();
		stop = undefined;
		expect(clear).toHaveBeenCalledTimes(1);
		expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
		await tick(600_000);
		page.setHidden(false);
		await Promise.resolve();
		expect(load).toHaveBeenCalledTimes(11);
	});

	it('does no work while hidden and refreshes immediately when the tab becomes visible', async () => {
		const page = new Page();
		page.hidden = true;
		const load = mock<(includeUptime: boolean) => Promise<boolean>>(async () => true);
		stop = startDashboardPolling(load, page);
		await tick(30_000);
		expect(load).not.toHaveBeenCalled();
		page.setHidden(false);
		await Promise.resolve();
		expect(load.mock.calls).toEqual([[true]]);
		page.setHidden(true);
		await tick(60_000);
		await tick(600_000);
		expect(load).toHaveBeenCalledTimes(1);
		page.setHidden(false);
		await Promise.resolve();
		expect(load.mock.calls).toEqual([[true], [true]]);
	});

	it('suppresses overlapping loads and measures availability freshness from successful completion', async () => {
		let finish!: (success: boolean) => void;
		const pending = new Promise<boolean>((resolve) => {
			finish = resolve;
		});
		const load = mock<(includeUptime: boolean) => Promise<boolean>>(() => pending);
		const page = new Page();
		stop = startDashboardPolling(load, page);
		await tick(30_000);
		page.setHidden(false);
		await tick(300_000);
		expect(load).toHaveBeenCalledTimes(1);
		finish(true);
		await Promise.resolve();
		load.mockImplementation(async () => true);
		await tick(330_000);
		expect(load.mock.calls.at(-1)).toEqual([false]);
		await tick(600_000);
		expect(load.mock.calls.at(-1)).toEqual([true]);
	});

	it('retries availability after a failed load instead of treating it as fresh', async () => {
		const load = mock<(includeUptime: boolean) => Promise<boolean>>(async () => false);
		stop = startDashboardPolling(load, new Page());
		await Promise.resolve();
		load.mockImplementation(async () => true);
		await tick(30_000);
		await tick(60_000);
		expect(load.mock.calls).toEqual([[true], [true], [false]]);
	});
});
