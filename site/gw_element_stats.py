"""Shared normalizer for per-GW element stats from FPL /event/{gw}/live/."""
from __future__ import annotations

# FPL DefCon thresholds (2025/26+): DEF 10 CBIT, MID/FWD 12 CBIRT. GK ineligible.
DEFCON_THRESHOLD_BY_TYPE = {
    2: 10,  # DEF
    3: 12,  # MID
    4: 12,  # FWD
}


def _inum(stats: dict, key: str) -> int:
    try:
        return int(stats.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def _fnum(stats: dict, key: str) -> float:
    try:
        return float(stats.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def defcon_hit(element_type: int, minutes: int, cbit: int, cbitr: int) -> bool:
    if minutes <= 0 or element_type not in DEFCON_THRESHOLD_BY_TYPE:
        return False
    threshold = DEFCON_THRESHOLD_BY_TYPE[element_type]
    actions = cbit if element_type == 2 else cbitr
    return actions >= threshold


def normalize_element_gw_record(
    stats: dict,
    *,
    element_type: int = 0,
    team_id: int = 0,
    fixture_id: int | None = None,
    live: bool = False,
    status: str = "finished",
) -> dict:
    """Map one element's live-GW stats into the canonical elementGw record."""
    cbi = _inum(stats, "clearances_blocks_interceptions")
    tackles = _inum(stats, "tackles")
    recoveries = _inum(stats, "recoveries")
    cbit = cbi + tackles
    cbitr = cbit + recoveries
    mins = _inum(stats, "minutes")
    etype = int(element_type or 0)
    xg = _fnum(stats, "expected_goals")
    xa = _fnum(stats, "expected_assists")
    xgi = _fnum(stats, "expected_goal_involvements")
    if xgi <= 0 and (xg > 0 or xa > 0):
        xgi = round(xg + xa, 3)
    return {
        "pts": _inum(stats, "total_points"),
        "minutes": mins,
        "live": bool(live),
        "status": status,
        "goals": _inum(stats, "goals_scored"),
        "assists": _inum(stats, "assists"),
        "cleanSheets": _inum(stats, "clean_sheets"),
        "saves": _inum(stats, "saves"),
        "bps": _inum(stats, "bps"),
        "bonus": _inum(stats, "bonus"),
        "yellowCards": _inum(stats, "yellow_cards"),
        "redCards": _inum(stats, "red_cards"),
        "ownGoals": _inum(stats, "own_goals"),
        "penaltiesMissed": _inum(stats, "penalties_missed"),
        "penaltiesSaved": _inum(stats, "penalties_saved"),
        "goalsConceded": _inum(stats, "goals_conceded"),
        "xg": round(xg, 3),
        "xa": round(xa, 3),
        "xgi": round(xgi, 3),
        "xgc": round(_fnum(stats, "expected_goals_conceded"), 3),
        "cbit": cbit,
        "cbitr": cbitr,
        "recoveries": recoveries,
        "defensiveContribution": _inum(stats, "defensive_contribution"),
        "defConHit": defcon_hit(etype, mins, cbit, cbitr),
        "elementType": etype,
        "teamId": int(team_id or 0),
        "fixtureId": fixture_id,
    }
