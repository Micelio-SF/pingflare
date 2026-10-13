-- Micelio database reachability, probed through the public API's /api/db-health
-- route. The endpoint runs a single SELECT 1 and is rate limited to one request
-- per 30 seconds per client, so the 60 second interval below leaves headroom.

INSERT INTO monitors (id, name, script, group_id, interval_seconds, timeout_ms, active)
VALUES
  (
    'micelio-database',
    'Micelio Database',
    '{"steps":[{"name":"db_health","request":{"method":"GET","url":"https://api.micelio.ai/api/db-health"},"assert":[{"check":"status","equals":200,"severity":"down"},{"check":"json.database","equals":"up","severity":"down"},{"check":"responseTime","lessThan":5000,"severity":"degraded"}]}]}',
    'micelio-services',
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
