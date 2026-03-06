#!/usr/bin/env python3
"""
scripts/fix-empty-categories.py  —  Self-healing category pipeline

Pass 1 (bulk P31 healing):
  - Collects every P31 QID present in uncategorized events that isn't already
    in WIKIDATA_TO_CATEGORY.
  - Fetches their English labels + descriptions from the Wikidata API.
  - Asks Claude (in large batches) to map each type to an OurStory category.
  - Writes the new mappings back into pipeline/extract.py so every future
    pipeline run categorises these types automatically.
  - Re-applies the full updated mapping to all uncategorized events in the DB.

Pass 2 (per-event fallback):
  - Events that are *still* uncategorized after Pass 1 get a per-event LLM call
    (title + summary → category).  These are unusual events whose P31 types
    genuinely don't map cleanly to a single category.

Usage:
    ANTHROPIC_API_KEY=... python3 scripts/fix-empty-categories.py
    ANTHROPIC_API_KEY=... python3 scripts/fix-empty-categories.py --dry-run
    ANTHROPIC_API_KEY=... python3 scripts/fix-empty-categories.py --limit 1000
"""

import argparse
import json
import os
import re
import sys
import textwrap
import time
from collections import defaultdict
from pathlib import Path
from typing import Optional

import anthropic
import psycopg2
import psycopg2.extras
import requests

ROOT       = Path(__file__).parent.parent
EXTRACT_PY = ROOT / "pipeline" / "extract.py"

DATABASE_URL = os.environ["DATABASE_URL"]  # set via: export DATABASE_URL=$(railway variables get DATABASE_URL)

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
USER_AGENT   = "OurStory-pipeline/0.2 (data@ourstory.app)"
CLAUDE_MODEL = "claude-haiku-4-5-20251001"

VALID_CATEGORIES = [
    "battle", "war", "politics", "founding", "religion",
    "disaster", "discovery", "exploration", "science", "culture",
]

# ---------------------------------------------------------------------------
# Wikidata label fetch
# ---------------------------------------------------------------------------

def fetch_wikidata_labels(qids: list[str]) -> dict[str, str]:
    """Returns {qid: "Label (description)"} for each QID."""
    result: dict[str, str] = {}
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    for i in range(0, len(qids), 50):
        batch = qids[i : i + 50]
        params = {
            "action": "wbgetentities",
            "ids": "|".join(batch),
            "props": "labels|descriptions",
            "languages": "en",
            "format": "json",
        }
        try:
            resp = session.get(WIKIDATA_API, params=params, timeout=20)
            resp.raise_for_status()
            entities = resp.json().get("entities", {})
            for qid, entity in entities.items():
                if entity.get("missing"):
                    continue
                label = entity.get("labels", {}).get("en", {}).get("value", "")
                desc  = entity.get("descriptions", {}).get("en", {}).get("value", "")
                result[qid] = label + (f" ({desc})" if desc else "")
        except Exception as exc:
            print(f"  Warning: label fetch failed for batch {i//50}: {exc}", file=sys.stderr)
        if i + 50 < len(qids):
            time.sleep(0.5)

    return result


# ---------------------------------------------------------------------------
# Pass 1: LLM maps P31 types → categories (bulk)
# ---------------------------------------------------------------------------

P31_SYSTEM = textwrap.dedent("""
    You are mapping Wikidata P31 (instance-of) entity types to OurStory historical atlas categories.

    Categories:
      battle      — specific military engagement, skirmish, siege, naval battle
      war         — broader armed conflict, campaign, military operation, mutiny, uprising, rebellion
      politics    — election, revolution, coup, assassination, treaty, riot, protest march,
                    political crisis, abdication, declaration of independence, political trial
      founding    — founding of a city, state, institution, or organization
      religion    — religious event, council, crusade, inquisition, persecution, conclave
      disaster    — earthquake, flood, famine, epidemic, volcanic eruption, fire,
                    industrial accident, shipwreck, storm
      discovery   — scientific or geographic discovery, invention
      exploration — expedition, voyage of discovery, exploration of new territory
      science     — scientific experiment, astronomical event, technological milestone
      culture     — cultural event, artistic movement, publication, festival

    Rules:
    - Respond ONLY with a flat JSON object: {"Q123": "battle", "Q456": null}
    - Use null for types that are too abstract, generic, or non-event (e.g. Q1190554 occurrence,
      Q13418847 historical event, Q3249551 process).
    - Every QID in the input must appear in your output.
    - No explanations.
""").strip()


