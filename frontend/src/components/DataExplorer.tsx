import { useState, useMemo } from 'react';
import type { FeatureProperties, Category } from '../types';
import { ALL_CATEGORIES, CATEGORY_COLORS, CATEGORY_LABELS, getCategoryColor } from '../theme/categories';
import { WIKIDATA_LABELS } from '../data/wikidataLabels';
import { WikiEditForm } from './WikiEditForm';

interface Props {
  geojson: GeoJSON.FeatureCollection;
  onBackToMap: () => void;
  onNavigateToFeature?: (feature: FeatureProperties) => void;
  wikiAuth: string | null;
  onAuth: (username: string | null) => void;
  onFeatureUpdated: (featureId: string, updates: Partial<FeatureProperties>) => void;
}

function PencilIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 12 12" fill="none" style={{ display: 'block' }}>
      <path d="M8.5 1.5l2 2-7 7H1.5v-2l7-7z" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

type SortKey = 'year' | 'title' | 'category' | 'type';
type SortDir = 'asc' | 'desc';

function displayYear(year: number | null): string {
  if (year === null) return '—';
  if (year < 0) return `${Math.abs(year)} BCE`;
  if (year === 0) return 'Year 0';
  return `${year} CE`;
}

export function DataExplorer({ geojson, onBackToMap, onNavigateToFeature, wikiAuth, onAuth, onFeatureUpdated }: Props) {
  const [search, setSearch] = useState('');
  const [activeFilters, setActiveFilters] = useState<Set<Category>>(new Set(ALL_CATEGORIES));
  const [yearFrom, setYearFrom] = useState('');
  const [yearTo, setYearTo] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('year');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [editState, setEditState] = useState<{ feature: FeatureProperties; field: 'date' | 'location' } | null>(null);
  const [unlocatedOnly, setUnlocatedOnly] = useState(false);

  const allRows = useMemo(() => {
    return geojson.features
      .map((f) => f.properties as FeatureProperties)
      .filter(Boolean);
  }, [geojson]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const from = yearFrom !== '' ? parseInt(yearFrom, 10) : null;
    const to = yearTo !== '' ? parseInt(yearTo, 10) : null;

    return allRows.filter((row) => {
      if (unlocatedOnly) {
        // Only events with no location data — skip location features entirely
        if (row.featureType !== 'event') return false;
        if (row.locationName && row.locationLevel) return false;
      }

      if (q && !row.title.toLowerCase().includes(q) && !(row.locationName ?? '').toLowerCase().includes(q)) return false;
      if (from !== null && row.yearStart !== null && row.yearStart < from) return false;
      if (to !== null && row.yearStart !== null && row.yearStart > to) return false;

      if (row.featureType === 'event' || row.featureType === 'polity') {
        if (!row.categories.some((c) => activeFilters.has(c as Category))) return false;
      } else {
        if (!activeFilters.has(row.featureType as Category)) return false;
      }

      return true;
    });
  }, [allRows, search, activeFilters, yearFrom, yearTo, unlocatedOnly]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'year') {
        const ay = a.yearStart ?? -Infinity;
        const by = b.yearStart ?? -Infinity;
        cmp = ay - by;
      } else if (sortKey === 'title') {
        cmp = a.title.localeCompare(b.title);
      } else if (sortKey === 'category') {
        cmp = a.primaryCategory.localeCompare(b.primaryCategory);
      } else if (sortKey === 'type') {
        cmp = a.featureType.localeCompare(b.featureType);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function toggleFilter(cat: Category) {
    setActiveFilters((prev) => {
      if (prev.size === ALL_CATEGORIES.length) return new Set([cat]);
      const next = new Set(prev);
      if (next.has(cat)) {
        next.delete(cat);
        if (next.size === 0) return new Set(ALL_CATEGORIES);
      } else {
        next.add(cat);
      }
      return next;
    });
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return <span style={{ opacity: 0.25 }}> ↕</span>;
    return <span style={{ opacity: 0.8 }}>{sortDir === 'asc' ? ' ↑' : ' ↓'}</span>;
  }

  return (
    <div style={s.page}>
      {/* ── Wiki edit modal ── */}
      {editState && (
        <div
          style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: '0 20px 20px 0' }}
          onClick={() => setEditState(null)}
        >
          <div
            style={{ width: 380, background: '#ffffff', borderRadius: 12, border: '1px solid rgba(0,0,0,0.1)', boxShadow: '0 12px 40px rgba(0,0,0,0.3)', overflow: 'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            <WikiEditForm
              feature={editState.feature}
              field={editState.field}
              wikiAuth={wikiAuth}
              onAuth={onAuth}
              onSuccess={(updates) => {
                onFeatureUpdated(editState.feature.id, updates);
                setEditState(null);
              }}
              onClose={() => setEditState(null)}
            />
          </div>
        </div>
      )}

      {/* ── Nav bar ── */}
      <div style={s.navbar}>
        <span style={s.wordmark}>OpenHistory</span>
        <div style={s.divider} />
        <span style={s.pageTitle}>Data Explorer</span>
        <div style={{ flex: 1 }} />
        <span style={s.count}>{sorted.length.toLocaleString()} of {allRows.length.toLocaleString()} records</span>
        <button style={s.backBtn} onClick={onBackToMap}>← Map</button>
      </div>

      {/* ── Filter bar ── */}
      <div style={s.filterBar}>
        {/* Search */}
        <input
          style={s.searchInput}
          placeholder="Search by title or location…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          spellCheck={false}
        />

        {/* Unified filter chips — event categories + location types */}
        <div style={s.chipRow}>
          {ALL_CATEGORIES.map((cat) => {
            const active = activeFilters.has(cat);
            const color = CATEGORY_COLORS[cat];
            return (
              <button
                key={cat}
                onClick={() => toggleFilter(cat)}
                style={{
                  ...s.chip,
                  background: active ? `${color}22` : 'transparent',
                  borderColor: active ? `${color}88` : 'rgba(255,255,255,0.12)',
                  color: active ? '#fff' : 'rgba(255,255,255,0.35)',
                }}
              >
                <span style={{ ...s.dot, background: color, opacity: active ? 1 : 0.35 }} />
                {CATEGORY_LABELS[cat]}
              </button>
            );
          })}
        </div>

        {/* Unlocated toggle */}
        <button
          onClick={() => setUnlocatedOnly((v) => !v)}
          style={{
            ...s.chip,
            background: unlocatedOnly ? 'rgba(255,160,0,0.18)' : 'transparent',
            borderColor: unlocatedOnly ? 'rgba(255,160,0,0.6)' : 'rgba(255,255,255,0.12)',
            color: unlocatedOnly ? '#ffa000' : 'rgba(255,255,255,0.35)',
          }}
          title="Show only events with no location data"
        >
          <span style={{ fontSize: 12 }}>⚠</span>
          Unlocated only
        </button>

        {/* Year range */}
        <div style={s.yearRange}>
          <input
            style={s.yearInput}
            placeholder="From year"
            value={yearFrom}
            onChange={(e) => setYearFrom(e.target.value)}
            type="number"
          />
          <span style={s.yearSep}>–</span>
          <input
            style={s.yearInput}
            placeholder="To year"
            value={yearTo}
            onChange={(e) => setYearTo(e.target.value)}
            type="number"
          />
        </div>
      </div>

      {/* ── Table ── */}
      <div style={s.tableWrap}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={{ ...s.th, width: 28 }} />
              <th style={{ ...s.th, textAlign: 'left', cursor: 'pointer' }} onClick={() => handleSort('title')}>
                Title{sortIndicator('title')}
              </th>
              <th style={{ ...s.th, cursor: 'pointer', width: 110 }} onClick={() => handleSort('year')}>
                Year{sortIndicator('year')}
              </th>
              <th style={{ ...s.th, textAlign: 'left' }}>Location</th>
              <th style={{ ...s.th, cursor: 'pointer', width: 130 }} onClick={() => handleSort('category')}>
                Category{sortIndicator('category')}
              </th>
              <th style={{ ...s.th, cursor: 'pointer', width: 80 }} onClick={() => handleSort('type')}>
                Type{sortIndicator('type')}
              </th>
              <th style={{ ...s.th, textAlign: 'left' }}>Wikidata Classes</th>
              <th style={{ ...s.th, width: 80 }}>Version</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <TableRow key={row.id} row={row} onNavigate={onNavigateToFeature} onEdit={setEditState} />
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={8} style={s.emptyCell}>No records match the current filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TableRow({
  row,
  onNavigate,
  onEdit,
}: {
  row: FeatureProperties;
  onNavigate?: (f: FeatureProperties) => void;
  onEdit?: (state: { feature: FeatureProperties; field: 'date' | 'location' }) => void;
}) {
  const color = getCategoryColor(row.primaryCategory);
  const prefix = row.dateIsFuzzy ? '~' : '';
  const isLocationFeature = row.featureType === 'city' || row.featureType === 'region';
  const canEdit = row.featureType === 'event' && !!row.wikipediaTitle;
  const yearLabel = row.yearStart === null
    ? '—'
    : row.yearEnd !== null
      ? `${prefix}${displayYear(row.yearStart)} – ${prefix}${displayYear(row.yearEnd)}`
      : isLocationFeature
        ? `${prefix}${displayYear(row.yearStart)} – present`
        : `${prefix}${displayYear(row.yearStart)}`;
  const estLabel = row.dateIsFuzzy && row.dateRangeMin != null && row.dateRangeMax != null
    ? `est. ${displayYear(row.dateRangeMin)} – ${displayYear(row.dateRangeMax)}`
    : null;

  return (
    <tr
      style={{ ...s.tr, cursor: onNavigate ? 'pointer' : 'default' }}
      onClick={() => onNavigate?.(row)}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <td style={s.td}>
        <span style={{ ...s.rowDot, background: color }} />
      </td>
      <td style={{ ...s.td, ...s.titleCell }}>
        <a
          href={row.wikipediaUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={s.link}
          onClick={(e) => e.stopPropagation()}
        >
          {row.title}
        </a>
      </td>
      <td style={{ ...s.td, ...s.monoCell }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span>{yearLabel}</span>
          {canEdit && row.yearStart !== null && (
            <button
              style={s.pencilBtn}
              title="Edit date on Wikidata"
              onClick={(e) => { e.stopPropagation(); onEdit?.({ feature: row, field: 'date' }); }}
            >
              <PencilIcon />
            </button>
          )}
        </div>
        {estLabel && <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 1 }}>{estLabel}</div>}
      </td>
      <td style={{ ...s.td, color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span>{row.locationName || <span style={{ color: 'rgba(255,255,255,0.2)' }}>—</span>}</span>
          {canEdit && (
            <button
              style={s.pencilBtn}
              title="Edit location on Wikidata"
              onClick={(e) => { e.stopPropagation(); onEdit?.({ feature: row, field: 'location' }); }}
            >
              <PencilIcon />
            </button>
          )}
        </div>
      </td>
      <td style={s.td}>
        <span style={{ ...s.catBadge, background: `${color}22`, color, borderColor: `${color}55` }}>
          {CATEGORY_LABELS[row.primaryCategory]}
        </span>
      </td>
      <td style={{ ...s.td, color: 'rgba(255,255,255,0.4)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {row.featureType === 'event'
          ? (row.locationLevel ?? 'unlocated')
          : row.featureType === 'city' && row.cityImportance
            ? `${row.cityImportance} city`
            : row.featureType}
      </td>
      <td style={{ ...s.td, maxWidth: 260 }}>
        {row.wikidataClasses && row.wikidataClasses.length > 0 ? (
          <div style={s.qidRow}>
            {row.wikidataClasses.map((qid) => (
              <a
                key={qid}
                href={`https://www.wikidata.org/wiki/${qid}`}
                target="_blank"
                rel="noopener noreferrer"
                style={s.qidChip}
                title={qid}
                onClick={(e) => e.stopPropagation()}
              >
                {WIKIDATA_LABELS[qid] ?? qid}
              </a>
            ))}
          </div>
        ) : (
          <span style={{ color: 'rgba(255,255,255,0.15)', fontSize: 11 }}>—</span>
        )}
      </td>
      <td style={{ ...s.td, color: 'rgba(255,255,255,0.25)', fontSize: 10, fontFamily: 'ui-monospace, monospace' }}>
        {row.pipelineRun ?? (row.dataVersion != null ? `v${row.dataVersion}` : '—')}
      </td>
    </tr>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: {
    width: '100vw',
    height: '100vh',
    background: '#0d0d14',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color: '#fff',
  },
  navbar: {
    height: 52,
    background: 'rgba(13,13,20,0.96)',
    borderBottom: '1px solid rgba(255,255,255,0.07)',
    display: 'flex',
    alignItems: 'center',
    padding: '0 20px',
    gap: 10,
    flexShrink: 0,
  },
  wordmark: {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: '#fff',
  },
  divider: {
    width: 1,
    height: 20,
    background: 'rgba(255,255,255,0.12)',
  },
  pageTitle: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.5)',
    fontWeight: 500,
  },
  count: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.35)',
  },
  backBtn: {
    fontSize: 12,
    fontWeight: 500,
    color: 'rgba(255,255,255,0.7)',
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 6,
    padding: '5px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'background 0.15s',
    marginLeft: 8,
  },
  filterBar: {
    padding: '10px 20px',
    background: 'rgba(255,255,255,0.02)',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
    flexShrink: 0,
  },
  searchInput: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 6,
    color: '#fff',
    fontSize: 13,
    padding: '5px 10px',
    width: 220,
    outline: 'none',
    fontFamily: 'inherit',
  },
  chipRow: {
    display: 'flex',
    gap: 5,
    flexWrap: 'wrap',
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
    fontFamily: 'inherit',
    transition: 'all 0.12s',
    whiteSpace: 'nowrap',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
  },
  yearRange: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  yearInput: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 6,
    color: '#fff',
    fontSize: 13,
    padding: '5px 8px',
    width: 90,
    outline: 'none',
    fontFamily: 'inherit',
  },
  yearSep: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 13,
  },
  tableWrap: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
  },
  th: {
    position: 'sticky',
    top: 0,
    background: 'rgba(13,13,20,0.98)',
    color: 'rgba(255,255,255,0.45)',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '10px 12px',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    textAlign: 'left',
    userSelect: 'none',
    whiteSpace: 'nowrap',
  },
  tr: {
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    transition: 'background 0.1s',
    cursor: 'default',
  },
  td: {
    padding: '9px 12px',
    verticalAlign: 'middle',
  },
  rowDot: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: '50%',
  },
  titleCell: {
    maxWidth: 320,
  },
  link: {
    color: '#fff',
    textDecoration: 'none',
    fontWeight: 500,
  },
  monoCell: {
    fontVariantNumeric: 'tabular-nums',
    fontSize: 12,
    color: 'rgba(255,255,255,0.75)',
    whiteSpace: 'nowrap',
  },
  catBadge: {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 500,
    padding: '2px 8px',
    borderRadius: 4,
    border: '1px solid',
    whiteSpace: 'nowrap',
  },
  emptyCell: {
    padding: '40px 12px',
    textAlign: 'center',
    color: 'rgba(255,255,255,0.3)',
    fontSize: 13,
  },
  qidRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 4,
  },
  qidChip: {
    fontSize: 10,
    fontFamily: 'ui-monospace, "SF Mono", monospace',
    color: 'rgba(255,255,255,0.45)',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 3,
    padding: '1px 5px',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  },
  pencilBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: 'rgba(255,255,255,0.2)',
    padding: '2px 3px',
    borderRadius: 3,
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    lineHeight: 1,
    transition: 'color 0.12s',
  },
};
