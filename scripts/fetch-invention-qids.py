#!/usr/bin/env python3
"""
Fetch Wikidata QIDs for inventions via Wikipedia's "Inventions by century" categories.

Wikipedia's curated invention categories are cleaner and more reliable than
Wikidata's P31/P279* hierarchy for Q4026292 (which times out on WDQS).

Usage:
    python3 scripts/fetch-invention-qids.py [--output FILE] [--dry-run]

Output: one QID per line, written to FILE (default: /tmp/invention_qids.txt)
Then run the pipeline with:
    source .env && python3 -m pipeline.run_local --qid-file /tmp/invention_qids.txt
"""

import argparse
import time
import requests

WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php"
WIKIDATA_API  = "https://www.wikidata.org/w/api.php"

# Wikipedia categories to harvest — human-curated, each item is a real invention
ROOT_CATEGORIES = [
    "Category:Inventions by century",
]

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "OpenHistory/1.0 (openhistory.app)"})


def get_subcategories(category: str) -> list[str]:
    """Return direct subcategory titles of a Wikipedia category."""
    params = {
        "action": "query",
        "list": "categorymembers",
        "cmtitle": category,
        "cmtype": "subcat",
        "cmlimit": 500,
        "format": "json",
    }
    resp = SESSION.get(WIKIPEDIA_API, params=params, timeout=15)
    resp.raise_for_status()
    return [m["title"] for m in resp.json()["query"]["categorymembers"]]


def get_category_pages(category: str) -> list[str]:
    """Return all article titles in a Wikipedia category (handles pagination)."""
    titles = []
    params = {
        "action": "query",
        "list": "categorymembers",
        "cmtitle": category,
        "cmtype": "page",
        "cmlimit": 500,
        "format": "json",
    }
    while True:
        resp = SESSION.get(WIKIPEDIA_API, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        titles.extend(m["title"] for m in data["query"]["categorymembers"])
        if "continue" not in data:
            break
        params["cmcontinue"] = data["continue"]["cmcontinue"]
    return titles


def titles_to_qids(titles: list[str]) -> dict[str, str]:
    """Convert Wikipedia article titles to Wikidata QIDs via wbgetentities."""
    qid_map = {}
    batch_size = 50  # wbgetentities limit
    for i in range(0, len(titles), batch_size):
        batch = titles[i : i + batch_size]
        params = {
            "action": "wbgetentities",
            "sites": "enwiki",
            "titles": "|".join(batch),
            "props": "info",
            "format": "json",
        }
        resp = SESSION.get(WIKIDATA_API, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        for entity in data.get("entities", {}).values():
            qid = entity.get("id", "")
            if qid and not qid.startswith("-"):  # -1 = not found
                title = entity.get("sitelinks", {})  # not in 'info' props; use id only
                qid_map[qid] = qid
        time.sleep(0.1)
    return qid_map


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", default="/tmp/invention_qids.txt", help="Output file path")
    parser.add_argument("--dry-run", action="store_true", help="Print QIDs to stdout only")
    args = parser.parse_args()

    print("Fetching invention categories from Wikipedia...")

    # Step 1: get century subcategories from the root
    all_categories: list[str] = []
    for root in ROOT_CATEGORIES:
        subs = get_subcategories(root)
        print(f"  {root} → {len(subs)} subcategories")
        all_categories.extend(subs)

    print(f"\nFetching articles from {len(all_categories)} categories...")

    # Step 2: collect all article titles
    all_titles: list[str] = []
    for cat in sorted(all_categories):
        pages = get_category_pages(cat)
        print(f"  {cat}: {len(pages)} articles")
        all_titles.extend(pages)
        time.sleep(0.2)

    unique_titles = list(dict.fromkeys(all_titles))  # deduplicate, preserve order
    print(f"\n{len(unique_titles)} unique article titles (from {len(all_titles)} total)")

    # Step 3: convert to Wikidata QIDs
    print("\nLooking up Wikidata QIDs...")
    qid_map: dict[str, str] = {}
    batch_size = 50
    found = 0
    not_found = 0
    for i in range(0, len(unique_titles), batch_size):
        batch = unique_titles[i : i + batch_size]
        params = {
            "action": "wbgetentities",
            "sites": "enwiki",
            "titles": "|".join(batch),
            "props": "info",
            "format": "json",
        }
        resp = SESSION.get(WIKIDATA_API, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        for entity in data.get("entities", {}).values():
            qid = entity.get("id", "")
            if qid and not qid.startswith("-"):
                qid_map[qid] = qid
                found += 1
            else:
                not_found += 1
        if (i // batch_size) % 5 == 4:
            print(f"  {i + len(batch)}/{len(unique_titles)} processed...")
        time.sleep(0.1)

    qids = sorted(qid_map.keys())
    print(f"\nResults: {found} QIDs found, {not_found} articles had no Wikidata item")

    if args.dry_run:
        print("\n--- QIDs (dry run) ---")
        for q in qids:
            print(q)
        return

    with open(args.output, "w") as f:
        for q in qids:
            f.write(q + "\n")

    print(f"\nWrote {len(qids)} QIDs to {args.output}")
    print(f"\nNext step:")
    print(f"  source .env && python3 -m pipeline.run_local --qid-file {args.output}")


if __name__ == "__main__":
    main()
