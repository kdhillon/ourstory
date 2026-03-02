"""
pipeline/load_postgres.py

Bulk-loads locations and events into the local Docker PostgreSQL instance.

Uses psycopg2 for batch inserts. Upserts by slug (the stable Wikipedia-title-
based public ID), so:
  - Re-runs are idempotent.
  - Existing seed data rows are enriched with wikidata_qid + summaries.
  - wikidata_qid is also UNIQUE (deduplicates within a pipeline run).

Usage:
    from pipeline.load_postgres import load_all
    load_all(events, location_records)

Dependencies:
    pip install psycopg2-binary
"""

import os
import uuid
import psycopg2
import psycopg2.extras
from typing import Optional

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://ourstory:ourstory@localhost:5432/ourstory"
)

# Bump this when pipeline logic changes significantly.
# Records loaded with an older version can be identified for re-enrichment.
CURRENT_DATA_VERSION = 2


def connect():
    return psycopg2.connect(DATABASE_URL)


# ---------------------------------------------------------------------------
# Locations (renamed from cities)
# ---------------------------------------------------------------------------

def upsert_locations(conn, location_records: list[dict], pipeline_run: str = "") -> set[str]:
    """
    Upserts location records into the locations table.

    location_records: list of dicts with keys:
        wikidata_qid, name, wikipedia_title, wikipedia_url, slug,
        wikipedia_summary (optional), lat, lon,
        founded_year (optional), founded_is_fuzzy (bool),
        location_type ('city', 'region', or 'country')

    Returns set of loaded wikidata_qids (for reference; no longer used for
    UUID resolution — events now reference by QID directly).
    """
    if not location_records:
        return set()

    sql = """
        INSERT INTO locations (
            id, name, wikipedia_title, wikipedia_summary, wikipedia_url,
            lng, lat,
            founded_year, founded_is_fuzzy, dissolved_year,
            wikidata_qid, slug, location_type, p31_qids, data_version, pipeline_run
        ) VALUES (
            %(id)s, %(name)s, %(wikipedia_title)s, %(wikipedia_summary)s, %(wikipedia_url)s,
            %(lon)s, %(lat)s,
            %(founded_year)s, %(founded_is_fuzzy)s, %(dissolved_year)s,
            %(wikidata_qid)s, %(slug)s, %(location_type)s, %(p31_qids)s, %(data_version)s, %(pipeline_run)s
        )
        ON CONFLICT (slug) DO UPDATE SET
            wikidata_qid      = COALESCE(EXCLUDED.wikidata_qid, locations.wikidata_qid),
            name              = EXCLUDED.name,
            wikipedia_summary = COALESCE(EXCLUDED.wikipedia_summary, locations.wikipedia_summary),
            wikipedia_url     = COALESCE(EXCLUDED.wikipedia_url, locations.wikipedia_url),
            lng               = EXCLUDED.lng,
            lat               = EXCLUDED.lat,
            founded_year      = COALESCE(EXCLUDED.founded_year, locations.founded_year),
            founded_is_fuzzy  = EXCLUDED.founded_is_fuzzy,
            dissolved_year    = COALESCE(EXCLUDED.dissolved_year, locations.dissolved_year),
            location_type     = EXCLUDED.location_type,
            p31_qids          = EXCLUDED.p31_qids,
            data_version      = EXCLUDED.data_version,
            pipeline_run      = EXCLUDED.pipeline_run
        RETURNING wikidata_qid
    """

    loaded_qids: set[str] = set()

    with conn.cursor() as cur:
        for record in location_records:
            slug = record.get("slug") or record["name"].replace(" ", "_")
            row = {
                "id":                str(uuid.uuid4()),
                "name":              record["name"],
                "wikipedia_title":   record.get("wikipedia_title") or record["name"],
                "wikipedia_summary": record.get("wikipedia_summary"),
                "wikipedia_url":     record.get("wikipedia_url") or
                                     f"https://en.wikipedia.org/wiki/{record['name'].replace(' ', '_')}",
                "lon":               record["lon"],
                "lat":               record["lat"],
                "founded_year":      record.get("founded_year"),
                "founded_is_fuzzy":  record.get("founded_is_fuzzy", False),
                "dissolved_year":    record.get("dissolved_year"),
                "wikidata_qid":      record["wikidata_qid"],
                "slug":              slug,
                "location_type":     record.get("location_type", "city"),
                "p31_qids":          record.get("p31_qids") or [],
                "data_version":      CURRENT_DATA_VERSION,
                "pipeline_run":      pipeline_run,
            }
            cur.execute(sql, row)
            result = cur.fetchone()
            if result and result[0]:
                loaded_qids.add(result[0])
            if record["wikidata_qid"]:
                loaded_qids.add(record["wikidata_qid"])

    conn.commit()
    return loaded_qids


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------

