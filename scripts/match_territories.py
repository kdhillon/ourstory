#!/usr/bin/env python3
"""
Match unlinked territory rows to polities in the DB.

Each row in the `territories` table has explicit year_start / year_end.
This script matches per row (not per hb_name group), writing polity_id
directly to the territories table.

Matching strategies (applied in order, best confidence wins):

  exact           (1.00) — normalized names match exactly
  alias_strip     (0.92) — strip parenthetical, match remainder
                           "Ceylon (Dutch)" → "ceylon" matches "Ceylon"
  alias_swap      (0.88) — move parenthetical to front
                           "Ceylon (Dutch)" → "dutch ceylon" matches "Dutch Ceylon"
  core_exact      (0.85) — strip political title prefixes from polity name,
                           compare cores: "Grand Duchy of Baden" → "Baden"
  contained_in    (0.80) — all meaningful tokens of hb_name appear in polity name
                           "Baden" ⊆ "Grand Duchy of Baden"
  contains        (0.78) — all meaningful tokens of polity name appear in hb_name
  token_high      (0.65) — Jaccard on meaningful tokens ≥ 0.60
  token_medium    (0.50) — Jaccard on meaningful tokens ≥ 0.40

Time filter: territory interval must overlap polity lifetime (±25yr tolerance).
Polities with NULL year_start are accepted unconditionally.
Sitelinks fetched from Wikidata to rank importance and sort output.

Usage:
  python3 scripts/match_territories.py              # dry run, shows results
  python3 scripts/match_territories.py --apply      # writes polity_id to territories table
  python3 scripts/match_territories.py --limit 50
  python3 scripts/match_territories.py --min-confidence 0.75
  python3 scripts/match_territories.py --output results.json
  python3 scripts/match_territories.py --no-sitelinks   # skip Wikidata fetch
"""

import argparse
import json
import os
import re
import sys
import time
import unicodedata

import psycopg2
import psycopg2.extras
import requests

# ── Config ─────────────────────────────────────────────────────────────────────

DATABASE_URL = os.environ["DATABASE_URL"]
TIME_TOLERANCE   = 25      # years either side of polity lifetime
MIN_JACCARD_HIGH = 0.60
MIN_JACCARD_MED  = 0.40
DEFAULT_MIN_CONF = 0.75

WDQS_SPARQL  = "https://query.wikidata.org/sparql"
WDQS_TIMEOUT = 30

# Political title prefixes to strip when computing polity "core" name
_TITLE_PREFIXES = [
    "grand duchy of", "duchy of", "kingdom of", "republic of", "empire of",
    "regency of", "emirate of", "khanate of", "sultanate of", "principality of",
    "county of", "lordship of", "margraviate of", "electorate of", "bishopric of",
    "archbishopric of", "caliphate of", "confederation of", "union of",
    "state of", "free city of", "free imperial city of", "crown of",
    "dominion of", "colony of", "province of", "territory of",
    "grand principality of", "principality of", "palatinate of",
]
_STOPWORDS = {
    # Articles / prepositions
    "of", "the", "and", "de", "du", "der", "von", "le", "la", "les", "al",
    "el", "en", "et", "in", "at", "to", "a", "an",
    # Political entity types — excluded from token matching so that
    # "X Confederation" never false-matches "Y Confederation" via Jaccard.
    "kingdom", "empire", "dynasty", "imperial",
    "republic", "republican",
    "sultanate", "sultan",
    "duchy", "dukedom", "grand",
    "principality", "princedom", "principate",
    "confederation", "confederacy", "confederate",
    "union", "united",
    "territory", "territories",
    "province", "provincial",
    "state", "states",
    "khanate", "khan", "khaganate", "khagan",
    "caliphate", "caliph",
    "emirate", "emir", "amirate", "amiri",
    "electorate", "elector",
    "margraviate", "margrave", "marquisate", "marquessate",
    "palatinate", "palatine",
    "landgraviate", "landgrave",
    "burggraviate", "burgrave",
    "dominion",
    "colony", "colonial", "colonies",
    "protectorate",
    "viceroyalty", "viceroy", "viceregal",
    "captaincy",
    "regency", "regent",
    "vilayet", "eyalet", "sanjak", "pashalik", "pasha",
    "despotate", "despot", "despotism",
    "commonwealth",
    "federation", "federated", "federal",
    "league",
    "alliance",
    "mandate",
    "dependency",
    "realm",
    "reich",
    "tsardom", "tsarist", "tsar", "czar", "czardom",
    "shogunate", "shogun", "bakufu",
    "beylik", "bey",
    "commune", "canton",
    "prefecture",
    "governorate", "governorship",
    "barony", "baron",
    "viscountcy", "viscountate", "viscount",
    "earldom", "earl",
    "archduchy", "archduke",
    "county", "countship", "count",
    "lordship", "lord",
    "bishopric", "bishop",
    "archbishopric", "archbishop",
    "papacy", "papal", "pontificate",
    "abbacy", "abbey",
    "priorate", "priory",
    "commandery",
    "imamate", "imam",
    "sheikhdom", "sheikh", "sheikdom",
    "nawabate", "nawab",
    "nizamate", "nizam",
    "raj", "rani", "rajah", "raja",
    "presidency",
    "residency",
    "ulus",
    "horde",
    "daimyo", "han",
    "chiefdom", "chieftaincy", "paramount",
    "band",
    "people", "peoples",
    "nation", "nations",
    "tribe", "tribal",
    "ethnic", "group",
    "native", "indigenous",
    "first",
    "society",
    "holy", "free", "royal", "sovereign", "independent",
    "crown",
    "old", "new", "northern", "southern", "eastern", "western",
    "upper", "lower", "greater", "lesser", "little", "great",
    "inner", "outer", "central", "middle",
    "mandate", "trust",
    "voivodate", "voivodeship", "voivode",
    "hetmanate", "hetman",
    "kraal",
    "ulus", "ordu",
    "obshchina",
}

