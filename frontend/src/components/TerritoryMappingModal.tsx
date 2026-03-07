import { useState, useMemo, useRef, useEffect } from 'react';
import type { FeatureProperties } from '../types';
import { assignPolygon, importPolityFromWikidata, deleteTerritoryRow, updateTerritoryYears } from '../lib/api';
import type { AssignResult } from '../lib/api';
import { searchEntities } from '../lib/wikidataApi';
import type { EntityResult } from '../lib/wikidataApi';

interface Props {
  hbName: string;
  polygonId: string;
  yearStart: number;
  yearEnd: number | null;
  polities: FeatureProperties[];
  onClose: () => void;
  onPolityImported?: (feature: GeoJSON.Feature) => void;
  onSaved?: (polityId: string, polityName: string) => void;
  onDeleted?: () => void;
  onYearsUpdated?: () => void;
}

interface OverlapInfo {
  overlaps: boolean;
  sliceStart: number;
  sliceEnd: number | null;
  hasBefore: boolean;
  hasAfter: boolean;
}

function computeOverlap(polity: FeatureProperties, intervalStart: number, intervalEnd: number | null): OverlapInfo {
  const ps = polity.yearStart ?? -9999;
  const pe = polity.yearEnd   ??  9999;
  const ie = intervalEnd      ??  9999;
  if (ps > ie || pe < intervalStart) {
    return { overlaps: false, sliceStart: 0, sliceEnd: null, hasBefore: false, hasAfter: false };
  }
  const sliceStart = Math.max(ps, intervalStart);
  let sliceEnd: number | null;
  if (polity.yearEnd === null && intervalEnd === null) sliceEnd = null;
  else if (polity.yearEnd === null) sliceEnd = intervalEnd;
  else if (intervalEnd === null)    sliceEnd = polity.yearEnd;
  else sliceEnd = Math.min(polity.yearEnd, intervalEnd);
  return {
    overlaps: true,
    sliceStart,
    sliceEnd,
    hasBefore: sliceStart > intervalStart,
    hasAfter:  sliceEnd !== null && (intervalEnd === null || sliceEnd < intervalEnd),
  };
}

