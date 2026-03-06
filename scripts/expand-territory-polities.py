#!/usr/bin/env python3
"""
scripts/expand-territory-polities.py

Walks the Wikidata succession chain (succeeded_by_qid) from each original
snapshot_polygon row and creates duplicate rows for each successor polity
whose active period falls within the snapshot's inter-snapshot interval.

Example: 1800 "France" snapshot covers 1800–1814 (until 1815 snapshot).
France → First Republic (1792-1804) → First Empire (1804-1815):
  Original row:  polity=First Republic,  sub_year_start=1800, sub_year_end=1804
  Duplicate row: polity=First Empire,    sub_year_start=1804, sub_year_end=1814
  (Bourbon Restoration starts 1815, which is the next snapshot year — covered there)

The expansion is idempotent: existing duplicates are detected and skipped.

Usage:
    python3 scripts/expand-territory-polities.py
    python3 scripts/expand-territory-polities.py --snapshot 1800
    python3 scripts/expand-territory-polities.py --snapshot 1800 --dry-run
"""

import argparse
import json
import os
import uuid
from typing import Optional

import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ["DATABASE_URL"]  # set via: export DATABASE_URL=$(railway variables get DATABASE_URL)


def expand_snapshot(snapshot_year: int, next_snapshot_year: Optional[int],
                    cur, dry_run: bool) -> dict:
    """
    Expand all original snapshot_polygons for a given snapshot year.
    Returns a stats dict.
    """
    interval_end = (next_snapshot_year - 1) if next_snapshot_year is not None else None

    # Load all polities keyed by wikidata_qid for quick lookup
    cur.execute("""
        SELECT id, wikidata_qid, name, year_start, year_end, succeeded_by_qid
        FROM polities
        WHERE wikidata_qid IS NOT NULL
    """)
    polities_by_qid = {
        row["wikidata_qid"]: dict(row)
        for row in cur.fetchall()
    }

    # Load original rows for this snapshot (source_polygon_id IS NULL = original)
    cur.execute("""
        SELECT
          sp.id, sp.snapshot_year, sp.hb_name, sp.hb_abbrevn, sp.hb_subjecto,
          sp.hb_partof, sp.border_precision, sp.polity_id, sp.boundary,
          sp.accuracy, sp.sub_year_start, sp.sub_year_end,
          p.wikidata_qid AS polity_qid, p.name AS polity_name,
          p.year_start AS polity_year_start, p.year_end AS polity_year_end,
          p.succeeded_by_qid
        FROM snapshot_polygons sp
        LEFT JOIN polities p ON p.id = sp.polity_id
        WHERE sp.snapshot_year = %s
          AND sp.source_polygon_id IS NULL
          AND sp.polity_id IS NOT NULL
        ORDER BY sp.hb_name
    """, (snapshot_year,))
    originals = [dict(r) for r in cur.fetchall()]

    # Load existing duplicates to avoid re-creating them
    cur.execute("""
        SELECT source_polygon_id, polity_id
        FROM snapshot_polygons
        WHERE snapshot_year = %s AND source_polygon_id IS NOT NULL
    """, (snapshot_year,))
    existing_duplicates: set[tuple] = {
        (str(r["source_polygon_id"]), str(r["polity_id"]))
        for r in cur.fetchall()
    }

    stats = {"chains_found": 0, "rows_created": 0, "already_existed": 0, "polities_missing": 0}

    for orig in originals:
        orig_id = str(orig["id"])
        orig_start = orig["sub_year_start"] or snapshot_year
        current_end = interval_end  # the full window for this snapshot

        # Walk the succession chain starting from this polygon's polity
        current_qid = orig["succeeded_by_qid"]
        chain = []

        visited = {orig["polity_qid"]}  # guard against cycles
        current_start = orig_start

        while current_qid:
            if current_qid in visited:
                break  # cycle detected
            visited.add(current_qid)

            successor = polities_by_qid.get(current_qid)
            if not successor:
                stats["polities_missing"] += 1
                break  # successor not in our DB

            succ_start = successor["year_start"]
            succ_end   = successor["year_end"]

            if succ_start is None:
                break  # no start date, can't place in timeline

            # Successor must start within our interval
            if succ_start <= current_start:
                break  # started at or before current position (shouldn't happen)

            if current_end is not None and succ_start > current_end:
                break  # successor starts after this snapshot's interval

            # Successor's sub-interval within our snapshot window
            sub_start = succ_start
            sub_end   = min(current_end, succ_end) if (current_end is not None and succ_end is not None) \
                        else (current_end if current_end is not None else succ_end)

            chain.append({
                "polity_id":   str(successor["id"]),
                "polity_qid":  current_qid,
                "polity_name": successor["name"],
                "sub_year_start": sub_start,
                "sub_year_end":   sub_end,
            })

            current_start  = sub_start
            current_qid    = successor["succeeded_by_qid"]

            # Stop if we've consumed the full interval
            if sub_end is not None and current_end is not None and sub_end >= current_end:
                break

        if not chain:
            continue

        stats["chains_found"] += 1
        chain_names = " → ".join(c["polity_name"] for c in chain)
        print(f"  {orig['hb_name']}: {orig['polity_name']} → {chain_names}")

        if dry_run:
            for c in chain:
                print(f"    Would create: {c['polity_name']} {c['sub_year_start']}–{c['sub_year_end']}")
            continue

        # 1. Update the original row's sub_year_end to close before first successor
        first_succ_start = chain[0]["sub_year_start"]
        cur.execute("""
            UPDATE snapshot_polygons
            SET sub_year_start = %s, sub_year_end = %s
            WHERE id = %s
        """, (orig_start, first_succ_start, orig["id"]))

        # 2. Create duplicate rows for each successor in the chain
        for entry in chain:
            key = (orig_id, entry["polity_id"])
            if key in existing_duplicates:
                stats["already_existed"] += 1
                continue

            new_id = str(uuid.uuid4())
            cur.execute("""
                INSERT INTO snapshot_polygons (
                  id, snapshot_year, hb_name, hb_abbrevn, hb_subjecto, hb_partof,
                  border_precision, polity_id, boundary, accuracy,
                  sub_year_start, sub_year_end, source_polygon_id
                )
                SELECT
                  %s, snapshot_year, hb_name, hb_abbrevn, hb_subjecto, hb_partof,
                  border_precision, %s, boundary, 'imported',
                  %s, %s, %s
                FROM snapshot_polygons WHERE id = %s
            """, (
                new_id,
                entry["polity_id"],
                entry["sub_year_start"],
                entry["sub_year_end"],
                orig["id"],
                orig["id"],
            ))
            stats["rows_created"] += 1
            existing_duplicates.add(key)

    return stats