# ── Text helpers ───────────────────────────────────────────────────────────────

_PAREN_RE   = re.compile(r'\s*\([^)]*\)')
_NONWORD_RE = re.compile(r'[^\w\s]')
_DASH_RE    = re.compile(r'[\u2010\u2011\u2012\u2013\u2014\u2015\-]')


def normalize(s: str) -> str:
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.lower()
    s = _DASH_RE.sub(" ", s)
    s = _NONWORD_RE.sub(" ", s)
    return " ".join(s.split())


def meaningful_tokens(s: str) -> set[str]:
    return {t for t in normalize(s).split() if t not in _STOPWORDS and len(t) > 1}


def core_name(polity_name: str) -> str:
    norm = normalize(polity_name)
    for prefix in sorted(_TITLE_PREFIXES, key=len, reverse=True):
        if norm.startswith(prefix + " "):
            return norm[len(prefix):].strip()
    return norm


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def name_variants(hb_name: str) -> list[tuple[str, str, float]]:
    variants: list[tuple[str, str, float]] = []
    norm = normalize(hb_name)
    variants.append((norm, "exact", 1.00))

    stripped = normalize(_PAREN_RE.sub("", hb_name))
    if stripped and stripped != norm:
        variants.append((stripped, "alias_strip", 0.92))

    m = _PAREN_RE.search(hb_name)
    if m:
        qualifier = normalize(m.group().strip())
        base = normalize(_PAREN_RE.sub("", hb_name))
        swapped = f"{qualifier} {base}".strip()
        if swapped not in {v for v, _, _ in variants}:
            variants.append((swapped, "alias_swap", 0.88))

    return variants


# ── Time overlap ───────────────────────────────────────────────────────────────

def time_overlap(t_start: int, t_end: int | None,
                 p_start: int | None, p_end: int | None,
                 tol: int = TIME_TOLERANCE) -> bool:
    """Territory interval [t_start, t_end] must overlap polity lifetime [p_start, p_end]."""
    if p_start is None:
        return True
    te = t_end if t_end is not None else 9999
    pe = p_end if p_end is not None else 9999
    if not ((t_start - tol) <= pe and (te + tol) >= p_start):
        return False
    if p_end is not None and t_start > p_end + tol:
        return False
    return True


# ── Wikidata sitelinks ─────────────────────────────────────────────────────────

