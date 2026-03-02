import { YEAR_MIN, YEAR_MAX } from '../types';
import { displayYear } from '../hooks/useTimeline';

interface Props {
  currentYear: number;
  stepSize: number;
  stepOptions: number[];
  isPlaying: boolean;
  playbackSpeed: number;
  onSeek: (year: number) => void;
  onStep: (dir: 1 | -1) => void;
  onTogglePlay: () => void;
  onSetStepSize: (s: number) => void;
  onSetSpeed: (s: number) => void;
}

const SPEED_OPTIONS = [5, 10, 25, 50];

export function TimelineBar({
  currentYear,
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
  return (
    <div style={styles.bar}>
      {/* Playback controls */}
      <div style={styles.controls}>
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
      </div>

      {/* Slider */}
      <div style={styles.sliderTrack}>
        <input
          type="range"
          min={YEAR_MIN}
          max={YEAR_MAX}
          step={stepSize}
          value={currentYear}
          onChange={(e) => onSeek(Number(e.target.value))}
          style={styles.slider}
        />
      </div>

      {/* Year display — hero element */}
      <div style={styles.yearBlock}>
        <span style={styles.yearLabel}>{displayYear(currentYear)}</span>
      </div>

      {/* Settings */}
      <div style={styles.settings}>
        <div style={styles.settingGroup}>
          <span style={styles.settingLabel}>step</span>
          <select style={styles.select} value={stepSize} onChange={(e) => onSetStepSize(Number(e.target.value))}>
            {stepOptions.map((s) => <option key={s} value={s}>{s}yr</option>)}
          </select>
        </div>
        <div style={styles.settingGroup}>
          <span style={styles.settingLabel}>speed</span>
          <select style={styles.select} value={playbackSpeed} onChange={(e) => onSetSpeed(Number(e.target.value))}>
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
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
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
  sliderTrack: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
  },
  slider: {
    width: '100%',
    accentColor: '#3366cc',
    height: 4,
    cursor: 'pointer',
  },
  yearBlock: {
    flexShrink: 0,
    minWidth: 100,
    textAlign: 'center',
  },
  yearLabel: {
    fontSize: 18,
    fontWeight: 700,
    color: '#202122',
    letterSpacing: '-0.03em',
    fontVariantNumeric: 'tabular-nums',
  },
  settings: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexShrink: 0,
  },
  settingGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
  },
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
