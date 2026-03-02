#!/usr/bin/env python3
"""
validate-sample.py

Fetches 10 diverse Wikidata event entities via the Wikidata API,
runs the pipeline extraction logic on them, and prints a field-coverage
validation report. Outputs results to scripts/sample-events.json.

No GCP or dump required — uses the live Wikidata API.
Run: python3 scripts/validate-sample.py
"""

import json
import re
import sys
import time
import requests

# ---------------------------------------------------------------------------
# Target events: chosen for diversity
#   - BCE dates, CE dates
#   - direct coords (P625), location QID (P276), no location
#   - fuzzy dates, multi-year spans
#   - multiple event types
# ---------------------------------------------------------------------------

SAMPLE_QIDS = [
    "Q131969",   # Battle of Thermopylae         (480 BCE, P585 + P625 coords,    battle)
    "Q83224",    # Battle of Hastings             (1066,    P585 + P625 coords,    battle)
    "Q42005",    # Black Death                    (1346-53, P580 + P276 location,  pandemic/disaster)
    "Q160077",   # Fall of Constantinople         (1453,    P580 + P625 + P276,    battle)
    "Q6534",     # French Revolution              (1789-99, P585 + P580 + P276,    politics)
    "Q164679",   # Great Fire of London           (1666,    P580 + P625 + P276,    disaster)
    "Q1025466",  # Assassination of Julius Caesar (44 BCE,  P585 + P625 + P276,    politics)
    "Q31900",    # Battle of Marathon             (490 BCE, P585 + P625 + P276,    battle)
    "Q16470",    # Normandy landings (D-Day)      (1944,    P580 + P625 + P276,    battle)
    "Q703203",   # Atomic bombing of Hiroshima    (1945,    P585 + P625 + P276,    disaster)
]

# ---------------------------------------------------------------------------
# Category mapping (Tier 2 static table — subset for validation)
# ---------------------------------------------------------------------------

WIKIDATA_TO_CATEGORY = {
    "Q178561":  "battle",        # battle
    "Q198":     "war",           # war
    "Q188055":  "battle",        # skirmish
    "Q831663":  "battle",        # naval battle
    "Q40231":   "politics",      # election
    "Q49773":   "politics",      # summit meeting
    "Q1781513": "politics",      # coup d'état
    "Q167466":  "politics",      # assassination
    "Q3882219": "politics",      # assassination (alt)
    "Q124490":  "disaster",      # natural disaster
    "Q7944":    "disaster",      # earthquake
    "Q8092":    "disaster",      # flood
    "Q8928":    "disaster",      # volcanic eruption
    "Q3839081": "disaster",      # wildfire
    "Q43229":   "discovery",     # discovery
    "Q2678658": "discovery",     # scientific discovery
    "Q2685356": "exploration",   # exploration
    "Q2085381": "religion",      # religious event
    "Q959583":  "culture",       # cultural event
    "Q11862829":"science",       # scientific experiment
    "Q752783":  "science",       # human spaceflight
    "Q2635894": "disaster",      # epidemic
    "Q3241045": "disaster",      # pandemic / disease outbreak
    "Q12184":   "disaster",      # pandemic
    "Q838718":  "disaster",      # city fire
    "Q2656967": "disaster",      # nuclear explosion
    "Q4688003": "war",           # aerial bombing of a city
    "Q135010":  "war",           # war crime
    # Military (additional)
    "Q348120":  "battle",        # amphibious warfare
    "Q3817498": "battle",        # last stand
    "Q1361229": "battle",        # conquest
    # Politics (additional)
    "Q10931":   "politics",      # revolution
    "Q1139665": "politics",      # political murder
    "Q930164":  "politics",      # conspiracy
    "Q6813020": "politics",      # stabbing attack
    # Generic fallback
    "Q13418847": None,           # historical event (generic) → needs LLM
    "Q1190554":  None,           # occurrence (generic) → needs LLM
}


# ---------------------------------------------------------------------------
# Extraction helpers
# ---------------------------------------------------------------------------

def get_claim_value(claims, prop):
    """Returns the first 'value' snak for a property, or None."""
    for stmt in claims.get(prop, []):
        snak = stmt.get("mainsnak", {})
        if snak.get("snaktype") == "value":
            return snak["datavalue"]["value"]
    return None


def get_all_claim_values(claims, prop):
    """Returns all 'value' snaks for a property."""
    result = []
    for stmt in claims.get(prop, []):
        snak = stmt.get("mainsnak", {})
        if snak.get("snaktype") == "value":
            result.append(snak["datavalue"]["value"])
    return result


def get_item_id(claims, prop):
    """Returns the QID string for an item-valued property."""
    val = get_claim_value(claims, prop)
    if val and isinstance(val, dict):
        return val.get("id")
    return None


