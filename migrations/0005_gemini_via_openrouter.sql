-- Gemini reachability through OpenRouter, using OpenRouter's own published
-- provider health for the model. Anonymous endpoint: no key, no inference.

INSERT INTO monitors (id, name, script, group_id, interval_seconds, timeout_ms, active)
VALUES
  (
    'gemini-via-openrouter',
    'Gemini via OpenRouter',
    '{"steps":[{"name":"gemini_via_openrouter","request":{"method":"GET","url":"https://openrouter.ai/api/v1/models/google/gemini-2.5-flash/endpoints"},"assert":[{"check":"status","equals":200,"severity":"down"},{"check":"json.data.id","equals":"google/gemini-2.5-flash","severity":"down"},{"check":"json.data.endpoints.length","greaterThan":0,"severity":"down"},{"check":"json.data.endpoints[0].status","equals":0,"severity":"down"},{"check":"json.data.endpoints[0].uptime_last_30m","greaterThan":90,"severity":"degraded"},{"check":"responseTime","lessThan":5000,"severity":"degraded"}]}]}',
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
  active = excluded.active;
