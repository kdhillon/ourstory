import type { Category } from '../types';
import { EVENT_CATEGORIES, LOCATION_CATEGORIES, CATEGORY_COLORS, CATEGORY_LABELS } from '../theme/categories';
import { WIKIPEDIA_LANGUAGES } from '../lib/languages';

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

export function CategoryFilter({ activeCategories, onToggle, showBorders, onToggleBorders, showOtherPolities, onToggleOtherPolities, onOpenData, onOpenAbout, onEditTerritory, editorMode, selectedLang, onLangChange }: Props) {
  const bordersColor = '#607D8B';
  const otherPolitiesColor = '#9C27B0';

  return (
    <div style={styles.bar}>
      {/* Row 1: wordmark + nav buttons */}
      <div style={styles.row}>
        <div style={styles.wordmark}>OpenHistory</div>
        <div style={{ flex: 1 }} />
        <button onClick={onEditTerritory} style={{ ...styles.dataBtn, ...(editorMode ? styles.dataBtnActive : {}) }}>Edit Territory</button>
        <button onClick={onOpenData} style={styles.dataBtn}>Data Explorer ↗</button>
        <button onClick={onOpenAbout} style={styles.dataBtn}>About</button>
        <select
          value={selectedLang}
          onChange={(e) => onLangChange(e.target.value)}
          style={styles.langSelect}
          title="Wikipedia language"
        >
          {WIKIPEDIA_LANGUAGES.map(([code, , en]) => (
            <option key={code} value={code}>{en}</option>
          ))}
        </select>
      </div>

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
    fontSize: 12,
    fontWeight: 600,
    color: '#202122',
    background: 'transparent',
    border: '1px solid rgba(0,0,0,0.18)',
    borderRadius: 6,
    padding: '5px 8px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    flexShrink: 0,
    maxWidth: 120,
  },
};