export function TerritoryMappingModal({ hbName, polygonId, yearStart, yearEnd, polities, onClose, onPolityImported, onSaved, onDeleted, onYearsUpdated }: Props) {
  // ── Year editing ───────────────────────────────────────────────────────────
  const [savedYearStart, setSavedYearStart] = useState(yearStart);
  const [savedYearEnd,   setSavedYearEnd]   = useState(yearEnd);
  const [localYearStart, setLocalYearStart] = useState(String(yearStart));
  const [localYearEnd,   setLocalYearEnd]   = useState(yearEnd === null ? '' : String(yearEnd));
  const [yearSaving, setYearSaving]         = useState(false);
  const [yearFlash,  setYearFlash]          = useState<'saved' | 'error' | null>(null);

  const intervalStart = savedYearStart;
  const intervalEnd   = savedYearEnd;

  const yearsChanged =
    localYearStart !== String(savedYearStart) ||
    localYearEnd   !== (savedYearEnd === null ? '' : String(savedYearEnd));

  const handleUpdateYears = async () => {
    const ys = parseInt(localYearStart, 10);
    if (isNaN(ys)) return;
    const ye = localYearEnd.trim() ? parseInt(localYearEnd, 10) : null;
    if (ye !== null && isNaN(ye)) return;
    setYearSaving(true);
    try {
      await updateTerritoryYears(polygonId, ys, ye);
      setSavedYearStart(ys);
      setSavedYearEnd(ye);
      setYearFlash('saved');
      setTimeout(() => setYearFlash(null), 2000);
      onYearsUpdated?.();
    } catch {
      setYearFlash('error');
      setTimeout(() => setYearFlash(null), 3000);
    } finally {
      setYearSaving(false);
    }
  };

  // ── Delete ─────────────────────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting]           = useState(false);
  const [deleteError, setDeleteError]     = useState<string | null>(null);

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteTerritoryRow(polygonId);
      onDeleted?.();
    } catch (e) {
      setDeleteError((e as Error).message);
      setDeleting(false);
    }
  };

  // ── Polity assignment ──────────────────────────────────────────────────────
  const [query, setQuery]               = useState(hbName);
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [status, setStatus]             = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [assignResult, setAssignResult] = useState<AssignResult | null>(null);

  const [wdResults, setWdResults]     = useState<EntityResult[]>([]);
  const [wdLoading, setWdLoading]     = useState(false);
  const [wdOpen, setWdOpen]           = useState(true);
  const [importingQid, setImportingQid] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    const matches = q
      ? polities.filter((p) => p.title.toLowerCase().includes(q))
      : polities;
    const overlaps = matches
      .filter((p) => computeOverlap(p, intervalStart, intervalEnd).overlaps)
      .sort((a, b) => {
        const lifeA = (a.yearStart != null && a.yearEnd != null) ? a.yearEnd - a.yearStart : Infinity;
        const lifeB = (b.yearStart != null && b.yearEnd != null) ? b.yearEnd - b.yearStart : Infinity;
        return lifeA - lifeB;
      });
    const outside = matches.filter((p) => !computeOverlap(p, intervalStart, intervalEnd).overlaps);
    return [...overlaps, ...outside].slice(0, 40);
  }, [query, polities, intervalStart, intervalEnd]);

  const existingQids = useMemo(() => new Set(polities.map((p) => p.wikidataQid).filter(Boolean)), [polities]);

  useEffect(() => {
    if (!wdOpen) return;
    let cancelled = false;
    setWdLoading(true);
    setWdResults([]);
    searchEntities(query.trim() || hbName)
      .then((r) => { if (!cancelled) setWdResults(r.filter((x) => !existingQids.has(x.id))); })
      .catch(() => { if (!cancelled) setWdResults([]); })
      .finally(() => { if (!cancelled) setWdLoading(false); });
    return () => { cancelled = true; };
  }, [query, wdOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = polities.find((p) => p.id === selectedId) ?? null;
  const overlap  = selected ? computeOverlap(selected, intervalStart, intervalEnd) : null;
  const canSave  = !!selected && (overlap?.overlaps ?? false);

  async function handleSave(polity?: FeatureProperties) {
    const p = polity ?? selected;
    if (!p) return;
    const ov = computeOverlap(p, intervalStart, intervalEnd);
    if (!ov.overlaps) return;
    setStatus('saving');
    try {
      const result = await assignPolygon(polygonId, p.id);
      setAssignResult(result);
      setStatus('saved');
      onSaved?.(p.id, p.title);
    } catch {
      setStatus('error');
    }
  }

  async function handleImport(r: EntityResult) {
    setImportingQid(r.id);
    try {
      const feature = await importPolityFromWikidata(r.id);
      onPolityImported?.(feature);
      const props = feature.properties as FeatureProperties;
      setSelectedId(props.id);
    } catch (e) {
      console.error('Import failed:', e);
    } finally {
      setImportingQid(null);
    }
  }

  const handleSeeMore = () => setWdOpen(true);

  // ── Styles ─────────────────────────────────────────────────────────────────
  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 2000,
  };

  const card: React.CSSProperties = {
    background: '#1e2433', color: '#e8eaf0', borderRadius: 10,
    width: 480, maxWidth: '95vw', padding: '20px 22px 18px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
    display: 'flex', flexDirection: 'column', gap: 14,
    position: 'relative',
    ...(status === 'saved'
      ? { height: 'auto' }
      : { height: 'calc(100vh - 120px)', maxHeight: 780 }),
    overflow: 'hidden',
  };

  const yearInputStyle: React.CSSProperties = {
    background: '#11172a', border: '1px solid #3a4560', borderRadius: 4,
    color: '#e8eaf0', padding: '3px 7px', fontSize: 12, outline: 'none',
    width: 72, fontFamily: 'inherit',
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <div style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div style={card}>

          {/* Header */}
          <div>
            <div style={{ fontSize: 13, color: '#8899bb', marginBottom: 3 }}>Assign territory</div>
            <div style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>{hbName}</div>

            {/* Editable year range */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: '#8899bb' }}>Years</span>
              <input
                type="number"
                value={localYearStart}
                onChange={e => setLocalYearStart(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && yearsChanged && handleUpdateYears()}
                style={yearInputStyle}
              />
              <span style={{ color: '#556', fontSize: 12 }}>–</span>
              <input
                type="number"
                value={localYearEnd}
                onChange={e => setLocalYearEnd(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && yearsChanged && handleUpdateYears()}
                placeholder="∞"
                style={{ ...yearInputStyle, width: 80 }}
              />
              {yearsChanged && (
                <button
                  onClick={handleUpdateYears}
                  disabled={yearSaving}
                  style={{
                    background: '#2a4a7a', color: '#93c5fd', border: 'none', borderRadius: 4,
                    padding: '3px 10px', fontSize: 11, fontWeight: 600,
                    cursor: yearSaving ? 'default' : 'pointer', fontFamily: 'inherit',
                  }}
                >
                  {yearSaving ? '…' : 'Update'}
                </button>
              )}
              {yearFlash === 'saved' && <span style={{ fontSize: 11, color: '#66bb6a' }}>✓ saved</span>}
              {yearFlash === 'error' && <span style={{ fontSize: 11, color: '#f87171' }}>error</span>}
            </div>
          </div>

          {status === 'saved' ? (
            <div style={{ textAlign: 'center', padding: '14px 0' }}>
              <div style={{ color: '#66bb6a', fontSize: 15, marginBottom: 6 }}>✓ Mapping saved</div>
              <button onClick={onClose} style={btnStyle('#3a4560')}>Close</button>
            </div>
          ) : (
            <>
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setSelectedId(null); }}
                placeholder="Search polities…"
                style={{
                  background: '#11172a', border: '1px solid #3a4560', borderRadius: 6,
                  color: '#e8eaf0', padding: '8px 10px', fontSize: 13, outline: 'none', width: '100%',
                  boxSizing: 'border-box',
                }}
              />

              <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
                {/* Local results */}
                <div style={{ border: '1px solid #2a3450', borderRadius: 6, background: '#11172a', flexShrink: 0 }}>
                  {filtered.length === 0 && (
                    <div style={{ padding: '10px 12px', color: '#556', fontSize: 13 }}>No local matches</div>
                  )}
                  {filtered.map((p) => {
                    const ov = computeOverlap(p, intervalStart, intervalEnd);
                    const dimmed = !ov.overlaps;
                    return (
                      <div
                        key={p.id}
                        onClick={() => setSelectedId(p.id)}
                        onDoubleClick={() => { setSelectedId(p.id); if (ov.overlaps) handleSave(p); }}
                        style={{
                          padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #1e2a3e',
                          background: p.id === selectedId ? '#2a3a5a' : 'transparent',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                          opacity: dimmed ? 0.4 : 1,
                        }}
                      >
                        <a
                          href={p.wikipediaUrl || `https://en.wikipedia.org/wiki/${p.title.replace(/ /g, '_')}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          style={{ fontSize: 13, color: '#e8eaf0', textDecoration: 'none' }}
                          onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                          onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                        >{p.title}</a>
                        <span style={{ fontSize: 11, color: '#778', marginLeft: 10, whiteSpace: 'nowrap' }}>
                          {p.yearStart ?? '?'}–{p.yearEnd ?? '∞'}
                          {p.polityType ? ` · ${p.polityType}` : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>

                {/* Wikipedia results */}
                {!wdOpen ? (
                  <button
                    onClick={handleSeeMore}
                    style={{
                      background: 'none', border: '1px solid #2a3450', borderRadius: 6,
                      color: '#8899bb', fontSize: 12, padding: '7px 12px',
                      cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
                    }}
                  >
                    See More — search Wikipedia
                  </button>
                ) : (
                  <div style={{ flexShrink: 0 }}>
                    <div style={{
                      fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
                      textTransform: 'uppercase', color: '#556', marginBottom: 6,
                    }}>
                      From Wikipedia {wdLoading && <span style={{ color: '#445', fontWeight: 400 }}>· searching…</span>}
                    </div>
                    {!wdLoading && wdResults.length === 0 && (
                      <div style={{ fontSize: 12, color: '#556', padding: '6px 0' }}>No results found.</div>
                    )}
                    {wdResults.length > 0 && (
                      <div style={{ border: '1px solid #2a3450', borderRadius: 6, background: '#11172a' }}>
                        {wdResults.map((r) => (
                          <div
                            key={r.id}
                            style={{
                              padding: '8px 12px', borderBottom: '1px solid #1e2a3e',
                              display: 'flex', alignItems: 'baseline', gap: 8,
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <a
                                href={`https://en.wikipedia.org/wiki/${r.label.replace(/ /g, '_')}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{ fontSize: 13, color: '#e8eaf0', textDecoration: 'none' }}
                                onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
                                onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
                              >
                                {r.label}
                              </a>
                              {r.description && (
                                <span style={{ fontSize: 11, color: '#667', marginLeft: 8 }}>{r.description}</span>
                              )}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                              <span style={{ fontSize: 10, color: '#445' }}>{r.id}</span>
                              <button
                                onClick={() => handleImport(r)}
                                disabled={importingQid === r.id}
                                style={btnStyle('#2a5a3a', importingQid === r.id)}
                              >
                                {importingQid === r.id ? 'Importing…' : 'Import'}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Overlap feedback */}
              {overlap && !overlap.overlaps && (
                <div style={{ fontSize: 12, color: '#ef5350', lineHeight: 1.4 }}>
                  {selected!.title} ({selected!.yearStart ?? '?'}–{selected!.yearEnd ?? '∞'}) doesn't
                  overlap with this territory's window ({intervalStart}–{intervalEnd ?? '∞'}). Cannot assign.
                </div>
              )}
              {overlap && overlap.overlaps && (overlap.hasBefore || overlap.hasAfter) && (
                <div style={{ fontSize: 12, color: '#ffb74d', lineHeight: 1.4 }}>
                  Will assign {overlap.sliceStart}–{overlap.sliceEnd ?? '∞'}.
                  {overlap.hasBefore && ` Unassigned gap before: ${intervalStart}–${overlap.sliceStart - 1}.`}
                  {overlap.hasAfter  && ` Unassigned gap after: ${overlap.sliceEnd! + 1}–${intervalEnd ?? '∞'}.`}
                </div>
              )}

              {status === 'error' && (
                <div style={{ fontSize: 12, color: '#ef5350' }}>Save failed — is the API running?</div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <button
                  onClick={() => setConfirmDelete(true)}
                  title="Delete this territory"
                  style={{ ...btnStyle('#2a3450'), fontSize: 16, padding: '5px 10px' }}
                >
                  🗑
                </button>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={onClose} style={btnStyle('#2a3450')}>Cancel</button>
                  <button
                    onClick={() => handleSave()}
                    disabled={!canSave || status === 'saving'}
                    style={btnStyle(canSave ? '#3a6bbf' : '#2a3450', !canSave)}
                  >
                    {status === 'saving' ? 'Saving…' : 'Save mapping'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Delete confirmation — separate overlay above the modal */}
      {confirmDelete && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 2100,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.6)',
        }}>
          <div style={{
            background: '#1e2433', color: '#e8eaf0', borderRadius: 10,
            padding: '24px 28px', width: 360, maxWidth: '90vw',
            boxShadow: '0 8px 32px rgba(0,0,0,0.7)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}>
            <p style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>Delete territory?</p>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: '#8899bb', lineHeight: 1.5 }}>
              This will permanently delete the territory row from the database. This cannot be undone.
            </p>
            {deleteError && (
              <p style={{ margin: '0 0 12px', fontSize: 12, color: '#f87171' }}>{deleteError}</p>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                onClick={() => { setConfirmDelete(false); setDeleteError(null); }}
                disabled={deleting}
                style={btnStyle('#2a3450')}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                style={btnStyle('#7f1d1d')}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function btnStyle(bg: string, disabled = false): React.CSSProperties {
  return {
    background: bg, color: disabled ? '#556' : '#e8eaf0',
    border: 'none', borderRadius: 6, padding: '7px 16px',
    fontSize: 13, cursor: disabled ? 'default' : 'pointer',
    marginTop: 4, fontFamily: 'inherit',
  };
}
