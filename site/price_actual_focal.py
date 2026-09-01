"""FPL Focal X posts — parse nightly price changes and re-attribute backfill dates."""
from __future__ import annotations

import json
import re
import sys
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime

from price_changes_lib import (
    LONDON,
    PRICE_ACTUAL_DIR,
    bootstrap_snapshot_paths,
    uk_midnight_utc_iso_for_date,
)

FOCAL_HANDLE = "FPLFocal"
FXTWITTER_API = "https://api.fxtwitter.com"
FOCAL_NIGHTS_CACHE = PRICE_ACTUAL_DIR / "focal-nights.json"
# Nightly "Price Changes" posts (newest first).
FOCAL_PRICE_TWEET_IDS = [
    "2094561658135834948",
    "2094199341086892132",
    "2093837591304921527",
    "2093474408975204687",
    "2093112838763987035",
    "2092749943182090276",
    "2092386935662575839",
]

# Tweet text aliases → bootstrap web_name
NAME_ALIASES: dict[str, str] = {
    "sangare": "M.Sangaré",
    "sangaré": "M.Sangaré",
    "de cuyper": "De Cuyper",
    "fernandes (the other one)": "Fernandes",
    "bruno g.": "Bruno G.",
    "p.m.sarr": "P.M.Sarr",
    "e.le fee": "E.Le Fée",
    "kroupi.jr": "Kroupi.Jr",
    "ait-nouri": "Aït-Nouri",
    "kadioglu": "Kadıoğlu",
    "odegaard": "Ødegaard",
    "joao pedro": "João Pedro",
    "estevao": "Estêvão",
    "sanchez": "Sánchez",
    "munoz": "Muñoz",
    "gibbs-white": "Gibbs-White",
}


def _norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", s.strip().lower())


