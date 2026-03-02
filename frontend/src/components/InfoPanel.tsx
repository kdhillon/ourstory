import { useState, useEffect, useCallback, useRef } from 'react';
import type { FeatureProperties, Category } from '../types';
import type { StackInfo } from './MapView';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../theme/categories';
import { displayYear } from '../hooks/useTimeline';

interface WikiSection {
  title: string;
  index: number;
  level: number;
}

interface WikiArticle {
  wikiTitle: string;
  leadImage?: string;
  leadHtml: string;
  sections: WikiSection[];
}

interface Props {
  feature: FeatureProperties | null;
  stack: StackInfo;
  onClose: () => void;
  geojson?: GeoJSON.FeatureCollection;
  onNavigateToFeature?: (f: FeatureProperties) => void;
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

export function InfoPanel({ feature, stack, onClose, geojson, onNavigateToFeature }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [expandedWidth, setExpandedWidth] = useState(468);
  const [article, setArticle] = useState<WikiArticle | null>(null);
  const [loading, setLoading] = useState(false);
  const [openSections, setOpenSections] = useState<Set<number>>(new Set());
  const [sectionHtml, setSectionHtml] = useState<Map<number, string>>(new Map());
  const [loadingSections, setLoadingSections] = useState<Set<number>>(new Set());

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollToSection = useRef<number | null>(null);

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
    setExpanded(false);
    setArticle(null);
    setLoading(false);
    setFetchedSummary(null);
    setOpenSections(new Set());
    setSectionHtml(new Map());
    setLoadingSections(new Set());
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
      fetch(`${WIKI_API}?${wikiParams({ action: 'query', titles: title, prop: 'pageimages', pithumbsize: '640' })}`).then((r) => r.json()),
    ])
      .then(([leadRes, sectionsRes, imageRes]) => {
        const leadHtml = fixWikiHtml(leadRes.parse?.text?.['*'] ?? '');
        const sections: WikiSection[] = (sectionsRes.parse?.sections ?? []).map(
          (s: { line?: string; index?: string; toclevel?: number }) => ({
            title: stripHtml(String(s.line ?? '')),
            index: Number(s.index ?? 0),
            level: Number(s.toclevel ?? 1),
          }),
        );
        const pages = Object.values(imageRes?.query?.pages ?? {}) as Array<{ thumbnail?: { source: string } }>;
        const leadImage = pages[0]?.thumbnail?.source;
        setArticle({ wikiTitle: title, leadImage, leadHtml, sections });
      })
      .catch(() => {
        const match2 = feature.wikipediaUrl!.match(/\/wiki\/([^#?]+)/);
        setArticle({ wikiTitle: match2?.[1] ?? '', leadHtml: '<p>Could not load article.</p>', sections: [] });
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
    scrollToSection.current = history.index;
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

  // Scroll to a pending section once its HTML has loaded
  useEffect(() => {
    const idx = scrollToSection.current;
    if (idx === null || !sectionHtml.has(idx) || !bodyRef.current) return;
    const el = bodyRef.current.querySelector<HTMLElement>(`[data-section="${idx}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    scrollToSection.current = null;
  }, [sectionHtml]);

  if (!feature) return null;

  const primaryColor = CATEGORY_COLORS[feature.primaryCategory as Category] ?? '#9E9E9E';

  // Build date string: null means no known date (permanent locations)
  const isLocation = feature.featureType === 'city' || feature.featureType === 'region' || feature.featureType === 'country';
  let dateStr: string | null = null;
  if (feature.yearStart != null) {
    const prefix = feature.dateIsFuzzy ? '~' : '';
    if (feature.yearEnd != null) {
      dateStr = `${prefix}${displayYear(feature.yearStart)} – ${prefix}${displayYear(feature.yearEnd)}`;
    } else if (isLocation) {
      dateStr = `${prefix}${displayYear(feature.yearStart)} – present`;
    } else {
      dateStr = `${prefix}${displayYear(feature.yearStart)}`;
    }
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
      maxHeight: 'calc(100vh - 136px)',
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
          {feature.categories.map((cat) => (
            <span
              key={cat}
              style={{
                ...styles.tag,
                background: `${CATEGORY_COLORS[cat as Category] ?? '#9E9E9E'}22`,
                color: CATEGORY_COLORS[cat as Category] ?? '#9E9E9E',
                borderColor: `${CATEGORY_COLORS[cat as Category] ?? '#9E9E9E'}44`,
              }}
            >
              {CATEGORY_LABELS[cat as Category] ?? cat}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {expanded && (
            <button style={styles.iconBtn} onClick={() => setExpanded(false)} title="Collapse">←</button>
          )}
          <button style={styles.iconBtn} onClick={onClose} title="Close">✕</button>
        </div>
      </div>

      {/* Lead image — expanded only */}
      {expanded && article?.leadImage && (
        <img src={article.leadImage} alt={feature.title} style={styles.leadImage} />
      )}

      {/* Title + date on same row */}
      <div style={styles.titleRow}>
        <h2 style={styles.title}>{feature.title}</h2>
        {dateStr && (
          <div style={styles.dateBlock}>
            <div style={styles.dateMain}>{dateStr}</div>
            {feature.dateIsFuzzy && feature.dateRangeMin != null && feature.dateRangeMax != null && (
              <div style={styles.dateRange}>
                est. {displayYear(feature.dateRangeMin)} – {displayYear(feature.dateRangeMax)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Meta — location only */}
      {feature.locationName && feature.locationName !== feature.title && (
        <div style={styles.meta}>
          <span style={styles.metaLocation}>{feature.locationName}</span>
        </div>
      )}

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
          <p style={styles.loadingText}>Loading article…</p>
        ) : article ? (
          <>
            {/* Lead section */}
            <div
              className="wiki-content"
              style={styles.leadContent}
              dangerouslySetInnerHTML={{ __html: article.leadHtml }}
            />

            {/* Sections accordion */}
            {article.sections.map((section) => {
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
    top: 64,
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
  leadImage: {
    width: '100%',
    height: 180,
    objectFit: 'cover' as const,
    flexShrink: 0,
    display: 'block',
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
    padding: '0 16px 12px',
    flexShrink: 0,
  },
  metaLocation: { fontSize: 13, color: '#54595d' },
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
