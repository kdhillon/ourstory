# Data Sources

Reference for all external data sources used in or considered for OpenHistory.

---

## 1. Wikidata / Wikipedia

**Role**: Primary source for events, locations, and polities.
**License**: CC BY-SA (Wikidata), CC BY-SA (Wikipedia)
**Access**: SPARQL endpoint (WDQS), MediaWiki API, Wikidata REST API

Events, locations, and polities are imported via SPARQL queries in the pipeline (`pipeline/run_local.py`, `pipeline/run_polities.py`). Wikipedia summaries are fetched per-entity via the MediaWiki API. Wikidata QIDs are the primary cross-reference key across the entire system.

---

## 2. historical-basemaps (Ourednik)

**Role**: Current source for territory polygon data.
**License**: **GPL-3.0** — any redistribution of modified territory data must also be GPL-3.0.
**Source**: https://github.com/aourednik/historical-basemaps
**Format**: GeoJSON MultiPolygon, WGS84
**Coverage**: ~1 BC to 2000 AD in ~50-year snapshots (53 snapshots in our DB)

Polygon data lives in the `territories` table (10,231 polygons, merged from snapshot data into rolling year ranges). Territory features have `hb_name` identifiers that are matched to our polity QIDs via the territory mapping system.

**Limitations**:
- Coarse 50-year snapshot resolution — no sub-decade boundary changes
- Simplified polygon geometry
- Coverage ends at 2000 AD
- GPL-3.0 license constrains redistribution

---

## 3. Open Historical Map (OHM)

**Role**: Candidate supplementary/replacement source for territory polygons, especially 1800–1945.
**License**: **CC0 (public domain)** — no attribution required, no redistribution constraints.
**Website**: https://www.openhistoricalmap.org/
**Wiki**: https://wiki.openhistoricalmap.org/
**Organization**: Charter project of OpenStreetMap U.S. (501(c)(3)); technical support from GreenInfo Network and Development Seed.

### Scale (as of March 2026)
- 167.3 million nodes
- 5.2 million ways
- 221,633 relations; ~69,500 are `boundary=administrative`
- 9,802 `type=chronology` meta-relations
- 23,295 contributors; 224,906 changesets
- Average mapped year: 1938 (coverage skews toward 19th–20th century)

### Data Model

OHM uses standard OSM element types (nodes, ways, relations) with temporal extensions:

**Temporal tags:**
| Tag | Format | Notes |
|-----|--------|-------|
| `start_date` | `YYYY`, `YYYY-MM`, `YYYY-MM-DD` | Required for dated features |
| `end_date` | same | Absence = still existing |
| `start_date:edtf` | EDTF format, e.g. `[1877..1887]` | For uncertain/range dates |
| `end_date:edtf` | same | |
| `start_event` | text | Human-readable trigger description |
| `start_event:wikidata` | QID | Wikidata QID of triggering event |
| `as_of` | date | For features with unknown exact dates |

**Boundary/relation tags:**
| Tag | Values | Notes |
|-----|--------|-------|
| `type` | `boundary`, `chronology` | `chronology` = meta-relation grouping successive versions |
| `boundary` | `administrative` | |
| `admin_level` | `2`–`9+` | See hierarchy below |
| `wikidata` | `Q...` | Present on most political boundaries |
| `wikipedia` | `en:...` | |
| `place` | `country`, `state`, `region`, `occupation_zone`, etc. | |
| `source` | varies | Required for non-original data |

**Admin level hierarchy (European convention):**
- `2` = sovereign state
- `3` = sub-sovereign / occupied zone / confederation member
- `4` = province, Gau, Reichsgau, first-level subdivision
- `5` = Regierungsbezirk, second-level subdivision
- `6` = Kreis / county
- `7`–`9` = municipalities, districts, etc.

**`type=chronology` relations**: Group all successive boundary relations for the same geographic/political entity across different time periods. 9,802 exist in the DB. Conceptually equivalent to our `territories` table's rolling year-range approach.

### Data Access

1. **Overpass API** (primary): `https://overpass-api.openhistoricalmap.org/api/interpreter`
   - Live, updated daily, no rate limit currently
   - Supports full Overpass QL
   - Practical for targeted queries (region + time window); not suited for full-DB dumps
   - Example — all admin-level-2 boundaries with 1800s start dates:
     ```
     [out:json][timeout:60];
     relation["boundary"="administrative"]["admin_level"="2"]
       ["start_date"~"^18"](bbox:-90,-180,90,180);
     out geom;
     ```

2. **Planet PBF dump**: `s3://planet.openhistoricalmap.org/`
   - **Last updated: March 2022** — no longer being generated
   - ~770 MB OSM PBF format
   - Not useful for current data

3. **Tile service**: Tegola-based vector tiles via `https://openhistoricalmap.github.io/`

4. **iD editor / JOSM**: In-browser and desktop editing

5. **Raw API**: `/api/0.6/map?bbox=...` — small areas only (<0.25 sq degrees)

### Coverage Comparison vs. historical-basemaps

