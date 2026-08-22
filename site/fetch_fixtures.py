#!/usr/bin/env python3
"""Fetch FPL fixtures snapshot → snapshots/fixtures_YYYY-MM-DD.json."""
from __future__ import annotations

import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SNAPSHOTS = ROOT / "snapshots"
URL = "https://fantasy.premierleague.com/api/fixtures/"
UA = "fpl-explorer/1.0 (+fixtures-snapshot)"


def main() -> int:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    dest = SNAPSHOTS / f"fixtures_{stamp}.json"
    SNAPSHOTS.mkdir(exist_ok=True)
    req = urllib.request.Request(URL, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            raw = resp.read().decode("utf-8")
        data = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        print(f"fixtures fetch failed: {exc}", file=sys.stderr)
        return 1
    if not isinstance(data, list):
        print("unexpected fixtures payload", file=sys.stderr)
        return 1
    dest.write_text(json.dumps(data), encoding="utf-8")
    print(f"Wrote {dest.name} ({len(data)} fixtures)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
