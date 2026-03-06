import { useMemo, useCallback, useEffect } from 'react';
import type { FeatureProperties } from '../types';
import { eventDateRange, STEP_YEAR } from '../hooks/useTimeline';

const LINGER_STEPS = 5;
const LINGER_MAX = 3 * STEP_YEAR;

interface MajorEvent {
  qid: string;
  title: string;
  slug: string | null;
  count: number;
}

const PANEL_HEIGHT = 44;

export type BBox = [number, number, number, number]; // [west, south, east, north]

interface Props {
  geojson: GeoJSON.FeatureCollection;
  currentDateInt: number;
  stepSize: number;
  onNavigateToFeature: (feature: FeatureProperties) => void;
  selectedQid: string | null;
  onSelectQid: (qid: string | null) => void;
  onFitBounds?: (bbox: BBox) => void;
  onHasEvents?: (has: boolean) => void;
}

export { PANEL_HEIGHT as MAJOR_EVENTS_PANEL_HEIGHT };

export function MajorEventsPanel({ geojson, currentDateInt, stepSize, onNavigateToFeature, selectedQid, onSelectQid, onFitBounds, onHasEvents }: Props) {
  const majorEvents = useMemo<MajorEvent[]>(() => {
    const counts = new Map<string, MajorEvent>();
    const effectiveNow = currentDateInt + stepSize - 1;

    for (const feature of geojson.features) {
      const p = feature.properties as FeatureProperties;
      if (p.featureType !== 'event' || p.yearStart == null) continue;

      const [startInt, endInt] = eventDateRange(
        p.yearStart, p.monthStart, p.dayStart,
        p.yearEnd,   p.monthEnd,   p.dayEnd,
      );
      if (!(startInt <= effectiveNow && currentDateInt <= endInt + Math.min(LINGER_STEPS * stepSize, LINGER_MAX))) continue;

      for (const parent of (p.partOfResolved ?? [])) {
        if (!parent.qid || !parent.title) continue;
        const ex = counts.get(parent.qid);
        if (ex) {
          ex.count++;
        } else {
          counts.set(parent.qid, {
            qid: parent.qid,
            title: parent.title,
            slug: parent.slug ?? null,
            count: 1,
          });
        }
      }
    }

    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [geojson, currentDateInt, stepSize]);

  const handleClick = useCallback((ev: MajorEvent) => {
    // Toggle: clicking the active filter deselects it
    if (ev.qid === selectedQid) {
      onSelectQid(null);
      return;
    }
    onSelectQid(ev.qid);

    // Compute bbox of all currently active events belonging to this major event
    if (!onFitBounds) return;
    const effectiveNow = currentDateInt + stepSize - 1;
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    let hasCoords = false;
    for (const f of geojson.features) {
      const p = f.properties as FeatureProperties;
      if (p.featureType !== 'event' || p.yearStart == null) continue;
      if (!f.geometry || f.geometry.type !== 'Point') continue;
      if (!(p.partOf ?? []).includes(ev.qid)) continue;
      const [startInt, endInt] = eventDateRange(
        p.yearStart, p.monthStart, p.dayStart,
        p.yearEnd,   p.monthEnd,   p.dayEnd,
      );
      if (!(startInt <= effectiveNow && currentDateInt <= endInt + Math.min(LINGER_STEPS * stepSize, LINGER_MAX))) continue;
      const [lon, lat] = (f.geometry as GeoJSON.Point).coordinates;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      hasCoords = true;
    }
    if (hasCoords) onFitBounds([minLon, minLat, maxLon, maxLat]);
  }, [selectedQid, onSelectQid, onFitBounds, geojson, currentDateInt, stepSize]);

  useEffect(() => {
    onHasEvents?.(majorEvents.length > 0);
  }, [majorEvents.length > 0, onHasEvents]); // eslint-disable-line react-hooks/exhaustive-deps

  if (majorEvents.length === 0) return null;

  return (
    <div style={{
      position: 'fixed',
      bottom: 64,
      left: 0,
      right: 0,
      height: 44,
      background: 'rgba(12, 17, 23, 0.88)',
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
      display: 'flex',
      alignItems: 'stretch',
      zIndex: 95,
      borderTop: '1px solid rgba(255,255,255,0.07)',
    }}>
      {/* Fixed label — does not scroll */}
      <div style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px 0 16px',
        color: 'rgba(255,255,255,0.35)',
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        borderRight: '1px solid rgba(255,255,255,0.09)',
        whiteSpace: 'nowrap',
      }}>
        Major Events
      </div>

      {/* Scrollable chips */}
      <div
        className="no-scrollbar"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          overflowX: 'auto',
          padding: '0 14px',
          flex: 1,
        }}
      >
        {majorEvents.map((ev) => (
          <Chip key={ev.qid} ev={ev} selected={ev.qid === selectedQid} onClick={handleClick} />
        ))}
      </div>
    </div>
  );
}

function Chip({ ev, selected, onClick }: { ev: MajorEvent; selected: boolean; onClick: (ev: MajorEvent) => void }) {
  const bg       = selected ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.06)';
  const border   = selected ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.11)';
  const color    = selected ? '#0c1117'                : 'rgba(255,255,255,0.85)';
  const cntColor = selected ? 'rgba(0,0,0,0.4)'       : 'rgba(255,255,255,0.38)';
  return (
    <button
      onClick={() => onClick(ev)}
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 999,
        color,
        fontSize: 12.5,
        lineHeight: 1,
        padding: '4px 11px 4px 11px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontWeight: selected ? 600 : 400,
        transition: 'background 0.12s, border-color 0.12s, color 0.12s',
      }}
      onMouseEnter={(e) => {
        if (selected) return;
        e.currentTarget.style.background = 'rgba(255,255,255,0.13)';
        e.currentTarget.style.borderColor = 'rgba(255,255,255,0.22)';
      }}
      onMouseLeave={(e) => {
        if (selected) return;
        e.currentTarget.style.background = bg;
        e.currentTarget.style.borderColor = border;
      }}
    >
      {ev.title}
      <span style={{
        fontSize: 11,
        fontWeight: 600,
        color: cntColor,
        minWidth: 14,
        textAlign: 'right',
      }}>
        {ev.count}
      </span>
    </button>
  );
}
