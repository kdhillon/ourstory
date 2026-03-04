import { useState, useRef, useCallback } from 'react';
import { YEAR_MIN, YEAR_MAX } from '../types';
import {
  displayDate, encodeDate, normalizeDateInt,
  DATE_MIN, DATE_MAX, STEP_DAY, STEP_MONTH, STEP_YEAR,
} from '../hooks/useTimeline';

interface Props {
  currentDateInt: number;
  stepSize: number;
  stepOptions: number[];
  isPlaying: boolean;
  playbackSpeed: number;
  onSeek: (dateInt: number) => void;
  onStep: (dir: 1 | -1) => void;
  onTogglePlay: () => void;
  onSetStepSize: (s: number) => void;
  onSetSpeed: (s: number) => void;
}

/** Parse user-typed date strings → dateInt.
 *  Accepts: "600 BCE", "600 BC", "-600", "1789", "1789 CE" */
function parseYearInput(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  let numeric: string;
  let negative = false;
  if (lower.endsWith('bce') || lower.endsWith('bc')) {
    numeric = s.replace(/bce?$/i, '').trim();
    negative = true;
  } else {
    numeric = s.replace(/\s*(ce|ad)$/i, '').trim();
  }
  const n = parseInt(numeric, 10);
  if (isNaN(n)) return null;
  const year = Math.max(YEAR_MIN, Math.min(YEAR_MAX, negative ? -Math.abs(n) : n));
  return encodeDate(year, 1, 1);
}

function formatStepLabel(s: number): string {
  if (s < STEP_MONTH)           return '1d';
  if (s < STEP_YEAR)            return '1mo';
  return `${s / STEP_YEAR}yr`;
}

const SPEED_OPTIONS = [1, 5, 10, 25, 50];
const JUMP_STEPS = 5; // how many steps the ±5 buttons jump

export function TimelineBar({
  currentDateInt,
  stepSize,
  stepOptions,
  isPlaying,
  playbackSpeed,
  onSeek,
  onStep,
  onTogglePlay,
  onSetStepSize,
  onSetSpeed,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = useCallback(() => {
    setDraft(displayDate(currentDateInt, stepSize));
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [currentDateInt, stepSize]);

  const commit = useCallback(() => {
    const dateInt = parseYearInput(draft);
    if (dateInt !== null) onSeek(dateInt);
    setEditing(false);
  }, [draft, onSeek]);

  const cancel = useCallback(() => setEditing(false), []);

  const jumpBack    = useCallback(() => onSeek(normalizeDateInt(currentDateInt - JUMP_STEPS * stepSize)), [currentDateInt, stepSize, onSeek]);
  const jumpForward = useCallback(() => onSeek(normalizeDateInt(currentDateInt + JUMP_STEPS * stepSize)), [currentDateInt, stepSize, onSeek]);

  return (
    <div style={styles.bar}>
      {/* Playback controls */}
      <div style={styles.controls}>
        <button style={styles.jumpBtn} onClick={jumpBack} title={`Back ${JUMP_STEPS} steps`}>−5</button>
        <button style={styles.stepBtn} onClick={() => onStep(-1)} title="Step back (←)">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 2v10M10.5 2L5 7l5.5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button style={{ ...styles.playBtn, background: isPlaying ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.05)' }} onClick={onTogglePlay} title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}>
          {isPlaying
            ? <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><rect x="2" y="1" width="4" height="12" rx="1"/><rect x="8" y="1" width="4" height="12" rx="1"/></svg>
            : <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1.5l10 5.5-10 5.5V1.5z"/></svg>
          }
        </button>
        <button style={styles.stepBtn} onClick={() => onStep(1)} title="Step forward (→)">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M11 2v10M3.5 2L9 7 3.5 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button style={styles.jumpBtn} onClick={jumpForward} title={`Forward ${JUMP_STEPS} steps`}>+5</button>
      </div>

      {/* Slider — operates in dateInt space */}
      <div style={styles.sliderTrack}>
        <input
          type="range"
          min={DATE_MIN}
          max={DATE_MAX}
          step={stepSize}
          value={currentDateInt}
          onChange={(e) => onSeek(normalizeDateInt(Number(e.target.value)))}
          style={styles.slider}
        />
      </div>

      {/* Date display — click to type */}
      <div style={styles.yearBlock}>
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') cancel();
            }}
            onBlur={commit}
            autoFocus
            style={styles.yearInput}
            placeholder="e.g. 600 BCE"
          />
        ) : (
          <span style={styles.yearLabel} onClick={startEdit} title="Click to type a year">
            {displayDate(currentDateInt, stepSize)}
          </span>
        )}
      </div>

      {/* Settings */}
      <div style={styles.settings}>
        <div style={styles.settingGroup} title="How much time each step/tick advances">
          <span style={styles.settingLabel}>step</span>
          <select style={styles.select} value={stepSize} onChange={(e) => { onSetStepSize(Number(e.target.value)); e.currentTarget.blur(); }}>
            {stepOptions.map((s) => <option key={s} value={s}>{formatStepLabel(s)}</option>)}
          </select>
        </div>
        <div style={styles.settingGroup} title="Steps per second during playback">
          <span style={styles.settingLabel}>speed</span>
          <select style={styles.select} value={playbackSpeed} onChange={(e) => { onSetSpeed(Number(e.target.value)); e.currentTarget.blur(); }}>
            {SPEED_OPTIONS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    height: 60,
    background: '#ffffff',
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '0 20px',
    zIndex: 100,
    borderTop: '1px solid rgba(0,0,0,0.1)',
  },
  controls: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 },
  stepBtn: {
    background: 'rgba(0,0,0,0.05)',
    border: '1px solid rgba(0,0,0,0.1)',
    borderRadius: 7,
    color: '#202122',
    width: 30,
    height: 30,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'inherit',
  },
  jumpBtn: {
    background: 'rgba(0,0,0,0.05)',
    border: '1px solid rgba(0,0,0,0.1)',
    borderRadius: 7,
    color: '#54595d',
    height: 30,
    padding: '0 8px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'inherit',
    letterSpacing: '-0.02em',
  },
  playBtn: {
    border: '1px solid rgba(0,0,0,0.15)',
    borderRadius: 7,
    color: '#202122',
    width: 36,
    height: 30,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'inherit',
    transition: 'background 0.15s',
  },
  sliderTrack: { flex: 1, display: 'flex', alignItems: 'center' },
  slider: { width: '100%', accentColor: '#3366cc', height: 4, cursor: 'pointer' },
  yearBlock: { flexShrink: 0, minWidth: 110, textAlign: 'center' },
  yearLabel: {
    fontSize: 18,
    fontWeight: 700,
    color: '#202122',
    letterSpacing: '-0.03em',
    fontVariantNumeric: 'tabular-nums',
    cursor: 'text',
  },
  yearInput: {
    width: 130,
    fontSize: 18,
    fontWeight: 700,
    color: '#202122',
    letterSpacing: '-0.03em',
    fontVariantNumeric: 'tabular-nums',
    fontFamily: 'inherit',
    textAlign: 'center',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid #3366cc',
    outline: 'none',
    padding: '0 2px',
  },
  settings: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  settingGroup: { display: 'flex', alignItems: 'center', gap: 5 },
  settingLabel: {
    fontSize: 10,
    fontWeight: 500,
    color: '#54595d',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  select: {
    background: '#f8f9fa',
    border: '1px solid rgba(0,0,0,0.1)',
    color: '#202122',
    borderRadius: 6,
    padding: '3px 6px',
    fontSize: 12,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
};
