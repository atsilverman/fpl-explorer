# Weekly GW readout

Living spec for a **local, post-gameweek** LLM/agent readout, baked into the **Report** page. Viewers stay offline: they only read `site/report_data.js`. Generation runs on a machine with caches (and FPL API if a pack is stale).

**How to contribute:** add topics under [Inbox](#inbox) if you are unsure; otherwise edit T01–T08. Date notes (`YYYY-MM-DD`).

---

## Vision

Each week, after the gameweek is settled, we gather evidence for **configured managers** and write a formal brief: risk and reward on the upcoming run, recent performance, injuries, and league context. The brief is stored as structured JSON (player mentions are ids, not bare names) and rendered on **Report**.

This is not a live dashboard. It is a **weekly bake**, like Statistics — not Home live polling.

## Working assumptions

| Constraint | Current take |
|------------|----------------|
| Cadence | Once per GW, **after the last full-time** (not per kickoff wave) |
| Runtime | Local gather + LLM/agent; site is static |
| Engine | Agent walks T01–T08 using the context pack; does not invent fixtures, news, or points |
| Audience | Configured managers (not a generic meta article) |
| Test manager | **Adam Silverman** — entry `296817`, SD Spurs, league `954157` (`site/home_prefs.json`) |
| Inputs | Prefer caches; `element-summary` only for the focus squad’s minutes history |
| Output | `window.FPL_REPORT` → Report page; player names open the existing details card |

## Status

| | |
|---|---|
| Product | T01–T08 locked; Report page ships the bake |
| Pipeline | `python3 site/build_report.py` gathers packs; agent/LLM fills JSON; `--bundle` writes `report_data.js` |
| Delivery | Report tab (after Gameweek) |
| First dry run | Adam `296817`, source GW3 |

---

## Inbox

Paste extras here before they become topics.

<!-- USER LIST GOES HERE -->

---

## Topics & sub-analyses

Canonical **page order**. Status: `idea` · `wanted` · `specified` · `cut`.

**Likely starts:** every `starter: true` pick, plus bench that is not fodder. **Dead spots (skip in T07 and most player callouts):** backup GK; benched players at £4.5m or less (the 4.5m benched forward case). Injured bench can still appear under T02.

### T01 — League recap
- **Status:** specified
- **Answers:** How did this team do in the GW that just finished, on the pitch and vs the mini-league?
- **Sub-analyses:**
  - GW points, official vs live if they still differ, chip used (e.g. Triple Captain)
  - Autosubs, captain haul / blank, notable DNPs in the XI
  - League rank and delta vs previous GW; who scored more/less among rivals
- **Likely inputs:** `HOME.summary`, `HOME.squad`, `HOME.standings` (`eventTotalOfficial` / `gwPointsLive` / `rankOfficial` / `rankPrev`)
- **Notes:** Recap is section 1 so the brief reads past → future.

### T02 — Injuries
- **Status:** specified
- **Answers:** Who is flagged, newly or for a long stretch?
- **Sub-analyses:**
  - `availStatus` not `a`, `news`, `newsAdded`, `chanceThis` / `chanceNext`
  - Distinguish long-standing (Rodon-style dated return) vs news added this week
- **Likely inputs:** bootstrap / `player_availability_fields`, squad rows
- **Notes:** Do not invent injuries. If news is empty and status is available, skip.

### T03 — Form
- **Status:** specified
- **Answers:** Who among likely starts is clearly in or out of form?
- **Sub-analyses:**
  - Bootstrap `form` and `formPts` GW series
  - Only standouts (high form vs near-blank); ignore the mushy middle
- **Likely inputs:** catalog / bootstrap on likely starts
- **Notes:** Early season: require a visible gap, not a 0.3 form difference.

### T04 — Over / under xGI (and related)
- **Status:** specified
- **Answers:** Who has clearly out- or under-performed expected involvement?
- **Sub-analyses:**
  - Goals + assists vs `xgi`; goals vs `xg`; assists vs `xa`
  - 2026/27 has **no Hub xPts** — do not fake season xPts
- **Likely inputs:** `nextSeasonPlayers` / bootstrap expected_* vs scored
- **Notes:** Only standouts (e.g. large G+A vs xGI). Do not list everyone with a 0.2 gap.

### T05 — Early subs
- **Status:** specified
- **Answers:** Who has a pattern of being hooked (Home MP yellow/red idea)?
- **Sub-analyses:**
  - Last few GWs of `element-summary` `history`: minutes, yellow/red
  - Short = played but &lt; 60′; modest = 60–75′; DNP = 0′
  - One 66′ outing is a note, not a pattern; repeat short minutes is the callout
- **Likely inputs:** FPL `GET /element-summary/{id}/` for the focus squad only
- **Notes:** Tie to yellow/red cards when they explain the hook.

### T06 — Midweek watch
- **Status:** specified
- **Answers:** Which likely starts have cups / Europe that could affect the next FPL GW (injury, start, early sub)?
- **Sub-analyses:**
  - Confirmed `CALENDAR.byTeam` rows (EFL, UCL, UEL, UECL, FA Cup)
  - Soft round windows if the club is typically in that competition
- **Likely inputs:** `site/calendar_data.js`
- **Notes:** Mention monitoring, not a predicted lineup.

### T07 — Fixture run (3–5 GWs)
- **Status:** specified
- **Answers:** Is the next 3–5 Premier League run good or bad for likely starts, and should we consider transferring out?
- **Sub-analyses:**
  - Per-player (or clustered by club) FDR / H-A list for outlook GWs
  - Transfer-out risk only when the run is clearly poor **and** the player is a real starter. **Never** list Haaland (or similar premium captains) as sellable — they are essential holds even through a tough FDR stretch.
- **Likely inputs:** `DATA.fixturesByTeam` / fixtures snapshot (`gw`, `opp`, `ha`, `difficulty`)
- **Notes:** Skip dead spots. Average FDR ≥ 4 across the window is the usual “consider moving on” bar; easy run is hold/trust. Essential premiums stay Hold/Essential regardless of FDR.

### T08 — Differentials
- **Status:** specified
- **Answers:** Low owned (TSB% and/or mini-league) names that just played well or sit at the top of a ranking — worth attention, not necessarily a transfer in.
- **Sub-analyses:**
  - Low `selected_by_percent` and/or few entries in `HOME.ownersByElement`
  - Recent GW points, form, or season rank among that position
  - Prefer names **not** already in the manager’s XI unless the point is “you already have the differential”
- **Likely inputs:** ownership check-in, `ownersByElement`, bootstrap points/form
- **Notes:** A handful of callouts, not a fishing net.

---

## Data we can already use

| Layer | Where | Typical use |
|-------|--------|-------------|
| Home cache | `site/home_data.json` / `fetch_home.py` | Squad, chips, standings, league owners |
| Bootstrap / fixtures snapshots | `snapshots/` | Prices, news, form, xG/xGI, FDR |
| Stats bundle | `site/build.py` → `site/data.js` | Catalog identity (`code` / `element`) |
| Ownership | `site/fetch_ownership.py` | TSB% |
| Calendar | `site/fetch_calendar.py` | Cups / Europe |
| Identity | [`FPL_IDENTITY.md`](FPL_IDENTITY.md) | Never join live data on Hub `id` |
| Minutes history | FPL `element-summary` | T05 early subs |

## Pipeline

Run **after the last FT** of the GW (same settled-GW idea as matchday rebuild, but **once**, not per wave).

```text
python3 site/build_report.py
# writes snapshots/reports/context_{managerId}_gw{N}.json

# Fill structured report (Cursor agent or local OpenAI-compatible LLM).
# Then:

python3 site/build_report.py --bundle snapshots/reports/report_{managerId}_gw{N}.json
# writes site/report_data.js

# Bump report_data.js?v= in site/index.html, then deploy if asked.
```

1. **Gather** — `build_report.py` reads `site/report_prefs.json` managers (start: `296817`). Uses Home + bootstrap + fixtures + calendar; fetches element-summary for the focus squad.
2. **Write** — LLM/agent fills T01–T08 using **only** the pack. Player mentions must be `{ element, code, name }`.
3. **Bundle** — slim `window.FPL_REPORT`.
4. **Deliver** — Report page. Footer `generatedAt` is the bundle time, never `Date.now()`.

Do **not** add a GitHub Action for the LLM. Do **not** poll Report live.

### Prompt (weekly fill)

You are writing one manager’s post-GW brief. Use only the context pack. Follow T01–T08 order. Skip dead-spot players in T07. Only standouts in T03/T04/T08. Haaland (and similar premium captains) are essential holds — never a transfer-out. Prefer visual blocks (`stats`, `bars`, `minutes`, `fixture-runs`, `callouts`, `watch`) plus short copy. Every player mention is an inline `player` object with `element`, `code`, and `name` from the pack. Output JSON matching [Output shape](#output-shape).

## Output shape

`window.FPL_REPORT`:

```json
{
  "generatedAt": "2026-09-10T00:00:00Z",
  "sourceGw": 3,
  "outlookGws": [4, 5, 6, 7, 8],
  "reports": {
    "296817": {
      "managerId": 296817,
      "teamName": "SD Spurs",
      "managerName": "Adam Silverman",
      "leagueName": "SoCal Big Guy FPL",
      "sections": [
        {
          "id": "recap",
          "title": "League recap",
          "blocks": [
            { "type": "h3", "text": "Optional subhead" },
            {
              "type": "p",
              "inlines": [
                { "text": "Triple-captain " },
                { "player": { "element": 430, "code": 223094, "name": "Haaland" } },
                { "text": " returned 27." }
              ]
            }
          ]
        }
      ]
    }
  }
}
```

Section ids (fixed): `recap`, `injuries`, `form`, `overUnder`, `earlySubs`, `midweek`, `fixtures`, `differentials`.

Visual block types (optional, mixed with `p` / `h3`): `stats` (metric tiles), `bars` (form / xGI), `minutes` (GW minute columns), `fixture-runs` (FDR pills + Hold/Move/Essential/Watch), `callouts` (differential chips), `watch` (cup/Europe rows). Fixture pills are resolved at render from `DATA.fixturesByTeam`.

## Report page

- Nav label **Report**, after Gameweek.
- Article: `h2` section titles, optional `h3`, body copy, and visual blocks (`stats`, `bars`, `minutes`, `fixture-runs`, `callouts`, `watch`). Club badges sit left of player names. **Bold** player buttons open `openPlayerDetailsFromRow`. Header shows a faint N min read estimate.
- Empty state if this Home manager has no bake.
- No Statistics toolbar / mobile Filters dock.

## Open questions

- Local Ollama vs Cursor agent for later weeks (v1 is agent-filled JSON).
- When to add other `tracked_ids.json` managers to `report_prefs.json`.

---

## Changelog

| Date | Note |
|------|------|
| 2026-09-09 | Doc created. |
| 2026-09-10 | Report visuals: fixture-run pills, bars, badges, read time; Haaland is an essential hold. |
