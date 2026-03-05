-- Migration 013: fix territory tables + add missing events columns
--
-- 1. Drops and recreates territory tables that were partially created on Railway
--    due to a failed 010_territory_snapshots.sql. Safe: no territory data on Railway.
-- 2. Adds month_start/day_start/month_end/day_end/sitelinks_count to events —
--    these were added locally but never via a migration.

DROP TABLE IF EXISTS territory_name_mappings CASCADE;
DROP TABLE IF EXISTS snapshot_polygons CASCADE;
DROP TABLE IF EXISTS territory_snapshots CASCADE;

CREATE TABLE IF NOT EXISTS territory_snapshots (
  snapshot_year   INT PRIMARY KEY,
  source          TEXT NOT NULL DEFAULT 'historical-basemaps',
  hb_filename     TEXT,
  hb_commit_sha   TEXT,
  polygon_count   INT NOT NULL DEFAULT 0,
  imported_count  INT NOT NULL DEFAULT 0,
  verified_count  INT NOT NULL DEFAULT 0,
  edited_count    INT NOT NULL DEFAULT 0,
  loaded_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS snapshot_polygons (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_year    INT NOT NULL REFERENCES territory_snapshots(snapshot_year) ON DELETE CASCADE,
  hb_name          TEXT NOT NULL,
  hb_abbrevn       TEXT,
  hb_subjecto      TEXT,
  hb_partof        TEXT,
  border_precision INT,
  polity_id        UUID REFERENCES polities(id) ON DELETE SET NULL,
  boundary         JSONB NOT NULL,
  accuracy         TEXT NOT NULL DEFAULT 'imported',
  sub_year_start   INT,
  sub_year_end     INT,
  source_polygon_id UUID REFERENCES snapshot_polygons(id) ON DELETE SET NULL,
  edited_at        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS snapshot_polygons_snapshot_year_idx ON snapshot_polygons(snapshot_year);
CREATE INDEX IF NOT EXISTS snapshot_polygons_polity_id_idx     ON snapshot_polygons(polity_id);
CREATE INDEX IF NOT EXISTS snapshot_polygons_hb_name_idx       ON snapshot_polygons(hb_name);
CREATE INDEX IF NOT EXISTS snapshot_polygons_accuracy_idx      ON snapshot_polygons(accuracy);

CREATE TABLE IF NOT EXISTS territory_name_mappings (
  hb_name       TEXT NOT NULL,
  snapshot_year INT NOT NULL,
  polity_id     UUID REFERENCES polities(id) ON DELETE SET NULL,
  wikidata_qid  TEXT,
  confidence    TEXT NOT NULL DEFAULT 'auto',
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (hb_name, snapshot_year)
);

CREATE INDEX IF NOT EXISTS territory_name_mappings_polity_id_idx     ON territory_name_mappings(polity_id);
CREATE INDEX IF NOT EXISTS territory_name_mappings_wikidata_qid_idx  ON territory_name_mappings(wikidata_qid);
CREATE INDEX IF NOT EXISTS territory_name_mappings_snapshot_year_idx ON territory_name_mappings(snapshot_year);

-- Add missing events columns (were added locally but never via a migration)
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS month_start     SMALLINT,
  ADD COLUMN IF NOT EXISTS day_start       SMALLINT,
  ADD COLUMN IF NOT EXISTS month_end       SMALLINT,
  ADD COLUMN IF NOT EXISTS day_end         SMALLINT,
  ADD COLUMN IF NOT EXISTS sitelinks_count INT;

-- Add missing polities column
ALTER TABLE polities
  ADD COLUMN IF NOT EXISTS sitelinks_count INT;
