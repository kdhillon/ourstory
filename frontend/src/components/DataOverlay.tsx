/**
 * DataOverlay — persistent top-left map overlay showing loaded data stats:
 * events (windowed), locations, polities (static), and territory snapshot.
 *
 * Each row label is clickable (opens About page) and shows a definition tooltip on hover.
 */

import { useState, useCallback } from 'react';
import type React from 'react';
import type { WindowInfo } from '../hooks/useEventSource';

export interface DataOverlayProps {
  windowInfo: WindowInfo | null;
  isLoading: boolean;
  error: string | null;
  territoriesLoading: boolean;
  territoriesError: string | null;
  seedLoading: boolean;
  locationCount: number;
  polityCount: number;
  onOpenAbout: () => void;
}

const DEFINITIONS: Record<string, string> = {
  events: 'Battles, elections, treaties, disasters, discoveries, and more — each with a date and location.',
  locations: 'Cities, regions, and countries referenced by events.',
  polities: 'Kingdoms, empires, republics, tribes, nations, indigenous peoples, colonies, and other political entities.',
  territories: 'Shaded boundary polygons linked to polities, covering their active date ranges.',
};

function Spinner() {
  return (
    <>
      <style>{`@keyframes oh-spin { to { transform: rotate(360deg); } }`}</style>
      <svg
        width="10" height="10" viewBox="0 0 10 10"
        style={{ animation: 'oh-spin 0.75s linear infinite', flexShrink: 0 }}
      >
        <circle cx="5" cy="5" r="3.5" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="1.5" />
        <path d="M5 1.5 A3.5 3.5 0 0 1 8.5 5" fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </>
  );
}

function RowLabel({ name, onOpenAbout }: { name: string; onOpenAbout: () => void }) {
  const [hovered, setHovered] = useState(false);
  const def = DEFINITIONS[name];

  return (
    <div style={{ position: 'relative', minWidth: 60 }}>
      <button
        onClick={onOpenAbout}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          color: hovered ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.5)',
          fontSize: 11,
          cursor: 'pointer',
          fontFamily: 'inherit',
          textDecoration: hovered ? 'underline' : 'none',
          textUnderlineOffset: 2,
        }}
      >
        {name}
      </button>

      {hovered && def && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            width: 200,
            background: 'rgba(20,20,20,0.95)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6,
            padding: '7px 10px',
            fontSize: 11,
            color: 'rgba(255,255,255,0.8)',
            lineHeight: 1.5,
            zIndex: 100,
            pointerEvents: 'none',
          }}
        >
          {def}
        </div>
      )}
    </div>
  );
}

const badge: React.CSSProperties = {
  marginLeft: 'auto',
  background: 'rgba(255,255,255,0.12)',
  borderRadius: 4,
  padding: '1px 5px',
  fontSize: 11,
  color: 'rgba(255,255,255,0.7)',
};
const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };

export function DataOverlay({
  windowInfo, isLoading, error,
  territoriesLoading, territoriesError,
  seedLoading, locationCount, polityCount,
  onOpenAbout,
}: DataOverlayProps) {
  const [collapsed, setCollapsed] = useState(false);
  const toggle = useCallback(() => setCollapsed((v) => !v), []);

  return (
    <div
      onClick={collapsed ? toggle : undefined}
      style={{
        position: 'absolute',
        top: 10,
        left: 10,
        zIndex: 10,
        background: 'rgba(30,30,30,0.72)',
        backdropFilter: 'blur(6px)',
        borderRadius: 8,
        padding: collapsed ? '5px 10px' : '8px 12px',
        fontSize: 12,
        color: 'rgba(255,255,255,0.9)',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        minWidth: collapsed ? 0 : 170,
        pointerEvents: 'auto',
        userSelect: 'none',
        cursor: collapsed ? 'pointer' : 'default',
      }}
    >
      {/* Collapse toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {!collapsed && (
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)' }}>
            Data
          </span>
        )}
        <button
          onClick={toggle}
          title={collapsed ? 'Show data stats' : 'Hide data stats'}
          style={{
            marginLeft: collapsed ? 0 : 'auto',
            background: 'none',
            border: 'none',
            padding: 0,
            color: 'rgba(255,255,255,0.4)',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            fontFamily: 'inherit',
          }}
        >
          {collapsed ? '▸' : '▾'}
        </button>
      </div>
      {/* Rows — hidden when collapsed */}
      {!collapsed && (
        <>
          {/* Events row */}
          <div style={row}>
            <RowLabel name="events" onOpenAbout={onOpenAbout} />
            {isLoading ? (
              <Spinner />
            ) : windowInfo ? (
              <>
                <span style={{ fontSize: 11 }}>{windowInfo.yearMin} – {windowInfo.yearMax}</span>
                <span style={badge}>{windowInfo.count.toLocaleString()}</span>
              </>
            ) : (
              <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11 }}>none</span>
            )}
          </div>

          {/* Locations row */}
          <div style={row}>
            <RowLabel name="locations" onOpenAbout={onOpenAbout} />
            {seedLoading ? <Spinner /> : <span style={badge}>{locationCount.toLocaleString()}</span>}
          </div>

          {/* Polities row */}
          <div style={row}>
            <RowLabel name="polities" onOpenAbout={onOpenAbout} />
            {seedLoading ? <Spinner /> : <span style={badge}>{polityCount.toLocaleString()}</span>}
          </div>

          {/* Territories row */}
          <div style={row}>
            <RowLabel name="territories" onOpenAbout={onOpenAbout} />
            {territoriesLoading ? (
              <Spinner />
            ) : (
              <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: 11, marginLeft: 'auto' }}>active</span>
            )}
          </div>

          {/* Error rows */}
          {error && <div style={{ fontSize: 11, color: '#ff8080' }}>⚠ events: {error}</div>}
          {territoriesError && <div style={{ fontSize: 11, color: '#ff8080' }}>⚠ territories: {territoriesError}</div>}
        </>
      )}
    </div>
  );
}
