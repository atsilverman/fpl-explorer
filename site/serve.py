#!/usr/bin/env python3
"""Local static server with /api/fpl/squad proxy (mirrors Vercel function)."""

from __future__ import annotations

import json
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
        return super().do_GET()

    def _json(self, status: int, body: dict):
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt, *args):
        sys_stderr = __import__("sys").stderr
        sys_stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    host, port = "127.0.0.1", 8000
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Serving {ROOT} at http://{host}:{port} (with /api/fpl/squad)")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
