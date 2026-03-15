import type { Story, StoryBeat, FeatureProperties } from '../types';
import { encodeDate, displayDate, STEP_DAY, STEP_MONTH, STEP_YEAR } from '../hooks/useTimeline';

const DETAIL_LEVEL_LABELS: Record<string, string> = {
  elementary: 'Elementary',
  middle_school: 'Middle School',
  high_school: 'High School',
  deep_dive: 'Deep Dive',
};

interface Props {
  story: Story;
  beatIndex: number;
  currentBeat: StoryBeat | null;
  currentBeatEvent: FeatureProperties | null;
  onNext: () => void;
  onPrev: () => void;
  onJumpToBeat: (index: number) => void;
  onExit: () => void;
}

function formatBeatDate(beat: StoryBeat, event: FeatureProperties | null): string | null {
  if (event?.yearStart != null) {
    const { yearStart, monthStart, dayStart } = event;
    const dateInt = encodeDate(yearStart, monthStart ?? 1, dayStart ?? 1);
    const step = dayStart != null ? STEP_DAY : monthStart != null ? STEP_MONTH : STEP_YEAR;
    return displayDate(dateInt, step);
  }
  if (beat.date) {
    const parts = beat.date.split('-').map(Number);
    const year = parts[0], month = parts[1] ?? null, day = parts[2] ?? null;
    const dateInt = encodeDate(year, month ?? 1, day ?? 1);
    const step = day != null ? STEP_DAY : month != null ? STEP_MONTH : STEP_YEAR;
    return displayDate(dateInt, step);
  }
  return null;
}

export function StoryPanel({ story, beatIndex, currentBeat, currentBeatEvent, onNext, onPrev, onJumpToBeat, onExit }: Props) {
  if (!currentBeat) return null;

  const isFirst = beatIndex === 0;
  const isLast = beatIndex === story.beats.length - 1;
  const dateStr = formatBeatDate(currentBeat, currentBeatEvent);

  // Walk back to find the current chapter title
  const chapterTitle = (() => {
    for (let i = beatIndex; i >= 0; i--) {
      if (story.beats[i].chapter_title) return story.beats[i].chapter_title;
    }
    return null;
  })();

  const isChapterStart = currentBeat.chapter_title != null;

  return (
    <div style={styles.panel}>
      {/* Top bar */}
      <div style={styles.topBar}>
        <button onClick={onExit} style={styles.exitBtn}>
          ← Exit
        </button>
        <div style={styles.storyMeta}>
          <span style={styles.storyTitle}>{story.title}</span>
          <span style={styles.detailBadge}>
            {DETAIL_LEVEL_LABELS[story.detail_level] ?? story.detail_level}
          </span>
        </div>
      </div>

      {/* Chapter label */}
      {chapterTitle && (
        <div style={{ ...styles.chapterBar, ...(isChapterStart ? styles.chapterBarNew : {}) }}>
          {isChapterStart && <span style={styles.chapterNew}>New Chapter</span>}
          <span style={styles.chapterLabel}>{chapterTitle}</span>
        </div>
      )}

      {/* Beat body */}
      <div style={styles.body}>
        <div style={styles.beatMeta}>
          <span style={styles.beatNum}>{beatIndex + 1} / {story.beats.length}</span>
          {dateStr && <span style={styles.beatDate}>{dateStr}</span>}
        </div>

        <h2 style={styles.beatTitle}>{currentBeat.beat_title}</h2>
        {currentBeatEvent && (
          <a
            href={currentBeatEvent.wikipediaUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.eventSubtitle}
          >
            {currentBeatEvent.title} ↗
          </a>
        )}
        <p style={styles.narrative}>{currentBeat.narrative_text}</p>
      </div>

      {/* Progress dots */}
      <div style={styles.progressRow}>
        {story.beats.map((beat, i) => (
          <button
            key={i}
            onClick={() => onJumpToBeat(i)}
            title={beat.beat_title}
            style={{
              ...styles.dot,
              ...(i === beatIndex ? styles.dotActive : {}),
              ...(beat.chapter_title && i > 0 ? styles.dotChapterStart : {}),
            }}
          />
        ))}
      </div>

      {/* Navigation */}
      <div style={styles.navRow}>
        <button
          onClick={onPrev}
          disabled={isFirst}
          style={{ ...styles.navBtn, ...(isFirst ? styles.navBtnDisabled : {}) }}
        >
          ← Previous
        </button>
        <button
          onClick={onNext}
          disabled={isLast}
          style={{ ...styles.navBtn, ...(isLast ? styles.navBtnDisabled : {}) }}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'fixed',
    top: 114,
    right: 16,
    width: 360,
    height: 'calc(90vh - 114px)',
    background: '#ffffff',
    borderRadius: 12,
    border: '1px solid rgba(0,0,0,0.1)',
    boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
    zIndex: 90,
    color: '#202122',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    animation: 'slideInRight 0.2s ease',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    background: '#1a237e',
    borderRadius: '12px 12px 0 0',
    flexShrink: 0,
  },
  exitBtn: {
    background: 'rgba(255,255,255,0.15)',
    border: '1px solid rgba(255,255,255,0.25)',
    borderRadius: 6,
    color: '#fff',
    fontSize: 12,
    padding: '4px 10px',
    cursor: 'pointer',
    flexShrink: 0,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
  },
  storyMeta: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: 2,
    minWidth: 0,
  },
  storyTitle: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
  },
  detailBadge: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.6)',
    fontWeight: 500,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  chapterBar: {
    background: '#f0f4ff',
    padding: '6px 14px',
    borderBottom: '1px solid rgba(26,35,126,0.1)',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  chapterBarNew: {
    background: '#e8eeff',
    borderBottom: '1px solid rgba(26,35,126,0.2)',
  },
  chapterNew: {
    fontSize: 9,
    fontWeight: 700,
    color: '#fff',
    background: '#1a237e',
    padding: '2px 6px',
    borderRadius: 3,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    flexShrink: 0,
  },
  chapterLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#1a237e',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  body: {
    padding: '14px 16px 10px',
    overflowY: 'auto',
    flex: 1,
  },
  beatMeta: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  beatNum: {
    fontSize: 11,
    color: '#72777d',
    fontWeight: 500,
  },
  beatDate: {
    fontSize: 12,
    color: '#1a237e',
    fontWeight: 600,
  },
  beatTitle: {
    fontSize: 17,
    fontWeight: 700,
    color: '#202122',
    margin: '0 0 10px',
    lineHeight: 1.3,
  },
  eventSubtitle: {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: '#1a237e',
    textDecoration: 'none',
    marginBottom: 10,
  },
  narrative: {
    fontSize: 14,
    lineHeight: 1.65,
    color: '#444',
    margin: 0,
  },
  progressRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
    padding: '10px 16px',
    borderTop: '1px solid rgba(0,0,0,0.06)',
    flexShrink: 0,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'rgba(0,0,0,0.15)',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    transition: 'transform 0.1s, background 0.1s',
  },
  dotActive: {
    background: '#1a237e',
    transform: 'scale(1.5)',
  },
  dotChapterStart: {
    background: 'rgba(26,35,126,0.35)',
  },
  navRow: {
    display: 'flex',
    gap: 8,
    padding: '0 16px 14px',
    flexShrink: 0,
  },
  navBtn: {
    flex: 1,
    padding: '9px 0',
    borderRadius: 8,
    border: '1px solid #1a237e',
    background: '#fff',
    color: '#1a237e',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'background 0.15s',
  },
  navBtnDisabled: {
    opacity: 0.3,
    cursor: 'default',
  },
};
