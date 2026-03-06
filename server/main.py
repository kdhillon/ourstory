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
from fastapi.middleware.gzip import GZipMiddleware
import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://ourstory:ourstory@localhost:5433/ourstory",
)

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
    allow_methods=["GET", "PATCH", "POST", "DELETE", "OPTIONS"],
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


_POLITY_COLORS = {
    "empire":        "#8B0000",
    "kingdom":       "#1A237E",
    "principality":  "#4E342E",
    "republic":      "#1B5E20",
    "confederation": "#4A148C",
    "sultanate":     "#BF360C",
    "papacy":        "#F9A825",
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


def build_event_features_bulk(cur, year_min: int, year_max: int) -> list[dict]:
    """
    Return all events overlapping [year_min, year_max] as GeoJSON Features.
    Uses the GiST year_range index for O(log n + k) lookup.
    Total: 2 DB queries regardless of window size.
    """
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
        })

    return features


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
def add_hidden_modern_nation(body: dict):
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
def remove_hidden_modern_nation(polity_id: str):
    """Remove a polity from the hidden modern nations list."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM hidden_modern_nations WHERE polity_id = %s", (polity_id,))
        conn.commit()
    finally:
        conn.close()


@app.delete("/api/territory-mappings/by-polity/{polity_id}", status_code=204)
def remove_territory_mappings_for_polity(polity_id: str):
    """Remove all territory_name_mappings rows for a given polity (unlinks its territories)."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM territory_name_mappings WHERE polity_id = %s", (polity_id,))
        conn.commit()
    finally:
        conn.close()


@app.delete("/api/territory-mappings", status_code=204)
def delete_territory_mapping(hb_name: str, snapshot_year: int):
    """Delete a single territory name mapping and clear the polygon's polity_id."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM territory_name_mappings WHERE hb_name = %s AND snapshot_year = %s",
            (hb_name, snapshot_year),
        )
        cur.execute(
            "UPDATE snapshot_polygons SET polity_id = NULL WHERE hb_name = %s AND snapshot_year = %s",
            (hb_name, snapshot_year),
        )
        conn.commit()
    finally:
        conn.close()


@app.post("/api/territory-mappings", status_code=201)
async def save_territory_mapping(request: Request):
    """
    Persist a manual territory name → polity mapping.
    Upserts into territory_name_mappings with confidence='manual'.
    """
    body = await request.json()
    hb_name = body.get("hbName")
    snapshot_year = body.get("snapshotYear")
    polity_id = body.get("polityId")
    wikidata_qid = body.get("wikidataQid")

    if not hb_name or snapshot_year is None or not polity_id:
        raise HTTPException(400, "hbName, snapshotYear, and polityId are required")

    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO territory_name_mappings (hb_name, snapshot_year, polity_id, wikidata_qid, confidence)
            VALUES (%s, %s, %s, %s, 'manual')
            ON CONFLICT (hb_name, snapshot_year) DO UPDATE SET
                polity_id    = EXCLUDED.polity_id,
                wikidata_qid = EXCLUDED.wikidata_qid,
                confidence   = 'manual',
                updated_at   = NOW()
        """, (hb_name, snapshot_year, polity_id, wikidata_qid))
        conn.commit()
        return {"hbName": hb_name, "snapshotYear": snapshot_year, "polityId": polity_id}
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


@app.get("/api/territory-snapshots")
def get_territory_snapshots():
    """Return all loaded snapshot years in ascending order."""
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT snapshot_year FROM territory_snapshots ORDER BY snapshot_year")
        return {"years": [row[0] for row in cur.fetchall()]}
    finally:
        conn.close()


