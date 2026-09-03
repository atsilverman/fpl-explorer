#!/usr/bin/env python3
"""
Regenerates site/data.js from the 4 source CSVs in the project root.
Run this again any time the CSVs are updated:

    python3 site/build.py

It parses the FPL export format where each player/team row's first
column is "<POSITION><Name><TEAM3>" concatenated with no separator
(e.g. "MIDB.FernandesMUN" -> MID, B.Fernandes, MUN) and splits it into
clean fields, then merges the Home + Away files into Home / Away /
Combined (season total) views.

It also matches each player against the newest bootstrap-static snapshot
in snapshots/ to attach a 2026/27 price (see match_new_season_prices()).
"""
import csv
import json
import re
import sys
import unicodedata
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = Path(__file__).resolve().parent
OUT = SITE / "data.js"
sys.path.insert(0, str(SITE))
from fpl_gameweeks import active_gameweek_id, extract_gameweeks  # noqa: E402
SNAPSHOTS_DIR = ROOT / "snapshots"
OVERRIDES_PATH = Path(__file__).resolve().parent / "price_overrides.json"
LAST_SEASON_STATS_PATH = SNAPSHOTS_DIR / "history_past_2025-26.json"
REPORTS_DIR = ROOT / "reports"

PLAYER_H = ROOT / "FPL Data - Player Key Stats (H).csv"
PLAYER_A = ROOT / "FPL Data - Player Key Stats (A).csv"
TEAM_H = ROOT / "FPL Data - Team Key Stats (H).csv"
TEAM_A = ROOT / "FPL Data - Team Key Stats (A).csv"

POSITIONS = ["GK", "DEF", "MID", "FWD"]

# Relegated at the end of 2025/26 — excluded from the site entirely.
EXCLUDED_TEAMS = {"BUR", "WHU", "WOL"}

# All 20 top-flight codes present in the raw source data (needed to validate
# parsed rows before exclusion is applied).
ALL_TEAM_CODES = [
    "ARS", "AVL", "BHA", "BOU", "BRE", "BUR", "CHE", "CRY", "EVE", "FUL",
    "LEE", "LIV", "MCI", "MUN", "NEW", "NFO", "SUN", "TOT", "WHU", "WOL",
]

# Codes actually shipped on the site once relegated teams are dropped.
TEAM_CODES = [c for c in ALL_TEAM_CODES if c not in EXCLUDED_TEAMS]

# FPL "club code" per team (stable badge/shirt identifier, distinct from the
# season's numeric team `id`) — verified against a bootstrap-static snapshot.
# Badge SVGs live in site/badges/, named by 3-letter short code (ARS.svg, …).
TEAM_CLUB_CODE = {
    "ARS": 3, "AVL": 7, "BHA": 36, "BOU": 91, "BRE": 94, "BUR": 90,
    "CHE": 8, "CRY": 31, "EVE": 11, "FUL": 54, "LEE": 2, "LIV": 14,
    "MCI": 43, "MUN": 1, "NEW": 4, "NFO": 17, "SUN": 56, "TOT": 6,
    "WHU": 21, "WOL": 39,
}


def split_player_key(raw):
    pos = next((p for p in POSITIONS if raw.startswith(p)), None)
    if pos is None:
        raise ValueError(f"Unrecognized position prefix in: {raw!r}")
    rest = raw[len(pos):]
    team = rest[-3:]
    if team not in ALL_TEAM_CODES:
        raise ValueError(f"Unrecognized team code {team!r} in: {raw!r}")
    name = rest[:-3]
    return pos, name, team


def split_team_key(raw):
    team = raw[-3:]
    if team not in ALL_TEAM_CODES:
        raise ValueError(f"Unrecognized team code {team!r} in: {raw!r}")
    name = raw[:-3]
    return name, team


def num(v):
    v = v.strip()
    if v == "":
        return 0
    try:
        f = float(v)
    except ValueError:
        return v
    return int(f) if f.is_integer() else round(f, 3)


def price_to_float(v):
    return float(v.replace("£", "").replace("m", "").strip())


PLAYER_FIELD_MAP = [
    ("Price", "price", price_to_float),
    ("Apps", "apps", num),
    ("Mins", "mins", num),
    ("S", "shots", num),
    ("OT", "shotsOnTarget", num),
    ("IN", "touchesBox", num),
    ("BC", "bigChances", num),
    ("XG", "xg", num),
    ("G", "goals", num),
    ("KP", "keyPasses", num),
    ("BCC", "bigChancesCreated", num),
    ("XA", "xa", num),
    ("A", "assists", num),
    ("XPTS", "xPts", num),
    ("BPS", "bps", num),
    ("B", "bonus", num),
    ("DC", "defCon", num),
    ("PTS", "pts", num),
]

TEAM_SUM_FIELDS = [
    "gp", "shots", "shotsOnTarget", "touchesBox", "bigChances", "xg",
    "goals", "xgc", "xcs", "goalsConceded", "cleanSheets", "xgd", "pts",
]
PLAYER_SUM_FIELDS = [
    "apps", "mins", "shots", "shotsOnTarget", "touchesBox", "bigChances",
    "xg", "goals", "keyPasses", "bigChancesCreated", "xa", "assists",
    "xPts", "bps", "bonus", "defCon", "pts",
]


def load_players(path):
    rows = {}
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            pos, name, team = split_player_key(row["Player"])
            if team in EXCLUDED_TEAMS:
                continue
            rec = {"position": pos, "name": name, "team": team}
            for csv_key, out_key, conv in PLAYER_FIELD_MAP:
                rec[out_key] = conv(row[csv_key])
            key = f"{pos}|{name}|{team}"
            rows[key] = rec
    return rows


def load_teams(path):
    rows = {}
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        # header has XGC twice; DictReader keeps the last occurrence only,
        # so re-read with the fieldnames positionally instead.
        f.seek(0)
        raw = csv.reader(f)
        header = next(raw)
        for cols in raw:
            row = dict(zip(header, cols))
            name_full, team = split_team_key(cols[0])
            if team in EXCLUDED_TEAMS:
                continue
            vals = cols[1:]
            # Source header reads: NAME, GP, S, OT, IN, BC, XG, G, XGC, XGC, XCS, GC, CS, GD, PTS
            # — but the second "XGC" is a mislabeled duplicate: the sheet's
            # header row is shifted one column short from XGC onward, so the
            # *data* in those cells is actually XCS, GC, CS, XGD (in that
            # order), with GD then back in sync. Confirmed by checking that
            # the raw "CS" column's values equal xG − xGC exactly (the
            # definition of expected goal difference), not clean-sheet counts.
            gp, s, ot, in_, bc, xg, g, xgc, raw_xcs, raw_gc, raw_cs, raw_xgd, gd, pts = vals
            rec = {
                "team": team,
                "name": name_full,
                "gp": num(gp),
                "shots": num(s),
                "shotsOnTarget": num(ot),
                "touchesBox": num(in_),
                "bigChances": num(bc),
                "xg": num(xg),
                "goals": num(g),
                "xgc": num(xgc),
                "xcs": num(raw_xcs),
                "goalsConceded": num(raw_gc),
                "cleanSheets": num(raw_cs),
                "xgd": num(raw_xgd),
                "gd": num(gd),
                "pts": num(pts),
            }
            rows[team] = rec
    return rows


