import { useEffect, useRef, useCallback } from 'react';
import maplibregl, { Map, GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureProperties, Category } from '../types';
import { CATEGORY_COLORS } from '../theme/categories';

const FADE_WINDOW = 10;

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
  currentYear: number;
  activeCategories: Set<Category>;
  onSelectFeature: (props: FeatureProperties, stack: StackInfo) => void;
  zoomRequest?: ZoomRequest | null;
}


// Major = all events + regions + countries + explicitly major cities — always visible
const MAJOR_FILTER = ['any',
  ['==', ['get', 'featureType'], 'event'],
  ['==', ['get', 'featureType'], 'region'],
  ['==', ['get', 'featureType'], 'country'],
  ['==', ['get', 'cityImportance'], 'major'],
] as maplibregl.FilterSpecification;

// Minor = cities that aren't explicitly major — zoom-gated
const MINOR_FILTER = ['all',
  ['==', ['get', 'featureType'], 'city'],
  ['!=', ['get', 'cityImportance'], 'major'],
] as maplibregl.FilterSpecification;

export function MapView({ geojson, currentYear, activeCategories, onSelectFeature, zoomRequest }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const updateFilterRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [20, 35],
      zoom: 3,
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-right');

    map.on('load', () => {
      map.addSource('features', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });

      const circlePaint: maplibregl.CirclePaintSpecification = {
        'circle-color': ['coalesce', ['get', '_color'], '#9E9E9E'],
        'circle-radius': ['case',
          ['==', ['get', 'featureType'], 'country'], 12,
          ['==', ['get', 'featureType'], 'region'],  9,
          ['==', ['get', 'featureType'], 'city'],    7,
          5,
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': ['case',
          ['==', ['get', 'featureType'], 'country'], 3,
          ['==', ['get', 'featureType'], 'region'],  2.5,
          1.5,
        ],
        'circle-opacity': ['number', ['get', '_opacity'], 1.0],
      };

      const labelLayout: maplibregl.SymbolLayoutSpecification = {
        'text-field': ['get', 'title'],
        'text-size': 11,
        'text-offset': [0, 1.2],
        'text-anchor': 'top',
        'text-max-width': 12,
        'text-optional': true,
      };

      const labelPaint: maplibregl.SymbolPaintSpecification = {
        'text-color': '#ffffff',
        'text-halo-color': 'rgba(0,0,0,0.75)',
        'text-halo-width': 1.5,
        'text-opacity': ['number', ['get', '_opacity'], 1.0],
      };

      // Events + major cities: always visible
      map.addLayer({ id: 'circles-major', type: 'circle', source: 'features', filter: MAJOR_FILTER, paint: circlePaint });
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

      map.on('mouseenter', 'circles-major', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'circles-major', () => { map.getCanvas().style.cursor = ''; });
      map.on('mouseenter', 'circles-minor', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'circles-minor', () => { map.getCanvas().style.cursor = ''; });

      // Populate features immediately on load using the latest filter state
      updateFilterRef.current();
    });

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  const onSelectRef = useRef(onSelectFeature);
  onSelectRef.current = onSelectFeature;
  const stackRef = useRef<{ ids: string[]; index: number } | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const features = e.features;
      if (!features || features.length === 0) return;

      const ids = features.map((f) => String(f.properties?.id ?? ''));
      let index = 0;
      if (stackRef.current?.ids.length === ids.length && stackRef.current.ids.every((id, i) => id === ids[i])) {
        index = (stackRef.current.index + 1) % ids.length;
      }
      stackRef.current = { ids, index };

      const raw = { ...features[index].properties } as Record<string, unknown>;
      if (typeof raw.categories === 'string') {
        try { raw.categories = JSON.parse(raw.categories as string); } catch { /* leave as-is */ }
      }
      onSelectRef.current(raw as unknown as FeatureProperties, { index, total: ids.length });
    };

    map.on('click', 'circles-major', onClick);
    map.on('click', 'circles-minor', onClick);
    return () => {
      map.off('click', 'circles-major', onClick);
      map.off('click', 'circles-minor', onClick);
    };
  }, []);

  const updateFilter = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    const source = map.getSource('features') as GeoJSONSource | undefined;
    if (!source) return;

    const visible = geojson.features.flatMap((f) => {
      const p = f.properties as FeatureProperties;

      const catOk = p.categories.some((c) => activeCategories.has(c));
      if (!catOk) return [];

      const isLocation = p.featureType === 'city' || p.featureType === 'region' || p.featureType === 'country';

      // Locations with no founding date: always visible
      if (p.yearStart == null) {
        if (!isLocation) return [];
        const _color = CATEGORY_COLORS[p.primaryCategory] ?? '#9E9E9E';
        return [{ ...f, properties: { ...f.properties, _opacity: 1.0, _color } }];
      }

      let yearOk: boolean;
      if (isLocation) {
        yearOk = p.yearStart <= currentYear && (p.yearEnd == null || currentYear <= p.yearEnd);
      } else if (p.yearEnd != null) {
        yearOk = p.yearStart <= currentYear && currentYear <= p.yearEnd;
      } else {
        yearOk = p.yearStart <= currentYear && currentYear <= p.yearStart + FADE_WINDOW;
      }

      if (!yearOk) return [];

      const baseOpacity = (isLocation || !p.dateIsFuzzy) ? 1.0 : 0.6;
      let fadeOpacity = 1.0;
      if (!isLocation && p.yearEnd == null && currentYear > p.yearStart) {
        fadeOpacity = 1.0 - (currentYear - p.yearStart) / FADE_WINDOW;
      }

      const _color = CATEGORY_COLORS[p.primaryCategory] ?? '#9E9E9E';
      return [{ ...f, properties: { ...f.properties, _opacity: baseOpacity * fadeOpacity, _color } }];
    });

    source.setData({ type: 'FeatureCollection', features: visible });
  }, [geojson, currentYear, activeCategories]);

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
      if (target?.geometry.type === 'Point') {
        const [lon, lat] = (target.geometry as GeoJSON.Point).coordinates;
        map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 6), duration: 800 });
      }
      onSelectRef.current(zoomRequest.feature, { index: 0, total: 1 });
    };

    if (map.isStyleLoaded()) doFly();
    else map.once('load', doFly);
  }, [zoomRequest, geojson]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
