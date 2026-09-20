#!/usr/bin/env python3
"""
Mirror FPL club shirt assets into site/kits/.

Official Fantasy PL builds shirt URLs as:
  /dist/img/shirts/standard/shirt_{teamCode}-220.png      (outfield)
  /dist/img/shirts/standard/shirt_{teamCode}_1-220.png    (GK)

teamCode is bootstrap-static teams[].code (not the FPL team id).
Files are saved as {short_name}_of.png / {short_name}_gk.png for the site.

Run:
    python3 site/fetch_kits.py
"""
from __future__ import annotations

import argparse
import json
import ssl
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = Path(__file__).resolve().parent / "kits"
BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/"
SHIRT_BASE = "https://fantasy.premierleague.com/dist/img/shirts/standard"
UA = "Mozilla/5.0 (compatible; FPL.db-kit-mirror/1.0)"
SIZE = 220


def fetch_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
        return json.load(resp)


def fetch_bytes(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
        return resp.read()


def shirt_url(fpl_code: int, *, gk: bool) -> str:
    mid = f"shirt_{fpl_code}_1" if gk else f"shirt_{fpl_code}"
    return f"{SHIRT_BASE}/{mid}-{SIZE}.png"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--out",
        type=Path,
        default=OUT_DIR,
        help=f"Output directory (default: {OUT_DIR})",
    )
    args = ap.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    try:
        boot = fetch_json(BOOTSTRAP_URL)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"bootstrap-static failed: {exc}", file=sys.stderr)
        return 1

    teams = boot.get("teams") or []
    if not teams:
        print("No teams in bootstrap-static", file=sys.stderr)
        return 1

    manifest = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": SHIRT_BASE,
        "size": SIZE,
        "kits": [],
    }

    for team in teams:
        short = str(team.get("short_name") or "").strip().upper()
        code = team.get("code")
        if not short or code is None:
            continue
        fpl_code = int(code)
        for kind, gk in (("of", False), ("gk", True)):
            url = shirt_url(fpl_code, gk=gk)
            dest = out / f"{short}_{kind}.png"
            try:
                data = fetch_bytes(url)
            except (urllib.error.URLError, TimeoutError) as exc:
                print(f"FAIL {dest.name}: {exc}", file=sys.stderr)
                return 1
            dest.write_bytes(data)
            manifest["kits"].append(
                {
                    "team": short,
                    "fplCode": fpl_code,
                    "kind": kind,
                    "file": dest.name,
                    "bytes": len(data),
                    "url": url,
                }
            )
            print(f"OK {dest.name} ({len(data)} bytes)")

    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(manifest['kits'])} kits → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
