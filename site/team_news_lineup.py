"""OCR club XI graphics and match tokens to that club's FPL players.

Used so Home can project auto-sub UI as soon as the team-news graphic lands,
before FPL live stats show 0′ / FT.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

NAMED_READY_MIN = 11
FUZZY_MIN = 0.82
TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z'’\-]{2,}")
STOP = {
    "the", "and", "for", "you", "our", "via", "with", "from", "this", "that",
    "your", "team", "news", "presented", "sponsored", "premier", "league",
    "starting", "lineup", "line", "subs", "sub", "substitutes", "bench",
    "kickoff", "versus", "skin", "sokin", "md8",
}


def fold_name(value: str) -> str:
    if not value:
        return ""
    text = unicodedata.normalize("NFKD", str(value))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = text.replace("'", "").replace("’", "").replace("-", " ")
    return re.sub(r"[^a-z0-9 ]+", " ", text.lower()).strip()


def name_tokens(value: str) -> list[str]:
    return [t for t in fold_name(value).split() if len(t) >= 3 and t not in STOP]


def ocr_image_text(path: Path) -> str:
    if not path.exists() or not shutil.which("tesseract"):
        return ""
    try:
        proc = subprocess.run(
            ["tesseract", str(path), "stdout", "--psm", "6"],
            capture_output=True,
            text=True,
            timeout=25,
        )
    except Exception:
        return ""
    return proc.stdout or ""


def player_keys(el: dict) -> set[str]:
    keys = set()
    web = fold_name(el.get("web_name") or "")
    if web:
        keys.add(web)
        keys.update(name_tokens(web))
    second = el.get("second_name") or ""
    for tok in name_tokens(second):
        if len(tok) >= 4:
            keys.add(tok)
    return {k for k in keys if k not in STOP}


def club_players(bootstrap: dict, club_code: str) -> list[dict]:
    teams = {int(t["id"]): t.get("short_name") for t in (bootstrap.get("teams") or [])}
    out = []
    for el in bootstrap.get("elements") or []:
        try:
            tid = int(el.get("team") or 0)
        except (TypeError, ValueError):
            continue
        if teams.get(tid) != club_code:
            continue
        out.append(el)
    return out


def _unique_fuzzy(token: str, key_index: dict[str, list[int]]) -> int | None:
    best_id = None
    best = 0.0
    ties = 0
    for key, ids in key_index.items():
        if abs(len(key) - len(token)) > 2:
            continue
        ratio = SequenceMatcher(None, token, key).ratio()
        if ratio < FUZZY_MIN:
            continue
        if ratio > best + 0.02:
            best = ratio
            best_id = ids[0] if len(ids) == 1 else None
            ties = 0 if len(ids) == 1 else 2
        elif abs(ratio - best) <= 0.02:
            if best_id is None or (ids and ids[0] != best_id):
                ties += 1
    if ties or best_id is None:
        return None
    return best_id


def match_named_players(ocr_text: str, players: list[dict]) -> dict:
    key_index: dict[str, list[int]] = {}
    by_id = {}
    for el in players:
        try:
            eid = int(el["id"])
        except (KeyError, TypeError, ValueError):
            continue
        by_id[eid] = el
        for key in player_keys(el):
            key_index.setdefault(key, [])
            if eid not in key_index[key]:
                key_index[key].append(eid)

    named: dict[int, str] = {}
    tokens = [fold_name(t).replace(" ", "") for t in TOKEN_RE.findall(ocr_text or "")]
    tokens = [t for t in tokens if len(t) >= 3 and t not in STOP]
    for token in tokens:
        hits = key_index.get(token) or []
        eid = hits[0] if len(hits) == 1 else None
        if eid is None and len(token) >= 5:
            eid = _unique_fuzzy(token, key_index)
        if eid is None or eid not in by_id:
            continue
        el = by_id[eid]
        named[eid] = el.get("web_name") or str(eid)

    ids = sorted(named)
    return {
        "named": ids,
        "namedNames": [named[i] for i in ids],
        "namedReady": len(ids) >= NAMED_READY_MIN,
        "namedCount": len(ids),
    }


def annotate_team_row(row: dict, bootstrap: dict, site_dir: Path, *, force: bool = False) -> dict:
    """Attach named FPL ids from the stored graphic. Returns a copy."""
    out = dict(row or {})
    if (
        not force
        and isinstance(out.get("named"), list)
        and out.get("namedCount") is not None
    ):
        return out
    rel = out.get("localPath") or ""
    path = (site_dir / rel) if rel else None
    if not path or not path.exists():
        out.setdefault("named", [])
        out.setdefault("namedNames", [])
        out["namedReady"] = False
        out["namedCount"] = 0
        return out
    players = club_players(bootstrap, str(out.get("code") or ""))
    parsed = match_named_players(ocr_image_text(path), players)
    out.update(parsed)
    return out


def annotate_teams(
    teams: list[dict],
    bootstrap: dict,
    site_dir: Path,
    *,
    force: bool = False,
) -> list[dict]:
    return [annotate_team_row(row, bootstrap, site_dir, force=force) for row in teams or []]
