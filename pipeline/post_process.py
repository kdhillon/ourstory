#!/usr/bin/env python3
"""
pipeline/post_process.py

Runs the full post-pipeline sequence after a pipeline pass:

  1. cleanup-non-settlements  — reclassify/delete bad location types
  2. assign-categories        — rule-based P31 category assignment
  3. backfill-part-of         — fetch P361 for events missing it
  4. backfill-city-summaries  — fetch Wikipedia summaries for locations missing them
  5. backfill-sitelinks       — fetch sitelinks count for zoom-based importance filtering
  6. export GeoJSON           — write frontend/public/data/seed.geojson

Usage:
    python3 -m pipeline.post_process          # standalone
    python3 -m pipeline.post_process --skip-backfills
    python3 -m pipeline.post_process --dry-run
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
SCRIPTS = ROOT / "scripts"

_ENV = {**os.environ, "PYTHONPATH": str(ROOT)}


def run(label: str, cmd: list[str], dry_run: bool = False) -> bool:
    print(f"\n{'='*60}")
    print(f"  {label}")
    print(f"{'='*60}")
    if dry_run:
        print(f"  [DRY RUN] would run: {' '.join(cmd)}")
        return True
    result = subprocess.run(cmd, cwd=ROOT, env=_ENV)
    if result.returncode != 0:
        print(f"\nERROR: '{label}' exited with code {result.returncode}", file=sys.stderr)
        return False
    return True


def main():
    parser = argparse.ArgumentParser(description="OpenHistory post-pipeline processing")
    parser.add_argument("--skip-backfills", action="store_true",
                        help="Skip backfill-part-of, backfill-city-summaries, and backfill-sitelinks")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would run without executing")
    args = parser.parse_args()

    py = sys.executable
    steps = [
        ("Cleanup non-settlement locations",
         [py, str(SCRIPTS / "cleanup-non-settlements.py")]),
        ("Assign categories (rule-based P31 mapping)",
         [py, str(SCRIPTS / "assign-categories.py")]),
    ]

    if not args.skip_backfills:
        steps += [
            ("Backfill P361 (part-of) for existing events",
             [py, str(SCRIPTS / "backfill-part-of.py")]),
            ("Backfill Wikipedia summaries for locations",
             [py, str(SCRIPTS / "backfill-city-summaries.py")]),
            ("Backfill Wikidata sitelinks count for events",
             [py, str(SCRIPTS / "backfill-sitelinks.py")]),
        ]

    steps.append(
        ("Export GeoJSON",
         [py, str(SCRIPTS / "export_geojson.py")])
    )

    print(f"\nRunning {len(steps)} post-pipeline step(s)...")
    for label, cmd in steps:
        ok = run(label, cmd, dry_run=args.dry_run)
        if not ok:
            print("\nPost-processing aborted.", file=sys.stderr)
            sys.exit(1)

    print("\n\nPost-processing complete.")


if __name__ == "__main__":
    main()
