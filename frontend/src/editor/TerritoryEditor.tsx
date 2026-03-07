/**
 * Territory Editor — main component
 *
 * Manages MapLibre layers for arc/vertex editing using TopoJSON shared-border topology.
 * Isolated module — delete the entire `editor/` folder to remove this feature.
 *
 * How it works:
 *  1. Fetches all territories active at `currentYear` from the API
 *  2. Runs topojson-server topology detection → shared borders become single arcs
 *  3. Renders arcs as editable line segments + vertex handle circles on the map
 *  4. Vertex drag updates that arc's coordinates → all polygons sharing the arc move together
 *  5. Save → reconstructs GeoJSON geometry per changed polygon → PATCH with year split
 */
import { useEffect, useRef, useState } from 'react';
import type { Map, GeoJSONSource } from 'maplibre-gl';
import { buildEditorData, buildVertexFC, buildArcFC } from './utils';
import type { PolygonEntry } from './utils';
import { EditorToolbar } from './EditorToolbar';
import { patchTerritoryGeometry } from '../lib/api';
import { NewTerritoryModal } from './NewTerritoryModal';
import { buildMultiPolygon } from './utils';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

const LAYER_ARC_LINES  = 'editor-arc-lines';
const LAYER_VERTICES   = 'editor-vertex-handles';
const SOURCE_ARCS      = 'editor-arcs';
const SOURCE_VERTICES  = 'editor-vertices';
const LAYER_DRAW_LINE  = 'editor-draw-line';
const LAYER_DRAW_SNAPS = 'editor-draw-snaps';
const SOURCE_DRAW_LINE  = 'editor-draw-line-src';
const SOURCE_DRAW_SNAPS = 'editor-draw-snaps-src';

function buildDrawLineFC(
  vertices: [number, number][],
  mousePos?: [number, number],
): GeoJSON.FeatureCollection {
  const pts: [number, number][] = mousePos ? [...vertices, mousePos] : [...vertices];
  if (pts.length < 2) return { type: 'FeatureCollection', features: [] };
  // Close preview ring when ≥ 3 vertices
  const coords: [number, number][] = pts.length >= 3 ? [...pts, pts[0]] : pts;
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }],
  };
}

function buildDrawSnapFC(vertices: [number, number][], snapHover = false): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: vertices.map((coord, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coord },
      properties: { first: i === 0, snapHover: i === 0 && snapHover },
    })),
  };
}

interface Props {
  map: Map;
  currentYear: number;
  onClose: () => void;
  onSaved: () => void;
  onTerritoryCreated: (polygonId: string, yearStart: number, yearEnd: number | null) => void;
}

