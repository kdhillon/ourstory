import { useEffect, useRef, useState } from 'react';
import type { Category } from '../types';
import { EVENT_CATEGORIES, LOCATION_CATEGORIES, CATEGORY_COLORS, CATEGORY_LABELS } from '../theme/categories';
import { WIKIPEDIA_LANGUAGES } from '../lib/languages';
import type { WindowInfo } from '../hooks/useEventSource';

interface Props {
  activeCategories: Set<Category>;
  onToggle: (cat: Category) => void;
  showBorders: boolean;
  onToggleBorders: () => void;
  showOtherPolities: boolean;
  onToggleOtherPolities: () => void;
  onOpenData: () => void;
  onOpenAbout: () => void;
  onEditTerritory: () => void;
  editorMode: boolean;
  selectedLang: string;
  onLangChange: (lang: string) => void;
  // Data stats (from DataOverlay)
  windowInfo: WindowInfo | null;
  eventsLoading: boolean;
  eventsError: string | null;
  territoriesLoading: boolean;
  territoriesError: string | null;
  seedLoading: boolean;
  locationCount: number;
  polityCount: number;
}

function Spinner() {
  return (
    <>
      <style>{`@keyframes oh-spin { to { transform: rotate(360deg); } }`}</style>
      <svg width="10" height="10" viewBox="0 0 10 10" style={{ animation: 'oh-spin 0.75s linear infinite', flexShrink: 0 }}>
        <circle cx="5" cy="5" r="3.5" fill="none" stroke="rgba(0,0,0,0.15)" strokeWidth="1.5" />
        <path d="M5 1.5 A3.5 3.5 0 0 1 8.5 5" fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </>
  );
}

function GroupLabel({ label, cats, activeSet, onToggle }: {
  label: string;
  cats: Category[];
  activeSet: Set<Category>;
  onToggle: (cat: Category) => void;
}) {
  const allOn = cats.every((c) => activeSet.has(c));

  const handleClick = () => {
    if (allOn) {
      // Deselect all in group
      cats.forEach((c) => { if (activeSet.has(c)) onToggle(c); });
    } else {
      // Select all in group
      cats.forEach((c) => { if (!activeSet.has(c)) onToggle(c); });
    }
  };

  return (
    <button
      onClick={handleClick}
      title={allOn ? `Hide all ${label}` : `Show all ${label}`}
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
        color: allOn ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.25)',
        background: allOn ? 'transparent' : 'rgba(0,0,0,0.04)',
        border: '1px solid',
        borderColor: allOn ? 'rgba(0,0,0,0.18)' : 'rgba(0,0,0,0.1)',
        borderRadius: 5,
        padding: '2px 7px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        flexShrink: 0,
        transition: 'all 0.15s ease',
      }}
    >
      {label}
    </button>
  );
}

function ChipGroup({ cats, activeCategories, onToggle }: {
  cats: Category[];
  activeCategories: Set<Category>;
  onToggle: (cat: Category) => void;
}) {
  return (
    <>
      {cats.map((cat) => {
        const active = activeCategories.has(cat);
        const color = CATEGORY_COLORS[cat];
        return (
          <button
            key={cat}
            onClick={() => onToggle(cat)}
            style={{
              ...styles.chip,
              background: active ? `${color}22` : 'transparent',
              borderColor: active ? `${color}88` : 'rgba(0,0,0,0.15)',
              color: active ? '#202122' : '#9a9a9a',
            }}
            title={active ? `Hide ${CATEGORY_LABELS[cat]}` : `Show ${CATEGORY_LABELS[cat]}`}
          >
            <span style={{ ...styles.dot, background: color, opacity: active ? 1 : 0.4 }} />
            {CATEGORY_LABELS[cat]}
          </button>
        );
      })}
    </>
  );
}

