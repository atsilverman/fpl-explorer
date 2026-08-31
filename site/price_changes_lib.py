"""Price-change predictor: slim check-ins, bundle rebuild, spark/d3 history."""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent
SNAPSHOTS = ROOT / "snapshots"
PRICE_CHANGES_DIR = SNAPSHOTS / "price-changes"
PRICES_OUT_PATH = SITE / "price_changes_data.js"
FPL_BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/"
UA = "fpl-explorer/1.0 (+price-checkin)"
FPL_POS_MAP = {"GKP": "GK", "DEF": "DEF", "MID": "MID", "FWD": "FWD"}
PRICE_LIKELIHOOD_INCLUDE = frozenset({5, 4, 3, 2, -2, -3, -4, -5})
PRICE_CHECKIN_RE = re.compile(
    r"price-changes_(\d{4}-\d{2}-\d{2}T\d{6}Z)\.json$"
)
BOOTSTRAP_DATE_RE = re.compile(r"bootstrap-static_(\d{4}-\d{2}-\d{2})\.json$")
RETENTION_DAYS = 4
SPARKLINE_DAYS = 3

import sys

sys.path.insert(0, str(SITE))
from fpl_gameweeks import extract_gameweeks  # noqa: E402


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def generated_at() -> str:
    return utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")


def checkin_stamp(dt: datetime | None = None) -> str:
    when = dt or utc_now()
    return when.strftime("%Y-%m-%dT%H%M%SZ")


def checkin_filename(stamp: str) -> str:
    return f"price-changes_{stamp}.json"


def parse_checkin_ms(checked_at: str) -> float | None:
    if not checked_at:
        return None
    try:
        if checked_at.endswith("Z"):
            return datetime.fromisoformat(checked_at.replace("Z", "+00:00")).timestamp() * 1000
        return datetime.fromisoformat(checked_at).timestamp() * 1000
    except ValueError:
        return None


def float_field(val, default: float = 0.0) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def price_status_from_likelihood(lk: int) -> tuple[str, str] | None:
    if lk in (5, 4):
        return "very_likely_rise", "Very likely to rise"
    if lk in (3, 2):
        return "likely_rise", "Likely to rise"
    if lk in (-2, -3):
        return "likely_drop", "Likely to drop"
    if lk in (-4, -5):
        return "very_likely_drop", "Very likely to drop"
    return None


def next_price_change_at_iso() -> str:
    london = ZoneInfo("Europe/London")
    now = datetime.now(london)
    next_mid = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if now >= next_mid:
        next_mid += timedelta(days=1)
    return next_mid.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def price_changes_from_snapshot(snap: dict, source: str = "") -> list[dict]:
    teams_by_id = {t["id"]: t.get("short_name") for t in snap.get("teams") or []}
    postype_by_id = {
        e["id"]: e.get("singular_name_short") for e in snap.get("element_types") or []
    }
    players: list[dict] = []
    for e in snap.get("elements") or []:
        if e.get("price_change_calibrating"):
            continue
        code = e.get("code")
        if code is None:
            continue
        projections = e.get("price_change_projections") or []
        if not projections:
            continue
        p0 = projections[0]
        try:
            lk = int(p0.get("likelihood", 0))
        except (TypeError, ValueError):
            continue
        if lk not in PRICE_LIKELIHOOD_INCLUDE:
            continue
        status = price_status_from_likelihood(lk)
        if not status:
            continue
        status_key, status_label = status
        team = teams_by_id.get(e.get("team"))
        pos_raw = postype_by_id.get(e.get("element_type"), "") or ""
        pos = FPL_POS_MAP.get(pos_raw, pos_raw or None)
        try:
            price = float(e.get("now_cost") or 0) / 10.0
        except (TypeError, ValueError):
            price = 0.0
        tin = int(e.get("transfers_in_event") or 0)
        tout = int(e.get("transfers_out_event") or 0)
        players.append(
            {
                "code": int(code),
                "name": e.get("web_name") or e.get("second_name") or str(code),
                "team": team,
                "position": pos,
                "price": round(price, 1),
                "progress": round(float_field(e.get("price_change_percent")), 1),
                "predicted": round(float_field(p0.get("projected_percent")), 1),
                "likelihood": lk,
                "statusKey": status_key,
                "statusLabel": status_label,
                "trend": "up" if tin >= tout else "down",
                "injuryStatus": e.get("status") or "a",
            }
        )
    status_order = {
        "very_likely_rise": 0,
        "likely_rise": 1,
        "very_likely_drop": 2,
        "likely_drop": 3,
    }
    players.sort(
        key=lambda p: (
            status_order.get(p["statusKey"], 9),
            -abs(p["predicted"]),
            p["name"],
        )
    )
    return players


