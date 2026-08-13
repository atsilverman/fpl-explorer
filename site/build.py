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
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(__file__).resolve().parent / "data.js"
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


def build_next_season_squad():
    """Full 2026/27 FPL elements list (all 20 clubs, including promoted) for
    the site's next-season zero-stat view. Relegated clubs are simply absent
    from bootstrap — no OPTA survivors from BUR/WHU/WOL are added here.
    """
    snap_path = latest_bootstrap_snapshot()
    if snap_path is None:
        return [], {}, {"source": None, "count": 0}

    snap = json.loads(snap_path.read_text(encoding="utf-8"))
    teams_by_id = {t["id"]: t["short_name"] for t in snap["teams"]}
    team_names = {t["short_name"]: t["name"] for t in snap["teams"]}
    postype_by_id = {e["id"]: e["singular_name_short"] for e in snap["element_types"]}

    players = []
    for e in snap["elements"]:
        team = teams_by_id.get(e["team"])
        if not team:
            continue
        pos_raw = postype_by_id.get(e["element_type"], "")
        pos = FPL_POS_MAP.get(pos_raw, pos_raw)
        players.append({
            "id": f"fpl-{e['code']}",
            "name": e["web_name"],
            "team": team,
            "position": pos,
            "price": e["now_cost"] / 10,
            "code": e["code"],
            "penaltiesOrder": e.get("penalties_order"),
            "directFreekicksOrder": e.get("direct_freekicks_order"),
            "cornersOrder": e.get("corners_and_indirect_freekicks_order"),
        })

    players.sort(key=lambda p: (p["team"], POSITIONS.index(p["position"]) if p["position"] in POSITIONS else 99, p["name"]))
    meta = {"source": snap_path.name, "count": len(players), "teams": len(team_names)}
    return players, team_names, meta


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

    events = bootstrap.get("events") or []
    current_gw = next((e.get("id") for e in events if e.get("is_current")), None)
    if current_gw is None:
        current_gw = next((e.get("id") for e in events if e.get("is_next")), None)
    if current_gw is None:
        gws = [fx["gw"] for rows in by_team.values() for fx in rows if fx.get("gw") is not None]
        current_gw = min(gws) if gws else 1

    meta = {
        "source": fx_path.name,
        "bootstrap": bs_path.name,
        "currentGw": current_gw,
    }
    return by_team, team_names, meta


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
    next_season_players, next_season_team_names, next_season_meta = build_next_season_squad()
    league_positions, league_positions_meta = fetch_league_positions(2025)

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
        "newSeasonPriceMeta": price_meta,
        "priceMatchIssues": price_issues,
        "lastSeasonApiMeta": last_season_api_meta,
        "nextSeasonPlayers": next_season_players,
        "nextSeasonTeamNames": next_season_team_names,
        "nextSeasonMeta": next_season_meta,
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
    else:
        print("2026/27 squad: no bootstrap-static snapshot found in snapshots/, skipped")
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
        print(f"Fixtures: {n_fx} upcoming across {n_teams} teams from {fixtures_meta['source']}")
    else:
        print("Fixtures: no fixtures_*.json snapshot found in snapshots/, skipped")
    if league_positions:
        label = league_positions_meta.get("seasonLabel") or "PL"
        print(f"League table: {len(league_positions)} teams from ESPN ({label})")
    else:
        err = league_positions_meta.get("error") or "unknown error"
        print(f"League table: skipped ({err})")


if __name__ == "__main__":
    main()
