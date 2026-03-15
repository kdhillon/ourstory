#!/usr/bin/env python3
"""
scripts/generate_story.py — Generate a story JSON from a Wikipedia article.

Flow:
  1. Fetch the Wikipedia article + all its internal links
  2. Resolve links to Wikidata QIDs; filter to event-like entities
  3. Claude reads the article + event pool → picks story beats (independent of DB)
  4. For each beat that references an event, ensure it exists in the DB (import if not)
  5. Write story JSON to frontend/public/data/stories/<slug>.json

Usage:
    source .env && export DATABASE_URL
    ANTHROPIC_API_KEY=... python3 scripts/generate_story.py --anchor-qid Q6534 --detail-level middle_school
    ANTHROPIC_API_KEY=... python3 scripts/generate_story.py --anchor-qid Q6534 --detail-level middle_school --dry-run
"""

import argparse
import json
import os
import re
import sys
import textwrap
import time
from pathlib import Path
from typing import Optional

import anthropic
import psycopg2
import psycopg2.extras
import requests

ROOT = Path(__file__).parent.parent
STORIES_DIR = ROOT / "frontend" / "public" / "data" / "stories"
DATABASE_URL = os.environ["DATABASE_URL"]

WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
WIKIDATA_API  = "https://www.wikidata.org/w/api.php"
USER_AGENT    = "OpenHistory-pipeline/0.1 (history@openhistory.app)"
CLAUDE_MODEL  = "claude-opus-4-6"

DETAIL_LEVELS = {
    "elementary":    "5th grade level, 8-12 key beats only, very simple language",
    "middle_school": "8th grade level, 15-20 beats covering the main turning points, clear accessible prose",
    "high_school":   "10th-12th grade, 25-35 beats with causes and consequences, nuanced analysis",
    "deep_dive":     "university/enthusiast level, 50+ beats, comprehensive with detailed context",
}

# P31 QIDs we recognise as event-like (subset of pipeline/extract.py)
EVENT_P31S = {
    "Q178561","Q188055","Q831663","Q645883","Q646740","Q678146","Q750215",
    "Q198","Q8465","Q467011","Q1323212","Q350604","Q41397","Q511866",
    "Q10931","Q124734","Q1781513","Q167466","Q191797","Q175482","Q133311",
    "Q40231","Q131569","Q208251","Q1464916","Q2223653","Q25906438",
    "Q2334719","Q3839261","Q145694","Q192909","Q900792","Q625994",
    "Q124490","Q7944","Q8092","Q7692360","Q2635894","Q3241045","Q12184",
    "Q3071558","Q3199915","Q1931234","Q2656967","Q838718",
    "Q2085381","Q3464753","Q8441","Q82821","Q186431","Q45469","Q191760",
    "Q2678658","Q43702","Q170584","Q1198916","Q2401485","Q11862829",
    "Q1473346","Q2334788","Q959583","Q752783","Q1005931",
    "Q19841484","Q997267","Q1006311","Q1155622","Q13427116",
    "Q21994376","Q107706","Q217901","Q1384277","Q188728",  # insurrection
    "Q16533779","Q1371150","Q104212151","Q350604",
}


# ── Wikipedia helpers ────────────────────────────────────────────────────────

def fetch_article(qid: str) -> tuple[str, str, list[str]]:
    """Return (wp_title, article_text, [linked_article_titles])."""
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    # 1. QID → Wikipedia title
    r = session.get(WIKIDATA_API, params={
        "action": "wbgetentities", "ids": qid,
        "props": "sitelinks", "sitefilter": "enwiki", "format": "json",
    }, timeout=20)
    r.raise_for_status()
    wp_title = r.json()["entities"][qid]["sitelinks"]["enwiki"]["title"]
    print(f"  Article: '{wp_title}'")

    # 2. Full article text
    r = session.get(WIKIPEDIA_API, params={
        "action": "query", "titles": wp_title,
        "prop": "extracts", "explaintext": True,
        "exsectionformat": "plain", "format": "json",
    }, timeout=30)
    r.raise_for_status()
    pages = r.json()["query"]["pages"]
    text = next(iter(pages.values())).get("extract", "")

    # 3. All internal links (namespace 0 = article space), paginated
    links: list[str] = []
    plcontinue = None
    while True:
        params: dict = {
            "action": "query", "titles": wp_title,
            "prop": "links", "pllimit": "500", "plnamespace": "0",
            "format": "json",
        }
        if plcontinue:
            params["plcontinue"] = plcontinue
        r = session.get(WIKIPEDIA_API, params=params, timeout=20)
        r.raise_for_status()
        data = r.json()
        page = next(iter(data["query"]["pages"].values()))
        links += [lk["title"] for lk in page.get("links", [])]
        plcontinue = data.get("continue", {}).get("plcontinue")
        if not plcontinue:
            break

    print(f"  Article length: {len(text):,} chars | Internal links: {len(links)}")
    return wp_title, text, links


