import { useState, useEffect, useCallback, useRef } from 'react';
import type { FeatureProperties, Category } from '../types';
import type { StackInfo } from './MapView';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../theme/categories';
import { CATEGORY_SVGS, colorSvg, svgDataUri } from '../theme/icons';
import { displayYear, encodeDate, STEP_DAY, STEP_MONTH, STEP_YEAR } from '../hooks/useTimeline';
import { WikiEditForm } from './WikiEditForm';

interface WikiSection {
  title: string;
  index: number;
  level: number;
}

interface WikiArticle {
  wikiTitle: string;
  images: string[];
  leadHtml: string;
  sections: WikiSection[];
}

interface Props {
  feature: FeatureProperties | null;
  stack: StackInfo;
  onClose: () => void;
  geojson?: GeoJSON.FeatureCollection;
  onNavigateToFeature?: (f: FeatureProperties) => void;
  wikiAuth: string | null;
  onAuth: (username: string | null) => void;
  onFeatureUpdated: (updates: Partial<FeatureProperties>) => void;
}

const WIKI_API = 'https://en.wikipedia.org/w/api.php';

function wikiParams(p: Record<string, string>): string {
  return new URLSearchParams({ format: 'json', origin: '*', ...p }).toString();
}

function fixWikiHtml(html: string): string {
  return html
    .replace(
      /href="(\/wiki\/[^"#]+)"/g,
      'target="_blank" rel="noopener noreferrer" href="https://en.wikipedia.org$1"',
    )
    .replace(/src="\/\/([^"]+)"/g, 'src="https://$1"')
    .replace(/srcset="\/\/([^"]+)"/g, 'srcset="https://$1"');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function PencilIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none" style={{ display: 'block' }}>
      <path d="M8.5 1.5l2 2-7 7H1.5v-2l7-7z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export function InfoPanel({ feature, stack, onClose, geojson, onNavigateToFeature, wikiAuth, onAuth, onFeatureUpdated }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [expandedWidth, setExpandedWidth] = useState(468);
  const [editField, setEditField] = useState<'date' | 'location' | 'capital' | 'sovereign' | null>(null);
  const [capitalDraft, setCapitalDraft] = useState<{ name: string; lat: string; lng: string } | null>(null);
  const [capitalSaving, setCapitalSaving] = useState(false);
  const [sovereignQuery, setSovereignQuery] = useState('');
  const [sovereignQidDraft, setSovereignQidDraft] = useState<string | null>(null);
  const [sovereignSaving, setSovereignSaving] = useState(false);
  const [article, setArticle] = useState<WikiArticle | null>(null);
  const [loading, setLoading] = useState(false);
  const [openSections, setOpenSections] = useState<Set<number>>(new Set());
  const [sectionHtml, setSectionHtml] = useState<Map<number, string>>(new Map());
  const [loadingSections, setLoadingSections] = useState<Set<number>>(new Set());
  const [imageIndex, setImageIndex] = useState(0);
  const [imageExpanded, setImageExpanded] = useState(false);

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: expandedWidth };
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const newWidth = Math.max(320, Math.min(900, dragRef.current.startWidth + (dragRef.current.startX - ev.clientX)));
      setExpandedWidth(newWidth);
    };

    const onUp = () => {
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [expandedWidth]);

  // Reset everything when a different feature is selected
  const [fetchedSummary, setFetchedSummary] = useState<string | null>(null);

  useEffect(() => {
    setExpanded(true);
    setArticle(null);
    setLoading(false);
    setFetchedSummary(null);
    setOpenSections(new Set());
    setSectionHtml(new Map());
    setLoadingSections(new Set());
    setImageIndex(0);
    setImageExpanded(false);
    setEditField(null);
    setCapitalDraft(null);
    setSovereignQuery('');
    setSovereignQidDraft(null);
  }, [feature?.title]);

  // On-demand summary fetch for features with no pre-populated wikipediaSummary
  useEffect(() => {
    if (!feature || feature.wikipediaSummary || !feature.wikipediaUrl) return;
    const match = feature.wikipediaUrl.match(/\/wiki\/([^#?]+)/);
    if (!match) return;
    const title = match[1];
    fetch(`${WIKI_API}?${wikiParams({ action: 'query', titles: title, prop: 'extracts', exintro: '1', explaintext: '1', exsentences: '3' })}`)
      .then((r) => r.json())
      .then((data) => {
        const pages = Object.values(data.query?.pages ?? {}) as Array<{ extract?: string }>;
        const extract = pages[0]?.extract?.trim();
        if (extract) setFetchedSummary(extract);
      })
      .catch(() => {});
  }, [feature?.title]);

  // Fetch lead + section list + thumbnail in parallel on expand
  useEffect(() => {
    if (!expanded || article !== null || !feature?.wikipediaUrl) return;
    const match = feature.wikipediaUrl.match(/\/wiki\/([^#?]+)/);
    if (!match) return;
    const title = match[1];

    setLoading(true);
    Promise.all([
      fetch(`${WIKI_API}?${wikiParams({ action: 'parse', page: title, section: '0', prop: 'text' })}`).then((r) => r.json()),
      fetch(`${WIKI_API}?${wikiParams({ action: 'parse', page: title, prop: 'sections' })}`).then((r) => r.json()),
      fetch(`${WIKI_API}?${wikiParams({ action: 'query', generator: 'images', titles: title, prop: 'imageinfo', iiprop: 'url|size|mime', iiurlwidth: '800', gimlimit: '30' })}`).then((r) => r.json()),
    ])
      .then(([leadRes, sectionsRes, imagesRes]) => {
        const leadHtml = fixWikiHtml(leadRes.parse?.text?.['*'] ?? '');
        const sections: WikiSection[] = (sectionsRes.parse?.sections ?? []).map(
          (s: { line?: string; index?: string; toclevel?: number }) => ({
            title: stripHtml(String(s.line ?? '')),
            index: Number(s.index ?? 0),
            level: Number(s.toclevel ?? 1),
          }),
        );
        type ImgPage = { imageinfo?: Array<{ url?: string; thumburl?: string; width?: number; mime?: string }> };
        const imgPages = Object.values(imagesRes?.query?.pages ?? {}) as ImgPage[];
        const images = imgPages
          .filter((p) => {
            const ii = p.imageinfo?.[0];
            if (!ii) return false;
            const mime = ii.mime ?? '';
            return mime.startsWith('image/') && mime !== 'image/svg+xml' && (ii.width ?? 0) >= 300;
          })
          .map((p) => p.imageinfo![0].thumburl ?? p.imageinfo![0].url ?? '')
          .filter(Boolean);
        setArticle({ wikiTitle: title, images, leadHtml, sections });
      })
      .catch(() => {
        const match2 = feature.wikipediaUrl!.match(/\/wiki\/([^#?]+)/);
        setArticle({ wikiTitle: match2?.[1] ?? '', images: [], leadHtml: '<p>Could not load article.</p>', sections: [] });
      })
      .finally(() => setLoading(false));
  }, [expanded, feature?.wikipediaUrl, article]);

  // Auto-open and pre-fetch the "History" section when article first loads
  useEffect(() => {
    if (!article || article.sections.length === 0) return;
    const history = article.sections.find((s) => s.title.toLowerCase() === 'history');
    if (!history) return;

    setOpenSections((prev) => new Set(prev).add(history.index));
    setLoadingSections((prev) => new Set(prev).add(history.index));
    fetch(`${WIKI_API}?${wikiParams({ action: 'parse', page: article.wikiTitle, section: String(history.index), prop: 'text' })}`)
      .then((r) => r.json())
      .then((data) => {
        setSectionHtml((prev) => new Map(prev).set(history.index, fixWikiHtml(data.parse?.text?.['*'] ?? '')));
      })
      .catch(() => {
        setSectionHtml((prev) => new Map(prev).set(history.index, '<p>Could not load section.</p>'));
      })
      .finally(() => {
        setLoadingSections((prev) => { const next = new Set(prev); next.delete(history.index); return next; });
      });
  }, [article]);

  // Intercept wiki-content link clicks — navigate on-map if the article exists in our dataset
  const handleBodyClick = useCallback((e: React.MouseEvent) => {
    if (!geojson || !onNavigateToFeature) return;
    const anchor = (e.target as Element).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    const match = href.match(/\/wiki\/([^#?]+)/);
    if (!match) return;
    const slug = decodeURIComponent(match[1]); // e.g. "Battle_of_Thermopylae"
    const slugSpaces = slug.replace(/_/g, ' ');
    const found = geojson.features.find((f) => {
      const p = f.properties as FeatureProperties;
      return p.wikipediaTitle === slug || p.wikipediaTitle === slugSpaces || p.slug === slug;
    });
    if (found) {
      e.preventDefault();
      onNavigateToFeature(found.properties as FeatureProperties);
    }
    // no match → let the link open normally in a new tab
  }, [geojson, onNavigateToFeature]);


  if (!feature) return null;

  const primaryColor = CATEGORY_COLORS[feature.primaryCategory as Category] ?? '#9E9E9E';

  // Build date string: null means no known date (permanent locations)
  const isLocation = feature.featureType === 'city' || feature.featureType === 'region' || feature.featureType === 'country';
  const isPolity = feature.featureType === 'polity';
  // Format a raw year/month/day to a display string at the highest available granularity
  const fmtDate = (year: number, month: number | null | undefined, day: number | null | undefined) => {
    const step = day != null ? STEP_DAY : month != null ? STEP_MONTH : STEP_YEAR;
    return displayYear(encodeDate(year, month ?? 1, day ?? 1), step);
  };

  let dateStr: string | null = null;
  const prefix = feature.dateIsFuzzy ? '~' : '';
  if (feature.yearStart != null && feature.yearEnd != null) {
    // Both known — show full range
    dateStr = `${prefix}${fmtDate(feature.yearStart, feature.monthStart, feature.dayStart)} – ${prefix}${fmtDate(feature.yearEnd, feature.monthEnd, feature.dayEnd)}`;
  } else if (feature.yearStart != null) {
    const startStr = `${prefix}${fmtDate(feature.yearStart, feature.monthStart, feature.dayStart)}`;
    // Locations without a known end date: show "– present"
    dateStr = isLocation ? `${startStr} – present` : startStr;
  } else if (feature.yearEnd != null) {
    // Only end date known (some polities/sultanates)
    dateStr = `? – ${prefix}${fmtDate(feature.yearEnd, feature.monthEnd, feature.dayEnd)}`;
  }

  const toggleSection = (section: WikiSection) => {
    const i = section.index;
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(i)) { next.delete(i); return next; }
      next.add(i);
      return next;
    });

    if (!sectionHtml.has(i) && !loadingSections.has(i) && article) {
      setLoadingSections((prev) => new Set(prev).add(i));
      fetch(`${WIKI_API}?${wikiParams({ action: 'parse', page: article.wikiTitle, section: String(i), prop: 'text' })}`)
        .then((r) => r.json())
        .then((data) => {
          setSectionHtml((prev) => new Map(prev).set(i, fixWikiHtml(data.parse?.text?.['*'] ?? '<p>Empty section.</p>')));
        })
        .catch(() => {
          setSectionHtml((prev) => new Map(prev).set(i, '<p>Could not load section.</p>'));
        })
        .finally(() => {
          setLoadingSections((prev) => { const next = new Set(prev); next.delete(i); return next; });
        });
    }
  };

  return (
    <div style={{
      ...styles.panel,
      width: expanded ? expandedWidth : 360,
      height: expanded ? 'calc(100vh - 136px)' : 'auto',
      maxHeight: 'calc(100vh - 220px)',
      overflow: expanded ? 'hidden' : 'visible',
      transition: dragRef.current ? 'none' : 'width 0.25s ease',
    }}>
      {/* Resize handle — left edge, expanded only */}
      {expanded && (
        <div className="resize-handle" onMouseDown={startDrag} />
      )}
      {/* Accent bar */}
      <div style={{ ...styles.accent, background: primaryColor }} />

      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          {feature.categories.map((cat) => {
            const color   = CATEGORY_COLORS[cat as Category] ?? '#9E9E9E';
            const rawSvg  = CATEGORY_SVGS[cat as Category];
            const iconSrc = rawSvg ? svgDataUri(colorSvg(rawSvg, color)) : null;
            return (
              <span
                key={cat}
                style={{
                  ...styles.tag,
                  background: `${color}22`,
                  color,
                  borderColor: `${color}44`,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                {iconSrc && (
                  <img src={iconSrc} width={12} height={12} style={{ flexShrink: 0, display: 'block' }} />
                )}
                {CATEGORY_LABELS[cat as Category] ?? cat}
              </span>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {expanded && (
            <button style={styles.iconBtn} onClick={() => setExpanded(false)} title="Collapse">←</button>
          )}
          <button style={styles.iconBtn} onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {/* Image carousel — expanded only */}
      {expanded && (
        article && article.images.length > 0
          ? (
            <div style={{ position: 'relative', flexShrink: 0, background: '#000', cursor: 'pointer' }} onClick={() => setImageExpanded((v) => !v)}>
              <img
                src={article.images[imageIndex]}
                alt={`${feature.title} ${imageIndex + 1}`}
                style={{
                  width: '100%',
                  height: imageExpanded ? 'auto' : 240,
                  maxHeight: imageExpanded ? '55vh' : 240,
                  objectFit: imageExpanded ? 'contain' : 'cover',
                  display: 'block',
                }}
              />
              {article.images.length > 1 && (
                <>
                  <button style={{ ...styles.imgArrow, left: 8 }} onClick={(e) => { e.stopPropagation(); setImageIndex((i) => (i - 1 + article.images.length) % article.images.length); }}>‹</button>
                  <button style={{ ...styles.imgArrow, right: 8 }} onClick={(e) => { e.stopPropagation(); setImageIndex((i) => (i + 1) % article.images.length); }}>›</button>
                  <div style={styles.imgCounter}>{imageIndex + 1} / {article.images.length}</div>
                </>
              )}
            </div>
          )
          : loading
            ? (
              <div style={styles.imageLoader}>
                <div style={styles.spinner} />
              </div>
            )
            : null
      )}

      {/* Title + date on same row */}
      <div style={styles.titleRow}>
        <h2 style={styles.title}>{feature.title}</h2>
        {dateStr && (
          <div style={styles.dateBlock}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <div style={styles.dateMain}>{dateStr}</div>
              {(feature.featureType === 'event' || feature.featureType === 'polity') && (
                <button style={styles.pencilBtn} onClick={() => setEditField(f => f === 'date' ? null : 'date')} title="Correct this date on Wikipedia">
                  <PencilIcon />
                </button>
              )}
            </div>
            {feature.dateIsFuzzy && feature.dateRangeMin != null && feature.dateRangeMax != null && (
              <div style={styles.dateRange}>
                est. {displayYear(encodeDate(feature.dateRangeMin!))} – {displayYear(encodeDate(feature.dateRangeMax!))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Meta — location only */}
      {feature.locationName && feature.locationName !== feature.title && (() => {
        const locFeature = geojson?.features.find((f) => {
          const p = f.properties as FeatureProperties;
          return p.title === feature.locationName &&
            (p.featureType === 'city' || p.featureType === 'region' || p.featureType === 'country');
        });
        return (
          <div style={styles.meta}>
            {locFeature && onNavigateToFeature
              ? (
                <span
                  style={{ ...styles.metaLocation, color: '#3366cc', cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => onNavigateToFeature(locFeature.properties as FeatureProperties)}
                >
                  {feature.locationName}
                </span>
              )
              : <span style={styles.metaLocation}>{feature.locationName}</span>
            }
            {(feature.featureType === 'event' || feature.featureType === 'polity') && (
              <button style={{ ...styles.pencilBtn, marginLeft: 4 }} onClick={() => setEditField(f => f === 'location' ? null : 'location')} title="Correct this location on Wikipedia">
                <PencilIcon />
              </button>
            )}
          </div>
        );
      })()}

      {/* Capital — polities only */}
      {isPolity && (() => {
        const capFeature = feature.capitalName ? geojson?.features.find((f) => {
          const p = f.properties as FeatureProperties;
          return feature.capitalWikidataQid
            ? p.wikidataQid === feature.capitalWikidataQid
            : p.title === feature.capitalName && (p.featureType === 'city' || p.featureType === 'region' || p.featureType === 'country');
        }) : undefined;
        return (
          <>
            <div style={styles.meta}>
              <span style={{ ...styles.metaLocation, color: '#9a9a9a', fontSize: 12, marginRight: 4 }}>Capital:</span>
              {feature.capitalName
                ? capFeature && onNavigateToFeature
                  ? (
                    <span
                      style={{ ...styles.metaLocation, color: '#3366cc', cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={() => onNavigateToFeature(capFeature.properties as FeatureProperties)}
                    >
                      {feature.capitalName}
                    </span>
                  )
                  : <span style={styles.metaLocation}>{feature.capitalName}</span>
                : <span style={{ ...styles.metaLocation, color: '#b0b0b0', fontStyle: 'italic' }}>unknown</span>
              }
              <button
                style={{ ...styles.pencilBtn, marginLeft: 4 }}
                onClick={() => {
                  setCapitalDraft({ name: feature.capitalName ?? '', lat: '', lng: '' });
                  setEditField(f => f === 'capital' ? null : 'capital');
                }}
                title="Correct this capital"
              >
                <PencilIcon />
              </button>
            </div>
            {editField === 'capital' && capitalDraft && (
              <div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  style={styles.editInput}
                  placeholder="Capital name"
                  value={capitalDraft.name}
                  onChange={e => setCapitalDraft(d => d && ({ ...d, name: e.target.value }))}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    style={{ ...styles.editInput, flex: 1 }}
                    placeholder="Latitude"
                    type="number"
                    step="any"
                    value={capitalDraft.lat}
                    onChange={e => setCapitalDraft(d => d && ({ ...d, lat: e.target.value }))}
                  />
                  <input
                    style={{ ...styles.editInput, flex: 1 }}
                    placeholder="Longitude"
                    type="number"
                    step="any"
                    value={capitalDraft.lng}
                    onChange={e => setCapitalDraft(d => d && ({ ...d, lng: e.target.value }))}
                  />
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    style={{ ...styles.saveBtn, opacity: capitalSaving ? 0.6 : 1 }}
                    disabled={capitalSaving || !capitalDraft.name.trim()}
                    onClick={async () => {
                      if (!capitalDraft.name.trim()) return;
                      setCapitalSaving(true);
                      const body: Record<string, unknown> = { capital_name: capitalDraft.name.trim(), capital_wikidata_qid: null };
                      const lat = parseFloat(capitalDraft.lat);
                      const lng = parseFloat(capitalDraft.lng);
                      if (!isNaN(lat) && !isNaN(lng)) { body.lat = lat; body.lng = lng; }
                      try {
                        const res = await fetch(`http://localhost:8000/api/polities/${feature.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(body),
                        });
                        if (res.ok) {
                          const updates: Partial<FeatureProperties> & { _coords?: [number, number] } = { capitalName: capitalDraft.name.trim(), capitalWikidataQid: null };
                          if (!isNaN(lat) && !isNaN(lng)) updates._coords = [lng, lat];
                          onFeatureUpdated(updates);
                          setEditField(null);
                          setCapitalDraft(null);
                        }
                      } finally {
                        setCapitalSaving(false);
                      }
                    }}
                  >
                    {capitalSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button style={styles.cancelBtn} onClick={() => { setEditField(null); setCapitalDraft(null); }}>Cancel</button>
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* Sovereign — polities only */}
      {isPolity && (() => {
        const sovFeature = feature.sovereignName ? geojson?.features.find((f) => {
          const p = f.properties as FeatureProperties;
          return p.featureType === 'polity' && (feature.sovereignSlug ? p.slug === feature.sovereignSlug : p.title === feature.sovereignName);
        }) : undefined;

        const polityMatches = editField === 'sovereign' && sovereignQuery.trim().length > 0
          ? (geojson?.features ?? [])
              .filter((f) => {
                const p = f.properties as FeatureProperties;
                return p.featureType === 'polity'
                  && p.id !== feature.id
                  && p.title?.toLowerCase().includes(sovereignQuery.toLowerCase());
              })
              .slice(0, 8)
              .map((f) => f.properties as FeatureProperties)
          : [];

        return (
          <>
            <div style={styles.meta}>
              <span style={{ ...styles.metaLocation, color: '#9a9a9a', fontSize: 12, marginRight: 4 }}>Part of:</span>
              {feature.sovereignName
                ? sovFeature && onNavigateToFeature
                  ? (
                    <span
                      style={{ ...styles.metaLocation, color: '#3366cc', cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={() => onNavigateToFeature(sovFeature.properties as FeatureProperties)}
                    >
                      {feature.sovereignName}
                    </span>
                  )
                  : <span style={styles.metaLocation}>{feature.sovereignName}</span>
                : <span style={{ ...styles.metaLocation, color: '#b0b0b0', fontStyle: 'italic' }}>—</span>
              }
              <button
                style={{ ...styles.pencilBtn, marginLeft: 4 }}
                onClick={() => {
                  setSovereignQuery(feature.sovereignName ?? '');
                  setSovereignQidDraft(feature.sovereignQid ?? null);
                  setEditField(f => f === 'sovereign' ? null : 'sovereign');
                }}
                title="Edit sovereign / parent polity"
              >
                <PencilIcon />
              </button>
            </div>
            {editField === 'sovereign' && (
              <div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  style={styles.editInput}
                  placeholder="Search polities…"
                  value={sovereignQuery}
                  autoFocus
                  onChange={e => { setSovereignQuery(e.target.value); setSovereignQidDraft(null); }}
                />
                {polityMatches.length > 0 && (
                  <div style={{ border: '1px solid rgba(0,0,0,0.12)', borderRadius: 5, overflow: 'hidden', maxHeight: 160, overflowY: 'auto' }}>
                    {polityMatches.map((p) => (
                      <button
                        key={p.id}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
                          background: sovereignQidDraft === p.wikidataQid ? 'rgba(51,102,204,0.1)' : 'transparent',
                          border: 'none', borderBottom: '1px solid rgba(0,0,0,0.06)',
                          fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', color: '#202122',
                        }}
                        onClick={() => { setSovereignQuery(p.title); setSovereignQidDraft(p.wikidataQid ?? null); }}
                      >
                        <span style={{ fontWeight: 500 }}>{p.title}</span>
                        <span style={{ color: '#9a9a9a', marginLeft: 6 }}>
                          {p.yearStart != null ? p.yearDisplay : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    style={{ ...styles.saveBtn, opacity: sovereignSaving || !sovereignQidDraft ? 0.6 : 1 }}
                    disabled={sovereignSaving || !sovereignQidDraft}
                    onClick={async () => {
                      if (!sovereignQidDraft) return;
                      setSovereignSaving(true);
                      try {
                        const res = await fetch(`http://localhost:8000/api/polities/${feature.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ sovereign_qids: [sovereignQidDraft] }),
                        });
                        if (res.ok) {
                          const selectedPolity = geojson?.features.find(
                            f => (f.properties as FeatureProperties).wikidataQid === sovereignQidDraft
                          )?.properties as FeatureProperties | undefined;
                          onFeatureUpdated({
                            sovereignName: selectedPolity?.title ?? sovereignQuery,
                            sovereignSlug: selectedPolity?.slug ?? null,
                            sovereignQid: sovereignQidDraft,
                          });
                          setEditField(null);
                        }
                      } finally {
                        setSovereignSaving(false);
                      }
                    }}
                  >
                    {sovereignSaving ? 'Saving…' : 'Save'}
                  </button>
                  {feature.sovereignQid && (
                    <button
                      style={{ ...styles.cancelBtn, color: '#c62828' }}
                      disabled={sovereignSaving}
                      onClick={async () => {
                        setSovereignSaving(true);
                        try {
                          const res = await fetch(`http://localhost:8000/api/polities/${feature.id}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sovereign_qids: [] }),
                          });
                          if (res.ok) {
                            onFeatureUpdated({ sovereignName: undefined, sovereignSlug: undefined, sovereignQid: undefined });
                            setEditField(null);
                          }
                        } finally {
                          setSovereignSaving(false);
                        }
                      }}
                    >
                      Clear
                    </button>
                  )}
                  <button style={styles.cancelBtn} onClick={() => setEditField(null)}>Cancel</button>
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* Inline correction form */}
      {editField && feature.wikipediaTitle && (
        <WikiEditForm
          feature={feature}
          field={editField}
          wikiAuth={wikiAuth}
          onAuth={onAuth}
          onSuccess={(updates) => {
            onFeatureUpdated(updates);
            setEditField(null);
          }}
          onClose={() => setEditField(null)}
        />
      )}

      {/* Part of — hierarchy chips (events with P361 data only) */}
      {feature.featureType === 'event' && feature.partOfResolved && feature.partOfResolved.length > 0 && (() => {
        const resolved: { qid: string; title: string; slug: string }[] = Array.isArray(feature.partOfResolved)
          ? feature.partOfResolved
          : typeof feature.partOfResolved === 'string'
            ? (() => { try { return JSON.parse(feature.partOfResolved as unknown as string); } catch { return []; } })()
            : [];
        return (
          <div style={styles.partOfRow}>
            <span style={styles.partOfLabel}>Part of</span>
            <div style={styles.partOfChips}>
              {resolved.map(({ qid, title, slug }) => {
                const parentFeature = geojson?.features.find((f) => {
                  const p = f.properties as FeatureProperties;
                  return p.slug === slug || p.slug === qid || p.wikipediaTitle === slug;
                });
                return parentFeature && onNavigateToFeature ? (
                  <button
                    key={qid}
                    style={styles.partOfChip}
                    onClick={() => onNavigateToFeature(parentFeature.properties as FeatureProperties)}
                    title={title}
                  >
                    {title} →
                  </button>
                ) : (
                  <span key={qid} style={{ ...styles.partOfChip, cursor: 'default', opacity: 0.6 }}>
                    {title}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })()}

      <div style={styles.divider} />

      {/* Body — scrollable only when expanded */}
      <div ref={bodyRef} onClick={handleBodyClick} style={{
        ...styles.body,
        flex: expanded ? 1 : undefined,
        overflowY: expanded ? 'auto' : 'visible',
      }}>
        {!expanded ? (
          (feature.wikipediaSummary || fetchedSummary) && (
            <p style={styles.summary}>{feature.wikipediaSummary || fetchedSummary}</p>
          )
        ) : loading ? (
          (feature.wikipediaSummary || fetchedSummary) && (
            <p style={styles.summary}>{feature.wikipediaSummary || fetchedSummary}</p>
          )
        ) : article ? (
          <>
            {/* Lead section */}
            <div
              className="wiki-content"
              style={styles.leadContent}
              dangerouslySetInnerHTML={{ __html: article.leadHtml }}
            />

            {/* Sections accordion — skip pure reference/footnote sections */}
            {article.sections.filter((s) => !/^(references?|notes?|footnotes?|citations?|bibliography|further reading|external links?|see also)$/i.test(s.title)).map((section) => {
              const isOpen = openSections.has(section.index);
              const html = sectionHtml.get(section.index);
              const isLoadingSection = loadingSections.has(section.index);
              return (
                <div key={section.index} data-section={section.index} style={styles.sectionWrap}>
                  <button
                    style={{
                      ...styles.sectionHeader,
                      paddingLeft: 16 + Math.max(0, section.level - 1) * 12,
                    }}
                    onClick={() => toggleSection(section)}
                  >
                    <span style={{
                      ...styles.sectionTitle,
                      fontWeight: section.level === 1 ? 700 : 500,
                      fontSize: section.level === 1 ? 13 : 12,
                    }}>
                      {section.title}
                    </span>
                    <span style={styles.chevron}>{isOpen ? '▲' : '▼'}</span>
                  </button>
                  {isOpen && (
                    isLoadingSection || !html ? (
                      <p style={{ ...styles.loadingText, padding: '6px 16px 12px' }}>Loading…</p>
                    ) : (
                      <div
                        className="wiki-content"
                        style={styles.sectionBody}
                        dangerouslySetInnerHTML={{ __html: html }}
                      />
                    )
                  )}
                </div>
              );
            })}
          </>
        ) : null}
      </div>

      {/* Footer */}
      <div style={{ ...styles.footer, borderTop: expanded ? '1px solid rgba(0,0,0,0.07)' : 'none' }}>
        {!expanded ? (
          <>
            {feature.wikipediaUrl && (
              <button style={styles.readBtn} onClick={() => setExpanded(true)}>
                Read article ↓
              </button>
            )}
            {feature.wikipediaUrl && (
              <a href={feature.wikipediaUrl} target="_blank" rel="noopener noreferrer" style={styles.extBtn} title="Open in Wikipedia">
                ↗
              </a>
            )}
            {stack.total > 1 && <StackDots stack={stack} />}
          </>
        ) : (
          <>
            {feature.wikipediaUrl && (
              <a href={feature.wikipediaUrl} target="_blank" rel="noopener noreferrer" style={styles.wikiBtn}>
                Open in Wikipedia ↗
              </a>
            )}
            {stack.total > 1 && <StackDots stack={stack} />}
          </>
        )}
      </div>
    </div>
  );
}

function StackDots({ stack }: { stack: StackInfo }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
      {Array.from({ length: stack.total }, (_, i) => (
        <div
          key={i}
          style={{
            height: 6,
            borderRadius: 3,
            transition: 'all 0.2s ease',
            background: i === stack.index ? '#202122' : 'rgba(0,0,0,0.2)',
            width: i === stack.index ? 16 : 6,
          }}
        />
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'fixed',
    top: 100,
    right: 16,
    width: 360,
    background: '#ffffff',
    borderRadius: 12,
    border: '1px solid rgba(0,0,0,0.1)',
    boxShadow: '0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
    zIndex: 90,
    color: '#202122',
    display: 'flex',
    flexDirection: 'column',
    animation: 'slideInRight 0.2s ease',
  },
  accent: {
    height: 3,
    flexShrink: 0,
    borderRadius: '12px 12px 0 0',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 14px 10px',
    gap: 8,
    flexShrink: 0,
  },
  headerLeft: {
    display: 'flex',
    gap: 6,
    flexWrap: 'wrap',
    minWidth: 0,
  },
  iconBtn: {
    background: 'rgba(0,0,0,0.05)',
    border: '1px solid rgba(0,0,0,0.1)',
    borderRadius: 6,
    color: '#54595d',
    fontSize: 12,
    width: 26,
    height: 26,
    cursor: 'pointer',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'inherit',
  },
  tag: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 4,
    border: '1px solid',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    whiteSpace: 'nowrap' as const,
  },
  imgArrow: {
    position: 'absolute' as const,
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'rgba(0,0,0,0.55)',
    border: 'none',
    color: '#fff',
    fontSize: 22,
    width: 30,
    height: 30,
    borderRadius: '50%',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'inherit',
    lineHeight: 1,
  },
  imgCounter: {
    position: 'absolute' as const,
    bottom: 6,
    right: 8,
    background: 'rgba(0,0,0,0.5)',
    color: '#fff',
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 7px',
    borderRadius: 10,
  },
  imageLoader: {
    width: '100%',
    height: 240,
    flexShrink: 0,
    background: 'rgba(0,0,0,0.04)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinner: {
    width: 32,
    height: 32,
    borderRadius: '50%',
    border: '3px solid rgba(0,0,0,0.1)',
    borderTopColor: '#3366cc',
    animation: 'spin 0.8s linear infinite',
  },
  titleRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '10px 16px 8px',
    flexShrink: 0,
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: 700,
    lineHeight: 1.35,
    color: '#202122',
    letterSpacing: '-0.01em',
    minWidth: 0,
  },
  dateBlock: {
    flexShrink: 0,
    textAlign: 'right' as const,
    paddingTop: 2,
  },
  dateMain: {
    fontSize: 12,
    fontWeight: 600,
    color: '#54595d',
    whiteSpace: 'nowrap' as const,
    letterSpacing: '0.01em',
  },
  dateRange: {
    fontSize: 11,
    color: '#9a9a9a',
    whiteSpace: 'nowrap' as const,
    marginTop: 2,
  },
  meta: {
    padding: '0 16px 8px',
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
  },
  metaLocation: { fontSize: 13, color: '#54595d' },
  pencilBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: '#b0b0b0',
    padding: '2px 3px',
    borderRadius: 4,
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    lineHeight: 1,
  },
  partOfRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '0 16px 12px',
    flexShrink: 0,
  },
  partOfLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: '#9a9a9a',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    whiteSpace: 'nowrap' as const,
    paddingTop: 3,
  },
  partOfChips: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: 4,
  },
  partOfChip: {
    fontSize: 11,
    fontWeight: 500,
    color: '#3366cc',
    background: 'rgba(51,102,204,0.08)',
    border: '1px solid rgba(51,102,204,0.2)',
    borderRadius: 4,
    padding: '2px 8px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap' as const,
    maxWidth: 200,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  editInput: {
    fontSize: 12,
    padding: '5px 8px',
    borderRadius: 5,
    border: '1px solid rgba(0,0,0,0.18)',
    fontFamily: 'inherit',
    background: '#fafafa',
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  saveBtn: {
    fontSize: 12,
    fontWeight: 600,
    color: '#fff',
    background: '#3366cc',
    border: 'none',
    borderRadius: 5,
    padding: '5px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  cancelBtn: {
    fontSize: 12,
    color: '#54595d',
    background: 'rgba(0,0,0,0.05)',
    border: '1px solid rgba(0,0,0,0.1)',
    borderRadius: 5,
    padding: '5px 10px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  divider: {
    height: 1,
    background: 'rgba(0,0,0,0.07)',
    flexShrink: 0,
  },
  body: {
    minHeight: 0,
  },
  summary: {
    fontSize: 13.5,
    lineHeight: 1.65,
    color: '#54595d',
    padding: '14px 16px',
  },
  loadingText: {
    fontSize: 13,
    color: '#9a9a9a',
    padding: '14px 16px',
  },
  leadContent: {
    padding: '14px 16px 4px',
  },
  sectionWrap: {
    borderTop: '1px solid rgba(0,0,0,0.06)',
  },
  sectionHeader: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 16,
    paddingTop: 10,
    paddingBottom: 10,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left' as const,
    gap: 8,
  },
  sectionTitle: {
    color: '#202122',
    flex: 1,
    minWidth: 0,
  },
  chevron: {
    fontSize: 8,
    color: '#9a9a9a',
    flexShrink: 0,
  },
  sectionBody: {
    padding: '0 16px 14px',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 16px',
    flexShrink: 0,
  },
  readBtn: {
    fontSize: 12,
    fontWeight: 600,
    color: '#ffffff',
    background: '#3366cc',
    border: 'none',
    borderRadius: 6,
    padding: '6px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    letterSpacing: '0.01em',
    whiteSpace: 'nowrap' as const,
  },
  extBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    background: 'rgba(0,0,0,0.04)',
    border: '1px solid rgba(0,0,0,0.1)',
    borderRadius: 6,
    fontSize: 13,
    color: '#54595d',
    textDecoration: 'none',
    flexShrink: 0,
  },
  wikiBtn: {
    fontSize: 12,
    fontWeight: 600,
    color: '#ffffff',
    background: '#3366cc',
    border: 'none',
    borderRadius: 6,
    padding: '6px 12px',
    textDecoration: 'none',
    letterSpacing: '0.01em',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap' as const,
  },
};
