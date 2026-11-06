#!/usr/bin/env python3
"""
Live Home cache server for VPS hosting (e.g. DigitalOcean).

Polls site/fetch_home.py on an adaptive interval and serves the latest payload:
  GET /api/home   → { ok, home, generatedAt }
  GET /health     → { ok, generatedAt, intervalSec, lastError }

Configure manager/league via site/home_prefs.json or env:
  FPL_HOME_MANAGER_ID, FPL_HOME_LEAGUE_ID

Run:
  python3 site/live_server.py
  python3 site/live_server.py --port 8080 --interval-live 15 --interval-idle 3600
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from fpl_gameweeks import (
    DEADLINE_POLL_LEAD_SEC,
    DEADLINE_POLL_TAIL_SEC,
    active_gameweek_id,
    deadline_poll_window_active,
    extract_gameweeks,
    next_deadline_unix,
    picks_gameweek_id,
)
from live_scoring import fixture_is_finished

SITE = Path(__file__).resolve().parent
REPO = SITE.parent
JSON_PATH = SITE / "home_data.json"
PREFS_PATH = SITE / "home_prefs.json"
FETCH_SCRIPT = SITE / "fetch_home.py"
FPL_BASE = "https://fantasy.premierleague.com/api"
UA = "Mozilla/5.0 (compatible; FPL-Explorer/1.0; +live-server)"
# Wake this many seconds before the next kickoff so the first live poll
# lands near KO instead of sleeping a blind idle hour past it.
KICKOFF_LEAD_SEC = 120
BOOTSTRAP_CACHE_SEC = 30
FIXTURES_CACHE_SEC = 30
# Re-evaluate FPL current / deadlines this often even during a long idle.
SLEEP_SLICE_SEC = 20
FIXTURE_FETCH_RETRY_SEC = 60

_bootstrap_cache: dict | None = None
_bootstrap_cache_at: float = 0.0
_fixtures_cache: dict[int, tuple[float, list]] = {}


class LiveState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.generated_at: str | None = None
        self.last_error: str | None = None
        self.last_fetch_sec: float | None = None
        self.interval_sec = 3600
        self.fetching = False
        self.poll_reason: str | None = None
        self.fpl_gw: int | None = None
        self.cache_gw: int | None = None


STATE = LiveState()
INTERVAL_LIVE_SEC = 15
INTERVAL_IDLE_SEC = 3600
# After full-time: frequent while Opta is hottest, then 10 min through Review.
REVIEW_FAST_SEC = 120
REVIEW_MID_SEC = 300
REVIEW_SLOW_SEC = 600
REVIEW_FAST_AGE_SEC = 20 * 60
REVIEW_MID_AGE_SEC = 90 * 60


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


def load_prefs() -> tuple[int | None, int | None]:
    prefs = {}
    if PREFS_PATH.exists():
        try:
            prefs = json.loads(PREFS_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            prefs = {}
    mid = os.environ.get("FPL_HOME_MANAGER_ID") or prefs.get("managerId")
    lid = os.environ.get("FPL_HOME_LEAGUE_ID") or prefs.get("leagueId")
    try:
        manager_id = int(mid) if mid is not None else None
    except (TypeError, ValueError):
        manager_id = None
    try:
        league_id = int(lid) if lid is not None else None
    except (TypeError, ValueError):
        league_id = None
    return manager_id, league_id


def load_gw_fixtures(gw: int | None) -> list[dict]:
    if not gw:
        return []
    now = time.time()
    cached = _fixtures_cache.get(int(gw))
    if cached and now - cached[0] < FIXTURES_CACHE_SEC:
        return cached[1]
    try:
        fixtures_raw = fpl_get(f"/fixtures/?event={gw}")
        fixtures = fixtures_raw if isinstance(fixtures_raw, list) else []
        if fixtures:
            _fixtures_cache[int(gw)] = (now, fixtures)
            return fixtures
        return cached[1] if cached else []
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, json.JSONDecodeError):
        return cached[1] if cached else []


def load_timing_fixtures(gw: int | None) -> list[dict]:
    """Fixtures for poll timing: active GW plus the next GW if it is distinct.

    Loading the next event means we still wake for its deadline / first kickoff
    even if Home cache is sitting on a settled previous GW.
    """
    seen: set[int] = set()
    out: list[dict] = []
    gws = load_bootstrap_gameweeks()
    ids: list[int] = []
    if gw:
        ids.append(int(gw))
    for key in ("current", "next"):
        row = gws.get(key) or {}
        try:
            eid = int(row.get("id"))
        except (TypeError, ValueError, AttributeError):
            continue
        if eid > 0:
            ids.append(eid)
    for eid in ids:
        if eid in seen:
            continue
        seen.add(eid)
        out.extend(load_gw_fixtures(eid))
    return out


def fixture_in_play_for_poll(fx: dict | None) -> bool:
    """True while /fixtures/ may still receive live stat updates.

    Do not treat fixture minutes ≥ 90 as finished here — FPL often keeps
    `finished` false through stoppage time and `finished_provisional` while
    element minutes and bonus still tick up.
    """
    if not fx or not isinstance(fx, dict):
        return False
    if fx.get("finished"):
        return False
    return bool(fx.get("started") or fx.get("finished_provisional"))


def fixtures_have_live_action(fixtures: list[dict]) -> bool:
    return any(fixture_in_play_for_poll(fx) for fx in fixtures)


def fixtures_have_completed(fixtures: list[dict]) -> bool:
    return any(fixture_is_finished(fx) for fx in fixtures)


def cached_home_gw() -> int | None:
    payload = read_home_payload()
    if not payload:
        return None
    try:
        gw = int(payload.get("gw"))
    except (TypeError, ValueError):
        return None
    return gw if gw > 0 else None


def home_gw_settled_cached(active_gw: int | None = None) -> bool:
    payload = read_home_payload()
    if not payload or payload.get("gwSettled") is not True:
        return False
    if active_gw is None:
        return True
    try:
        return int(payload.get("gw") or 0) == int(active_gw)
    except (TypeError, ValueError):
        return False


def newest_full_time_age_sec(fixtures: list[dict], now: float | None = None) -> float | None:
    """Seconds since the most recently completed fixture's estimated full-time."""
    now_ts = time.time() if now is None else now
    newest: float | None = None
    for fx in fixtures:
        if not fixture_is_finished(fx):
            continue
        ko = parse_kickoff_unix(fx.get("kickoff_time") if isinstance(fx, dict) else None)
        if ko is None:
            continue
        try:
            mins = int(fx.get("minutes") or 0)
        except (TypeError, ValueError):
            mins = 0
        match_len = (max(mins, 90) if mins else 105) * 60
        ft = min(now_ts, ko + match_len)
        if newest is None or ft > newest:
            newest = ft
    if newest is None:
        return None
    return max(0.0, now_ts - newest)


