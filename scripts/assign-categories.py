#!/usr/bin/env python3
"""
Assign categories to uncategorized events using P31 QID → category mapping.

This is a non-LLM, rule-based assignment using the WIKIDATA_TO_CATEGORY dict
from pipeline/extract.py. Runs against all events with categories = '{}'.

Usage:
    source .env
    python3 scripts/assign-categories.py [--dry-run] [--limit N]
"""

import argparse
import os
import sys

import psycopg2
import psycopg2.extras

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pipeline.extract import WIKIDATA_TO_CATEGORY, map_categories


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="Print changes without writing to DB")
    parser.add_argument("--limit", type=int, default=None, help="Max events to process")
    args = parser.parse_args()

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set. Run: source .env", file=sys.stderr)
        sys.exit(1)

    conn = psycopg2.connect(db_url)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    query = """
        SELECT id, title, p31_qids
        FROM events
        WHERE categories = '{}'
          AND p31_qids IS NOT NULL
          AND array_length(p31_qids, 1) > 0
        ORDER BY year_start
    """
    if args.limit:
        query += f" LIMIT {args.limit}"

    cur.execute(query)
    rows = cur.fetchall()
    print(f"Found {len(rows)} uncategorized events with P31 QIDs")

    assigned = 0
    excluded = 0
    still_empty = 0

    updates = []  # (id, categories)
    deletes = []  # ids to delete (mapped to None = noise)

    for row in rows:
        p31_qids = row["p31_qids"] or []
        categories, _ = map_categories(p31_qids)

        # Check if any P31 maps explicitly to None (noise/excluded)
        any_excluded = any(
            WIKIDATA_TO_CATEGORY.get(q) is None and q in WIKIDATA_TO_CATEGORY
            for q in p31_qids
        )
        # Only exclude if ALL known P31s map to None (not just one)
        all_excluded = p31_qids and all(
            q in WIKIDATA_TO_CATEGORY and WIKIDATA_TO_CATEGORY[q] is None
            for q in p31_qids
        )

        if categories:
            updates.append((row["id"], categories, row["title"]))
            assigned += 1
        elif all_excluded:
            deletes.append((row["id"], row["title"], p31_qids))
            excluded += 1
        else:
            still_empty += 1

    print(f"  → {assigned} will be assigned categories")
    print(f"  → {excluded} will be deleted (all P31s are noise types)")
    print(f"  → {still_empty} still have no match (unknown P31s)")

    if args.dry_run:
        print("\n-- ASSIGNMENTS (dry run) --")
        for event_id, cats, title in updates[:20]:
            print(f"  {title}: {cats}")
        if len(updates) > 20:
            print(f"  ... and {len(updates) - 20} more")
        print("\n-- DELETIONS (dry run) --")
        for event_id, title, p31s in deletes[:20]:
            print(f"  {title}: {p31s}")
        if len(deletes) > 20:
            print(f"  ... and {len(deletes) - 20} more")
        conn.close()
        return

    # Apply updates
    if updates:
        cur_write = conn.cursor()
        psycopg2.extras.execute_batch(
            cur_write,
            "UPDATE events SET categories = %s WHERE id = %s",
            [(cats, event_id) for event_id, cats, _ in updates],
        )
        print(f"\nUpdated {len(updates)} events with categories")

    # Apply deletes
    if deletes:
        cur_write = conn.cursor()
        delete_ids = [event_id for event_id, _, _ in deletes]
        cur_write.execute(
            "DELETE FROM events WHERE id = ANY(%s::uuid[])",
            (delete_ids,),
        )
        print(f"Deleted {len(deletes)} noise events")

    conn.commit()
    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
