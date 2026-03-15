import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslations } from '../lib/TranslationContext';
import type { OhmLink } from '../hooks/useOhmLinks';
import maplibregl, { Map, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureProperties, Category } from '../types';
import { CATEGORY_COLORS } from '../theme/categories';
import { CATEGORY_SVGS } from '../theme/icons';
import { encodeDate, eventDateRange, STEP_YEAR, decodeDate } from '../hooks/useTimeline';

// ---------------------------------------------------------------------------
// Territory label points — explode MultiPolygon features into ranked Points
// so each polity shows at most MAX_LABEL_PARTS labels (largest parts first).
// ---------------------------------------------------------------------------
const MAX_LABEL_PARTS = 3;

function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(a / 2);
}

function ringCentroid(ring: number[][]): [number, number] {
  const n = ring.length - 1;
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; }
  return [x / n, y / n];
}


function buildLabelPoints(features: GeoJSON.Feature[]): GeoJSON.Feature[] {
  type Part = { area: number; centroid: [number, number]; props: Record<string, unknown> };
  // Note: avoid `new Map()` — `Map` is shadowed by the maplibre-gl import above.
  const byPolity: Record<string, Part[]> = {};
  const unmatched: GeoJSON.Feature[] = [];

  for (const f of features) {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const polityId = props.polityId as string | null;
    const geom = f.geometry;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;
    const rings = geom.type === 'Polygon'
      ? [(geom as GeoJSON.Polygon).coordinates]
      : (geom as GeoJSON.MultiPolygon).coordinates;

    if (!polityId) {
      if (rings.length === 0) continue;
      const biggest = rings.reduce((best, r) => ringArea(r[0]) > ringArea(best[0]) ? r : best, rings[0]);
      if (!biggest[0]?.length) continue;
      unmatched.push({ type: 'Feature', geometry: { type: 'Point', coordinates: ringCentroid(biggest[0]) }, properties: props });
      continue;
    }

    const parts = byPolity[polityId] ?? [];
    for (const r of rings) {
      if (!r[0]?.length) continue;
      parts.push({ area: ringArea(r[0]), centroid: ringCentroid(r[0]), props });
    }
    byPolity[polityId] = parts;
  }

  const matched: GeoJSON.Feature[] = [];
  for (const parts of Object.values(byPolity)) {
    parts.sort((a, b) => b.area - a.area);
    parts.slice(0, MAX_LABEL_PARTS).forEach((p, i) => {
      matched.push({ type: 'Feature', geometry: { type: 'Point', coordinates: p.centroid }, properties: { ...p.props, _labelRank: i + 1 } });
    });
  }

  return [...unmatched, ...matched];
}

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
  /** Direct coordinates fallback — used when the feature isn't in the loaded geojson window. */
  center?: [number, number];
}

