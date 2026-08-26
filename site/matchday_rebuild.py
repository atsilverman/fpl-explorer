#!/usr/bin/env python3
"""
Post-matchday Statistics rebuild trigger.

When every fixture on a UK calendar matchday in the active gameweek has finished,
wait a short settling buffer, then run build.py once per (gw, matchday).

Designed for GitHub Actions polling (cheap no-op when nothing to do).

Run:
    python3 site/matchday_rebuild.py              # check + rebuild if ready
    python3 site/matchday_rebuild.py --dry-run    # print decision only
    python3 site/matchday_rebuild.py --commit     # rebuild + git commit/push
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent
SNAPSHOTS = ROOT / "snapshots"
STATE_PATH = SNAPSHOTS / "matchday_rebuild_state.json"
INDEX_PATH = SITE / "index.html"
BUILD_SCRIPT = SITE / "build.py"
FETCH_FIXTURES = SITE / "fetch_fixtures.py"

FPL_BASE = "https://fantasy.premierleague.com/api"
UA = "fpl-explorer/1.0 (+matchday-rebuild)"
MATCHDAY_TZ = ZoneInfo("Europe/London")
DEFAULT_SETTLE_MINUTES = 45
DEFAULT_MATCH_DURATION_MINUTES = 105

sys.path.insert(0, str(SITE))
from fpl_gameweeks import active_gameweek_id, extract_gameweeks  # noqa: E402
from live_scoring import fixture_is_finished  # noqa: E402


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def generated_at() -> str:
    return utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")


def fpl_get(path: str) -> dict | list:
    url = f"{FPL_BASE}{path}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        raw = resp.read().decode("utf-8")
    data = json.loads(raw) if raw else None
    if data is None:
        raise RuntimeError(f"empty payload from {path}")
    return data


def parse_kickoff_utc(iso: str | None) -> datetime | None:
    if not iso or not isinstance(iso, str):
        return None
    raw = iso.strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def matchday_key_uk(kickoff: datetime) -> str:
    return kickoff.astimezone(MATCHDAY_TZ).strftime("%Y-%m-%d")


def fixture_end_utc(fx: dict) -> datetime | None:
    """Best-estimate UTC when a fixture ended (for settling buffer)."""
    kickoff = parse_kickoff_utc(fx.get("kickoff_time"))
    if kickoff is None:
        return None
    if not fixture_is_finished(fx):
        return None
    try:
        mins = int(fx.get("minutes") or 0)
    except (TypeError, ValueError):
        mins = 0
    played = max(mins, DEFAULT_MATCH_DURATION_MINUTES if mins <= 0 else mins)
    return kickoff + timedelta(minutes=played)


def group_gw_fixtures_by_matchday(fixtures: list[dict], gw: int) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    for fx in fixtures:
        if not isinstance(fx, dict):
            continue
        try:
            event = int(fx.get("event") or 0)
        except (TypeError, ValueError):
            continue
        if event != gw:
            continue
        kickoff = parse_kickoff_utc(fx.get("kickoff_time"))
        if kickoff is None:
            continue
        key = matchday_key_uk(kickoff)
        groups.setdefault(key, []).append(fx)
    return dict(sorted(groups.items()))


def matchday_all_finished(day_fixtures: list[dict]) -> bool:
    return bool(day_fixtures) and all(fixture_is_finished(fx) for fx in day_fixtures)


def matchday_settled(day_fixtures: list[dict], *, settle_minutes: int, now: datetime) -> bool:
    ends = [fixture_end_utc(fx) for fx in day_fixtures]
    ends = [t for t in ends if t is not None]
    if len(ends) != len(day_fixtures):
        return False
    latest_end = max(ends)
    return now >= latest_end + timedelta(minutes=settle_minutes)


def load_state() -> dict:
    if not STATE_PATH.exists():
        return {"rebuilt": []}
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"rebuilt": []}
    if not isinstance(data, dict):
        return {"rebuilt": []}
    rebuilt = data.get("rebuilt")
    if not isinstance(rebuilt, list):
        rebuilt = []
    return {"rebuilt": rebuilt}


def save_state(state: dict) -> None:
    SNAPSHOTS.mkdir(exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def already_rebuilt(state: dict, gw: int, matchday: str) -> bool:
    for row in state.get("rebuilt") or []:
        if not isinstance(row, dict):
            continue
        try:
            if int(row.get("gw") or 0) == gw and str(row.get("matchday") or "") == matchday:
                return True
        except (TypeError, ValueError):
            continue
    return False


def mark_rebuilt_for_gw_through(
    state: dict, gw: int, through_matchday: str, groups: dict[str, list[dict]]
) -> None:
    """One build covers all prior matchdays in the GW — mark them all done."""
    ts = generated_at()
    rebuilt = [
        r
        for r in (state.get("rebuilt") or [])
        if isinstance(r, dict)
        and not (int(r.get("gw") or 0) == gw and str(r.get("matchday") or "") <= through_matchday)
    ]
    for day in sorted(d for d in groups if d <= through_matchday):
        rebuilt.append({"gw": gw, "matchday": day, "rebuiltAt": ts})
    state["rebuilt"] = rebuilt[-120:]
    save_state(state)


def find_pending_matchday(
    groups: dict[str, list[dict]],
    gw: int,
    state: dict,
    *,
    settle_minutes: int,
    now: datetime,
) -> tuple[str, list[dict]] | None:
    """Latest settled matchday in the GW that has not been rebuilt yet."""
    pending: tuple[str, list[dict]] | None = None
    for matchday, day_fixtures in groups.items():
        if already_rebuilt(state, gw, matchday):
            continue
        if not matchday_all_finished(day_fixtures):
            continue
        if not matchday_settled(day_fixtures, settle_minutes=settle_minutes, now=now):
            continue
        pending = (matchday, day_fixtures)
    return pending


def run_fetch_fixtures() -> None:
    proc = subprocess.run(
        [sys.executable, str(FETCH_FIXTURES)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "fetch_fixtures failed").strip()
        raise RuntimeError(detail[-800:])


def run_build() -> None:
    proc = subprocess.run(
        [sys.executable, str(BUILD_SCRIPT)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.stdout:
        print(proc.stdout, end="" if proc.stdout.endswith("\n") else "\n")
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "build.py failed").strip()
        raise RuntimeError(detail[-800:])


def bump_data_js_cache() -> bool:
    if not INDEX_PATH.exists():
        return False
    text = INDEX_PATH.read_text(encoding="utf-8")
    pat = re.compile(r'(src="data\.js\?v=)(\d+)(")')

    def repl(m: re.Match[str]) -> str:
        return f"{m.group(1)}{int(m.group(2)) + 1}{m.group(3)}"

    new_text, n = pat.subn(repl, text)
    if n:
        INDEX_PATH.write_text(new_text, encoding="utf-8")
        print(f"Bumped data.js cache param in {INDEX_PATH.name}")
    return n > 0


def git_commit_push(gw: int, matchday: str) -> bool:
    subprocess.run(["git", "add", "site/data.js", "site/index.html", "snapshots", "reports"], check=True)
    if subprocess.run(["git", "diff", "--staged", "--quiet"]).returncode == 0:
        print("No file changes to commit.")
        return False
    msg = f"Rebuild Statistics after GW{gw} matchday {matchday}.\n"
    subprocess.run(["git", "commit", "-m", msg], check=True)
    subprocess.run(["git", "push"], check=True)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Rebuild Statistics after a GW matchday completes.")
    parser.add_argument("--dry-run", action="store_true", help="Print decision only; no build or writes.")
    parser.add_argument("--commit", action="store_true", help="Git commit and push after rebuild.")
    parser.add_argument(
        "--settle-minutes",
        type=int,
        default=DEFAULT_SETTLE_MINUTES,
        help=f"Wait this long after last FT before rebuild (default {DEFAULT_SETTLE_MINUTES}).",
    )
    args = parser.parse_args()

    try:
        bootstrap = fpl_get("/bootstrap-static/")
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, json.JSONDecodeError) as exc:
        print(f"bootstrap fetch failed: {exc}", file=sys.stderr)
        return 1
    if not isinstance(bootstrap, dict):
        print("unexpected bootstrap payload", file=sys.stderr)
        return 1

    gws = extract_gameweeks(bootstrap, source="bootstrap")
    gw = active_gameweek_id(gws)
    if gw is None:
        print("No active gameweek — skip.")
        return 0

    if args.dry_run:
        fixtures = fpl_get("/fixtures/")
        if not isinstance(fixtures, list):
            print("unexpected fixtures payload", file=sys.stderr)
            return 1
    else:
        run_fetch_fixtures()
        fixtures = fpl_get("/fixtures/")
        if not isinstance(fixtures, list):
            print("unexpected fixtures payload", file=sys.stderr)
            return 1

    state = load_state()
    now = utc_now()
    groups = group_gw_fixtures_by_matchday(fixtures, gw)
    pending = find_pending_matchday(
        groups,
        gw,
        state,
        settle_minutes=max(5, args.settle_minutes),
        now=now,
    )
    if not pending:
        print(f"GW{gw}: no settled matchday pending rebuild.")
        return 0

    matchday, day_fixtures = pending
    ids = sorted(int(fx["id"]) for fx in day_fixtures if fx.get("id") is not None)
    print(
        f"GW{gw} matchday {matchday}: {len(day_fixtures)} fixtures finished — "
        f"rebuild ready (fixtures {ids})."
    )

    if args.dry_run:
        print("Dry run — skip build.")
        return 0

    run_build()
    bump_data_js_cache()
    mark_rebuilt_for_gw_through(state, gw, matchday, groups)

    if args.commit:
        if git_commit_push(gw, matchday):
            print("Committed and pushed.")
    else:
        print("Rebuild complete (local only — pass --commit to push).")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
