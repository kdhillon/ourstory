// In dev: Vite proxies /wikidata-api → https://www.wikidata.org/w/api.php
// In production: requests go to the FastAPI backend proxy at api.openhistory.app/wikidata-api
const WD_API = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/wikidata-api`
  : '/wikidata-api';

function wd(p: Record<string, string>) {
  return new URLSearchParams({ format: 'json', ...p }).toString();
}

// ── Auth ────────────────────────────────────────────────────────────────────

export async function checkLogin(): Promise<string | null> {
  try {
    const res = await fetch(`${WD_API}?${wd({ action: 'query', meta: 'userinfo' })}`, { credentials: 'include' });
    const data = await res.json();
    const u = data.query?.userinfo;
    return (u && !('anon' in u)) ? u.name as string : null;
  } catch { return null; }
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  /** Set when Wikipedia requires email verification — show a code input */
  ui?: { message: string; logintoken: string; requestId: string; fieldName: string };
}

export async function login(username: string, password: string): Promise<LoginResult> {
  // Step 1: login token
  const tokenRes = await fetch(
    `${WD_API}?${wd({ action: 'query', meta: 'tokens', type: 'login' })}`,
    { credentials: 'include' },
  );
  const tokenData = await tokenRes.json();
  const logintoken = tokenData.query?.tokens?.logintoken as string;

  // Step 2: authenticate
  const body = new URLSearchParams({
    action: 'clientlogin', format: 'json',
    logintoken, username, password,
    loginreturnurl: window.location.origin,
  });
  const res = await fetch(WD_API, { method: 'POST', body, credentials: 'include' });
  const data = await res.json();
  if (data.clientlogin?.status === 'PASS') return { ok: true };
  // UI status = additional verification step required (e.g. email code)
  if (data.clientlogin?.status === 'UI') {
    // Extract the actual request ID and field name from the API response
    const req = data.clientlogin.requests?.[0];
    const requestId = req?.id ?? 'EmailAuthenticationRequest';
    const fieldName = Object.keys(req?.fields ?? { code: 1 })[0] ?? 'code';
    console.log('[wiki login] UI step, requestId=', requestId, 'fieldName=', fieldName);
    return { ok: false, ui: { message: data.clientlogin.message ?? 'Verification required', logintoken, requestId, fieldName } };
  }
  return { ok: false, error: data.clientlogin?.message ?? 'Login failed' };
}

/** Continue login after a UI verification step (e.g. email code). */
export async function loginContinue(logintoken: string, code: string, requestId = 'EmailAuthenticationRequest', fieldName = 'code'): Promise<LoginResult> {
  const body = new URLSearchParams({
    action: 'clientlogin', format: 'json',
    logincontinue: '1',
    logintoken,
    [fieldName]: code,
  });
  const res = await fetch(WD_API, { method: 'POST', body, credentials: 'include' });
  const data = await res.json();
  if (data.clientlogin?.status === 'PASS') return { ok: true };
  if (data.clientlogin?.status === 'UI') {
    return { ok: false, ui: { message: data.clientlogin.message ?? 'Verification required', logintoken } };
  }
  return { ok: false, error: data.clientlogin?.message ?? 'Verification failed' };
}

export async function logout(): Promise<void> {
  const tokenRes = await fetch(`${WD_API}?${wd({ action: 'query', meta: 'tokens' })}`, { credentials: 'include' });
  const tokenData = await tokenRes.json();
  const token = tokenData.query?.tokens?.csrftoken as string;
  const body = new URLSearchParams({ action: 'logout', format: 'json', token });
  await fetch(WD_API, { method: 'POST', body, credentials: 'include' });
}

// ── Entity lookup ────────────────────────────────────────────────────────────

export async function getQid(wikipediaTitle: string): Promise<string | null> {
  try {
    const res = await fetch(`${WD_API}?${wd({ action: 'wbgetentities', sites: 'enwiki', titles: wikipediaTitle, props: 'info' })}`);
    const data = await res.json();
    const entries = Object.values(data.entities ?? {}) as Array<{ id?: string }>;
    const hit = entries.find(e => e.id && !e.id.startsWith('-'));
    return hit?.id ?? null;
  } catch { return null; }
}

// ── CSRF ─────────────────────────────────────────────────────────────────────

export async function getCsrf(): Promise<string> {
  const res = await fetch(`${WD_API}?${wd({ action: 'query', meta: 'tokens' })}`, { credentials: 'include' });
  const data = await res.json();
  const token = data.query.tokens.csrftoken as string;
  console.log('[getCsrf] token (last 4):', token?.slice(-4));
  return token;
}

// ── Claims ───────────────────────────────────────────────────────────────────

export interface Claim {
  id?: string;
  type: 'statement';
  rank: 'normal' | 'preferred' | 'deprecated';
  mainsnak: { snaktype: string; property: string; datavalue: unknown };
}

export async function getExistingClaims(entityId: string, property: string): Promise<Claim[]> {
  const res = await fetch(`${WD_API}?${wd({ action: 'wbgetclaims', entity: entityId, property })}`);
  const data = await res.json();
  return (data.claims?.[property] ?? []) as Claim[];
}

function buildTimeClaim(property: string, year: number, month: number | null, day: number | null, existingId?: string): Claim {
  const precision = day != null ? 11 : month != null ? 10 : 9;
  const abs = Math.abs(year);
  const sign = year < 0 ? '-' : '+';
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const time = `${sign}${pad(abs, 4)}-${pad(month ?? 1)}-${pad(day ?? 1)}T00:00:00Z`;
  const claim: Claim = {
    type: 'statement', rank: 'normal',
    mainsnak: {
      snaktype: 'value', property,
      datavalue: {
        value: { time, timezone: 0, before: 0, after: 0, precision, calendarmodel: 'http://www.wikidata.org/entity/Q1985727' },
        type: 'time',
      },
    },
  };
  if (existingId) claim.id = existingId;
  return claim;
}

async function submitClaim(entityId: string, claim: Claim, csrf: string, summary: string): Promise<void> {
  let body: URLSearchParams;

  if (claim.id) {
    // Updating an existing claim — wbsetclaim requires the GUID
    body = new URLSearchParams({
      action: 'wbsetclaim', format: 'json',
      claim: JSON.stringify(claim),
      token: csrf, summary,
    });
  } else {
    // Creating a new claim — wbcreateclaim takes the entity + property separately
    const snak = claim.mainsnak;
    body = new URLSearchParams({
      action: 'wbcreateclaim', format: 'json',
      entity: entityId,
      property: snak.property,
      snaktype: snak.snaktype,
      value: JSON.stringify((snak.datavalue as { value: unknown }).value),
      token: csrf, summary,
    });
  }

  const res = await fetch(WD_API, { method: 'POST', body, credentials: 'include' });
  const data = await res.json();
  if (data.error) {
    console.error('[submitClaim] Wikidata error:', JSON.stringify(data.error));
    throw new Error(`[${data.error.code ?? '?'}] ${data.error.info ?? JSON.stringify(data.error)}`);
  }
}

export async function submitDateEdit(
  entityId: string,
  startYear: number, startMonth: number | null, startDay: number | null,
  endYear: number | null, endMonth: number | null, endDay: number | null,
  csrf: string,
): Promise<void> {
  const summary = 'Correcting date via OpenHistory historical atlas';

  // Resolve which property to use for start (prefer what already exists)
  const [p585, p580, p582] = await Promise.all([
    getExistingClaims(entityId, 'P585'),
    getExistingClaims(entityId, 'P580'),
    getExistingClaims(entityId, 'P582'),
  ]);

  if (endYear == null) {
    // Single-point event
    const prop = p580.length > 0 ? 'P580' : 'P585';
    const existing = prop === 'P580' ? p580 : p585;
    await submitClaim(entityId, buildTimeClaim(prop, startYear, startMonth, startDay, existing[0]?.id), csrf, summary);
  } else {
    // Range
    await submitClaim(entityId, buildTimeClaim('P580', startYear, startMonth, startDay, p580[0]?.id), csrf, summary);
    await submitClaim(entityId, buildTimeClaim('P582', endYear, endMonth, endDay, p582[0]?.id), csrf, summary);
  }
}

// ── Location search ───────────────────────────────────────────────────────────

export interface EntityResult { id: string; label: string; description: string }

export async function searchEntities(query: string): Promise<EntityResult[]> {
  if (!query.trim()) return [];
  // Run Wikidata entity search and Wikipedia article search in parallel.
  // Wikipedia search handles disambiguated titles (e.g. "Louisiana (New France)")
  // that Wikidata label search misses entirely.
  const [wdResults, wpResults] = await Promise.all([
    _searchWikidata(query),
    _searchViaWikipedia(query),
  ]);
  // Merge: Wikidata results first, then Wikipedia-resolved results not already included
  const seen = new Set(wdResults.map((r) => r.id));
  return [...wdResults, ...wpResults.filter((r) => !seen.has(r.id))];
}

async function _searchWikidata(query: string): Promise<EntityResult[]> {
  try {
    const res = await fetch(`${WD_API}?${wd({ action: 'wbsearchentities', search: query, language: 'en', limit: '8', type: 'item' })}`);
    const data = await res.json();
    return (data.search ?? []).map((r: { id: string; label?: string; description?: string }) => ({
      id: r.id, label: r.label ?? r.id, description: r.description ?? '',
    }));
  } catch { return []; }
}

async function _searchViaWikipedia(query: string): Promise<EntityResult[]> {
  try {
    // 1. Search Wikipedia article titles (CORS-safe via origin=*)
    const wpRes = await fetch(`https://en.wikipedia.org/w/api.php?${new URLSearchParams({
      action: 'query', list: 'search', srsearch: query, format: 'json',
      srlimit: '8', srnamespace: '0', origin: '*',
    })}`);
    const wpData = await wpRes.json();
    const titles: string[] = (wpData.query?.search ?? []).map((r: { title: string }) => r.title);
    if (!titles.length) return [];

    // 2. Resolve article titles → Wikidata QIDs via our proxy
    const wdRes = await fetch(`${WD_API}?${wd({
      action: 'wbgetentities', sites: 'enwiki', titles: titles.join('|'),
      props: 'info|labels|descriptions', languages: 'en',
    })}`);
    const wdData = await wdRes.json();
    return Object.values(wdData.entities ?? {})
      .filter((e: unknown) => {
        const ent = e as { id?: string; missing?: string };
        return ent.id && !ent.id.startsWith('-') && ent.missing === undefined;
      })
      .map((e: unknown) => {
        const ent = e as { id: string; labels?: Record<string, { value: string }>; descriptions?: Record<string, { value: string }> };
        return {
          id: ent.id,
          label: ent.labels?.en?.value ?? ent.id,
          description: ent.descriptions?.en?.value ?? '',
        };
      });
  } catch { return []; }
}

// ── Batch polity label translations ────────────────────────────────────────

export async function fetchEntityTranslations(
  qids: string[],
  lang: string,
): Promise<Record<string, string>> {
  if (lang === 'en' || qids.length === 0) return {};

  const valid = qids.filter((q) => /^Q\d+$/.test(q));
  const result: Record<string, string> = {};
  const BATCH = 50;

  const batches: string[][] = [];
  for (let i = 0; i < valid.length; i += BATCH) batches.push(valid.slice(i, i + BATCH));

  // Run up to 8 parallel batches at a time
  const PARALLEL = 8;
  for (let i = 0; i < batches.length; i += PARALLEL) {
    await Promise.all(
      batches.slice(i, i + PARALLEL).map(async (batch) => {
        try {
          const params = new URLSearchParams({
            action: 'wbgetentities',
            ids: batch.join('|'),
            props: 'labels',
            languages: lang,
            format: 'json',
            origin: '*',
          });
          const data = await fetch(`https://www.wikidata.org/w/api.php?${params}`).then((r) => r.json());
          for (const [qid, entity] of Object.entries(data.entities ?? {})) {
            const label = (entity as Record<string, unknown> & { labels?: Record<string, { value: string }> }).labels?.[lang]?.value;
            if (label) result[qid] = label;
          }
        } catch { /* skip failed batch */ }
      }),
    );
  }
  return result;
}

