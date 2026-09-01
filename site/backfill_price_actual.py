#!/usr/bin/env python3
"""One-off / manual backfill of actual price changes from bootstrap snapshots."""
from __future__ import annotations

import argparse
import sys

from price_changes_lib import backfill_actual_changes_from_snapshots, rebuild_price_changes_bundle


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Replace actual-changes.json instead of appending new events only.",
    )
    parser.add_argument(
        "--no-rebuild",
        action="store_true",
        help="Skip rebuilding site/price_changes_data.js.",
    )
    parser.add_argument(
        "--no-focal",
        action="store_true",
        help="Skip FPL Focal tweet date reattribution.",
    )
    args = parser.parse_args()

    stats = backfill_actual_changes_from_snapshots(
        replace=args.replace,
        use_focal=not args.no_focal,
    )
    print(
        f"Backfill: {stats['pairs']} snapshot pair(s) with changes, "
        f"{stats['events']} event(s), {stats['saved']} saved, "
        f"{stats.get('snapshotAdjusted', 0)} snapshot date fix(es), "
        f"{stats.get('focalAdjusted', 0)} focal date fix(es)."
    )
    if not args.no_rebuild:
        rebuild_price_changes_bundle()
        print("Rebuilt site/price_changes_data.js")
    return 0


if __name__ == "__main__":
    sys.exit(main())
