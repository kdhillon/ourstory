"""
OurStory API server.

Run with:
    uvicorn server.main:app --reload --port 8000

Endpoints:
    PATCH /api/features/{event_id}      — save a user correction to Postgres
    GET   /api/features/overrides       — all manually-edited events as GeoJSON features
    PATCH /api/polities/{polity_id}     — save a user correction to a polity record
"""

import json
import os
import re
import urllib.request
import urllib.parse
from fastapi import FastAPI, HTTPException, Request, Depends, Header
from fastapi.responses import Response as FastAPIResponse
from typing import Optional
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ["DATABASE_URL"]  # set via Railway env

# Optional write secret — if set, all mutating endpoints require the
# X-Write-Secret header to match. Unset in local dev to skip the check.
WRITE_SECRET = os.environ.get("WRITE_SECRET")

async def require_write_secret(x_write_secret: Optional[str] = Header(default=None)):
    if WRITE_SECRET and x_write_secret != WRITE_SECRET:
        raise HTTPException(status_code=403, detail="Forbidden")

app = FastAPI(title="OurStory API", version="0.1.0")

app.add_middleware(GZipMiddleware, minimum_size=1000)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",   # Vite dev server
        "http://localhost:4173",   # Vite preview
        "http://localhost:3000",
        "https://openhistory.app",
        "https://www.openhistory.app",
    ],
    allow_credentials=True,
    allow_methods=["GET", "PATCH", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Write-Secret"],
)

# ── DB helpers ─────────────────────────────────────────────────────────────────

def get_conn():
    return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)


def display_year(year: int) -> str:
    if year == 0:
        return "Year 0"
    if year < 0:
        return f"{abs(year)} BCE"
    return f"{year} CE"


_POLITY_COLORS = {
    "empire":        "#8B0000",
    "kingdom":       "#1A237E",
    "principality":  "#4E342E",
    "republic":      "#1B5E20",
    "confederation": "#4A148C",
    "sultanate":     "#BF360C",
    "papacy":        "#F9A825",
    "colony":        "#5D4037",
    "people":        "#78909C",  # slate — tribes, nations, indigenous peoples
    "other":         "#607D8B",
}


def build_event_feature(cur, event_id: str) -> dict | None:
    """Re-fetch a single event from DB and format it as a GeoJSON Feature."""
    cur.execute("""
        SELECT
          e.id, e.slug, e.title, e.wikipedia_title, e.wikipedia_summary, e.wikipedia_url,
          e.year_start, e.month_start, e.day_start,
          e.year_end, e.month_end, e.day_end,
          e.date_is_fuzzy, e.date_range_min, e.date_range_max,
          e.location_level, e.location_wikidata_qid,
          CASE WHEN e.location_level = 'point' THEN e.lng ELSE l.lng END AS lng,
          CASE WHEN e.location_level = 'point' THEN e.lat ELSE l.lat END AS lat,
          e.location_name,
          l.slug AS location_slug,
          e.categories, e.p31_qids, e.part_of_qids,
          e.sitelinks_count, e.data_version, e.pipeline_run
        FROM events e
        LEFT JOIN locations l ON e.location_wikidata_qid = l.wikidata_qid
        WHERE e.id = %s
    """, (event_id,))
    row = cur.fetchone()
    if not row:
        return None

    # Resolve part_of_qids → titles
    qid_map: dict = {}
    if row["part_of_qids"]:
        cur.execute(
            "SELECT wikidata_qid, title, slug FROM events WHERE wikidata_qid = ANY(%s)",
            (row["part_of_qids"],),
        )
        qid_map = {r["wikidata_qid"]: {"title": r["title"], "slug": r["slug"]} for r in cur.fetchall()}

    part_of_resolved = [
        {"qid": qid, "title": qid_map[qid]["title"], "slug": qid_map[qid]["slug"]}
        for qid in (row["part_of_qids"] or [])
        if qid in qid_map
    ]

    lng, lat = row["lng"], row["lat"]
    geometry = (
        {"type": "Point", "coordinates": [float(lng), float(lat)]}
        if lng is not None and lat is not None
        else None
    )

    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": {
            "featureType": "event",
            "id": str(row["id"]),
            "slug": row["slug"] or (row["wikipedia_title"] or "").replace(" ", "_"),
            "title": row["title"],
            "wikipediaTitle": row["wikipedia_title"],
            "wikipediaSummary": row["wikipedia_summary"] or "",
            "wikipediaUrl": row["wikipedia_url"],
            "yearStart": row["year_start"],
            "monthStart": row["month_start"],
            "dayStart": row["day_start"],
            "yearEnd": row["year_end"],
            "monthEnd": row["month_end"],
            "dayEnd": row["day_end"],
            "dateIsFuzzy": row["date_is_fuzzy"],
            "dateRangeMin": row["date_range_min"],
            "dateRangeMax": row["date_range_max"],
            "locationLevel": row["location_level"],
            "locationName": row["location_name"] or "",
            "locationSlug": row["location_slug"],
            "locationWikidataQid": row["location_wikidata_qid"],
            "categories": row["categories"] or [],
            "primaryCategory": (row["categories"] or ["unknown"])[0],
            "wikidataClasses": row["p31_qids"] or [],
            "partOf": row["part_of_qids"] or [],
            "partOfResolved": part_of_resolved,
            "sitelinksCount": row["sitelinks_count"],
            "yearDisplay": display_year(row["year_start"]) if row["year_start"] is not None else "Unknown",
            "dataVersion": row["data_version"],
            "pipelineRun": row["pipeline_run"],
        },
    }


