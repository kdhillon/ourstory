# Data Quality Evaluation — 2026-03-04

Evaluated after populating 1730–1830 (events) + polities for the same window.
DB state: 6,997 events | 1,633 locations | 1,275 polities

---

## Summary

Overall data quality is **good for high-sitelink events** but has three systemic issues worth addressing:
1. ~2,059 "year in X" meta-articles that shouldn't be in the DB
2. 1,859 events with empty categories (many overlap with issue 1)
3. Two future events that slipped through the date filter

---

## Issue 1 — "Year in X" Wikipedia meta-articles (HIGH PRIORITY)

**Count**: 2,059 events (~29% of total)

**Examples**: "1730 in France", "1730 in Canada", "1730 in music", "1730 in art", "1730s in Wales", "1730"

These are Wikipedia's annual summary disambiguation articles, not actual historical events. They come in through SPARQL queries that match on P585 (point in time) date ranges. They inflate event counts significantly, have no coordinates, and almost all have empty categories.

**Impact**: 1,572 of the 1,859 empty-category events are these meta-articles.

**Fix**: Add a title-pattern exclusion to `pipeline/run_local.py` Step 3 extract phase:
```python
NOISE_TITLE_PATTERNS = [
    r'^\d{4}s? in ',      # "1730 in France", "1730s in Wales"
    r'^\d{4}s?$',          # "1730", "1730s"
    r'^list of ',          # "List of..."
    r'^history of ',       # "History of..."
]
```
Could also be done as a post-processing DELETE. Recommend filtering at extraction time.

---

## Issue 2 — Empty categories (1,859 events, 26%)

After removing "year in X" noise (~1,572), ~287 events genuinely lack categories. These need the LLM fix pass:
```bash
ANTHROPIC_API_KEY=... python3 scripts/fix-empty-categories.py
```
The current empty-category count will drop substantially once noise articles are removed.

**Category distribution for categorized events (1750–1830):**
| Category | Count |
|---|---|
| battle | 2,174 |
| politics | 1,707 |
| war | 390 |
| culture | 306 |
| disaster | 104 |
| science | 95 |
| exploration | 35 |
| discovery | 24 |
| religion | 8 |

The `battle` and `politics` dominance is expected for this era (Napoleonic wars, American/French revolutions). `religion` at 8 seems low — likely under-captured.

---

## Issue 3 — Out-of-range events (2 events)

Two events have `year_start` outside the pipeline's target window:
- **"Chechen–Russian conflict"** — `year_start: 2017`. Came through a conflict SPARQL query that matched the start of the modern conflict, but the entity has a P580 start date in 2017. Shouldn't be in a 1730–1830 dataset.
- **"Bicentennial of Bolivia"** — `year_start: 2025`. A future event that matched a `P571` date. Should be excluded.

**Fix**: The pipeline has a `max_year` filter (default 2015) in SPARQL. These two slipped through because they're tagged differently in Wikidata. The "Bicentennial of Bolivia" may need an `AND year_start <= max_year` guard at the DB load step.

---

## Issue 4 — Polity date anomaly

**"United Provinces of New Granada"** has `year_start: 181`, `year_end: 1816`.
- The correct founding year is **1811** (not 181).
- This appears to be a Wikidata P571 precision/parsing issue — the date was likely stored as an uncertain year and our parser read the century as the year.
- `wikidata_qid: Q2249661`

**Fix**: Manual correction via the in-app edit UI, or a direct DB update:
```sql
UPDATE polities SET year_start = 1811 WHERE wikidata_qid = 'Q2249661';
```

---

## Positive findings

**High-quality events (1750–1770 sample):**
The top events by sitelinks are all historically correct and well-categorized:
- Seven Years' War (97 sitelinks, `war`, location: Europe) ✓
- American Revolution (90 sitelinks, `politics`, location: Thirteen Colonies) ✓
- 1755 Lisbon earthquake (59 sitelinks, `disaster`, location: Lisbon) ✓
- Battle of Plassey (55 sitelinks, `battle`, location: Palashi) ✓
- Treaty of Paris 1763 (46 sitelinks, `politics`, location: Paris) ✓
- Third Battle of Panipat (40 sitelinks, `battle`, location: Panipat) ✓

**Locations**: 0 records with null coordinates. Duplicate city names (Tripoli, Alexandria, Brest, etc.) are correctly handled as distinct QID-keyed entities — Tripoli Libya ≠ Tripoli Greece; Alexandria Egypt ≠ Alexandria Virginia.

**Culture events (1750–1770)**: Paris Salon series (Salon of 1755, 1757, 1759, etc.) correctly categorized as `culture`.

**Polities**: HRE states, Indian princely states, and major European powers all look reasonable. `principality` correctly captures German prince-bishoprics and Indian states.

**"Other" polities** include: Denmark, Sweden, Hungary, San Marino — these are real polities that Wikidata doesn't tag as kingdom/empire specifically. Acceptable fallback.

---

## Recommendations

| Priority | Issue | Action |
|---|---|---|
| High | "Year in X" noise (2,059 events) | Add title-pattern filter in `run_local.py` extract step |
| High | United Provinces year_start=181 | `UPDATE polities SET year_start=1811 WHERE wikidata_qid='Q2249661'` |
| Medium | 287 genuinely uncategorized events | Run `fix-empty-categories.py` after noise is removed |
| Medium | Future events (2017, 2025) | Add `year_start <= max_year` guard in load step |
| Low | `religion` category under-represented | May need dedicated SPARQL categories (councils, synods) |
| Fixed ✓ | backfill-part-of.py re-scanning all events | Fixed: now filters `IS NULL` only |
