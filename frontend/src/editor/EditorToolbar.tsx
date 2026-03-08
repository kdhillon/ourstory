/**
 * Territory Editor — floating toolbar
 * Isolated module. Delete the entire `editor/` folder to remove this feature.
 */
interface Props {
  currentYear: number;
  dirtyCount: number;
  undoCount: number;
  saving: boolean;
  loadState: 'loading' | 'ready' | 'error';
  error: string | null;
  drawMode: boolean;
  drawVertexCount: number;
  onToggleDraw: () => void;
  onSave: () => void;
  onCancel: () => void;
}

export function EditorToolbar({ currentYear, dirtyCount, undoCount, saving, loadState, error, drawMode, drawVertexCount, onToggleDraw, onSave, onCancel }: Props) {
  return (
    <div style={{
      position: 'fixed',
      top: 10,
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#0f172a',
      color: '#f1f5f9',
      borderRadius: 10,
      padding: '8px 14px',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      zIndex: 300,
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: 13,
      userSelect: 'none',
      whiteSpace: 'nowrap',
    }}>
      <span style={{ fontWeight: 700, color: '#60a5fa', letterSpacing: '-0.01em' }}>
        ✎ Territory Editor
      </span>

      <span style={{ color: '#475569', margin: '0 2px' }}>|</span>

      <span style={{ color: '#94a3b8' }}>
        Year <strong style={{ color: '#f1f5f9' }}>{currentYear}</strong>
      </span>

      {loadState === 'loading' && (
        <span style={{ color: '#94a3b8', fontSize: 12 }}>Building topology…</span>
      )}

      {loadState === 'ready' && dirtyCount > 0 && (
        <span style={{
          background: '#f59e0b',
          color: '#000',
          borderRadius: 20,
          padding: '1px 8px',
          fontSize: 11,
          fontWeight: 700,
        }}>
          {dirtyCount} change{dirtyCount !== 1 ? 's' : ''}
        </span>
      )}

      {loadState === 'ready' && dirtyCount === 0 && !drawMode && (
        <span style={{ color: '#475569', fontSize: 12 }}>
          Drag · Right-click edge to add · Right-click vertex to delete · Click vertex to select
        </span>
      )}

      {loadState === 'ready' && undoCount > 0 && !drawMode && (
        <span
          title={`${undoCount} action${undoCount !== 1 ? 's' : ''} in undo history`}
          style={{ color: '#334155', fontSize: 11, cursor: 'default' }}
        >
          ↩ {undoCount}
        </span>
      )}

      {loadState === 'ready' && drawMode && (
        <span style={{ color: '#f59e0b', fontSize: 12 }}>
          {drawVertexCount === 0
            ? 'Click to place vertices'
            : drawVertexCount < 3
            ? `${drawVertexCount} vertices — keep clicking`
            : `${drawVertexCount} vertices — Enter or click ● to close`}
        </span>
      )}

      {loadState === 'ready' && !drawMode && (
        <button
          onClick={onToggleDraw}
          disabled={saving}
          title="Draw a new polygon"
          style={{
            background: 'transparent',
            color: '#94a3b8',
            border: '1px solid #1e293b',
            borderRadius: 6,
            padding: '4px 9px',
            cursor: saving ? 'default' : 'pointer',
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 700,
            lineHeight: 1,
          }}
        >
          +
        </button>
      )}

      {(error) && (
        <span style={{ color: '#f87171', fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {error}
        </span>
      )}

      <button
        onClick={onSave}
        disabled={saving || dirtyCount === 0 || loadState !== 'ready'}
        style={{
          background: dirtyCount > 0 && !saving ? '#3b82f6' : '#1e3a5f',
          color: dirtyCount > 0 && !saving ? '#fff' : '#475569',
          border: 'none',
          borderRadius: 6,
          padding: '5px 13px',
          cursor: dirtyCount > 0 && !saving ? 'pointer' : 'default',
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 600,
          transition: 'background 0.15s',
        }}
      >
        {saving ? 'Saving…' : 'Save'}
      </button>

      <button
        onClick={onCancel}
        disabled={saving}
        style={{
          background: 'transparent',
          color: '#94a3b8',
          border: '1px solid #1e293b',
          borderRadius: 6,
          padding: '5px 11px',
          cursor: saving ? 'default' : 'pointer',
          fontFamily: 'inherit',
          fontSize: 12,
        }}
      >
        Cancel
      </button>
    </div>
  );
}
