#!/usr/bin/env python3
"""
Fetch EPL odds from The Odds API into site/markets_data.js.

Setup:
  1. Get a key at https://the-odds-api.com/
  2. Add to project-root .env:
       ODDS_API_KEY=your_key_here

Run:
  python3 site/fetch_markets.py

The static site only reads markets_data.js — the key never ships to the browser.
"""
from __future__ import annotations

import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent
ENV_PATH = ROOT / ".env"
OUT_PATH = SITE / "markets_data.js"
API_BASE = "https://api.the-odds-api.com/v4"
SPORT = "soccer_epl"

# Prefer sharp / exchange books for the primary line.
BOOK_PRIORITY = (
    "pinnacle",
    "betfair_ex_uk",
    "betfair_ex_eu",
    "betfair_ex_au",
    "matchbook",
    "williamhill",
    "bet365",
    "unibet_uk",
    "ladbrokes_uk",
    "paddypower",
    "skybet",
)

# Odds API full names → FPL short codes used in data.js / badges.
TEAM_NAME_TO_CODE = {
    "arsenal": "ARS",
    "aston villa": "AVL",
    "afc bournemouth": "BOU",
    "bournemouth": "BOU",
    "brentford": "BRE",
    "brighton and hove albion": "BHA",
    "brighton & hove albion": "BHA",
    "brighton": "BHA",
    "chelsea": "CHE",
    "crystal palace": "CRY",
    "everton": "EVE",
    "fulham": "FUL",
    "ipswich town": "IPS",
    "ipswich": "IPS",
    "leeds united": "LEE",
    "leeds": "LEE",
    "liverpool": "LIV",
    "manchester city": "MCI",
    "man city": "MCI",
    "manchester united": "MUN",
    "man united": "MUN",
    "man utd": "MUN",
    "newcastle united": "NEW",
    "newcastle": "NEW",
    "nottingham forest": "NFO",
    "nott'm forest": "NFO",
    "nottm forest": "NFO",
    "sunderland": "SUN",
    "tottenham hotspur": "TOT",
    "tottenham": "TOT",
    "spurs": "TOT",
    "west ham united": "WHU",
    "west ham": "WHU",
    "wolverhampton wanderers": "WOL",
    "wolves": "WOL",
    "burnley": "BUR",
    "leicester city": "LEI",
    "leicester": "LEI",
    "southampton": "SOU",
    "sheffield united": "SHU",
    "sheffield utd": "SHU",
    "coventry city": "COV",
    "coventry": "COV",
    "hull city": "HUL",
    "hull": "HUL",
}


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


def team_code(name: str) -> str | None:
    key = " ".join((name or "").strip().lower().split())
    if key in TEAM_NAME_TO_CODE:
        return TEAM_NAME_TO_CODE[key]
    # Soft contains match for longer API names.
    for alias, code in TEAM_NAME_TO_CODE.items():
        if alias in key or key in alias:
            return code
    return None


