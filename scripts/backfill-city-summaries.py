#!/usr/bin/env python3
"""
scripts/backfill-city-summaries.py

Fetches Wikipedia summaries for all cities in the DB that currently have none.
This backfills cities loaded by previous pipeline runs before city summary
fetching was added.

Usage:
    python3 scripts/backfill-city-summaries.py
"""

import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import quote

import psycopg2
import psycopg2.extras
import requests

DATABASE_URL = os.environ["DATABASE_URL"]  # set via: export DATABASE_URL=$(railway variables get DATABASE_URL)

WIKIPEDIA_API = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"
USER_AGENT = "OurStory-pipeline/0.2 (backfill-city-summaries)"

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT})


def fetch_summary(wikipedia_title: str) -> str | None:
    url = WIKIPEDIA_API.format(title=quote(wikipedia_title, safe=""))
    try:
        resp = SESSION.get(url, timeout=15)
        if resp.status_code == 200:
            return resp.json().get("extract") or None
        return None
    except Exception:
        return None


def main():
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False

    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT id, wikipedia_title
            FROM locations
            WHERE location_type = 'city'
              AND (wikipedia_summary IS NULL OR wikipedia_summary = '')
              AND wikipedia_title IS NOT NULL
            ORDER BY created_at DESC
        """)
        rows = cur.fetchall()

    print(f"Cities needing summaries: {len(rows)}")
    if not rows:
        print("All cities have summaries. Nothing to do.")
        return

    results: dict[str, str] = {}

    with ThreadPoolExecutor(max_workers=8) as executor:
        future_to_id = {
            executor.submit(fetch_summary, row["wikipedia_title"]): str(row["id"])
            for row in rows
        }
        done = 0
        for future in as_completed(future_to_id):
            city_id = future_to_id[future]
            summary = future.result()
            if summary:
                results[city_id] = summary
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{len(rows)} fetched, {len(results)} with content")

    print(f"\nFetched {len(results)}/{len(rows)} summaries with content.")

    if not results:
        print("No summaries fetched.")
        return

    with conn.cursor() as cur:
        for city_id, summary in results.items():
            cur.execute(
                "UPDATE locations SET wikipedia_summary = %s WHERE id = %s::uuid",
                (summary, city_id),
            )
    conn.commit()
    conn.close()

    print(f"Updated {len(results)} cities with Wikipedia summaries.")
    print("Re-export GeoJSON to apply cityImportance changes:")
    print("  cd scripts && npm run export")


if __name__ == "__main__":
    main()
