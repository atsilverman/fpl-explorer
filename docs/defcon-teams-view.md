# DefCon page — Teams view (parked)

Add a **Players | Teams** switcher to the DefCon page (like the Gameweek page mode seg `#live-mode-seg`). Players = current view. Teams = team-level heatmap showing which clubs concede (or produce) DefCon hits.

## Decisions (agreed)

- **Both directions**, with an **Against | For** toggle shown only in Teams view.
  - **Against**: opponent outfield players who hit DefCon vs this team in that GW.
  - **For**: this team's own outfield players who hit DefCon.
- **Cell = hit count** on a heat wash (teal, `hsl(var(--check-threshold) / alpha)`, alpha = count / max visible count). **% goes in the tooltip and the totals**.
- Hide the floating Opponents FAB in Teams view.

## Layout

- Rows: 20 clubs (crest + name).
- Columns: each finished GW, then **Hits** (total), **Per game**, **Rate %** (hits / outfielders who played).
- Tooltip example: `GW3 vs ARS (A) · 4 of 11 outfielders hit (36%)`.
- Sortable: team name, total, per game, rate, any GW column.
- Filters: position filter changes which players count (e.g. DEF-only); team filter + search narrow rows. Price / owned filters don't apply.
- Count label: `N teams`.

## Data

- Source: `DATA.defconByGw[gw][elementId]` → `{ teamId, defConHit, minutes, elementType }`. Count only `minutes > 0`, `elementType` 2/3/4 (GK ineligible).
- No FPL team id → code map in `DATA`. Build one by voting: element id → player row (`livePlayerByElement`) → `currentTeamCode(row)`, majority per `teamId`. Or add `teamCodeById` in `build.py` from bootstrap `teams` (cleaner).
- Opponents per GW: `defconFixturesForTeamGw(team, gw)` (falls back to `DATA.liveFixturesByGw`, which covers the same GWs as `defconByGw`; `FIXTURES_BY_TEAM` is upcoming-only).
- Compute **For** per team/GW first; **Against** for team T = sum of **For** over T's opponents that GW.
- **DGW caveat**: per-GW element data merges both matches, so Against in a DGW includes the opponent's hits from its other match too. Flag it in the tooltip.

## Implementation sketch

1. State: `defconView: "players" | "teams"`, `defconTeamMode: "against" | "for"`, `defconTeamSortKey` / `defconTeamSortDir`.
2. HTML in `.defcon-toolbar-bar`: `#defcon-view-seg` (`data-defcon-view`) and `#defcon-team-mode-seg` (`data-defcon-team-mode`, `hidden` unless Teams) using `segmented ownership-mover-seg`. Sync with `syncSegThumb`.
3. `renderDefcon()` branches to `renderDefconTeams()` when `defconView === "teams"`; reuse `#defcon-table-head` / `#defcon-table-body`.
4. `syncDefconOpponentsDock()`: show only when `page === "defcon" && defconView === "players"`.
5. Add Teams copy to the DefCon page-info legend.
6. Bump `app.js?v=` / `styles.css?v=`.
