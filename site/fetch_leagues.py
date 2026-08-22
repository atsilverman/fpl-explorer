#!/usr/bin/env python3
"""
Tracked FPL managers + classic leagues → site/leagues_data.js.

Reads site/tracked_ids.json, fetches entry + standings from the FPL API,
and writes a slim cache for Preferences dropdowns (and later league UI).

Run:
    python3 site/fetch_leagues.py
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent
CONFIG_PATH = SITE / "tracked_ids.json"
OUT_PATH = SITE / "leagues_data.js"
FPL_BASE = "https://fantasy.premierleague.com/api"
UA = "fpl-explorer/1.0 (+leagues-tracking)"


def generated_at() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fpl_get(path: str) -> dict:
    url = f"{FPL_BASE}{path}"
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        raw = resp.read().decode("utf-8")
    data = json.loads(raw) if raw else None
    if not isinstance(data, dict):
        raise RuntimeError(f"unexpected payload from {path}")
    return data


def load_config() -> tuple[list[int], list[int]]:
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    leagues = [int(x) for x in (cfg.get("leagues") or [])]
    managers = [int(x) for x in (cfg.get("managers") or [])]
    if not leagues and not managers:
        raise RuntimeError(f"{CONFIG_PATH.name} has no leagues or managers")
    return leagues, managers


def slim_manager(
    entry_id: int, entry: dict, tracked_league_ids: list[int]
) -> dict:
    classic = (entry.get("leagues") or {}).get("classic") or []
    member_ids = set()
    for row in classic:
        try:
            lid = int(row.get("id"))
        except (TypeError, ValueError):
            continue
        if lid in tracked_league_ids:
            member_ids.add(lid)
    # Keep tracked_ids.json order for stable dropdowns.
    league_ids = [lid for lid in tracked_league_ids if lid in member_ids]
    first = (entry.get("player_first_name") or "").strip()
    last = (entry.get("player_last_name") or "").strip()
    name = " ".join(p for p in (first, last) if p) or f"Manager {entry_id}"
    return {
        "id": entry_id,
        "name": name,
        "teamName": entry.get("name") or "",
        "leagueIds": league_ids,
    }


def slim_league(league_id: int, payload: dict) -> dict:
    league = payload.get("league") or {}
    results = (payload.get("standings") or {}).get("results") or []
    standings = []
    for row in results:
        try:
            entry = int(row.get("entry"))
        except (TypeError, ValueError):
            continue
        standings.append(
            {
                "entry": entry,
                "rank": row.get("rank"),
                "playerName": row.get("player_name") or "",
                "entryName": row.get("entry_name") or "",
                "total": row.get("total"),
            }
        )
    return {
        "id": league_id,
        "name": league.get("name") or f"League {league_id}",
        "standings": standings,
    }


def write_leagues_js(payload: dict) -> None:
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    OUT_PATH.write_text(f"window.FPL_LEAGUES = {body};\n", encoding="utf-8")


def main() -> int:
    try:
        league_ids, manager_ids = load_config()
    except (OSError, json.JSONDecodeError, RuntimeError, TypeError, ValueError) as exc:
        print(f"Config error: {exc}", file=sys.stderr)
        return 1

    tracked_league_list = list(league_ids)
    managers: list[dict] = []
    leagues: list[dict] = []
    errors: list[str] = []

    for mid in manager_ids:
        try:
            print(f"Fetching entry/{mid}/")
            entry = fpl_get(f"/entry/{mid}/")
            managers.append(slim_manager(mid, entry, tracked_league_list))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, RuntimeError) as exc:
            errors.append(f"manager {mid}: {exc}")
            print(f"  failed: {exc}", file=sys.stderr)

    for lid in league_ids:
        try:
            print(f"Fetching leagues-classic/{lid}/standings/")
            payload = fpl_get(f"/leagues-classic/{lid}/standings/")
            leagues.append(slim_league(lid, payload))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError, RuntimeError) as exc:
            errors.append(f"league {lid}: {exc}")
            print(f"  failed: {exc}", file=sys.stderr)

    if not managers and not leagues:
        print("No managers or leagues fetched.", file=sys.stderr)
        return 1

    # Stable order matching config
    managers.sort(key=lambda m: manager_ids.index(m["id"]) if m["id"] in manager_ids else 999)
    leagues.sort(key=lambda L: league_ids.index(L["id"]) if L["id"] in league_ids else 999)

    payload = {
        "generatedAt": generated_at(),
        "managers": managers,
        "leagues": leagues,
    }
    write_leagues_js(payload)

    bits = [f"{len(managers)} managers", f"{len(leagues)} leagues"]
    for m in managers:
        lids = ",".join(str(x) for x in m["leagueIds"]) or "—"
        bits.append(f"{m['id']}→[{lids}]")
    print(f"Wrote {OUT_PATH.relative_to(ROOT)}: {'; '.join(bits)}")
    if errors:
        print(f"{len(errors)} fetch error(s).", file=sys.stderr)
        return 1 if not managers else 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