def llm_map_p31_types(
    client: anthropic.Anthropic,
    qid_labels: dict[str, str],
) -> dict[str, Optional[str]]:
    """Bulk-maps {qid: label} → {qid: category | None}."""
    result: dict[str, Optional[str]] = {}
    items = list(qid_labels.items())
    batch_size = 80  # keep prompts under ~4k tokens

    for i in range(0, len(items), batch_size):
        batch = dict(items[i : i + batch_size])
        batch_num = i // batch_size + 1
        total = (len(items) + batch_size - 1) // batch_size
        print(f"    P31 batch {batch_num}/{total} ({len(batch)} types)...", end=" ", flush=True)

        try:
            msg = client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=2048,
                system=P31_SYSTEM,
                messages=[{
                    "role": "user",
                    "content": (
                        f"Map these {len(batch)} Wikidata P31 types to OurStory categories:\n\n"
                        + json.dumps(batch, indent=2)
                    ),
                }],
            )
            raw = msg.content[0].text.strip()
            if raw.startswith("```"):
                lines = raw.split("\n")
                raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])

            parsed: dict = {}
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                start, end = raw.find("{"), raw.rfind("}") + 1
                if start >= 0 and end > start:
                    parsed = json.loads(raw[start:end])

            good = 0
            for qid, cat in parsed.items():
                if cat is None or cat in VALID_CATEGORIES:
                    result[qid] = cat
                    good += 1
            print(f"{good}/{len(batch)} mapped")

        except Exception as exc:
            print(f"ERROR: {exc}", file=sys.stderr)

    return result


# ---------------------------------------------------------------------------
# Write new mappings into extract.py
# ---------------------------------------------------------------------------

def update_extract_py(
    new_mappings: dict[str, Optional[str]],
    qid_labels: dict[str, str],
    dry_run: bool = False,
) -> int:
    """Inserts new entries into WIKIDATA_TO_CATEGORY in extract.py. Returns count added."""
    if not new_mappings:
        return 0

    text = EXTRACT_PY.read_text()

    # Skip QIDs already present in the file
    to_add = {qid: cat for qid, cat in new_mappings.items() if f'"{qid}"' not in text}
    if not to_add:
        return 0

    # Build the block to insert, grouped by category
    by_cat: dict[Optional[str], list[tuple[str, str]]] = defaultdict(list)
    for qid, cat in sorted(to_add.items()):
        label = qid_labels.get(qid, "unknown").split("(")[0].strip()[:60]
        by_cat[cat].append((qid, label))

    lines: list[str] = ["    # Auto-learned from LLM (do not edit by hand — re-run fix-empty-categories.py)"]
    for cat in [*VALID_CATEGORIES, None]:
        for qid, label in by_cat.get(cat, []):
            if cat is not None:
                lines.append(f'    "{qid}":  "{cat}",      # {label}')
            else:
                lines.append(f'    "{qid}":  None,          # {label} — generic/excluded')

    insert_block = "\n".join(lines) + "\n\n"

    # Insert just before the "# Generic fallbacks" comment
    marker = "    # Generic fallbacks — needs LLM category assignment"
    if marker in text:
        new_text = text.replace(marker, insert_block + marker, 1)
    else:
        # Fallback: before closing brace of the dict
        new_text = re.sub(r'(\n\})\n', lambda m: f"\n{insert_block.rstrip()}{m.group(1)}\n", text, count=1)

    if not dry_run:
        EXTRACT_PY.write_text(new_text)

    return len(to_add)


# ---------------------------------------------------------------------------
# Apply the (now updated) mapping to the DB
# ---------------------------------------------------------------------------

