#!/usr/bin/env python3
"""
One-off (re-runnable) fetch of last season's per-player totals straight from
the live FPL API, to cross-check/replace our CSV-sourced stats.

FPL wipes match-level history at season rollover, but
GET /element-summary/{id}/ still returns a `history_past` array with one row
per prior season (season totals only), keyed by `element_code` — the stable
identifier that survives squad reshuffles (see FPL_API_AUDIT_2026-07-23.md
§9). Querying with *this* season's id works fine; the API resolves history
for the underlying player regardless of which season's id you use.

Run:
    python3 site/fetch_history_past.py

Writes snapshots/history_past_2025-26.json:
    {"<element_code>": {<history_past row for 2025/26>, "web_name": ...}}

Only elements present in the newest bootstrap-static snapshot are queried
(~700 players). Runs a small thread pool against the public API — polite
concurrency, not a hammer.
"""
import json
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOTS_DIR = ROOT / "snapshots"
OUT_PATH = SNAPSHOTS_DIR / "history_past_2025-26.json"
SEASON = "2025/26"
CONCURRENCY = 8
TIMEOUT = 15


def latest_bootstrap_snapshot():
    candidates = sorted(
        p for p in SNAPSHOTS_DIR.glob("bootstrap-static_*.json") if "archived" not in p.stem
    )
    if not candidates:
        raise SystemExit("No bootstrap-static_*.json snapshot found in snapshots/ — fetch one first.")
    return candidates[-1]


def fetch_json(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "fpl-site-build/1.0"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return json.load(resp)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            if attempt == retries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))


def fetch_one(element_id, code, web_name):
    data = fetch_json(f"https://fantasy.premierleague.com/api/element-summary/{element_id}/")
    row = next((r for r in data.get("history_past", []) if r.get("season_name") == SEASON), None)
    return code, web_name, row


def main():
    snap_path = latest_bootstrap_snapshot()
    snap = json.loads(snap_path.read_text(encoding="utf-8"))
    elements = snap["elements"]
    print(f"Fetching {SEASON} history_past for {len(elements)} elements from {snap_path.name}...")

    results = {}
    missing = []
    errors = []

    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = {
            pool.submit(fetch_one, e["id"], e["code"], e["web_name"]): e
            for e in elements
        }
        done = 0
        for fut in as_completed(futures):
            e = futures[fut]
            done += 1
            try:
                code, web_name, row = fut.result()
            except Exception as exc:
                errors.append({"code": e["code"], "web_name": e["web_name"], "error": str(exc)})
                continue
            if row is None:
                missing.append({"code": code, "web_name": web_name})
                continue
            row = dict(row)
            row["web_name"] = web_name
            results[str(code)] = row
            if done % 100 == 0:
                print(f"  ...{done}/{len(elements)}")

    OUT_PATH.write_text(json.dumps(results, indent=1), encoding="utf-8")
    print(f"Wrote {OUT_PATH} — {len(results)} players with a {SEASON} history_past row")
    print(f"  {len(missing)} elements had no {SEASON} row (new to the league, e.g. promoted-club signings)")
    print(f"  {len(errors)} elements failed to fetch")
    if errors:
        for e in errors[:10]:
            print(f"    - {e['web_name']} (code {e['code']}): {e['error']}")


if __name__ == "__main__":
    main()
