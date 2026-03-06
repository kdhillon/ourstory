#!/usr/bin/env python3
"""
Match unlinked territory HB names to polities in the DB.

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
  python3 scripts/match_territories.py --apply      # writes to territory_name_mappings
  python3 scripts/match_territories.py --limit 50
  python3 scripts/match_territories.py --min-confidence 0.75
  python3 scripts/match_territories.py --output results.json
  python3 scripts/match_territories.py --no-sitelinks   # skip Wikidata fetch
  python3 scripts/match_territories.py --overwrite-auto # re-match existing auto entries
"""

import argparse
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path

import psycopg2
import psycopg2.extras
import requests

# ── Config ─────────────────────────────────────────────────────────────────────

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://ourstory:ourstory@localhost:5433/ourstory",
)
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
    # These words are still used in _TITLE_PREFIXES for core_name stripping.
    "kingdom", "empire", "dynasty", "imperial", "imperial",
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
    "crown", "crown",
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
_DASH_RE    = re.compile(r'[\u2010\u2011\u2012\u2013\u2014\u2015\-]')  # hyphens + en/em-dashes


def normalize(s: str) -> str:
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.lower()
    # Normalize all dash variants (hyphen, en-dash, em-dash, …) to space before
    # stripping other non-word chars, so "Denmark-Norway" ≡ "Denmark–Norway".
    s = _DASH_RE.sub(" ", s)
    s = _NONWORD_RE.sub(" ", s)
    return " ".join(s.split())


def meaningful_tokens(s: str) -> set[str]:
    """Tokens after normalizing and removing stopwords."""
    return {t for t in normalize(s).split() if t not in _STOPWORDS and len(t) > 1}


def core_name(polity_name: str) -> str:
    """Strip political title prefix from a polity name."""
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
    """Return (normalized_variant, strategy_tag, confidence) to try as exact lookups."""
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
    """Territory interval [t_start, t_end] must overlap polity lifetime [p_start, p_end].
    Polities with no year_start are always accepted (undated).
    The snapshot year (t_start) itself must fall within the polity lifetime when
    the polity has a known end year — this prevents matching a polity that ended
    long before the snapshot even with generous tolerance.
    """
    if p_start is None:
        return True
    te = t_end if t_end is not None else 9999
    pe = p_end if p_end is not None else 9999
    # Basic interval overlap with tolerance
    if not ((t_start - tol) <= pe and (te + tol) >= p_start):
        return False
    # Extra: if polity has a known end year, the snapshot start must not be
    # more than tol years past it (prevents matching long-dead polities).
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
    """
    Returns:
      norm_index  : normalized_full_name → [polity, ...]
      core_index  : core_name (title stripped) → [polity, ...]
    """
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
    interval_start: int,
    interval_end: int | None,
    norm_index: dict[str, list[dict]],
    core_index: dict[str, list[dict]],
    all_polities: list[dict],
) -> list[dict]:
    """Return matches sorted by confidence desc."""
    seen_ids: set[str] = set()
    results: list[dict] = []

    def candidate_ok(p: dict) -> bool:
        return time_overlap(interval_start, interval_end,
                            p.get("year_start"), p.get("year_end"))

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
    single_word = len(hb_tokens) == 1  # single-word names need stricter matching
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
                    # Require hb_name covers ≥50% of polity's tokens
                    # Prevents "Africa" ⊆ "Caritas Middle East and North Africa"
                    if len(hb_tokens) / len(p_tokens) < 0.5:
                        continue
                    add(p, 0.80, "contained_in")
                elif p_tokens <= hb_tokens:
                    # Require polity name covers ≥60% of hb_name tokens
                    # Prevents "Spain" ⊆ "Vice-Royalty of New Spain"
                    if len(p_tokens) / len(hb_tokens) < 0.6:
                        continue
                    add(p, 0.78, "contains")
                else:
                    j = jaccard(hb_tokens, p_tokens)
                    if j >= MIN_JACCARD_HIGH:
                        add(p, 0.65 * (j / MIN_JACCARD_HIGH), "token_high")
                    elif j >= MIN_JACCARD_MED:
                        add(p, 0.50 * (j / MIN_JACCARD_MED), "token_medium")

    # 7: compound-split — for "Denmark-Norway" style names, try each part as an
    #    exact or core lookup.  Only fires when the name contains a dash/en-dash.
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
        # Prefer polities with both start AND end year (has_both=0 sorts first)
        has_both = 0 if (ys is not None and ye is not None) else 1
        # Among those, prefer tightest lifespan that still covers the interval
        lifespan = (ye - ys) if has_both == 0 else 999_999
        return (-m["confidence"], has_both, lifespan)

    results.sort(key=_rank)
    return results


# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Match territories to polities")
    parser.add_argument("--apply",          action="store_true",
                        help="Write matches to territory_name_mappings and snapshot_polygons")
    parser.add_argument("--overwrite-auto", action="store_true",
                        help="Re-match entries that already have auto confidence (skip manual)")
    parser.add_argument("--limit",          type=int, default=0)
    parser.add_argument("--min-confidence", type=float, default=DEFAULT_MIN_CONF)
    parser.add_argument("--output",         type=str, default="")
    parser.add_argument("--no-sitelinks",   action="store_true")
    args = parser.parse_args()

    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Load all polities
    cur.execute("SELECT id, name, short_name, year_start, year_end, wikidata_qid, slug FROM polities ORDER BY name")
    all_polities = [dict(r) for r in cur.fetchall()]
    print(f"Loaded {len(all_polities)} polities from DB")

    # Load existing mappings — skip manual ones always, skip auto ones unless --overwrite-auto
    cur.execute("SELECT hb_name, snapshot_year, confidence FROM territory_name_mappings")
    manual_mapped:   set[tuple] = set()
    auto_mapped:     set[tuple] = set()
    for r in cur.fetchall():
        key = (r["hb_name"], r["snapshot_year"])
        if r["confidence"] == "manual":
            manual_mapped.add(key)
        else:
            auto_mapped.add(key)
    print(f"Already mapped: {len(manual_mapped)} manual, {len(auto_mapped)} auto")

    # Load all distinct (hb_name, snapshot_year) from DB with their intervals
    cur.execute("""
        WITH snapshot_intervals AS (
            SELECT
                snapshot_year,
                LEAD(snapshot_year) OVER (ORDER BY snapshot_year) AS next_snapshot_year
            FROM territory_snapshots
        )
        SELECT DISTINCT
            sp.hb_name,
            sp.snapshot_year,
            si.snapshot_year    AS interval_start,
            si.next_snapshot_year AS interval_end
        FROM snapshot_polygons sp
        JOIN snapshot_intervals si ON si.snapshot_year = sp.snapshot_year
        WHERE NOT sp.explicitly_unlinked
        ORDER BY sp.hb_name, sp.snapshot_year
    """)
    all_territory_rows = [dict(r) for r in cur.fetchall()]

    # Build per-hb_name snapshot index (all snapshot years, for expansion at apply time)
    hb_all_snapshots: dict[str, set[int]] = {}
    for row in all_territory_rows:
        hb_all_snapshots.setdefault(row["hb_name"], set()).add(row["snapshot_year"])

    # Deduplicate: one candidate per hb_name (use earliest snapshot for interval)
    seen_names: set[str] = set()
    candidates = []
    for row in all_territory_rows:
        key = (row["hb_name"], row["snapshot_year"])
        if key in manual_mapped:
            continue  # never overwrite manual
        if key in auto_mapped and not args.overwrite_auto:
            continue  # skip auto unless asked
        if row["hb_name"] in seen_names:
            continue  # one candidate per name
        seen_names.add(row["hb_name"])
        candidates.append(row)

    print(f"Candidates to match: {len(candidates)}")

    if args.limit:
        candidates = candidates[: args.limit]
        print(f"Processing first {args.limit}")

    norm_index, core_index = build_indexes(all_polities)

    all_results = []
    for terr in candidates:
        hb_name       = terr["hb_name"]
        snapshot_year = terr["snapshot_year"]
        i_start       = terr["interval_start"]
        i_end         = terr["interval_end"]

        matches = match_territory(hb_name, i_start, i_end, norm_index, core_index, all_polities)

        if matches and matches[0]["confidence"] >= args.min_confidence:
            status = "matched"
        elif matches:
            status = "low_confidence"
        else:
            status = "no_match"

        all_results.append({
            "hb_name":       hb_name,
            "snapshot_year": snapshot_year,
            "interval":      [i_start, i_end],
            "status":        status,
            "best_match":    matches[0] if matches else None,
            "all_matches":   matches[:5],
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
            print(f"  ✓  {r['hb_name']:<35} → {b['polity_name']:<35} "
                  f"conf={b['confidence']:.2f}  [{b['strategy']}]{sl}")

    if low_conf:
        print("\n── Low confidence (review manually) ─────────────────────────────────────────")
        for r in low_conf:
            b  = r["best_match"]
            sl = f"  sl={b.get('sitelinks','?')}" if "sitelinks" in (b or {}) else ""
            print(f"  ~  {r['hb_name']:<35} → {b['polity_name']:<35} "
                  f"conf={b['confidence']:.2f}  [{b['strategy']}]{sl}")

    if no_match:
        print("\n── No match ─────────────────────────────────────────────────────────────────")
        for r in no_match:
            print(f"  ✗  {r['hb_name']}")

    if args.apply:
        to_insert = matched
        # Expand: each matched hb_name → all its snapshot_years
        rows_to_write: list[tuple] = []
        for r in to_insert:
            b = r["best_match"]
            all_years = sorted(hb_all_snapshots.get(r["hb_name"], {r["snapshot_year"]}))
            for year in all_years:
                if (r["hb_name"], year) in manual_mapped:
                    continue  # never overwrite manual
                rows_to_write.append((
                    r["hb_name"], year,
                    b["polity_id"], b.get("wikidata_qid"),
                    str(round(b["confidence"], 3)),
                    f"auto:{b['strategy']}",
                ))

        print(f"\nWriting {len(rows_to_write)} rows ({len(to_insert)} hb_names × all snapshot years)…")
        cur2 = conn.cursor()
        tnm_inserted = 0
        sp_updated   = 0
        for row in rows_to_write:
            hb_name, year, polity_id, wikidata_qid, confidence, notes = row
            try:
                cur2.execute("""
                    INSERT INTO territory_name_mappings
                        (hb_name, snapshot_year, polity_id, wikidata_qid, confidence, notes)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (hb_name, snapshot_year) DO UPDATE SET
                        polity_id    = EXCLUDED.polity_id,
                        wikidata_qid = EXCLUDED.wikidata_qid,
                        confidence   = EXCLUDED.confidence,
                        notes        = EXCLUDED.notes,
                        updated_at   = NOW()
                    WHERE territory_name_mappings.confidence != 'manual'
                """, row)
                tnm_inserted += cur2.rowcount
                # Also update snapshot_polygons so COALESCE(tnm, sp) is consistent
                cur2.execute("""
                    UPDATE snapshot_polygons
                    SET polity_id = %s
                    WHERE hb_name = %s AND snapshot_year = %s
                      AND NOT explicitly_unlinked
                """, (polity_id, hb_name, year))
                sp_updated += cur2.rowcount
            except Exception as e:
                print(f"  [error] {hb_name} / {year}: {e}", file=sys.stderr)
        conn.commit()
        print(f"territory_name_mappings: {tnm_inserted} upserted")
        print(f"snapshot_polygons:       {sp_updated} updated")

    if args.output:
        with open(args.output, "w") as f:
            json.dump(all_results, f, indent=2, default=str)
        print(f"\nFull results → {args.output}")

    conn.close()


if __name__ == "__main__":
    main()
