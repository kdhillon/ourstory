#!/usr/bin/env python3
"""
scripts/import-territories.py

Fetches a historical-basemaps snapshot GeoJSON and imports it into the
territory_snapshots + snapshot_polygons + territory_name_mappings tables.

Source repo: https://github.com/aourednik/historical-basemaps (GPL-3.0)

Usage:
    python3 scripts/import-territories.py --snapshot 1800
    python3 scripts/import-territories.py --snapshot 1800 --dry-run
    python3 scripts/import-territories.py --snapshot 1783 --snapshot 1800

Snapshot rendering logic (in MapView):
    For a given timeline year, the active snapshot is:
        MAX(snapshot_year) WHERE snapshot_year <= current_year
    i.e. the 1800 snapshot is NOT shown before year 1800.
    Load world_1783.geojson to cover the 1783-1799 period.

Available snapshot years in historical-basemaps (as of 2026):
    -100000, -3000, -1000, -323, -200, 1, 200, 400, 500, 600, 700, 800,
    900, 1000, 1100, 1200, 1279, 1300, 1400, 1492, 1500, 1530, 1600,
    1650, 1700, 1715, 1783, 1800, 1815, 1880, 1900, 1914, 1920, 1930,
    1938, 1945, 1960, 1994, 2000, 2010
"""

import argparse
import json
import os
import sys
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ["DATABASE_URL"]  # set via: export DATABASE_URL=$(railway variables get DATABASE_URL)

HB_RAW_BASE = (
    "https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson"
)

# Local cache dir — avoids re-downloading on repeated runs
CACHE_DIR = Path(__file__).parent.parent / ".hb-cache"


def hb_filename(year: int) -> str:
    if year < 0:
        return f"world_bc{abs(year)}.geojson"
    return f"world_{year}.geojson"


def fetch_snapshot(year: int) -> dict:
    """Download (or load from cache) a historical-basemaps snapshot GeoJSON."""
    CACHE_DIR.mkdir(exist_ok=True)
    cache_path = CACHE_DIR / hb_filename(year)

    if cache_path.exists():
        print(f"  Using cached {cache_path.name}")
        with open(cache_path) as f:
            return json.load(f)

    url = f"{HB_RAW_BASE}/{hb_filename(year)}"
    print(f"  Fetching {url} ...")
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"ERROR: Could not fetch {url}: {e}", file=sys.stderr)
        sys.exit(1)

    with open(cache_path, "w") as f:
        json.dump(data, f)
    print(f"  Cached to {cache_path}")
    return data


# Generic political type words that carry no discriminative value and should be
# stripped from both sides before comparing. Without this, "Mysore Kingdom" and
# "Haji Kingdom" would share the " kingdom" suffix and get inflated similarity.
# Stripping these also makes _WORD_SUBS unnecessary: "Qing Empire" and
# "Qing dynasty" both reduce to "qing" and match perfectly.
_STOPWORDS = {
    "kingdom", "empire", "dynasty", "republic", "sultanate", "duchy",
    "principality", "confederation", "confederacy", "union", "territory",
    "province", "state", "khanate", "caliphate", "emirate", "shogunate",
    "electorate", "margraviate", "landgraviate", "palatinate", "dominion",
    "the", "of", "and",
}


def normalize(name: str) -> str:
    """Lowercase, strip generic prefixes, then remove stopword tokens."""
    s = name.lower().strip()
    for prefix in ("the ", "kingdom of ", "empire of ", "republic of ",
                   "sultanate of ", "duchy of ", "principality of ",
                   "confederation of ", "union of ", "imperial "):
        if s.startswith(prefix):
            s = s[len(prefix):]
    # Remove generic political-type words from anywhere in the name so that
    # shared suffixes like " kingdom" or " empire" don't inflate match scores.
    tokens = [t for t in s.split() if t not in _STOPWORDS]
    return " ".join(tokens).strip() if tokens else s


def similarity(a: str, b: str) -> float:
    na, nb = normalize(a), normalize(b)
    return SequenceMatcher(None, na, nb).ratio()