def apply_p31_mapping_to_db(
    conn,
    merged_map: dict[str, Optional[str]],
    dry_run: bool = False,
) -> int:
    """
    Re-applies a combined WIKIDATA_TO_CATEGORY dict to all uncategorized events.
    Uses the in-memory merged_map (original + new LLM mappings) so we don't
    need to reload the module from disk.
    """
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT id, p31_qids FROM events
            WHERE (categories = '{}' OR categories IS NULL)
              AND p31_qids IS NOT NULL AND array_length(p31_qids, 1) > 0
        """)
        rows = cur.fetchall()

    fixed = 0
    updates = []
    for row in rows:
        cats: set[str] = set()
        for qid in (row["p31_qids"] or []):
            if qid in merged_map:
                cat = merged_map[qid]
                if cat is not None:
                    cats.add(cat)
        if cats:
            updates.append((sorted(cats), row["id"]))
            fixed += 1

    if not dry_run and updates:
        with conn.cursor() as cur:
            for cats, eid in updates:
                cur.execute("UPDATE events SET categories = %s WHERE id = %s", (cats, eid))
        conn.commit()

    return fixed


# ---------------------------------------------------------------------------
# Pass 2: per-event LLM fallback
# ---------------------------------------------------------------------------

EVENT_SYSTEM = textwrap.dedent("""
    You are a categorization assistant for a historical atlas database called OurStory.
    Assign categories to historical events based on their title and description.

    Categories (use ONLY these exact strings):
      battle     — a specific military engagement, skirmish, or battle
      war        — a broader armed conflict, campaign, or military operation
      politics   — election, revolution, coup, assassination, treaty, political crisis, rebellion
      founding   — founding or establishment of a city, state, institution, or organization
      religion   — religious event, council, crusade, inquisition, religious persecution
      disaster   — earthquake, flood, famine, epidemic, volcanic eruption, fire, accident
      discovery  — scientific or geographic discovery, invention
      exploration — expedition, voyage, exploration of new territories
      science    — scientific experiment, astronomical event, technological milestone
      culture    — cultural event, artistic movement, landmark publication

    Rules:
    - Assign 1–3 categories per event. Most events need only 1.
    - Respond ONLY with a JSON array: [{"id": "<uuid>", "categories": ["battle"]}]
    - No explanations.