interface Props {
  geojson: GeoJSON.FeatureCollection;
  territoriesGeojson?: GeoJSON.FeatureCollection;
  currentDateInt: number;
  stepSize: number;
  activeCategories: Set<Category>;
  showBorders: boolean;
  showOtherPolities: boolean;
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
  /** 'hb' shows historical-basemaps GeoJSON territories; 'ohm' shows live OHM vector tiles */
  territorySource?: 'hb' | 'ohm';
  /** OHM polity color links — used to color matched territories in OHM mode */
  ohmLinks?: OhmLink[];
  /** Called when user clicks an OHM territory that has no polity assigned */
  onOhmTerritoryClick?: (ohmName: string, ohmWikidataQid: string | null) => void;
  /** Called when user clicks × to unlink an OHM territory from its polity */
  onUnlinkOhmTerritory?: (ohmName: string) => void;
  /** Called after rebuildColors with the set of polity IDs that are matched to a visible OHM territory */
  onOhmMatchedPolityIds?: (ids: Set<string>) => void;
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

export function MapView({ geojson, territoriesGeojson, currentDateInt, stepSize, activeCategories, showBorders, showOtherPolities, onSelectFeature, zoomRequest, fitBoundsRequest, hiddenNations, suppressedPolityIds, polityIdsWithTerritory, onUnmatchedTerritoryClick, onUnlinkPolygon, majorEventFilter, onMapReady, editorMode, territorySource = 'hb', ohmLinks, onOhmTerritoryClick, onUnlinkOhmTerritory, onOhmMatchedPolityIds }: Props) {
  const translationMap = useTranslations();
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
  const showBordersRef = useRef(showBorders);
  showBordersRef.current = showBorders;
  const territorySourceRef = useRef(territorySource);
  territorySourceRef.current = territorySource;
  const ohmLinksRef = useRef(ohmLinks ?? []);
  ohmLinksRef.current = ohmLinks ?? [];
  const onOhmTerritoryClickRef = useRef(onOhmTerritoryClick);
  onOhmTerritoryClickRef.current = onOhmTerritoryClick;
  const [showModernBorders, setShowModernBorders] = useState(false);
  const showModernBordersRef = useRef(showModernBorders);
  showModernBordersRef.current = showModernBorders;
  const [hoveredLabel, setHoveredLabel] = useState<HoveredLabel | null>(null);
  const [hoveredOhmLabel, setHoveredOhmLabel] = useState<{ ohmName: string; x: number; y: number } | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Cache the first-seen screen position per territory name so re-hovering the same label
  // always shows the × at the same spot. Cleared on map move to avoid stale positions.
  const hbLabelPosCache = useRef<Record<string, { x: number; y: number }>>({});
  const ohmLabelPosCache = useRef<Record<string, { x: number; y: number }>>({});
  const rebuildColorsRef = useRef<() => void>(() => {});
  const onUnlinkPolygonRef = useRef(onUnlinkPolygon);
  onUnlinkPolygonRef.current = onUnlinkPolygon;
  const onUnlinkOhmTerritoryRef = useRef(onUnlinkOhmTerritory);
  onUnlinkOhmTerritoryRef.current = onUnlinkOhmTerritory;
  const onOhmMatchedPolityIdsRef = useRef(onOhmMatchedPolityIds);
  onOhmMatchedPolityIdsRef.current = onOhmMatchedPolityIds;

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
      attributionControl: false,
    });

    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
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
      // Separate point source for territory labels — one point per polygon part,
      // ranked by area so we can limit each polity to its 3 largest parts.
      map.addSource('territory-labels', {
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
      // Territory labels — sourced from territory-labels (exploded points, ranked by area).
      // Each polity shows at most 3 labels (its 3 largest polygon parts).
      map.addLayer({
        id: 'labels-territory',
        type: 'symbol',
        source: 'territory-labels',
        filter: ['any',
          ['!', ['has', '_labelRank']],        // unmatched — always label
          ['<=', ['get', '_labelRank'], 3],     // matched — top 3 largest parts only
        ],
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

      // ── OHM vector tile source + layers ──────────────────────────────────────
      // Live administrative boundary tiles from Open Historical Map (CC0).
      // Tile spec (verified from live tile inspection):
      //   URL: https://vtiles.openhistoricalmap.org/maps/ohm_admin/{z}/{x}/{y}.pbf
      //   Source layer: 'boundaries'
      //   admin_level: integer (2 = sovereign state)
      //   start_decdate / end_decdate: float (e.g. 1852.9194)
      //   name_en: English name; name: primary-language name
      //   NOTE: no 'wikidata' property in tiles — polity color matching uses name_en
      const OHM_SOURCE_LAYER = 'boundaries';
      const ohmInitialVis = territorySourceRef.current === 'ohm' ? 'visible' : 'none';
      const initialYear = decodeDate(currentDateInt).year;
      // Initial filter matches the temporal effect logic: require start_decdate, hide untimed features.
      const OHM_ADMIN_FILTER = ['all',
        ['match', ['get', 'admin_level'], [2, 3], true, false],
        ['has', 'start_decdate'],
        ['<=', ['get', 'start_decdate'], initialYear],
        ['any', ['!', ['has', 'end_decdate']], ['>=', ['get', 'end_decdate'], initialYear]],
      ] as maplibregl.FilterSpecification;

      map.addSource('ohm-admin', {
        type: 'vector',
        tiles: ['https://vtiles.openhistoricalmap.org/maps/ohm_admin/{z}/{x}/{y}.pbf'],
        maxzoom: 14,
        attribution: '© <a href="https://www.openhistoricalmap.org" target="_blank">OpenHistoricalMap</a> contributors',
      });
      map.addLayer({
        id: 'ohm-fills',
        type: 'fill',
        source: 'ohm-admin',
        'source-layer': OHM_SOURCE_LAYER,
        filter: OHM_ADMIN_FILTER,
        layout: { visibility: ohmInitialVis },
        paint: { 'fill-color': '#78909C', 'fill-opacity': 0.22 },
      });
      map.addLayer({
        id: 'ohm-borders',
        type: 'line',
        source: 'ohm-admin',
        'source-layer': OHM_SOURCE_LAYER,
        filter: OHM_ADMIN_FILTER,
        layout: { visibility: ohmInitialVis },
        paint: { 'line-color': '#78909C', 'line-width': 1.2, 'line-opacity': 0.6 },
      });
      map.addLayer({
        id: 'ohm-labels',
        type: 'symbol',
        source: 'ohm-admin',
        'source-layer': OHM_SOURCE_LAYER,
        filter: OHM_ADMIN_FILTER,
        layout: {
          'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']],
          'text-size': 12,
          'text-max-width': 10,
          'text-optional': true,
          'text-font': ['Open Sans Italic', 'Arial Unicode MS Regular'],
          visibility: ohmInitialVis,
        },
        paint: {
          'text-color': '#9e9e9e',
          'text-halo-color': 'rgba(0,0,0,0.6)',
          'text-halo-width': 1.5,
        },
      });
      // Hide HB territory layers if starting in OHM mode
      if (territorySourceRef.current === 'ohm') {
        for (const id of ['fills-territory', 'borders-territory', 'labels-territory']) {
          map.setLayoutProperty(id, 'visibility', 'none');
        }
      }

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

      // Apply initial modern border visibility from ref (in case toggle was hit before load)
      if (!showModernBordersRef.current) applyBorderVisibility(map, false);

      for (const layer of ['circles-major', 'circles-minor', 'events-major', 'stars-polity', 'fills-territory', 'labels-territory', 'ohm-fills']) {
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
        const polygonId = feat.properties?.polygonId as string;
        const pos = hbLabelPosCache.current[polygonId] ?? { x: e.point.x, y: e.point.y };
        hbLabelPosCache.current[polygonId] = pos;
        setHoveredLabel({ polygonId, hbName: feat.properties?.hbName as string, x: pos.x, y: pos.y });
      });
      map.on('mouseleave', 'labels-territory', () => {
        hideTimerRef.current = setTimeout(() => setHoveredLabel(null), 150);
      });

      // Hover state for OHM territory labels: show × unlink button on any colored label
      // (manual DB link OR auto-matched by polity name).
      const DATE_SUFFIX_RE_HOVER = /\s*\(\d{1,4}(?:\s*[-–]\s*(?:\d{1,4}|present))?\)\s*$/;
      map.on('mouseenter', 'ohm-labels', (e) => {
        if (!e.features?.length) return;
        const feat = e.features[0];
        const rawName = (feat.properties?.name_en ?? feat.properties?.name ?? '') as string;
        const stripped = rawName.replace(DATE_SUFFIX_RE_HOVER, '').trim();
        if (!stripped) return;
        // Check manual DB link first
        const hasManualLink = ohmLinksRef.current.some((l) => l.ohmName === stripped && l.polityId && !l.explicitlyUnlinked);
        // Fall back to auto-match: any polity whose title matches the stripped name
        const hasAutoMatch = !hasManualLink && geojsonRef.current.features.some((f) => {
          const p = f.properties as FeatureProperties;
          return p.featureType === 'polity' && p.title.toLowerCase() === stripped.toLowerCase();
        });
        if (!hasManualLink && !hasAutoMatch) return;
        if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
        const pos = ohmLabelPosCache.current[stripped] ?? { x: e.point.x, y: e.point.y };
        ohmLabelPosCache.current[stripped] = pos;
        setHoveredOhmLabel({ ohmName: stripped, x: pos.x, y: pos.y });
      });
      map.on('mouseleave', 'ohm-labels', () => {
        hideTimerRef.current = setTimeout(() => setHoveredOhmLabel(null), 150);
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
      // Invalidate label position caches so re-hovering after a pan/zoom picks up fresh coords.
      hbLabelPosCache.current = {};
      ohmLabelPosCache.current = {};
    });

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // Toggle political boundary layers without reloading the style
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    applyBorderVisibility(map, showModernBorders);
  }, [showModernBorders]);

  // Toggle between HB (GeoJSON) and OHM (vector tile) territory layers
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const hbVis = territorySource !== 'ohm' ? 'visible' : 'none';
    const ohmVis = territorySource === 'ohm' ? 'visible' : 'none';
    for (const id of ['fills-territory', 'borders-territory', 'labels-territory']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', hbVis);
    }
    for (const id of ['ohm-fills', 'ohm-borders', 'ohm-labels']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', ohmVis);
    }
  }, [territorySource]);

  // Update OHM temporal filter on every year tick
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (!map.getLayer('ohm-fills')) return;

    const year = decodeDate(currentDateInt).year;
    // Temporal filter: start_decdate and end_decdate are floats (e.g. 1852.9194)
    // Require start_decdate to exist — features without it have no temporal metadata
    // and would otherwise appear at all times (wrong for a historical atlas).
    // Missing end_decdate = still active (no end date), so allow those through.
    const temporalFilter = ['all',
      ['match', ['get', 'admin_level'], [2, 3], true, false],
      ['has', 'start_decdate'],
      ['<=', ['get', 'start_decdate'], year],
      ['any', ['!', ['has', 'end_decdate']], ['>=', ['get', 'end_decdate'], year]],
    ] as maplibregl.FilterSpecification;

    map.setFilter('ohm-fills', temporalFilter);
    map.setFilter('ohm-borders', temporalFilter);
    map.setFilter('ohm-labels', temporalFilter);
  }, [currentDateInt]);

  // Auto-color OHM territories by matching rendered tile names against polity names.
  // OHM tiles have no 'wikidata' property, so we:
  //   1. Query rendered OHM features after each map idle (new tiles loaded)
  //   2. Strip date suffixes from name_en: "Republic of Venice (1510-1571)" → "Republic of Venice"
  //   3. Match stripped name (case-insensitive) against polity titles in geojson
  //   4. Build a ['match', name_en, ...fullName→color pairs, default] expression
  // Manual ohm_territory_links entries can override any auto-match.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const rebuildColors = () => {
      if (!map.getLayer('ohm-fills')) return;

      // Build lowercase polity-name → color/id lookup from loaded polities (always fresh via ref)
      // Note: avoid `new Map()` — `Map` is shadowed by the maplibre-gl import.
      const polityColorByName: Record<string, string> = {};
      const polityIdByName: Record<string, string> = {};
      for (const f of geojsonRef.current.features) {
        const p = f.properties as FeatureProperties;
        if (p.featureType !== 'polity') continue;
        const color = CATEGORY_COLORS[(p.polityType as keyof typeof CATEGORY_COLORS) ?? 'other'] ?? CATEGORY_COLORS.other;
        polityColorByName[p.title.toLowerCase()] = color;
        polityIdByName[p.title.toLowerCase()] = p.id;
      }

      // queryRenderedFeatures can throw if the map's WebGL painter isn't ready.
      // This is safe to swallow — sourcedata/moveend will retry automatically.
      let rendered: maplibregl.MapGeoJSONFeature[];
      try {
        rendered = map.queryRenderedFeatures({ layers: ['ohm-fills'] });
      } catch {
        return;
      }
      const fillPairs: (string | maplibregl.ExpressionSpecification)[] = [];
      const labelPairs: (string | maplibregl.ExpressionSpecification)[] = [];
      const textPairs: (string | maplibregl.ExpressionSpecification)[] = [];

      // Strip trailing " (YYYY)" / " (YYYY-YYYY)" / " (YYYY-present)" date suffixes.
      // Links are stored by base name (server strips on save), so a single link for
      // "French Republic" covers "French Republic (1800)", "French Republic (1801-1804)", etc.
      const DATE_SUFFIX_RE = /\s*\(\d{1,4}(?:\s*[-–]\s*(?:\d{1,4}|present))?\)\s*$/;
      // stripDisplay: removes date suffix, preserves original casing (for map labels / UI)
      // stripKey: additionally lowercases for case-insensitive lookups
      const stripDisplay = (s: string) => s.replace(DATE_SUFFIX_RE, '').trim();
      const stripSuffix = (s: string) => stripDisplay(s).toLowerCase();

      // Build base-name → color/polityId/polityName lookup from manual links.
      // Also track suppressed names (explicitlyUnlinked=TRUE) so auto-match skips them.
      const linkColorByBase: Record<string, string> = {};
      const linkPolityIdByBase: Record<string, string> = {};
      const linkPolityNameByBase: Record<string, string> = {};
      const suppressedByBase = new Set<string>();
      for (const link of ohmLinksRef.current) {
        if (!link.ohmName) continue;
        if (link.explicitlyUnlinked) {
          suppressedByBase.add(stripSuffix(link.ohmName));
        } else if (link.polityId) {
          const key = stripSuffix(link.ohmName);
          linkColorByBase[key] = link.color;
          linkPolityIdByBase[key] = link.polityId;
          if (link.polityName) linkPolityNameByBase[key] = link.polityName;
        }
      }

      // For each rendered feature: manual link (by base name) takes priority over auto-match.
      // Suppressed names are skipped entirely.
      const seenNames = new Set<string>();
      const matchedPolityIds = new Set<string>();
      for (const f of rendered) {
        const fullName = (f.properties?.name_en ?? f.properties?.name ?? '') as string;
        if (!fullName || seenNames.has(fullName)) continue;
        seenNames.add(fullName);

        const displayName = stripDisplay(fullName);
        const base = displayName.toLowerCase();
        const color = suppressedByBase.has(base) ? undefined : (linkColorByBase[base] ?? polityColorByName[base]);
        if (color) {
          fillPairs.push(fullName, color);
          labelPairs.push(fullName, '#f5c842');
          // Track which polity this territory is matched to (for star suppression)
          const polityId = linkPolityIdByBase[base] ?? polityIdByName[base];
          if (polityId) matchedPolityIds.add(polityId);
        }
        // Remap label text: manual DB link uses polity name; otherwise just strip date suffix.
        // Even uncoloured features get their suffix stripped.
        const labelName = linkPolityNameByBase[base] ?? displayName;
        if (fullName !== labelName) {
          textPairs.push(fullName, labelName);
        }
      }

      const nameExpr = ['coalesce', ['get', 'name_en'], ['get', 'name']] as unknown as maplibregl.ExpressionSpecification;
      const fillColor = fillPairs.length > 0
        ? (['match', nameExpr, ...fillPairs, '#78909C'] as unknown as maplibregl.ExpressionSpecification)
        : '#78909C';
      const labelColor = labelPairs.length > 0
        ? (['match', nameExpr, ...labelPairs, '#9e9e9e'] as unknown as maplibregl.ExpressionSpecification)
        : '#9e9e9e';
      // Label text: mapped names strip date suffix; unmapped fall back to raw tile name.
      const labelText = textPairs.length > 0
        ? (['match', nameExpr, ...textPairs, nameExpr] as unknown as maplibregl.ExpressionSpecification)
        : nameExpr;

      map.setPaintProperty('ohm-fills', 'fill-color', fillColor);
      map.setPaintProperty('ohm-borders', 'line-color', fillColor);
      map.setPaintProperty('ohm-labels', 'text-color', labelColor);
      map.setLayoutProperty('ohm-labels', 'text-field', labelText);

      onOhmMatchedPolityIdsRef.current?.(matchedPolityIds);
    };

    rebuildColorsRef.current = rebuildColors;

    // Rebuild when OHM tiles finish loading. 'sourcedata' does not fire when
    // setPaintProperty is called, so there is no infinite loop.
    const onSourceData = (e: maplibregl.MapSourceDataEvent) => {
      if (e.sourceId === 'ohm-admin' && e.isSourceLoaded) rebuildColors();
    };
    // Also rebuild after panning/zooming to catch any new visible features.
    map.on('sourcedata', onSourceData);
    map.on('moveend', rebuildColors);
    return () => {
      map.off('sourcedata', onSourceData);
      map.off('moveend', rebuildColors);
    };
  // Empty deps: geojsonRef and ohmLinksRef are always current — no need to re-register listeners.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-run rebuildColors whenever ohmLinks changes (e.g. after an unlink/suppress).
  useEffect(() => {
    rebuildColorsRef.current();
  }, [ohmLinks]);

  const onSelectRef = useRef(onSelectFeature);
  onSelectRef.current = onSelectFeature;
  const onUnmatchedTerritoryRef = useRef(onUnmatchedTerritoryClick);
  onUnmatchedTerritoryRef.current = onUnmatchedTerritoryClick;
  const onMapReadyRef = useRef(onMapReady);
  onMapReadyRef.current = onMapReady;
  const editorModeRef = useRef(editorMode);
  editorModeRef.current = editorMode;
  const stackRef = useRef<{ ids: string[]; index: number } | null>(null);
  const ohmStackRef = useRef<{ names: string[]; index: number } | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Single map-level handler queries all clickable layers at once.
    // Layer-specific handlers would fire multiple times per click for stacked
    // war events (circles-major + icons-war both hit), corrupting the stack index.
    const CLICK_LAYERS = ['events-major', 'circles-major', 'circles-minor', 'stars-polity', 'fills-territory', 'labels-territory', 'ohm-fills'];

    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (editorModeRef.current) return;
      const features = map.queryRenderedFeatures(e.point, { layers: CLICK_LAYERS });
      if (!features || features.length === 0) return;

      const top = features[0];

      // OHM territory click.
      // Priority:
      //   1. Direct Wikidata QID match against polities in geojson (auto, no manual linking needed)
      //   2. Manual ohm_territory_links override (name-keyed, for renames / overrides)
      //   3. No match → open OhmMappingModal
      if (top.layer.id === 'ohm-fills') {
        // Re-query specifically for ohm-fills to get ALL overlapping polygons at this point.
        const allOhmFeatures = map.queryRenderedFeatures(e.point, { layers: ['ohm-fills'] });
        const DATE_SUFFIX = /\s*\(\d{1,4}(?:\s*[-–]\s*(?:\d{1,4}|present))?\)\s*$/;
        const stripName = (s: string) => s.replace(DATE_SUFFIX, '').trim();

        // Resolve an OHM tile feature to its matched polity in geojson (DB link takes priority).
        const resolvePolity = (f: maplibregl.MapGeoJSONFeature) => {
          const stripped = stripName((f.properties?.name_en ?? f.properties?.name ?? '') as string);
          const link = ohmLinksRef.current.find((l) => l.ohmName === stripped && !l.explicitlyUnlinked);
          if (link?.polityId)
            return geojsonRef.current.features.find((p) => (p.properties as FeatureProperties).id === link.polityId) ?? null;
          const isSuppressed = ohmLinksRef.current.some((l) => l.ohmName === stripped && l.explicitlyUnlinked);
          if (isSuppressed) return null;
          return geojsonRef.current.features.find(
            (p) => (p.properties as FeatureProperties).featureType === 'polity'
              && (p.properties as FeatureProperties).title?.toLowerCase() === stripped.toLowerCase(),
          ) ?? null;
        };

        const polityDuration = (f: maplibregl.MapGeoJSONFeature) => {
          const polity = resolvePolity(f);
          if (!polity) return Infinity;
          const p = polity.properties as FeatureProperties;
          return (p.yearEnd ?? 9999) - (p.yearStart ?? 0);
        };

        // Build sorted list of ALL unique OHM features at this point.
        // Matched polities come first (sorted by admin_level desc, then polity duration asc).
        // Unmatched (no polity, not suppressed) come after — clicking them opens the mapping modal.
        // Deduplicate: matched by polity id, unmatched by stripped name.
        const seenKeys = new Set<string>();
        type OhmEntry = { feature: maplibregl.MapGeoJSONFeature; polity: GeoJSON.Feature | null; strippedName: string };
        const allEntries: OhmEntry[] = allOhmFeatures
          .map((f) => ({
            feature: f,
            polity: resolvePolity(f),
            strippedName: stripName((f.properties?.name_en ?? f.properties?.name ?? '') as string),
          }))
          .filter(({ polity, strippedName }) => {
            // Exclude suppressed (explicitly unlinked with no replacement)
            const isSuppressed = !polity && ohmLinksRef.current.some((l) => l.ohmName === strippedName && l.explicitlyUnlinked);
            if (isSuppressed) return false;
            // Deduplicate by polity id (matched) or stripped name (unmatched)
            const key = polity ? `polity:${(polity.properties as FeatureProperties).id}` : `name:${strippedName}`;
            if (seenKeys.has(key)) return false;
            seenKeys.add(key);
            return true;
          })
          .sort((a, b) => {
            // Matched polities before unmatched
            if (!!a.polity !== !!b.polity) return a.polity ? -1 : 1;
            // Among matched: highest admin_level first, then shortest polity duration
            const levelDiff = Number(b.feature.properties?.admin_level ?? 0) - Number(a.feature.properties?.admin_level ?? 0);
            if (levelDiff !== 0) return levelDiff;
            return polityDuration(a.feature) - polityDuration(b.feature);
          });

        if (allEntries.length === 0) return;

        // Cycle through entries on repeated clicks at the same spot.
        const names = allEntries.map((e) => e.strippedName);
        let idx = 0;
        if (ohmStackRef.current?.names.length === names.length && ohmStackRef.current.names.every((n, i) => n === names[i])) {
          idx = (ohmStackRef.current.index + 1) % names.length;
        }
        ohmStackRef.current = { names, index: idx };

        const { feature: chosen, polity: chosenPolity, strippedName: chosenName } = allEntries[idx];

        if (chosenPolity) {
          const raw = { ...chosenPolity.properties } as Record<string, unknown>;
          for (const key of ['categories', 'partOfResolved', 'wikidataClasses'] as const) {
            if (typeof raw[key] === 'string') {
              try { raw[key] = JSON.parse(raw[key] as string); } catch { /* leave as-is */ }
            }
          }
          onSelectRef.current(raw as unknown as FeatureProperties, { index: idx, total: allEntries.length });
        } else {
          // Unmatched territory — open mapping modal
          onOhmTerritoryClickRef.current?.(chosenName, chosen.properties?.wikidata as string | null);
        }
        return;
      }

      // If the top hit is an HB territory, resolve to the linked polity feature instead
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

        if (!showOtherPolities) return [];

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

        const translatedTitle = (translationMap && p.wikidataQid) ? translationMap[p.wikidataQid] : undefined;
        const titleProps = translatedTitle ? { title: translatedTitle } : {};
        return [{ ...f, properties: { ...f.properties, ...titleProps, _opacity: 1.0, _labelOpacity: 1.0, _color, _minZoom } }];
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
      // Build polityId (UUID) → wikidataQid lookup for territory label translation
      const polityIdToQid: Record<string, string> = {};
      if (translationMap && Object.keys(translationMap).length > 0) {
        for (const f of geojson.features) {
          const p = f.properties as FeatureProperties;
          if (p.featureType === 'polity' && p.id && p.wikidataQid) {
            polityIdToQid[p.id] = p.wikidataQid;
          }
        }
      }

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
        if (!showBorders) return [];
        // If polity is a hidden modern nation, render territory as unlinked (gray, no name)
        if (p.polityId && hiddenNations?.has(p.polityId)) {
          return [{ ...f, properties: { ...f.properties, polityId: null, polityName: null, politySlug: null, polityType: null } }];
        }
        // Apply translated polity name if available
        const qid = p.polityId ? polityIdToQid[p.polityId] : null;
        const translatedName = (qid && translationMap) ? translationMap[qid] : null;
        if (translatedName) {
          return [{ ...f, properties: { ...f.properties, polityName: translatedName } }];
        }
        // Note: suppressedPolityIds is intentionally NOT applied to territory polygons.
        // Capital-conflict suppression is only for polity marker dots — territory shapes
        // have explicit geographic bounds and should always render within their time interval.
        return [f];
      });
      terrSource.setData({ type: 'FeatureCollection', features: visibleTerritories });

      const labelSource = map.getSource('territory-labels') as GeoJSONSource | undefined;
      if (labelSource) {
        labelSource.setData({ type: 'FeatureCollection', features: buildLabelPoints(visibleTerritories) });
      }
    }
  }, [geojson, territoriesGeojson, currentDateInt, stepSize, activeCategories, showBorders, showOtherPolities, hiddenNations, majorEventFilter, translationMap]);

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
      } else if (zoomRequest.center) {
        map.flyTo({ center: zoomRequest.center, zoom: Math.max(map.getZoom(), 6), duration: 800 });
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

      {/* × unlink button — appears next to a hovered matched territory label (HB mode) */}
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

      {/* × unlink button — appears next to a hovered linked OHM territory label */}
      {hoveredOhmLabel && (
        <button
          onMouseEnter={() => {
            if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
          }}
          onMouseLeave={() => setHoveredOhmLabel(null)}
          onClick={() => {
            onUnlinkOhmTerritoryRef.current?.(hoveredOhmLabel.ohmName);
            setHoveredOhmLabel(null);
          }}
          title="Unlink OHM territory from polity"
          style={{
            position: 'absolute',
            left: hoveredOhmLabel.x + 6,
            top: hoveredOhmLabel.y - 10,
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

      {/* Modern border layer toggle — sits to the left of the NavigationControl */}
      <style>{`
        .oh-borders-btn .oh-tooltip {
          display: none;
          position: absolute;
          top: 50%;
          right: 36px;
          transform: translateY(-50%);
          background: rgba(20,20,20,0.9);
          color: #fff;
          font-size: 11px;
          font-weight: 500;
          white-space: nowrap;
          padding: 4px 8px;
          border-radius: 4px;
          pointer-events: none;
        }
        .oh-borders-btn:hover .oh-tooltip { display: block; }
      `}</style>
      <div
        className="oh-borders-btn"
        style={{ position: 'absolute', top: 10, right: 50, zIndex: 10 }}
      >
        <button
          onClick={() => setShowModernBorders((v) => !v)}
          style={{
            width: 29,
            height: 29,
            background: showModernBorders ? '#3366cc' : '#ffffff',
            border: '1px solid rgba(0,0,0,0.3)',
            borderRadius: 4,
            boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
            <polygon
              points="7.5,1.5 13.5,5.5 13.5,9.5 7.5,13.5 1.5,9.5 1.5,5.5"
              fill="none"
              stroke={showModernBorders ? '#ffffff' : '#54595d'}
              strokeWidth="1.4"
              strokeDasharray="2.2 1.8"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <span className="oh-tooltip">{showModernBorders ? 'Hide Modern Borders' : 'Show Modern Borders'}</span>
      </div>
    </div>
  );
}
