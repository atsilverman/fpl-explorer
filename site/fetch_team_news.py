#!/usr/bin/env python3
"""
Current-GW club team-news graphics → site/team-news/ + site/team_news_data.js
(Graphics page).

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
from team_news_lineup import annotate_teams

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
    rf"to\s+(face|take\s+on)\s+@?\w+|starting\s+(at|xi)\b|📋)",
    re.I,
)
STRONG = re.compile(
    rf"(team\s*news\s*is\s*in|teamnews|confirmed\s*(line|xi|team)|starting\s*xi|"
    rf"team\s*news\s*graphic|here.?s\s+(our|the)\s+(starting\s*)?(xi|team)|"
    rf"your\s+.{{0,48}}\bXI\b|"
    rf"your\s+.{{0,48}}\b({_CLUB_WORDS})\b\s+to\s+(face|take\s+on)|"
    rf"(our|the)\s+.{{0,48}}\b(side|team|xi|gunners)\b|"
    rf"to\s+(face|take\s+on)\s+@?\w+|"
    rf"your\s+.{{0,48}}\b({_CLUB_WORDS})\b.{{0,40}}📋)",
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
# OCR-only (no XI caption / alt) needs a real name sheet, not stadium chrome.
OCR_ONLY_MIN_NAMES = 8

# Clubs often caption the XI with just a nickname ("The Tigers. 👊"), so photo
# posts in the usual XI slot get an OCR-only chance at a stricter bar.
SLOT_MIN_BEFORE_KO = 55.0
SLOT_MAX_BEFORE_KO = 100.0
SLOT_MIN_OCR = 70.0
# OCR-only picks must never outrank a post whose caption says it is the XI.
SLOT_OCR_PENALTY = 100.0
NON_LINEUP_CAPTION = re.compile(
    r"\b(arriv\w*|check(ed|ing)\s+in|in\s+the\s+building|warm(s|ing)?[\s-]*up|"
    r"scene|setting|minutes\s+(until|to\s+go)|from\s+above|appearances?|"
    r"racism|stadium|tickets?|kit|kick[\s-]?off|build(ing)?[\s-]+up|"
    r"fan\s*zone|times|here\s+come|amex|anfield|etihad|old\s*trafford|"
    r"emirates|stamford|selhurst|craven|goodison|villa\s+park|"
    r"atmosphere|gates?\s+open|welcome\s+to|matchday\s+(vibes?|ready)|"
    r"looks\s+(a\s+)?(picture|treat)|the\s+stage\s+is|empty\s+seats)\b",
    re.I,
)
# Countdown teasers ("Team news in 🔟...", "team news coming soon") precede the XI.
TEASER_CAPTION = re.compile(
    r"team\s*news\s+(in\s*(\d|🔟|\S\ufe0f?\u20e3|ten|five|a\s+few|\.{2,}|…)|"
    r"(coming|is\s+coming|incoming|soon|shortly|next|to\s+follow|on\s+(its|the)\s+way|drops?))",
    re.I,
)


def in_lineup_slot(created: datetime, ko: datetime) -> bool:
    mins_before = (ko - created).total_seconds() / 60.0
    return SLOT_MIN_BEFORE_KO <= mins_before <= SLOT_MAX_BEFORE_KO


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
    if TEASER_CAPTION.search(t):
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


def fxtwitter_tweet(tweet_id: str) -> dict | None:
    """Unfurl a public status when X recent-search missed it or hid media."""
    url = f"{FXTWITTER}/status/{tweet_id}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None
    tweet = payload.get("tweet") if isinstance(payload, dict) else None
    return tweet if isinstance(tweet, dict) else None


def fxtwitter_photos(tweet_id: str) -> list[dict]:
    """Some club XI posts omit attachments in X API — fxtwitter still has photos."""
    tweet = fxtwitter_tweet(tweet_id)
    if not tweet:
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


def fxtwitter_created(tweet: dict) -> datetime | None:
    raw = tweet.get("created_at")
    if isinstance(raw, str) and raw:
        # "Sun Oct 25 12:45:30 +0000 2026"
        try:
            return datetime.strptime(raw, "%a %b %d %H:%M:%S %z %Y")
        except ValueError:
            pass
    ts = tweet.get("created_timestamp")
    if ts is not None:
        try:
            return datetime.fromtimestamp(int(ts), tz=timezone.utc)
        except (TypeError, ValueError, OSError):
            return None
    return None


def parse_ingest_specs(argv: list[str]) -> list[tuple[str, str]]:
    """--ingest BHA:2114…  (repeatable). Lets us seed a known XI tweet."""
    out: list[tuple[str, str]] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        spec = ""
        if arg.startswith("--ingest="):
            spec = arg.split("=", 1)[1]
        elif arg == "--ingest" and i + 1 < len(argv):
            spec = argv[i + 1]
            i += 1
        i += 1
        if not spec or ":" not in spec:
            continue
        code, tid = spec.split(":", 1)
        code = code.strip().upper()
        tid = tid.strip()
        if code and tid.isdigit():
            out.append((code, tid))
    return out


def pick_from_fxtwitter(tweet_id: str, ko: datetime) -> dict | None:
    """Score a known status (used by --ingest and as a search miss fallback)."""
    tweet = fxtwitter_tweet(tweet_id)
    if not tweet:
        return None
    created = fxtwitter_created(tweet)
    if not created:
        return None
    text = tweet.get("text") or tweet.get("raw_text") or ""
    if isinstance(text, dict):
        text = text.get("text") or ""
    photos = []
    media = tweet.get("media") if isinstance(tweet.get("media"), dict) else {}
    for photo in media.get("photos") or []:
        if not isinstance(photo, dict):
            continue
        url = (photo.get("url") or "").split("?")[0]
        if not url:
            continue
        photos.append(
            {
                "url": url,
                "alt_text": photo.get("altText") or photo.get("alt_text") or "",
                "width": photo.get("width"),
                "height": photo.get("height"),
            }
        )
    if not photos:
        return None
    fake = {
        "id": str(tweet.get("id") or tweet_id),
        "created_at": created.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "text": str(text),
        "attachments": {"media_keys": [f"fx-{i}" for i in range(len(photos))]},
    }
    media_by_key = {f"fx-{i}": {**p, "type": "photo", "url": p["url"]} for i, p in enumerate(photos)}
    return pick_best([fake], media_by_key, ko)


def ocr_lineup_stats(image_url: str) -> dict:
    """OCR a candidate photo. Lineup cards are dense with surnames.

    Multi-image posts often lead with a promo still; the lineup card is later.
    Stadium / kickoff teasers can OCR 'TEAM NEWS' chrome without naming anyone.
    """
    empty = {"score": 0.0, "nameCount": 0, "text": ""}
    import shutil
    import subprocess

    if not shutil.which("tesseract"):
        return empty
    fetch_url = image_url
    if "pbs.twimg.com" in image_url and "name=" not in image_url:
        fetch_url = f"{image_url}?name=large"
    try:
        req = urllib.request.Request(fetch_url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
    except Exception:
        return empty
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
            return empty
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
    text_n = normalize_text(text).upper()
    # Surname-like tokens (lineup cards are dense with these)
    tokens = re.findall(r"\b[A-Z][A-Z'’\-]{2,}\b", text_n)
    # Drop very common OCR junk / short UI words / venue chrome
    stop = {
        "THE", "AND", "FOR", "YOU", "OUR", "VIA", "WITH", "FROM", "THIS",
        "THAT", "YOUR", "TEAM", "NEWS", "PRESENTED", "SPONSORED", "KICK",
        "OFF", "STADIUM", "AMEX", "ANFIELD", "PREMIER", "LEAGUE", "LIVE",
        "VERSUS", "KICKOFF",
    }
    names = [t for t in tokens if t not in stop]
    score = float(min(len(names), 18) * 4.0)  # up to +72
    if re.search(r"\bSUBS?\b|\bSUBSTITUTES?\b|\bBENCH\b", text_n):
        score += 25.0
    if re.search(r"\b(TEAM\s*NEWS|STARTING\s*XI|LINE[\s-]?UP)\b", text_n):
        score += 20.0
    # Dense name block = real sheet; sparse OCR = promo / stadium photo
    if len(names) >= 8:
        score += 20.0
    elif len(names) <= 2:
        score -= 30.0
    return {"score": score, "nameCount": len(names), "text": text}


def ocr_lineup_score(image_url: str) -> float:
    return float(ocr_lineup_stats(image_url).get("score") or 0.0)


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
        slot_ok = (
            in_lineup_slot(created, ko)
            and not NON_LINEUP_CAPTION.search(normalize_text(text))
            and not TEASER_CAPTION.search(normalize_text(text))
        )
        # Expand via fxtwitter when X hid attachments, or to recover full
        # carousels (some XI posts list only one image in search results).
        if (HINT.search(normalize_text(text)) and len(candidates) <= 1) or (
            slot_ok and not candidates
        ):
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
        ocr_names: dict[str, int] = {}
        if len(candidates) > 1:
            for media in candidates:
                u = media["url"]
                stats = ocr_lineup_stats(u)
                ocr_bonus[u] = float(stats["score"])
                ocr_names[u] = int(stats["nameCount"])
                time.sleep(0.05)

        for media in candidates:
            alt = media.get("alt_text") or ""
            sc = score_candidate(
                text,
                alt,
                has_photo=True,
                created=created,
                ko=ko,
            )
            evidence = lineup_evidence(text, alt)
            if sc < 0:
                evidence = "ocr"
                if not slot_ok or (alt and NON_LINEUP_ALT.search(normalize_text(alt))):
                    continue
                if media["url"] not in ocr_bonus:
                    stats = ocr_lineup_stats(media["url"])
                    ocr_bonus[media["url"]] = float(stats["score"])
                    ocr_names[media["url"]] = int(stats["nameCount"])
                # Stadium teasers often OCR "TEAM NEWS" / "KICK OFF" chrome
                # without listing an XI — require a dense name sheet.
                if (
                    ocr_bonus[media["url"]] < SLOT_MIN_OCR
                    or ocr_names.get(media["url"], 0) < OCR_ONLY_MIN_NAMES
                ):
                    continue
                mins_before = (ko - created).total_seconds() / 60.0
                sc = 100.0 - abs(mins_before - 75.0) * 0.6 - SLOT_OCR_PENALTY
            elif evidence == "weak":
                if media["url"] not in ocr_bonus:
                    stats = ocr_lineup_stats(media["url"])
                    ocr_bonus[media["url"]] = float(stats["score"])
                    ocr_names[media["url"]] = int(stats["nameCount"])
                if ocr_bonus[media["url"]] < WEAK_MIN_OCR:
                    continue
            # Weak wording only uses OCR as a gate: busy photos (bus livery,
            # crowds) OCR high and must not outrank an explicit "Your XI" post.
            if evidence != "weak":
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
                    "evidence": evidence,
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


def write_bundle(
    gw: int,
    teams: list[dict],
    generated: str,
    bootstrap: dict | None = None,
    *,
    force_annotate: bool = False,
) -> list[dict]:
    # Most recent left-most for the UI swipe track
    annotated = (
        annotate_teams(teams, bootstrap or {}, SITE, force=force_annotate)
        if bootstrap
        else list(teams or [])
    )
    ordered = sorted(annotated, key=lambda t: t.get("postedAt") or "", reverse=True)
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
    return annotated


ACTIVE_BEFORE_KO = timedelta(minutes=120)
# Searches stay capped at KO+30; the long tail only lets a late run catch up.
ACTIVE_AFTER_KO = timedelta(minutes=120)
# XI graphics land ~KO-75, so poll densely just after that, then sparse catch-ups.
POLL_OFFSETS_MIN = (-90, -70, -64, -58, -50, -40, -25, -5, 30, 110)
# A stored graphic at/above this score stops further polling for that club.
DONE_MIN_SCORE = 120.0
NEXT_POLL_HORIZON = timedelta(hours=6)


def club_is_done(state: dict, gw: int, code: str) -> bool:
    if state.get("gw") != gw:
        return False
    row = (state.get("teams") or {}).get(code) or {}
    if row.get("evidence") in ("weak", "ocr"):
        return False
    # Stadium teasers can score on timing alone — require a named XI sheet.
    named_n = int(row.get("namedCount") or 0)
    if not (row.get("namedReady") or named_n >= 8):
        return False
    return bool(row.get("localPath")) and float(row.get("score") or 0) >= DONE_MIN_SCORE


def next_poll_seconds(club_fixtures: dict, state: dict, gw: int) -> int | None:
    """Seconds until the next checkpoint for a club still missing a graphic."""
    now = datetime.now(timezone.utc)
    best: datetime | None = None
    for code, fxinfo in club_fixtures.items():
        ko = parse_iso(fxinfo["ko"])
        if not ko or club_is_done(state, gw, code):
            continue
        for off in POLL_OFFSETS_MIN:
            at = ko + timedelta(minutes=off)
            if at <= now + timedelta(seconds=30) or at > now + NEXT_POLL_HORIZON:
                continue
            if best is None or at < best:
                best = at
    if best is None:
        return None
    return max(0, int((best - now).total_seconds()))


def load_bootstrap_local() -> dict | None:
    snaps = sorted((ROOT / "snapshots").glob("bootstrap-static_*.json"), reverse=True)
    if not snaps:
        return None
    try:
        data = json.loads(snaps[0].read_text(encoding="utf-8"))
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def persist_pick(
    state: dict,
    *,
    gw: int,
    code: str,
    club: dict,
    fxinfo: dict,
    best: dict,
    now: str,
) -> bool:
    """Download + store a scored pick. Returns True when the file changed."""
    prev = (state.get("teams") or {}).get(code) or {}
    if (
        prev.get("tweetId") == best["tweetId"]
        and prev.get("mediaUrl") == best.get("mediaUrl")
        and prev.get("localPath")
    ):
        local = SITE / prev["localPath"]
        if local.exists():
            print(
                f"  ✓ {code} @{club['xHandle']}: unchanged {best['tweetId']} "
                f"(Δko={best['minsBeforeKo']}m)"
            )
            return False
    dest = download_image(best["mediaUrl"], MEDIA_DIR / f"gw{gw}" / code)
    rel = str(dest.relative_to(SITE)).replace("\\", "/")
    opp = fxinfo["away"] if fxinfo["ha"] == "H" else fxinfo["home"]
    row = {
        "code": code,
        "name": club["name"],
        "handle": club["xHandle"],
        "tweetId": best["tweetId"],
        "tweetUrl": f"https://x.com/{club['xHandle']}/status/{best['tweetId']}",
        "postedAt": best["postedAt"],
        "kickoff": fxinfo["ko"],
        "minsBeforeKo": best["minsBeforeKo"],
        "match": f"{fxinfo['home']} v {fxinfo['away']}",
        "opp": opp,
        "ha": fxinfo["ha"],
        "text": (best.get("text") or "")[:240],
        "altText": (best.get("altText") or "")[:800],
        "localPath": rel,
        "mediaUrl": best["mediaUrl"],
        "width": best.get("width"),
        "height": best.get("height"),
        "score": best["score"],
        "evidence": best.get("evidence"),
        "fetchedAt": now,
    }
    state.setdefault("teams", {})[code] = row
    print(
        f"  ✓ {code} @{club['xHandle']}: saved {rel} "
        f"(Δko={best['minsBeforeKo']}m score={best['score']})"
    )
    return True


def main() -> int:
    active_only = "--active-only" in sys.argv[1:]
    next_poll = "--next-poll" in sys.argv[1:]
    annotate_only = "--annotate-only" in sys.argv[1:]
    ingest_specs = parse_ingest_specs(sys.argv[1:])
    bearer = os.environ.get("X_BEARER_TOKEN", "").strip()
    if annotate_only:
        bootstrap = None
        try:
            bootstrap = fpl_get("/bootstrap-static/")
        except Exception:
            bootstrap = load_bootstrap_local()
        if not isinstance(bootstrap, dict):
            print("No bootstrap-static — cannot annotate lineups.", file=sys.stderr)
            return 1
        state = load_state()
        gw = state.get("gw")
        teams = list((state.get("teams") or {}).values())
        now = generated_at()
        annotated = write_bundle(int(gw or 0), teams, now, bootstrap, force_annotate=True)
        state["teams"] = {t["code"]: t for t in annotated if t.get("code")}
        state["generatedAt"] = now
        save_state(state)
        ready = sum(1 for t in annotated if t.get("namedReady"))
        print(f"Annotated {len(annotated)} graphics ({ready} lineup-ready) → {OUT_JS.name}")
        return 0
    if not bearer and not ingest_specs:
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
    if next_poll:
        secs = next_poll_seconds(club_fixtures, state, gw)
        print("none" if secs is None else secs)
        return 0
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

    if ingest_specs:
        for code, tweet_id in ingest_specs:
            fxinfo = club_fixtures.get(code)
            club = by_code.get(code)
            if not fxinfo or not club:
                print(f"  · {code}: no fixture / handle for ingest {tweet_id}")
                errors += 1
                continue
            ko = parse_iso(fxinfo["ko"])
            if not ko:
                print(f"  · {code}: bad kickoff for ingest")
                errors += 1
                continue
            best = pick_from_fxtwitter(tweet_id, ko)
            if not best:
                print(f"  · {code}: fxtwitter miss for {tweet_id}")
                errors += 1
                continue
            try:
                if persist_pick(
                    state, gw=gw, code=code, club=club, fxinfo=fxinfo, best=best, now=now
                ):
                    updated += 1
            except Exception as e:
                print(f"  · {code}: ingest download failed: {e}")
                errors += 1
        teams = [t for t in (state.get("teams") or {}).values() if t.get("code") in club_fixtures]
        annotated = write_bundle(gw, teams, now, bootstrap)
        state["gw"] = gw
        state["teams"] = {t["code"]: t for t in annotated if t.get("code")}
        state["generatedAt"] = now
        save_state(state)
        print(
            f"\nIngest GW{gw}: {len(teams)} graphics stored, {updated} new/updated, "
            f"{errors} errors → {OUT_JS.name}"
        )
        return 0 if errors == 0 or teams else 1

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
            if club_is_done(state, gw, code):
                print(f"  ✓ {code} @{handle}: already have graphic — skip")
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

        try:
            if persist_pick(
                state, gw=gw, code=code, club=club, fxinfo=fxinfo, best=best, now=now
            ):
                updated += 1
        except Exception as e:
            print(f"  · {code} @{handle}: download failed: {e}")
            errors += 1
            continue

    if active_only and not updated and not gw_changed:
        existing = list((state.get("teams") or {}).values())
        if existing and all(t.get("namedReady") or not t.get("localPath") for t in existing):
            print(f"\nGW{gw}: no new graphics — bundle unchanged.")
            return 0 if errors == 0 else 1

    teams = list((state.get("teams") or {}).values())
    # Only keep clubs still in this GW fixture list
    teams = [t for t in teams if t.get("code") in club_fixtures]
    annotated = write_bundle(gw, teams, now, bootstrap)
    state["gw"] = gw
    state["teams"] = {t["code"]: t for t in annotated if t.get("code")}
    state["generatedAt"] = now
    save_state(state)

    print(
        f"\nDone GW{gw}: {len(teams)} graphics stored, {updated} new/updated, "
        f"{errors} errors → {OUT_JS.name}"
    )
    return 0 if errors == 0 or teams else 1


if __name__ == "__main__":
    raise SystemExit(main())
