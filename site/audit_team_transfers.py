#!/usr/bin/env python3
"""Audit FPL team assignments vs OPTA CSV baseline and live bootstrap.

Compares three layers:
  1. OPTA CSV team (2025/26 export — fixed at setup)
  2. Cached bootstrap snapshot (what build.py last used)
  3. Live FPL bootstrap-static (authoritative for 2026/27)

Also reads site/data.js nextSeasonPlayers + 2025/26 newTeam overlay when present.

Usage:
    python3 site/audit_team_transfers.py
    python3 site/audit_team_transfers.py --write reports/team_transfer_audit.json
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = Path(__file__).resolve().parent
SNAPSHOTS = ROOT / "snapshots"
REPORTS = ROOT / "reports"
DATA_JS = SITE / "data.js"
FPL_BOOTSTRAP = "https://fantasy.premierleague.com/api/bootstrap-static/"

sys.path.insert(0, str(SITE))
from build import (  # noqa: E402
    latest_bootstrap_snapshot,
    load_players,
    match_new_season_prices,
    merge_players,
)

PLAYER_H = ROOT / "FPL Data - Player Key Stats (H).csv"
PLAYER_A = ROOT / "FPL Data - Player Key Stats (A).csv"


def fetch_live_bootstrap() -> dict:
    req = urllib.request.Request(FPL_BOOTSTRAP, headers={"User-Agent": "fpl-explorer/audit"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def elem_maps(bootstrap: dict) -> tuple[dict[int, str], dict[int, tuple[str, str, int]]]:
    teams = {int(t["id"]): t["short_name"] for t in bootstrap.get("teams") or []}
    by_code: dict[int, tuple[str, str, int]] = {}
    for e in bootstrap.get("elements") or []:
        code = int(e["code"])
        by_code[code] = (e["web_name"], teams[int(e["team"])], int(e["id"]))
    return teams, by_code


def load_data_js() -> dict | None:
    if not DATA_JS.exists():
        return None
    text = DATA_JS.read_text(encoding="utf-8").strip()
    if "window.FPL_DATA = " not in text:
        return None
    raw = text.split("window.FPL_DATA = ", 1)[1].strip().rstrip(";")
    return json.loads(raw)


def site_team_by_code(data: dict) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for split in ("combined", "home", "away"):
        for p in (data.get("players") or {}).get(split) or []:
            code = p.get("code")
            if code is None:
                continue
            out[int(code)] = {
                "name": p.get("name"),
                "csvTeam": p.get("team"),
                "newTeam": p.get("newTeam"),
                "effective": p.get("newTeam") or p.get("team"),
                "source": f"players.{split}",
            }
    for p in (data.get("nextSeasonPlayers") or {}).get("combined") or []:
        code = p.get("code")
        if code is None:
            continue
        out[int(code)] = {
            "name": p.get("name"),
            "csvTeam": None,
            "newTeam": p.get("team"),
            "effective": p.get("team"),
            "source": "nextSeasonPlayers.combined",
        }
    return out


def run_audit(*, fetch_live: bool = True) -> dict:
    ph = load_players(PLAYER_H)
    pa = load_players(PLAYER_A)
    players = merge_players(ph, pa)
    combined = players["combined"]
    match_results, issues, match_meta = match_new_season_prices(combined)

    snap_path = latest_bootstrap_snapshot()
    cached = json.loads(snap_path.read_text(encoding="utf-8")) if snap_path else {}
    _, cached_by_code = elem_maps(cached) if cached else ({}, {})

    live_error = None
    live_by_code: dict[int, tuple[str, str, int]] = {}
    live_source = None
    if fetch_live:
        try:
            live = fetch_live_bootstrap()
            _, live_by_code = elem_maps(live)
            live_source = "live FPL API"
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            live_error = str(exc)

    data = load_data_js()
    site_by_code = site_team_by_code(data) if data else {}

    csv_to_bootstrap: list[dict] = []
    stale_cache: list[dict] = []
    site_mismatch: list[dict] = []

    for p in combined:
        pid = p["id"]
        if pid not in match_results:
            continue
        m = match_results[pid]
        code = m.get("code")
        if code is None:
            continue
        code = int(code)
        csv_team = p["team"]
        bootstrap_team = m.get("newTeam")
        cached_team = cached_by_code.get(code, (None, None, None))[1]
        live_team = live_by_code.get(code, (None, None, None))[1]
        site = site_by_code.get(code)

        if csv_team != bootstrap_team:
            row = {
                "name": p["name"],
                "code": code,
                "csvTeam": csv_team,
                "bootstrapTeam": bootstrap_team,
                "cachedBootstrapTeam": cached_team,
                "liveTeam": live_team,
                "matchStatus": m.get("status"),
            }
            csv_to_bootstrap.append(row)
            if cached_team and live_team and cached_team != live_team:
                stale_cache.append({**row, "kind": "cache_behind_live"})
        if site and live_team and site.get("effective") != live_team:
            site_mismatch.append({
                "name": site.get("name") or p["name"],
                "code": code,
                "siteTeam": site.get("effective"),
                "siteSource": site.get("source"),
                "liveTeam": live_team,
                "bootstrapTeam": bootstrap_team,
            })

    return {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "csvSource": [PLAYER_H.name, PLAYER_A.name],
        "cachedBootstrap": snap_path.name if snap_path else None,
        "liveSource": live_source,
        "liveFetchError": live_error,
        "dataJsGeneratedAt": (data or {}).get("generatedAt"),
        "matchMeta": match_meta,
        "ambiguousIssues": issues,
        "summary": {
            "csvPlayers": len(combined),
            "matchedToBootstrap": len(match_results),
            "transfersSinceCsv": len(csv_to_bootstrap),
            "staleInCachedBootstrap": len(stale_cache),
            "siteVsLiveMismatch": len(site_mismatch),
        },
        "transfersSinceCsv": sorted(csv_to_bootstrap, key=lambda r: r["name"]),
        "staleInCachedBootstrap": sorted(stale_cache, key=lambda r: r["name"]),
        "siteVsLiveMismatch": sorted(site_mismatch, key=lambda r: r["name"]),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit FPL team transfers vs CSV baseline.")
    parser.add_argument(
        "--write",
        type=Path,
        default=REPORTS / "team_transfer_audit.json",
        help="Write JSON report (default: reports/team_transfer_audit.json)",
    )
    parser.add_argument("--no-live", action="store_true", help="Skip live FPL fetch")
    args = parser.parse_args()

    report = run_audit(fetch_live=not args.no_live)
    s = report["summary"]

    print(f"CSV players: {s['csvPlayers']}")
    print(f"Matched to bootstrap ({report['cachedBootstrap']}): {s['matchedToBootstrap']}")
    print(f"Transfers since CSV (csv team != bootstrap): {s['transfersSinceCsv']}")
    print(f"Stale in cached bootstrap (cache != live FPL): {s['staleInCachedBootstrap']}")
    print(f"Site data.js vs live FPL: {s['siteVsLiveMismatch']}")
    if report.get("liveFetchError"):
        print(f"Live fetch error: {report['liveFetchError']}", file=sys.stderr)

    if report["staleInCachedBootstrap"]:
        print("\nStale cached bootstrap (refresh ownership + rebuild):")
        for row in report["staleInCachedBootstrap"]:
            print(
                f"  {row['name']} ({row['code']}): "
                f"cached {row['cachedBootstrapTeam']} -> live {row['liveTeam']}"
            )

    if report["siteVsLiveMismatch"]:
        print("\nSite data.js mismatches (run build.py after fresh bootstrap):")
        for row in report["siteVsLiveMismatch"]:
            print(
                f"  {row['name']} ({row['code']}): "
                f"site {row['siteTeam']} vs live {row['liveTeam']}"
            )

    if args.write:
        args.write.parent.mkdir(parents=True, exist_ok=True)
        args.write.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\nWrote {args.write.relative_to(ROOT)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
