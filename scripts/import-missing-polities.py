#!/usr/bin/env python3
"""
Import polities for unmatched territory names.

For each hb_name that has no linked polity, search Wikidata for the name,
find the best matching entity, and import it into the polities table.
Only imports entities not already in the DB (by wikidata_qid).

Usage:
  source .env
  python3 scripts/import-missing-polities.py            # dry run
  python3 scripts/import-missing-polities.py --apply    # write to DB
  python3 scripts/import-missing-polities.py --limit 50 # cap results
"""

import argparse
import os
import re
import sys
import time
import unicodedata

import psycopg2
import psycopg2.extras
import requests

DATABASE_URL = os.environ["DATABASE_URL"]  # set via: source .env

WDQS_SPARQL  = "https://query.wikidata.org/sparql"
WDQS_TIMEOUT = 30
WD_API       = "https://www.wikidata.org/w/api.php"
WP_API       = "https://en.wikipedia.org/w/api.php"

# Wikidata P31 classes that indicate a polity-like entity
POLITY_P31 = {
    "Q6256", "Q3024240",   # country, historical country
    "Q7270", "Q417175",    # republic, historical kingdom
    "Q48349", "Q159067",   # empire, confederation
    "Q41710", "Q131596",   # ethnic group, indigenous people
    "Q1137806", "Q4358176",# native american tribe, indigenous nation
    "Q484736",             # first nation
    "Q1642488", "Q133311", # chiefdom, tribe
    "Q200976", "Q12759805",# khanate, sultanate
}

POLITY_TYPE_MAP = {
    "Q48349": "empire", "Q159067": "empire",
    "Q417175": "kingdom", "Q6256": "kingdom",
    "Q7270": "republic",
    "Q159067": "confederation", "Q170156": "confederation",
    "Q12759805": "sultanate",
    "Q41710": "people", "Q131596": "people",
    "Q1137806": "people", "Q4358176": "people",
    "Q484736": "people", "Q1642488": "people", "Q133311": "people",
}

_DASH_RE    = re.compile(r'[\u2010-\u2015\-]')
_PAREN_RE   = re.compile(r'\s*\([^)]*\)')
_NONWORD_RE = re.compile(r'[^\w\s]')

def normalize(s: str) -> str:
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return " ".join(_NONWORD_RE.sub(" ", _DASH_RE.sub(" ", s.lower())).split())

def search_wikidata(name: str) -> list[dict]:
    """Search Wikidata entity API for name, return top results."""
    try:
        resp = requests.get(WD_API, params={
            "action": "wbsearchentities",
            "search": name,
            "language": "en",
            "limit": 5,
            "format": "json",
        }, timeout=10)
        resp.raise_for_status()
        return resp.json().get("search", [])
    except Exception:
        return []

def get_entity(qid: str) -> dict | None:
    """Fetch full entity data from Wikidata."""
    try:
        resp = requests.get(WD_API, params={
            "action": "wbgetentities",
            "ids": qid,
            "props": "claims|labels|sitelinks",
            "languages": "en",
            "format": "json",
        }, timeout=15)
        resp.raise_for_status()
        entities = resp.json().get("entities", {})
        return entities.get(qid)
    except Exception:
        return None

def get_claim_qid(claims: dict, prop: str) -> str | None:
    vals = claims.get(prop, [])
    for v in vals:
        try:
            return v["mainsnak"]["datavalue"]["value"]["id"]
        except (KeyError, TypeError):
            pass
    return None

def get_claim_year(claims: dict, prop: str) -> int | None:
    vals = claims.get(prop, [])
    for v in vals:
        try:
            t = v["mainsnak"]["datavalue"]["value"]["time"]
            # format: +1800-01-01T00:00:00Z or -0480-01-01T00:00:00Z
            m = re.match(r'([+-])(\d+)-', t)
            if m:
                y = int(m.group(2))
                return -y if m.group(1) == "-" else y
        except (KeyError, TypeError):
            pass
    return None

def get_coord(claims: dict) -> tuple[float, float] | None:
    vals = claims.get("P625", [])
    for v in vals:
        try:
            loc = v["mainsnak"]["datavalue"]["value"]
            return float(loc["longitude"]), float(loc["latitude"])
        except (KeyError, TypeError):
            pass
    return None

def get_wp_summary(wp_title: str) -> str | None:
    try:
        resp = requests.get(WP_API, params={
            "action": "query",
            "titles": wp_title,
            "prop": "extracts",
            "exintro": True,
            "explaintext": True,
            "format": "json",
        }, timeout=10)
        resp.raise_for_status()
        pages = resp.json()["query"]["pages"]
        page = next(iter(pages.values()))
        return (page.get("extract") or "").strip()[:2000] or None
    except Exception:
        return None

def classify_polity(claims: dict) -> str:
    p31_vals = claims.get("P31", [])
    for v in p31_vals:
        try:
            qid = v["mainsnak"]["datavalue"]["value"]["id"]
            if qid in POLITY_TYPE_MAP:
                return POLITY_TYPE_MAP[qid]
        except (KeyError, TypeError):
            pass
    return "other"

