import type { Category } from '../types';
import { EVENT_CATEGORIES, LOCATION_CATEGORIES, POLITY_CATEGORIES, CATEGORY_COLORS, CATEGORY_LABELS } from '../theme/categories';
interface Props {
  activeCategories: Set<Category>;
  onToggle: (cat: Category) => void;
  activePolityCategories: Set<Category>;
  onTogglePolity: (cat: Category) => void;
  onOpenData: () => void;
  onOpenAbout: () => void;
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

export function CategoryFilter({ activeCategories, onToggle, activePolityCategories, onTogglePolity, onOpenData, onOpenAbout }: Props) {
  return (
    <div style={styles.bar}>
      {/* Row 1: wordmark + nav buttons */}
      <div style={styles.row}>
        <div style={styles.wordmark}>OpenHistory</div>
        <button onClick={onOpenAbout} style={styles.dataBtn}>About</button>
        <div style={{ flex: 1 }} />
        <button onClick={onOpenData} style={styles.dataBtn}>Data Explorer ↗</button>
      </div>

      <div style={styles.rowDivider} />

      {/* Row 2: events + locations */}
      <div style={styles.row}>
        <GroupLabel label="Events" cats={EVENT_CATEGORIES} activeSet={activeCategories} onToggle={onToggle} />
        <ChipGroup cats={EVENT_CATEGORIES} activeCategories={activeCategories} onToggle={onToggle} />
        <div style={styles.groupDivider} />
        <GroupLabel label="Locations" cats={LOCATION_CATEGORIES} activeSet={activeCategories} onToggle={onToggle} />
        <ChipGroup cats={LOCATION_CATEGORIES} activeCategories={activeCategories} onToggle={onToggle} />
      </div>

      <div style={styles.rowDivider} />

      {/* Row 3: polities */}
      <div style={styles.row}>
        <GroupLabel label="Polities" cats={POLITY_CATEGORIES} activeSet={activePolityCategories} onToggle={onTogglePolity} />
        <ChipGroup cats={POLITY_CATEGORIES} activeCategories={activePolityCategories} onToggle={onTogglePolity} />
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
  rowDivider: {
    height: 1,
    background: 'rgba(0,0,0,0.07)',
    margin: '0 20px',
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
};