def fetch_sitelinks(qids: list[str]) -> dict[str, int]:
    if not qids:
        return {}
    values = " ".join(f"wd:{q}" for q in qids)
    sparql = f"""
SELECT ?item (COUNT(?sitelink) AS ?n) WHERE {{
  VALUES ?item {{ {values} }}
  ?sitelink schema:about ?item .
}} GROUP BY ?item
"""
    headers = {
        "Accept": "application/sparql-results+json",
        "User-Agent": "OpenHistoryMatcher/1.0",
    }
    try:
        resp = requests.get(
            WDQS_SPARQL,
            params={"query": sparql, "format": "json"},
            headers=headers,
            timeout=WDQS_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        return {
            row["item"]["value"].split("/")[-1]: int(row["n"]["value"])
            for row in data["results"]["bindings"]
        }
    except Exception as e:
        print(f"  [warn] sitelinks fetch failed: {e}", file=sys.stderr)
        return {}


# ── Core matching ──────────────────────────────────────────────────────────────

def build_indexes(polities: list[dict]) -> tuple[dict, dict]:
    norm_index: dict[str, list[dict]] = {}
    core_index: dict[str, list[dict]] = {}

    for p in polities:
        for field in ("name", "short_name"):
            raw = p.get(field) or ""
            if not raw:
                continue
            nk = normalize(raw)
            norm_index.setdefault(nk, []).append(p)
            ck = core_name(raw)
            if ck != nk:
                core_index.setdefault(ck, []).append(p)

    return norm_index, core_index


def match_territory(
    hb_name: str,
    t_start: int,
    t_end: int | None,
    norm_index: dict[str, list[dict]],
    core_index: dict[str, list[dict]],
    all_polities: list[dict],
) -> list[dict]:
    """Return matches sorted by confidence desc."""
    seen_ids: set[str] = set()
    results: list[dict] = []

    def candidate_ok(p: dict) -> bool:
        return time_overlap(t_start, t_end, p.get("year_start"), p.get("year_end"))

    def add(p: dict, conf: float, strategy: str):
        pid = str(p["id"])
        if pid in seen_ids:
            return
        if not candidate_ok(p):
            return
        seen_ids.add(pid)
        results.append({
            "polity_id":    pid,
            "polity_name":  p["name"],
            "polity_type":  p.get("polity_type"),
            "year_start":   p.get("year_start"),
            "year_end":     p.get("year_end"),
            "wikidata_qid": p.get("wikidata_qid"),
            "confidence":   round(conf, 3),
            "strategy":     strategy,
        })

    # 1–3: exact name variant lookups
    for variant, strategy, conf in name_variants(hb_name):
        for p in norm_index.get(variant, []):
            add(p, conf, strategy)

    # 4: core name exact match (strip title prefix from polity name)
    hb_norm = normalize(hb_name)
    for p in core_index.get(hb_norm, []):
        add(p, 0.85, "core_exact")

    # Also try alias_strip against core_index
    stripped = normalize(_PAREN_RE.sub("", hb_name))
    if stripped != hb_norm:
        for p in core_index.get(stripped, []):
            add(p, 0.82, "core_alias_strip")

    # 5–6: containment matching on meaningful tokens
    hb_tokens = meaningful_tokens(hb_name)
    if hb_tokens:
        for p in all_polities:
            if not candidate_ok(p):
                continue
            for field in ("name", "short_name"):
                raw = p.get(field) or ""
                if not raw:
                    continue
                p_tokens = meaningful_tokens(raw)
                if not p_tokens:
                    continue
                if hb_tokens <= p_tokens:
                    if len(hb_tokens) / len(p_tokens) < 0.5:
                        continue
                    if p.get("polity_type") == "people" and p_tokens != hb_tokens:
                        continue
                    add(p, 0.80, "contained_in")
                elif p_tokens <= hb_tokens:
                    if len(p_tokens) / len(hb_tokens) < 0.6:
                        continue
                    add(p, 0.78, "contains")
                else:
                    j = jaccard(hb_tokens, p_tokens)
                    if j >= MIN_JACCARD_HIGH:
                        add(p, 0.65 * (j / MIN_JACCARD_HIGH), "token_high")
                    elif j >= MIN_JACCARD_MED:
                        add(p, 0.50 * (j / MIN_JACCARD_MED), "token_medium")

    # 7: compound-split — "Denmark-Norway" → try each part separately
    raw_parts = _DASH_RE.split(hb_name)
    if len(raw_parts) > 1:
        for part in raw_parts:
            part = part.strip()
            if len(part) < 3:
                continue
            p_norm = normalize(part)
            for p in norm_index.get(p_norm, []):
                add(p, 0.72, "compound_split")
            p_core = core_name(part)
            if p_core != p_norm:
                for p in core_index.get(p_core, []):
                    add(p, 0.68, "compound_split_core")

    def _rank(m: dict) -> tuple:
        ys, ye = m.get("year_start"), m.get("year_end")
        is_people = 1 if m.get("polity_type") == "people" else 0
        has_both = 0 if (ys is not None and ye is not None) else 1
        lifespan = (ye - ys) if has_both == 0 else 999_999
        return (-m["confidence"], has_both, is_people, lifespan)

    results.sort(key=_rank)
    return results


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Match territories to polities")
    parser.add_argument("--apply",          action="store_true",
                        help="Write polity_id directly to territories table")
    parser.add_argument("--limit",          type=int, default=0)
    parser.add_argument("--min-confidence", type=float, default=DEFAULT_MIN_CONF)
    parser.add_argument("--output",         type=str, default="")
    parser.add_argument("--no-sitelinks",   action="store_true")
    args = parser.parse_args()

    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Load all polities
    cur.execute("SELECT id, name, short_name, year_start, year_end, wikidata_qid, slug, polity_type FROM polities ORDER BY name")
    all_polities = [dict(r) for r in cur.fetchall()]
    print(f"Loaded {len(all_polities)} polities from DB")

    # Load unassigned, non-explicitly-unlinked territory rows
    cur.execute("""
        SELECT id, hb_name, year_start, year_end
        FROM territories
        WHERE polity_id IS NULL
          AND NOT explicitly_unlinked
        ORDER BY year_start, hb_name
    """)
    candidates = [dict(r) for r in cur.fetchall()]
    print(f"Unassigned territories to match: {len(candidates)}")

    if args.limit:
        candidates = candidates[: args.limit]
        print(f"Processing first {args.limit}")

    norm_index, core_index = build_indexes(all_polities)

    all_results = []
    for terr in candidates:
        hb_name = terr["hb_name"]
        t_start = terr["year_start"]
        t_end   = terr["year_end"]

        matches = match_territory(hb_name, t_start, t_end, norm_index, core_index, all_polities)

        if matches and matches[0]["confidence"] >= args.min_confidence:
            status = "matched"
        elif matches:
            status = "low_confidence"
        else:
            status = "no_match"

        all_results.append({
            "territory_id": str(terr["id"]),
            "hb_name":      hb_name,
            "year_start":   t_start,
            "year_end":     t_end,
            "status":       status,
            "best_match":   matches[0] if matches else None,
            "all_matches":  matches[:5],
        })

    # Fetch sitelinks for matched polities
    if not args.no_sitelinks:
        qids = list({
            r["best_match"]["wikidata_qid"]
            for r in all_results
            if r["best_match"] and r["best_match"].get("wikidata_qid")
        })
        if qids:
            print(f"Fetching sitelinks for {len(qids)} QIDs…")
            time.sleep(1)
            sitelinks = fetch_sitelinks(qids)
            for r in all_results:
                if r["best_match"] and r["best_match"].get("wikidata_qid"):
                    r["best_match"]["sitelinks"] = sitelinks.get(
                        r["best_match"]["wikidata_qid"], 0
                    )

    # Sort: matched first, then by sitelinks desc, then confidence desc
    def sort_key(r):
        sl = r["best_match"].get("sitelinks", 0) if r["best_match"] else 0
        c  = r["best_match"]["confidence"] if r["best_match"] else 0
        return ({"matched": 0, "low_confidence": 1, "no_match": 2}.get(r["status"], 9), -sl, -c)

    all_results.sort(key=sort_key)

    matched  = [r for r in all_results if r["status"] == "matched"]
    low_conf = [r for r in all_results if r["status"] == "low_confidence"]
    no_match = [r for r in all_results if r["status"] == "no_match"]

    print(f"\n{'═'*78}")
    print(f"  MATCHED ({len(matched)})  |  LOW CONF ({len(low_conf)})  |  NO MATCH ({len(no_match)})  "
          f"|  threshold={args.min_confidence}")
    print(f"{'═'*78}\n")

    if matched:
        print("── Matched ──────────────────────────────────────────────────────────────────")
        for r in matched:
            b  = r["best_match"]
            sl = f"  sl={b.get('sitelinks','?')}" if "sitelinks" in (b or {}) else ""
            yr = f"{r['year_start']}–{r['year_end'] or '∞'}"
            print(f"  ✓  {r['hb_name']:<35} [{yr:<14}] → {b['polity_name']:<35} "
                  f"conf={b['confidence']:.2f}  [{b['strategy']}]{sl}")

    if low_conf:
        print("\n── Low confidence (review manually) ─────────────────────────────────────────")
        for r in low_conf:
            b  = r["best_match"]
            sl = f"  sl={b.get('sitelinks','?')}" if "sitelinks" in (b or {}) else ""
            yr = f"{r['year_start']}–{r['year_end'] or '∞'}"
            print(f"  ~  {r['hb_name']:<35} [{yr:<14}] → {b['polity_name']:<35} "
                  f"conf={b['confidence']:.2f}  [{b['strategy']}]{sl}")

    if no_match:
        print("\n── No match ─────────────────────────────────────────────────────────────────")
        for r in no_match:
            yr = f"{r['year_start']}–{r['year_end'] or '∞'}"
            print(f"  ✗  {r['hb_name']:<35} [{yr}]")

    if args.apply:
        print(f"\nApplying {len(matched)} matches to territories table…")
        cur2 = conn.cursor()
        updated = 0
        for r in matched:
            b = r["best_match"]
            try:
                cur2.execute("""
                    UPDATE territories
                    SET polity_id = %s
                    WHERE id = %s
                      AND polity_id IS NULL
                      AND NOT explicitly_unlinked
                """, (b["polity_id"], r["territory_id"]))
                updated += cur2.rowcount
            except Exception as e:
                print(f"  [error] {r['hb_name']} / {r['territory_id']}: {e}", file=sys.stderr)
        conn.commit()
        print(f"territories updated: {updated}")

    if args.output:
        with open(args.output, "w") as f:
            json.dump(all_results, f, indent=2, default=str)
        print(f"\nFull results → {args.output}")

    conn.close()


if __name__ == "__main__":
    main()