def slim_price_checkin(snap: dict, checked_at: str, source: str) -> dict:
    players = price_changes_from_snapshot(snap, source)
    slim_players = [
        {
            "code": p["code"],
            "progress": p["progress"],
            "predicted": p["predicted"],
            "likelihood": p["likelihood"],
            "statusKey": p["statusKey"],
            "trend": p["trend"],
            "price": p["price"],
        }
        for p in players
    ]
    return {
        "checkedAt": checked_at,
        "source": source,
        "players": slim_players,
    }


def write_price_changes_js(payload: dict) -> None:
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    PRICES_OUT_PATH.write_text(f"window.FPL_PRICE_CHANGES = {body};\n", encoding="utf-8")


def price_checkin_paths() -> list[Path]:
    PRICE_CHANGES_DIR.mkdir(parents=True, exist_ok=True)
    paths = []
    for p in PRICE_CHANGES_DIR.glob("price-changes_*.json"):
        if PRICE_CHECKIN_RE.search(p.name):
            paths.append(p)
    paths.sort(key=lambda p: PRICE_CHECKIN_RE.search(p.name).group(1))
    return paths


def load_checkin(path: Path) -> dict | None:
    try:
        row = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"skip {path.name}: {exc}", file=__import__("sys").stderr)
        return None
    if not isinstance(row, dict) or "checkedAt" not in row:
        return None
    return row


def prune_old_checkins(retention_days: int = RETENTION_DAYS) -> int:
    cutoff = utc_now() - timedelta(days=retention_days)
    removed = 0
    for path in price_checkin_paths():
        m = PRICE_CHECKIN_RE.search(path.name)
        if not m:
            continue
        try:
            stamp = datetime.strptime(m.group(1), "%Y-%m-%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if stamp < cutoff:
            path.unlink(missing_ok=True)
            removed += 1
    return removed


def bootstrap_snapshot_paths() -> list[Path]:
    SNAPSHOTS.mkdir(exist_ok=True)
    paths = []
    for p in SNAPSHOTS.glob("bootstrap-static_*.json"):
        if "archived" in p.stem:
            continue
        if BOOTSTRAP_DATE_RE.search(p.name):
            paths.append(p)
    paths.sort(key=lambda p: BOOTSTRAP_DATE_RE.search(p.name).group(1))
    return paths


def gameweeks_from_latest_bootstrap() -> dict:
    paths = bootstrap_snapshot_paths()
    if not paths:
        return {"previous": None, "current": None, "next": None, "source": None}
    path = paths[-1]
    try:
        snap = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"skip gameweeks from {path.name}: {exc}", file=__import__("sys").stderr)
        return {"previous": None, "current": None, "next": None, "source": None}
    return extract_gameweeks(snap, path.name)


def progress_at_or_before(history: list[dict], target_ms: float) -> dict | None:
    hit = None
    for pt in history:
        ms = parse_checkin_ms(pt.get("checkedAt", ""))
        if ms is None or ms > target_ms:
            continue
        if pt.get("progress") is None:
            continue
        hit = pt
    if hit:
        return hit
    return next((pt for pt in history if pt.get("progress") is not None), None)


