/**
 * useOhmLinks — fetches OHM territory → polity links from the API.
 *
 * Links are loaded once on mount and on explicit refresh.
 * Each link maps an OHM OSM relation ID to a polity (for coloring the live tile layer).
 */

import { useState, useEffect, useCallback } from 'react';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

export interface OhmLink {
  id: string;
  ohmRelationId: number;
  ohmName: string | null;
  ohmWikidataQid: string | null;  // OHM wikidata tag, e.g. "Q34" — used for tile color matching
  ohmAdminLevel: number | null;
  polityId: string | null;
  polityName: string | null;
  polityType: string | null;
  politySlug: string | null;
  color: string;
  explicitlyUnlinked: boolean;
}

export function useOhmLinks(): {
  links: OhmLink[];
  refresh: () => void;
  isLoading: boolean;
  error: string | null;
} {
  const [links, setLinks] = useState<OhmLink[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchTick, setFetchTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    fetch(`${API_BASE}/ohm-links`)
      .then((r) => {
        if (!r.ok) throw new Error(`GET /api/ohm-links failed (${r.status})`);
        return r.json();
      })
      .then((data: { links: OhmLink[] }) => {
        if (!cancelled) {
          setLinks(data.links ?? []);
          setError(null);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [fetchTick]);

  const refresh = useCallback(() => setFetchTick((t) => t + 1), []);

  return { links, refresh, isLoading, error };
}
