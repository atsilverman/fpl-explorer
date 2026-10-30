#!/usr/bin/env python3
"""
Home dashboard cache → site/home_data.js (window.FPL_HOME).

Uses live_scoring (Defcon auto-subs + chips) for focus manager squad
and mini-league GW standings. Rank delta arrows compare live ranks to
end-of-previous-GW baselines (frozen in home_rank_baselines.json per
manager/league/GW on first GW2+ refresh). Target manager/league from:
  1) CLI --manager / --league
  2) site/home_prefs.json
  3) first tracked manager + first tracked league

Run:
    python3 site/fetch_home.py
    python3 site/fetch_home.py --manager 296817 --league 954157
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, time as dtime, timedelta, timezone
from pathlib import Path

from fpl_gameweeks import (
    display_gameweek_id,
    extract_gameweeks,
    picks_gameweek_id,
)
from gw_element_stats import normalize_element_gw_record
from stat_adjustments import empty_stat_log, update_stat_log
from player_availability import player_availability_fields
from live_scoring import (
    apply_auto_substitution,
    build_match_status_by_element,
    calculate_manager_points_from_live,
    effective_element_multipliers,
    element_by_id,
    element_type_map,
    fixture_is_final,
    fixture_is_finished,
    fixture_is_live,
    fixtures_for_element,
    gw_fixtures_awaiting_kickoff,
    importance_pct,
    live_stats_map,
    project_graphic_auto_subs,
    team_by_id,
    top_third_entry_ids,
)

SITE = Path(__file__).resolve().parent
SOCAL_LEAGUE_ID = 954157
TRACKED_MANAGERS = [296817, 1404383, 5497737, 185072]
TRACKED_PATH = SITE / "tracked_ids.json"
PREFS_PATH = SITE / "home_prefs.json"
BASELINES_PATH = SITE / "home_rank_baselines.json"
AUTOSUB_CACHE_PATH = SITE / "autosub_points_cache.json"
MANAGER_POINTS_CACHE_PATH = SITE / "manager_points_cache.json"
MANAGER_POINTS_JS_PATH = SITE / "manager_points_data.js"
TEAM_NEWS_PATH = SITE / "team_news_data.json"
OUT_PATH = SITE / "home_data.js"
JSON_PATH = SITE / "home_data.json"
FPL_BASE = "https://fantasy.premierleague.com/api"
UA = "Mozilla/5.0 (compatible; FPL-Explorer/1.0; +local-home)"

# Season chip set — each name has a first-half and second-half window in bootstrap.
CHIP_NAMES = ("wildcard", "freehit", "bboost", "3xc")
CHIP_LABELS = {
    "wildcard": "WC",
    "freehit": "FH",
    "bboost": "BB",
    "3xc": "TC",
}


def generated_at() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


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


def fpl_get_result(path: str) -> tuple[dict | list | None, str | None]:
    """Like fpl_get but returns (data, error) instead of raising."""
    url = f"{FPL_BASE}{path}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read().decode("utf-8")
        data = json.loads(raw) if raw else None
        if data is None:
            return None, f"empty payload from {path}"
        return data, None
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code} {path}"
    except (urllib.error.URLError, RuntimeError, json.JSONDecodeError, OSError) as exc:
        return None, str(exc)


def _parse_home_js_payload(raw: str) -> dict | None:
    try:
        payload = raw.split("=", 1)[1].strip().rstrip(";")
        data = json.loads(payload)
        return data if isinstance(data, dict) else None
    except (json.JSONDecodeError, IndexError, TypeError):
        return None


def read_home_cache() -> dict | None:
    """Read the newest embedded Home cache (JSON API mirror or home_data.js)."""
    candidates: list[dict] = []
    if JSON_PATH.exists():
        try:
            data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                candidates.append(data)
        except (OSError, json.JSONDecodeError):
            pass
    if OUT_PATH.exists():
        try:
            data = _parse_home_js_payload(OUT_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                candidates.append(data)
        except OSError:
            pass
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]

    def stamp(item: dict) -> str:
        return str(item.get("generatedAt") or "")

    return max(candidates, key=stamp)


def fetch_entry_event_picks(entry_id: int, gw: int) -> tuple[dict | None, str | None]:
    """Fetch entry GW picks. Ready when 15 picks returned."""
    data, err = fpl_get_result(f"/entry/{entry_id}/event/{gw}/picks/")
    if err:
        return None, err
    if not isinstance(data, dict):
        return None, "invalid picks payload"
    picks = data.get("picks") or []
    if len(picks) < 15:
        return data, None
    return data, None


def fetch_entry_transfers(entry_id: int) -> tuple[list[dict], str | None]:
    """Fetch an entry's transfer history. Returns ([], err) on failure."""
    data, err = fpl_get_result(f"/entry/{entry_id}/transfers/")
    if err:
        return [], err
    if not isinstance(data, list):
        return [], "invalid transfers payload"
    return [row for row in data if isinstance(row, dict)], None


def next_deadline_gw(bootstrap: dict) -> int | None:
    for ev in bootstrap.get("events") or []:
        if isinstance(ev, dict) and ev.get("is_next"):
            try:
                return int(ev["id"])
            except (KeyError, TypeError, ValueError):
                return None
    return None


def free_transfers_left(
    history_payload: dict | None,
    transfer_rows: list[dict] | None,
    target_gw: int | None,
    ft_max: int = 5,
) -> int | None:
    """Free transfers still unused for ``target_gw`` (the next deadline).

    Banks +1 per GW from the GW after the manager joined (capped at ``ft_max``). WC / FH weeks keep the bank
    as-is but do not earn the +1.
    Transfers already logged for ``target_gw`` (pre-deadline) are subtracted.
    """
    if not isinstance(history_payload, dict) or not target_gw or target_gw <= 1:
        return None
    current = history_payload.get("current")
    if not isinstance(current, list):
        return None
    chip_events: set[int] = set()
    for ch in history_payload.get("chips") or []:
        if isinstance(ch, dict) and ch.get("name") in {"wildcard", "freehit"}:
            try:
                chip_events.add(int(ch.get("event") or 0))
            except (TypeError, ValueError):
                continue
    rows = sorted(
        (r for r in current if isinstance(r, dict)),
        key=lambda r: int(r.get("event") or 0),
    )
    # The joining GW has unlimited transfers; 1 FT arrives the GW after.
    try:
        start_ev = max(1, int(rows[0].get("event") or 1)) if rows else 1
    except (TypeError, ValueError):
        start_ev = 1
    ft = 1
    for row in rows:
        try:
            ev = int(row.get("event") or 0)
            transfers = int(row.get("event_transfers") or 0)
            cost = int(row.get("event_transfers_cost") or 0)
        except (TypeError, ValueError):
            continue
        if ev >= target_gw:
            break
        if ev <= start_ev:
            continue
        if ev in chip_events:
            continue
        free_used = max(0, transfers - round(cost / 4))
        ft = min(ft_max, max(0, ft - free_used) + 1)
    pending = 0
    for row in transfer_rows or []:
        try:
            if int(row.get("event") or 0) == target_gw:
                pending += 1
        except (TypeError, ValueError, AttributeError):
            continue
    return max(0, ft - pending)


def picks_payload_ready(payload: dict | None) -> bool:
    if not payload or not isinstance(payload, dict):
        return False
    return len(payload.get("picks") or []) >= 15


def compute_transfers(
    prev_picks: list,
    curr_picks: list,
    elements: dict[int, dict],
    entry_history: dict | None,
    active_chip: str | None,
    stats: dict[int, dict] | None = None,
    *,
    event_id: int | None = None,
    official_transfers: list[dict] | None = None,
) -> dict:
    """Build transfer moves for the league card.

    Prefer FPL ``/entry/{id}/transfers/`` pairs for the event (recorded like-for-like).
    Wildcard / Free Hit use a same-position squad diff so we do not dump dozens of
    intermediate WC clicks. Squad-diff fallback never pairs across ``element_type``.
    """
    eh = entry_history if isinstance(entry_history, dict) else {}
    chip = (active_chip or "").strip().lower() or None

    def el_name(eid: int) -> str:
        return player_display_name(elements.get(eid) or {})

    def el_type(eid: int) -> int:
        try:
            return int((elements.get(eid) or {}).get("element_type") or 0)
        except (TypeError, ValueError):
            return 0

    def el_gw_points(eid: int) -> int:
        st = (stats or {}).get(eid) if isinstance(stats, dict) else None
        if not isinstance(st, dict):
            return 0
        try:
            return int(st.get("total_points") or 0)
        except (TypeError, ValueError):
            return 0

    def make_move(out_eid: int, in_eid: int) -> dict | None:
        out_type = el_type(out_eid)
        in_type = el_type(in_eid)
        # Hard rule: never invent cross-position pairs.
        if out_type and in_type and out_type != in_type:
            return None
        move = {
            "out": {
                "id": out_eid,
                "name": el_name(out_eid),
                "gwPoints": el_gw_points(out_eid),
                "elementType": out_type or None,
            },
            "in": {
                "id": in_eid,
                "name": el_name(in_eid),
                "gwPoints": el_gw_points(in_eid),
                "elementType": in_type or None,
            },
        }
        move["ptsDelta"] = int(move["in"]["gwPoints"] or 0) - int(move["out"]["gwPoints"] or 0)
        return move

    def moves_from_official(rows: list[dict], gw: int) -> list[dict]:
        out: list[dict] = []
        for row in rows:
            try:
                if int(row.get("event") or 0) != gw:
                    continue
                out_eid = int(row["element_out"])
                in_eid = int(row["element_in"])
            except (KeyError, TypeError, ValueError):
                continue
            move = make_move(out_eid, in_eid)
            if move:
                out.append(move)
        return out

    def moves_from_squad_diff(prev: list, curr: list) -> list[dict]:
        prev_ids = [
            int(p["element"])
            for p in (prev or [])
            if isinstance(p, dict) and p.get("element") is not None
        ]
        curr_ids = [
            int(p["element"])
            for p in (curr or [])
            if isinstance(p, dict) and p.get("element") is not None
        ]
        prev_set = set(prev_ids)
        curr_set = set(curr_ids)
        outs = [eid for eid in prev_ids if eid not in curr_set]
        ins = [eid for eid in curr_ids if eid not in prev_set]

        outs_by: dict[int, list[int]] = {1: [], 2: [], 3: [], 4: []}
        ins_by: dict[int, list[int]] = {1: [], 2: [], 3: [], 4: []}
        for eid in outs:
            et = el_type(eid)
            if et in outs_by:
                outs_by[et].append(eid)
        for eid in ins:
            et = el_type(eid)
            if et in ins_by:
                ins_by[et].append(eid)

        moves: list[dict] = []
        for et in (1, 2, 3, 4):
            for out_eid, in_eid in zip(outs_by[et], ins_by[et]):
                move = make_move(out_eid, in_eid)
                if move:
                    moves.append(move)
        # Drop unmatched outs/ins — never cross-pair positions.
        return moves

    try:
        count = int(eh.get("event_transfers") if eh.get("event_transfers") is not None else 0)
    except (TypeError, ValueError):
        count = 0
    try:
        cost = int(eh.get("event_transfers_cost") or 0)
    except (TypeError, ValueError):
        cost = 0

    moves: list[dict] = []
    use_chip_rebuild = chip in {"wildcard", "freehit"}
    if (
        not use_chip_rebuild
        and event_id is not None
        and isinstance(official_transfers, list)
        and official_transfers
    ):
        moves = moves_from_official(official_transfers, int(event_id))
        if not count:
            count = len(moves)
    if not moves:
        moves = moves_from_squad_diff(prev_picks, curr_picks)
        if not count and not use_chip_rebuild:
            count = len(moves)

    return {
        "count": count,
        "cost": cost,
        "hit": cost > 0,
        "moves": moves,
        "netPtsDelta": sum(int(m.get("ptsDelta") or 0) for m in moves),
        "activeChip": active_chip,
    }