def resolve_qids(titles: list[str]) -> dict[str, str]:
    """Return {wp_title: wikidata_qid} for all titles that have a QID."""
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    result: dict[str, str] = {}
    for i in range(0, len(titles), 50):
        batch = titles[i:i+50]
        r = session.get(WIKIDATA_API, params={
            "action": "wbgetentities",
            "sites": "enwiki",
            "titles": "|".join(batch),
            "props": "claims|labels|sitelinks",
            "sitefilter": "enwiki",
            "languages": "en",
            "format": "json",
        }, timeout=20)
        r.raise_for_status()
        for qid, entity in r.json()["entities"].items():
            if entity.get("missing") or not qid.startswith("Q"):
                continue
            wp = entity.get("sitelinks", {}).get("enwiki", {}).get("title")
            if wp:
                result[wp] = qid
        if i + 50 < len(titles):
            time.sleep(0.2)
    return result


def fetch_entity_data(qids: list[str]) -> dict[str, dict]:
    """Return {qid: {label, year, month, day, p31s, lat, lng, loc_qid, wp_title}} for each QID."""
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    result: dict[str, dict] = {}
    for i in range(0, len(qids), 50):
        batch = qids[i:i+50]
        r = session.get(WIKIDATA_API, params={
            "action": "wbgetentities",
            "ids": "|".join(batch),
            "props": "claims|labels|sitelinks",
            "sitefilter": "enwiki",
            "languages": "en",
            "format": "json",
        }, timeout=25)
        r.raise_for_status()
        for qid, entity in r.json()["entities"].items():
            if entity.get("missing"):
                continue
            claims = entity.get("claims", {})
            result[qid] = {
                "label":    _label(entity),
                "wp_title": entity.get("sitelinks", {}).get("enwiki", {}).get("title"),
                "p31s":     _item_ids(claims, "P31"),
                **_date(claims),
                **_location(claims),
            }
        if i + 50 < len(qids):
            time.sleep(0.2)
    return result


def _label(entity: dict) -> str:
    labels = entity.get("labels", {})
    return (labels.get("en") or next(iter(labels.values()), {})).get("value", "")


def _date(claims: dict) -> dict:
    """Extract year/month/day from P585 > P580 > P571."""
    for prop in ("P585", "P580", "P571"):
        for s in claims.get(prop, []):
            dv = s.get("mainsnak", {}).get("datavalue", {})
            if dv.get("type") != "time":
                continue
            t = dv["value"]["time"]       # e.g. "+1789-07-14T00:00:00Z"
            prec = dv["value"]["precision"]
            m = re.match(r"([+-])(\d+)-(\d{2})-(\d{2})T", t)
            if not m:
                continue
            sign, y, mo, d = m.groups()
            year  = int(y) * (-1 if sign == "-" else 1)
            month = int(mo) if prec >= 10 and int(mo) > 0 else None
            day   = int(d)  if prec >= 11 and int(d)  > 0 else None
            return {"year": year, "month": month, "day": day}
    return {"year": None, "month": None, "day": None}


