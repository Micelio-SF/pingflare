import { describe, expect, it } from 'bun:test';
import { isMonitorDue } from './scheduling';

describe('monitor intervals', () => {
	const now = Date.parse('2026-10-12T12:01:00Z');
	it('runs monitors with no history or invalid timestamps', () => {
		expect(isMonitorDue(undefined, 60, now)).toBe(true);
		expect(isMonitorDue('invalid', 60, now)).toBe(true);
	});
	it('interprets D1 timestamps as UTC and respects interval boundaries', () => {
		expect(isMonitorDue('2026-10-12 12:00:00', 60, now)).toBe(true);
		expect(isMonitorDue('2026-10-12 12:00:01', 60, now)).toBe(false);
	});
	it('skips longer intervals until they are due', () => {
		expect(isMonitorDue('2026-10-12T12:00:00.000Z', 300, now)).toBe(false);
		expect(isMonitorDue('2026-10-12T11:56:00.000Z', 300, now)).toBe(true);
	});
});