def match_name(
    hb_name: str,
    polity_rows: list[dict],
    snapshot_year: int,
) -> tuple[dict | None, float]:
    """
    Return (best_polity_row, score) or (None, 0.0).

    Year-aware: strongly prefer polities whose active period contains
    snapshot_year (year_start <= snapshot_year <= year_end).
    Falls back to any polity if no year-active match reaches threshold.

    Tier 1: exact normalized match among year-active polities.
    Tier 2: fuzzy match (ratio >= 0.78) among year-active polities.
    Tier 3: exact or fuzzy match among all polities (year-unaware fallback).
    """
    norm_hb = normalize(hb_name)

    def is_active(p: dict) -> bool:
        ys = p.get("year_start")
        ye = p.get("year_end")
        if ys is not None and ys > snapshot_year:
            return False
        if ye is not None and ye < snapshot_year:
            return False
        return True

    active = [p for p in polity_rows if is_active(p)]
    inactive = [p for p in polity_rows if not is_active(p)]

    def best_match(candidates: list[dict], threshold: float, allow_exact: bool = True) -> tuple[dict | None, float]:
        # Tier 1: exact (only for active polities — exact match on inactive = wrong era)
        if allow_exact:
            for p in candidates:
                if normalize(p["name"]) == norm_hb:
                    return p, 1.0
                if p["short_name"] and normalize(p["short_name"]) == norm_hb:
                    return p, 1.0
        # Tier 2: fuzzy
        best_score = 0.0
        best_polity = None
        for p in candidates:
            s = max(
                similarity(hb_name, p["name"]),
                similarity(hb_name, p["short_name"] or ""),
            )
            if s > best_score:
                best_score = s
                best_polity = p
        if best_score >= threshold:
            return best_polity, best_score
        return None, best_score

    # Try year-active polities first (lower threshold ok since context is right)
    result, score = best_match(active, threshold=0.78, allow_exact=True)
    if result:
        return result, score

    # Fall back to inactive polities — fuzzy only (no exact, to avoid wrong-era matches
    # like "France" 1800 → France Q142 which started 1958)
    result, score = best_match(inactive, threshold=0.88, allow_exact=False)
    if result:
        return result, score

    return None, 0.0