def get_coord(claims):
    """Returns (lat, lon) from P625, or (None, None)."""
    val = get_claim_value(claims, "P625")
    if val and isinstance(val, dict):
        return val.get("latitude"), val.get("longitude")
    return None, None


def get_time_value(claims, prop):
    """Returns (time_str, precision) from a time-valued property."""
    val = get_claim_value(claims, prop)
    if val and isinstance(val, dict) and "time" in val:
        return val["time"], val.get("precision", 9)
    return None, None


def parse_wikidata_time(time_str, precision):
    """
    Parses a Wikidata time string into (year, is_fuzzy).

    Wikidata format: +1066-10-14T00:00:00Z or -0480-00-00T00:00:00Z
    Precision: 9=year, 10=month, 11=day, 8=decade, 7=century, 6=millennium

    Returns:
        year (int, negative = BCE, using astronomical year numbering)
        is_fuzzy (bool) — True if precision < 9 (decade/century/millennium)
    """
    if not time_str:
        return None, True

    is_negative = time_str.startswith("-")
    # Strip sign, then split on 'T' to get date part
    date_part = time_str.lstrip("+-").split("T")[0]
    # date_part is like "0480-00-00" or "1066-10-14"
    year_str = date_part.split("-")[0]

    try:
        year = int(year_str)
    except ValueError:
        return None, True

    if is_negative:
        year = -year

    # Precision < 9 means decade, century, millennium — treat as fuzzy
    is_fuzzy = precision < 9

    return year, is_fuzzy


def map_categories(p31_qids):
    """Maps a list of P31 QIDs to OurStory category strings."""
    categories = set()
    needs_llm = False
    for qid in p31_qids:
        cat = WIKIDATA_TO_CATEGORY.get(qid)
        if cat:
            categories.add(cat)
        elif qid in WIKIDATA_TO_CATEGORY:
            needs_llm = True  # mapped to None — generic type, needs LLM
    return sorted(categories), needs_llm


# ---------------------------------------------------------------------------
# Main extraction function
# (mirrors what the Dataproc pipeline will do on each entity)
# ---------------------------------------------------------------------------

def extract_event(entity):
    """
    Extracts structured fields from a raw Wikidata entity dict.
    Returns a dict matching the DB events table schema.
    """
    qid = entity.get("id")
    labels = entity.get("labels", {})
    sitelinks = entity.get("sitelinks", {})
    claims = entity.get("claims", {})

    label_en = labels.get("en", {}).get("value")
    enwiki = sitelinks.get("enwiki", {})
    wikipedia_title = enwiki.get("title")
    wikipedia_url = (
        f"https://en.wikipedia.org/wiki/{wikipedia_title.replace(' ', '_')}"
        if wikipedia_title else None
    )

    # Dates — prefer P585 (point in time) then P580/P582 (start/end)
    point_time, point_prec = get_time_value(claims, "P585")
    start_time, start_prec = get_time_value(claims, "P580")
    end_time, end_prec     = get_time_value(claims, "P582")

    # Resolve year_start: prefer point_in_time, fall back to start_time
    if point_time:
        year_start, date_is_fuzzy = parse_wikidata_time(point_time, point_prec)
        year_end = None
    elif start_time:
        year_start, date_is_fuzzy = parse_wikidata_time(start_time, start_prec)
        year_end_val, _ = parse_wikidata_time(end_time, end_prec) if end_time else (None, False)
        year_end = year_end_val
    else:
        year_start, date_is_fuzzy, year_end = None, True, None

    # Spatial
    lat, lon = get_coord(claims)
    location_qid = get_item_id(claims, "P276")
    country_qid  = get_item_id(claims, "P17")

    # Determine location_level for DB schema
    if lat is not None and lon is not None:
        location_level = "point"
    elif location_qid:
        location_level = "city"   # placeholder — may be region/country after QID resolution
    else:
        location_level = None     # unknown — needs LLM assignment

    # Categories
    p31_qids = [v["id"] for v in get_all_claim_values(claims, "P31") if isinstance(v, dict)]
    categories, needs_llm_category = map_categories(p31_qids)

    return {
        # Identity
        "wikidata_qid":      qid,
        "title":             label_en,
        "wikipedia_title":   wikipedia_title,
        "wikipedia_url":     wikipedia_url,
        "wikipedia_summary": None,          # filled by DBpedia join step

        # Temporal
        "year_start":       year_start,
        "year_end":         year_end,
        "date_is_fuzzy":    date_is_fuzzy,
        "date_range_min":   None,           # set when date_is_fuzzy = True by LLM or known range
        "date_range_max":   None,

        # Spatial (raw from Wikidata)
        "location_level":        location_level,
        "lat":                   lat,
        "lon":                   lon,
        "location_qid":          location_qid,   # Wikidata QID → resolved to city UUID in load step
        "country_qid":           country_qid,
        "location_name":         None,           # resolved from location_qid label in load step

        # Classification
        "p31_qids":              p31_qids,
        "categories":            categories,

        # Flags for downstream enrichment steps
        "_needs_llm_category":   needs_llm_category and not categories,
        "_needs_location":       location_level is None,
        "_needs_location_qid_resolution": location_level == "city",
    }


