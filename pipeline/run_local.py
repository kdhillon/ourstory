#!/usr/bin/env python3
"""
pipeline/run_local.py  —  Run 1 & Run 2: local API-based data ingestion

Fetches event QIDs from Wikidata SPARQL, batch-fetches entity JSON from the
Wikidata API, fetches Wikipedia summaries in parallel, extracts structured
data, resolves location QIDs to coordinates, and loads everything into the
local Docker PostgreSQL instance.

No GCP required. All data comes from public Wikidata / Wikipedia APIs.

Usage:
    python3 -m pipeline.run_local [--limit N]

    Default limit: 500 events (Run 1). Set --limit 5000 for Run 2.

Dependencies:
    pip install requests psycopg2-binary

Rate limits:
    Wikidata API:    50 QIDs/request, ~1 req/sec safe limit
    WDQS SPARQL:     60-second timeout; queries below are type-scoped (<10 sec)
    Wikipedia REST:  200 req/sec (no issue); parallelized with 8 threads here
"""

import argparse
import datetime
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional
from urllib.parse import quote

import requests

from pipeline.extract import classify_location, extract_event, make_slug, parse_wikidata_time
from pipeline.load_postgres import load_all

# ---------------------------------------------------------------------------
# SPARQL category queries
# Each entry: (category_label, root_class_QID, per-query_limit)
# Five categories × (limit // 5) events each = `limit` total QIDs.
# ---------------------------------------------------------------------------

SPARQL_CATEGORIES = [
    # Military
    ("battles",        "Q178561"),   # battle
    ("wars",           "Q198"),      # war
    ("sieges",         "Q188686"),   # siege
    ("naval battles",  "Q831663"),   # naval battle
    # Politics
    ("revolutions",    "Q10931"),    # revolution
    ("elections",      "Q40231"),    # election
    ("coups",          "Q45382"),    # coup d'état (Q45382 is more widely used than Q1781513)
    ("treaties",       "Q131569"),   # treaty
    ("political murder","Q1139665"), # political murder / assassination
    # Disasters
    ("disasters",      "Q124490"),   # natural disaster
    ("epidemics",      "Q3241045"),  # epidemic / pandemic
    ("earthquakes",    "Q7944"),     # earthquake
    ("famines",        "Q168247"),   # famine
    ("volcanic eruptions","Q7692360"),  # volcanic eruption (Q8928 is 'constellation')
    ("floods",         "Q8092"),     # flood
    ("wildfires",      "Q3839081"),  # wildfire
    ("city fires",     "Q838718"),   # city fire (Great Fire of London etc.)
    ("massacres",      "Q3199915"),  # massacre
    # Exploration & Science
    ("expeditions",    "Q170584"),   # expedition (more items than Q2685356)
    ("conquests",      "Q1361229"),  # conquest
    ("inventions",     "Q4026292"),  # invention
    ("spaceflights",   "Q752783"),   # human spaceflight
    ("sci experiments","Q11862829"), # scientific experiment
    # Religion
    ("councils",       "Q82821"),    # ecclesiastical council
    ("papal elections","Q29102902"), # papal election
]

WDQS_ENDPOINT = "https://query.wikidata.org/sparql"
WIKIDATA_API  = "https://www.wikidata.org/w/api.php"
WIKIPEDIA_API = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"

USER_AGENT = "OurStory-pipeline/0.2 (https://github.com/ourstory; data@ourstory.app)"

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT})


# ---------------------------------------------------------------------------
# SPARQL: fetch QIDs
# ---------------------------------------------------------------------------