def merge_players(home, away):
    keys = set(home) | set(away)
    out = {"home": [], "away": [], "combined": []}
    for key in keys:
        h = home.get(key)
        a = away.get(key)
        base = h or a
        pos, name, team = base["position"], base["name"], base["team"]
        pid = f"{pos}-{name}-{team}".replace(" ", "_")
        if h:
            hh = dict(h)
            hh["id"] = pid
            out["home"].append(hh)
        if a:
            aa = dict(a)
            aa["id"] = pid
            out["away"].append(aa)
        combined = {"id": pid, "position": pos, "name": name, "team": team}
        # price: same in both splits; take whichever exists
        combined["price"] = (h or a)["price"]
        for field in PLAYER_SUM_FIELDS:
            combined[field] = round((h[field] if h else 0) + (a[field] if a else 0), 3)
        combined["playedHome"] = bool(h)
        combined["playedAway"] = bool(a)
        out["combined"].append(combined)
    return out


def merge_teams(home, away):
    keys = set(home) | set(away)
    out = {"home": [], "away": [], "combined": []}
    for team in keys:
        h = home.get(team)
        a = away.get(team)
        base = h or a
        if h:
            out["home"].append(dict(h))
        if a:
            out["away"].append(dict(a))
        combined = {"team": team, "name": base["name"]}
        for field in TEAM_SUM_FIELDS:
            combined[field] = round((h[field] if h else 0) + (a[field] if a else 0), 3)
        combined["gd"] = round(combined["goals"] - combined["goalsConceded"], 3)
        out["combined"].append(combined)
    return out


def normalize_name(s):
    """Strips accents/punctuation/case so 'Traoré' == 'traore' == 'TRAORE'."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", s.lower())


# FPL's element_type short names -> this site's position codes.
FPL_POS_MAP = {"GKP": "GK", "DEF": "DEF", "MID": "MID", "FWD": "FWD"}


def fetch_league_positions(season_year=2025):
    """Premier League table positions from ESPN's public standings feed
    (no API key required).

    ESPN's `season` query is the start year of the campaign, so 2025 →
    2025/26. Abbreviations mostly match FPL short codes; Man City / United
    are remapped (MNC→MCI, MAN→MUN).
    """
    import urllib.error
    import urllib.request

    espn_to_fpl = {"MNC": "MCI", "MAN": "MUN"}
    url = (
        "https://site.api.espn.com/apis/v2/sports/soccer/eng.1/standings"
        f"?season={season_year}"
    )
    meta = {"source": "espn", "seasonYear": season_year, "url": url}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "FPL-Explorer/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        meta["error"] = str(exc)
        return {}, meta

    try:
        standings = payload["children"][0]["standings"]
        meta["seasonLabel"] = standings.get("seasonDisplayName") or f"{season_year}/{season_year + 1 - 2000:02d}"
        entries = standings["entries"]
    except (KeyError, IndexError, TypeError) as exc:
        meta["error"] = f"unexpected ESPN payload: {exc}"
        return {}, meta

    positions = {}
    for entry in entries:
        team = entry.get("team") or {}
        abbr = team.get("abbreviation") or ""
        code = espn_to_fpl.get(abbr, abbr)
        stats = entry.get("stats") or []
        rank = next((s.get("value") for s in stats if s.get("name") == "rank"), None)
        if code and rank is not None:
            positions[code] = int(rank)

    meta["count"] = len(positions)
    return positions, meta


def latest_bootstrap_snapshot():
    """Picks the newest non-archived bootstrap-static_*.json in snapshots/."""
    candidates = sorted(
        p for p in SNAPSHOTS_DIR.glob("bootstrap-static_*.json") if "archived" not in p.stem
    )
    return candidates[-1] if candidates else None


def _http_get_json(url: str, timeout: int = 45):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "fpl-explorer/1.0 (+build-apps)", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


from gw_element_stats import DEFCON_THRESHOLD_BY_TYPE, normalize_element_gw_record

# FPL DefCon: 2 pts when match actions clear the bar.
DEFCON_POINTS_PER_HIT = 2


def _empty_live_bucket() -> dict:
    return {
        "apps": 0,
        "starts": 0,
        "mins": 0,
        "xg": 0.0,
        "goals": 0,
        "xa": 0.0,
        "assists": 0,
        "bps": 0,
        "bonus": 0,
        "pts": 0,
        "cleanSheets": 0,
        "goalsConceded": 0,
        "xgc": 0.0,
        "saves": 0,
        "xgi": 0.0,
        "cbit": 0,
        "cbitr": 0,
        "defCon": 0,
        "defConActions": 0,
        "_defConHits": 0,
    }


def _fnum(stats: dict, key: str) -> float:
    try:
        return float(stats.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def _inum(stats: dict, key: str) -> int:
    try:
        return int(stats.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def _add_live_stats(bucket: dict, stats: dict, element_type: int | None) -> None:
    """Accumulate one GW's live stats into a venue bucket."""
    mins = _inum(stats, "minutes")
    if mins > 0:
        bucket["apps"] += 1
    bucket["starts"] += _inum(stats, "starts")
    bucket["mins"] += mins
    bucket["xg"] += _fnum(stats, "expected_goals")
    bucket["goals"] += _inum(stats, "goals_scored")
    bucket["xa"] += _fnum(stats, "expected_assists")
    bucket["assists"] += _inum(stats, "assists")
    bucket["bps"] += _inum(stats, "bps")
    bucket["bonus"] += _inum(stats, "bonus")
    bucket["pts"] += _inum(stats, "total_points")
    bucket["cleanSheets"] += _inum(stats, "clean_sheets")
    bucket["goalsConceded"] += _inum(stats, "goals_conceded")
    bucket["xgc"] += _fnum(stats, "expected_goals_conceded")
    bucket["saves"] += _inum(stats, "saves")
    bucket["xgi"] += _fnum(stats, "expected_goal_involvements")
    cbit = _inum(stats, "clearances_blocks_interceptions") + _inum(stats, "tackles")
    recoveries = _inum(stats, "recoveries")
    bucket["cbit"] += cbit
    bucket["cbitr"] += cbit + recoveries
    bucket["defConActions"] += _inum(stats, "defensive_contribution")
    threshold = DEFCON_THRESHOLD_BY_TYPE.get(element_type) if element_type else None
    if threshold and mins > 0:
        actions = cbit if element_type == 2 else cbit + recoveries
        if actions >= threshold:
            bucket["_defConHits"] += 1
            bucket["defCon"] = bucket["_defConHits"] * DEFCON_POINTS_PER_HIT


def _team_venue_by_gw(fixtures: list, gw: int) -> dict[int, str | None]:
    """Map FPL team_id → 'H' | 'A' | None for a gameweek.

    None means the club had no fixture, or a DGW spanning both venues (stats
    stay on combined only for that GW).
    """
    by_team: dict[int, list[str]] = {}
    for f in fixtures:
        if f.get("event") != gw:
            continue
        try:
            th = int(f["team_h"])
            ta = int(f["team_a"])
        except (KeyError, TypeError, ValueError):
            continue
        by_team.setdefault(th, []).append("H")
        by_team.setdefault(ta, []).append("A")
    out: dict[int, str | None] = {}
    for tid, venues in by_team.items():
        uniq = set(venues)
        out[tid] = venues[0] if len(uniq) == 1 else None
    return out


