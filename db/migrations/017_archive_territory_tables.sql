-- 017_archive_territory_tables.sql
-- Archive old snapshot-based territory tables after migration to rolling territories.
-- Run AFTER scripts/migrate-to-rolling-territories.py succeeds.

ALTER TABLE snapshot_polygons       RENAME TO snapshot_polygons_archive;
ALTER TABLE territory_snapshots     RENAME TO territory_snapshots_archive;
ALTER TABLE territory_name_mappings RENAME TO territory_name_mappings_archive;