def fetch_sparql_qids(
    class_qid: str,
    limit: int,
    max_year: int = 2015,
    min_year: Optional[int] = None,
) -> list[str]:
    """
    Fetches up to `limit` Wikidata QIDs for entities that are:
      - instance of (or subclass of) class_qid
      - have a date (P585, P580, or P571) within [min_year, max_year]
      - have an English Wikipedia article

    min_year is optional; omit for no lower bound.
    Returns a list of Q-ID strings (e.g. ['Q178561', ...]).
    """
    min_filter = f" && YEAR(?date) >= {min_year}" if min_year is not None else ""
    query = f"""
    SELECT DISTINCT ?item WHERE {{
      ?item wdt:P31/wdt:P279* wd:{class_qid} .
      {{
        ?item wdt:P585 ?date .
        FILTER(YEAR(?date) <= {max_year}{min_filter})
      }} UNION {{
        ?item wdt:P580 ?date .
        FILTER(YEAR(?date) <= {max_year}{min_filter})
      }} UNION {{
        ?item wdt:P571 ?date .
        FILTER(YEAR(?date) <= {max_year}{min_filter})
      }}
      ?article schema:about ?item ;
               schema:isPartOf <https://en.wikipedia.org/> .
    }}
    LIMIT {limit}
    """

    resp = SESSION.get(
        WDQS_ENDPOINT,
        params={"query": query, "format": "json"},
        headers={"Accept": "application/sparql-results+json"},
        timeout=55,  # WDQS hard limit is 60s; leave a margin
    )
    resp.raise_for_status()
    data = resp.json()
    qids = [
        binding["item"]["value"].split("/")[-1]
        for binding in data["results"]["bindings"]
    ]
    return qids


# ---------------------------------------------------------------------------
# Wikidata API: batch-fetch entities (50 per request)
# ---------------------------------------------------------------------------

def fetch_wikidata_entities(qids: list[str]) -> dict:
    """
    Fetches entity JSON from the Wikidata API for a list of QIDs.
    Splits into batches of 50 (API limit) and merges results.

    Returns {qid: entity_dict}.
    """
    all_entities: dict = {}
    batch_size = 50

    for i in range(0, len(qids), batch_size):
        batch = qids[i : i + batch_size]
        params = {
            "action":    "wbgetentities",
            "ids":       "|".join(batch),
            "props":     "labels|claims|sitelinks",
            "languages": "en",
            "sitefilter": "enwiki",
            "format":    "json",
        }
        resp = SESSION.get(WIKIDATA_API, params=params, timeout=30)
        resp.raise_for_status()
        entities = resp.json().get("entities", {})
        all_entities.update(entities)

        # Polite rate limiting: 1 request/second
        if i + batch_size < len(qids):
            time.sleep(1.0)

    return all_entities


# ---------------------------------------------------------------------------
# Wikidata API: resolve location QIDs (P276, P17)
# ---------------------------------------------------------------------------

