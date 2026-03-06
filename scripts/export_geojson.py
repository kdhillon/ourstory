#!/usr/bin/env python3
"""
scripts/export_geojson.py

Queries the local Postgres database and writes a GeoJSON FeatureCollection
to ../frontend/src/data/seed.geojson, ready for the frontend to consume.

Usage:
    python3 scripts/export_geojson.py          # from project root
    python3 -m scripts.export_geojson          # also from project root
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://ourstory:ourstory@localhost:5433/ourstory",
)

OUT_PATH       = Path(__file__).parent.parent / "frontend" / "public" / "data" / "seed.geojson"
TERR_OUT_PATH  = Path(__file__).parent.parent / "frontend" / "public" / "data" / "territories.geojson"

# Polity type → fill color (must match frontend theme/categories.ts CATEGORY_COLORS)
_POLITY_COLORS = {
    "empire":        "#8B0000",
    "kingdom":       "#1A237E",
    "principality":  "#4E342E",
    "republic":      "#1B5E20",
    "confederation": "#4A148C",
    "sultanate":     "#BF360C",
    "papacy":        "#F9A825",
    "colony":        "#5D4037",
    "other":         "#607D8B",
}


def display_year(year: int) -> str:
    if year == 0:
        return "Year 0"
    if year < 0:
        return f"{abs(year)} BCE"
    return f"{year} CE"


def export(conn: "psycopg2.connection | None" = None) -> int:
    """
    Export GeoJSON from Postgres. Accepts an existing connection or opens one.
    Returns the number of features written.
    """
    close_conn = conn is None
    if conn is None:
        conn = psycopg2.connect(DATABASE_URL)

    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # Events are served by the /api/events endpoint — not included in seed.geojson.

    # Locations
    cur.execute("""
        SELECT
          id, wikidata_qid, slug, name, wikipedia_title, wikipedia_summary, wikipedia_url,
          lng, lat, founded_year, founded_is_fuzzy,
          founded_range_min, founded_range_max, dissolved_year,
          location_type, p31_qids, data_version, pipeline_run
        FROM locations
        ORDER BY founded_year NULLS LAST
    """)
    locations = cur.fetchall()

    # Polities
    cur.execute("""
        SELECT
          id, wikidata_qid, slug, name, wikipedia_title, wikipedia_summary, wikipedia_url,
          year_start, year_end, date_is_fuzzy,
          polity_type, capital_name, capital_wikidata_qid,
          lng, lat, preceded_by_qid, succeeded_by_qid,
          sovereign_qids, p31_qids, data_version, pipeline_run,
          sitelinks_count
        FROM polities
        WHERE lng IS NOT NULL AND lat IS NOT NULL
           OR id IN (SELECT DISTINCT polity_id FROM snapshot_polygons WHERE polity_id IS NOT NULL)
           OR polity_type = 'people'
        ORDER BY year_start NULLS LAST
    """)
    polities = cur.fetchall()

    # QID lookup for resolving sovereign_qids → polity name/slug
    cur.execute("SELECT wikidata_qid, name, slug FROM polities WHERE wikidata_qid IS NOT NULL")
    polity_qid_map = {
        row["wikidata_qid"]: {"name": row["name"], "slug": row["slug"]}
        for row in cur.fetchall()
    }

    features = []

    for row in locations:
        if row["lng"] is None or row["lat"] is None:
            continue

        loc_type = row["location_type"]
        props = {
            "featureType": loc_type,
            "id": str(row["id"]),
            "wikidataQid": row["wikidata_qid"],
            "slug": row["slug"] or row["wikipedia_title"].replace(" ", "_"),
            "title": row["name"],
            "wikipediaTitle": row["wikipedia_title"],
            "wikipediaSummary": row["wikipedia_summary"] or "",
            "wikipediaUrl": row["wikipedia_url"],
            "yearStart": row["founded_year"],
            "yearEnd": row["dissolved_year"],
            "dateIsFuzzy": row["founded_is_fuzzy"],
            "dateRangeMin": row["founded_range_min"],
            "dateRangeMax": row["founded_range_max"],
            "locationName": row["name"],
            "locationSlug": None,
            "categories": [loc_type],
            "primaryCategory": loc_type,
            "yearDisplay": display_year(row["founded_year"]) if row["founded_year"] is not None else "Unknown",
            "wikidataClasses": row["p31_qids"] or [],
            "dataVersion": row["data_version"],
            "pipelineRun": row["pipeline_run"],
        }
        if loc_type == "city":
            props["cityImportance"] = "major" if row["wikipedia_summary"] else "minor"

        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [float(row["lng"]), float(row["lat"])]},
            "properties": props,
        })

    for row in polities:
        # Resolve sovereign QIDs → first polity in our DB that is meaningfully different
        sovereign_resolved = None
        own_name_lower = (row["name"] or "").lower()
        for qid in (row["sovereign_qids"] or []):
            if qid not in polity_qid_map:
                continue
            if qid == row.get("wikidata_qid"):
                continue  # skip self-reference by QID
            sov_name = polity_qid_map[qid]["name"] or ""
            sov_lower = sov_name.lower()
            # Skip if names are basically the same (e.g. "Denmark" / "Kingdom of Denmark")
            if sov_lower == own_name_lower or own_name_lower in sov_lower or sov_lower in own_name_lower:
                continue
            sovereign_resolved = {"qid": qid, "name": sov_name, "slug": polity_qid_map[qid]["slug"]}
            break

        geom = (
            {"type": "Point", "coordinates": [float(row["lng"]), float(row["lat"])]}
            if row["lng"] is not None and row["lat"] is not None
            else None
        )
        features.append({
            "type": "Feature",
            "geometry": geom,
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
                "monthStart": None,
                "dayStart": None,
                "monthEnd": None,
                "dayEnd": None,
                "dateIsFuzzy": row["date_is_fuzzy"],
                "dateRangeMin": None,
                "dateRangeMax": None,
                "polityType": row["polity_type"],
                "capitalName": row["capital_name"],
                "capitalWikidataQid": row["capital_wikidata_qid"],
                "precededByQid": row["preceded_by_qid"],
                "succeededByQid": row["succeeded_by_qid"],
                "sovereignName": sovereign_resolved["name"] if sovereign_resolved else None,
                "sovereignSlug": sovereign_resolved["slug"] if sovereign_resolved else None,
                "sovereignQid":  sovereign_resolved["qid"] if sovereign_resolved else None,
                "locationName": "",
                "locationSlug": None,
                "categories": [row["polity_type"]],
                "primaryCategory": row["polity_type"],
                "wikidataClasses": row["p31_qids"] or [],
                "hasTerritory": False,  # true once polity_territories has data
                "sitelinksCount": row["sitelinks_count"],
                "yearDisplay": display_year(row["year_start"]) if row["year_start"] is not None else "Unknown",
                "dataVersion": row["data_version"],
                "pipelineRun": row["pipeline_run"],
            },
        })

    print(f"  {len(features)} features ({len(locations)} locations, {len(polities)} polities)", file=sys.stderr)

    geojson = {
        "type": "FeatureCollection",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "features": features,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(geojson, indent=2))

    # ── Territory polygons ───────────────────────────────────────────────────
    # Export snapshot_polygons as a separate territories.geojson.
    # Each feature has intervalStart/intervalEnd for time-based filtering in MapView.
    # Polygons linked to our polities use polityType for color + category filtering.
    # Unlinked polygons (indigenous territories etc.) still render but without polity info.

    # Compute ordered snapshot years so we can derive interval_end per polygon
    cur.execute("SELECT snapshot_year FROM territory_snapshots ORDER BY snapshot_year")
    snapshot_years = [r["snapshot_year"] for r in cur.fetchall()]
    next_year: dict[int, int | None] = {}
    for i, yr in enumerate(snapshot_years):
        next_year[yr] = snapshot_years[i + 1] if i + 1 < len(snapshot_years) else None

    # Build polity_id → polity metadata lookup from already-fetched polities
    polity_id_map = {
        str(row["id"]): row for row in polities
    }

    cur.execute("""
        SELECT
          sp.id, sp.snapshot_year, sp.hb_name, sp.hb_abbrevn,
          sp.border_precision, sp.boundary, sp.accuracy,
          sp.sub_year_start, sp.sub_year_end, sp.source_polygon_id,
          COALESCE(sp.polity_id, tnm.polity_id) AS polity_id,
          p.slug AS polity_slug, p.name AS polity_name,
          p.polity_type, p.year_start AS polity_year_start, p.year_end AS polity_year_end
        FROM snapshot_polygons sp
        LEFT JOIN territory_name_mappings tnm
          ON tnm.hb_name = sp.hb_name AND tnm.snapshot_year = sp.snapshot_year
        LEFT JOIN polities p
          ON p.id = COALESCE(sp.polity_id, tnm.polity_id)
        ORDER BY sp.snapshot_year, sp.hb_name
    """)
    territory_rows = cur.fetchall()

    territory_features = []
    for tr in territory_rows:
        snap_yr = tr["snapshot_year"]
        poly_yr_start = tr["polity_year_start"]
        poly_yr_end   = tr["polity_year_end"]

        # interval_start: only defer to polity's founding year if it falls WITHIN
        # this snapshot's interval (i.e. between snap_yr and next snapshot).
        # If poly_yr_start is before snap_yr (normal) or way after (wrong-era match),
        # just use snap_yr so the territory still renders correctly at this snapshot.
        nxt_for_start = next_year.get(snap_yr)
        interval_start = snap_yr
        if poly_yr_start is not None:
            upper = nxt_for_start if nxt_for_start is not None else snap_yr + 1000
            if snap_yr < poly_yr_start <= upper:
                interval_start = poly_yr_start

        # interval_end: just before the next snapshot year (or null if newest snapshot).
        nxt = next_year.get(snap_yr)
        interval_end = (nxt - 1) if nxt is not None else None

        # Sub-interval overrides: when set, these take precedence over derived interval.
        # Used by expand-territory-polities.py to split a snapshot interval across
        # multiple successor polities (e.g. First Republic 1800-1804, First Empire 1804-1814).
        if tr["sub_year_start"] is not None:
            interval_start = tr["sub_year_start"]
        if tr["sub_year_end"] is not None:
            interval_end = tr["sub_year_end"]

        polity_type = tr["polity_type"]
        color = _POLITY_COLORS.get(polity_type, "#607D8B") if polity_type else "#78909C"

        territory_features.append({
            "type": "Feature",
            "geometry": tr["boundary"],   # already a dict (psycopg2 JSONB → dict)
            "properties": {
                "featureType": "territory",
                "snapshotYear": snap_yr,
                "intervalStart": interval_start,
                "intervalEnd": interval_end,
                "hbName": tr["hb_name"],
                "hbAbbrevn": tr["hb_abbrevn"],
                "borderPrecision": tr["border_precision"],
                "polityId": str(tr["polity_id"]) if tr["polity_id"] else None,
                "politySlug": tr["polity_slug"],
                "polityName": tr["polity_name"],
                "polityType": polity_type,
                "polityYearStart": poly_yr_start,
                "polityYearEnd": poly_yr_end,
                "accuracy": tr["accuracy"],
                "sourcePolygonId": str(tr["source_polygon_id"]) if tr["source_polygon_id"] else None,
                "_color": color,
            },
        })

    territories_geojson = {
        "type": "FeatureCollection",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "features": territory_features,
    }
    TERR_OUT_PATH.write_text(json.dumps(territories_geojson))
    print(f"  {len(territory_features)} territory polygons → {TERR_OUT_PATH.name}", file=sys.stderr)

    if close_conn:
        cur.close()
        conn.close()

    return len(features)


def main():
    print("Connected to database")
    n = export()
    print(f"Wrote {n} features to {OUT_PATH}")


if __name__ == "__main__":
    main()