def review_interval_sec(fixtures: list[dict], active_gw: int | None = None) -> int | None:
    """Poll cadence from first full-time through FPL lock; None if not in that window."""
    if home_gw_settled_cached(active_gw):
        return None
    if not fixtures_have_completed(fixtures):
        return None
    age = newest_full_time_age_sec(fixtures)
    if age is None:
        return REVIEW_SLOW_SEC
    if age < REVIEW_FAST_AGE_SEC:
        return REVIEW_FAST_SEC
    if age < REVIEW_MID_AGE_SEC:
        return REVIEW_MID_SEC
    return REVIEW_SLOW_SEC


def parse_kickoff_unix(iso: str | None) -> float | None:
    if not iso or not isinstance(iso, str):
        return None
    raw = iso.strip()
    if not raw:
        return None
    # FPL uses e.g. 2026-08-23T14:00:00Z
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def seconds_until_next_kickoff(fixtures: list[dict], now: float | None = None) -> float | None:
    """Seconds until the soonest not-started fixture kickoff, or None."""
    now_ts = time.time() if now is None else now
    soonest: float | None = None
    for fx in fixtures:
        if fx.get("started") or fixture_is_finished(fx):
            continue
        ko = parse_kickoff_unix(fx.get("kickoff_time") if isinstance(fx, dict) else None)
        if ko is None:
            continue
        delta = ko - now_ts
        if soonest is None or delta < soonest:
            soonest = delta
    return soonest