def progress_delta(live: float, base: float | None) -> float | None:
    if base is None or not (isinstance(live, (int, float)) and isinstance(base, (int, float))):
        return None
    return round(float(live) - float(base), 1)


def enrich_players_with_history(
    latest_players: list[dict],
    check_ins: list[dict],
    sparkline_days: int = SPARKLINE_DAYS,
) -> list[dict]:
    if not latest_players:
        return []
    by_code: dict[int, list[dict]] = {}
    for ci in check_ins:
        checked_at = ci.get("checkedAt", "")
        for p in ci.get("players") or []:
            code = p.get("code")
            if code is None:
                continue
            by_code.setdefault(int(code), []).append(
                {"checkedAt": checked_at, "progress": p.get("progress")}
            )

    day_ms = 24 * 60 * 60 * 1000
    enriched: list[dict] = []
    for row in latest_players:
        code = int(row["code"])
        history = by_code.get(code, [])
        valid = [
            pt
            for pt in history
            if pt.get("progress") is not None and parse_checkin_ms(pt.get("checkedAt", "")) is not None
        ]
        out = dict(row)
        if len(valid) < 2:
            out["spark"] = []
            out["sparkStart"] = None
            out["sparkEnd"] = None
            out["d3"] = None
            enriched.append(out)
            continue

        live_pt = valid[-1]
        live = float(live_pt["progress"])
        live_ms = parse_checkin_ms(live_pt["checkedAt"]) or 0
        spark_from_ms = live_ms - sparkline_days * day_ms
        spark_pts = [pt for pt in valid if (parse_checkin_ms(pt["checkedAt"]) or 0) >= spark_from_ms]
        if len(spark_pts) < 2:
            spark_pts = valid[-min(len(valid), 8) :]

        pt3 = progress_at_or_before(valid, live_ms - sparkline_days * day_ms)
        base3 = float(pt3["progress"]) if pt3 else float(spark_pts[0]["progress"])
        spark_vals = [float(pt["progress"]) for pt in spark_pts]

        out["spark"] = spark_vals
        out["sparkStart"] = spark_vals[0]
        out["sparkEnd"] = spark_vals[-1]
        out["d3"] = progress_delta(live, base3)
        enriched.append(out)
    return enriched


def rebuild_price_changes_bundle(
    *,
    latest_snap: dict | None = None,
    latest_source: str | None = None,
) -> dict | None:
    check_ins: list[dict] = []
    for path in price_checkin_paths():
        row = load_checkin(path)
        if row:
            check_ins.append(row)
    if not check_ins and not latest_snap:
        return None

    latest_players: list[dict] = []
    source = latest_source or (check_ins[-1]["source"] if check_ins else None)

    if latest_snap is not None:
        latest_players = price_changes_from_snapshot(latest_snap, source or "")
    elif check_ins:
        # Rebuild identity from newest bootstrap snapshot when only slim check-ins exist.
        paths = bootstrap_snapshot_paths()
        if paths:
            try:
                snap = json.loads(paths[-1].read_text(encoding="utf-8"))
                latest_players = price_changes_from_snapshot(snap, paths[-1].name)
                source = paths[-1].name
            except (OSError, json.JSONDecodeError):
                latest_players = []
        if not latest_players:
            # Fallback: slim-only (no names) — should not happen in normal ops.
            codes = {int(p["code"]) for p in check_ins[-1].get("players") or []}
            latest_players = [
                {"code": c, "name": str(c), "progress": 0, "predicted": 0}
                for c in sorted(codes)
            ]

    players = enrich_players_with_history(latest_players, check_ins)
    payload = {
        "generatedAt": generated_at(),
        "source": source,
        "nextChangeAt": next_price_change_at_iso(),
        "gameweeks": gameweeks_from_latest_bootstrap(),
        "checkIns": check_ins,
        "players": players,
    }
    write_price_changes_js(payload)
    return payload
