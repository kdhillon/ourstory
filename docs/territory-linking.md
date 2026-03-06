# Territory Linking System

Territories are polygon features stored in `snapshot_polygons`. Multiple polygons can share the same `hb_name` (e.g., "Ottoman Empire" → Anatolia + Cyprus + etc.). Linking connects all polygons with a given `hb_name` to a polity via `territory_name_mappings`.

## How linking works (end-to-end)

**DB tables involved:**
- `territory_name_mappings (hb_name, snapshot_year) → polity_id` — group mapping by name (confidence: 'auto' | 'manual')
- `snapshot_polygons.polity_id` — per-polygon override (takes precedence over name mapping in the COALESCE query)

**Server query** (`GET /api/territories`): `COALESCE(sp.polity_id, tnm.polity_id)` — per-polygon assignment wins; name mapping is the fallback for all polygons sharing that name.

**Label rendering** (`MapView.tsx`): MapLibre symbol layer with `text-field: ['coalesce', ['get', 'polityName'], ['get', 'hbName']]`. Unlinked territories show their raw `hbName` in gray; linked territories show `polityName` in yellow.

**Clicking an unlinked territory** (gray label): fires `onUnmatchedTerritoryClick(hbName, snapshotYear)` → App.tsx sets `mappingTarget` → opens `TerritoryMappingModal`. User picks a polity → `POST /api/territory-mappings` upserts `territory_name_mappings` with confidence='manual'.

**Clicking the × button on a linked territory** (appears on hover): fires `onUnlinkTerritory(hbName, snapshotYear)` → App.tsx calls `DELETE /api/territory-mappings?hb_name=...&snapshot_year=...` which deletes the `territory_name_mappings` row **and** clears `polity_id` on all matching `snapshot_polygons` rows. All polygons sharing that `hb_name` revert to unlinked (gray).

**Optimistic UI**: App.tsx maintains two in-memory sets:
- `localMappings: Map<"hbName::snapshotYear", {polityId, polityName}>` — applied immediately after save, before next API window fetch
- `localUnlinks: Set<"hbName::snapshotYear">` — applied immediately after unlink
`patchedTerritories` memo applies both on top of the raw `territoryFeatures` window data.

**Server endpoints:**
- `POST /api/territory-mappings` — save/upsert a name mapping
- `DELETE /api/territory-mappings?hb_name=&snapshot_year=` — unlink all polygons with that name in that snapshot
- `DELETE /api/territory-mappings/by-polity/{polity_id}` — unlink all territories for a polity (used when hiding a modern nation)

## Known limitation / planned feature

The × button currently unlinks **all** polygons sharing an `hb_name` (e.g., unlinking Ottoman Empire removes both Anatolia and Cyprus). The planned improvement is a per-polygon unlink: mark one specific `snapshot_polygons` row as `explicitly_unlinked=true` so it shows as "Unknown" while other polygons in the group remain linked. That polygon can then be individually re-linked via the existing unmatched-territory click flow.
