# Pipeline Timing Reference

Approximate wall-clock times for running the Open History data pipeline.
Based on runs executed 2026-03-04, on Apple Silicon (M-series), with Wikidata SPARQL + Wikipedia REST APIs.
Times vary with network conditions and Wikidata server load.

---

## Events pipeline (`pipeline.run_local`)

Timed for a **20-year window** (~1,100–1,400 unique QIDs typical).

| Step | What it does | Approx time |
|---|---|---|
| Step 1 — SPARQL | 37 category queries to Wikidata Query Service | 2–4 min |
| Step 2 — Entity fetch | Batch `wbgetentities` API (50 QIDs/request) | 1–2 min |
| Step 3 — Extract | Parse Wikidata claims into structured fields | < 1 min |
| Step 4 — Location resolution | Resolve P276/P17 QIDs via SPARQL | 1 min |
| Step 4b — Transitive P31 | BFS over P279 for unknown P31 types | 1–2 min |
| Step 5 — Event summaries | Wikipedia REST API, 8 threads, ~1,200 articles | 3–5 min |
| Step 6 — Location summaries | Wikipedia REST API, 8 threads, ~350 locations | 1–2 min |
| Step 7 — DB load | Upsert to Postgres | < 1 min |
| **Total (events)** | | **~10–16 min** |

### QID counts by window (observed)

| Window | Event QIDs | Events loaded | Notes |
|---|---|---|---|
| 1750–1770 | 877 | 862 | Fewer QIDs — less recorded history pre-1770 |
| 1770–1790 | 1,335 | 1,303 | Heavy astronomical discoveries (Q1318295) |
| 1790–1810 | ~2,125 | ~2,125 | Napoleonic era — high conflict density |
| 1810–1820 | ~1,100 | ~1,100 | Pre-existing in DB |
| 1820–1830 | 1,181 | 1,114 | 66 skipped (need enrichment) |

> **Note on Q1318295 (astronomical discoveries):** Returns 462 QIDs for 1770–1790, 594 for 1790–1810.
> Most are minor asteroid/comet discoveries. They inflate event counts but are valid.

---

## Polities pipeline (`pipeline.run_polities`)

Timed for a **20-year window** (~550–650 polities typical).

| Step | What it does | Approx time |
|---|---|---|
| SPARQL | 8 superclass queries (empire, kingdom, etc.) | 1–2 min |
| Entity fetch | Batch `wbgetentities` API | 1 min |
| Capital resolution | Resolve P36 (capital) QIDs + P625 coords | 1 min |
| Wikipedia summaries | 8 threads, ~550–650 articles | 2–3 min |
| DB load | Upsert to Postgres | < 1 min |
| **Total (polities)** | | **~5–8 min** |

### Polity counts by window (observed)

| Window | Polities upserted | Notes |
|---|---|---|
| 1770–1790 | 592 | 438 with coords, 154 without |
| 1790–1820 | 1,275 | Ran as 80-year window initially; many HRE states |
| 1820–1830 | 630 | Many overlap with 1790–1820 (upserts) |

---

## Post-processing (`pipeline.post_process`)

Runs after each pipeline pass. Covers all data in DB regardless of window.

| Step | What it does | Approx time |
|---|---|---|
| cleanup-non-settlements | Reclassify/remove rivers, palaces, etc. | < 1 min |
| backfill-sitelinks | Wikidata sitelinks count per event | 2–5 min (scales with new events) |
| export_geojson | Build GeoJSON from all 3 tables | < 1 min |
| **Total** | | **~3–7 min** |

---

## Full pipeline run for a new 20-year window

```
run_local (events)    ~10–16 min
run_polities          ~5–8  min
post_process          ~3–7  min
─────────────────────────────────
Total per 20 years    ~18–31 min
```

So a full century (100 years, 5 windows) takes roughly **1.5–2.5 hours** end to end.

---

## Per-year estimate

Each year adds roughly:
- **50–100 events** (depending on era — Napoleonic/WWI/WWII peaks much higher)
- **10–30 polities** (stable across most of history)
- Pipeline time ≈ **~1 min per year of coverage** as a rough rule of thumb

---

## Known slow queries / gotchas

- **Q5389 (Olympic Games)** — SPARQL is very slow (~5 min); returns 0 for pre-1896 windows. Consider skipping or caching.
- **Q1318295 (astronomical discoveries)** — returns 400–600 QIDs per 20-year window in 1750–1850. Normal; many are Messier catalogue entries.
- **Rate limits** — Wikidata returns `429` if two pipeline runs are started within ~2 min of each other. Wait 3+ min between runs.
- **Q2678658 (scientific discoveries)** — returns 0 for pre-1850 windows. Wikidata uses different QIDs for historical science events; Q1318295 covers astronomy specifically.
