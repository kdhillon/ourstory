#!/usr/bin/env python3
"""
pipeline/run_polities.py — Polity data pipeline

Fetches sovereign political entities (kingdoms, empires, republics, etc.)
from Wikidata SPARQL, batch-fetches entity details, resolves capital
coordinates, classifies polity types, and upserts into the polities table.

Works exactly like run_local.py but targets the polities table.
Parameterized by date range: fetch polities active during [min_year, max_year].

Usage:
    python3 -m pipeline.run_polities [--min-year Y] [--max-year Y] [--dry-run]

    Default range: all time (no lower bound, max_year=2015)

Dependencies:
    pip install requests psycopg2-binary
"""

import argparse
import datetime
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional
from urllib.parse import quote

import requests

from pipeline.extract import (
    classify_polity_type,
    is_known_polity_p31,
    is_known_polity_p31_any,
    should_exclude_polity,
    make_slug,
    parse_wikidata_time,
    get_claim_value,
    get_all_claim_values,
    get_item_id,
    get_coord,
    get_time_value,
)
from pipeline.load_postgres import connect, upsert_polities

WDQS_ENDPOINT = "https://query.wikidata.org/sparql"
WIKIDATA_API  = "https://www.wikidata.org/w/api.php"
WIKIPEDIA_API = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"

USER_AGENT = "OurStory-pipeline/0.2 (https://github.com/ourstory; data@ourstory.app)"

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT})

# ---------------------------------------------------------------------------
# SPARQL categories — separate query per superclass to avoid timeouts
# ---------------------------------------------------------------------------

# (label, class_qid) — one SPARQL query per entry
POLITY_SPARQL_CATEGORIES: list[tuple[str, str]] = [
    ("historical country",  "Q3024240"),   # historical country
    ("historical kingdom",  "Q417175"),    # kingdom
    ("empire",              "Q48349"),     # empire
    ("republic",            "Q7270"),      # republic
    ("confederation",       "Q170156"),    # confederation
    ("sultanate",           "Q12759805"),  # sultanate
    ("emirate",             "Q189898"),    # emirate
    ("caliphate",           "Q131401"),    # caliphate
    ("pontificate",         "Q12799209"),  # pontificate / papacy
    ("country",             "Q6256"),      # country (catches remaining sovereign states)
    # Colonial / dependent territories
    ("colony",              "Q133156"),    # colony (Dutch Ceylon, British India, etc.)
    ("protectorate",        "Q164142"),    # protectorate (Tunisia, Morocco, etc.)
    ("captaincy general",   "Q5036886"),   # captaincy general (Guatemala, Cuba, etc.)
    ("viceroyalty",         "Q12356456"),  # viceroyalty (New Granada, New Spain, Peru, etc.)
    # Other European political forms common in 1600–1900
    ("duchy",               "Q159627"),    # duchy (German states, Italian states)
    ("grand duchy",         "Q47848"),     # grand duchy (Tuscany, Lithuania, etc.)
    ("margraviate",         "Q165994"),    # margraviate (Brandenburg, etc.)
    ("county palatine",     "Q166346"),    # county palatine
    # Sub-state entities treated as principalities
    ("vilayet",             "Q1462047"),   # Ottoman vilayet
    ("eyalet",              "Q44565"),     # Ottoman eyalet (earlier provincial type)
    ("khanate",             "Q200976"),    # khanate (Crimea, Central Asia, etc.)
    ("regency",             "Q2560551"),   # regency (Algiers, Tunis, Tripoli)
    # Peoples, tribes, and indigenous groups
    ("ethnic group",        "Q41710"),     # ethnic group (broad — catches most indigenous peoples)
    ("indigenous people",   "Q131596"),    # indigenous people (distinct class from ethnic group)
    ("horde",               "Q1345055"),   # horde (Mongol, Nogai, etc.)
    ("tribe",               "Q133311"),    # tribe (human social group)
    ("chiefdom",            "Q1642488"),   # chiefdom
    ("band society",        "Q271445"),    # band society (small hunter-gatherer groups)
    ("indigenous nation",   "Q4358176"),   # indigenous nation (North America, Australia, etc.)
    ("first nation",        "Q484736"),    # First Nations (Canada)
    ("native american tribe","Q1137806"),  # Native American tribe (US-specific class)
]

