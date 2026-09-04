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
PRICE_ACTUAL_DIR = SNAPSHOTS / "price-actual"
ACTUAL_CHANGES_PATH = PRICE_ACTUAL_DIR / "actual-changes.json"
ACTUAL_STATE_PATH = PRICE_ACTUAL_DIR / "state.json"
PRICES_OUT_PATH = SITE / "price_changes_data.js"
LONDON = ZoneInfo("Europe/London")
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
FPL_COST_STEP = 1  # now_cost units per £0.1m (55 → 56 = £5.5m → £5.6m)

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


def uk_now() -> datetime:
    return datetime.now(LONDON)


def uk_today_stamp(when: datetime | None = None) -> str:
    return (when or uk_now()).strftime("%Y-%m-%d")


def add_uk_calendar_days(uk_date: str, days: int = 1) -> str:
    d = datetime.strptime(uk_date, "%Y-%m-%d") + timedelta(days=days)
    return d.strftime("%Y-%m-%d")


def uk_night_from_changed_at_iso(changed_at: str) -> str:
    """UK calendar date for a midnight changedAt timestamp."""
    dt = datetime.fromisoformat(changed_at.replace("Z", "+00:00"))
    return dt.astimezone(LONDON).strftime("%Y-%m-%d")


def uk_price_change_effective_date_for_snapshot_date(snapshot_date: str) -> str:
    """UTC bootstrap filename date → UK label date for the midnight change.

    Ownership snapshots use UTC calendar dates in filenames. FPL applies changes
    at UK midnight, so new prices in snapshot D align with the UK label D+1
    during BST (matches live poll labels).
    """
    return add_uk_calendar_days(snapshot_date, 1)


def stamp_actual_change_night(events: list[dict], uk_night: str) -> list[dict]:
    changed_at = uk_midnight_utc_iso_for_date(uk_night)
    return [
        {**ev, "changedAt": changed_at, "changeNightUk": uk_night}
        for ev in events
    ]


# Live-captured Sep 2 UK night — already labeled correctly.
_LEGACY_ACTUAL_CHANGE_CUTOFF = "2026-09-01T23:00:00Z"


