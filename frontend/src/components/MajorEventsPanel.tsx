import { useMemo, useCallback, useState } from 'react';
import { useTranslations } from '../lib/TranslationContext';
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

export type BBox = [number, number, number, number]; // [west, south, east, north]

interface Props {
  geojson: GeoJSON.FeatureCollection;
  currentDateInt: number;
  stepSize: number;
  onNavigateToFeature: (feature: FeatureProperties) => void;
  selectedQid: string | null;
  onSelectQid: (qid: string | null) => void;
  onFitBounds?: (bbox: BBox) => void;
}

export function MajorEventsPanel({ geojson, currentDateInt, stepSize, selectedQid, onSelectQid, onFitBounds }: Props) {
  const [collapsed, setCollapsed] = useState(false);

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
          counts.set(parent.qid, { qid: parent.qid, title: parent.title, slug: parent.slug ?? null, count: 1 });
        }
      }
    }

    return [...counts.values()].sort((a, b) => b.count - a.count);
  }, [geojson, currentDateInt, stepSize]);

  const handleClick = useCallback((ev: MajorEvent) => {
    if (ev.qid === selectedQid) {
      onSelectQid(null);
      return;
    }
    onSelectQid(ev.qid);

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

  if (majorEvents.length === 0) return null;

  return (
    <div style={{
      background: '#ffffff',
      borderRadius: 12,
      border: '1px solid rgba(0,0,0,0.1)',
      boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
      color: '#202122',
      maxWidth: 240,
      minWidth: collapsed ? 0 : 200,
      pointerEvents: 'auto',
    }}>
      {/* Header */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', cursor: 'pointer' }}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: '#54595d', flex: 1 }}>
          {collapsed ? `Major Events (${majorEvents.length})` : 'Major Events'}
        </span>
        <span style={{ fontSize: 18, color: '#9a9a9a', lineHeight: 1 }}>
          {collapsed ? '▴' : '▾'}
        </span>
      </div>

      {/* Body */}
      {!collapsed && (
        <div style={{
          maxHeight: 280,
          overflowY: 'auto',
          padding: '0 6px 8px',
          borderTop: '1px solid rgba(0,0,0,0.06)',
        }}>
          {majorEvents.map((ev) => (
            <EventRow key={ev.qid} ev={ev} selected={ev.qid === selectedQid} onClick={handleClick} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({ ev, selected, onClick }: { ev: MajorEvent; selected: boolean; onClick: (ev: MajorEvent) => void }) {
  const translationMap = useTranslations();
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={() => onClick(ev)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        width: '100%',
        background: selected ? 'rgba(51,102,204,0.08)' : hovered ? 'rgba(0,0,0,0.04)' : 'transparent',
        border: 'none',
        borderRadius: 4,
        padding: '5px 8px',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
      }}
    >
      <span style={{ fontSize: 13, color: selected ? '#3366cc' : '#202122', lineHeight: 1.4, flex: 1, fontWeight: selected ? 600 : 400 }}>
        {translationMap?.[ev.qid] ?? ev.title}
      </span>
      <span style={{
        fontSize: 11,
        fontWeight: 600,
        color: selected ? '#3366cc' : 'rgba(0,0,0,0.35)',
        minWidth: 14,
        textAlign: 'right',
        flexShrink: 0,
      }}>
        {ev.count}
      </span>
    </button>
  );
}
