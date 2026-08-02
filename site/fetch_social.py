#!/usr/bin/env python3
"""
Fetch recent posts for curated X accounts into site/social_data.js.

Setup (one-time):
  1. Create an app at https://developer.x.com (pay-per-use / read access).
  2. Copy a Bearer Token from the developer console.
  3. Paste it into the project-root .env file:
       X_BEARER_TOKEN=your_token_here
     (or export X_BEARER_TOKEN='…' in the shell)

Run:
  python3 site/fetch_social.py

Optional:
  POSTS_PER_ACCOUNT=40 python3 site/fetch_social.py
  WINDOW_HOURS=48 python3 site/fetch_social.py

Keeps a rolling ~48h window of original posts. The static site only reads
social_data.js — the token never ships to Vercel.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent
ENV_PATH = ROOT / ".env"
ACCOUNTS_PATH = SITE / "social_accounts.json"
OUT_PATH = SITE / "social_data.js"
API_BASE = "https://api.x.com/2"


def load_dotenv(path: Path = ENV_PATH) -> None:
    """Load KEY=VALUE pairs from .env into os.environ (does not override existing)."""
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

POSTS_PER_ACCOUNT = max(5, min(100, int(os.environ.get("POSTS_PER_ACCOUNT", "40"))))
# Hard time window for the Feed (player-mention cards).
WINDOW_HOURS = max(6, min(168, int(os.environ.get("WINDOW_HOURS", "48"))))
# Cap after the time prune so the static file stays small.
MAX_POSTS_RETAINED = max(50, int(os.environ.get("MAX_POSTS_RETAINED", "400")))

TWEET_FIELDS = ",".join(
    [
        "created_at",
        "public_metrics",
        "lang",
        "possibly_sensitive",
        "conversation_id",
        "in_reply_to_user_id",
        "referenced_tweets",
        "attachments",
        "entities",
    ]
)
USER_FIELDS = ",".join(["name", "username", "profile_image_url", "verified", "public_metrics"])
MEDIA_FIELDS = ",".join(["type", "url", "preview_image_url", "width", "height", "alt_text"])


def load_accounts() -> list[dict]:
    raw = json.loads(ACCOUNTS_PATH.read_text(encoding="utf-8"))
    accounts = raw.get("accounts") or []
    if not accounts:
        raise SystemExit(f"No accounts listed in {ACCOUNTS_PATH}")
    out = []
    for a in accounts:
        handle = (a.get("handle") or "").lstrip("@").strip()
        if not handle:
            continue
        roles = a.get("roles") or ([] if not a.get("role") else [a.get("role")])
        out.append(
            {
                "handle": handle,
                "label": a.get("label") or handle,
                "userId": a.get("userId"),
                "roles": [r for r in roles if r],
            }
        )
    if not out:
        raise SystemExit(f"No valid handles in {ACCOUNTS_PATH}")
    return out


def load_existing() -> dict:
    if not OUT_PATH.exists():
        return {"accounts": [], "posts": []}
    text = OUT_PATH.read_text(encoding="utf-8").strip()
    m = re.search(r"window\.FPL_SOCIAL\s*=\s*(\{.*\})\s*;?\s*$", text, re.S)
    if not m:
        return {"accounts": [], "posts": []}
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return {"accounts": [], "posts": []}


def api_get(path: str, params: dict | None = None) -> dict:
    token = os.environ.get("X_BEARER_TOKEN", "").strip()
    if not token:
        raise SystemExit(
            "Missing X_BEARER_TOKEN.\n"
            "Paste your Bearer Token into the project .env file:\n"
            f"  {ENV_PATH}\n"
            "  X_BEARER_TOKEN=your_token_here\n"
            "Or: export X_BEARER_TOKEN='…' then python3 site/fetch_social.py"
        )
    qs = f"?{urllib.parse.urlencode(params)}" if params else ""
    url = f"{API_BASE}{path}{qs}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": "FPL-Explorer-Feed/0.1",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"X API HTTP {e.code} for {path}: {body}") from e
    except urllib.error.URLError as e:
        raise SystemExit(f"X API network error for {path}: {e}") from e


def resolve_user(handle: str, cached_id: str | None, cached_account: dict | None = None) -> dict:
    """
    Resolve an X user. When we already have userId + profile fields cached,
    skip the paid user lookup (~$0.01) unless FORCE_USER_REFRESH=1.
    """
    force = os.environ.get("FORCE_USER_REFRESH", "").strip() in ("1", "true", "yes")
    cached_account = cached_account or {}
    if (
        not force
        and cached_id
        and cached_account.get("name")
        and cached_account.get("handle")
    ):
        return {
            "id": cached_id,
            "username": cached_account.get("handle") or handle,
            "name": cached_account.get("name"),
            "profile_image_url": cached_account.get("avatarUrl"),
            "verified": cached_account.get("verified"),
            "public_metrics": cached_account.get("publicMetrics"),
        }
    if cached_id and force:
        data = api_get(
            f"/users/{cached_id}",
            {"user.fields": USER_FIELDS},
        )
        user = data.get("data") or {}
        if user.get("id"):
            return user
    data = api_get(
        f"/users/by/username/{urllib.parse.quote(handle)}",
        {"user.fields": USER_FIELDS},
    )
    user = data.get("data")
    if not user:
        raise SystemExit(f"Could not resolve @{handle}: {data}")
    return user


def fetch_user_tweets(user_id: str, since_id: str | None) -> tuple[list[dict], dict]:
    params = {
        "max_results": str(min(100, max(5, POSTS_PER_ACCOUNT))),
        "tweet.fields": TWEET_FIELDS,
        "expansions": "attachments.media_keys,author_id,referenced_tweets.id",
        "media.fields": MEDIA_FIELDS,
        "user.fields": USER_FIELDS,
        "exclude": "retweets",
    }
    if since_id:
        params["since_id"] = since_id
    data = api_get(f"/users/{user_id}/tweets", params)
    tweets = data.get("data") or []
    includes = data.get("includes") or {}
    return tweets, includes


def media_index(includes: dict) -> dict[str, dict]:
    out = {}
    for m in includes.get("media") or []:
        key = m.get("media_key")
        if key:
            out[key] = m
    return out


def normalize_post(tweet: dict, account: dict, media_by_key: dict[str, dict]) -> dict:
    metrics = tweet.get("public_metrics") or {}
    media = []
    for key in (tweet.get("attachments") or {}).get("media_keys") or []:
        m = media_by_key.get(key)
        if not m:
            continue
        media.append(
            {
                "type": m.get("type"),
                "url": m.get("url") or m.get("preview_image_url"),
                "previewImageUrl": m.get("preview_image_url"),
                "width": m.get("width"),
                "height": m.get("height"),
                "altText": m.get("alt_text"),
            }
        )
    handle = account["handle"]
    post_id = tweet["id"]
    refs = tweet.get("referenced_tweets") or []
    return {
        "id": post_id,
        "handle": handle,
        "authorName": account.get("name") or account.get("label") or handle,
        "authorAvatarUrl": account.get("avatarUrl"),
        "text": tweet.get("text") or "",
        "createdAt": tweet.get("created_at"),
        "lang": tweet.get("lang"),
        "conversationId": tweet.get("conversation_id"),
        "inReplyToUserId": tweet.get("in_reply_to_user_id"),
        "referencedTweets": refs,
        "url": f"https://x.com/{handle}/status/{post_id}",
        "metrics": {
            "likes": metrics.get("like_count"),
            "reposts": metrics.get("retweet_count"),
            "replies": metrics.get("reply_count"),
            "quotes": metrics.get("quote_count"),
            "bookmarks": metrics.get("bookmark_count"),
            "impressions": metrics.get("impression_count"),
        },
        "media": media,
        "entities": tweet.get("entities"),
    }


def newest_id_for_handle(posts: list[dict], handle: str) -> str | None:
    ids = [p["id"] for p in posts if p.get("handle") == handle and p.get("id")]
    if not ids:
        return None
    return max(ids, key=lambda x: int(x))


def parse_created_at(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        # X returns e.g. 2026-08-01T12:34:56.000Z
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def prune_to_window(posts: list[dict], *, hours: int, now: datetime | None = None) -> tuple[list[dict], int]:
    """Keep posts created within the last `hours`. Returns (kept, dropped_count)."""
    now = now or datetime.now(timezone.utc)
    cutoff = now.timestamp() - hours * 3600
    kept = []
    dropped = 0
    for p in posts:
        created = parse_created_at(p.get("createdAt"))
        if created is None:
            kept.append(p)
            continue
        if created.timestamp() >= cutoff:
            kept.append(p)
        else:
            dropped += 1
    return kept, dropped


def write_output(payload: dict) -> None:
    body = "window.FPL_SOCIAL = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    OUT_PATH.write_text(body, encoding="utf-8")


def main() -> None:
    curated = load_accounts()
    existing = load_existing()
    prior_posts = existing.get("posts") or []
    prior_accounts = {a.get("handle"): a for a in (existing.get("accounts") or []) if a.get("handle")}

    accounts_out = []
    new_posts: list[dict] = []
    fetched_counts: list[tuple[str, int]] = []

    for entry in curated:
        handle = entry["handle"]
        cached = prior_accounts.get(handle) or {}
        user = resolve_user(
            handle,
            cached.get("userId") or entry.get("userId"),
            cached_account=cached,
        )
        account = {
            "handle": user.get("username") or handle,
            "label": entry.get("label") or user.get("name") or handle,
            "userId": user.get("id"),
            "name": user.get("name"),
            "avatarUrl": user.get("profile_image_url"),
            "verified": user.get("verified"),
            "publicMetrics": user.get("public_metrics"),
            "roles": entry.get("roles") or cached.get("roles") or [],
        }
        accounts_out.append(account)

        since_id = newest_id_for_handle(prior_posts, account["handle"])
        tweets, includes = fetch_user_tweets(account["userId"], since_id)
        media_by_key = media_index(includes)
        batch = [normalize_post(t, account, media_by_key) for t in tweets]
        new_posts.extend(batch)
        fetched_counts.append((account["handle"], len(batch)))
        print(f"@{account['handle']}: fetched {len(batch)} post(s)" + (f" (since_id={since_id})" if since_id else ""))

    # Merge by post id: keep prior posts, upsert this run (no duplicates).
    prior_ids = {p["id"] for p in prior_posts if p.get("id")}
    by_id = {p["id"]: p for p in prior_posts if p.get("id")}
    truly_new_ids = []
    for p in new_posts:
        if p["id"] not in prior_ids:
            truly_new_ids.append(p["id"])
        # Preserve prior LLM/heuristic analysis when re-fetching the same id.
        prior = by_id.get(p["id"])
        if prior and prior.get("analysis") and not p.get("analysis"):
            p = {**p, "analysis": prior["analysis"]}
        by_id[p["id"]] = p
    merged = sorted(by_id.values(), key=lambda p: int(p["id"]), reverse=True)

    # Drop posts for handles no longer curated, prune to the time window,
    # then enforce a retention cap.
    keep_handles = {a["handle"] for a in accounts_out}
    merged = [p for p in merged if p.get("handle") in keep_handles]
    merged, dropped_for_age = prune_to_window(merged, hours=WINDOW_HOURS)
    dropped_for_cap = max(0, len(merged) - MAX_POSTS_RETAINED)
    merged = merged[:MAX_POSTS_RETAINED]

    newest_by_handle = {
        a["handle"]: newest_id_for_handle(merged, a["handle"]) for a in accounts_out
    }

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    prior_meta = existing.get("meta") or {}
    analysis_meta = prior_meta.get("analysis")
    if analysis_meta:
        analysis_meta = {
            **analysis_meta,
            "postsWithAnalysis": sum(1 for p in merged if p.get("analysis")),
        }
    payload = {
        "generatedAt": generated,
        "accounts": accounts_out,
        "posts": merged,
        "meta": {
            # Browser refreshes never hit X — only this script does.
            "source": "x-api-v2",
            "chargedOn": "fetch_social.py only (not page load)",
            "windowHours": WINDOW_HOURS,
            "postsPerAccount": POSTS_PER_ACCOUNT,
            "maxPostsRetained": MAX_POSTS_RETAINED,
            "fetchedThisRun": {h: n for h, n in fetched_counts},
            "newPostIds": truly_new_ids,
            "newPostCount": len(truly_new_ids),
            "totalPosts": len(merged),
            "priorPostCount": len(prior_ids),
            "droppedForAge": dropped_for_age,
            "droppedForRetentionCap": dropped_for_cap,
            "newestIdByHandle": newest_by_handle,
            # Incremental pulls use since_id = newest kept id per handle.
            "incremental": True,
            # Carry forward; refresh with: python3 site/annotate_social.py
            "analysis": analysis_meta,
        },
    }
    write_output(payload)

    print(f"\nWrote {OUT_PATH.name}: {len(merged)} post(s), {len(accounts_out)} account(s)")
    print(f"generatedAt: {generated}")
    print(f"Window: last {WINDOW_HOURS}h (dropped {dropped_for_age} older)")
    print(f"New since last fetch: {len(truly_new_ids)} (deduped by id; since_id incremental)")
    if merged:
        sample = merged[0]
        keys = sorted(sample.keys())
        print(f"Sample post fields: {', '.join(keys)}")
        metrics = sample.get("metrics") or {}
        print(
            "Sample metrics: "
            + ", ".join(f"{k}={v}" for k, v in metrics.items() if v is not None)
        )
        if sample.get("media"):
            print(f"Sample media: {len(sample['media'])} item(s), types={[m.get('type') for m in sample['media']]}")
    else:
        print("No posts in output yet (accounts may have no recent original posts).")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