def build_event_features_bulk(cur, year_min: int, year_max: int) -> list[dict]:
    """
    Return all events overlapping [year_min, year_max] as GeoJSON Features.
    Uses the GiST year_range index for O(log n + k) lookup.
    Total: 2 DB queries regardless of window size.
    """
    cur.execute("""
        SELECT
          e.id, e.wikidata_qid, e.slug, e.title, e.wikipedia_title, e.wikipedia_summary, e.wikipedia_url,
          e.year_start, e.month_start, e.day_start,
          e.year_end, e.month_end, e.day_end,
          e.date_is_fuzzy, e.date_range_min, e.date_range_max,
          e.location_level, e.location_wikidata_qid,
          CASE WHEN e.location_level = 'point' THEN e.lng ELSE l.lng END AS lng,
          CASE WHEN e.location_level = 'point' THEN e.lat ELSE l.lat END AS lat,
          e.location_name,
          l.slug AS location_slug,
          e.categories, e.p31_qids, e.part_of_qids,
          e.sitelinks_count, e.data_version, e.pipeline_run
        FROM events e
        LEFT JOIN locations l ON e.location_wikidata_qid = l.wikidata_qid
        WHERE e.year_range && int4range(%(year_min)s, %(year_max)s, '[]')
          AND e.year_start IS NOT NULL
        ORDER BY e.year_start
    """, {"year_min": year_min, "year_max": year_max})
    rows = cur.fetchall()

    if not rows:
        return []

    # Batch-resolve all part_of_qids in one query
    all_qids: list[str] = []
    for row in rows:
        all_qids.extend(row["part_of_qids"] or [])

    qid_map: dict = {}
    if all_qids:
        cur.execute(
            "SELECT wikidata_qid, title, slug FROM events WHERE wikidata_qid = ANY(%s)",
            (list(set(all_qids)),),
        )
        qid_map = {r["wikidata_qid"]: {"title": r["title"], "slug": r["slug"]} for r in cur.fetchall()}

    features = []
    for row in rows:
        part_of_resolved = [
            {"qid": qid, "title": qid_map[qid]["title"], "slug": qid_map[qid]["slug"]}
            for qid in (row["part_of_qids"] or [])
            if qid in qid_map
        ]

        lng, lat = row["lng"], row["lat"]
        geometry = (
            {"type": "Point", "coordinates": [float(lng), float(lat)]}
            if lng is not None and lat is not None
            else None
        )

        features.append({
            "type": "Feature",
            "geometry": geometry,
            "properties": {
                "featureType": "event",
                "id": str(row["id"]),
                "wikidataQid": row["wikidata_qid"],
                "slug": row["slug"] or (row["wikipedia_title"] or "").replace(" ", "_"),
                "title": row["title"],
                "wikipediaTitle": row["wikipedia_title"],
                "wikipediaSummary": row["wikipedia_summary"] or "",
                "wikipediaUrl": row["wikipedia_url"],
                "yearStart": row["year_start"],
                "monthStart": row["month_start"],
                "dayStart": row["day_start"],
                "yearEnd": row["year_end"],
                "monthEnd": row["month_end"],
                "dayEnd": row["day_end"],
                "dateIsFuzzy": row["date_is_fuzzy"],
                "dateRangeMin": row["date_range_min"],
                "dateRangeMax": row["date_range_max"],
                "locationLevel": row["location_level"],
                "locationName": row["location_name"] or "",
                "locationSlug": row["location_slug"],
                "locationWikidataQid": row["location_wikidata_qid"],
                "categories": row["categories"] or [],
                "primaryCategory": (row["categories"] or ["unknown"])[0],
                "wikidataClasses": row["p31_qids"] or [],
                "partOf": row["part_of_qids"] or [],
                "partOfResolved": part_of_resolved,
                "sitelinksCount": row["sitelinks_count"],
                "yearDisplay": display_year(row["year_start"]) if row["year_start"] is not None else "Unknown",
                "dataVersion": row["data_version"],
                "pipelineRun": row["pipeline_run"],
            },
        })

    return features


# ── Location auto-import helper ─────────────────────────────────────────────────

def _ensure_location_exists(cur, qid: str) -> str:
    """
    Ensure a location with the given Wikidata QID exists in our locations table.
    If not present, fetch it from Wikidata, classify its type, and insert it.
    Returns the location_type ('city', 'region', or 'country').
    """
    cur.execute("SELECT location_type FROM locations WHERE wikidata_qid = %s", (qid,))
    row = cur.fetchone()
    if row:
        return row["location_type"]

    # Not in DB — fetch from Wikidata and insert
    try:
        entity = _wd_fetch(qid)
    except Exception:
        return "region"  # graceful fallback if Wikidata is unreachable

    claims = entity.get("claims", {})
    labels = entity.get("labels", {})
    sitelinks = entity.get("sitelinks", {})

    name = labels.get("en", {}).get("value") or qid
    wiki_title = sitelinks.get("enwiki", {}).get("title")

    # Classify type from P31 instance-of QIDs
    _CITY_P31   = {"Q515", "Q1549591", "Q532", "Q3957", "Q7930989", "Q2514025", "Q486972"}
    _REGION_P31 = {"Q82794", "Q10864048", "Q1428", "Q35657", "Q11828004", "Q56061",
                   "Q107390", "Q16110", "Q13220204", "Q3455524"}
    p31_qids = {
        s["mainsnak"]["datavalue"]["value"]["id"]
        for s in claims.get("P31", [])
        if s["mainsnak"].get("datavalue", {}).get("type") == "wikibase-entityid"
    }
    if p31_qids & _CITY_P31:
        loc_type = "city"
    elif p31_qids & _REGION_P31:
        loc_type = "region"
    else:
        loc_type = "region"  # default for ambiguous entities

    # Coordinates
    coords = _wd_coords(claims)
    lat = coords[0] if coords else None
    lng = coords[1] if coords else None

    # Slug — lowercase, hyphenated
    slug_base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    slug = slug_base
    suffix = 1
    while True:
        cur.execute("SELECT 1 FROM locations WHERE slug = %s", (slug,))
        if not cur.fetchone():
            break
        slug = f"{slug_base}-{suffix}"
        suffix += 1

    wiki_url = f"https://en.wikipedia.org/wiki/{wiki_title.replace(' ', '_')}" if wiki_title else ""

    cur.execute(
        """
        INSERT INTO locations
            (wikidata_qid, slug, name, wikipedia_title, wikipedia_url, location_type, lat, lng, pipeline_run)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'manual-location-import')
        ON CONFLICT (wikidata_qid) DO NOTHING
        """,
        (qid, slug, name, wiki_title, wiki_url, loc_type, lat, lng),
    )
    return loc_type


# ── Routes ──────────────────────────────────────────────────────────────────────

# Fields the PATCH endpoint is allowed to update, mapped to their DB column names.
_ALLOWED_FIELDS = {
    "year_start", "month_start", "day_start",
    "year_end", "month_end", "day_end",
    "location_name", "location_wikidata_qid", "location_level",
    "manually_hidden", "categories",
}


@app.patch("/api/features/{event_id}")
async def patch_feature(event_id: str, request: Request, _: None = Depends(require_write_secret)):
    """
    Save a user correction to Postgres and return the updated GeoJSON feature.

    Body (JSON): any subset of the allowed fields. Send `null` to clear a field.
    Example date edit:
        { "year_start": 1798, "month_start": 6, "day_start": 9,
          "year_end": 1800, "month_end": null, "day_end": null }
    Example location edit:
        { "location_name": "Malta", "location_wikidata_qid": "Q233" }
    """
    body: dict = await request.json()
    updates = {k: v for k, v in body.items() if k in _ALLOWED_FIELDS}
    if not updates:
        raise HTTPException(400, "No valid fields provided.")

    conn = get_conn()
    try:
        cur = conn.cursor()

        # Verify the event exists
        cur.execute("SELECT id FROM events WHERE id = %s", (event_id,))
        if not cur.fetchone():
            raise HTTPException(404, f"Event {event_id} not found.")

        # If a location QID is provided but no level, ensure the location exists
        # in our locations table (auto-importing from Wikidata if needed) then resolve level.
        if "location_wikidata_qid" in updates and "location_level" not in updates:
            qid = updates["location_wikidata_qid"]
            if qid:
                updates["location_level"] = _ensure_location_exists(cur, qid)
            else:
                updates["location_level"] = None

        # Build parameterised UPDATE — keys are from the allowlist so safe
        set_parts = [f"{col} = %({col})s" for col in updates]
        set_parts.append("manually_edited_at = NOW()")
        sql = f"UPDATE events SET {', '.join(set_parts)} WHERE id = %(id)s"
        cur.execute(sql, {**updates, "id": event_id})
        conn.commit()

        # Return the fully re-fetched feature so the frontend has accurate coords
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        feature = build_event_feature(cur, event_id)
        if not feature:
            raise HTTPException(500, "Feature not found after update.")
        return feature

    finally:
        conn.close()


