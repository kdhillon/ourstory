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
 *
 * Edit interactions:
 *  - Drag vertex           → move it (shared borders update all touching polygons)
 *  - Right-click arc edge  → insert new vertex at closest point on that segment
 *  - Right-click vertex    → delete vertex (blocked if arc would become degenerate)
 *  - Click vertex          → select it (highlight red); click again to deselect
 *  - Delete / Backspace    → delete the currently selected vertex
 *  - Ctrl+Z / Cmd+Z        → undo last mutation (insert / delete / drag)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map, GeoJSONSource } from 'maplibre-gl';
import { buildEditorData, buildVertexFC, buildArcFC } from './utils';
import type { PolygonEntry } from './utils';
import { EditorToolbar } from './EditorToolbar';
import { patchTerritoryGeometry } from '../lib/api';
import { NewTerritoryModal } from './NewTerritoryModal';
import { buildMultiPolygon } from './utils';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

// Layer / source constants
const LAYER_ARC_LINES    = 'editor-arc-lines';
const LAYER_ARC_HIT      = 'editor-arc-hit';   // invisible wide line for easier hover/click detection
const LAYER_HOVER_ARC    = 'editor-hover-arc';
const LAYER_VERTICES     = 'editor-vertex-handles';
const LAYER_GHOST_VERTEX = 'editor-ghost-vertex';
const LAYER_SEL_VERTEX   = 'editor-sel-vertex';
const LAYER_DRAW_LINE    = 'editor-draw-line';
const LAYER_DRAW_SNAPS   = 'editor-draw-snaps';

const SOURCE_ARCS        = 'editor-arcs';
const SOURCE_HOVER_ARC   = 'editor-hover-arc-src';
const SOURCE_VERTICES    = 'editor-vertices';
const SOURCE_GHOST       = 'editor-ghost-src';
const SOURCE_SEL         = 'editor-sel-src';
const SOURCE_DRAW_LINE   = 'editor-draw-line-src';
const SOURCE_DRAW_SNAPS  = 'editor-draw-snaps-src';

const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

interface UndoEntry {
  arcs: [number, number][][];
  dirtyIds: Set<string>;
}

/**
 * Find the closest point on an arc to a screen-space click position.
 * Returns the segment index and the geographic insertion point.
 */
function closestSegmentOnArc(
  map: Map,
  clickPt: { x: number; y: number },
  arc: [number, number][],
): { segIdx: number; insertPt: [number, number] } {
  let bestSegIdx = 0;
  let bestDist = Infinity;
  let bestPt: [number, number] = arc[0];

  for (let i = 0; i < arc.length - 1; i++) {
    const pa = map.project(arc[i] as [number, number]);
    const pb = map.project(arc[i + 1] as [number, number]);
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0
      ? Math.max(0, Math.min(1, ((clickPt.x - pa.x) * dx + (clickPt.y - pa.y) * dy) / len2))
      : 0;
    const cx = pa.x + t * dx, cy = pa.y + t * dy;
    const dist = Math.hypot(cx - clickPt.x, cy - clickPt.y);
    if (dist < bestDist) {
      bestDist = dist;
      bestSegIdx = i;
      bestPt = [
        arc[i][0] + t * (arc[i + 1][0] - arc[i][0]),
        arc[i][1] + t * (arc[i + 1][1] - arc[i][1]),
      ];
    }
  }
  return { segIdx: bestSegIdx, insertPt: bestPt };
}

