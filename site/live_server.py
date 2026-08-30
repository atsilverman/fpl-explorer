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
  python3 site/live_server.py --port 8080 --interval-live 60 --interval-idle 3600
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
    DEADLINE_POLL_TAIL_SEC,
    active_gameweek_id,
    deadline_poll_window_active,
    extract_gameweeks,
)
from live_scoring import fixture_is_finished, fixture_is_live

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
BOOTSTRAP_CACHE_SEC = 120

_bootstrap_cache: dict | None = None
_bootstrap_cache_at: float = 0.0


class LiveState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.generated_at: str | None = None
        self.last_error: str | None = None
        self.last_fetch_sec: float | None = None
        self.interval_sec = 3600
        self.fetching = False


STATE = LiveState()


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
    try:
        fixtures_raw = fpl_get(f"/fixtures/?event={gw}")
        return fixtures_raw if isinstance(fixtures_raw, list) else []
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, json.JSONDecodeError):
        return []


def fixtures_have_live_action(fixtures: list[dict]) -> bool:
    for fx in fixtures:
        if fixture_is_live(fx):
            return True
        if fx.get("started") and not fixture_is_finished(fx):
            return True
    return False


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
    cached = read_home_payload()
    if cached and cached.get("gw") is not None:
        try:
            return int(cached["gw"])
        except (TypeError, ValueError):
            pass
    try:
        bootstrap = fpl_get("/bootstrap-static/")
        if not isinstance(bootstrap, dict):
            return None
        gws = extract_gameweeks(bootstrap, source="bootstrap")
        return active_gameweek_id(gws)
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, json.JSONDecodeError):
        return None


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


def choose_interval(live_sec: int, idle_sec: int, kickoff_lead_sec: int = KICKOFF_LEAD_SEC) -> int:
    gws = load_bootstrap_gameweeks()
    now = time.time()
    if deadline_poll_window_active(gws, now, DEADLINE_POLL_TAIL_SEC):
        return max(15, live_sec)
    if league_picks_need_poll():
        return max(15, live_sec)
    gw = resolve_active_gw()
    fixtures = load_gw_fixtures(gw)
    if fixtures_have_live_action(fixtures):
        return max(15, live_sec)
    until = seconds_until_next_kickoff(fixtures)
    if until is None:
        return max(15, idle_sec)
    # KO imminent or overdue (API lag on `started`) — keep live cadence.
    if until <= kickoff_lead_sec:
        return max(15, live_sec)
    # Wake ~kickoff_lead_sec before KO; never sleep longer than idle_sec.
    wake = max(15, int(until) - kickoff_lead_sec)
    return min(max(15, idle_sec), wake)


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
        interval = choose_interval(live_sec, idle_sec)
        with STATE.lock:
            STATE.fetching = False
            STATE.last_fetch_sec = time.time()
            STATE.interval_sec = interval
            if ok and payload:
                STATE.generated_at = payload.get("generatedAt")
                STATE.last_error = payload.get("error")
            else:
                STATE.last_error = err or "fetch failed"


def daemon_loop(live_sec: int, idle_sec: int) -> None:
    while True:
        refresh_once(live_sec, idle_sec)
        with STATE.lock:
            wait = max(15, STATE.interval_sec)
        time.sleep(wait)


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
                body = {
                    "ok": True,
                    "generatedAt": STATE.generated_at,
                    "intervalSec": STATE.interval_sec,
                    "lastError": STATE.last_error,
                    "fetching": STATE.fetching,
                }
            return self._json(200, body)

        if route == "/api/home":
            payload = read_home_payload()
            if not payload:
                return self._json(503, {"ok": False, "error": "Home cache not ready"})
            return self._json(200, {"ok": True, "home": payload})

        self.send_error(404)


def main() -> int:
    parser = argparse.ArgumentParser(description="FPL Explorer live Home cache server")
    parser.add_argument("--host", default=os.environ.get("LIVE_SERVER_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("LIVE_SERVER_PORT", "8080")))
    parser.add_argument(
        "--interval-live",
        type=int,
        default=int(os.environ.get("LIVE_INTERVAL_LIVE", "60")),
        help="Refresh seconds while fixtures are live (default 60)",
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
