#!/usr/bin/env python3
"""
scripts/cleanup-non-settlements.py

Classifies all pipeline-created locations in the DB using the P31 classifier
from pipeline/extract.py:

  - 'city'    → keep as-is (already correct location_type)
  - 'region'  → update location_type = 'region' (keep the record for event pinning)
  - 'country' → update location_type = 'country' (keep the record for event pinning)
  - None      → excluded geographic feature → null out event QID refs, delete record

For each excluded location being removed:
  1. Set location_wikidata_qid = NULL on all events that referenced it.
  2. Delete the location record.

Usage:
    python3 scripts/cleanup-non-settlements.py
    python3 scripts/cleanup-non-settlements.py --dry-run
"""

import argparse
import os
import sys
import time

import psycopg2
import psycopg2.extras
import requests

from pipeline.extract import classify_location

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://ourstory:ourstory@localhost:5432/ourstory",
)

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
USER_AGENT = "OurStory-pipeline/0.2 (cleanup-non-settlements)"

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT})


def fetch_p31_types(qids: list[str]) -> dict[str, list[str]]:
    """Returns {qid: [p31_qid, ...]} for a list of QIDs."""
    result: dict[str, list[str]] = {}
    batch_size = 50

    for i in range(0, len(qids), batch_size):
        batch = qids[i : i + batch_size]
        params = {
            "action":    "wbgetentities",
            "ids":       "|".join(batch),
            "props":     "claims",
            "format":    "json",
        }
        resp = SESSION.get(WIKIDATA_API, params=params, timeout=30)
        resp.raise_for_status()
        entities = resp.json().get("entities", {})

        for qid, entity in entities.items():
            if entity.get("missing"):
                result[qid] = []
                continue
            p31s = []
            for stmt in entity.get("claims", {}).get("P31", []):
                snak = stmt.get("mainsnak", {})
                if snak.get("snaktype") == "value":
                    val = snak["datavalue"]["value"]
                    if isinstance(val, dict) and val.get("id"):
                        p31s.append(val["id"])
            result[qid] = p31s

        if i + batch_size < len(qids):
            time.sleep(1.0)

    return result


def main():
    parser = argparse.ArgumentParser(description="Classify and clean up locations in DB")
    parser.add_argument("--dry-run", action="store_true", help="Print what would be done, no DB writes")
    args = parser.parse_args()

    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False

    try:
        with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            # Fetch all pipeline-created locations (those with a wikidata_qid)
            cur.execute("""
                SELECT id, name, wikidata_qid, location_type
                FROM locations
                WHERE wikidata_qid IS NOT NULL
                ORDER BY name
            """)
            pipeline_locations = cur.fetchall()

        print(f"Found {len(pipeline_locations)} pipeline-created locations to classify.")

        if not pipeline_locations:
            print("Nothing to do.")
            return

        # Batch-fetch P31 types from Wikidata
        qids = [row["wikidata_qid"] for row in pipeline_locations]
        print(f"Fetching P31 types from Wikidata for {len(qids)} QIDs...")
        p31_map = fetch_p31_types(qids)

        # Classify each location
        to_exclude: list[dict] = []       # None → delete
        to_update: list[dict] = []        # type changed (city↔region↔country)
        kept_unchanged = 0
        unknown = 0

        for row in pipeline_locations:
            qid = row["wikidata_qid"]
            p31s = p31_map.get(qid, [])
            new_type = classify_location(p31s)

            if new_type is None:
                to_exclude.append({
                    "id":   str(row["id"]),
                    "name": row["name"],
                    "qid":  qid,
                })
            elif new_type != row["location_type"]:
                to_update.append({
                    "id":       str(row["id"]),
                    "name":     row["name"],
                    "qid":      qid,
                    "old_type": row["location_type"],
                    "new_type": new_type,
                })
            else:
                # Unknown P31 or correct type — leave in place
                if not p31s:
                    unknown += 1
                else:
                    kept_unchanged += 1

        print(f"\nClassification results:")
        print(f"  Keep unchanged:          {kept_unchanged}")
        print(f"  Update location_type:    {len(to_update)}")
        print(f"  Exclude (delete):        {len(to_exclude)}")
        print(f"  Unknown (no P31):        {unknown} — left in place")

        if to_update:
            print(f"\nLocations to update ({len(to_update)}):")
            for item in to_update:
                print(f"  {item['name']} ({item['qid']}): {item['old_type']} → {item['new_type']}")

        if to_exclude:
            print(f"\nLocations to exclude/delete ({len(to_exclude)}):")
            for item in to_exclude:
                print(f"  {item['name']} ({item['qid']})")

        if not to_update and not to_exclude:
            print("\nDatabase is clean. No changes needed.")
            return

        if args.dry_run:
            print("\n[DRY RUN] No changes made.")
            return

        print(f"\nApplying changes...")

        updated_types = 0
        nulled_event_refs = 0
        deleted_locations = 0

        with conn.cursor() as cur:
            # Update location_type for region/country reclassifications
            for item in to_update:
                cur.execute(
                    "UPDATE locations SET location_type = %s WHERE id = %s::uuid",
                    (item["new_type"], item["id"]),
                )
                updated_types += cur.rowcount

            # For excluded locations: null out event QID references, then delete
            for item in to_exclude:
                # Step 1: Clear the soft QID reference on events
                cur.execute("""
                    UPDATE events
                    SET location_wikidata_qid = NULL,
                        location_level = NULL
                    WHERE location_wikidata_qid = %s
                """, (item["qid"],))
                nulled_event_refs += cur.rowcount

                # Step 2: Delete the excluded location record
                cur.execute("DELETE FROM locations WHERE id = %s::uuid", (item["id"],))
                deleted_locations += cur.rowcount

        conn.commit()
        print(f"\nDone.")
        print(f"  Location types updated:          {updated_types}")
        print(f"  Event QID references nulled out: {nulled_event_refs}")
        print(f"  Excluded location records deleted: {deleted_locations}")
        print(f"\nNext step: re-export GeoJSON")
        print("  cd scripts && npm run export")

    except Exception as exc:
        conn.rollback()
        print(f"\nERROR: {exc}", file=sys.stderr)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
