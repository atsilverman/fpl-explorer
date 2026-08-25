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
from datetime import datetime, timezone
from pathlib import Path

from fpl_gameweeks import active_gameweek_id, extract_gameweeks
from live_scoring import (
    build_match_status_by_element,
    calculate_manager_points_from_live,
    effective_element_multipliers,
    element_by_id,
    element_type_map,
    fixture_is_finished,
    fixture_is_live,
    fixtures_for_element,
    importance_pct,
    live_stats_map,
    team_by_id,
    top_third_entry_ids,
)

SITE = Path(__file__).resolve().parent
SOCAL_LEAGUE_ID = 954157
TRACKED_MANAGERS = [296817, 1404383, 5497737, 185072]
TRACKED_PATH = SITE / "tracked_ids.json"
PREFS_PATH = SITE / "home_prefs.json"
BASELINES_PATH = SITE / "home_rank_baselines.json"
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
) -> tuple[int, int]:
    """(in_play, still_to_play) among active scoring picks.

    Bench Boost can push either count above 11. DGW: live > to-play > done.
    """
    in_play = 0
    to_play = 0
    for pick in active_picks or []:
        try:
            eid = int(pick["element"])
        except (KeyError, TypeError, ValueError):
            continue
        el = elements.get(eid) or {}
        fx_list = fixtures_for_element(el, fixtures)
        if fx_list:
            if any(fixture_is_live(fx) for fx in fx_list):
                in_play += 1
            elif any(not fixture_is_finished(fx) for fx in fx_list):
                to_play += 1
            continue
        status = match_status.get(eid) or "scheduled"
        if status == "live":
            in_play += 1
        elif status != "finished":
            to_play += 1
    return in_play, to_play


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
) -> tuple[int, list[dict], list[dict]]:
    """Live GW points with safeguards against post-FT autosub drift.

    While matches are live we compute from element points + cautious autosubs
    (final fixture flag only). Once nothing is live, trust FPL's
    entry_history.points — autosubs often lag behind finished_provisional.
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

    if not any_fixture_live:
        try:
            official = eh.get("points")
            if official is not None:
                return int(official), active, subs
        except (TypeError, ValueError):
            pass
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
) -> list[dict]:
    rows = []
    ordered = sorted(picks, key=lambda p: int(p.get("position") or 0))
    auto_sub_in = {int(s["in"]) for s in (auto_subs or []) if s.get("in") is not None}
    auto_sub_out = {int(s["out"]) for s in (auto_subs or []) if s.get("out") is not None}
    partner_for: dict[int, int] = {}
    for s in auto_subs or []:
        try:
            out_id = int(s["out"])
            in_id = int(s["in"])
        except (KeyError, TypeError, ValueError):
            continue
        partner_for[out_id] = in_id
        partner_for[in_id] = out_id

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
            fixture_rows.append(
                {
                    "opp": team_short(teams, int(fx["_opp"])),
                    "oppHa": fx["_ha"],
                    "kickoff": fx.get("kickoff_time"),
                    "live": live,
                    "finished": finished,
                    "minutes": mins if live or finished else None,
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
                    "minutes": None,
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
            }
        )
    return rows


def fetch_standings_page(league_id: int, page: int = 1) -> dict:
    return fpl_get(f"/leagues-classic/{league_id}/standings/?page_standings={page}")


def fetch_all_standings(league_id: int) -> tuple[list, dict]:
    """Paginate classic league standings until has_next is false."""
    page = 1
    all_results: list = []
    league_meta: dict = {}
    while True:
        payload = fetch_standings_page(league_id, page)
        assert isinstance(payload, dict)
        if not league_meta:
            league_meta = payload.get("league") or {}
        standings = payload.get("standings") or {}
        results = standings.get("results") or []
        all_results.extend(results)
        if not standings.get("has_next"):
            break
        page += 1
    return all_results, league_meta


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
            "error": "No manager/league configured. Set Preferences or pass --manager/--league.",
        }
        write_home_outputs(empty)
        print(f"Wrote empty {OUT_PATH.name} (missing manager/league)", file=sys.stderr)
        return 0

    print(f"Home targets: manager={manager_id} league={league_id}")

    try:
        bootstrap = fpl_get("/bootstrap-static/")
        assert isinstance(bootstrap, dict)
        gws = extract_gameweeks(bootstrap, source="bootstrap")
        gw = args.gw or active_gameweek_id(gws)
        if not gw:
            raise RuntimeError("Could not resolve active gameweek")

        live = fpl_get(f"/event/{gw}/live/")
        assert isinstance(live, dict)
        fixtures_raw = fpl_get(f"/fixtures/?event={gw}")
        fixtures = fixtures_raw if isinstance(fixtures_raw, list) else []

        entry = fpl_get(f"/entry/{manager_id}/")
        assert isinstance(entry, dict)
        picks_payload = fpl_get(f"/entry/{manager_id}/event/{gw}/picks/")
        assert isinstance(picks_payload, dict)
        history_payload = fpl_get(f"/entry/{manager_id}/history/")
        assert isinstance(history_payload, dict)

        results, league_meta = fetch_all_standings(league_id)

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
        # Auto-subs only after FPL's full `finished` flag — provisional FT still
        # leaves blank starters with multiplier 1 until GW processing.
        autosub_status = build_match_status_by_element(
            list(elements.values()), fixtures, final_only=True
        )
        any_fixture_live = any(fixture_is_live(fx) for fx in fixtures)

        focus_picks = picks_payload.get("picks") or []
        focus_chip = picks_payload.get("active_chip")
        focus_history_chips = list(history_payload.get("chips") or [])
        chip_windows = chip_windows_from_bootstrap(bootstrap)
        chip_half = season_chip_half(gw, chip_windows)
        focus_hist = picks_payload.get("entry_history") or {}
        focus_pts, focus_active, focus_subs = resolve_manager_gw_points(
            focus_picks,
            stats,
            match_status,
            autosub_status,
            etypes,
            focus_chip,
            focus_hist,
            any_fixture_live=any_fixture_live,
        )
        active_ids = {int(p["element"]) for p in focus_active}
        auto_in = {s["in"] for s in focus_subs}
        focus_mults = effective_element_multipliers(focus_picks, focus_active)
        focus_in_play, focus_to_play = active_pick_progress(
            focus_active, elements, fixtures, match_status
        )

        standing_rows: list[dict] = []
        entry_data: dict[int, dict] = {
            manager_id: {
                "picks": focus_picks,
                "active": focus_active,
                "subs": focus_subs,
                "chip": focus_chip,
                "live_gw": focus_pts,
                "mults": focus_mults,
                "overall_rank": int(entry.get("summary_overall_rank") or 0),
                "overall_points": int(entry.get("summary_overall_points") or 0),
            }
        }
        mults_by_entry: dict[int, dict[int, int]] = {manager_id: focus_mults}
        owners_by_element: dict[int, list[int]] = {}
        progress_by_entry: dict[int, tuple[int, int]] = {
            manager_id: (focus_in_play, focus_to_play)
        }
        chip_by_entry: dict[int, str | None] = {manager_id: focus_chip}
        history_chips_by_entry: dict[int, list] = {manager_id: focus_history_chips}

        def note_owners(entry_id: int, picks: list) -> None:
            for pick in picks or []:
                try:
                    el_id = int(pick["element"])
                except (KeyError, TypeError, ValueError):
                    continue
                bucket = owners_by_element.setdefault(el_id, [])
                if entry_id not in bucket:
                    bucket.append(entry_id)

        note_owners(manager_id, focus_picks)

        for row in results:
            try:
                eid = int(row["entry"])
            except (KeyError, TypeError, ValueError):
                continue
            try:
                if eid == manager_id:
                    live_gw = focus_pts
                    active = focus_active
                    subs = focus_subs
                    chip = focus_chip
                else:
                    mp = fpl_get(f"/entry/{eid}/event/{gw}/picks/")
                    assert isinstance(mp, dict)
                    other_picks = mp.get("picks") or []
                    chip = mp.get("active_chip")
                    note_owners(eid, other_picks)
                    live_gw, active, subs = resolve_manager_gw_points(
                        other_picks,
                        stats,
                        match_status,
                        autosub_status,
                        etypes,
                        chip,
                        mp.get("entry_history") or {},
                        any_fixture_live=any_fixture_live,
                    )
                    other_mults = effective_element_multipliers(other_picks, active)
                    mults_by_entry[eid] = other_mults
                    overall_rank = 0
                    overall_points = int(row.get("total") or 0)
                    try:
                        other_entry = fpl_get(f"/entry/{eid}/")
                        assert isinstance(other_entry, dict)
                        overall_rank = int(other_entry.get("summary_overall_rank") or 0)
                        overall_points = int(
                            other_entry.get("summary_overall_points") or overall_points
                        )
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
                        "chip": chip,
                        "live_gw": live_gw,
                        "mults": other_mults,
                        "overall_rank": overall_rank,
                        "overall_points": overall_points,
                    }
                # Season chip uses — history/chips[] (half-scoped later).
                if eid != manager_id:
                    try:
                        hist = fpl_get(f"/entry/{eid}/history/")
                        assert isinstance(hist, dict)
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
                    active, elements, fixtures, match_status
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
                live_gw = int(row.get("event_total") or 0)
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
            standing_rows.append(
                {
                    "entry": eid,
                    "playerName": row.get("player_name") or "",
                    "entryName": row.get("entry_name") or "",
                    "gwPointsLive": live_gw,
                    "eventTotalOfficial": int(row.get("event_total") or 0),
                    "total": int(row.get("total") or 0),
                    "overallRank": int(ed.get("overall_rank") or 0) or None,
                    "overallPoints": int(ed.get("overall_points") or 0)
                    or int(row.get("total") or 0),
                    "rankOfficial": int(row.get("rank") or 0),
                    "rankPrev": positive_rank(row.get("last_rank")),
                    "inPlay": in_play,
                    "toPlay": to_play,
                    "activeChip": chip_by_entry.get(eid),
                    "chips": chips_half,
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
            )
        squad = squads_by_entry.get(str(manager_id), [])

        # Once nobody has picks still to play / in play, trust FPL event_total
        # for GW points + live rank (our live engine can drift after the whistle).
        settled = bool(standing_rows) and all(
            int(r.get("inPlay") or 0) == 0 and int(r.get("toPlay") or 0) == 0
            for r in standing_rows
        )
        if settled:
            for row in standing_rows:
                row["gwPointsLive"] = int(row.get("eventTotalOfficial") or 0)

        standing_rows.sort(
            key=lambda r: (
                -int(r.get("gwPointsLive") or 0),
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

        first = (entry.get("player_first_name") or "").strip()
        last = (entry.get("player_last_name") or "").strip()
        manager_name = " ".join(p for p in (first, last) if p) or f"Manager {manager_id}"

        element_gw: dict[str, dict] = {}
        for eid, st in stats.items():
            status = match_status.get(eid) or "scheduled"
            element_gw[str(eid)] = {
                "pts": int(st.get("total_points") or 0),
                "minutes": int(st.get("minutes") or 0),
                "live": status == "live",
                "status": status,
            }

        payload = {
            "generatedAt": generated_at(),
            "gw": gw,
            "managerId": manager_id,
            "leagueId": league_id,
            "leagueName": league_meta.get("name") or f"League {league_id}",
            "summary": {
                "gwPoints": focus_pts,
                "overallPoints": int(entry.get("summary_overall_points") or 0),
                "overallRank": int(entry.get("summary_overall_rank") or 0),
                "overallRankPrev": overall_rank_prev,
                "leagueRank": focus_league_rank,
                "leagueRankPrev": league_rank_prev,
                "totalPlayers": total_players or None,
                "eventPointsOfficial": int(entry.get("summary_event_points") or 0),
                "teamName": entry.get("name") or "",
                "managerName": manager_name,
                "activeChip": focus_chip,
            },
            "squad": squad,
            "squadsByEntry": squads_by_entry,
            "standings": standing_rows,
            "chipWindow": chip_window_meta(chip_half, chip_windows, gw),
            "ownersByElement": {
                str(el_id): entry_ids
                for el_id, entry_ids in sorted(owners_by_element.items())
            },
            "elementGw": element_gw,
            "error": None,
        }

        write_home_outputs(payload)
        print(
            f"Wrote {OUT_PATH.name}: GW{gw} pts={focus_pts} "
            f"squad={len(squad)} standings={len(standing_rows)}"
        )
        return 0
    except Exception as exc:
        print(f"fetch_home failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
