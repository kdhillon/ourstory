# OpenHistory — Claude Code Context

Interactive historical atlas. Wikipedia/Wikidata data → PostgreSQL → GeoJSON → MapLibre GL JS + React.

## Stack
- **Frontend**: React 18 + TypeScript + Vite, in `frontend/`
- **Backend**: FastAPI (Python), in `server/`
- **DB**: PostgreSQL 16 on port **5433** locally (Docker), Railway in prod
- **Map**: MapLibre GL JS, OpenFreeMap liberty tiles

## Key commands
```bash
# DB
docker start openhistory-postgres

# Frontend
cd frontend && npm run dev        # dev server on :5173
npm run build                     # vite only (no tsc — MapLibre v5 types too strict)
npm run typecheck                 # tsc if needed separately

# Backend
uvicorn server.main:app --reload --port 8000

# Pipeline (from project root)
python3 -m pipeline.run_local --min-year 1770 --max-year 1820
python3 -m pipeline.run_polities --min-year 1770 --max-year 1820
python3 -m pipeline.post_process   # cleanup + sitelinks + GeoJSON export

# Export GeoJSON
python3 scripts/export_geojson.py
```

## Current state
- **Events**: ~16,600 (1600–2025), with heaviest coverage 1770–1820 and 1970–1999
- **Locations**: ~4,034 | **Polities**: ~7,096 | **Territory polygons**: ~10,223 across 53 snapshots
- Deployed on Railway: frontend at `openhistory.app`, backend at `api.openhistory.app`
- `seed.geojson` lives at `frontend/public/data/seed.geojson` — fetched at runtime (not bundled); regenerate after pipeline runs

## Licenses (important)
- **Code**: MIT
- **Event/location/polity data**: CC BY-SA (Wikidata/Wikipedia)
- **Territory polygons**: GPL-3.0 (historical-basemaps by A. Ourednik) — any redistribution of modified territory data must also be GPL-3.0

## Wikidata edit architecture
Edits made via the in-app edit UI (dates, locations, descriptions) are submitted **directly to Wikidata** via the Wikidata OAuth API — they do not go into our DB. The DB is populated by re-running the pipeline after Wikidata updates propagate. Territory mappings (grey → yellow) are the exception: those save to our DB only.

## Snapshot list in About page
`frontend/src/components/AboutPage.tsx` has a **hardcoded** `SNAPSHOT_YEARS` array. This is not queried from the DB — it must be updated manually whenever territory snapshots are added or removed. Currently 46 items in code vs 53 in the DB (out of sync as of 2026-03-05).

## Territory Linking System

See [`docs/territory-linking.md`](docs/territory-linking.md) for the full explanation of how territory linking, unlinking, and the optimistic UI work.

## Important conventions
- `npm run build` uses `vite build` only — MapLibre v5 has overly strict TS generics
- DB port is **5433** locally (not 5432)
- Event icons use Lucide SVGs bundled via `lucide-static` + `?raw` imports — defined in `frontend/src/theme/icons.ts`
- After any pipeline run: always run `post_process`, then check category coverage with `fix-empty-categories.py`
