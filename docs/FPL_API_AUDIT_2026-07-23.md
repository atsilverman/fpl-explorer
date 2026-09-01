# FPL API Audit — Preseason 2026/27 Snapshot

**Audit date:** 2026-07-23 (live crawl)
**Season context:** Pre-season, 2026/27. Gameweek 1 deadline is **2026-08-21T17:30:00Z**. No gameweek has `is_current`, `is_previous`, or any played data yet — every event is unstarted, and `is_next` is only true for GW1.
**Compares against:** [`FPL_DATA_DICTIONARY.md`](FPL_DATA_DICTIONARY.md) and [`FPL_API_COMPLETE_REFERENCE.md`](FPL_API_COMPLETE_REFERENCE.md), both generated **2026-01-24** during Gameweek 23 of the 2025/26 season.
**Raw evidence saved to:** [`snapshots/`](snapshots/) — `bootstrap-static_2026-07-23.json`, `fixtures_2026-07-23.json`, `set-piece-notes_2026-07-23.json`, `event-status_2026-07-23.json`. Keep these; they're the baseline for diffing against a post-GW1 crawl later.

This audit has two jobs: (1) fully catalog `bootstrap-static/` field-by-field against what's currently documented, and (2) capture what the API looks like **before a season starts**, since neither existing doc — both written mid-season — covers that state at all. That preseason behavior turns out to matter a lot for app design.

---

## 1. Executive Summary

