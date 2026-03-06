/**
 * OurStory API client.
 *
 * In development, Vite proxies /api → http://localhost:8000
 * In production, /api should point to the same origin or a configured backend.
 */

// In dev, Vite proxies /api → localhost:8000.
// In production, set VITE_API_URL to the Railway backend URL (no trailing slash).
const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

export interface FeaturePatch {
  // Date fields — send null to clear
  year_start?: number | null;
  month_start?: number | null;
  day_start?: number | null;
  year_end?: number | null;
  month_end?: number | null;
  day_end?: number | null;
  // Location fields
  location_name?: string | null;
  location_wikidata_qid?: string | null;
}

/**
 * Persist a user correction to Postgres.
 * Returns the updated GeoJSON feature (with fresh coordinates from DB join).
 * Throws on network error or non-2xx response.
 */
export async function patchFeature(eventId: string, patch: FeaturePatch): Promise<GeoJSON.Feature> {
  const res = await fetch(`${API_BASE}/features/${eventId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API PATCH failed (${res.status}): ${text}`);
  }
  return res.json();
}

export interface PolityPatch {
  year_start?: number | null;
  year_end?: number | null;
  name?: string | null;
  capital_name?: string | null;
  capital_wikidata_qid?: string | null;
}

/**
 * Persist a user correction to a polity record in Postgres.
 * Returns the updated GeoJSON feature. Throws on network error or non-2xx response.
 */
export async function patchPolity(polityId: string, patch: PolityPatch): Promise<GeoJSON.Feature> {
  const res = await fetch(`${API_BASE}/polities/${polityId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API PATCH polity failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Fetch all manually-edited events since the last GeoJSON generation.
 * Returns a FeatureCollection to merge over the static seed.geojson.
 */
export async function fetchOverrides(): Promise<GeoJSON.FeatureCollection> {
  const res = await fetch(`${API_BASE}/features/overrides`);
  if (!res.ok) throw new Error(`API GET overrides failed (${res.status})`);
  return res.json();
}

export interface HiddenNation {
  polityId: string;
  hideUntilYear: number;
  notes: string | null;
}

export async function fetchHiddenNations(): Promise<HiddenNation[]> {
  const res = await fetch(`${API_BASE}/hidden-modern-nations`);
  if (!res.ok) throw new Error(`API GET hidden-modern-nations failed (${res.status})`);
  return res.json();
}

export async function addHiddenNation(polityId: string, hideUntilYear = 1900): Promise<void> {
  const res = await fetch(`${API_BASE}/hidden-modern-nations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ polityId, hideUntilYear }),
  });
  if (!res.ok) throw new Error(`API POST hidden-modern-nations failed (${res.status})`);
}

export async function removeHiddenNation(polityId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/hidden-modern-nations/${polityId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`API DELETE hidden-modern-nations failed (${res.status})`);
}

export async function removeTerritoryMappingsByPolity(polityId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/territory-mappings/by-polity/${polityId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`API DELETE territory-mappings/by-polity failed (${res.status})`);
}

export async function deleteTerritoryMapping(hbName: string, snapshotYear: number): Promise<void> {
  const params = new URLSearchParams({ hb_name: hbName, snapshot_year: String(snapshotYear) });
  const res = await fetch(`${API_BASE}/territory-mappings?${params}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`API DELETE territory-mappings failed (${res.status})`);
}

export async function fetchManualPolities(): Promise<GeoJSON.Feature[]> {
  const res = await fetch(`${API_BASE}/polities/manual`);
  if (!res.ok) return [];
  const fc = await res.json() as { features: GeoJSON.Feature[] };
  return fc.features ?? [];
}

export async function importPolityFromWikidata(qid: string): Promise<GeoJSON.Feature> {
  const res = await fetch(`${API_BASE}/polities/import-from-wikidata`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qid }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Import failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function saveTerritoryMapping(
  hbName: string,
  snapshotYear: number,
  polityId: string,
  wikidataQid: string | null,
): Promise<void> {
  const res = await fetch(`${API_BASE}/territory-mappings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hbName, snapshotYear, polityId, wikidataQid }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API POST territory-mappings failed (${res.status}): ${text}`);
  }
}
