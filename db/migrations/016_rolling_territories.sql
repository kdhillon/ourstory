-- 016_rolling_territories.sql
-- Create territories table for rolling (non-snapshot) territory ranges.
-- Replaces snapshot_polygons as the active territory system.
-- Old tables are archived in 017_archive_territory_tables.sql.

CREATE TABLE IF NOT EXISTS territories (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hb_name             TEXT NOT NULL,
    hb_abbrevn          TEXT,
    hb_subjecto         TEXT,
    hb_partof           TEXT,
    border_precision    INT,
    boundary            JSONB NOT NULL,    -- GeoJSON MultiPolygon geometry
    year_start          INT NOT NULL,
    year_end            INT,               -- NULL = ongoing / no end date
    polity_id           UUID REFERENCES polities(id),
    accuracy            TEXT DEFAULT 'imported',
    explicitly_unlinked BOOLEAN DEFAULT FALSE,
    parent_id           UUID REFERENCES territories(id),  -- set when split on assignment
    source              TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    edited_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS territories_year_range ON territories (year_start, year_end NULLS LAST);
CREATE INDEX IF NOT EXISTS territories_hb_name    ON territories (hb_name);
CREATE INDEX IF NOT EXISTS territories_polity_id  ON territories (polity_id) WHERE polity_id IS NOT NULL;
