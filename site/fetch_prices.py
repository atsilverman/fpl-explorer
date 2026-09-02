#!/usr/bin/env python3
"""
4-hour FPL price-change check-ins → site/price_changes_data.js.

Fetches bootstrap-static, writes snapshots/price-changes/price-changes_*.json,
prunes check-ins older than 4 days, rebuilds bundle with 3-day progress sparklines.

Run:
    python3 site/fetch_prices.py
    python3 site/fetch_prices.py --rebuild-only
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

from price_changes_lib import (
    FPL_BOOTSTRAP,
    PRICE_CHANGES_DIR,
    PRICES_OUT_PATH,
    ROOT,
    UA,
    checkin_filename,
    checkin_stamp,
    pending_change_night_uk,
    poll_actual_changes_from_bootstrap,
    prune_old_checkins,
    rebuild_price_changes_bundle,
    slim_price_checkin,
)


def fetch_bootstrap() -> dict:
    req = urllib.request.Request(
        FPL_BOOTSTRAP,
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        raw = resp.read().decode("utf-8")
    data = json.loads(raw) if raw else None
    if not isinstance(data, dict) or "elements" not in data:
        raise RuntimeError("unexpected bootstrap-static payload")
    return data


def iso_from_stamp(stamp: str) -> str:
    return f"{stamp[:10]}T{stamp[11:13]}:{stamp[13:15]}:{stamp[15:17]}Z"


def main() -> int:
    parser = argparse.ArgumentParser(description="Build FPL price-change check-in history.")
    parser.add_argument(
        "--rebuild-only",
        action="store_true",
        help="Skip live FPL fetch; rebuild from price-changes snapshots on disk.",
    )
    args = parser.parse_args()

    latest_snap = None
    latest_source = None

    if not args.rebuild_only:
        stamp = checkin_stamp()
        fname = checkin_filename(stamp)
        dest = PRICE_CHANGES_DIR / fname
        try:
            print(f"Fetching {FPL_BOOTSTRAP}")
            data = fetch_bootstrap()
            PRICE_CHANGES_DIR.mkdir(parents=True, exist_ok=True)
            checked_at = iso_from_stamp(stamp)
            row = slim_price_checkin(data, checked_at, fname)
            dest.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
            n = len(row.get("players") or [])
            print(f"Wrote {dest.relative_to(ROOT)} ({n} movers)")
            latest_snap = data
            latest_source = fname
            night = pending_change_night_uk()
            if night:
                added, recorded_night, events = poll_actual_changes_from_bootstrap(data)
                if events:
                    print(
                        f"Catch-up: recorded {added} actual change(s)"
                        f" for UK night {recorded_night}"
                    )
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, RuntimeError) as exc:
            print(f"Live fetch failed ({exc}); rebuilding from existing check-ins.", file=sys.stderr)

    removed = prune_old_checkins()
    if removed:
        print(f"Pruned {removed} price check-in(s) older than retention window")

    payload = rebuild_price_changes_bundle(latest_snap=latest_snap, latest_source=latest_source)
    if not payload:
        print("No price check-ins in snapshots/price-changes/.", file=sys.stderr)
        return 1

    n_ci = len(payload.get("checkIns") or [])
    n_pr = len(payload.get("players") or [])
    print(
        f"Wrote {PRICES_OUT_PATH.relative_to(ROOT)}: {n_ci} check-in{'s' if n_ci != 1 else ''},"
        f" {n_pr} movers (from {payload.get('source')})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
