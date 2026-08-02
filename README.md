# FPL Explorer

Static Fantasy Premier League research site — browse OPTA/FPL stats, fixture matchups, social buzz, and bookmaker-derived projections without a backend. Everything runs in the browser from prebuilt JS data files under `site/`.

**Live UI:** open [`site/index.html`](site/index.html) via a local static server (see [Run locally](#run-locally)).

---

## Pages

| Tab | What it shows |
|-----|----------------|
| **Statistics** | Sortable player/team table (Total / Home / Away). Value modes: season total, per 90, per £m. Column picker, compare up to 5 rows, fixture hover tooltips, owned-player pins (manager ID in Preferences). Season switch: **2025/26** full stats vs **2026/27** zero-stat squad + prices. |
| **Rankings** | Top-10 cards per metric. Hover to cross-highlight a name across cards; pin up to five colours. |
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
│   ├── social_data.js    # Feed cache
│   ├── markets_data.js   # Markets cache
│   ├── badges/           # Club crest SVGs (ARS.svg, …)
│   ├── img/              # Matchups help art
│   ├── build.py          # CSV + snapshots → data.js
│   ├── fetch_*.py        # Optional refresh scripts
│   └── …
├── snapshots/            # Saved FPL API JSON (bootstrap, fixtures, …)
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

### Feed (`social_data.js`)

1. `python3 site/fetch_social.py` — X API v2 (`X_BEARER_TOKEN`), accounts in `site/social_accounts.json`.
2. `python3 site/annotate_social.py` — resolve player mentions (Claude / OpenAI if keyed, else heuristics).

Refreshing the browser never spends X credits; only the fetch script does.

### Markets (`markets_data.js`)

`python3 site/fetch_markets.py` — [The Odds API](https://the-odds-api.com/) (`ODDS_API_KEY`), sport `soccer_epl`, UK/EU regions. Prefers Pinnacle (then Betfair), de-vigs 1X2 + totals, fits independent Poisson λ for goals / CS% / top scores. The API key never ships to the browser; the page only reads the static JS cache.

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
# fill X_BEARER_TOKEN, ODDS_API_KEY, and optional LLM keys

python3 site/build.py                 # after CSV / snapshot updates
python3 site/fetch_history_past.py    # optional: rebuild history_past snapshot
python3 site/fetch_social.py && python3 site/annotate_social.py
python3 site/fetch_markets.py         # ~few Odds API credits per pull
```

Drop updated Hub CSVs in the project root and/or dated JSON under `snapshots/` before rebuilding. Manual FPL price ambiguities go in `site/price_overrides.json`.

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
