/**
 * useTerritoriesSource — sliding window territory fetching from the API.
 *
 * Mirrors useEventSource exactly:
 * - Computes a year window sized to the current step size.
 * - Fetches GET /api/territories?year_min=N&year_max=M when the timeline exits the loaded window.
 * - Prefetches the adjacent window when within 20% of the edge.
 * - Cancels stale in-flight requests via AbortController.
 * - Keeps at most 2 windows in memory (current + prefetched).
 * - Falls back to the last successful window on fetch error.
 *
 * The server handles the "valid until next snapshot" rule — a request for
 * year_min=1898&year_max=1899 returns the 1800 snapshot when the next is 1900.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { STEP_YEAR, STEP_MONTH } from './useTimeline';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

interface WindowData {
  yearMin: number;
  yearMax: number;
  features: GeoJSON.Feature[];
}

function halfWidth(stepSize: number): number {
  if (stepSize >= STEP_YEAR * 100) return 500;
  if (stepSize >= STEP_YEAR * 10)  return 100;
  if (stepSize >= STEP_YEAR)       return  25;
  if (stepSize >= STEP_MONTH)      return   3;
  return 1;
}

function computeWindow(currentYear: number, stepSize: number): { yearMin: number; yearMax: number } {
  const hw = halfWidth(stepSize);
  return { yearMin: currentYear - hw, yearMax: currentYear + hw };
}

async function fetchWindow(
  yearMin: number,
  yearMax: number,
  source: 'hb' | 'ohm',
  signal: AbortSignal,
): Promise<GeoJSON.FeatureCollection & { yearMin: number; yearMax: number; count: number }> {
  const url = `${API_BASE}/territories?year_min=${yearMin}&year_max=${yearMax}&source=${source}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`GET /api/territories failed (${res.status})`);
  return res.json();
}

export function useTerritoriesSource(opts: {
  currentYear: number;
  stepSize: number;
  source?: 'hb' | 'ohm';
}): {
  territoryFeatures: GeoJSON.Feature[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const { currentYear, stepSize, source = 'hb' } = opts;

  const [currentWindow, setCurrentWindow] = useState<WindowData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prefetchRef = useRef<WindowData | null>(null);
  const prefetchAbortRef = useRef<AbortController | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const fetchIdRef = useRef(0);

  // Reset loaded window whenever the source changes so we refetch immediately
  const prevSourceRef = useRef(source);
  if (prevSourceRef.current !== source) {
    prevSourceRef.current = source;
    // Synchronous state mutation during render is intentional here to avoid a stale-window flash
    // We can't call setState during render, so we use a ref to signal the effect
  }
  useEffect(() => {
    if (prevSourceRef.current !== source) {
      prevSourceRef.current = source;
    }
    setCurrentWindow(null);
    prefetchRef.current = null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const doFetch = useCallback(async (yearMin: number, yearMax: number) => {
    fetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    fetchAbortRef.current = ctrl;
    const id = ++fetchIdRef.current;

    setIsLoading(true);
    setError(null);

    try {
      const data = await fetchWindow(yearMin, yearMax, source, ctrl.signal);
      if (fetchIdRef.current !== id) return;
      setCurrentWindow({ yearMin, yearMax, features: data.features });
      prefetchRef.current = null;
    } catch (err) {
      if (fetchIdRef.current !== id) return;
      if ((err as Error).name === 'AbortError') return;
      setError((err as Error).message ?? 'Fetch failed');
    } finally {
      if (fetchIdRef.current === id) setIsLoading(false);
    }
  }, [source]);

  const doPrefetch = useCallback(async (yearMin: number, yearMax: number) => {
    if (
      prefetchRef.current &&
      prefetchRef.current.yearMin === yearMin &&
      prefetchRef.current.yearMax === yearMax
    ) return;

    prefetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    prefetchAbortRef.current = ctrl;

    try {
      const data = await fetchWindow(yearMin, yearMax, source, ctrl.signal);
      if (ctrl.signal.aborted) return;
      prefetchRef.current = { yearMin, yearMax, features: data.features };
    } catch {
      // Prefetch failures are silent
    }
  }, [source]);

  // Window management: fetch on exit, prefetch near edges
  useEffect(() => {
    const win = currentWindow;
    const outsideWindow = !win || currentYear < win.yearMin || currentYear > win.yearMax;

    if (outsideWindow) {
      const pf = prefetchRef.current;
      if (pf && currentYear >= pf.yearMin && currentYear <= pf.yearMax) {
        setCurrentWindow(pf);
        prefetchRef.current = null;
        return;
      }
      const { yearMin, yearMax } = computeWindow(currentYear, stepSize);
      doFetch(yearMin, yearMax);
      return;
    }

    // Prefetch adjacent window when within 20% of an edge
    const span = win.yearMax - win.yearMin;
    const edge20 = span * 0.2;
    const hw = halfWidth(stepSize);

    if (currentYear < win.yearMin + edge20) {
      doPrefetch(win.yearMin - hw * 2, win.yearMin - 1);
    } else if (currentYear > win.yearMax - edge20) {
      doPrefetch(win.yearMax + 1, win.yearMax + hw * 2);
    }
  }, [currentYear, stepSize, currentWindow, doFetch, doPrefetch]);

  const refresh = useCallback(() => {
    const win = currentWindow;
    if (win) doFetch(win.yearMin, win.yearMax);
  }, [currentWindow, doFetch]);

  return {
    territoryFeatures: currentWindow?.features ?? [],
    isLoading,
    error,
    refresh,
  };
}