def _location(claims: dict) -> dict:
    """Extract location info: direct coords (P625) or location QID (P276 > P17)."""
    for s in claims.get("P625", []):
        dv = s.get("mainsnak", {}).get("datavalue", {})
        if dv.get("type") == "globecoordinate":
            v = dv["value"]
            return {"lat": float(v["latitude"]), "lng": float(v["longitude"]),
                    "loc_qid": None, "loc_level": "point"}
    for prop, level in (("P276", "city"), ("P17", "country")):
        for s in claims.get(prop, []):
            dv = s.get("mainsnak", {}).get("datavalue", {})
            if dv.get("type") == "wikibase-entityid":
                return {"lat": None, "lng": None,
                        "loc_qid": dv["value"]["id"], "loc_level": level}
    return {"lat": None, "lng": None, "loc_qid": None, "loc_level": None}


def _item_ids(claims: dict, prop: str) -> list[str]:
    ids = []
    for s in claims.get(prop, []):
        dv = s.get("mainsnak", {}).get("datavalue", {})
        if dv.get("type") == "wikibase-entityid":
            ids.append(dv["value"]["id"])
    return ids


def is_event_like(info: dict) -> bool:
    """True if this entity looks like a historical event."""
    if info.get("year") is not None:
        return True
    return bool(set(info.get("p31s", [])) & EVENT_P31S)


# ── DB helpers ───────────────────────────────────────────────────────────────

def qids_in_db(conn, qids: list[str]) -> set[str]:
    with conn.cursor() as cur:
        cur.execute("SELECT wikidata_qid FROM events WHERE wikidata_qid = ANY(%s)", (qids,))
        return {row[0] for row in cur.fetchall()}


def _wp_summary_and_url(title: str) -> tuple[str, str]:
    try:
        encoded = requests.utils.quote(title.replace(" ", "_"))
        r = requests.get(
            f"https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}",
            headers={"User-Agent": USER_AGENT}, timeout=8,
        )
        if r.ok:
            d = r.json()
            return d.get("extract", ""), d.get("content_urls", {}).get("desktop", {}).get("page", "")
    except Exception:
        pass
    title_encoded = title.replace(" ", "_")
    return "", f"https://en.wikipedia.org/wiki/{title_encoded}"


def import_event(conn, qid: str, info: dict, anchor_qid: str) -> None:
    """Insert a minimal event row; skip if QID already exists."""
    title    = info["label"] or qid
    wp_title = info.get("wp_title") or title
    summary, wp_url = _wp_summary_and_url(wp_title)
    if not wp_url:
        wp_url = f"https://en.wikipedia.org/wiki/{wp_title.replace(' ', '_')}"

    slug_base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    p31s      = info.get("p31s", [])

    # Derive category from P31
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).parent.parent))
    from pipeline.extract import WIKIDATA_TO_CATEGORY
    category = next((WIKIDATA_TO_CATEGORY[p] for p in p31s if p in WIKIDATA_TO_CATEGORY and WIKIDATA_TO_CATEGORY[p]), None)
    categories = [category] if category else []

    with conn.cursor() as cur:
        # Try slug; if collision, append qid suffix
        slug = slug_base
        cur.execute("SELECT 1 FROM events WHERE slug = %s AND wikidata_qid != %s", (slug, qid))
        if cur.fetchone():
            slug = f"{slug_base}-{qid.lower()}"

        cur.execute("""
            INSERT INTO events (
                wikidata_qid, slug, title, wikipedia_title, wikipedia_summary, wikipedia_url,
                year_start, month_start, day_start,
                location_level, location_name, location_wikidata_qid, lng, lat,
                categories, p31_qids, part_of_qids,
                data_version, pipeline_run
            ) VALUES (
                %(qid)s, %(slug)s, %(title)s, %(wp_title)s, %(summary)s, %(wp_url)s,
                %(year)s, %(month)s, %(day)s,
                %(loc_level)s, %(loc_name)s, %(loc_qid)s, %(lng)s, %(lat)s,
                %(categories)s, %(p31s)s, %(part_of_qids)s,
                2, 'story-import'
            )
            ON CONFLICT (wikidata_qid) DO UPDATE
                SET part_of_qids = array(
                    SELECT DISTINCT unnest(events.part_of_qids || EXCLUDED.part_of_qids)
                )
        """, {
            "qid": qid, "slug": slug, "title": title,
            "wp_title": wp_title, "summary": summary, "wp_url": wp_url,
            "year": info.get("year"), "month": info.get("month"), "day": info.get("day"),
            "loc_level": info.get("loc_level"), "loc_name": None,
            "loc_qid": info.get("loc_qid"), "lng": info.get("lng"), "lat": info.get("lat"),
            "categories": categories, "p31s": p31s,
            "part_of_qids": [anchor_qid],
        })
    conn.commit()


