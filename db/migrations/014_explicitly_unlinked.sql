-- Migration 014: per-polygon explicit unlink
-- Allows a single snapshot_polygon to be detached from its group name mapping
-- without affecting other polygons that share the same hb_name.
ALTER TABLE snapshot_polygons
  ADD COLUMN IF NOT EXISTS explicitly_unlinked BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS snapshot_polygons_explicitly_unlinked_idx
  ON snapshot_polygons(explicitly_unlinked)
  WHERE explicitly_unlinked = TRUE;