_POLITY_ALLOWED_FIELDS = {
    "name", "year_start", "year_end", "capital_name", "capital_wikidata_qid",
    "polity_type", "short_name", "lat", "lng", "sovereign_qids",
    "manually_hidden",
}


@app.patch("/api/polities/{polity_id}")
async def patch_polity(polity_id: str, request: Request, _: None = Depends(require_write_secret)):
    """
    Save a user correction to a polity record in Postgres.

    Body (JSON): any subset of the allowed fields. Send `null` to clear a field.
    Example:
        { "year_start": 1792, "year_end": 1804, "name": "French First Republic" }
    """
    body: dict = await request.json()
    updates = {k: v for k, v in body.items() if k in _POLITY_ALLOWED_FIELDS}
    if not updates:
        raise HTTPException(400, "No valid fields provided.")

    conn = get_conn()
    try:
        cur = conn.cursor()

        cur.execute("SELECT id FROM polities WHERE id = %s", (polity_id,))
        if not cur.fetchone():
            raise HTTPException(404, f"Polity {polity_id} not found.")

        set_parts = [f"{col} = %({col})s" for col in updates]
        set_parts.append("manually_edited_at = NOW()")
        sql = f"UPDATE polities SET {', '.join(set_parts)} WHERE id = %(id)s"
        cur.execute(sql, {**updates, "id": polity_id})
        conn.commit()

        # Return the updated polity as a GeoJSON-style feature
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT id, wikidata_qid, slug, name, wikipedia_title, wikipedia_summary, wikipedia_url,
                   year_start, year_end, date_is_fuzzy, polity_type,
                   capital_name, capital_wikidata_qid, lng, lat,
                   preceded_by_qid, succeeded_by_qid, sovereign_qids, p31_qids,
                   data_version, pipeline_run
            FROM polities WHERE id = %s
        """, (polity_id,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(500, "Polity not found after update.")

        lng, lat = row["lng"], row["lat"]
        return {
            "type": "Feature",
            "geometry": (
                {"type": "Point", "coordinates": [float(lng), float(lat)]}
                if lng is not None and lat is not None else None
            ),
            "properties": {
                "featureType": "polity",
                "id": str(row["id"]),
                "wikidataQid": row["wikidata_qid"],
                "slug": row["slug"],
                "title": row["name"],
                "wikipediaTitle": row["wikipedia_title"],
                "wikipediaSummary": row["wikipedia_summary"] or "",
                "wikipediaUrl": row["wikipedia_url"],
                "yearStart": row["year_start"],
                "yearEnd": row["year_end"],
                "dateIsFuzzy": row["date_is_fuzzy"],
                "polityType": row["polity_type"],
                "capitalName": row["capital_name"],
                "capitalWikidataQid": row["capital_wikidata_qid"],
                "precededByQid": row["preceded_by_qid"],
                "succeededByQid": row["succeeded_by_qid"],
                "sovereignQids": row["sovereign_qids"] or [],
                "categories": [row["polity_type"]],
                "primaryCategory": row["polity_type"],
                "wikidataClasses": row["p31_qids"] or [],
                "hasTerritory": False,
                "yearDisplay": display_year(row["year_start"]) if row["year_start"] is not None else "Unknown",
                "dataVersion": row["data_version"],
                "pipelineRun": row["pipeline_run"],
            },
        }
    finally:
        conn.close()


# ── Wikidata polity import helpers ─────────────────────────────────────────────

def _wd_fetch(qid: str) -> dict:
    """Fetch a Wikidata entity via Special:EntityData."""
    url = f"https://www.wikidata.org/wiki/Special:EntityData/{qid}.json"
    req = urllib.request.Request(url, headers={"User-Agent": "OpenHistory/1.0 (https://openhistory.app)"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())["entities"][qid]


def _wd_str_value(claims: dict, prop: str) -> str | None:
    """Return first string value for a Wikidata claim, or None."""
    for s in claims.get(prop, []):
        dv = s.get("mainsnak", {}).get("datavalue", {})
        if dv.get("type") == "string":
            return dv["value"]
    return None


def _wd_item_id(claims: dict, prop: str) -> str | None:
    """Return first item QID for a Wikidata claim, or None."""
    for s in claims.get(prop, []):
        dv = s.get("mainsnak", {}).get("datavalue", {})
        if dv.get("type") == "wikibase-entityid":
            return dv["value"]["id"]
    return None


def _wd_coords(claims: dict) -> tuple[float, float] | None:
    """Return (lat, lng) from P625, or None."""
    for s in claims.get("P625", []):
        dv = s.get("mainsnak", {}).get("datavalue", {})
        if dv.get("type") == "globecoordinate":
            v = dv["value"]
            return float(v["latitude"]), float(v["longitude"])
    return None


def _wd_year(claims: dict, prop: str) -> int | None:
    """Return year integer from a Wikidata time claim."""
    for s in claims.get(prop, []):
        dv = s.get("mainsnak", {}).get("datavalue", {})
        if dv.get("type") == "time":
            t = dv["value"]["time"]  # e.g. "+1492-00-00T00:00:00Z"
            m = re.match(r"([+-])(\d+)-", t)
            if m:
                y = int(m.group(2))
                return -y if m.group(1) == "-" else y
    return None


def _classify_polity_type_simple(name: str, p31_qids: list[str]) -> str:
    """Lightweight polity type classifier for manually imported entities."""
    # P31 QID-based checks for common types
    _TYPE_QIDS: dict[str, str] = {
        "Q3024240": "other",     # historical country
        "Q6256":    "other",     # country
        "Q7275":    "republic",  # state
        "Q7270":    "republic",  # republic
        "Q28171280": "republic", # sovereign state
        "Q43702":   "confederation",  # confederation
        "Q208511":  "empire",    # empire
        "Q1250464": "empire",    # empire (alt)
        "Q160016":  "sultanate", # sultanate
        "Q170018":  "sultanate", # caliphate
        "Q202216":  "kingdom",   # kingdom
        "Q170089":  "principality",
        "Q1336137": "colony",    # colony
        "Q23526":   "people",    # tribal nation / First Nation
        "Q41710":   "people",    # ethnic group
        "Q484652":  "people",    # indigenous peoples
        "Q33506":   "people",    # tribe
        "Q839954":  "people",    # indigenous people
    }
    for qid in p31_qids:
        if qid in _TYPE_QIDS:
            return _TYPE_QIDS[qid]
    # Name-based fallback
    n = name.lower()
    if any(w in n for w in ("empire",)): return "empire"
    if any(w in n for w in ("kingdom",)): return "kingdom"
    if any(w in n for w in ("republic",)): return "republic"
    if any(w in n for w in ("confederation", "confederacy")): return "confederation"
    if any(w in n for w in ("sultanate",)): return "sultanate"
    if any(w in n for w in ("principality", "duchy", "margraviate")): return "principality"
    if any(w in n for w in ("colony", "colonial")): return "colony"
    if any(w in n for w in ("tribe", "nation", "band", "people", "peoples",
                             "first nation", "indigenous", "confederacy")): return "people"
    # Default for manually imported entities: people (primary use case)
    return "people"


def _wp_summary(title: str) -> tuple[str, str]:
    """Fetch Wikipedia summary and URL. Returns (summary, url)."""
    try:
        encoded = urllib.parse.quote(title.replace(" ", "_"))
        url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}"
        req = urllib.request.Request(url, headers={"User-Agent": "OpenHistory/1.0"})
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read())
            return data.get("extract", ""), data.get("content_urls", {}).get("desktop", {}).get("page", "")
    except Exception:
        return "", ""


def _build_polity_feature(row: dict) -> dict:
    """Format a polity DB row as a GeoJSON Feature (same shape as seed.geojson)."""
    lng, lat = row["lng"], row["lat"]
    return {
        "type": "Feature",
        "geometry": (
            {"type": "Point", "coordinates": [float(lng), float(lat)]}
            if lng is not None and lat is not None else None
        ),
        "properties": {
            "featureType": "polity",
            "id": str(row["id"]),
            "wikidataQid": row["wikidata_qid"],
            "slug": row["slug"],
            "title": row["name"],
            "wikipediaTitle": row["wikipedia_title"],
            "wikipediaSummary": row["wikipedia_summary"] or "",
            "wikipediaUrl": row["wikipedia_url"],
            "yearStart": row["year_start"],
            "yearEnd": row["year_end"],
            "monthStart": None, "dayStart": None, "monthEnd": None, "dayEnd": None,
            "dateIsFuzzy": row["date_is_fuzzy"],
            "dateRangeMin": None, "dateRangeMax": None,
            "polityType": row["polity_type"],
            "capitalName": row["capital_name"],
            "capitalWikidataQid": row["capital_wikidata_qid"],
            "precededByQid": row["preceded_by_qid"],
            "succeededByQid": row["succeeded_by_qid"],
            "sovereignName": None, "sovereignSlug": None, "sovereignQid": None,
            "locationName": "",
            "locationSlug": None,
            "categories": [row["polity_type"]],
            "primaryCategory": row["polity_type"],
            "wikidataClasses": row["p31_qids"] or [],
            "hasTerritory": False,
            "sitelinksCount": row.get("sitelinks_count"),
            "yearDisplay": display_year(row["year_start"]) if row["year_start"] is not None else "Unknown",
            "dataVersion": row.get("data_version"),
            "pipelineRun": row.get("pipeline_run"),
        },
    }


import urllib.parse


@app.post("/api/polities/import-from-wikidata", status_code=201)
async def import_polity_from_wikidata(request: Request, _: None = Depends(require_write_secret)):
    """
    Fetch a Wikidata entity by QID and import it as a polity.

    Body: { "qid": "Q193268" }

    Returns the new (or existing) polity as a GeoJSON Feature.
    If the QID already exists in the DB, returns the existing record (200).
    """
    body = await request.json()
    qid: str = (body.get("qid") or "").strip().upper()
    if not qid or not re.match(r"^Q\d+$", qid):
        raise HTTPException(400, "Invalid or missing QID.")

    # 1. Check if already in DB
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT id, wikidata_qid, slug, name, wikipedia_title, wikipedia_summary, wikipedia_url,
                   year_start, year_end, date_is_fuzzy, polity_type,
                   capital_name, capital_wikidata_qid, lng, lat,
                   preceded_by_qid, succeeded_by_qid, p31_qids,
                   sitelinks_count, data_version, pipeline_run
            FROM polities WHERE wikidata_qid = %s
        """, (qid,))
        existing = cur.fetchone()
        if existing:
            return _build_polity_feature(dict(existing))
    finally:
        conn.close()

    # 2. Fetch from Wikidata
    try:
        entity = _wd_fetch(qid)
    except Exception as e:
        raise HTTPException(502, f"Wikidata fetch failed: {e}")

    claims = entity.get("claims", {})
    labels = entity.get("labels", {})
    sitelinks = entity.get("sitelinks", {})

    name = (labels.get("en") or labels.get(next(iter(labels), ""), {})).get("value") or qid
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    wp_title = sitelinks.get("enwiki", {}).get("title")

    year_start = _wd_year(claims, "P571") or _wd_year(claims, "P580")
    year_end   = _wd_year(claims, "P576") or _wd_year(claims, "P582")

    p31_qids = [_wd_item_id({"P31": [s]}, "P31") for s in claims.get("P31", [])]
    p31_qids = [q for q in p31_qids if q]

    polity_type = _classify_polity_type_simple(name, p31_qids)

    # Coordinates: try P625 direct, then capital P36 → P625
    coords = _wd_coords(claims)
    lat, lng, capital_name, capital_qid = None, None, None, None

    capital_qid_raw = _wd_item_id(claims, "P36")
    if capital_qid_raw:
        capital_qid = capital_qid_raw
        try:
            cap_entity = _wd_fetch(capital_qid)
            cap_labels = cap_entity.get("labels", {})
            capital_name = (cap_labels.get("en") or cap_labels.get(next(iter(cap_labels), ""), {})).get("value")
            cap_coords = _wd_coords(cap_entity.get("claims", {}))
            if cap_coords:
                lat, lng = cap_coords
        except Exception:
            pass

    if lat is None and coords:
        lat, lng = coords

    preceded_by = _wd_item_id(claims, "P1365")
    succeeded_by = _wd_item_id(claims, "P1366")

    # Wikipedia summary
    wp_summary, wp_url = ("", "")
    if wp_title:
        wp_summary, wp_url = _wp_summary(wp_title)

    # 3. Insert into DB
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            INSERT INTO polities (
                wikidata_qid, slug, name, wikipedia_title, wikipedia_summary, wikipedia_url,
                year_start, year_end, date_is_fuzzy, polity_type,
                capital_name, capital_wikidata_qid, lng, lat,
                preceded_by_qid, succeeded_by_qid, p31_qids,
                data_version, pipeline_run
            ) VALUES (
                %(wikidata_qid)s, %(slug)s, %(name)s, %(wikipedia_title)s,
                %(wikipedia_summary)s, %(wikipedia_url)s,
                %(year_start)s, %(year_end)s, FALSE, %(polity_type)s,
                %(capital_name)s, %(capital_wikidata_qid)s, %(lng)s, %(lat)s,
                %(preceded_by_qid)s, %(succeeded_by_qid)s, %(p31_qids)s,
                2, 'manual-import'
            )
            ON CONFLICT (wikidata_qid) DO UPDATE SET pipeline_run = polities.pipeline_run
            RETURNING id, wikidata_qid, slug, name, wikipedia_title, wikipedia_summary, wikipedia_url,
                      year_start, year_end, date_is_fuzzy, polity_type,
                      capital_name, capital_wikidata_qid, lng, lat,
                      preceded_by_qid, succeeded_by_qid, p31_qids,
                      sitelinks_count, data_version, pipeline_run
        """, {
            "wikidata_qid": qid, "slug": slug, "name": name,
            "wikipedia_title": wp_title, "wikipedia_summary": wp_summary, "wikipedia_url": wp_url,
            "year_start": year_start, "year_end": year_end, "polity_type": polity_type,
            "capital_name": capital_name, "capital_wikidata_qid": capital_qid,
            "lng": lng, "lat": lat,
            "preceded_by_qid": preceded_by, "succeeded_by_qid": succeeded_by,
            "p31_qids": p31_qids,
        })
        conn.commit()
        row = dict(cur.fetchone())
        return _build_polity_feature(row)
    finally:
        conn.close()


@app.get("/api/polities/manual")
def get_manual_polities():
    """
    Return all manually imported polities (pipeline_run='manual-import') as GeoJSON features.

    The frontend fetches this on startup and merges over the static seed.geojson,
    so imported polities appear on the map immediately without a full rebuild.
    """
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT id, wikidata_qid, slug, name, wikipedia_title, wikipedia_summary, wikipedia_url,
                   year_start, year_end, date_is_fuzzy, polity_type,
                   capital_name, capital_wikidata_qid, lng, lat,
                   preceded_by_qid, succeeded_by_qid, p31_qids,
                   sitelinks_count, data_version, pipeline_run
            FROM polities WHERE pipeline_run = 'manual-import'
            ORDER BY name
        """)
        features = [_build_polity_feature(dict(r)) for r in cur.fetchall()]
        return {"type": "FeatureCollection", "features": features}
    finally:
        conn.close()


