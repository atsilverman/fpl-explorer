# FPL player identity in FPL Explorer

Three player keys coexist in this project. Use the right one for each join.

## Keys

| Key | Example (Gabriel) | Scope | Used for |
|-----|-------------------|-------|----------|
| Hub pid `id` | `DEF-Gabriel-ARS` | 2025/26 OPTA stats only | Statistics table rows, CSV joins |
| Stable `code` | `226597` | Cross-season (FPL/Opta) | Price matching, ownership trends, identity bridge |
| Live `element` | `4` | Current bootstrap only | Home squad, `ownersByElement`, picks API |

**Rule:** Never join live Home/league data using Hub `id` or `Number(row.id)` on catalog rows. Those strings are not FPL element ids.

See also [`FPL_API_AUDIT_2026-07-23.md`](FPL_API_AUDIT_2026-07-23.md) §9 for API evidence that `code` is stable and `element`/`id` reshuffle every season.

## Where each layer lives

- **2025/26 OPTA** — `DATA.players.combined` in [`site/data.js`](../site/data.js). Matched rows also get `code`, `newTeam`, `newPosition`, `element2627` from [`site/build.py`](../site/build.py) price matching.
- **2026/27 live FPL** — `DATA.nextSeasonPlayers.combined`. Each row has `code`, `element`, `id: "fpl-{code}"`.
- **Identity bridge** — `DATA.fplIdentity.elementByCode` in `data.js` (built from bootstrap snapshot).
- **Home cache** — `HOME.squad[].element`, `HOME.ownersByElement[elementId]` in [`site/home_data.js`](../site/home_data.js).

## Client helper

[`site/app.js`](../site/app.js) exposes `fplElementIdForRow(row)`:

1. `row.element2627` or `row.element` if present
2. Else `DATA.fplIdentity.elementByCode[row.code]`
3. Else squad fallback by `code`

Home search always uses the 2026/27 catalog and this helper for league ownership.

## Build coverage (typical)

- ~381/420 Hub players match a 2026/27 element via name/team/position (`code` + `element2627`)
- ~39 departed/unmatched (no current element — expected)
- ~600 players in `nextSeasonPlayers` with full `code` + `element`

Run `python3 site/build.py` after bootstrap snapshot updates to refresh `fplIdentity` and price matches.

## Debugging league ownership

1. Find player in `nextSeasonPlayers.combined` → note `element` and `code`
2. Check `HOME.ownersByElement[element]` in `home_data.js`
3. Confirm `fplElementIdForRow(searchRow)` returns that same element id

If step 3 fails, ownership highlight will not work even when step 2 has data.
