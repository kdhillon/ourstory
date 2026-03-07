import { useEffect, useRef, useCallback, useState } from 'react';
import maplibregl, { Map, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureProperties, Category } from '../types';
import { CATEGORY_COLORS } from '../theme/categories';
import { CATEGORY_SVGS } from '../theme/icons';
import { encodeDate, eventDateRange, STEP_YEAR, decodeDate } from '../hooks/useTimeline';

// Linger window: 5 steps in the current unit, capped at 3 years.
const LINGER_STEPS = 5;
const LINGER_MAX = 3 * STEP_YEAR;

// Zoom offset added per polity type on top of the sitelinks-based base zoom.
// Higher = needs more zoom to appear. Major polities (empire, kingdom) show early;
// smaller or noisier types (principality, people, other) are held back.
const POLITY_ZOOM_OFFSET: Record<string, number> = {
  empire:        2,
  kingdom:       2,
  republic:      2,
  papacy:        2,
  sultanate:     3,
  confederation: 3,
  colony:        3,
  principality:  3,
  people:        4,
  other:         4,
};
// Principalities with no linked territory are hidden until this zoom level minimum.
const UNLINKED_PRINCIPALITY_MIN_ZOOM = 8;

// ─── Canvas icons ────────────────────────────────────────────────────────────
//
// Each event category gets a pre-rendered canvas image: colored circle + white
// Lucide icon. Lucide SVGs are bundled at build time via ?raw imports in
// icons.ts — no CDN requests, no CORS issues.
//
// Using a single image (vs separate circle + symbol layers) ensures the
// background and icon always come from the same GeoJSON feature, preventing
// mismatches when events stack at the same pixel.
//
const ICON_SIZE = 28; // canvas px; MapLibre icon-size scales this
const catIconName = (cat: Category) => `ev-${cat}`;

function loadCategoryIcons(map: Map): Promise<void> {
  return Promise.all(
    (Object.entries(CATEGORY_SVGS) as [Category, string][]).map(([category, rawSvg]) =>
      new Promise<void>((resolve) => {
        const color    = CATEGORY_COLORS[category];
        const name     = catIconName(category);
        // Lucide icons use stroke="currentColor"; replace with white
        const whiteSvg = rawSvg.replace(/currentColor/g, 'white');
        const blob     = new Blob([whiteSvg], { type: 'image/svg+xml' });
        const url      = URL.createObjectURL(blob);

        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);

          const canvas  = document.createElement('canvas');
          canvas.width  = ICON_SIZE;
          canvas.height = ICON_SIZE;
          const ctx = canvas.getContext('2d')!;
          const cx  = ICON_SIZE / 2;
          const r   = cx - 1.5;

          // Colored background circle
          ctx.beginPath();
          ctx.arc(cx, cx, r, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // White icon — Lucide SVGs are 24×24 viewBox, drawn at ~60% of canvas
          const pad = Math.round(ICON_SIZE * 0.2);
          ctx.drawImage(img, pad, pad, ICON_SIZE - pad * 2, ICON_SIZE - pad * 2);

          const { data } = ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE);
          map.addImage(name, { width: ICON_SIZE, height: ICON_SIZE, data: new Uint8Array(data) });
          resolve();
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(); };
        img.src = url;
      })
    )
  ).then(() => {});
}

export interface StackInfo {
  index: number;
  total: number;
}

export interface ZoomRequest {
  feature: FeatureProperties;
  id: number;
}