def fetch_focal_tweet(tweet_id: str) -> dict:
    url = f"{FXTWITTER_API}/{FOCAL_HANDLE}/status/{tweet_id}"
    req = urllib.request.Request(url, headers={"User-Agent": "fpl-explorer/1.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.load(resp)
    tweet = payload.get("tweet")
    if not isinstance(tweet, dict):
        raise ValueError(f"unexpected fxtwitter payload for {tweet_id}")
    return tweet


def focal_change_night_uk(created_at: str) -> str:
    """UK calendar date of the 00:00 price change (tweet posts ~00:03 UK)."""
    dt = datetime.strptime(created_at, "%a %b %d %H:%M:%S %z %Y")
    return dt.astimezone(LONDON).strftime("%Y-%m-%d")


def parse_focal_price_tweet(text: str) -> tuple[list[str], list[str]]:
    text = re.sub(r"https?://\S+", "", text)
    if "📈" not in text:
        return [], []

    pre, post_rise = text.split("📈", 1)
    rise_text = pre.split("✅")[-1] if "✅" in pre else pre
    rises = _split_names(rise_text)

    falls: list[str] = []
    if "📉" in post_rise:
        fall_text = post_rise.split("📉", 1)[0]
        fall_text = re.sub(r"^\+0\.1m\s*", "", fall_text, flags=re.I)
        falls = _split_names(fall_text)

    return rises, falls


def _split_names(block: str) -> list[str]:
    block = re.sub(r"[📈📉✅]", "", block)
    block = re.sub(r"[+-]0\.1m", "", block, flags=re.I)
    names: list[str] = []
    for raw in re.split(r"[,،\n]+", block):
        name = raw.strip()
        name = re.sub(r"\s+are the main ones\.?$", "", name, flags=re.I)
        name = re.sub(r"\s*\+\s*", " + ", name)
        if not name:
            continue
        if " + " in name:
            names.extend(part.strip() for part in name.split(" + ") if part.strip())
        else:
            names.append(name)
    return names


def player_lookup(snap: dict) -> dict[str, list[dict]]:
    teams = {t["id"]: t.get("short_name") for t in snap.get("teams") or []}
    by_norm: dict[str, list[dict]] = {}
    for e in snap.get("elements") or []:
        code = e.get("code")
        if code is None:
            continue
        web = e.get("web_name") or ""
        second = e.get("second_name") or ""
        row = {
            "code": int(code),
            "name": web,
            "team": teams.get(e.get("team")),
            "position": e.get("element_type"),
        }
        for label in {web, second, f"{web} {second}".strip()}:
            if label:
                by_norm.setdefault(_norm_name(label), []).append(row)
    return by_norm


def resolve_name(name: str, lookup: dict[str, list[dict]]) -> dict | None:
    alias = NAME_ALIASES.get(_norm_name(name))
    if alias:
        name = alias
    key = _norm_name(name)
    hits = lookup.get(key, [])
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        # Prefer exact web_name match
        for h in hits:
            if _norm_name(h["name"]) == key:
                return h
        return hits[0]
    # partial
    partial = [h for k, rows in lookup.items() for h in rows if key in k or k in key]
    if len(partial) == 1:
        return partial[0]
    return None


def load_snapshots_by_date() -> dict[str, dict]:
    out: dict[str, dict] = {}
    for path in bootstrap_snapshot_paths():
        from price_changes_lib import bootstrap_snapshot_date

        day = bootstrap_snapshot_date(path)
        try:
            out[day] = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
    return out


def cost_on_date(snapshots: dict[str, dict], code: int, date: str) -> int | None:
    snap = snapshots.get(date)
    if not snap:
        return None
    for e in snap.get("elements") or []:
        if int(e.get("code") or 0) == code:
            return int(e.get("now_cost") or 0)
    return None


def pick_night_for_event(
    code: int,
    direction: str,
    before: float,
    after: float,
    nights: list[str],
    snapshots: dict[str, dict],
) -> str | None:
    dates = sorted(snapshots)
    before_t = int(round(before * 10))
    after_t = int(round(after * 10))
    matches: list[str] = []
    for night in nights:
        prev_dates = [d for d in dates if d < night]
        next_dates = [d for d in dates if d >= night]
        if not prev_dates or not next_dates:
            continue
        prev_cost = cost_on_date(snapshots, code, prev_dates[-1])
        next_cost = cost_on_date(snapshots, code, next_dates[0])
        if prev_cost == before_t and next_cost == after_t:
            matches.append(night)
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        return matches[-1]
    return nights[0] if len(nights) == 1 else None


def save_focal_nights_cache(nights: list[dict]) -> None:
    PRICE_ACTUAL_DIR.mkdir(parents=True, exist_ok=True)
    FOCAL_NIGHTS_CACHE.write_text(
        json.dumps(nights, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )


def load_focal_nights_cache() -> list[dict]:
    if not FOCAL_NIGHTS_CACHE.exists():
        return []
    try:
        data = json.loads(FOCAL_NIGHTS_CACHE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def load_focal_nights(snap: dict | None = None, *, fetch: bool = True) -> list[dict]:
    if snap is None:
        paths = bootstrap_snapshot_paths()
        if not paths:
            return []
        snap = json.loads(paths[-1].read_text(encoding="utf-8"))
    lookup = player_lookup(snap)
    nights: list[dict] = []

    for tweet_id in FOCAL_PRICE_TWEET_IDS:
        try:
            if fetch:
                tweet = fetch_focal_tweet(tweet_id)
            else:
                continue
        except (urllib.error.URLError, ValueError, json.JSONDecodeError) as exc:
            print(f"skip focal tweet {tweet_id}: {exc}", file=sys.stderr)
            continue
        rises, falls = parse_focal_price_tweet(tweet.get("text") or "")
        uk_date = focal_change_night_uk(tweet["created_at"])
        rise_codes: list[int] = []
        fall_codes: list[int] = []
        for name in rises:
            row = resolve_name(name, lookup)
            if row:
                rise_codes.append(row["code"])
            else:
                print(f"unmapped rise '{name}' ({uk_date})", file=sys.stderr)
        for name in falls:
            row = resolve_name(name, lookup)
            if row:
                fall_codes.append(row["code"])
            else:
                print(f"unmapped fall '{name}' ({uk_date})", file=sys.stderr)
        nights.append(
            {
                "ukDate": uk_date,
                "tweetId": tweet_id,
                "rises": rise_codes,
                "falls": fall_codes,
            }
        )
    nights.sort(key=lambda n: n["ukDate"])
    if fetch and nights:
        save_focal_nights_cache(nights)
    return nights


def load_focal_nights_cached_or_fetch(snap: dict | None = None) -> list[dict]:
    cached = load_focal_nights_cache()
    if cached:
        return cached
    return load_focal_nights(snap, fetch=True)


def snapshot_supports_night(
    code: int,
    before: float,
    after: float,
    night: str,
    snapshots: dict[str, dict],
) -> bool:
    dates = sorted(snapshots)
    prev_dates = [d for d in dates if d < night]
    next_dates = [d for d in dates if d >= night]
    if not prev_dates or not next_dates:
        return False
    before_t = int(round(float(before) * 10))
    after_t = int(round(float(after) * 10))
    prev_c = cost_on_date(snapshots, code, prev_dates[-1])
    next_c = cost_on_date(snapshots, code, next_dates[0])
    return prev_c == before_t and next_c == after_t


def reattribute_events_with_focal(
    events: list[dict],
    focal_nights: list[dict],
    snapshots: dict[str, dict],
) -> tuple[list[dict], int]:
    by_cd: dict[tuple[int, str], list[str]] = {}
    for night in focal_nights:
        uk = night["ukDate"]
        for code in night["rises"]:
            by_cd.setdefault((int(code), "rise"), []).append(uk)
        for code in night["falls"]:
            by_cd.setdefault((int(code), "fall"), []).append(uk)

    changed = 0
    out: list[dict] = []
    for ev in events:
        code = int(ev.get("code") or 0)
        direction = ev.get("direction") or ""
        before = float(ev.get("before") or 0)
        after = float(ev.get("after") or 0)
        nights = by_cd.get((code, direction), [])
        supporting = [
            n
            for n in nights
            if snapshot_supports_night(code, before, after, n, snapshots)
        ]
        if not supporting:
            out.append(ev)
            continue
        if len(supporting) == 1:
            night = supporting[0]
        else:
            night = pick_night_for_event(
                code, direction, before, after, supporting, snapshots
            )
        if not night:
            out.append(ev)
            continue
        new_at = uk_midnight_utc_iso_for_date(night)
        if ev.get("changedAt") != new_at:
            ev = {**ev, "changedAt": new_at}
            changed += 1
        out.append(ev)
    return out, changed