def resolve_qid_labels_and_coords(qids: list[str]) -> dict[str, dict]:
    """
    Batch-resolves a list of QIDs to their English labels and P625 coordinates.

    Returns:
        {qid: {label, lat, lon, wikipedia_title, slug}}

    Used for:
      - P276 (location of event) → create city records + get location_name
      - P17  (country of event)  → get location_name fallback
    """
    if not qids:
        return {}

    result: dict[str, dict] = {}
    unique_qids = list(set(qids))
    batch_size = 50

    for i in range(0, len(unique_qids), batch_size):
        batch = unique_qids[i : i + batch_size]
        params = {
            "action":    "wbgetentities",
            "ids":       "|".join(batch),
            "props":     "labels|claims|sitelinks",
            "languages": "en",
            "sitefilter": "enwiki",
            "format":    "json",
        }
        resp = SESSION.get(WIKIDATA_API, params=params, timeout=30)
        resp.raise_for_status()
        entities = resp.json().get("entities", {})

        for qid, entity in entities.items():
            if entity.get("missing"):
                continue

            label = entity.get("labels", {}).get("en", {}).get("value")
            claims = entity.get("claims", {})

            # Coordinates
            lat, lon = None, None
            coord_val = None
            for stmt in claims.get("P625", []):
                snak = stmt.get("mainsnak", {})
                if snak.get("snaktype") == "value":
                    coord_val = snak["datavalue"]["value"]
                    break
            if coord_val and isinstance(coord_val, dict):
                lat = coord_val.get("latitude")
                lon = coord_val.get("longitude")

            # Wikipedia sitelink
            enwiki = entity.get("sitelinks", {}).get("enwiki", {})
            wikipedia_title = enwiki.get("title")
            slug = make_slug(wikipedia_title) if wikipedia_title else (
                label.replace(" ", "_") if label else None
            )

            # P31 (instance of) — used to classify entity type
            p31_qids = []
            for stmt in claims.get("P31", []):
                snak = stmt.get("mainsnak", {})
                if snak.get("snaktype") == "value":
                    val = snak["datavalue"]["value"]
                    if isinstance(val, dict) and val.get("id"):
                        p31_qids.append(val["id"])

            # P571 inception (founding date)
            founded_year, founded_is_fuzzy = None, False
            for stmt in claims.get("P571", []):
                snak = stmt.get("mainsnak", {})
                if snak.get("snaktype") == "value":
                    val = snak["datavalue"]["value"]
                    if isinstance(val, dict) and "time" in val:
                        founded_year, founded_is_fuzzy = parse_wikidata_time(
                            val["time"], val.get("precision", 9)
                        )
                        break

            # P576 dissolved / abolished
            dissolved_year = None
            for stmt in claims.get("P576", []):
                snak = stmt.get("mainsnak", {})
                if snak.get("snaktype") == "value":
                    val = snak["datavalue"]["value"]
                    if isinstance(val, dict) and "time" in val:
                        dissolved_year, _ = parse_wikidata_time(
                            val["time"], val.get("precision", 9)
                        )
                        break

            result[qid] = {
                "label":            label,
                "lat":              lat,
                "lon":              lon,
                "wikipedia_title":  wikipedia_title,
                "wikipedia_url":    (
                    f"https://en.wikipedia.org/wiki/{wikipedia_title.replace(' ', '_')}"
                    if wikipedia_title else None
                ),
                "slug":             slug,
                "p31_qids":         p31_qids,
                "founded_year":     founded_year,
                "founded_is_fuzzy": founded_is_fuzzy,
                "dissolved_year":   dissolved_year,
            }

        if i + batch_size < len(unique_qids):
            time.sleep(1.0)

    return result


# ---------------------------------------------------------------------------
# Wikipedia REST API: fetch summaries (parallelized)
# ---------------------------------------------------------------------------

def fetch_wikipedia_summary(wikipedia_title: str) -> Optional[str]:
    """Fetches the first-paragraph summary for a Wikipedia article."""
    url = WIKIPEDIA_API.format(title=quote(wikipedia_title, safe=""))
    try:
        resp = SESSION.get(url, timeout=15)
        if resp.status_code == 200:
            return resp.json().get("extract", "")
        return None
    except Exception:
        return None


def fetch_summaries_parallel(events: list[dict], max_workers: int = 8) -> None:
    """
    Fetches Wikipedia summaries for all events/cities in parallel (in-place update).
    Only fetches for records that have a wikipedia_title and no summary yet.
    Works for both event dicts and city record dicts.
    """
    to_fetch = [
        (i, ev["wikipedia_title"])
        for i, ev in enumerate(events)
        if ev.get("wikipedia_title") and not ev.get("wikipedia_summary")
    ]

    if not to_fetch:
        return

    print(f"  Fetching {len(to_fetch)} Wikipedia summaries ({max_workers} threads)...")

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_idx = {
            executor.submit(fetch_wikipedia_summary, title): idx
            for idx, title in to_fetch
        }
        done = 0
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                events[idx]["wikipedia_summary"] = future.result()
            except Exception:
                pass
            done += 1
            if done % 50 == 0:
                print(f"    {done}/{len(to_fetch)} summaries fetched")


# ---------------------------------------------------------------------------
# Location name resolution + location_level refinement
# ---------------------------------------------------------------------------

