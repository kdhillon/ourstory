import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { checkLogin } from './lib/wikidataApi';
import { fetchOverrides, fetchHiddenNations, addHiddenNation, removeHiddenNation, removeTerritoryMappingsByPolity, deleteTerritoryMapping } from './lib/api';
import { MapView } from './components/MapView';
import { TerritoryMappingModal } from './components/TerritoryMappingModal';
import { TimelineBar } from './components/TimelineBar';
import { InfoPanel } from './components/InfoPanel';
import { CategoryFilter } from './components/CategoryFilter';
import { DataExplorer } from './components/DataExplorer';
import { AboutPage } from './components/AboutPage';
import { MajorEventsPanel, MAJOR_EVENTS_PANEL_HEIGHT } from './components/MajorEventsPanel';
import { useTimeline, encodeDate, decodeDate, STEP_YEAR } from './hooks/useTimeline';
import { useEventSource } from './hooks/useEventSource';
import { useTerritoriesSource } from './hooks/useTerritoriesSource';
import type { FeatureProperties, Category } from './types';
import type { StackInfo, ZoomRequest } from './components/MapView';
import { EVENT_CATEGORIES, POLITY_CATEGORIES } from './theme/categories';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export default function App() {
  const [seedFeatureCollection, setSeedFeatureCollection] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);

  useEffect(() => {
    fetch('/data/seed.geojson')
      .then((r) => r.json())
      .then((data: GeoJSON.FeatureCollection) => setSeedFeatureCollection(data))
      .catch(console.error);
  }, []);

  const staticFeatures = useMemo(
    () => seedFeatureCollection.features.filter(
      (f) => (f.properties as { featureType: string }).featureType !== 'event',
    ),
    [seedFeatureCollection],
  );

  const polityFeatures = useMemo(
    () => (seedFeatureCollection.features
      .filter((f) => (f.properties as { featureType: string }).featureType === 'polity')
      .map((f) => f.properties) as import('./types').FeatureProperties[])
      .sort((a, b) => a.title.localeCompare(b.title)),
    [seedFeatureCollection],
  );
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);

  const timeline = useTimeline();
  const currentYear = decodeDate(timeline.currentDateInt).year;

  const { eventFeatures, windowInfo, isLoading: eventsLoading, error: eventsError } =
    useEventSource({ currentYear, stepSize: timeline.stepSize });

  const { territoryFeatures, refresh: refreshTerritories } =
    useTerritoriesSource({ currentYear, stepSize: timeline.stepSize });

  const activeSnapshotYear = useMemo(() => {
    for (const f of territoryFeatures) {
      const p = f.properties as { intervalStart: number; intervalEnd: number | null; snapshotYear: number };
      if (p.intervalStart <= currentYear && (p.intervalEnd === null || currentYear <= p.intervalEnd)) {
        return p.snapshotYear;
      }
    }
    return null;
  }, [territoryFeatures, currentYear]);

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
  // polityId → hideUntilYear for modern nations hidden in historical views
  const [hiddenNations, setHiddenNations] = useState<Map<string, number>>(new Map());
  // Unmatched territory the user clicked — shows the mapping assignment modal
  const [mappingTarget, setMappingTarget] = useState<{ hbName: string; snapshotYear: number } | null>(null);
  // QID of the major event chip selected in the bottom bar (null = no filter)
  const [majorEventFilter, setMajorEventFilter] = useState<string | null>(null);
  const [hasMajorEvents, setHasMajorEvents] = useState(false);
  // Mappings saved in this session: "hbName::snapshotYear" → { polityId, polityName }
  // Used to immediately reflect matched territory labels without re-exporting
  const [localMappings, setLocalMappings] = useState<Map<string, { polityId: string; polityName: string }>>(new Map());
  // Territories unlinked in this session: "hbName::snapshotYear"
  // Overrides server data until the next API window fetch
  const [localUnlinks, setLocalUnlinks] = useState<Set<string>>(new Set());

  const territoriesFeatureCollection = useMemo(
    (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: territoryFeatures }),
    [territoryFeatures],
  );

  const patchedTerritories = useMemo(() => {
    if (localMappings.size === 0 && localUnlinks.size === 0) return territoriesFeatureCollection;
    return {
      ...territoriesFeatureCollection,
      features: territoriesFeatureCollection.features.map((f) => {
        const p = f.properties as { hbName: string; snapshotYear: number; polityId: string | null };
        const key = `${p.hbName}::${p.snapshotYear}`;
        // Apply local unlinks first
        if (localUnlinks.has(key)) {
          return { ...f, properties: { ...f.properties, polityId: null, polityName: null } };
        }
        if (p.polityId) return f;
        const mapping = localMappings.get(key);
        if (!mapping) return f;
        return { ...f, properties: { ...f.properties, polityId: mapping.polityId, polityName: mapping.polityName } };
      }),
    } as GeoJSON.FeatureCollection;
  }, [localMappings, localUnlinks, territoriesFeatureCollection]);

  // Pre-compute suppressed polity IDs for the current year.
  // When multiple polities share a capital, only the shortest-lived (most historically
  // specific) shows; longer-lived ones are suppressed. Recomputes once per year — polity
  // boundaries are year-resolution so sub-year currentDateInt changes don't matter here.
  const suppressedPolityIds = useMemo(() => {
    const suppressed = new Set<string>();
    type Entry = { id: string; capitalKey: string; lifespan: number };
    const active: Entry[] = [];

    for (const f of staticFeatures) {
      const p = f.properties as FeatureProperties;
      if (p.featureType !== 'polity' || !p.id || p.yearStart == null) continue;
      if (p.yearStart > currentYear) continue;
      if (p.yearEnd != null && currentYear > p.yearEnd) continue;

      const capitalKey = p.capitalWikidataQid ?? p.capitalName?.toLowerCase() ?? '';
      if (!capitalKey) continue;

      const lifespan = p.yearEnd != null ? (p.yearEnd - p.yearStart) : 999999;
      active.push({ id: p.id, capitalKey, lifespan });
    }

    const byCapital = new Map<string, Entry[]>();
    for (const entry of active) {
      const group = byCapital.get(entry.capitalKey);
      if (group) group.push(entry);
      else byCapital.set(entry.capitalKey, [entry]);
    }

    for (const group of byCapital.values()) {
      if (group.length <= 1) continue;
      const minLifespan = Math.min(...group.map((e) => e.lifespan));
      for (const entry of group) {
        if (entry.lifespan > minLifespan) suppressed.add(entry.id);
      }
    }

    return suppressed;
  }, [currentYear]); // staticFeatures is a module-level constant

  // Polity IDs that have a matched, time-visible territory — their capital dot is redundant
  const polityIdsWithTerritory = useMemo(() => {
    const ids = new Set<string>();
    for (const f of patchedTerritories.features) {
      const p = f.properties as { polityId: string | null; intervalStart: number; intervalEnd: number | null };
      if (!p.polityId) continue;
      if (p.intervalStart > currentYear) continue;
      if (p.intervalEnd !== null && currentYear > p.intervalEnd) continue;
      ids.add(p.polityId);
    }
    return ids;
  }, [patchedTerritories, currentYear]);

  // Derive the GeoJSON passed to MapView: static features + windowed events + overrides
  const geojson = useMemo((): GeoJSON.FeatureCollection => {
    const baseFeatures = [...staticFeatures, ...eventFeatures];
    const features = overrideMap.size > 0
      ? baseFeatures.map((f) => overrideMap.get((f.properties as { id: string }).id) ?? f)
      : baseFeatures;
    return { type: 'FeatureCollection', features };
  }, [staticFeatures, eventFeatures, overrideMap]);

  useEffect(() => {
    checkLogin().then((username) => setWikiAuth(username));
  }, []);

  useEffect(() => {
    fetchHiddenNations()
      .then((list) => setHiddenNations(new Map(list.map((h) => [h.polityId, h.hideUntilYear]))))
      .catch(() => {/* API not running — no hidden nations applied */});
  }, []);

  const handleUnlinkTerritory = useCallback((hbName: string, snapshotYear: number) => {
    const key = `${hbName}::${snapshotYear}`;
    deleteTerritoryMapping(hbName, snapshotYear).catch(console.error);
    setLocalUnlinks((prev) => new Set(prev).add(key));
    // Also remove any local mapping for the same key
    setLocalMappings((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const handleToggleHiddenNation = useCallback((polityId: string) => {
    if (hiddenNations.has(polityId)) {
      removeHiddenNation(polityId).catch(console.error);
      setHiddenNations((m) => { const n = new Map(m); n.delete(polityId); return n; });
    } else {
      // Hide the polity star and unlink its territory mappings (territory reverts to unassigned)
      addHiddenNation(polityId).catch(console.error);
      removeTerritoryMappingsByPolity(polityId).catch(console.error);
      setHiddenNations((m) => new Map(m).set(polityId, 1900));
    }
  }, [hiddenNations]);

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
        settings={{ windowInfo, isLoading: eventsLoading, error: eventsError, snapshotYear: activeSnapshotYear, onSeekToSnapshot: (y) => timeline.seek(encodeDate(y, 1, 1)) }}
      />

      <div style={{ position: 'absolute', inset: `89px 0 ${64 + (hasMajorEvents ? MAJOR_EVENTS_PANEL_HEIGHT : 0)}px 0` }}>
        <MapView
          geojson={geojson}
          territoriesGeojson={patchedTerritories}
          currentDateInt={timeline.currentDateInt}
          stepSize={timeline.stepSize}
          activeCategories={activeCategories}
          activePolityCategories={activePolityCategories}
          onSelectFeature={handleSelectFeature}
          zoomRequest={zoomRequest}
          hiddenNations={hiddenNations}
          suppressedPolityIds={suppressedPolityIds}
          polityIdsWithTerritory={polityIdsWithTerritory}
          onUnmatchedTerritoryClick={(hbName, snapshotYear) => setMappingTarget({ hbName, snapshotYear })}
          onUnlinkTerritory={handleUnlinkTerritory}
          majorEventFilter={majorEventFilter}
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
        hiddenNations={hiddenNations}
        onToggleHiddenNation={handleToggleHiddenNation}
      />

      <MajorEventsPanel
        geojson={geojson}
        currentDateInt={timeline.currentDateInt}
        stepSize={timeline.stepSize}
        onNavigateToFeature={handleNavigateToFeature}
        selectedQid={majorEventFilter}
        onSelectQid={setMajorEventFilter}
        onHasEvents={setHasMajorEvents}
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

      {mappingTarget && (
        <TerritoryMappingModal
          hbName={mappingTarget.hbName}
          snapshotYear={mappingTarget.snapshotYear}
          polities={polityFeatures}
          onClose={() => setMappingTarget(null)}
          onSaved={(polityId, polityName) => {
            setLocalMappings((m) => new Map(m).set(
              `${mappingTarget.hbName}::${mappingTarget.snapshotYear}`,
              { polityId, polityName },
            ));
            refreshTerritories();
          }}
        />
      )}
    </div>
  );
}