// ── Multi-language Wikipedia fetch ─────────────────────────────────────────

export interface TranslatedArticle {
  title: string;
  wikiTitle: string; // article title in target-language Wikipedia (for API calls)
  summary: string; // empty string if no article exists
  hasArticle: boolean;
}

export async function fetchArticleInLanguage(
  wikidataQid: string,
  lang: string,
): Promise<TranslatedArticle | null> {
  if (lang === 'en') return null; // caller handles English natively

  try {
    // 1. Fetch Wikidata label + sitelink for this language
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: wikidataQid,
      props: 'labels|sitelinks',
      languages: lang,
      sitelinkfilter: `${lang}wiki`,
      format: 'json',
      origin: '*',
    });
    const wdRes = await fetch(`https://www.wikidata.org/w/api.php?${params}`);
    if (!wdRes.ok) return null;
    const wdData = await wdRes.json();

    const entity = wdData.entities?.[wikidataQid];
    if (!entity) return null;

    const label = entity.labels?.[lang]?.value as string | undefined;
    const sitelink = entity.sitelinks?.[`${lang}wiki`] as { title: string } | undefined;

    if (!sitelink) {
      // No Wikipedia article in this language — return label only if available
      return label ? { title: label, wikiTitle: '', summary: '', hasArticle: false } : null;
    }

    // 2. Fetch Wikipedia summary from the target language edition
    const title = encodeURIComponent(sitelink.title.replace(/ /g, '_'));
    const wpRes = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${title}`);
    if (!wpRes.ok) {
      return { title: label ?? sitelink.title, wikiTitle: sitelink.title, summary: '', hasArticle: false };
    }
    const wpData = await wpRes.json();

    return {
      title: wpData.title ?? label ?? sitelink.title,
      wikiTitle: sitelink.title,
      summary: wpData.extract ?? '',
      hasArticle: true,
    };
  } catch {
    return null;
  }
}

export async function submitLocationEdit(
  entityId: string, locationQid: string, csrf: string,
): Promise<void> {
  const summary = 'Correcting location via OpenHistory historical atlas';
  const existing = await getExistingClaims(entityId, 'P276');
  const claim: Claim = {
    type: 'statement', rank: 'normal',
    mainsnak: {
      snaktype: 'value', property: 'P276',
      datavalue: { value: { 'entity-type': 'item', id: locationQid }, type: 'wikibase-entityid' },
    },
  };
  if (existing[0]?.id) claim.id = existing[0].id;
  await submitClaim(entityId, claim, csrf, summary);
}