export function CategoryFilter({ activeCategories, onToggle, showBorders, onToggleBorders, showOtherPolities, onToggleOtherPolities, onOpenData, onOpenAbout, onEditTerritory, editorMode, selectedLang, onLangChange, windowInfo, eventsLoading, eventsError, territoriesLoading, territoriesError, seedLoading, locationCount, polityCount }: Props) {
  const bordersColor = '#607D8B';
  const otherPolitiesColor = '#9C27B0';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const gearRef = useRef<HTMLButtonElement>(null);
  const settingsModalRef = useRef<HTMLDivElement>(null);

  // Close settings when clicking outside
  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        settingsModalRef.current && !settingsModalRef.current.contains(e.target as Node) &&
        gearRef.current && !gearRef.current.contains(e.target as Node)
      ) {
        setSettingsOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [settingsOpen]);

  return (
    <div style={styles.bar}>
      {/* Row 1: wordmark + nav buttons */}
      <div style={styles.row}>
        <button onClick={onOpenAbout} title="About OpenHistory" style={styles.infoBtn}>i</button>
        <div style={styles.wordmark}>OpenHistory</div>
        <div style={{ flex: 1 }} />
        <button onClick={onEditTerritory} style={{ ...styles.dataBtn, ...(editorMode ? styles.dataBtnActive : {}) }}>Edit Borders ✎</button>
        <button onClick={onOpenData} style={styles.dataBtn}>Data Explorer ↗</button>
        {/* Gear / settings */}
        <button
          ref={gearRef}
          onClick={() => setSettingsOpen((v) => !v)}
          title="Settings"
          style={{ ...styles.dataBtn, fontSize: 16, lineHeight: 1, padding: '4px 8px', color: settingsOpen ? '#3366cc' : '#202122', ...(settingsOpen ? styles.dataBtnActive : {}) }}
        >
          ⚙
        </button>
      </div>

      {/* Settings modal — rendered outside the row to escape overflow:hidden */}
      {settingsOpen && (
          <div ref={settingsModalRef} style={styles.settingsModal}>
            <div style={styles.settingsRow}>
              <label style={styles.settingsLabel}>Language</label>
              <select
                value={selectedLang}
                onChange={(e) => onLangChange(e.target.value)}
                style={styles.langSelect}
                title="Wikipedia language"
              >
                {WIKIPEDIA_LANGUAGES.map(([code, native]) => (
                  <option key={code} value={code}>{native}</option>
                ))}
              </select>
            </div>
            <hr style={{ border: 'none', borderTop: '1px solid rgba(0,0,0,0.08)', margin: '10px 0' }} />
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'rgba(0,0,0,0.35)', marginBottom: 8 }}>Data</div>
            {/* Events */}
            <div style={styles.statsRow}>
              <span style={styles.statsLabel}>Events</span>
              {eventsLoading ? <Spinner /> : windowInfo ? (
                <>
                  <span style={styles.statsRange}>{windowInfo.yearMin} – {windowInfo.yearMax}</span>
                  <span style={styles.statsBadge}>{windowInfo.count.toLocaleString()}</span>
                </>
              ) : (
                <span style={styles.statsNone}>none</span>
              )}
            </div>
            {/* Locations */}
            <div style={styles.statsRow}>
              <span style={styles.statsLabel}>Locations</span>
              {seedLoading ? <Spinner /> : <span style={styles.statsBadge}>{locationCount.toLocaleString()}</span>}
            </div>
            {/* Polities */}
            <div style={styles.statsRow}>
              <span style={styles.statsLabel}>Polities</span>
              {seedLoading ? <Spinner /> : <span style={styles.statsBadge}>{polityCount.toLocaleString()}</span>}
            </div>
            {/* Territories */}
            <div style={styles.statsRow}>
              <span style={styles.statsLabel}>Territories</span>
              {territoriesLoading ? <Spinner /> : <span style={styles.statsNone}>active</span>}
            </div>
            {eventsError && <div style={{ fontSize: 11, color: '#c0392b', marginTop: 4 }}>⚠ events: {eventsError}</div>}
            {territoriesError && <div style={{ fontSize: 11, color: '#c0392b', marginTop: 4 }}>⚠ territories: {territoriesError}</div>}
          </div>
      )}

      {/* Row 2: polity toggles + events + locations */}
      <div style={styles.row}>
        {/* Borders toggle */}
        <button
          onClick={onToggleBorders}
          style={{
            ...styles.chip,
            background: showBorders ? `${bordersColor}22` : 'transparent',
            borderColor: showBorders ? `${bordersColor}88` : 'rgba(0,0,0,0.15)',
            color: showBorders ? '#202122' : '#9a9a9a',
          }}
          title={showBorders ? 'Hide territory borders' : 'Show territory borders'}
        >
          <span style={{ ...styles.dot, background: bordersColor, opacity: showBorders ? 1 : 0.4 }} />
          Borders
        </button>
        {/* Other Polities toggle */}
        <button
          onClick={onToggleOtherPolities}
          style={{
            ...styles.chip,
            background: showOtherPolities ? `${otherPolitiesColor}22` : 'transparent',
            borderColor: showOtherPolities ? `${otherPolitiesColor}88` : 'rgba(0,0,0,0.15)',
            color: showOtherPolities ? '#202122' : '#9a9a9a',
          }}
          title={showOtherPolities ? 'Hide unlinked polities' : 'Show unlinked polities'}
        >
          <span style={{ ...styles.dot, background: otherPolitiesColor, opacity: showOtherPolities ? 1 : 0.4 }} />
          Other Polities
        </button>
        <div style={styles.groupDivider} />
        <GroupLabel label="Events" cats={EVENT_CATEGORIES} activeSet={activeCategories} onToggle={onToggle} />
        <ChipGroup cats={EVENT_CATEGORIES} activeCategories={activeCategories} onToggle={onToggle} />
        <div style={styles.groupDivider} />
        <GroupLabel label="Locations" cats={LOCATION_CATEGORIES} activeSet={activeCategories} onToggle={onToggle} />
        <ChipGroup cats={LOCATION_CATEGORIES} activeCategories={activeCategories} onToggle={onToggle} />
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    background: '#ffffff',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 100,
    borderBottom: '1px solid rgba(0,0,0,0.1)',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 20px',
    height: 34,
    overflow: 'hidden',
  },
  infoBtn: {
    width: 18,
    height: 18,
    borderRadius: '50%',
    border: '1.5px solid rgba(0,0,0,0.3)',
    background: 'transparent',
    color: 'rgba(0,0,0,0.5)',
    fontSize: 11,
    fontWeight: 700,
    fontStyle: 'italic',
    fontFamily: 'Georgia, serif',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    padding: 0,
    lineHeight: 1,
  },
  wordmark: {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: '#202122',
    flexShrink: 0,
    marginRight: 4,
  },
  divider: {
    width: 1,
    height: 20,
    background: 'rgba(0,0,0,0.15)',
    marginRight: 6,
    flexShrink: 0,
  },
  groupDivider: {
    width: 1,
    height: 20,
    background: 'rgba(0,0,0,0.1)',
    marginLeft: 6,
    marginRight: 6,
    flexShrink: 0,
  },
  chip: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    border: '1px solid',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 500,
    padding: '4px 10px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    whiteSpace: 'nowrap',
    fontFamily: 'inherit',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
  },
  dataBtn: {
    fontSize: 12,
    fontWeight: 600,
    color: '#202122',
    background: 'transparent',
    border: '1px solid rgba(0,0,0,0.18)',
    borderRadius: 6,
    padding: '5px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    letterSpacing: '0.01em',
    flexShrink: 0,
  },
  dataBtnActive: {
    background: '#e8f0fe',
    borderColor: '#3366cc',
    color: '#3366cc',
  },
  langSelect: {
    fontSize: 13,
    fontWeight: 400,
    color: '#202122',
    background: '#f3f4f6',
    border: '1px solid rgba(0,0,0,0.12)',
    borderRadius: 6,
    padding: '5px 8px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    flex: 1,
  },
  settingsModal: {
    position: 'fixed' as const,
    top: 74,
    right: 20,
    background: '#ffffff',
    border: '1px solid rgba(0,0,0,0.18)',
    borderRadius: 10,
    boxShadow: '0 4px 20px rgba(0,0,0,0.12)',
    padding: '14px 16px',
    zIndex: 200,
    minWidth: 240,
  },
  settingsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  settingsLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: '#202122',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
  statsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 5,
  },
  statsLabel: {
    fontSize: 12,
    color: 'rgba(0,0,0,0.5)',
    minWidth: 64,
    flexShrink: 0,
  },
  statsRange: {
    fontSize: 11,
    color: 'rgba(0,0,0,0.45)',
  },
  statsBadge: {
    marginLeft: 'auto',
    background: 'rgba(0,0,0,0.07)',
    borderRadius: 4,
    padding: '1px 6px',
    fontSize: 11,
    color: 'rgba(0,0,0,0.6)',
  },
  statsNone: {
    marginLeft: 'auto',
    fontSize: 11,
    color: 'rgba(0,0,0,0.3)',
  },
};
