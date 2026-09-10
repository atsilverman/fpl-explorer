#!/usr/bin/env python3
"""
FPL ownership check-ins → site/ownership_data.js.

Fetches bootstrap-static, overwrites today's snapshots/bootstrap-static_YYYY-MM-DD.json
(used by build.py / live £ + owned %), writes a slim hourly point under
snapshots/ownership/, then rebuilds the history bundle.

7d / 3d / 1d deltas are lookbacks from the latest check-in to the nearest
snapshot on or before that many days — hourly points make 1d a true ~24h
window. The JS bundle keeps every point from the last 36 hours, then one
check-in per UTC day for older history (sparklines stay 14d).

The static site only reads the JS bundles — it never calls the FPL API.

Run:
    python3 site/fetch_ownership.py
    python3 site/fetch_ownership.py --rebuild-only   # skip live fetch
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent
SNAPSHOTS = ROOT / "snapshots"
HOURLY_DIR = SNAPSHOTS / "ownership"
OUT_PATH = SITE / "ownership_data.js"
FPL_BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/"
UA = "fpl-explorer/1.0 (+ownership-checkin)"
FPL_POS_MAP = {"GKP": "GK", "DEF": "DEF", "MID": "MID", "FWD": "FWD"}
DATE_RE = re.compile(r"bootstrap-static_(\d{4}-\d{2}-\d{2})\.json$")
HOURLY_RE = re.compile(r"ownership_(\d{4}-\d{2}-\d{2}T\d{6}Z)\.json$")
HOURLY_KEEP_DAYS = 16
BUNDLE_HOURLY_HOURS = 36

sys.path.insert(0, str(SITE))
from fpl_gameweeks import extract_gameweeks  # noqa: E402
from player_availability import player_availability_fields  # noqa: E402
from price_changes_lib import rebuild_price_changes_bundle  # noqa: E402


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def today_stamp() -> str:
    return utc_now().strftime("%Y-%m-%d")


def generated_at() -> str:
    return utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")


def checkin_stamp(dt: datetime | None = None) -> str:
    when = dt or utc_now()
    return when.strftime("%Y-%m-%dT%H%M%SZ")


def iso_from_stamp(stamp: str) -> str:
    return f"{stamp[:10]}T{stamp[11:13]}:{stamp[13:15]}:{stamp[15:17]}Z"


def parse_checked_at(value: str) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    if raw.endswith("Z") and "T" in raw and "-" in raw:
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            pass
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", raw)
    if m:
        y, mo, d = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
        return datetime(y, mo, d, tzinfo=timezone.utc)
    return None


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


def hourly_paths() -> list[Path]:
    if not HOURLY_DIR.exists():
        return []
    paths = [p for p in HOURLY_DIR.glob("ownership_*.json") if HOURLY_RE.search(p.name)]
    paths.sort(key=lambda p: HOURLY_RE.search(p.name).group(1))
    return paths


def prune_old_hourlies() -> int:
    cutoff = utc_now() - timedelta(days=HOURLY_KEEP_DAYS)
    removed = 0
    for path in hourly_paths():
        stamp = HOURLY_RE.search(path.name).group(1)
        when = parse_checked_at(iso_from_stamp(stamp))
        if when is None or when >= cutoff:
            continue
        try:
            path.unlink()
            removed += 1
        except OSError as exc:
            print(f"skip delete {path.name}: {exc}", file=sys.stderr)
    return removed


def players_from_bootstrap(snap: dict) -> list[dict]:
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
                **player_availability_fields(e),
            }
        )
    players.sort(key=lambda p: (-p["owned"], p["code"]))
    return players


def compact_players(players: list[dict]) -> list[dict]:
    out = []
    for p in players or []:
        code = p.get("code")
        if code is None:
            continue
        try:
            owned = float(p.get("owned"))
        except (TypeError, ValueError):
            owned = None
        out.append(
            {
                "code": int(code),
                "team": p.get("team"),
                "owned": round(owned, 1) if owned is not None else None,
            }
        )
    return out


def slim_checkin(path: Path) -> dict | None:
    m = DATE_RE.search(path.name)
    if not m:
        return None
    try:
        snap = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"skip {path.name}: {exc}", file=sys.stderr)
        return None
    if not isinstance(snap, dict) or "elements" not in snap:
        return None
    return {
        "checkedAt": m.group(1),
        "source": path.name,
        "players": players_from_bootstrap(snap),
    }


def load_hourly(path: Path) -> dict | None:
    m = HOURLY_RE.search(path.name)
    if not m:
        return None
    try:
        row = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"skip {path.name}: {exc}", file=sys.stderr)
        return None
    if not isinstance(row, dict):
        return None
    players = row.get("players")
    if not isinstance(players, list):
        return None
    checked = row.get("checkedAt") or iso_from_stamp(m.group(1))
    return {
        "checkedAt": checked,
        "source": row.get("source") or path.name,
        "players": compact_players(players),
    }


def write_hourly_checkin(players: list[dict], stamp: str) -> Path:
    HOURLY_DIR.mkdir(parents=True, exist_ok=True)
    fname = f"ownership_{stamp}.json"
    dest = HOURLY_DIR / fname
    payload = {
        "checkedAt": iso_from_stamp(stamp),
        "source": fname,
        "players": compact_players(players),
    }
    dest.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    return dest


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


def downsample_checkins(rows: list[dict]) -> list[dict]:
    parsed = []
    for row in rows:
        when = parse_checked_at(row.get("checkedAt") or "")
        if when is None:
            continue
        parsed.append((when, row))
    if not parsed:
        return []
    parsed.sort(key=lambda item: item[0])
    latest = parsed[-1][0]
    cutoff = latest - timedelta(hours=BUNDLE_HOURLY_HOURS)
    kept: list[dict] = []
    last_of_day: dict = {}
    for when, row in parsed:
        if when >= cutoff:
            kept.append(row)
        else:
            last_of_day[when.date()] = row
    older = [last_of_day[d] for d in sorted(last_of_day)]
    merged: dict[str, dict] = {}
    for row in older + kept:
        merged[row["checkedAt"]] = row
    return sorted(merged.values(), key=lambda r: parse_checked_at(r["checkedAt"]) or datetime.min.replace(tzinfo=timezone.utc))


def enrich_latest(rows: list[dict]) -> list[dict]:
    """Latest point keeps full player metadata from the newest daily bootstrap."""
    if not rows:
        return rows
    paths = snapshot_paths()
    if not paths:
        return rows
    full = slim_checkin(paths[-1])
    if not full:
        return rows
    by_code = {p["code"]: p for p in full["players"] if p.get("code") is not None}
    latest = dict(rows[-1])
    merged = []
    seen = set()
    for p in latest.get("players") or []:
        code = p.get("code")
        if code is None:
            continue
        code = int(code)
        seen.add(code)
        fp = by_code.get(code)
        if fp:
            merged.append({**fp, "owned": p.get("owned", fp.get("owned"))})
        else:
            merged.append(p)
    for code, fp in by_code.items():
        if code not in seen:
            merged.append(fp)
    merged.sort(key=lambda p: (-(p.get("owned") or 0), p.get("code") or 0))
    latest["players"] = merged
    rows[-1] = latest
    return rows


def compact_history_checkins(rows: list[dict]) -> list[dict]:
    if not rows:
        return []
    out = []
    last_i = len(rows) - 1
    for i, row in enumerate(rows):
        if i == last_i:
            out.append(row)
            continue
        out.append(
            {
                "checkedAt": row["checkedAt"],
                "source": row.get("source"),
                "players": compact_players(row.get("players") or []),
            }
        )
    return out


def collect_checkins() -> list[dict]:
    by_key: dict[str, dict] = {}
    for path in snapshot_paths():
        row = slim_checkin(path)
        if row:
            by_key[row["checkedAt"]] = row
    for path in hourly_paths():
        row = load_hourly(path)
        if row:
            by_key[row["checkedAt"]] = row
    rows = list(by_key.values())
    hourly_dates = set()
    for row in rows:
        when = parse_checked_at(row.get("checkedAt") or "")
        if when is not None and "T" in str(row.get("checkedAt") or ""):
            hourly_dates.add(when.date())
    filtered = []
    for row in rows:
        checked = str(row.get("checkedAt") or "")
        when = parse_checked_at(checked)
        if when is None:
            continue
        if "T" not in checked and when.date() in hourly_dates:
            continue
        filtered.append(row)
    return downsample_checkins(filtered)


def rebuild_bundle() -> dict:
    check_ins = compact_history_checkins(enrich_latest(collect_checkins()))
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
            players = players_from_bootstrap(data)
            n = len(players)
            print(f"Wrote {dest.relative_to(ROOT)} ({n} players)")
            stamp = checkin_stamp()
            hourly = write_hourly_checkin(players, stamp)
            print(f"Wrote {hourly.relative_to(ROOT)}")
            pruned = prune_old_hourlies()
            if pruned:
                print(f"Pruned {pruned} ownership check-in{'s' if pruned != 1 else ''} older than {HOURLY_KEEP_DAYS}d")
            rebuild_price_changes_bundle(latest_snap=data, latest_source=dest.name)
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
    latest_at = payload["checkIns"][-1]["checkedAt"] if n_ci else "—"
    print(
        f"Wrote {OUT_PATH.relative_to(ROOT)}: {n_ci} check-in{'s' if n_ci != 1 else ''}"
        + (f", latest {n_pl} players @ {latest_at}" if n_ci else "")
        + f"; gameweeks {' '.join(gw_bits)}"
    )
    if not n_ci:
        print("No ownership snapshots found in snapshots/.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
