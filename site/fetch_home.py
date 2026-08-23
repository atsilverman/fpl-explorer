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
TRACKED_PATH = SITE / "tracked_ids.json"
PREFS_PATH = SITE / "home_prefs.json"
BASELINES_PATH = SITE / "home_rank_baselines.json"
OUT_PATH = SITE / "home_data.js"
FPL_BASE = "https://fantasy.premierleague.com/api"
UA = "Mozilla/5.0 (compatible; FPL-Explorer/1.0; +local-home)"


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
    if mid is None and managers:
        mid = managers[0]
    if lid is None and leagues:
        lid = leagues[0]
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


def build_squad_rows(
    picks: list[dict],
    active_ids: set[int],
    auto_sub_in: set[int],
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
        OUT_PATH.write_text(
            f"window.FPL_HOME = {json.dumps(empty, separators=(',', ':'))};\n",
            encoding="utf-8",
        )
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

        focus_picks = picks_payload.get("picks") or []
        focus_chip = picks_payload.get("active_chip")
        focus_pts, focus_active, focus_subs = calculate_manager_points_from_live(
            focus_picks, stats, match_status, etypes, focus_chip
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
                    live_gw, active, subs = calculate_manager_points_from_live(
                        other_picks,
                        stats,
                        match_status,
                        etypes,
                        chip,
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

            in_play, to_play = progress_by_entry.get(eid, (0, 0))
            ed = entry_data.get(eid, {})
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
                    "inPlay": in_play,
                    "toPlay": to_play,
                    "activeChip": chip_by_entry.get(eid),
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
            auto_in = {s["in"] for s in subs}
            squads_by_entry[str(eid)] = build_squad_rows(
                picks,
                active_ids,
                auto_in,
                stats,
                match_status,
                elements,
                teams,
                fixtures,
                ed.get("mults") or {},
                top_third_mult_maps,
            )
        squad = squads_by_entry.get(str(manager_id), [])

        standing_rows.sort(key=lambda r: (-r["gwPointsLive"], r["rankOfficial"] or 9999))
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
            "ownersByElement": {
                str(el_id): entry_ids
                for el_id, entry_ids in sorted(owners_by_element.items())
            },
            "elementGw": element_gw,
            "error": None,
        }

        OUT_PATH.write_text(
            f"window.FPL_HOME = {json.dumps(payload, separators=(',', ':'))};\n",
            encoding="utf-8",
        )
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
