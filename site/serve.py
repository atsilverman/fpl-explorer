#!/usr/bin/env python3
"""Local static server with /api/fpl/squad proxy (mirrors Vercel function)."""

from __future__ import annotations

import json
import subprocess
import sys
import re
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
FPL_BASE = "https://fantasy.premierleague.com/api"
UA = "fpl-explorer/1.0 (+local-proxy)"
POS_BY_TYPE = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}
BOOTSTRAP_TTL = 30 * 60
_bootstrap = None
_bootstrap_at = 0.0


def fpl_get(path: str):
    req = urllib.request.Request(
        f"{FPL_BASE}{path}",
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            data = None
        return exc.code, data


def get_bootstrap():
    global _bootstrap, _bootstrap_at
    now = time.time()
    if _bootstrap and now - _bootstrap_at < BOOTSTRAP_TTL:
        return _bootstrap
    status, data = fpl_get("/bootstrap-static/")
    if status != 200 or not data:
        raise RuntimeError(f"bootstrap-static failed ({status})")
    _bootstrap = data
    _bootstrap_at = now
    return data


def resolve_gw(bootstrap, entry):
    events = bootstrap.get("events") or []
    current = next((e for e in events if e.get("is_current")), None)
    nxt = next((e for e in events if e.get("is_next")), None)
    from_entry = entry.get("current_event") if entry else None
    if isinstance(from_entry, int) and from_entry > 0:
        return from_entry
    if current and current.get("id"):
        return int(current["id"])
    if nxt and nxt.get("id"):
        return int(nxt["id"])
    return 1


def gw_label(bootstrap, gw, has_picks):
    events = bootstrap.get("events") or []
    ev = next((e for e in events if int(e.get("id") or 0) == int(gw)), None)
    name = (ev or {}).get("name") or f"Gameweek {gw}"
    if not has_picks and ev and ev.get("is_next") and not ev.get("is_current"):
        return "Preseason"
    if not has_picks and int(gw) <= 1:
        return "Preseason"
    return name


def map_picks(bootstrap, picks_payload):
    by_id = {e["id"]: e for e in bootstrap.get("elements") or []}
    teams = {t["id"]: t.get("short_name") for t in bootstrap.get("teams") or []}
    squad = []
    captain = None
    vice = None
    for pick in picks_payload.get("picks") or []:
        el = by_id.get(pick.get("element"))
        if not el:
            continue
        position = POS_BY_TYPE.get(el.get("element_type"), "MID")
        slot_pos = int(pick.get("position") or 0)
        starter = 1 <= slot_pos <= 11
        bench_order = 0 if starter else max(0, slot_pos - 12)
        code = int(el["code"])
        if pick.get("is_captain"):
            captain = code
        if pick.get("is_vice_captain"):
            vice = code
        squad.append(
            {
                "code": code,
                "element": pick.get("element"),
                "position": position,
                "starter": starter,
                "benchOrder": bench_order,
                "name": el.get("web_name") or el.get("second_name") or str(code),
                "team": teams.get(el.get("team")),
            }
        )
    return squad, captain, vice


def build_squad_payload(manager_id: str):
    bootstrap = get_bootstrap()
    status, entry = fpl_get(f"/entry/{manager_id}/")
    if status == 404:
        return 404, {"ok": False, "error": "Manager not found"}
    if status != 200 or not entry:
        return 502, {"ok": False, "error": "FPL entry lookup failed"}
    gw = resolve_gw(bootstrap, entry)
    pstatus, picks = fpl_get(f"/entry/{manager_id}/event/{gw}/picks/")
    has_picks = pstatus == 200 and isinstance((picks or {}).get("picks"), list)
    if has_picks:
        squad, captain, vice = map_picks(bootstrap, picks)
    else:
        squad, captain, vice = [], None, None
    history = (picks or {}).get("entry_history") or {}
    bank = history.get("bank")
    value = history.get("value")
    return 200, {
        "ok": True,
        "managerId": manager_id,
        "teamName": entry.get("name") or "",
        "managerName": " ".join(
            p for p in [entry.get("player_first_name"), entry.get("player_last_name")] if p
        ),
        "gw": gw,
        "gwLabel": gw_label(bootstrap, gw, has_picks),
        "hasPicks": has_picks,
        "syncedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bank": (bank / 10.0) if isinstance(bank, (int, float)) else None,
        "value": (value / 10.0) if isinstance(value, (int, float)) else None,
        "squad": squad,
        "captain": captain,
        "vice": vice,
        "message": None
        if has_picks
        else "No published FPL picks yet for this gameweek (common in preseason before the squad is set).",
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_OPTIONS(self):
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") in {"/api/home-prefs", "/api/refresh-home"}:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()
            return
        self.send_error(404)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.rstrip("/") == "/api/fpl/squad":
            qs = parse_qs(parsed.query)
            mid = (qs.get("id") or [""])[0].strip()
            if not re.fullmatch(r"\d+", mid) or int(mid) <= 0:
                return self._json(400, {"ok": False, "error": "Invalid manager ID"})
            try:
                status, body = build_squad_payload(mid)
            except Exception as exc:  # noqa: BLE001
                return self._json(502, {"ok": False, "error": str(exc)})
            return self._json(status, body)
        if parsed.path.rstrip("/") == "/api/home-prefs":
            prefs_path = ROOT / "home_prefs.json"
            if prefs_path.exists():
                try:
                    data = json.loads(prefs_path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    data = {}
            else:
                data = {}
            return self._json(200, {"ok": True, "prefs": data})
        if parsed.path.rstrip("/") == "/api/home":
            json_path = ROOT / "home_data.json"
            if not json_path.exists():
                home = self._parse_home_data_js()
                if not home:
                    return self._json(503, {"ok": False, "error": "Home cache not ready"})
                return self._json(200, {"ok": True, "home": home})
            try:
                home = json.loads(json_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return self._json(503, {"ok": False, "error": "Home cache invalid"})
            return self._json(200, {"ok": True, "home": home})
        return super().do_GET()

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw_body = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw_body.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return None

    def _write_home_prefs(self, body: dict):
        out = {}
        manager_id = body.get("managerId")
        league_id = body.get("leagueId")
        if manager_id is not None and str(manager_id).strip() != "":
            mid = str(manager_id).strip()
            if not re.fullmatch(r"\d+", mid) or int(mid) <= 0:
                return None, "Invalid managerId"
            out["managerId"] = int(mid)
        if league_id is not None and str(league_id).strip() != "":
            lid = str(league_id).strip()
            if not re.fullmatch(r"\d+", lid) or int(lid) <= 0:
                return None, "Invalid leagueId"
            out["leagueId"] = int(lid)
        prefs_path = ROOT / "home_prefs.json"
        prefs_path.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
        return out, None

    def _parse_home_data_js(self):
        path = ROOT / "home_data.js"
        if not path.exists():
            return None
        text = path.read_text(encoding="utf-8").strip()
        # window.FPL_HOME = {...};
        if "=" not in text:
            return None
        raw = text.split("=", 1)[1].strip().rstrip(";").strip()
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None

    def _run_fetch_home(self):
        script = ROOT / "fetch_home.py"
        proc = subprocess.run(
            [sys.executable, str(script)],
            cwd=str(ROOT.parent),
            capture_output=True,
            text=True,
            timeout=180,
        )
        return proc

    def do_POST(self):
        parsed = urlparse(self.path)
        route = parsed.path.rstrip("/")
        if route not in {"/api/home-prefs", "/api/refresh-home"}:
            self.send_error(404)
            return
        body = self._read_json_body()
        if body is None:
            return self._json(400, {"ok": False, "error": "Invalid JSON"})
        prefs, err = self._write_home_prefs(body)
        if err:
            return self._json(400, {"ok": False, "error": err})
        if route == "/api/home-prefs":
            return self._json(200, {"ok": True, "prefs": prefs})
        # /api/refresh-home — rebuild home_data.js for current prefs, return payload.
        try:
            proc = self._run_fetch_home()
        except subprocess.TimeoutExpired:
            return self._json(504, {"ok": False, "error": "fetch_home timed out"})
        except OSError as exc:
            return self._json(500, {"ok": False, "error": str(exc)})
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "fetch_home failed").strip()
            return self._json(502, {"ok": False, "error": detail[-800:], "prefs": prefs})
        home = self._parse_home_data_js()
        if not home:
            return self._json(500, {"ok": False, "error": "home_data.js missing or invalid", "prefs": prefs})
        return self._json(200, {"ok": True, "prefs": prefs, "home": home})

    def _json(self, status: int, body: dict):
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt, *args):
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    host, port = "127.0.0.1", 8000
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Serving {ROOT} at http://{host}:{port} (with /api/fpl/squad, /api/home-prefs, /api/refresh-home, /api/home)")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