interface Props {
  geojson: GeoJSON.FeatureCollection;
  territoriesGeojson?: GeoJSON.FeatureCollection;
  currentDateInt: number;
  stepSize: number;
  activeCategories: Set<Category>;
  activePolityCategories: Set<Category>;
  onSelectFeature: (props: FeatureProperties, stack: StackInfo) => void;
  zoomRequest?: ZoomRequest | null;
  /** Fit the map to a bounding box (used when selecting a major event chip). */
  fitBoundsRequest?: { bbox: [number, number, number, number]; id: number } | null;
  /** polityId → hideUntilYear: territories for these polities are hidden before that year */
  hiddenNations?: Map<string, number>;
  /** Polity IDs suppressed because a more-specific co-capital polity is active at this year */
  suppressedPolityIds?: Set<string>;
  /** Polity IDs whose territory polygon is visible — hides the capital dot only (not the territory) */
  polityIdsWithTerritory?: Set<string>;
  /** Called when user clicks an unmatched territory (no polity linked) */
  onUnmatchedTerritoryClick?: (hbName: string, polygonId: string, yearStart: number, yearEnd: number | null) => void;
  /** Called when user clicks × to unlink a single polygon from its polity */
  onUnlinkPolygon?: (polygonId: string) => void;
  /** When set, only events whose partOf[] includes this QID are shown */
  majorEventFilter?: string | null;
  /** Called once after the MapLibre map finishes loading — provides the map instance for editor components. */
  onMapReady?: (map: Map) => void;
  /** When true, disables all click handling (territory editor mode). */
  editorMode?: boolean;
}


// Circles: regions and explicitly major cities (no events)
const LOCATION_MAJOR_FILTER = ['any',
  ['==', ['get', 'featureType'], 'region'],
  ['==', ['get', 'cityImportance'], 'major'],
] as maplibregl.FilterSpecification;

// Symbol icons: events only, zoom-gated by _minZoom
const EVENT_FILTER = ['all',
  ['==', ['get', 'featureType'], 'event'],
  ['<=', ['coalesce', ['get', '_minZoom'], 4], ['zoom']],
] as maplibregl.FilterSpecification;

// Labels: events + major location markers (combined filter for the text layer)
const MAJOR_FILTER = ['any',
  ['all',
    ['==', ['get', 'featureType'], 'event'],
    ['<=', ['coalesce', ['get', '_minZoom'], 4], ['zoom']],
  ],
  ['==', ['get', 'featureType'], 'region'],
  ['==', ['get', 'cityImportance'], 'major'],
] as maplibregl.FilterSpecification;

// Minor = cities that aren't explicitly major — zoom-gated
const MINOR_FILTER = ['all',
  ['==', ['get', 'featureType'], 'city'],
  ['!=', ['get', 'cityImportance'], 'major'],
] as maplibregl.FilterSpecification;

// Polities — hollow rings, rendered on their own layers
const POLITY_FILTER = ['==', ['get', 'featureType'], 'polity'] as maplibregl.FilterSpecification;

function applyBorderVisibility(map: Map, visible: boolean) {
  const visibility = visible ? 'visible' : 'none';
  map.getStyle().layers.forEach((layer) => {
    const sourceLayer = (layer as { 'source-layer'?: string })['source-layer'];
    if (sourceLayer === 'boundary') {
      map.setLayoutProperty(layer.id, 'visibility', visibility);
    }
  });
}

interface HoveredLabel {
  polygonId: string;
  hbName: string;
  x: number;
  y: number;
}

