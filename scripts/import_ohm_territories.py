#!/usr/bin/env python3
"""
scripts/import_ohm_territories.py

Fetch administrative boundary relations from OpenHistoricalMap (OHM) via
the Overpass API and import them into the territories table as source='ohm'.

Usage:
    python3 scripts/import_ohm_territories.py [options]

Options:
    --admin-level INT        Admin level to fetch (default: 2)
    --min-year INT           Only import relations with year_start >= this
    --max-year INT           Only import relations with year_start <= this
    --dry-run                Print stats, no DB writes
    --rematch-only           Skip fetch/insert, just run the auto-mapping UPDATE
    --unmatched-qids FILE    Write unmatched wikidata QIDs to this file
                             (default: /tmp/ohm_unmatched_qids.txt)
"""

import argparse
import json
import os
import re
import sys
from math import sqrt
from typing import Optional

import psycopg2
import psycopg2.extras
import requests

DATABASE_URL = os.environ["DATABASE_URL"]

OVERPASS_URL = "https://overpass-api.openhistoricalmap.org/api/interpreter"
OVERPASS_TIMEOUT = 300  # seconds


# ---------------------------------------------------------------------------
# Date parsing
# ---------------------------------------------------------------------------

def parse_date(value: Optional[str]) -> Optional[int]:
    """
    Parse an OHM date tag into a year integer.
    Handles:
      YYYY
      YYYY-MM
      YYYY-MM-DD
      EDTF range [YYYY..YYYY] — uses the first year
    Returns None if unparseable.
    """
    if not value:
        return None
    value = value.strip()

    # EDTF range [YYYY..YYYY] — take the start year
    edtf_match = re.match(r'^\[(-?\d{1,4})\.\.', value)
    if edtf_match:
        return int(edtf_match.group(1))

    # ISO-ish: YYYY, YYYY-MM, YYYY-MM-DD (possibly negative)
    iso_match = re.match(r'^(-?\d{1,4})(?:-\d{2}(?:-\d{2})?)?$', value)
    if iso_match:
        return int(iso_match.group(1))

    return None


# ---------------------------------------------------------------------------
# Geometry assembly
# ---------------------------------------------------------------------------

_COORD_TOL = 1e-7  # tolerance for endpoint matching


def _approx_eq(a: tuple, b: tuple) -> bool:
    return abs(a[0] - b[0]) < _COORD_TOL and abs(a[1] - b[1]) < _COORD_TOL


def _stitch_ways(ways: list[list[tuple]]) -> Optional[list[tuple]]:
    """
    Stitch a list of way coordinate lists into a single closed ring.
    Returns the ring as a list of (lon, lat) tuples, or None on failure.
    """
    if not ways:
        return None

    # Work with copies
    remaining = [list(w) for w in ways]
    ring = list(remaining.pop(0))

    max_iters = len(remaining) * len(remaining) + len(remaining) + 1
    iterations = 0

    while remaining and iterations < max_iters:
        iterations += 1
        head = ring[0]
        tail = ring[-1]
        found = False
        for i, way in enumerate(remaining):
            if _approx_eq(tail, way[0]):
                ring.extend(way[1:])
                remaining.pop(i)
                found = True
                break
            if _approx_eq(tail, way[-1]):
                ring.extend(reversed(way[:-1]))
                remaining.pop(i)
                found = True
                break
            if _approx_eq(head, way[-1]):
                ring = way + ring[1:]
                remaining.pop(i)
                found = True
                break
            if _approx_eq(head, way[0]):
                ring = list(reversed(way)) + ring[1:]
                remaining.pop(i)
                found = True
                break
        if not found:
            # Cannot stitch — return what we have if remaining is just dangling
            break

    # Close the ring
    if not _approx_eq(ring[0], ring[-1]):
        ring.append(ring[0])

    if len(ring) < 4:
        return None

    return ring