# Reasonable limit per category — polities are far fewer than events
DEFAULT_LIMIT = 5000


# ---------------------------------------------------------------------------
# SPARQL: fetch polity QIDs active in a time window
# ---------------------------------------------------------------------------

def fetch_polity_sparql_qids(
    class_qid: str,
    limit: int,
    min_year: Optional[int] = None,
    max_year: Optional[int] = 2015,
) -> list[str]:
    """
    Fetches Wikidata QIDs for polities (instances/subclasses of class_qid)
    that were active during [min_year, max_year] — i.e.:
      - inception (P571) <= max_year  OR  no inception date
      - dissolution (P576) >= min_year  OR  no dissolution date

    Requires an English Wikipedia article.
    Returns a list of Q-ID strings.
    """
    inception_filter = f"(!BOUND(?inception) || YEAR(?inception) <= {max_year})" if max_year else "TRUE"
    dissolved_filter = f"(!BOUND(?dissolved) || YEAR(?dissolved) >= {min_year})" if min_year else "TRUE"

    query = f"""
    SELECT DISTINCT ?item WHERE {{
      ?item wdt:P31/wdt:P279* wd:{class_qid} .
      OPTIONAL {{ ?item wdt:P571 ?inception . }}
      OPTIONAL {{ ?item wdt:P576 ?dissolved . }}
      FILTER({inception_filter} && {dissolved_filter})
      ?article schema:about ?item ;
               schema:isPartOf <https://en.wikipedia.org/> .
    }}
    LIMIT {limit}
    """

    resp = SESSION.get(
        WDQS_ENDPOINT,
        params={"query": query, "format": "json"},
        headers={"Accept": "application/sparql-results+json"},
        timeout=55,
    )
    resp.raise_for_status()
    data = resp.json()
    return [
        binding["item"]["value"].split("/")[-1]
        for binding in data["results"]["bindings"]
    ]


# ---------------------------------------------------------------------------
# Wikidata API: batch-fetch polity entities
# ---------------------------------------------------------------------------

def fetch_wikidata_entities(qids: list[str]) -> dict:
    """
    Fetches entity JSON from the Wikidata API for a list of QIDs.
    Splits into batches of 50 and merges results.
    Returns {qid: entity_dict}.
    """
    all_entities: dict = {}
    for i in range(0, len(qids), 50):
        batch = qids[i : i + 50]
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
        all_entities.update(resp.json().get("entities", {}))
        if i + 50 < len(qids):
            time.sleep(1.0)
    return all_entities


# ---------------------------------------------------------------------------
# Wikidata API: resolve capital coordinates (P36 → P625)
# ---------------------------------------------------------------------------

def resolve_capital_coords(capital_qids: list[str]) -> dict[str, dict]:
    """
    Batch-resolves capital QIDs (P36) to their label and P625 coordinates.

    Returns {qid: {label, lat, lon}}.
    """
    if not capital_qids:
        return {}

    result: dict[str, dict] = {}
    unique = list(set(capital_qids))

    for i in range(0, len(unique), 50):
        batch = unique[i : i + 50]
        params = {
            "action":    "wbgetentities",
            "ids":       "|".join(batch),
            "props":     "labels|claims",
            "languages": "en",
            "format":    "json",
        }
        resp = SESSION.get(WIKIDATA_API, params=params, timeout=30)
        resp.raise_for_status()
        entities = resp.json().get("entities", {})

        for qid, entity in entities.items():
            if entity.get("missing"):
                continue
            label = entity.get("labels", {}).get("en", {}).get("value")
            lat, lon = get_coord(entity.get("claims", {}))
            result[qid] = {"label": label, "lat": lat, "lon": lon}

        if i + 50 < len(unique):
            time.sleep(1.0)

    return result


