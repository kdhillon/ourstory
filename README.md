# OpenHistory

An open-source interactive historical atlas. Scroll through history and learn the story of humankind.

**Live at [openhistory.app](https://openhistory.app)**

Built with MapLibre GL JS, React, TypeScript, and Wikipedia/Wikidata as the source of truth for all historical data. Territory polygons from [historical-basemaps](https://github.com/aourednik/historical-basemaps).

---

## Status: In Progress

This project is under active development. The core map, data pipeline, and deployment are working; the focus now is expanding data coverage and adding territory editing.

### Done
- **Map** — MapLibre GL JS with OpenFreeMap basemap (light Wikipedia-style theme)
- **Timeline** — scrubber, play/pause, step controls, adjustable speed, keyboard shortcuts (←/→/Space)
- **Events** — Lucide SVG icon markers per category (battle, war, politics, religion, disaster, exploration, science, culture)
- **Locations** — cities, regions, and countries shown at appropriate zoom levels
- **Polities** — time-bounded sovereign entities (empires, kingdoms, republics, colonies, viceroyalties, etc.) shown as markers at their capitals
- **Territory polygons** — shaded boundary overlays from the historical-basemaps dataset, linked to polities; stored as rolling date ranges (year_start/year_end) rather than discrete snapshots
- **Territory mapping UI** — users can link unmatched (grey) territories to polities by clicking and searching
- **Category filter** — two-row bar for toggling event/location/polity types
- **Info panel** — Wikipedia summary, categories, date range, and location for any clicked feature
- **In-app Wikidata editing** — dates and locations can be corrected in-app and submitted **directly to Wikidata** (requires a Wikimedia account)
- **Data pipeline** — Wikidata SPARQL + Wikipedia API → PostgreSQL (37+ active event categories using transitive P279*)
- **Polity pipeline** — separate pipeline for sovereign political entities (14 SPARQL categories including colonies, viceroyalties, khanates, regencies)
- **Post-processing** — cleanup, rule-based P31 category assignment, sitelinks backfill, GeoJSON export
- **Event fade-out** — single-year events fade out over a 10-year window rather than snapping off
- **Zoom filtering** — events filtered by importance (`sitelinks_count`) at low zoom levels
- **Major events panel** — bottom bar showing significant events in the current time window
- **Deployment** — frontend + backend on [Railway](https://railway.app), auto-migrations on deploy
- **Data loaded** — 22,058 events · 6,416 locations · 9,854 polities (incl. ancient empires) · coverage: 601 BCE–2025

### To Do
- **Data coverage** — expand beyond current 601 BCE–2025 coverage; fill gaps in ancient and medieval periods
- **Territory boundary editing** — draw/correct polygon shapes and contribute back to the historical-basemaps project as new snapshots
- **Location dates** — `founded_year` / `dissolved_year` mostly NULL; needs Wikidata backfill
- **Polity succession** — `preceded_by` / `succeeded_by` chain is stored but not surfaced in the UI
- **Related events** — semantically related events panel in the info card
- **Natural language search** — search by concept, not just by name
- **Mobile layout** — not yet optimized for small screens

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React 18, TypeScript, Vite |
| Map | MapLibre GL JS, OpenFreeMap tiles |
| Backend | FastAPI (Python), PostgreSQL 16 |
| Data | Wikidata SPARQL, Wikipedia REST API, historical-basemaps GeoJSON |
| Infrastructure | Railway (DB + production hosting) |

---

## Getting Started

### Prerequisites
- Docker
- Node.js 20+
- Python 3.10+

### 1. Set up the database connection

This project uses a hosted PostgreSQL database on [Railway](https://railway.app). There is no local database.

```bash
cp .env.example .env
# Fill in DATABASE_URL with your Railway Postgres URL
# Add ANTHROPIC_API_KEY if you want to use LLM category assignment
source .env
```

### 2. Apply schema migrations

```bash
source .env
for f in db/migrations/*.sql; do
  echo "Applying $f..."
  psql "$DATABASE_URL" -f "$f"
done
```

Migrations are in `db/migrations/` and numbered sequentially. Apply them in order; they are idempotent.

### 4. Run the pipeline

```bash
# Events — fetch from Wikidata + Wikipedia for a date range
python3 -m pipeline.run_local --min-year 1770 --max-year 1820

# Polities — fetch sovereign political entities
python3 -m pipeline.run_polities --min-year 1770 --max-year 1820
```

Then run post-processing:

```bash
# Runs cleanup, sitelinks backfill, and GeoJSON export in one step
python3 -m pipeline.post_process

# Or individually:
python3 scripts/cleanup-non-settlements.py
python3 scripts/backfill-sitelinks.py
python3 scripts/export_geojson.py
```

### 5. Import territory polygons (optional)

Territory boundary data comes from [historical-basemaps](https://github.com/aourednik/historical-basemaps). The rolling territory migration script merges all snapshots into continuous date ranges:

```bash
python3 scripts/migrate-to-rolling-territories.py
```

### 6. Run the frontend

```bash
cd frontend && npm install && npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### 7. Run the API server (needed for in-app edits)

```bash
uvicorn server.main:app --reload --port 8000
```

The frontend proxies `/api` to `localhost:8000` in dev via Vite config.

---

## Data Model

All historical data flows from Wikidata + Wikipedia through the pipeline into Postgres, then exported to GeoJSON files consumed by the frontend.

### Entity types

| Class | Table | GeoJSON `featureType` | Description |
|---|---|---|---|
| Historical event | `events` | `'event'` | Battles, treaties, disasters, etc. |
| Location | `locations` | `'city'` / `'region'` / `'country'` | Geographic anchors used to pin events |
| Polity | `polities` | `'polity'` | Time-bounded sovereign entities (empires, kingdoms, colonies, etc.) |
| Territory polygon | `territories` | — (served via `/api/territories`) | Boundary polygons from historical-basemaps, linked to polities |

### `events` table

| Column | Type | Description |
|---|---|---|
| `wikidata_qid` | TEXT UNIQUE | Wikidata Q-identifier |
| `title` | TEXT | Display title |
| `year_start` / `year_end` | INT | Year range (negative = BCE) |
| `date_is_fuzzy` | BOOL | Approximate date |
| `location_level` | TEXT | `'point'`, `'city'`, `'region'`, `'country'`, or NULL |
| `lng` / `lat` | FLOAT | Direct coords (point-level events only) |
| `location_wikidata_qid` | TEXT | Soft ref to `locations.wikidata_qid` |
| `categories` | TEXT[] | e.g. `['battle', 'war']` |
| `part_of_qids` | TEXT[] | Wikidata P361 (part-of) parent event QIDs |
| `sitelinks_count` | INT | Wikipedia language editions (importance signal for zoom filtering) |

### `polities` table

Time-bounded sovereign political entities — historically specific ("French First Republic 1792–1804", not just "France").

| Column | Type | Description |
|---|---|---|
| `wikidata_qid` | TEXT UNIQUE | Wikidata Q-identifier |
| `polity_type` | TEXT | `empire`, `kingdom`, `principality`, `republic`, `confederation`, `sultanate`, `papacy`, `other` |
| `year_start` / `year_end` | INT | Active period |
| `capital_name` | TEXT | Capital city name |
| `lng` / `lat` | FLOAT | Representative point (capital coordinates) |
| `preceded_by_qid` / `succeeded_by_qid` | TEXT | Succession chain |
| `sovereign_qids` | TEXT[] | Parent polity QIDs |

### Territory table

Territory polygons are stored in a single `territories` table as rolling date ranges:

- **`territories`** — one row per unique polygon geometry, with explicit `year_start`/`year_end` columns, a `polity_id` FK (nullable for unmatched territories), and `explicitly_unlinked` flag. Adjacent snapshots with identical geometry are merged into a single row rather than stored separately.

Territory data comes from [aourednik/historical-basemaps](https://github.com/aourednik/historical-basemaps) (GPL-3.0), which provides 53 hand-curated snapshots spanning 100,000 BCE → 2010 CE.

### Location resolution (events → map coordinates)

1. **Point** — event has its own P625 coordinates → `location_level = 'point'`
2. **P276** — event's P276 (location) QID resolves to a location record
3. **P17 fallback** — event's P17 (country) QID → `location_level = 'country'`
4. **Unlocated** — no location data → stored but not shown on map

---

## Future: Semantic Search via Vector Embeddings

> Out of scope for now. Captured here for reference.

In October 2025, **Wikimedia Deutschland + Jina AI** launched the [Wikidata Embedding Project](https://www.wikidata.org/wiki/Wikidata:Embedding_Project) — all ~119M Wikidata entities converted to dense vector embeddings via a free public API. This enables:

1. **"Related Events" in the InfoPanel** — semantically nearest events to whatever the user clicked
2. **Natural language search** — *"revolts against colonial powers"*, *"plagues in the Mediterranean"*
3. **Spatio-temporal + semantic queries** — combine vector distance with viewport/time filters
4. **Auto category outlier detection** — flag miscategorised events by comparing to category centroids

Implementation would use `pgvector` (Postgres extension) with no new infrastructure required.
