import type { Category } from '../types';
import { EVENT_CATEGORIES, LOCATION_CATEGORIES, CATEGORY_COLORS, CATEGORY_LABELS } from '../theme/categories';

interface Props {
  activeCategories: Set<Category>;
  onToggle: (cat: Category) => void;
  onOpenData: () => void;
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

export function CategoryFilter({ activeCategories, onToggle, onOpenData }: Props) {
  return (
    <div style={styles.bar}>
      {/* Wordmark */}
      <div style={styles.wordmark}>OurStory</div>
      <div style={styles.divider} />

      {/* Events group */}
      <span style={styles.groupLabel}>Events</span>
      <ChipGroup cats={EVENT_CATEGORIES} activeCategories={activeCategories} onToggle={onToggle} />

      {/* Separator */}
      <div style={styles.groupDivider} />

      {/* Locations group */}
      <span style={styles.groupLabel}>Locations</span>
      <ChipGroup cats={LOCATION_CATEGORIES} activeCategories={activeCategories} onToggle={onToggle} />

      {/* Data explorer link */}
      <div style={{ flex: 1 }} />
      <button onClick={onOpenData} style={styles.dataBtn}>
        Data ↗
      </button>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    height: 52,
    background: '#ffffff',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 20px',
    zIndex: 100,
    borderBottom: '1px solid rgba(0,0,0,0.1)',
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
  groupLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: 'rgba(0,0,0,0.35)',
    flexShrink: 0,
    marginRight: 2,
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
