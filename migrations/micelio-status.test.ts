import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateScript } from '../src/lib/server/checkers/script';

const migrationsDirectory = import.meta.dir;

function createSeededDatabase(): Database {
	const database = new Database(':memory:');
	database.exec(readFileSync(join(migrationsDirectory, '0001_schema.sql'), 'utf8'));
	database.exec(readFileSync(join(migrationsDirectory, '0002_micelio_status.sql'), 'utf8'));
	database.exec(readFileSync(join(migrationsDirectory, '0003_english_status_labels.sql'), 'utf8'));
	database.exec(readFileSync(join(migrationsDirectory, '0005_gemini_via_openrouter.sql'), 'utf8'));
	return database;
}

describe('Micelio status seed', () => {
	it('creates the public Micelio and external dependency groups', () => {
		const database = createSeededDatabase();
		const groups = database
			.query(
				'SELECT name, slug, is_public, display_order FROM monitor_groups ORDER BY display_order'
			)
			.all();

		expect(groups).toEqual([
			{ name: 'Micelio', slug: 'micelio', is_public: 1, display_order: 10 },
			{
				name: 'External dependencies',
				slug: 'external-dependencies',
				is_public: 1,
				display_order: 20
			}
		]);
	});

	it('creates six active monitors with valid scripts and stable endpoints', () => {
		const database = createSeededDatabase();
		const monitors = database
			.query(
				'SELECT name, script, group_id, interval_seconds, timeout_ms, active FROM monitors ORDER BY name'
			)
			.all() as Array<{
			name: string;
			script: string;
			group_id: string;
			interval_seconds: number;
			timeout_ms: number;
			active: number;
		}>;

		expect(monitors.map(({ name }) => name)).toEqual([
			'Gemini via OpenRouter',
			'Google Gemini API',
			'Micelio Public API',
			'Micelio Website',
			'OpenRouter API',
			'SII'
		]);
		expect(monitors.every(({ active }) => active === 1)).toBe(true);
		expect(monitors.every(({ interval_seconds }) => interval_seconds === 60)).toBe(true);
		expect(monitors.every(({ timeout_ms }) => timeout_ms === 15000)).toBe(true);
		expect(monitors.every(({ script }) => validateScript(script).valid)).toBe(true);
		expect(monitors.map(({ group_id }) => group_id)).toEqual([
			'micelio-dependencies',
			'micelio-dependencies',
			'micelio-services',
			'micelio-services',
			'micelio-dependencies',
			'micelio-dependencies'
		]);

		const scripts = monitors.map(({ script }) => JSON.parse(script));
		const urls = scripts.map(({ steps }) => steps[0].request.url);
		const methods = scripts.map(({ steps }) => steps[0].request.method);
		expect(urls).toEqual([
			'https://openrouter.ai/api/v1/models/google/gemini-2.5-flash/endpoints',
			'https://generativelanguage.googleapis.com/v1beta/models',
			'https://api.micelio.ai/',
			'https://micelio.ai/',
			'https://openrouter.ai/api/v1/models',
			'https://homer.sii.cl/'
		]);
		expect(methods).toEqual(['GET', 'GET', 'GET', 'GET', 'HEAD', 'GET']);
		expect(scripts.map(({ steps }) => steps[0].assert)).toEqual([
			[
				{ check: 'status', equals: 200, severity: 'down' },
				{ check: 'json.data.id', equals: 'google/gemini-2.5-flash', severity: 'down' },
				{ check: 'json.data.endpoints.length', greaterThan: 0, severity: 'down' },
				{ check: 'json.data.endpoints[0].status', equals: 0, severity: 'down' },
				{
					check: 'json.data.endpoints[0].uptime_last_30m',
					greaterThan: 90,
					severity: 'degraded'
				},
				{ check: 'responseTime', lessThan: 5000, severity: 'degraded' }
			],
			[
				{ check: 'status', equals: 403, severity: 'down' },
				{ check: 'body', contains: 'PERMISSION_DENIED', severity: 'down' },
				{ check: 'responseTime', lessThan: 5000, severity: 'degraded' }
			],
			[
				{ check: 'status', equals: 200, severity: 'down' },
				{ check: 'json.status', equals: 'public', severity: 'down' },
				{ check: 'responseTime', lessThan: 5000, severity: 'degraded' }
			],
			[
				{ check: 'status', equals: 200, severity: 'down' },
				{ check: 'body', contains: 'Micelio', severity: 'down' },
				{ check: 'responseTime', lessThan: 5000, severity: 'degraded' }
			],
			[
				{ check: 'status', equals: 200, severity: 'down' },
				{ check: 'responseTime', lessThan: 5000, severity: 'degraded' }
			],
			[
				{ check: 'status', equals: 200, severity: 'down' },
				{ check: 'body', contains: 'Servicio de Impuestos Internos', severity: 'down' },
				{ check: 'responseTime', lessThan: 10000, severity: 'degraded' }
			]
		]);
	});

	it('can safely reapply the seed without duplicating records', () => {
		const database = createSeededDatabase();
		database.exec(readFileSync(join(migrationsDirectory, '0002_micelio_status.sql'), 'utf8'));
		database.exec(readFileSync(join(migrationsDirectory, '0005_gemini_via_openrouter.sql'), 'utf8'));

		expect(database.query('SELECT COUNT(*) AS count FROM monitor_groups').get()).toEqual({
			count: 2
		});
		expect(database.query('SELECT COUNT(*) AS count FROM monitors').get()).toEqual({ count: 6 });
	});
});