def migrate_legacy_actual_change_dates(events: list[dict]) -> tuple[list[dict], int]:
    """Bump backfilled changedAt values that predate the first live UK poll."""
    changed = 0
    out: list[dict] = []
    for ev in events:
        row = dict(ev)
        at = str(row.get("changedAt") or "")
        if at and at < _LEGACY_ACTUAL_CHANGE_CUTOFF:
            dt = datetime.fromisoformat(at.replace("Z", "+00:00"))
            row["changedAt"] = (dt + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
            changed += 1
        if not row.get("changeNightUk") and row.get("changedAt"):
            row["changeNightUk"] = uk_night_from_changed_at_iso(str(row["changedAt"]))
        out.append(row)
    return out, changed


def uk_midnight_utc_iso(for_night: datetime | None = None) -> str:
    """UTC ISO for 00:00 Europe/London on the UK calendar date of for_night."""
    when = for_night or uk_now()
    midnight = when.replace(hour=0, minute=0, second=0, microsecond=0)
    return midnight.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def uk_midnight_utc_iso_for_date(uk_date: str) -> str:
    """UTC ISO for 00:00 Europe/London on a YYYY-MM-DD UK calendar date."""
    midnight = datetime.strptime(uk_date, "%Y-%m-%d").replace(tzinfo=LONDON)
    return midnight.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def bootstrap_snapshot_date(path: Path) -> str:
    match = BOOTSTRAP_DATE_RE.search(path.name)
    if not match:
        raise ValueError(f"not a dated bootstrap snapshot: {path.name}")
    return match.group(1)


def should_run_baseline_poll(when: datetime | None = None) -> bool:
    """~23:57–23:59 UK — snapshot costs before midnight update."""
    now = when or uk_now()
    return now.hour == 23 and now.minute >= 57


def change_night_has_events(night: str) -> bool:
    return any(
        str(e.get("changeNightUk") or "") == night for e in load_actual_changes_log()
    )


def pending_change_night_uk(when: datetime | None = None) -> str | None:
    """UK calendar date of a 00:00 batch not yet logged (None if up to date)."""
    now = when or uk_now()
    night = uk_today_stamp(now)
    if now.hour == 0 and now.minute < 1:
        return None
    state = load_actual_state()
    if state.get("lastChangeNightUk") == night:
        return None
    if change_night_has_events(night):
        return None
    return night


def should_accept_quiet_night(when: datetime | None = None) -> bool:
    """After 07:00 UK, close a pending night with no price moves."""
    now = when or uk_now()
    return now.hour >= 7 and pending_change_night_uk(now) is not None


def should_run_change_poll(when: datetime | None = None) -> bool:
    """Detect overnight price changes at 00:00 UK, with catch-up until noon."""
    now = when or uk_now()
    if now.hour == 0 and now.minute <= 45:
        return True
    return pending_change_night_uk(now) is not None and now.hour < 12


def next_price_change_at_iso() -> str:
    now = uk_now()
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


def players_from_slim_checkin(ci: dict, snap: dict | None) -> list[dict]:
    """Hydrate full predictor rows from a slim check-in + optional bootstrap meta."""
    meta: dict[int, dict] = {}
    if snap:
        meta, _costs = _player_meta_maps(snap)
    status_label = {
        "very_likely_rise": "Very likely to rise",
        "likely_rise": "Likely to rise",
        "likely_drop": "Likely to drop",
        "very_likely_drop": "Very likely to drop",
    }
    out: list[dict] = []
    for p in ci.get("players") or []:
        code = p.get("code")
        if code is None:
            continue
        try:
            code_i = int(code)
        except (TypeError, ValueError):
            continue
        m = meta.get(code_i) or {}
        sk = p.get("statusKey") or ""
        try:
            lk = int(p.get("likelihood") or 0)
        except (TypeError, ValueError):
            lk = 0
        out.append(
            {
                "code": code_i,
                "name": m.get("name") or str(code_i),
                "team": m.get("team"),
                "position": m.get("position"),
                "price": p.get("price") if p.get("price") is not None else 0,
                "progress": round(float_field(p.get("progress")), 1),
                "predicted": round(float_field(p.get("predicted")), 1),
                "likelihood": lk,
                "statusKey": sk,
                "statusLabel": status_label.get(sk, sk or "—"),
                "trend": p.get("trend") or "up",
                "injuryStatus": "a",
            }
        )
    status_order = {
        "very_likely_rise": 0,
        "likely_rise": 1,
        "very_likely_drop": 2,
        "likely_drop": 3,
    }
    out.sort(
        key=lambda row: (
            status_order.get(row["statusKey"], 9),
            -abs(row["predicted"]),
            row["name"],
        )
    )
    return out


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


def _player_meta_maps(snap: dict) -> tuple[dict[int, dict], dict[int, int]]:
    """Return (code → {name, team, position}, code → now_cost tenths)."""
    teams_by_id = {t["id"]: t.get("short_name") for t in snap.get("teams") or []}
    postype_by_id = {
        e["id"]: e.get("singular_name_short") for e in snap.get("element_types") or []
    }
    meta: dict[int, dict] = {}
    costs: dict[int, int] = {}
    for e in snap.get("elements") or []:
        code = e.get("code")
        if code is None:
            continue
        try:
            code_i = int(code)
            cost = int(e.get("now_cost") or 0)
        except (TypeError, ValueError):
            continue
        pos_raw = postype_by_id.get(e.get("element_type"), "") or ""
        pos = FPL_POS_MAP.get(pos_raw, pos_raw or None)
        meta[code_i] = {
            "name": e.get("web_name") or e.get("second_name") or str(code_i),
            "team": teams_by_id.get(e.get("team")),
            "position": pos,
        }
        costs[code_i] = cost
    return meta, costs


def costs_index_from_snap(snap: dict) -> dict[int, int]:
    return _player_meta_maps(snap)[1]


def costs_differ(prev_costs: dict[int, int], next_costs: dict[int, int]) -> bool:
    for code, after in next_costs.items():
        if prev_costs.get(code) != after:
            return True
    return False


def diff_costs_for_actual_changes(
    prev_costs: dict[int, int],
    next_snap: dict,
    changed_at: str,
) -> list[dict]:
    """Emit £0.1 events between a baseline cost index and a bootstrap snapshot."""
    prev_meta = _player_meta_maps(next_snap)[0]  # names from latest
    _, next_costs = _player_meta_maps(next_snap)
    events: list[dict] = []
    for code, after_tenths in next_costs.items():
        before_tenths = prev_costs.get(code)
        if before_tenths is None or before_tenths == after_tenths:
            continue
        delta = after_tenths - before_tenths
        if abs(delta) != FPL_COST_STEP:
            continue
        info = prev_meta.get(code) or {}
        events.append(
            {
                "code": code,
                "name": info.get("name") or str(code),
                "team": info.get("team"),
                "position": info.get("position"),
                "direction": "rise" if delta > 0 else "fall",
                "before": round(before_tenths / 10.0, 1),
                "after": round(after_tenths / 10.0, 1),
                "changedAt": changed_at,
                "changeNightUk": uk_night_from_changed_at_iso(changed_at),
            }
        )
    return events


def diff_snapshots_for_actual_changes(
    prev_snap: dict,
    next_snap: dict,
    changed_at: str,
) -> list[dict]:
    """Emit £0.1 price-change events between two bootstrap snapshots."""
    prev_costs = costs_index_from_snap(prev_snap)
    return diff_costs_for_actual_changes(prev_costs, next_snap, changed_at)


def load_actual_state() -> dict:
    if not ACTUAL_STATE_PATH.exists():
        return {}
    try:
        row = json.loads(ACTUAL_STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return row if isinstance(row, dict) else {}


def save_actual_state(state: dict) -> None:
    PRICE_ACTUAL_DIR.mkdir(parents=True, exist_ok=True)
    ACTUAL_STATE_PATH.write_text(
        json.dumps(state, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )


def baseline_costs_from_state(state: dict) -> dict[int, int]:
    raw = state.get("costsByCode") or {}
    out: dict[int, int] = {}
    for k, v in raw.items():
        try:
            out[int(k)] = int(v)
        except (TypeError, ValueError):
            continue
    return out


def update_actual_state_costs(
    snap: dict,
    *,
    result: str,
    change_night_uk: str | None = None,
    mark_night_recorded: bool = True,
) -> None:
    state = load_actual_state()
    costs = costs_index_from_snap(snap)
    state["costsByCode"] = {str(k): v for k, v in costs.items()}
    state["baselineAt"] = generated_at()
    state["lastPollAt"] = state["baselineAt"]
    state["lastPollResult"] = result
    if change_night_uk and mark_night_recorded:
        state["lastChangeNightUk"] = change_night_uk
    save_actual_state(state)


def resolve_baseline_costs(data: dict) -> dict[int, int]:
    """Pre-midnight costs for diffing: state baseline, else latest dated bootstrap."""
    state = load_actual_state()
    baseline = baseline_costs_from_state(state)
    if baseline:
        return baseline
    paths = bootstrap_snapshot_paths()
    paths = [p for p in paths if "archived" not in p.stem]
    if paths:
        try:
            prev = json.loads(paths[-1].read_text(encoding="utf-8"))
            if paths[-1].name != f"bootstrap-static_{uk_today_stamp()}.json":
                return costs_index_from_snap(prev)
        except (OSError, json.JSONDecodeError):
            pass
    return costs_index_from_snap(data)


def poll_actual_changes_from_bootstrap(
    data: dict,
    *,
    change_night: str | None = None,
    quiet_if_no_diff: bool = False,
) -> tuple[int, str | None, list[dict]]:
    """Diff bootstrap vs baseline for a UK night. Returns (added, night, events)."""
    night = change_night or pending_change_night_uk()
    if not night:
        return 0, None, []
    changed_at = uk_midnight_utc_iso_for_date(night)
    baseline = resolve_baseline_costs(data)
    latest_costs = costs_index_from_snap(data)
    if not costs_differ(baseline, latest_costs):
        if quiet_if_no_diff:
            update_actual_state_costs(
                data,
                result="no_changes",
                change_night_uk=night,
            )
        return 0, night, []

    events = diff_costs_for_actual_changes(baseline, data, changed_at)
    events = [{**ev, "changeNightUk": night} for ev in events]
    if not events:
        return 0, night, []

    added = append_actual_changes(events)
    update_actual_state_costs(data, result="changes", change_night_uk=night)
    return added, night, events


def diff_checkins_for_actual_changes(
    prev_checkin: dict,
    next_checkin: dict,
    meta_snap: dict | None,
    changed_at: str,
) -> list[dict]:
    """Emit £0.1 events between consecutive slim price check-ins."""
    prev_prices = {
        int(p["code"]): int(round(float(p["price"]) * 10))
        for p in prev_checkin.get("players") or []
        if p.get("code") is not None and p.get("price") is not None
    }
    next_prices = {
        int(p["code"]): int(round(float(p["price"]) * 10))
        for p in next_checkin.get("players") or []
        if p.get("code") is not None and p.get("price") is not None
    }
    meta = _player_meta_maps(meta_snap)[0] if meta_snap else {}
    events: list[dict] = []
    for code, after_tenths in next_prices.items():
        before_tenths = prev_prices.get(code)
        if before_tenths is None or before_tenths == after_tenths:
            continue
        delta = after_tenths - before_tenths
        if abs(delta) != FPL_COST_STEP:
            continue
        info = meta.get(code) or {}
        events.append(
            {
                "code": code,
                "name": info.get("name") or str(code),
                "team": info.get("team"),
                "position": info.get("position"),
                "direction": "rise" if delta > 0 else "fall",
                "before": round(before_tenths / 10.0, 1),
                "after": round(after_tenths / 10.0, 1),
                "changedAt": changed_at,
                "changeNightUk": uk_night_from_changed_at_iso(changed_at),
            }
        )
    return events


def _actual_event_key(event: dict) -> tuple:
    return (
        int(event.get("code") or 0),
        float(event.get("before") or 0),
        float(event.get("after") or 0),
        str(event.get("changedAt") or ""),
    )


def load_actual_changes_log() -> list[dict]:
    if not ACTUAL_CHANGES_PATH.exists():
        return []
    try:
        data = json.loads(ACTUAL_CHANGES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(data, list):
        return [e for e in data if isinstance(e, dict)]
    if isinstance(data, dict) and isinstance(data.get("changes"), list):
        return [e for e in data["changes"] if isinstance(e, dict)]
    return []


def save_actual_changes_log(events: list[dict]) -> None:
    PRICE_ACTUAL_DIR.mkdir(parents=True, exist_ok=True)
    ACTUAL_CHANGES_PATH.write_text(
        json.dumps(events, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )


def dedupe_actual_events(events: list[dict]) -> list[dict]:
    seen: set[tuple] = set()
    out: list[dict] = []
    for ev in events:
        key = _actual_event_key(ev)
        if key in seen:
            continue
        seen.add(key)
        out.append(ev)
    return out


def append_actual_changes(new_events: list[dict]) -> int:
    if not new_events:
        return 0
    existing = load_actual_changes_log()
    seen = {_actual_event_key(e) for e in existing}
    added = 0
    for ev in new_events:
        key = _actual_event_key(ev)
        if key in seen:
            continue
        seen.add(key)
        existing.append(ev)
        added += 1
    if added:
        save_actual_changes_log(existing)
    return added


def infer_change_night_uk(
    code: int,
    before: float,
    after: float,
    snapshots: dict[str, dict],
) -> str | None:
    """Earliest snapshot transition date matching this £0.1 move."""
    before_t = int(round(float(before) * 10))
    after_t = int(round(float(after) * 10))
    if abs(after_t - before_t) != FPL_COST_STEP:
        return None
    dates = sorted(snapshots)
    for i in range(1, len(dates)):
        prev_d, next_d = dates[i - 1], dates[i]
        prev_c = _cost_on_date(snapshots, code, prev_d)
        next_c = _cost_on_date(snapshots, code, next_d)
        if prev_c == before_t and next_c == after_t:
            return next_d
    return None


def _cost_on_date(snapshots: dict[str, dict], code: int, date: str) -> int | None:
    snap = snapshots.get(date)
    if not snap:
        return None
    for e in snap.get("elements") or []:
        if int(e.get("code") or 0) == code:
            try:
                return int(e.get("now_cost") or 0)
            except (TypeError, ValueError):
                return None
    return None


def reattribute_events_to_earliest_snapshot(
    events: list[dict], snapshots: dict[str, dict]
) -> tuple[list[dict], int]:
    changed = 0
    out: list[dict] = []
    for ev in events:
        night = infer_change_night_uk(
            int(ev.get("code") or 0),
            float(ev.get("before") or 0),
            float(ev.get("after") or 0),
            snapshots,
        )
        if night:
            effective = uk_price_change_effective_date_for_snapshot_date(night)
            new_at = uk_midnight_utc_iso_for_date(effective)
            if ev.get("changedAt") != new_at or ev.get("changeNightUk") != effective:
                ev = {**ev, "changedAt": new_at, "changeNightUk": effective}
                changed += 1
        out.append(ev)
    return out, changed


def backfill_actual_changes_from_snapshots(
    *, replace: bool = False, use_focal: bool = True
) -> dict:
    """Rebuild actual-changes.json from consecutive bootstrap-static snapshots.

    Each pair (D-1, D) attributes single £0.1 steps to UK midnight on D.
    Multi-day gaps only capture a change when the total delta is exactly £0.1.
    When use_focal is True, FPL Focal X posts re-attribute dates across gaps.
    """
    paths = bootstrap_snapshot_paths()
    if len(paths) < 2:
        return {"pairs": 0, "events": 0, "saved": 0, "snapshotAdjusted": 0, "focalAdjusted": 0}

    events: list[dict] = []
    pairs = 0
    for prev_path, next_path in zip(paths, paths[1:]):
        try:
            next_date = bootstrap_snapshot_date(next_path)
            prev_snap = json.loads(prev_path.read_text(encoding="utf-8"))
            next_snap = json.loads(next_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            print(f"skip {prev_path.name} → {next_path.name}: {exc}", file=sys.stderr)
            continue
        changed_at = uk_midnight_utc_iso_for_date(
            uk_price_change_effective_date_for_snapshot_date(next_date)
        )
        batch = diff_snapshots_for_actual_changes(prev_snap, next_snap, changed_at)
        if batch:
            pairs += 1
            events.extend(batch)

    events = dedupe_actual_events(events)
    snapshots = _snapshots_by_date_from_paths(paths)
    snapshot_adjusted = 0
    if events and snapshots:
        events, snapshot_adjusted = reattribute_events_to_earliest_snapshot(
            events, snapshots
        )
        events = dedupe_actual_events(events)

    focal_adjusted = 0
    if use_focal and events:
        try:
            from price_actual_focal import (
                load_focal_nights_cached_or_fetch,
                reattribute_events_with_focal,
            )

            latest_snap = json.loads(paths[-1].read_text(encoding="utf-8"))
            focal_nights = load_focal_nights_cached_or_fetch(latest_snap)
            events, focal_adjusted = reattribute_events_with_focal(
                events, focal_nights, snapshots
            )
            events = dedupe_actual_events(events)
        except Exception as exc:
            print(f"focal reattribution skipped: {exc}", file=sys.stderr)

    if replace:
        save_actual_changes_log(events)
        saved = len(events)
    else:
        saved = append_actual_changes(events)
    return {
        "pairs": pairs,
        "events": len(events),
        "saved": saved,
        "snapshotAdjusted": snapshot_adjusted,
        "focalAdjusted": focal_adjusted,
    }


def _snapshots_by_date_from_paths(paths: list[Path]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for path in paths:
        try:
            day = bootstrap_snapshot_date(path)
            out[day] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, ValueError):
            continue
    return out


def actual_changes_newest_first() -> list[dict]:
    rows = load_actual_changes_log()
    rows.sort(key=lambda e: str(e.get("changedAt") or ""), reverse=True)
    return rows


def record_actual_changes_from_bootstrap(
    latest_snap: dict,
    changed_at: str,
    *,
    previous_snap: dict | None = None,
) -> int:
    if previous_snap is None:
        paths = bootstrap_snapshot_paths()
        if len(paths) < 2:
            return 0
        try:
            previous_snap = json.loads(paths[-2].read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return 0
    events = diff_snapshots_for_actual_changes(previous_snap, latest_snap, changed_at)
    return append_actual_changes(events)


def record_actual_changes_from_checkin(
    latest_checkin: dict,
    changed_at: str,
    *,
    previous_checkin: dict | None = None,
    meta_snap: dict | None = None,
) -> int:
    if previous_checkin is None:
        paths = price_checkin_paths()
        if len(paths) < 2:
            return 0
        previous_checkin = load_checkin(paths[-2])
        if not previous_checkin:
            return 0
    events = diff_checkins_for_actual_changes(
        previous_checkin, latest_checkin, meta_snap, changed_at
    )
    return append_actual_changes(events)


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
    meta_snap = latest_snap

    if latest_snap is not None:
        latest_players = price_changes_from_snapshot(latest_snap, source or "")
    elif check_ins:
        # Rebuild identity from newest bootstrap snapshot when only slim check-ins exist.
        paths = bootstrap_snapshot_paths()
        if paths:
            try:
                snap = json.loads(paths[-1].read_text(encoding="utf-8"))
                meta_snap = snap
                latest_players = price_changes_from_snapshot(snap, paths[-1].name)
                source = paths[-1].name
            except (OSError, json.JSONDecodeError):
                latest_players = []

    # FPL sometimes returns a post-deadline window with no includable movers
    # (likelihood ±1/0 only). Never wipe a good Prices page — fall back to the
    # newest non-empty check-in hydrated with bootstrap names/teams.
    if not latest_players:
        if meta_snap is None:
            paths = bootstrap_snapshot_paths()
            if paths:
                try:
                    meta_snap = json.loads(paths[-1].read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    meta_snap = None
        for ci in reversed(check_ins):
            if not (ci.get("players") or []):
                continue
            latest_players = players_from_slim_checkin(ci, meta_snap)
            source = ci.get("source") or source
            break

    players = enrich_players_with_history(latest_players, check_ins)
    payload = {
        "generatedAt": generated_at(),
        "source": source,
        "nextChangeAt": next_price_change_at_iso(),
        "gameweeks": gameweeks_from_latest_bootstrap(),
        "checkIns": check_ins,
        "players": players,
        "actualChanges": actual_changes_newest_first(),
    }
    write_price_changes_js(payload)
    return payload
