# Manager Points card (parked)

Removed from **Home** (2026-10-25). Weekly live value was low; the interesting story is a **mid-season / end-of-season recap** (who rode differentials, chip weeks, category mix), not a card under League every GW.

This note is the restore map. Python stack builders are still in [`site/fetch_home.py`](../site/fetch_home.py) but are **not called** on Home refresh. Do not load `manager_points_data.js` on the site until a recap surface exists.

---

## What it was

Home panel **below League, above Feed**. One card, two views (Team Pitch–style dropdown, not a second card):

| View | Content |
|------|---------|
| **Manager Detail** (default) | Stacked GW bars (category colors) + always-on category table. Default table = **Season** totals. Tap a GW → that week’s table; tap again → Season. Selected GW used an x-axis **tab** that opened into the table container (not a stroke around the bar). Chip abbr (WC/FH/BB/TC) above the GW number. Chart scrolled; newest GW pinned right. |
| **Player Detail** | Horizontal bars, current squad, top 10 season FPL pts (2026/27 catalog). Pitch-style photos. **Star** on the differential. Tap row → same player overlay as the pitch. |

Heading: `Manager Points` + chevron menu `Manager Detail` / `Player Detail`.

---

## Locked product rules

**Differential (league impact)**

```
impact = seasonPts × (1 − leagueEO)
leagueEO = owners / leagueSize
```

`owners` from `homeOwnersForElement` (league picks). Star the max impact. If that player is outside the top 10 by pts, **swap in as 10th** so the star is always visible. Show EO% on that row only.

**Scoring (no bench unless BB; autosubs count)**

- Starters: FPL `multiplier` (C/VC).
- `autoSubOut` → 0.
- `autoSubIn` with `multiplier <= 0` → treat as 1.
- Bench Boost: every row uses `multiplier` or 1.
- Finished-GW official total = `history.current[].points` (includes hits).
- Live / current GW = standings `gwPointsLive` + pending autosub delta when preview is on.
- Hits (`event_transfers_cost`) sit in the stack as a negative “Hits” slice; table count = `max(1, round(hits / 4))`.

**Category stack** (pts and counts)

| key | FPL return |
|-----|------------|
| `minutes` | +2 if ≥60′, else +1 |
| `goals` | position goal pts |
| `assists` | ×3 |
| `cleanSheets` | position CS pts |
| `defcon` | +2 if DefCon hit |
| `bonus` | BPS bonus |
| `saves` | floor(saves/3) + 5× pen saved |
| `discipline` | −GC docks, −YC/−RC, −pen miss, −OG |
| `hits` | transfer hit cost (manager, not player) |

---

## Data

**Shape** (`managerPointsByEntry[entryId]`):

```json
{
  "gws": [
    {
      "gw": 4,
      "points": 72,
      "hits": 0,
      "chip": "WC",
      "stack": { "minutes": 24, "goals": 13, "assists": 12, "cleanSheets": 14, "defcon": 0, "bonus": 10, "saves": 2, "discipline": -3 },
      "counts": { "minutes": 11, "goals": 3, "assists": 3, "cleanSheets": 5, "defcon": 0, "bonus": 10, "saves": 6, "discipline": 3 }
    }
  ]
}
```

**Pipeline (still in `fetch_home.py`, not invoked)**

1. `backfill_manager_points` — once per `(entry, settled GW)`: `GET /entry/{id}/event/{gw}/picks` + `event-live` / `snapshots/event-live_{gw}.json`. Writes `site/manager_points_cache.json`.
2. `build_manager_points_by_entry` — merge cache + `entry/{id}/history` + live current GW from `squadsByEntry` / `elementGw`.
3. `write_manager_points_js` — `site/manager_points_data.js` → `window.FPL_MANAGER_POINTS.byEntry` (Vercel static seed; live `/api/home` used to omit history and show one bar).
4. Client `mergeManagerPointsByEntry` — union by GW so a live poll cannot wipe settled stacks.

History already fetched per manager for Home standings; extra cost is picks-per-GW until the cache is warm.

---

## UI notes (if rebuilt for recap)

- Do **not** wrap the stacked bar in a selection stroke (collides with the points pill).
- GW select = tab on the **x-axis number**, table in a bordered container; Season = no tab.
- Player photos: `home-pitch-photo` / `feedPlayerPhotoSrc`.
- Hide category table + return-type legend on Player Detail; one-line star legend instead.
- iOS `theme-color` / GW-range sliders / Price Fallers columns were **separate** Home/Price/filter work — not part of this card.

---

## How to restore

1. In `fetch_home.py` `main`, re-enable `backfill_manager_points` + `build_manager_points_by_entry` and set `payload["managerPointsByEntry"]`. `write_home_outputs` already calls `write_manager_points_js` when that key is present.
2. Recreate the Home (or **Report / recap**) panel from git history of `site/index.html` (`#home-manager-points-panel`), `site/app.js` (`renderHomeManagerPoints` and friends), `site/styles.css` (`.home-mp-*` card rules — **not** `.home-mp-line`, which is pitch minutes).
3. Load `manager_points_data.js` only if the surface is static (Vercel). Live Home should merge from `/api/home` the same way as before.

Suggested recap home: GW1–19 and GW1–38 tables + Player Detail differentials, not a live poll card.

---

## Files

| Path | Role after parking |
|------|-------------------|
| `site/fetch_home.py` | Stack builders remain; Home refresh does not call them |
| `site/manager_points_cache.json` | Last settled-GW cache (safe to keep) |
| `site/manager_points_data.js` | Last static seed (not loaded) |
| `site/home_data.js` | May still contain a stale `managerPointsByEntry` until next `refresh home` |
