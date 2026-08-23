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
  python3 site/live_server.py --port 8080 --interval-live 60 --interval-idle 300
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from fpl_gameweeks import active_gameweek_id, extract_gameweeks
from live_scoring import fixture_is_finished, fixture_is_live

SITE = Path(__file__).resolve().parent
REPO = SITE.parent
JSON_PATH = SITE / "home_data.json"
PREFS_PATH = SITE / "home_prefs.json"
FETCH_SCRIPT = SITE / "fetch_home.py"
FPL_BASE = "https://fantasy.premierleague.com/api"
UA = "Mozilla/5.0 (compatible; FPL-Explorer/1.0; +live-server)"


class LiveState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.generated_at: str | None = None
        self.last_error: str | None = None
        self.last_fetch_sec: float | None = None
        self.interval_sec = 300
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


def fixtures_have_live_action(gw: int | None) -> bool:
    if not gw:
        return False
    try:
        fixtures_raw = fpl_get(f"/fixtures/?event={gw}")
        fixtures = fixtures_raw if isinstance(fixtures_raw, list) else []
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError, json.JSONDecodeError):
        return False
    for fx in fixtures:
        if fixture_is_live(fx):
            return True
        if fx.get("started") and not fixture_is_finished(fx):
            return True
    return False


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
    if not JSON_PATH.exists():
        return None
    try:
        data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


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


def choose_interval(live_sec: int, idle_sec: int) -> int:
    gw = resolve_active_gw()
    return live_sec if fixtures_have_live_action(gw) else idle_sec


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
        default=int(os.environ.get("LIVE_INTERVAL_IDLE", "300")),
        help="Refresh seconds when no live fixtures (default 300)",
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
