-- 018_ohm_territory_source.sql
-- Tag all existing HB territories, add OHM-specific columns.

UPDATE territories SET source = 'hb' WHERE source IS NULL;
ALTER TABLE territories ALTER COLUMN source SET DEFAULT 'hb';
ALTER TABLE territories ALTER COLUMN source SET NOT NULL;
ALTER TABLE territories
  ADD COLUMN IF NOT EXISTS ohm_relation_id  BIGINT,
  ADD COLUMN IF NOT EXISTS ohm_name         TEXT,
  ADD COLUMN IF NOT EXISTS ohm_admin_level  SMALLINT,
  ADD COLUMN IF NOT EXISTS ohm_wikidata_qid TEXT;
CREATE INDEX IF NOT EXISTS territories_source ON territories (source);
CREATE INDEX IF NOT EXISTS territories_ohm_relation_id ON territories (ohm_relation_id) WHERE ohm_relation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS territories_ohm_wikidata_qid ON territories (ohm_wikidata_qid) WHERE ohm_wikidata_qid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS territories_ohm_unique ON territories (ohm_relation_id) WHERE ohm_relation_id IS NOT NULL;
