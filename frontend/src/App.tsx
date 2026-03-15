import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Map as MaplibreMap } from 'maplibre-gl';
import { checkLogin, fetchEntityTranslations } from './lib/wikidataApi';
import { TranslationContext } from './lib/TranslationContext';
import { fetchOverrides, fetchPolityOverrides, fetchHiddenNations, addHiddenNation, removeHiddenNation, removeTerritoryMappingsByPolity, unlinkPolygon, unlinkOhmLink, suppressOhmLink, fetchManualPolities, fetchHiddenFeatures, setFeatureHidden } from './lib/api';
import { MapView } from './components/MapView';
import { TerritoryEditor } from './editor/TerritoryEditor';
import { TerritoryMappingModal } from './components/TerritoryMappingModal';
import { OhmMappingModal } from './components/OhmMappingModal';
import { TimelineBar, TIMELINE_BAR_HEIGHT } from './components/TimelineBar';
import { InfoPanel } from './components/InfoPanel';
import { CategoryFilter } from './components/CategoryFilter';
import { DataExplorer } from './components/DataExplorer';
import { AboutPage } from './components/AboutPage';
import { WelcomeModal, shouldShowWelcome } from './components/WelcomeModal';
import { MajorEventsPanel } from './components/MajorEventsPanel';
import { UnlocatedEventsPanel } from './components/UnlocatedEventsPanel';
import { StoryPanel } from './components/StoryPanel';
import { useTimeline, encodeDate, decodeDate, STEP_YEAR, STEP_DAY } from './hooks/useTimeline';
import { useStory } from './hooks/useStory';
import { useEventSource } from './hooks/useEventSource';
import { useTerritoriesSource } from './hooks/useTerritoriesSource';
import { useOhmLinks } from './hooks/useOhmLinks';
import type { FeatureProperties, Category } from './types';
import type { StackInfo, ZoomRequest } from './components/MapView';
import { EVENT_CATEGORIES, POLITY_CATEGORIES } from './theme/categories';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export default function App() {
  const [seedFeatureCollection, setSeedFeatureCollection] = useState<GeoJSON.FeatureCollection>(EMPTY_FC);
  const [seedLoading, setSeedLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/data/seed.geojson').then((r) => r.json()) as Promise<GeoJSON.FeatureCollection>,
      fetchManualPolities(),
    ]).then(([seed, manualFeatures]) => {
      // Merge manually imported polities (not yet in static build) into the seed collection.
      // De-duplicate by id in case a polity was later included in a rebuild.
      const existingIds = new Set(seed.features.map((f) => (f.properties as { id: string }).id));
      const fresh = manualFeatures.filter((f) => !existingIds.has((f.properties as { id: string }).id));
      setSeedFeatureCollection({ ...seed, features: [...seed.features, ...fresh] });
      setSeedLoading(false);
    }).catch(() => setSeedLoading(false));
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

  const locationCount = useMemo(
    () => seedFeatureCollection.features.filter((f) => {
      const ft = (f.properties as { featureType: string }).featureType;
      return ft === 'city' || ft === 'region';
    }).length,
    [seedFeatureCollection],
  );

  const polityCount = useMemo(
    () => seedFeatureCollection.features.filter(
      (f) => (f.properties as { featureType: string }).featureType === 'polity'
    ).length,
    [seedFeatureCollection],
  );
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname);

  const timeline = useTimeline();
  const { story, beatIndex, setBeatIndex, currentBeat, currentBeatEvent, beatEvents, beatCenters, loadStory, exitStory } = useStory();
  const currentYear = decodeDate(timeline.currentDateInt).year;

  // Debounce year for API calls — UI renders at full speed but DB requests only
  // fire 300ms after the user stops dragging, preventing a flood of cancelled queries.
  const [debouncedYear, setDebouncedYear] = useState(currentYear);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedYear(currentYear), 300);
    return () => clearTimeout(t);
  }, [currentYear]);

  const { eventFeatures, windowInfo, isLoading: eventsLoading, error: eventsError } =
    useEventSource({ currentYear: debouncedYear, stepSize: timeline.stepSize });

  const territorySource = 'ohm' as const;

  const { territoryFeatures, refresh: refreshTerritories, isLoading: territoriesLoading, error: territoriesError } =
    useTerritoriesSource({ currentYear: debouncedYear, stepSize: timeline.stepSize, source: 'hb' });

  const { links: ohmLinks, refresh: refreshOhmLinks } = useOhmLinks();

  // Map of id → patched feature for manual edits (applied on top of base features)
  const [overrideMap, setOverrideMap] = useState<Map<string, GeoJSON.Feature>>(new Map());

  const [selectedFeature, setSelectedFeature] = useState<FeatureProperties | null>(null);
  const [stack, setStack] = useState<StackInfo>({ index: 0, total: 1 });
  const [activeCategories, setActiveCategories] = useState<Set<Category>>(
    new Set(EVENT_CATEGORIES as Category[]),
  );
  const [showBorders, setShowBorders] = useState(true);
  const [showOtherPolities, setShowOtherPolities] = useState(true);
  const [zoomRequest, setZoomRequest] = useState<ZoomRequest | null>(null);
  const zoomIdRef = useRef(0);
  const [wikiAuth, setWikiAuth] = useState<string | null>(null);
  // polityId → hideUntilYear for modern nations hidden in historical views
  const [hiddenNations, setHiddenNations] = useState<Map<string, number>>(new Map());
  // Unmatched territory the user clicked — shows the mapping assignment modal
  const [mappingTarget, setMappingTarget] = useState<{ hbName: string; polygonId: string; yearStart: number; yearEnd: number | null } | null>(null);
  // OHM territory the user clicked — shows the OHM polity assignment modal
  const [ohmMappingTarget, setOhmMappingTarget] = useState<{ ohmName: string; ohmWikidataQid: string | null } | null>(null);
  // QID of the major event chip selected in the bottom bar (null = no filter)
  const [majorEventFilter, setMajorEventFilter] = useState<string | null>(null);
  const [fitBoundsRequest, setFitBoundsRequest] = useState<{ bbox: [number,number,number,number]; id: number } | null>(null);
  const fitBoundsIdRef = useRef(0);
  // Mappings saved in this session: polygonId → { polityId, polityName }
  // Used to immediately reflect matched territory labels without re-exporting
  const [localMappings, setLocalMappings] = useState<Map<string, { polityId: string; polityName: string }>>(new Map());
  // Polygon IDs explicitly unlinked this session (per-polygon, not group-level)
  const [localPolygonUnlinks, setLocalPolygonUnlinks] = useState<Set<string>>(new Set());
  const [showWelcome, setShowWelcome] = useState(() => shouldShowWelcome());
  // IDs of features the user has manually hidden from the map
  const [hiddenFeatureIds, setHiddenFeatureIds] = useState<Set<string>>(new Set());
  // Territory editor
  const [editorMode, setEditorMode] = useState(false);
  const [mapInstance, setMapInstance] = useState<MaplibreMap | null>(null);
  // Wikipedia language + polity label translations
  const [selectedLang, setSelectedLang] = useState(() => localStorage.getItem('oh_lang') ?? 'en');
  const [translationMap, setTranslationMap] = useState<Record<string, string>>({});

  const handleLangChange = useCallback((lang: string) => {
    setSelectedLang(lang);
    localStorage.setItem('oh_lang', lang);
  }, []);

  const territoriesFeatureCollection = useMemo(
    (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: territoryFeatures }),
    [territoryFeatures],
  );

  const patchedTerritories = useMemo(() => {
    if (localMappings.size === 0 && localPolygonUnlinks.size === 0) return territoriesFeatureCollection;
    return {
      ...territoriesFeatureCollection,
      features: territoriesFeatureCollection.features.map((f) => {
        const p = f.properties as { polygonId: string; polityId: string | null };
        // Per-polygon unlink: clear polity info for this specific polygon
        if (localPolygonUnlinks.has(p.polygonId)) {
          return { ...f, properties: { ...f.properties, polityId: null, polityName: null, explicitlyUnlinked: true } };
        }
        const mapping = localMappings.get(p.polygonId);
        if (mapping) {
          return { ...f, properties: { ...f.properties, polityId: mapping.polityId, polityName: mapping.polityName } };
        }
        return f;
      }),
    } as GeoJSON.FeatureCollection;
  }, [localMappings, localPolygonUnlinks, territoriesFeatureCollection]);

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

  // OHM mode: polity IDs matched to a currently-visible OHM territory (set by MapView after rebuildColors)
  const [ohmMatchedPolityIds, setOhmMatchedPolityIds] = useState<Set<string>>(new Set());

  // Polity IDs that have a matched, time-visible territory — their capital dot is redundant
  const polityIdsWithTerritory = useMemo(() => {
    if (territorySource === 'ohm') {
      return ohmMatchedPolityIds;
    }
    const ids = new Set<string>();
    for (const f of patchedTerritories.features) {
      const p = f.properties as { polityId: string | null; yearStart: number; yearEnd: number | null };
      if (!p.polityId) continue;
      if (p.yearStart > currentYear) continue;
      if (p.yearEnd !== null && currentYear > p.yearEnd) continue;
      ids.add(p.polityId);
    }
    return ids;
  }, [territorySource, ohmMatchedPolityIds, patchedTerritories, currentYear]);

  // Derive the GeoJSON passed to MapView: static features + windowed events + overrides
  const geojson = useMemo((): GeoJSON.FeatureCollection => {
    const baseFeatures = [...staticFeatures, ...eventFeatures];
    const withOverrides = overrideMap.size > 0
      ? baseFeatures.map((f) => overrideMap.get((f.properties as { id: string }).id) ?? f)
      : baseFeatures;
    const features = hiddenFeatureIds.size > 0
      ? withOverrides.filter((f) => !hiddenFeatureIds.has((f.properties as { id: string }).id))
      : withOverrides;
    return { type: 'FeatureCollection', features };
  }, [staticFeatures, eventFeatures, overrideMap, hiddenFeatureIds]);

  // Fetch polity name translations whenever language or polity data changes
  useEffect(() => {
    if (selectedLang === 'en') { setTranslationMap({}); return; }
    const seen = new Set<string>();
    for (const f of geojson.features) {
      const p = f.properties as { featureType?: string; wikidataQid?: string; partOfResolved?: string | Array<{ qid?: string }> };
      if (p.wikidataQid) seen.add(p.wikidataQid);
      // Include partOfResolved QIDs for major-event chip translations
      if (p.partOfResolved) {
        const resolved = typeof p.partOfResolved === 'string'
          ? (JSON.parse(p.partOfResolved) as Array<{ qid?: string }>)
          : p.partOfResolved;
        for (const r of resolved) { if (r.qid) seen.add(r.qid); }
      }
    }
    const qids = [...seen];
    let cancelled = false;
    fetchEntityTranslations(qids, selectedLang).then((map) => {
      if (!cancelled) setTranslationMap(map);
    });
    return () => { cancelled = true; };
  }, [selectedLang, geojson]);

  useEffect(() => {
    checkLogin().then((username) => setWikiAuth(username));
  }, []);


  useEffect(() => {
    fetchHiddenNations()
      .then((list) => setHiddenNations(new Map(list.map((h) => [h.polityId, h.hideUntilYear]))))
      .catch(() => {/* API not running — no hidden nations applied */});
  }, []);

  useEffect(() => {
    fetchHiddenFeatures()
      .then((ids) => setHiddenFeatureIds(new Set(ids)))
      .catch(() => {/* API not running */});
  }, []);

  const handleHideFeature = useCallback((id: string, type: 'polity' | 'event') => {
    setHiddenFeatureIds((prev) => new Set(prev).add(id));
    setFeatureHidden(id, type, true).catch(console.error);
    // Close the panel since the feature is now hidden
    setSelectedFeature(null);
  }, []);

  const handleUnlinkPolygon = useCallback((polygonId: string) => {
    unlinkPolygon(polygonId).catch(console.error);
    setLocalPolygonUnlinks((prev) => new Set(prev).add(polygonId));
  }, []);

  const handleUnlinkOhmTerritory = useCallback((ohmName: string) => {
    const link = ohmLinks.find((l) => l.ohmName === ohmName && l.polityId && !l.explicitlyUnlinked);
    if (link) {
      unlinkOhmLink(link.id).catch(console.error);
    } else {
      suppressOhmLink(ohmName).catch(console.error);
    }
    refreshOhmLinks();
  }, [ohmLinks, refreshOhmLinks]);

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

  // Merge API-persisted corrections over the baseline on startup (events + polities)
  useEffect(() => {
    Promise.allSettled([fetchOverrides(), fetchPolityOverrides()])
      .then(([eventsResult, politiesResult]) => {
        const allFeatures: GeoJSON.Feature[] = [];
        if (eventsResult.status === 'fulfilled') allFeatures.push(...eventsResult.value.features);
        if (politiesResult.status === 'fulfilled') allFeatures.push(...politiesResult.value.features);
        if (allFeatures.length === 0) return;
        setOverrideMap(new Map(
          allFeatures.map((f) => [(f.properties as { id: string }).id, f]),
        ));
      });
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
      if (mappingTarget) { setMappingTarget(null); return; }
      if (ohmMappingTarget) { setOhmMappingTarget(null); return; }
      if (showWelcome) { setShowWelcome(false); return; }
      setSelectedFeature(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mappingTarget, ohmMappingTarget, showWelcome]);

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

  const handleToggleBorders = useCallback(() => setShowBorders((v) => !v), []);
  const handleToggleOtherPolities = useCallback(() => setShowOtherPolities((v) => !v), []);

  const handleSelectFeature = useCallback((props: FeatureProperties, stackInfo: StackInfo) => {
    setSelectedFeature(props);
    setStack(stackInfo);
    if (props.yearStart !== null) {
      const isStaticFeature = props.featureType === 'city' || props.featureType === 'region'
        || props.featureType === 'polity';
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

  const handleNavigateToFeature = useCallback((feature: FeatureProperties, center?: [number, number]) => {
    // Only seek the timeline for events and polities — locations (cities/regions) exist across
    // all time and should never cause a jump to their founding date.
    if (feature.featureType === 'event' && feature.yearStart !== null) {
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
    setZoomRequest({ feature, id: ++zoomIdRef.current, center });
  }, [timeline, navigate]);

  const handleStartStory = useCallback(async (slug: string) => {
    setSelectedFeature(null);
    timeline.setStepSize(STEP_DAY);
    const result = await loadStory(slug);
    if (!result) return;
    const firstBeat = result.story.beats[0];
    if (firstBeat?.event_qid) {
      const feature = result.beatEvents.get(firstBeat.event_qid);
      if (feature) handleNavigateToFeature(feature, result.beatCenters.get(firstBeat.event_qid));
    }
  }, [loadStory, handleNavigateToFeature, timeline]);

  const handleStoryBeatNavigate = useCallback((index: number, targetBeatEvents: typeof beatEvents, targetBeatCenters: typeof beatCenters) => {
    if (!story) return;
    const beat = story.beats[index];
    if (!beat?.event_qid) return;
    const feature = targetBeatEvents.get(beat.event_qid);
    if (feature) handleNavigateToFeature(feature, targetBeatCenters.get(beat.event_qid));
  }, [story, handleNavigateToFeature]);

  const handleNextBeat = useCallback(() => {
    if (!story) return;
    const next = Math.min(beatIndex + 1, story.beats.length - 1);
    if (next === beatIndex) return;
    setBeatIndex(next);
    handleStoryBeatNavigate(next, beatEvents, beatCenters);
  }, [story, beatIndex, setBeatIndex, beatEvents, beatCenters, handleStoryBeatNavigate]);

  const handlePrevBeat = useCallback(() => {
    if (!story) return;
    const prev = Math.max(beatIndex - 1, 0);
    if (prev === beatIndex) return;
    setBeatIndex(prev);
    handleStoryBeatNavigate(prev, beatEvents, beatCenters);
  }, [story, beatIndex, setBeatIndex, beatEvents, beatCenters, handleStoryBeatNavigate]);

  const handleJumpToBeat = useCallback((index: number) => {
    if (!story) return;
    setBeatIndex(index);
    handleStoryBeatNavigate(index, beatEvents, beatCenters);
  }, [story, setBeatIndex, beatEvents, beatCenters, handleStoryBeatNavigate]);

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
    <TranslationContext.Provider value={translationMap}>
    <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#f8f9fa' }}>
      <CategoryFilter
        activeCategories={activeCategories}
        onToggle={handleToggleCategory}
        showBorders={showBorders}
        onToggleBorders={handleToggleBorders}
        showOtherPolities={showOtherPolities}
        onToggleOtherPolities={handleToggleOtherPolities}
        onOpenAbout={() => navigate('/about')}
        onOpenData={() => navigate('/data')}
        onEditTerritory={() => setEditorMode((v) => !v)}
        editorMode={editorMode}
        selectedLang={selectedLang}
        onLangChange={handleLangChange}
        windowInfo={windowInfo}
        eventsLoading={eventsLoading}
        eventsError={eventsError}
        territoriesLoading={territoriesLoading}
        territoriesError={territoriesError}
        seedLoading={seedLoading}
        locationCount={locationCount}
        polityCount={polityCount}
      />

      <div style={{ position: 'absolute', inset: `69px 0 ${TIMELINE_BAR_HEIGHT}px 0` }}>
        <div style={{ position: 'absolute', bottom: 10, left: 10, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none', maxWidth: 240 }}>
          <UnlocatedEventsPanel
            eventFeatures={eventFeatures}
            currentDateInt={timeline.currentDateInt}
            stepSize={timeline.stepSize}
            onSelectFeature={(props) => {
              setSelectedFeature(props);
              setStack({ index: 0, total: 1 });
            }}
          />
          <MajorEventsPanel
            geojson={geojson}
            currentDateInt={timeline.currentDateInt}
            stepSize={timeline.stepSize}
            onNavigateToFeature={handleNavigateToFeature}
            selectedQid={majorEventFilter}
            onSelectQid={setMajorEventFilter}
            onFitBounds={(bbox) => setFitBoundsRequest({ bbox, id: ++fitBoundsIdRef.current })}
          />
        </div>
        <MapView
          geojson={geojson}
          territoriesGeojson={patchedTerritories}
          currentDateInt={timeline.currentDateInt}
          stepSize={timeline.stepSize}
          activeCategories={activeCategories}
          showBorders={showBorders}
          showOtherPolities={showOtherPolities}
          onSelectFeature={handleSelectFeature}
          zoomRequest={zoomRequest}
          fitBoundsRequest={fitBoundsRequest}
          hiddenNations={hiddenNations}
          suppressedPolityIds={suppressedPolityIds}
          polityIdsWithTerritory={polityIdsWithTerritory}
          onUnmatchedTerritoryClick={(hbName, polygonId, yearStart, yearEnd) => setMappingTarget({ hbName, polygonId, yearStart, yearEnd })}
          onUnlinkPolygon={handleUnlinkPolygon}
          majorEventFilter={majorEventFilter}
          onMapReady={setMapInstance}
          editorMode={editorMode}
          territorySource={territorySource}
          ohmLinks={ohmLinks}
          onOhmTerritoryClick={(ohmName, ohmWikidataQid) => setOhmMappingTarget({ ohmName, ohmWikidataQid })}
          onUnlinkOhmTerritory={handleUnlinkOhmTerritory}
          onOhmMatchedPolityIds={setOhmMatchedPolityIds}
        />
      </div>

      {story ? (
        <StoryPanel
          story={story}
          beatIndex={beatIndex}
          currentBeat={currentBeat}
          currentBeatEvent={currentBeatEvent}
          onNext={handleNextBeat}
          onPrev={handlePrevBeat}
          onJumpToBeat={handleJumpToBeat}
          onExit={exitStory}
        />
      ) : (
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
          onHideFeature={handleHideFeature}
          selectedLang={selectedLang}
          onStartStory={handleStartStory}
        />
      )}

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
          polygonId={mappingTarget.polygonId}
          yearStart={mappingTarget.yearStart}
          yearEnd={mappingTarget.yearEnd}
          polities={polityFeatures}
          onClose={() => setMappingTarget(null)}
          onPolityImported={(feature) => {
            setSeedFeatureCollection((prev) => ({
              ...prev,
              features: [...prev.features, feature],
            }));
          }}
          onSaved={(polityId, polityName) => {
            setLocalMappings((m) => new Map(m).set(
              mappingTarget.polygonId,
              { polityId, polityName },
            ));
            refreshTerritories();
          }}
          onYearsUpdated={refreshTerritories}
          onDeleted={() => {
            setMappingTarget(null);
            refreshTerritories();
          }}
        />
      )}
      {ohmMappingTarget && (
        <OhmMappingModal
          ohmName={ohmMappingTarget.ohmName}
          ohmWikidataQid={ohmMappingTarget.ohmWikidataQid}
          polities={polityFeatures}
          onClose={() => setOhmMappingTarget(null)}
          onPolityImported={(feature) => {
            setSeedFeatureCollection((prev) => ({
              ...prev,
              features: [...prev.features, feature],
            }));
          }}
          onSaved={() => {
            setOhmMappingTarget(null);
            refreshOhmLinks();
          }}
        />
      )}
      {showWelcome && <WelcomeModal onClose={() => setShowWelcome(false)} />}

{editorMode && mapInstance && (
        <TerritoryEditor
          map={mapInstance}
          currentYear={currentYear}
          onClose={() => setEditorMode(false)}
          onSaved={() => { refreshTerritories(); setEditorMode(false); }}
          onTerritoryCreated={(polygonId, yearStart, yearEnd) =>
            setMappingTarget({ hbName: 'New Territory', polygonId, yearStart, yearEnd })
          }
        />
      )}
    </div>
    </TranslationContext.Provider>
  );
}