| Dimension | OHM | historical-basemaps |
|-----------|-----|---------------------|
| License | **CC0** | GPL-3.0 |
| Time resolution | **Day-level** | ~50-year snapshots |
| Polygon quality | **Very high** vertex counts | Coarser/simplified |
| Admin hierarchy | **Full hierarchy L2–L9** | Top-level polities only |
| Wikidata QID tags | **Yes (most boundaries)** | No |
| Coverage | Uneven (community-driven) | Uniform global |
| Best period | 19th–20th century Europe | Global ancient–2000 AD |
| Bulk download | Overpass only (PBF stale) | GeoJSON on GitHub |
| Last updated | Live | ~2017 |

### WWII German Administrative Entities

OHM has exceptional coverage of Nazi Germany's multi-level administrative hierarchy in occupied territories, with full polygon geometry and day-level date precision. All entities have `wikidata` tags.

**Hierarchy in occupied Eastern Europe:**
```
Deutsches Reich (admin_level=2) — tracked through 22 separate relations, 1871–1945
└── Reichskommissariate (admin_level=3) — civilian occupation zones
    ├── Reichskommissariat Ostland (Q156031) — Baltic states + Belarus, 1941–1945
    └── Reichskommissariat Ukraine (Q46315) — 1941-09-01 to 1944-11-09
        └── Generalbezirke (admin_level=4) — "General Districts"
            ├── Generalkommissariat Weißruthenien (White Ruthenia) — Belarus portion, 1942–1944
            ├── Generalbezirk Wolhynien-Podolien — western Ukraine
            ├── Generalbezirk Shitomir, Kiew, Nikolajew, Dnepropetrowsk, Krim...
            └── Generalbezirk Litauen, Lettland, Estland (Baltic states)
                └── Regierungsbezirke (admin_level=5)
                    └── Kreise (admin_level=6)
```

Also present: Generalgouvernement (occupied Poland, two phases), Protektorat Böhmen und Mähren, 10+ Reichsgaue, Gau Westmark, Gau Baden-Elsaß.

**What "Generalbezirk" means for us**: These are sub-polity administrative districts — real governing entities with defined territories, not just geographic labels. They sit between Reichskommissariat (the top-level occupied zone polity) and Regierungsbezirk. For OpenHistory, these could be rendered as a new `polity_type='admin_district'` at higher zoom levels, or as territory polygons linked to a polity via a parent relationship.

**Data quality note**: Most WWII-era OHM features have `fixme:s: needs source for boundary lines` — geometries exist and are usable but may be approximate along some edges.

### Year Range Analysis (from Overpass API, March 2026)

Active admin_level=2 boundary counts by year (computed client-side from 3,543 total relations):

| Year | Active | Notes |
|------|--------|-------|
| 1600 | 113 | Major powers only |
| 1700 | 175 | Moderate |
| 1800 | 162 | Napoleonic gap — Habsburg has no geometry 1803–1816 |
| **1815** | **225** | Congress of Vienna — density spike, every German statelet present |
| 1830–1860 | 210–226 | Excellent |
| 1870 | 176 | German/Italian unification collapses many entities |
| 1880–1914 | 173–196 | Good |
| **1920** | **238** | Peak — post-WWI new states, Versailles, mandates |
| 1938–1944 | 196–216 | Excellent (+ sub-polity admin districts) |
| 1950–2025 | 195–218 | Good |

**Recommended cutoff: 1815 onward.** This is where OHM becomes reliably complete. Pre-1815 has specific gaps (Napoleonic era, Habsburg succession) that make it unreliable as a primary source.

| Period | Recommended source |
|--------|-------------------|
| Pre-1700 | historical-basemaps |
| 1700–1814 | historical-basemaps (OHM as spot supplement) |
| **1815–present** | **OHM** |

Note: OHM does not implement the OSM `[date:]` Overpass filter — temporal queries must be done client-side by comparing `start_date`/`end_date` tags after fetching all relations.

### Integration Notes for OpenHistory

**How OHM Wikidata tags map to our schema**: OHM boundary relations carry `wikidata=Q...` tags that map directly to our `polities.wikidata_qid`. The linkage between OHM territory polygons and our polity records would be automatic for any entity that has both a Wikidata QID in OHM and exists in our polities table.

**Recommended use**: OHM as a supplementary territory source for **1800–1945** where their data is strongest, queried via Overpass by polity QID or region+timewindow. Importing via Overpass → GeoJSON → our `territories` table pipeline.

**License benefit**: CC0 would free the territory layer from historical-basemaps' GPL-3.0 constraint. Currently, our `territories.geojson` export is GPL-3.0 by viral license. OHM-sourced polygons would be CC0, same as our code (MIT) and event data (CC BY-SA from Wikidata).

**Potential new feature — admin districts**: OHM's L3–L6 data enables a new `polity_type='admin_district'` (or similar) for sub-sovereign entities: colonial administrative zones, occupation districts, provinces, Generalbezirke, etc. These could be shown at higher zoom levels with a distinct visual style, linked to their parent polity.

---

*Last updated: 2026-03-08*
