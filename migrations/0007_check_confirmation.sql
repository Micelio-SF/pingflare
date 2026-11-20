-- Preserve observations while separating confirmed outages from isolated failures.
ALTER TABLE checks ADD COLUMN observed_status TEXT CHECK (observed_status IN ('up', 'down', 'degraded'));
ALTER TABLE checks ADD COLUMN is_slow INTEGER NOT NULL DEFAULT 0 CHECK (is_slow IN (0, 1));
ALTER TABLE checks ADD COLUMN cf_ray TEXT;
ALTER TABLE checks ADD COLUMN run_id TEXT;

ALTER TABLE daily_status ADD COLUMN unconfirmed_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_status ADD COLUMN slow_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_status ADD COLUMN legacy_down_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_status ADD COLUMN inferred_isolated_checks INTEGER NOT NULL DEFAULT 0;
UPDATE daily_status SET legacy_down_checks = down_checks;

-- Snapshot neighbors before updating any status. Calendar boundaries do not break a run.
CREATE TABLE _check_confirmation_backfill (
  id INTEGER PRIMARY KEY,
  observed_status TEXT,
  public_status TEXT NOT NULL
);
INSERT INTO _check_confirmation_backfill
WITH neighbors AS (
  SELECT c.id, c.status, c.checked_at, m.timeout_ms,
    LAG(c.status) OVER history AS previous_status,
    LAG(UNIXEPOCH(c.checked_at)) OVER history AS previous_time,
    LEAD(c.status) OVER history AS next_status,
    LEAD(UNIXEPOCH(c.checked_at)) OVER history AS next_time
  FROM checks c JOIN monitors m ON m.id = c.monitor_id
  WINDOW history AS (PARTITION BY c.monitor_id ORDER BY c.checked_at, c.id)
), classified AS (
  SELECT *, CASE WHEN
    (previous_status = 'down' AND UNIXEPOCH(checked_at) - previous_time BETWEEN 30 AND 120 + timeout_ms / 1000.0)
    OR (next_status = 'down' AND next_time - UNIXEPOCH(checked_at) BETWEEN 30 AND 120 + timeout_ms / 1000.0)
    THEN 1 ELSE 0 END AS has_pair
  FROM neighbors
)
SELECT id,
  CASE WHEN status = 'down' AND has_pair = 0 AND (previous_status IS NULL OR next_status IS NULL)
    THEN NULL ELSE status END,
  CASE WHEN status = 'down' AND has_pair = 0 AND previous_status IS NOT NULL AND next_status IS NOT NULL
    THEN 'degraded' ELSE status END
FROM classified;

UPDATE checks SET
  observed_status = (SELECT observed_status FROM _check_confirmation_backfill b WHERE b.id = checks.id),
  status = (SELECT public_status FROM _check_confirmation_backfill b WHERE b.id = checks.id)
WHERE id IN (SELECT id FROM _check_confirmation_backfill);
DROP TABLE _check_confirmation_backfill;

-- Retained raw history can be partial. Replace complete days only; for partial
-- days adjust just the failed attempts whose classification we can establish.
CREATE TABLE _check_confirmation_days AS
SELECT monitor_id, DATE(checked_at) AS date, COUNT(*) AS total_checks,
  SUM(status = 'up') AS up_checks,
  SUM(status = 'down') AS down_checks,
  SUM(status = 'degraded') AS degraded_checks,
  SUM(observed_status = 'down' AND status = 'degraded') AS isolated_checks,
  SUM(observed_status = 'down' AND status = 'down') AS confirmed_checks,
  SUM(observed_status IS NULL AND status = 'down') AS legacy_down_checks
FROM checks GROUP BY monitor_id, DATE(checked_at);
CREATE UNIQUE INDEX _check_confirmation_days_key ON _check_confirmation_days(monitor_id, date);

UPDATE daily_status AS d SET
  down_checks = MAX(0, d.down_checks - COALESCE(s.isolated_checks, 0)),
  degraded_checks = d.degraded_checks + COALESCE(s.isolated_checks, 0),
  unconfirmed_checks = COALESCE(s.isolated_checks, 0),
  legacy_down_checks = MAX(0, d.down_checks - COALESCE(s.isolated_checks, 0) - COALESCE(s.confirmed_checks, 0)),
  downtime_minutes = ROUND(1440.0 * MAX(0, d.down_checks - COALESCE(s.isolated_checks, 0)) / d.total_checks)
FROM _check_confirmation_days s
WHERE d.monitor_id = s.monitor_id AND d.date = s.date AND d.total_checks != s.total_checks;

UPDATE daily_status AS d SET
  up_checks = s.up_checks, down_checks = s.down_checks, degraded_checks = s.degraded_checks,
  unconfirmed_checks = COALESCE(s.isolated_checks, 0), legacy_down_checks = s.legacy_down_checks,
  downtime_minutes = ROUND(1440.0 * s.down_checks / s.total_checks)
FROM _check_confirmation_days s
WHERE d.monitor_id = s.monitor_id AND d.date = s.date AND d.total_checks = s.total_checks;

-- Requested historical policy: one failed check estimated at at most a minute
-- is green when only daily evidence remains. Record that this is an inference.
UPDATE daily_status AS d SET
  down_checks = 0, degraded_checks = degraded_checks + 1,
  unconfirmed_checks = unconfirmed_checks + 1, legacy_down_checks = 0,
  inferred_isolated_checks = 1, downtime_minutes = 0
WHERE down_checks = 1 AND legacy_down_checks = 1 AND downtime_minutes <= 1
  AND NOT EXISTS (SELECT 1 FROM _check_confirmation_days s
    WHERE s.monitor_id = d.monitor_id AND s.date = d.date AND s.total_checks = d.total_checks);
DROP TABLE _check_confirmation_days;