function buildDrawLineFC(
  vertices: [number, number][],
  mousePos?: [number, number],
): GeoJSON.FeatureCollection {
  const pts: [number, number][] = mousePos ? [...vertices, mousePos] : [...vertices];
  if (pts.length < 2) return EMPTY_FC;
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
  const undoStackRef       = useRef<UndoEntry[]>([]);
  const selectedVertexRef  = useRef<{ arcIdx: number; vertexIdx: number } | null>(null);
  const hoveredArcIdxRef   = useRef<number | null>(null);

  // React state — only for toolbar display
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dirtyCount, setDirtyCount] = useState(0);
  const [undoCount, setUndoCount]   = useState(0);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState<string | null>(null);

  // Draw mode
  const [drawMode, setDrawMode]               = useState(false);
  const [drawVertexCount, setDrawVertexCount] = useState(0);
  const [pendingGeometry, setPendingGeometry] = useState<GeoJSON.MultiPolygon | null>(null);
  const pendingArcIdxRef  = useRef<number | null>(null);
  const drawVerticesRef   = useRef<[number, number][]>([]);
  const ringArcIndicesRef = useRef<Set<number>>(new Set());
  const drawModeRef       = useRef(false);
  drawModeRef.current     = drawMode;

  // ── Stable helpers (only use refs — safe to define in component body) ────

  const pushUndo = useCallback(() => {
    undoStackRef.current.push({
      arcs: arcsRef.current.map((arc) => arc.map((pt) => [pt[0], pt[1]] as [number, number])),
      dirtyIds: new Set(dirtyIdsRef.current),
    });
    setUndoCount(undoStackRef.current.length);
  }, []);

  const markArcDirty = useCallback((arcIdx: number) => {
    for (const p of polygonsRef.current) {
      outer: for (const piece of p.arcRefs)
        for (const ring of piece)
          for (const ref of ring)
            if ((ref >= 0 ? ref : ~ref) === arcIdx) {
              dirtyIdsRef.current.add(p.polygonId);
              break outer;
            }
    }
  }, []);

  const refreshSources = useCallback(() => {
    const m = map;
    (m.getSource(SOURCE_VERTICES) as GeoJSONSource)?.setData(buildVertexFC(arcsRef.current));
    (m.getSource(SOURCE_ARCS)     as GeoJSONSource)?.setData(
      buildArcFC(arcsRef.current, arcPolygonCountRef.current, ringArcIndicesRef.current),
    );
  }, [map]);

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
        undoStackRef.current       = [];
        selectedVertexRef.current  = null;
        hoveredArcIdxRef.current   = null;
        setDirtyCount(0);
        setUndoCount(0);
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

  // ── 2. Add MapLibre layers + edit interactions ───────────────────────────
  useEffect(() => {
    if (loadState !== 'ready') return;

    const m = map;

    // Dim existing territory fills; hide borders (editor arc lines replace them)
    m.setPaintProperty('fills-territory', 'fill-opacity', 0.08);
    m.setPaintProperty('borders-territory', 'line-opacity', 0);

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

    // Invisible wide hit-target layer — same source as arcs, wider stroke for easier hover/click
    m.addLayer({
      id: LAYER_ARC_HIT,
      type: 'line',
      source: SOURCE_ARCS,
      paint: { 'line-color': 'transparent', 'line-width': 20 },
    });

    // Hover arc highlight — green line on top of the hovered arc
    m.addSource(SOURCE_HOVER_ARC, { type: 'geojson', data: EMPTY_FC });
    m.addLayer({
      id: LAYER_HOVER_ARC,
      type: 'line',
      source: SOURCE_HOVER_ARC,
      paint: { 'line-color': '#22c55e', 'line-width': 3, 'line-opacity': 0.9 },
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

    // Ghost vertex — preview dot at the closest point on a hovered arc segment
    m.addSource(SOURCE_GHOST, { type: 'geojson', data: EMPTY_FC });
    m.addLayer({
      id: LAYER_GHOST_VERTEX,
      type: 'circle',
      source: SOURCE_GHOST,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 2, 6, 4, 10, 7, 14, 10],
        'circle-color': '#22c55e',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
        'circle-opacity': 0.85,
      },
    });

    // Selected vertex highlight — red ring drawn over the selected vertex handle
    m.addSource(SOURCE_SEL, { type: 'geojson', data: EMPTY_FC });
    m.addLayer({
      id: LAYER_SEL_VERTEX,
      type: 'circle',
      source: SOURCE_SEL,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 4, 6, 6, 10, 11, 14, 15],
        'circle-color': '#ef4444',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-opacity': 0.9,
      },
    });

    // Draw mode layers (populated imperatively when draw mode is active)
    m.addSource(SOURCE_DRAW_LINE,  { type: 'geojson', data: EMPTY_FC });
    m.addSource(SOURCE_DRAW_SNAPS, { type: 'geojson', data: EMPTY_FC });
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

    // ── Drag vertex ────────────────────────────────────────────────────────
    const onVertexEnter = () => { if (!drawModeRef.current) m.getCanvas().style.cursor = 'grab'; };
    const onVertexLeave = () => { if (!drawModeRef.current) m.getCanvas().style.cursor = ''; };

    const onMousedown = (e: maplibregl.MapLayerMouseEvent) => {
      if (drawModeRef.current) return;
      if (!e.features?.length) return;
      if (e.originalEvent.button !== 0) return; // left-click only — right-click is handled by contextmenu
      e.preventDefault();

      const { arcIdx, vertexIdx } = e.features[0].properties as { arcIdx: number; vertexIdx: number };

      pushUndo();
      m.dragPan.disable();
      m.getCanvas().style.cursor = 'grabbing';

      const onMove = (moveE: maplibregl.MapMouseEvent) => {
        const { lng, lat } = moveE.lngLat;
        arcsRef.current[arcIdx][vertexIdx] = [lng, lat];

        // Keep selected vertex indicator in sync during drag
        if (selectedVertexRef.current?.arcIdx === arcIdx &&
            selectedVertexRef.current?.vertexIdx === vertexIdx) {
          (m.getSource(SOURCE_SEL) as GeoJSONSource).setData({
            type: 'FeatureCollection',
            features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }],
          });
        }

        markArcDirty(arcIdx);
        (m.getSource(SOURCE_VERTICES) as GeoJSONSource).setData(buildVertexFC(arcsRef.current));
        (m.getSource(SOURCE_ARCS)     as GeoJSONSource).setData(
          buildArcFC(arcsRef.current, arcPolygonCountRef.current, ringArcIndicesRef.current),
        );
      };

      const onUp = () => {
        m.off('mousemove', onMove);
        m.dragPan.enable();
        m.getCanvas().style.cursor = 'grab';
        setDirtyCount(dirtyIdsRef.current.size);
      };

      m.on('mousemove', onMove);
      m.once('mouseup', onUp);
    };

    // ── Right-click vertex: delete ─────────────────────────────────────────
    const onVertexContextMenu = (e: maplibregl.MapLayerMouseEvent) => {
      if (drawModeRef.current) return;
      e.preventDefault();
      if (!e.features?.length) return;

      const { arcIdx, vertexIdx } = e.features[0].properties as { arcIdx: number; vertexIdx: number };
      const arc = arcsRef.current[arcIdx];
      // Block if deletion would leave fewer than the minimum viable vertices
      const minAfter = ringArcIndicesRef.current.has(arcIdx) ? 3 : 2;
      if (arc.length <= minAfter) return;

      pushUndo();
      arc.splice(vertexIdx, 1);

      if (selectedVertexRef.current?.arcIdx === arcIdx) {
        selectedVertexRef.current = null;
        (m.getSource(SOURCE_SEL) as GeoJSONSource).setData(EMPTY_FC);
      }
      markArcDirty(arcIdx);
      refreshSources();
      setDirtyCount(dirtyIdsRef.current.size);
    };

    // ── Arc hover: highlight + ghost insertion point ───────────────────────
    const onArcMouseMove = (e: maplibregl.MapLayerMouseEvent) => {
      if (drawModeRef.current) return;
      if (!e.features?.length) return;

      // Vertex takes priority — skip arc hover when a vertex is under the cursor
      const vertexHit = m.queryRenderedFeatures(e.point, { layers: [LAYER_VERTICES] });
      if (vertexHit.length > 0) {
        if (hoveredArcIdxRef.current !== null) {
          hoveredArcIdxRef.current = null;
          (m.getSource(SOURCE_HOVER_ARC) as GeoJSONSource).setData(EMPTY_FC);
          (m.getSource(SOURCE_GHOST)     as GeoJSONSource).setData(EMPTY_FC);
        }
        return;
      }

      const { arcIdx } = e.features[0].properties as { arcIdx: number };
      const arc = arcsRef.current[arcIdx];
      m.getCanvas().style.cursor = 'cell';

      // Update hover arc highlight only when arc changes
      if (hoveredArcIdxRef.current !== arcIdx) {
        hoveredArcIdxRef.current = arcIdx;
        const coords = ringArcIndicesRef.current.has(arcIdx) && arc.length > 1
          ? [...arc, arc[0]] : arc;
        (m.getSource(SOURCE_HOVER_ARC) as GeoJSONSource).setData({
          type: 'FeatureCollection',
          features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }],
        });
      }

      // Ghost vertex — closest point on the nearest segment
      const { insertPt } = closestSegmentOnArc(m, e.point, arc);
      (m.getSource(SOURCE_GHOST) as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: insertPt }, properties: {} }],
      });
    };

    const onArcMouseLeave = () => {
      if (drawModeRef.current) return;
      hoveredArcIdxRef.current = null;
      m.getCanvas().style.cursor = '';
      (m.getSource(SOURCE_HOVER_ARC) as GeoJSONSource)?.setData(EMPTY_FC);
      (m.getSource(SOURCE_GHOST)     as GeoJSONSource)?.setData(EMPTY_FC);
    };

    // ── Insert vertex (shared logic for left-click and right-click on arc) ──
    const insertVertexAtEvent = (e: maplibregl.MapLayerMouseEvent) => {
      if (drawModeRef.current) return false;
      if (!e.features?.length) return false;

      // Don't insert when clicking directly on a vertex
      const vertexHit = m.queryRenderedFeatures(e.point, { layers: [LAYER_VERTICES] });
      if (vertexHit.length > 0) return false;

      const { arcIdx } = e.features[0].properties as { arcIdx: number };
      const arc = arcsRef.current[arcIdx];
      const { segIdx, insertPt } = closestSegmentOnArc(m, e.point, arc);

      pushUndo();
      arc.splice(segIdx + 1, 0, insertPt);
      markArcDirty(arcIdx);
      refreshSources();

      // Clear ghost (will reappear on next mousemove)
      (m.getSource(SOURCE_GHOST) as GeoJSONSource).setData(EMPTY_FC);
      setDirtyCount(dirtyIdsRef.current.size);
      return true;
    };

    // ── Left-click arc: insert vertex ──────────────────────────────────────
    const onArcClick = (e: maplibregl.MapLayerMouseEvent) => {
      insertVertexAtEvent(e);
    };

    // ── Right-click arc: insert vertex ─────────────────────────────────────
    const onArcContextMenu = (e: maplibregl.MapLayerMouseEvent) => {
      e.preventDefault();
      insertVertexAtEvent(e);
    };

    // ── Click vertex: select / deselect ────────────────────────────────────
    const onVertexClick = (e: maplibregl.MapLayerMouseEvent) => {
      if (drawModeRef.current) return;
      if (!e.features?.length) return;

      const { arcIdx, vertexIdx } = e.features[0].properties as { arcIdx: number; vertexIdx: number };

      // Toggle off if re-clicking the same vertex
      if (selectedVertexRef.current?.arcIdx === arcIdx &&
          selectedVertexRef.current?.vertexIdx === vertexIdx) {
        selectedVertexRef.current = null;
        (m.getSource(SOURCE_SEL) as GeoJSONSource).setData(EMPTY_FC);
        return;
      }

      const [lng, lat] = arcsRef.current[arcIdx][vertexIdx];
      selectedVertexRef.current = { arcIdx, vertexIdx };
      (m.getSource(SOURCE_SEL) as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }],
      });
    };

    // Suppress browser context menu everywhere on the map while in editor mode
    const onMapContextMenu = (e: maplibregl.MapMouseEvent) => e.preventDefault();

    m.on('mouseenter',  LAYER_VERTICES,  onVertexEnter);
    m.on('mouseleave',  LAYER_VERTICES,  onVertexLeave);
    m.on('mousedown',   LAYER_VERTICES,  onMousedown);
    m.on('contextmenu', LAYER_VERTICES,  onVertexContextMenu);
    m.on('click',       LAYER_VERTICES,  onVertexClick);
    m.on('mousemove',   LAYER_ARC_HIT, onArcMouseMove);
    m.on('mouseleave',  LAYER_ARC_HIT, onArcMouseLeave);
    m.on('click',       LAYER_ARC_HIT, onArcClick);
    m.on('contextmenu', LAYER_ARC_HIT, onArcContextMenu);
    m.on('contextmenu', onMapContextMenu);

    // ── Cleanup ────────────────────────────────────────────────────────────
    return () => {
      m.off('mouseenter',  LAYER_VERTICES,  onVertexEnter);
      m.off('mouseleave',  LAYER_VERTICES,  onVertexLeave);
      m.off('mousedown',   LAYER_VERTICES,  onMousedown);
      m.off('contextmenu', LAYER_VERTICES,  onVertexContextMenu);
      m.off('click',       LAYER_VERTICES,  onVertexClick);
      m.off('mousemove',   LAYER_ARC_HIT, onArcMouseMove);
      m.off('mouseleave',  LAYER_ARC_HIT, onArcMouseLeave);
      m.off('click',       LAYER_ARC_HIT, onArcClick);
      m.off('contextmenu', LAYER_ARC_HIT, onArcContextMenu);
      m.off('contextmenu', onMapContextMenu);

      try {
        if (m.getLayer(LAYER_DRAW_SNAPS))   m.removeLayer(LAYER_DRAW_SNAPS);
        if (m.getLayer(LAYER_DRAW_LINE))    m.removeLayer(LAYER_DRAW_LINE);
        if (m.getLayer(LAYER_SEL_VERTEX))   m.removeLayer(LAYER_SEL_VERTEX);
        if (m.getLayer(LAYER_GHOST_VERTEX)) m.removeLayer(LAYER_GHOST_VERTEX);
        if (m.getLayer(LAYER_VERTICES))     m.removeLayer(LAYER_VERTICES);
        if (m.getLayer(LAYER_HOVER_ARC))    m.removeLayer(LAYER_HOVER_ARC);
        if (m.getLayer(LAYER_ARC_HIT))      m.removeLayer(LAYER_ARC_HIT);
        if (m.getLayer(LAYER_ARC_LINES))    m.removeLayer(LAYER_ARC_LINES);

        if (m.getSource(SOURCE_DRAW_SNAPS)) m.removeSource(SOURCE_DRAW_SNAPS);
        if (m.getSource(SOURCE_DRAW_LINE))  m.removeSource(SOURCE_DRAW_LINE);
        if (m.getSource(SOURCE_SEL))        m.removeSource(SOURCE_SEL);
        if (m.getSource(SOURCE_GHOST))      m.removeSource(SOURCE_GHOST);
        if (m.getSource(SOURCE_VERTICES))   m.removeSource(SOURCE_VERTICES);
        if (m.getSource(SOURCE_HOVER_ARC))  m.removeSource(SOURCE_HOVER_ARC);
        if (m.getSource(SOURCE_ARCS))       m.removeSource(SOURCE_ARCS);
      } catch { /* map may already be destroyed */ }

      try {
        m.setPaintProperty('fills-territory',   'fill-opacity', 0.22);
        m.setPaintProperty('borders-territory', 'line-opacity', 0.6);
      } catch { /* ignore */ }

      m.getCanvas().style.cursor = '';
    };
  }, [loadState, map, markArcDirty, pushUndo, refreshSources]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 3. Draw interaction ───────────────────────────────────────────────────
  useEffect(() => {
    if (loadState !== 'ready') return;
    const m = map;

    if (!drawMode) {
      m.getCanvas().style.cursor = '';
      return;
    }

    m.getCanvas().style.cursor = 'crosshair';

    // Clear hover/selection state when entering draw mode
    selectedVertexRef.current = null;
    hoveredArcIdxRef.current  = null;
    (m.getSource(SOURCE_SEL)       as GeoJSONSource)?.setData(EMPTY_FC);
    (m.getSource(SOURCE_GHOST)     as GeoJSONSource)?.setData(EMPTY_FC);
    (m.getSource(SOURCE_HOVER_ARC) as GeoJSONSource)?.setData(EMPTY_FC);

    const closePolygon = () => {
      const verts = drawVerticesRef.current;
      if (verts.length < 3) return;

      const arcIdx = arcsRef.current.length;
      arcsRef.current.push([...verts]);
      arcPolygonCountRef.current.push(1);
      ringArcIndicesRef.current.add(arcIdx);

      const tempId = `new-${Date.now()}`;
      polygonsRef.current.push({ polygonId: tempId, arcRefs: [[[arcIdx]]] });

      const geometry = buildMultiPolygon([[[arcIdx]]], arcsRef.current);
      pendingArcIdxRef.current = arcIdx;
      setPendingGeometry(geometry);

      drawVerticesRef.current = [];
      setDrawVertexCount(0);
      setDrawMode(false);

      (m.getSource(SOURCE_VERTICES)  as GeoJSONSource).setData(buildVertexFC(arcsRef.current));
      (m.getSource(SOURCE_ARCS)      as GeoJSONSource).setData(
        buildArcFC(arcsRef.current, arcPolygonCountRef.current, ringArcIndicesRef.current),
      );
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

  // ── 4. Keyboard shortcuts for edit mode: undo + delete selected vertex ───
  useEffect(() => {
    if (loadState !== 'ready') return;
    const m = map;

    const onKeyDown = (e: KeyboardEvent) => {
      if (drawModeRef.current) return; // draw mode has its own keydown handler

      // Undo (Ctrl+Z / Cmd+Z)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        const prev = undoStackRef.current.pop();
        if (!prev) return;
        arcsRef.current     = prev.arcs;
        dirtyIdsRef.current = prev.dirtyIds;
        selectedVertexRef.current = null;
        hoveredArcIdxRef.current  = null;
        (m.getSource(SOURCE_SEL)       as GeoJSONSource)?.setData(EMPTY_FC);
        (m.getSource(SOURCE_GHOST)     as GeoJSONSource)?.setData(EMPTY_FC);
        (m.getSource(SOURCE_HOVER_ARC) as GeoJSONSource)?.setData(EMPTY_FC);
        (m.getSource(SOURCE_VERTICES)  as GeoJSONSource)?.setData(buildVertexFC(arcsRef.current));
        (m.getSource(SOURCE_ARCS)      as GeoJSONSource)?.setData(
          buildArcFC(arcsRef.current, arcPolygonCountRef.current, ringArcIndicesRef.current),
        );
        setDirtyCount(dirtyIdsRef.current.size);
        setUndoCount(undoStackRef.current.length);
        return;
      }

      // Delete / Backspace — delete selected vertex
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const sel = selectedVertexRef.current;
        if (!sel) return;
        const { arcIdx, vertexIdx } = sel;
        const arc = arcsRef.current[arcIdx];
        const minAfter = ringArcIndicesRef.current.has(arcIdx) ? 3 : 2;
        if (arc.length <= minAfter) return;

        pushUndo();
        arc.splice(vertexIdx, 1);
        selectedVertexRef.current = null;
        (m.getSource(SOURCE_SEL)      as GeoJSONSource)?.setData(EMPTY_FC);
        markArcDirty(arcIdx);
        (m.getSource(SOURCE_VERTICES) as GeoJSONSource)?.setData(buildVertexFC(arcsRef.current));
        (m.getSource(SOURCE_ARCS)     as GeoJSONSource)?.setData(
          buildArcFC(arcsRef.current, arcPolygonCountRef.current, ringArcIndicesRef.current),
        );
        setDirtyCount(dirtyIdsRef.current.size);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loadState, map, markArcDirty, pushUndo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 5. Save ──────────────────────────────────────────────────────────────
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
    const arcIdx = pendingArcIdxRef.current;
    if (arcIdx !== null) {
      arcsRef.current.pop();
      arcPolygonCountRef.current.pop();
      polygonsRef.current.pop();
      ringArcIndicesRef.current.delete(arcIdx);
      pendingArcIdxRef.current = null;
      const m = map;
      (m.getSource(SOURCE_VERTICES) as GeoJSONSource)?.setData(buildVertexFC(arcsRef.current));
      (m.getSource(SOURCE_ARCS)     as GeoJSONSource)?.setData(
        buildArcFC(arcsRef.current, arcPolygonCountRef.current, ringArcIndicesRef.current),
      );
    }
    setPendingGeometry(null);
  };

  return (
    <>
      <EditorToolbar
        currentYear={currentYear}
        dirtyCount={dirtyCount}
        undoCount={undoCount}
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