def import_snapshot(year: int, dry_run: bool, conn) -> None:
    print(f"\n── Snapshot {year} {'(DRY RUN) ' if dry_run else ''}──────────────────")

    geojson = fetch_snapshot(year)
    features = [f for f in geojson.get("features", []) if f.get("geometry")]
    print(f"  {len(features)} polygon features in snapshot")

    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Load all polities (all time periods — a polygon might match a polity
    # that's active a bit before/after the snapshot year)
    cur.execute("""
        SELECT id, wikidata_qid, name, short_name, year_start, year_end
        FROM polities
        ORDER BY name
    """)
    polity_rows = [dict(r) for r in cur.fetchall()]
    print(f"  {len(polity_rows)} polities in DB")

    # Load existing name mappings for this specific snapshot year
    cur.execute("""
        SELECT hb_name, polity_id, wikidata_qid, confidence
        FROM territory_name_mappings
        WHERE snapshot_year = %s
    """, (year,))
    existing_mappings: dict[str, dict] = {
        r["hb_name"]: dict(r) for r in cur.fetchall()
    }
    print(f"  {len(existing_mappings)} existing name mappings")

    # Check if snapshot already exists
    cur.execute("SELECT snapshot_year FROM territory_snapshots WHERE snapshot_year = %s", (year,))
    already_exists = cur.fetchone() is not None
    if already_exists:
        print(f"  NOTE: snapshot {year} already in DB — will upsert polygons")

    matched = []
    unmatched = []
    new_mappings = []

    for feat in features:
        props = feat.get("properties") or {}
        hb_name = (props.get("NAME") or "").strip()
        if not hb_name:
            continue

        geometry = feat["geometry"]
        border_precision = props.get("BORDERPRECISION")
        hb_abbrevn = props.get("ABBREVN")
        hb_subjecto = props.get("SUBJECTO")
        hb_partof = props.get("PARTOF")

        # Check existing mapping first (manual mappings are preserved)
        polity_id = None
        wikidata_qid = None
        confidence = "auto"
        score = 0.0

        if hb_name in existing_mappings:
            m = existing_mappings[hb_name]
            polity_id = m["polity_id"]
            wikidata_qid = m["wikidata_qid"]
            confidence = m["confidence"]
            score = 1.0  # existing mapping — treat as confirmed
        else:
            # Auto-match (year-aware)
            best_polity, score = match_name(hb_name, polity_rows, year)
            if best_polity:
                polity_id = str(best_polity["id"])
                wikidata_qid = best_polity["wikidata_qid"]
                confidence = "auto"
                new_mappings.append({
                    "hb_name": hb_name,
                    "polity_id": polity_id,
                    "wikidata_qid": wikidata_qid,
                    "confidence": "auto",
                    "score": score,
                })

        entry = {
            "hb_name": hb_name,
            "hb_abbrevn": hb_abbrevn,
            "hb_subjecto": hb_subjecto,
            "hb_partof": hb_partof,
            "border_precision": border_precision,
            "polity_id": polity_id,
            "wikidata_qid": wikidata_qid,
            "boundary": geometry,
            "score": round(score, 3),
            "confidence": confidence,
        }

        if polity_id:
            matched.append(entry)
        else:
            unmatched.append(entry)

    print(f"\n  Results:")
    print(f"    Matched:   {len(matched)} ({len(matched)/len(features)*100:.0f}%)")
    print(f"    Unmatched: {len(unmatched)} ({len(unmatched)/len(features)*100:.0f}%)")
    print(f"    New name mappings to persist: {len(new_mappings)}")

    if new_mappings:
        print(f"\n  Sample matches (top 10 by score):")
        for m in sorted(new_mappings, key=lambda x: -x["score"])[:10]:
            print(f"    {m['score']:.2f}  '{m['hb_name']}' → '{m['wikidata_qid']}'")

    if unmatched:
        print(f"\n  Unmatched polygons:")
        for u in sorted(unmatched, key=lambda x: x["hb_name"]):
            print(f"    '{u['hb_name']}'")

    # Write unmatched to file for manual review
    unmatched_path = Path(__file__).parent / f"territory-unmatched-{year}.json"
    unmatched_out = [{"hb_name": u["hb_name"], "snapshot_year": year} for u in unmatched]
    if not dry_run:
        with open(unmatched_path, "w") as f:
            json.dump(unmatched_out, f, indent=2)
        print(f"\n  Unmatched written to {unmatched_path.name}")

    if dry_run:
        print(f"\n  DRY RUN — no DB writes.")
        cur.close()
        return

    # ── Write to DB ──────────────────────────────────────────────────────────

    # 1. Upsert territory_snapshots row
    cur.execute("""
        INSERT INTO territory_snapshots (snapshot_year, source, hb_filename, polygon_count,
                                         imported_count, verified_count, edited_count)
        VALUES (%s, 'historical-basemaps', %s, %s, %s, 0, 0)
        ON CONFLICT (snapshot_year) DO UPDATE SET
            hb_filename    = EXCLUDED.hb_filename,
            polygon_count  = EXCLUDED.polygon_count,
            imported_count = EXCLUDED.imported_count,
            loaded_at      = NOW()
    """, (year, hb_filename(year), len(features), len(features)))

    # 2. Delete existing polygons for this snapshot (clean re-import)
    cur.execute("DELETE FROM snapshot_polygons WHERE snapshot_year = %s", (year,))

    # 3. Insert all polygons
    all_entries = matched + unmatched
    for e in all_entries:
        cur.execute("""
            INSERT INTO snapshot_polygons
              (snapshot_year, hb_name, hb_abbrevn, hb_subjecto, hb_partof,
               border_precision, polity_id, boundary, accuracy)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'imported')
        """, (
            year,
            e["hb_name"],
            e["hb_abbrevn"],
            e["hb_subjecto"],
            e["hb_partof"],
            e["border_precision"],
            e["polity_id"],
            json.dumps(e["boundary"]),
        ))

    # 4. Upsert new name mappings (never overwrite manual ones)
    for m in new_mappings:
        cur.execute("""
            INSERT INTO territory_name_mappings (hb_name, snapshot_year, polity_id, wikidata_qid, confidence)
            VALUES (%s, %s, %s, %s, 'auto')
            ON CONFLICT (hb_name, snapshot_year) DO UPDATE SET
                polity_id    = EXCLUDED.polity_id,
                wikidata_qid = EXCLUDED.wikidata_qid,
                updated_at   = NOW()
            WHERE territory_name_mappings.confidence != 'manual'
        """, (m["hb_name"], year, m["polity_id"], m["wikidata_qid"]))

    conn.commit()
    print(f"\n  ✓ {len(all_entries)} polygons inserted for snapshot {year}")
    print(f"  ✓ {len(new_mappings)} name mappings persisted")
    cur.close()


def main():
    parser = argparse.ArgumentParser(description="Import historical-basemaps snapshot(s)")
    parser.add_argument(
        "--snapshot", type=int, action="append", dest="years", metavar="YEAR",
        help="Snapshot year to import (can repeat: --snapshot 1783 --snapshot 1800)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print match results without writing to DB",
    )
    args = parser.parse_args()

    if not args.years:
        parser.error("Specify at least one --snapshot YEAR")

    conn = psycopg2.connect(DATABASE_URL)
    try:
        for year in sorted(args.years):
            import_snapshot(year, args.dry_run, conn)
    finally:
        conn.close()

    print("\nDone.")


if __name__ == "__main__":
    main()