# ---------------------------------------------------------------------------
# Extract polity record from Wikidata entity
# ---------------------------------------------------------------------------

def extract_polity(entity: dict) -> Optional[dict]:
    """
    Extracts structured fields from a Wikidata entity for the polities table.

    Returns a dict or None if the entity has no usable title/slug.
    """
    qid = entity.get("id")
    if not qid or entity.get("missing"):
        return None

    labels    = entity.get("labels", {})
    sitelinks = entity.get("sitelinks", {})
    claims    = entity.get("claims", {})

    label_en = labels.get("en", {}).get("value")
    if label_en:
        label_en = label_en[0].upper() + label_en[1:]

    enwiki         = sitelinks.get("enwiki", {})
    wikipedia_title = enwiki.get("title")
    if not label_en and not wikipedia_title:
        return None

    wikipedia_url = (
        f"https://en.wikipedia.org/wiki/{wikipedia_title.replace(' ', '_')}"
        if wikipedia_title else None
    )
    slug = make_slug(wikipedia_title) if wikipedia_title else (
        label_en.replace(" ", "_") if label_en else None
    )
    if not slug:
        return None

    # Temporal: P571 inception, P576 dissolved
    inception_time, inception_prec = get_time_value(claims, "P571")
    dissolved_time, dissolved_prec = get_time_value(claims, "P576")

    year_start, _, _, date_is_fuzzy = (
        parse_wikidata_time(inception_time, inception_prec)
        if inception_time else (None, None, None, False)
    )
    year_end = None
    if dissolved_time:
        year_end, _, _, _ = parse_wikidata_time(dissolved_time, dissolved_prec)

    # Direct coordinates (fallback when no capital)
    lat, lon = get_coord(claims)

    # Capital QID (P36) — resolved separately for coordinates
    capital_qid = get_item_id(claims, "P36")

    # Succession
    preceded_by = get_item_id(claims, "P1365")
    succeeded_by = get_item_id(claims, "P1366")

    # Country link (P17) for location_wikidata_qid — soft ref to locations table
    country_qid = get_item_id(claims, "P17")

    # Sovereign / suzerain QIDs (all P17 values) — used to display "Part of: X"
    # e.g. Electorate of Saxony → [Q12548 (Holy Roman Empire)]
    #      Hyderabad State      → [Q129286 (British Raj), Q668 (India)]
    sovereign_qids = [
        v["id"] for v in get_all_claim_values(claims, "P17")
        if isinstance(v, dict) and v.get("id")
    ]
    # Also check P361 (part of) for polities that use it instead of P17
    part_of_sovereign = [
        v["id"] for v in get_all_claim_values(claims, "P361")
        if isinstance(v, dict) and v.get("id")
    ]
    # Merge: P361 first (more specific), then P17; deduplicate
    seen: set[str] = set()
    merged_sovereign: list[str] = []
    for q in part_of_sovereign + sovereign_qids:
        if q not in seen:
            seen.add(q)
            merged_sovereign.append(q)
    sovereign_qids = merged_sovereign

    # P31 (instance-of)
    p31_qids = [
        v["id"] for v in get_all_claim_values(claims, "P31")
        if isinstance(v, dict) and v.get("id")
    ]

    # Strong sovereign evidence: has dates AND (capital OR succession link).
    # If both are present, trust the data over any P31-based exclusion — some real
    # polities (e.g. Humska zemlja) carry both a "historical region" P31 and genuine
    # state properties. Only apply the P31 exclude list when evidence is weak.
    has_strong_sovereign = (
        (year_start is not None or year_end is not None)
        and (capital_qid is not None or preceded_by is not None or succeeded_by is not None)
    )
    if not has_strong_sovereign and should_exclude_polity(p31_qids):
        return None

    # Reject Wikipedia list articles (e.g. "List of possessions of Norway")
    name_check = (label_en or wikipedia_title or "").lower()
    if name_check.startswith("list of ") or name_check.startswith("lists of "):
        return None

    # Sovereign-state gate: reject entities with no evidence of being a state.
    # An entity passes if it has ANY of:
    #   - a start or end date (temporal existence as a state)
    #   - a capital city
    #   - a predecessor or successor (succession chain)
    #   - a P31 that directly matches a known polity type (e.g. P31=sultanate)
    #     → trust Wikidata's explicit classification even when dates are missing,
    #       since geographic noise is already blocked by should_exclude_polity() above.
    has_direct_polity_p31 = is_known_polity_p31_any(p31_qids)
    has_sovereign_markers = (
        year_start is not None
        or year_end is not None
        or capital_qid is not None
        or preceded_by is not None
        or succeeded_by is not None
        or has_direct_polity_p31
    )
    if not has_sovereign_markers:
        return None

    return {
        "wikidata_qid":         qid,
        "name":                 label_en or wikipedia_title,
        "wikipedia_title":      wikipedia_title,
        "wikipedia_url":        wikipedia_url,
        "slug":                 slug,
        "wikipedia_summary":    None,   # filled by Wikipedia REST API
        "year_start":           year_start,
        "year_end":             year_end,
        "date_is_fuzzy":        date_is_fuzzy,
        "lat":                  lat,
        "lng":                  lon,
        "_capital_qid":         capital_qid,    # resolved in a later step
        "capital_name":         None,            # filled after capital resolution
        "capital_wikidata_qid": capital_qid,
        "preceded_by_qid":      preceded_by,
        "succeeded_by_qid":     succeeded_by,
        "location_wikidata_qid": country_qid,
        "sovereign_qids":       sovereign_qids,
        "p31_qids":             p31_qids,
        "polity_type":          "other",         # classified in a later step
    }