@app.get("/api/features/overrides")
def get_overrides():
    """
    Return all manually-edited events as a GeoJSON FeatureCollection.

    The frontend fetches this on startup and merges it over the static seed.geojson,
    so user corrections survive hard refreshes without requiring a pipeline re-run.
    """
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT id FROM events WHERE manually_edited_at IS NOT NULL ORDER BY manually_edited_at DESC")
        ids = [str(row["id"]) for row in cur.fetchall()]
        features = [f for event_id in ids if (f := build_event_feature(cur, event_id)) is not None]
        return {"type": "FeatureCollection", "features": features, "count": len(features)}
    finally:
        conn.close()


@app.get("/api/polities/overrides")
def get_polity_overrides():
    """
    Return all manually-edited polities as a GeoJSON FeatureCollection.

    The frontend fetches this on startup and merges it over the static seed.geojson,
    so user corrections (year_start, year_end, etc.) survive hard refreshes without
    requiring a pipeline re-run.
    """
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT id, wikidata_qid, slug, name, wikipedia_title, wikipedia_summary, wikipedia_url,
                   year_start, year_end, date_is_fuzzy, polity_type,
                   capital_name, capital_wikidata_qid, lng, lat,
                   preceded_by_qid, succeeded_by_qid, sovereign_qids, p31_qids
            FROM polities
            WHERE manually_edited_at IS NOT NULL
            ORDER BY manually_edited_at DESC
        """)
        features = [_build_polity_feature(dict(r)) for r in cur.fetchall()]
        return {"type": "FeatureCollection", "features": features, "count": len(features)}
    finally:
        conn.close()


@app.get("/api/hidden-features")
def get_hidden_features():
    """Return IDs of all manually-hidden polities and events."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT id FROM polities WHERE manually_hidden = TRUE")
        polity_ids = [str(r[0]) for r in cur.fetchall()]
        cur.execute("SELECT id FROM events WHERE manually_hidden = TRUE")
        event_ids = [str(r[0]) for r in cur.fetchall()]
        return {"ids": polity_ids + event_ids}
    finally:
        conn.close()