export function MapView({ geojson, territoriesGeojson, currentDateInt, stepSize, activeCategories, activePolityCategories, onSelectFeature, zoomRequest, fitBoundsRequest, hiddenNations, suppressedPolityIds, polityIdsWithTerritory, onUnmatchedTerritoryClick, onUnlinkPolygon, majorEventFilter, onMapReady, editorMode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const updateFilterRef = useRef<() => void>(() => {});
  const territoriesGeojsonRef = useRef(territoriesGeojson);
  territoriesGeojsonRef.current = territoriesGeojson;
  const geojsonRef = useRef(geojson);
  geojsonRef.current = geojson;
  const suppressedPolityIdsRef = useRef(suppressedPolityIds ?? new Set<string>());
  suppressedPolityIdsRef.current = suppressedPolityIds ?? new Set<string>();
  const polityIdsWithTerritoryRef = useRef(polityIdsWithTerritory ?? new Set<string>());
  polityIdsWithTerritoryRef.current = polityIdsWithTerritory ?? new Set<string>();
  const [showBorders, setShowBorders] = useState(false);
  const showBordersRef = useRef(showBorders);
  showBordersRef.current = showBorders;
  const [hoveredLabel, setHoveredLabel] = useState<HoveredLabel | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onUnlinkPolygonRef = useRef(onUnlinkPolygon);
  onUnlinkPolygonRef.current = onUnlinkPolygon;

  useEffect(() => {
    const container = containerRef.current;
    // Guard 1: skip if no container, already initialized, or container detached from DOM
    // (React 18 Strict Mode runs effects twice; the second run must not re-create the map
    //  on a container that MapLibre already removed its canvas from)
    if (!container || mapRef.current || !container.isConnected) return;

    let savedCenter: [number, number] = [20, 35];
    let savedZoom = 3;
    try {
      const c = localStorage.getItem('oh-map-center');
      const z = localStorage.getItem('oh-map-zoom');
      if (c) { const parsed = JSON.parse(c); if (Array.isArray(parsed) && parsed.length === 2) savedCenter = parsed as [number, number]; }
      if (z) { const n = parseFloat(z); if (isFinite(n)) savedZoom = n; }
    } catch { /* ignore */ }

    const map = new maplibregl.Map({
      container,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: savedCenter,
      zoom: savedZoom,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', async () => {
      // Guard 2: bail out if this map instance was removed before load fired
      // (happens in Strict Mode when cleanup runs before the async load event)
      if (mapRef.current !== map) return;
      // Icons must be registered before layers render, so load them first.
      await loadCategoryIcons(map);
      // Guard 3: re-check after the async gap — cleanup may have run during the await
      if (mapRef.current !== map) return;

      map.addSource('features', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      const circlePaint = {
        'circle-color': ['coalesce', ['get', '_color'], '#9E9E9E'],
        'circle-radius': ['case',
          ['has', '_radius'],                                 ['get', '_radius'],
          ['==', ['get', 'featureType'], 'region'],           11,
          ['==', ['get', 'cityImportance'], 'major'],         9,
          ['==', ['get', 'featureType'], 'city'],             6,
          6,
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['case',
          ['==', ['get', 'featureType'], 'region'],  3,
          2,
        ],
        'circle-opacity': ['number', ['get', '_opacity'], 1.0],
      };

      const labelLayout = {
        'text-field': ['get', 'title'],
        'text-size': ['case', ['==', ['get', 'primaryCategory'], 'war'], 22, 14],
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-max-width': 12,
        'text-optional': true,
      };

      const labelPaint = {
        'text-color': '#ffffff',
        'text-halo-color': 'rgba(0,0,0,0.75)',
        'text-halo-width': 1.5,
        'text-opacity': ['number', ['get', '_labelOpacity'], 1.0],
      };

      // Territory polygons — rendered first (bottommost layer)
      map.addSource('territories', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'fills-territory',
        type: 'fill',
        source: 'territories',
        paint: {
          'fill-color': ['coalesce', ['get', '_color'], '#607D8B'],
          'fill-opacity': 0.22,
        },
      });
      map.addLayer({
        id: 'borders-territory',
        type: 'line',
        source: 'territories',
        paint: {
          'line-color': ['coalesce', ['get', '_color'], '#607D8B'],
          'line-width': 1.2,
          'line-opacity': 0.6,
        },
      });
      // Territory name at the visual centroid of each polygon
      map.addLayer({
        id: 'labels-territory',
        type: 'symbol',
        source: 'territories',
        layout: {
          'text-field': ['coalesce', ['get', 'polityName'], ['get', 'hbName']],
          'text-size': 12,
          'text-max-width': 10,
          'text-optional': true,
          'text-font': ['Open Sans Italic', 'Arial Unicode MS Regular'],
        },
        paint: {
          'text-color': [
            'case',
            ['!=', ['get', 'polityId'], null], '#f5c842',  // matched → yellow
            '#9e9e9e',                                       // unmatched → gray
          ],
          'text-halo-color': 'rgba(0,0,0,0.6)',
          'text-halo-width': 1.5,
        },
      });

      // Polity zoom filter: same _minZoom convention as events
      const POLITY_ZOOM_FILTER = ['all',
        ['==', ['get', 'featureType'], 'polity'],
        ['<=', ['coalesce', ['get', '_minZoom'], 2], ['zoom']],
      ] as maplibregl.FilterSpecification;

      map.addLayer({
        id: 'labels-polity',
        type: 'symbol',
        source: 'features',
        filter: POLITY_ZOOM_FILTER,
        layout: { ...labelLayout, 'text-offset': [0, 1.6], 'text-size': 13 },
        paint: labelPaint,
      });

      // Capital star: shown at the centre of every polity
      map.addLayer({
        id: 'stars-polity',
        type: 'symbol',
        source: 'features',
        filter: ['all',
          ['==', ['get', 'featureType'], 'polity'],
          ['<=', ['coalesce', ['get', '_minZoom'], 2], ['zoom']],
        ] as maplibregl.FilterSpecification,
        layout: {
          'icon-image': 'star',
          'icon-size': 0.9,
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-color': ['coalesce', ['get', '_color'], '#9E9E9E'],
          'icon-opacity': ['number', ['get', '_opacity'], 1.0],
        },
      });

      // Location circles: regions, countries, major cities
      map.addLayer({ id: 'circles-major', type: 'circle', source: 'features', filter: LOCATION_MAJOR_FILTER, paint: circlePaint });

      // Event icons: single symbol layer using pre-rendered canvas images.
      // Background + icon are part of the same image, so they always come from
      // the same GeoJSON feature — no mismatch when events stack at one pixel.
      map.addLayer({
        id: 'events-major',
        type: 'symbol',
        source: 'features',
        filter: EVENT_FILTER,
        layout: {
          'icon-image': ['coalesce', ['get', '_icon'], 'marker'],
          'icon-size': ['interpolate', ['linear'], ['coalesce', ['get', '_radius'], 7], 5, 0.6, 7, 0.75, 9, 0.9, 12, 1.1],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-opacity': ['number', ['get', '_opacity'], 1.0],
        },
      });

      // Labels for events + major locations
      map.addLayer({ id: 'labels-major', type: 'symbol', source: 'features', filter: MAJOR_FILTER, layout: labelLayout, paint: labelPaint });

      // Minor cities: MapLibre natively hides this layer below zoom 7
      map.addLayer({ id: 'circles-minor', type: 'circle', source: 'features', filter: MINOR_FILTER, minzoom: 7, paint: circlePaint });
      map.addLayer({ id: 'labels-minor', type: 'symbol', source: 'features', filter: MINOR_FILTER, minzoom: 7, layout: labelLayout, paint: labelPaint });

      // Hide base map place labels — our own historical features provide this context
      map.getStyle().layers.forEach((layer) => {
        if (layer.type === 'symbol' && (layer as { 'source-layer'?: string })['source-layer'] === 'place') {
          map.setLayoutProperty(layer.id, 'visibility', 'none');
        }
      });

      // Apply initial border visibility from ref (in case toggle was hit before load)
      if (!showBordersRef.current) applyBorderVisibility(map, false);

      for (const layer of ['circles-major', 'circles-minor', 'events-major', 'stars-polity', 'fills-territory', 'labels-territory']) {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
      }

      // Hover state for territory labels: show × unlink button on matched (yellow) labels
      map.on('mouseenter', 'labels-territory', (e) => {
        if (!e.features?.length) return;
        const feat = e.features[0];
        const polityId = feat.properties?.polityId as string | null;
        if (!polityId) return; // only matched territories show the unlink button
        if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
        setHoveredLabel({
          polygonId: feat.properties?.polygonId as string,
          hbName: feat.properties?.hbName as string,
          x: e.point.x,
          y: e.point.y,
        });
      });
      map.on('mouseleave', 'labels-territory', () => {
        hideTimerRef.current = setTimeout(() => setHoveredLabel(null), 150);
      });

      updateFilterRef.current();
      onMapReadyRef.current?.(map);
    });

    map.on('moveend', () => {
      try {
        const { lng, lat } = map.getCenter();
        localStorage.setItem('oh-map-center', JSON.stringify([lng, lat]));
        localStorage.setItem('oh-map-zoom', String(map.getZoom()));
      } catch { /* ignore */ }
    });

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // Toggle political boundary layers without reloading the style
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    applyBorderVisibility(map, showBorders);
  }, [showBorders]);

  const onSelectRef = useRef(onSelectFeature);
  onSelectRef.current = onSelectFeature;
  const onUnmatchedTerritoryRef = useRef(onUnmatchedTerritoryClick);
  onUnmatchedTerritoryRef.current = onUnmatchedTerritoryClick;
  const onMapReadyRef = useRef(onMapReady);
  onMapReadyRef.current = onMapReady;
  const editorModeRef = useRef(editorMode);
  editorModeRef.current = editorMode;
  const stackRef = useRef<{ ids: string[]; index: number } | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Single map-level handler queries all clickable layers at once.
    // Layer-specific handlers would fire multiple times per click for stacked
    // war events (circles-major + icons-war both hit), corrupting the stack index.
    const CLICK_LAYERS = ['events-major', 'circles-major', 'circles-minor', 'stars-polity', 'fills-territory', 'labels-territory'];

    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (editorModeRef.current) return;
      const features = map.queryRenderedFeatures(e.point, { layers: CLICK_LAYERS });
      if (!features || features.length === 0) return;

      // If the top hit is a territory, resolve to the linked polity feature instead
      const top = features[0];
      if (top.properties?.featureType === 'territory') {
        const polityId = top.properties?.polityId as string | null;
        if (!polityId) {
          // Unmatched territory — open the mapping assignment UI
          const hbName    = top.properties?.hbName     as string | undefined;
          const polygonId = top.properties?.polygonId  as string | undefined;
          const yearStart = top.properties?.yearStart   as number | undefined;
          const yearEnd   = top.properties?.yearEnd     as number | null | undefined;
          if (hbName && polygonId && yearStart != null) {
            onUnmatchedTerritoryRef.current?.(hbName, polygonId, yearStart, yearEnd ?? null);
          }
          return;
        }
        const polityFeature = geojsonRef.current.features.find(
          (f) => (f.properties as FeatureProperties).id === polityId,
        );
        if (!polityFeature) return;
        const raw = { ...polityFeature.properties } as Record<string, unknown>;
        for (const key of ['categories', 'partOfResolved', 'wikidataClasses'] as const) {
          if (typeof raw[key] === 'string') {
            try { raw[key] = JSON.parse(raw[key] as string); } catch { /* leave as-is */ }
          }
        }
        onSelectRef.current(raw as unknown as FeatureProperties, { index: 0, total: 1 });
        return;
      }

      // Deduplicate by id — queryRenderedFeatures can return the same feature
      // from multiple layers (e.g. a war event appears in both circles-major and icons-war).
      // Also exclude territory features here — they are only handled via the early-return
      // branch above (when they're the top hit). Letting them into the stack cycling causes
      // handleSelectFeature to receive a territory with no yearStart → encodeDate(undefined) → NaN.
      const seen = new Set<string>();
      const unique = features.filter((f) => {
        if (f.properties?.featureType === 'territory') return false;
        const id = String(f.properties?.id ?? '');
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });

      const ids = unique.map((f) => String(f.properties?.id ?? ''));
      let index = 0;
      if (stackRef.current?.ids.length === ids.length && stackRef.current.ids.every((id, i) => id === ids[i])) {
        index = (stackRef.current.index + 1) % ids.length;
      }
      stackRef.current = { ids, index };

      const raw = { ...unique[index].properties } as Record<string, unknown>;
      for (const key of ['categories', 'partOfResolved', 'wikidataClasses'] as const) {
        if (typeof raw[key] === 'string') {
          try { raw[key] = JSON.parse(raw[key] as string); } catch { /* leave as-is */ }
        }
      }
      onSelectRef.current(raw as unknown as FeatureProperties, { index, total: ids.length });
    };

    map.on('click', onClick);
    return () => { map.off('click', onClick); };
  }, []);

  const updateFilter = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    const source = map.getSource('features') as GeoJSONSource | undefined;
    if (!source) return;

    const suppressed = suppressedPolityIdsRef.current;
    const hasTerritory = polityIdsWithTerritoryRef.current;
    const currentYear = decodeDate(currentDateInt).year;

    // End of the current time "bucket": events starting anywhere within the current
    // year/month/day are all visible. e.g. in year mode (stepSize=10000), effectiveNow
    // covers the whole year so a Jul 14 event is visible when we're at "Jan 1789".
    const effectiveNow = currentDateInt + stepSize - 1;

    const visible = geojson.features.flatMap((f) => {
      // Null-geometry features (unlocated events) are Data Explorer-only — skip map rendering
      if (!f.geometry) return [];

      const p = f.properties as FeatureProperties;
      const isPolity   = p.featureType === 'polity';
      const isLocation = p.featureType === 'city' || p.featureType === 'region';

      // Polities use their own independent filter set
      if (isPolity) {
        // Require a start date always.
        // Null end date = "still active" — only valid for modern nation types (republic, kingdom).
        // Everything else (colony, empire, people, sultanate, etc.) must have an explicit end date.
        const STILL_ACTIVE_TYPES = new Set(['republic', 'kingdom']);
        if (p.yearStart == null) return [];
        if (p.yearEnd == null && !STILL_ACTIVE_TYPES.has(p.polityType ?? '')) return [];

        const catOk = p.categories.some((c) => activePolityCategories.has(c));
        if (!catOk) return [];

        const _color = CATEGORY_COLORS[p.primaryCategory] ?? '#9E9E9E';

        // Snap in/out at year_start / year_end — no fade (same as locations)
        if (p.yearStart != null) {
          const locStart = encodeDate(p.yearStart, 1, 1);
          const locEnd   = p.yearEnd != null ? encodeDate(p.yearEnd, 12, 31) : null;
          const yearOk   = locStart <= effectiveNow && (locEnd == null || currentDateInt <= locEnd);
          if (!yearOk) return [];
        }

        // Hide if a more-specific (shorter-lived) co-capital polity is active now
        if (suppressed.has(p.id)) return [];
        // Hide capital dot if this polity's territory polygon is already labelled on the map
        if (hasTerritory.has(p.id)) return [];

        // Hide modern nations before their hide_until_year threshold
        if (hiddenNations) {
          const threshold = hiddenNations.get(p.id);
          if (threshold !== undefined && currentYear < threshold) return [];
        }

        // Zoom threshold: sitelinks give a base zoom (more sitelinks = visible earlier),
        // then a per-type offset is added so noisier polity types appear later.
        const sl = p.sitelinksCount ?? null;
        const sitelinkZoom = sl === null ? 2 : sl >= 25 ? 1 : sl >= 10 ? 2 : sl >= 3 ? 4 : 6;
        const typeOffset   = POLITY_ZOOM_OFFSET[p.polityType ?? ''] ?? 3;
        const baseZoom     = sitelinkZoom + typeOffset;
        const isUnlinkedPrincipality = p.polityType === 'principality' && !hasTerritory.has(p.id);
        const _minZoom = isUnlinkedPrincipality ? Math.max(baseZoom, UNLINKED_PRINCIPALITY_MIN_ZOOM) : baseZoom;

        return [{ ...f, properties: { ...f.properties, _opacity: 1.0, _labelOpacity: 1.0, _color, _minZoom } }];
      }

      const catOk = p.categories.some((c) => activeCategories.has(c));
      if (!catOk) return [];

      // Locations with no founding date: always visible
      if (p.yearStart == null) {
        if (!isLocation) return [];
        const _color = CATEGORY_COLORS[p.primaryCategory] ?? '#9E9E9E';
        return [{ ...f, properties: { ...f.properties, _opacity: 1.0, _color } }];
      }

      let yearOk: boolean;
      if (isLocation) {
        const locStart = encodeDate(p.yearStart, 1, 1);
        const locEnd   = p.yearEnd != null ? encodeDate(p.yearEnd, 12, 31) : null;
        yearOk = locStart <= effectiveNow && (locEnd == null || currentDateInt <= locEnd);
      } else {
        const [startInt, endInt] = eventDateRange(
          p.yearStart, p.monthStart, p.dayStart,
          p.yearEnd,   p.monthEnd,   p.dayEnd,
        );
        yearOk = startInt <= effectiveNow && currentDateInt <= endInt + Math.min(LINGER_STEPS * stepSize, LINGER_MAX);
      }

      if (!yearOk) return [];

      // Major event filter: hide events that aren't part of the selected parent event
      if (majorEventFilter && !isLocation && p.featureType === 'event') {
        if (!(p.partOf ?? []).includes(majorEventFilter)) return [];
      }

      const baseOpacity = (isLocation || !p.dateIsFuzzy) ? 1.0 : 0.6;
      let fadeOpacity = 1.0;
      if (!isLocation) {
        const [, endInt] = eventDateRange(
          p.yearStart, p.monthStart, p.dayStart,
          p.yearEnd,   p.monthEnd,   p.dayEnd,
        );
        if (currentDateInt > endInt) {
          fadeOpacity = 0.5;
        }
      }

      const _color = CATEGORY_COLORS[p.primaryCategory] ?? '#9E9E9E';
      const extraProps: Record<string, unknown> = {
        _opacity: baseOpacity * fadeOpacity,
        _labelOpacity: baseOpacity,
        _color,
      };

      if (!isLocation) {
        // Sitelinks count drives both zoom threshold and pin size.
        // Higher sitelinks = more globally significant = visible earlier + bigger pin.
        const sl = p.sitelinksCount ?? null;
        extraProps._minZoom = sl === null ? 2 : sl >= 25 ? 1 : sl >= 10 ? 2 : sl >= 3 ? 4 : 6;
        extraProps._radius  = sl === null ? 7 : sl >= 25 ? 12 : sl >= 10 ? 9 : sl >= 3 ? 7 : 5;
        extraProps._icon    = (p.primaryCategory in CATEGORY_SVGS) ? catIconName(p.primaryCategory as Category) : 'marker';
      }

      return [{ ...f, properties: { ...f.properties, ...extraProps } }];
    });

    source.setData({ type: 'FeatureCollection', features: visible });

    // Territory fill layer — time-filter by yearStart/yearEnd
    const terrSource = map.getSource('territories') as GeoJSONSource | undefined;
    if (terrSource) {
      const allTerritories = territoriesGeojsonRef.current?.features ?? [];
      const visibleTerritories = allTerritories.flatMap((f) => {
        const p = f.properties as {
          yearStart: number;
          yearEnd: number | null;
          polityType: string | null;
          polityId: string | null;
        };
        if (p.yearStart > currentYear) return [];
        if (p.yearEnd !== null && currentYear > p.yearEnd) return [];
        // Apply polity category filter for linked territories; unlinked always show
        if (p.polityType && !activePolityCategories.has(p.polityType as Category)) return [];
        // If polity is a hidden modern nation, render territory as unlinked (gray, no name)
        if (p.polityId && hiddenNations?.has(p.polityId)) {
          return [{ ...f, properties: { ...f.properties, polityId: null, polityName: null, politySlug: null, polityType: null } }];
        }
        // Note: suppressedPolityIds is intentionally NOT applied to territory polygons.
        // Capital-conflict suppression is only for polity marker dots — territory shapes
        // have explicit geographic bounds and should always render within their time interval.
        return [f];
      });
      terrSource.setData({ type: 'FeatureCollection', features: visibleTerritories });
    }
  }, [geojson, territoriesGeojson, currentDateInt, stepSize, activeCategories, activePolityCategories, hiddenNations, majorEventFilter]);

  // Keep the ref current so the map.on('load') callback always invokes the latest version
  updateFilterRef.current = updateFilter;

  useEffect(() => {
    updateFilter();
  }, [updateFilter]);

  useEffect(() => {
    if (!zoomRequest) return;
    const map = mapRef.current;
    if (!map) return;

    const target = geojson.features.find(
      (f) => (f.properties as FeatureProperties).slug === zoomRequest.feature.slug,
    );

    const doFly = () => {
      if (target?.geometry?.type === 'Point') {
        const [lon, lat] = (target.geometry as GeoJSON.Point).coordinates;
        map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 6), duration: 800 });
      }
      onSelectRef.current(zoomRequest.feature, { index: 0, total: 1 });
    };

    if (map.isStyleLoaded()) doFly();
    else map.once('load', doFly);
  }, [zoomRequest, geojson]);

  useEffect(() => {
    if (!fitBoundsRequest) return;
    const map = mapRef.current;
    if (!map) return;
    const [west, south, east, north] = fitBoundsRequest.bbox;
    const doFit = () => {
      map.fitBounds([[west, south], [east, north]], {
        padding: { top: 80, bottom: 140, left: 80, right: 420 },
        maxZoom: 8,
        duration: 900,
      });
    };
    if (map.isStyleLoaded()) doFit();
    else map.once('load', doFit);
  }, [fitBoundsRequest]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* × unlink button — appears next to a hovered matched territory label */}
      {hoveredLabel && (
        <button
          onMouseEnter={() => {
            if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
          }}
          onMouseLeave={() => setHoveredLabel(null)}
          onClick={() => {
            onUnlinkPolygonRef.current?.(hoveredLabel.polygonId);
            setHoveredLabel(null);
          }}
          title="Unlink territory from polity"
          style={{
            position: 'absolute',
            left: hoveredLabel.x + 6,
            top: hoveredLabel.y - 10,
            zIndex: 20,
            background: 'rgba(30,30,30,0.82)',
            color: '#f5c842',
            border: '1px solid rgba(245,200,66,0.5)',
            borderRadius: '50%',
            width: 18,
            height: 18,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1,
            padding: 0,
            fontFamily: 'inherit',
          }}
        >
          ×
        </button>
      )}

      {/* Border layer toggle */}
      <div style={{
        position: 'absolute',
        bottom: 24,
        left: 10,
        display: 'flex',
        background: '#ffffff',
        borderRadius: 6,
        border: '1px solid rgba(0,0,0,0.15)',
        boxShadow: '0 2px 6px rgba(0,0,0,0.12)',
        overflow: 'hidden',
        zIndex: 10,
      }}>
        {([true, false] as const).map((val, i) => (
          <button
            key={String(val)}
            onClick={() => setShowBorders(val)}
            style={{
              padding: '5px 11px',
              fontSize: 11,
              fontWeight: 600,
              fontFamily: 'inherit',
              border: 'none',
              borderLeft: i > 0 ? '1px solid rgba(0,0,0,0.1)' : 'none',
              cursor: 'pointer',
              background: showBorders === val ? '#3366cc' : 'transparent',
              color: showBorders === val ? '#ffffff' : '#54595d',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            {val ? 'Modern Borders' : 'No Borders'}
          </button>
        ))}
      </div>
    </div>
  );
}
