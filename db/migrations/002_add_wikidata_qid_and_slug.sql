-- Migration 002: add wikidata_qid and slug to events and cities
--
-- wikidata_qid: Wikidata entity ID (e.g. 'Q131969') used for deduplication
--               and incremental pipeline updates.
--
-- slug: Human-readable, URL-safe identifier derived from wikipedia_title
--       (spaces → underscores, e.g. 'Battle_of_Thermopylae').
--       Used as the stable public ID for cross-entity linking in the frontend.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS wikidata_qid TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS slug         TEXT UNIQUE;

ALTER TABLE cities
  ADD COLUMN IF NOT EXISTS wikidata_qid TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS slug         TEXT UNIQUE;

-- Index slug lookups (resolving entity links in frontend navigation)
CREATE INDEX IF NOT EXISTS events_slug_idx ON events (slug);
CREATE INDEX IF NOT EXISTS cities_slug_idx ON cities (slug);

-- Back-fill slug for existing seed data rows (wikipedia_title → slug)
UPDATE events SET slug = REPLACE(wikipedia_title, ' ', '_') WHERE slug IS NULL;
UPDATE cities SET slug = REPLACE(wikipedia_title, ' ', '_') WHERE slug IS NULL;

-- Rename category: natural_disaster → disaster (expanded category set)
UPDATE events
  SET categories = ARRAY_REPLACE(categories, 'natural_disaster', 'disaster')
  WHERE 'natural_disaster' = ANY(categories);