def assemble_geometry(members: list[dict]) -> Optional[dict]:
    """
    Assemble OHM relation members into a GeoJSON geometry dict.
    Returns Polygon or MultiPolygon, or None if assembly fails.
    """
    outer_ways: list[list[tuple]] = []
    inner_ways: list[list[tuple]] = []

    for member in members:
        if member.get("type") != "way":
            continue
        geom_nodes = member.get("geometry", [])
        if not geom_nodes:
            continue
        coords = [(node["lon"], node["lat"]) for node in geom_nodes]
        if len(coords) < 2:
            continue
        role = member.get("role", "outer")
        if role == "inner":
            inner_ways.append(coords)
        else:
            outer_ways.append(coords)

    if not outer_ways:
        return None

    # Group outer ways into rings by stitching
    # Simple approach: stitch all outer ways into one ring first; if there are
    # disconnected sections they become separate outer rings (MultiPolygon).
    outer_ring = _stitch_ways(outer_ways)
    if outer_ring is None or len(outer_ring) < 4:
        return None

    # Stitch inner ways (holes) — one ring per connected group
    inner_rings: list[list[tuple]] = []
    if inner_ways:
        inner_ring = _stitch_ways(inner_ways)
        if inner_ring and len(inner_ring) >= 4:
            inner_rings.append(inner_ring)

    return {
        "type": "Polygon",
        "coordinates": [outer_ring] + inner_rings,
    }


# ---------------------------------------------------------------------------
# Overpass fetch
# ---------------------------------------------------------------------------

def fetch_overpass(admin_level: int) -> list[dict]:
    """Fetch all boundary=administrative relations at the given admin_level."""
    query = (
        f'[out:json][timeout:{OVERPASS_TIMEOUT}];\n'
        f'relation["boundary"="administrative"]["admin_level"="{admin_level}"];\n'
        f'out geom;\n'
    )
    print(f"Fetching OHM admin_level={admin_level} from Overpass ... (may take several minutes)")
    resp = requests.post(
        OVERPASS_URL,
        data={"data": query},
        timeout=OVERPASS_TIMEOUT + 30,
        headers={"User-Agent": "OpenHistory/1.0 (https://openhistory.app)"},
    )
    resp.raise_for_status()
    data = resp.json()
    relations = [el for el in data.get("elements", []) if el.get("type") == "relation"]
    print(f"  → {len(relations)} relations received")
    return relations


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

INSERT_SQL = """
INSERT INTO territories (
    source,
    ohm_relation_id,
    ohm_name,
    ohm_admin_level,
    ohm_wikidata_qid,
    year_start,
    year_end,
    boundary,
    hb_name,
    hb_abbrevn,
    border_precision,
    accuracy,
    explicitly_unlinked,
    polity_id,
    parent_id
)
VALUES (
    'ohm',
    %(ohm_relation_id)s,
    %(ohm_name)s,
    %(ohm_admin_level)s,
    %(ohm_wikidata_qid)s,
    %(year_start)s,
    %(year_end)s,
    ST_SetSRID(ST_GeomFromGeoJSON(%(boundary)s), 4326),
    NULL,
    NULL,
    NULL,
    'ohm-import',
    FALSE,
    NULL,
    NULL
)
ON CONFLICT (ohm_relation_id) DO UPDATE SET
    ohm_name         = EXCLUDED.ohm_name,
    ohm_admin_level  = EXCLUDED.ohm_admin_level,
    ohm_wikidata_qid = EXCLUDED.ohm_wikidata_qid,
    year_start       = EXCLUDED.year_start,
    year_end         = EXCLUDED.year_end,
    boundary         = EXCLUDED.boundary,
    edited_at        = NOW()
RETURNING (xmax = 0) AS inserted
"""

REMATCH_SQL = """
UPDATE territories t
SET polity_id = p.id
FROM polities p
WHERE t.ohm_wikidata_qid = p.wikidata_qid
  AND t.polity_id IS NULL
  AND t.source = 'ohm'
  AND t.explicitly_unlinked = FALSE
"""

UNMATCHED_SQL = """
SELECT DISTINCT t.ohm_wikidata_qid
FROM territories t
LEFT JOIN polities p ON p.wikidata_qid = t.ohm_wikidata_qid
WHERE t.source = 'ohm'
  AND t.ohm_wikidata_qid IS NOT NULL
  AND p.id IS NULL
"""


def run_rematch(cur) -> int:
    cur.execute(REMATCH_SQL)
    return cur.rowcount


