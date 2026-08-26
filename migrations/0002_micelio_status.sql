-- Micelio status-page defaults. Stable IDs keep the seed safe to reapply.

INSERT INTO monitor_groups (id, name, slug, description, is_public, display_order)
VALUES
  ('micelio-services', 'Micelio', 'micelio', 'Availability of Micelio public services.', 1, 10),
  ('micelio-dependencies', 'External dependencies', 'external-dependencies', 'Third-party services required to operate Micelio.', 1, 20)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  slug = excluded.slug,
  description = excluded.description,
  is_public = excluded.is_public,
  display_order = excluded.display_order;

INSERT INTO monitors (id, name, script, group_id, interval_seconds, timeout_ms, active)
VALUES
  (
    'micelio-public-api',
    'Micelio Public API',
    '{"steps":[{"name":"public_api","request":{"method":"GET","url":"https://api.micelio.ai/"},"assert":[{"check":"status","equals":200,"severity":"down"},{"check":"json.status","equals":"public","severity":"down"},{"check":"responseTime","lessThan":5000,"severity":"degraded"}]}]}',
    'micelio-services',
    60,
    15000,
    1
  ),
  (
    'micelio-web',
    'Micelio Website',
    '{"steps":[{"name":"website","request":{"method":"GET","url":"https://micelio.ai/"},"assert":[{"check":"status","equals":200,"severity":"down"},{"check":"body","contains":"Micelio","severity":"down"},{"check":"responseTime","lessThan":5000,"severity":"degraded"}]}]}',
    'micelio-services',
    60,
    15000,
    1
  ),
  (
    'sii-landing',
    'SII',
    '{"steps":[{"name":"landing","request":{"method":"GET","url":"https://homer.sii.cl/"},"assert":[{"check":"status","equals":200,"severity":"down"},{"check":"body","contains":"Servicio de Impuestos Internos","severity":"down"},{"check":"responseTime","lessThan":10000,"severity":"degraded"}]}]}',
    'micelio-dependencies',
    60,
    15000,
    1
  ),
  (
    'openrouter-api',
    'OpenRouter API',
    '{"steps":[{"name":"models","request":{"method":"HEAD","url":"https://openrouter.ai/api/v1/models"},"assert":[{"check":"status","equals":200,"severity":"down"},{"check":"responseTime","lessThan":5000,"severity":"degraded"}]}]}',
    'micelio-dependencies',
    60,
    15000,
    1
  ),
  (
    'gemini-api',
    'Google Gemini API',
    '{"steps":[{"name":"unauthenticated_models","request":{"method":"GET","url":"https://generativelanguage.googleapis.com/v1beta/models"},"assert":[{"check":"status","equals":403,"severity":"down"},{"check":"body","contains":"PERMISSION_DENIED","severity":"down"},{"check":"responseTime","lessThan":5000,"severity":"degraded"}]}]}',
    'micelio-dependencies',
    60,
    15000,
    1
  )
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  script = excluded.script,
  group_id = excluded.group_id,
  interval_seconds = excluded.interval_seconds,
  timeout_ms = excluded.timeout_ms,
  active = excluded.active,
  updated_at = datetime('now');