def http_get_json(url: str) -> tuple[object, dict[str, str]]:
    req = urllib.request.Request(url, headers={"User-Agent": "FPL-Explorer/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        headers = {k.lower(): v for k, v in resp.headers.items()}
        body = resp.read().decode("utf-8")
    return json.loads(body), headers


def de_vig(prices: list[float]) -> list[float]:
    inv = [1.0 / p for p in prices if p and p > 1.0]
    if len(inv) != len(prices) or not inv:
        return []
    total = sum(inv)
    if total <= 0:
        return []
    return [x / total for x in inv]


def market_map(bookmaker: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for m in bookmaker.get("markets") or []:
        key = m.get("key")
        if key:
            out[key] = m
    return out


def parse_h2h(market: dict, home: str, away: str) -> dict[str, float] | None:
    prices: dict[str, float] = {}
    for o in market.get("outcomes") or []:
        name = o.get("name")
        price = o.get("price")
        if name is None or price is None:
            continue
        if name == home:
            prices["home"] = float(price)
        elif name == away:
            prices["away"] = float(price)
        elif name == "Draw":
            prices["draw"] = float(price)
    if len(prices) != 3:
        return None
    return prices


def parse_totals(market: dict) -> dict | None:
    over = under = point = None
    for o in market.get("outcomes") or []:
        name = (o.get("name") or "").lower()
        price = o.get("price")
        pt = o.get("point")
        if price is None or pt is None:
            continue
        if name == "over":
            over, point = float(price), float(pt)
        elif name == "under":
            under, point = float(price), float(pt)
    if over is None or under is None or point is None:
        return None
    return {"point": point, "over": over, "under": under}


def parse_btts(market: dict) -> dict[str, float] | None:
    yes = no = None
    for o in market.get("outcomes") or []:
        name = (o.get("name") or "").lower()
        price = o.get("price")
        if price is None:
            continue
        if name == "yes":
            yes = float(price)
        elif name == "no":
            no = float(price)
    if yes is None or no is None:
        return None
    return {"yes": yes, "no": no}


def book_rank(key: str) -> int:
    try:
        return BOOK_PRIORITY.index(key)
    except ValueError:
        return len(BOOK_PRIORITY) + 50


def pick_primary(bookmakers: list[dict], home: str, away: str) -> tuple[str | None, dict | None]:
    """Return (book_key, {h2h, totals?, btts?}) for the best available book."""
    candidates: list[tuple[int, str, dict]] = []
    for bm in bookmakers:
        key = bm.get("key") or ""
        markets = market_map(bm)
        h2h_m = markets.get("h2h")
        if not h2h_m:
            continue
        h2h = parse_h2h(h2h_m, home, away)
        if not h2h:
            continue
        payload = {"h2h": h2h}
        if "totals" in markets:
            totals = parse_totals(markets["totals"])
            if totals:
                payload["totals"] = totals
        if "btts" in markets:
            btts = parse_btts(markets["btts"])
            if btts:
                payload["btts"] = btts
        # Prefer books that also have totals.
        rank = book_rank(key) - (10 if "totals" in payload else 0)
        candidates.append((rank, key, payload))
    if not candidates:
        return None, None
    candidates.sort(key=lambda x: x[0])
    _, key, payload = candidates[0]
    return key, payload


def poisson_pmf(k: int, lam: float) -> float:
    if lam <= 0:
        return 1.0 if k == 0 else 0.0
    return math.exp(-lam) * (lam**k) / math.factorial(k)


def match_outcome_probs(lh: float, la: float, max_goals: int = 12) -> tuple[float, float, float]:
    ph = pd = pa = 0.0
    for i in range(max_goals + 1):
        pi = poisson_pmf(i, lh)
        for j in range(max_goals + 1):
            p = pi * poisson_pmf(j, la)
            if i > j:
                ph += p
            elif i == j:
                pd += p
            else:
                pa += p
    total = ph + pd + pa
    if total <= 0:
        return 1 / 3, 1 / 3, 1 / 3
    return ph / total, pd / total, pa / total


def expected_total_from_ou(point: float, p_over: float) -> float:
    """Find μ for independent Poisson total ≈ Poisson(μ) matching P(total > point)."""
    # For .5 lines, over means total >= ceil(point).
    threshold = math.floor(point) + 1  # e.g. 2.5 → need ≥ 3

    def p_over_at(mu: float) -> float:
        return sum(poisson_pmf(k, mu) for k in range(threshold, 20))

    lo, hi = 0.2, 6.0
    for _ in range(40):
        mid = (lo + hi) / 2
        if p_over_at(mid) > p_over:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def fit_poisson(
    p_home: float, p_draw: float, p_away: float, mu: float | None
) -> tuple[float, float]:
    """Fit λ_home, λ_away to 1X2 probs (and optional expected total)."""
    target_mu = mu if mu and mu > 0.3 else 2.5
    best = (target_mu / 2 + 0.2, target_mu / 2 - 0.2)
    best_err = float("inf")

    # Search goal-difference offset around equal split of μ.
    for step_mu in (0.0, -0.15, 0.15, -0.3, 0.3):
        mu_try = max(0.6, target_mu + step_mu)
        for delta in [i * 0.05 for i in range(-40, 41)]:
            lh = max(0.05, mu_try / 2 + delta)
            la = max(0.05, mu_try / 2 - delta)
            ph, pd, pa = match_outcome_probs(lh, la)
            err = (
                (ph - p_home) ** 2
                + (pd - p_draw) ** 2
                + (pa - p_away) ** 2
                + 0.15 * ((lh + la) - target_mu) ** 2
            )
            if err < best_err:
                best_err = err
                best = (lh, la)
    return best


def top_correct_scores(lh: float, la: float, n: int = 5) -> list[dict]:
    cells: list[tuple[float, int, int]] = []
    for i in range(0, 6):
        for j in range(0, 6):
            cells.append((poisson_pmf(i, lh) * poisson_pmf(j, la), i, j))
    cells.sort(reverse=True)
    out = []
    for p, i, j in cells[:n]:
        out.append({"score": f"{i}-{j}", "prob": round(p * 100, 1)})
    return out


def process_event(event: dict) -> dict | None:
    home_name = event.get("home_team") or ""
    away_name = event.get("away_team") or ""
    home_code = team_code(home_name)
    away_code = team_code(away_name)
    if not home_code or not away_code:
        print(f"  skip unmapped: {home_name} vs {away_name}", file=sys.stderr)
        return None

    bookmakers = event.get("bookmakers") or []
    primary_key, primary = pick_primary(bookmakers, home_name, away_name)
    if not primary:
        print(f"  skip no h2h: {home_code} vs {away_code}", file=sys.stderr)
        return None

    h2h = primary["h2h"]
    probs = de_vig([h2h["home"], h2h["draw"], h2h["away"]])
    if len(probs) != 3:
        return None
    p_home, p_draw, p_away = probs

    mu = None
    totals_out = None
    if "totals" in primary:
        t = primary["totals"]
        ou = de_vig([t["over"], t["under"]])
        if len(ou) == 2:
            mu = expected_total_from_ou(t["point"], ou[0])
            totals_out = {
                "point": t["point"],
                "over": t["over"],
                "under": t["under"],
                "overProb": round(ou[0] * 100, 1),
                "underProb": round(ou[1] * 100, 1),
            }

    lh, la = fit_poisson(p_home, p_draw, p_away, mu)
    cs_home = poisson_pmf(0, la)  # home CS = away scores 0
    cs_away = poisson_pmf(0, lh)

    # Prefer book BTTS when present (per-event feeds); else Poisson-derived.
    btts_out = None
    if "btts" in primary:
        b = primary["btts"]
        bp = de_vig([b["yes"], b["no"]])
        if len(bp) == 2:
            btts_out = {
                "yes": round(bp[0] * 100, 1),
                "no": round(bp[1] * 100, 1),
                "odds": {"yes": b["yes"], "no": b["no"]},
                "source": "book",
            }
    if btts_out is None:
        p_btts = (1.0 - poisson_pmf(0, lh)) * (1.0 - poisson_pmf(0, la))
        btts_out = {
            "yes": round(p_btts * 100, 1),
            "no": round((1.0 - p_btts) * 100, 1),
            "odds": None,
            "source": "poisson",
        }

    book_keys = sorted(
        {bm.get("key") for bm in bookmakers if bm.get("key")},
        key=book_rank,
    )[:8]

    return {
        "id": event.get("id"),
        "commenceTime": event.get("commence_time"),
        "home": {"code": home_code, "name": home_name},
        "away": {"code": away_code, "name": away_name},
        "probs": {
            "home": round(p_home * 100, 1),
            "draw": round(p_draw * 100, 1),
            "away": round(p_away * 100, 1),
        },
        "goals": {"home": round(lh, 2), "away": round(la, 2)},
        "cleanSheet": {
            "home": round(cs_home * 100, 1),
            "away": round(cs_away * 100, 1),
        },
        "btts": btts_out,
        "topScores": top_correct_scores(lh, la, 5),
        "books": {
            "primary": primary_key,
            "h2h": h2h,
            "totals": totals_out,
        },
        "rawBookmakers": book_keys,
    }


def write_markets_js(payload: dict) -> None:
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    OUT_PATH.write_text(f"window.FPL_MARKETS = {body};\n", encoding="utf-8")


def main() -> int:
    api_key = os.environ.get("ODDS_API_KEY", "").strip()
    if not api_key:
        print(
            "No ODDS_API_KEY in .env — add:\n"
            "  ODDS_API_KEY=your_key_here\n"
            f"to {ENV_PATH}",
            file=sys.stderr,
        )
        return 1

    # Featured markets only on the bulk /odds endpoint. BTTS is additional and
    # needs /events/{id}/odds — we derive it from the Poisson fit instead.
    params = urllib.parse.urlencode(
        {
            "apiKey": api_key,
            "regions": "uk,eu",
            "markets": "h2h,totals",
            "oddsFormat": "decimal",
        }
    )
    url = f"{API_BASE}/sports/{SPORT}/odds?{params}"
    print(f"Fetching {SPORT} odds…")
    try:
        data, headers = http_get_json(url)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")[:400]
        print(f"HTTP {e.code}: {body}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"Request failed: {e}", file=sys.stderr)
        return 1

    if not isinstance(data, list):
        print(f"Unexpected response: {type(data)}", file=sys.stderr)
        return 1

    fixtures = []
    for event in data:
        row = process_event(event)
        if row:
            fixtures.append(row)

    fixtures.sort(key=lambda f: f.get("commenceTime") or "")

    remaining = headers.get("x-requests-remaining")
    used = headers.get("x-requests-used")
    last_cost = headers.get("x-requests-last")

    payload = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "meta": {
            "sport": SPORT,
            "regions": "uk,eu",
            "markets": "h2h,totals",
            "btts": "poisson-derived",
            "source": "the-odds-api",
            "requestsRemaining": remaining,
            "requestsUsed": used,
            "requestsLast": last_cost,
            "eventsRaw": len(data),
            "eventsMapped": len(fixtures),
        },
        "fixtures": fixtures,
    }
    write_markets_js(payload)
    print(
        f"Wrote {OUT_PATH.name}: {len(fixtures)} fixtures "
        f"(raw {len(data)}; remaining credits: {remaining})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