@app.get("/api/hidden-modern-nations")
def get_hidden_modern_nations():
    """Return all hidden modern nation polity ids with their hide_until_year."""
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT polity_id, hide_until_year, notes FROM hidden_modern_nations ORDER BY hidden_at")
        return [{"polityId": str(r["polity_id"]), "hideUntilYear": r["hide_until_year"], "notes": r["notes"]} for r in cur.fetchall()]
    finally:
        conn.close()


@app.post("/api/hidden-modern-nations", status_code=201)
def add_hidden_modern_nation(body: dict, _: None = Depends(require_write_secret)):
    """Add a polity to the hidden modern nations list."""
    polity_id = body.get("polityId")
    hide_until_year = int(body.get("hideUntilYear", 1900))
    notes = body.get("notes", "")
    if not polity_id:
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="polityId required")
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO hidden_modern_nations (polity_id, hide_until_year, notes) VALUES (%s, %s, %s) ON CONFLICT (polity_id) DO UPDATE SET hide_until_year = EXCLUDED.hide_until_year, notes = EXCLUDED.notes",
            (polity_id, hide_until_year, notes),
        )
        conn.commit()
        return {"polityId": polity_id, "hideUntilYear": hide_until_year}
    finally:
        conn.close()


@app.delete("/api/hidden-modern-nations/{polity_id}", status_code=204)
def remove_hidden_modern_nation(polity_id: str, _: None = Depends(require_write_secret)):
    """Remove a polity from the hidden modern nations list."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM hidden_modern_nations WHERE polity_id = %s", (polity_id,))
        conn.commit()
    finally:
        conn.close()


@app.delete("/api/territories/by-polity/{polity_id}", status_code=204)
def remove_territory_mappings_for_polity(polity_id: str, _: None = Depends(require_write_secret)):
    """Clear polity_id on all territory rows assigned to the given polity."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("UPDATE territories SET polity_id = NULL WHERE polity_id = %s", (polity_id,))
        conn.commit()
    finally:
        conn.close()


@app.get("/api/events")
def get_events(year_min: int, year_max: int):
    """
    Return all events overlapping [year_min, year_max] as a GeoJSON FeatureCollection.

    Uses a GiST int4range index for O(log n + k) interval overlap queries.
    2 DB queries total regardless of window size.
    """
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        features = build_event_features_bulk(cur, year_min, year_max)
        return {
            "type": "FeatureCollection",
            "features": features,
            "count": len(features),
            "yearMin": year_min,
            "yearMax": year_max,
        }
    finally:
        conn.close()