export function TerritoryEditor({ map, currentYear, onClose, onSaved, onTerritoryCreated }: Props) {
  // Mutable refs — updated imperatively during drag without triggering re-renders
  const arcsRef            = useRef<[number, number][][]>([]);
  const arcPolygonCountRef = useRef<number[]>([]);
  const polygonsRef        = useRef<PolygonEntry[]>([]);
  const dirtyIdsRef        = useRef<Set<string>>(new Set());

  // React state — only for toolbar display
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dirtyCount, setDirtyCount] = useState(0);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState<string | null>(null);

  // Draw mode
  const [drawMode, setDrawMode]               = useState(false);
  const [drawVertexCount, setDrawVertexCount] = useState(0);
  // Pending new polygon: geometry captured after close, waiting for year-range modal
  const [pendingGeometry, setPendingGeometry] = useState<GeoJSON.MultiPolygon | null>(null);
  const pendingArcIdxRef  = useRef<number | null>(null);
  const drawVerticesRef   = useRef<[number, number][]>([]);
  const ringArcIndicesRef = useRef<Set<number>>(new Set()); // arc indices for drawn single-ring polygons
  const drawModeRef       = useRef(false);
  drawModeRef.current     = drawMode;

  // ── 1. Fetch + build topology ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setError(null);

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/territories?year_min=${currentYear}&year_max=${currentYear}`);
        if (!res.ok) throw new Error(`API error ${res.status}`);
        const fc = await res.json() as GeoJSON.FeatureCollection;

        if (cancelled) return;

        const data = buildEditorData(fc);
        if (!data) throw new Error('No editable territories at this year');

        arcsRef.current            = data.arcs;
        arcPolygonCountRef.current = data.arcPolygonCount;
        polygonsRef.current        = data.polygons;
        dirtyIdsRef.current        = new Set();
        setDirtyCount(0);
        setLoadState('ready');
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoadState('error');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [currentYear]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 2. Add MapLibre layers once topology is ready ───────────────────────
  useEffect(() => {
    if (loadState !== 'ready') return;

    const m = map;

    // Dim existing territory fills so edges are easier to see
    m.setPaintProperty('fills-territory', 'fill-opacity', 0.08);
    m.setPaintProperty('borders-territory', 'line-opacity', 0.25);

    // Arc lines — blue for shared borders, gray for coastlines/unshared
    m.addSource(SOURCE_ARCS, {
      type: 'geojson',
      data: buildArcFC(arcsRef.current, arcPolygonCountRef.current),
    });
    m.addLayer({
      id: LAYER_ARC_LINES,
      type: 'line',
      source: SOURCE_ARCS,
      paint: {
        'line-color': ['case', ['get', 'shared'], '#3b82f6', '#64748b'],
        'line-width': ['case', ['get', 'shared'], 2, 1],
        'line-opacity': 0.9,
      },
    });

    // Vertex handle circles
    m.addSource(SOURCE_VERTICES, {
      type: 'geojson',
      data: buildVertexFC(arcsRef.current),
    });
    m.addLayer({
      id: LAYER_VERTICES,
      type: 'circle',
      source: SOURCE_VERTICES,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 6, 3, 10, 6, 14, 9],
        'circle-color': '#ffffff',
        'circle-stroke-color': '#3b82f6',
        'circle-stroke-width': 1.5,
        'circle-opacity': 0.9,
      },
    });

    // Draw mode layers (sources populated imperatively when draw mode is active)
    m.addSource(SOURCE_DRAW_LINE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    m.addSource(SOURCE_DRAW_SNAPS, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    m.addLayer({
      id: LAYER_DRAW_LINE,
      type: 'line',
      source: SOURCE_DRAW_LINE,
      paint: { 'line-color': '#f59e0b', 'line-width': 2, 'line-dasharray': [4, 3] },
    });
    m.addLayer({
      id: LAYER_DRAW_SNAPS,
      type: 'circle',
      source: SOURCE_DRAW_SNAPS,
      paint: {
        'circle-radius': ['case',
          ['boolean', ['get', 'snapHover'], false], 14,
          ['boolean', ['get', 'first'],    false],  7,
          5,
        ] as maplibregl.ExpressionSpecification,
        'circle-color': ['case',
          ['boolean', ['get', 'snapHover'], false], '#22c55e',
          ['boolean', ['get', 'first'],    false], '#f59e0b',
          '#ffffff',
        ] as maplibregl.ExpressionSpecification,
        'circle-stroke-color': ['case',
          ['boolean', ['get', 'snapHover'], false], '#22c55e',
          '#f59e0b',
        ] as maplibregl.ExpressionSpecification,
        'circle-stroke-width': 2.5,
        'circle-opacity': 0.9,
      },
    });

    // ── Drag interaction ───────────────────────────────────────────────────
    const onEnter = () => { if (!drawModeRef.current) m.getCanvas().style.cursor = 'grab'; };
    const onLeave = () => { if (!drawModeRef.current) m.getCanvas().style.cursor = ''; };

    const onMousedown = (e: maplibregl.MapLayerMouseEvent) => {
      if (drawModeRef.current) return; // draw mode takes over — ignore vertex drags
      if (!e.features?.length) return;
      e.preventDefault();

      const { arcIdx, vertexIdx } = e.features[0].properties as { arcIdx: number; vertexIdx: number };

      m.dragPan.disable();
      m.getCanvas().style.cursor = 'grabbing';

      const onMove = (moveE: maplibregl.MapMouseEvent) => {
        const { lng, lat } = moveE.lngLat;

        // Move the vertex in-place (mutable ref — no React re-render)
        arcsRef.current[arcIdx][vertexIdx] = [lng, lat];

        // Mark all polygons referencing this arc as dirty
        for (const p of polygonsRef.current) {
          outer: for (const piece of p.arcRefs)
            for (const ring of piece)
              for (const ref of ring)
                if ((ref >= 0 ? ref : ~ref) === arcIdx) {
                  dirtyIdsRef.current.add(p.polygonId);
                  break outer;
                }
        }

        // Update MapLibre sources directly — avoids React state thrash during drag
        (m.getSource(SOURCE_VERTICES) as GeoJSONSource).setData(buildVertexFC(arcsRef.current));
        (m.getSource(SOURCE_ARCS)     as GeoJSONSource).setData(buildArcFC(arcsRef.current, arcPolygonCountRef.current, ringArcIndicesRef.current));
      };

      const onUp = () => {
        m.off('mousemove', onMove);
        m.dragPan.enable();
        m.getCanvas().style.cursor = 'grab';
        setDirtyCount(dirtyIdsRef.current.size + newPolygonIdsRef.current.size);
      };

      m.on('mousemove', onMove);
      m.once('mouseup', onUp);
    };

    m.on('mouseenter', LAYER_VERTICES, onEnter);
    m.on('mouseleave', LAYER_VERTICES, onLeave);
    m.on('mousedown',  LAYER_VERTICES, onMousedown);

    // ── Cleanup ────────────────────────────────────────────────────────────
    return () => {
      m.off('mouseenter', LAYER_VERTICES, onEnter);
      m.off('mouseleave', LAYER_VERTICES, onLeave);
      m.off('mousedown',  LAYER_VERTICES, onMousedown);

      try {
        if (m.getLayer(LAYER_DRAW_SNAPS))  m.removeLayer(LAYER_DRAW_SNAPS);
        if (m.getLayer(LAYER_DRAW_LINE))   m.removeLayer(LAYER_DRAW_LINE);
        if (m.getLayer(LAYER_VERTICES))    m.removeLayer(LAYER_VERTICES);
        if (m.getLayer(LAYER_ARC_LINES))   m.removeLayer(LAYER_ARC_LINES);
        if (m.getSource(SOURCE_DRAW_SNAPS)) m.removeSource(SOURCE_DRAW_SNAPS);
        if (m.getSource(SOURCE_DRAW_LINE))  m.removeSource(SOURCE_DRAW_LINE);
        if (m.getSource(SOURCE_VERTICES))   m.removeSource(SOURCE_VERTICES);
        if (m.getSource(SOURCE_ARCS))       m.removeSource(SOURCE_ARCS);
      } catch { /* map may already be destroyed */ }

      try {
        m.setPaintProperty('fills-territory',   'fill-opacity', 0.22);
        m.setPaintProperty('borders-territory', 'line-opacity', 0.6);
      } catch { /* ignore */ }

      m.getCanvas().style.cursor = '';
    };
  }, [loadState, map]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 3. Draw interaction ───────────────────────────────────────────────────
  useEffect(() => {
    if (loadState !== 'ready') return;
    const m = map;

    if (!drawMode) {
      m.getCanvas().style.cursor = '';
      return;
    }

    m.getCanvas().style.cursor = 'crosshair';

    const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

    const closePolygon = () => {
      const verts = drawVerticesRef.current;
      if (verts.length < 3) return;

      // Add arc to topology for visual display
      const arcIdx = arcsRef.current.length;
      arcsRef.current.push([...verts]);
      arcPolygonCountRef.current.push(1);
      ringArcIndicesRef.current.add(arcIdx);

      const tempId = `new-${Date.now()}`;
      polygonsRef.current.push({ polygonId: tempId, arcRefs: [[[arcIdx]]] });

      // Capture geometry and show year-range modal
      const geometry = buildMultiPolygon([[[arcIdx]]], arcsRef.current);
      pendingArcIdxRef.current = arcIdx;
      setPendingGeometry(geometry);

      // Clear draw state
      drawVerticesRef.current = [];
      setDrawVertexCount(0);
      setDrawMode(false);

      // Refresh arc/vertex layers
      (m.getSource(SOURCE_VERTICES) as GeoJSONSource).setData(buildVertexFC(arcsRef.current));
      (m.getSource(SOURCE_ARCS)     as GeoJSONSource).setData(buildArcFC(arcsRef.current, arcPolygonCountRef.current, ringArcIndicesRef.current));
      (m.getSource(SOURCE_DRAW_LINE)  as GeoJSONSource).setData(EMPTY_FC);
      (m.getSource(SOURCE_DRAW_SNAPS) as GeoJSONSource).setData(EMPTY_FC);
    };

    const SNAP_RADIUS = 30; // screen pixels

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      const verts = drawVerticesRef.current;
      if (verts.length === 0) return;
      let snapHover = false;
      if (verts.length >= 3) {
        const firstPt = m.project(verts[0]);
        snapHover = Math.hypot(firstPt.x - e.point.x, firstPt.y - e.point.y) < SNAP_RADIUS;
      }
      (m.getSource(SOURCE_DRAW_SNAPS) as GeoJSONSource).setData(buildDrawSnapFC(verts, snapHover));
      (m.getSource(SOURCE_DRAW_LINE)  as GeoJSONSource).setData(
        buildDrawLineFC(verts, [e.lngLat.lng, e.lngLat.lat]),
      );
    };

    const onClick = (e: maplibregl.MapMouseEvent) => {
      const verts = drawVerticesRef.current;
      // Snap to first vertex using same radius as hover
      if (verts.length >= 3) {
        const firstPt = m.project(verts[0]);
        if (Math.hypot(firstPt.x - e.point.x, firstPt.y - e.point.y) < SNAP_RADIUS) {
          closePolygon();
          return;
        }
      }
      const coord: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      verts.push(coord);
      setDrawVertexCount(verts.length);
      (m.getSource(SOURCE_DRAW_SNAPS) as GeoJSONSource).setData(buildDrawSnapFC(verts));
      (m.getSource(SOURCE_DRAW_LINE)  as GeoJSONSource).setData(buildDrawLineFC(verts));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        closePolygon();
      } else if (e.key === 'Escape') {
        drawVerticesRef.current = [];
        setDrawVertexCount(0);
        setDrawMode(false);
        (m.getSource(SOURCE_DRAW_LINE)  as GeoJSONSource).setData(EMPTY_FC);
        (m.getSource(SOURCE_DRAW_SNAPS) as GeoJSONSource).setData(EMPTY_FC);
      }
    };

    m.on('click', onClick);
    m.on('mousemove', onMouseMove);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      m.off('click', onClick);
      m.off('mousemove', onMouseMove);
      window.removeEventListener('keydown', onKeyDown);
      m.getCanvas().style.cursor = '';
    };
  }, [drawMode, loadState, map]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 4. Save ──────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      for (const polygonId of dirtyIdsRef.current) {
        const entry = polygonsRef.current.find((p) => p.polygonId === polygonId);
        if (!entry) continue;
        const geometry = buildMultiPolygon(entry.arcRefs, arcsRef.current);
        await patchTerritoryGeometry(polygonId, geometry, currentYear);
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const handleModalCancel = () => {
    // Remove the pending arc from topology
    const arcIdx = pendingArcIdxRef.current;
    if (arcIdx !== null) {
      arcsRef.current.pop();
      arcPolygonCountRef.current.pop();
      polygonsRef.current.pop();
      ringArcIndicesRef.current.delete(arcIdx);
      pendingArcIdxRef.current = null;
      const m = map;
      (m.getSource(SOURCE_VERTICES) as GeoJSONSource)?.setData(buildVertexFC(arcsRef.current));
      (m.getSource(SOURCE_ARCS)     as GeoJSONSource)?.setData(buildArcFC(arcsRef.current, arcPolygonCountRef.current, ringArcIndicesRef.current));
    }
    setPendingGeometry(null);
  };

  return (
    <>
      <EditorToolbar
        currentYear={currentYear}
        dirtyCount={dirtyCount}
        saving={saving}
        loadState={loadState}
        error={error}
        drawMode={drawMode}
        drawVertexCount={drawVertexCount}
        onToggleDraw={() => setDrawMode((v) => !v)}
        onSave={handleSave}
        onCancel={onClose}
      />
      {pendingGeometry && (
        <NewTerritoryModal
          currentYear={currentYear}
          geometry={pendingGeometry}
          onSave={(id, yearStart, yearEnd) => {
            setPendingGeometry(null);
            pendingArcIdxRef.current = null;
            onTerritoryCreated(id, yearStart, yearEnd);
          }}
          onCancel={handleModalCancel}
        />
      )}
    </>
  );
}
