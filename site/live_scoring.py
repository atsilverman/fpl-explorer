"""Live FPL gameweek scoring — port of Defcon gameweekPoints.js (v1).

XI vs bench: pick.position 1–11 start, 12–15 bench order.
Auto-subs: starter 0' + match *fully* finished (`finished`, not merely
finished_provisional) → first compatible bench with minutes (GK↔GK,
outfield↔outfield), preferring formation-valid swaps. Provisional FT still
leaves blank starters at multiplier 1 until FPL processes the GW — do not
autosub on provisional alone.
Bench Boost (active_chip == 'bboost'): all 15 count, no auto-subs.
Points: live stats.total_points × pick.multiplier.
When no fixtures are live, fetch_home prefers entry_history.points over the
engine so standings match FPL while autosubs/BPS settle.
"""
from __future__ import annotations

from typing import Any


def _minutes(stats: dict | None) -> int:
    if not stats:
        return 0
    try:
        return int(stats.get("minutes") or 0)
    except (TypeError, ValueError):
        return 0


def _total_points(stats: dict | None) -> int:
    if not stats:
        return 0
    try:
        return int(stats.get("total_points") or 0)
    except (TypeError, ValueError):
        return 0


def validate_formation(active_picks: list[dict], element_types: dict[int, int]) -> bool:
    counts = {1: 0, 2: 0, 3: 0, 4: 0}
    for pick in active_picks:
        pos = element_types.get(int(pick["element"]))
        if pos in counts:
            counts[pos] += 1
    return counts[1] >= 1 and counts[2] >= 3 and counts[3] >= 2 and counts[4] >= 1


def would_maintain_valid_formation(
    current_without_starter: list[dict],
    bench_id: int,
    element_types: dict[int, int],
) -> bool:
    """current_without_starter = already-kept + remaining (starter already omitted)."""
    counts = {1: 0, 2: 0, 3: 0, 4: 0}
    for pick in current_without_starter:
        pos = element_types.get(int(pick["element"]))
        if pos in counts:
            counts[pos] += 1
    bench_pos = element_types.get(bench_id)
    if bench_pos in counts:
        counts[bench_pos] += 1
    return counts[1] >= 1 and counts[2] >= 3 and counts[3] >= 2 and counts[4] >= 1


def apply_auto_substitution(
    picks: list[dict],
    live_stats: dict[int, dict],
    match_status: dict[int, str],
    element_types: dict[int, int],
) -> tuple[list[dict], list[dict]]:
    """Return (active_picks, auto_subs)."""
    starting = sorted(
        [p for p in picks if int(p.get("position") or 0) <= 11],
        key=lambda p: int(p.get("position") or 0),
    )
    bench = sorted(
        [p for p in picks if int(p.get("position") or 0) > 11],
        key=lambda p: int(p.get("position") or 0),
    )
    active: list[dict] = []
    used_bench: set[int] = set()
    auto_subs: list[dict] = []

    for idx, starter in enumerate(starting):
        starter_id = int(starter["element"])
        starter_mins = _minutes(live_stats.get(starter_id))
        starter_status = match_status.get(starter_id) or "scheduled"
        starter_etype = element_types.get(starter_id)

        if starter_mins > 0 or starter_status != "finished":
            active.append(starter)
            continue

        found = False
        for bp in bench:
            bench_id = int(bp["element"])
            if bench_id in used_bench:
                continue
            bench_mins = _minutes(live_stats.get(bench_id))
            if bench_mins <= 0:
                continue
            bench_etype = element_types.get(bench_id)
            if not starter_etype or not bench_etype:
                continue
            compatible = (starter_etype == 1 and bench_etype == 1) or (
                starter_etype != 1 and bench_etype != 1
            )
            if not compatible:
                continue
            # Starter is omitted from current; only add the bench player.
            remaining = starting[idx + 1 :]
            current = active + remaining
            if not would_maintain_valid_formation(current, bench_id, element_types):
                continue
            subbed = dict(bp)
            subbed["substituted_for"] = starter_id
            active.append(subbed)
            used_bench.add(bench_id)
            auto_subs.append({"out": starter_id, "in": bench_id})
            found = True
            break

        if not found:
            active.append(starter)

    return active, auto_subs