@app.get("/api/events/by-qids")
def get_events_by_qids(qids: str):
    """
    Return specific events by Wikidata QIDs as a GeoJSON FeatureCollection.
    Used by the story player to pre-fetch beat event data.

    Query param: qids=Q1,Q2,Q3 (comma-separated)
    """
    qid_list = [q.strip() for q in qids.split(",") if q.strip().startswith("Q")]
    if not qid_list:
        return {"type": "FeatureCollection", "features": [], "count": 0}

    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT
              e.id, e.wikidata_qid, e.slug, e.title, e.wikipedia_title, e.wikipedia_summary, e.wikipedia_url,
              e.year_start, e.month_start, e.day_start,
              e.year_end, e.month_end, e.day_end,
              e.date_is_fuzzy, e.date_range_min, e.date_range_max,
              e.location_level, e.location_wikidata_qid,
              CASE WHEN e.location_level = 'point' THEN e.lng ELSE l.lng END AS lng,
              CASE WHEN e.location_level = 'point' THEN e.lat ELSE l.lat END AS lat,
              e.location_name,
              l.slug AS location_slug,
              e.categories, e.p31_qids, e.part_of_qids,
              e.sitelinks_count, e.data_version, e.pipeline_run
            FROM events e
            LEFT JOIN locations l ON e.location_wikidata_qid = l.wikidata_qid
            WHERE e.wikidata_qid = ANY(%s)
        """, (qid_list,))
        rows = cur.fetchall()

        all_qids: list[str] = []
        for row in rows:
            all_qids.extend(row["part_of_qids"] or [])
        qid_map: dict = {}
        if all_qids:
            cur.execute(
                "SELECT wikidata_qid, title, slug FROM events WHERE wikidata_qid = ANY(%s)",
                (list(set(all_qids)),),
            )
            qid_map = {r["wikidata_qid"]: {"title": r["title"], "slug": r["slug"]} for r in cur.fetchall()}

        features = []
        for row in rows:
            part_of_resolved = [
                {"qid": qid, "title": qid_map[qid]["title"], "slug": qid_map[qid]["slug"]}
                for qid in (row["part_of_qids"] or [])
                if qid in qid_map
            ]
            lng, lat = row["lng"], row["lat"]
            geometry = (
                {"type": "Point", "coordinates": [float(lng), float(lat)]}
                if lng is not None and lat is not None
                else None
            )
            features.append({
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "featureType": "event",
                    "id": str(row["id"]),
                    "wikidataQid": row["wikidata_qid"],
                    "slug": row["slug"] or (row["wikipedia_title"] or "").replace(" ", "_"),
                    "title": row["title"],
                    "wikipediaTitle": row["wikipedia_title"],
                    "wikipediaSummary": row["wikipedia_summary"] or "",
                    "wikipediaUrl": row["wikipedia_url"],
                    "yearStart": row["year_start"],
                    "monthStart": row["month_start"],
                    "dayStart": row["day_start"],
                    "yearEnd": row["year_end"],
                    "monthEnd": row["month_end"],
                    "dayEnd": row["day_end"],
                    "dateIsFuzzy": row["date_is_fuzzy"],
                    "dateRangeMin": row["date_range_min"],
                    "dateRangeMax": row["date_range_max"],
                    "locationLevel": row["location_level"],
                    "locationName": row["location_name"] or "",
                    "locationSlug": row["location_slug"],
                    "locationWikidataQid": row["location_wikidata_qid"],
                    "categories": row["categories"] or [],
                    "primaryCategory": (row["categories"] or ["unknown"])[0],
                    "wikidataClasses": row["p31_qids"] or [],
                    "partOf": row["part_of_qids"] or [],
                    "partOfResolved": part_of_resolved,
                    "sitelinksCount": row["sitelinks_count"],
                    "yearDisplay": display_year(row["year_start"]) if row["year_start"] is not None else "Unknown",
                    "dataVersion": row["data_version"],
                    "pipelineRun": row["pipeline_run"],
                },
            })

        return {"type": "FeatureCollection", "features": features, "count": len(features)}
    finally:
        conn.close()


@app.post("/api/territories/{territory_id}/assign", status_code=200)
async def assign_territory(territory_id: str, request: Request, _: None = Depends(require_write_secret)):
    """
    Assign a polity to a territory row.

    Validates that the polity's date range overlaps with the territory's year_start/year_end.
    If the polity only covers part of the range, creates unassigned gap rows (with parent_id)
    for the periods before and/or after.

    Body: { "polityId": "<uuid>" }
    Returns 422 if no overlap.
    """
    body = await request.json()
    polity_id = body.get("polityId")
    if not polity_id:
        raise HTTPException(400, "polityId required")

    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        # Fetch territory row
        cur.execute("""
            SELECT id, hb_name, hb_abbrevn, hb_subjecto, hb_partof,
                   border_precision, boundary, year_start, year_end, accuracy
            FROM territories WHERE id = %s
        """, (territory_id,))
        territory = cur.fetchone()
        if not territory:
            raise HTTPException(404, "Territory not found")

        t_start = territory["year_start"]
        t_end   = territory["year_end"]

        # Fetch polity dates
        cur.execute("SELECT id, year_start, year_end FROM polities WHERE id = %s", (polity_id,))
        polity = cur.fetchone()
        if not polity:
            raise HTTPException(404, "Polity not found")

        p_start = polity["year_start"]
        p_end   = polity["year_end"]

        # Overlap check (treat None as ±∞)
        t_end_num   = t_end   if t_end   is not None else 9999
        p_start_num = p_start if p_start is not None else -9999
        p_end_num   = p_end   if p_end   is not None else  9999

        if p_start_num > t_end_num or p_end_num < t_start:
            raise HTTPException(422,
                f"Polity ({p_start}–{p_end}) doesn't overlap with this territory's "
                f"window ({t_start}–{t_end})")

        # Compute the polity's slice within the territory range
        slice_start = max(p_start_num, t_start)

        if p_end is None and t_end is None:
            slice_end = None
        elif p_end is None:
            slice_end = t_end
        elif t_end is None:
            slice_end = p_end
        else:
            slice_end = min(p_end, t_end)

        needs_before = slice_start > t_start
        needs_after  = slice_end is not None and (t_end is None or slice_end < t_end)

        # Update this territory: narrow its range to the polity's slice and assign polity
        cur.execute("""
            UPDATE territories
            SET polity_id = %s, year_start = %s, year_end = %s, explicitly_unlinked = FALSE
            WHERE id = %s
        """, (polity_id, slice_start, slice_end, territory_id))

        # Gap before (unassigned)
        if needs_before:
            cur.execute("""
                INSERT INTO territories (
                    hb_name, hb_abbrevn, hb_subjecto, hb_partof,
                    border_precision, boundary, year_start, year_end,
                    accuracy, polity_id, parent_id
                )
                SELECT hb_name, hb_abbrevn, hb_subjecto, hb_partof,
                       border_precision, boundary, %s, %s,
                       accuracy, NULL, %s
                FROM territories WHERE id = %s
            """, (t_start, slice_start - 1, territory_id, territory_id))

        # Gap after (unassigned)
        if needs_after:
            cur.execute("""
                INSERT INTO territories (
                    hb_name, hb_abbrevn, hb_subjecto, hb_partof,
                    border_precision, boundary, year_start, year_end,
                    accuracy, polity_id, parent_id
                )
                SELECT hb_name, hb_abbrevn, hb_subjecto, hb_partof,
                       border_precision, boundary, %s, %s,
                       accuracy, NULL, %s
                FROM territories WHERE id = %s
            """, (slice_end + 1, t_end, territory_id, territory_id))

        conn.commit()
        return {
            "ok": True,
            "yearStart": t_start,
            "yearEnd": t_end,
            "sliceStart": slice_start,
            "sliceEnd": slice_end,
            "createdBefore": needs_before,
            "createdAfter": needs_after,
        }
    finally:
        conn.close()


@app.delete("/api/territories/{territory_id}", status_code=204)
def delete_territory(territory_id: str, _: None = Depends(require_write_secret)):
    """Permanently delete a territory row."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM territories WHERE id = %s", (territory_id,))
        if cur.rowcount == 0:
            raise HTTPException(404, "Territory not found")
        conn.commit()
    finally:
        conn.close()


@app.patch("/api/territories/{territory_id}/years", status_code=204)
async def update_territory_years(territory_id: str, request: Request, _: None = Depends(require_write_secret)):
    """Update year_start / year_end of a territory without changing its boundary."""
    body = await request.json()
    year_start = body.get("yearStart")
    year_end   = body.get("yearEnd")   # None = open-ended
    if year_start is None:
        raise HTTPException(400, "yearStart required")
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE territories SET year_start = %s, year_end = %s WHERE id = %s",
            (year_start, year_end, territory_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, "Territory not found")
        conn.commit()
    finally:
        conn.close()


