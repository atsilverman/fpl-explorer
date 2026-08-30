"""Extract previous / current / next gameweek from FPL bootstrap-static events."""
from __future__ import annotations

from datetime import datetime, timezone

DEADLINE_POLL_TAIL_SEC = 45 * 60


def slim_event(event: dict | None) -> dict | None:
    if not event:
        return None
    eid = event.get("id")
    if eid is None:
        return None
    return {
        "id": int(eid),
        "name": event.get("name") or f"Gameweek {eid}",
        "deadlineTime": event.get("deadline_time"),
        "finished": bool(event.get("finished")),
    }


def extract_gameweeks(bootstrap: dict | None, source: str | None = None) -> dict:
    """Return {previous, current, next, source} from bootstrap events flags.

    Each of previous/current/next is a slim event dict or None. Flags come
    straight from FPL (`is_previous` / `is_current` / `is_next`); at most one
    event carries each flag.
    """
    events = (bootstrap or {}).get("events") or []
    previous = next((e for e in events if e.get("is_previous")), None)
    current = next((e for e in events if e.get("is_current")), None)
    nxt = next((e for e in events if e.get("is_next")), None)
    return {
        "previous": slim_event(previous),
        "current": slim_event(current),
        "next": slim_event(nxt),
        "source": source,
    }


def parse_deadline_unix(deadline_time: str | None) -> float | None:
    """Parse FPL deadline_time ISO string to unix timestamp."""
    if not deadline_time or not isinstance(deadline_time, str):
        return None
    raw = deadline_time.strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def active_gameweek_id(gameweeks: dict | None) -> int | None:
    """GW the UI should treat as 'now': current if set, else next."""
    if not gameweeks:
        return None
    for key in ("current", "next"):
        row = gameweeks.get(key)
        if row and row.get("id") is not None:
            return int(row["id"])
    return None


def display_gameweek_id(gameweeks: dict | None) -> int | None:
    """Site-wide scoring/UI GW — FPL ``is_current`` only; preseason falls back to next."""
    return active_gameweek_id(gameweeks)


def post_deadline_before_next_current(
    gameweeks: dict | None, now_ts: float | None = None
) -> bool:
    """True when the next GW deadline passed but FPL still marks the prior GW current."""
    if not gameweeks:
        return False
    cur = gameweeks.get("current")
    nxt = gameweeks.get("next")
    if not cur or not nxt:
        return False
    try:
        cur_id = int(cur["id"])
        nxt_id = int(nxt["id"])
    except (KeyError, TypeError, ValueError):
        return False
    if cur_id >= nxt_id:
        return False
    dl = parse_deadline_unix(nxt.get("deadlineTime"))
    if dl is None:
        return False
    now = now_ts if now_ts is not None else datetime.now(timezone.utc).timestamp()
    return now >= dl


def picks_gameweek_id(gameweeks: dict | None, now_ts: float | None = None) -> int | None:
    """GW whose squad picks we should fetch.

    Once the next GW deadline has passed, return that GW (picks unlock window).
    Otherwise fall back to current/next like active_gameweek_id.
    """
    if not gameweeks:
        return None
    now = now_ts if now_ts is not None else datetime.now(timezone.utc).timestamp()
    nxt = gameweeks.get("next")
    if nxt and nxt.get("id") is not None:
        dl = parse_deadline_unix(nxt.get("deadlineTime"))
        if dl is not None and now >= dl:
            return int(nxt["id"])
    return active_gameweek_id(gameweeks)


def next_deadline_unix(gameweeks: dict | None, now_ts: float | None = None) -> float | None:
    """Unix timestamp of the soonest upcoming GW deadline, or None."""
    if not gameweeks:
        return None
    now = now_ts if now_ts is not None else datetime.now(timezone.utc).timestamp()
    soonest: float | None = None
    for key in ("current", "next"):
        row = gameweeks.get(key)
        if not row:
            continue
        dl = parse_deadline_unix(row.get("deadlineTime"))
        if dl is None or dl <= now:
            continue
        if soonest is None or dl < soonest:
            soonest = dl
    return soonest


def deadline_poll_window_active(
    gameweeks: dict | None,
    now_ts: float | None = None,
    tail_sec: int = DEADLINE_POLL_TAIL_SEC,
) -> bool:
    """True during the post-deadline window when FPL may still be locking picks."""
    if not gameweeks or tail_sec <= 0:
        return False
    now = now_ts if now_ts is not None else datetime.now(timezone.utc).timestamp()
    for key in ("previous", "current", "next"):
        row = gameweeks.get(key)
        if not row:
            continue
        dl = parse_deadline_unix(row.get("deadlineTime"))
        if dl is None:
            continue
        if dl <= now <= dl + tail_sec:
            return True
    return False