def load_bootstrap_gameweeks() -> dict:
    """Cached bootstrap gameweeks (short TTL for deadline polling)."""
    global _bootstrap_cache, _bootstrap_cache_at
    now = time.time()
    if _bootstrap_cache and now - _bootstrap_cache_at < BOOTSTRAP_CACHE_SEC:
        return _bootstrap_cache
    try:
        bootstrap = fpl_get("/bootstrap-static/")
        if isinstance(bootstrap, dict):
            gws = extract_gameweeks(bootstrap, source="bootstrap")
            _bootstrap_cache = gws
            _bootstrap_cache_at = now
            return gws
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, json.JSONDecodeError):
        pass
    return _bootstrap_cache or {}


def league_picks_need_poll() -> bool:
    """Poll aggressively while league picks GW is set but transfers aren't ready."""
    payload = read_home_payload()
    if not payload:
        return False
    status = payload.get("leaguePicksStatus")
    if not isinstance(status, dict):
        return False
    picks_gw = status.get("picksGw")
    if picks_gw is None:
        return False
    return not bool(status.get("transfersReady"))


def resolve_active_gw() -> int | None:
    """GW Home should track now. Uses next-GW picks after deadline, not a stale cache."""
    gws = load_bootstrap_gameweeks()
    boot_gw = picks_gameweek_id(gws) or active_gameweek_id(gws)
    if boot_gw:
        return boot_gw
    return cached_home_gw()


def cache_gw_stale() -> bool:
    """True when the on-disk Home payload is a different GW than FPL current/picks."""
    boot_gw = resolve_active_gw()
    cache_gw = cached_home_gw()
    if not boot_gw or not cache_gw:
        return False
    return int(cache_gw) != int(boot_gw)


def read_home_payload() -> dict | None:
    js_path = SITE / "home_data.js"
    candidates: list[dict] = []
    if JSON_PATH.exists():
        try:
            data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                candidates.append(data)
        except (OSError, json.JSONDecodeError):
            pass
    if js_path.exists():
        try:
            raw = js_path.read_text(encoding="utf-8")
            payload = raw.split("=", 1)[1].strip().rstrip(";")
            data = json.loads(payload)
            if isinstance(data, dict):
                candidates.append(data)
        except (OSError, json.JSONDecodeError, IndexError):
            pass
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]
    return max(candidates, key=lambda item: str(item.get("generatedAt") or ""))


def run_fetch_home(manager_id: int, league_id: int) -> tuple[bool, str | None]:
    cmd = [
        sys.executable,
        str(FETCH_SCRIPT),
        "--manager",
        str(manager_id),
        "--league",
        str(league_id),
    ]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(REPO),
            capture_output=True,
            text=True,
            timeout=180,
        )
    except subprocess.TimeoutExpired:
        return False, "fetch_home timed out"
    except OSError as exc:
        return False, str(exc)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "fetch_home failed").strip()
        return False, detail[-500:]
    payload = read_home_payload()
    if not payload:
        return False, "home_data.json missing after fetch"
    return True, None


