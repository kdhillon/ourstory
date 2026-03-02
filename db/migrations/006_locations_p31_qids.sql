-- Add p31_qids to locations table (mirrors events.p31_qids)
ALTER TABLE locations ADD COLUMN IF NOT EXISTS p31_qids TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_locations_p31_qids ON locations USING GIN (p31_qids);
