"""Rolling FPL live-stat diffs after full-time (BPS / DefCon / scoring tweaks).

Polls piggyback `fetch_home.py`'s existing `/event/{gw}/live/` fetch. First
sighting of a completed-match player is the baseline (not a log event); later
snapshots append only real field changes. Cache lives on disk for the droplet
and is not part of the static git bundle.
"""
from __future__ import annotations

import json
from pathlib import Path

from gw_element_stats import DEFCON_THRESHOLD_BY_TYPE, defcon_hit, normalize_element_gw_record
from live_scoring import fixture_is_full_time, fixture_is_live, fixtures_for_element

SITE = Path(__file__).resolve().parent
CACHE_PATH = SITE / "stat_adjustments_cache.json"
CACHE_GEN = 3
LOG_CAP = 150
PUBLIC_CAP = 40

POS_LABEL = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}

# Slim snapshot fields we diff. `defCon` is the position-relevant action count.
DIFF_FIELDS = (
    ("pts", "Pts"),
    ("goals", "Goals"),
    ("assists", "Assists"),
    ("bonus", "Bonus"),
    ("bps", "BPS"),
    ("defCon", "DefCon"),
    ("cs", "CS"),
    ("saves", "Saves"),
    ("gc", "GC"),
    ("yc", "YC"),
    ("rc", "RC"),
    ("og", "OG"),
    ("pm", "Pen miss"),
    ("ps", "Pen save"),
    ("minutes", "Mins"),
)


def _inum(v) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _player_watchable(element: dict, fixtures: list[dict]) -> bool:
    """True once FPL has marked this player's started fixtures full-time.

    Uses official ``finished`` / ``finished_provisional`` only — not minutes ≥ 90.
    """
    fxs = fixtures_for_element(element, fixtures)
    started = [
        fx
        for fx in fxs
        if fixture_is_full_time(fx) or fixture_is_live(fx) or fx.get("started")
    ]
    if not started:
        return False
    return all(fixture_is_full_time(fx) for fx in started)


def _defcon_actions(etype: int, cbit: int, cbitr: int) -> int:
    if etype == 2:
        return cbit
    if etype in (3, 4):
        return cbitr
    return 0


def slim_player(
    eid: int,
    rec: dict,
    *,
    name: str,
    team: str,
    code: int | None,
) -> dict:
    etype = _inum(rec.get("elementType"))
    cbit = _inum(rec.get("cbit"))
    cbitr = _inum(rec.get("cbitr"))
    return {
        "id": eid,
        "name": name,
        "team": team,
        "code": code,
        "pos": POS_LABEL.get(etype, ""),
        "etype": etype,
        "pts": _inum(rec.get("pts")),
        "goals": _inum(rec.get("goals")),
        "assists": _inum(rec.get("assists")),
        "bonus": _inum(rec.get("bonus")),
        "bps": _inum(rec.get("bps")),
        "minutes": _inum(rec.get("minutes")),
        "cs": _inum(rec.get("cleanSheets")),
        "saves": _inum(rec.get("saves")),
        "gc": _inum(rec.get("goalsConceded")),
        "yc": _inum(rec.get("yellowCards")),
        "rc": _inum(rec.get("redCards")),
        "og": _inum(rec.get("ownGoals")),
        "pm": _inum(rec.get("penaltiesMissed")),
        "ps": _inum(rec.get("penaltiesSaved")),
        "cbit": cbit,
        "cbitr": cbitr,
        "defCon": _defcon_actions(etype, cbit, cbitr),
        "defConHit": bool(rec.get("defConHit")),
        "threshold": DEFCON_THRESHOLD_BY_TYPE.get(etype),
    }


def _threshold_flag(field: str, prev: dict, curr: dict) -> str | None:
    if field == "defCon":
        was = bool(prev.get("defConHit"))
        now = bool(curr.get("defConHit"))
        if not was and now:
            return "hit"
        if was and not now:
            return "lost"
        return None
    if field == "bonus":
        a, b = _inum(prev.get("bonus")), _inum(curr.get("bonus"))
        if a <= 0 < b:
            return "hit"
        if a > 0 >= b:
            return "lost"
        return None
    if field == "cs":
        a, b = _inum(prev.get("cs")), _inum(curr.get("cs"))
        if a <= 0 < b:
            return "hit"
        if a > 0 >= b:
            return "lost"
        return None
    return None


