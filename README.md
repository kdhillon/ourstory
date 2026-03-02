# OurStory

An open-source interactive historical atlas. A real-world map with a timeline slider that lets you scroll through human history — watching events unfold and civilizations rise and fall.

Built with MapLibre GL JS, React, TypeScript, and Wikipedia as the source of truth.

## Getting Started

### Prerequisites
- Docker + Docker Compose
- Node.js 20+
- Python 3.10+

### 1. Start the database
```bash
cp .env.example .env
docker compose up -d
```

### 2. Apply schema migrations
```bash
psql $DATABASE_URL -f db/migrations/001_initial_schema.sql
psql $DATABASE_URL -f db/migrations/002_add_wikidata_qid_and_slug.sql
psql $DATABASE_URL -f db/migrations/003_data_versioning.sql
psql $DATABASE_URL -f db/migrations/004_locations_refactor.sql
psql $DATABASE_URL -f db/migrations/005_events_p31_qids.sql
psql $DATABASE_URL -f db/migrations/006_locations_p31_qids.sql
```

### 3. Run the pipeline
```bash
# Full run (~1,000+ events, all eras up to 2015)
python3 -m pipeline.run_local --limit 1000

# Targeted slice for testing (e.g. Classical Antiquity)
python3 -m pipeline.run_local --limit 300 --min-year -500 --max-year 500
```

Then run the post-pipeline scripts:
```bash
# Remove non-settlement locations (volcanoes, buildings, straits, etc.)
PYTHONPATH=. python3 scripts/cleanup-non-settlements.py

# Export to GeoJSON for the frontend
cd scripts && npm install && npm run export
```

### 4. Run the frontend
```bash
cd frontend && npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

---

## Data Model

All historical data flows from Wikidata + Wikipedia through the pipeline into two Postgres tables: `events` and `locations`. Both are exported to a single GeoJSON file consumed by the frontend.

### Entity types

Every record — event or location — is an **entity** with a Wikidata QID as its stable identifier. Two entity classes:

| Class | Table | GeoJSON `featureType` |
|---|---|---|
| Historical event | `events` | `'event'` |
| Location | `locations` | `'city'` (only cities are map pins) |

### `events` table

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `slug` | TEXT UNIQUE | Wikipedia title slug (stable public ID) |
| `wikidata_qid` | TEXT UNIQUE | Wikidata Q-identifier |
| `title` | TEXT | Display title (capitalized) |
| `wikipedia_title` | TEXT | Wikipedia article title |
| `wikipedia_summary` | TEXT | Wikipedia intro paragraph |
| `wikipedia_url` | TEXT | Full Wikipedia URL |
| `year_start` | INT | Start year (negative = BCE) |
| `year_end` | INT | End year (null if point-in-time) |
| `date_is_fuzzy` | BOOL | True if date is approximate |
| `date_range_min` | INT | Earliest plausible year (fuzzy dates) |
| `date_range_max` | INT | Latest plausible year (fuzzy dates) |
| `location_level` | TEXT | `'point'`, `'city'`, `'region'`, `'country'`, or NULL |
| `lng` / `lat` | FLOAT | Direct coordinates (point-level events only) |
| `location_wikidata_qid` | TEXT | Soft reference to `locations.wikidata_qid` |
| `location_name` | TEXT | Display name of the location |
| `categories` | TEXT[] | OurStory categories (e.g. `['battle', 'war']`) |
| `p31_qids` | TEXT[] | Wikidata P31 (instance-of) QIDs |
| `data_version` | INT | Pipeline schema version |
| `pipeline_run` | TEXT | Run identifier (e.g. `run-2026-03-02-v2`) |

### `locations` table

Locations are referenced **softly** by `events.location_wikidata_qid` — no FK constraint, so events are never dropped for a missing location.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `slug` | TEXT UNIQUE | Wikipedia title slug |
| `wikidata_qid` | TEXT UNIQUE | Wikidata Q-identifier |
| `name` | TEXT | Display name |
| `wikipedia_title` | TEXT | Wikipedia article title |
| `wikipedia_summary` | TEXT | Wikipedia intro paragraph |
| `wikipedia_url` | TEXT | Full Wikipedia URL |
| `lng` / `lat` | FLOAT | Centroid coordinates |
| `location_type` | TEXT | `'city'`, `'region'`, or `'country'` |
| `founded_year` | INT | Founding year (from Wikidata P571) |
| `founded_is_fuzzy` | BOOL | True if founding date is approximate |
| `dissolved_year` | INT | Dissolution year (from Wikidata P576) |
| `p31_qids` | TEXT[] | Wikidata P31 (instance-of) QIDs |
| `data_version` | INT | Pipeline schema version |
| `pipeline_run` | TEXT | Run identifier |

Only `location_type = 'city'` records are exported as map pins in GeoJSON. Regions and countries are reference data used to pin events.

### Location resolution (events → map coordinates)

Events are pinned to the map in this priority order:

1. **Point** — event has its own P625 coordinates → `location_level = 'point'`, `location_wikidata_qid = NULL`
2. **P276 city/region/country** — event's P276 (location) QID resolves to a location record → `location_level` set by classifier
3. **P17 country fallback** — event's P17 (country) QID → `location_level = 'country'`
4. **Unlocated** — no location data → `location_level = NULL`, stored but not shown on map

### Location type classifier (`pipeline/extract.py`)

The `classify_location(p31_qids)` function categorises a Wikidata entity by its P31 (instance-of) values:

| Result | Meaning | Examples |
|---|---|---|
| `'city'` | Human settlement | city, town, village, polis, ancient city, port city |
| `'region'` | Sub-national area | US state, oblast, province, island group, autonomous community |
| `'country'` | Sovereign/empire entity | country, sovereign state, historical kingdom |
| `None` (exclude) | Not a location entity | river, palace, church, volcano, street, prison, museum |

Unknown P31 types default to `'city'` (safe fallback for genuine but unrecognised settlement types).

### GeoJSON output (`frontend/src/data/seed.geojson`)

All features carry a `wikidataClasses` array of P31 QIDs, visible in the Data Explorer with links to wikidata.org. The `pipelineRun` and `dataVersion` fields identify the ingestion batch.

---

## Post-pipeline workflow

After each pipeline run:
1. `PYTHONPATH=. python3 scripts/cleanup-non-settlements.py` — reclassifies/deletes bad locations
2. `cd scripts && npm run export` — regenerates GeoJSON
3. Optional: `ANTHROPIC_API_KEY=... python3 scripts/fix-empty-categories.py` — LLM category assignment for uncategorised events
4. Optional: `ANTHROPIC_API_KEY=... python3 scripts/quality-check.py --no-fail` — LLM quality audit

## Project Spec
See [ourstory-spec.md](./ourstory-spec.md) for the full project design.