def build_league_picks_status(
    entry_ids: list[int],
    picks_gw: int,
    compare_gw: int,
    picks_by_entry: dict[int, dict | None],
    prev_by_entry: dict[int, dict | None],
    errors: dict[int, str],
) -> dict:
    total = len(entry_ids)
    ready = 0
    pending: list[int] = []
    blackout = False

    for eid in entry_ids:
        payload = picks_by_entry.get(eid)
        if picks_payload_ready(payload):
            ready += 1
        else:
            pending.append(eid)
            err = errors.get(eid) or ""
            if "503" in err or "HTTP 503" in err:
                blackout = True

    picks_ready = total > 0 and ready >= total

    transfers_ready = picks_ready
    if transfers_ready and compare_gw >= 1:
        for eid in entry_ids:
            if not picks_payload_ready(prev_by_entry.get(eid)):
                transfers_ready = False
                break

    return {
        "picksGw": picks_gw,
        "compareGw": compare_gw,
        "total": total,
        "ready": ready,
        "picksReady": picks_ready,
        "transfersReady": transfers_ready,
        "blackout": blackout,
        "checkedAt": generated_at(),
        "pendingEntries": pending,
    }


def load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_json(path: Path, data: dict) -> None:
    path.write_text(
        json.dumps(data, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def rank_baseline_key(manager_id: int, league_id: int) -> str:
    return f"{manager_id}:{league_id}"


def positive_rank(value: object) -> int | None:
    try:
        rank = int(value or 0)
    except (TypeError, ValueError):
        return None
    return rank if rank > 0 else None


def overall_rank_from_history(history: dict | None, gw: int) -> int | None:
    """Overall rank at end of previous GW from entry history."""
    if gw <= 1 or not isinstance(history, dict):
        return None
    for hist in history.get("current") or []:
        try:
            if int(hist.get("event") or 0) == gw - 1:
                return positive_rank(hist.get("overall_rank"))
        except (TypeError, ValueError):
            continue
    return None


def gw_rank_from_history(history: dict | None, gw: int) -> int | None:
    """Gameweek rank for ``gw`` from entry history ``current[].rank``."""
    if gw < 1 or not isinstance(history, dict):
        return None
    for hist in history.get("current") or []:
        try:
            if int(hist.get("event") or 0) == gw:
                return positive_rank(hist.get("rank"))
        except (TypeError, ValueError):
            continue
    return None


def bench_boost_events(history_chips: list | None) -> set[int]:
    """Gameweeks where Bench Boost was played (pine pts count in the XI, not season bench)."""
    out: set[int] = set()
    for ch in history_chips or []:
        if not isinstance(ch, dict):
            continue
        name = str(ch.get("name") or "").strip()
        if name not in {"bboost", "benchboost", "bench_boost"}:
            continue
        try:
            ev = int(ch.get("event") or 0)
        except (TypeError, ValueError):
            continue
        if ev > 0:
            out.add(ev)
    return out


def entry_bench_points_total(
    history_payload: dict | None,
    picks_history: dict | None = None,
    *,
    exclude_events: set[int] | None = None,
    display_gw: int | None = None,
) -> int | None:
    """Season cumulative points left on the bench (FPL ``points_on_bench``).

    Excludes Bench Boost weeks when ``exclude_events`` is provided (those pts
    count in the XI). ``display_gw`` ignores stale picks entry_history from a
    prior GW after a gameweek flip.
    """
    total = 0
    seen = False
    events_seen: set[int] = set()
    skip = exclude_events or set()
    current = (history_payload or {}).get("current") if isinstance(history_payload, dict) else None
    if isinstance(current, list):
        for row in current:
            if not isinstance(row, dict) or "points_on_bench" not in row:
                continue
            try:
                ev = int(row.get("event") or 0)
                if ev > 0 and ev in skip:
                    events_seen.add(ev)
                    continue
                total += int(row.get("points_on_bench") or 0)
                seen = True
                if ev > 0:
                    events_seen.add(ev)
            except (TypeError, ValueError):
                continue
    # Live / current GW may land on picks entry_history before history current updates.
    if isinstance(picks_history, dict) and "points_on_bench" in picks_history:
        try:
            gw_bench = int(picks_history.get("points_on_bench") or 0)
            ev = int(picks_history.get("event") or 0)
            if display_gw is not None and ev > 0 and ev != int(display_gw):
                # Stale picks history from the previous GW after a flip.
                pass
            elif ev > 0 and ev in skip:
                pass
            elif ev > 0 and ev not in events_seen:
                total += gw_bench
                seen = True
            elif not events_seen:
                total += gw_bench
                seen = True
        except (TypeError, ValueError):
            pass
    return total if seen else None


def settled_gameweeks(bootstrap: dict) -> set[int]:
    """GWs FPL has fully processed (``finished`` + ``data_checked``) — official
    ``automatic_subs`` and element points no longer change."""
    out: set[int] = set()
    for ev in bootstrap.get("events") or []:
        try:
            eid = int(ev["id"])
        except (KeyError, TypeError, ValueError):
            continue
        if ev.get("finished") and ev.get("data_checked"):
            out.add(eid)
    return out


def gw_lock_at_iso(last_kickoff: str | None) -> str | None:
    """09:00 Europe/London the calendar day after the last kickoff (2026/27 lockdown)."""
    if not last_kickoff or not isinstance(last_kickoff, str):
        return None
    try:
        from zoneinfo import ZoneInfo

        london = ZoneInfo("Europe/London")
        raw = last_kickoff.strip()
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        nxt = dt.astimezone(london).date() + timedelta(days=1)
        lock = datetime.combine(nxt, dtime(9, 0), tzinfo=london)
        return lock.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError):
        return None


def summarize_gw_progress(
    fixtures: list,
    *,
    deadline_time: str | None,
    gw_settled: bool,
) -> dict:
    """Compact GW pipeline for the Home progress bar."""
    total = 0
    started = 0
    provisional_ft = 0
    final = 0
    last_ko = None
    for fx in fixtures or []:
        if not isinstance(fx, dict):
            continue
        total += 1
        ko = fx.get("kickoff_time")
        if isinstance(ko, str) and ko and (last_ko is None or ko > last_ko):
            last_ko = ko
        if fx.get("started") or fixture_is_finished(fx) or fixture_is_live(fx):
            started += 1
        if fixture_is_finished(fx):
            provisional_ft += 1
        if fixture_is_final(fx):
            final += 1
    return {
        "deadlineTime": deadline_time,
        "lastKickoff": last_ko,
        "lockAt": gw_lock_at_iso(last_ko),
        "fixturesTotal": total,
        "fixturesStarted": started,
        "fixturesProvisionalFt": provisional_ft,
        "fixturesFinal": final,
        "gwSettled": bool(gw_settled),
    }


def score_autosubs(subs: list[dict], points_by_element: dict[int, int]) -> dict:
    """{"pts", "subs": [{"in", "out", "pts"}]} — in-player pts minus out-player pts
    (out played 0′ so usually 0). Subbed-in players always count ×1."""
    rows: list[dict] = []
    total = 0
    for sub in subs or []:
        try:
            in_id = int(sub["in"])
            out_id = int(sub["out"])
        except (KeyError, TypeError, ValueError):
            continue
        pts = int(points_by_element.get(in_id, 0)) - int(points_by_element.get(out_id, 0))
        total += pts
        rows.append({"in": in_id, "out": out_id, "pts": pts})
    return {"pts": total, "subs": rows}


def official_autosubs(picks_payload: dict | None, gw: int) -> list[dict]:
    """FPL ``automatic_subs`` for this GW as [{"in", "out"}]."""
    out: list[dict] = []
    for row in (picks_payload or {}).get("automatic_subs") or []:
        if not isinstance(row, dict):
            continue
        try:
            if int(row.get("event") or gw) != int(gw):
                continue
            out.append({
                "in": int(row["element_in"]),
                "out": int(row["element_out"]),
                "source": "official",
            })
        except (KeyError, TypeError, ValueError):
            continue
    return out


def element_points_map(live_payload: dict | None) -> dict[int, int]:
    out: dict[int, int] = {}
    for eid, stats in live_stats_map(live_payload or {}).items():
        try:
            out[eid] = int(stats.get("total_points") or 0)
        except (TypeError, ValueError):
            out[eid] = 0
    return out


def backfill_autosub_points(
    entry_ids: list[int],
    settled: set[int],
    cache: dict,
) -> bool:
    """Fill cache["entries"][entry][gw] for every settled GW not yet cached.

    Settled GWs never change, so each (entry, GW) is fetched once. A failed
    fetch is skipped (not cached) and retried next run. Returns True if the
    cache changed.
    """
    entries = cache.setdefault("entries", {})
    live_points: dict[int, dict[int, int]] = {}
    changed = False

    def points_for(gw: int) -> dict[int, int] | None:
        if gw in live_points:
            return live_points[gw]
        data, err = fpl_get_result(f"/event/{gw}/live/")
        if err or not isinstance(data, dict):
            snap = SITE.parent / "snapshots" / f"event-live_{gw}.json"
            data = load_json(snap) if snap.exists() else None
        pts = element_points_map(data) if isinstance(data, dict) and data.get("elements") else None
        if pts is not None:
            live_points[gw] = pts
        return pts

    for eid in entry_ids:
        per_entry = entries.setdefault(str(eid), {})
        for gw in sorted(settled):
            if str(gw) in per_entry:
                continue
            payload, err = fetch_entry_event_picks(eid, gw)
            if err or not isinstance(payload, dict):
                # 404 = entry joined after this GW — record a zero so we don't refetch.
                if err and err.startswith("HTTP 404"):
                    per_entry[str(gw)] = {"pts": 0, "subs": []}
                    changed = True
                continue
            pts = points_for(gw)
            if pts is None:
                continue
            per_entry[str(gw)] = score_autosubs(official_autosubs(payload, gw), pts)
            changed = True
    return changed


STACK_KEYS = (
    "minutes",
    "goals",
    "assists",
    "cleanSheets",
    "defcon",
    "bonus",
    "saves",
    "discipline",
)
GOAL_PTS_BY_TYPE = {1: 6, 2: 6, 3: 5, 4: 4}
CS_PTS_BY_TYPE = {1: 4, 2: 4, 3: 1, 4: 0}
GC_DOCK_BY_TYPE = {1: 1, 2: 1, 3: 0, 4: 0}


def empty_points_stack() -> dict[str, int]:
    return {key: 0 for key in STACK_KEYS}


def empty_points_counts() -> dict[str, int]:
    return {key: 0 for key in STACK_KEYS}


def add_points_stack(dst: dict[str, int], src: dict[str, int], mult: int = 1) -> None:
    for key in STACK_KEYS:
        dst[key] = int(dst.get(key) or 0) + int(src.get(key) or 0) * mult


def add_points_counts(dst: dict[str, int], src: dict[str, int]) -> None:
    for key in STACK_KEYS:
        dst[key] = int(dst.get(key) or 0) + int(src.get(key) or 0)


def score_element_points_stack(
    stats: dict | None, element_type: int
) -> tuple[dict[str, int], dict[str, int]]:
    """FPL return-type pts + event counts for one appearance."""
    rec = normalize_element_gw_record(stats or {}, element_type=element_type)
    return score_normalized_points_stack(rec)


def score_normalized_points_stack(
    rec: dict | None,
) -> tuple[dict[str, int], dict[str, int]]:
    rec = rec if isinstance(rec, dict) else {}
    try:
        etype = int(rec.get("elementType") or 0)
    except (TypeError, ValueError):
        etype = 0
    out = empty_points_stack()
    counts = empty_points_counts()
    try:
        mins = int(rec.get("minutes") or 0)
    except (TypeError, ValueError):
        mins = 0
    if mins > 0:
        out["minutes"] = 2 if mins >= 60 else 1
        counts["minutes"] = 1
    try:
        goals = int(rec.get("goals") or 0)
    except (TypeError, ValueError):
        goals = 0
    if goals:
        out["goals"] = goals * GOAL_PTS_BY_TYPE.get(etype, 4)
        counts["goals"] = goals
    try:
        assists = int(rec.get("assists") or 0)
    except (TypeError, ValueError):
        assists = 0
    if assists:
        out["assists"] = assists * 3
        counts["assists"] = assists
    try:
        cs = int(rec.get("cleanSheets") or 0)
    except (TypeError, ValueError):
        cs = 0
    cs_pts = CS_PTS_BY_TYPE.get(etype, 0)
    if cs and cs_pts:
        out["cleanSheets"] = cs * cs_pts
        counts["cleanSheets"] = cs
    try:
        gc = int(rec.get("goalsConceded") or 0)
    except (TypeError, ValueError):
        gc = 0
    gc_dock = GC_DOCK_BY_TYPE.get(etype, 0)
    if gc and gc_dock:
        docks = gc // 2
        out["discipline"] -= docks * gc_dock
        counts["discipline"] += docks
    try:
        saves = int(rec.get("saves") or 0)
    except (TypeError, ValueError):
        saves = 0
    if saves:
        out["saves"] += saves // 3
        counts["saves"] += saves
    try:
        pen_saved = int(rec.get("penaltiesSaved") or 0)
    except (TypeError, ValueError):
        pen_saved = 0
    if pen_saved:
        out["saves"] += pen_saved * 5
        counts["saves"] += pen_saved
    try:
        pen_miss = int(rec.get("penaltiesMissed") or 0)
    except (TypeError, ValueError):
        pen_miss = 0
    if pen_miss:
        out["discipline"] += pen_miss * -2
        counts["discipline"] += pen_miss
    try:
        yc = int(rec.get("yellowCards") or 0)
    except (TypeError, ValueError):
        yc = 0
    if yc:
        out["discipline"] += yc * -1
        counts["discipline"] += yc
    try:
        rc = int(rec.get("redCards") or 0)
    except (TypeError, ValueError):
        rc = 0
    if rc:
        out["discipline"] += rc * -3
        counts["discipline"] += rc
    try:
        og = int(rec.get("ownGoals") or 0)
    except (TypeError, ValueError):
        og = 0
    if og:
        out["discipline"] += og * -2
        counts["discipline"] += og
    if rec.get("defConHit"):
        out["defcon"] = 2
        counts["defcon"] = 1
    try:
        bonus = int(rec.get("bonus") or 0)
    except (TypeError, ValueError):
        bonus = 0
    if bonus:
        out["bonus"] = bonus
        counts["bonus"] = bonus
    return out, counts


def stack_from_picks(
    picks: list | None,
    stats_by_id: dict[int, dict],
    etypes: dict[int, int],
) -> tuple[dict[str, int], dict[str, int]]:
    stack = empty_points_stack()
    counts = empty_points_counts()
    for pick in picks or []:
        if not isinstance(pick, dict):
            continue
        try:
            eid = int(pick["element"])
            mult = int(pick.get("multiplier") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        if mult <= 0:
            continue
        etype = int(etypes.get(eid) or 0)
        one_stack, one_counts = score_element_points_stack(stats_by_id.get(eid), etype)
        add_points_stack(stack, one_stack, mult)
        add_points_counts(counts, one_counts)
    return stack, counts


def stack_from_squad(
    squad: list | None, element_gw: dict[str, dict]
) -> tuple[dict[str, int], dict[str, int]]:
    stack = empty_points_stack()
    counts = empty_points_counts()
    for row in squad or []:
        if not isinstance(row, dict):
            continue
        try:
            eid = int(row["element"])
            mult = int(row.get("multiplier") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        if row.get("autoSubOut"):
            continue
        if row.get("autoSubIn") and mult <= 0:
            mult = 1
        if mult <= 0:
            continue
        rec = element_gw.get(str(eid)) if isinstance(element_gw, dict) else None
        if not isinstance(rec, dict):
            rec = {}
            try:
                rec["elementType"] = int(row.get("elementType") or 0)
            except (TypeError, ValueError):
                rec["elementType"] = 0
        one_stack, one_counts = score_normalized_points_stack(rec)
        add_points_stack(stack, one_stack, mult)
        add_points_counts(counts, one_counts)
    return stack, counts


def load_event_live(gw: int) -> dict | None:
    data, err = fpl_get_result(f"/event/{gw}/live/")
    if isinstance(data, dict) and data.get("elements"):
        return data
    snap = SITE.parent / "snapshots" / f"event-live_{gw}.json"
    loaded = load_json(snap) if snap.exists() else {}
    if isinstance(loaded, dict) and loaded.get("elements"):
        return loaded
    if err:
        print(f"  event live GW{gw} failed: {err}", file=sys.stderr)
    return None


def chips_by_event(history_payload: dict | None) -> dict[int, str]:
    out: dict[int, str] = {}
    for ch in (history_payload or {}).get("chips") or []:
        if not isinstance(ch, dict):
            continue
        try:
            ev = int(ch.get("event") or 0)
        except (TypeError, ValueError):
            continue
        name = str(ch.get("name") or "").lower()
        label = CHIP_LABELS.get(name)
        if ev > 0 and label:
            out[ev] = label
    return out


def slim_history_gws(history_payload: dict | None) -> list[dict]:
    chips = chips_by_event(history_payload)
    rows: list[dict] = []
    for hist in (history_payload or {}).get("current") or []:
        if not isinstance(hist, dict):
            continue
        try:
            gw = int(hist.get("event") or 0)
        except (TypeError, ValueError):
            continue
        if gw <= 0:
            continue
        try:
            points = int(hist.get("points") or 0)
        except (TypeError, ValueError):
            points = 0
        try:
            hits = int(hist.get("event_transfers_cost") or 0)
        except (TypeError, ValueError):
            hits = 0
        rows.append({"gw": gw, "points": points, "hits": max(0, hits), "chip": chips.get(gw)})
    rows.sort(key=lambda row: row["gw"])
    return rows


def fetch_entry_history(entry_id: int) -> dict:
    data, err = fpl_get_result(f"/entry/{entry_id}/history/")
    if err:
        print(f"  history failed entry {entry_id}: {err}", file=sys.stderr)
    return data if isinstance(data, dict) else {}


def backfill_manager_points(
    entry_ids: list[int],
    settled: set[int],
    cache: dict,
    etypes: dict[int, int],
    history_by_entry: dict[int, dict],
) -> bool:
    """Cache settled-GW stacks per entry. Each (entry, gw) is fetched once."""
    entries = cache.setdefault("entries", {})
    live_by_gw: dict[int, dict[int, dict]] = {}
    changed = False

    def stats_for(gw: int) -> dict[int, dict] | None:
        if gw in live_by_gw:
            return live_by_gw[gw]
        payload = load_event_live(gw)
        stats = live_stats_map(payload) if isinstance(payload, dict) else None
        if stats is not None:
            live_by_gw[gw] = stats
        return stats

    for eid in entry_ids:
        per_entry = entries.setdefault(str(eid), {})
        hist_rows = slim_history_gws(history_by_entry.get(eid))
        hist_by_gw = {int(row["gw"]): row for row in hist_rows}
        for gw in sorted(settled):
            key = str(gw)
            cached_row = per_entry.get(key)
            if (
                isinstance(cached_row, dict)
                and "stack" in cached_row
                and "counts" in cached_row
            ):
                continue
            payload, err = fetch_entry_event_picks(eid, gw)
            if err or not isinstance(payload, dict):
                if err and err.startswith("HTTP 404"):
                    hist = hist_by_gw.get(gw) or {}
                    per_entry[key] = {
                        "points": int(hist.get("points") or 0),
                        "hits": int(hist.get("hits") or 0),
                        "chip": hist.get("chip"),
                        "stack": empty_points_stack(),
                        "counts": empty_points_counts(),
                    }
                    changed = True
                continue
            stats = stats_for(gw)
            if stats is None:
                continue
            hist = hist_by_gw.get(gw) or {}
            chip = hist.get("chip")
            if not chip:
                raw_chip = str((payload or {}).get("active_chip") or "").lower()
                chip = CHIP_LABELS.get(raw_chip)
            try:
                picks_pts = int(((payload or {}).get("entry_history") or {}).get("points") or 0)
            except (TypeError, ValueError):
                picks_pts = 0
            try:
                picks_hits = int(((payload or {}).get("entry_history") or {}).get("event_transfers_cost") or 0)
            except (TypeError, ValueError):
                picks_hits = 0
            stack, counts = stack_from_picks((payload or {}).get("picks") or [], stats, etypes)
            per_entry[key] = {
                "points": int(hist.get("points") or picks_pts or 0),
                "hits": max(0, int(hist.get("hits") or picks_hits or 0)),
                "chip": chip,
                "stack": stack,
                "counts": counts,
            }
            changed = True
    return changed


def build_manager_points_by_entry(
    entry_ids: list[int],
    *,
    current_gw: int,
    settled: set[int],
    history_by_entry: dict[int, dict],
    cache: dict,
    squads_by_entry: dict[str, list],
    element_gw: dict[str, dict],
    live_points_by_entry: dict[int, int],
    chip_by_entry: dict[int, str | None],
    gw_awaiting_kickoff: bool,
) -> dict[str, dict]:
    cached_entries = (cache or {}).get("entries") or {}
    out: dict[str, dict] = {}
    for eid in entry_ids:
        hist_rows = slim_history_gws(history_by_entry.get(eid))
        by_gw: dict[int, dict] = {}
        cached = cached_entries.get(str(eid)) or {}
        for row in hist_rows:
            gw = int(row["gw"])
            cached_row = cached.get(str(gw)) if isinstance(cached.get(str(gw)), dict) else {}
            stack = cached_row.get("stack") if isinstance(cached_row.get("stack"), dict) else empty_points_stack()
            counts = cached_row.get("counts") if isinstance(cached_row.get("counts"), dict) else empty_points_counts()
            by_gw[gw] = {
                "gw": gw,
                "points": int(row["points"]),
                "hits": int(row["hits"]),
                "chip": row.get("chip") or cached_row.get("chip"),
                "stack": {key: int(stack.get(key) or 0) for key in STACK_KEYS},
                "counts": {key: int(counts.get(key) or 0) for key in STACK_KEYS},
            }
        if current_gw > 0 and current_gw not in settled:
            squad = squads_by_entry.get(str(eid)) or []
            live_pts = live_points_by_entry.get(eid)
            if gw_awaiting_kickoff:
                live_pts = 0
            elif live_pts is None:
                live_pts = int((by_gw.get(current_gw) or {}).get("points") or 0)
            chip = chip_by_entry.get(eid)
            if chip:
                chip = CHIP_LABELS.get(str(chip).lower(), chip if str(chip).upper() in CHIP_LABELS.values() else None)
            live_stack, live_counts = (
                stack_from_squad(squad, element_gw)
                if not gw_awaiting_kickoff
                else (empty_points_stack(), empty_points_counts())
            )
            by_gw[current_gw] = {
                "gw": current_gw,
                "points": int(live_pts or 0),
                "hits": 0,
                "chip": chip,
                "stack": live_stack,
                "counts": live_counts,
            }
        gws = [by_gw[gw] for gw in sorted(by_gw)]
        out[str(eid)] = {"gws": gws}
    return out


def resolve_gw_rank(
    *,
    gw: int,
    history_payload: dict | None,
    picks_history: dict | None,
    entry: dict | None = None,
) -> int | None:
    """Prefer history/picks ``rank``; mid-GW fall back to entry ``summary_event_rank``."""
    hist_rank = gw_rank_from_history(history_payload, gw)
    if hist_rank:
        return hist_rank
    picks_history = picks_history if isinstance(picks_history, dict) else {}
    picks_rank = positive_rank(picks_history.get("rank"))
    if picks_rank:
        return picks_rank
    entry = entry if isinstance(entry, dict) else {}
    return positive_rank(entry.get("summary_event_rank"))


def resolve_entry_overall_rank_prev(
    *,
    eid: int,
    manager_id: int,
    gw: int,
    focus_overall_rank_prev: int | None,
    picks_history: dict | None,
    history_payload: dict | None,
    cached_row: dict | None,
) -> int | None:
    """Baseline overall rank for intra-GW delta arrows (configured + league views)."""
    if gw <= 1:
        return None
    if eid == manager_id and focus_overall_rank_prev:
        return focus_overall_rank_prev
    # End-of-previous-GW rank from history — picks entry_history overall_rank
    # tracks near-current rank mid-GW and must not be used as the baseline.
    hist_prev = overall_rank_from_history(history_payload, gw)
    if hist_prev:
        return hist_prev
    picks_history = picks_history if isinstance(picks_history, dict) else {}
    picks_prev = positive_rank(picks_history.get("overall_rank"))
    cached_prev = positive_rank((cached_row or {}).get("overallRankPrev"))
    return picks_prev or cached_prev


def cached_standings_by_entry(cached: dict | None, league_id: int) -> dict[int, dict]:
    if not cached or cached.get("leagueId") != league_id:
        return {}
    out: dict[int, dict] = {}
    for row in cached.get("standings") or []:
        if not isinstance(row, dict):
            continue
        try:
            out[int(row["entry"])] = row
        except (KeyError, TypeError, ValueError):
            continue
    return out


def resolve_focus_summary_fields(
    manager_id: int,
    entry: dict,
    picks_history: dict | None,
    cached_summary: dict | None = None,
    *,
    gw_in_play: bool = False,
    league_total: int | None = None,
    live_gw_pts: int | None = None,
) -> dict[str, object]:
    """Overall rank/points/name — entry API, cache, then picks (deadline snapshot).

    During a live GW, picks entry_history.overall_rank is still the pre-deadline /
    post-previous-GW stamp — use entry.summary_overall_rank or the last good cache.
    """
    picks_history = picks_history if isinstance(picks_history, dict) else {}
    cached_summary = cached_summary if isinstance(cached_summary, dict) else {}

    overall_rank = positive_rank(entry.get("summary_overall_rank"))
    picks_rank = positive_rank(picks_history.get("overall_rank"))
    # Mid-GW some FPL edges serve summary_overall_rank == picks entry_history
    # (deadline snapshot). Ignore that stamp while fixtures are live.
    if gw_in_play and overall_rank and picks_rank and overall_rank == picks_rank:
        overall_rank = None
    if overall_rank is None:
        overall_rank = positive_rank(cached_summary.get("overallRank"))
    if overall_rank is None and not gw_in_play:
        overall_rank = picks_rank

    overall_points = int(entry.get("summary_overall_points") or 0)
    picks_total = int(picks_history.get("total_points") or 0)
    if overall_points <= 0:
        overall_points = picks_total
    if overall_points <= 0:
        overall_points = int(cached_summary.get("overallPoints") or 0)
    try:
        league_pts = int(league_total) if league_total is not None else 0
    except (TypeError, ValueError):
        league_pts = 0
    if league_pts > overall_points:
        overall_points = league_pts
    elif gw_in_play and live_gw_pts is not None:
        try:
            live = int(live_gw_pts)
            if live > 0 and picks_total > 0 and overall_points <= picks_total:
                overall_points = picks_total + live
        except (TypeError, ValueError):
            pass

    event_points = int(entry.get("summary_event_points") or 0)
    if event_points <= 0:
        event_points = int(picks_history.get("points") or 0)
    if event_points <= 0:
        event_points = int(cached_summary.get("eventPointsOfficial") or 0)

    team_name = (entry.get("name") or "").strip() or (cached_summary.get("teamName") or "").strip()

    first = (entry.get("player_first_name") or "").strip()
    last = (entry.get("player_last_name") or "").strip()
    manager_name = " ".join(p for p in (first, last) if p).strip()
    if not manager_name:
        manager_name = (cached_summary.get("managerName") or "").strip()
    if not manager_name:
        manager_name = f"Manager {manager_id}"

    return {
        "overallRank": overall_rank or 0,
        "overallPoints": overall_points,
        "eventPointsOfficial": event_points,
        "teamName": team_name,
        "managerName": manager_name,
    }


def chip_windows_from_bootstrap(bootstrap: dict) -> dict[str, list[tuple[int, int]]]:
    """name -> [(start, stop), ...] ordered by start_event (half 1, then half 2)."""
    by_name: dict[str, list[tuple[int, int]]] = {}
    for raw in bootstrap.get("chips") or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        if name not in CHIP_NAMES:
            continue
        try:
            start = int(raw.get("start_event") or 0)
            stop = int(raw.get("stop_event") or 0)
        except (TypeError, ValueError):
            continue
        if start <= 0 or stop <= 0:
            continue
        by_name.setdefault(name, []).append((start, stop))
    for name in by_name:
        by_name[name].sort(key=lambda w: w[0])
    return by_name


def season_chip_half(gw: int, windows: dict[str, list[tuple[int, int]]]) -> int:
    """1 = first half, 2 = second half. Prefer wildcard windows; fall back to GW≤19."""
    for name in ("wildcard", "bboost", "3xc", "freehit"):
        halves = windows.get(name) or []
        if len(halves) >= 2:
            start1, stop1 = halves[0]
            if start1 <= gw <= stop1:
                return 1
            start2, stop2 = halves[1]
            if start2 <= gw <= stop2:
                return 2
            return 1 if gw <= stop1 else 2
        if len(halves) == 1:
            start1, stop1 = halves[0]
            if start1 <= gw <= stop1:
                return 1
    return 1 if gw <= 19 else 2


def entry_chips_for_half(
    history_chips: list,
    active_chip: str | None,
    half: int,
    windows: dict[str, list[tuple[int, int]]],
    gw: int,
) -> dict[str, dict]:
    """Per-chip status for the visible season half: available | used | active."""
    out: dict[str, dict] = {}
    active = str(active_chip or "").strip() or None
    for name in CHIP_NAMES:
        halves = windows.get(name) or []
        if half > len(halves):
            out[name] = {"status": "unavailable", "event": None, "label": CHIP_LABELS[name]}
            continue
        start, stop = halves[half - 1]
        used_event: int | None = None
        for ch in history_chips or []:
            if not isinstance(ch, dict):
                continue
            if str(ch.get("name") or "") != name:
                continue
            try:
                ev = int(ch.get("event") or 0)
            except (TypeError, ValueError):
                continue
            if start <= ev <= stop:
                used_event = ev
                break
        label = CHIP_LABELS[name]
        if active == name and start <= gw <= stop:
            out[name] = {"status": "active", "event": gw, "label": label}
        elif used_event is not None:
            out[name] = {"status": "used", "event": used_event, "label": label}
        else:
            out[name] = {"status": "available", "event": None, "label": label}
    return out


def chip_window_meta(half: int, windows: dict[str, list[tuple[int, int]]], gw: int) -> dict:
    chips = []
    for name in CHIP_NAMES:
        halves = windows.get(name) or []
        if half > len(halves):
            continue
        start, stop = halves[half - 1]
        chips.append(
            {
                "name": name,
                "label": CHIP_LABELS[name],
                "startEvent": start,
                "stopEvent": stop,
            }
        )
    return {
        "half": half,
        "gw": gw,
        "label": "First half" if half == 1 else "Second half",
        "chips": chips,
    }


def resolve_rank_baselines(
    manager_id: int,
    league_id: int,
    gw: int,
    api_overall_prev: int | None,
    api_league_prev: int | None,
    baselines: dict,
) -> tuple[int | None, int | None, bool]:
    """Freeze end-of-previous-GW ranks for intra-GW delta arrows.

    GW1 has no prior gameweek — return None and clear any stale snapshot.
    GW2+ locks baselines on the first refresh of the gameweek; later refreshes
    keep those values while live overall/league ranks update from the API.
    """
    key = rank_baseline_key(manager_id, league_id)
    changed = False

    if gw <= 1:
        if key in baselines:
            del baselines[key]
            changed = True
        return None, None, changed

    stored = baselines.get(key) if isinstance(baselines.get(key), dict) else {}
    if stored.get("gw") == gw:
        overall = positive_rank(stored.get("overallRankPrev"))
        league = positive_rank(stored.get("leagueRankPrev"))
        if overall is None and api_overall_prev:
            overall = api_overall_prev
            stored["overallRankPrev"] = overall
            stored["updatedAt"] = generated_at()
            baselines[key] = stored
            changed = True
        if league is None and api_league_prev:
            league = api_league_prev
            stored["leagueRankPrev"] = league
            stored["updatedAt"] = generated_at()
            baselines[key] = stored
            changed = True
        return overall, league, changed

    overall = api_overall_prev
    league = api_league_prev
    if overall or league:
        baselines[key] = {
            "gw": gw,
            "overallRankPrev": overall,
            "leagueRankPrev": league,
            "updatedAt": generated_at(),
        }
        changed = True
    return overall, league, changed


def write_manager_points_js(payload: dict) -> None:
    """Slim historical Manager Points bundle for Vercel — not the live Home cache."""
    by_entry = payload.get("managerPointsByEntry") or {}
    if not isinstance(by_entry, dict) or not by_entry:
        return
    body = {
        "generatedAt": payload.get("generatedAt") or generated_at(),
        "gw": payload.get("gw"),
        "leagueId": payload.get("leagueId"),
        "byEntry": by_entry,
    }
    MANAGER_POINTS_JS_PATH.write_text(
        f"window.FPL_MANAGER_POINTS = {json.dumps(body, separators=(',', ':'))};\n",
        encoding="utf-8",
    )


def write_home_outputs(payload: dict) -> None:
    """Write Home cache for static embed (JS) and live server API (JSON)."""
    OUT_PATH.write_text(
        f"window.FPL_HOME = {json.dumps(payload, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    JSON_PATH.write_text(
        json.dumps(payload, separators=(",", ":")),
        encoding="utf-8",
    )
    write_manager_points_js(payload)


def resolve_targets(args: argparse.Namespace) -> tuple[int | None, int | None]:
    tracked = load_json(TRACKED_PATH)
    prefs = load_json(PREFS_PATH)
    managers = [int(x) for x in (tracked.get("managers") or [])]
    leagues = [int(x) for x in (tracked.get("leagues") or [])]

    mid = args.manager
    lid = args.league
    if mid is None and prefs.get("managerId") is not None:
        try:
            mid = int(prefs["managerId"])
        except (TypeError, ValueError):
            mid = None
    if lid is None and prefs.get("leagueId") is not None:
        try:
            lid = int(prefs["leagueId"])
        except (TypeError, ValueError):
            lid = None
    if lid is None and leagues:
        lid = SOCAL_LEAGUE_ID if SOCAL_LEAGUE_ID in leagues else leagues[0]
    if lid != SOCAL_LEAGUE_ID:
        lid = SOCAL_LEAGUE_ID
    if mid is None and managers:
        mid = managers[0]
    if mid is not None and mid not in TRACKED_MANAGERS and managers:
        mid = managers[0]
    return mid, lid


def team_short(teams: dict[int, dict], team_id: int) -> str:
    t = teams.get(team_id) or {}
    return (t.get("short_name") or t.get("name") or "?").strip().upper()[:3] or "?"


def player_display_name(el: dict) -> str:
    web = (el.get("web_name") or "").strip()
    if web:
        return web
    first = (el.get("first_name") or "").strip()
    second = (el.get("second_name") or "").strip()
    return " ".join(p for p in (first, second) if p) or f"#{el.get('id')}"


def active_pick_progress(
    active_picks: list[dict],
    elements: dict[int, dict],
    fixtures: list[dict],
    match_status: dict[int, str],
    mults: dict[int, int] | None = None,
) -> tuple[int, int]:
    """(in_play, still_to_play) among active scoring picks.

    Bench Boost can push either count above 11. DGW: live > to-play > done.
    Both counts weight by effective multiplier so a captain contributes +1
    (2 total) and triple captain +2 (3 total), whether still to play or live.
    """
    in_play = 0
    to_play = 0
    for pick in active_picks or []:
        try:
            eid = int(pick["element"])
        except (KeyError, TypeError, ValueError):
            continue
        try:
            if mults is not None:
                mult = int(mults.get(eid) or 0)
            else:
                mult = int(pick.get("multiplier") or 0)
        except (TypeError, ValueError):
            mult = 0
        if mult <= 0:
            mult = 1
        el = elements.get(eid) or {}
        fx_list = fixtures_for_element(el, fixtures)
        if fx_list:
            if any(fixture_is_live(fx) for fx in fx_list):
                in_play += mult
            elif any(not fixture_is_finished(fx) for fx in fx_list):
                to_play += mult
            continue
        status = match_status.get(eid) or "scheduled"
        if status == "live":
            in_play += mult
        elif status != "finished":
            to_play += mult
    return in_play, to_play


def projected_auto_subs_for_ui(
    picks: list[dict],
    stats: dict[int, dict],
    match_status: dict[int, str],
    etypes: dict[int, int],
    chip: str | None,
) -> list[dict]:
    """Auto-subs for pitch/list icons once fixtures are provisionally finished.

    Scoring still uses final-only fixture status so GW totals don't jump before
    FPL stamps auto-subs. Icons can light up earlier (blank starter + FT).
    """
    chip_l = (chip or "").lower()
    if chip_l in {"bboost", "benchboost", "bench_boost"}:
        return []
    if not picks:
        return []
    _active, subs = apply_auto_substitution(picks, stats, match_status, etypes)
    return subs


def load_graphic_named_ids(gw: int) -> dict[str, set[int]]:
    try:
        payload = json.loads(TEAM_NEWS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    try:
        news_gw = int(payload.get("gw"))
    except (TypeError, ValueError):
        news_gw = None
    if news_gw != int(gw):
        return {}
    out: dict[str, set[int]] = {}
    for row in payload.get("teams") or []:
        if not row.get("namedReady"):
            continue
        code = str(row.get("code") or "")
        ids: set[int] = set()
        for raw in row.get("named") or []:
            try:
                ids.add(int(raw))
            except (TypeError, ValueError):
                continue
        if code and len(ids) >= 11:
            out[code] = ids
    return out


def team_code_by_element_map(elements: dict, teams: dict) -> dict[int, str]:
    out: dict[int, str] = {}
    for eid, el in (elements or {}).items():
        try:
            tid = int((el or {}).get("team") or 0)
            code = (teams.get(tid) or {}).get("short_name")
        except (TypeError, ValueError, AttributeError):
            continue
        if code:
            out[int(eid)] = str(code)
    return out


def _with_sub_source(subs: list[dict] | None, source: str) -> list[dict]:
    out: list[dict] = []
    for row in subs or []:
        if not isinstance(row, dict):
            continue
        tagged = dict(row)
        tagged["source"] = tagged.get("source") or source
        out.append(tagged)
    return out


def resolve_ui_auto_subs(
    picks: list[dict],
    stats: dict[int, dict],
    match_status: dict[int, str],
    etypes: dict[int, int],
    chip: str | None,
    *,
    team_codes: dict[int, str],
    graphic_named: dict[str, set[int]],
    official_subs: list[dict] | None = None,
    gw_settled: bool = False,
) -> list[dict]:
    """Pitch/list auto-sub icons.

    Official FPL ``automatic_subs`` wins as soon as it exists — including after
    lock, when the bodies have already moved (IN sits in the XI, OUT on the
    bench). Preview (0′ + FT, then graphics) only runs before that stamp.
    Once the GW is settled with no official pairs, return empty so leftover
    graphic projections cannot invent a second swap.
    """
    official = _with_sub_source(official_subs, "official")
    if official:
        return official
    if gw_settled:
        return []
    ui = projected_auto_subs_for_ui(picks, stats, match_status, etypes, chip)
    if ui:
        return _with_sub_source(ui, "minutes")
    return project_graphic_auto_subs(
        picks, etypes, team_codes, graphic_named, chip, live_stats=stats
    )


def resolve_manager_gw_points(
    picks: list[dict],
    stats: dict,
    match_status: dict[int, str],
    autosub_status: dict[int, str],
    etypes: dict[int, int],
    chip: str | None,
    entry_history: dict | None,
    *,
    any_fixture_live: bool,
    entry_official: int | None = None,
    awaiting_kickoff: bool = False,
) -> tuple[int, list[dict], list[dict]]:
    """Live GW points with safeguards against post-FT autosub drift.

    While matches are live we compute from element points + cautious autosubs
    (final fixture flag only). Once nothing is live, trust FPL's stamped GW
    total when available — picks entry_history.points often stays 0 mid-GW
    until FPL processes the gameweek; entry summary_event_points can lead.

    Pre-kickoff (new current GW, no fixtures started): never trust leftover
    official totals from the previous gameweek — return computed live (0).
    """
    live_pts, active, subs = calculate_manager_points_from_live(
        picks,
        stats,
        match_status,
        etypes,
        chip,
        autosub_match_status=autosub_status,
    )
    eh = entry_history if isinstance(entry_history, dict) else {}
    try:
        cost = int(eh.get("event_transfers_cost") or 0)
    except (TypeError, ValueError):
        cost = 0
    live_pts = max(0, int(live_pts) - cost)

    if awaiting_kickoff:
        return 0, active, subs

    if not any_fixture_live:
        for src in (eh.get("points"), entry_official):
            try:
                if src is not None and int(src) > 0:
                    return int(src), active, subs
            except (TypeError, ValueError):
                continue
    return live_pts, active, subs


def build_squad_rows(
    picks: list[dict],
    active_ids: set[int],
    auto_subs: list[dict],
    live_stats: dict[int, dict],
    match_status: dict[int, str],
    elements: dict[int, dict],
    teams: dict[int, dict],
    fixtures: list[dict],
    our_mults: dict[int, int],
    top_third_mult_maps: list[dict[int, int]],
    *,
    ui_auto_subs: list[dict] | None = None,
) -> list[dict]:
    rows = []
    ordered = sorted(picks, key=lambda p: int(p.get("position") or 0))
    # Icons use projected (provisional FT) subs; scoring active_ids stay final-only.
    flag_subs = ui_auto_subs if ui_auto_subs is not None else auto_subs
    auto_sub_in = {int(s["in"]) for s in (flag_subs or []) if s.get("in") is not None}
    auto_sub_out = {int(s["out"]) for s in (flag_subs or []) if s.get("out") is not None}
    partner_for: dict[int, int] = {}
    source_for: dict[int, str] = {}
    for s in flag_subs or []:
        try:
            out_id = int(s["out"])
            in_id = int(s["in"])
        except (KeyError, TypeError, ValueError):
            continue
        partner_for[out_id] = in_id
        partner_for[in_id] = out_id
        src = str(s.get("source") or "") or None
        if src:
            source_for[out_id] = src
            source_for[in_id] = src

    def partner_name(eid: int) -> str | None:
        other = partner_for.get(eid)
        if other is None:
            return None
        return player_display_name(elements.get(other) or {})

    for pick in ordered:
        eid = int(pick["element"])
        el = elements.get(eid) or {}
        pos = int(pick.get("position") or 0)
        starter_slot = pos <= 11
        is_active = eid in active_ids
        show_starter = starter_slot or eid in auto_sub_in
        fx_list = fixtures_for_element(el, fixtures)
        stats = live_stats.get(eid) or {}
        mins = int(stats.get("minutes") or 0)
        pts = int(stats.get("total_points") or 0)
        mult = int(our_mults.get(eid) or 0)
        if is_active and mult <= 0:
            mult = int(pick.get("multiplier") or 1) or 1
        status = match_status.get(eid) or "scheduled"
        top_mults = [m.get(eid, 0) for m in top_third_mult_maps]
        imp = importance_pct(our_mults.get(eid, 0), top_mults)

        fixture_rows = []
        for fx in fx_list:
            finished = fixture_is_finished(fx)
            live = fixture_is_live(fx)
            try:
                clock = int(fx.get("minutes") or 0)
            except (TypeError, ValueError):
                clock = 0
            fixture_rows.append(
                {
                    "opp": team_short(teams, int(fx["_opp"])),
                    "oppHa": fx["_ha"],
                    "kickoff": fx.get("kickoff_time"),
                    "live": live,
                    "finished": finished,
                    # Official FPL `finished` (not merely finished_provisional).
                    "final": fixture_is_final(fx),
                    "minutes": mins if live or finished else None,
                    # Match minute from /fixtures/ (not the player's appearance minutes).
                    "clock": clock if live or finished else None,
                }
            )
        if not fixture_rows:
            fixture_rows = [
                {
                    "opp": "—",
                    "oppHa": "",
                    "kickoff": None,
                    "live": False,
                    "finished": False,
                    "final": False,
                    "minutes": None,
                    "clock": None,
                }
            ]

        with_id = partner_for.get(eid)
        with_name = partner_name(eid) if with_id is not None else None
        rows.append(
            {
                "code": el.get("code"),
                "element": eid,
                "name": player_display_name(el),
                "team": team_short(teams, int(el.get("team") or 0)),
                "elementType": int(el.get("element_type") or 0),
                "position": pos,
                "starter": show_starter and is_active,
                "onBench": pos > 11,
                "isCaptain": bool(pick.get("is_captain")),
                "isVice": bool(pick.get("is_vice_captain")),
                "multiplier": mult,
                "gwPoints": pts * mult if is_active else pts,
                "basePoints": pts,
                "minutes": mins,
                "matchStatus": status,
                "live": status == "live",
                "fixtures": fixture_rows,
                "opp": fixture_rows[0]["opp"],
                "oppHa": fixture_rows[0]["oppHa"],
                "kickoff": fixture_rows[0]["kickoff"],
                "imp": imp,
                "autoSubIn": eid in auto_sub_in,
                "autoSubOut": eid in auto_sub_out,
                "autoSubWith": with_id,
                "autoSubWithName": with_name,
                "autoSubSource": source_for.get(eid),
                **player_availability_fields(el),
            }
        )
    return rows


def fetch_standings_page(league_id: int, page: int = 1) -> tuple[dict | None, str | None]:
    data, err = fpl_get_result(f"/leagues-classic/{league_id}/standings/?page_standings={page}")
    if err:
        return None, err
    return data if isinstance(data, dict) else None, None


def cached_standings_as_results(cached: dict | None) -> list[dict]:
    """Rebuild raw league rows from a prior home cache during API blackout."""
    rows = (cached or {}).get("standings")
    if not isinstance(rows, list):
        return []
    out: list[dict] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        out.append(
            {
                "entry": row.get("entry"),
                "player_name": row.get("playerName"),
                "entry_name": row.get("entryName"),
                "event_total": row.get("eventTotalOfficial")
                if row.get("eventTotalOfficial") is not None
                else row.get("gwPointsLive"),
                "total": row.get("total"),
                "rank": row.get("rankOfficial")
                if row.get("rankOfficial") is not None
                else row.get("rankLive"),
                "last_rank": row.get("rankPrev"),
                "overall_rank_prev": row.get("overallRankPrev"),
            }
        )
    return out


def fetch_all_standings(league_id: int) -> tuple[list, dict, str | None]:
    """Paginate classic league standings until has_next is false."""
    page = 1
    all_results: list = []
    league_meta: dict = {}
    last_err: str | None = None
    while True:
        payload, err = fetch_standings_page(league_id, page)
        if err:
            last_err = err
            break
        if not isinstance(payload, dict):
            last_err = "invalid standings payload"
            break
        if not league_meta:
            league_meta = payload.get("league") or {}
        standings = payload.get("standings") or {}
        results = standings.get("results") or []
        all_results.extend(results)
        if not standings.get("has_next"):
            break
        page += 1
    return all_results, league_meta, last_err


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch Home dashboard cache")
    parser.add_argument("--manager", type=int, default=None)
    parser.add_argument("--league", type=int, default=None)
    parser.add_argument("--gw", type=int, default=None, help="Override gameweek")
    args = parser.parse_args()

    manager_id, league_id = resolve_targets(args)
    if not manager_id or not league_id:
        empty = {
            "generatedAt": generated_at(),
            "gw": None,
            "managerId": manager_id,
            "leagueId": league_id,
            "leagueName": None,
            "summary": None,
            "squad": [],
            "squadsByEntry": {},
            "standings": [],
            "ownersByElement": {},
            "elementGw": {},
            "leaguePicksStatus": None,
            "transfersSchemaVersion": 2,
            "transfersByEntry": {},
            "gwAwaitingKickoff": False,
            "error": "No manager/league configured. Set Preferences or pass --manager/--league.",
        }
        write_home_outputs(empty)
        print(f"Wrote empty {OUT_PATH.name} (missing manager/league)", file=sys.stderr)
        return 0

    print(f"Home targets: manager={manager_id} league={league_id}")

    try:
        bootstrap, bootstrap_err = fpl_get_result("/bootstrap-static/")
        if bootstrap_err or not isinstance(bootstrap, dict):
            raise RuntimeError(bootstrap_err or "bootstrap-static failed")
        gws = extract_gameweeks(bootstrap, source="bootstrap")
        display_gw = args.gw or display_gameweek_id(gws)
        picks_gw = picks_gameweek_id(gws) or display_gw
        if not display_gw:
            raise RuntimeError("Could not resolve active gameweek")
        # Scoring/UI follow FPL current; league polling may target next GW during blackout.
        gw = display_gw
        transfer_poll_gw = picks_gw if picks_gw > display_gw else None
        compare_gw = display_gw if transfer_poll_gw else max(0, display_gw - 1)
        ft_target_gw = next_deadline_gw(bootstrap)
        try:
            ft_max = 1 + int((bootstrap.get("game_settings") or {}).get("max_extra_free_transfers"))
        except (TypeError, ValueError):
            ft_max = 5

        live_raw, live_err = fpl_get_result(f"/event/{display_gw}/live/")
        live = live_raw if isinstance(live_raw, dict) else {}
        if live_err:
            print(f"  live failed GW{gw}: {live_err}", file=sys.stderr)

        fixtures_raw, fixtures_err = fpl_get_result(f"/fixtures/?event={display_gw}")
        fixtures = fixtures_raw if isinstance(fixtures_raw, list) else []
        if fixtures_err:
            print(f"  fixtures failed GW{gw}: {fixtures_err}", file=sys.stderr)

        entry, entry_err = fpl_get_result(f"/entry/{manager_id}/")
        if not isinstance(entry, dict):
            entry = {}
        if entry_err:
            print(f"  entry failed: {entry_err}", file=sys.stderr)
        history_payload, history_err = fpl_get_result(f"/entry/{manager_id}/history/")
        if not isinstance(history_payload, dict):
            history_payload = {}
        if history_err:
            print(f"  history failed: {history_err}", file=sys.stderr)

        cached = read_home_cache()
        results, league_meta, standings_err = fetch_all_standings(league_id)
        if standings_err:
            print(f"  standings failed: {standings_err}", file=sys.stderr)
        if not results and cached and cached.get("leagueId") == league_id:
            results = cached_standings_as_results(cached)
            if not league_meta.get("name"):
                league_meta = {"name": cached.get("leagueName") or ""}

        entry_ids: list[int] = []
        seen_entries: set[int] = set()
        for row in results:
            try:
                eid = int(row["entry"])
            except (KeyError, TypeError, ValueError):
                continue
            if eid not in seen_entries:
                seen_entries.add(eid)
                entry_ids.append(eid)
        if manager_id not in seen_entries:
            entry_ids.append(manager_id)

        picks_by_entry: dict[int, dict | None] = {}
        prev_by_entry: dict[int, dict | None] = {}
        pick_errors: dict[int, str] = {}
        transfer_picks_by_entry: dict[int, dict | None] = {}

        focus_picks_payload, focus_pick_err = fetch_entry_event_picks(manager_id, display_gw)
        if focus_pick_err:
            pick_errors[manager_id] = focus_pick_err
        picks_by_entry[manager_id] = focus_picks_payload

        if compare_gw >= 1:
            prev_focus, prev_focus_err = fetch_entry_event_picks(manager_id, compare_gw)
            if prev_focus_err:
                pick_errors.setdefault(manager_id, prev_focus_err)
            prev_by_entry[manager_id] = prev_focus

        for eid in entry_ids:
            if eid == manager_id:
                continue
            payload, err = fetch_entry_event_picks(eid, display_gw)
            picks_by_entry[eid] = payload
            if err:
                pick_errors[eid] = err
            if compare_gw >= 1 and not transfer_poll_gw:
                prev_payload, prev_err = fetch_entry_event_picks(eid, compare_gw)
                prev_by_entry[eid] = prev_payload
                if prev_err:
                    pick_errors.setdefault(eid, prev_err)

        status_picks_gw = transfer_poll_gw or display_gw
        status_compare_gw = compare_gw
        if transfer_poll_gw:
            for eid in entry_ids:
                payload, err = fetch_entry_event_picks(eid, transfer_poll_gw)
                transfer_picks_by_entry[eid] = payload
                if err:
                    pick_errors.setdefault(eid, err)
                if eid == manager_id:
                    continue
                if compare_gw >= 1 and eid not in prev_by_entry:
                    prev_payload, prev_err = fetch_entry_event_picks(eid, compare_gw)
                    prev_by_entry[eid] = prev_payload
                    if prev_err:
                        pick_errors.setdefault(eid, prev_err)

        league_picks_status = build_league_picks_status(
            entry_ids,
            status_picks_gw,
            status_compare_gw,
            transfer_picks_by_entry if transfer_poll_gw else picks_by_entry,
            prev_by_entry,
            pick_errors,
        )

        total_players = int(bootstrap.get("total_players") or 0)
        api_overall_prev = None
        for hist in history_payload.get("current") or []:
            try:
                if int(hist.get("event") or 0) == gw - 1:
                    api_overall_prev = positive_rank(hist.get("overall_rank"))
                    break
            except (TypeError, ValueError):
                continue

        api_league_prev = None
        for row in results:
            try:
                if int(row.get("entry") or 0) != manager_id:
                    continue
                api_league_prev = positive_rank(row.get("last_rank"))
                break
            except (TypeError, ValueError):
                continue

        rank_baselines = load_json(BASELINES_PATH)
        overall_rank_prev, league_rank_prev, baselines_changed = resolve_rank_baselines(
            manager_id,
            league_id,
            gw,
            api_overall_prev,
            api_league_prev,
            rank_baselines,
        )
        if baselines_changed:
            save_json(BASELINES_PATH, rank_baselines)

        stats = live_stats_map(live)
        etypes = element_type_map(bootstrap)
        elements = element_by_id(bootstrap)
        teams = team_by_id(bootstrap)
        match_status = build_match_status_by_element(
            list(elements.values()), fixtures
        )
        autosub_status = build_match_status_by_element(
            list(elements.values()), fixtures, final_only=True
        )
        any_fixture_live = any(fixture_is_live(fx) for fx in fixtures)
        gw_awaiting_kickoff = gw_fixtures_awaiting_kickoff(fixtures)
        graphic_named = load_graphic_named_ids(gw)
        team_codes = team_code_by_element_map(elements, teams)
        settled = settled_gameweeks(bootstrap)
        gw_settled = gw in settled

        focus_picks_payload = picks_by_entry.get(manager_id)
        focus_picks = (focus_picks_payload or {}).get("picks") or []
        focus_chip = (focus_picks_payload or {}).get("active_chip")
        focus_history_chips = list(history_payload.get("chips") or [])
        chip_windows = chip_windows_from_bootstrap(bootstrap)
        chip_half = season_chip_half(gw, chip_windows)
        focus_hist = (focus_picks_payload or {}).get("entry_history") or {}
        focus_entry_official = int(entry.get("summary_event_points") or 0) or None
        focus_pts, focus_active, focus_subs = resolve_manager_gw_points(
            focus_picks,
            stats,
            match_status,
            autosub_status,
            etypes,
            focus_chip,
            focus_hist,
            any_fixture_live=any_fixture_live,
            entry_official=focus_entry_official,
            awaiting_kickoff=gw_awaiting_kickoff,
        )
        active_ids = {int(p["element"]) for p in focus_active}
        focus_mults = effective_element_multipliers(focus_picks, focus_active)
        focus_in_play, focus_to_play = active_pick_progress(
            focus_active, elements, fixtures, match_status, focus_mults
        )

        transfers_by_entry: dict[str, dict] = {}
        official_transfers_by_entry: dict[int, list[dict]] = {}
        for eid in entry_ids:
            curr_payload = (
                transfer_picks_by_entry.get(eid)
                if transfer_poll_gw
                else picks_by_entry.get(eid)
            )
            prev_payload = prev_by_entry.get(eid)
            if not picks_payload_ready(curr_payload):
                continue
            curr_picks = (curr_payload or {}).get("picks") or []
            prev_picks = (prev_payload or {}).get("picks") or [] if prev_payload else []
            official_rows, _xfer_err = fetch_entry_transfers(eid)
            if not _xfer_err:
                official_transfers_by_entry[eid] = official_rows
            transfers_by_entry[str(eid)] = compute_transfers(
                prev_picks,
                curr_picks,
                elements,
                (curr_payload or {}).get("entry_history") or {},
                (curr_payload or {}).get("active_chip"),
                stats,
                event_id=status_picks_gw,
                official_transfers=official_rows,
            )

        standing_rows: list[dict] = []
        entry_data: dict[int, dict] = {}
        history_by_entry: dict[int, dict] = {manager_id: history_payload}
        cached_standings = cached_standings_by_entry(cached, league_id)
        autosub_cache = load_json(AUTOSUB_CACHE_PATH)
        if backfill_autosub_points(entry_ids, settled, autosub_cache):
            save_json(AUTOSUB_CACHE_PATH, autosub_cache)
        autosub_entries = autosub_cache.get("entries") or {}
        current_points = element_points_map(live)
        mults_by_entry: dict[int, dict[int, int]] = {}
        owners_by_element: dict[int, list[int]] = {}
        progress_by_entry: dict[int, tuple[int, int]] = {}
        chip_by_entry: dict[int, str | None] = {}
        history_chips_by_entry: dict[int, list] = {}

        gw_in_play = any_fixture_live or focus_in_play > 0 or focus_to_play > 0
        cached_summary = (
            cached.get("summary")
            if cached and cached.get("managerId") == manager_id and isinstance(cached.get("summary"), dict)
            else None
        )

        focus_league_total = 0
        for row in results:
            try:
                if int(row.get("entry") or 0) == manager_id:
                    focus_league_total = int(row.get("total") or 0)
                    break
            except (TypeError, ValueError):
                continue

        if picks_payload_ready(focus_picks_payload):
            mgr_overall_rank = positive_rank(entry.get("summary_overall_rank"))
            picks_rank = positive_rank(focus_hist.get("overall_rank"))
            if gw_in_play and mgr_overall_rank and picks_rank and mgr_overall_rank == picks_rank:
                mgr_overall_rank = None
            mgr_overall_rank = (
                mgr_overall_rank
                or positive_rank((cached_summary or {}).get("overallRank"))
                or (picks_rank if not gw_in_play else None)
                or 0
            )
            mgr_overall_points = int(entry.get("summary_overall_points") or 0)
            if mgr_overall_points <= 0:
                mgr_overall_points = int(focus_hist.get("total_points") or 0)
            if focus_league_total > mgr_overall_points:
                mgr_overall_points = focus_league_total
            elif gw_in_play and focus_pts > 0:
                picks_total = int(focus_hist.get("total_points") or 0)
                if picks_total > 0 and mgr_overall_points <= picks_total:
                    mgr_overall_points = picks_total + focus_pts
            entry_data[manager_id] = {
                "picks": focus_picks,
                "active": focus_active,
                "subs": focus_subs,
                "ui_subs": resolve_ui_auto_subs(
                    focus_picks,
                    stats,
                    match_status,
                    etypes,
                    focus_chip,
                    team_codes=team_codes,
                    graphic_named=graphic_named,
                    official_subs=official_autosubs(focus_picks_payload, gw),
                    gw_settled=gw_settled,
                ),
                "chip": focus_chip,
                "live_gw": focus_pts,
                "mults": focus_mults,
                "overall_rank": mgr_overall_rank,
                "overall_points": mgr_overall_points,
                "gw_rank": resolve_gw_rank(
                    gw=gw,
                    history_payload=history_payload,
                    picks_history=focus_hist,
                    entry=entry,
                ),
            }
            mults_by_entry[manager_id] = focus_mults
            progress_by_entry[manager_id] = (focus_in_play, focus_to_play)
            chip_by_entry[manager_id] = focus_chip
            history_chips_by_entry[manager_id] = focus_history_chips

        def note_owners(entry_id: int, picks: list) -> None:
            for pick in picks or []:
                try:
                    el_id = int(pick["element"])
                except (KeyError, TypeError, ValueError):
                    continue
                bucket = owners_by_element.setdefault(el_id, [])
                if entry_id not in bucket:
                    bucket.append(entry_id)

        if focus_picks:
            note_owners(manager_id, focus_picks)

        for row in results:
            try:
                eid = int(row["entry"])
            except (KeyError, TypeError, ValueError):
                continue
            try:
                mp = picks_by_entry.get(eid)
                other_picks = (mp or {}).get("picks") or []
                chip = (mp or {}).get("active_chip") if mp else None

                if eid == manager_id:
                    live_gw_pts = focus_pts
                    active = focus_active
                    subs = focus_subs
                    chip = focus_chip
                elif picks_payload_ready(mp):
                    note_owners(eid, other_picks)
                    league_entry_official = int(row.get("event_total") or 0) or None
                    live_gw_pts, active, subs = resolve_manager_gw_points(
                        other_picks,
                        stats,
                        match_status,
                        autosub_status,
                        etypes,
                        chip,
                        (mp or {}).get("entry_history") or {},
                        any_fixture_live=any_fixture_live,
                        entry_official=league_entry_official,
                        awaiting_kickoff=gw_awaiting_kickoff,
                    )
                    other_mults = effective_element_multipliers(other_picks, active)
                    mults_by_entry[eid] = other_mults
                    overall_rank = positive_rank(
                        ((mp or {}).get("entry_history") or {}).get("overall_rank")
                    ) or 0
                    overall_points = int(row.get("total") or 0)
                    other_entry = None
                    try:
                        other_entry = fpl_get(f"/entry/{eid}/")
                        assert isinstance(other_entry, dict)
                        overall_rank = int(other_entry.get("summary_overall_rank") or 0) or overall_rank
                        entry_pts = int(other_entry.get("summary_overall_points") or 0)
                        overall_points = max(overall_points, entry_pts)
                    except (
                        urllib.error.HTTPError,
                        urllib.error.URLError,
                        RuntimeError,
                        AssertionError,
                        OSError,
                        json.JSONDecodeError,
                    ) as exc:
                        print(f"  entry failed entry={eid}: {exc}", file=sys.stderr)
                    entry_data[eid] = {
                        "picks": other_picks,
                        "active": active,
                        "subs": subs,
                        "ui_subs": resolve_ui_auto_subs(
                            other_picks,
                            stats,
                            match_status,
                            etypes,
                            chip,
                            team_codes=team_codes,
                            graphic_named=graphic_named,
                            official_subs=official_autosubs(mp, gw),
                            gw_settled=gw_settled,
                        ),
                        "chip": chip,
                        "live_gw": live_gw_pts,
                        "mults": other_mults,
                        "overall_rank": overall_rank,
                        "overall_points": overall_points,
                        "gw_rank": resolve_gw_rank(
                            gw=gw,
                            history_payload=history_by_entry.get(eid),
                            picks_history=(mp or {}).get("entry_history") or {},
                            entry=other_entry if isinstance(other_entry, dict) else None,
                        ),
                    }
                else:
                    live_gw_pts = 0 if gw_awaiting_kickoff else int(row.get("event_total") or 0)
                    active = []
                    subs = []
                    mults_by_entry.setdefault(eid, {})

                if eid != manager_id:
                    try:
                        hist = fpl_get(f"/entry/{eid}/history/")
                        assert isinstance(hist, dict)
                        history_by_entry[eid] = hist
                        history_chips_by_entry[eid] = list(hist.get("chips") or [])
                    except (
                        urllib.error.HTTPError,
                        urllib.error.URLError,
                        RuntimeError,
                        AssertionError,
                        OSError,
                        json.JSONDecodeError,
                    ) as exc:
                        print(f"  history failed entry={eid}: {exc}", file=sys.stderr)
                        history_chips_by_entry.setdefault(eid, [])
                chip_by_entry[eid] = chip
                progress_by_entry[eid] = active_pick_progress(
                    active,
                    elements,
                    fixtures,
                    match_status,
                    mults_by_entry.get(eid),
                )
            except (
                urllib.error.HTTPError,
                urllib.error.URLError,
                RuntimeError,
                AssertionError,
                OSError,
                json.JSONDecodeError,
            ) as exc:
                print(f"  picks failed entry={eid}: {exc}", file=sys.stderr)
                live_gw_pts = int(row.get("event_total") or 0)
                mults_by_entry.setdefault(eid, {})
                progress_by_entry.setdefault(eid, (0, 0))
                chip_by_entry.setdefault(eid, None)
                history_chips_by_entry.setdefault(eid, [])

            in_play, to_play = progress_by_entry.get(eid, (0, 0))
            ed = entry_data.get(eid, {})
            chips_half = entry_chips_for_half(
                history_chips_by_entry.get(eid) or [],
                chip_by_entry.get(eid),
                chip_half,
                chip_windows,
                gw,
            )
            transfer_summary = transfers_by_entry.get(str(eid))
            picks_payload = picks_by_entry.get(eid)
            picks_history = focus_hist if eid == manager_id else ((picks_payload or {}).get("entry_history") or {})
            row_overall_rank_prev = resolve_entry_overall_rank_prev(
                eid=eid,
                manager_id=manager_id,
                gw=gw,
                focus_overall_rank_prev=overall_rank_prev,
                picks_history=picks_history,
                history_payload=history_by_entry.get(eid),
                cached_row=cached_standings.get(eid),
            )
            row_gw_rank = (
                positive_rank(ed.get("gw_rank"))
                or resolve_gw_rank(
                    gw=gw,
                    history_payload=history_by_entry.get(eid),
                    picks_history=picks_history,
                    entry=entry if eid == manager_id else None,
                )
            )
            hist_payload = history_by_entry.get(eid)
            bb_events = bench_boost_events(history_chips_by_entry.get(eid) or [])
            if chip_by_entry.get(eid) in {"bboost", "benchboost", "bench_boost"}:
                bb_events.add(int(gw))
            bench_points = entry_bench_points_total(
                hist_payload,
                picks_history,
                exclude_events=bb_events,
                display_gw=gw,
            )
            if bench_points is None:
                cached_bp = (cached_standings.get(eid) or {}).get("benchPoints")
                try:
                    if cached_bp is not None:
                        bench_points = int(cached_bp)
                except (TypeError, ValueError):
                    bench_points = None
            bench_points_gw = None
            if gw_awaiting_kickoff:
                # New GW not started — don't carry prior-GW pine into the GW column.
                bench_points_gw = 0
            elif isinstance(picks_history, dict) and "points_on_bench" in picks_history:
                try:
                    picks_ev = int(picks_history.get("event") or 0)
                    if picks_ev in {0, int(gw)}:
                        bench_points_gw = int(picks_history.get("points_on_bench") or 0)
                except (TypeError, ValueError):
                    bench_points_gw = None
            if (
                bench_points_gw is None
                and not gw_awaiting_kickoff
                and (cached or {}).get("gw") == gw
            ):
                cached_gw_bp = (cached_standings.get(eid) or {}).get("benchPointsGw")
                try:
                    if cached_gw_bp is not None:
                        bench_points_gw = int(cached_gw_bp)
                except (TypeError, ValueError):
                    bench_points_gw = None
            ft_left = None
            if ft_target_gw:
                if eid not in official_transfers_by_entry:
                    rows_xfer, rows_err = fetch_entry_transfers(eid)
                    if not rows_err:
                        official_transfers_by_entry[eid] = rows_xfer
                if eid in official_transfers_by_entry:
                    ft_left = free_transfers_left(
                        hist_payload,
                        official_transfers_by_entry[eid],
                        ft_target_gw,
                        ft_max,
                    )
            if ft_left is None:
                cached_ft = cached_standings.get(eid) or {}
                if cached_ft.get("freeTransfersGw") == ft_target_gw:
                    ft_left = cached_ft.get("freeTransfersLeft")
            autosub_by_gw = autosub_entries.get(str(eid)) or {}
            autosub_season = 0
            for gw_key, slot in autosub_by_gw.items():
                try:
                    if int(gw_key) < int(gw):
                        autosub_season += int((slot or {}).get("pts") or 0)
                except (TypeError, ValueError):
                    continue
            if not autosub_by_gw:
                try:
                    autosub_season = int((cached_standings.get(eid) or {}).get("autosubPoints") or 0)
                except (TypeError, ValueError):
                    autosub_season = 0
            autosub_pending = False
            if gw_awaiting_kickoff:
                autosub_gw = 0
            elif str(gw) in autosub_by_gw:
                autosub_gw = int((autosub_by_gw[str(gw)] or {}).get("pts") or 0)
            else:
                official = official_autosubs(picks_by_entry.get(eid), gw)
                if official:
                    autosub_gw = score_autosubs(official, current_points)["pts"]
                else:
                    projected = (entry_data.get(eid) or {}).get("ui_subs") or []
                    autosub_gw = score_autosubs(projected, current_points)["pts"]
                    autosub_pending = bool(projected)
            standing_rows.append(
                {
                    "entry": eid,
                    "playerName": row.get("player_name") or "",
                    "entryName": row.get("entry_name") or "",
                    "gwPointsLive": live_gw_pts,
                    "eventTotalOfficial": int(row.get("event_total") or 0),
                    "total": int(row.get("total") or 0),
                    "overallRank": int(ed.get("overall_rank") or 0) or None,
                    "overallRankPrev": row_overall_rank_prev,
                    "gwRank": row_gw_rank,
                    "overallPoints": max(
                        int(ed.get("overall_points") or 0),
                        int(row.get("total") or 0),
                    ),
                    "rankOfficial": int(row.get("rank") or 0),
                    "rankPrev": positive_rank(row.get("last_rank")),
                    "inPlay": in_play,
                    "toPlay": to_play,
                    "activeChip": chip_by_entry.get(eid),
                    "chips": chips_half,
                    "transfers": transfer_summary,
                    "benchPoints": bench_points,
                    "benchPointsGw": bench_points_gw,
                    "autosubPoints": autosub_season,
                    "autosubPointsGw": autosub_gw,
                    "autosubPendingGw": autosub_pending,
                    "freeTransfersLeft": ft_left,
                    "freeTransfersGw": ft_target_gw,
                }
            )

        top_ids = top_third_entry_ids(results)
        top_third_mult_maps = [mults_by_entry.get(eid, {}) for eid in top_ids]
        squads_by_entry: dict[str, list] = {}
        for eid, ed in entry_data.items():
            picks = ed.get("picks") or []
            if not picks:
                continue
            active = ed.get("active") or []
            subs = ed.get("subs") or []
            active_ids = {int(p["element"]) for p in active}
            squads_by_entry[str(eid)] = build_squad_rows(
                picks,
                active_ids,
                subs,
                stats,
                match_status,
                elements,
                teams,
                fixtures,
                ed.get("mults") or {},
                top_third_mult_maps,
                ui_auto_subs=ed.get("ui_subs"),
            )
        squad = squads_by_entry.get(str(manager_id), [])

        focus_picks_not_ready = not picks_payload_ready(focus_picks_payload)
        if focus_picks_not_ready and cached and cached.get("managerId") == manager_id:
            if cached.get("squad"):
                squad = cached["squad"]
            if cached.get("squadsByEntry"):
                for key, rows in cached["squadsByEntry"].items():
                    if key not in squads_by_entry:
                        squads_by_entry[key] = rows
            # Only reuse cached GW points within the same gameweek and after kickoff.
            if (
                not gw_awaiting_kickoff
                and cached.get("gw") == gw
                and cached.get("summary")
                and isinstance(cached["summary"], dict)
            ):
                cached_summary = cached["summary"]
                focus_pts = cached_summary.get("gwPoints", focus_pts)
            elif cached.get("summary") and isinstance(cached["summary"], dict):
                cached_summary = cached["summary"]

        degraded_msgs: list[str] = []
        if standings_err:
            degraded_msgs.append(standings_err)
        if league_picks_status.get("blackout"):
            degraded_msgs.append("FPL picks API blackout — showing cached squad where available")
        if entry_err:
            degraded_msgs.append(entry_err)
        if history_err:
            degraded_msgs.append(history_err)
        if focus_picks_not_ready:
            degraded_msgs.append("Focus manager picks not ready")
        error_msg = "; ".join(degraded_msgs) if degraded_msgs else None

        # Per manager: once their XI is done (in_play == 0), trust FPL event_total.
        # Waiting for league-wide toPlay == 0 left stale live GW pts when some fixtures
        # remained later in the gameweek. Pre-kickoff: FPL event_total is often still
        # last GW — force 0 until the first match starts.
        for row in standing_rows:
            if gw_awaiting_kickoff:
                row["gwPointsLive"] = 0
                row["eventTotalOfficial"] = 0
            elif int(row.get("inPlay") or 0) == 0:
                official = row.get("eventTotalOfficial")
                if official is not None:
                    row["gwPointsLive"] = int(official)

        standing_rows.sort(
            key=lambda r: (
                -int(r.get("total") or 0),
                int(r.get("rankOfficial") or 9999),
            )
        )
        for i, row in enumerate(standing_rows, start=1):
            row["rankLive"] = i

        focus_league_rank = None
        for row in standing_rows:
            if row["entry"] == manager_id:
                focus_league_rank = row["rankOfficial"] or row["rankLive"]
                break
        if focus_league_rank is None:
            for row in results:
                if int(row.get("entry") or 0) == manager_id:
                    focus_league_rank = int(row.get("rank") or 0)
                    break

        focus_summary = resolve_focus_summary_fields(
            manager_id,
            entry,
            focus_hist,
            cached_summary,
            gw_in_play=gw_in_play,
            league_total=focus_league_total or None,
            live_gw_pts=focus_pts,
        )

        # team id → fixture id for this GW (DGW: last write wins; rare).
        fixture_id_by_team: dict[int, int] = {}
        for fx in fixtures:
            try:
                fid = int(fx["id"])
                th = int(fx["team_h"])
                ta = int(fx["team_a"])
            except (KeyError, TypeError, ValueError):
                continue
            fixture_id_by_team[th] = fid
            fixture_id_by_team[ta] = fid

        element_gw: dict[str, dict] = {}
        for eid, st in stats.items():
            status = match_status.get(eid) or "scheduled"
            el_meta = elements.get(eid) or {}
            try:
                etype = int(el_meta.get("element_type") or etypes.get(eid) or 0)
            except (TypeError, ValueError):
                etype = int(etypes.get(eid) or 0)
            try:
                team_id = int(el_meta.get("team") or 0)
            except (TypeError, ValueError):
                team_id = 0
            element_gw[str(eid)] = normalize_element_gw_record(
                st,
                element_type=etype,
                team_id=team_id,
                fixture_id=fixture_id_by_team.get(team_id),
                live=status == "live",
                status=status,
            )

        # Manager Points Home card is parked — see docs/manager-points-card.md.
        # backfill_manager_points / build_manager_points_by_entry stay in this
        # file for a mid- or end-season recap; do not put stacks on the live
        # Home payload until that surface exists.

        gw_deadline = None
        cur_gw = gws.get("current") or {}
        try:
            if int(cur_gw.get("id") or 0) == int(gw):
                gw_deadline = cur_gw.get("deadlineTime")
        except (TypeError, ValueError):
            gw_deadline = None
        if not gw_deadline:
            for ev in bootstrap.get("events") or []:
                try:
                    if int(ev.get("id") or 0) == int(gw):
                        gw_deadline = ev.get("deadline_time")
                        break
                except (TypeError, ValueError):
                    continue

        try:
            stat_log = update_stat_log(
                gw=int(gw),
                checked_at=generated_at(),
                live=live,
                fixtures=fixtures,
                elements=elements,
                teams=teams,
                owners_by_element=owners_by_element,
                gw_settled=gw_settled,
            )
        except Exception as stat_exc:
            print(f"  stat log failed: {stat_exc}", file=sys.stderr)
            stat_log = empty_stat_log(gw)

        payload = {
            "generatedAt": generated_at(),
            "gw": gw,
            "managerId": manager_id,
            "leagueId": league_id,
            "leagueName": league_meta.get("name") or f"League {league_id}",
            "summary": {
                # Before first kickoff FPL still stamps last GW's summary_event_points —
                # never surface those as this GW's score.
                "gwPoints": (
                    0
                    if gw_awaiting_kickoff
                    else (
                        focus_entry_official
                        if focus_in_play == 0 and focus_entry_official is not None
                        else focus_pts
                    )
                ),
                "overallPoints": int(focus_summary["overallPoints"]),
                "overallRank": int(focus_summary["overallRank"]),
                "overallRankPrev": overall_rank_prev,
                "gwRank": resolve_gw_rank(
                    gw=gw,
                    history_payload=history_payload,
                    picks_history=focus_hist,
                    entry=entry,
                ),
                "leagueRank": focus_league_rank,
                "leagueRankPrev": league_rank_prev,
                "totalPlayers": total_players or None,
                "eventPointsOfficial": (
                    0 if gw_awaiting_kickoff else int(focus_summary["eventPointsOfficial"])
                ),
                "teamName": focus_summary["teamName"],
                "managerName": focus_summary["managerName"],
                "activeChip": focus_chip,
            },
            "squad": squad,
            "squadsByEntry": squads_by_entry,
            "standings": standing_rows,
            "chipWindow": chip_window_meta(chip_half, chip_windows, gw),
            "gwAwaitingKickoff": gw_awaiting_kickoff,
            # FPL has stamped autosubs, bonus, and official ranks for this GW.
            "gwSettled": gw_settled,
            "gwProgress": summarize_gw_progress(
                fixtures,
                deadline_time=gw_deadline,
                gw_settled=gw_settled,
            ),
            "statLog": stat_log,
            "ownersByElement": {
                str(el_id): entry_ids
                for el_id, entry_ids in sorted(owners_by_element.items())
            },
            "elementGw": element_gw,
            "leaguePicksStatus": league_picks_status,
            # v2 = official/same-position pairing with elementType on moves.
            "transfersSchemaVersion": 2,
            "transfersByEntry": transfers_by_entry,
            "error": error_msg,
        }

        write_home_outputs(payload)
        print(
            f"Wrote {OUT_PATH.name}: GW{gw} pts={focus_pts} "
            f"squad={len(squad)} standings={len(standing_rows)} "
            f"picks={league_picks_status.get('ready')}/{league_picks_status.get('total')}"
        )
        return 0
    except Exception as exc:
        print(f"fetch_home failed: {exc}", file=sys.stderr)
        cached = read_home_cache()
        if cached and isinstance(cached, dict):
            status = cached.get("leaguePicksStatus")
            if not isinstance(status, dict):
                status = {}
            status = dict(status)
            status["blackout"] = True
            status["checkedAt"] = generated_at()
            cached["leaguePicksStatus"] = status
            cached["generatedAt"] = generated_at()
            cached["error"] = str(exc)
            try:
                write_home_outputs(cached)
                print(f"Updated {OUT_PATH.name} with blackout flag", file=sys.stderr)
                return 0
            except OSError as write_exc:
                print(f"Could not write degraded cache: {write_exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