def resolve_location_names(events: list[dict], qid_data: dict[str, dict]) -> None:
    """
    Fills in location_name and refines location_level for each event (in-place)
    using resolved QID data.

    Priority for location_name:
      1. P276 (location) label — most specific
      2. P17  (country) label  — fallback
      3. 'Unknown'             — last resort

    Also updates location_level from 'city' (the extract.py placeholder) to the
    actual type returned by classify_location() for P276 entities.
    """
    for ev in events:
        loc_qid     = ev.get("location_qid")
        country_qid = ev.get("country_qid")

        # Refine location_level for P276-linked events
        if ev.get("location_level") == "city" and loc_qid and loc_qid in qid_data:
            p31_qids = qid_data[loc_qid].get("p31_qids", [])
            loc_type = classify_location(p31_qids)
            if loc_type is None:
                # Excluded geographic feature — clear the location QID
                ev["location_qid"] = None
                ev["location_level"] = None
            else:
                ev["location_level"] = loc_type

        # Fill location_name if not already set
        if ev.get("location_name"):
            continue

        if loc_qid and loc_qid in qid_data and ev.get("location_qid") is not None:
            label = qid_data[loc_qid].get("label")
            if label:
                ev["location_name"] = label
                continue

        if country_qid and country_qid in qid_data:
            label = qid_data[country_qid].get("label")
            if label:
                ev["location_name"] = label
                continue

        ev["location_name"] = "Unknown"


# ---------------------------------------------------------------------------
# Build location records (cities, regions, countries) from resolved QIDs
# ---------------------------------------------------------------------------

def build_location_records(events: list[dict], qid_data: dict[str, dict]) -> list[dict]:
    """
    Builds location records from unique P276 and P17 QIDs that have coordinates.

    Uses classify_location() to determine location_type for each record:
      - 'city'    → from P276 QIDs classified as settlements
      - 'region'  → from P276 QIDs classified as sub-national regions
      - 'country' → from P276 QIDs classified as countries, plus all P17 QIDs

    Excluded types (rivers, mountains, etc.) are not added to the locations table.
    QIDs without coordinates are skipped (can't be displayed on map).
    """
    seen_qids: set[str] = set()
    location_records: list[dict] = []

    # Collect all P276 QIDs → classify
    for ev in events:
        loc_qid = ev.get("location_qid")
        if not loc_qid or loc_qid in seen_qids:
            continue
        seen_qids.add(loc_qid)

        qdata = qid_data.get(loc_qid)
        if not qdata or not qdata.get("label"):
            continue
        if qdata.get("lat") is None or qdata.get("lon") is None:
            continue

        p31_qids = qdata.get("p31_qids", [])
        loc_type = classify_location(p31_qids)
        if loc_type is None:
            continue  # excluded geographic feature

        location_records.append({
            "wikidata_qid":      loc_qid,
            "name":              qdata["label"],
            "wikipedia_title":   qdata.get("wikipedia_title") or qdata["label"],
            "wikipedia_url":     qdata.get("wikipedia_url"),
            "slug":              qdata.get("slug"),
            "wikipedia_summary": None,
            "lat":               qdata["lat"],
            "lon":               qdata["lon"],
            "founded_year":      qdata.get("founded_year"),
            "founded_is_fuzzy":  qdata.get("founded_is_fuzzy", False),
            "dissolved_year":    qdata.get("dissolved_year"),
            "location_type":     loc_type,
            "p31_qids":          p31_qids,
        })

    # Also add all unique P17 (country) QIDs not already captured via P276
    for ev in events:
        country_qid = ev.get("country_qid")
        if not country_qid or country_qid in seen_qids:
            continue
        seen_qids.add(country_qid)

        qdata = qid_data.get(country_qid)
        if not qdata or not qdata.get("label"):
            continue
        if qdata.get("lat") is None or qdata.get("lon") is None:
            continue

        location_records.append({
            "wikidata_qid":      country_qid,
            "name":              qdata["label"],
            "wikipedia_title":   qdata.get("wikipedia_title") or qdata["label"],
            "wikipedia_url":     qdata.get("wikipedia_url"),
            "slug":              qdata.get("slug"),
            "wikipedia_summary": None,
            "lat":               qdata["lat"],
            "lon":               qdata["lon"],
            "founded_year":      qdata.get("founded_year"),
            "founded_is_fuzzy":  qdata.get("founded_is_fuzzy", False),
            "dissolved_year":    qdata.get("dissolved_year"),
            "location_type":     "country",
            "p31_qids":          qdata.get("p31_qids", []),
        })

    return location_records


