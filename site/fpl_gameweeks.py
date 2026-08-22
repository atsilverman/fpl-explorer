"""Extract previous / current / next gameweek from FPL bootstrap-static events."""
from __future__ import annotations


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


def active_gameweek_id(gameweeks: dict | None) -> int | None:
    """GW the UI should treat as 'now': current if set, else next."""
    if not gameweeks:
        return None
    for key in ("current", "next"):
        row = gameweeks.get(key)
        if row and row.get("id") is not None:
            return int(row["id"])
    return None