@app.post("/api/territories", status_code=201)
async def create_territory(request: Request, _: None = Depends(require_write_secret)):
    """
    Create a new territory row drawn by hand in the editor.
    Body: { "boundary": <GeoJSON MultiPolygon>, "yearStart": <int>, "yearEnd": <int>, "hbName"?: <str> }
    Returns: { "id": "<uuid>" }
    """
    body = await request.json()
    boundary  = body.get("boundary")
    year_start = body.get("yearStart")
    year_end   = body.get("yearEnd", year_start)
    hb_name    = body.get("hbName", "New Territory")

    if boundary is None or year_start is None:
        raise HTTPException(400, "boundary and yearStart required")

    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            INSERT INTO territories (hb_name, boundary, year_start, year_end, accuracy)
            VALUES (%s, %s::jsonb, %s, %s, 'added')
            RETURNING id
        """, (hb_name, json.dumps(boundary), year_start, year_end))
        row = cur.fetchone()
        conn.commit()
        return {"id": str(row["id"])}
    finally:
        conn.close()


@app.patch("/api/territories/{territory_id}/geometry", status_code=204)
async def patch_territory_geometry(territory_id: str, request: Request, _: None = Depends(require_write_secret)):
    """
    Update the boundary of a territory for a specific year.
    Year-splits the row if the edit year is a subset of [year_start, year_end]:
      - Creates a before row (year_start..year-1) if year > year_start
      - Creates an after row (year+1..year_end) if year < year_end
      - Updates this row to cover only Y..Y with the new boundary

    Body: { "boundary": <GeoJSON MultiPolygon>, "year": <int> }
    """
    body = await request.json()
    boundary = body.get("boundary")
    year = body.get("year")
    if boundary is None or year is None:
        raise HTTPException(400, "boundary and year required")

    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT id, year_start, year_end FROM territories WHERE id = %s", (territory_id,))
        territory = cur.fetchone()
        if not territory:
            raise HTTPException(404, "Territory not found")

        t_start = territory["year_start"]
        t_end   = territory["year_end"]

        if year < t_start:
            raise HTTPException(422, f"Year {year} is before territory start ({t_start})")
        if t_end is not None and year > t_end:
            raise HTTPException(422, f"Year {year} is after territory end ({t_end})")

        boundary_json = json.dumps(boundary)

        # If editing mid-range, preserve the original boundary for the period before this year
        if year > t_start:
            cur.execute("""
                INSERT INTO territories (
                    hb_name, hb_abbrevn, hb_subjecto, hb_partof,
                    border_precision, boundary, year_start, year_end,
                    accuracy, polity_id, parent_id
                )
                SELECT hb_name, hb_abbrevn, hb_subjecto, hb_partof,
                       border_precision, boundary, %s, %s,
                       accuracy, polity_id, %s
                FROM territories WHERE id = %s
            """, (t_start, year - 1, territory_id, territory_id))

        # Update this row from year Y to its original end — new boundary persists for the rest of its duration
        cur.execute("""
            UPDATE territories
            SET boundary = %s::jsonb, year_start = %s, accuracy = 'edited'
            WHERE id = %s
        """, (boundary_json, year, territory_id))

        conn.commit()
    finally:
        conn.close()


@app.patch("/api/territories/{territory_id}/unlink", status_code=204)
def unlink_territory(territory_id: str, _: None = Depends(require_write_secret)):
    """Mark a territory row as explicitly_unlinked=TRUE and clear polity_id."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE territories SET explicitly_unlinked = TRUE, polity_id = NULL WHERE id = %s",
            (territory_id,),
        )
        if cur.rowcount == 0:
            raise HTTPException(404, f"Territory {territory_id} not found.")
        conn.commit()
    finally:
        conn.close()


@app.get("/api/territories")
def get_territories(year_min: int, year_max: int, source: str = "hb"):
    """
    Return territory rows active during [year_min, year_max] as a GeoJSON FeatureCollection.
    source: 'hb' (historical-basemaps, default) or 'ohm' (OpenHistoricalMap)
    """
    if source not in ("hb", "ohm"):
        raise HTTPException(status_code=400, detail="source must be 'hb' or 'ohm'")

    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        cur.execute("""
            SELECT t.id, t.hb_name, t.hb_abbrevn, t.border_precision, t.boundary,
                   t.year_start, t.year_end, t.accuracy, t.explicitly_unlinked, t.parent_id,
                   t.source, t.ohm_name, t.ohm_admin_level, t.ohm_relation_id,
                   t.polity_id, p.slug AS polity_slug, p.name AS polity_name, p.polity_type,
                   p.year_start AS polity_year_start, p.year_end AS polity_year_end
            FROM territories t
            LEFT JOIN polities p ON p.id = t.polity_id
            WHERE t.year_start <= %(year_max)s
              AND (t.year_end IS NULL OR t.year_end >= %(year_min)s)
              AND t.source = %(source)s
            ORDER BY t.year_start, COALESCE(t.hb_name, t.ohm_name)
        """, {"year_min": year_min, "year_max": year_max, "source": source})
        rows = cur.fetchall()

        features = []
        for tr in rows:
            polity_type = tr["polity_type"]
            color = _POLITY_COLORS.get(polity_type, "#607D8B") if polity_type else "#78909C"

            effective_polity_id = None if tr["explicitly_unlinked"] else tr["polity_id"]

            # Display name: hb_name for HB rows, ohm_name for OHM rows
            display_name = tr["hb_name"] or tr["ohm_name"]

            features.append({
                "type": "Feature",
                "geometry": tr["boundary"],
                "properties": {
                    "featureType":        "territory",
                    "polygonId":          str(tr["id"]),
                    "yearStart":          tr["year_start"],
                    "yearEnd":            tr["year_end"],
                    "hbName":             display_name,
                    "hbAbbrevn":          tr["hb_abbrevn"],
                    "borderPrecision":    tr["border_precision"],
                    "explicitlyUnlinked": tr["explicitly_unlinked"],
                    "polityId":           str(effective_polity_id) if effective_polity_id else None,
                    "politySlug":         tr["polity_slug"] if not tr["explicitly_unlinked"] else None,
                    "polityName":         tr["polity_name"] if not tr["explicitly_unlinked"] else None,
                    "polityType":         polity_type if not tr["explicitly_unlinked"] else None,
                    "polityYearStart":    tr["polity_year_start"],
                    "polityYearEnd":      tr["polity_year_end"],
                    "accuracy":           tr["accuracy"],
                    "_color":             color if not tr["explicitly_unlinked"] else "#78909C",
                    # OHM-specific fields (None for HB rows)
                    "ohmName":            tr["ohm_name"],
                    "ohmAdminLevel":      tr["ohm_admin_level"],
                    "ohmRelationId":      tr["ohm_relation_id"],
                },
            })

        return {
            "type": "FeatureCollection",
            "features": features,
            "count": len(features),
            "yearMin": year_min,
            "yearMax": year_max,
        }
    finally:
        conn.close()


# ── OHM territory links ───────────────────────────────────────────────────────
# Lightweight polity→OHM-relation mapping for coloring live OHM vector tiles.
# No geometry stored here — tiles are fetched directly from vtiles.openhistoricalmap.org.


