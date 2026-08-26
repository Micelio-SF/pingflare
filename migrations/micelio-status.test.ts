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
				name: 'Dependencias externas',
				slug: 'dependencias-externas',
				is_public: 1,
				display_order: 20
			}
		]);
	});

	it('creates five active monitors with valid scripts and stable endpoints', () => {
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
			'API pública de Micelio',
			'Google Gemini API',
			'OpenRouter API',
			'Servicio de Impuestos Internos',
			'Web de Micelio'
		]);
		expect(monitors.every(({ active }) => active === 1)).toBe(true);
		expect(monitors.every(({ interval_seconds }) => interval_seconds === 60)).toBe(true);
		expect(monitors.every(({ timeout_ms }) => timeout_ms === 15000)).toBe(true);
		expect(monitors.every(({ script }) => validateScript(script).valid)).toBe(true);
		expect(monitors.map(({ group_id }) => group_id)).toEqual([
			'micelio-services',
			'micelio-dependencies',
			'micelio-dependencies',
			'micelio-dependencies',
			'micelio-services'
		]);

		const scripts = monitors.map(({ script }) => JSON.parse(script));
		const urls = scripts.map(({ steps }) => steps[0].request.url);
		const methods = scripts.map(({ steps }) => steps[0].request.method);
		expect(urls).toEqual([
			'https://api.micelio.ai/',
			'https://generativelanguage.googleapis.com/v1beta/models',
			'https://openrouter.ai/api/v1/models',
			'https://homer.sii.cl/',
			'https://micelio.ai/'
		]);
		expect(methods).toEqual(['GET', 'GET', 'HEAD', 'GET', 'GET']);
		expect(scripts.map(({ steps }) => steps[0].assert)).toEqual([
			[
				{ check: 'status', equals: 200, severity: 'down' },
				{ check: 'json.status', equals: 'public', severity: 'down' },
				{ check: 'responseTime', lessThan: 5000, severity: 'degraded' }
			],
			[
				{ check: 'status', equals: 403, severity: 'down' },
				{ check: 'body', contains: 'PERMISSION_DENIED', severity: 'down' },
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
			],
			[
				{ check: 'status', equals: 200, severity: 'down' },
				{ check: 'body', contains: 'Micelio', severity: 'down' },
				{ check: 'responseTime', lessThan: 5000, severity: 'degraded' }
			]
		]);
	});

	it('can safely reapply the seed without duplicating records', () => {
		const database = createSeededDatabase();
		const seed = readFileSync(join(migrationsDirectory, '0002_micelio_status.sql'), 'utf8');
		database.exec(seed);

		expect(database.query('SELECT COUNT(*) AS count FROM monitor_groups').get()).toEqual({
			count: 2
		});
		expect(database.query('SELECT COUNT(*) AS count FROM monitors').get()).toEqual({ count: 5 });
	});
});
