#!/usr/bin/env python3
"""
scripts/backfill-part-of.py

Backfills part_of_qids on existing events that were loaded before P361
extraction was added to the pipeline.

Fetches P361 ("part of") claims from the Wikidata API for every event
that has a wikidata_qid but an empty part_of_qids array, then updates
the DB in place.

Usage:
    python3 scripts/backfill-part-of.py [--limit N] [--dry-run]
"""

import argparse
import os
import sys
import time

import psycopg2
import psycopg2.extras
import requests

DATABASE_URL = os.environ["DATABASE_URL"]  # set via: export DATABASE_URL=$(railway variables get DATABASE_URL)
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
USER_AGENT   = "OurStory-pipeline/0.2 (backfill-part-of)"

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT})


def fetch_p361_batch(qids: list[str]) -> dict[str, list[str]]:
    """Returns {qid: [part_of_qid, ...]} for each QID in the batch."""
    params = {
        "action":    "wbgetentities",
        "ids":       "|".join(qids),
        "props":     "claims",
        "format":    "json",
    }
    resp = SESSION.get(WIKIDATA_API, params=params, timeout=30)
    resp.raise_for_status()
    entities = resp.json().get("entities", {})

    result: dict[str, list[str]] = {}
    for qid, entity in entities.items():
        if entity.get("missing"):
            result[qid] = []
            continue
        part_of: list[str] = []
        for stmt in entity.get("claims", {}).get("P361", []):
            snak = stmt.get("mainsnak", {})
            if snak.get("snaktype") == "value":
                val = snak["datavalue"]["value"]
                if isinstance(val, dict) and val.get("id"):
                    part_of.append(val["id"])
        result[qid] = part_of
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None,
                        help="Max number of events to process (default: all)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch from Wikidata but do not write to DB")
    args = parser.parse_args()

    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False

    with conn.cursor() as cur:
        cur.execute("""
            SELECT id, wikidata_qid FROM events
            WHERE wikidata_qid IS NOT NULL
              AND part_of_qids IS NULL
            ORDER BY year_start
            %s
        """ % (f"LIMIT {args.limit}" if args.limit else ""))
        rows = cur.fetchall()

    print(f"Found {len(rows)} events to backfill.")
    if not rows:
        print("Nothing to do.")
        return

    batch_size = 50
    total_updated = 0
    total_with_data = 0

    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        qid_to_id = {qid: db_id for db_id, qid in batch}

        print(f"  Fetching P361 for batch {i // batch_size + 1} "
              f"({len(batch)} QIDs)...", end=" ", flush=True)

        try:
            p361_map = fetch_p361_batch(list(qid_to_id.keys()))
        except Exception as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            time.sleep(2)
            continue

        updates = [
            (part_of_qids, qid_to_id[qid])
            for qid, part_of_qids in p361_map.items()
            if qid in qid_to_id
        ]
        with_data = sum(1 for part_of, _ in updates if part_of)
        print(f"{with_data}/{len(batch)} have P361 data.")
        total_with_data += with_data

        if not args.dry_run:
            with conn.cursor() as cur:
                psycopg2.extras.execute_batch(
                    cur,
                    "UPDATE events SET part_of_qids = %s WHERE id = %s",
                    [(part_of, db_id) for part_of, db_id in updates],
                )
            conn.commit()
            total_updated += len(updates)

        time.sleep(1.0)

    conn.close()
    print(f"\nDone. {total_with_data} events had P361 data.")
    if not args.dry_run:
        print(f"Updated {total_updated} rows in DB.")
    else:
        print("Dry run — no DB writes.")


if __name__ == "__main__":
    main()
