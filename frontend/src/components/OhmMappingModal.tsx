import { useState, useMemo, useRef, useEffect } from 'react';
import type { FeatureProperties } from '../types';
import { importPolityFromWikidata } from '../lib/api';
import { searchEntities } from '../lib/wikidataApi';
import type { EntityResult } from '../lib/wikidataApi';

const API_BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';
const WRITE_SECRET = import.meta.env.VITE_WRITE_SECRET ?? '';

interface Props {
  ohmName: string;
  ohmWikidataQid: string | null;
  polities: FeatureProperties[];
  onClose: () => void;
  onPolityImported?: (feature: GeoJSON.Feature) => void;
  onSaved?: () => void;
}

function btnStyle(bg: string, disabled = false): React.CSSProperties {
  return {
    background: disabled ? '#223' : bg,
    color: disabled ? '#556' : '#e8eaf0',
    border: 'none', borderRadius: 4,
    padding: '5px 12px', fontSize: 12, fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit',
  };
}

export function OhmMappingModal({ ohmName, ohmWikidataQid, polities, onClose, onPolityImported, onSaved }: Props) {
  const [query, setQuery]               = useState(ohmName);
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [status, setStatus]             = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg]         = useState<string | null>(null);

  const [wdResults, setWdResults]       = useState<EntityResult[]>([]);
  const [wdLoading, setWdLoading]       = useState(false);
  const [wdOpen, setWdOpen]             = useState(true);
  const [importingQid, setImportingQid] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return (q ? polities.filter((p) => p.title.toLowerCase().includes(q)) : polities).slice(0, 40);
  }, [query, polities]);

  const existingQids = useMemo(() => new Set(polities.map((p) => p.wikidataQid).filter(Boolean)), [polities]);

  useEffect(() => {
    if (!wdOpen) return;
    let cancelled = false;
    setWdLoading(true);
    setWdResults([]);
    searchEntities(query.trim() || ohmName)
      .then((r) => { if (!cancelled) setWdResults(r.filter((x) => !existingQids.has(x.id))); })
      .catch(() => { if (!cancelled) setWdResults([]); })
      .finally(() => { if (!cancelled) setWdLoading(false); });
    return () => { cancelled = true; };
  }, [query, wdOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave(polity?: FeatureProperties) {
    const p = polity ?? polities.find((x) => x.id === selectedId);
    if (!p) return;
    setStatus('saving');
    setErrorMsg(null);
    try {
      const res = await fetch(`${API_BASE}/ohm-links`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Write-Secret': WRITE_SECRET,
        },
        body: JSON.stringify({
          ohmName,
          ohmWikidataQid,
          polityId: p.id,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus('saved');
      onSaved?.();
    } catch (e) {
      setErrorMsg((e as Error).message);
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

  return (
    <div style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={card}>

        {/* Header */}
        <div>
          <div style={{ fontSize: 13, color: '#8899bb', marginBottom: 3 }}>Assign OHM territory</div>
          <div style={{ fontSize: 17, fontWeight: 600 }}>{ohmName}</div>
          {ohmWikidataQid && (
            <div style={{ fontSize: 11, color: '#556', marginTop: 3 }}>{ohmWikidataQid}</div>
          )}
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
              {/* Local polity results */}
              <div style={{ border: '1px solid #2a3450', borderRadius: 6, background: '#11172a', flexShrink: 0 }}>
                {filtered.length === 0 && (
                  <div style={{ padding: '10px 12px', color: '#556', fontSize: 13 }}>No local matches</div>
                )}
                {filtered.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    onDoubleClick={() => { setSelectedId(p.id); handleSave(p); }}
                    style={{
                      padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #1e2a3e',
                      background: p.id === selectedId ? '#2a3a5a' : 'transparent',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
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
                ))}
              </div>

              {/* Wikipedia / Wikidata results */}
              {!wdOpen ? (
                <button
                  onClick={() => setWdOpen(true)}
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

            {status === 'error' && (
              <div style={{ fontSize: 12, color: '#ef5350' }}>
                Save failed{errorMsg ? `: ${errorMsg}` : ' — is the API running?'}
              </div>
            )}

            {/* Footer buttons */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={btnStyle('#3a4560')}>Cancel</button>
              <button
                onClick={() => handleSave()}
                disabled={!selectedId || status === 'saving'}
                style={btnStyle('#2a4a7a', !selectedId || status === 'saving')}
              >
                {status === 'saving' ? 'Saving…' : 'Assign'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
