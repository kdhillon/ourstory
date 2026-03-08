import { useState, useEffect, useRef } from 'react';
import type { FeatureProperties } from '../types';
import {
  login, loginContinue, logout, getQid, getCsrf,
  submitDateEdit, submitLocationEdit, searchEntities,
  type EntityResult,
} from '../lib/wikidataApi';
import { patchFeature, patchPolity } from '../lib/api';

interface Props {
  feature: FeatureProperties;
  field: 'date' | 'location' | 'capital' | 'sovereign';
  wikiAuth: string | null;
  onAuth: (username: string | null) => void;
  onSuccess: (updates: Partial<FeatureProperties>) => void;
  onClose: () => void;
}

type Phase = 'login' | 'edit' | 'submitting' | 'success' | 'error';

export function WikiEditForm({ feature, field, wikiAuth, onAuth, onSuccess, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>(wikiAuth ? 'edit' : 'login');

  // Login fields
  const [loginUser, setLoginUser] = useState('');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  // Email verification step — set when Wikipedia responds with status=UI
  const [loginUi, setLoginUi] = useState<{ message: string; logintoken: string } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');

  // Date edit fields — pre-filled from feature
  const [startYear, setStartYear] = useState(feature.yearStart != null ? String(Math.abs(feature.yearStart)) : '');
  const [startMonth, setStartMonth] = useState(feature.monthStart != null ? String(feature.monthStart) : '');
  const [startDay, setStartDay] = useState(feature.dayStart != null ? String(feature.dayStart) : '');
  const [startBce, setStartBce] = useState((feature.yearStart ?? 0) < 0);
  const [endYear, setEndYear] = useState(feature.yearEnd != null ? String(Math.abs(feature.yearEnd)) : '');
  const [endMonth, setEndMonth] = useState(feature.yearEnd != null && feature.monthEnd != null ? String(feature.monthEnd) : '');
  const [endDay, setEndDay] = useState(feature.yearEnd != null && feature.dayEnd != null ? String(feature.dayEnd) : '');
  const [endBce, setEndBce] = useState((feature.yearEnd ?? 0) < 0);

  // Location search
  const [locationQuery, setLocationQuery] = useState(feature.locationName ?? '');
  const [locationResults, setLocationResults] = useState<EntityResult[]>([]);
  const [selectedLocation, setSelectedLocation] = useState<EntityResult | null>(null);
  const [searchingLocation, setSearchingLocation] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [submitError, setSubmitError] = useState('');

  useEffect(() => {
    if (wikiAuth && phase === 'login') setPhase('edit');
  }, [wikiAuth, phase]);

  const handleLogin = async () => {
    setLoginError('');
    setLoggingIn(true);
    const result = await login(loginUser, loginPass);
    setLoggingIn(false);
    if (result.ok) {
      onAuth(loginUser);
      setPhase('edit');
    } else if (result.ui) {
      setLoginUi(result.ui);
    } else {
      setLoginError(result.error ?? 'Login failed');
    }
  };

  const handleVerifyCode = async () => {
    if (!loginUi) return;
    setLoginError('');
    setLoggingIn(true);
    const result = await loginContinue(loginUi.logintoken, verifyCode.trim(), loginUi.requestId, loginUi.fieldName);
    setLoggingIn(false);
    if (result.ok) {
      onAuth(loginUser);
      setPhase('edit');
    } else if (result.ui) {
      setLoginUi(result.ui);
      setVerifyCode('');
    } else {
      setLoginError(result.error ?? 'Verification failed');
    }
  };

  const handleLogout = async () => {
    await logout();
    onAuth(null);
    setPhase('login');
  };

  const handleLocationSearch = (q: string) => {
    setLocationQuery(q);
    setSelectedLocation(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) { setLocationResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearchingLocation(true);
      const results = await searchEntities(q);
      setLocationResults(results);
      setSearchingLocation(false);
    }, 300);
  };

  const handleSubmit = async () => {
    setSubmitError('');
    setPhase('submitting');
    try {
      const qid = await getQid(feature.wikipediaTitle);
      if (!qid) throw new Error('Could not find a Wikidata item for this article.');
      const csrf = await getCsrf();

      if (field === 'date') {
        const sy = parseInt(startYear, 10);
        if (isNaN(sy)) throw new Error('Please enter a valid start year.');
        const startYearFinal = startBce ? -Math.abs(sy) : sy;
        const sm = startMonth ? parseInt(startMonth, 10) : null;
        const sd = startDay ? parseInt(startDay, 10) : null;
        const eyRaw = endYear ? parseInt(endYear, 10) : null;
        const eyFinal = eyRaw != null ? (endBce ? -Math.abs(eyRaw) : eyRaw) : null;
        const em = eyFinal != null && endMonth ? parseInt(endMonth, 10) : null;
        const ed = eyFinal != null && endDay ? parseInt(endDay, 10) : null;
        await submitDateEdit(qid, startYearFinal, sm, sd, eyFinal, em, ed, csrf);
        // Persist to our DB (fire-and-forget — don't block the success screen)
        if (feature.featureType === 'polity') {
          patchPolity(feature.id, { year_start: startYearFinal, year_end: eyFinal })
            .catch((e) => console.warn('[API] polity date patch failed:', e));
        } else {
          patchFeature(feature.id, {
            year_start: startYearFinal, month_start: sm, day_start: sd,
            year_end: eyFinal, month_end: em, day_end: ed,
          }).catch((e) => console.warn('[API] date patch failed:', e));
        }
        onSuccess({ yearStart: startYearFinal, monthStart: sm, dayStart: sd, yearEnd: eyFinal, monthEnd: em, dayEnd: ed });
      } else {
        if (!selectedLocation) throw new Error('Please select a location from the search results.');
        await submitLocationEdit(qid, selectedLocation.id, csrf);
        // Persist to our DB — include the Wikidata QID so we get the right coordinates
        patchFeature(feature.id, {
          location_name: selectedLocation.label,
          location_wikidata_qid: selectedLocation.id,
        }).catch((e) => console.warn('[API] location patch failed:', e));
        onSuccess({ locationName: selectedLocation.label });
      }

      setPhase('success');
    } catch (e) {
      setSubmitError((e as Error).message);
      setPhase('error');
    }
  };

  // ── Login screen ──────────────────────────────────────────────────────────

  if (phase === 'login') {
    return (
      <div style={s.drawer}>
        <div style={s.drawerHeader}>
          <span style={s.drawerTitle}>Log in to Wikipedia</span>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>
        <p style={s.desc}>
          Log in with your Wikipedia account to submit edits to Wikidata.
        </p>
        {loginUi ? (
          // Email verification step
          <>
            <p style={{ ...s.desc, color: '#54595d', marginBottom: 12 }}>{loginUi.message}</p>
            <div style={s.field}>
              <label style={s.label}>Verification code</label>
              <input
                style={s.input}
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleVerifyCode()}
                autoFocus
                placeholder="Enter the code from your email"
                autoComplete="one-time-code"
              />
            </div>
          </>
        ) : (
          <>
            <div style={s.field}>
              <label style={s.label}>Username</label>
              <input
                style={s.input}
                value={loginUser}
                onChange={(e) => setLoginUser(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                autoFocus
                autoComplete="username"
                placeholder="Your Wikipedia username"
              />
            </div>
            <div style={s.field}>
              <label style={s.label}>Password</label>
              <input
                style={s.input}
                type="password"
                value={loginPass}
                onChange={(e) => setLoginPass(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                autoComplete="current-password"
              />
            </div>
          </>
        )}
        {loginError && <p style={s.errorText}>{loginError}</p>}
        <div style={s.actions}>
          {loginUi ? (
            <button style={s.primaryBtn} onClick={handleVerifyCode} disabled={loggingIn || !verifyCode.trim()}>
              {loggingIn ? 'Verifying…' : 'Verify'}
            </button>
          ) : (
            <button style={s.primaryBtn} onClick={handleLogin} disabled={loggingIn}>
              {loggingIn ? 'Logging in…' : 'Log in'}
            </button>
          )}
          <a href="https://www.wikipedia.org/wiki/Special:CreateAccount" target="_blank" rel="noopener noreferrer" style={s.ghostLink}>
            Create account ↗
          </a>
        </div>
      </div>
    );
  }

  // ── Success screen ────────────────────────────────────────────────────────

  if (phase === 'success') {
    return (
      <div style={s.drawer}>
        <div style={s.drawerHeader}>
          <span style={s.drawerTitle}>Edit submitted ✓</span>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>
        <p style={s.desc}>
          Your change has been saved to Wikidata. Wikipedia infoboxes typically update within a few minutes.
        </p>
        <div style={s.actions}>
          <button style={s.primaryBtn} onClick={onClose}>Done</button>
          {wikiAuth && (
            <button style={s.ghostBtn} onClick={handleLogout}>Log out ({wikiAuth})</button>
          )}
        </div>
      </div>
    );
  }

  // ── Error screen ──────────────────────────────────────────────────────────

  if (phase === 'error') {
    return (
      <div style={s.drawer}>
        <div style={s.drawerHeader}>
          <span style={s.drawerTitle}>Edit failed</span>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>
        <p style={s.errorText}>{submitError}</p>
        <div style={s.actions}>
          <button style={s.primaryBtn} onClick={() => setPhase('edit')}>Try again</button>
          <button style={s.ghostBtn} onClick={onClose}>Cancel</button>
        </div>
      </div>
    );
  }

  // ── Edit / Submitting screen ──────────────────────────────────────────────

  return (
    <div style={s.drawer}>
      <div style={s.drawerHeader}>
        <span style={s.drawerTitle}>
          {field === 'date' ? 'Correct the date' : 'Correct the location'}
        </span>
        <button style={s.closeBtn} onClick={onClose}>✕</button>
      </div>

      {field === 'date' ? (
        <>
          {/* Start date */}
          <div style={s.fieldGroup}>
            <span style={s.groupLabel}>Start date</span>
            <div style={s.dateRow}>
              <input style={{ ...s.input, width: 70 }} placeholder="Year" value={startYear} onChange={(e) => setStartYear(e.target.value)} />
              <input style={{ ...s.input, width: 46 }} placeholder="Mo" value={startMonth} onChange={(e) => setStartMonth(e.target.value)} />
              <input style={{ ...s.input, width: 46 }} placeholder="Day" value={startDay} onChange={(e) => setStartDay(e.target.value)} />
              <label style={s.checkboxLabel}>
                <input type="checkbox" checked={startBce} onChange={(e) => setStartBce(e.target.checked)} />
                {' BCE'}
              </label>
            </div>
          </div>

          {/* End date */}
          <div style={s.fieldGroup}>
            <span style={s.groupLabel}>End date <span style={s.optional}>(leave blank for single-point event)</span></span>
            <div style={s.dateRow}>
              <input style={{ ...s.input, width: 70 }} placeholder="Year" value={endYear} onChange={(e) => setEndYear(e.target.value)} />
              <input style={{ ...s.input, width: 46 }} placeholder="Mo" value={endMonth} onChange={(e) => setEndMonth(e.target.value)} />
              <input style={{ ...s.input, width: 46 }} placeholder="Day" value={endDay} onChange={(e) => setEndDay(e.target.value)} />
              <label style={s.checkboxLabel}>
                <input type="checkbox" checked={endBce} onChange={(e) => setEndBce(e.target.checked)} />
                {' BCE'}
              </label>
            </div>
          </div>

          <div style={s.authBadge}>
            <span style={s.authUser}>Editing as <strong>{wikiAuth}</strong></span>
            <button style={s.ghostBtn} onClick={handleLogout}>Log out</button>
          </div>
          <p style={s.hint}>
            Saves as Wikidata P580/P582 (start/end time) or P585 (point in time). Month and day are optional.
          </p>
        </>
      ) : (
        <>
          {/* Location search */}
          <div style={s.fieldGroup}>
            <span style={s.groupLabel}>Search Wikidata for location</span>
            <input
              style={s.input}
              placeholder="e.g. Rome, Gaul, Persian Empire…"
              value={locationQuery}
              onChange={(e) => handleLocationSearch(e.target.value)}
              autoFocus
            />
          </div>

          {searchingLocation && <p style={s.hint}>Searching…</p>}

          {locationResults.length > 0 && !selectedLocation && (
            <div style={s.resultsList}>
              {locationResults.map((r) => (
                <button
                  key={r.id}
                  style={s.resultItem}
                  onClick={() => {
                    setSelectedLocation(r);
                    setLocationQuery(r.label);
                    setLocationResults([]);
                  }}
                >
                  <span style={s.resultLabel}>{r.label}</span>
                  {r.description && <span style={s.resultDesc}>{r.description}</span>}
                </button>
              ))}
            </div>
          )}

          {selectedLocation && (
            <div style={s.selectedLocation}>
              <span style={s.selectedLabel}>{selectedLocation.label}</span>
              {selectedLocation.description && (
                <span style={s.selectedDesc}>{selectedLocation.description}</span>
              )}
              <button style={{ ...s.ghostBtn, marginLeft: 'auto' }} onClick={() => { setSelectedLocation(null); setLocationResults([]); }}>
                Change
              </button>
            </div>
          )}

          <div style={s.authBadge}>
            <span style={s.authUser}>Editing as <strong>{wikiAuth}</strong></span>
            <button style={s.ghostBtn} onClick={handleLogout}>Log out</button>
          </div>
          <p style={s.hint}>Saves as Wikidata P276 (location). Propagates to Wikipedia infoboxes automatically.</p>
        </>
      )}

      <div style={s.actions}>
        <button
          style={{ ...s.primaryBtn, opacity: phase === 'submitting' ? 0.6 : 1 }}
          onClick={handleSubmit}
          disabled={phase === 'submitting'}
        >
          {phase === 'submitting' ? 'Submitting…' : 'Submit to Wikidata'}
        </button>
        <button style={s.ghostBtn} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  drawer: {
    margin: '0 12px 10px',
    padding: '10px 12px',
    background: 'rgba(51,102,204,0.05)',
    border: '1px solid rgba(51,102,204,0.18)',
    borderRadius: 8,
    flexShrink: 0,
  },
  drawerHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  drawerTitle: { fontSize: 12, fontWeight: 700, color: '#202122' },
  closeBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    color: '#9a9a9a', fontSize: 11, padding: '0 2px', fontFamily: 'inherit',
  },
  desc: { fontSize: 11.5, color: '#54595d', lineHeight: 1.55, marginBottom: 8 },
  authBadge: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'rgba(0,0,0,0.04)', borderRadius: 5,
    padding: '4px 8px', marginBottom: 10,
  },
  authUser: { fontSize: 11, color: '#54595d', flex: 1 },
  field: { marginBottom: 8 },
  fieldGroup: { marginBottom: 8 },
  label: { display: 'block', fontSize: 10.5, fontWeight: 600, color: '#54595d', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 4 },
  groupLabel: { display: 'block', fontSize: 10.5, fontWeight: 600, color: '#54595d', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 4 },
  optional: { fontWeight: 400, textTransform: 'none' as const, letterSpacing: 0, color: '#9a9a9a' },
  input: {
    width: '100%',
    boxSizing: 'border-box' as const,
    fontSize: 12,
    color: '#202122',
    background: '#fff',
    border: '1px solid rgba(0,0,0,0.18)',
    borderRadius: 5,
    padding: '4px 7px',
    fontFamily: 'inherit',
    outline: 'none',
  },
  dateRow: { display: 'flex', gap: 6, alignItems: 'center' },
  checkboxLabel: { fontSize: 11, color: '#54595d', display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' as const, cursor: 'pointer' },
  hint: { fontSize: 10.5, color: '#9a9a9a', lineHeight: 1.5, marginBottom: 10 },
  errorText: { fontSize: 11.5, color: '#cc3333', marginBottom: 8, lineHeight: 1.5 },
  actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const },
  primaryBtn: {
    fontSize: 11, fontWeight: 600, color: '#ffffff',
    background: '#3366cc', border: 'none', borderRadius: 5,
    padding: '5px 11px', cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap' as const,
  },
  ghostBtn: {
    fontSize: 11, fontWeight: 500, color: '#54595d',
    background: 'none', border: '1px solid rgba(0,0,0,0.15)',
    borderRadius: 5, padding: '5px 10px', cursor: 'pointer', fontFamily: 'inherit',
    whiteSpace: 'nowrap' as const,
  },
  ghostLink: {
    fontSize: 11, fontWeight: 500, color: '#3366cc',
    textDecoration: 'none', whiteSpace: 'nowrap' as const,
  },
  resultsList: {
    border: '1px solid rgba(0,0,0,0.12)', borderRadius: 6,
    background: '#fff', marginBottom: 8, maxHeight: 160, overflowY: 'auto' as const,
  },
  resultItem: {
    width: '100%', textAlign: 'left' as const,
    background: 'none', border: 'none', borderBottom: '1px solid rgba(0,0,0,0.06)',
    padding: '6px 10px', cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', flexDirection: 'column' as const, gap: 1,
  },
  resultLabel: { fontSize: 12, fontWeight: 600, color: '#202122' },
  resultDesc: { fontSize: 10.5, color: '#9a9a9a' },
  selectedLocation: {
    display: 'flex', alignItems: 'center', gap: 6,
    background: 'rgba(0,120,0,0.06)', border: '1px solid rgba(0,120,0,0.2)',
    borderRadius: 5, padding: '5px 8px', marginBottom: 8, flexWrap: 'wrap' as const,
  },
  selectedLabel: { fontSize: 12, fontWeight: 600, color: '#202122' },
  selectedDesc: { fontSize: 10.5, color: '#9a9a9a' },
};
