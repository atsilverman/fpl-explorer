#!/usr/bin/env python3
"""
Manual FPL ownership check-ins → site/ownership_data.js.

Fetches bootstrap-static, writes snapshots/bootstrap-static_YYYY-MM-DD.json
when that date is new (overwrites same-day), then rebuilds a slim history
bundle from every non-archived bootstrap snapshot.

Price-change check-ins live in site/fetch_prices.py (4h cadence).

The static site only reads the JS bundles — it never calls the FPL API.

Run:
    python3 site/fetch_ownership.py
    python3 site/fetch_ownership.py --rebuild-only   # skip live fetch
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent
SNAPSHOTS = ROOT / "snapshots"
OUT_PATH = SITE / "ownership_data.js"
FPL_BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/"
UA = "fpl-explorer/1.0 (+ownership-checkin)"
FPL_POS_MAP = {"GKP": "GK", "DEF": "DEF", "MID": "MID", "FWD": "FWD"}
DATE_RE = __import__("re").compile(r"bootstrap-static_(\d{4}-\d{2}-\d{2})\.json$")

sys.path.insert(0, str(SITE))
from fpl_gameweeks import extract_gameweeks  # noqa: E402


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def today_stamp() -> str:
    return utc_now().strftime("%Y-%m-%d")


def generated_at() -> str:
    return utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")


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


def snapshot_paths() -> list[Path]:
    SNAPSHOTS.mkdir(exist_ok=True)
    paths = []
    for p in SNAPSHOTS.glob("bootstrap-static_*.json"):
        if "archived" in p.stem:
            continue
        if DATE_RE.search(p.name):
            paths.append(p)
    paths.sort(key=lambda p: DATE_RE.search(p.name).group(1))
    return paths


def slim_checkin(path: Path) -> dict | None:
    m = DATE_RE.search(path.name)
    if not m:
        return None
    try:
        snap = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"skip {path.name}: {exc}", file=sys.stderr)
        return None
    teams_by_id = {t["id"]: t.get("short_name") for t in snap.get("teams") or []}
    postype_by_id = {
        e["id"]: e.get("singular_name_short") for e in snap.get("element_types") or []
    }
    players = []
    for e in snap.get("elements") or []:
        code = e.get("code")
        if code is None:
            continue
        team = teams_by_id.get(e.get("team"))
        pos_raw = postype_by_id.get(e.get("element_type"), "") or ""
        pos = FPL_POS_MAP.get(pos_raw, pos_raw or None)
        try:
            owned = float(e.get("selected_by_percent") or 0)
        except (TypeError, ValueError):
            owned = 0.0
        try:
            price = float(e.get("now_cost") or 0) / 10.0
        except (TypeError, ValueError):
            price = 0.0
        players.append(
            {
                "code": int(code),
                "name": e.get("web_name") or e.get("second_name") or str(code),
                "team": team,
                "position": pos,
                "price": price,
                "owned": round(owned, 1),
            }
        )
    players.sort(key=lambda p: (-p["owned"], p["code"]))
    return {
        "checkedAt": m.group(1),
        "source": path.name,
        "players": players,
    }


def write_ownership_js(payload: dict) -> None:
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    OUT_PATH.write_text(f"window.FPL_OWNERSHIP = {body};\n", encoding="utf-8")


def gameweeks_from_latest_snapshot() -> dict:
    """Prev/current/next GW from the newest bootstrap snapshot on disk."""
    paths = snapshot_paths()
    if not paths:
        return {"previous": None, "current": None, "next": None, "source": None}
    path = paths[-1]
    try:
        snap = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"skip gameweeks from {path.name}: {exc}", file=sys.stderr)
        return {"previous": None, "current": None, "next": None, "source": None}
    return extract_gameweeks(snap, path.name)


def rebuild_bundle() -> dict:
    check_ins = []
    for path in snapshot_paths():
        row = slim_checkin(path)
        if row:
            check_ins.append(row)
    gameweeks = gameweeks_from_latest_snapshot()
    payload = {
        "generatedAt": generated_at(),
        "checkIns": check_ins,
        "gameweeks": gameweeks,
    }
    write_ownership_js(payload)
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Build FPL ownership check-in history.")
    parser.add_argument(
        "--rebuild-only",
        action="store_true",
        help="Skip the live FPL fetch; rebuild from snapshots already on disk.",
    )
    args = parser.parse_args()

    if not args.rebuild_only:
        dest = SNAPSHOTS / f"bootstrap-static_{today_stamp()}.json"
        try:
            print(f"Fetching {FPL_BOOTSTRAP}")
            data = fetch_bootstrap()
            SNAPSHOTS.mkdir(exist_ok=True)
            dest.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            n = len(data.get("elements") or [])
            print(f"Wrote {dest.relative_to(ROOT)} ({n} players)")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, RuntimeError) as exc:
            print(f"Live fetch failed ({exc}); rebuilding from existing snapshots.", file=sys.stderr)

    payload = rebuild_bundle()
    n_ci = len(payload["checkIns"])
    n_pl = len(payload["checkIns"][-1]["players"]) if n_ci else 0
    gw = payload.get("gameweeks") or {}
    gw_bits = []
    for label, key in (("prev", "previous"), ("curr", "current"), ("next", "next")):
        row = gw.get(key)
        gw_bits.append(f"{label}={row['id'] if row else '—'}")
    print(
        f"Wrote {OUT_PATH.relative_to(ROOT)}: {n_ci} check-in{'s' if n_ci != 1 else ''}"
        + (f", latest {n_pl} players" if n_ci else "")
        + f"; gameweeks {' '.join(gw_bits)}"
    )
    if not n_ci:
        print("No non-archived bootstrap-static_YYYY-MM-DD.json files in snapshots/.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
