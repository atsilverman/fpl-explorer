#!/usr/bin/env python3
"""
Post–kickoff-wave Statistics rebuild trigger.

When every fixture in a kickoff wave (same-time / near-same KO set) in the active
gameweek has finished, wait a short settling buffer, then run build.py once per
(gw, matchday, wave). Simultaneous kickoffs share one wave so we do not rebuild
once per fixture.

Designed for GitHub Actions. Scheduled runs are often dropped, so --watch
stays up on a matchday and rechecks every 20 minutes instead of depending on
the next cron. A quiet poll still exits immediately.

Run:
    python3 site/matchday_rebuild.py              # check + rebuild if ready
    python3 site/matchday_rebuild.py --dry-run    # print decision only
    python3 site/matchday_rebuild.py --commit     # rebuild + git commit/push
    python3 site/matchday_rebuild.py --commit --watch  # stay up through a matchday
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TypedDict
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
DEFAULT_SETTLE_MINUTES = 20
DEFAULT_MATCH_DURATION_MINUTES = 105
# Fixtures whose kickoffs are within this gap of the wave's first KO stay one wave.
WAVE_GAP_MINUTES = 15
# First GW where post-match GHA rebuilds run (GW1 handled manually).
AUTOMATION_START_GW = 2
FETCH_ATTEMPTS = 3
FETCH_BACKOFF_SECONDS = (5, 15)
PUSH_ATTEMPTS = 3
# Stay awake when an unrebuilt wave kicks off inside this window.
WATCH_HORIZON_HOURS = 6
# Kickoff this long ago and still not FT: postponed or a missing status.
STUCK_FIXTURE_HOURS = 3
# Just under the workflow job cap (355 min) so the last check can finish.
DEFAULT_WATCH_MINUTES = 330
DEFAULT_INTERVAL_MINUTES = 20

sys.path.insert(0, str(SITE))
from fpl_gameweeks import active_gameweek_id, extract_gameweeks  # noqa: E402
from live_scoring import fixture_is_finished  # noqa: E402


class KickoffWave(TypedDict):
    matchday: str
    wave: str
    fixtures: list[dict]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def generated_at() -> str:
    return utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")


def _fpl_get_once(path: str) -> dict | list:
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


def _fetch_detail(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return f"HTTP {exc.code} {exc.reason}"
    return str(exc)


def fpl_get(path: str) -> dict | list:
    """GET an FPL path, retrying transient HTTP and network failures."""
    last_exc: BaseException | None = None
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        try:
            return _fpl_get_once(path)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, RuntimeError) as exc:
            if isinstance(exc, urllib.error.HTTPError):
                exc.close()
            last_exc = exc
            print(
                f"FPL {path} attempt {attempt}/{FETCH_ATTEMPTS} failed: {_fetch_detail(exc)}",
                file=sys.stderr,
            )
            if attempt < FETCH_ATTEMPTS:
                time.sleep(FETCH_BACKOFF_SECONDS[attempt - 1])
    raise RuntimeError(f"FPL {path} failed after {FETCH_ATTEMPTS} attempts: {last_exc}")


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


def wave_key_uk(kickoff: datetime) -> str:
    """UK-local kickoff stamp for the wave's first fixture (YYYY-MM-DDTHH:MM)."""
    return kickoff.astimezone(MATCHDAY_TZ).strftime("%Y-%m-%dT%H:%M")


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


def gw_fixtures_with_kickoff(fixtures: list[dict], gw: int) -> list[tuple[datetime, dict]]:
    rows: list[tuple[datetime, dict]] = []
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
        rows.append((kickoff, fx))
    rows.sort(key=lambda item: (item[0], int(item[1].get("id") or 0)))
    return rows