def maybe_trigger_refresh_if_stale() -> None:
    """Kick off a background fetch when clients hit a payload that should already be live."""
    with STATE.lock:
        if STATE.fetching:
            return
    interval, reason = compute_interval(INTERVAL_LIVE_SEC, INTERVAL_IDLE_SEC)
    with STATE.lock:
        STATE.interval_sec = interval
        STATE.poll_reason = reason
        if STATE.fetching:
            return
        last = STATE.last_fetch_sec
        # Idle page views must not hammer FPL; urgent windows may catch a stuck daemon.
        if interval > 120 and not cache_gw_stale():
            return
        if last is not None and time.time() - last < interval:
            return
    threading.Thread(
        target=refresh_once,
        args=(INTERVAL_LIVE_SEC, INTERVAL_IDLE_SEC),
        daemon=True,
        name="home-refresh-stale",
    ).start()


def compute_interval(
    live_sec: int,
    idle_sec: int,
    kickoff_lead_sec: int = KICKOFF_LEAD_SEC,
) -> tuple[int, str]:
    """Return (seconds until next fetch, reason). Never rely on a settled cache GW."""
    gws = load_bootstrap_gameweeks()
    now = time.time()
    live = max(15, int(live_sec))
    idle = max(live, int(idle_sec))
    gw = resolve_active_gw()
    cache_gw = cached_home_gw()
    with STATE.lock:
        STATE.fpl_gw = gw
        STATE.cache_gw = cache_gw

    if cache_gw_stale():
        return live, f"cache-gw-{cache_gw}-behind-fpl-{gw}"
    if deadline_poll_window_active(
        gws, now, tail_sec=DEADLINE_POLL_TAIL_SEC, lead_sec=DEADLINE_POLL_LEAD_SEC
    ):
        return live, "deadline-window"
    if league_picks_need_poll():
        return live, "league-picks"

    fixtures = load_timing_fixtures(gw)
    if fixtures_have_live_action(fixtures):
        return live, "live-fixtures"
    until = seconds_until_next_kickoff(fixtures)
    if until is not None and until <= kickoff_lead_sec:
        return live, "kickoff-lead"
    nxt_dl = next_deadline_unix(gws, now)
    if nxt_dl is not None and (nxt_dl - now) <= kickoff_lead_sec:
        return live, "deadline-lead"

    review = review_interval_sec(fixtures, active_gw=gw)
    if review is not None:
        interval = max(live, int(review))
        reason = "review"
    elif not fixtures and gw:
        interval = min(idle, FIXTURE_FETCH_RETRY_SEC)
        reason = "fixtures-missing"
    else:
        interval = idle
        reason = "idle"

    wakes: list[tuple[int, str]] = []
    if until is not None:
        wakes.append((max(live, int(until) - kickoff_lead_sec), "until-kickoff"))
    if nxt_dl is not None:
        wakes.append((max(live, int(nxt_dl - now) - kickoff_lead_sec), "until-deadline"))
    for wake, wake_reason in wakes:
        if wake < interval:
            interval = wake
            reason = wake_reason
    return interval, reason


def choose_interval(live_sec: int, idle_sec: int, kickoff_lead_sec: int = KICKOFF_LEAD_SEC) -> int:
    interval, reason = compute_interval(live_sec, idle_sec, kickoff_lead_sec)
    with STATE.lock:
        STATE.poll_reason = reason
    return interval


def refresh_once(live_sec: int, idle_sec: int) -> None:
    manager_id, league_id = load_prefs()
    if not manager_id or not league_id:
        with STATE.lock:
            STATE.last_error = "No manager/league in home_prefs.json or env"
            STATE.interval_sec = idle_sec
        return

    with STATE.lock:
        if STATE.fetching:
            return
        STATE.fetching = True

    ok = False
    err: str | None = None
    try:
        ok, err = run_fetch_home(manager_id, league_id)
    finally:
        payload = read_home_payload()
        interval, reason = compute_interval(live_sec, idle_sec)
        with STATE.lock:
            STATE.fetching = False
            STATE.last_fetch_sec = time.time()
            STATE.interval_sec = interval
            STATE.poll_reason = reason
            if ok and payload:
                STATE.generated_at = payload.get("generatedAt")
                STATE.last_error = payload.get("error")
            else:
                STATE.last_error = err or "fetch failed"