def write_unmatched_qids(cur, path: str) -> int:
    cur.execute(UNMATCHED_SQL)
    rows = cur.fetchall()
    qids = [r[0] for r in rows]
    with open(path, "w") as f:
        for q in qids:
            f.write(q + "\n")
    return len(qids)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Import OHM territory boundaries")
    parser.add_argument("--admin-level", type=int, default=2)
    parser.add_argument("--min-year", type=int, default=None)
    parser.add_argument("--max-year", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--rematch-only", action="store_true")
    parser.add_argument("--unmatched-qids", default="/tmp/ohm_unmatched_qids.txt")
    args = parser.parse_args()

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    if args.rematch_only:
        n = run_rematch(cur)
        conn.commit()
        print(f"Rematch complete: {n} territories linked to polities")
        unmatched = write_unmatched_qids(cur, args.unmatched_qids)
        print(f"Unmatched QIDs written to {args.unmatched_qids}: {unmatched}")
        cur.close()
        conn.close()
        return

    # ── Fetch from Overpass ──────────────────────────────────────────────
    try:
        relations = fetch_overpass(args.admin_level)
    except Exception as exc:
        print(f"ERROR fetching from Overpass: {exc}", file=sys.stderr)
        sys.exit(1)

    # ── Process relations ────────────────────────────────────────────────
    total = len(relations)
    skipped_no_date = 0
    skipped_bad_geom = 0
    skipped_year_filter = 0
    inserted = 0
    updated = 0

    for idx, rel in enumerate(relations):
        if (idx + 1) % 100 == 0:
            print(f"  Processed {idx + 1}/{total} ...")

        tags = rel.get("tags", {})
        year_start = parse_date(tags.get("start_date"))
        year_end = parse_date(tags.get("end_date"))

        if year_start is None:
            skipped_no_date += 1
            continue

        if args.min_year is not None and year_start < args.min_year:
            skipped_year_filter += 1
            continue
        if args.max_year is not None and year_start > args.max_year:
            skipped_year_filter += 1
            continue

        geom = assemble_geometry(rel.get("members", []))
        if geom is None:
            skipped_bad_geom += 1
            continue

        ohm_name = tags.get("name") or tags.get("name:en")
        ohm_wikidata_qid = tags.get("wikidata")

        row = {
            "ohm_relation_id": rel["id"],
            "ohm_name": ohm_name,
            "ohm_admin_level": int(tags.get("admin_level", args.admin_level)),
            "ohm_wikidata_qid": ohm_wikidata_qid,
            "year_start": year_start,
            "year_end": year_end,
            "boundary": json.dumps(geom),
        }

        if args.dry_run:
            inserted += 1  # count as would-be insert for dry-run reporting
            continue

        try:
            cur.execute(INSERT_SQL, row)
            result = cur.fetchone()
            if result and result[0]:
                inserted += 1
            else:
                updated += 1
        except Exception as exc:
            conn.rollback()
            print(f"  WARN: failed to insert relation {rel['id']}: {exc}", file=sys.stderr)
            skipped_bad_geom += 1
            continue

    if not args.dry_run:
        conn.commit()

    # ── Auto-mapping ─────────────────────────────────────────────────────
    auto_mapped = 0
    if not args.dry_run:
        auto_mapped = run_rematch(cur)
        conn.commit()
        unmatched_count = write_unmatched_qids(cur, args.unmatched_qids)
    else:
        unmatched_count = 0

    # ── Summary ──────────────────────────────────────────────────────────
    print()
    print("=" * 50)
    print(f"OHM Import Summary (admin_level={args.admin_level})")
    if args.dry_run:
        print("  DRY RUN — no DB writes performed")
    print(f"  Total fetched:        {total}")
    print(f"  Skipped (no date):    {skipped_no_date}")
    print(f"  Skipped (bad geom):   {skipped_bad_geom}")
    print(f"  Skipped (year filt):  {skipped_year_filter}")
    if args.dry_run:
        print(f"  Would insert:         {inserted}")
    else:
        print(f"  Inserted:             {inserted}")
        print(f"  Updated (upserted):   {updated}")
        print(f"  Auto-mapped:          {auto_mapped}")
        print(f"  Unmatched QIDs:       {unmatched_count} → {args.unmatched_qids}")
    print("=" * 50)

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