""").strip()


def per_event_llm_batch(
    client: anthropic.Anthropic,
    events: list[dict],
) -> list[dict]:
    records = [
        {
            "id":       str(ev["id"]),
            "title":    ev["title"],
            "summary":  (ev.get("wikipedia_summary") or "")[:250] or None,
            "year":     ev.get("year_start"),
            "location": ev.get("location_name"),
        }
        for ev in events
    ]
    try:
        msg = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=1024,
            system=EVENT_SYSTEM,
            messages=[{
                "role": "user",
                "content": f"Categorise these {len(records)} events:\n\n{json.dumps(records, indent=2, default=str)}",
            }],
        )
        raw = msg.content[0].text.strip()
        if raw.startswith("```"):
            lines = raw.split("\n")
            raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        result = json.loads(raw)
        if isinstance(result, list):
            return result
    except Exception:
        start = raw.find("[") if 'raw' in dir() else -1
        end   = raw.rfind("]") + 1 if start >= 0 else 0
        if start >= 0 and end > start:
            try:
                return json.loads(raw[start:end])
            except Exception:
                pass
    return []


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Self-healing category pipeline")
    parser.add_argument("--limit",   type=int, default=2000, help="Max uncategorized events to process")
    parser.add_argument("--dry-run", action="store_true",    help="Show what would change, don't write")
    args = parser.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY not set.", file=sys.stderr)
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)
    conn   = psycopg2.connect(DATABASE_URL)

    # Load current WIKIDATA_TO_CATEGORY from extract.py
    sys.path.insert(0, str(ROOT))
    from pipeline.extract import WIKIDATA_TO_CATEGORY
    existing_qids = set(WIKIDATA_TO_CATEGORY.keys())

    # ------------------------------------------------------------------
    # Step 1: find all unknown P31 QIDs in uncategorized events
    # ------------------------------------------------------------------
    print("\n[Pass 1] Healing P31 type mappings...")

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT id, title, wikipedia_summary, year_start, location_name, p31_qids
            FROM events
            WHERE (categories = '{}' OR categories IS NULL)
              AND wikidata_qid IS NOT NULL
            ORDER BY year_start
            LIMIT %s
        """, (args.limit,))
        uncategorized = [dict(r) for r in cur.fetchall()]

    print(f"  Uncategorized events: {len(uncategorized)}")

    unknown_qids: set[str] = set()
    for ev in uncategorized:
        for qid in (ev.get("p31_qids") or []):
            if qid not in existing_qids:
                unknown_qids.add(qid)

    print(f"  Unknown P31 QIDs to classify: {len(unknown_qids)}")

    new_mappings: dict[str, Optional[str]] = {}

    if unknown_qids:
        # Step 2: fetch labels
        print(f"  Fetching Wikidata labels for {len(unknown_qids)} QIDs...")
        qid_labels = fetch_wikidata_labels(list(unknown_qids))
        print(f"  Got {len(qid_labels)} labels.")

        # Step 3: LLM maps P31 types
        print("  Asking LLM to map P31 types...")
        new_mappings = llm_map_p31_types(client, qid_labels)
        mapped     = sum(1 for v in new_mappings.values() if v is not None)
        excluded   = sum(1 for v in new_mappings.values() if v is None)
        print(f"  Result: {mapped} mapped to categories, {excluded} marked None.")

        # Step 4: write back to extract.py
        added = update_extract_py(new_mappings, qid_labels, dry_run=args.dry_run)
        action = "[DRY RUN] would add" if args.dry_run else "Added"
        print(f"  {action} {added} new entries to pipeline/extract.py.")
    else:
        qid_labels = {}

    # Step 5: apply merged mapping to DB
    merged_map = {**WIKIDATA_TO_CATEGORY, **new_mappings}
    fixed_p31 = apply_p31_mapping_to_db(conn, merged_map, dry_run=args.dry_run)
    action = "[DRY RUN] would fix" if args.dry_run else "Fixed"
    print(f"  {action} {fixed_p31} events via updated P31 mapping.")

    # ------------------------------------------------------------------
    # Step 6: per-event LLM fallback for events still uncategorized
    # ------------------------------------------------------------------
    print("\n[Pass 2] Per-event LLM fallback for remaining uncategorized events...")

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT id, title, wikipedia_summary, year_start, location_name
            FROM events
            WHERE (categories = '{}' OR categories IS NULL)
              AND wikidata_qid IS NOT NULL
            ORDER BY year_start
            LIMIT %s
        """, (args.limit,))
        still_empty = [dict(r) for r in cur.fetchall()]

    print(f"  Events still uncategorized: {len(still_empty)}")

    if not still_empty:
        print("  Nothing left to fix.")
    else:
        all_assignments: list[dict] = []
        batch_size = 20
        for i in range(0, len(still_empty), batch_size):
            batch = still_empty[i : i + batch_size]
            bn    = i // batch_size + 1
            total = (len(still_empty) + batch_size - 1) // batch_size
            print(f"  Event batch {bn}/{total} ({len(batch)})...", end=" ", flush=True)
            assignments = per_event_llm_batch(client, batch)
            all_assignments.extend(assignments)
            print(f"{sum(1 for a in assignments if a.get('categories'))} assigned")

        valid = [
            {"id": a["id"], "categories": [c for c in (a.get("categories") or []) if c in VALID_CATEGORIES]}
            for a in all_assignments
            if any(c in VALID_CATEGORIES for c in (a.get("categories") or []))
        ]
        print(f"  {len(valid)}/{len(still_empty)} events will get per-event categories")

        if not args.dry_run:
            with conn.cursor() as cur:
                for a in valid:
                    cur.execute(
                        "UPDATE events SET categories = %s WHERE id = %s::uuid",
                        (a["categories"], a["id"]),
                    )
            conn.commit()

    conn.close()

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    print("\n" + "=" * 50)
    print("Done.")
    if args.dry_run:
        print("[DRY RUN] No changes were written.")
    else:
        print("Next step: re-export GeoJSON")
        print("  python3 scripts/export_geojson.py")


if __name__ == "__main__":
    main()
