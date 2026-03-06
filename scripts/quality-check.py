#!/usr/bin/env python3
"""
scripts/quality-check.py

LLM-powered data quality checker for the OurStory dataset.

Samples recently loaded records from the DB, sends them to Claude in batches,
and flags potential data issues such as:
  - WRONG_TYPE:     Geographic feature (country, peninsula, sea) stored as a city
  - WRONG_CATEGORY: Event categories don't match the event's actual content
  - BAD_LOCATION:   Location name/coordinates seem wrong for this event
  - SUSPICIOUS:     Other anomalies (implausible dates, mismatched title/summary, etc.)

Designed to be run:
  - After a pipeline batch:  python3 scripts/quality-check.py --limit 50
  - As a full audit:         python3 scripts/quality-check.py --all
  - From run_local.py with --quality-check flag (see below)

Exits with code 1 if high-confidence issues are found (for CI / pipeline pause).
Exits with code 0 if clean (or only low-confidence warnings).

Usage:
    python3 scripts/quality-check.py [--limit N] [--all] [--threshold 0.85] [--no-fail]

Environment:
    ANTHROPIC_API_KEY  — required
    DATABASE_URL       — Railway connection string (required)
"""

import argparse
import json
import os
import sys
import textwrap

import anthropic
import psycopg2
import psycopg2.extras

DATABASE_URL = os.environ["DATABASE_URL"]  # set via: export DATABASE_URL=$(railway variables get DATABASE_URL)

# Model to use — haiku is fast and cheap; swap for sonnet if accuracy matters more
CLAUDE_MODEL = "claude-haiku-4-5-20251001"

# Batch size: how many records per Claude call
BATCH_SIZE = 15

# Default confidence threshold above which an issue triggers a non-zero exit
DEFAULT_THRESHOLD = 0.85


# ---------------------------------------------------------------------------
# DB queries
# ---------------------------------------------------------------------------

def fetch_recent_cities(conn, limit: int) -> list[dict]:
    """Fetches the most recently created pipeline cities."""
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT id, name, wikipedia_title, wikipedia_summary,
                   founded_year, dissolved_year, wikidata_qid, lng, lat
            FROM locations
            WHERE location_type = 'city'
              AND wikidata_qid IS NOT NULL
            ORDER BY created_at DESC
            LIMIT %s
        """, (limit,))
        return [dict(row) for row in cur.fetchall()]


def fetch_recent_events(conn, limit: int) -> list[dict]:
    """Fetches the most recently created pipeline events."""
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT id, title, wikipedia_title, wikipedia_summary,
                   year_start, year_end, location_name, location_level,
                   categories, wikidata_qid, lng, lat
            FROM events
            WHERE wikidata_qid IS NOT NULL
            ORDER BY created_at DESC
            LIMIT %s
        """, (limit,))
        return [dict(row) for row in cur.fetchall()]


def fetch_all_cities(conn) -> list[dict]:
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT id, name, wikipedia_title, wikipedia_summary,
                   founded_year, dissolved_year, wikidata_qid, lng, lat
            FROM locations
            WHERE location_type = 'city'
              AND wikidata_qid IS NOT NULL
            ORDER BY created_at DESC
        """)
        return [dict(row) for row in cur.fetchall()]


def fetch_all_events(conn) -> list[dict]:
    with conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
        cur.execute("""
            SELECT id, title, wikipedia_title, wikipedia_summary,
                   year_start, year_end, location_name, location_level,
                   categories, wikidata_qid, lng, lat
            FROM events
            WHERE wikidata_qid IS NOT NULL
            ORDER BY created_at DESC
        """)
        return [dict(row) for row in cur.fetchall()]


# ---------------------------------------------------------------------------
# Format records for LLM prompt
# ---------------------------------------------------------------------------

def format_city_for_prompt(city: dict) -> dict:
    summary = (city.get("wikipedia_summary") or "")[:300]
    return {
        "id":              str(city["id"]),
        "record_type":     "city",
        "name":            city["name"],
        "wikipedia_title": city.get("wikipedia_title"),
        "summary":         summary or None,
        "founded_year":    city.get("founded_year"),
        "coordinates":     [city.get("lng"), city.get("lat")],
        "wikidata_qid":    city.get("wikidata_qid"),
    }


def format_event_for_prompt(event: dict) -> dict:
    summary = (event.get("wikipedia_summary") or "")[:300]
    return {
        "id":            str(event["id"]),
        "record_type":   "event",
        "title":         event["title"],
        "summary":       summary or None,
        "year_start":    event.get("year_start"),
        "year_end":      event.get("year_end"),
        "location_name": event.get("location_name"),
        "categories":    event.get("categories") or [],
        "coordinates":   [event.get("lng"), event.get("lat")],
        "wikidata_qid":  event.get("wikidata_qid"),
    }


# ---------------------------------------------------------------------------
# Claude quality check
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = textwrap.dedent("""
    You are a data quality auditor for a historical atlas database called OurStory.
    The database contains two types of records:
      - "event": a historical event (battle, election, disaster, founding, etc.)
      - "city": a human settlement (city, town, village, historical settlement, etc.)

    Your job is to identify data quality issues in the records you receive.

    Issue types to check for:
    - WRONG_TYPE: The record is misclassified. Examples:
        • A "city" record is actually a geographic feature (country, region, peninsula,
          island, sea, ocean, mountain, river, forest, empire, etc.)
        • An "event" record is actually a place or institution
    - WRONG_CATEGORY: An event's categories don't match its actual content.
        Example: a coronation ceremony labeled as "battle", a trade agreement as "disaster"
    - BAD_LOCATION: The location seems inconsistent with the event.
        Example: A Napoleonic battle placed in Australia, a Roman event in South America
    - SUSPICIOUS: Other anomalies — implausible dates, title/summary mismatch, etc.

    Respond ONLY with a JSON array (no extra text). One object per flagged record:
    [
      {
        "id": "<uuid>",
        "issues": ["WRONG_TYPE"],
        "confidence": 0.95,
        "reason": "Italian Peninsula is a geographic feature, not a settlement"
      }
    ]

    Only include records that have actual issues (confidence >= 0.7).
    If all records look correct, respond with an empty array: []
