#!/usr/bin/env python3
"""
Fetch non-PL club fixtures (cups / Europe) from The Odds API /events into
site/calendar_data.js, plus curated soft windows (FIFA intl breaks + cup
round date ranges) for All-mode ghost markers.

/events does not consume Odds API quota. Near-term bookmaker listings only —
enough to surface Prem sides' cup/Europe matchups as they appear. Prior rows
are merged so fixtures don't vanish the moment books delist a finished round.

Setup:
  ODDS_API_KEY in project-root .env (same key as Markets)

Run:
  python3 site/fetch_calendar.py
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent
ENV_PATH = ROOT / ".env"
OUT_PATH = SITE / "calendar_data.js"
SNAPSHOT_DIR = ROOT / "snapshots" / "calendar"
API_BASE = "https://api.the-odds-api.com/v4"

# Keep finished / delisted cup rows on the calendar for a bit.
KEEP_PAST_DAYS = 21

# Public CDN logos (no API key). Used as competition badges in All mode.
COMPETITIONS = (
    {
        "sport": "soccer_fa_cup",
        "key": "fac",
        "name": "FA Cup",
        "logo": "https://media.api-sports.io/football/leagues/45.png",
    },
    {
        "sport": "soccer_england_efl_cup",
        "key": "efl",
        "name": "EFL Cup",
        "logo": "https://media.api-sports.io/football/leagues/48.png",
    },
    {
        "sport": "soccer_uefa_champs_league",
        "key": "ucl",
        "name": "UEFA Champions League",
        "logo": "https://media.api-sports.io/football/leagues/2.png",
    },
    {
        "sport": "soccer_uefa_europa_league",
        "key": "uel",
        "name": "UEFA Europa League",
        "logo": "https://media.api-sports.io/football/leagues/3.png",
    },
    {
        "sport": "soccer_uefa_europa_conference_league",
        "key": "uecl",
        "name": "UEFA Europa Conference League",
        "logo": "https://media.api-sports.io/football/leagues/848.png",
    },
)

# Odds / Markets name aliases → FPL short codes (shared with fetch_markets.py).
TEAM_NAME_TO_CODE = {
    "arsenal": "ARS",
    "aston villa": "AVL",
    "afc bournemouth": "BOU",
    "bournemouth": "BOU",
    "brentford": "BRE",
    "brighton and hove albion": "BHA",
    "brighton & hove albion": "BHA",
    "brighton": "BHA",
    "chelsea": "CHE",
    "crystal palace": "CRY",
    "everton": "EVE",
    "fulham": "FUL",
    "ipswich town": "IPS",
    "ipswich": "IPS",
    "leeds united": "LEE",
    "leeds": "LEE",
    "liverpool": "LIV",
    "manchester city": "MCI",
    "man city": "MCI",
    "manchester united": "MUN",
    "man united": "MUN",
    "man utd": "MUN",
    "newcastle united": "NEW",
    "newcastle": "NEW",
    "nottingham forest": "NFO",
    "nott'm forest": "NFO",
    "nottm forest": "NFO",
    "sunderland": "SUN",
    "tottenham hotspur": "TOT",
    "tottenham": "TOT",
    "spurs": "TOT",
    "west ham united": "WHU",
    "west ham": "WHU",
    "wolverhampton wanderers": "WOL",
    "wolves": "WOL",
    "burnley": "BUR",
    "leicester city": "LEI",
    "leicester": "LEI",
    "southampton": "SOU",
    "sheffield united": "SHU",
    "sheffield utd": "SHU",
    "coventry city": "COV",
    "coventry": "COV",
    "hull city": "HUL",
    "hull": "HUL",
}

# FIFA Men's International Match Calendar 2026/27 (club-release windows).
# Soft bands only — not kickoffs. Source: FIFA calendar 2023–2030.
INTL_WINDOWS_BY_SEASON = {
    2026: [
        {
            "start": "2026-09-21",
            "end": "2026-10-06",
            "label": "International break",
            "note": "FIFA window (16 days · up to 4 matches)",
        },
        {
            "start": "2026-11-09",
            "end": "2026-11-17",
            "label": "International break",
            "note": "FIFA window",
        },
        {
            "start": "2027-03-22",
            "end": "2027-03-30",
            "label": "International break",
            "note": "FIFA window",
        },
    ],
}

# Soft cup / Europe round windows (Wikipedia / UEFA calendars). Dates TBC —
# UI shows muted ghost badges; Odds /events replace them when listed.
ROUND_WINDOWS_BY_SEASON = {
    2026: [
        {
            "competitionKey": "efl",
            "start": "2026-10-27",
            "end": "2026-10-29",
            "label": "EFL Cup R4",
            "note": "Round window · dates TBC",
        },
        {
            "competitionKey": "ucl",
            "start": "2026-10-21",
            "end": "2026-10-23",
            "label": "UCL MD3",
            "note": "League-phase window · dates TBC",
        },
        {
            "competitionKey": "uel",
            "start": "2026-10-22",
            "end": "2026-10-24",
            "label": "UEL MD3",
            "note": "League-phase window · dates TBC",
        },
        {
            "competitionKey": "uecl",
            "start": "2026-10-22",
            "end": "2026-10-24",
            "label": "UECL MD3",
            "note": "League-phase window · dates TBC",
        },
        {
            "competitionKey": "efl",
            "start": "2026-12-15",
            "end": "2026-12-17",
            "label": "EFL Cup QF",
            "note": "Round window · dates TBC",
        },
        {
            "competitionKey": "fac",
            "start": "2027-01-09",
            "end": "2027-01-12",
            "label": "FA Cup R3",
            "note": "Prem enter · dates TBC",
        },
    ],
}


def curated_intl_windows(season: int) -> list[dict]:
    return [dict(w) for w in (INTL_WINDOWS_BY_SEASON.get(season) or [])]


def curated_round_windows(season: int) -> list[dict]:
    logo_by_key = {c["key"]: c["logo"] for c in COMPETITIONS}
    out = []
    for w in ROUND_WINDOWS_BY_SEASON.get(season) or []:
        row = dict(w)
        row["logo"] = logo_by_key.get(row.get("competitionKey"))
        out.append(row)
    return out


def load_dotenv(path: Path = ENV_PATH) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv()


def team_code(name: str) -> str | None:
    key = " ".join((name or "").strip().lower().split())
    if key in TEAM_NAME_TO_CODE:
        return TEAM_NAME_TO_CODE[key]
    for alias, code in TEAM_NAME_TO_CODE.items():
        if alias in key or key in alias:
            return code
    return None


def season_start_year(now: datetime | None = None) -> int:
    dt = now or datetime.now(timezone.utc)
    return dt.year if dt.month >= 7 else dt.year - 1


def parse_iso_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def events_url(sport: str, api_key: str) -> str:
    qs = urllib.parse.urlencode({"apiKey": api_key})
    return f"{API_BASE}/sports/{sport}/events?{qs}"


def api_get_events(sport: str, api_key: str) -> tuple[list, dict[str, str]]:
    req = urllib.request.Request(
        events_url(sport, api_key),
        headers={"User-Agent": "FPL-Explorer/1.0"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        headers = {k.lower(): v for k, v in resp.headers.items()}
        body = resp.read().decode("utf-8")
    data = json.loads(body)
    if not isinstance(data, list):
        return [], headers
    return data, headers


def event_row_key(code: str, row: dict) -> str:
    eid = row.get("eventId") or ""
    if eid:
        return f"{code}|{eid}|{row.get('ha') or ''}"
    return "|".join(
        [
            code,
            str(row.get("date") or ""),
            str(row.get("competitionKey") or ""),
            str(row.get("ha") or ""),
            str(row.get("kickoff") or ""),
        ]
    )


def load_previous_by_team() -> dict[str, list[dict]]:
    if not OUT_PATH.is_file():
        return {}
    text = OUT_PATH.read_text(encoding="utf-8")
    m = re.search(r"window\.FPL_CALENDAR\s*=\s*(\{.*\})\s*;?\s*$", text, re.S)
    if not m:
        return {}
    try:
        prev = json.loads(m.group(1))
    except json.JSONDecodeError:
        return {}
    by_team = prev.get("byTeam") or {}
    if not isinstance(by_team, dict):
        return {}
    out: dict[str, list[dict]] = {}
    for code, rows in by_team.items():
        if isinstance(rows, list):
            out[str(code)] = [r for r in rows if isinstance(r, dict)]
    return out


def prune_and_merge(
    previous: dict[str, list[dict]],
    fresh: dict[str, list[dict]],
    *,
    today: date,
) -> dict[str, list[dict]]:
    cutoff = today - timedelta(days=KEEP_PAST_DAYS)
    merged: dict[str, dict[str, dict]] = {}

    def ingest(src: dict[str, list[dict]], *, prefer_fresh: bool) -> None:
        for code, rows in src.items():
            bucket = merged.setdefault(code, {})
            for row in rows:
                day = parse_iso_date(row.get("date"))
                if day is None or day < cutoff:
                    continue
                key = event_row_key(code, row)
                if prefer_fresh or key not in bucket:
                    bucket[key] = row

    ingest(previous, prefer_fresh=False)
    ingest(fresh, prefer_fresh=True)

    out: dict[str, list[dict]] = {}
    for code, by_key in merged.items():
        rows = list(by_key.values())
        rows.sort(key=lambda r: (r.get("date") or "", r.get("kickoff") or "", r.get("competitionKey") or ""))
        if rows:
            out[code] = rows
    return out


def write_bundle(payload: dict) -> None:
    text = "window.FPL_CALENDAR = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    OUT_PATH.write_text(text, encoding="utf-8")
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ")
    (SNAPSHOT_DIR / f"calendar_{stamp}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def empty_payload(season: int, reason: str) -> dict:
    return {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "meta": {
            "season": season,
            "source": "the-odds-api",
            "endpoint": "events",
            "error": reason,
            "requestsRemaining": None,
        },
        "competitions": [
            {"key": c["key"], "name": c["name"], "logo": c["logo"], "sport": c["sport"]}
            for c in COMPETITIONS
        ],
        "byTeam": {},
        "intlWindows": curated_intl_windows(season),
        "roundWindows": curated_round_windows(season),
    }


def main() -> int:
    api_key = os.environ.get("ODDS_API_KEY", "").strip()
    season = season_start_year()
    today = datetime.now(timezone.utc).date()
    if not api_key:
        print(
            "No ODDS_API_KEY in .env — writing empty calendar bundle.\n"
            "  ODDS_API_KEY=your_key_here\n"
            f"to {ENV_PATH}",
            file=sys.stderr,
        )
        write_bundle(empty_payload(season, "missing_api_key"))
        return 0

    remaining = None
    fresh: dict[str, list[dict]] = {}
    competitions_out: list[dict] = []
    unmapped: list[str] = []

    for comp in COMPETITIONS:
        try:
            events, headers = api_get_events(comp["sport"], api_key)
            remaining = headers.get("x-requests-remaining") or remaining
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")[:300]
            print(f"HTTP {e.code} {comp['sport']}: {body}", file=sys.stderr)
            competitions_out.append(
                {
                    "key": comp["key"],
                    "name": comp["name"],
                    "logo": comp["logo"],
                    "sport": comp["sport"],
                }
            )
            continue
        except urllib.error.URLError as e:
            print(f"{comp['sport']} failed: {e}", file=sys.stderr)
            competitions_out.append(
                {
                    "key": comp["key"],
                    "name": comp["name"],
                    "logo": comp["logo"],
                    "sport": comp["sport"],
                }
            )
            continue

        kept = 0
        for ev in events:
            kickoff = ev.get("commence_time")
            day = str(kickoff)[:10] if kickoff else None
            if not day:
                continue
            home_name = ev.get("home_team") or ""
            away_name = ev.get("away_team") or ""
            home_code = team_code(home_name)
            away_code = team_code(away_name)
            if not home_code and not away_code:
                for name in (home_name, away_name):
                    if name and name not in unmapped:
                        unmapped.append(name)
                continue
            eid = ev.get("id")
            for code, opp, ha in (
                (home_code, away_name or None, "H"),
                (away_code, home_name or None, "A"),
            ):
                if not code:
                    continue
                row = {
                    "date": day,
                    "kickoff": kickoff,
                    "competitionKey": comp["key"],
                    "ha": ha,
                    "logo": comp["logo"],
                    "eventId": eid,
                }
                if opp:
                    row["oppName"] = opp
                fresh.setdefault(code, []).append(row)
                kept += 1

        competitions_out.append(
            {
                "key": comp["key"],
                "name": comp["name"],
                "logo": comp["logo"],
                "sport": comp["sport"],
            }
        )
        print(f"  {comp['key']}: {kept} PL-side rows from {len(events)} events")

    previous = load_previous_by_team()
    by_team = prune_and_merge(previous, fresh, today=today)
    prev_n = sum(len(v) for v in previous.values())
    fresh_n = sum(len(v) for v in fresh.values())
    merged_n = sum(len(v) for v in by_team.values())

    if unmapped:
        sample = ", ".join(unmapped[:8])
        more = f" (+{len(unmapped) - 8} more)" if len(unmapped) > 8 else ""
        print(f"  unmapped non-PL names (ok): {sample}{more}")

    payload = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "meta": {
            "season": season,
            "source": "the-odds-api",
            "endpoint": "events",
            "quotaCost": 0,
            "sports": [c["sport"] for c in COMPETITIONS],
            "requestsRemaining": remaining,
            "freshRows": fresh_n,
            "previousRows": prev_n,
            "mergedRows": merged_n,
            "plTeamsWithCups": len(by_team),
            "keepPastDays": KEEP_PAST_DAYS,
        },
        "competitions": competitions_out,
        "byTeam": by_team,
        "intlWindows": curated_intl_windows(season),
        "roundWindows": curated_round_windows(season),
    }
    write_bundle(payload)
    print(f"Wrote {OUT_PATH} (teams={len(by_team)} rows={merged_n} remaining={remaining})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
