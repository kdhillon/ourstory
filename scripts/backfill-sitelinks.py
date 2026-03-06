#!/usr/bin/env python3
"""
scripts/backfill-sitelinks.py

Fetches the Wikidata sitelinks count for every event where wikidata_qid is
set but sitelinks_count is NULL, then writes the count back to the DB.

The sitelinks count is the number of Wikipedia language editions that have an
article about the event — a reliable, language-agnostic "importance" signal
that requires no LLM and is stable over time.

Usage:
    python3 scripts/backfill-sitelinks.py             # process all NULL events
    python3 scripts/backfill-sitelinks.py --limit 200
    python3 scripts/backfill-sitelinks.py --dry-run   # fetch but don't write
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
BATCH_SIZE = 50
DELAY = 1.0  # seconds between batches
HEADERS = {"User-Agent": "OurStory-history-atlas/1.0 (backfill-sitelinks; contact=local)"}


def fetch_sitelinks_counts(qids: list[str]) -> dict[str, int]:
    """Return {qid: sitelinks_count} for a batch of Wikidata QIDs."""
    params = {
        "action": "wbgetentities",
        "ids": "|".join(qids),
        "props": "sitelinks",
        "format": "json",
    }
    resp = requests.get(WIKIDATA_API, params=params, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    counts: dict[str, int] = {}
    for qid in qids:
        entity = data.get("entities", {}).get(qid, {})
        if entity.get("missing") == "":
            counts[qid] = 0
        else:
            counts[qid] = len(entity.get("sitelinks", {}))
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill sitelinks count for events")
    parser.add_argument("--limit", type=int, default=None, help="Max events to process")
    parser.add_argument("--dry-run", action="store_true", help="Fetch but don't write to DB")
    args = parser.parse_args()

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    query = """
        SELECT wikidata_qid FROM events
        WHERE wikidata_qid IS NOT NULL AND sitelinks_count IS NULL
        ORDER BY year_start
    """
    if args.limit:
        query += f" LIMIT {args.limit}"
    cur.execute(query)
    rows = cur.fetchall()
    qids = [r["wikidata_qid"] for r in rows]
    cur.close()

    if not qids:
        print("No events to backfill.")
        conn.close()
        return

    total_batches = (len(qids) + BATCH_SIZE - 1) // BATCH_SIZE
    print(f"Fetching sitelinks for {len(qids)} events in {total_batches} batch(es)...")

    update_cur = conn.cursor()
    total_updated = 0

    for i in range(0, len(qids), BATCH_SIZE):
        batch = qids[i:i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        print(f"  Batch {batch_num}/{total_batches}: {len(batch)} QIDs...", end=" ", flush=True)

        try:
            counts = fetch_sitelinks_counts(batch)
        except Exception as e:
            print(f"\nERROR fetching batch {batch_num}: {e}", file=sys.stderr)
            conn.rollback()
            conn.close()
            sys.exit(1)

        if not args.dry_run:
            for qid, count in counts.items():
                update_cur.execute(
                    "UPDATE events SET sitelinks_count = %s WHERE wikidata_qid = %s",
                    (count, qid),
                )
            conn.commit()

        total_updated += len(counts)
        avg = sum(counts.values()) / len(counts) if counts else 0.0
        print(f"done (avg {avg:.1f} sitelinks)")

        if i + BATCH_SIZE < len(qids):
            time.sleep(DELAY)

    print(f"\nDone. Processed {total_updated} events.")
    if args.dry_run:
        print("[DRY RUN] No changes written to database.")
    conn.close()


if __name__ == "__main__":
    main()