def fixture_is_finished(fx: dict | None) -> bool:
    """True when the match is done for UI progress (incl. provisional FT).

    Official `finished` often stays false while `finished_provisional` is true
    right after full time. Also treat started + minutes ≥ 90 as finished when
    both flags lag.
    """
    if not fx:
        return False
    if fx.get("finished") or fx.get("finished_provisional"):
        return True
    try:
        mins = int(fx.get("minutes") or 0)
    except (TypeError, ValueError):
        mins = 0
    return bool(fx.get("started")) and mins >= 90


def fixture_is_final(fx: dict | None) -> bool:
    """True only when FPL has fully finalized the fixture.

    Auto-subs on picks (multipliers) usually land after `finished` flips true —
    not merely `finished_provisional`. Treating provisional FT as final caused us
    to sub bench players in while FPL still scored the blank starter at 0.
    """
    if not fx:
        return False
    return bool(fx.get("finished"))


def fixture_is_live(fx: dict | None) -> bool:
    if not fx:
        return False
    return bool(fx.get("started")) and not fixture_is_finished(fx)


def fixture_has_started(fx: dict | None) -> bool:
    """True once a fixture has kicked off (live or finished)."""
    if not fx:
        return False
    return bool(fx.get("started")) or fixture_is_finished(fx)


def gw_fixtures_awaiting_kickoff(fixtures: list | None) -> bool:
    """True when this GW has fixtures and none have started yet.

    FPL often keeps classic-league ``event_total`` / ``summary_event_points``
    at the previous GW total until the first kickoff — Home must show 0 pts
    in that window instead of the stale totals.
    """
    if not fixtures:
        return False
    return not any(fixture_has_started(fx) for fx in fixtures)


def build_match_status_by_element(
    elements: list[dict],
    fixtures: list[dict],
    *,
    final_only: bool = False,
) -> dict[int, str]:
    """Map element id → scheduled | live | finished from fixtures + element.team.

    final_only=True uses fully finalized fixtures only (for auto-subs).
    """
    is_done = fixture_is_final if final_only else fixture_is_finished
    team_status: dict[int, str] = {}
    for fx in fixtures:
        try:
            th = int(fx["team_h"])
            ta = int(fx["team_a"])
        except (KeyError, TypeError, ValueError):
            continue
        if is_done(fx):
            status = "finished"
        elif fixture_is_live(fx):
            status = "live"
        else:
            status = "scheduled"
        # Prefer finished > live > scheduled if DGW
        for tid in (th, ta):
            prev = team_status.get(tid)
            if prev == "finished":
                continue
            if status == "finished" or prev is None or (status == "live" and prev == "scheduled"):
                team_status[tid] = status

    out: dict[int, str] = {}
    for el in elements:
        try:
            eid = int(el["id"])
            team = int(el["team"])
        except (KeyError, TypeError, ValueError):
            continue
        out[eid] = team_status.get(team, "scheduled")
    return out


def calculate_manager_points_from_live(
    picks: list[dict],
    live_stats: dict[int, dict],
    match_status: dict[int, str],
    element_types: dict[int, int],
    active_chip: str | None = None,
    *,
    autosub_match_status: dict[int, str] | None = None,
) -> tuple[int, list[dict], list[dict]]:
    """Return (total_points, active_picks, auto_subs).

    Auto-subs use autosub_match_status when provided (typically final-only
    finished flags). Scoring still uses live_stats.total_points × multiplier.
    """
    if not picks:
        return 0, [], []

    # FPL chip id is 'bboost'; accept a few aliases.
    chip = (active_chip or "").lower()
    bench_boost = chip in {"bboost", "benchboost", "bench_boost"}
    sub_status = autosub_match_status if autosub_match_status is not None else match_status
    if bench_boost:
        active = list(picks)
        auto_subs: list[dict] = []
    else:
        active, auto_subs = apply_auto_substitution(
            picks, live_stats, sub_status, element_types
        )

    total = 0
    for pick in active:
        eid = int(pick["element"])
        mult = int(pick.get("multiplier") or 1)
        pts = _total_points(live_stats.get(eid))
        total += pts * mult
    return total, active, auto_subs


