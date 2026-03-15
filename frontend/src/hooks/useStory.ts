import { useState, useCallback } from 'react';
import type { Story, FeatureProperties } from '../types';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

export interface StoryLoadResult {
  story: Story;
  beatEvents: Map<string, FeatureProperties>;
  beatCenters: Map<string, [number, number]>;
}

export function useStory() {
  const [story, setStory] = useState<Story | null>(null);
  const [beatIndex, setBeatIndex] = useState(0);
  const [beatEvents, setBeatEvents] = useState<Map<string, FeatureProperties>>(new Map());
  const [beatCenters, setBeatCenters] = useState<Map<string, [number, number]>>(new Map());
  const [loading, setLoading] = useState(false);

  const loadStory = useCallback(async (slug: string): Promise<StoryLoadResult | null> => {
    setLoading(true);
    try {
      const res = await fetch(`/data/stories/${slug}.json`);
      if (!res.ok) throw new Error(`Story not found: ${slug}`);
      const s: Story = await res.json();

      // Pre-fetch event data for all beats with QIDs in a single API call
      const qids = s.beats.map((b) => b.event_qid).filter(Boolean) as string[];
      const evMap = new Map<string, FeatureProperties>();
      const centersMap = new Map<string, [number, number]>();

      if (qids.length > 0) {
        const evRes = await fetch(`${API_BASE}/events/by-qids?qids=${qids.join(',')}`);
        if (evRes.ok) {
          const evData = await evRes.json();
          for (const f of evData.features ?? []) {
            const p = f.properties as FeatureProperties;
            if (p.wikidataQid) {
              evMap.set(p.wikidataQid, p);
              // Store geometry center for direct map navigation (bypasses geojson window lookup)
              if (f.geometry?.type === 'Point') {
                const [lng, lat] = f.geometry.coordinates as [number, number];
                centersMap.set(p.wikidataQid, [lng, lat]);
              }
            }
          }
        }
      }

      setStory(s);
      setBeatIndex(0);
      setBeatEvents(evMap);
      setBeatCenters(centersMap);
      return { story: s, beatEvents: evMap, beatCenters: centersMap };
    } catch (err) {
      console.error('Failed to load story:', err);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const exitStory = useCallback(() => {
    setStory(null);
    setBeatIndex(0);
    setBeatEvents(new Map());
    setBeatCenters(new Map());
  }, []);

  const currentBeat = story?.beats[beatIndex] ?? null;
  const currentBeatEvent = currentBeat?.event_qid
    ? (beatEvents.get(currentBeat.event_qid) ?? null)
    : null;

  return {
    story,
    beatIndex,
    setBeatIndex,
    currentBeat,
    currentBeatEvent,
    beatEvents,
    beatCenters,
    loadStory,
    exitStory,
    loading,
  };
}
