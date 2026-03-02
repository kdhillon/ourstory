-- Migration 004: Wikidata QID-keyed location refactor
--
-- Renames cities → locations, adds location_type, replaces UUID FK
-- (events.location_id → cities.id) with a soft QID reference
-- (events.location_wikidata_qid TEXT). Events with no resolvable
-- location are now stored (with NULL location) instead of being skipped.

-- 1. Rename cities → locations
ALTER TABLE cities RENAME TO locations;
ALTER TABLE locations RENAME CONSTRAINT cities_pkey TO locations_pkey;
ALTER INDEX cities_slug_idx RENAME TO locations_slug_idx;
ALTER INDEX cities_data_version_idx RENAME TO locations_data_version_idx;

-- 2. Add location_type column
ALTER TABLE locations ADD COLUMN location_type TEXT NOT NULL DEFAULT 'city';
ALTER TABLE locations ADD CONSTRAINT locations_location_type_check
    CHECK (location_type IN ('city', 'region', 'country'));

-- 3. Add location_wikidata_qid to events (no FK — intentional soft reference)
ALTER TABLE events ADD COLUMN location_wikidata_qid TEXT;
CREATE INDEX idx_events_location_wikidata_qid ON events(location_wikidata_qid);

-- 4. Populate location_wikidata_qid from existing UUID joins
UPDATE events e
SET location_wikidata_qid = l.wikidata_qid
FROM locations l
WHERE e.location_id = l.id AND l.wikidata_qid IS NOT NULL;

-- 5. Make location_level nullable, update CHECK to allow region/country
ALTER TABLE events ALTER COLUMN location_level DROP NOT NULL;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_location_level_check;
ALTER TABLE events ADD CONSTRAINT events_location_level_check
    CHECK (location_level IS NULL OR location_level IN ('point', 'city', 'region', 'country'));

-- 6. Drop old FK, the old location constraints, and location_id column
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_location_id_fkey;
ALTER TABLE events DROP CONSTRAINT IF EXISTS non_point_requires_location_id;
ALTER TABLE events DROP CONSTRAINT IF EXISTS point_requires_coords;
ALTER TABLE events DROP COLUMN location_id;
