/**
 * SettingsPanel — gear button + status popover showing the current API window.
 */

import { useState, useRef } from 'react';
import type React from 'react';
import type { WindowInfo } from '../hooks/useEventSource';

export interface SettingsPanelProps {
  windowInfo: WindowInfo | null;
  isLoading: boolean;
  error: string | null;
  snapshotYear: number | null;
  prevSnapshotYear: number | null;
  nextSnapshotYear: number | null;
  onSeekToSnapshot: (year: number) => void;
}

const arrowBtn: React.CSSProperties = {
  background: 'none', border: 'none', padding: '0 3px',
  fontSize: 15, color: '#444', cursor: 'pointer', lineHeight: 1, fontFamily: 'inherit',
};

const yearBtn: React.CSSProperties = {
  background: '#f0f0f0', border: 'none', borderRadius: 4,
  padding: '1px 6px', fontSize: 11, color: '#444', cursor: 'pointer', fontFamily: 'inherit',
};

export function SettingsPanel({ windowInfo, isLoading, error, snapshotYear, prevSnapshotYear, nextSnapshotYear, onSeekToSnapshot }: SettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="API status"
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: error ? '#c00' : '#202122',
          background: open ? 'rgba(0,0,0,0.06)' : 'transparent',
          border: '1px solid rgba(0,0,0,0.18)',
          borderRadius: 6,
          padding: '3px 10px',
          cursor: 'pointer',
          fontFamily: 'inherit',
          flexShrink: 0,
          lineHeight: 1,
        }}
      >
        ⚙
      </button>

      {open && (
        <div
          style={{
            position: 'fixed',
            top: 54,
            right: 10,
            width: 220,
            background: 'white',
            borderRadius: 8,
            boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
            border: '1px solid rgba(0,0,0,0.1)',
            padding: '12px 14px',
            fontSize: 13,
            zIndex: 1000,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8, color: '#444' }}>API status</div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {isLoading ? (
              <span style={{ color: '#888', fontSize: 12 }}>Loading…</span>
            ) : windowInfo ? (
              <>
                <span style={{ color: '#555', fontSize: 12 }}>
                  {windowInfo.yearMin} – {windowInfo.yearMax}
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    background: '#f0f0f0',
                    borderRadius: 4,
                    padding: '1px 6px',
                    fontSize: 11,
                    color: '#666',
                  }}
                >
                  {windowInfo.count.toLocaleString()} events
                </span>
              </>
            ) : (
              <span style={{ color: '#aaa', fontSize: 12 }}>No data loaded</span>
            )}
          </div>

          {snapshotYear !== null && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 }}>
              <span style={{ color: '#555', fontSize: 12 }}>Territory snapshot</span>
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 2 }}>
                <button
                  onClick={() => prevSnapshotYear != null && onSeekToSnapshot(prevSnapshotYear)}
                  disabled={prevSnapshotYear == null}
                  title={prevSnapshotYear != null ? `Go to ${prevSnapshotYear}` : undefined}
                  style={{ ...arrowBtn, opacity: prevSnapshotYear == null ? 0.3 : 1 }}
                >
                  ‹
                </button>
                <button
                  onClick={() => onSeekToSnapshot(snapshotYear)}
                  style={yearBtn}
                >
                  {snapshotYear}
                </button>
                <button
                  onClick={() => nextSnapshotYear != null && onSeekToSnapshot(nextSnapshotYear)}
                  disabled={nextSnapshotYear == null}
                  title={nextSnapshotYear != null ? `Go to ${nextSnapshotYear}` : undefined}
                  style={{ ...arrowBtn, opacity: nextSnapshotYear == null ? 0.3 : 1 }}
                >
                  ›
                </button>
              </div>
            </div>
          )}

          {error && (
            <div
              style={{
                marginTop: 8,
                padding: '4px 8px',
                background: '#fff0f0',
                border: '1px solid #fcc',
                borderRadius: 5,
                color: '#c00',
                fontSize: 11,
              }}
            >
              ⚠ {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
