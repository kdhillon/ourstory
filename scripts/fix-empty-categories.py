#!/usr/bin/env python3
"""
scripts/fix-empty-categories.py

Uses Claude to assign categories to events that have an empty categories array.
These are events where none of their Wikidata P31 types matched the static
WIKIDATA_TO_CATEGORY mapping in extract.py.

Usage:
    ANTHROPIC_API_KEY=... python3 scripts/fix-empty-categories.py
    ANTHROPIC_API_KEY=... python3 scripts/fix-empty-categories.py --dry-run
    ANTHROPIC_API_KEY=... python3 scripts/fix-empty-categories.py --limit 50
"""

import argparse
import json
import os
import sys
import textwrap

import anthropic
import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://ourstory:ourstory@localhost:5432/ourstory",
)

CLAUDE_MODEL = "claude-haiku-4-5-20251001"
BATCH_SIZE = 20

VALID_CATEGORIES = [
    "battle", "war", "politics", "founding", "religion",
    "disaster", "discovery", "exploration", "science", "culture",
]

SYSTEM_PROMPT = textwrap.dedent("""
    You are a categorization assistant for a historical atlas database called OurStory.
    You assign categories to historical events based on their title and description.

    Available categories (use ONLY these exact strings):
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
    - Assign 1-3 categories maximum per event. Most events need only 1.
    - For wars and battles: use "battle" for single engagements, "war" for multi-year conflicts.
    - Prefer more specific over generic.

    Respond ONLY with a JSON array. One object per event:
    [{"id": "<uuid>", "categories": ["battle"]}]

    Never add explanations. Never include events that had clear enough information.
    Just the JSON array.
""").strip()


def fetch_empty_category_events(conn, limit: int) -> list[dict]:
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT id, title, wikipedia_title, wikipedia_summary,
                   year_start, year_end, location_name, categories
            FROM events
            WHERE categories = '{}'
              AND wikidata_qid IS NOT NULL
            ORDER BY created_at DESC
            LIMIT %s
        """, (limit,))
        return [dict(row) for row in cur.fetchall()]


def categorize_batch(client: anthropic.Anthropic, events: list[dict]) -> list[dict]:
    records = []
    for ev in events:
        summary = (ev.get("wikipedia_summary") or "")[:250]
        records.append({
            "id": str(ev["id"]),
            "title": ev["title"],
            "summary": summary or None,
            "year": ev.get("year_start"),
            "location": ev.get("location_name"),
        })

    message = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[{
            "role": "user",
            "content": f"Assign categories to these {len(records)} events:\n\n{json.dumps(records, indent=2, default=str)}"
        }],
    )

    raw = message.content[0].text.strip()
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(lines[1:-1] if lines[-1] == "```" else lines[1:])

    try:
        result = json.loads(raw)
        if isinstance(result, list):
            return result
    except json.JSONDecodeError:
        start = raw.find("[")
        end = raw.rfind("]") + 1
        if start >= 0 and end > start:
            try:
                return json.loads(raw[start:end])
            except json.JSONDecodeError:
                pass
    print(f"  Warning: could not parse response: {raw[:200]}", file=sys.stderr)
    return []


def main():
    parser = argparse.ArgumentParser(description="Fix events with empty categories using LLM")
    parser.add_argument("--limit", type=int, default=500, help="Max events to fix (default: 500)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be changed, don't write")
    args = parser.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY not set.", file=sys.stderr)
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)
    conn = psycopg2.connect(DATABASE_URL)

    events = fetch_empty_category_events(conn, args.limit)
    print(f"Events with empty categories: {len(events)}")

    if not events:
        print("Nothing to fix.")
        return

    all_assignments: list[dict] = []

    for i in range(0, len(events), BATCH_SIZE):
        batch = events[i : i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total = (len(events) + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"  Batch {batch_num}/{total} ({len(batch)} events)...", end=" ", flush=True)
        assignments = categorize_batch(client, batch)
        all_assignments.extend(assignments)
        assigned = sum(1 for a in assignments if a.get("categories"))
        print(f"{assigned} assigned")

    # Validate categories
    valid_assignments = []
    for a in all_assignments:
        cats = [c for c in (a.get("categories") or []) if c in VALID_CATEGORIES]
        if cats:
            valid_assignments.append({"id": a["id"], "categories": cats})

    print(f"\n{len(valid_assignments)}/{len(events)} events will get categories assigned")

    if args.dry_run:
        for a in valid_assignments[:20]:
            print(f"  {a['id']}: {a['categories']}")
        if len(valid_assignments) > 20:
            print(f"  ... and {len(valid_assignments) - 20} more")
        print("\n[DRY RUN] No changes written.")
        return

    with conn.cursor() as cur:
        for a in valid_assignments:
            cur.execute(
                "UPDATE events SET categories = %s WHERE id = %s::uuid",
                (a["categories"], a["id"]),
            )
    conn.commit()
    conn.close()

    print(f"Updated {len(valid_assignments)} events with categories.")
    print("Re-export GeoJSON:")
    print("  cd scripts && npm run export")


if __name__ == "__main__":
    main()
