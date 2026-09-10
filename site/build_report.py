#!/usr/bin/env python3
"""
Weekly GW report — gather a context pack, or write site/report_data.js.

  python3 site/build_report.py
  python3 site/build_report.py --manager 296817
  python3 site/build_report.py --bundle snapshots/reports/report_296817_gw3.json

Gather reads site/report_prefs.json (and optional --manager), Home cache,
bootstrap + fixtures snapshots, calendar_data.js, and FPL element-summary
for the focus squad. It does not call an LLM. Fill the pack separately,
then --bundle the structured report JSON.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent
SNAPSHOTS = ROOT / "snapshots"
REPORTS_DIR = SNAPSHOTS / "reports"
PREFS_PATH = SITE / "report_prefs.json"
HOME_JSON = SITE / "home_data.json"
HOME_JS = SITE / "home_data.js"
CALENDAR_JS = SITE / "calendar_data.js"
OUT_JS = SITE / "report_data.js"
FPL_BASE = "https://fantasy.premierleague.com/api"
UA = "Mozilla/5.0 (compatible; FPL-Explorer/1.0; +local-report)"
OUTLOOK_GWS = 5
SUMMARY_RECENT_GWS = 5
FODDER_PRICE = 4.5
CONCURRENCY = 6
TIMEOUT = 20

COMP_LABELS = {
    "fac": "FA Cup",
    "efl": "EFL Cup",
    "ucl": "UEFA Champions League",
    "uel": "UEFA Europa League",
    "uecl": "UEFA Europa Conference League",
}


def generated_at() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_window_js(path: Path, marker: str) -> dict | None:
    if not path.exists():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    if marker not in raw:
        return None
    payload = raw.split(marker, 1)[1].strip().rstrip(";")
    try:
        data = json.loads(payload)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def latest_snapshot(glob_pat: str) -> Path | None:
    candidates = sorted(
        p for p in SNAPSHOTS.glob(glob_pat) if "archived" not in p.stem
    )
    return candidates[-1] if candidates else None


def fpl_get_json(path: str, retries: int = 3) -> dict | list:
    url = f"{FPL_BASE}{path}"
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read().decode("utf-8")
            data = json.loads(raw) if raw else None
            if data is None:
                raise RuntimeError(f"empty payload from {path}")
            return data
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, RuntimeError, json.JSONDecodeError) as exc:
            last_err = exc
            time.sleep(1.2 * (attempt + 1))
    raise RuntimeError(str(last_err) if last_err else path)


def load_home() -> dict:
    if HOME_JSON.exists():
        data = json.loads(HOME_JSON.read_text(encoding="utf-8"))
        if isinstance(data, dict) and data.get("managerId") is not None:
            return data
    parsed = parse_window_js(HOME_JS, "window.FPL_HOME =")
    if parsed:
        return parsed
    raise SystemExit("No home_data.json / home_data.js — run python3 site/fetch_home.py")


def load_prefs() -> list[int]:
    if not PREFS_PATH.exists():
        return [296817]
    cfg = json.loads(PREFS_PATH.read_text(encoding="utf-8"))
    return [int(x) for x in (cfg.get("managers") or [])] or [296817]


def slim_history_row(row: dict) -> dict:
    mins = row.get("minutes")
    try:
        mins_n = int(mins) if mins is not None else 0
    except (TypeError, ValueError):
        mins_n = 0
    band = None
    if mins_n <= 0:
        band = "dnp"
    elif mins_n <= 59:
        band = "short"
    elif mins_n <= 75:
        band = "modest"
    out = {
        "gw": row.get("round"),
        "minutes": mins_n,
        "band": band,
        "points": int(row.get("total_points") or 0),
        "yellow": int(row.get("yellow_cards") or 0),
        "red": int(row.get("red_cards") or 0),
        "starts": int(row.get("starts") or 0),
    }
    return out


def fetch_minutes_history(element_id: int) -> dict:
    data = fpl_get_json(f"/element-summary/{element_id}/")
    history = data.get("history") if isinstance(data, dict) else None
    rows = [slim_history_row(r) for r in (history or []) if isinstance(r, dict)]
    rows.sort(key=lambda r: int(r.get("gw") or 0))
    recent = rows[-SUMMARY_RECENT_GWS:] if rows else []
    short_played = sum(1 for r in recent if r.get("band") == "short")
    modest = sum(1 for r in recent if r.get("band") == "modest")
    return {
        "element": element_id,
        "recent": recent,
        "shortPlayedCount": short_played,
        "modestCount": modest,
        "earlySubPattern": short_played >= 2,
    }


def catalog_from_bootstrap(bootstrap: dict) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for e in bootstrap.get("elements") or []:
        try:
            eid = int(e["id"])
        except (KeyError, TypeError, ValueError):
            continue
        news = (e.get("news") or "").strip() or None
        news_added = e.get("news_added") or None
        xg = float(e.get("expected_goals") or 0)
        xa = float(e.get("expected_assists") or 0)
        xgi = float(e.get("expected_goal_involvements") or 0)
        goals = int(e.get("goals_scored") or 0)
        assists = int(e.get("assists") or 0)
        gi = goals + assists
        try:
            form = float(e.get("form") or 0)
        except (TypeError, ValueError):
            form = 0.0
        try:
            selected = float(e.get("selected_by_percent") or 0)
        except (TypeError, ValueError):
            selected = 0.0
        out[eid] = {
            "element": eid,
            "code": e.get("code"),
            "name": e.get("web_name"),
            "teamId": e.get("team"),
            "elementType": e.get("element_type"),
            "price": (e.get("now_cost") or 0) / 10,
            "form": form,
            "ppg": float(e.get("points_per_game") or 0),
            "pts": int(e.get("total_points") or 0),
            "minutes": int(e.get("minutes") or 0),
            "starts": int(e.get("starts") or 0),
            "goals": goals,
            "assists": assists,
            "gi": gi,
            "xg": round(xg, 2),
            "xa": round(xa, 2),
            "xgi": round(xgi, 2),
            "giMinusXgi": round(gi - xgi, 2),
            "goalsMinusXg": round(goals - xg, 2),
            "selectedBy": selected,
            "availStatus": (e.get("status") or "a").strip().lower() or "a",
            "chanceThis": e.get("chance_of_playing_this_round"),
            "chanceNext": e.get("chance_of_playing_next_round"),
            "news": news,
            "newsAdded": news_added,
            "epThis": e.get("ep_this"),
            "epNext": e.get("ep_next"),
        }
    return out


def team_map(bootstrap: dict) -> dict[int, str]:
    return {int(t["id"]): t["short_name"] for t in bootstrap.get("teams") or [] if t.get("id") is not None}


def upcoming_by_team(fixtures: list, teams: dict[int, str], after_gw: int, n_gws: int) -> dict[str, list]:
    hi = after_gw + n_gws
    by: dict[str, list] = {code: [] for code in teams.values()}
    for f in fixtures or []:
        try:
            gw = int(f.get("event"))
        except (TypeError, ValueError):
            continue
        if gw <= after_gw or gw > hi:
            continue
        if f.get("finished"):
            continue
        home = teams.get(f.get("team_h"))
        away = teams.get(f.get("team_a"))
        if not home or not away:
            continue
        kickoff = f.get("kickoff_time")

        def row(opp: str, ha: str, diff_key: str) -> dict:
            rec = {"gw": gw, "opp": opp, "ha": ha, "kickoff": kickoff}
            raw = f.get(diff_key)
            try:
                d = int(raw)
            except (TypeError, ValueError):
                d = None
            if d is not None and 1 <= d <= 5:
                rec["difficulty"] = d
            return rec

        by[home].append(row(away, "H", "team_h_difficulty"))
        by[away].append(row(home, "A", "team_a_difficulty"))
    for code in by:
        by[code].sort(key=lambda r: (r["gw"], r.get("kickoff") or ""))
    return by


def is_fodder(squad_row: dict, cat: dict | None) -> bool:
    if squad_row.get("starter"):
        return False
    if squad_row.get("isCaptain") or squad_row.get("isVice"):
        return False
    etype = int(squad_row.get("elementType") or (cat or {}).get("elementType") or 0)
    if etype == 1:
        return True
    price = (cat or {}).get("price")
    try:
        p = float(price)
    except (TypeError, ValueError):
        p = None
    if p is not None and p <= FODDER_PRICE:
        return True
    return False


def avg_fdr(rows: list[dict]) -> float | None:
    diffs = [r["difficulty"] for r in rows if isinstance(r.get("difficulty"), int)]
    if not diffs:
        return None
    return round(sum(diffs) / len(diffs), 2)


def midweek_for_team(calendar: dict | None, team: str, after_iso_date: str | None) -> list[dict]:
    if not calendar:
        return []
    rows = (calendar.get("byTeam") or {}).get(team) or []
    out = []
    for ev in rows:
        if not isinstance(ev, dict):
            continue
        if ev.get("provisional"):
            continue
        date = ev.get("date") or (str(ev.get("kickoff") or "")[:10] or None)
        if after_iso_date and date and date < after_iso_date:
            continue
        key = ev.get("competitionKey")
        out.append({
            "date": date,
            "kickoff": ev.get("kickoff"),
            "competitionKey": key,
            "competition": COMP_LABELS.get(key) or key,
            "ha": ev.get("ha"),
            "oppName": ev.get("oppName"),
        })
    out.sort(key=lambda r: (r.get("kickoff") or r.get("date") or ""))
    return out[:8]


def slim_standings(home: dict) -> list[dict]:
    rows = []
    for r in home.get("standings") or []:
        if not isinstance(r, dict):
            continue
        gw_pts = r.get("eventTotalOfficial")
        if gw_pts is None:
            gw_pts = r.get("gwPointsLive")
        rows.append({
            "entry": r.get("entry"),
            "entryName": r.get("entryName"),
            "playerName": r.get("playerName"),
            "gwPoints": gw_pts,
            "total": r.get("total"),
            "rankOfficial": r.get("rankOfficial"),
            "rankLive": r.get("rankLive"),
            "rankPrev": r.get("rankPrev"),
            "overallRank": r.get("overallRank"),
            "activeChip": r.get("activeChip"),
            "benchPoints": r.get("benchPoints") or r.get("benchPointsGw"),
        })
    rows.sort(key=lambda r: (r.get("rankOfficial") or r.get("rankLive") or 9999))
    return rows


def gather_manager(
    manager_id: int,
    home: dict,
    bootstrap: dict,
    fixtures: list,
    calendar: dict | None,
    *,
    skip_summary: bool = False,
) -> dict:
    if int(home.get("managerId") or 0) != int(manager_id):
        raise SystemExit(
            f"Home cache is manager {home.get('managerId')}, not {manager_id}. "
            "Run python3 site/fetch_home.py --manager {manager_id} first."
        )
    source_gw = int(home.get("gw") or 0)
    outlook = list(range(source_gw + 1, source_gw + 1 + OUTLOOK_GWS))
    catalog = catalog_from_bootstrap(bootstrap)
    teams = team_map(bootstrap)
    squad_kickoffs = [str(r.get("kickoff") or "")[:10] for r in (home.get("squad") or []) if r.get("kickoff")]
    after_midweek = min(squad_kickoffs) if squad_kickoffs else None
    for rec in catalog.values():
        rec["team"] = teams.get(rec.get("teamId"))
    fx_by_team = upcoming_by_team(fixtures, teams, source_gw, OUTLOOK_GWS)
    owners = home.get("ownersByElement") or {}
    league_n = max(len(home.get("standings") or []), 1)

    squad_out = []
    focus_ids: list[int] = []
    for row in home.get("squad") or []:
        eid = int(row.get("element") or 0)
        cat = catalog.get(eid) or {}
        fodder = is_fodder(row, cat)
        likely = not fodder
        if likely:
            focus_ids.append(eid)
        team = row.get("team") or cat.get("team")
        owner_entries = owners.get(str(eid)) or owners.get(eid) or []
        league_owned_n = len(owner_entries) if isinstance(owner_entries, list) else 0
        run = fx_by_team.get(team) or []
        squad_out.append({
            "element": eid,
            "code": row.get("code") or cat.get("code"),
            "name": row.get("name") or cat.get("name"),
            "team": team,
            "elementType": row.get("elementType") or cat.get("elementType"),
            "position": row.get("position"),
            "starter": bool(row.get("starter")),
            "onBench": bool(row.get("onBench")),
            "isCaptain": bool(row.get("isCaptain")),
            "isVice": bool(row.get("isVice")),
            "fodder": fodder,
            "likelyStart": likely,
            "price": cat.get("price"),
            "gwPoints": row.get("gwPoints"),
            "basePoints": row.get("basePoints"),
            "minutes": row.get("minutes"),
            "matchStatus": row.get("matchStatus"),
            "autoSubIn": row.get("autoSubIn"),
            "autoSubOut": row.get("autoSubOut"),
            "availStatus": row.get("availStatus") or cat.get("availStatus"),
            "chanceThis": row.get("chanceThis") if row.get("chanceThis") is not None else cat.get("chanceThis"),
            "chanceNext": row.get("chanceNext") if row.get("chanceNext") is not None else cat.get("chanceNext"),
            "news": cat.get("news"),
            "newsAdded": cat.get("newsAdded"),
            "form": cat.get("form"),
            "ppg": cat.get("ppg"),
            "pts": cat.get("pts"),
            "goals": cat.get("goals"),
            "assists": cat.get("assists"),
            "gi": cat.get("gi"),
            "xg": cat.get("xg"),
            "xa": cat.get("xa"),
            "xgi": cat.get("xgi"),
            "giMinusXgi": cat.get("giMinusXgi"),
            "goalsMinusXg": cat.get("goalsMinusXg"),
            "selectedBy": cat.get("selectedBy"),
            "leagueOwnedN": league_owned_n,
            "leagueOwnedPct": round(100.0 * league_owned_n / league_n, 1) if league_n else None,
            "fixtureRun": run,
            "fixtureRunAvgFdr": avg_fdr(run),
            "midweek": midweek_for_team(calendar, team, after_midweek),
        })

    minutes_by_el: dict[int, dict] = {}
    errors: list[str] = []
    if not skip_summary:
        with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
            futures = {pool.submit(fetch_minutes_history, eid): eid for eid in focus_ids}
            for fut in as_completed(futures):
                eid = futures[fut]
                try:
                    minutes_by_el[eid] = fut.result()
                except Exception as exc:  # noqa: BLE001 — pack should still write
                    errors.append(f"element-summary {eid}: {exc}")

    for rec in squad_out:
        hist = minutes_by_el.get(rec["element"])
        if hist:
            rec["minutesHistory"] = hist.get("recent")
            rec["earlySubPattern"] = hist.get("earlySubPattern")
            rec["shortPlayedCount"] = hist.get("shortPlayedCount")

    # Differentials: low TSB and/or low league owned, strong GW or season pts — not fodder.
    # Include both squad exceptions (you already own) and catalog names from standout list.
    standouts = []
    for rec in catalog.values():
        if rec.get("availStatus") not in ("a", "d", "i", "n", "s", "u"):
            pass
        selected = rec.get("selectedBy") or 0
        eid = rec["element"]
        owner_entries = owners.get(str(eid)) or owners.get(eid) or []
        league_n_owned = len(owner_entries) if isinstance(owner_entries, list) else 0
        pts = rec.get("pts") or 0
        form = rec.get("form") or 0
        gw_live = None
        if isinstance(home.get("elementGw"), dict):
            gw_row = home["elementGw"].get(str(eid)) or home["elementGw"].get(eid)
            if isinstance(gw_row, dict):
                gw_live = gw_row.get("total") or gw_row.get("pts") or gw_row.get("points")
        # Thresholds: don't be too sensitive.
        low_owned = selected < 8.0 or league_n_owned <= 2
        hot = (pts >= 18) or (form >= 6.5) or (isinstance(gw_live, (int, float)) and gw_live >= 8)
        if low_owned and hot:
            standouts.append({
                "element": eid,
                "code": rec.get("code"),
                "name": rec.get("name"),
                "team": rec.get("team"),
                "elementType": rec.get("elementType"),
                "price": rec.get("price"),
                "selectedBy": selected,
                "leagueOwnedN": league_n_owned,
                "pts": pts,
                "form": form,
                "gwPointsHint": gw_live,
                "inThisSquad": any(s["element"] == eid for s in squad_out),
            })
    standouts.sort(key=lambda r: (-(r.get("pts") or 0), r.get("selectedBy") or 99))
    standouts = standouts[:18]

    x_flags = []
    form_flags = []
    for rec in squad_out:
        if not rec.get("likelyStart"):
            continue
        gi_gap = rec.get("giMinusXgi")
        if gi_gap is not None and abs(gi_gap) >= 1.5:
            x_flags.append({
                "element": rec["element"],
                "name": rec["name"],
                "code": rec["code"],
                "gi": rec.get("gi"),
                "xgi": rec.get("xgi"),
                "giMinusXgi": gi_gap,
                "goalsMinusXg": rec.get("goalsMinusXg"),
            })
        form = rec.get("form")
        if isinstance(form, (int, float)) and (form >= 7.0 or form <= 2.0):
            form_flags.append({
                "element": rec["element"],
                "name": rec["name"],
                "code": rec["code"],
                "form": form,
                "band": "in" if form >= 7.0 else "out",
            })

    summary = home.get("summary") or {}
    pack = {
        "generatedAt": generated_at(),
        "sourceGw": source_gw,
        "outlookGws": outlook,
        "managerId": manager_id,
        "teamName": summary.get("teamName"),
        "managerName": summary.get("managerName"),
        "leagueId": home.get("leagueId"),
        "leagueName": home.get("leagueName"),
        "homeGeneratedAt": home.get("generatedAt"),
        "bootstrapSource": None,
        "fixturesSource": None,
        "calendarGeneratedAt": (calendar or {}).get("generatedAt"),
        "summary": {
            "gwPoints": summary.get("gwPoints"),
            "eventPointsOfficial": summary.get("eventPointsOfficial"),
            "overallPoints": summary.get("overallPoints"),
            "overallRank": summary.get("overallRank"),
            "overallRankPrev": summary.get("overallRankPrev"),
            "gwRank": summary.get("gwRank"),
            "leagueRank": summary.get("leagueRank"),
            "leagueRankPrev": summary.get("leagueRankPrev"),
            "activeChip": summary.get("activeChip"),
            "totalPlayers": summary.get("totalPlayers"),
        },
        "standings": slim_standings(home),
        "squad": squad_out,
        "formStandouts": form_flags,
        "overUnderStandouts": x_flags,
        "differentialCandidates": standouts,
        "errors": errors,
        "notes": {
            "likelyStartRule": "starters plus non-fodder bench; backup GK and benched ≤£4.5m are fodder",
            "xPts": "2026/27 has no Hub xPts; use xGI/xG/xA vs actual",
            "doNotInvent": "injuries, fixtures, points, ownership",
            "essentialHolds": "Haaland (and similar premium captains) are never transfer-out recommendations",
        },
    }
    return pack


def write_js(payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    OUT_JS.write_text(f"window.FPL_REPORT = {body};\n", encoding="utf-8")
    print(f"Wrote {OUT_JS} ({OUT_JS.stat().st_size:,} bytes)")


def validate_report_payload(payload: dict) -> None:
    if not isinstance(payload, dict) or "reports" not in payload:
        raise SystemExit("bundle JSON must be { generatedAt, sourceGw, outlookGws, reports }")
    reports = payload.get("reports")
    if not isinstance(reports, dict) or not reports:
        raise SystemExit("reports must be a non-empty object keyed by manager id")
    for key, report in reports.items():
        if not isinstance(report, dict):
            raise SystemExit(f"report {key} is not an object")
        sections = report.get("sections")
        if not isinstance(sections, list) or len(sections) < 1:
            raise SystemExit(f"report {key} needs sections[]")


def main() -> None:
    parser = argparse.ArgumentParser(description="Gather weekly report context or write report_data.js")
    parser.add_argument("--manager", type=int, help="Single manager id (default: report_prefs.json)")
    parser.add_argument("--bundle", type=Path, help="Write site/report_data.js from a filled report JSON")
    parser.add_argument("--skip-summary", action="store_true", help="Do not fetch element-summary (minutes)")
    args = parser.parse_args()

    if args.bundle:
        path = args.bundle
        payload = json.loads(path.read_text(encoding="utf-8"))
        validate_report_payload(payload)
        if not payload.get("generatedAt"):
            payload["generatedAt"] = generated_at()
        write_js(payload)
        return

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    managers = [args.manager] if args.manager else load_prefs()
    home = load_home()
    bs_path = latest_snapshot("bootstrap-static_*.json")
    fx_path = latest_snapshot("fixtures_*.json")
    if not bs_path or not fx_path:
        raise SystemExit("Need snapshots/bootstrap-static_*.json and snapshots/fixtures_*.json")
    bootstrap = json.loads(bs_path.read_text(encoding="utf-8"))
    fixtures = json.loads(fx_path.read_text(encoding="utf-8"))
    calendar = parse_window_js(CALENDAR_JS, "window.FPL_CALENDAR =")

    for mid in managers:
        pack = gather_manager(
            mid, home, bootstrap, fixtures, calendar, skip_summary=args.skip_summary
        )
        pack["bootstrapSource"] = bs_path.name
        pack["fixturesSource"] = fx_path.name
        gw = pack["sourceGw"]
        out = REPORTS_DIR / f"context_{mid}_gw{gw}.json"
        out.write_text(json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote {out} (squad {len(pack['squad'])}, errors {len(pack.get('errors') or [])})")
        for err in pack.get("errors") or []:
            print(f"  warn: {err}", file=sys.stderr)


if __name__ == "__main__":
    main()
