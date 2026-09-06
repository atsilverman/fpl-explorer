"""Slim FPL availability fields from bootstrap-static elements."""
from __future__ import annotations


def _chance(value) -> int | None:
    if value is None or value == "":
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    if n < 0 or n > 100:
        return None
    return n


def player_availability_fields(el: dict | None) -> dict:
    """Extract availability for site bundles (distinct from match-outcome status)."""
    e = el or {}
    status = (e.get("status") or "a").strip().lower() or "a"
    news = (e.get("news") or "").strip() or None
    news_added = e.get("news_added") or None
    news_url = (e.get("scout_news_link") or "").strip() or None
    out = {
        "availStatus": status,
        "chanceThis": _chance(e.get("chance_of_playing_this_round")),
        "chanceNext": _chance(e.get("chance_of_playing_next_round")),
    }
    if news:
        out["news"] = news
    if news_added:
        out["newsAdded"] = news_added
    if news_url:
        out["newsUrl"] = news_url
    return out