""").strip()


def check_batch(client: anthropic.Anthropic, records: list[dict]) -> list[dict]:
    """Sends a batch of records to Claude and returns flagged issues."""
    records_json = json.dumps(records, indent=2, default=str)

    message = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=1024,
        system=SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": f"Check these {len(records)} records for data quality issues:\n\n{records_json}"
            }
        ],
    )

    raw = message.content[0].text.strip()

    # Parse JSON response — handle markdown code blocks if present
    if raw.startswith("```"):
        lines = raw.split("\n")
        raw = "\n".join(lines[1:-1] if lines[-1] == "```" else lines[1:])

    try:
        issues = json.loads(raw)
        if not isinstance(issues, list):
            return []
        return issues
    except json.JSONDecodeError:
        # Try extracting just the JSON array
        start = raw.find("[")
        end = raw.rfind("]") + 1
        if start >= 0 and end > start:
            try:
                return json.loads(raw[start:end])
            except json.JSONDecodeError:
                pass
        print(f"  Warning: could not parse LLM response: {raw[:200]}", file=sys.stderr)
        return []


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="LLM data quality checker for OurStory")
    parser.add_argument(
        "--limit", type=int, default=50,
        help="Number of most-recent records to check (default: 50)"
    )
    parser.add_argument(
        "--all", action="store_true",
        help="Check all pipeline-created records (overrides --limit)"
    )
    parser.add_argument(
        "--threshold", type=float, default=DEFAULT_THRESHOLD,
        help=f"Confidence threshold to trigger exit code 1 (default: {DEFAULT_THRESHOLD})"
    )
    parser.add_argument(
        "--no-fail", action="store_true",
        help="Always exit with 0 even if issues found (for non-blocking use)"
    )
    parser.add_argument(
        "--cities-only", action="store_true",
        help="Only check city records (useful for quick WRONG_TYPE detection)"
    )
    parser.add_argument(
        "--events-only", action="store_true",
        help="Only check event records"
    )
    args = parser.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY environment variable not set.", file=sys.stderr)
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)

    conn = psycopg2.connect(DATABASE_URL)
    try:
        # Fetch records to check
        cities: list[dict] = []
        events: list[dict] = []

        if not args.events_only:
            cities_raw = fetch_all_cities(conn) if args.all else fetch_recent_cities(conn, args.limit // 2 or 25)
            cities = [format_city_for_prompt(c) for c in cities_raw]

        if not args.cities_only:
            events_raw = fetch_all_events(conn) if args.all else fetch_recent_events(conn, args.limit // 2 or 25)
            events = [format_event_for_prompt(e) for e in events_raw]

    finally:
        conn.close()

    all_records = cities + events
    if not all_records:
        print("No pipeline-created records found to check.")
        return

    print(f"Checking {len(all_records)} records ({len(cities)} cities, {len(events)} events)...")
    print(f"  Model: {CLAUDE_MODEL}, batch size: {BATCH_SIZE}, confidence threshold: {args.threshold}")

    all_issues: list[dict] = []

    for i in range(0, len(all_records), BATCH_SIZE):
        batch = all_records[i : i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (len(all_records) + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"  Batch {batch_num}/{total_batches} ({len(batch)} records)...", end=" ", flush=True)

        issues = check_batch(client, batch)
        all_issues.extend(issues)
        print(f"{len(issues)} issue(s) found")

    # Report
    print(f"\n{'='*60}")
    print(f"QUALITY CHECK RESULTS: {len(all_issues)} issue(s) found")
    print(f"{'='*60}")

    high_confidence = []

    if all_issues:
        for issue in sorted(all_issues, key=lambda x: x.get("confidence", 0), reverse=True):
            conf = issue.get("confidence", 0)
            issue_types = ", ".join(issue.get("issues", []))
            reason = issue.get("reason", "")
            flag = " *** HIGH CONFIDENCE ***" if conf >= args.threshold else ""
            print(f"\n  [{conf:.0%}] {issue_types}{flag}")
            print(f"    ID:     {issue.get('id')}")
            print(f"    Reason: {reason}")
            if conf >= args.threshold:
                high_confidence.append(issue)
    else:
        print("\n  No issues detected. Dataset looks clean.")

    print(f"\n{'='*60}")
    if high_confidence:
        print(f"HIGH-CONFIDENCE ISSUES: {len(high_confidence)} (confidence >= {args.threshold:.0%})")
        print("Review and fix these before continuing the pipeline run.")

    if high_confidence and not args.no_fail:
        sys.exit(1)


if __name__ == "__main__":
    main()
