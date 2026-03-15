/**
 * OurStory API client.
 *
 * In development, Vite proxies /api → http://localhost:8000
 * In production, /api should point to the same origin or a configured backend.
 */

// In dev, Vite proxies /api → localhost:8000.
// In production, set VITE_API_URL to the Railway backend URL (no trailing slash).
const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

// Injected at build time. Set VITE_WRITE_SECRET in Railway (frontend service) to match
// the WRITE_SECRET env var on the backend. Unset in local dev to skip the check.
const WRITE_SECRET = import.meta.env.VITE_WRITE_SECRET ?? '';

function withWriteSecret(headers: Record<string, string> = {}): Record<string, string> {
  if (!WRITE_SECRET) return headers;
  return { ...headers, 'X-Write-Secret': WRITE_SECRET };
}

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
  // Category
  categories?: string[];
}

/**
 * Persist a user correction to Postgres.
 * Returns the updated GeoJSON feature (with fresh coordinates from DB join).
 * Throws on network error or non-2xx response.
 */
export async function patchFeature(eventId: string, patch: FeaturePatch): Promise<GeoJSON.Feature> {
  const res = await fetch(`${API_BASE}/features/${eventId}`, {
    method: 'PATCH',
    headers: withWriteSecret({ 'Content-Type': 'application/json' }),
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
  polity_type?: string;
}

/**
 * Persist a user correction to a polity record in Postgres.
 * Returns the updated GeoJSON feature. Throws on network error or non-2xx response.
 */
export async function patchPolity(polityId: string, patch: PolityPatch): Promise<GeoJSON.Feature> {
  const res = await fetch(`${API_BASE}/polities/${polityId}`, {
    method: 'PATCH',
    headers: withWriteSecret({ 'Content-Type': 'application/json' }),
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

/**
 * Fetch all manually-edited polities since the last GeoJSON generation.
 * Returns a FeatureCollection to merge over the static seed.geojson.
 */
export async function fetchPolityOverrides(): Promise<GeoJSON.FeatureCollection> {
  const res = await fetch(`${API_BASE}/polities/overrides`);
  if (!res.ok) throw new Error(`API GET polity overrides failed (${res.status})`);
  return res.json();
}

/**
 * Mark a single territory row as explicitly unlinked (clears polity_id).
 */
export async function unlinkPolygon(polygonId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/territories/${polygonId}/unlink`, { method: 'PATCH', headers: withWriteSecret() });
  if (!res.ok) throw new Error(`API PATCH unlink territory failed (${res.status})`);
}

/**
 * Mark an OHM territory link as explicitly unlinked (clears polity assignment).
 */
export async function unlinkOhmLink(linkId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/ohm-links/${linkId}/unlink`, { method: 'PATCH', headers: withWriteSecret() });
  if (!res.ok) throw new Error(`API PATCH unlink OHM link failed (${res.status})`);
}

/**
 * Suppress an auto-matched OHM territory by name (no existing DB link).
 * Upserts a row with explicitly_unlinked=TRUE so rebuildColors skips it.
 */
export async function suppressOhmLink(ohmName: string): Promise<void> {
  const res = await fetch(`${API_BASE}/ohm-links/suppress`, {
    method: 'POST',
    headers: withWriteSecret({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ohmName }),
  });
  if (!res.ok) throw new Error(`API POST suppress OHM link failed (${res.status})`);
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
    headers: withWriteSecret({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ polityId, hideUntilYear }),
  });
  if (!res.ok) throw new Error(`API POST hidden-modern-nations failed (${res.status})`);
}

export async function removeHiddenNation(polityId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/hidden-modern-nations/${polityId}`, { method: 'DELETE', headers: withWriteSecret() });
  if (!res.ok) throw new Error(`API DELETE hidden-modern-nations failed (${res.status})`);
}

export async function removeTerritoryMappingsByPolity(polityId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/territories/by-polity/${polityId}`, { method: 'DELETE', headers: withWriteSecret() });
  if (!res.ok) throw new Error(`API DELETE territories/by-polity failed (${res.status})`);
}

// ── Territory geometry editing (editor/ prototype) ────────────────────────

export async function patchTerritoryGeometry(
  territoryId: string,
  boundary: GeoJSON.MultiPolygon,
  year: number,
): Promise<void> {
  const res = await fetch(`${API_BASE}/territories/${territoryId}/geometry`, {
    method: 'PATCH',
    headers: withWriteSecret({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ boundary, year }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Geometry patch failed (${res.status}): ${text}`);
  }
}

/**
 * Fetch IDs of all manually-hidden polities and events.
 */
export interface AssignResult {
  yearStart: number;
  yearEnd: number | null;
  sliceStart: number;
  sliceEnd: number | null;
  createdBefore: boolean;
  createdAfter: boolean;
}

/**
 * Assign a polity to a territory row.
 * Validates overlap and creates gap rows automatically.
 * Throws with a descriptive message on 422 (no overlap) or other errors.
 */
export async function assignPolygon(polygonId: string, polityId: string): Promise<AssignResult> {
  const res = await fetch(`${API_BASE}/territories/${polygonId}/assign`, {
    method: 'POST',
    headers: withWriteSecret({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ polityId }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Assign failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function fetchHiddenFeatures(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/hidden-features`);
  if (!res.ok) return [];
  const data = await res.json() as { ids: string[] };
  return data.ids ?? [];
}

/**
 * Toggle the manually_hidden flag for a polity or event.
 */
export async function setFeatureHidden(id: string, type: 'polity' | 'event', hidden: boolean): Promise<void> {
  const url = type === 'polity'
    ? `${API_BASE}/polities/${id}`
    : `${API_BASE}/features/${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: withWriteSecret({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ manually_hidden: hidden }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API PATCH hidden failed (${res.status}): ${text}`);
  }
}

export async function fetchManualPolities(): Promise<GeoJSON.Feature[]> {
  const res = await fetch(`${API_BASE}/polities/manual`);
  if (!res.ok) return [];
  const fc = await res.json() as { features: GeoJSON.Feature[] };
  return fc.features ?? [];
}

export async function deleteTerritoryRow(polygonId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/territories/${polygonId}`, { method: 'DELETE', headers: withWriteSecret() });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Delete territory failed (${res.status}): ${text}`);
  }
}

export async function updateTerritoryYears(
  polygonId: string,
  yearStart: number,
  yearEnd: number | null,
): Promise<void> {
  const res = await fetch(`${API_BASE}/territories/${polygonId}/years`, {
    method: 'PATCH',
    headers: withWriteSecret({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ yearStart, yearEnd }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Update years failed (${res.status}): ${text}`);
  }
}

export async function createTerritory(
  boundary: GeoJSON.MultiPolygon,
  yearStart: number,
  yearEnd: number | null,
): Promise<string> {
  const res = await fetch(`${API_BASE}/territories`, {
    method: 'POST',
    headers: withWriteSecret({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ boundary, yearStart, yearEnd }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Create territory failed (${res.status}): ${text}`);
  }
  const data = await res.json() as { id: string };
  return data.id;
}

export async function importPolityFromWikidata(qid: string): Promise<GeoJSON.Feature> {
  const res = await fetch(`${API_BASE}/polities/import-from-wikidata`, {
    method: 'POST',
    headers: withWriteSecret({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ qid }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Import failed (${res.status}): ${text}`);
  }
  return res.json();
}

