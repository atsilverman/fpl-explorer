# FPL Explorer

Static Fantasy Premier League research site — browse OPTA/FPL stats, fixture matchups, social buzz, and bookmaker-derived projections without a backend. Everything runs in the browser from prebuilt JS data files under `site/`.

**Live UI:** open [`site/index.html`](site/index.html) via a local static server (see [Run locally](#run-locally)).

---

## Pages

| Tab | What it shows |
|-----|----------------|
| **Statistics** | Sortable player/team table (Total / Home / Away), including current FPL ownership. Value modes: season total, per 90, per £m. Column picker, compare up to 5 rows, click-to-open fixture tooltips, owned-player pins (manager ID in Preferences). Season switch: **2025/26** full stats vs **2026/27** zero-stat squad + prices. |
| **Rankings** | Top-10 cards per metric. Hover to cross-highlight a name across cards; pin up to five colours. |
| **Ownership** | Multi-line `selected_by%` over manual FPL check-ins. Players default to 5%+ owned, capped at the latest top 100 (grey lines, hover uses club colour). Risers/Fallers always show the top five player ownership movers; the sidebar threshold controls qualification and **Trending** colors only those listed movers. Teams average each club’s current top 20. |
| **Prices** | Official FPL price-change predictor (2026/27): **Prediction** mode with stacked risers/fallers tables, progress sparklines, and countdown; **Actual** mode logs confirmed £0.1m moves (backfilled from bootstrap snapshots + ongoing midnight check-ins). |
| **Matchups** | Upcoming fixture difficulty cards plus an attack/defence scatter. Blend Expected vs Actual ranks; highlight edges for favourable attacking or defensive matchups. |
| **Feed** | Player-mention cards from curated FPL creators on X (~last 48 hours), with quotes and season stats. Search + Volume / Recent sort. |
| **Markets** | Upcoming EPL fixtures from bookmaker odds: projected goals, clean-sheet %, most likely scorelines. Grouped by local date; heat colouring for Goals / CS%. |
| **xData** | Barbell charts of expected vs actual (xG/Goals, xA/Assists, xGI/G+A, xGC/Conceded; teams also xCS). Home / Away / Compare. Empty state on **2026/27** until expected stats exist. |

Preferences (gear): FPL manager ID, font pair, **12/24-hour clock**, fixture tooltip delay. Theme cycles System / Light / Dark.

---

## Project layout

```
FPL/
├── site/                 # The app (serve this folder)
│   ├── index.html
│   ├── app.js / styles.css
│   ├── data.js           # Main stats bundle (from build.py)
│   ├── markets_data.js   # Markets cache
│   ├── ownership_data.js # Ownership check-ins
│   ├── price_changes_data.js # Price predictor check-ins
│   ├── badges/           # Club crest SVGs (ARS.svg, …)
│   ├── img/              # Matchups help art
│   ├── build.py          # CSV + snapshots → data.js
│   ├── fetch_*.py        # Optional refresh scripts
│   └── …
├── snapshots/            # Saved FPL API JSON (bootstrap, fixtures, …)
├── archive/              # Parked features (e.g. Feed / X API)
├── docs/                 # API notes & data-source writeups
├── reports/              # Optional build diffs (CSV vs FPL API)
├── FPL Data - *.csv      # Fantasy Football Hub exports (build inputs)
├── .env.example          # Keys for fetch scripts (copy to .env)
└── README.md
```

Club badges used by the UI live only in `site/badges/`. Numbered FPL club-code SVGs that used to sit in the repo root were unused duplicates and have been removed.

---

## Data sources

### Statistics / Rankings / Matchups / xData (`data.js`)

Built by `python3 site/build.py`:

1. **Fantasy Football Hub CSVs** (project root) — venue-split player and team OPTA-style stats (H/A files merged into home / away / combined).
2. **FPL API snapshots** in `snapshots/` — latest non-archived `bootstrap-static_*.json` and `fixtures_*.json`, plus `history_past_2025-26.json` when present. Used for prices, squad, set pieces, fixtures, and overwriting overlapping **combined** player season totals.
3. **ESPN standings** (live, no key) — Premier League table ranks for Matchups context.

**Precedence (combined players):** FPL season totals win on overlapping fields; home/away splits and all **team** rows stay on Hub CSVs. See [`docs/data-sources-infographic.html`](docs/data-sources-infographic.html).

Relegated clubs from the prior campaign are excluded where appropriate; promoted clubs appear in 2026/27 mode from bootstrap.

### Feed (archived)

Social Feed + X API pulls are parked under [`archive/feed/`](archive/feed/README.md) (scripts, accounts list, last `social_data.js`, and a client JS excerpt). Not part of the live UI or **refresh data** pipeline.

### Ownership (`ownership_data.js`)

`python3 site/fetch_ownership.py` — pulls `bootstrap-static`, writes `snapshots/bootstrap-static_YYYY-MM-DD.json` if that calendar day is new (overwrites same-day), then rebuilds a slim check-in history from every non-archived bootstrap snapshot. `python3 site/fetch_ownership.py --rebuild-only` skips the live fetch. The page never calls the FPL API.

**Cadence:** one useful check-in per calendar day. The Ownership UI’s **24h / 3d / 7d** columns compare against the nearest prior daily snapshot — they are not live transfer ticks — so refreshing more than once a day only overwrites today’s point.

### Prices (`price_changes_data.js`)

`python3 site/fetch_prices.py` — pulls `bootstrap-static` every run, writes slim mover snapshots to `snapshots/price-changes/price-changes_*.json` (prunes files older than ~4 days), then rebuilds `site/price_changes_data.js` with check-in history and 3-day progress sparklines.

**Actual price changes** (confirmed £0.1 moves) are detected by `python3 site/fetch_price_actual.py`, scheduled around **00:00 UK** (baseline at 23:57 UK, polls 00:02–00:15 UK with retries). Events land in `snapshots/price-actual/actual-changes.json` with `changedAt` at UK midnight. One-time season backfill: `python3 site/backfill_price_actual.py --replace` (diffs consecutive `bootstrap-static_YYYY-MM-DD.json` snapshots).

`python3 site/fetch_prices.py --rebuild-only` skips the live fetch.

**Cadence:** every **hour** via [`.github/workflows/refresh-prices.yml`](.github/workflows/refresh-prices.yml) (separate from ownership). Daily FPL price changes apply at 00:00 Europe/London.

### Markets (`markets_data.js`)

`python3 site/fetch_markets.py` — [The Odds API](https://the-odds-api.com/) (`ODDS_API_KEY`), sport `soccer_epl`, UK/EU regions. Prefers Pinnacle (then Betfair), de-vigs 1X2 + totals, fits independent Poisson λ for goals / CS% / top scores. The API key never ships to the browser; the page only reads the static JS cache.

### Scheduled refreshes (GitHub Actions → Vercel)

Workflow [`.github/workflows/refresh-caches.yml`](.github/workflows/refresh-caches.yml) commits updated caches to `main` (Vercel redeploys):

| When (Pacific) | What |
|----------------|------|
| **Midnight** | Markets |
| **Noon** | Markets + Ownership |
| **Hourly (UTC)** | Prices predictor (`refresh-prices.yml`) |
| **~00:00 UK** | Actual price changes (`refresh-price-actual.yml`) |

Cron is UTC (`07:00` / `19:00` ≈ PDT). In winter (PST) those fire one hour later local. Manual run: Actions → **Refresh caches** → Run workflow.

Requires repo secret **`ODDS_API_KEY`**. Home still uses the DigitalOcean live server (60s live / ≤1h idle) — not this workflow. Statistics / Rankings / Matchups / xData still need a manual `build.py` + deploy.

### Reference docs

| Doc | Topic |
|-----|--------|
| [`docs/FPL_DATA_DICTIONARY.md`](docs/FPL_DATA_DICTIONARY.md) | Field meanings |
| [`docs/FPL_API_COMPLETE_REFERENCE.md`](docs/FPL_API_COMPLETE_REFERENCE.md) | FPL API surface |
| [`docs/FPL_API_AUDIT_2026-07-23.md`](docs/FPL_API_AUDIT_2026-07-23.md) | Preseason API audit notes |

---

## Run locally

Serve **from `site/`** so relative paths resolve:

```bash
cd site
python3 -m http.server 8000
# → http://localhost:8000
```

Browsing existing caches needs no API keys. For refreshes:

```bash
cp .env.example .env
# fill ODDS_API_KEY (and other keys as needed)

python3 site/build.py                 # after CSV / snapshot updates
python3 site/fetch_history_past.py    # optional: rebuild history_past snapshot
python3 site/fetch_ownership.py       # ownership check-in + history bundle
python3 site/fetch_prices.py          # price predictor check-ins (hourly in CI)
python3 site/fetch_price_actual.py    # UK-midnight actual change detection
python3 site/fetch_markets.py         # ~few Odds API credits per pull
python3 site/fetch_leagues.py
python3 site/fetch_home.py
```

Drop updated Hub CSVs in the project root and/or dated JSON under `snapshots/` before rebuilding. Manual FPL price ambiguities go in `site/price_overrides.json`.

### Live Home (near real-time GW updates)

Static `home_data.js` on Vercel is a fallback. For minute-by-minute live scores, standings, and squads:

1. **DigitalOcean droplet** ($6/mo, 1 GB) runs [`site/live_server.py`](site/live_server.py) — polls [`site/fetch_home.py`](site/fetch_home.py) every **15s** during live fixtures (idle up to 1h, waking ~2m before kickoff).
2. **Vercel** serves the UI; set `window.FPL_LIVE_API` in [`site/index.html`](site/index.html) to your droplet URL (HTTPS).
3. Home polls `GET /api/home` every **15s** during live fixtures (60s idle) when manager/league match Preferences.

Full setup: [`deploy/digitalocean/README.md`](deploy/digitalocean/README.md). On a fresh Ubuntu droplet:

```bash
sudo bash deploy/digitalocean/setup.sh
```

Local dev with live Home parity: `python3 site/serve.py` — `/api/home` proxies to the same DO droplet as Vercel (`FPL_LIVE_ORIGIN`, default `159.203.184.115:8080`). Set `FPL_HOME_LOCAL_CACHE=1` to use local `home_data.js` instead.

---

## Stack

- Plain HTML / CSS / JS (no bundler)
- Lucide icons (inline sprite)
- Python 3 for build & fetch scripts
- Secrets only in `.env` (gitignored); `.env.example` documents variables

---

## Notes

- **Clock format** (Preferences) affects Markets kickoff times and similar stamps; times always use the visitor’s device timezone.
- **Markets / Feed** hide the Statistics sidebar; page enter animations cascade rows/cards (Markets also counts Goals / CS% up on enter).
- Opening `index.html` via `file://` may break fonts or fetches depending on the browser — prefer a local HTTP server.