def main():
    parser = argparse.ArgumentParser(
        description="Expand snapshot_polygons with successor polities via succession chains"
    )
    parser.add_argument(
        "--snapshot", type=int, action="append", dest="years", metavar="YEAR",
        help="Snapshot year(s) to expand (default: all loaded snapshots)",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Load all loaded snapshot years in order
    cur.execute("SELECT snapshot_year FROM territory_snapshots ORDER BY snapshot_year")
    all_years = [r["snapshot_year"] for r in cur.fetchall()]
    if not all_years:
        print("No snapshots loaded yet. Run import-territories.py first.")
        return

    # next_snapshot_year lookup
    next_year = {all_years[i]: all_years[i + 1] for i in range(len(all_years) - 1)}
    next_year[all_years[-1]] = None

    target_years = args.years if args.years else all_years

    total_created = 0
    for year in sorted(target_years):
        if year not in next_year:
            print(f"Snapshot {year} not loaded — skipping.")
            continue
        nxt = next_year[year]
        print(f"\n── Expanding snapshot {year} (interval {year}–{nxt - 1 if nxt else '∞'}) {'DRY RUN' if args.dry_run else ''}──")
        stats = expand_snapshot(year, nxt, cur, args.dry_run)
        print(f"  Chains found: {stats['chains_found']}")
        print(f"  Rows created: {stats['rows_created']}")
        if stats["already_existed"]:
            print(f"  Already existed: {stats['already_existed']}")
        if stats["polities_missing"]:
            print(f"  Successors not in DB: {stats['polities_missing']}")
        total_created += stats["rows_created"]

    if not args.dry_run:
        conn.commit()
        print(f"\n✓ Committed. Total new rows: {total_created}")
    else:
        print(f"\nDRY RUN — no changes written.")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
