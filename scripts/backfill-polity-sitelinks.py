#!/usr/bin/env python3
"""
scripts/backfill-polity-sitelinks.py

Fetches the Wikidata sitelinks count for every polity where wikidata_qid is
set but sitelinks_count is NULL, then writes the count back to the DB.

Usage:
    python3 scripts/backfill-polity-sitelinks.py
    python3 scripts/backfill-polity-sitelinks.py --limit 100
    python3 scripts/backfill-polity-sitelinks.py --dry-run
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
DELAY = 1.0
HEADERS = {"User-Agent": "OurStory-history-atlas/1.0 (backfill-polity-sitelinks; contact=local)"}


def fetch_sitelinks_counts(qids: list[str]) -> dict[str, int]:
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
        counts[qid] = 0 if entity.get("missing") == "" else len(entity.get("sitelinks", {}))
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill sitelinks count for polities")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    query = """
        SELECT wikidata_qid FROM polities
        WHERE wikidata_qid IS NOT NULL AND sitelinks_count IS NULL
        ORDER BY year_start
    """
    if args.limit:
        query += f" LIMIT {args.limit}"
    cur.execute(query)
    qids = [r["wikidata_qid"] for r in cur.fetchall()]
    cur.close()

    if not qids:
        print("Nothing to backfill.")
        conn.close()
        return

    total_batches = (len(qids) + BATCH_SIZE - 1) // BATCH_SIZE
    print(f"Fetching sitelinks for {len(qids)} polities in {total_batches} batch(es)...")

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
                    "UPDATE polities SET sitelinks_count = %s WHERE wikidata_qid = %s",
                    (count, qid),
                )
            conn.commit()

        total_updated += len(counts)
        avg = sum(counts.values()) / len(counts) if counts else 0.0
        print(f"done (avg {avg:.1f} sitelinks)")

        if i + BATCH_SIZE < len(qids):
            time.sleep(DELAY)

    print(f"\nDone. Processed {total_updated} polities.")
    if args.dry_run:
        print("[DRY RUN] No changes written.")
    conn.close()


if __name__ == "__main__":
    main()
