import { describe, expect, it } from 'bun:test';
import { PUBLIC_STATUS_DESCRIPTION, PUBLIC_STATUS_TITLE } from './brand';

describe('Micelio status branding', () => {
	it('uses Micelio-specific public metadata', () => {
		expect(PUBLIC_STATUS_TITLE).toBe('Micelio Status');
		expect(PUBLIC_STATUS_DESCRIPTION).toBe(
			'Operational status of Micelio and its external dependencies.'
		);
	});
});
