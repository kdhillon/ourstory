-- Migration 003: data versioning
--
-- data_version: integer, incremented whenever pipeline logic that affects
--   a record's correctness changes. Lets us identify stale records that
--   should be re-parsed after a pipeline improvement.
--
--   Version history:
--     1 — initial pipeline (Run 1, before P31 non-settlement denylist)
--     2 — P31 denylist added; non-settlement cities removed; events
--         re-anchored to direct coordinates (2026-03-01)
--
-- pipeline_run: human-readable run identifier, e.g. 'run-2026-03-01-v2'
--   Useful for tracing which batch created a record.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS data_version   INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS pipeline_run   TEXT;

ALTER TABLE cities
  ADD COLUMN IF NOT EXISTS data_version   INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS pipeline_run   TEXT;

-- Mark all pre-existing records as version 1 (created before this migration)
-- so they can be identified as candidates for re-enrichment.
UPDATE events SET data_version = 1 WHERE data_version = 2;
UPDATE cities SET data_version = 1 WHERE data_version = 2;

CREATE INDEX IF NOT EXISTS events_data_version_idx ON events (data_version);
CREATE INDEX IF NOT EXISTS cities_data_version_idx ON cities (data_version);
