#!/usr/bin/env python3
"""
Annotate curated X posts with player mentions for the Feed card grid.

Writes into site/social_data.js under each post's `analysis` field.
Slim schema: who the post is about (players), resolved to FPL `code`.
Only annotates posts that are missing analysis (or --force).

Setup (project-root .env):
  # Claude (Anthropic) — preferred if both set
  ANTHROPIC_API_KEY=…
  ANTHROPIC_MODEL=claude-haiku-4-5    # optional (Haiku default — cheaper)

  # Or OpenAI-compatible Chat Completions
  OPENAI_API_KEY=…
  OPENAI_MODEL=gpt-4o-mini           # optional

  # Fallback if no key: --heuristic (keyword/alias scan, no LLM)

Run:
  python3 site/annotate_social.py
  python3 site/annotate_social.py --heuristic
  python3 site/annotate_social.py --force
  python3 site/annotate_social.py --limit 5
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent
ENV_PATH = ROOT / ".env"
SOCIAL_PATH = SITE / "social_data.js"
DATA_PATH = SITE / "data.js"
ACCOUNTS_PATH = SITE / "social_accounts.json"

ANALYSIS_VERSION = 5
SNAPSHOTS_DIR = ROOT / "snapshots"


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

DEFAULT_OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
DEFAULT_ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5")
OPENAI_URL = os.environ.get(
    "OPENAI_BASE_URL", "https://api.openai.com/v1/chat/completions"
)
ANTHROPIC_URL = os.environ.get(
    "ANTHROPIC_BASE_URL", "https://api.anthropic.com/v1/messages"
)


def load_js_object(path: Path, assign_prefix: str) -> dict:
    text = path.read_text(encoding="utf-8").strip()
    m = re.search(
        rf"{re.escape(assign_prefix)}\s*=\s*(\{{.*\}})\s*;?\s*$", text, re.S
    )
    if not m:
        raise SystemExit(f"Could not parse object from {path}")
    return json.loads(m.group(1))


def write_social(payload: dict) -> None:
    body = (
        "window.FPL_SOCIAL = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    SOCIAL_PATH.write_text(body, encoding="utf-8")


def _catalog_player_from_row(row: dict) -> dict | None:
    name = row.get("name") or ""
    team = row.get("team") or row.get("newTeam") or ""
    if not name:
        return None
    # Catalog uses forms like "B.Fernandes", "Igor Jesus", "G.Jesus"
    if "." in name and " " not in name:
        last = name.split(".")[-1]
        first = name.split(".")[0]
    else:
        parts = name.replace("_", " ").split()
        last = parts[-1] if parts else name
        first = parts[0] if len(parts) > 1 else ""
    aliases = {
        name.lower(),
        last.lower(),
        name.replace(".", " ").lower(),
        name.replace("_", " ").lower(),
    }
    if first and last:
        aliases.add(f"{first} {last}".lower())
        aliases.add(f"{first}.{last}".lower())
    # Common spoken forms for dotted web names
    if name == "B.Fernandes":
        aliases |= {"bruno fernandes", "bruno", "fernandes"}
    if name == "G.Jesus":
        aliases |= {"gabriel jesus"}
    if name == "Igor Jesus":
        aliases |= {"igor jesus"}
    pos = (row.get("position") or row.get("newPosition") or "").upper()
    if pos not in ("GK", "DEF", "MID", "FWD"):
        pos = ""
    price = row.get("price2627")
    if price is None:
        price = row.get("price")
    try:
        price_f = float(price) if price is not None else 0.0
    except (TypeError, ValueError):
        price_f = 0.0
    return {
        "id": row.get("id"),
        "name": name,
        "team": team,
        "code": row.get("code"),
        "position": pos,
        "price": price_f,
        "owned": 0.0,
        "last": last,
        "first": first,
        "last_l": last.lower(),
        "name_l": name.lower(),
        "aliases": aliases,
    }


def latest_bootstrap() -> dict | None:
    candidates = sorted(
        (
            p
            for p in SNAPSHOTS_DIR.glob("bootstrap-static_*.json")
            if "archived" not in p.stem
        ),
        key=lambda p: p.name,
        reverse=True,
    )
    if not candidates:
        return None
    try:
        return json.loads(candidates[0].read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def enrich_catalog_popularity(by_code: dict) -> None:
    """Attach ownership (+ fresher price) from the newest bootstrap snapshot."""
    boot = latest_bootstrap()
    if not boot:
        return
    for e in boot.get("elements") or []:
        code = e.get("code")
        if code is None:
            continue
        cur = by_code.get(str(code))
        if not cur:
            continue
        try:
            cur["owned"] = float(e.get("selected_by_percent") or 0)
        except (TypeError, ValueError):
            cur["owned"] = 0.0
        try:
            cur["price"] = float(e.get("now_cost") or 0) / 10.0
        except (TypeError, ValueError):
            pass


def popularity_key(player: dict) -> tuple:
    """Higher ownership, then higher price — proxies for FPL discourse share."""
    return (
        float(player.get("owned") or 0),
        float(player.get("price") or 0),
        int(player.get("code") or 0),
    )


def pick_by_popularity(candidates: list[dict]) -> dict:
    return max(candidates, key=popularity_key)


def load_catalog() -> dict:
    data = load_js_object(DATA_PATH, "window.FPL_DATA")
    team_names = {
        **(data.get("teamNames") or {}),
        **(data.get("fixtureTeamNames") or {}),
        **(data.get("nextSeasonTeamNames") or {}),
    }
    by_code: dict = {}
    # Prefer OPTA/season rows (have stats ids); fill gaps from full FPL squad.
    for row in data.get("players", {}).get("combined") or []:
        p = _catalog_player_from_row(row)
        if not p or p.get("code") is None:
            continue
        by_code[str(p["code"])] = p
    next_players = data.get("nextSeasonPlayers") or []
    if isinstance(next_players, dict):
        next_players = next_players.get("combined") or []
    for row in next_players:
        p = _catalog_player_from_row(row)
        if not p or p.get("code") is None:
            continue
        key = str(p["code"])
        if key not in by_code:
            by_code[key] = p
        else:
            # Prefer next-season team/position when OPTA row is stale.
            cur = by_code[key]
            if p.get("team"):
                cur["team"] = p["team"]
            if p.get("position"):
                cur["position"] = p["position"]
            if p.get("price"):
                cur["price"] = p["price"]
    enrich_catalog_popularity(by_code)
    players = list(by_code.values())
    teams = []
    for code, label in team_names.items():
        aliases = {code.lower(), label.lower(), label.lower().replace(" ", "")}
        # Common shorthand
        if code == "MUN":
            aliases |= {"man utd", "manchester united", "man united"}
        if code == "MCI":
            aliases |= {"man city", "manchester city"}
        if code == "TOT":
            aliases |= {"spurs", "tottenham"}
        if code == "NFO":
            aliases |= {"forest", "nottingham forest", "nottm forest", "nott'm forest"}
        if code == "NEW":
            aliases |= {"newcastle", "toon"}
        if code == "WHU":
            aliases |= {"west ham", "hammers"}
        if code == "COV":
            aliases |= {"coventry"}
        if code == "HUL":
            aliases |= {"hull", "hull city"}
        if code == "IPS":
            aliases |= {"ipswich"}
        teams.append({"code": code, "name": label, "aliases": aliases})
    return {"players": players, "teams": teams, "teamNames": team_names}


def account_roles() -> dict[str, list[str]]:
    if not ACCOUNTS_PATH.exists():
        return {}
    raw = json.loads(ACCOUNTS_PATH.read_text(encoding="utf-8"))
    out = {}
    for a in raw.get("accounts") or []:
        handle = (a.get("handle") or "").lstrip("@")
        roles = a.get("roles") or ([] if not a.get("role") else [a.get("role")])
        if handle:
            out[handle] = [r for r in roles if r]
    return out


def _entities_from_slim_players(raw: dict) -> list[dict]:
    """Accept slim `{players:[…]}` or legacy `{entities:[…]}`."""
    players_raw = raw.get("players")
    if isinstance(players_raw, list):
        out = []
        for p in players_raw:
            if not isinstance(p, dict):
                continue
            out.append(
                {
                    "mention": p.get("mention") or p.get("name"),
                    "type": "player",
                    "name": p.get("name"),
                    "team": p.get("team"),
                    "position": p.get("position"),
                    "hintedTeam": p.get("team"),
                    "hintedPosition": p.get("position"),
                    "confidence": p.get("confidence", 0.6),
                }
            )
        return out
    return list(raw.get("entities") or [])


def normalize_analysis(raw: dict, model: str) -> dict:
    entities = []
    for e in _entities_from_slim_players(raw):
        if not isinstance(e, dict):
            continue
        conf = e.get("confidence")
        try:
            conf = max(0.0, min(1.0, float(conf)))
        except (TypeError, ValueError):
            conf = 0.5
        position = normalize_position(e.get("position"))
        hinted_team = (e.get("hintedTeam") or "").strip().upper()
        if not re.fullmatch(r"[A-Z]{2,4}", hinted_team or ""):
            hinted_team = None
        hinted_pos = normalize_position(e.get("hintedPosition") or e.get("positionHint"))
        # Model may put team/position hints on the entity before linking.
        if not hinted_team and not e.get("resolved"):
            maybe = (e.get("team") or "").strip().upper()
            if re.fullmatch(r"[A-Z]{2,4}", maybe or ""):
                hinted_team = maybe
        if not hinted_pos and not e.get("resolved"):
            hinted_pos = normalize_position(e.get("position"))
        match_basis = e.get("matchBasis")
        if match_basis is not None:
            match_basis = str(match_basis)[:40]
        ctx_teams = []
        for tcode in e.get("contextTeams") or []:
            if isinstance(tcode, str) and tcode.strip():
                ctx_teams.append(tcode.strip().upper()[:4])
        ctx_pos = []
        for pcode in e.get("contextPositions") or []:
            p = normalize_position(pcode)
            if p:
                ctx_pos.append(p)
        candidates = []
        for c in e.get("candidates") or []:
            if not isinstance(c, dict):
                continue
            candidates.append(
                {
                    "name": c.get("name"),
                    "team": c.get("team"),
                    "code": c.get("code"),
                    "position": c.get("position"),
                }
            )
        ent_type = e.get("type") if e.get("type") in ("player", "team", "other") else "player"
        entities.append(
            {
                "mention": str(e.get("mention") or e.get("name") or "")[:80],
                "type": ent_type,
                "name": e.get("name"),
                "team": e.get("team"),
                "position": position if e.get("resolved") else None,
                "hintedTeam": hinted_team,
                "hintedPosition": hinted_pos,
                "code": e.get("code"),
                "playerId": e.get("playerId") or e.get("id"),
                "confidence": conf,
                "resolved": bool(e.get("resolved")),
                "matchBasis": match_basis,
                "contextTeams": ctx_teams[:6],
                "contextPositions": ctx_pos[:4],
                "candidates": candidates[:6],
            }
        )
    conf = raw.get("confidence")
    try:
        conf = max(0.0, min(1.0, float(conf)))
    except (TypeError, ValueError):
        conf = 0.55 if entities else 0.35
    return {
        "version": ANALYSIS_VERSION,
        "model": model,
        "annotatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "entities": entities[:20],
        "confidence": conf,
        "needsReview": bool(raw.get("needsReview")) or conf < 0.45,
    }


# Team codes / aliases that are also common English — never match alone.
RISKY_TEAM_TOKENS = {
    "new",
    "sun",
    "united",
    "city",
    "forest",
    "town",
    "athletic",
    "hot",
    "the",
}

POSITION_WORDS = {
    "gk": "GK",
    "gkp": "GK",
    "goalkeeper": "GK",
    "goalkeepers": "GK",
    "keeper": "GK",
    "keepers": "GK",
    "def": "DEF",
    "defender": "DEF",
    "defenders": "DEF",
    "defence": "DEF",
    "defense": "DEF",
    "cb": "DEF",
    "fb": "DEF",
    "wb": "DEF",
    "fullback": "DEF",
    "full-back": "DEF",
    "mid": "MID",
    "midfielder": "MID",
    "midfielders": "MID",
    "midfield": "MID",
    "cm": "MID",
    "am": "MID",
    "dm": "MID",
    "fwd": "FWD",
    "fwds": "FWD",
    "forward": "FWD",
    "forwards": "FWD",
    "striker": "FWD",
    "strikers": "FWD",
    "attacker": "FWD",
    "attackers": "FWD",
}


def normalize_position(value: str | None) -> str | None:
    if not value:
        return None
    v = str(value).strip().lower()
    if v.upper() in ("GK", "DEF", "MID", "FWD"):
        return v.upper()
    return POSITION_WORDS.get(v)


def apply_player(
    ent: dict,
    player: dict,
    *,
    confidence: float | None = None,
    match_basis: str | None = None,
    context_teams: list[str] | None = None,
    context_positions: list[str] | None = None,
    candidates: list[dict] | None = None,
) -> dict:
    out = dict(ent)
    out["type"] = "player"
    out["name"] = player["name"]
    out["team"] = player["team"]
    out["position"] = player.get("position") or None
    out["code"] = player["code"]
    out["playerId"] = player.get("id")
    out["resolved"] = player.get("code") is not None
    out["matchBasis"] = match_basis
    out["contextTeams"] = context_teams or []
    out["contextPositions"] = context_positions or []
    out["candidates"] = candidates or []
    if confidence is not None:
        out["confidence"] = confidence
    return out


def apply_team(ent: dict, team: dict, *, confidence: float | None = None) -> dict:
    out = dict(ent)
    out["type"] = "team"
    out["name"] = team["name"]
    out["team"] = team["code"]
    out["position"] = None
    out["code"] = None
    out["playerId"] = None
    out["resolved"] = True
    out["matchBasis"] = "team_alias"
    out["contextTeams"] = [team["code"]]
    out["contextPositions"] = []
    out["candidates"] = []
    if confidence is not None:
        out["confidence"] = confidence
    return out


def unresolved_player(
    ent: dict,
    *,
    match_basis: str,
    context_teams: list[str],
    context_positions: list[str],
    candidates: list[dict],
) -> dict:
    out = dict(ent)
    out["type"] = "player"
    out["code"] = None
    out["playerId"] = None
    out["resolved"] = False
    out["matchBasis"] = match_basis
    out["contextTeams"] = context_teams
    out["contextPositions"] = context_positions
    out["candidates"] = candidates[:6]
    # Keep model-provided name/team as hints only when not validated
    if not out.get("name"):
        out["name"] = out.get("mention")
    return out


def candidate_brief(p: dict) -> dict:
    return {
        "name": p.get("name"),
        "team": p.get("team"),
        "code": p.get("code"),
        "position": p.get("position") or None,
    }


def teams_mentioned_in_text(text: str, catalog: dict) -> list[str]:
    found: list[str] = []
    for t in catalog["teams"]:
        aliases = sorted(
            (a for a in t["aliases"] if a not in RISKY_TEAM_TOKENS and a != t["code"].lower()),
            key=len,
            reverse=True,
        )
        # Prefer full names; allow code only as a standalone token if not risky
        for alias in aliases:
            if len(alias) < 4:
                continue
            if re.search(rf"\b{re.escape(alias)}\b", text, re.I):
                found.append(t["code"])
                break
        else:
            code = t["code"]
            if code.lower() not in RISKY_TEAM_TOKENS and re.search(
                rf"\b{re.escape(code)}\b", text
            ):
                found.append(code)
    # de-dupe preserve order
    return list(dict.fromkeys(found))


def positions_mentioned_in_text(text: str) -> list[str]:
    found: list[str] = []
    for word, pos in POSITION_WORDS.items():
        if re.search(rf"\b{re.escape(word)}\b", text, re.I):
            if pos not in found:
                found.append(pos)
    return found


def extract_entity_context(ent: dict, text: str, catalog: dict) -> dict:
    """Team/position cues from the post text + explicit model hints (not resolved joins)."""
    teams = teams_mentioned_in_text(text, catalog)
    positions = positions_mentioned_in_text(text)

    hinted_team = (ent.get("hintedTeam") or "").strip().upper()
    if not hinted_team and not ent.get("resolved"):
        hinted_team = (ent.get("team") or "").strip().upper()
    if hinted_team and re.fullmatch(r"[A-Z]{2,4}", hinted_team):
        if hinted_team in (catalog.get("teamNames") or {}) or any(
            t["code"] == hinted_team for t in catalog["teams"]
        ):
            teams = [hinted_team] + [t for t in teams if t != hinted_team]

    hinted_pos = normalize_position(ent.get("hintedPosition"))
    if not hinted_pos and not ent.get("resolved"):
        hinted_pos = normalize_position(ent.get("position"))
    if hinted_pos and hinted_pos not in positions:
        positions = [hinted_pos] + positions

    return {"teams": teams[:6], "positions": positions[:4]}


def collect_player_candidates(mention: str, catalog: dict, text: str) -> list[dict]:
    m = (mention or "").lower().strip().lstrip("@")
    if not m:
        return []
    players = catalog["players"]
    text_l = text.lower()

    # Stronger: exact alias hits
    exact = [p for p in players if m in p["aliases"]]
    if exact:
        # Drop bare-token hits when a longer multi-word alias for another player
        # is present (Igor vs Igor Jesus).
        if " " not in m and len(m) <= 8:
            blocked = False
            for other in players:
                for alias in other["aliases"]:
                    if " " in alias and m in alias.split() and alias in text_l:
                        if all(other["code"] != p["code"] for p in exact):
                            blocked = True
                            break
                if blocked:
                    break
            if blocked:
                exact = [
                    p
                    for p in exact
                    if any((" " in a or "." in a) and a in text_l for a in p["aliases"])
                    or (" " in m)
                ]
        return exact

    # Last-name / token candidates
    cands = []
    for p in players:
        last = p["last_l"]
        if len(last) < 4:
            continue
        if last == m or m == p["name_l"] or last in m.split():
            if re.search(rf"\b{re.escape(p['last'])}\b", mention, re.I) or m == last:
                cands.append(p)
    return cands


def resolve_player_with_context(
    mention: str, ent: dict, catalog: dict, text: str
) -> dict | None:
    """
    Resolve a player mention only when context is strong enough.

    Accepted bases:
      - unique_full_alias: distinctive multi-word / dotted name, single catalog hit
      - unique_lastname: last name unique across catalog
      - team_context: team cue uniquely selects among candidates
      - position_context: position cue uniquely selects among candidates
      - team_position_context: team+position together uniquely select
      - hinted_team / hinted_position: model-provided team/pos on the entity

    Ambiguous surnames without team/position context default to the
    higher-owned, then higher-priced candidate (`popularity_default`) —
    the player more likely to appear in FPL discourse.
    """
    ctx = extract_entity_context(ent, text, catalog)
    cands = collect_player_candidates(mention, catalog, text)
    if not cands:
        return None

    m = (mention or "").lower().strip().lstrip("@")
    briefs = [candidate_brief(p) for p in cands]
    ctx_teams = ctx["teams"]
    ctx_pos = ctx["positions"]

    def finish(player: dict, basis: str, confidence: float) -> dict:
        out = apply_player(
            ent,
            player,
            confidence=confidence,
            match_basis=basis,
            context_teams=ctx_teams,
            context_positions=ctx_pos,
            candidates=briefs if len(cands) > 1 else [],
        )
        # Preserve model hints separately from resolved catalog team/position.
        if ent.get("hintedTeam"):
            out["hintedTeam"] = ent.get("hintedTeam")
        if ent.get("hintedPosition"):
            out["hintedPosition"] = ent.get("hintedPosition")
        return out

    def reject(basis: str) -> dict:
        out = unresolved_player(
            ent,
            match_basis=basis,
            context_teams=ctx_teams,
            context_positions=ctx_pos,
            candidates=briefs,
        )
        if ent.get("hintedTeam"):
            out["hintedTeam"] = ent.get("hintedTeam")
        if ent.get("hintedPosition"):
            out["hintedPosition"] = ent.get("hintedPosition")
        return out

    def popularity_default(pool: list[dict]) -> dict:
        best = pick_by_popularity(pool)
        return finish(best, "popularity_default", 0.62)

    # 1) Unique candidate
    if len(cands) == 1:
        p = cands[0]
        distinctive = (" " in m) or ("." in m) or any(
            (" " in a or "." in a) and a == m for a in p["aliases"]
        )
        same_last = [x for x in catalog["players"] if x["last_l"] == p["last_l"]]
        unique_last = len(same_last) == 1
        team_ok = p["team"] in ctx_teams if ctx_teams else False
        pos_ok = p.get("position") in ctx_pos if ctx_pos else False

        # Soft conflict: post names other clubs (often opponents) — only hard-fail
        # when a short/common mention has zero supporting distinctive alias.
        if ctx_teams and not team_ok and not distinctive:
            return reject("team_conflict")

        # Prefer context-validated bases when cues exist (better audit trail).
        if team_ok and pos_ok:
            return finish(p, "team_position_context", 0.95)
        if team_ok:
            return finish(p, "team_context", 0.9)
        if distinctive:
            return finish(p, "unique_full_alias", 0.88 if unique_last else 0.84)
        if unique_last and not ctx_teams:
            return finish(p, "unique_lastname", 0.8)
        if unique_last and team_ok:
            return finish(p, "team_context", 0.9)
        if pos_ok and unique_last:
            return finish(p, "position_context", 0.72)
        if not ctx_teams and not ctx_pos:
            # Shared surname but only one catalog hit for this mention form.
            if not unique_last:
                return popularity_default(same_last)
            return reject("needs_team_or_position")
        if pos_ok:
            return finish(p, "position_context", 0.7)
        return reject("needs_team_or_position")

    # 2) Multiple candidates — require team and/or position to uniquely select
    team_filtered = [p for p in cands if p["team"] in ctx_teams] if ctx_teams else []
    pos_filtered = [p for p in cands if p.get("position") in ctx_pos] if ctx_pos else []
    both_filtered = [
        p
        for p in cands
        if (not ctx_teams or p["team"] in ctx_teams)
        and (not ctx_pos or p.get("position") in ctx_pos)
    ]

    if len(team_filtered) == 1 and len(pos_filtered) == 1 and team_filtered[0]["code"] == pos_filtered[0]["code"]:
        return finish(team_filtered[0], "team_position_context", 0.95)
    if len(both_filtered) == 1 and (ctx_teams or ctx_pos):
        basis = (
            "team_position_context"
            if ctx_teams and ctx_pos
            else ("team_context" if ctx_teams else "position_context")
        )
        return finish(both_filtered[0], basis, 0.9 if ctx_teams else 0.78)
    if len(team_filtered) == 1:
        return finish(team_filtered[0], "team_context", 0.9)
    if len(pos_filtered) == 1 and not team_filtered:
        # Position alone among collisions is weaker — only accept if position
        # cue is present and team cue didn't contradict multiple teams
        return finish(pos_filtered[0], "position_context", 0.7)

    # Distinctive multi-word alias present in text that matches exactly one cand
    text_l = text.lower()
    distinctive_hits = []
    for p in cands:
        for alias in p["aliases"]:
            if (" " in alias or "." in alias) and len(alias) >= 5 and alias in text_l:
                distinctive_hits.append(p)
                break
    distinctive_hits = list({p["code"]: p for p in distinctive_hits}.values())
    if len(distinctive_hits) == 1:
        return finish(distinctive_hits[0], "unique_full_alias", 0.88)

    # Still ambiguous: prefer the more-owned / higher-priced player.
    pool = both_filtered if len(both_filtered) > 1 else cands
    if len(team_filtered) > 1:
        pool = team_filtered
    elif len(pos_filtered) > 1 and not team_filtered:
        pool = pos_filtered
    return popularity_default(pool)


def match_team(mention: str, catalog: dict):
    m = (mention or "").lower().strip().lstrip("@")
    if not m:
        return None
    # Handles like @afcbournemouth
    compact = re.sub(r"[^a-z0-9]", "", m)
    for t in catalog["teams"]:
        if m == t["name"].lower():
            return t
        # Allow code match only when mention is clearly a code (uppercase-ish / exact)
        if m == t["code"].lower() and m not in RISKY_TEAM_TOKENS:
            return t
        if m in t["aliases"] and m not in RISKY_TEAM_TOKENS:
            return t
        if compact and compact == re.sub(r"[^a-z0-9]", "", t["name"].lower()):
            return t
        name_compact = re.sub(r"[^a-z0-9]", "", t["name"].lower())
        if compact and len(compact) >= 6 and name_compact and name_compact in compact:
            return t
        if len(m) >= 5 and t["name"].lower() in m:
            return t
    return None


def link_entities(analysis: dict, catalog: dict, text: str) -> dict:
    """Attach FPL player/team codes only when team/position context validates them."""
    text_l = text.lower()
    players = catalog["players"]
    teams = catalog["teams"]
    post_teams = teams_mentioned_in_text(text, catalog)
    post_positions = positions_mentioned_in_text(text)

    def weak_mention(mention: str) -> bool:
        m = (mention or "").strip().lower()
        if not m or len(m) < 3:
            return True
        if m in {
            "he", "she", "they", "him", "his", "her", "it", "this", "that",
            "you", "we", "us", "them", "who", "someone", "anyone",
        }:
            return True
        if m.startswith("£") or m.startswith("$"):
            return True
        return False

    linked = []
    for e in analysis.get("entities") or []:
        ent = dict(e)
        mention = ent.get("mention") or ent.get("name") or ""
        etype = ent.get("type")
        if etype in ("player", None, "other") and weak_mention(mention):
            continue
        # Promote model team/position into explicit hint fields before resolve.
        if not ent.get("hintedTeam") and not ent.get("resolved"):
            maybe = (ent.get("team") or "").strip().upper()
            if re.fullmatch(r"[A-Z]{2,4}", maybe or ""):
                ent["hintedTeam"] = maybe
        if not ent.get("hintedPosition") and not ent.get("resolved"):
            hp = normalize_position(ent.get("position"))
            if hp:
                ent["hintedPosition"] = hp

        if etype == "player":
            resolved = resolve_player_with_context(mention, ent, catalog, text)
            # Includes unresolved rows that still have candidates for review.
            if resolved and (resolved.get("resolved") or resolved.get("candidates")):
                linked.append(resolved)
            continue

        if etype == "other":
            # Only promote to player with strong context validation
            resolved = resolve_player_with_context(mention, ent, catalog, text)
            if resolved and resolved.get("resolved") and resolved.get("matchBasis") in {
                "unique_full_alias",
                "team_context",
                "team_position_context",
                "unique_lastname",
            }:
                resolved["confidence"] = min(float(resolved.get("confidence") or 0.5), 0.7)
                linked.append(resolved)
                continue

        if etype in ("team", "other", None):
            t = match_team(mention, catalog)
            if t and etype != "player":
                linked.append(apply_team(ent, t))
                continue

        if etype is None:
            resolved = resolve_player_with_context(mention, ent, catalog, text)
            if resolved and (resolved.get("resolved") or resolved.get("candidates")):
                linked.append(resolved)
                continue

        # Keep non-player leftovers for review — clear stale join keys.
        if etype == "team":
            ent["code"] = None
            ent["playerId"] = None
            ent["team"] = None
            ent["position"] = None
            ent["resolved"] = False
            ent.setdefault("matchBasis", "unresolved")
            ent.setdefault("contextTeams", post_teams)
            ent.setdefault("contextPositions", post_positions)
            ent.setdefault("candidates", [])
            linked.append(ent)
        elif etype == "other":
            ent["code"] = None
            ent["playerId"] = None
            ent["resolved"] = False
            ent.setdefault("matchBasis", "unresolved")
            linked.append(ent)

    # Backfill: scan distinctive aliases in text, still requiring context rules.
    seen_codes = {
        e.get("code") for e in linked if e.get("type") == "player" and e.get("resolved") and e.get("code") is not None
    }
    seen_mentions = {(e.get("mention") or "").lower() for e in linked if e.get("resolved")}
    for p in players:
        if p.get("code") in seen_codes:
            continue
        hit_alias = None
        for alias in sorted(p["aliases"], key=len, reverse=True):
            if len(alias) < 4:
                continue
            if " " in alias or "." in alias:
                if alias in text_l:
                    hit_alias = alias
                    break
            elif re.search(rf"\b{re.escape(alias)}\b", text, re.I):
                # Shared surnames are fine — resolve_player_with_context will
                # apply team/position cues or popularity_default.
                hit_alias = alias
                break
        if not hit_alias or hit_alias in seen_mentions:
            continue
        probe = {
            "mention": hit_alias,
            "type": "player",
            "confidence": 0.55,
        }
        resolved = resolve_player_with_context(hit_alias, probe, catalog, text)
        if not resolved or not resolved.get("resolved"):
            continue
        if resolved.get("code") is not None and resolved.get("code") in seen_codes:
            continue
        # Avoid adding a second player whose name is nested in an already resolved one
        if any(
            (resolved.get("name") or "").lower() in (e.get("name") or "").lower()
            or (e.get("name") or "").lower() in (resolved.get("name") or "").lower()
            for e in linked
            if e.get("resolved") and e.get("type") == "player"
        ):
            # Allow if codes differ and names aren't substrings in a confusing way
            nested = False
            for e in linked:
                if not (e.get("resolved") and e.get("type") == "player"):
                    continue
                en = (e.get("name") or "").lower()
                rn = (resolved.get("name") or "").lower()
                if en and rn and en != rn and (en in rn or rn in en):
                    nested = True
                    break
            if nested:
                continue
        linked.append(resolved)
        seen_codes.add(resolved.get("code"))
        seen_mentions.add(hit_alias)

    # Backfill teams named in the post.
    seen_teams = {e.get("team") for e in linked if e.get("type") == "team" and e.get("team")}
    for tcode in post_teams:
        if tcode in seen_teams:
            continue
        t = next((x for x in teams if x["code"] == tcode), None)
        if not t:
            continue
        linked.append(
            apply_team(
                {
                    "mention": t["name"],
                    "confidence": 0.5,
                },
                t,
                confidence=0.5,
            )
        )
        seen_teams.add(t["code"])

    # Prefer resolved player/team rows; keep unresolved players with candidates
    resolved = [e for e in linked if e.get("type") in ("player", "team") and e.get("resolved")]
    unresolved_players = [
        e
        for e in linked
        if e.get("type") == "player" and not e.get("resolved") and e.get("candidates")
    ]
    other = [
        e
        for e in linked
        if e not in resolved and e not in unresolved_players
    ]
    analysis["entities"] = (resolved + unresolved_players + other)[:20]
    analysis["contextTeams"] = post_teams
    analysis["contextPositions"] = post_positions
    return analysis


# Only these resolution bases are safe enough to join from stats → posts.
INDEXABLE_MATCH_BASES = {
    "unique_full_alias",
    "unique_lastname",
    "team_context",
    "team_position_context",
    "team_alias",
    "popularity_default",
}


def build_mention_index(posts: list[dict]) -> dict:
    """
    Reverse index for future stats/rankings popups:
      players[code] -> [postId, ...]
      teams[PL code] -> [postId, ...]

    Players are included only when matchBasis is strong (team-validated or
    uniquely identifiable). Weak position-only guesses are kept on the entity
    for review but omitted from the index.
    """
    players: dict[str, list[str]] = {}
    teams: dict[str, list[str]] = {}
    skipped_weak = 0
    for post in posts:
        pid = str(post.get("id") or "")
        if not pid:
            continue
        for e in (post.get("analysis") or {}).get("entities") or []:
            if e.get("type") == "player" and e.get("code") is not None and e.get("resolved"):
                basis = e.get("matchBasis") or ""
                if basis not in INDEXABLE_MATCH_BASES:
                    skipped_weak += 1
                    continue
                key = str(e["code"])
                bucket = players.setdefault(key, [])
                if pid not in bucket:
                    bucket.append(pid)
            if e.get("type") == "team" and e.get("team") and e.get("resolved"):
                key = str(e["team"]).upper()
                bucket = teams.setdefault(key, [])
                if pid not in bucket:
                    bucket.append(pid)
    return {
        "players": players,
        "teams": teams,
        "playerCount": len(players),
        "teamCount": len(teams),
        "postLinks": sum(len(v) for v in players.values()) + sum(len(v) for v in teams.values()),
        "skippedWeakPlayerLinks": skipped_weak,
        "indexableBases": sorted(INDEXABLE_MATCH_BASES),
    }


def heuristic_annotate(post: dict, catalog: dict) -> dict:
    """Keyword/alias scan for player names; resolver disambiguates."""
    text = post.get("text") or ""
    t = text.lower()
    players_out = []
    seen_codes = set()
    seen_bare_lasts = set()
    for p in catalog["players"]:
        hit = False
        mention = p["last"]
        distinctive = False
        # Prefer distinctive multi-word / dotted aliases when present.
        for a in sorted(p["aliases"], key=len, reverse=True):
            if len(a) < 5:
                continue
            if (" " in a or "." in a) and a in t:
                hit = True
                distinctive = True
                mention = a
                break
        if not hit and len(p["last_l"]) >= 4 and re.search(
            rf"\b{re.escape(p['last'])}\b", text, re.I
        ):
            hit = True
        if not hit:
            continue

        same_last = [x for x in catalog["players"] if x["last_l"] == p["last_l"]]
        if len(same_last) > 1 and not distinctive:
            # One bare surname mention — do not attach every club's team hint
            # (that was resolving both Palmers). Resolver picks by ownership/price.
            if p["last_l"] in seen_bare_lasts:
                continue
            seen_bare_lasts.add(p["last_l"])
            players_out.append({"mention": p["last"], "confidence": 0.5})
            if len(players_out) >= 8:
                break
            continue

        code = p.get("code")
        if code is not None and code in seen_codes:
            continue
        if code is not None:
            seen_codes.add(code)
        entry = {
            "mention": mention,
            "name": p["name"],
            "confidence": 0.55,
        }
        # Only pass team/position when the hit is unique or distinctive —
        # otherwise the linker treats catalog team as a hard hint.
        if distinctive or len(same_last) == 1:
            entry["team"] = p.get("team")
            entry["position"] = p.get("position") or None
        players_out.append(entry)
        if len(players_out) >= 8:
            break

    raw = {
        "players": players_out,
        "confidence": 0.4 if players_out else 0.3,
        "needsReview": True,
    }
    return link_entities(normalize_analysis(raw, "heuristic-v1"), catalog, text)


def analysis_prompt_parts(post: dict, catalog: dict) -> tuple[str, str]:
    team_lines = ", ".join(
        f"{code}={name}" for code, name in sorted((catalog.get("teamNames") or {}).items())
    )
    system = (
        "You extract Fantasy Premier League (FPL) player mentions from social posts. "
        "Return ONLY valid JSON matching the schema (no markdown fences). "
        "Only list players clearly referred to in the post text. "
        "When a surname could match multiple players, set team (PL code) and/or "
        "position (GK/DEF/MID/FWD) from post context. If still unclear, omit team "
        "and lower confidence. Do not invent players not implied by the text."
    )
    schema_hint = {
        "players": [
            {
                "mention": "as written in the post",
                "name": "optional normalized web name",
                "team": "PL team code like ARS/CHE when the post implies a club",
                "position": "GK|DEF|MID|FWD when the post implies a position",
                "confidence": "0-1",
            }
        ],
        "confidence": "0-1 overall",
        "needsReview": "boolean — true when unsure or ambiguous",
        "notes": "Empty players array is fine for banter/replies with no clear name.",
    }
    user = {
        "handle": post.get("handle"),
        "text": post.get("text"),
        "teams": team_lines,
        "schema": schema_hint,
    }
    user_content = (
        "Extract player mentions and return JSON only.\n"
        + json.dumps(user, ensure_ascii=False)
    )
    return system, user_content


def parse_json_content(content: str) -> dict:
    text = (content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def openai_annotate(post: dict, catalog: dict, model: str) -> dict:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY missing")
    system, user_content = analysis_prompt_parts(post, catalog)
    body = {
        "model": model,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ],
    }
    req = urllib.request.Request(
        OPENAI_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "FPL-Explorer-Annotate/0.1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI HTTP {e.code}: {err}") from e

    content = payload["choices"][0]["message"]["content"]
    raw = parse_json_content(content)
    model_name = payload.get("model") or model
    return link_entities(normalize_analysis(raw, model_name), catalog, post.get("text") or "")


def anthropic_annotate(post: dict, catalog: dict, model: str) -> dict:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY missing")
    system, user_content = analysis_prompt_parts(post, catalog)
    body = {
        "model": model,
        "max_tokens": 1024,
        "temperature": 0.2,
        "system": system,
        "messages": [{"role": "user", "content": user_content}],
    }
    req = urllib.request.Request(
        ANTHROPIC_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
            "User-Agent": "FPL-Explorer-Annotate/0.1",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Anthropic HTTP {e.code}: {err}") from e

    blocks = payload.get("content") or []
    content = "".join(b.get("text", "") for b in blocks if isinstance(b, dict))
    raw = parse_json_content(content)
    model_name = payload.get("model") or model
    return link_entities(normalize_analysis(raw, model_name), catalog, post.get("text") or "")


def resolve_llm_provider() -> tuple[str, str] | None:
    """Return (provider, model) or None if no API key."""
    if os.environ.get("ANTHROPIC_API_KEY", "").strip():
        return "anthropic", DEFAULT_ANTHROPIC_MODEL
    if os.environ.get("OPENAI_API_KEY", "").strip():
        return "openai", DEFAULT_OPENAI_MODEL
    return None


def llm_annotate(post: dict, catalog: dict, provider: str, model: str) -> dict:
    if provider == "anthropic":
        return anthropic_annotate(post, catalog, model)
    if provider == "openai":
        return openai_annotate(post, catalog, model)
    raise RuntimeError(f"Unknown LLM provider: {provider}")


def needs_annotation(post: dict, force: bool) -> bool:
    if force:
        return True
    analysis = post.get("analysis")
    if not analysis:
        return True
    return analysis.get("version") != ANALYSIS_VERSION


def main() -> None:
    parser = argparse.ArgumentParser(description="Annotate FPL social posts")
    parser.add_argument("--heuristic", action="store_true", help="Rule-based only (no LLM)")
    parser.add_argument("--force", action="store_true", help="Re-annotate all posts")
    parser.add_argument("--limit", type=int, default=0, help="Max posts to annotate this run")
    args = parser.parse_args()

    social = load_js_object(SOCIAL_PATH, "window.FPL_SOCIAL")
    posts = social.get("posts") or []
    catalog = load_catalog()
    roles = account_roles()

    provider_info = None if args.heuristic else resolve_llm_provider()
    if not args.heuristic and not provider_info:
        print(
            "No ANTHROPIC_API_KEY or OPENAI_API_KEY in .env — using heuristic annotator.\n"
            "Add ANTHROPIC_API_KEY=… (Claude) or OPENAI_API_KEY=… for LLM mention extraction."
        )

    if provider_info:
        provider, model = provider_info
        mode = f"llm:{provider}"
    else:
        provider, model = None, "heuristic-v1"
        mode = "heuristic"

    pending = [p for p in posts if needs_annotation(p, args.force)]
    if args.limit > 0:
        pending = pending[: args.limit]

    print(f"Posts total={len(posts)} to_annotate={len(pending)} mode={mode} model={model}")

    annotated = 0
    errors = 0
    for post in pending:
        try:
            if provider:
                analysis = llm_annotate(post, catalog, provider, model)
            else:
                analysis = heuristic_annotate(post, catalog)
            # Attach account roles for downstream notification routing
            analysis["accountRoles"] = roles.get(post.get("handle") or "", [])
            post["analysis"] = analysis
            annotated += 1
            resolved = sum(
                1
                for e in analysis.get("entities") or []
                if e.get("type") == "player" and e.get("resolved")
            )
            print(
                f"  ✓ {post.get('id')} entities={len(analysis.get('entities') or [])} "
                f"resolved={resolved}"
            )
        except Exception as e:
            errors += 1
            print(f"  ✗ {post.get('id')}: {e}", file=sys.stderr)

    mention_index = build_mention_index(posts)
    meta = social.get("meta") or {}
    meta["analysis"] = {
        "version": ANALYSIS_VERSION,
        "mode": mode,
        "provider": provider or "heuristic",
        "model": model,
        "annotatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "annotatedThisRun": annotated,
        "errorsThisRun": errors,
        "postsWithAnalysis": sum(1 for p in posts if p.get("analysis")),
    }
    # Join keys for future stats/rankings → Feed popup (no UI yet).
    meta["mentionIndex"] = mention_index
    social["meta"] = meta
    # Keep account roles on social accounts when present in accounts file
    for acc in social.get("accounts") or []:
        handle = acc.get("handle")
        if handle in roles:
            acc["roles"] = roles[handle]

    write_social(social)
    print(
        f"\nWrote {SOCIAL_PATH.name}: annotated {annotated}, "
        f"errors {errors}, with_analysis={meta['analysis']['postsWithAnalysis']}"
    )
    print(
        f"mentionIndex: {mention_index['playerCount']} player(s), "
        f"{mention_index['teamCount']} team(s), "
        f"{mention_index['postLinks']} post link(s)"
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
