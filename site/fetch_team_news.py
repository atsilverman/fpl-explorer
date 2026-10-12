#!/usr/bin/env python3
"""
Current-GW club team-news graphics → site/team-news/ + site/team_news_data.js.

Uses FPL fixture kickoff times to score posts (graphics typically ~75 min pre-KO)
and X recent search (`X_BEARER_TOKEN`) for each club in the active gameweek.
Stores one graphic per team for the current GW only; re-runs update as posts land.

Run:
    python3 site/fetch_team_news.py
    python3 site/fetch_team_news.py --active-only   # scheduled: clubs near KO only
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fpl_gameweeks import display_gameweek_id, extract_gameweeks

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent
ENV_PATH = ROOT / ".env"
ACCOUNTS_PATH = SITE / "pl_club_x_accounts.json"
MEDIA_DIR = SITE / "team-news"
OUT_JS = SITE / "team_news_data.js"
OUT_JSON = SITE / "team_news_data.json"
STATE_PATH = SITE / "team_news_state.json"
FPL_BASE = "https://fantasy.premierleague.com/api"
X_SEARCH = "https://api.x.com/2/tweets/search/recent"
FXTWITTER = "https://api.fxtwitter.com"
UA = "Mozilla/5.0 (compatible; FPL-Explorer/1.0; +team-news)"

# Nicknames / XI phrasing clubs use instead of "team news"
_CLUB_WORDS = (
    r"xi|team|side|line[\s-]?up|blues|reds|gunners|tigers|toffees|magpies|"
    r"hammers|clarets|bees|seagulls|foxes|wolves|cherries|cottagers|"
    r"eagles|spurs|united|city|forest|sunderland|villa|leeds|hull|"
    r"ipswich|brentford|bournemouth|chelsea|arsenal|liverpool|palace|"
    r"newcastle|tottenham|manchester|everton|fulham|brighton|coventry"
)

HINT = re.compile(
    rf"(team\s*news|teamnews|line[\s-]?up|starting\s*xi|\bXI\b|team\s*sheet|"
    rf"here.?s\s+(our|the)\s+team|confirmed\s*(line|xi|team)|matchday\s*(squad|xi)|"
    rf"your\s+.{{0,48}}\b({_CLUB_WORDS})\b|"
    rf"(our|the)\s+.{{0,48}}\b(xi|side|team|gunners)\b|"
    rf"to\s+(face|take\s+on)\s+\w+|starting\s+(at|xi)\b)",
    re.I,
)
STRONG = re.compile(
    rf"(team\s*news\s*is\s*in|teamnews|confirmed\s*(line|xi|team)|starting\s*xi|"
    rf"team\s*news\s*graphic|here.?s\s+(our|the)\s+(starting\s*)?(xi|team)|"
    rf"your\s+.{{0,48}}\bXI\b|"
    rf"your\s+.{{0,48}}\b({_CLUB_WORDS})\b\s+to\s+(face|take\s+on)|"
    rf"(our|the)\s+.{{0,48}}\b(side|team|xi|gunners)\b|"
    rf"to\s+(face|take\s+on)\s+\w+)",
    re.I,
)


def normalize_text(s: str) -> str:
    """NFKC so mathematical bold '𝗧𝗘𝗔𝗠𝗡𝙀𝙒𝙎' → 'TEAMNEWS' for matching."""
    if not s:
        return ""
    return unicodedata.normalize("NFKC", s)


def load_dotenv(path: Path = ENV_PATH) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv()


def generated_at() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fpl_get(path: str):
    req = urllib.request.Request(
        f"{FPL_BASE}{path}",
        headers={"User-Agent": UA, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    raw = s.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def x_search(
    query: str,
    bearer: str,
    *,
    max_results: int = 10,
    start_time: str | None = None,
    end_time: str | None = None,
) -> dict:
    params: dict[str, str] = {
        "query": query,
        "max_results": str(max(10, min(100, max_results))),
        "tweet.fields": "created_at,attachments,entities,text",
        "expansions": "attachments.media_keys",
        "media.fields": "url,preview_image_url,alt_text,width,height,type",
    }
    if start_time:
        params["start_time"] = start_time
    if end_time:
        params["end_time"] = end_time
    params_enc = urllib.parse.urlencode(params)
    req = urllib.request.Request(
        f"{X_SEARCH}?{params_enc}",
        headers={
            "Authorization": f"Bearer {bearer}",
            "User-Agent": UA,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


# Alt text that describes a photo of something else (arrivals, warm-ups, venue).
NON_LINEUP_ALT = re.compile(
    r"\b(arriv\w*|warm(s|ing)?[\s-]*up|training|general\s+view|kick[\s-]?off|"
    r"celebrat\w*|goal|full[\s-]?time|half[\s-]?time)\b",
    re.I,
)


# Weak-wording posts must OCR as a dense name sheet (~8+ surnames) to count.
WEAK_MIN_OCR = 40.0


def alt_is_lineup(alt: str) -> bool:
    """Alt text that reads like a team sheet (names list or XI / Subs labels)."""
    a = normalize_text(alt or "")
    if not a:
        return False
    if re.search(r"\b(starting\s*xi|xi\s*[:|]|subs?\s*[:|]|substitutes|line[\s-]?up|team\s*news)", a, re.I):
        return True
    return a.count(",") >= 8


def lineup_evidence(text: str, alt: str) -> str:
    """'strong' = post or alt clearly a team sheet; 'weak' = XI-ish wording only;
    'none' = no team-news signal, or alt describes a non-lineup photo."""
    t = normalize_text(text)
    if alt_is_lineup(alt):
        return "strong"
    if alt and NON_LINEUP_ALT.search(normalize_text(alt)):
        return "none"
    if STRONG.search(t):
        return "strong"
    if HINT.search(t):
        return "weak"
    return "none"


def score_candidate(
    text: str,
    alt: str,
    *,
    has_photo: bool,
    created: datetime,
    ko: datetime,
) -> float:
    blob = normalize_text(f"{text}\n{alt}")
    if not has_photo:
        return -1.0
    evidence = lineup_evidence(text, alt)
    if evidence == "none":
        return -1.0
    mins_before = (ko - created).total_seconds() / 60.0
    # Ideal ~75 min pre-KO; accept KO-180 → KO+45
    if mins_before > 180 or mins_before < -45:
        if evidence != "strong":
            return -1.0
        if abs(mins_before) > 36 * 60:
            return -1.0
        score = 20.0
    else:
        score = 100.0 - abs(mins_before - 75.0) * 0.6
    if evidence == "strong":
        score += 40.0
    if alt_is_lineup(alt):
        score += 30.0
    if "team news graphic" in blob.lower():
        score += 50.0
    if re.search(r"\bsubs?\b", blob, re.I):
        score += 15.0
    # Demote single-player callouts ("Jefferson back in the XI") vs full sheets
    if re.search(r"\b(back in|returns? to)\s+the\s+XI\b", blob, re.I):
        score -= 55.0
    return score


def fxtwitter_photos(tweet_id: str) -> list[dict]:
    """Some club XI posts omit attachments in X API — fxtwitter still has photos."""
    url = f"{FXTWITTER}/status/{tweet_id}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return []
    tweet = payload.get("tweet") if isinstance(payload, dict) else None
    if not isinstance(tweet, dict):
        return []
    photos = ((tweet.get("media") or {}).get("photos") or []) if isinstance(tweet.get("media"), dict) else []
    out: list[dict] = []
    for photo in photos:
        if not isinstance(photo, dict):
            continue
        media_url = (photo.get("url") or "").split("?")[0]
        if not media_url:
            continue
        out.append(
            {
                "url": media_url,
                "alt_text": photo.get("altText") or photo.get("alt_text") or "",
                "width": photo.get("width"),
                "height": photo.get("height"),
                "type": "photo",
            }
        )
    return out


def ocr_lineup_score(image_url: str) -> float:
    """Score how much an image looks like a starting-XI graphic via OCR.

    Multi-image posts often lead with a promo still; the lineup card is later.
    """
    import shutil
    import subprocess

    if not shutil.which("tesseract"):
        return 0.0
    fetch_url = image_url
    if "pbs.twimg.com" in image_url and "name=" not in image_url:
        fetch_url = f"{image_url}?name=large"
    try:
        req = urllib.request.Request(fetch_url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
    except Exception:
        return 0.0
    # Keep OCR temps inside the repo — system /tmp can be unusable when the
    # Data volume is near-full (macOS still routes NamedTemporaryFile there).
    ocr_dir = MEDIA_DIR / ".ocr-tmp"
    ocr_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = ocr_dir / f"ocr_{abs(hash(image_url)) % (10**10)}.jpg"
    try:
        tmp_path.write_bytes(raw)
        try:
            proc = subprocess.run(
                ["tesseract", str(tmp_path), "stdout", "--psm", "6"],
                capture_output=True,
                text=True,
                timeout=25,
            )
            text = proc.stdout or ""
        except Exception:
            return 0.0
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
    text_n = normalize_text(text).upper()
    # Surname-like tokens (lineup cards are dense with these)
    tokens = re.findall(r"\b[A-Z][A-Z'’\-]{2,}\b", text_n)
    # Drop very common OCR junk / short UI words
    stop = {
        "THE", "AND", "FOR", "YOU", "OUR", "VIA", "WITH", "FROM", "THIS",
        "THAT", "YOUR", "TEAM", "NEWS", "PRESENTED", "SPONSORED",
    }
    names = [t for t in tokens if t not in stop]
    score = float(min(len(names), 18) * 4.0)  # up to +72
    if re.search(r"\bSUBS?\b|\bSUBSTITUTES?\b|\bBENCH\b", text_n):
        score += 25.0
    if re.search(r"\b(TEAM\s*NEWS|STARTING\s*XI|LINE[\s-]?UP)\b", text_n):
        score += 20.0
    # Dense name block = real sheet; sparse OCR = promo photo
    if len(names) >= 8:
        score += 20.0
    elif len(names) <= 2:
        score -= 30.0
    return score


def merge_tweets(*groups: list[dict]) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for group in groups:
        for tw in group or []:
            tid = str(tw.get("id") or "")
            if not tid or tid in seen:
                continue
            seen.add(tid)
            out.append(tw)
    return out


def pick_best(
    tweets: list[dict],
    media_by_key: dict[str, dict],
    ko: datetime,
) -> dict | None:
    best = None
    best_score = -1.0
    for tw in tweets:
        created = parse_iso(tw.get("created_at"))
        if not created:
            continue
        text = tw.get("text") or ""
        tid = str(tw.get("id") or "")
        keys = (tw.get("attachments") or {}).get("media_keys") or []
        candidates: list[dict] = []
        for key in keys:
            media = media_by_key.get(key) or {}
            if (media.get("type") or "") != "photo":
                continue
            url = media.get("url") or media.get("preview_image_url")
            if not url:
                continue
            candidates.append(
                {
                    "url": url.split("?")[0],
                    "alt_text": media.get("alt_text") or "",
                    "width": media.get("width"),
                    "height": media.get("height"),
                }
            )
        # Expand via fxtwitter when X hid attachments, or to recover full
        # carousels (some XI posts list only one image in search results).
        if HINT.search(normalize_text(text)) and len(candidates) <= 1:
            fx_photos = fxtwitter_photos(tid)
            time.sleep(0.15)
            if fx_photos:
                by_url = {c["url"]: dict(c) for c in candidates}
                for fx in fx_photos:
                    u = fx["url"].split("?")[0]
                    if u in by_url:
                        if not by_url[u].get("alt_text") and fx.get("alt_text"):
                            by_url[u]["alt_text"] = fx["alt_text"]
                    else:
                        by_url[u] = {**fx, "url": u}
                candidates = list(by_url.values())

        # Multi-image posts: OCR each photo and boost the lineup sheet
        ocr_bonus: dict[str, float] = {}
        if len(candidates) > 1:
            for media in candidates:
                u = media["url"]
                ocr_bonus[u] = ocr_lineup_score(u)
                time.sleep(0.05)

        for media in candidates:
            sc = score_candidate(
                text,
                media.get("alt_text") or "",
                has_photo=True,
                created=created,
                ko=ko,
            )
            if sc < 0:
                continue
            if lineup_evidence(text, media.get("alt_text") or "") == "weak":
                if media["url"] not in ocr_bonus:
                    ocr_bonus[media["url"]] = ocr_lineup_score(media["url"])
                if ocr_bonus[media["url"]] < WEAK_MIN_OCR:
                    continue
            sc += ocr_bonus.get(media["url"], 0.0)
            if sc > best_score:
                best_score = sc
                best = {
                    "tweetId": tid,
                    "postedAt": created.astimezone(timezone.utc).strftime(
                        "%Y-%m-%dT%H:%M:%SZ"
                    ),
                    "text": text,
                    "altText": media.get("alt_text") or "",
                    "mediaUrl": media["url"],
                    "width": media.get("width"),
                    "height": media.get("height"),
                    "score": round(sc, 1),
                    "minsBeforeKo": round((ko - created).total_seconds() / 60.0, 1),
                    "ocrBonus": round(ocr_bonus.get(media["url"], 0.0), 1),
                }
    return best


def download_image(url: str, dest_no_ext: Path) -> Path:
    fetch_url = url
    if "pbs.twimg.com" in url and "name=" not in url:
        fetch_url = f"{url}?name=large"
    req = urllib.request.Request(fetch_url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=45) as resp:
        data = resp.read()
        ctype = (resp.headers.get("Content-Type") or "").lower()
    if "png" in ctype:
        dest = dest_no_ext.with_suffix(".png")
    elif "webp" in ctype:
        dest = dest_no_ext.with_suffix(".webp")
    else:
        dest = dest_no_ext.with_suffix(".jpg")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return dest


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"gw": None, "teams": {}}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2), encoding="utf-8")


def write_bundle(gw: int, teams: list[dict], generated: str) -> None:
    # Most recent left-most for the UI swipe track
    ordered = sorted(teams, key=lambda t: t.get("postedAt") or "", reverse=True)
    payload = {
        "generatedAt": generated,
        "gw": gw,
        "teams": ordered,
    }
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    OUT_JS.write_text(
        "window.FPL_TEAM_NEWS = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n",
        encoding="utf-8",
    )


ACTIVE_BEFORE_KO = timedelta(minutes=120)
ACTIVE_AFTER_KO = timedelta(minutes=45)


def main() -> int:
    active_only = "--active-only" in sys.argv[1:]
    bearer = os.environ.get("X_BEARER_TOKEN", "").strip()
    if not bearer:
        print("No X_BEARER_TOKEN in .env — cannot fetch team news.", file=sys.stderr)
        return 1

    accounts = json.loads(ACCOUNTS_PATH.read_text(encoding="utf-8"))["clubs"]
    by_code = {c["code"]: c for c in accounts}

    bootstrap = fpl_get("/bootstrap-static/")
    gws = extract_gameweeks(bootstrap, source="bootstrap-static")
    gw = display_gameweek_id(gws)
    if gw is None:
        print("No current/next gameweek in bootstrap", file=sys.stderr)
        return 1

    teams_meta = {t["id"]: t for t in bootstrap.get("teams") or []}
    fixtures = fpl_get(f"/fixtures/?event={gw}")
    if not isinstance(fixtures, list):
        print("Unexpected fixtures payload", file=sys.stderr)
        return 1

    # Per-club KO for this GW (one PL fixture each)
    club_fixtures: dict[str, dict] = {}
    for fx in fixtures:
        ko = fx.get("kickoff_time")
        if not ko:
            continue
        for side in ("team_h", "team_a"):
            tid = fx.get(side)
            tmeta = teams_meta.get(tid) or {}
            code = tmeta.get("short_name")
            if not code or code not in by_code:
                continue
            club_fixtures[code] = {
                "ko": ko,
                "fixtureId": fx.get("id"),
                "home": teams_meta.get(fx.get("team_h"), {}).get("short_name"),
                "away": teams_meta.get(fx.get("team_a"), {}).get("short_name"),
                "ha": "H" if side == "team_h" else "A",
            }

    state = load_state()
    gw_changed = state.get("gw") != gw
    if gw_changed:
        # New GW — drop prior stored graphics from the bundle (files can remain for debug)
        state = {"gw": gw, "teams": {}}
        gw_dir = MEDIA_DIR / f"gw{gw}"
        if gw_dir.exists():
            for p in gw_dir.glob("*"):
                if p.is_file():
                    p.unlink()

    print(f"GW{gw}: scanning {len(club_fixtures)} clubs for team-news graphics…")
    now = generated_at()
    updated = 0
    errors = 0

    for code, fxinfo in sorted(club_fixtures.items(), key=lambda kv: kv[1]["ko"]):
        club = by_code[code]
        handle = club["xHandle"]
        ko = parse_iso(fxinfo["ko"])
        if not ko:
            continue
        if active_only:
            now_check = datetime.now(timezone.utc)
            if not (ko - ACTIVE_BEFORE_KO <= now_check <= ko + ACTIVE_AFTER_KO):
                continue
        # Anchor on FPL KO (~75 min pre-KO). Some clubs' XI posts are NOT
        # indexed under has:media (ARS/MUN), so also search by XI keywords
        # in the same window without the media operator.
        now_dt = datetime.now(timezone.utc)
        end_cap = now_dt - timedelta(seconds=15)
        start_dt = ko - timedelta(minutes=150)
        end_dt = min(ko + timedelta(minutes=30), end_cap)
        if start_dt >= end_dt:
            if ko > now_dt + timedelta(minutes=150):
                print(f"  · {code} @{handle}: too early (KO {fxinfo['ko']})")
                continue
            end_dt = end_cap
            start_dt = min(start_dt, end_dt - timedelta(minutes=5))

        start_s = start_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        end_s = end_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        tweets: list[dict] = []
        media_by_key: dict[str, dict] = {}
        try:
            media_payload = x_search(
                f"from:{handle} has:media -is:retweet",
                bearer,
                max_results=15,
                start_time=start_s,
                end_time=end_s,
            )
            time.sleep(0.3)
            # Keyword pass catches XI posts X does not tag as has:media
            kw_payload = x_search(
                (
                    f'from:{handle} ("team news" OR TEAMNEWS OR lineup OR "line-up" OR '
                    f'"starting XI" OR "to face" OR "to take on" OR "Your" OR Gunners OR '
                    f'Tigers) -is:retweet'
                ),
                bearer,
                max_results=15,
                start_time=start_s,
                end_time=end_s,
            )
            time.sleep(0.3)
            tweets = merge_tweets(media_payload.get("data"), kw_payload.get("data"))
            for m in (media_payload.get("includes") or {}).get("media") or []:
                if m.get("media_key"):
                    media_by_key[m["media_key"]] = m
            for m in (kw_payload.get("includes") or {}).get("media") or []:
                if m.get("media_key"):
                    media_by_key[m["media_key"]] = m
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:200]
            print(f"  · {code} @{handle}: HTTP {e.code} {body}")
            errors += 1
        except Exception as e:
            print(f"  · {code} @{handle}: {type(e).__name__}: {e}")
            errors += 1

        best = pick_best(tweets, media_by_key, ko)
        if not best:
            prev = (state.get("teams") or {}).get(code)
            mark = "kept" if prev else "miss"
            print(f"  · {code} @{handle}: no graphic ({mark})")
            continue

        prev = (state.get("teams") or {}).get(code) or {}
        if (
            prev.get("tweetId") == best["tweetId"]
            and prev.get("mediaUrl") == best.get("mediaUrl")
            and prev.get("localPath")
        ):
            local = SITE / prev["localPath"]
            if local.exists():
                print(
                    f"  ✓ {code} @{handle}: unchanged {best['tweetId']} "
                    f"(Δko={best['minsBeforeKo']}m)"
                )
                continue

        try:
            dest = download_image(best["mediaUrl"], MEDIA_DIR / f"gw{gw}" / code)
            rel = str(dest.relative_to(SITE)).replace("\\", "/")
        except Exception as e:
            print(f"  · {code} @{handle}: download failed: {e}")
            errors += 1
            continue

        opp = fxinfo["away"] if fxinfo["ha"] == "H" else fxinfo["home"]
        row = {
            "code": code,
            "name": club["name"],
            "handle": handle,
            "tweetId": best["tweetId"],
            "tweetUrl": f"https://x.com/{handle}/status/{best['tweetId']}",
            "postedAt": best["postedAt"],
            "kickoff": fxinfo["ko"],
            "minsBeforeKo": best["minsBeforeKo"],
            "match": f"{fxinfo['home']} v {fxinfo['away']}",
            "opp": opp,
            "ha": fxinfo["ha"],
            "text": best["text"][:240],
            "altText": best["altText"][:800] if best["altText"] else "",
            "localPath": rel,
            "mediaUrl": best["mediaUrl"],
            "width": best.get("width"),
            "height": best.get("height"),
            "score": best["score"],
            "fetchedAt": now,
        }
        state.setdefault("teams", {})[code] = row
        updated += 1
        print(
            f"  ✓ {code} @{handle}: saved {rel} "
            f"(Δko={best['minsBeforeKo']}m score={best['score']})"
        )

    if active_only and not updated and not gw_changed:
        print(f"\nGW{gw}: no new graphics — bundle unchanged.")
        return 0 if errors == 0 else 1

    teams = list((state.get("teams") or {}).values())
    # Only keep clubs still in this GW fixture list
    teams = [t for t in teams if t.get("code") in club_fixtures]
    state["gw"] = gw
    state["teams"] = {t["code"]: t for t in teams}
    state["generatedAt"] = now
    save_state(state)
    write_bundle(gw, teams, now)

    print(
        f"\nDone GW{gw}: {len(teams)} graphics stored, {updated} new/updated, "
        f"{errors} errors → {OUT_JS.name}"
    )
    return 0 if errors == 0 or teams else 1


if __name__ == "__main__":
    raise SystemExit(main())