# ---------------------------------------------------------------------------
# Transitive BFS for novel polity P31 types (mirrors run_local.py Step 4b)
# ---------------------------------------------------------------------------

def build_polity_p31_dynamic_map(
    polity_records: list[dict],
) -> dict[str, Optional[str]]:
    """
    Collects all unique P31 QIDs from polity records, finds those NOT in
    the hardcoded polity classifier sets, and resolves them via transitive
    P279* BFS (up to 4 levels).

    Returns {p31_qid: polity_type_string | None} for unknown types.
    """
    all_p31: set[str] = set()
    for rec in polity_records:
        all_p31.update(rec.get("p31_qids") or [])

    unknown = [q for q in all_p31 if not is_known_polity_p31(q)]
    if not unknown:
        return {}

    print(f"  Resolving {len(unknown)} novel polity P31 type(s) via transitive BFS...")

    # Polity type root QIDs for BFS classification — must mirror extract.py _POLITY_* sets
    POLITY_TYPE_ROOTS: dict[str, str] = {
        # Empire
        "Q48349":     "empire",
        "Q1790360":   "empire",        # colonial empire
        # Kingdom
        "Q417175":    "kingdom",       # historical kingdom
        "Q1250464":   "kingdom",       # realm
        "Q128193315": "kingdom",       # atabegate
        # Principality / sub-state
        "Q208500":    "principality",  # principality
        "Q154547":    "principality",  # duchy
        "Q1336152":   "principality",  # princely state
        "Q26830017":  "principality",  # state in the Holy Roman Empire
        "Q26879769":  "principality",  # state in Confederation of the Rhine
        "Q57318":     "principality",  # free imperial city
        "Q353344":    "principality",  # countship
        "Q196068":    "principality",  # lordship
        "Q1371288":   "principality",  # vassal state
        "Q463742":    "principality",  # Hochstift
        "Q1462047":   "principality",  # vilayet
        "Q44565":     "principality",  # eyalet
        "Q330425":    "principality",  # sanjak
        "Q1993723":   "principality",  # administrative territorial entity of Ottoman Empire
        "Q113388921": "principality",  # privileged Ottoman province
        # Republic
        "Q7270":      "republic",
        "Q472538":    "republic",      # sister republic
        # Confederation
        "Q170156":    "confederation",
        # Sultanate / Emirate / Khanate / Caliphate
        "Q12759805":  "sultanate",
        "Q331644":    "sultanate",     # khanate
        "Q189898":    "sultanate",     # emirate
        "Q131401":    "sultanate",     # caliphate
        # Papacy
        "Q12799209":  "papacy",
        # Peoples / indigenous groups
        "Q41710":     "people",    # ethnic group
        "Q131596":    "people",    # indigenous people
        "Q1345055":   "people",    # horde
        "Q133311":    "people",    # tribe
        "Q1642488":   "people",    # chiefdom
        "Q179062":    "people",    # chiefdom (alt)
        "Q215628":    "people",    # people (ethnic)
        "Q271445":    "people",    # band society
        "Q4358176":   "people",    # indigenous nation
        "Q484736":    "people",    # First Nation
        "Q1137806":   "people",    # Native American tribe
        # Colony / dependency
        "Q133156":    "colony",
        "Q164142":    "colony",    # protectorate
        "Q12356456":  "colony",    # viceroyalty
        "Q5036886":   "colony",    # captaincy general
        "Q1351282":   "colony",    # crown colony
        "Q185441":    "colony",    # dependency
    }
    PRIORITY = {"papacy": 7, "sultanate": 6, "confederation": 5, "republic": 4, "empire": 3, "kingdom": 2, "principality": 1, "colony": 1, "people": 1}

    def _classify_direct(qid: str) -> Optional[str]:
        return POLITY_TYPE_ROOTS.get(qid, "UNKNOWN")

    def _fetch_p279_batch(qids: list[str]) -> dict[str, list[str]]:
        params = {"action": "wbgetentities", "ids": "|".join(qids), "props": "claims", "format": "json"}
        try:
            resp = SESSION.get(WIKIDATA_API, params=params, timeout=20)
            resp.raise_for_status()
            entities = resp.json().get("entities", {})
            result: dict[str, list[str]] = {}
            for qid, entity in entities.items():
                if entity.get("missing"):
                    result[qid] = []
                    continue
                parents = [
                    stmt["mainsnak"]["datavalue"]["value"]["id"]
                    for stmt in entity.get("claims", {}).get("P279", [])
                    if stmt.get("mainsnak", {}).get("snaktype") == "value"
                    and isinstance(stmt["mainsnak"]["datavalue"]["value"], dict)
                ]
                result[qid] = parents
            return result
        except Exception:
            return {q: [] for q in qids}

    results: dict[str, Optional[str]] = {}
    p279_cache: dict[str, list[str]] = {}
    still_unknown = []

    for q in unknown:
        t = _classify_direct(q)
        if t == "UNKNOWN":
            still_unknown.append(q)
        else:
            results[q] = t  # direct hit

    for _depth in range(4):
        if not still_unknown:
            break
        need_fetch = [q for q in still_unknown if q not in p279_cache]
        if need_fetch:
            for i in range(0, len(need_fetch), 50):
                p279_cache.update(_fetch_p279_batch(need_fetch[i : i + 50]))
                if i + 50 < len(need_fetch):
                    time.sleep(0.5)

        next_unknown = []
        for q in still_unknown:
            parents = p279_cache.get(q, [])
            best: Optional[str] = None
            for p in parents:
                t = _classify_direct(p)
                if t != "UNKNOWN":
                    if best is None or PRIORITY.get(t, 0) > PRIORITY.get(best, 0):
                        best = t
            if best is not None:
                results[q] = best
            else:
                for p in parents:
                    if p not in p279_cache and p not in results:
                        next_unknown.append(p)
                        p279_cache.setdefault(p, [])
                next_unknown.append(q)

        still_unknown = list(dict.fromkeys(next_unknown))

    classified = sum(1 for v in results.values() if v is not None)
    print(f"  BFS result: {classified}/{len(unknown)} unknown P31s resolved to polity types.")
    return results


