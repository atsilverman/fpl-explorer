#!/usr/bin/env python3
"""
UK-midnight FPL price-change detection → snapshots/price-actual/ + bundle rebuild.

FPL applies daily price changes at 00:00 Europe/London. Run this script in a
tight window around that time:

  23:57–23:59 UK  — baseline-only (store pre-change costs)
  00:00–00:45 UK  — poll, diff vs baseline, append actual-changes log
  01:00–12:00 UK  — catch-up if a night was missed
  07:00+ UK       — --accept-quiet-night closes a truly quiet pending night

GitHub Actions runs UTC crons that map to both BST and GMT; the script no-ops
outside the UK windows unless --force.

Exit codes:
  0 — success (changes recorded, quiet night, baseline saved, or skipped)
  1 — fetch / IO error
  2 — in poll window, no diff yet (API may still be stale — retry)

Run:
    python3 site/fetch_price_actual.py
    python3 site/fetch_price_actual.py --baseline-only
    python3 site/fetch_price_actual.py --force
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import timedelta
from pathlib import Path

from price_changes_lib import (
    FPL_BOOTSTRAP,
    PRICE_CHANGES_DIR,
    PRICES_OUT_PATH,
    ROOT,
    SNAPSHOTS,
    UA,
    checkin_filename,
    checkin_stamp,
    generated_at,
    load_actual_state,
    pending_change_night_uk,
    poll_actual_changes_from_bootstrap,
    rebuild_price_changes_bundle,
    save_actual_state,
    should_run_baseline_poll,
    should_run_change_poll,
    should_accept_quiet_night,
    slim_price_checkin,
    uk_now,
    uk_today_stamp,
    update_actual_state_costs,
)

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_RETRY = 2


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


def write_bootstrap_snapshot(data: dict, day_stamp: str | None = None) -> Path:
    dest = SNAPSHOTS / f"bootstrap-static_{day_stamp or uk_today_stamp()}.json"
    SNAPSHOTS.mkdir(exist_ok=True)
    dest.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return dest


def write_slim_checkin(data: dict) -> tuple[Path, dict]:
    stamp = checkin_stamp()
    fname = checkin_filename(stamp)
    dest = PRICE_CHANGES_DIR / fname
    PRICE_CHANGES_DIR.mkdir(parents=True, exist_ok=True)
    checked_at = iso_from_stamp(stamp)
    row = slim_price_checkin(data, checked_at, fname)
    dest.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
    return dest, row


def run_change_poll(data: dict, *, final_attempt: bool = False, quiet_if_no_diff: bool = False) -> int:
    change_night = pending_change_night_uk()
    if not change_night:
        print("No pending UK price-change night")
        return EXIT_OK

    added, night, events = poll_actual_changes_from_bootstrap(
        data, change_night=change_night, quiet_if_no_diff=quiet_if_no_diff
    )
    if not events:
        if quiet_if_no_diff:
            print(f"No price changes for UK night {night}")
            return EXIT_OK
        if final_attempt:
            update_actual_state_costs(
                data,
                result="no_changes",
                change_night_uk=change_night,
                mark_night_recorded=False,
            )
            print(
                f"No diff for UK night {change_night} on final attempt"
                " — leaving night open for catch-up"
            )
            return EXIT_OK
        print("No diff yet — API may still be stale")
        return EXIT_RETRY

    dest = write_bootstrap_snapshot(data)
    checkin_path, _row = write_slim_checkin(data)
    rebuild_price_changes_bundle(latest_snap=data, latest_source=dest.name)

    print(
        f"UK night {night}: recorded {added} new actual change(s)"
        f" ({len(events)} detected this poll)"
    )
    print(f"Wrote {dest.relative_to(ROOT)}")
    print(f"Wrote {checkin_path.relative_to(ROOT)}")
    print(f"Wrote {PRICES_OUT_PATH.relative_to(ROOT)}")
    return EXIT_OK


def run_baseline_only(data: dict) -> int:
    from price_changes_lib import costs_index_from_snap

    night = (uk_now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)).strftime(
        "%Y-%m-%d"
    )
    update_actual_state_costs(data, result="baseline", change_night_uk=None)
    state = load_actual_state()
    state["baselineNightUk"] = night
    save_actual_state(state)
    n = len(costs_index_from_snap(data))
    print(f"Baseline saved ({n} players) for UK night {night}")
    return EXIT_OK


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Detect FPL actual price changes at UK midnight."
    )
    parser.add_argument(
        "--baseline-only",
        action="store_true",
        help="Store pre-midnight cost baseline only (no diff).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Run poll outside the UK midnight window (manual/debug).",
    )
    parser.add_argument(
        "--final-attempt",
        action="store_true",
        help="Last retry of the night — do not mark night complete if still no diff.",
    )
    parser.add_argument(
        "--accept-quiet-night",
        action="store_true",
        help="Morning catch-up: mark night as no-change when API still matches baseline.",
    )
    args = parser.parse_args()

    now_uk = uk_now()
    if args.baseline_only:
        if not args.force and not should_run_baseline_poll(now_uk):
            print("Outside UK baseline window (23:57–23:59); skip")
            return EXIT_OK
        mode = "baseline"
    elif args.force:
        mode = "poll"
    elif args.accept_quiet_night:
        if not should_accept_quiet_night(now_uk):
            print("Outside quiet-night window (07:00+ UK with pending night); skip")
            return EXIT_OK
        mode = "poll"
    elif should_run_baseline_poll(now_uk):
        mode = "baseline"
    elif should_run_change_poll(now_uk):
        if pending_change_night_uk(now_uk):
            mode = "poll"
        else:
            print("Price-change poll not needed; night already recorded")
            return EXIT_OK
    else:
        print("Outside UK price-change window; skip")
        return EXIT_OK

    try:
        print(f"Fetching {FPL_BOOTSTRAP}")
        data = fetch_bootstrap()
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, RuntimeError) as exc:
        print(f"Fetch failed: {exc}", file=sys.stderr)
        return EXIT_ERROR

    if mode == "baseline":
        return run_baseline_only(data)
    return run_change_poll(
        data,
        final_attempt=args.final_attempt,
        quiet_if_no_diff=args.accept_quiet_night,
    )


if __name__ == "__main__":
    raise SystemExit(main())
