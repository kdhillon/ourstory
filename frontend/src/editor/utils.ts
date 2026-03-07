/**
 * Territory Editor — topology utilities
 *
 * Isolated module. Delete the entire `editor/` folder to remove this feature.
 */
import { topology as buildTopology } from 'topojson-server';
import type { Topology } from 'topojson-specification';

export interface PolygonEntry {
  polygonId: string;
  arcRefs: number[][][]; // [piece][ring] → array of arc indices (negative = reversed ~i)
}

export interface EditorData {
  arcs: [number, number][][];   // decoded geographic [lng, lat] coords — mutable during editing
  polygons: PolygonEntry[];
  arcPolygonCount: number[];    // arcPolygonCount[i] = how many polygons reference arc i
}

/** Convert a GeoJSON FeatureCollection (territories) into the editor's topology representation. */
export function buildEditorData(fc: GeoJSON.FeatureCollection): EditorData | null {
  const validFeatures = fc.features.filter(
    (f) => f.geometry != null && f.geometry.type === 'MultiPolygon',
  );
  if (validFeatures.length === 0) return null;

  const validFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: validFeatures };
  const topo = buildTopology({ t: validFC }) as Topology;
  const arcs = decodeArcs(topo);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const geomColl = topo.objects['t'] as any;
  const polygons: PolygonEntry[] = [];

  for (const geom of geomColl?.geometries ?? []) {
    const polygonId = geom.properties?.polygonId as string | undefined;
    if (!polygonId || geom.type !== 'MultiPolygon') continue;
    polygons.push({ polygonId, arcRefs: geom.arcs as number[][][] });
  }

  const arcPolygonCount = new Array<number>(arcs.length).fill(0);
  for (const p of polygons) {
    const seen = new Set<number>();
    for (const piece of p.arcRefs)
      for (const ring of piece)
        for (const ref of ring) {
          const idx = ref >= 0 ? ref : ~ref;
          if (!seen.has(idx)) { arcPolygonCount[idx]++; seen.add(idx); }
        }
  }

  return { arcs, polygons, arcPolygonCount };
}

/** Decode quantized delta-encoded topojson arcs to geographic coordinates. */
function decodeArcs(topo: Topology): [number, number][][] {
  if (!topo.transform) {
    return topo.arcs.map((arc) => arc.map((p) => [p[0], p[1]] as [number, number]));
  }
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  return topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map((p) => {
      x += p[0]; y += p[1];
      return [x * sx + tx, y * sy + ty] as [number, number];
    });
  });
}

/** Reconstruct a GeoJSON ring from arc references + current arc coordinates. */
function buildRing(refs: number[], arcs: [number, number][][]): number[][] {
  const coords: number[][] = [];
  for (const ref of refs) {
    const arc = ref >= 0 ? arcs[ref] : [...arcs[~ref]].reverse();
    coords.push(...(coords.length === 0 ? arc : arc.slice(1)));
  }
  // Close ring
  if (coords.length > 1) {
    const [fx, fy] = coords[0], [lx, ly] = coords[coords.length - 1];
    if (fx !== lx || fy !== ly) coords.push([fx, fy]);
  }
  return coords;
}

/** Reconstruct a GeoJSON MultiPolygon from arc refs + current arc coordinates. */
export function buildMultiPolygon(arcRefs: number[][][], arcs: [number, number][][]): GeoJSON.MultiPolygon {
  return {
    type: 'MultiPolygon',
    coordinates: arcRefs.map((piece) => piece.map((ring) => buildRing(ring, arcs))),
  };
}

/** Build a GeoJSON FeatureCollection of Points for all arc vertices (for the vertex handles layer). */
export function buildVertexFC(arcs: [number, number][][]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  arcs.forEach((arc, arcIdx) => {
    arc.forEach(([lng, lat], vertexIdx) => {
      features.push({
        type: 'Feature',
        id: arcIdx * 1e5 + vertexIdx,
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: { arcIdx, vertexIdx },
      });
    });
  });
  return { type: 'FeatureCollection', features };
}

/** Build a GeoJSON FeatureCollection of LineStrings for all arcs. Shared arcs flagged.
 *  ringArcIndices: arc indices that are sole rings (drawn polygons) — closed for display. */
export function buildArcFC(
  arcs: [number, number][][],
  arcPolygonCount: number[],
  ringArcIndices?: Set<number>,
): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: arcs.map((arc, arcIdx) => {
      const coords = ringArcIndices?.has(arcIdx) && arc.length > 1
        ? [...arc, arc[0]]   // close the ring for display only
        : arc;
      return {
        type: 'Feature' as const,
        geometry: { type: 'LineString' as const, coordinates: coords },
        properties: { arcIdx, shared: arcPolygonCount[arcIdx] > 1 },
      };
    }),
  };
}