def diff_player(prev: dict, curr: dict) -> list[dict]:
    changes = []
    for field, label in DIFF_FIELDS:
        a = _inum(prev.get(field))
        b = _inum(curr.get(field))
        if a == b:
            continue
        row = {
            "stat": field,
            "label": label,
            "from": a,
            "to": b,
        }
        flag = _threshold_flag(field, prev, curr)
        if flag:
            row["threshold"] = flag
        changes.append(row)
    return changes


def load_cache(path: Path | None = None) -> dict:
    target = path or CACHE_PATH
    if not target.exists():
        return {}
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def save_cache(cache: dict, path: Path | None = None) -> None:
    target = path or CACHE_PATH
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache, separators=(",", ":")), encoding="utf-8")
    tmp.replace(target)


def public_stat_log(cache: dict) -> dict:
    log = cache.get("log") if isinstance(cache.get("log"), list) else []
    return {
        "gw": cache.get("gw"),
        "gen": _inum(cache.get("gen")) or CACHE_GEN,
        "updatedAt": cache.get("updatedAt"),
        "entries": log[:PUBLIC_CAP],
    }


def empty_stat_log(gw: int | None = None) -> dict:
    return {"gw": gw, "gen": CACHE_GEN, "updatedAt": None, "entries": []}


def update_stat_log(
    *,
    gw: int,
    checked_at: str,
    live: dict,
    fixtures: list[dict],
    elements: dict[int, dict],
    teams: dict[int, dict],
    owners_by_element: dict[int, list[int]] | None = None,
    gw_settled: bool = False,
    cache_path: Path | None = None,
) -> dict:
    """Diff completed-match players vs last snapshot; persist + return public log."""
    cache = load_cache(cache_path)
    if _inum(cache.get("gw")) != int(gw) or _inum(cache.get("gen")) != CACHE_GEN:
        cache = {"gw": int(gw), "gen": CACHE_GEN, "updatedAt": checked_at, "players": {}, "log": []}

    if gw_settled and cache.get("frozen"):
        # Already captured the lock snapshot — keep the recap.
        return public_stat_log(cache)

    prev_players = cache.get("players") if isinstance(cache.get("players"), dict) else {}
    log = list(cache.get("log") or [])
    owners = owners_by_element or {}
    next_players: dict[str, dict] = {}
    new_events: list[dict] = []

    live_elements = live.get("elements") if isinstance(live, dict) else None
    if not isinstance(live_elements, list):
        live_elements = []

    for row in live_elements:
        if not isinstance(row, dict):
            continue
        try:
            eid = int(row.get("id"))
        except (TypeError, ValueError):
            continue
        el_meta = elements.get(eid) or {}
        if not _player_watchable(el_meta, fixtures):
            continue
        stats = row.get("stats") if isinstance(row.get("stats"), dict) else {}
        if _inum(stats.get("minutes")) <= 0 and _inum(stats.get("bps")) <= 0:
            continue
        try:
            etype = int(el_meta.get("element_type") or 0)
        except (TypeError, ValueError):
            etype = 0
        try:
            team_id = int(el_meta.get("team") or 0)
        except (TypeError, ValueError):
            team_id = 0
        rec = normalize_element_gw_record(stats, element_type=etype, team_id=team_id)
        team_meta = teams.get(team_id) or {}
        team = str(team_meta.get("short_name") or "")
        name = str(el_meta.get("web_name") or el_meta.get("second_name") or f"#{eid}")
        try:
            code = int(el_meta.get("code")) if el_meta.get("code") is not None else None
        except (TypeError, ValueError):
            code = None
        curr = slim_player(eid, rec, name=name, team=team, code=code)
        key = str(eid)
        next_players[key] = curr
        prev = prev_players.get(key)
        if not isinstance(prev, dict):
            continue
        changes = diff_player(prev, curr)
        if not changes:
            continue
        owner_ids = owners.get(eid) or []
        new_events.append(
            {
                "at": checked_at,
                "element": eid,
                "name": name,
                "team": team,
                "pos": curr.get("pos") or "",
                "code": code,
                "owned": len(owner_ids) > 0,
                "ownerCount": len(owner_ids),
                "ptsFrom": _inum(prev.get("pts")),
                "ptsTo": curr["pts"],
                "changes": changes,
            }
        )

    if new_events:
        log = new_events[::-1] + log
        if len(log) > LOG_CAP:
            log = log[:LOG_CAP]

    cache = {
        "gw": int(gw),
        "gen": CACHE_GEN,
        "updatedAt": checked_at,
        "players": next_players or prev_players,
        "log": log,
        "frozen": bool(gw_settled),
    }
    save_cache(cache, cache_path)
    return public_stat_log(cache)