def upsert_events(
    conn,
    event_records: list[dict],
    pipeline_run: str = "",
) -> tuple[int, int]:
    """
    Upserts event records into the events table.

    Location resolution order (no longer skips events for missing location):
      1. location_level == 'point'  → direct coords, location_wikidata_qid = NULL
      2. P276 QID present           → location_wikidata_qid = P276 QID,
                                      location_level = classifier result
      3. P17 QID present (fallback) → location_wikidata_qid = P17 QID,
                                      location_level = 'country'
      4. Neither                    → location_wikidata_qid = NULL,
                                      location_level = NULL (stored, not mapped)

    Only skips events missing year_start, title, or wikipedia_title.

    Returns (loaded_count, skipped_count).
    """
    sql = """
        INSERT INTO events (
            title, wikipedia_title, wikipedia_summary, wikipedia_url,
            year_start, year_end, date_is_fuzzy, date_range_min, date_range_max,
            location_level, lng, lat, location_wikidata_qid, location_name,
            categories, p31_qids, wikidata_qid, slug, data_version, pipeline_run
        ) VALUES (
            %(title)s, %(wikipedia_title)s, %(wikipedia_summary)s, %(wikipedia_url)s,
            %(year_start)s, %(year_end)s, %(date_is_fuzzy)s, %(date_range_min)s, %(date_range_max)s,
            %(location_level)s, %(lon)s, %(lat)s, %(location_wikidata_qid)s, %(location_name)s,
            %(categories)s, %(p31_qids)s, %(wikidata_qid)s, %(slug)s, %(data_version)s, %(pipeline_run)s
        )
        ON CONFLICT (slug) DO UPDATE SET
            wikidata_qid          = COALESCE(EXCLUDED.wikidata_qid, events.wikidata_qid),
            wikipedia_summary     = COALESCE(EXCLUDED.wikipedia_summary, events.wikipedia_summary),
            year_end              = COALESCE(EXCLUDED.year_end, events.year_end),
            date_is_fuzzy         = EXCLUDED.date_is_fuzzy,
            location_level        = EXCLUDED.location_level,
            lng                   = EXCLUDED.lng,
            lat                   = EXCLUDED.lat,
            location_wikidata_qid = EXCLUDED.location_wikidata_qid,
            location_name         = EXCLUDED.location_name,
            categories            = CASE
                WHEN array_length(EXCLUDED.categories, 1) > 0 THEN EXCLUDED.categories
                ELSE events.categories
            END,
            p31_qids              = EXCLUDED.p31_qids,
            data_version          = EXCLUDED.data_version,
            pipeline_run          = EXCLUDED.pipeline_run
    """

    loaded = 0
    skipped = 0

    with conn.cursor() as cur:
        for ev in event_records:
            # Hard requirements — skip only for missing identity/date fields
            if ev.get("year_start") is None:
                skipped += 1
                continue
            if not ev.get("title"):
                skipped += 1
                continue
            if not ev.get("wikipedia_title"):
                skipped += 1
                continue

            # Resolve location — soft reference, never skip for missing location
            location_level = ev.get("location_level")
            lon = ev.get("lon")
            lat = ev.get("lat")
            location_wikidata_qid: Optional[str] = None

            if location_level == "point":
                # Direct coordinates on the event itself
                if lon is None or lat is None:
                    # Point event with no coords — demote to unlocated
                    location_level = None
            elif ev.get("location_qid"):
                # P276 QID → soft reference
                location_wikidata_qid = ev["location_qid"]
                # location_level was already set to 'city'/'region'/'country'
                # by run_local.py after classifying the QID
            elif ev.get("country_qid"):
                # P17 fallback
                location_wikidata_qid = ev["country_qid"]
                location_level = "country"
            else:
                # No location at all — store with NULLs
                location_level = None

            location_name = ev.get("location_name") or "Unknown"
            categories = ev.get("categories") or []
            p31_qids = ev.get("p31_qids") or []

            row = {
                "title":                ev["title"],
                "wikipedia_title":      ev["wikipedia_title"],
                "wikipedia_summary":    ev.get("wikipedia_summary"),
                "wikipedia_url":        ev.get("wikipedia_url"),
                "year_start":           ev["year_start"],
                "year_end":             ev.get("year_end"),
                "date_is_fuzzy":        ev.get("date_is_fuzzy", False),
                "date_range_min":       ev.get("date_range_min"),
                "date_range_max":       ev.get("date_range_max"),
                "location_level":       location_level,
                "lon":                  lon,
                "lat":                  lat,
                "location_wikidata_qid": location_wikidata_qid,
                "location_name":        location_name,
                "categories":           categories,
                "p31_qids":             p31_qids,
                "wikidata_qid":         ev.get("wikidata_qid"),
                "slug":                 ev.get("slug"),
                "data_version":         CURRENT_DATA_VERSION,
                "pipeline_run":         pipeline_run,
            }
            cur.execute(sql, row)
            loaded += 1

    conn.commit()
    return loaded, skipped


# ---------------------------------------------------------------------------
# Convenience entry point
# ---------------------------------------------------------------------------

def load_all(
    events: list[dict],
    location_records: list[dict],
    pipeline_run: str = "",
) -> dict:
    """
    Full load sequence: locations first, then events.

    Returns a summary dict with counts.
    """
    conn = connect()
    try:
        print(f"  Loading {len(location_records)} locations...")
        loaded_qids = upsert_locations(conn, location_records, pipeline_run)
        print(f"  → {len(loaded_qids)} locations upserted.")

        print(f"  Loading {len(events)} events...")
        loaded, skipped = upsert_events(conn, events, pipeline_run)
        print(f"  → {loaded} events loaded, {skipped} skipped (no date/title).")

        return {
            "locations_loaded": len(loaded_qids),
            "events_loaded": loaded,
            "events_skipped": skipped,
        }
    finally:
        conn.close()