# ── Claude story generation ──────────────────────────────────────────────────

STORY_SYSTEM = textwrap.dedent("""
    You are a master history teacher constructing story beats for an interactive
    historical atlas. Your task: read a Wikipedia article and choose the most
    important events to feature as beats in a narrative story.

    RULES:
    - Select beats appropriate for the requested detail level (quantity and depth).
    - Order beats chronologically.
    - Each beat should have narrative_text: 2-4 sentences of engaging prose drawn
      from the Wikipedia article. Write at the specified reading level.
    - If a beat corresponds to an event in the "Available events" list, set
      event_qid to that event's QID. Prefer matching over null.
    - If no matching event exists in the list, set event_qid to null.
    - chapter_title: only set on the FIRST beat of a new chapter/phase.
    - date: only include for beats where event_qid is null (narrative-only beats with no DB event).
      Format: "YYYY-MM-DD", "YYYY-MM", or "YYYY". Omit entirely when event_qid is set.
    - beat_title: the narrative title for this beat — how it should be displayed in the story card.
      This may differ from the raw Wikipedia/DB event title (e.g. "The King's Escape" instead of
      "Flight to Varennes"). Always include even when event_qid is set.

    OUTPUT: respond with ONLY a valid JSON array of beat objects, no markdown:
    [
      {
        "sequence": 1,
        "chapter_title": "The Collapse of the Old Order",
        "event_qid": "Q200749",
        "beat_title": "Day of the Tiles",
        "date": "1788-06-07",
        "narrative_text": "..."
      },
      ...
    ]
""").strip()