@app.get("/api/ohm-links")
def get_ohm_links():
    """Return all OHM territory links with resolved polity colors."""
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            SELECT l.id, l.ohm_relation_id, l.ohm_name, l.ohm_wikidata_qid,
                   l.ohm_admin_level, l.explicitly_unlinked,
                   l.polity_id, p.name AS polity_name, p.polity_type,
                   p.slug AS polity_slug, p.wikidata_qid AS polity_wikidata_qid
            FROM ohm_territory_links l
            LEFT JOIN polities p ON p.id = l.polity_id
            ORDER BY l.ohm_relation_id
        """)
        rows = cur.fetchall()
        links = []
        for r in rows:
            polity_type = r["polity_type"]
            color = _POLITY_COLORS.get(polity_type, "#607D8B") if polity_type else "#78909C"
            effective_polity_id = None if r["explicitly_unlinked"] else r["polity_id"]
            links.append({
                "id":                str(r["id"]),
                "ohmRelationId":     r["ohm_relation_id"],
                "ohmName":           r["ohm_name"],
                "ohmWikidataQid":    r["ohm_wikidata_qid"],
                "ohmAdminLevel":     r["ohm_admin_level"],
                "polityId":          str(effective_polity_id) if effective_polity_id else None,
                "polityName":        r["polity_name"] if not r["explicitly_unlinked"] else None,
                "polityType":        polity_type if not r["explicitly_unlinked"] else None,
                "politySlug":        r["polity_slug"] if not r["explicitly_unlinked"] else None,
                "color":             color if effective_polity_id else "#78909C",
                "explicitlyUnlinked": r["explicitly_unlinked"],
            })
        return {"links": links}
    finally:
        conn.close()


_OHM_DATE_SUFFIX = re.compile(r'\s*\(\d{1,4}(?:\s*[-\u2013]\s*(?:\d{1,4}|present))?\)\s*$')


@app.post("/api/ohm-links", dependencies=[Depends(require_write_secret)])
async def upsert_ohm_link(request: Request):
    """Create or update an OHM territory → polity link.

    ohm_name is normalised to a base name (date suffix stripped) so that one
    row covers all temporal slices of the same entity, e.g. both
    'French Republic (1800)' and 'French Republic (1801-1804)' upsert into
    the single row keyed by 'French Republic'.
    """
    body = await request.json()
    # Strip trailing " (YYYY)" / " (YYYY-YYYY)" from the territory name so that
    # the link applies to every temporal slice with the same base name.
    raw_name = body["ohmName"]
    base_name = _OHM_DATE_SUFFIX.sub('', raw_name).strip() if raw_name else raw_name
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("""
            INSERT INTO ohm_territory_links
              (ohm_name, ohm_wikidata_qid, ohm_admin_level, polity_id, explicitly_unlinked)
            VALUES
              (%(ohm_name)s, %(ohm_wikidata_qid)s, %(ohm_admin_level)s, %(polity_id)s, FALSE)
            ON CONFLICT (ohm_name) DO UPDATE SET
              ohm_wikidata_qid = EXCLUDED.ohm_wikidata_qid,
              ohm_admin_level  = EXCLUDED.ohm_admin_level,
              polity_id        = EXCLUDED.polity_id,
              explicitly_unlinked = FALSE
            RETURNING id
        """, {
            "ohm_name":        base_name,
            "ohm_wikidata_qid": body.get("ohmWikidataQid"),
            "ohm_admin_level": body.get("ohmAdminLevel"),
            "polity_id":       body.get("polityId"),
        })
        row = cur.fetchone()
        conn.commit()
        return {"id": str(row["id"])}
    finally:
        conn.close()


@app.patch("/api/ohm-links/{link_id}/unlink", dependencies=[Depends(require_write_secret)])
def unlink_ohm_territory(link_id: str):
    """Mark an OHM territory link as explicitly unlinked (clears polity assignment)."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE ohm_territory_links SET explicitly_unlinked = TRUE, polity_id = NULL WHERE id = %(id)s",
            {"id": link_id},
        )
        if cur.rowcount == 0:
            raise HTTPException(404, f"OHM link {link_id} not found.")
        conn.commit()
    finally:
        conn.close()


@app.post("/api/ohm-links/suppress", dependencies=[Depends(require_write_secret)])
async def suppress_ohm_link(request: Request):
    """Suppress an auto-matched OHM territory by name.

    Creates or updates a link row with explicitly_unlinked=TRUE so that
    rebuildColors skips auto-matching this territory name.
    """
    body = await request.json()
    raw_name = body.get("ohmName") or ""
    ohm_name = _OHM_DATE_SUFFIX.sub("", raw_name).strip()
    if not ohm_name:
        raise HTTPException(400, "ohmName is required")
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO ohm_territory_links (ohm_name, explicitly_unlinked, polity_id)
            VALUES (%(ohm_name)s, TRUE, NULL)
            ON CONFLICT (ohm_name) DO UPDATE SET
              explicitly_unlinked = TRUE,
              polity_id = NULL
            """,
            {"ohm_name": ohm_name},
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── Wikidata API proxy ────────────────────────────────────────────────────────
# Proxies browser requests to https://www.wikidata.org/w/api.php, forwarding
# cookies so the login session works in production (no Vite dev proxy there).

_WD_API = "https://www.wikidata.org/w/api.php"


@app.api_route("/wikidata-api", methods=["GET", "POST"])
async def wikidata_proxy(request: Request):
    cookie_header = request.headers.get("cookie", "")
    req_headers = {
        "Cookie": cookie_header,
        "User-Agent": "OpenHistory/1.0 (https://openhistory.app)",
        "Accept": "application/json",
    }
    print(f"[wd-proxy] {request.method} cookies_len={len(cookie_header)}", flush=True)

    qs = urllib.parse.urlencode(dict(request.query_params))
    url = f"{_WD_API}?{qs}" if qs else _WD_API

    if request.method == "POST":
        body = await request.body()
        req_headers["Content-Type"] = request.headers.get("content-type", "application/x-www-form-urlencoded")
        wd_req = urllib.request.Request(url, data=body, headers=req_headers, method="POST")
    else:
        wd_req = urllib.request.Request(url, headers=req_headers)

    import concurrent.futures
    loop = __import__("asyncio").get_event_loop()
    def _fetch():
        with urllib.request.urlopen(wd_req, timeout=15) as r:
            return r.read(), r.status, list(r.headers.items())

    content, status, resp_headers = await loop.run_in_executor(None, _fetch)

    content_type = next((v for k, v in resp_headers if k.lower() == "content-type"), "application/json")
    resp = FastAPIResponse(content=content, status_code=status, media_type=content_type)

    # Forward Set-Cookie headers, stripping wikidata.org domain so cookies apply to current domain
    set_cookies = [(k, v) for k, v in resp_headers if k.lower() == "set-cookie"]
    print(f"[wd-proxy] response status={status} set-cookie-count={len(set_cookies)}", flush=True)
    for k, v in set_cookies:
        cleaned = re.sub(r';\s*[Dd]omain=[^;]+', '', v)
        resp.headers.append("Set-Cookie", cleaned)
    return resp