@app.get("/api/territories")
def get_territories(year_min: int, year_max: int):
    """
    Return territory polygons active during [year_min, year_max] as a GeoJSON FeatureCollection.

    A snapshot is valid from its year until the next snapshot year (exclusive), so a request
    for 1898-1899 will return the 1800 snapshot if the next snapshot is 1900.
    """
    conn = get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

        cur.execute("""
            WITH snapshot_intervals AS (
                SELECT
                    snapshot_year,
                    LEAD(snapshot_year) OVER (ORDER BY snapshot_year) AS next_snapshot_year
                FROM territory_snapshots
            )
            SELECT
                sp.id, sp.snapshot_year, sp.hb_name, sp.hb_abbrevn,
                sp.border_precision, sp.boundary, sp.accuracy,
                sp.sub_year_start, sp.sub_year_end, sp.source_polygon_id,
                COALESCE(sp.polity_id, tnm.polity_id) AS polity_id,
                p.slug  AS polity_slug,
                p.name  AS polity_name,
                p.polity_type,
                p.year_start AS polity_year_start,
                p.year_end   AS polity_year_end,
                si.next_snapshot_year
            FROM snapshot_polygons sp
            JOIN snapshot_intervals si ON si.snapshot_year = sp.snapshot_year
            LEFT JOIN territory_name_mappings tnm
                ON tnm.hb_name = sp.hb_name AND tnm.snapshot_year = sp.snapshot_year
            LEFT JOIN polities p
                ON p.id = COALESCE(sp.polity_id, tnm.polity_id)
            WHERE si.snapshot_year <= %(year_max)s
              AND (si.next_snapshot_year IS NULL OR si.next_snapshot_year > %(year_min)s)
            ORDER BY sp.snapshot_year, sp.hb_name
        """, {"year_min": year_min, "year_max": year_max})
        rows = cur.fetchall()

        features = []
        for tr in rows:
            snap_yr       = tr["snapshot_year"]
            next_snap_yr  = tr["next_snapshot_year"]
            poly_yr_start = tr["polity_year_start"]

            # interval_start: defer to polity founding only if it falls within this snapshot's window
            interval_start = snap_yr
            if poly_yr_start is not None:
                upper = next_snap_yr if next_snap_yr is not None else snap_yr + 1000
                if snap_yr < poly_yr_start <= upper:
                    interval_start = poly_yr_start

            # interval_end: just before the next snapshot (or null if newest)
            interval_end = (next_snap_yr - 1) if next_snap_yr is not None else None

            # Sub-interval overrides take precedence (succession chains)
            if tr["sub_year_start"] is not None:
                interval_start = tr["sub_year_start"]
            if tr["sub_year_end"] is not None:
                interval_end = tr["sub_year_end"]

            polity_type = tr["polity_type"]
            color = _POLITY_COLORS.get(polity_type, "#607D8B") if polity_type else "#78909C"

            features.append({
                "type": "Feature",
                "geometry": tr["boundary"],
                "properties": {
                    "featureType":     "territory",
                    "snapshotYear":    snap_yr,
                    "intervalStart":   interval_start,
                    "intervalEnd":     interval_end,
                    "hbName":          tr["hb_name"],
                    "hbAbbrevn":       tr["hb_abbrevn"],
                    "borderPrecision": tr["border_precision"],
                    "polityId":        str(tr["polity_id"]) if tr["polity_id"] else None,
                    "politySlug":      tr["polity_slug"],
                    "polityName":      tr["polity_name"],
                    "polityType":      polity_type,
                    "polityYearStart": poly_yr_start,
                    "polityYearEnd":   tr["polity_year_end"],
                    "accuracy":        tr["accuracy"],
                    "sourcePolygonId": str(tr["source_polygon_id"]) if tr["source_polygon_id"] else None,
                    "_color":          color,
                },
            })

        # All loaded snapshot years — returned to the frontend for prev/next navigation.
        # To add a new snapshot: run scripts/import-territories.py --snapshot <year>
        # then scripts/expand-territory-polities.py --snapshot <year>.
        # This query picks them up automatically; no code change needed.
        cur.execute("SELECT snapshot_year FROM territory_snapshots ORDER BY snapshot_year")
        all_snapshot_years = [row["snapshot_year"] for row in cur.fetchall()]

        return {
            "type": "FeatureCollection",
            "features": features,
            "count": len(features),
            "yearMin": year_min,
            "yearMax": year_max,
            "snapshotYears": all_snapshot_years,
        }
    finally:
        conn.close()