def live_gw_aggregates_by_element(bootstrap: dict) -> tuple[dict, dict]:
    """From /event/{gw}/live/ + fixtures venue: per-player home/away/combined.

    Returns (by_split, meta) where by_split is
      { "home"|"away"|"combined": { element_id: stats_bucket } }.

    DefCon points = 2 × matches where the position threshold is hit
    (DEF 10 CBIT, MID/FWD 12 CBIRT). Appearances = GWs with minutes > 0.

    Finished GWs reuse snapshots/event-live_{gw}.json; the current GW is
    always re-fetched so mid-weekend updates land on rebuild.
    """
    events = bootstrap.get("events") or []
    element_type = {
        int(e["id"]): int(e["element_type"])
        for e in (bootstrap.get("elements") or [])
        if e.get("id") is not None and e.get("element_type") is not None
    }
    element_team = {
        int(e["id"]): int(e["team"])
        for e in (bootstrap.get("elements") or [])
        if e.get("id") is not None and e.get("team") is not None
    }
    gw_ids: list[int] = []
    current_id = None
    for ev in events:
        try:
            eid = int(ev["id"])
        except (KeyError, TypeError, ValueError):
            continue
        if ev.get("is_current"):
            current_id = eid
        if ev.get("finished") or ev.get("is_current") or ev.get("is_previous"):
            gw_ids.append(eid)
    seen = set()
    ordered = []
    for eid in gw_ids:
        if eid not in seen:
            seen.add(eid)
            ordered.append(eid)

    fx_path = latest_fixtures_snapshot()
    fixtures = []
    if fx_path is not None:
        try:
            fixtures = json.loads(fx_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            fixtures = []

    by_split = {"home": {}, "away": {}, "combined": {}}
    # Per-element GW points in gameweek order — Planner Form sparkline.
    form_pts: dict[int, list[int]] = {}
    fetched = 0
    cached = 0
    failed = []
    hit_log = []
    mixed_venue_gws = 0

    def bucket_for(split: str, eid: int) -> dict:
        store = by_split[split]
        if eid not in store:
            store[eid] = _empty_live_bucket()
        return store[eid]

    for gw in ordered:
        cache_path = SNAPSHOTS_DIR / f"event-live_{gw}.json"
        live = None
        use_cache = cache_path.exists() and gw != current_id
        if use_cache:
            try:
                live = json.loads(cache_path.read_text(encoding="utf-8"))
                cached += 1
            except (OSError, json.JSONDecodeError):
                live = None
        if live is None:
            try:
                live = _http_get_json(
                    f"https://fantasy.premierleague.com/api/event/{gw}/live/"
                )
                SNAPSHOTS_DIR.mkdir(exist_ok=True)
                cache_path.write_text(json.dumps(live), encoding="utf-8")
                fetched += 1
            except Exception as exc:  # noqa: BLE001
                if cache_path.exists():
                    try:
                        live = json.loads(cache_path.read_text(encoding="utf-8"))
                        cached += 1
                    except (OSError, json.JSONDecodeError):
                        live = None
                if live is None:
                    failed.append({"gw": gw, "error": str(exc)})
                    continue

        venue_by_team = _team_venue_by_gw(fixtures, gw)
        if any(v is None for v in venue_by_team.values()):
            mixed_venue_gws += 1

        for el in live.get("elements") or []:
            try:
                eid = int(el["id"])
                stats = el.get("stats") or {}
            except (KeyError, TypeError, ValueError):
                continue
            etype = element_type.get(eid)
            tid = element_team.get(eid)
            venue = venue_by_team.get(tid) if tid is not None else None
            form_pts.setdefault(eid, []).append(_inum(stats, "total_points"))

            _add_live_stats(bucket_for("combined", eid), stats, etype)
            if venue in ("H", "A"):
                split = "home" if venue == "H" else "away"
                before_hits = bucket_for(split, eid)["_defConHits"]
                _add_live_stats(bucket_for(split, eid), stats, etype)
                if bucket_for(split, eid)["_defConHits"] > before_hits:
                    hit_log.append(
                        {
                            "gw": gw,
                            "element": eid,
                            "elementType": etype,
                            "venue": venue,
                            "threshold": DEFCON_THRESHOLD_BY_TYPE.get(etype),
                        }
                    )

    # Round floats; drop internal hit counter from exported buckets.
    for split_map in by_split.values():
        for bucket in split_map.values():
            for key in ("xg", "xa", "xgc", "xgi"):
                bucket[key] = round(bucket[key], 3)
            bucket.pop("_defConHits", None)

    apps = {eid: b["apps"] for eid, b in by_split["combined"].items() if b["apps"]}
    defcon_pts = {
        eid: b["defCon"] for eid, b in by_split["combined"].items() if b["defCon"]
    }
    meta = {
        "gameweeks": ordered,
        "fetched": fetched,
        "cached": cached,
        "playersWithApps": len(apps),
        "defConHits": len(hit_log),
        "playersWithDefCon": len(defcon_pts),
        "failed": failed,
        "hitLog": hit_log,
        "fixturesSource": fx_path.name if fx_path else None,
        "mixedVenueGameweeks": mixed_venue_gws,
        "homePlayers": len(by_split["home"]),
        "awayPlayers": len(by_split["away"]),
        "formPtsByElement": form_pts,
    }
    return by_split, meta


def build_defcon_by_gw(bootstrap: dict | None = None) -> dict:
    """Per-GW DefCon progress from event-live snapshots (finished GWs).

    Shape matches fetch_home elementGw DefCon fields:
      { "<gw>": { "<elementId>": { minutes, cbit, cbitr, …, status } } }
    """
    if bootstrap is None:
        snap_path = latest_bootstrap_snapshot()
        if snap_path is None:
            return {}
        bootstrap = json.loads(snap_path.read_text(encoding="utf-8"))

    element_type = {
        int(e["id"]): int(e["element_type"])
        for e in (bootstrap.get("elements") or [])
        if e.get("id") is not None and e.get("element_type") is not None
    }
    element_team = {
        int(e["id"]): int(e["team"])
        for e in (bootstrap.get("elements") or [])
        if e.get("id") is not None and e.get("team") is not None
    }

    fx_path = latest_fixtures_snapshot()
    fixtures = []
    if fx_path is not None:
        try:
            fixtures = json.loads(fx_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            fixtures = []

    # Collect finished / previous GWs that have a cached event-live file.
    gw_ids: list[int] = []
    for ev in bootstrap.get("events") or []:
        try:
            eid = int(ev["id"])
        except (KeyError, TypeError, ValueError):
            continue
        if ev.get("finished") or ev.get("is_previous"):
            gw_ids.append(eid)
    # Always include GW1 backfill when the snapshot exists.
    if 1 not in gw_ids and (SNAPSHOTS_DIR / "event-live_1.json").exists():
        gw_ids.append(1)

    out: dict[str, dict] = {}
    for gw in sorted(set(gw_ids)):
        cache_path = SNAPSHOTS_DIR / f"event-live_{gw}.json"
        if not cache_path.exists():
            continue
        try:
            live = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        fixture_id_by_team: dict[int, int] = {}
        for fx in fixtures:
            try:
                if int(fx.get("event") or 0) != gw:
                    continue
                fid = int(fx["id"])
                th = int(fx["team_h"])
                ta = int(fx["team_a"])
            except (KeyError, TypeError, ValueError):
                continue
            fixture_id_by_team[th] = fid
            fixture_id_by_team[ta] = fid

        gw_map: dict[str, dict] = {}
        for el in live.get("elements") or []:
            try:
                eid = int(el["id"])
                stats = el.get("stats") or {}
            except (KeyError, TypeError, ValueError):
                continue
            etype = element_type.get(eid) or 0
            team_id = element_team.get(eid) or 0
            gw_map[str(eid)] = normalize_element_gw_record(
                stats,
                element_type=etype,
                team_id=team_id,
                fixture_id=fixture_id_by_team.get(team_id),
                live=False,
                status="finished",
            )
        if gw_map:
            out[str(gw)] = gw_map
    return out


def build_next_season_squad():
    """Full 2026/27 FPL elements with combined + home/away splits.

    Combined stats come from bootstrap season totals (authoritative). Home/Away
    are summed from /event/{gw}/live/ tagged by fixture venue. Returns
    players/teams as {home, away, combined} lists.
    """
    snap_path = latest_bootstrap_snapshot()
    if snap_path is None:
        empty = {"home": [], "away": [], "combined": []}
        return empty, {}, {"source": None, "count": 0}, empty

    snap = json.loads(snap_path.read_text(encoding="utf-8"))
    teams_by_id = {t["id"]: t for t in snap["teams"]}
    team_names = {t["short_name"]: t["name"] for t in snap["teams"]}
    postype_by_id = {e["id"]: e["singular_name_short"] for e in snap["element_types"]}
    by_split, live_meta = live_gw_aggregates_by_element(snap)
    combined_live = by_split.get("combined") or {}
    form_pts_by_element = live_meta.pop("formPtsByElement", {}) or {}

    # Games played per club by venue from finished/provisional fixtures.
    fx_path = latest_fixtures_snapshot()
    gp_by_venue = {code: {"home": 0, "away": 0, "combined": 0} for code in team_names}
    if fx_path is not None:
        try:
            fixtures = json.loads(fx_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            fixtures = []
        for f in fixtures:
            if not (f.get("finished") or f.get("finished_provisional")):
                continue
            try:
                home = teams_by_id[int(f["team_h"])]["short_name"]
                away = teams_by_id[int(f["team_a"])]["short_name"]
            except (KeyError, TypeError, ValueError):
                continue
            gp_by_venue[home]["home"] += 1
            gp_by_venue[home]["combined"] += 1
            gp_by_venue[away]["away"] += 1
            gp_by_venue[away]["combined"] += 1

    STAT_KEYS = (
        "apps", "starts", "mins", "xg", "goals", "xa", "assists", "bps", "bonus",
        "pts", "cleanSheets", "goalsConceded", "xgc", "saves", "xgi", "cbit",
        "cbitr", "defCon", "defConActions",
    )

    def identity_row(e, team, pos):
        eid = int(e["id"])
        return {
            "id": f"fpl-{e['code']}",
            "element": eid,
            "name": e["web_name"],
            "team": team,
            "position": pos,
            "price": e["now_cost"] / 10,
            "code": e["code"],
            "penaltiesOrder": e.get("penalties_order"),
            "directFreekicksOrder": e.get("direct_freekicks_order"),
            "cornersOrder": e.get("corners_and_indirect_freekicks_order"),
            "form": float(e.get("form") or 0),
            "formPts": list(form_pts_by_element.get(eid) or []),
            "ppg": float(e.get("points_per_game") or 0),
            "ict": float(e.get("ict_index") or 0),
            "selectedBy": float(e.get("selected_by_percent") or 0),
        }

    def bootstrap_stats(e, eid):
        cbit = int(e.get("clearances_blocks_interceptions") or 0) + int(e.get("tackles") or 0)
        recoveries = int(e.get("recoveries") or 0)
        starts = int(e.get("starts") or 0)
        mins = int(e.get("minutes") or 0)
        live = combined_live.get(eid) or {}
        if eid in combined_live and live.get("apps"):
            apps = int(live["apps"])
        elif starts:
            apps = starts
        else:
            apps = 1 if mins > 0 else 0
        return {
            "apps": apps,
            "starts": starts,
            "mins": mins,
            "xg": api_number(e, "expected_goals"),
            "goals": int(e.get("goals_scored") or 0),
            "xa": api_number(e, "expected_assists"),
            "assists": int(e.get("assists") or 0),
            "bps": int(e.get("bps") or 0),
            "bonus": int(e.get("bonus") or 0),
            "pts": int(e.get("total_points") or 0),
            "cleanSheets": int(e.get("clean_sheets") or 0),
            "goalsConceded": int(e.get("goals_conceded") or 0),
            "xgc": api_number(e, "expected_goals_conceded"),
            "saves": int(e.get("saves") or 0),
            "xgi": api_number(e, "expected_goal_involvements"),
            "cbit": cbit,
            "cbitr": cbit + recoveries,
            "defCon": int((live.get("defCon") if live else 0) or 0),
            "defConActions": int(e.get("defensive_contribution") or 0),
        }

    def live_stats(eid, split):
        bucket = (by_split.get(split) or {}).get(eid)
        if not bucket:
            return {k: 0 for k in STAT_KEYS}
        out = {k: bucket.get(k, 0) for k in STAT_KEYS if k != "defConActions"}
        # Actions are season-total in bootstrap; keep venue-split actions from live.
        out["defConActions"] = int(bucket.get("defConActions") or 0)
        return out

    def sort_players(rows):
        rows.sort(
            key=lambda p: (
                p["team"],
                POSITIONS.index(p["position"]) if p["position"] in POSITIONS else 99,
                p["name"],
            )
        )
        return rows

    def team_rows_from_players(player_rows, split):
        by_team = {}
        for p in player_rows:
            by_team.setdefault(p["team"], []).append(p)
        teams = []
        for tid, tmeta in teams_by_id.items():
            code = tmeta["short_name"]
            plist = by_team.get(code) or []
            gks = [p for p in plist if p["position"] == "GK"]
            defs = [p for p in plist if p["position"] == "DEF"]
            mids = [p for p in plist if p["position"] == "MID"]
            outfield = [p for p in plist if p["position"] != "GK"]
            gc_all = sum(p["goalsConceded"] for p in plist)
            team_gc = sum(p["goalsConceded"] for p in gks) if gks else gc_all
            # Team CS ≈ sum of GK clean_sheets (one eligible keeper per CS GW).
            # Fallback: max DEF/MID CS — covers the rare case the keeper was
            # subbed before 60' so FPL gave CS to outfield only. Never sum
            # DEF/MID (many players share one team CS).
            gk_cs = sum(int(p.get("cleanSheets") or 0) for p in gks)
            outfield_cs = 0
            for p in defs + mids:
                outfield_cs = max(outfield_cs, int(p.get("cleanSheets") or 0))
            team_cs = max(gk_cs, outfield_cs)
            team_xgc = round(sum(p["xgc"] for p in gks), 3) if gks else 0
            team_xg = round(sum(p["xg"] for p in outfield), 3)
            team_goals = sum(p["goals"] for p in outfield)
            gp = gp_by_venue.get(code, {}).get(split, 0)
            if split == "combined" and gp == 0:
                gp = int(tmeta.get("played") or 0)
            teams.append({
                "team": code,
                "name": tmeta.get("name") or code,
                "gp": gp,
                "pts": sum(int(p.get("pts") or 0) for p in plist),
                "xg": team_xg,
                "goals": team_goals,
                "xgc": team_xgc,
                "goalsConceded": team_gc,
                "cleanSheets": team_cs,
                "xcs": None,
                "xgd": round(team_xg - team_xgc, 3),
                "gd": team_goals - team_gc,
                "shots": 0,
                "shotsOnTarget": 0,
                "touchesBox": 0,
                "bigChances": 0,
                "squadPts": sum(int(p.get("pts") or 0) for p in plist),
                "tablePts": int(tmeta.get("points") or 0),
            })
        teams.sort(key=lambda t: t["team"])
        return teams

    players_by_split = {"home": [], "away": [], "combined": []}
    for e in snap["elements"]:
        tmeta = teams_by_id.get(e["team"])
        if not tmeta:
            continue
        team = tmeta["short_name"]
        pos_raw = postype_by_id.get(e["element_type"], "")
        pos = FPL_POS_MAP.get(pos_raw, pos_raw)
        eid = int(e["id"])
        base = identity_row(e, team, pos)

        combined = {**base, **bootstrap_stats(e, eid)}
        players_by_split["combined"].append(combined)

        for split in ("home", "away"):
            row = {**base, **live_stats(eid, split)}
            # Season-level rates stay on the identity; don't invent venue form.
            players_by_split[split].append(row)

    for split in players_by_split:
        sort_players(players_by_split[split])

    teams_by_split = {
        split: team_rows_from_players(players_by_split[split], split)
        for split in ("home", "away", "combined")
    }

    meta = {
        "source": snap_path.name,
        "count": len(players_by_split["combined"]),
        "teams": len(team_names),
        "statsFrom": "bootstrap-static+event-live",
        "liveAggregates": live_meta,
        "splits": True,
    }
    return players_by_split, team_names, meta, teams_by_split


def league_positions_from_fixtures(bootstrap: dict | None = None):
    """Premier League table ranks from finished fixture scorelines.

    Prefer this over ESPN — no third-party dependency, uses the same
    snapshots/fixtures_*.json the rest of the site already trusts.
    """
    fx_path = latest_fixtures_snapshot()
    bs_path = latest_bootstrap_snapshot() if bootstrap is None else None
    meta = {
        "source": "fixtures",
        "fixturesSource": fx_path.name if fx_path else None,
        "bootstrapSource": None,
    }
    if fx_path is None:
        meta["error"] = "no fixtures snapshot"
        return {}, meta

    if bootstrap is None:
        if bs_path is None:
            meta["error"] = "no bootstrap snapshot"
            return {}, meta
        bootstrap = json.loads(bs_path.read_text(encoding="utf-8"))
        meta["bootstrapSource"] = bs_path.name

    teams_by_id = {int(t["id"]): t for t in bootstrap.get("teams") or []}
    table = {
        int(tid): {
            "code": t["short_name"],
            "played": 0,
            "won": 0,
            "drawn": 0,
            "lost": 0,
            "gf": 0,
            "ga": 0,
            "gd": 0,
            "pts": 0,
        }
        for tid, t in teams_by_id.items()
    }

    try:
        fixtures = json.loads(fx_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        meta["error"] = str(exc)
        return {}, meta

    counted = 0
    for f in fixtures:
        if not (f.get("finished") or f.get("finished_provisional")):
            continue
        try:
            th = int(f["team_h"])
            ta = int(f["team_a"])
            hs = int(f["team_h_score"])
            as_ = int(f["team_a_score"])
        except (KeyError, TypeError, ValueError):
            continue
        if th not in table or ta not in table:
            continue
        home, away = table[th], table[ta]
        home["played"] += 1
        away["played"] += 1
        home["gf"] += hs
        home["ga"] += as_
        away["gf"] += as_
        away["ga"] += hs
        if hs > as_:
            home["won"] += 1
            home["pts"] += 3
            away["lost"] += 1
        elif hs < as_:
            away["won"] += 1
            away["pts"] += 3
            home["lost"] += 1
        else:
            home["drawn"] += 1
            away["drawn"] += 1
            home["pts"] += 1
            away["pts"] += 1
        counted += 1

    for row in table.values():
        row["gd"] = row["gf"] - row["ga"]

    ranked = sorted(
        table.values(),
        key=lambda r: (-r["pts"], -r["gd"], -r["gf"], r["code"]),
    )
    positions = {row["code"]: i for i, row in enumerate(ranked, start=1)}
    meta.update({
        "count": len(positions),
        "fixturesCounted": counted,
        "seasonLabel": "2026/27",
        "table": [
            {
                "rank": i,
                "team": row["code"],
                "played": row["played"],
                "won": row["won"],
                "drawn": row["drawn"],
                "lost": row["lost"],
                "gf": row["gf"],
                "ga": row["ga"],
                "gd": row["gd"],
                "pts": row["pts"],
            }
            for i, row in enumerate(ranked, start=1)
        ],
    })
    return positions, meta

def latest_fixtures_snapshot():
    """Picks the newest fixtures_*.json in snapshots/."""
    candidates = sorted(SNAPSHOTS_DIR.glob("fixtures_*.json"))
    return candidates[-1] if candidates else None


def build_fixtures_by_team():
    """Builds per-team upcoming fixture lists from the FPL fixtures snapshot,
    keyed by short_name (ARS, …). Each entry is {gw, opp, ha, kickoff, difficulty}
    from that team's perspective (ha = H/A). difficulty is FPL's 1–5 FDR
    (team_h_difficulty / team_a_difficulty). Also returns bootstrap team names
    so promoted clubs missing from the OPTA CSVs still have a display name, plus
    a small meta blob naming the source files.
    """
    fx_path = latest_fixtures_snapshot()
    bs_path = latest_bootstrap_snapshot()
    if fx_path is None or bs_path is None:
        return {}, {}, {"source": None}

    bootstrap = json.loads(bs_path.read_text(encoding="utf-8"))
    teams_by_id = {t["id"]: t["short_name"] for t in bootstrap["teams"]}
    team_names = {t["short_name"]: t["name"] for t in bootstrap["teams"]}

    fixtures = json.loads(fx_path.read_text(encoding="utf-8"))
    by_team = {code: [] for code in teams_by_id.values()}

    upcoming = [
        f for f in fixtures
        if not f.get("finished") and f.get("event") is not None
    ]
    upcoming.sort(key=lambda f: (f["event"], f.get("kickoff_time") or ""))

    def fpl_difficulty(f, ha):
        raw = f.get("team_h_difficulty" if ha == "H" else "team_a_difficulty")
        try:
            d = int(raw)
        except (TypeError, ValueError):
            return None
        return d if 1 <= d <= 5 else None

    for f in upcoming:
        home = teams_by_id.get(f["team_h"])
        away = teams_by_id.get(f["team_a"])
        if not home or not away:
            continue
        kickoff = f.get("kickoff_time")
        home_row = {"gw": f["event"], "opp": away, "ha": "H", "kickoff": kickoff}
        away_row = {"gw": f["event"], "opp": home, "ha": "A", "kickoff": kickoff}
        home_d = fpl_difficulty(f, "H")
        away_d = fpl_difficulty(f, "A")
        if home_d is not None:
            home_row["difficulty"] = home_d
        if away_d is not None:
            away_row["difficulty"] = away_d
        by_team[home].append(home_row)
        by_team[away].append(away_row)

    gameweeks = extract_gameweeks(bootstrap, bs_path.name)
    active_gw = active_gameweek_id(gameweeks)
    if active_gw is None:
        gws = [fx["gw"] for rows in by_team.values() for fx in rows if fx.get("gw") is not None]
        active_gw = min(gws) if gws else 1

    meta = {
        "source": fx_path.name,
        "bootstrap": bs_path.name,
        # FPL triad (nullable ids). activeGw = current or next for UI windows.
        "previousGw": gameweeks["previous"]["id"] if gameweeks["previous"] else None,
        "currentGw": gameweeks["current"]["id"] if gameweeks["current"] else None,
        "nextGw": gameweeks["next"]["id"] if gameweeks["next"] else None,
        "activeGw": active_gw,
        "gameweeks": gameweeks,
    }
    return by_team, team_names, meta


def build_live_fixtures_by_gw(bootstrap: dict | None = None) -> dict:
    """Finished + in-play fixtures for Gameweek (Bonus/Feed) while a GW is still current.

    ``fixturesByTeam`` only keeps upcoming fixtures, so after FT the Bonus view
    would have no matchup cards until FPL flips ``is_current``. This map keeps
    previous/current (and any GW with an event-live snapshot) so BPS rankings
    stay visible until the next GW takes over.
    """
    fx_path = latest_fixtures_snapshot()
    if fx_path is None:
        return {}
    if bootstrap is None:
        bs_path = latest_bootstrap_snapshot()
        if bs_path is None:
            return {}
        bootstrap = json.loads(bs_path.read_text(encoding="utf-8"))

    teams_by_id = {
        int(t["id"]): t["short_name"]
        for t in (bootstrap.get("teams") or [])
        if t.get("id") is not None and t.get("short_name")
    }

    gw_ids: set[int] = set()
    for ev in bootstrap.get("events") or []:
        try:
            eid = int(ev["id"])
        except (KeyError, TypeError, ValueError):
            continue
        if ev.get("is_current") or ev.get("is_previous"):
            gw_ids.add(eid)
    for cache_path in SNAPSHOTS_DIR.glob("event-live_*.json"):
        try:
            gw_ids.add(int(cache_path.stem.split("_")[-1]))
        except ValueError:
            continue

    if not gw_ids:
        return {}

    try:
        fixtures = json.loads(fx_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    out: dict[str, list] = {}
    for f in fixtures:
        try:
            gw = int(f["event"])
        except (KeyError, TypeError, ValueError):
            continue
        if gw not in gw_ids:
            continue
        home = teams_by_id.get(int(f["team_h"])) if f.get("team_h") is not None else None
        away = teams_by_id.get(int(f["team_a"])) if f.get("team_a") is not None else None
        if not home or not away:
            continue
        out.setdefault(str(gw), []).append(
            {
                "home": home,
                "away": away,
                "kickoff": f.get("kickoff_time"),
                "finished": bool(f.get("finished") or f.get("finished_provisional")),
            }
        )

    for gw, rows in out.items():
        rows.sort(key=lambda r: (r.get("kickoff") or "", r["home"], r["away"]))
    return out


def load_price_overrides():
    """Manual pid -> FPL player `code` map for cases the auto-matcher can't
    (or gets wrong). See site/price_overrides.json — safe to hand-edit."""
    if not OVERRIDES_PATH.exists():
        return {}
    return json.loads(OVERRIDES_PATH.read_text(encoding="utf-8"))


def match_new_season_prices(players_combined):
    """Matches each 2025/26 player to their 2026/27 bootstrap-static entry by
    normalized name (team/position can't be trusted as join keys across a
    close season — see FPL_API_AUDIT_2026-07-23.md §9 — squads reshuffle and
    a handful of players get reclassified between positions).

    Returns (results, issues, meta):
      results: {pid: {price2627, priceDelta, newTeam, newPosition, status,
        penaltiesOrder, directFreekicksOrder, cornersOrder, code, webName}}
        the three *Order fields are the club's set-piece pecking order
        (1 = first choice) straight off the matched element, None if the
        player isn't on that list at all. `code` is the matched element's
        stable FPL code — also used to join against
        snapshots/history_past_2025-26.json (see apply_last_season_api_stats()).
        `webName` is the element's display string; main() copies it onto
        `name` after matching so the UI matches the FPL API (Hub CSV names
        remain the join key / pid basis). status is one of "ok" (name/team/position all agree), "transfer"
        (unique name match, team differs), "reclassified" (unique name
        match, position differs — can combine with "transfer"), or absent
        entirely if there's truly no 2026/27 price.
      issues: [{pid, name, team, position, reason, candidates}] for anything
        needing a human to look at it — currently just ambiguous
        (multiple same-name candidates even after team/position tiebreaks).
        Players who simply aren't in the 2026/27 elements list (retired,
        left the league) are NOT issues — that's an expected, unambiguous
        outcome, surfaced instead via a missing `results` entry.
      meta: snapshot filename + counts, for a footer/tooltip note.
    """
    snap_path = latest_bootstrap_snapshot()
    if snap_path is None:
        return {}, [], {"source": None}

    snap = json.loads(snap_path.read_text(encoding="utf-8"))
    teams_by_id = {t["id"]: t["short_name"] for t in snap["teams"]}
    postype_by_id = {e["id"]: e["singular_name_short"] for e in snap["element_types"]}

    def elem_pos(e):
        return FPL_POS_MAP.get(postype_by_id[e["element_type"]], postype_by_id[e["element_type"]])

    def elem_team(e):
        return teams_by_id[e["team"]]

    by_name = {}
    by_code = {}
    for e in snap["elements"]:
        by_name.setdefault(normalize_name(e["web_name"]), []).append(e)
        by_code[e["code"]] = e

    overrides = load_price_overrides()

    results = {}
    issues = []
    counts = {"ok": 0, "transfer": 0, "reclassified": 0, "override": 0, "ambiguous": 0, "unmatched": 0}

    for p in players_combined:
        pid = p["id"]

        if pid in overrides:
            e = by_code.get(overrides[pid])
            if e is None:
                issues.append({
                    "pid": pid, "name": p["name"], "team": p["team"], "position": p["position"],
                    "reason": f"price_overrides.json points at code {overrides[pid]!r}, not found in snapshot",
                    "candidates": [],
                })
                counts["unmatched"] += 1
                continue
            status = "override"
        else:
            cands = by_name.get(normalize_name(p["name"]), [])
            if not cands:
                counts["unmatched"] += 1
                continue
            pool = cands
            if len(pool) > 1:
                same_team = [c for c in pool if elem_team(c) == p["team"]]
                if same_team:
                    pool = same_team
            if len(pool) > 1:
                same_pos = [c for c in pool if elem_pos(c) == p["position"]]
                if same_pos:
                    pool = same_pos
            if len(pool) > 1:
                issues.append({
                    "pid": pid, "name": p["name"], "team": p["team"], "position": p["position"],
                    "reason": "multiple 2026/27 players share this name and couldn't be narrowed down by team or position",
                    "candidates": [
                        {"code": c["code"], "team": elem_team(c), "position": elem_pos(c),
                         "firstName": c["first_name"], "secondName": c["second_name"],
                         "price": c["now_cost"] / 10}
                        for c in pool
                    ],
                })
                counts["ambiguous"] += 1
                continue
            e = pool[0]
            team_changed = elem_team(e) != p["team"]
            pos_changed = elem_pos(e) != p["position"]
            status = "transfer" if team_changed else ("reclassified" if pos_changed else "ok")

        counts[status] += 1
        results[pid] = {
            "price2627": e["now_cost"] / 10,
            "priceDelta": round(e["now_cost"] / 10 - p["price"], 3),
            "newTeam": elem_team(e),
            "newPosition": elem_pos(e),
            "status": status,
            "penaltiesOrder": e.get("penalties_order"),
            "directFreekicksOrder": e.get("direct_freekicks_order"),
            "cornersOrder": e.get("corners_and_indirect_freekicks_order"),
            "code": e["code"],
            "element2627": int(e["id"]),
            # Display rename only — applied after match so Hub CSV strings
            # stay the join key. Player `id` keeps the Hub-based pid.
            "webName": e["web_name"],
        }

    meta = {
        "source": snap_path.name,
        "matched": len(results),
        "unmatched": counts["unmatched"],
        "ambiguous": counts["ambiguous"],
        "totalPlayers": len(players_combined),
    }
    return results, issues, meta


def build_fpl_identity(next_season_players: dict, source: str | None = None) -> dict:
    """Stable code → current-season element/team ids for live FPL joins."""
    combined = (next_season_players or {}).get("combined") or []
    element_by_code = {}
    missing = 0
    for row in combined:
        code = row.get("code")
        element = row.get("element")
        if code is None or element is None:
            missing += 1
            continue
        element_by_code[str(int(code))] = int(element)

    team_code_by_short = {}
    snap_path = latest_bootstrap_snapshot()
    if snap_path is not None:
        snap = json.loads(snap_path.read_text(encoding="utf-8"))
        source = source or snap_path.name
        for team in snap.get("teams") or []:
            short = team.get("short_name")
            tid = team.get("code")
            if short and tid is not None:
                team_code_by_short[str(short)] = int(tid)

    return {
        "elementByCode": element_by_code,
        "teamCodeByShort": team_code_by_short,
        "source": source,
        "playerCount": len(element_by_code),
        "missingElementRows": missing,
    }


def validate_fpl_identity(fpl_identity: dict, next_season_players: dict, price_meta: dict) -> None:
    combined = (next_season_players or {}).get("combined") or []
    bad = [r for r in combined if r.get("code") is None or r.get("element") is None]
    if bad:
        names = ", ".join(str(r.get("name") or "?") for r in bad[:5])
        raise RuntimeError(
            f"nextSeasonPlayers missing code/element on {len(bad)} row(s)"
            + (f" (e.g. {names})" if names else "")
        )
    if not fpl_identity.get("elementByCode"):
        raise RuntimeError("fplIdentity.elementByCode is empty — bootstrap snapshot may be missing")
    print(
        f"FPL identity: {fpl_identity['playerCount']} code→element mappings "
        f"from {fpl_identity.get('source') or 'nextSeasonPlayers'}; "
        f"2025/26 price match {price_meta.get('matched', 0)}/{price_meta.get('totalPlayers', 0)} "
        f"({price_meta.get('unmatched', 0)} departed/unmatched)"
    )


# Our CSV field -> the FPL element-summary history_past field it directly
# overlaps with. API values replace ours outright for any matched player.
# Values are ints in the API except the two noted, which arrive as decimal
# strings.
#
# defCon is deliberately NOT here: our "DC" column is fantasy points earned
# from the defensive-contribution rule (it lives in the Points/FPL group next
# to BPS/Bonus/PTS), but the API's `defensive_contribution` field is a raw
# action count instead (CBI + recoveries + tackles — verified: Haaland's
# 2025/26 value of 104 equals 48+41+15 exactly). Building this and diffing
# it caught the mismatch: our CSV total was 2,224 vs. the API field's 46,137,
# a ~20x scale difference that would have silently corrupted this column.
# There's no season-total "DEFCON points" field anywhere in the API — it's
# only ever baked into total_points — so this field simply isn't replaceable
# and is left on the original CSV value.
OVERLAP_FIELD_MAP = {
    "mins": "minutes",
    "xg": "expected_goals",  # string
    "goals": "goals_scored",
    "xa": "expected_assists",  # string
    "assists": "assists",
    "bps": "bps",
    "bonus": "bonus",
    "pts": "total_points",
}
STRING_NUMBER_API_FIELDS = {"expected_goals", "expected_assists", "expected_goals_conceded", "expected_goal_involvements"}

# Stats the API has that we don't ingest from the CSV at all — pure additions,
# no CSV counterpart to replace.
API_ONLY_FIELD_MAP = {
    "cleanSheets": "clean_sheets",
    "goalsConceded": "goals_conceded",
    "xgc": "expected_goals_conceded",  # string
    "saves": "saves",
    "xgi": "expected_goal_involvements",  # string
    # Starts are API-only for 2025/26 — Hub Apps stay as OPTA appearances.
    "starts": "starts",
}


def api_number(row, api_key):
    v = row[api_key]
    return round(float(v), 3) if api_key in STRING_NUMBER_API_FIELDS else v


def load_last_season_api_stats():
    """code -> history_past row for 2025/26, from snapshots/history_past_2025-26.json
    (see fetch_history_past.py). Empty dict if that fetch hasn't been run yet."""
    if not LAST_SEASON_STATS_PATH.exists():
        return {}
    raw = json.loads(LAST_SEASON_STATS_PATH.read_text(encoding="utf-8"))
    return {int(code): row for code, row in raw.items()}


def apply_last_season_api_stats(players_combined, price_matches, last_season_stats):
    """Overwrites the 9 direct-overlap fields with FPL API values and adds the
    5 API-only fields (clean sheets, goals conceded, xGC, saves, xGI) plus the
    two defensive-action totals (cbit, cbitr), for every combined-view player
    we can tie to a 2025/26 history_past row.

    Season-total data only — there's no home/away split in the API, so this
    only touches players_combined, never the home/away views.

    Returns (matched_count, unmatched_count, diff_rows) where diff_rows is
    [{id, name, team, position, fields: {csvField: {csv, api, diff}}}] for
    every matched player, for the CSV-vs-API discrepancy report.
    """
    matched, unmatched = 0, 0
    diff_rows = []
    for rec in players_combined:
        m = price_matches.get(rec["id"])
        code = m.get("code") if m else None
        row = last_season_stats.get(code) if code else None
        if row is None:
            unmatched += 1
            continue
        matched += 1

        diff_fields = {}
        for our_key, api_key in OVERLAP_FIELD_MAP.items():
            old = rec.get(our_key)
            new = api_number(row, api_key)
            diff_fields[our_key] = {
                "csv": old,
                "api": new,
                "diff": round(new - old, 3) if isinstance(old, (int, float)) else None,
            }
            rec[our_key] = new
        for our_key, api_key in API_ONLY_FIELD_MAP.items():
            rec[our_key] = api_number(row, api_key)
        # Raw action counts behind FPL's defensive-contribution rule, which
        # scores a different action set per position: defenders need 10 CBIT
        # (clearances, blocks, interceptions, tackles) in a match, midfielders
        # and forwards need 12 CBIRT — the same actions plus ball recoveries.
        # The API's own `defensive_contribution` already picks one of the two,
        # but it does so by the position the player held *last* season, which
        # is wrong for anyone since reclassified, so both totals ship and the
        # site selects by current position.
        rec["cbit"] = row["clearances_blocks_interceptions"] + row["tackles"]
        rec["cbitr"] = rec["cbit"] + row["recoveries"]

        diff_rows.append({
            "id": rec["id"], "name": rec["name"], "team": rec["team"], "position": rec["position"],
            "fields": diff_fields,
        })

    return matched, unmatched, diff_rows


def summarize_diffs(diff_rows):
    """Per-field discrepancy summary across every matched player: exact-match
    rate, mean/median/max absolute difference, and the single biggest outlier
    — the numbers behind the CSV-vs-API accuracy report."""
    summary = {}
    for key in OVERLAP_FIELD_MAP:
        entries = [(row["name"], row["team"], row["fields"][key]) for row in diff_rows]
        diffs = [f["diff"] for _, _, f in entries if f["diff"] is not None]
        if not diffs:
            summary[key] = None
            continue
        abs_diffs = sorted(abs(d) for d in diffs)
        n = len(diffs)
        exact = sum(1 for d in diffs if abs(d) < 1e-6)
        worst_name, worst_team, worst_f = max(entries, key=lambda e: abs(e[2]["diff"]))
        summary[key] = {
            "n": n,
            "exactMatches": exact,
            "exactMatchPct": round(100 * exact / n, 1),
            "meanAbsDiff": round(sum(abs_diffs) / n, 3),
            "medianAbsDiff": round(abs_diffs[n // 2], 3),
            "maxAbsDiff": round(abs_diffs[-1], 3),
            "maxAbsDiffPlayer": f"{worst_name} ({worst_team})",
            "maxAbsDiffValues": {"csv": worst_f["csv"], "api": worst_f["api"]},
            "csvTotal": round(sum(f["csv"] for _, _, f in entries), 1),
            "apiTotal": round(sum(f["api"] for _, _, f in entries), 1),
        }
    return summary


def main():
    ph = load_players(PLAYER_H)
    pa = load_players(PLAYER_A)
    th = load_teams(TEAM_H)
    ta = load_teams(TEAM_A)

    players = merge_players(ph, pa)
    teams = merge_teams(th, ta)

    price_matches, price_issues, price_meta = match_new_season_prices(players["combined"])
    renamed = 0
    for split in ("home", "away", "combined"):
        for rec in players[split]:
            m = price_matches.get(rec["id"])
            if not m:
                continue
            web_name = m.get("webName")
            payload = {k: v for k, v in m.items() if k != "webName"}
            rec.update(payload)
            # Align display with FPL API once we have a unique code match
            # (team/position already used as validators in the matcher).
            # Unmatched / ambiguous rows keep the Hub CSV name.
            if web_name:
                if split == "combined" and rec.get("name") != web_name:
                    renamed += 1
                rec["name"] = web_name

    # Season-total stats straight from the FPL API replace our CSV numbers
    # for direct-overlap fields and add API-only fields (combined view only —
    # see apply_last_season_api_stats()'s docstring for why home/away are
    # untouched).
    last_season_stats = load_last_season_api_stats()
    api_matched, api_unmatched, api_diff_rows = apply_last_season_api_stats(
        players["combined"], price_matches, last_season_stats
    )
    api_diff_summary = summarize_diffs(api_diff_rows)
    last_season_api_meta = {
        "source": LAST_SEASON_STATS_PATH.name if last_season_stats else None,
        "matched": api_matched,
        "unmatched": api_unmatched,
        "totalPlayers": len(players["combined"]),
    }

    team_names = {}
    for rec in list(th.values()) + list(ta.values()):
        team_names[rec["team"]] = rec["name"]

    fixtures_by_team, fixture_team_names, fixtures_meta = build_fixtures_by_team()
    next_season_players, next_season_team_names, next_season_meta, next_season_teams = (
        build_next_season_squad()
    )
    defcon_by_gw = build_defcon_by_gw()
    live_fixtures_by_gw = build_live_fixtures_by_gw()
    fpl_identity = build_fpl_identity(next_season_players, next_season_meta.get("source"))
    validate_fpl_identity(fpl_identity, next_season_players, price_meta)
    # PL table ranks from finished fixture scorelines (ESPN 403 fallback removed).
    league_positions, league_positions_meta = league_positions_from_fixtures()

    badges_dir = Path(__file__).resolve().parent / "badges"
    badge_codes = set(TEAM_CODES) | set(fixtures_by_team) | set(next_season_team_names)
    team_badges = {
        short: f"badges/{short}.svg"
        for short in sorted(badge_codes)
        if (badges_dir / f"{short}.svg").exists()
    }

    data = {
        "generatedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
        "teamNames": team_names,
        "fixtureTeamNames": {
            code: name for code, name in fixture_team_names.items() if code not in team_names
        },
        "teamBadges": team_badges,
        "leaguePositions": league_positions,
        "leaguePositionsMeta": league_positions_meta,
        "positions": POSITIONS,
        "players": players,
        "teams": teams,
        "fixturesByTeam": fixtures_by_team,
        "fixturesMeta": fixtures_meta,
        # Global prev/current/next GW (also nested under fixturesMeta).
        "gameweeks": fixtures_meta.get("gameweeks")
        or {"previous": None, "current": None, "next": None, "source": None},
        "newSeasonPriceMeta": price_meta,
        "priceMatchIssues": price_issues,
        "lastSeasonApiMeta": last_season_api_meta,
        "nextSeasonPlayers": next_season_players,
        "nextSeasonTeams": next_season_teams,
        "nextSeasonTeamNames": next_season_team_names,
        "nextSeasonMeta": next_season_meta,
        "defconByGw": defcon_by_gw,
        # Finished/current GW matchups for Gameweek Bonus (fixturesByTeam is upcoming-only).
        "liveFixturesByGw": live_fixtures_by_gw,
        "fplIdentity": fpl_identity,
    }

    OUT.write_text("window.FPL_DATA = " + json.dumps(data, ensure_ascii=False) + ";\n", encoding="utf-8")
    print(f"Wrote {OUT} ({OUT.stat().st_size:,} bytes)")
    print(f"Players: home={len(players['home'])} away={len(players['away'])} combined={len(players['combined'])}")
    print(f"Teams:   home={len(teams['home'])} away={len(teams['away'])} combined={len(teams['combined'])}")

    if last_season_stats:
        print(
            f"2025/26 API stats: {api_matched}/{len(players['combined'])} players matched from "
            f"{LAST_SEASON_STATS_PATH.name} (mins/xg/goals/xa/assists/bps/bonus/pts replaced with API "
            f"totals, cleanSheets/goalsConceded/xgc/saves/xgi/cbit/cbitr added — combined view only)"
        )
        REPORTS_DIR.mkdir(exist_ok=True)
        report_path = REPORTS_DIR / "fpl_api_diff_2025-26.json"
        report = {
            "generatedAt": data["generatedAt"],
            "source": LAST_SEASON_STATS_PATH.name,
            "matched": api_matched,
            "unmatched": api_unmatched,
            "totalPlayers": len(players["combined"]),
            "summary": api_diff_summary,
            "players": api_diff_rows,
        }
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"Wrote {report_path} — CSV-vs-API discrepancy report for {len(api_diff_rows)} matched players")
    else:
        print(f"2025/26 API stats: no {LAST_SEASON_STATS_PATH.name} found, skipped (run site/fetch_history_past.py)")
    if next_season_meta.get("source"):
        print(
            f"2026/27 squad: {next_season_meta['count']} players across "
            f"{next_season_meta['teams']} teams from {next_season_meta['source']}"
        )
        live = next_season_meta.get("liveAggregates") or {}
        hits = live.get("defConHits") or 0
        print(
            f"2026/27 DefCon: {hits} threshold hit(s) → "
            f"{live.get('playersWithDefCon', 0)} player(s) with DC points "
            f"(GWs {live.get('gameweeks')})"
        )
        for hit in live.get("hitLog") or []:
            print(f"  GW{hit['gw']} element={hit['element']} type={hit['elementType']} "
                  f"venue={hit.get('venue')} threshold={hit.get('threshold')}")
    else:
        print("2026/27 squad: no bootstrap-static snapshot found in snapshots/, skipped")
    if defcon_by_gw:
        print(
            f"DefCon by GW: {', '.join(f'GW{g}={len(m)}' for g, m in sorted(defcon_by_gw.items(), key=lambda x: int(x[0])))}"
        )
    if live_fixtures_by_gw:
        print(
            "Live fixtures by GW: "
            + ", ".join(
                f"GW{g}={len(rows)}"
                for g, rows in sorted(live_fixtures_by_gw.items(), key=lambda x: int(x[0]))
            )
        )
    if price_meta["source"]:
        print(
            f"2026/27 prices: {price_meta['matched']}/{price_meta['totalPlayers']} matched from "
            f"{price_meta['source']} ({price_meta['unmatched']} no longer in the elements list, "
            f"{price_meta['ambiguous']} ambiguous — needs manual resolution in site/price_overrides.json)"
        )
        print(
            f"Display names: {renamed} renamed to FPL web_name "
            f"({price_meta['matched'] - renamed} already matched the API string)"
        )
        if price_issues:
            print("Ambiguous matches needing review:")
            for i in price_issues:
                cand_desc = "; ".join(
                    f"{c['firstName']} {c['secondName']} ({c['team']} {c['position']}, code {c['code']})"
                    for c in i["candidates"]
                )
                print(f"  - {i['name']} ({i['team']} {i['position']}): {cand_desc or i['reason']}")
    else:
        print("2026/27 prices: no bootstrap-static snapshot found in snapshots/, skipped")
    if fixtures_meta.get("source"):
        n_teams = len(fixtures_by_team)
        n_fx = sum(len(v) for v in fixtures_by_team.values()) // 2
        print(
            f"Fixtures: {n_fx} upcoming across {n_teams} teams from {fixtures_meta['source']}"
            f" (prev={fixtures_meta.get('previousGw')!s} curr={fixtures_meta.get('currentGw')!s}"
            f" next={fixtures_meta.get('nextGw')!s} active={fixtures_meta.get('activeGw')!s})"
        )
    else:
        print("Fixtures: no fixtures_*.json snapshot found in snapshots/, skipped")
    if league_positions:
        label = league_positions_meta.get("seasonLabel") or "PL"
        print(f"League table: {len(league_positions)} teams from fixtures ({label})")
    else:
        err = league_positions_meta.get("error") or "unknown error"
        print(f"League table: skipped ({err})")


if __name__ == "__main__":
    main()