# ---------------------------------------------------------------------------
# Coverage report
# ---------------------------------------------------------------------------

def print_coverage(events: list[dict], loaded: int, skipped: int) -> None:
    total       = len(events)
    has_date    = sum(1 for e in events if e.get("year_start") is not None)
    has_coord   = sum(1 for e in events if e.get("lat") is not None)
    has_loc_qid = sum(1 for e in events if e.get("location_qid") is not None)
    has_loc_any = sum(1 for e in events if e.get("location_level") is not None)
    has_summary = sum(1 for e in events if e.get("wikipedia_summary"))
    has_cat     = sum(1 for e in events if e.get("categories"))
    needs_loc   = sum(1 for e in events if e.get("_needs_location"))
    needs_cat   = sum(1 for e in events if e.get("_needs_llm_category"))

    print("\n" + "=" * 60)
    print("RUN 1 COVERAGE REPORT")
    print("=" * 60)
    print(f"  Total events extracted:  {total}")
    print(f"  With date:               {has_date}/{total} ({has_date*100//total}%)")
    print(f"  With direct coords:      {has_coord}/{total} ({has_coord*100//total}%)")
    print(f"  With location QID (P276):{has_loc_qid}/{total}")
    print(f"  Any location:            {has_loc_any}/{total} ({has_loc_any*100//total}%)")
    print(f"  With Wikipedia summary:  {has_summary}/{total} ({has_summary*100//total}%)")
    print(f"  With category:           {has_cat}/{total} ({has_cat*100//total}%)")
    print()
    print(f"  Loaded to Postgres:      {loaded}")
    print(f"  Skipped (needs enrich):  {skipped}")
    print()
    print("  Downstream enrichment needed:")
    print(f"    LLM location (Bucket 3):    {needs_loc}")
    print(f"    LLM category assignment:    {needs_cat}")
    print("=" * 60)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="OurStory local pipeline (Run 1 / Run 2)")
    parser.add_argument(
        "--limit", type=int, default=500,
        help="Total events to fetch (default 500 for Run 1, use 5000 for Run 2)"
    )
    parser.add_argument(
        "--skip-load", action="store_true",
        help="Extract and print coverage but do not write to Postgres"
    )
    parser.add_argument(
        "--quality-check", action="store_true",
        help="Run LLM quality check on newly loaded records after the pipeline completes"
    )
    parser.add_argument(
        "--quality-check-limit", type=int, default=50,
        help="Number of recent records to check with the quality checker (default: 50)"
    )
    parser.add_argument(
        "--max-year", type=int, default=2015,
        help="Exclude events dated after this year (default: 2015)"
    )
    parser.add_argument(
        "--min-year", type=int, default=None,
        help="Exclude events dated before this year (default: no lower bound)"
    )
    args = parser.parse_args()

    per_category = max(1, args.limit // len(SPARQL_CATEGORIES))

    # ------------------------------------------------------------------
    # Step 1: SPARQL → QIDs
    # ------------------------------------------------------------------
    print(f"\n[Step 1] Fetching QIDs via SPARQL ({len(SPARQL_CATEGORIES)} categories × {per_category})...")
    all_qids: list[str] = []
    seen: set[str] = set()

    for label, class_qid in SPARQL_CATEGORIES:
        print(f"  Querying {label} (wd:{class_qid})... ", end="", flush=True)
        try:
            qids = fetch_sparql_qids(class_qid, per_category, max_year=args.max_year, min_year=args.min_year)
            # Deduplicate across categories
            new_qids = [q for q in qids if q not in seen]
            seen.update(new_qids)
            all_qids.extend(new_qids)
            print(f"{len(new_qids)} QIDs")
        except Exception as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
        time.sleep(1.0)  # polite delay between SPARQL queries

    print(f"  Total unique QIDs: {len(all_qids)}")

    # ------------------------------------------------------------------
    # Step 2: Wikidata API batch fetch
    # ------------------------------------------------------------------
    print(f"\n[Step 2] Batch-fetching {len(all_qids)} entities from Wikidata API...")
    entities = fetch_wikidata_entities(all_qids)
    print(f"  Got {len(entities)} entities.")

    # ------------------------------------------------------------------
    # Step 3: Extract events
    # ------------------------------------------------------------------
    print("\n[Step 3] Extracting structured fields...")
    events: list[dict] = []
    for qid in all_qids:
        entity = entities.get(qid)
        if not entity or entity.get("missing"):
            continue
        ev = extract_event(entity)
        if ev.get("title") and ev.get("wikipedia_title"):
            events.append(ev)

    print(f"  Extracted {len(events)} events with title + Wikipedia article.")

    # ------------------------------------------------------------------
    # Step 4: Collect QIDs to resolve (P276 locations + P17 countries)
    # ------------------------------------------------------------------
    loc_qids = [ev["location_qid"]  for ev in events if ev.get("location_qid")]
    cty_qids = [ev["country_qid"]   for ev in events if ev.get("country_qid")]
    all_resolve_qids = list(set(loc_qids + cty_qids))

    print(f"\n[Step 4] Resolving {len(all_resolve_qids)} location/country QIDs...")
    qid_data = resolve_qid_labels_and_coords(all_resolve_qids)
    print(f"  Resolved {len(qid_data)} QIDs.")

    # ------------------------------------------------------------------
    # Step 5: Fill location_name from resolved QIDs
    # ------------------------------------------------------------------
    resolve_location_names(events, qid_data)

    # ------------------------------------------------------------------
    # Step 6: Wikipedia summaries (parallel)
    # ------------------------------------------------------------------
    print("\n[Step 5] Fetching Wikipedia summaries...")
    fetch_summaries_parallel(events, max_workers=8)

    # ------------------------------------------------------------------
    # Step 7: Build location records from resolved P276 + P17 QIDs
    # ------------------------------------------------------------------
    city_records = build_location_records(events, qid_data)
    cities_count   = sum(1 for r in city_records if r.get("location_type") == "city")
    regions_count  = sum(1 for r in city_records if r.get("location_type") == "region")
    countries_count= sum(1 for r in city_records if r.get("location_type") == "country")
    print(f"\n[Step 6] Built {len(city_records)} location records "
          f"({cities_count} cities, {regions_count} regions, {countries_count} countries).")
    print("  Fetching Wikipedia summaries for locations...")
    fetch_summaries_parallel(city_records, max_workers=8)

    # ------------------------------------------------------------------
    # Step 8: Load to Postgres
    # ------------------------------------------------------------------
    if args.skip_load:
        print("\n[Step 7] --skip-load set: skipping Postgres load.")
        loaded, skipped_count = 0, len(events)
    else:
        run_tag = datetime.datetime.utcnow().strftime("run-%Y-%m-%d-v2")
        print(f"\n[Step 7] Loading to Postgres (pipeline_run={run_tag})...")
        summary = load_all(events, city_records, pipeline_run=run_tag)
        loaded = summary["events_loaded"]
        skipped_count = summary["events_skipped"]

    # ------------------------------------------------------------------
    # Report
    # ------------------------------------------------------------------
    print_coverage(events, loaded, skipped_count)

    if not args.skip_load and loaded > 0:
        print("\nNext step: export updated GeoJSON")
        print("  cd scripts && npm run export")
        print("  (then reload the frontend to see new events on the map)")

    # ------------------------------------------------------------------
    # Optional: LLM quality check on newly loaded records
    # ------------------------------------------------------------------
    if args.quality_check and not args.skip_load and loaded > 0:
        import subprocess
        print(f"\n[Quality Check] Running LLM quality check on {args.quality_check_limit} recent records...")
        result = subprocess.run(
            [
                sys.executable, "scripts/quality-check.py",
                "--limit", str(args.quality_check_limit),
                "--no-fail",  # Don't abort the pipeline; just report
            ],
            capture_output=False,
        )
        if result.returncode != 0:
            print("\nQuality check found high-confidence issues. Review before running more batches.",
                  file=sys.stderr)


if __name__ == "__main__":
    main()