- **The two existing docs are excellent on live-gameweek mechanics** (bonus timing, DEFCON, auto-subs, provisional vs. final standings) and that content is still accurate — nothing found here contradicts it.
- **`bootstrap-static.elements[]` has 105 fields; the data dictionary documents 28.** The other 77 include genuinely high-value data your app will want: official set-piece order (penalty/free-kick/corner takers), FPL's own predicted points (`ep_this`/`ep_next`), per-90 normalized stats, price-change tracking, and stat-ranking fields. See [§3.8](#38-elements-the-big-gap).
- **A real, explicit, official scoring rulebook exists as data** (`game_config.scoring`) — every point value for every action, by position. Neither doc mentions this key exists; right now both docs infer scoring rules from prose/external sources instead of reading them from the API. See [§3.7](#37-game_settings--game_config-new-top-level-keys).
- **Preseason has its own quirks that will bite you if you build against it now:** season-cumulative fields on `elements[]` (total_points, minutes, bps, etc.) are **not zeroed** — they still hold the just-finished 2025/26 season's final numbers until GW1 data starts landing. Team strength/FDR fields are null. `event/{gw}/live` returns an empty array rather than erroring. See [§4](#4-critical-preseason-behavior-not-covered-by-either-existing-doc).
- **Several real, working endpoints are used nowhere in either doc**: `/api/team/set-piece-notes/`, `/api/event-status/`, `/api/leagues-classic/{id}/standings/`, `/api/entry/{id}/history/` (with an undocumented `rank_percentage` field), `/api/dream_team/{event}/`, and the auth-gated `/api/my-team/{id}/`. See [§5](#5-endpoints-confirmed-live-but-absent-from-both-docs).
- **Two rule/format details worth designing around**: chips are now split into first-half/second-half pairs (two Wildcards, two Free Hits, two Bench Boosts, two Triple Captains per season, `start_event`/`stop_event` scoped), and there's a hard per-gameweek transfer cap (`transfers_cap: 20`) neither doc mentions. See [§6](#6-rule-and-format-details-worth-designing-around).

---

## 2. Endpoint Inventory

| Endpoint | Confirmed live 2026-07-23 | In `FPL_DATA_DICTIONARY.md`? | In `FPL_API_COMPLETE_REFERENCE.md`? |
|---|---|---|---|
| `GET /bootstrap-static/` | ✅ | ✅ (partial — see gaps below) | ✅ |
| `GET /fixtures/` | ✅ (380 fixtures pre-scheduled, all unplayed) | ✅ | ✅ |
| `GET /event/{gw}/live` | ✅ (`elements: []` pre-season) | ✅ | ✅ |
| `GET /element-summary/{id}/` | ✅ | ✅ | ✅ |
| `GET /entry/{id}/` | ✅ | partial (missing several fields, see §5) | — |
| `GET /entry/{id}/event/{gw}/picks/` | not testable pre-season (no picks yet) | ✅ | ✅ |
| `GET /entry/{id}/history/` | ✅ | partial — missing `rank_percentage` | ✅ |
| `GET /entry/{id}/transfers/` | ✅ (`[]` pre-season) | ✅ | — |
| `GET /leagues-classic/{id}/standings/` | ✅ | ❌ not documented | referenced in code samples, but schema never shown |
| `GET /event-status/` | ✅ | ❌ not documented | ❌ not documented |
| `GET /team/set-piece-notes/` | ✅ | ❌ not documented | ❌ not documented |
| `GET /dream_team/{gw}/` | ✅ (404 HTML for a gw with no data) | ❌ not documented | ❌ not documented |
| `GET /my-team/{id}/` | ✅ (401 without session auth) | ❌ not documented | ❌ not documented |

---

## 3. `bootstrap-static/` — Full Field Audit

Top-level keys, live: `chips`, `element_stats`, `element_types`, `elements`, `events`, `game_config`, `game_settings`, `phases`, `teams`, `total_players`.

`game_config` and `phases` are **not mentioned in either existing doc at all**.

### 3.1 `total_players`

Currently `711225`. The dictionary labels this "Total number of players" — ambiguous, and easy to misread as "players in the game" (i.e. `elements.length`, which is 555). It's actually **the count of registered FPL manager accounts**, unrelated to the elements array. Recommend the dictionary rename this row's description to "Total registered manager/entry accounts (not football players)."

### 3.2 `events[]` (Gameweeks)

29 fields live vs. 19 documented. Ten undocumented fields:

| Field | Type | Example | Notes |
|---|---|---|---|
| `deadline_time_epoch` | integer | `1787333400` | Unix timestamp version of `deadline_time` |
| `deadline_time_game_offset` | integer | `0` | Offset in seconds, relevant for chip-deadline edge cases |
| `can_enter` | boolean | `true` | Whether the gameweek can still be entered/joined |
| `can_manage` | boolean | `true` | Whether picks can still be managed |
| `released` | boolean | `true` | Fixture list released, independent of `finished`/`data_checked` |
| `ranked_count` | integer | `0` | Number of entries ranked so far this gameweek |
| `cup_leagues_created` | boolean | `false` | Whether FPL Cup league instances exist for this gameweek |
| `h2h_ko_matches_created` | boolean | `false` | Whether head-to-head knockout fixtures exist for this gameweek |
| `overrides` | object `{rules, scoring, element_types, pick_multiplier}` | all empty pre-season | Per-gameweek rule/scoring overrides — mechanism exists for special gameweeks (e.g. a scoring tweak for one GW) even if unused right now |
| `top_element_info` | object or `null` | `null` | Companion to `top_element` (which is just an ID) |

### 3.3 `teams[]`

22 fields live vs. 17 documented. Five undocumented:

| Field | Type | Example | Notes |
|---|---|---|---|
| `form` | string or `null` | `null` (pre-season) | Recent form, same concept as player `form` |
| `team_division` | integer or `null` | `null` | Always null in this snapshot — reserved, unclear current use |
| `unavailable` | boolean | `false` | Likely flags a team affected by postponement/scheduling issue |
| `link_url` | string | `""` | Empty in this snapshot |
| `pulse_id` | integer | `1` | Premier League's own (Opta/Pulse) team ID — dictionary only documents this on fixtures, not teams |

Also note: **all `strength*` fields are `0` or `null` pre-season** (see §4.3) — don't treat a `0` there as "weak team," it means "not yet calculated."

### 3.4 `element_types[]` (Positions)

13 fields live vs. 11 documented. Two new: `ui_shirt_specific` (boolean, true only for GKP — likely controls whether the position gets a distinct kit rendering in FPL's UI) and `sub_positions_locked` (array, e.g. `[12]` for GKP — appears to constrain which squad-slot indices a position can occupy, relevant if you build a squad/pitch editor).

### 3.5 `element_stats[]`

Matches documentation exactly — 26 stat label/name pairs, no changes.

### 3.6 `chips[]`

Structurally matches the documented shape (`id`, `name`, `number`, `start_event`, `stop_event`, `chip_type`, `overrides`), but the **current data reveals a parsing gotcha neither doc calls out**: each chip name now appears **twice** — once scoped to the first half of the season and once to the second:

| id | name | start_event | stop_event |
|---|---|---|---|
| 1 | wildcard | 2 | 19 |
| 2 | wildcard | 20 | 38 |
| 3 | freehit | 2 | 19 |
| 4 | bboost | 1 | 19 |
| 5 | 3xc | 1 | 19 |
| 6 | freehit | 20 | 38 |
| 7 | bboost | 20 | 38 |
| 8 | 3xc | 20 | 38 |

If your code does `chips.find(c => c.name === "wildcard")`, it'll silently grab the wrong half of the season. Key on `id`, or filter by `start_event`/`stop_event` against the current gameweek.

### 3.7 `game_settings` / `game_config` — new top-level keys

Not present in either doc. Two things worth flagging:

**`game_settings` and `game_config.rules` are near-duplicates.** A diff shows they're identical except `game_settings` has one extra field, `timezone`. This looks like `game_settings` is a legacy key kept for backward compatibility while `game_config` is a newer, consolidated object. Recommend documenting `game_config` as canonical and noting `game_settings` as a redundant legacy mirror.

**`game_config.scoring` is a complete, explicit, official scoring rulebook** — every point value FPL applies, by action and position:

```json
{
  "goals_scored": {"GKP": 10, "DEF": 6, "MID": 5, "FWD": 4},
  "clean_sheets": {"GKP": 4, "DEF": 4, "MID": 1, "FWD": 0},
  "goals_conceded": {"GKP": -1, "DEF": -1, "MID": 0, "FWD": 0},
  "defensive_contribution": {"GKP": 0, "DEF": 2, "MID": 2, "FWD": 2},
  "assists": 3, "bonus": 1, "saves": 1,
  "penalties_saved": 5, "penalties_missed": -2,
  "yellow_cards": -1, "red_cards": -3, "own_goals": -2,
  "long_play": 2, "short_play": 1,
  "mng_goals_scored": {...}, "mng_clean_sheets": {...}, "mng_win": {...}, "mng_draw": {...}, "mng_loss": 0, "mng_underdog_win": {...}, "mng_underdog_draw": {...}
}
```

This is a significant upgrade over both existing docs, which describe scoring rules through prose and worked examples rather than reading them programmatically. Recommend the app pull scoring values from here instead of hardcoding them — it also future-proofs against mid-season rule tweaks (there's literally a per-gameweek `overrides.scoring` mechanism in the events array for this).

The `mng_*` fields (goals scored, clean sheets, win/draw/loss, underdog bonus — all currently zeroed) are scoring rules for FPL's separate **"Fantasy Premier League: Manager"** game mode, where you pick real managers instead of players. There's no corresponding position type in `element_types` (only GKP/DEF/MID/FWD, ids 1–4) — this confirms Manager mode isn't part of the classic-game `elements[]` structure and, if you want to support it, is a separate feature to research against its own (undocumented here) endpoints.

**`game_config.rules`** duplicates `game_settings` — squad rules worth knowing for team-builder logic: `squad_squadsize: 15`, `squad_squadplay: 11`, `squad_team_limit: 3` (max players from one club), `squad_total_spend: 1000` (£100.0m), `transfers_cap: 20` (hard per-gameweek transfer limit — not mentioned in either doc), `max_extra_free_transfers: 4` (confirms the 1-base + 4-extra = 5 max banked free transfers the reference doc already documents correctly), `transfers_sell_on_fee: 0.5`.

### 3.8 `elements[]` — the big gap

**105 fields live vs. 28 documented.** The 77 undocumented fields split into two groups:

**Group A — genuinely new, not mentioned anywhere in either doc (58 fields):**

| Category | Fields |
|---|---|
| Set-piece order ⭐ | `penalties_order`, `penalties_text`, `direct_freekicks_order`, `direct_freekicks_text`, `corners_and_indirect_freekicks_order`, `corners_and_indirect_freekicks_text` |
| FPL's predicted points ⭐ | `ep_this`, `ep_next` |
| Rank fields (vs. all players, and vs. same position) | `influence_rank`, `influence_rank_type`, `creativity_rank`, `creativity_rank_type`, `threat_rank`, `threat_rank_type`, `ict_index_rank`, `ict_index_rank_type`, `now_cost_rank`, `now_cost_rank_type`, `form_rank`, `form_rank_type`, `points_per_game_rank`, `points_per_game_rank_type`, `selected_rank`, `selected_rank_type` |
| Per-90 normalized stats | `expected_goals_per_90`, `expected_assists_per_90`, `expected_goal_involvements_per_90`, `expected_goals_conceded_per_90`, `saves_per_90`, `goals_conceded_per_90`, `starts_per_90`, `clean_sheets_per_90`, `defensive_contribution_per_90` |
| Pricing / value | `cost_change_event`, `cost_change_event_fall`, `cost_change_start`, `cost_change_start_fall`, `price_change_percent`, `value_form`, `value_season` |
| Identity / bio | `code`, `team_code`, `photo`, `opta_code`, `has_temporary_code`, `region`, `birth_date`, `team_join_date`, `known_name`, `squad_number`, `special`, `removed`, `can_select`, `can_transact` |
| Editorial | `scout_risks`, `scout_news_link` |
| Transfer, gameweek-scoped | `transfers_in_event`, `transfers_out_event` |

⭐ = highest value for the app you're planning — set-piece order tells you who's on penalties/free kicks/corners for every club (verified live, e.g. Saka is Arsenal's #1 penalty taker, #2 direct-free-kick taker, #6 corners option), and `ep_this`/`ep_next` are FPL's own official predicted-points model, which most third-party FPL sites lean on heavily.

**Group B — the underlying stat already exists in the dictionary, but only documented under `Live Data`/`Element Summary` (per-gameweek context), not under the `Elements` table (season-cumulative context) — a cross-reference gap, not a totally new concept (19 fields):**
`clearances_blocks_interceptions`, `creativity`, `expected_assists`, `expected_goal_involvements`, `expected_goals`, `expected_goals_conceded`, `goals_conceded`, `ict_index`, `influence`, `own_goals`, `penalties_missed`, `penalties_saved`, `recoveries`, `red_cards`, `saves`, `starts`, `tackles`, `threat`, `yellow_cards`.

**Other observations:**
- `status` values seen live: `a` (514 players), `d` (18), `i` (20), `s` (2), `u` (1). The dictionary lists `a, d, i, n, s` — `n` wasn't observed and `u` (unavailable, likely for a player who's left/loaned out of the league) isn't documented. Recommend updating the possible-values list to `a, d, i, s, u, n` and clarifying `u` vs `n`.
- `special` was `false` for all 555 players — reserved for a special/showcase player slot, not currently in use.
- `now_cost` ranges from `40` (£4.0m) to `155` (£15.5m) this preseason — useful as a sanity bound for budget UI.
- Squad sizes per club currently range **25–32** players (avg ~28), well above the ~15-per-club steady state you'd see mid-season — the summer transfer window is still open. One spot-checked player (`van Oevelen`) has `team_join_date: 2026-07-21`, two days before this snapshot, confirming the data updates with live transfer activity.

### Price Change Predictor (2026/27, `elements[]`)

New in 2026/27 bootstrap — powers FPL's `/en/price-changes` page. No separate API; read from `bootstrap-static` `elements[]`:

| Field | Type / notes |
|---|---|
| `price_change_percent` | string/number — current % progress toward next £0.1m rise/fall |
| `price_change_hourly_rate` | int — transfer velocity signal |
| `price_change_projections` | array of `{offset, projected_percent, likelihood}` — `offset: 0` is tonight's predicted progress |
| `price_change_calibrating` | bool — hide until calibrated (early GW) |
| `price_change_locked_until` | ISO timestamp or null — price locked until GW1 deadline |

**`likelihood` → status label** (empirical mapping used by this repo's Prices page — FPL does not document the integer scale):

| `likelihood` | Label |
|---|---|
| 5, 4 | Very likely to rise |
| 3, 2 | Likely to rise |
| −2, −3 | Likely to drop |
| −4, −5 | Very likely to drop |
| −1, 0, 1 | Unlikely to change (excluded from our table) |

Extracted by `site/fetch_prices.py` into `site/price_changes_data.js` on a **4-hour** cadence. Slim check-ins are stored under `snapshots/price-changes/` (~4 days retained) and power a **3-day progress sparkline** on the Prices page (Prediction mode). **Actual** price changes are detected at **00:00 UK** via `fetch_price_actual.py` into `snapshots/price-actual/actual-changes.json`; season history is backfilled from consecutive bootstrap snapshots (`backfill_price_actual.py`). Daily price changes apply at **00:00 Europe/London** during the season.

---

## 4. Critical Preseason Behavior (not covered by either existing doc)

Both existing docs were written mid-season and implicitly assume gameweeks are in progress or just finished. None of this is wrong — it's just a state the docs never had to describe. If you start building now, these will matter:

1. **Season-cumulative fields on `elements[]` are not reset to zero pre-season — they mirror last season's final totals.** Verified directly: David Raya's `total_points: 162`, `minutes: 3330`, `bps: 633`, `clean_sheets: 19` in the live `elements[]` array are an **exact match** to his `2025/26` entry in `history_past`. `event_points` is `0` (correct — no gameweek has happened), but `total_points`, `minutes`, `bps`, `ict_index`, all the rank fields, etc. are stale until GW1 data starts landing. **Don't build a "reset to zero" preseason UI expecting zeros in these fields — check `events[].is_current`/`is_previous` (all false right now) instead, and treat non-zero season totals as "last season's numbers" until a gameweek goes live.**
2. **No gameweek is `is_current` or `is_previous` pre-season** — only `is_next` (GW1) is true. Any logic assuming exactly one `is_current: true` event exists at all times needs a preseason branch.
3. **`teams[].strength*` and `.form` are `null`/`0` pre-season** — FDR (fixture difficulty ratings shown via `team_h_difficulty`/`team_a_difficulty` on fixtures) are already populated on the 380 pre-scheduled fixtures, but the teams' own strength ratings aren't calculated yet.
4. **`element-summary/{id}/history` is an empty array pre-season**; use `history_past` for last-season (and earlier — this player has 5 seasons back to 2021/22) stats. `history` only starts populating once GW1 is played.
5. **`event/{gw}/live` returns `{"elements": []}`**, not an error, for a gameweek with no data yet — code that only checks HTTP status won't catch this; check array length.
6. **`fixtures/` already returns the full 380-match season schedule** pre-season, with `stats: []` and `pulse_id: 0` on every unplayed match, `started`/`finished`/`finished_provisional` all `false`. This is good — you can build a full-season fixture list UI before a ball is kicked.
7. **`dream_team/{gw}/` 404s with an HTML error page (not JSON)** for a gameweek that hasn't happened — needs a content-type check or try/catch around JSON parsing, not just an HTTP-status check.
8. **`my-team/{id}/` requires session authentication** (`{"detail": "Authentication credentials were not provided."}` without it) — unlike every other endpoint audited here, which are all public/unauthenticated. If your app needs a logged-in user's actual current picks/bank/free-transfer state before a deadline, this is the one endpoint that needs an auth flow; everything else in this audit works anonymously.

---

## 5. Endpoints confirmed live but absent from both docs

### `GET /event-status/`
Pre-season: `{"status": [], "leagues": ""}`. This is FPL's own day-by-day bonus/data-confirmation tracker during a live gameweek (an empty `status` array here, filling in with per-matchday entries once fixtures are played) — likely more reliable than inferring "is bonus confirmed yet" purely from `fixtures[].finished` + `bonus` fields, since it's the same signal FPL's own site uses. Worth revisiting once GW1 is underway to capture its populated shape.

### `GET /team/set-piece-notes/`
```json
{
  "last_updated": "2026-07-22T18:37:17Z",
  "teams": [
    {"id": 1, "notes": [{"external_link": true, "info_message": "Check back for additional notes soon", "source_link": ""}]}
  ]
}
```
FPL's own editorial notes on each club's set-piece order (a prose complement to the `penalties_order`/`direct_freekicks_order`/`corners_and_indirect_freekicks_order` fields in §3.8). Currently placeholder text for all 20 teams pre-season ("Check back for additional notes soon"); expect it to populate with real content once preseason friendlies/GW1 give FPL's editors something to say.

### `GET /leagues-classic/{league_id}/standings/`
Referenced conceptually in the reference doc's code samples but its schema is never shown. Confirmed structure:
```json
{
  "new_entries": {"has_next": false, "page": 1, "results": []},
  "last_updated_data": null,
  "league": {"id": 14, "name": "...", "created": "...", "closed": false, "max_entries": null, "league_type": "s", "scoring": "c", "admin_entry": null, "start_event": 1, "code_privacy": "p", "has_cup": true, "cup_league": null, "rank": null},
  "standings": {"has_next": false, "page": 1, "results": []}
}
```
`standings.results` is paginated (`has_next`/`page`) — worth noting since the reference doc's mini-league standings code treats `standings.results` as a complete array without handling pagination for leagues over the page size.

### `GET /entry/{id}/history/`
Confirmed structure matches the dictionary, but `past[]` (season-by-season history) has one undocumented field: **`rank_percentage`** (string, e.g. `"0.1"`) alongside `season_name`, `total_points`, `rank`. Also confirmed `chips: []` is a top-level array on this endpoint (empty pre-season) — the dictionary currently only documents chip usage inside the picks endpoint, not here.

### `GET /my-team/{id}/`
Requires session auth; not reachable anonymously. Flagged in §4.8 above — noted here for completeness of the endpoint inventory.

---

## 6. Rule and format details worth designing around

- **Two Wildcards per season**, first-half (GW2–19) and second-half (GW20–38), each usable once — same pattern for Free Hit, Bench Boost, and Triple Captain (see the chip table in §3.6). Design transfer/chip UI around chip `id`, not `name`.
- **`transfers_cap: 20`** — a hard per-gameweek transfer limit that neither doc mentions. Relevant if you ever let a user simulate/queue transfers beyond what FPL itself would allow.
- **Free transfers can bank up to 5** (`max_extra_free_transfers: 4`, i.e. 1 base + 4 extra) — this matches what `FPL_API_COMPLETE_REFERENCE.md` already documents correctly; no conflict, just confirmed straight from the rules object instead of inferred.
- **Defensive Contribution reward is explicit and position-scoped**: `defensive_contribution: {GKP: 0, DEF: 2, MID: 2, FWD: 2}` points when the threshold is met — consistent with, and now backed by, the DEFCON thresholds already in the reference doc (DEF: 10, MID/FWD: 12 raw actions to trigger it).
- **Manager mode (`mng_*` scoring) exists in the shared config but isn't part of the classic game's `elements[]`/`element_types` structure** — if the app ever wants to support "Fantasy Premier League: Manager" (picking real managers instead of players), that's a separate research task with its own endpoints, not something bootstrap-static exposes for this game mode.

---

## 7. Recommended edits to the existing docs

### `FPL_DATA_DICTIONARY.md`
1. **Elements Array table**: add the 58 Group-A fields from §3.8, and cross-reference the 19 Group-B fields to note they also appear as season-cumulative totals in this table (not just per-gameweek in Live Data/Element Summary).
2. **Events Array table**: add the 10 fields from §3.2.
3. **Teams Array table**: add the 5 fields from §3.3.
4. **Element Types table**: add `ui_shirt_specific`, `sub_positions_locked`.
5. **New sections needed**: `phases[]`, `game_config` (`rules`/`scoring`/`settings`) with `game_settings` noted as its legacy duplicate, `/event-status/`, `/team/set-piece-notes/`, `/leagues-classic/{id}/standings/`.
6. **Clarify `total_players`** wording (registered managers, not football players).
7. **Manager History `past[]`**: add `rank_percentage`; note top-level `chips[]` array on the history endpoint.
8. **`status` possible values**: change `a, d, i, n, s` to `a, d, i, s, u` (n unconfirmed live, u confirmed live).

### `FPL_API_COMPLETE_REFERENCE.md`
1. **Add a "Preseason / Season-Transition Behavior" section** — the 8 points in §4 of this audit. The doc currently has no coverage of what the API looks like before a season starts, which matters given the user is building against it right now, months before GW1.
2. **Add a "Set-Piece Takers" section** covering `penalties_order`/`direct_freekicks_order`/`corners_and_indirect_freekicks_order` (+ `_text` companions) and `/team/set-piece-notes/` — likely high-value for captaincy/differential features.
3. **Add an "Official Expected Points" section** for `ep_this`/`ep_next` — FPL's own predicted-points model, straight from the API.
4. **Note that `game_config.scoring` now exposes the full scoring rulebook as data** — recommend reading point values from there rather than hardcoding them, and mention the per-gameweek `events[].overrides.scoring` mechanism for special-rule gameweeks.
5. **Add the chip id/name split gotcha** from §3.6 (each chip name appears twice, half-season-scoped) to whatever section discusses chip handling.
6. **Document `/leagues-classic/{id}/standings/` schema** including standings pagination, since the mini-league standings code samples assume `standings.results` is complete.

---

## 8. Suggested next steps

- **Re-crawl just before the GW1 deadline (2026-08-21)** to see squads settle (currently 25–32/club, will trim toward ~15–25 as the transfer window closes) and prices stabilize.
- **Re-crawl right after GW1 completes** — this is the one that will confirm exactly when/how the stale 2025/26 cumulative totals reset, when `is_current` first flips true, and what `event/1/live` looks like with real data. That's the biggest unverified assumption in this audit (based on `history_past` matching current totals, not on observing the reset itself).
- **Periodically snapshot `bootstrap-static/` yourself** (a few times per season, e.g. after each price-change window) if you want your own historical archive — the API doesn't expose past-season `elements[]`-shaped snapshots itself, only `history_past` aggregates and `element-summary/{id}/history` per-player per-gameweek detail.

---

## 9. ID Stability Across Seasons (verified 2026-07-23)

**Question:** can `elements[].id` / `teams[].id` be trusted as a stable key for building cross-season graphs (season stat totals, multi-year player/team trends)?

**Answer: no, not `id` — but `code` is stable, and the API itself already relies on `code` for this.** Verified empirically, not inferred: pulled a real archived `bootstrap-static` snapshot from **2026-01-25** (mid 2025/26 season, via the Wayback Machine — `web.archive.org/web/20260125000135/https://fantasy.premierleague.com/api/bootstrap-static/`) and diffed it against the live 2026-07-23 (2026/27 preseason) snapshot already saved in [`snapshots/`](snapshots/).

### 9.1 Teams: `id` reshuffles every season, `code` doesn't

`teams[].id` is a 1–20 index over whichever 20 clubs are in the league *this season* — every promotion/relegation reshuffles it for every other club, even ones that didn't move:

| Team | `id` 2025/26 | `id` 2026/27 | `code` (both seasons) |
|---|---|---|---|
| Bournemouth | 4 | 3 | 91 — stable |
| Brentford | 5 | 4 | 94 — stable |
| Brighton | 6 | 5 | 36 — stable |
| Chelsea | 7 | 6 | 8 — stable |
| Leeds | 11 | 13 | 2 — stable |
| Liverpool | 12 | 14 | 14 — stable |
| Man City | 13 | 15 | 43 — stable |
| Man Utd | 14 | 16 | 1 — stable |
| Newcastle | 15 | 17 | 4 — stable |
| Sunderland | 17 | 20 | 56 — stable |
| Tottenham | 18 | 19 | 6 — stable |
| Burnley | 3 | *relegated — absent from 2026/27* | 90 |
| West Ham | 19 | *relegated — absent from 2026/27* | 21 |
| Wolves | 20 | *relegated — absent from 2026/27* | 39 |
| Coventry / Hull / Ipswich | *absent from 2025/26* | 7 / 11 / 12 | 9 / 88 / 40 (new entries) |

`code` never changed for a single club across the two snapshots. `id` changed for every club below Aston Villa in the list, purely because Burnley dropped out and Coventry was inserted alphabetically ahead of it.

### 9.2 Players: same pattern, and stale ids get silently reassigned to a *different person*

| Player | `id` 2025/26 | `id` 2026/27 | `code` (both seasons) |
|---|---|---|---|
| Saka | 16 | 12 | 223340 — stable |
| Ødegaard | 17 | 15 | 184029 — stable |
| Haaland | 430 | 411 | 223094 — stable |
| Cole Palmer | 235 | 154 | 244851 — stable |
| M. Salah | **381** | *transferred out — absent from 2026/27 elements* | 118748 |
| *(whoever now holds id 381)* | — | **Koumas**, a different Liverpool player entirely | 514514 |

That last row is the sharp edge: a hardcoded `id: 381` doesn't error next season — it silently starts pointing at a real, different person's stats. `id: 624` (Bowen, West Ham, in the 2025/26 doc examples) is currently unassigned in 2026/27 (West Ham relegated), but nothing guarantees it stays unassigned next season either.

Also confirmed live: `web_name` is not even a safe unique key **within a single season** — the current data has two different players both with `web_name: "Palmer"` (Cole Palmer, Chelsea, MID, `code: 244851`; Alex Palmer, Liverpool, GK, `code: 112520`).

### 9.3 Recommended join strategy

- **Primary key for anything persisted across seasons:** `elements[].code` (players), `teams[].code` (teams). Both are FPL's underlying Opta/Pulse-style permanent identifiers and were stable across every club/player checked above.
- **Treat `id` as ephemeral, season-scoped:** safe to use only for joins *within* data pulled together in the same season/snapshot (e.g. matching a gameweek's `picks[].element` to that same gameweek's `elements[].id`, or `fixtures[].team_h`/`team_a` to that season's `teams[].id`). Never store a raw `id` long-term without `code` alongside it, and never assume a prior season's `id` still means the same thing.
- **`element-summary/{id}/history_past[]` already does this for you** — it's keyed by `element_code`, not `id`. That's effectively FPL confirming `id` isn't meant to survive a season boundary.
- **Suggested schema shape:**
  - `players(code PK, first_name, second_name, web_name)` — `web_name` for display only, never for lookup (see the Palmer/Palmer collision above).
  - `player_seasons(code FK, season_name, current_season_id nullable, team_code, position, total_points, minutes, goals_scored, assists, bonus, bps, ict_index, ...)` — populate from `history_past[]` for past seasons, from your own periodic `elements[]` captures for the current one.
  - `teams(code PK, name, short_name)`.
  - `team_seasons(code FK, season_name, current_season_id nullable, strength ratings, division)`.

### 9.4 A real gap this exposes: `history_past[]` doesn't include team affiliation

Beyond id instability, `element-summary/{id}/history_past[]` gives season **totals** (points, minutes, goals, bonus, bps, ict, etc.) but **no team field at all** — you can't tell which club a player was at in a past season from this array. Combined with §8's point about the API not exposing past-season `elements[]` snapshots, this means:

- **Season-total graphs** (e.g. "Salah's points by season," "goals per season for player X") are directly buildable today from `history_past[]`, keyed by `code` — no extra joins needed, this part just works.
- **Gameweek-level graphs across past seasons** (e.g. "points by gameweek, 2023/24 vs 2025/26") and **anything requiring past-season team affiliation** cannot be built from the live API alone. You'd need either your own periodic snapshots captured going forward (already started in [`snapshots/`](snapshots/) — worth turning into a scheduled job), or a third-party historical archive to backfill seasons before you started capturing your own. The community-maintained `vaastav/Fantasy-Premier-League` GitHub repo is the commonly-cited source for this kind of backfill — verify its current maintenance status yourself before depending on it, since it's a third-party project outside FPL's own API.