def wait_until_next_fetch(live_sec: int, idle_sec: int) -> None:
    """Sleep in short slices so a GW flip / deadline can interrupt a long idle."""
    while True:
        interval, reason = compute_interval(live_sec, idle_sec)
        with STATE.lock:
            STATE.interval_sec = interval
            STATE.poll_reason = reason
            last = STATE.last_fetch_sec
        now = time.time()
        due = (last or 0) + max(15, interval)
        if now >= due:
            return
        time.sleep(min(float(SLEEP_SLICE_SEC), max(1.0, due - now)))


def daemon_loop(live_sec: int, idle_sec: int) -> None:
    while True:
        refresh_once(live_sec, idle_sec)
        wait_until_next_fetch(live_sec, idle_sec)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, status: int, body: dict) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:
        route = self.path.split("?", 1)[0].rstrip("/")
        if route not in {"/api/home", "/health"}:
            self.send_error(404)
            return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        route = self.path.split("?", 1)[0].rstrip("/")
        if route == "/health":
            with STATE.lock:
                last = STATE.last_fetch_sec
                body = {
                    "ok": True,
                    "generatedAt": STATE.generated_at,
                    "intervalSec": STATE.interval_sec,
                    "pollReason": STATE.poll_reason,
                    "fplGw": STATE.fpl_gw,
                    "cacheGw": STATE.cache_gw,
                    "lastFetchAgeSec": (
                        None if last is None else max(0, int(time.time() - last))
                    ),
                    "lastError": STATE.last_error,
                    "fetching": STATE.fetching,
                }
            return self._json(200, body)

        if route == "/api/home":
            maybe_trigger_refresh_if_stale()
            payload = read_home_payload()
            if not payload:
                return self._json(503, {"ok": False, "error": "Home cache not ready"})
            return self._json(200, {"ok": True, "home": payload})

        self.send_error(404)


def main() -> int:
    global INTERVAL_LIVE_SEC, INTERVAL_IDLE_SEC
    parser = argparse.ArgumentParser(description="FPL Explorer live Home cache server")
    parser.add_argument("--host", default=os.environ.get("LIVE_SERVER_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("LIVE_SERVER_PORT", "8080")))
    parser.add_argument(
        "--interval-live",
        type=int,
        default=int(os.environ.get("LIVE_INTERVAL_LIVE", "15")),
        help="Refresh seconds while fixtures are live (default 15)",
    )
    parser.add_argument(
        "--interval-idle",
        type=int,
        default=int(os.environ.get("LIVE_INTERVAL_IDLE", "3600")),
        help="Max refresh seconds when no live fixtures (default 3600; shortens near kickoff)",
    )
    parser.add_argument(
        "--skip-daemon",
        action="store_true",
        help="Serve API only (no background polling)",
    )
    args = parser.parse_args()
    INTERVAL_LIVE_SEC = max(10, args.interval_live)
    INTERVAL_IDLE_SEC = max(60, args.interval_idle)

    manager_id, league_id = load_prefs()
    if not manager_id or not league_id:
        print(
            "Warning: set site/home_prefs.json or FPL_HOME_MANAGER_ID / FPL_HOME_LEAGUE_ID",
            file=sys.stderr,
        )
    else:
        print(f"Live targets: manager={manager_id} league={league_id}", file=sys.stderr)

    if not args.skip_daemon:
        thread = threading.Thread(
            target=daemon_loop,
            args=(args.interval_live, args.interval_idle),
            daemon=True,
            name="home-refresh",
        )
        thread.start()

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(
        f"Live server on http://{args.host}:{args.port} "
        f"(live={args.interval_live}s idle={args.interval_idle}s)",
        file=sys.stderr,
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
