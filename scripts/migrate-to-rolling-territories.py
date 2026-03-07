#!/usr/bin/env python3
"""
scripts/migrate-to-rolling-territories.py

Migrate snapshot_polygons to the new territories table.

Algorithm:
1. Fetch all snapshot years to compute effective year ranges per polygon.
2. For each snapshot_polygon, compute:
   - year_start = sub_year_start if set, else snapshot_year
   - year_end   = sub_year_end   if set, else (next_snapshot_year - 1), or NULL for last snapshot
3. Group rows by hb_name, sort by year_start ascending.
4. Walk each group sequentially:
   - If the boundary JSON is identical to the previous row AND the intervals are
     contiguous (this year_start <= prev year_end + 1) → extend prev row's year_end.
   - Otherwise → emit a new territory row.
5. Batch-insert all resulting rows into territories with polity_id = NULL.
   (Assignments start fresh in the new system.)

Usage:
    source .env
    python3 scripts/migrate-to-rolling-territories.py
"""

import json
import os
import sys
from collections import defaultdict

import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ["DATABASE_URL"]


def main() -> None:
    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Check that territories table exists and is empty
    cur.execute("SELECT COUNT(*) FROM territories")
    existing = cur.fetchone()["count"]
    if existing > 0:
        print(f"ERROR: territories table already has {existing} rows. Aborting.", file=sys.stderr)
        sys.exit(1)

    # Fetch all snapshot years for next-snapshot lookup
    cur.execute("SELECT snapshot_year FROM territory_snapshots ORDER BY snapshot_year")
    snapshot_years = [r["snapshot_year"] for r in cur.fetchall()]
    if not snapshot_years:
        print("No snapshot_years found. Nothing to migrate.", file=sys.stderr)
        return

    next_yr: dict[int, int | None] = {}
    for i, yr in enumerate(snapshot_years):
        next_yr[yr] = snapshot_years[i + 1] if i + 1 < len(snapshot_years) else None

    print(f"Loaded {len(snapshot_years)} snapshot years: {snapshot_years[0]}–{snapshot_years[-1]}", file=sys.stderr)

    # Fetch all snapshot_polygons rows
    cur.execute("""
        SELECT
          snapshot_year, hb_name, hb_abbrevn, hb_subjecto, hb_partof,
          border_precision, boundary, accuracy,
          sub_year_start, sub_year_end
        FROM snapshot_polygons
        ORDER BY hb_name, COALESCE(sub_year_start, snapshot_year), snapshot_year
    """)
    rows = cur.fetchall()
    print(f"Loaded {len(rows)} snapshot_polygon rows", file=sys.stderr)

    # Compute effective year intervals for each row
    polygons = []
    for r in rows:
        snap_yr = r["snapshot_year"]
        nxt = next_yr.get(snap_yr)
        year_start = r["sub_year_start"] if r["sub_year_start"] is not None else snap_yr
        year_end = r["sub_year_end"] if r["sub_year_end"] is not None else (
            (nxt - 1) if nxt is not None else None
        )
        polygons.append({
            "hb_name":          r["hb_name"],
            "hb_abbrevn":       r["hb_abbrevn"],
            "hb_subjecto":      r["hb_subjecto"],
            "hb_partof":        r["hb_partof"],
            "border_precision": r["border_precision"],
            "boundary":         r["boundary"],  # dict from psycopg2 JSONB
            "accuracy":         r["accuracy"] or "imported",
            "year_start":       year_start,
            "year_end":         year_end,
        })

    # Group by hb_name, sort within each group by year_start
    groups: dict[str, list[dict]] = defaultdict(list)
    for p in polygons:
        groups[p["hb_name"]].append(p)
    for k in groups:
        groups[k].sort(key=lambda x: x["year_start"])

    # Walk each group, merging consecutive rows with identical geometry and contiguous intervals
    territory_rows: list[dict] = []
    merge_count = 0

    for hb_name in sorted(groups.keys()):
        group = groups[hb_name]
        current: dict | None = None

        for p in group:
            if current is None:
                current = dict(p)
                continue

            prev_end = current["year_end"]
            this_start = p["year_start"]

            # Contiguous: no gap between intervals (allows NULL year_end = infinity)
            contiguous = prev_end is None or this_start <= prev_end + 1

            # Identical geometry: exact JSON dict equality
            same_boundary = p["boundary"] == current["boundary"]

            if contiguous and same_boundary:
                # Extend current row to cover this polygon's range
                current["year_end"] = p["year_end"]
                merge_count += 1
            else:
                territory_rows.append(current)
                current = dict(p)

        if current is not None:
            territory_rows.append(current)

    print(
        f"Merging: {len(polygons)} polygons → {len(territory_rows)} territory rows "
        f"({merge_count} rows merged)",
        file=sys.stderr,
    )

    # Batch-insert into territories
    plain_cur = conn.cursor()
    for t in territory_rows:
        plain_cur.execute("""
            INSERT INTO territories (
                hb_name, hb_abbrevn, hb_subjecto, hb_partof,
                border_precision, boundary, year_start, year_end,
                accuracy, polity_id
            ) VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, NULL)
        """, (
            t["hb_name"],
            t["hb_abbrevn"],
            t["hb_subjecto"],
            t["hb_partof"],
            t["border_precision"],
            json.dumps(t["boundary"]),
            t["year_start"],
            t["year_end"],
            t["accuracy"],
        ))

    conn.commit()
    print(f"Inserted {len(territory_rows)} rows into territories", file=sys.stderr)

    # Summary stats
    plain_cur.execute("SELECT COUNT(*) FROM territories")
    final_count = plain_cur.fetchone()[0]
    print(f"territories table now has {final_count} rows", file=sys.stderr)

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
