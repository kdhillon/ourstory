/**
 * Territory Editor — new polygon year-range modal
 * Shown immediately after the user closes a drawn polygon.
 * Isolated module — delete the entire `editor/` folder to remove this feature.
 */
import { useState } from 'react';
import { createTerritory } from '../lib/api';

interface Props {
  currentYear: number;
  geometry: GeoJSON.MultiPolygon;
  onSave: (id: string, yearStart: number, yearEnd: number | null) => void;
  onCancel: () => void;
}

export function NewTerritoryModal({ currentYear, geometry, onSave, onCancel }: Props) {
  const [yearStart, setYearStart] = useState(String(currentYear));
  const [yearEnd, setYearEnd]     = useState('');
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const handleSave = async () => {
    const ys = parseInt(yearStart, 10);
    if (isNaN(ys)) { setError('Start year is required'); return; }
    const ye = yearEnd.trim() ? parseInt(yearEnd, 10) : null;
    if (ye !== null && isNaN(ye)) { setError('Invalid end year'); return; }
    if (ye !== null && ye < ys)   { setError('End year must be ≥ start year'); return; }

    setSaving(true);
    setError(null);
    try {
      const id = await createTerritory(geometry, ys, ye);
      onSave(id, ys, ye);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') onCancel();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 400,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.55)',
    }}>
      <div style={{
        background: '#0f172a',
        color: '#f1f5f9',
        borderRadius: 12,
        padding: '24px 28px',
        width: 320,
        boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <p style={{ margin: '0 0 16px', fontSize: 14, fontWeight: 700 }}>Save Territory</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13 }}>
            <span style={{ color: '#94a3b8' }}>
              Start year <span style={{ color: '#f87171' }}>*</span>
            </span>
            <input
              type="number"
              value={yearStart}
              onChange={e => setYearStart(e.target.value)}
              onKeyDown={onKey}
              placeholder="e.g. 1800"
              autoFocus
              style={inputStyle}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13 }}>
            <span style={{ color: '#94a3b8' }}>
              End year{' '}
              <span style={{ color: '#475569', fontStyle: 'italic', fontWeight: 400 }}>
                (blank = open-ended)
              </span>
            </span>
            <input
              type="number"
              value={yearEnd}
              onChange={e => setYearEnd(e.target.value)}
              onKeyDown={onKey}
              placeholder="e.g. 1830"
              style={inputStyle}
            />
          </label>
        </div>

        {error && (
          <p style={{ margin: '10px 0 0', fontSize: 12, color: '#f87171' }}>{error}</p>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} disabled={saving} style={cancelStyle}>
            Discard
          </button>
          <button onClick={handleSave} disabled={saving} style={saveStyle}>
            {saving ? 'Saving…' : 'Save & Assign →'}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: '#1e293b',
  color: '#f1f5f9',
  border: '1px solid #334155',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 13,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
};

const saveStyle: React.CSSProperties = {
  background: '#3b82f6',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '7px 16px',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'inherit',
};

const cancelStyle: React.CSSProperties = {
  background: 'transparent',
  color: '#94a3b8',
  border: '1px solid #1e293b',
  borderRadius: 6,
  padding: '7px 14px',
  cursor: 'pointer',
  fontSize: 13,
  fontFamily: 'inherit',
};