def group_gw_fixtures_by_kickoff_wave(
    fixtures: list[dict], gw: int, *, gap_minutes: int = WAVE_GAP_MINUTES
) -> list[KickoffWave]:
    """
    Cluster active-GW fixtures into kickoff waves.

    Sort by kickoff; start a new wave when a fixture's kickoff is more than
    gap_minutes after the first kickoff of the current wave. Same-time games
    share one wave (12:30 / 15:00 / 17:30 → three waves).
    """
    rows = gw_fixtures_with_kickoff(fixtures, gw)
    if not rows:
        return []

    gap = timedelta(minutes=max(1, gap_minutes))
    waves: list[KickoffWave] = []
    wave_start: datetime | None = None
    wave_fixtures: list[dict] = []

    def flush() -> None:
        nonlocal wave_start, wave_fixtures
        if wave_start is None or not wave_fixtures:
            wave_start = None
            wave_fixtures = []
            return
        waves.append(
            {
                "matchday": matchday_key_uk(wave_start),
                "wave": wave_key_uk(wave_start),
                "fixtures": list(wave_fixtures),
            }
        )
        wave_start = None
        wave_fixtures = []

    for kickoff, fx in rows:
        if wave_start is None:
            wave_start = kickoff
            wave_fixtures = [fx]
            continue
        if kickoff - wave_start > gap:
            flush()
            wave_start = kickoff
            wave_fixtures = [fx]
        else:
            wave_fixtures.append(fx)
    flush()
    return waves


def wave_all_finished(wave_fixtures: list[dict]) -> bool:
    return bool(wave_fixtures) and all(fixture_is_finished(fx) for fx in wave_fixtures)


def wave_settled(wave_fixtures: list[dict], *, settle_minutes: int, now: datetime) -> bool:
    ends = [fixture_end_utc(fx) for fx in wave_fixtures]
    ends = [t for t in ends if t is not None]
    if len(ends) != len(wave_fixtures):
        return False
    latest_end = max(ends)
    return now >= latest_end + timedelta(minutes=settle_minutes)


def load_state() -> dict:
    base = {"automationStartGw": AUTOMATION_START_GW, "rebuilt": []}
    if not STATE_PATH.exists():
        return base
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return base
    if not isinstance(data, dict):
        return base
    rebuilt = data.get("rebuilt")
    if not isinstance(rebuilt, list):
        rebuilt = []
    try:
        start_gw = int(data.get("automationStartGw") or AUTOMATION_START_GW)
    except (TypeError, ValueError):
        start_gw = AUTOMATION_START_GW
    out = {"automationStartGw": start_gw, "rebuilt": rebuilt}
    if data.get("note"):
        out["note"] = data["note"]
    return out