# ---------------------------------------------------------------------------
# Wikipedia summaries (parallelized — reused from run_local pattern)
# ---------------------------------------------------------------------------

def fetch_wikipedia_summary(wikipedia_title: str) -> Optional[str]:
    url = WIKIPEDIA_API.format(title=quote(wikipedia_title, safe=""))
    try:
        resp = SESSION.get(url, timeout=15)
        if resp.status_code == 200:
            return resp.json().get("extract", "")
        return None
    except Exception:
        return None


def fetch_summaries_parallel(records: list[dict], max_workers: int = 8) -> None:
    """Fetches Wikipedia summaries in parallel (in-place update)."""
    to_fetch = [
        (i, rec["wikipedia_title"])
        for i, rec in enumerate(records)
        if rec.get("wikipedia_title") and not rec.get("wikipedia_summary")
    ]
    if not to_fetch:
        return

    print(f"  Fetching {len(to_fetch)} Wikipedia summaries ({max_workers} threads)...")
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        future_to_idx = {
            executor.submit(fetch_wikipedia_summary, title): idx
            for idx, title in to_fetch
        }
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                records[idx]["wikipedia_summary"] = future.result()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="OurStory polity pipeline")
    parser.add_argument("--min-year", type=int, default=None,
                        help="Only include polities active after this year (default: no lower bound)")
    parser.add_argument("--max-year", type=int, default=2015,
                        help="Only include polities active before this year (default: 2015)")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                        help=f"Max QIDs per SPARQL category (default: {DEFAULT_LIMIT})")
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch and classify but do not write to Postgres")
    parser.add_argument("--categories", type=str, default=None,
                        help="Comma-separated category labels to run, e.g. "
                             "'ethnic group,tribe,indigenous people'. Defaults to all.")
    args = parser.parse_args()

    # Filter categories if requested
    categories = POLITY_SPARQL_CATEGORIES
    if args.categories:
        wanted = {c.strip().lower() for c in args.categories.split(",")}
        categories = [(label, qid) for label, qid in POLITY_SPARQL_CATEGORIES
                      if label.lower() in wanted]
        if not categories:
            print(f"No categories matched. Available: {[l for l,_ in POLITY_SPARQL_CATEGORIES]}")
            return
        print(f"Running {len(categories)} selected categories: {[l for l,_ in categories]}")

    # ------------------------------------------------------------------
    # Step 1: SPARQL → QIDs per polity superclass
    # ------------------------------------------------------------------
    print(f"\n[Step 1] Fetching polity QIDs via SPARQL "
          f"({len(categories)} categories, "
          f"window: {args.min_year or 'any'}–{args.max_year})...")

    all_qids: list[str] = []
    seen: set[str] = set()

    for label, class_qid in categories:
        print(f"  Querying {label} (wd:{class_qid})... ", end="", flush=True)
        try:
            qids = fetch_polity_sparql_qids(
                class_qid, args.limit,
                min_year=args.min_year, max_year=args.max_year,
            )
            new_qids = [q for q in qids if q not in seen]
            seen.update(new_qids)
            all_qids.extend(new_qids)
            print(f"{len(new_qids)} QIDs")
        except Exception as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
        time.sleep(1.0)

    print(f"  Total unique polity QIDs: {len(all_qids)}")
    if not all_qids:
        print("No QIDs fetched. Exiting.")
        return

    # ------------------------------------------------------------------
    # Step 2: Wikidata API batch fetch
    # ------------------------------------------------------------------
    print(f"\n[Step 2] Batch-fetching {len(all_qids)} entities from Wikidata API...")
    entities = fetch_wikidata_entities(all_qids)
    print(f"  Got {len(entities)} entities.")

    # ------------------------------------------------------------------
    # Step 3: Extract polity records
    # ------------------------------------------------------------------
    print("\n[Step 3] Extracting polity fields...")
    polity_records: list[dict] = []
    for qid in all_qids:
        entity = entities.get(qid)
        if not entity or entity.get("missing"):
            continue
        rec = extract_polity(entity)
        if rec:
            polity_records.append(rec)

    print(f"  Extracted {len(polity_records)} polity records.")

    # ------------------------------------------------------------------
    # Step 4: Build dynamic P31 map for unknown polity types
    # ------------------------------------------------------------------
    print("\n[Step 4] Building transitive P31 classification map...")
    dynamic_map = build_polity_p31_dynamic_map(polity_records)

    # ------------------------------------------------------------------
    # Step 5: Classify polity types
    # ------------------------------------------------------------------
    print("\n[Step 5] Classifying polity types...")
    type_counts: dict[str, int] = {}
    for rec in polity_records:
        ptype = classify_polity_type(rec["p31_qids"], extra_map=dynamic_map, name=rec.get("name"))
        rec["polity_type"] = ptype
        type_counts[ptype] = type_counts.get(ptype, 0) + 1

    for ptype, count in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f"    {ptype:15s}: {count}")

    # ------------------------------------------------------------------
    # Step 6: Resolve capital coordinates
    # ------------------------------------------------------------------
    capital_qids = [rec["_capital_qid"] for rec in polity_records if rec.get("_capital_qid")]
    if capital_qids:
        print(f"\n[Step 6] Resolving {len(set(capital_qids))} capital QIDs...")
        capital_data = resolve_capital_coords(capital_qids)
        print(f"  Resolved {len(capital_data)} capitals.")

        for rec in polity_records:
            cap_qid = rec.get("_capital_qid")
            if cap_qid and cap_qid in capital_data:
                cap = capital_data[cap_qid]
                rec["capital_name"] = cap.get("label")
                # Always prefer capital coordinates — the polity entity's own P625
                # often points to an arbitrary geographic centroid or historical site
                # rather than the seat of government.
                if cap.get("lat") is not None:
                    rec["lat"] = cap["lat"]
                    rec["lng"] = cap["lon"]
    else:
        print("\n[Step 6] No capitals to resolve.")

    # ------------------------------------------------------------------
    # Step 7: Wikipedia summaries
    # ------------------------------------------------------------------
    print("\n[Step 7] Fetching Wikipedia summaries...")
    fetch_summaries_parallel(polity_records, max_workers=8)

    # ------------------------------------------------------------------
    # Step 8: Load to Postgres
    # ------------------------------------------------------------------
    with_coords = sum(1 for r in polity_records if r.get("lat") is not None)
    no_coords   = len(polity_records) - with_coords
    print(f"\n  {with_coords} polities with coordinates, {no_coords} without.")

    if args.dry_run:
        print("\n[Step 8] --dry-run: skipping Postgres load.")
        print(f"  Would upsert {len(polity_records)} polities.")
        return

    run_tag = datetime.datetime.utcnow().strftime("run-%Y-%m-%d-v2")
    print(f"\n[Step 8] Loading to Postgres (pipeline_run={run_tag})...")
    conn = connect()
    try:
        loaded, skipped = upsert_polities(conn, polity_records, pipeline_run=run_tag)
    finally:
        conn.close()

    print(f"  {loaded} polities upserted, {skipped} skipped (no name/slug).")
    print("\nNext step: re-export GeoJSON to include polities")
    print("  python3 scripts/export_geojson.py")


if __name__ == "__main__":
    main()
