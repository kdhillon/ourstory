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
- Data loaded: **1790–1810 only** (2,125 events, 742 locations). Other periods need pipeline runs.
- Deployed on Railway: frontend at `openhistory.app`, backend at `api.openhistory.app`
- GeoJSON lives at `frontend/src/data/seed.geojson` — regenerate after pipeline runs

## Territory Linking System

See [`docs/territory-linking.md`](docs/territory-linking.md) for the full explanation of how territory linking, unlinking, and the optimistic UI work.

## Important conventions
- `npm run build` uses `vite build` only — MapLibre v5 has overly strict TS generics
- DB port is **5433** locally (not 5432)
- Event icons use Lucide SVGs bundled via `lucide-static` + `?raw` imports — defined in `frontend/src/theme/icons.ts`
- After any pipeline run: always run `post_process`, then check category coverage with `fix-empty-categories.py`
