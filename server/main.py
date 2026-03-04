"""
OurStory API server.

Run with:
    uvicorn server.main:app --reload --port 8000

Endpoints:
    PATCH /api/features/{event_id}      — save a user correction to Postgres
    GET   /api/features/overrides       — all manually-edited events as GeoJSON features
    PATCH /api/polities/{polity_id}     — save a user correction to a polity record
"""

import os
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://ourstory:ourstory@localhost:5433/ourstory",
)

app = FastAPI(title="OurStory API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",   # Vite dev server
        "http://localhost:4173",   # Vite preview
        "http://localhost:3000",
        "https://openhistory.app",
        "https://www.openhistory.app",
    ],
    allow_methods=["GET", "PATCH", "OPTIONS"],
    allow_headers=["Content-Type"],
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


def build_event_feature(cur, event_id: str) -> dict | None:
    """Re-fetch a single event from DB and format it as a GeoJSON Feature."""
    cur.execute("""
        SELECT
          e.id, e.slug, e.title, e.wikipedia_title, e.wikipedia_summary, e.wikipedia_url,
          e.year_start, e.month_start, e.day_start,
          e.year_end, e.month_end, e.day_end,
          e.date_is_fuzzy, e.date_range_min, e.date_range_max,
          e.location_level,
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


# ── Routes ──────────────────────────────────────────────────────────────────────

# Fields the PATCH endpoint is allowed to update, mapped to their DB column names.
_ALLOWED_FIELDS = {
    "year_start", "month_start", "day_start",
    "year_end", "month_end", "day_end",
    "location_name", "location_wikidata_qid", "location_level",
}


@app.patch("/api/features/{event_id}")
async def patch_feature(event_id: str, request: Request):
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

        # If a location QID is provided but no level, resolve from our locations table
        if "location_wikidata_qid" in updates and "location_level" not in updates:
            qid = updates["location_wikidata_qid"]
            if qid:
                cur.execute("SELECT location_type FROM locations WHERE wikidata_qid = %s", (qid,))
                loc_row = cur.fetchone()
                updates["location_level"] = loc_row["location_type"] if loc_row else "city"
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
}


@app.patch("/api/polities/{polity_id}")
async def patch_polity(polity_id: str, request: Request):
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