# ---------------------------------------------------------------------------
# Wikidata API fetch
# ---------------------------------------------------------------------------

def fetch_entities(qids, lang="en"):
    """Fetches entity JSON from the Wikidata API for a list of QIDs."""
    url = "https://www.wikidata.org/w/api.php"
    params = {
        "action":   "wbgetentities",
        "ids":      "|".join(qids),
        "props":    "labels|claims|sitelinks",
        "languages": lang,
        "sitefilter": "enwiki",
        "format":   "json",
    }
    headers = {"User-Agent": "OurStory-pipeline-validation/0.1 (https://github.com/ourstory)"}
    resp = requests.get(url, params=params, headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.json().get("entities", {})


# ---------------------------------------------------------------------------
# Validation report
# ---------------------------------------------------------------------------

def print_report(events):
    col_w = 34
    print("\n" + "=" * 100)
    print("OURSTORY PIPELINE VALIDATION — 10 SAMPLE EVENTS")
    print("=" * 100)

    headers = ["Title", "QID", "year_start", "year_end", "fuzzy", "lat/lon", "loc_qid", "categories", "issues"]
    print(f"{'Title':<{col_w}} {'QID':<12} {'year_start':>10} {'year_end':>8} {'fuzzy':>5} {'coords':>8} {'loc_qid':>10} {'categories':<20} issues")
    print("-" * 100)

    for e in events:
        title    = (e["title"] or "")[:col_w - 1]
        qid      = e["wikidata_qid"]
        yr_start = str(e["year_start"]) if e["year_start"] is not None else "MISSING"
        yr_end   = str(e["year_end"])   if e["year_end"]   is not None else ""
        fuzzy    = "Y" if e["date_is_fuzzy"] else "N"
        coords   = "Y" if e["lat"] is not None else "N"
        loc_qid  = (e["location_qid"] or "")[:10]
        cats     = ",".join(e["categories"])[:20] if e["categories"] else "NONE"

        issues = []
        if e["year_start"] is None:
            issues.append("NO_DATE")
        if e["location_level"] is None:
            issues.append("NO_LOC")
        if not e["categories"]:
            issues.append("NO_CAT")
        issue_str = " ".join(issues) if issues else "ok"

        print(f"{title:<{col_w}} {qid:<12} {yr_start:>10} {yr_end:>8} {fuzzy:>5} {coords:>8} {loc_qid:>10} {cats:<20} {issue_str}")

    print("-" * 100)
    total   = len(events)
    has_date  = sum(1 for e in events if e["year_start"] is not None)
    has_coord = sum(1 for e in events if e["lat"] is not None)
    has_loc   = sum(1 for e in events if e["location_qid"] is not None)
    has_cat   = sum(1 for e in events if e["categories"])
    has_loc_any = sum(1 for e in events if e["location_level"] is not None)

    print(f"\nCoverage ({total} events):")
    print(f"  dates:       {has_date}/{total}")
    print(f"  coords:      {has_coord}/{total}  (direct P625)")
    print(f"  location QID:{has_loc}/{total}   (P276 → resolve to coords in Step 7a)")
    print(f"  any location:{has_loc_any}/{total}  (total with coords OR location QID)")
    print(f"  categories:  {has_cat}/{total}")
    print()

    needs_loc  = sum(1 for e in events if e["_needs_location"])
    needs_cat  = sum(1 for e in events if e["_needs_llm_category"])
    needs_res  = sum(1 for e in events if e["_needs_location_qid_resolution"])
    print("Downstream enrichment needed:")
    print(f"  LLM location assignment (Bucket 3): {needs_loc}/{total}")
    print(f"  location QID→coords resolution:     {needs_res}/{total}")
    print(f"  LLM category assignment:            {needs_cat}/{total}")
    print()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    print(f"Fetching {len(SAMPLE_QIDS)} Wikidata entities...")
    entities = fetch_entities(SAMPLE_QIDS)
    print(f"  Got {len(entities)} entities back.\n")

    events = []
    for qid in SAMPLE_QIDS:
        entity = entities.get(qid)
        if not entity or entity.get("missing"):
            print(f"  WARNING: {qid} not found", file=sys.stderr)
            continue
        extracted = extract_event(entity)
        events.append(extracted)

    # Write raw output
    output_path = "scripts/sample-events.json"
    with open(output_path, "w") as f:
        json.dump(events, f, indent=2, default=str)
    print(f"Raw output written to {output_path}\n")

    # Print validation report
    print_report(events)

    # Print full JSON for the first event so we can eyeball the structure
    print("\n--- First event (full JSON) ---")
    print(json.dumps(events[0], indent=2, default=str))


if __name__ == "__main__":
    main()