def generate_beats(
    client: anthropic.Anthropic,
    wp_title: str,
    article_text: str,
    event_pool: list[dict],  # [{qid, title, year}]
    detail_level: str,
) -> list[dict]:
    level_desc = DETAIL_LEVELS[detail_level]

    pool_str = json.dumps([{
        "qid": e["qid"], "title": e["title"],
        "year": e["year"], "month": e.get("month"), "day": e.get("day"),
    } for e in event_pool], indent=2)

    # Keep first 10k chars of article to stay within reasonable context
    excerpt = article_text[:10000]
    if len(article_text) > 10000:
        excerpt += "\n\n[Article truncated]"

    user_msg = f"""Detail level: {detail_level} — {level_desc}

---
Wikipedia article: {wp_title}

{excerpt}

---
Available events (use event_qid from this list when a beat matches):

{pool_str}

---
Generate the story beats JSON array now."""

    print(f"  Calling Claude ({CLAUDE_MODEL})...")
    msg = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=8192,
        system=STORY_SYSTEM,
        messages=[{"role": "user", "content": user_msg}],
    )
    raw = msg.content[0].text.strip()
    if raw.startswith("```"):
        raw = "\n".join(raw.split("\n")[1:])
    if raw.endswith("```"):
        raw = "\n".join(raw.split("\n")[:-1])
    return json.loads(raw)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--anchor-qid", required=True, help="Wikidata QID (e.g. Q6534)")
    parser.add_argument("--detail-level", default="middle_school", choices=list(DETAIL_LEVELS))
    parser.add_argument("--slug", help="Override output slug")
    parser.add_argument("--dry-run", action="store_true", help="Skip DB writes and file output")
    args = parser.parse_args()

    anchor_qid = args.anchor_qid.upper()
    slug = args.slug or f"{anchor_qid.lower()}-{args.detail_level.replace('_', '-')}"
    output_path = STORIES_DIR / f"{slug}.json"

    print(f"\n=== Generating story: {anchor_qid} / {args.detail_level} ===")

    # ── Step 1: Fetch article + links ────────────────────────────────────────
    print("\n[1/4] Fetching Wikipedia article and links...")
    wp_title, article_text, linked_titles = fetch_article(anchor_qid)

    # ── Step 2: Resolve links → QIDs, filter to events ──────────────────────
    print(f"\n[2/4] Resolving {len(linked_titles)} links to Wikidata QIDs...")
    title_to_qid = resolve_qids(linked_titles)
    print(f"  Resolved {len(title_to_qid)} QIDs")

    # Fetch entity data for all resolved QIDs to filter event-like ones
    all_qids = list(title_to_qid.values())
    print(f"  Fetching entity data for {len(all_qids)} entities (to filter events)...")
    entity_data = fetch_entity_data(all_qids)

    event_pool = []
    for title, qid in title_to_qid.items():
        info = entity_data.get(qid)
        if info and is_event_like(info):
            event_pool.append({
                "qid": qid,
                "title": info["label"] or title,
                "year": info["year"],
                "month": info.get("month"),
                "day": info.get("day"),
            })
    event_pool.sort(key=lambda e: (e["year"] or 9999, e.get("month") or 0, e.get("day") or 0))
    print(f"  Event-like entities: {len(event_pool)}")

    # ── Step 3: Claude picks story beats ────────────────────────────────────
    print(f"\n[3/4] Generating story beats with Claude...")
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("ERROR: ANTHROPIC_API_KEY not set")

    client = anthropic.Anthropic(api_key=api_key)
    beats = generate_beats(client, wp_title, article_text, event_pool, args.detail_level)

    beat_qids = [b["event_qid"] for b in beats if b.get("event_qid")]
    print(f"  Generated {len(beats)} beats ({len(beat_qids)} with event QIDs, "
          f"{len(beats) - len(beat_qids)} narrative-only)")

    # ── Step 4: Ensure all beat events exist in DB ───────────────────────────
    print(f"\n[4/4] Syncing {len(beat_qids)} beat events to DB...")
    if not args.dry_run:
        conn = psycopg2.connect(DATABASE_URL)
        try:
            existing = qids_in_db(conn, beat_qids)
            missing  = [q for q in beat_qids if q not in existing]
            print(f"  Already in DB: {len(existing)} | To import: {len(missing)}")
            for qid in missing:
                info = entity_data.get(qid)
                if not info:
                    # fetch individually if not in our entity_data (beat QID not from article links)
                    info_list = fetch_entity_data([qid])
                    info = info_list.get(qid, {"label": qid, "p31s": [], "year": None,
                                               "month": None, "day": None,
                                               "lat": None, "lng": None,
                                               "loc_qid": None, "loc_level": None,
                                               "wp_title": None})
                print(f"  Importing: {qid} — {info.get('label', '?')}")
                import_event(conn, qid, info, anchor_qid)
        finally:
            conn.close()
    else:
        print("  [dry-run] Skipping DB import")

    # ── Build and write story JSON ───────────────────────────────────────────
    # Derive year_start from the first beat that has a date
    first_year = next((int(b["date"][:4]) for b in beats if b.get("date")), None)

    story = {
        "id":           slug,
        "slug":         slug,
        "anchor_qid":   anchor_qid,
        "detail_level": args.detail_level,
        "title":        wp_title,
        "year_start":   first_year,
        "beats":        beats,
        "generated_from": "wikipedia+claude",
        "status":       "draft",
    }

    if args.dry_run:
        print("\n[dry-run] Story JSON:")
        print(json.dumps(story, indent=2, ensure_ascii=False)[:3000])
        print("...")
        return

    STORIES_DIR.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(story, indent=2, ensure_ascii=False))
    print(f"\n✓ Written to {output_path}")

    print("\nFirst 3 beats:")
    for beat in beats[:3]:
        qid_label = beat.get("event_qid") or "(narrative-only)"
        date_str  = beat.get("date", "?")
        print(f"  [{beat['sequence']}] {date_str} — {beat.get('event_title','')} [{qid_label}]")
        print(f"       {beat['narrative_text'][:100]}...")


if __name__ == "__main__":
    main()
