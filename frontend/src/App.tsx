import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { checkLogin } from './lib/wikidataApi';
import { fetchOverrides } from './lib/api';
import { MapView } from './components/MapView';
import { TimelineBar } from './components/TimelineBar';
import { InfoPanel } from './components/InfoPanel';
import { CategoryFilter } from './components/CategoryFilter';
import { DataExplorer } from './components/DataExplorer';
import { AboutPage } from './components/AboutPage';
import { MajorEventsPanel } from './components/MajorEventsPanel';
import { useTimeline, encodeDate, decodeDate, STEP_YEAR } from './hooks/useTimeline';
import { useEventSource } from './hooks/useEventSource';
import type { FeatureProperties, Category } from './types';
import type { StackInfo, ZoomRequest } from './components/MapView';
import { EVENT_CATEGORIES, POLITY_CATEGORIES } from './theme/categories';

// Static seed data — locations + polities only (events come from API)
import seedData from './data/seed.geojson';

const seedFeatureCollection = seedData as GeoJSON.FeatureCollection;

// Non-event features (locations + polities) — loaded in full from seed, kept in memory
const staticFeatures = seedFeatureCollection.features.filter(
  (f) => (f.properties as { featureType: string }).featureType !== 'event',
);

export default function App() {
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);

  const timeline = useTimeline();
  const currentYear = decodeDate(timeline.currentDateInt).year;

  const { eventFeatures, windowInfo, isLoading: eventsLoading, error: eventsError } =
    useEventSource({ currentYear, stepSize: timeline.stepSize });

  // Map of id → patched feature for manual edits (applied on top of base features)
  const [overrideMap, setOverrideMap] = useState<Map<string, GeoJSON.Feature>>(new Map());

  const [selectedFeature, setSelectedFeature] = useState<FeatureProperties | null>(null);
  const [stack, setStack] = useState<StackInfo>({ index: 0, total: 1 });
  const [activeCategories, setActiveCategories] = useState<Set<Category>>(
    new Set(EVENT_CATEGORIES as Category[]),
  );
  const [activePolityCategories, setActivePolityCategories] = useState<Set<Category>>(
    new Set(POLITY_CATEGORIES.filter((c) => c !== 'principality') as Category[]),
  );
  const [zoomRequest, setZoomRequest] = useState<ZoomRequest | null>(null);
  const zoomIdRef = useRef(0);
  const [wikiAuth, setWikiAuth] = useState<string | null>(null);

  // Derive the GeoJSON passed to MapView: static features + windowed events + overrides
  const geojson = useMemo((): GeoJSON.FeatureCollection => {
    const baseFeatures = [...staticFeatures, ...eventFeatures];
    const features = overrideMap.size > 0
      ? baseFeatures.map((f) => overrideMap.get((f.properties as { id: string }).id) ?? f)
      : baseFeatures;
    return { ...seedFeatureCollection, features };
  }, [eventFeatures, overrideMap]);

  useEffect(() => {
    checkLogin().then((username) => setWikiAuth(username));
  }, []);

  // Merge API-persisted corrections over the baseline on startup
  useEffect(() => {
    fetchOverrides()
      .then((overrides) => {
        if (overrides.features.length === 0) return;
        setOverrideMap(new Map(
          overrides.features.map((f) => [(f.properties as { id: string }).id, f]),
        ));
      })
      .catch(() => {/* API not running — no overrides applied */});
  }, []);

  useEffect(() => {
    const onPop = () => setCurrentPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      setSelectedFeature(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const navigate = useCallback((to: string) => {
    window.history.pushState({}, '', to);
    setCurrentPath(to);
  }, []);

  const handleToggleCategory = useCallback((cat: Category) => {
    setActiveCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const handleTogglePolityCategory = useCallback((cat: Category) => {
    setActivePolityCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }, []);

  const handleSelectFeature = useCallback((props: FeatureProperties, stackInfo: StackInfo) => {
    setSelectedFeature(props);
    setStack(stackInfo);
    if (props.yearStart !== null) {
      const isStaticFeature = props.featureType === 'city' || props.featureType === 'region'
        || props.featureType === 'country' || props.featureType === 'polity';
      if (!isStaticFeature) {
        const featureDateInt = encodeDate(props.yearStart, props.monthStart ?? 1, props.dayStart ?? 1);
        const cur = timeline.currentDateInt;
        const activeNow = props.yearEnd != null
          ? cur >= featureDateInt && cur <= encodeDate(props.yearEnd, props.monthEnd ?? 12, props.dayEnd ?? 31)
          : cur === featureDateInt;
        if (!activeNow) timeline.seek(featureDateInt);
      }
    }
  }, [timeline]);

  const handleClosePanel = useCallback(() => {
    setSelectedFeature(null);
  }, []);

  const handleFeatureUpdated = useCallback((updates: Partial<FeatureProperties> & { _coords?: [number, number] }) => {
    setSelectedFeature((prev) => {
      if (!prev) return prev;
      const { _coords, ...propsOnly } = updates as Partial<FeatureProperties> & { _coords?: [number, number] };
      const updated = { ...prev, ...propsOnly };
      setOverrideMap((om) => {
        const existing = om.get(prev.id);
        const patched: GeoJSON.Feature = {
          type: 'Feature',
          geometry: _coords
            ? { type: 'Point', coordinates: _coords }
            : (existing?.geometry ?? null),
          properties: updated,
        };
        const next = new Map(om);
        next.set(prev.id, patched);
        return next;
      });
      return updated;
    });
  }, []);

  const handleNavigateToFeature = useCallback((feature: FeatureProperties) => {
    if (feature.yearStart !== null) {
      const featureStart = encodeDate(feature.yearStart, feature.monthStart ?? 1, feature.dayStart ?? 1);
      const featureEnd   = feature.yearEnd != null
        ? encodeDate(feature.yearEnd, feature.monthEnd ?? 12, feature.dayEnd ?? 31)
        : encodeDate(feature.yearStart, 12, 31);
      const cur = timeline.currentDateInt;
      const effectiveNow = cur + timeline.stepSize - 1;
      const isVisible = featureStart <= effectiveNow && cur <= featureEnd + 3 * STEP_YEAR;
      if (!isVisible) timeline.seek(featureStart);
    }
    if (feature.featureType === 'polity') {
      setActivePolityCategories((prev) => {
        const missing = feature.categories.filter((c) => !prev.has(c as Category));
        if (missing.length === 0) return prev;
        const next = new Set(prev);
        missing.forEach((c) => next.add(c as Category));
        return next;
      });
    } else {
      setActiveCategories((prev) => {
        const missing = feature.categories.filter((c) => !prev.has(c as Category));
        if (missing.length === 0) return prev;
        const next = new Set(prev);
        missing.forEach((c) => next.add(c as Category));
        return next;
      });
    }
    navigate('/');
    setZoomRequest({ feature, id: ++zoomIdRef.current });
  }, [timeline, navigate]);

  const handleDataExplorerFeatureUpdated = useCallback((featureId: string, updates: Partial<FeatureProperties>) => {
    setOverrideMap((om) => {
      const existing = om.get(featureId);
      const next = new Map(om);
      next.set(featureId, {
        type: 'Feature',
        geometry: existing?.geometry ?? null,
        properties: { ...(existing?.properties ?? {}), ...updates },
      });
      return next;
    });
  }, []);

  if (currentPath === '/about') {
    return <AboutPage onBack={() => navigate('/')} />;
  }

  if (currentPath === '/data') {
    return (
      <DataExplorer
        geojson={geojson}
        onBackToMap={() => navigate('/')}
        onNavigateToFeature={handleNavigateToFeature}
        wikiAuth={wikiAuth}
        onAuth={setWikiAuth}
        onFeatureUpdated={handleDataExplorerFeatureUpdated}
      />
    );
  }

  return (
    <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#f8f9fa' }}>
      <CategoryFilter
        activeCategories={activeCategories}
        onToggle={handleToggleCategory}
        activePolityCategories={activePolityCategories}
        onTogglePolity={handleTogglePolityCategory}
        onOpenAbout={() => navigate('/about')}
        onOpenData={() => navigate('/data')}
        settings={{ windowInfo, isLoading: eventsLoading, error: eventsError }}
      />

      <div style={{ position: 'absolute', inset: '89px 0 104px 0' }}>
        <MapView
          geojson={geojson}
          currentDateInt={timeline.currentDateInt}
          stepSize={timeline.stepSize}
          activeCategories={activeCategories}
          activePolityCategories={activePolityCategories}
          onSelectFeature={handleSelectFeature}
          zoomRequest={zoomRequest}
        />
      </div>

      <InfoPanel
        feature={selectedFeature}
        stack={stack}
        onClose={handleClosePanel}
        geojson={geojson}
        onNavigateToFeature={handleNavigateToFeature}
        wikiAuth={wikiAuth}
        onAuth={setWikiAuth}
        onFeatureUpdated={handleFeatureUpdated}
      />

      <MajorEventsPanel
        geojson={geojson}
        currentDateInt={timeline.currentDateInt}
        stepSize={timeline.stepSize}
        onNavigateToFeature={handleNavigateToFeature}
      />

      <TimelineBar
        currentDateInt={timeline.currentDateInt}
        stepSize={timeline.stepSize}
        stepOptions={timeline.stepOptions}
        isPlaying={timeline.isPlaying}
        playbackSpeed={timeline.playbackSpeed}
        onSeek={timeline.seek}
        onStep={timeline.step}
        onTogglePlay={timeline.togglePlay}
        onSetStepSize={timeline.setStepSize}
        onSetSpeed={timeline.setPlaybackSpeed}
      />
    </div>
  );
}