def live_stats_map(live_payload: dict) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for row in live_payload.get("elements") or []:
        try:
            eid = int(row["id"])
        except (KeyError, TypeError, ValueError):
            continue
        stats = row.get("stats") or {}
        if isinstance(stats, dict):
            out[eid] = stats
    return out


def element_type_map(bootstrap: dict) -> dict[int, int]:
    out: dict[int, int] = {}
    for el in bootstrap.get("elements") or []:
        try:
            out[int(el["id"])] = int(el["element_type"])
        except (KeyError, TypeError, ValueError):
            continue
    return out


def element_by_id(bootstrap: dict) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for el in bootstrap.get("elements") or []:
        try:
            out[int(el["id"])] = el
        except (KeyError, TypeError, ValueError):
            continue
    return out


def team_by_id(bootstrap: dict) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for t in bootstrap.get("teams") or []:
        try:
            out[int(t["id"])] = t
        except (KeyError, TypeError, ValueError):
            continue
    return out


def fixtures_for_element(
    element: dict,
    fixtures: list[dict],
) -> list[dict]:
    """GW fixtures for this player's club (may be 0–2)."""
    try:
        team = int(element["team"])
    except (KeyError, TypeError, ValueError):
        return []
    rows = []
    for fx in fixtures:
        try:
            th = int(fx["team_h"])
            ta = int(fx["team_a"])
        except (KeyError, TypeError, ValueError):
            continue
        if team == th:
            rows.append({**fx, "_ha": "H", "_opp": ta})
        elif team == ta:
            rows.append({**fx, "_ha": "A", "_opp": th})
    rows.sort(key=lambda f: f.get("kickoff_time") or f.get("kickoff_time") or "")
    return rows


def effective_element_multipliers(
    picks: list[dict],
    active_picks: list[dict],
) -> dict[int, int]:
    """Map element_id → effective multiplier (0 out/bench, 1 XI, 2 C, 3 TC).

    Auto-subs that still have API multiplier 0 are treated as 1.
    """
    active_by_id = {int(p["element"]): p for p in active_picks}
    out: dict[int, int] = {}
    for pick in picks:
        try:
            eid = int(pick["element"])
        except (KeyError, TypeError, ValueError):
            continue
        if eid not in active_by_id:
            out[eid] = 0
            continue
        mult = int(active_by_id[eid].get("multiplier") or 0)
        if mult <= 0:
            mult = 1
        out[eid] = mult
    return out


def top_third_entry_ids(standings_results: list[dict]) -> list[int]:
    """First ceil(n/3) entries from official standings order (overall rank)."""
    n = len(standings_results)
    if n <= 0:
        return []
    top_n = max(1, (n + 2) // 3)  # ceil(n/3)
    ids: list[int] = []
    for row in standings_results[:top_n]:
        try:
            ids.append(int(row["entry"]))
        except (KeyError, TypeError, ValueError):
            continue
    return ids


def importance_pct(our_mult: int, top_third_mults: list[int]) -> int:
    """Defcon Importance: (our mult×100) − mean(top-third mult×100).

    100% ≈ unique XI vs top third; 200% captain; 300% triple captain.
    Positive = you gain more share than the top third average.
    """
    our = int(our_mult or 0) * 100
    if not top_third_mults:
        return our
    avg = (sum(int(m or 0) for m in top_third_mults) * 100) / len(top_third_mults)
    return int(round(our - avg))
