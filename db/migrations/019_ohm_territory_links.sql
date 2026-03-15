-- 019_ohm_territory_links.sql
--
-- Lightweight link table for OHM territory coloring.
-- No geometry stored — polygons are rendered live from OHM vector tiles.
-- ohm_relation_id is the OSM relation ID (accessible via feature.id in MapLibre).

CREATE TABLE IF NOT EXISTS ohm_territory_links (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ohm_relation_id     BIGINT      NOT NULL,
  ohm_name            TEXT,
  ohm_wikidata_qid    TEXT,         -- from OHM wikidata tag, e.g. "Q34"
  ohm_admin_level     SMALLINT,
  polity_id           UUID        REFERENCES polities(id) ON DELETE SET NULL,
  explicitly_unlinked BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ohm_relation_id)
);

CREATE INDEX IF NOT EXISTS ohm_territory_links_polity_id_idx
  ON ohm_territory_links (polity_id)
  WHERE polity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ohm_territory_links_wikidata_idx
  ON ohm_territory_links (ohm_wikidata_qid)
  WHERE ohm_wikidata_qid IS NOT NULL;