def save_state(state: dict) -> None:
    SNAPSHOTS.mkdir(exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def _row_wave(row: dict) -> str:
    raw = row.get("wave")
    if raw is None or raw == "":
        return ""
    return str(raw)


def already_rebuilt(state: dict, gw: int, matchday: str, wave: str) -> bool:
    """
    True if this kickoff wave was rebuilt, or a legacy whole-matchday row exists
    for the same (gw, matchday) with no wave key.
    """
    for row in state.get("rebuilt") or []:
        if not isinstance(row, dict):
            continue
        try:
            if int(row.get("gw") or 0) != gw:
                continue
            if str(row.get("matchday") or "") != matchday:
                continue
        except (TypeError, ValueError):
            continue
        row_wave = _row_wave(row)
        if not row_wave:
            # Legacy day-level mark covers every wave that day.
            return True
        if row_wave == wave:
            return True
    return False


def wave_sort_key(matchday: str, wave: str) -> tuple[str, str]:
    return (matchday, wave)


def mark_rebuilt_for_gw_through_wave(
    state: dict,
    gw: int,
    through: KickoffWave,
    waves: list[KickoffWave],
    *,
    settle_minutes: int,
    now: datetime,
) -> None:
    """
    One build covers all settled waves up to `through` — mark those done.

    Unfinished later (or earlier postponed) waves are left unmarked.
    """
    ts = generated_at()
    through_key = wave_sort_key(through["matchday"], through["wave"])

    def row_covered(row: dict) -> bool:
        try:
            if int(row.get("gw") or 0) != gw:
                return False
        except (TypeError, ValueError):
            return False
        md = str(row.get("matchday") or "")
        rw = _row_wave(row)
        if not rw:
            # Drop legacy day rows on/before through's matchday so wave rows replace them.
            return bool(md) and md <= through["matchday"]
        return wave_sort_key(md, rw) <= through_key

    rebuilt = [
        r
        for r in (state.get("rebuilt") or [])
        if isinstance(r, dict) and not row_covered(r)
    ]
    for w in waves:
        key = wave_sort_key(w["matchday"], w["wave"])
        if key > through_key:
            break
        if not wave_all_finished(w["fixtures"]):
            continue
        if not wave_settled(w["fixtures"], settle_minutes=settle_minutes, now=now):
            continue
        rebuilt.append(
            {
                "gw": gw,
                "matchday": w["matchday"],
                "wave": w["wave"],
                "rebuiltAt": ts,
            }
        )
    state["rebuilt"] = rebuilt[-120:]
    save_state(state)


def find_pending_wave(
    waves: list[KickoffWave],
    gw: int,
    state: dict,
    *,
    settle_minutes: int,
    now: datetime,
) -> KickoffWave | None:
    """Latest settled kickoff wave in the GW that has not been rebuilt yet."""
    pending: KickoffWave | None = None
    for wave in waves:
        if already_rebuilt(state, gw, wave["matchday"], wave["wave"]):
            continue
        if not wave_all_finished(wave["fixtures"]):
            continue
        if not wave_settled(wave["fixtures"], settle_minutes=settle_minutes, now=now):
            continue
        pending = wave
    return pending


def wave_kickoff_utc(wave: KickoffWave) -> datetime | None:
    kickoffs = [parse_kickoff_utc(fx.get("kickoff_time")) for fx in wave["fixtures"]]
    kickoffs = [t for t in kickoffs if t is not None]
    if not kickoffs:
        return None
    return min(kickoffs)


def should_keep_watching(
    waves: list[KickoffWave],
    gw: int,
    state: dict,
    *,
    now: datetime,
    horizon_hours: float = WATCH_HORIZON_HOURS,
    stuck_hours: float = STUCK_FIXTURE_HOURS,
) -> bool:
    """True when an unrebuilt wave has started or kicks off within the horizon.

    A fixture that kicked off long ago and is still not finished is treated as
    stuck (postponed, or a missing full-time flag) so a runner is not held open.
    """
    horizon = now + timedelta(hours=horizon_hours)
    stuck_after = timedelta(hours=stuck_hours)
    for wave in waves:
        if already_rebuilt(state, gw, wave["matchday"], wave["wave"]):
            continue
        kickoff = wave_kickoff_utc(wave)
        if kickoff is None or kickoff > horizon:
            continue
        if not wave_all_finished(wave["fixtures"]) and now > kickoff + stuck_after:
            print(
                f"GW{gw} wave {wave['wave']} still unfinished "
                f"{stuck_hours:g}h after kickoff — not holding the runner."
            )
            continue
        return True
    return False


def run_fetch_fixtures() -> None:
    last = "fetch_fixtures failed"
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        proc = subprocess.run(
            [sys.executable, str(FETCH_FIXTURES)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0:
            if proc.stdout:
                print(proc.stdout, end="" if proc.stdout.endswith("\n") else "\n")
            return
        last = (proc.stderr or proc.stdout or last).strip()[-800:]
        print(
            f"fixtures snapshot attempt {attempt}/{FETCH_ATTEMPTS} failed: {last}",
            file=sys.stderr,
        )
        if attempt < FETCH_ATTEMPTS:
            time.sleep(FETCH_BACKOFF_SECONDS[attempt - 1])
    raise RuntimeError(last)


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


def git_commit_push(gw: int, wave: str) -> bool:
    subprocess.run(["git", "config", "user.name", "github-actions[bot]"], check=False)
    subprocess.run(
        ["git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
        check=False,
    )
    subprocess.run(["git", "add", "site/data.js", "site/index.html", "snapshots", "reports"], check=True)
    if subprocess.run(["git", "diff", "--staged", "--quiet"]).returncode == 0:
        print("No file changes to commit.")
        return False
    before = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    msg = f"Rebuild Statistics after GW{gw} kickoff wave {wave}.\n"
    subprocess.run(["git", "commit", "-m", msg], check=True)
    try:
        _push_with_rebase()
    except subprocess.CalledProcessError:
        subprocess.run(["git", "reset", "--hard", before], check=False)
        raise
    return True


def _push_with_rebase() -> None:
    """Push, rebasing onto origin/main when another workflow moved the branch."""
    last_code = 1
    for attempt in range(1, PUSH_ATTEMPTS + 1):
        proc = subprocess.run(["git", "push"])
        if proc.returncode == 0:
            return
        last_code = proc.returncode
        print(
            f"Push rejected (attempt {attempt}/{PUSH_ATTEMPTS}) — rebasing onto origin/main.",
            file=sys.stderr,
        )
        pull = subprocess.run(["git", "pull", "--rebase", "origin", "main"])
        if pull.returncode != 0:
            print("Rebase failed — aborting rebase.", file=sys.stderr)
            subprocess.run(["git", "rebase", "--abort"], check=False)
            raise subprocess.CalledProcessError(pull.returncode, pull.args)
    raise subprocess.CalledProcessError(last_code, ["git", "push"])


class Poll(TypedDict):
    status: str  # ok, transient, error
    watch: bool
    message: str


def _poll(status: str, watch: bool, message: str) -> Poll:
    return {"status": status, "watch": watch, "message": message}


def _state_text() -> str | None:
    if not STATE_PATH.exists():
        return None
    return STATE_PATH.read_text(encoding="utf-8")


def _restore_state(text: str | None) -> None:
    if text is None:
        if STATE_PATH.exists():
            STATE_PATH.unlink()
        return
    STATE_PATH.write_text(text, encoding="utf-8")


def one_pass(args: argparse.Namespace) -> Poll:
    """One check. Rebuilds a settled wave when one is waiting."""
    try:
        bootstrap = fpl_get("/bootstrap-static/")
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, json.JSONDecodeError, TimeoutError) as exc:
        return _poll("transient", False, f"bootstrap fetch failed: {exc}")
    if not isinstance(bootstrap, dict):
        return _poll("error", False, "unexpected bootstrap payload")

    gws = extract_gameweeks(bootstrap, source="bootstrap")
    gw = active_gameweek_id(gws)
    if gw is None:
        return _poll("ok", False, "No active gameweek — skip.")

    state = load_state()
    start_gw = int(state.get("automationStartGw") or AUTOMATION_START_GW)
    if gw < start_gw:
        return _poll("ok", False, f"GW{gw} is before automation start (GW{start_gw}) — skip.")

    try:
        if not args.dry_run:
            run_fetch_fixtures()
        fixtures = fpl_get("/fixtures/")
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, json.JSONDecodeError, TimeoutError) as exc:
        return _poll("transient", False, f"fixtures fetch failed: {exc}")
    if not isinstance(fixtures, list):
        return _poll("error", False, "unexpected fixtures payload")

    now = utc_now()
    settle_minutes = max(5, args.settle_minutes)
    waves = group_gw_fixtures_by_kickoff_wave(fixtures, gw)
    watch = should_keep_watching(waves, gw, state, now=now)
    pending = find_pending_wave(
        waves,
        gw,
        state,
        settle_minutes=settle_minutes,
        now=now,
    )
    if not pending:
        return _poll("ok", watch, f"GW{gw}: no settled kickoff wave pending rebuild.")

    wave_fixtures = pending["fixtures"]
    ids = sorted(int(fx["id"]) for fx in wave_fixtures if fx.get("id") is not None)
    print(
        f"GW{gw} kickoff wave {pending['wave']}: {len(wave_fixtures)} fixtures finished — "
        f"rebuild ready (fixtures {ids})."
    )

    if args.dry_run:
        return _poll("ok", False, "Dry run — skip build.")

    try:
        run_build()
    except RuntimeError as exc:
        return _poll("error", watch, f"build failed: {exc}")
    bump_data_js_cache()

    if args.commit:
        # Record the wave before committing so the state file ships in the same
        # commit — otherwise CI never sees it and rebuilds this wave every poll.
        previous_state = _state_text()
        mark_rebuilt_for_gw_through_wave(
            state, gw, pending, waves, settle_minutes=settle_minutes, now=now
        )
        watch_after = should_keep_watching(waves, gw, state, now=now)
        try:
            if git_commit_push(gw, pending["wave"]):
                return _poll("ok", watch_after, "Committed and pushed.")
            return _poll("ok", watch_after, "No file changes to commit.")
        except subprocess.CalledProcessError:
            _restore_state(previous_state)
            return _poll("error", watch, "Git commit/push failed.")

    mark_rebuilt_for_gw_through_wave(
        state, gw, pending, waves, settle_minutes=settle_minutes, now=now
    )
    watch_after = should_keep_watching(waves, gw, state, now=now)
    return _poll("ok", watch_after, "Rebuild complete (local only — pass --commit to push).")


def _report(poll: Poll) -> None:
    stream = sys.stderr if poll["status"] != "ok" else sys.stdout
    print(poll["message"], file=stream)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Rebuild Statistics after a GW kickoff wave completes."
    )
    parser.add_argument("--dry-run", action="store_true", help="Print decision only; no build or writes.")
    parser.add_argument("--commit", action="store_true", help="Git commit and push after rebuild.")
    parser.add_argument(
        "--watch",
        action="store_true",
        help="On a matchday, recheck until the watch window ends or nothing is left ahead.",
    )
    parser.add_argument(
        "--watch-minutes",
        type=int,
        default=DEFAULT_WATCH_MINUTES,
        help=f"Max minutes to stay up with --watch (default {DEFAULT_WATCH_MINUTES}).",
    )
    parser.add_argument(
        "--interval-minutes",
        type=int,
        default=DEFAULT_INTERVAL_MINUTES,
        help=f"Minutes between --watch checks (default {DEFAULT_INTERVAL_MINUTES}).",
    )
    parser.add_argument(
        "--settle-minutes",
        type=int,
        default=DEFAULT_SETTLE_MINUTES,
        help=f"Wait this long after last FT in the wave before rebuild (default {DEFAULT_SETTLE_MINUTES}).",
    )
    args = parser.parse_args()

    if not args.watch or args.dry_run:
        poll = one_pass(args)
        _report(poll)
        return 0 if poll["status"] == "ok" else 1

    deadline = time.monotonic() + max(1, args.watch_minutes) * 60
    interval = max(1, args.interval_minutes) * 60
    watching = False
    consecutive_failures = 0
    while True:
        poll = one_pass(args)
        _report(poll)
        if poll["status"] == "ok":
            consecutive_failures = 0
            if not poll["watch"]:
                print("No unrebuilt wave inside the watch horizon — done.")
                return 0
        else:
            consecutive_failures += 1
            if poll["status"] == "transient" and not watching:
                print("::warning::FPL fetch failed after retries — skipping this run.")
                return 0
            if consecutive_failures >= 3 or (poll["status"] == "error" and not poll["watch"]):
                return 1
        watching = True
        remaining = deadline - time.monotonic()
        if remaining < interval:
            print("Watch window ended with a kickoff wave still ahead.")
            print("WATCH_CONTINUE=1")
            return 0
        sleep_s = int(min(interval, remaining))
        print(f"Sleeping {sleep_s}s until the next check.")
        time.sleep(sleep_s)


if __name__ == "__main__":
    raise SystemExit(main())