def slugify(s: str) -> str:
    s = normalize(s)
    s = re.sub(r'[^\w\s-]', '', s)
    return re.sub(r'[\s_]+', '-', s).strip('-')

def best_match(name: str, results: list[dict]) -> dict | None:
    """Pick the result whose label most closely matches the territory name."""
    name_norm = normalize(name)
    # Strip parenthetical from hb_name for matching
    name_bare = normalize(_PAREN_RE.sub("", name))
    for r in results:
        label_norm = normalize(r.get("label", ""))
        if label_norm == name_norm or label_norm == name_bare:
            return r
        # Also accept if label matches when stripping parenthetical from label
        label_bare = normalize(_PAREN_RE.sub("", r.get("label", "")))
        if label_bare == name_bare and name_bare:
            return r
    return None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Write to DB")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--snapshot", type=int, default=0,
                        help="Only consider territories from this snapshot year")
    args = parser.parse_args()

    conn = psycopg2.connect(DATABASE_URL)
    cur  = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Load existing QIDs so we don't re-import
    cur.execute("SELECT wikidata_qid FROM polities WHERE wikidata_qid IS NOT NULL")
    existing_qids: set[str] = {r["wikidata_qid"] for r in cur.fetchall()}
    print(f"Existing polities in DB: {len(existing_qids)}")

    # Get distinct unmatched territory names
    snapshot_filter = "AND sp.snapshot_year = %s" if args.snapshot else ""
    params = [args.snapshot] if args.snapshot else []
    cur.execute(f"""
        SELECT DISTINCT sp.hb_name
        FROM snapshot_polygons sp
        WHERE NOT sp.explicitly_unlinked
          AND sp.polity_id IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM territory_name_mappings tnm
              WHERE tnm.hb_name = sp.hb_name
                AND tnm.polity_id IS NOT NULL
          )
        {snapshot_filter}
        ORDER BY sp.hb_name
    """, params)
    names = [r["hb_name"] for r in cur.fetchall()]
    print(f"Unmatched territory names: {len(names)}")

    if args.limit:
        names = names[:args.limit]
        print(f"Processing first {args.limit}")

    imported = []
    skipped  = []
    no_match = []

    for i, name in enumerate(names):
        # Try bare name first, then without parenthetical
        search_name = _PAREN_RE.sub("", name).strip() or name
        results = search_wikidata(search_name)
        time.sleep(0.15)  # be polite to Wikidata API

        match = best_match(name, results)
        if not match:
            no_match.append(name)
            print(f"  ✗  {name}")
            continue

        qid = match["id"]
        label = match.get("label", name)

        if qid in existing_qids:
            skipped.append((name, qid, label))
            print(f"  ↷  {name} → {label} ({qid}) already in DB")
            continue

        # Fetch full entity to get dates, coords, type
        entity = get_entity(qid)
        if not entity:
            no_match.append(name)
            print(f"  ✗  {name} — could not fetch entity {qid}")
            continue
        time.sleep(0.1)

        claims    = entity.get("claims", {})
        polity_type = classify_polity(claims)
        year_start  = get_claim_year(claims, "P571") or get_claim_year(claims, "P580")
        year_end    = get_claim_year(claims, "P576") or get_claim_year(claims, "P582")
        coord       = get_coord(claims)
        lng = coord[0] if coord else None
        lat = coord[1] if coord else None

        # Wikipedia title from sitelinks
        sitelinks   = entity.get("sitelinks", {})
        wp_title    = sitelinks.get("enwiki", {}).get("title")
        wp_summary  = None
        wp_url      = None
        if wp_title:
            wp_summary = get_wp_summary(wp_title)
            wp_url = f"https://en.wikipedia.org/wiki/{wp_title.replace(' ', '_')}"
            time.sleep(0.1)

        slug = slugify(label)

        print(f"  ✓  {name} → {label} ({qid}) [{polity_type}] {year_start}–{year_end}")

        if args.apply:
            cur2 = conn.cursor()
            try:
                cur2.execute("""
                    INSERT INTO polities
                        (wikidata_qid, slug, name, polity_type,
                         year_start, year_end,
                         lng, lat,
                         wikipedia_title, wikipedia_summary, wikipedia_url,
                         pipeline_run)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'import-missing')
                    ON CONFLICT (wikidata_qid) DO NOTHING
                """, (qid, slug, label, polity_type,
                      year_start, year_end,
                      lng, lat,
                      wp_title, wp_summary, wp_url))
                conn.commit()
                existing_qids.add(qid)
                imported.append((name, qid, label))
            except Exception as e:
                conn.rollback()
                print(f"    [error] {e}", file=sys.stderr)
        else:
            imported.append((name, qid, label))

    print(f"\n{'─'*60}")
    print(f"  Matched/importable: {len(imported)}")
    print(f"  Already in DB:      {len(skipped)}")
    print(f"  No match:           {len(no_match)}")
    if not args.apply and imported:
        print("\n  Run with --apply to write to DB")

    conn.close()

if __name__ == "__main__":
    main()
