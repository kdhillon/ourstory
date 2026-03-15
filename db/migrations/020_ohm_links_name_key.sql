-- 020_ohm_links_name_key.sql
--
-- OHM vector tiles have no stable feature IDs (all tiles return id=0).
-- Switch the unique key from ohm_relation_id to ohm_name so that polity
-- assignments are keyed by territory name instead of an unusable integer.
--
-- ohm_relation_id is made nullable (kept for forward-compat if OHM ever adds IDs).

ALTER TABLE ohm_territory_links
  ALTER COLUMN ohm_relation_id DROP NOT NULL,
  ALTER COLUMN ohm_name SET NOT NULL;

-- Drop the old unique constraint on relation_id and add one on name.
ALTER TABLE ohm_territory_links DROP CONSTRAINT IF EXISTS ohm_territory_links_ohm_relation_id_key;
ALTER TABLE ohm_territory_links ADD CONSTRAINT ohm_territory_links_ohm_name_key UNIQUE (ohm_name);

-- Re-create wikidata index (no change, just ensures it exists post-migration).
CREATE INDEX IF NOT EXISTS ohm_territory_links_wikidata_idx
  ON ohm_territory_links (ohm_wikidata_qid)
  WHERE ohm_wikidata_qid IS NOT NULL;
