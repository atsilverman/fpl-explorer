/* FPL Data Explorer — client-side filter/sort/group/aggregate over the
   embedded season data in data.js. No build step needed to browse; run
   build.py again if the source CSVs change. */

(function () {
  "use strict";

  const DATA = window.FPL_DATA;
  const MARKETS = window.FPL_MARKETS || { generatedAt: null, meta: {}, fixtures: [] };
  const OWNERSHIP = window.FPL_OWNERSHIP || { generatedAt: null, checkIns: [] };
  const LEAGUES = window.FPL_LEAGUES || { generatedAt: null, managers: [], leagues: [] };
  const HOME = window.FPL_HOME || {
    generatedAt: null,
    gw: null,
    managerId: null,
    leagueId: null,
    summary: null,
    squad: [],
    squadsByEntry: {},
    standings: [],
    ownersByElement: {},
    elementGw: {},
    error: null,
  };
  window.FPL_HOME = HOME;
  // Prefer ownership bundle (refreshed with bootstrap) over build-time data.js.
  const GAMEWEEKS =
    OWNERSHIP.gameweeks ||
    DATA.gameweeks ||
    (DATA.fixturesMeta && DATA.fixturesMeta.gameweeks) ||
    { previous: null, current: null, next: null, source: null };
  const TEAM_NAMES = { ...DATA.teamNames, ...(DATA.fixtureTeamNames || {}) };
  const TEAM_BADGES = DATA.teamBadges || {}; // short code -> "badges/XXX.svg" (only where art exists)
  // Dark-surface variants (navy/black crests that disappear on dark UI).
  const TEAM_BADGES_DARK = {
    TOT: "badges/TOT-white.svg",
  };
  // Soft dark-mode scatter disc tint — club primary mixed toward white in CSS.
  const TEAM_SCATTER_ACCENT = {
    ARS: "#ef0107",
    AVL: "#670e36",
    BHA: "#0057b8",
    BOU: "#da291c",
    BRE: "#e30613",
    CHE: "#034694",
    COV: "#69b3e7",
    CRY: "#1b458f",
    EVE: "#003399",
    FUL: "#000000",
    HUL: "#f18a01",
    IPS: "#3a64a3",
    LEE: "#1d428a",
    LIV: "#c8102e",
    MCI: "#6cabdd",
    MUN: "#da291c",
    NEW: "#241f20",
    NFO: "#dd0000",
    SUN: "#eb172b",
    TOT: "#132257",
  };
  const LEAGUE_POSITIONS = DATA.leaguePositions || {}; // short code -> 1..20
  const LEAGUE_POSITIONS_META = DATA.leaguePositionsMeta || {};
  const FIXTURES_BY_TEAM = DATA.fixturesByTeam || {};
  const POSITIONS = DATA.positions; // ["GK","DEF","MID","FWD"]
  // Filter chips for 2025/26 list clubs present in the OPTA export (relegated
  // already dropped at build). 2026/27 uses the full bootstrap 20.
  const TEAM_CODES = Object.keys(DATA.teamNames).sort((a, b) =>
    DATA.teamNames[a].localeCompare(DATA.teamNames[b])
  );
  const NEXT_SEASON_TEAM_NAMES = DATA.nextSeasonTeamNames || {};
  const NEXT_SEASON_TEAM_CODES = Object.keys(NEXT_SEASON_TEAM_NAMES).sort((a, b) =>
    NEXT_SEASON_TEAM_NAMES[a].localeCompare(NEXT_SEASON_TEAM_NAMES[b])
  );
  // Fallback if the build hasn't shipped nextSeason* yet.
  const ALL_TEAM_CODES = (NEXT_SEASON_TEAM_CODES.length
    ? NEXT_SEASON_TEAM_CODES
    : Object.keys(TEAM_NAMES)
  ).slice().sort((a, b) => TEAM_NAMES[a].localeCompare(TEAM_NAMES[b]));
  // Venue-split team stats for fixture tooltips (opponent home/away profile).
  const TEAM_STATS = {
    home: Object.fromEntries((DATA.teams.home || []).map((t) => [t.team, t])),
    away: Object.fromEntries((DATA.teams.away || []).map((t) => [t.team, t])),
    combined: Object.fromEntries((DATA.teams.combined || []).map((t) => [t.team, t])),
  };
  const FIXTURE_TT_DELAY_MS = 1000;
  const FIXTURE_TT_COUNT = 7;
  const OWNERSHIP_FILTER_DEFAULT = 5;
  const OWNERSHIP_FILTER_MAX = 100;
  // Lookback in check-ins (1 / 3 / 7). Maps to ~1 / 3 / 7 days once snapshots are daily.
  // Chart + cards color only the top N risers/fallers for that window.
  const OWNERSHIP_TREND_WINDOW_DEFAULT = 1;
  // Statistics-page fixture tooltip shading — wider than the players Enhance
  // default (10%) so tough/soft opponents read clearly in fixture tips.
  const FIXTURE_TT_ENHANCE_PCT = 30;
  const FIXTURE_GAMEWEEKS = Object.values(FIXTURES_BY_TEAM)
    .flat()
    .map((fixture) => Number(fixture.gw))
    .filter(Number.isFinite);
  const SCHEDULE_GW_MIN = FIXTURE_GAMEWEEKS.length ? Math.min(...FIXTURE_GAMEWEEKS) : 1;
  const SCHEDULE_GW_MAX = FIXTURE_GAMEWEEKS.length ? Math.max(...FIXTURE_GAMEWEEKS) : 38;

  // FPL triad: current when a GW is live; otherwise next (preseason / between GWs).
  function activeGameweek() {
    const cur = Number(GAMEWEEKS.current && GAMEWEEKS.current.id);
    if (Number.isFinite(cur)) return cur;
    const nxt = Number(GAMEWEEKS.next && GAMEWEEKS.next.id);
    if (Number.isFinite(nxt)) return nxt;
    const meta = DATA.fixturesMeta || {};
    const active = Number(meta.activeGw != null ? meta.activeGw : meta.currentGw);
    if (Number.isFinite(active)) return active;
    return SCHEDULE_GW_MIN;
  }

  // Planning horizon: next GW while current is live; else next/active.
  // Used by Team heat, Matchups defaults, and fixture tooltips.
  function planningGameweek() {
    const cur = Number(GAMEWEEKS.current && GAMEWEEKS.current.id);
    const nxt = Number(GAMEWEEKS.next && GAMEWEEKS.next.id);
    let n;
    if (Number.isFinite(cur)) {
      n = Number.isFinite(nxt) ? nxt : cur + 1;
    } else if (Number.isFinite(nxt)) {
      n = nxt;
    } else {
      n = Number(activeGameweek());
    }
    if (Number.isFinite(n) && n >= SCHEDULE_GW_MIN) {
      return Math.min(n, SCHEDULE_GW_MAX);
    }
    return SCHEDULE_GW_MIN;
  }

  function defaultScheduleGwWindow() {
    const start = Math.min(
      SCHEDULE_GW_MAX,
      Math.max(SCHEDULE_GW_MIN, planningGameweek())
    );
    return [start, Math.min(start + FIXTURE_TT_COUNT - 1, SCHEDULE_GW_MAX)];
  }
  const [SCHEDULE_GW_DEFAULT_MIN, SCHEDULE_GW_DEFAULT_MAX] = defaultScheduleGwWindow();

  function planningFixturesForTeam(teamCode, count = FIXTURE_TT_COUNT) {
    const startGw = planningGameweek();
    return (FIXTURES_BY_TEAM[teamCode] || [])
      .filter((fx) => Number(fx.gw) >= startGw)
      .slice(0, count);
  }
  // Whether build.py's 2026/27 price match ran — used to exclude players with
  // no price2627 (departed / not on the current FPL list).
  const HAS_PRICE_DATA = !!(DATA.newSeasonPriceMeta && DATA.newSeasonPriceMeta.source);

  function excludeDepartedPlayer(row) {
    return !isNextSeason() && HAS_PRICE_DATA && row && row.price2627 == null;
  }

  // Tall shield SVGs (Hull, Arsenal, Villa, …) fill the full crest-box height
  // while roundels leave side slack, so they read larger at the same CSS size.
  // Fit % is precomputed from each file's viewBox aspect (rsvg raster check);
  // square/circular art stays at 100. Regenerate: compare max/min viewBox sides,
  // pct = clamp(74, 100, round(100 * 1.05 / ratio)) when ratio > 1.08.
  // Rounded color-tile badges are already square with internal padding — no
  // per-crest shrink. (Legacy tall shields used fit % here.)
  const CREST_FIT_PCT = {};

  function badgeHTML(teamCode, className) {
    const src = TEAM_BADGES[teamCode];
    if (!src) return "";
    const cls = className ? `badge-img ${className}` : "badge-img";
    const fitAttr = (imgSrc) => {
      const pct = CREST_FIT_PCT[imgSrc];
      return pct && pct < 100 ? ` style="--crest-fit:${pct}%"` : "";
    };
    const darkSrc = TEAM_BADGES_DARK[teamCode];
    if (!darkSrc) return `<img class="${cls}" src="${src}"${fitAttr(src)} alt="" />`;
    return (
      `<img class="${cls} badge-img-light" src="${src}"${fitAttr(src)} alt="" />` +
      `<img class="${cls} badge-img-dark" src="${darkSrc}"${fitAttr(darkSrc)} alt="" />`
    );
  }

  function iconHTML(name, className) {
    const cls = className ? ` class="icon ${className}"` : ` class="icon"`;
    return `<svg${cls} aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function positiveFill(alpha) {
    return `hsl(var(--positive) / ${alpha})`;
  }

  function positiveHighlightFill(alpha) {
    return `hsl(var(--positive-highlight, var(--positive)) / ${alpha})`;
  }

  function negativeFill(alpha) {
    return `hsl(var(--negative) / ${alpha})`;
  }

  function fdrEasyFill(alpha) {
    return `hsl(var(--fdr-easy) / ${alpha})`;
  }

  function fdrHardFill(alpha) {
    return `hsl(var(--fdr-hard) / ${alpha})`;
  }

  function spectrumHighlightPaint(isEasy, intensity, palette) {
    const t = Math.min(1, Math.max(0, Number(intensity) || 0));
    if (t < 0.04) {
      return { backgroundColor: "", color: "", strong: false, skip: true, emphasize: false };
    }
    const dark = themePrefersDark();
    const base = isEasy ? palette.easy : palette.hard;
    if (t < 0.65) {
      // No alpha floor — the lowest ranks in the band should read as the row.
      const alpha = dark
        ? (isEasy ? t * 0.4 : t * 0.56).toFixed(3)
        : (t * 0.74).toFixed(3);
      return {
        backgroundColor: (isEasy ? palette.easyFill : palette.hardFill)(alpha),
        color: "",
        strong: false,
        emphasize: t >= 0.42,
      };
    }
    // Light-mode easy: richer wash, keep dark text — no color-mix toward black.
    if (!dark && isEasy) {
      const alpha = (0.5 + ((t - 0.65) / 0.35) * 0.26).toFixed(3); // ~0.50–0.76
      return {
        backgroundColor: palette.easyFill(alpha),
        color: "",
        strong: false,
        emphasize: true,
      };
    }
    // Strong band: mix toward black so white text stays readable.
    // Dark easy solids need more black so they don't glow.
    const blackPct = dark
      ? Math.round((isEasy ? 34 : 24) + ((t - 0.65) / 0.35) * (isEasy ? 18 : 16))
      : Math.round(18 + ((t - 0.65) / 0.35) * 16);
    return {
      backgroundColor: `color-mix(in srgb, ${base} ${100 - blackPct}%, black)`,
      color: "#fff",
      strong: true,
      emphasize: true,
    };
  }

  function enhanceHighlightPaint(kind, intensity) {
    return spectrumHighlightPaint(kind === "top", intensity, {
      easy: "hsl(var(--positive-highlight, var(--positive)))",
      hard: "hsl(var(--negative))",
      easyFill: positiveHighlightFill,
      hardFill: negativeFill,
    });
  }

  function fdrHighlightPaint(kind, intensity) {
    return spectrumHighlightPaint(kind === "easy", intensity, {
      easy: "hsl(var(--fdr-easy))",
      hard: "hsl(var(--fdr-hard))",
      easyFill: fdrEasyFill,
      hardFill: fdrHardFill,
    });
  }

  function enhanceHighlightInlineStyle(kind, intensity) {
    const paint = enhanceHighlightPaint(kind, intensity);
    if (paint.skip) return { style: "", strongClass: "" };
    const color = paint.color ? `;color:${paint.color}` : "";
    const kindClass =
      paint.emphasize || paint.strong ? (kind === "top" ? " highlight-top" : " highlight-bottom") : "";
    const strong = paint.strong ? " highlight-strong" : "";
    return {
      style: `background-color:${paint.backgroundColor}${color}`,
      strongClass: `${kindClass}${strong}`,
    };
  }

  function fdrHighlightInlineStyle(kind, intensity) {
    const paint = fdrHighlightPaint(kind, intensity);
    if (paint.skip) return { style: "", strongClass: "" };
    const color = paint.color ? `;color:${paint.color}` : "";
    const kindClass =
      paint.emphasize || paint.strong ? (kind === "easy" ? " highlight-top" : " highlight-bottom") : "";
    const strong = paint.strong ? " highlight-strong" : "";
    return {
      style: `background-color:${paint.backgroundColor}${color}`,
      strongClass: `${kindClass}${strong}`,
    };
  }

  function applyEnhanceHighlight(td, kind, intensity) {
    const paint = enhanceHighlightPaint(kind, intensity);
    if (paint.skip) return;
    td.classList.add("is-enhanced");
    if (paint.emphasize || paint.strong) {
      td.classList.add(kind === "top" ? "highlight-top" : "highlight-bottom");
    }
    td.classList.toggle("highlight-strong", paint.strong);
    td.style.setProperty("--hl-fill", paint.backgroundColor);
    td.style.removeProperty("background-color");
    td.style.removeProperty("color");
  }



  const METRIC_TITLE_OVERRIDES = {
    players: {
      cleanSheets: "Clean sheets",
      saves: "Saves",
      __cbitr: "Clearances, blocks, interceptions, tackles",
      defCon: "Defensive Contribution Points",
      bps: "Bonus Points System",
      xgi: "Expected goal involvements",
    },
    teams: {
      pts: "Total FPL Points",
      gd: "Goal difference",
      xgd: "Expected goal difference",
      __ppg: "Points per GW",
    },
  };

  function metricDisplayTitle(col) {
    return METRIC_TITLE_OVERRIDES[state.view]?.[col.key] || col.title || col.label;
  }

  // Columns where a lower value is the better outcome (conceding stats) —
  // "Enhance" ranks these ascending instead of descending.
  const LOWER_BETTER = new Set(["xgc", "goalsConceded"]);
  // These player fields come from FPL's season-total history. The API does
  // not provide a home/away breakdown, so split cells must not imply one.
  const FPL_SEASON_TOTAL_ONLY = new Set([
    "cleanSheets", "goalsConceded", "xgc", "saves", "__cbitr", "xgi",
  ]);
  // Columns exempt from Enhance ranking even though they're numeric.
  const ENHANCE_EXCLUDE = new Set(["price", "owned", "apps", "starts", "gp"]);
  const CORE_COL_KEYS = new Set(["price", "owned", "apps", "starts", "mins", "gp"]);
  const ENHANCE_PCT_MIN = 2;
  const ENHANCE_PCT_MAX = 40;
  const ENHANCE_PCT_PLAYERS = 5;
  const ENHANCE_PCT_TEAMS = 30;
  // Relative mode ranks within the filtered set — floor the band so a 5%
  // full-table slider still colors a useful share of a small cohort (e.g. BHA Mids).
  const ENHANCE_RELATIVE_FLOOR = 25;
  // Matchups highlight band as absolute ranks (always a ~20-team view).
  const SCHEDULE_ENHANCE_TOP_MIN = 1;
  const SCHEDULE_ENHANCE_TOP_MAX = 10;
  const SCHEDULE_ENHANCE_TOP_DEFAULT = 6;
  // Matchup finder: expected weight (0 = all actual, 100 = all expected)
  // and the minimum rank gap that qualifies as "favorable".
  const SCHEDULE_EXPECTED_WEIGHT_DEFAULT = 50;
  const SCHEDULE_EDGE_MIN = 2;
  const SCHEDULE_EDGE_MAX = 10;
  const SCHEDULE_EDGE_DEFAULT = 4;
  // Markets Goals/CS heat: 0 = only extremes colored, 100 = most cells colored.
  const MARKETS_HEAT_MIN = 0;
  const MARKETS_HEAT_MAX = 100;
  const MARKETS_HEAT_DEFAULT = 50;
  const MARKETS_HEAT_GOALS_KEY = "fpl-explorer-markets-heat-goals";
  const MARKETS_HEAT_CS_KEY = "fpl-explorer-markets-heat-cs";
  // The promoted clubs have no prior-season OPTA row. Give them explicit
  // provisional bottom-three ranks instead of inventing raw stat values.
  // Existing clubs keep their natural rank among the 17 measured teams.
  const PROVISIONAL_TEAM_RANKS = new Map([
    ["COV", 18],
    ["IPS", 19],
    ["HUL", 20],
  ]);

  // FPL's defensive-contribution rule scores a different action set per
  // position: defenders bank 2 points for 10 CBIT (clearances, blocks,
  // interceptions, tackles) in a match, midfielders and forwards need 12 CBIRT
  // — the same actions plus ball recoveries. Keepers are ineligible entirely.
  // build.py ships both season totals so the threshold basis can follow the
  // position a player is listed at now rather than the one they held when the
  // actions were recorded.
  const DEFCON_RULES = {
    DEF: { threshold: 10, field: "cbit", actions: "clearances, blocks, interceptions and tackles" },
    MID: { threshold: 12, field: "cbitr", actions: "clearances, blocks, interceptions, tackles and recoveries" },
    FWD: { threshold: 12, field: "cbitr", actions: "clearances, blocks, interceptions, tackles and recoveries" },
  };

  function defconPosition(row) {
    return row.newPosition || row.position;
  }

  function deriveExtra(row, isTeam) {
    if (isTeam) {
      row.__ppg = row.gp ? row.pts / row.gp : 0;
      row.__gpg = row.gp ? row.goals / row.gp : 0;
    } else {
      row.__gi = (row.goals || 0) + (row.assists || 0);
      // Collapse the two raw action totals into the one this player is
      // actually judged on. Null (not 0) where the rule can't produce a
      // figure, so the column shows a dash instead of a misleading zero.
      const rule = DEFCON_RULES[defconPosition(row)];
      row.__cbitr = rule && row[rule.field] != null ? row[rule.field] : null;
    }
  }

  ["home", "away", "combined"].forEach((split) => {
    DATA.players[split].forEach((r) => deriveExtra(r, false));
    DATA.teams[split].forEach((r) => deriveExtra(r, true));
  });

  // 2026/27 view: full FPL bootstrap squad with season-to-date API stats.
  // Hub/OPTA-only columns stay zero (no FPL equivalent).
  const PLAYER_OPTA_ONLY_KEYS = [
    "shots", "shotsOnTarget", "touchesBox", "bigChances",
    "keyPasses", "bigChancesCreated", "xPts",
  ];
  const PLAYER_FPL_STAT_KEYS = [
    "apps", "starts", "mins", "xg", "goals", "xa", "assists", "bps", "bonus", "pts",
    "cleanSheets", "goalsConceded", "xgc", "saves", "xgi", "cbit", "cbitr", "defCon",
  ];
  const TEAM_OPTA_ONLY_KEYS = [
    "shots", "shotsOnTarget", "touchesBox", "bigChances", "xcs",
  ];
  const TEAM_FPL_STAT_KEYS = [
    "gp", "xg", "goals", "xgc", "goalsConceded", "cleanSheets", "xgd", "gd", "pts",
  ];
  let season2627Cache = null;

  function teamNameForSeason(code) {
    if (state.page === "team" || isNextSeason()) {
      return NEXT_SEASON_TEAM_NAMES[code] || TEAM_NAMES[code] || code;
    }
    return TEAM_NAMES[code] || code;
  }

  function nextSeasonSplitLists(raw) {
    // New builds ship {home,away,combined}; older data.js may still be a flat array.
    if (Array.isArray(raw)) {
      return { home: raw, away: raw, combined: raw };
    }
    return {
      home: (raw && raw.home) || [],
      away: (raw && raw.away) || [],
      combined: (raw && raw.combined) || [],
    };
  }

  function buildSeason2627Data() {
    const playerLists = nextSeasonSplitLists(DATA.nextSeasonPlayers);
    const teamLists = nextSeasonSplitLists(DATA.nextSeasonTeams);
    const players = { home: [], away: [], combined: [] };
    ["home", "away", "combined"].forEach((split) => {
      (playerLists[split] || []).forEach((src) => {
        const row = {
          id: src.id,
          name: src.name,
          team: src.team,
          position: src.position,
          price: src.price,
          price2627: src.price,
          priceDelta: 0,
          newTeam: src.team,
          newPosition: src.position,
          status: "ok",
          code: src.code,
          penaltiesOrder: src.penaltiesOrder ?? null,
          directFreekicksOrder: src.directFreekicksOrder ?? null,
          cornersOrder: src.cornersOrder ?? null,
        };
        PLAYER_FPL_STAT_KEYS.forEach((k) => {
          row[k] = src[k] != null ? src[k] : 0;
        });
        PLAYER_OPTA_ONLY_KEYS.forEach((k) => {
          row[k] = 0;
        });
        deriveExtra(row, false);
        players[split].push(row);
      });
    });

    const teamCodes = NEXT_SEASON_TEAM_CODES.length ? NEXT_SEASON_TEAM_CODES : ALL_TEAM_CODES;
    const teams = { home: [], away: [], combined: [] };
    ["home", "away", "combined"].forEach((split) => {
      const byCode = new Map((teamLists[split] || []).map((t) => [t.team, t]));
      teamCodes.forEach((code) => {
        const src = byCode.get(code) || {};
        const base = {
          team: code,
          name: src.name || NEXT_SEASON_TEAM_NAMES[code] || TEAM_NAMES[code] || code,
        };
        TEAM_FPL_STAT_KEYS.forEach((k) => {
          base[k] = src[k] != null ? src[k] : 0;
        });
        TEAM_OPTA_ONLY_KEYS.forEach((k) => {
          base[k] = src[k] != null ? src[k] : 0;
        });
        deriveExtra(base, true);
        teams[split].push(base);
      });
    });
    return { players, teams };
  }

  function season2627Data() {
    if (!season2627Cache) season2627Cache = buildSeason2627Data();
    return season2627Cache;
  }

  let fplElementByCodeCache = null;
  let fplElementLookupWarned = false;

  function fplElementByCodeMap() {
    if (fplElementByCodeCache) return fplElementByCodeCache;
    const map = new Map();
    const fromData = (DATA.fplIdentity && DATA.fplIdentity.elementByCode) || {};
    Object.entries(fromData).forEach(([code, element]) => {
      const c = Number(code);
      const el = Number(element);
      if (Number.isFinite(c) && Number.isFinite(el)) map.set(c, el);
    });
    if (!map.size) {
      const pool = (season2627Data().players && season2627Data().players.combined) || [];
      for (const row of pool) {
        const code = Number(row.code);
        const el = Number(row.element);
        if (Number.isFinite(code) && Number.isFinite(el)) map.set(code, el);
      }
    }
    for (const row of (HOME && HOME.squad) || []) {
      const code = Number(row.code);
      const el = Number(row.element);
      if (Number.isFinite(code) && Number.isFinite(el) && !map.has(code)) map.set(code, el);
    }
    fplElementByCodeCache = map;
    return map;
  }

  function fplElementIdForRow(row) {
    if (!row) return null;
    if (row.element2627 != null) {
      const el = Number(row.element2627);
      if (Number.isFinite(el)) return el;
    }
    if (row.element != null) {
      const el = Number(row.element);
      if (Number.isFinite(el)) return el;
    }
    const code = Number(row.code);
    if (!Number.isFinite(code)) return null;
    const mapped = fplElementByCodeMap().get(code);
    if (mapped != null) return mapped;
    if (!fplElementLookupWarned) {
      console.warn("FPL element lookup failed for player code", code, row.name || row);
      fplElementLookupWarned = true;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    page: "home", // home | opta | rankings | ownership | expected | schedule | markets | team
    season: "2026-27", // 2025-26 | 2026-27
    view: "players", // players | teams
    split: "combined", // combined | home | away
    search: "",
    posFilter: new Set(),
    teamFilter: new Set(),
    priceMin: null,
    priceMax: null,
    ownedMin: OWNERSHIP_FILTER_DEFAULT,
    minsMin: null,
    minsMax: null,
    valueMode: "total", // total | per90 | perM
    showNewPrice: true,
    setPieceTakersOnly: false,
    // Always-on top/bottom % cell tint vs the full Players/Teams view
    // (raw values stay in the cells; filters don't shrink the bands).
    // enhanceRelative = true ranks the band against the filtered rows instead.
    // Defaults on whenever filters narrow; user can turn off until filters clear.
    enhancePct: ENHANCE_PCT_PLAYERS,
    enhanceRelative: false,
    scheduleEnhanceTopN: SCHEDULE_ENHANCE_TOP_DEFAULT,
    compareMode: false,
    compareSelection: { players: new Set(), teams: new Set() },
    sortKey: "price",
    sortDir: "desc",
    hiddenCols: new Set(),
    rankingsPins: [],
    expectedCat: "goals", // goals | assists | gi | conceded | cs
    expectedSortKey: "actual", // diff | expected | actual | name
    expectedSortDir: "desc",
    expectedSplit: "combined", // combined | home | away | compare
    scheduleGwMin: SCHEDULE_GW_DEFAULT_MIN,
    scheduleGwMax: SCHEDULE_GW_DEFAULT_MAX,
    scheduleMatchups: true,
    scheduleExpectedWeight: SCHEDULE_EXPECTED_WEIGHT_DEFAULT,
    scheduleEdgeMin: SCHEDULE_EDGE_DEFAULT,
    // Markets Goals/CS heat fills — 0 = stricter (less color), 100 = looser (more).
    marketsHeatGoals: MARKETS_HEAT_DEFAULT,
    marketsHeatCs: MARKETS_HEAT_DEFAULT,
    marketsCompare: "current", // current | last | 72h
    marketsCardView: "stats", // stats (G+CS%) | scoreline
    teamSquad: [],
    teamCaptainCode: null,
    teamViceCode: null,
    teamPickerSlot: null, // { position, starter, replaceCode }
    teamGwStart: null,
    teamSortKey: null,
    teamSortDir: "desc",
    teamSubCode: null,
    teamAffordableOnly: false,
    teamCompareMode: false,
    teamCompareCodes: [], // pins + click-to-select, max MAX_COMPARE
    teamHoverCompareCode: null,
    teamSearchActiveCode: null,
    teamMode: "actual", // planner | actual
    teamSparkMetric: "form", // form | owned
    ownershipTrendWindow: OWNERSHIP_TREND_WINDOW_DEFAULT,
    ownershipRisersCollapsed: false,
    ownershipFallersCollapsed: false,
    actualMeta: null, // { syncedAt, gw, gwLabel, teamName, managerName, hasPicks, message }
  };
  state.teamSearchPins = state.teamCompareCodes;

  const MAX_COMPARE = 5;
  // Relative defaults on when filters narrow; remembered off until filters clear.
  let enhanceRelativeUserOff = false;
  let lastOptaHighlightFilterKey = "";

  function compareSet() {
    return state.compareSelection[state.view];
  }

  function isNextSeason() {
    return state.season === "2026-27";
  }

  // Updates chrome (arrows / ±) on 2025/26 data — always uses matched 2026/27 price/team/pos.
  function updatesOverlayOn() {
    return !isNextSeason();
  }

  function computeBounds(season = state.season) {
    if (season === "2026-27") {
      const players = season2627Data().players.combined;
      const price = players.map((p) => p.price);
      return {
        price: {
          min: price.length ? Math.min(...price) : 4,
          max: price.length ? Math.max(...price) : 15,
        },
        // Stats are zero until the season starts; keep a full-season ceiling
        // so the minutes slider stays usable once values land.
        mins: { min: 0, max: 38 * 90 },
      };
    }
    const players = DATA.players.combined;
    // Include matched 2026/27 prices so Updates-mode £ filters cover the
    // values shown in the table (e.g. Haaland 14.7 → 15.5).
    const prices = [];
    for (const p of players) {
      if (p.price != null) prices.push(p.price);
      if (p.price2627 != null) prices.push(p.price2627);
    }
    const mins = players.map((p) => p.mins);
    return {
      price: {
        min: prices.length ? Math.min(...prices) : 4,
        max: prices.length ? Math.max(...prices) : 15,
      },
      mins: { min: 0, max: mins.length ? Math.max(...mins) : 38 * 90 },
    };
  }

  // Mutable range used by the price/mins dual sliders (updated on season switch).
  const bounds = computeBounds(state.season);
  function defaultMinPrice() {
    // Player select shows the full catalog; elsewhere keep the £4.5m+ default.
    if (state.page === "team" && state.teamPickerSlot) return bounds.price.min;
    return Math.min(Math.max(4.5, bounds.price.min), bounds.price.max);
  }
  function defaultMinMinutes() {
    return isNextSeason() ? 0 : Math.min(1000, bounds.mins.max);
  }

  function statisticsCoreFilterDefaults(mode = state.valueMode) {
    if (mode === "total") {
      return {
        priceMin: bounds.price.min,
        priceMax: bounds.price.max,
        ownedMin: 0,
        minsMin: bounds.mins.min,
        minsMax: bounds.mins.max,
      };
    }
    return {
      priceMin: defaultMinPrice(),
      priceMax: bounds.price.max,
      ownedMin: OWNERSHIP_FILTER_DEFAULT,
      minsMin: defaultMinMinutes(),
      minsMax: bounds.mins.max,
    };
  }

  function applyStatisticsCoreFilterDefaults(mode = state.valueMode) {
    const d = statisticsCoreFilterDefaults(mode);
    state.priceMin = d.priceMin;
    state.priceMax = d.priceMax;
    state.ownedMin = d.ownedMin;
    state.minsMin = d.minsMin;
    state.minsMax = d.minsMax;
    if (typeof updatePriceSlider === "function") updatePriceSlider();
    if (typeof updateOwnedSlider === "function") updateOwnedSlider();
    if (typeof updateMinsSlider === "function") updateMinsSlider();
  }

  const statsCoreDefaults = statisticsCoreFilterDefaults("total");
  state.priceMin = statsCoreDefaults.priceMin;
  state.priceMax = statsCoreDefaults.priceMax;
  state.ownedMin = statsCoreDefaults.ownedMin;
  state.minsMin = statsCoreDefaults.minsMin;
  state.minsMax = statsCoreDefaults.minsMax;

  const PLAYER_COLS = [
    { key: "player", label: "Player", type: "player", pin: true },
    { key: "price", label: "£m", decimals: 1, group: "Core", title: "Price (£m)" },
    { key: "owned", label: "TSB%", decimals: 1, group: "Core", title: "FPL selected-by-% (TSB)" },
    { key: "apps", label: "Apps", decimals: 0, group: "Core", title: "Appearances" },
    { key: "mins", label: "Mins", decimals: 0, group: "Core", title: "Minutes played" },
    { key: "shots", label: "S", decimals: 0, group: "Attack", section: "Goal Threat", rate: true, title: "Shots" },
    { key: "shotsOnTarget", label: "OT", decimals: 0, group: "Attack", section: "Goal Threat", rate: true, title: "Shots on target" },
    { key: "touchesBox", label: "IN", decimals: 0, group: "Attack", section: "Goal Threat", rate: true, title: "Shots in the box" },
    { key: "bigChances", label: "BC", decimals: 0, group: "Attack", section: "Goal Threat", rate: true, title: "Big chances" },
    { key: "xg", label: "xG", decimals: 1, group: "Attack", section: "Goal Threat", rate: true, title: "Expected goals" },
    { key: "goals", label: "G", decimals: 0, group: "Attack", section: "Goal Threat", rate: true, title: "Goals" },
    { key: "keyPasses", label: "KP", decimals: 0, group: "Creativity", section: "Creativity", rate: true, title: "Key passes" },
    { key: "bigChancesCreated", label: "BCC", decimals: 0, group: "Creativity", section: "Creativity", rate: true, title: "Big chances created" },
    { key: "xa", label: "xA", decimals: 1, group: "Creativity", section: "Creativity", rate: true, title: "Expected assists" },
    { key: "assists", label: "A", decimals: 0, group: "Creativity", section: "Creativity", rate: true, title: "Assists" },
    { key: "cleanSheets", label: "CS", decimals: 0, group: "Defence", section: "Defensive", rate: true, title: "Clean sheets (FPL API, 2025/26 combined only)" },
    { key: "goalsConceded", label: "GC", decimals: 0, group: "Defence", section: "Defensive", rate: true, title: "Goals conceded while on the pitch — recorded for every position, though only keepers and defenders are docked points for them (FPL API, 2025/26 combined only)" },
    { key: "xgc", label: "xGC", decimals: 1, group: "Defence", section: "Defensive", rate: true, title: "Expected goals conceded while on the pitch — recorded for every position (FPL API, 2025/26 combined only)" },
    { key: "saves", label: "Saves", decimals: 0, group: "Defence", section: "Defensive", rate: true, title: "Saves — goalkeepers (FPL API, 2025/26 combined only)" },
    { key: "__cbitr", label: "CBIT/R", decimals: 0, group: "Defence", section: "Defensive", rate: true, derived: true, title: "Clearances, blocks, interceptions & tackles (+ recoveries for MID/FWD). Combined view only." },
    { key: "xPts", label: "xPts", decimals: 1, group: "Points", section: "FPL", rate: true, title: "Expected FPL points" },
    { key: "bps", label: "BPS", decimals: 0, group: "Points", section: "FPL", rate: true, title: "Bonus points system score" },
    { key: "bonus", label: "B", decimals: 0, group: "Points", section: "FPL", rate: true, title: "Bonus points" },
    { key: "defCon", label: "DC", decimals: 0, group: "Points", section: "FPL", rate: true, title: "Defensive contribution points earned (2 per match at the position's action threshold)" },
    { key: "pts", label: "Pts", decimals: 0, group: "Points", section: "FPL", rate: true, title: "Total FPL points", strong: true },
    { key: "__gi", label: "G+A", decimals: 0, group: "Combined", section: "Combined", derived: true, rate: true, title: "Goals + assists" },
    { key: "xgi", label: "xGI", decimals: 1, group: "Combined", section: "Combined", rate: true, title: "Expected goal involvements (FPL API, 2025/26 combined only)" },
    { key: "penaltiesOrder", label: "PK", type: "check", group: "Set Pieces", section: "Set Pieces", title: "1st-choice penalty taker" },
    { key: "directFreekicksOrder", label: "FK", type: "check", group: "Set Pieces", section: "Set Pieces", title: "1st-choice direct free kick taker" },
    { key: "cornersOrder", label: "CK", type: "check", group: "Set Pieces", section: "Set Pieces", title: "1st-choice corners & indirect free kick taker" },
  ];

  const TEAM_COLS = [
    { key: "name", label: "Team", type: "name", pin: true },
    { key: "gp", label: "GP", decimals: 0, group: "Core", title: "Gameweeks played" },
    { key: "shots", label: "S", decimals: 0, group: "Attack", section: "Goal Threat", rate: true, title: "Shots" },
    { key: "shotsOnTarget", label: "OT", decimals: 0, group: "Attack", section: "Goal Threat", rate: true, title: "Shots on target" },
    { key: "touchesBox", label: "IN", decimals: 0, group: "Attack", section: "Goal Threat", rate: true, title: "Shots in the box" },
    { key: "bigChances", label: "BC", decimals: 0, group: "Attack", section: "Goal Threat", rate: true, title: "Big chances" },
    { key: "xg", label: "xG", decimals: 1, group: "Attack", section: "Goal Threat", rate: true, title: "Expected goals" },
    { key: "goals", label: "G", decimals: 0, group: "Attack", section: "Goal Threat", rate: true, title: "Goals" },
    { key: "xgc", label: "xGC", decimals: 1, group: "Defence", section: "Defensive", rate: true, title: "Expected goals conceded" },
    { key: "xcs", label: "xCS", decimals: 1, group: "Defence", section: "Defensive", rate: true, title: "Expected clean sheets" },
    { key: "goalsConceded", label: "GC", decimals: 0, group: "Defence", section: "Defensive", rate: true, title: "Goals conceded" },
    { key: "cleanSheets", label: "CS", decimals: 0, group: "Defence", section: "Defensive", rate: true, title: "Team clean sheets — max of (sum of GK FPL CS, best DEF/MID CS). Outfield fallback covers keepers subbed before 60′." },
    { key: "xgd", label: "xGD", decimals: 1, group: "Overall", section: "Overall", rate: true, title: "Expected goal difference (xG − xGC)" },
    { key: "gd", label: "GD", decimals: 0, group: "Overall", section: "Overall", title: "Goal difference (goals − conceded)" },
    { key: "pts", label: "Pts", decimals: 0, group: "Points", section: "FPL", rate: true, title: "Total FPL points scored by the squad", strong: true },
    { key: "__ppg", label: "Pts/GP", decimals: 1, group: "Derived", section: "Derived", derived: true, title: "Points per gameweek played" },
    { key: "__gpg", label: "G/GP", decimals: 1, group: "Derived", section: "Derived", derived: true, title: "Goals per gameweek played" },
  ];

  const PLAYER_OPTA_ONLY_COL_KEYS = new Set([
    "shots", "shotsOnTarget", "touchesBox", "bigChances",
    "keyPasses", "bigChancesCreated", "xPts",
  ]);
  const TEAM_OPTA_ONLY_COL_KEYS = new Set([
    "shots", "shotsOnTarget", "touchesBox", "bigChances", "xcs",
  ]);

  function cols() {
    const all = state.view === "players" ? PLAYER_COLS : TEAM_COLS;
    if (!isNextSeason()) return all;
    const hide = state.view === "players" ? PLAYER_OPTA_ONLY_COL_KEYS : TEAM_OPTA_ONLY_COL_KEYS;
    return all.filter((c) => !hide.has(c.key));
  }

  const latestOwnershipCheckIn =
    Array.isArray(OWNERSHIP.checkIns) && OWNERSHIP.checkIns.length
      ? OWNERSHIP.checkIns[OWNERSHIP.checkIns.length - 1]
      : null;
  const latestOwnershipByCode = new Map(
    ((latestOwnershipCheckIn && latestOwnershipCheckIn.players) || [])
      .filter((player) => player && player.code != null)
      .map((player) => [Number(player.code), Number(player.owned)])
  );

  function currentOwnership(code) {
    if (code == null || code === "") return null;
    const owned = latestOwnershipByCode.get(Number(code));
    return Number.isFinite(owned) ? owned : null;
  }

  function passesOwnershipFilter(row) {
    if (state.ownedMin <= 0) return true;
    const owned = currentOwnership(row && row.code);
    return owned != null && owned >= state.ownedMin;
  }

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const el = {
    pageHome: $("#page-home"),
    pageOpta: $("#page-opta"),
    pageRankings: $("#page-rankings"),
    pageOwnership: $("#page-ownership"),
    pageTeam: $("#page-team"),
    pageExpected: $("#page-expected"),
    pageTabs: $("#page-tabs"),
    pageTabsClip: $("#page-tabs-clip"),
    pageNav: document.querySelector(".page-nav"),
    pageNavCenter: $(".page-nav-center"),
    pageInfoNavBtn: $("#page-info-nav-btn"),
    pageTrayBtn: $("#page-tray-btn"),
    pageTrayLabel: $("#page-tray-label"),
    pageTrayIconUse: $("#page-tray-icon-use"),
    expectedCatMenu: $("#expected-cat-menu"),
    expectedCatToolbar: $("#expected-cat-toolbar"),
    expectedCatBtn: $("#expected-cat-btn"),
    expectedCatLabel: $("#expected-cat-label"),
    pageSchedule: $("#page-schedule"),
    pageMarkets: $("#page-markets"),
    homePage: $("#home-page"),
    homePageSubtitle: $("#home-page-subtitle"),
    homeCountLabel: $("#home-count-label"),
    homeEmpty: $("#home-empty"),
    homeEmptyTitle: $("#home-empty-title"),
    homeEmptyCopy: $("#home-empty-copy"),
    homeBento: $("#home-bento"),
    homeDeadline: $("#home-deadline"),
    homeViewBanner: $("#home-view-banner"),
    homeViewBannerName: $("#home-view-banner-name"),
    homeViewBannerClear: $("#home-view-banner-clear"),
    homeGwPoints: $("#home-gw-points"),
    homeGwHeading: $("#home-gw-heading"),
    homeGwMeta: $("#home-gw-meta"),
    homeOverallRank: $("#home-overall-rank"),
    homeOverallRankNum: $("#home-overall-rank-num"),
    homeOverallRankDelta: $("#home-overall-rank-delta"),
    homeOverallPct: $("#home-overall-pct"),
    homeTotalPoints: $("#home-total-points"),
    homeLeagueRank: $("#home-league-rank"),
    homeLeagueRankNum: $("#home-league-rank-num"),
    homeLeagueRankDelta: $("#home-league-rank-delta"),
    homeSquadGwLabel: $("#home-squad-gw-label"),
    homeLeagueTitle: $("#home-league-title"),
    homeSquadBody: $("#home-squad-body"),
    homeStandingsBody: $("#home-standings-body"),
    homeSummaryCards: $("#home-summary-cards"),
    homeSquadPanel: $("#home-squad-panel"),
    homeStandingsPanel: $("#home-standings-panel"),
    homePlayerProfile: $("#home-player-profile"),
    homePlayerMatchup: $("#home-player-matchup"),
    homeSearchBtn: $("#home-search-btn"),
    subtoolbar: $("#subtoolbar"),
    statsToolbarStart: $("#stats-toolbar-start"),
    statsToolbarActions: $("#stats-toolbar-actions"),
    optaPage: $("#opta-page"),
    rankingsPage: $("#rankings-page"),
    rankingsPinBar: $("#rankings-pin-bar"),
    rankingsGrid: $("#rankings-grid"),
    rankingsCountLabel: $("#rankings-count-label"),
    ownershipPage: $("#ownership-page"),
    ownershipChart: $("#ownership-chart"),
    ownershipChartWrap: $("#ownership-chart-wrap"),
    ownershipChartTitle: $("#ownership-chart-title"),
    ownershipTooltip: $("#ownership-tooltip"),
    ownershipSelection: $("#ownership-selection"),
    ownershipCountLabel: $("#ownership-count-label"),
    ownershipTrendingGroup: $("#ownership-trending-group"),
    ownershipTrendWindowSeg: $("#ownership-trend-window-seg"),
    ownershipTrendCards: $("#ownership-trend-cards"),
    ownershipTrendRisers: $("#ownership-trend-risers"),
    ownershipTrendFallers: $("#ownership-trend-fallers"),
    teamPage: $("#team-page"),
    teamPageSubtitle: $("#team-page-subtitle"),
    teamModeSeg: $("#team-mode-seg"),
    teamResyncBtn: $("#team-resync-btn"),
    teamResyncToolbar: $("#team-resync-toolbar"),
    teamClearBtn: $("#team-clear-btn"),
    teamClearToolbar: $("#team-clear-toolbar"),
    teamRowMenu: $("#team-row-menu"),
    teamBudgetBar: $("#team-budget-bar"),
    teamSubBar: $("#team-sub-bar"),
    teamGwNav: $("#team-gw-nav"),
    teamSquadView: $("#team-squad-view"),
    teamPickerView: $("#team-picker-view"),
    teamSquadHead: $("#team-squad-head"),
    teamSquadBody: $("#team-squad-body"),
    teamSearchResults: $("#team-search-results"),
    teamSearchTitle: $("#team-search-title"),
    teamSearchClearPins: $("#team-search-clear-pins"),
    teamSearchHead: $("#team-search-head"),
    teamSearchBody: $("#team-search-body"),
    teamPickerHead: $("#team-picker-head"),
    teamPickerBody: $("#team-picker-body"),
    teamAffordableGroup: $("#team-affordable-group"),
    teamAffordableCheck: $("#team-affordable-check"),
    teamCompareBtn: $("#team-compare-btn"),
    teamCompareWrap: $("#team-compare-wrap"),
    teamCompareTitle: $("#team-compare-title"),
    teamCompareClear: $("#team-compare-clear"),
    teamCompareHead: $("#team-compare-head"),
    teamCompareBody: $("#team-compare-body"),
    teamToolbarControls: $("#team-toolbar-controls"),
    teamHeaderInlineActions: $("#team-header-inline-actions"),
    teamToolbarMode: $("#team-toolbar-mode"),
    teamPickerHeaderActions: $("#team-picker-header-actions"),
    teamPickerCancel: $("#team-picker-cancel"),
    searchHome: $(".topbar-end-cluster"),
    expectedPage: $("#expected-page"),
    schedulePage: $("#schedule-page"),
    scheduleGrid: $("#schedule-grid"),
    marketsPage: $("#markets-page"),
    marketsGrid: $("#markets-grid"),
    marketsAttribution: $("#markets-attribution"),
    marketsControls: $("#markets-controls"),
    marketsSlidersToggle: $("#markets-sliders-toggle"),
    marketsHeatGoals: $("#markets-heat-goals"),
    marketsHeatGoalsFill: $("#markets-heat-goals-fill"),
    marketsHeatGoalsLabel: $("#markets-heat-goals-label"),
    marketsHeatCs: $("#markets-heat-cs"),
    marketsHeatCsFill: $("#markets-heat-cs-fill"),
    marketsHeatCsLabel: $("#markets-heat-cs-label"),
    marketsCompareSeg: $("#markets-compare-seg"),
    marketsViewSeg: $("#markets-view-seg"),
    marketsViewControl: $("#markets-view-control"),
    marketsHeaderActions: $("#markets-header-actions"),
    scheduleScatter: $("#schedule-scatter"),
    scheduleScatterTooltip: $("#schedule-scatter-tooltip"),
    uiTooltip: $("#ui-tooltip"),
    mobileSheet: $("#mobile-sheet"),
    mobileSheetTitle: $("#mobile-sheet-title"),
    mobileSheetBody: $("#mobile-sheet-body"),
    mobileSheetPanel: document.querySelector("#mobile-sheet .mobile-sheet-panel"),
    mobileSheetReset: $("#mobile-sheet-reset"),
    mobileFilterDock: $("#mobile-filter-dock"),
    mobileViewDock: $("#mobile-view-dock"),
    mobileChromeFade: $("#mobile-chrome-fade"),
    filtersResetRow: $("#filters-reset-row"),
    searchClearBtn: $("#search-clear-btn"),
    scheduleRangeLabel: $("#schedule-range-label"),
    scheduleGwMin: $("#schedule-gw-min"),
    scheduleGwMax: $("#schedule-gw-max"),
    scheduleGwMinLabel: $("#schedule-gw-min-label"),
    scheduleGwMaxLabel: $("#schedule-gw-max-label"),
    scheduleGwFill: $("#schedule-gw-fill"),
    scheduleEnhancePct: $("#schedule-enhance-pct"),
    scheduleEnhancePctLabel: $("#schedule-enhance-pct-label"),
    scheduleEnhancePctFill: $("#schedule-enhance-pct-fill"),
    scheduleExpectedWeightGroup: $("#schedule-expected-weight-group"),
    scheduleExpectedWeight: $("#schedule-expected-weight"),
    scheduleExpectedWeightLabel: $("#schedule-expected-weight-label"),
    scheduleExpectedWeightFill: $("#schedule-expected-weight-fill"),
    scheduleEdgeMinGroup: $("#schedule-edge-min-group"),
    scheduleEdgeMin: $("#schedule-edge-min"),
    scheduleEdgeMinLabel: $("#schedule-edge-min-label"),
    scheduleEdgeMinFill: $("#schedule-edge-min-fill"),
    scheduleControls: $("#schedule-controls"),
    scheduleSlidersToggle: $("#schedule-sliders-toggle"),
    expectedTitle: $("#expected-title"),
    expectedSub: $("#expected-sub"),
    expectedSplitGroup: $("#expected-split-group"),
    expectedSplitSeg: $("#expected-split-seg"),
    barbellWrap: $("#barbell-wrap"),
    barbellHead: $("#barbell-head"),
    barbellScale: $("#barbell-scale"),
    barbellBody: $("#barbell-body"),
    expectedTooltip: $("#expected-tooltip"),
    seasonSelect: $("#season-select"),
    seasonSeg: $("#season-seg"),
    tableOnlyToggles: $("#table-only-toggles"),
    columnsSidebar: $("#columns-sidebar"),
    tabPlayers: $("#tab-players"),
    tabTeams: $("#tab-teams"),
    splitGroup: $("#split-group"),
    splitSeg: $("#split-seg"),
    search: $("#search-input"),
    searchWrap: $("#search-wrap"),
    searchToggle: $("#search-toggle"),
    sidebar: $("#sidebar"),
    sidebarToggle: $("#sidebar-toggle"),
    sidebarColumnsHost: $("#sidebar-columns-host"),
    pageInfoTooltip: $("#page-info-tooltip"),
    themeCycleBtn: $("#theme-cycle-btn"),
    themeSeg: $("#theme-seg"),
    accentSwatches: $("#accent-swatches"),
    prefsBtn: $("#prefs-btn"),
    prefsPanel: $("#prefs-panel"),
    fplManagerSelect: $("#fpl-manager-select"),
    fplLeagueLabel: $("#fpl-league-label"),
    fplIdClear: $("#fpl-id-clear"),
    fplIdStatus: $("#fpl-id-status"),
    posFilters: $("#pos-filters"),
    teamFilters: $("#team-filters"),
    priceMin: $("#price-min"),
    priceMax: $("#price-max"),
    priceMinLabel: $("#price-min-label"),
    priceMaxLabel: $("#price-max-label"),
    priceFill: $("#price-fill"),
    ownedMin: $("#owned-min"),
    ownedMinLabel: $("#owned-min-label"),
    ownedMinFill: $("#owned-min-fill"),
    minsMin: $("#mins-min"),
    minsMax: $("#mins-max"),
    minsMinLabel: $("#mins-min-label"),
    minsMaxLabel: $("#mins-max-label"),
    minsFill: $("#mins-fill"),
    resetFilters: $("#reset-filters"),
    enhancePctGroup: $("#enhance-pct-group"),
    enhancePct: $("#enhance-pct"),
    enhancePctLabel: $("#enhance-pct-label"),
    enhancePctHint: $("#enhance-pct-hint"),
    enhancePctFill: $("#enhance-pct-fill"),
    valueModeGroup: $("#value-mode-group"),
    valueModeSeg: $("#value-mode-seg"),
    newpriceWrap: $("#newprice-wrap"),
    newpriceToggle: $("#newprice-toggle"),
    newpriceIssuesBadge: $("#newprice-issues-badge"),
    newpriceIssuesPanel: $("#newprice-issues-panel"),
    compareToggle: $("#compare-toggle"),
    enhanceRelativeBtn: $("#enhance-relative-btn"),
    compareWrap: $("#compare-wrap"),
    compareTitle: $("#compare-title"),
    compareClear: $("#compare-clear"),
    compareHead: $("#compare-head"),
    compareBody: $("#compare-body"),
    toastRoot: $("#toast-root"),
    confirmModal: $("#confirm-modal"),
    confirmModalTitle: $("#confirm-modal-title"),
    confirmModalMsg: $("#confirm-modal-msg"),
    confirmModalOk: $("#confirm-modal-ok"),
    columnsBtn: $("#columns-btn"),
    columnsList: $("#columns-list"),
    countLabel: $("#count-label"),
    tableHead: $("#table-head"),
    tableBody: $("#table-body"),
    fixtureTooltip: $("#fixture-tooltip"),
    teamRankTooltip: $("#team-rank-tooltip"),
    matchupEdgeTooltip: $("#matchup-edge-tooltip"),
    positionFilterGroup: $("#position-filter-group"),
    setpieceFilterGroup: $("#setpiece-filter-group"),
    setpieceTakersCheck: $("#setpiece-takers-check"),
    minutesFilterGroup: $("#minutes-filter-group"),
    priceFilterGroup: $("#price-filter-group"),
    ownedFilterGroup: $("#owned-filter-group"),
  };

  // ---------------------------------------------------------------------
  // Build static filter UI (positions / teams)
  // ---------------------------------------------------------------------
  function teamCodesForSeason() {
    return state.page === "team" || isNextSeason() ? ALL_TEAM_CODES : TEAM_CODES;
  }

  function buildTeamFilterChips() {
    el.teamFilters.innerHTML = "";
    teamCodesForSeason().forEach((code) => {
      const chip = document.createElement("div");
      chip.className = "chip team-chip";
      chip.innerHTML = `${badgeHTML(code)}${code}`;
      setTip(chip, teamNameForSeason(code));
      chip.dataset.team = code;
      if (state.teamFilter.has(code)) chip.classList.add("active");
      chip.addEventListener("click", () => {
        toggleSetValue(state.teamFilter, code);
        chip.classList.toggle("active");
        renderTable();
      });
      el.teamFilters.appendChild(chip);
    });
  }

  function buildStaticFilters() {
    el.posFilters.innerHTML = "";
    POSITIONS.forEach((p) => {
      const chip = document.createElement("div");
      chip.className = "chip";
      chip.textContent = p;
      chip.dataset.pos = p;
      chip.addEventListener("click", () => {
        if (state.page === "team" && state.teamPickerSlot) return;
        toggleSetValue(state.posFilter, p);
        chip.classList.toggle("active");
        renderTable();
      });
      el.posFilters.appendChild(chip);
    });
    buildTeamFilterChips();
  }

  function toggleSetValue(set, val) {
    if (set.has(val)) set.delete(val);
    else set.add(val);
  }

  function syncFilterChipUI() {
    const lock = state.page === "team" && state.teamPickerSlot && state.teamPickerSlot.position;
    $$("#pos-filters .chip").forEach((c) => {
      c.classList.toggle("active", !lock && state.posFilter.has(c.dataset.pos));
      c.classList.toggle("is-locked", !!lock);
    });
    $$("#team-filters .chip").forEach((c) => c.classList.toggle("active", state.teamFilter.has(c.dataset.team)));
    syncFiltersResetUI();
  }

  function defaultEnhancePct() {
    return state.view === "players" ? ENHANCE_PCT_PLAYERS : ENHANCE_PCT_TEAMS;
  }

  function filtersAreDirty() {
    if (state.posFilter.size) return true;
    if (state.teamFilter.size) return true;
    if (state.search.trim() && !(state.page === "team" && !state.teamPickerSlot)) return true;
    const coreDefaults = statisticsCoreFilterDefaults(state.valueMode);
    if (state.priceMin !== coreDefaults.priceMin || state.priceMax !== coreDefaults.priceMax) return true;
    if (state.ownedMin !== coreDefaults.ownedMin) return true;
    if (state.minsMin !== coreDefaults.minsMin || state.minsMax !== coreDefaults.minsMax) return true;
    if (state.ownershipTrendWindow !== OWNERSHIP_TREND_WINDOW_DEFAULT) return true;
    if (state.setPieceTakersOnly) return true;
    if (state.page === "team" && state.teamAffordableOnly) return true;
    if (state.valueMode !== "total") return true;
    if (state.split !== "combined") return true;
    if (state.enhancePct !== defaultEnhancePct()) return true;
    if (state.page === "opta" && state.hiddenCols.size) return true;
    return false;
  }

  function syncFiltersResetUI() {
    const dirty = filtersAreDirty();
    const sheetFilters = mobileSheetOpen && mobileSheetKey === "filters";
    if (el.mobileSheetReset) {
      el.mobileSheetReset.hidden = !(sheetFilters && dirty);
    }
    if (el.filtersResetRow) {
      // Sheet header owns Reset while Filters is hosted; otherwise top of sidebar.
      el.filtersResetRow.hidden = !dirty || sheetFilters;
    }
  }

  function resetFiltersToDefault() {
    state.posFilter.clear();
    state.teamFilter.clear();
    const coreDefaults = statisticsCoreFilterDefaults(state.valueMode);
    state.priceMin = coreDefaults.priceMin;
    state.priceMax = coreDefaults.priceMax;
    state.ownedMin = coreDefaults.ownedMin;
    state.minsMin = coreDefaults.minsMin;
    state.minsMax = coreDefaults.minsMax;
    state.ownershipTrendWindow = OWNERSHIP_TREND_WINDOW_DEFAULT;
    syncOwnershipTrendWindowUI();
    state.search = "";
    if (el.search) el.search.value = "";
    if (el.searchWrap) el.searchWrap.classList.remove("search-open");
    if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "false");
    syncSearchClearBtns();
    state.setPieceTakersOnly = false;
    if (el.setpieceTakersCheck) el.setpieceTakersCheck.checked = false;
    state.teamAffordableOnly = false;
    if (el.teamAffordableCheck) el.teamAffordableCheck.checked = false;
    setValueMode("total", { rerender: false });
    state.split = "combined";
    $$("#split-seg button").forEach((b) => b.classList.toggle("active", b.dataset.split === "combined"));
    syncSegThumb(el.splitSeg);
    state.enhancePct = defaultEnhancePct();
    state.enhanceRelative = false;
    enhanceRelativeUserOff = false;
    state.hiddenCols = new Set();
    updateEnhancePctSlider();
    syncEnhanceRelativeUI();
    updatePriceSlider();
    updateOwnedSlider();
    updateMinsSlider();
    syncFilterChipUI();
    renderColumnsPanel();
    renderTable();
    if (state.page === "ownership") renderOwnership();
  }

  // ---------------------------------------------------------------------
  // Filtering / sorting / grouping
  // ---------------------------------------------------------------------
  function getRows() {
    if (isNextSeason()) {
      const next = season2627Data();
      return state.view === "players" ? next.players[state.split] : next.teams[state.split];
    }
    return state.view === "players" ? DATA.players[state.split] : DATA.teams[state.split];
  }

  // Set-piece marks use FPL's absolute order (same source as The Scout page):
  //   PK → #1 check only
  //   FK / CK → #1 check, #2 shows "2"
  // Null and #3+ stay completely blank.
  const SET_PIECE_CHECK_KEYS = ["penaltiesOrder", "directFreekicksOrder", "cornersOrder"];
  const SET_PIECE_DISPLAY_MAX = {
    penaltiesOrder: 1,
    directFreekicksOrder: 2,
    cornersOrder: 2,
  };

  function setPieceOrder(row, key) {
    if (row == null || row[key] == null || row[key] === "") return null;
    const n = Number(row[key]);
    return Number.isFinite(n) ? n : null;
  }

  function setPieceDisplayRank(row, key) {
    const order = setPieceOrder(row, key);
    if (order == null) return null;
    const max = SET_PIECE_DISPLAY_MAX[key] ?? 1;
    if (order < 1 || order > max) return null;
    return order;
  }

  function isSetPieceTaker(row) {
    return SET_PIECE_CHECK_KEYS.some((key) => setPieceOrder(row, key) === 1);
  }

  function applyFilters(rows) {
    // Rankings has no search UI — ignore any leftover query from other pages.
    const q = state.page === "rankings" ? "" : state.search.trim().toLowerCase();
    return rows.filter((r) => {
      if (state.view === "players") {
        if (excludeDepartedPlayer(r)) return false;
        if (state.setPieceTakersOnly && !isSetPieceTaker(r)) return false;
        // Match table display: Updates remaps team / position / £ on 2025/26 rows.
        if (state.posFilter.size && !state.posFilter.has(filterPosition(r))) return false;
        if (state.teamFilter.size && !state.teamFilter.has(filterTeamCode(r))) return false;
        const price = effectivePrice(r);
        if (price < state.priceMin || price > state.priceMax) return false;
        if (!passesOwnershipFilter(r)) return false;
        if (r.mins < state.minsMin || r.mins > state.minsMax) return false;
        if (q && !playerSearchHaystack(r).includes(q)) return false;
      } else {
        if (state.teamFilter.size && !state.teamFilter.has(r.team)) return false;
        if (q) {
          const hay = (r.name + " " + r.team + " " + teamNameForSeason(r.team)).toLowerCase();
          if (!hay.includes(q)) return false;
        }
      }
      return true;
    });
  }

  function per90Value(row, col) {
    const mins = row.mins || 0;
    if (!mins) return 0;
    // Derived rate columns (e.g. G+A) still live on the row as a precomputed
    // season total — scale that total the same way as any other counting stat.
    return ((row[col.key] || 0) / mins) * 90;
  }

  // Active price for display / Per £m / price filter: next-season price while
  // Updates is on (when matched). In 2026/27 mode the row price is already remapped.
  function effectivePrice(row) {
    if (updatesOverlayOn() && row.price2627 != null) return row.price2627;
    return row.price || 0;
  }

  // Filter chips / search must match crest + position badge + £ in the table.
  function filterTeamCode(row) {
    if (state.view === "teams") return row.team;
    if (updatesOverlayOn() && row.newTeam) return row.newTeam;
    return row.team;
  }

  function filterPosition(row) {
    if (updatesOverlayOn() && row.newPosition) return row.newPosition;
    return row.position;
  }

  function playerSearchHaystack(row) {
    const team = filterTeamCode(row);
    const parts = [row.name, team, teamNameForSeason(team)];
    if (row.team && row.team !== team) {
      parts.push(row.team, teamNameForSeason(row.team));
    }
    return parts.join(" ").toLowerCase();
  }

  function perMillionValue(row, col) {
    const price = effectivePrice(row);
    if (!price) return 0;
    return (row[col.key] || 0) / price;
  }

  function displayValue(row, col) {
    // Already-normalised derived rates (Pts/GP, G/GP) must not be rescaled.
    if (col.derived && !col.rate) return row[col.key];
    if (col.key === "price") return effectivePrice(row) || row.price;
    if (col.key === "owned") return currentOwnership(row.code);
    if (state.view === "players" && col.rate) {
      if (state.valueMode === "per90") return per90Value(row, col);
      if (state.valueMode === "perM") return perMillionValue(row, col);
    }
    return row[col.key];
  }

  // Season totals keep their column precision. Per 90 / Per £m values use at
  // least 1dp, with small nonzero values rendered as "<0.1" rather than "0.0".
  function displayDecimals(col) {
    if (state.view === "players" && col.rate && (state.valueMode === "per90" || state.valueMode === "perM")) {
      return Math.max(col.decimals, 1);
    }
    return col.decimals;
  }

  function fmtDisplayValue(value, col) {
    const isRateMode =
      state.view === "players" &&
      col.rate &&
      (state.valueMode === "per90" || state.valueMode === "perM");
    if (isRateMode && value > 0 && value < 0.1) return "<0.1";
    return fmtNum(value, displayDecimals(col));
  }

  // Position-gated FPL stats: show "–" (still demoted) instead of a
  // misleading 0 when the category can't apply to that role.
  function isStatApplicable(row, col) {
    if (state.view !== "players" || !row || !col) return true;
    const pos = row.position;
    if (!pos) return true;
    switch (col.key) {
      case "saves":
        return pos === "GK";
      case "cleanSheets":
        return pos === "GK" || pos === "DEF" || pos === "MID";
      // Goals conceded and xGC are recorded for every outfield position, not
      // just the two that lose points for them — a forward's xGC still says
      // something about the game state they play in, so the number is shown
      // wherever the API reports it.
      case "defCon":
        // Keepers can't earn contribution points, but the CSV carries the
        // points themselves on every split.
        return defconPosition(row) !== "GK";
      case "__cbitr":
        return defconPosition(row) !== "GK";
      default:
        return true;
    }
  }

  function notApplicableReason(row, col) {
    return `Not applicable for ${row.position || "this position"}`;
  }

  function sourceUnsupportedReason(row, col) {
    // 2026/27 preview rows are intentionally zeroed — don't flag missing H/A.
    if (isNextSeason()) return null;
    if (state.view !== "players" || !FPL_SEASON_TOTAL_ONLY.has(col.key)) return null;
    if (!isStatApplicable(row, col)) return null;
    if (state.split !== "combined") {
      return "FPL API data source does not support home/away splits for 2025/26 season";
    }
    // cleanSheets is present (including a valid zero) on every successfully
    // matched history_past row, so it is also our provenance marker for xGI,
    // whose FFH fallback would otherwise conceal a missing FPL match.
    if (!Object.prototype.hasOwnProperty.call(row, "cleanSheets")) {
      const label = col.title || col.label || col.key;
      return `${label} is unavailable — this player could not be matched to an FPL season-total record`;
    }
    return null;
  }

  function isStatAvailable(row, col) {
    return isStatApplicable(row, col) && !sourceUnsupportedReason(row, col);
  }

  function sourceUnsupportedHTML(reason) {
    return `<span class="source-unsupported" role="img" aria-label="${escapeHtml(reason)}"${tipAttr(reason)}>${iconHTML("triangle-alert")}</span>`;
  }

  // DefCon indicator beside CBIT/R. Thresholds are per *match* (DEF 10 /
  // MID·FWD 12), not per 90 — a 20′ cameo with 5 actions is 22.5/90 but never
  // hit the bar. `meets` therefore follows earned DC points (2 per hit).
  function defconStatus(row) {
    const pos = defconPosition(row);
    const rule = DEFCON_RULES[pos];
    if (!rule || row.__cbitr == null || !row.mins) return null;
    const per90 = (row.__cbitr / row.mins) * 90;
    const dcPts = Number(row.defCon) || 0;
    const hits = Math.floor(dcPts / 2);
    return {
      pos,
      per90,
      actions: row.__cbitr,
      rule,
      threshold: rule.threshold,
      dcPts,
      hits,
      meets: dcPts > 0,
    };
  }

  // Check beside CBIT/R only when the player has actually earned DefCon
  // points (hit the match threshold at least once). Color: blue in light
  // mode, red in dark mode (see .threshold-dot).
  function defconDotHTML(row) {
    const status = defconStatus(row);
    if (!status || !status.meets) return "";
    const hitLabel = status.hits === 1 ? "1 match" : `${status.hits} matches`;
    const title =
      `DefCon hit in ${hitLabel} (+${status.dcPts} pts) — ` +
      `${status.threshold} ${status.pos} actions needed per match` +
      (status.per90 ? ` · ${status.per90.toFixed(1)} actions/90` : "");
    return `<span class="threshold-dot"${tipAttr(title)}><svg class="check-mark-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg></span>`;
  }

  // Filled squad pin used in row chrome and page-info keys.
  function ownedPinSVG(className = "owned-flag-icon") {
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0Z"/><path d="m9 10 2 2 4-4"/></svg>`;
  }

  // Team / position moves only (price-only changes are common).
  // Used for the Updates overlay blue edge, not an in-row icon.
  function playerHasSeasonUpdate(row) {
    if (isNextSeason() || !HAS_PRICE_DATA || !row || state.view !== "players") return false;
    const teamChanged = !!(row.newTeam && row.newTeam !== row.team);
    const posChanged = !!(row.newPosition && row.newPosition !== row.position);
    return teamChanged || posChanged;
  }

  function spitOwnedPinHTML() {
    return ownedPinSVG("spit-owned-pin");
  }

  function spitCheckMarkHTML(className = "spit-check-mark") {
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`;
  }

  function sortRows(rows) {
    const col = cols().find((c) => c.key === state.sortKey);
    const dir = state.sortDir === "asc" ? 1 : -1;
    return rows.slice().sort((a, b) => {
      let va, vb;
      if (!col || col.type === "pos" || col.type === "name" || col.type === "team" || col.type === "player") {
        const field = col && col.type === "player" ? "name" : col ? col.key : "";
        va = a[field] || "";
        vb = b[field] || "";
        return dir * String(va).localeCompare(String(vb));
      }
      if (col.type === "check") {
        const rankA = setPieceDisplayRank(a, col.key) || 99;
        const rankB = setPieceDisplayRank(b, col.key) || 99;
        return dir * (rankA - rankB);
      }
      const aNA = !isStatAvailable(a, col);
      const bNA = !isStatAvailable(b, col);
      if (aNA !== bNA) return aNA ? 1 : -1;
      va = displayValue(a, col) || 0;
      vb = displayValue(b, col) || 0;
      return dir * (va - vb);
    });
  }

  function rowKey(row) {
    return state.view === "players" ? row.id : row.team;
  }

  // ---------------------------------------------------------------------
  // Viewer-owned squad (FPL manager ID → owned player codes)
  // ---------------------------------------------------------------------
  const FPL_ID_KEY = "fpl-explorer-manager-id";
  const FPL_LEAGUE_KEY = "fpl-explorer-league-id";
  const HOME_LEAGUE_ID = "954157";
  const HOME_LEAGUE_NAME = "SoCal Big Guy FPL";
  const TRACKED_MANAGER_IDS = [296817, 1404383, 5497737, 185072];
  const TEAM_MODE_KEY = "fpl-explorer-team-mode";
  const TEAM_ACTUAL_KEY = "fpl-explorer-team-actual";
  let ownedCodes = new Set();
  let savedManagerId = null;
  let savedLeagueId = null;
  async function fetchManagerSquad(managerId) {
    const url = `/api/fpl/squad?id=${encodeURIComponent(managerId)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || !data || !data.ok) {
      const err = new Error((data && data.error) || `Manager sync failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function normalizeSquadSlots(raw) {
    return (Array.isArray(raw) ? raw : [])
      .filter((s) => s && s.code != null && TEAM_SQUAD_MAX[s.position])
      .slice(0, 15)
      .map((s) => ({
        code: Number(s.code) || s.code,
        position: s.position,
        starter: !!s.starter,
        benchOrder: Number.isFinite(s.benchOrder) ? s.benchOrder : 0,
      }));
  }

  function loadActualSnapshot() {
    try {
      const raw = localStorage.getItem(TEAM_ACTUAL_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.squad)) return null;
      return {
        squad: normalizeSquadSlots(parsed.squad),
        captain: parsed.captain != null ? Number(parsed.captain) || parsed.captain : null,
        vice: parsed.vice != null ? Number(parsed.vice) || parsed.vice : null,
        meta: parsed.meta || null,
      };
    } catch {
      return null;
    }
  }

  function saveActualSnapshot(snap) {
    try {
      localStorage.setItem(
        TEAM_ACTUAL_KEY,
        JSON.stringify({
          version: 1,
          squad: snap.squad || [],
          captain: snap.captain ?? null,
          vice: snap.vice ?? null,
          meta: snap.meta || null,
        })
      );
    } catch {
      /* private browsing */
    }
  }

  function applySquadSnapshot(snap) {
    state.teamSquad = normalizeSquadSlots(snap && snap.squad);
    state.teamCaptainCode = snap && snap.captain != null ? Number(snap.captain) || snap.captain : null;
    state.teamViceCode = snap && snap.vice != null ? Number(snap.vice) || snap.vice : null;
    normalizeTeamRoles();
  }

  function teamIsEditable() {
    return state.teamMode !== "actual";
  }

  function plannerDraftIsEmpty() {
    try {
      const raw = localStorage.getItem(TEAM_DRAFT_KEY);
      if (!raw) return !state.teamSquad.length;
      const parsed = JSON.parse(raw);
      return !(parsed && Array.isArray(parsed.squad) && parsed.squad.length);
    } catch {
      return !state.teamSquad.length;
    }
  }

  function trackedManagerById(id) {
    const n = Number(id);
    if (!TRACKED_MANAGER_IDS.includes(n)) return null;
    return (LEAGUES.managers || []).find((m) => Number(m.id) === n) || null;
  }

  function trackedLeagueById(id) {
    const n = Number(id);
    return (LEAGUES.leagues || []).find((L) => Number(L.id) === n) || null;
  }

  function refreshManagerDependentUI() {
    syncFplIdStatus();
    syncTeamModeUI();
    if (state.page === "home") renderHome();
    else if (state.page === "rankings") renderRankings();
    else if (state.page === "team") renderTeam();
    else if (state.page === "opta") renderTable();
    else renderTable();
  }

  function populateManagerSelect() {
    if (!el.fplManagerSelect) return;
    const selected = savedManagerId || "";
    const allowed = new Set(TRACKED_MANAGER_IDS.map(String));
    const opts = ['<option value="">Select manager…</option>'];
    for (const m of LEAGUES.managers || []) {
      if (!allowed.has(String(m.id))) continue;
      const label = m.teamName ? `${m.name} — ${m.teamName}` : m.name;
      opts.push(
        `<option value="${escapeHtml(String(m.id))}">${escapeHtml(label)}</option>`
      );
    }
    el.fplManagerSelect.innerHTML = opts.join("");
    el.fplManagerSelect.value = selected;
    if (selected && el.fplManagerSelect.value !== selected) {
      el.fplManagerSelect.value = "";
    }
  }

  function syncFixedHomeLeague({ persist = true, quiet = true } = {}) {
    applyLeagueId(HOME_LEAGUE_ID, { persist, quiet });
    if (el.fplLeagueLabel) el.fplLeagueLabel.textContent = HOME_LEAGUE_NAME;
  }

  function rebuildLeagueSelect() {
    syncFixedHomeLeague({ persist: true, quiet: true });
  }

  function applyLeagueId(rawId, { persist = true, quiet = true } = {}) {
    const id = HOME_LEAGUE_ID;
    if (String(rawId || "").trim() && String(rawId).trim() !== id) {
      if (!quiet) {
        showToast({
          title: "League fixed",
          message: HOME_LEAGUE_NAME,
          icon: "info",
        });
      }
    }
    const prevLeague = savedLeagueId;
    savedLeagueId = id;
    if (persist) {
      try {
        localStorage.setItem(FPL_LEAGUE_KEY, id);
      } catch {
        /* private browsing */
      }
      persistHomePrefs();
    }
    if (el.fplLeagueLabel) el.fplLeagueLabel.textContent = HOME_LEAGUE_NAME;
    if (!quiet) syncFplIdStatus();
    // Rebuild Home + site-wide owned indicators when the league target changes.
    if (String(prevLeague || "") !== String(id)) {
      scheduleSiteRefreshForHomeTargets({ toast: !quiet });
    } else {
      refreshManagerDependentUI();
    }
  }

  function syncFplIdStatus() {
    if (!el.fplIdStatus) return;
    if (!savedManagerId) {
      el.fplIdStatus.textContent = "No manager linked.";
      syncTeamPlannerPrefsBtns();
      return;
    }
    const manager = trackedManagerById(savedManagerId);
    const league = trackedLeagueById(savedLeagueId);
    const n = ownedCodes.size;
    const meta = state.actualMeta;
    const bits = [];
    if (manager) {
      bits.push(manager.teamName ? `${manager.name} (${manager.teamName})` : manager.name);
    } else {
      bits.push(`ID ${savedManagerId}`);
    }
    if (league) bits.push(league.name);
    if (meta && meta.gwLabel) bits.push(meta.gwLabel);
    if (n > 0) bits.push(`${n} pick${n === 1 ? "" : "s"}`);
    else if (meta && meta.hasPicks === false) bits.push("no published picks yet");
    else bits.push("not synced");
    el.fplIdStatus.textContent = bits.join(" · ");
    syncTeamPlannerPrefsBtns();
  }

  let confirmArmBtn = null;
  let confirmArmTimer = null;

  function confirmButtonLabelEl(btn) {
    return (btn && (btn.querySelector(".btn-label") || btn)) || null;
  }

  function disarmConfirmButton(btn) {
    const target = btn || confirmArmBtn;
    if (!target) {
      if (confirmArmTimer) {
        clearTimeout(confirmArmTimer);
        confirmArmTimer = null;
      }
      return;
    }
    if (confirmArmBtn === target) {
      confirmArmBtn = null;
      if (confirmArmTimer) {
        clearTimeout(confirmArmTimer);
        confirmArmTimer = null;
      }
    }
    const labelEl = confirmButtonLabelEl(target);
    if (labelEl && target.dataset.confirmOrig != null) {
      labelEl.textContent = target.dataset.confirmOrig;
    }
    delete target.dataset.confirmOrig;
    delete target.dataset.confirmArmed;
    target.classList.remove("is-confirm-armed");
    target.removeAttribute("aria-pressed");
  }

  function armConfirmButton(btn, { onConfirm, timeoutMs = 4000 } = {}) {
    if (!btn) return;
    if (btn.dataset.confirmArmed === "1") {
      disarmConfirmButton(btn);
      if (typeof onConfirm === "function") onConfirm();
      return;
    }
    if (confirmArmBtn && confirmArmBtn !== btn) disarmConfirmButton(confirmArmBtn);
    const labelEl = confirmButtonLabelEl(btn);
    if (labelEl && btn.dataset.confirmOrig == null) {
      btn.dataset.confirmOrig = labelEl.textContent;
      labelEl.textContent = "Confirm";
    }
    btn.dataset.confirmArmed = "1";
    btn.classList.add("is-confirm-armed");
    btn.setAttribute("aria-pressed", "true");
    confirmArmBtn = btn;
    if (confirmArmTimer) clearTimeout(confirmArmTimer);
    confirmArmTimer = setTimeout(() => disarmConfirmButton(btn), timeoutMs);
  }

  function syncTeamModeUI() {
    if (el.teamPage) {
      el.teamPage.dataset.teamMode = state.teamMode;
      el.teamPage.classList.toggle("is-actual-readonly", state.teamMode === "actual");
    }
    if (el.teamModeSeg) {
      el.teamModeSeg.querySelectorAll("[data-team-mode]").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-team-mode") === state.teamMode);
      });
      syncSegThumb(el.teamModeSeg, { animate: false });
    }
    if (el.teamPageSubtitle) {
      el.teamPageSubtitle.textContent =
        state.teamMode === "actual"
          ? "Read-only view of your linked FPL squad. Switch to Planner to draft changes."
          : "Editable planner squad (£100.0m). Use Resync to replace this with your linked Actual team.";
    }
    syncTeamPlannerPrefsBtns();
  }

  function syncTeamPlannerPrefsBtns() {
    const planner = state.teamMode === "planner";
    const canResync = !!savedManagerId && planner;
    const canClear = planner && !!state.teamSquad.length;
    const desktop = !NARROW_MQ.matches;

    const syncOne = (btn, { show, enabled }) => {
      if (!btn) return;
      btn.hidden = !show;
      btn.disabled = !enabled;
      if (!show || !enabled) disarmConfirmButton(btn);
    };

    // Prefs buttons: mobile only (desktop uses toolbar).
    syncOne(el.teamResyncBtn, { show: canResync && !desktop, enabled: canResync });
    syncOne(el.teamClearBtn, { show: canClear && !desktop, enabled: canClear });
    // Toolbar: desktop Team page, Planner mode.
    const onTeamDesktop = desktop && state.page === "team";
    syncOne(el.teamResyncToolbar, { show: onTeamDesktop && canResync, enabled: canResync });
    syncOne(el.teamClearToolbar, { show: onTeamDesktop && canClear, enabled: canClear });
  }

  function setTeamMode(mode, { render = true, persist = true } = {}) {
    const next = mode === "actual" ? "actual" : "planner";
    if (state.teamMode === "planner" && next !== "planner") {
      saveTeamDraft();
      closeTeamPicker({ silent: true });
      cancelTeamSub({ silent: true });
      hideTeamRowActionsPopup();
    }
    state.teamMode = next;
    if (persist) {
      try {
        localStorage.setItem(TEAM_MODE_KEY, next);
      } catch {
        /* private browsing */
      }
    }
    if (next === "actual") {
      const snap = loadActualSnapshot() || { squad: [], captain: null, vice: null, meta: state.actualMeta };
      state.actualMeta = snap.meta || state.actualMeta;
      applySquadSnapshot(snap);
      state.teamCompareMode = false;
      state.teamCompareCodes = [];
      state.teamSearchActiveCode = null;
    } else {
      loadTeamDraft();
    }
    syncTeamModeUI();
    if (render) renderTeam();
  }

  async function ingestManagerSquad(payload, { seedPlannerIfEmpty = false } = {}) {
    const snap = {
      squad: normalizeSquadSlots(payload.squad),
      captain: payload.captain != null ? Number(payload.captain) || payload.captain : null,
      vice: payload.vice != null ? Number(payload.vice) || payload.vice : null,
      meta: {
        syncedAt: payload.syncedAt || new Date().toISOString(),
        gw: payload.gw,
        gwLabel: payload.gwLabel || (payload.hasPicks ? `Gameweek ${payload.gw}` : "Preseason"),
        teamName: payload.teamName || "",
        managerName: payload.managerName || "",
        hasPicks: !!payload.hasPicks,
        message: payload.message || null,
        managerId: String(payload.managerId || savedManagerId || ""),
      },
    };
    saveActualSnapshot(snap);
    state.actualMeta = snap.meta;
    ownedCodes = new Set(snap.squad.map((s) => s.code));
    if (seedPlannerIfEmpty && payload.hasPicks && plannerDraftIsEmpty()) {
      const prevMode = state.teamMode;
      state.teamMode = "planner";
      applySquadSnapshot(snap);
      saveTeamDraft();
      state.teamMode = prevMode;
      if (prevMode === "actual") applySquadSnapshot(snap);
    } else if (state.teamMode === "actual") {
      applySquadSnapshot(snap);
    }
    syncFplIdStatus();
    syncTeamModeUI();
    return snap;
  }

  async function syncManagerFromApi(managerId, { seedPlannerIfEmpty = false, quiet = false } = {}) {
    const payload = await fetchManagerSquad(managerId);
    await ingestManagerSquad(payload, { seedPlannerIfEmpty });
    if (!quiet) {
      showToast({
        title: payload.hasPicks ? "FPL squad synced" : "Manager linked",
        message: payload.hasPicks
          ? `${payload.squad.length} picks · ${payload.gwLabel || "GW"}`
          : payload.message || "No published picks yet — Actual stays empty until FPL publishes them.",
        icon: payload.hasPicks ? "circle-check" : "info",
      });
    }
    return payload;
  }

  function homePrefsBody() {
    return {
      managerId: savedManagerId ? Number(savedManagerId) : null,
      leagueId: savedLeagueId ? Number(savedLeagueId) : null,
    };
  }

  function persistHomePrefs() {
    // Fire-and-forget; local serve.py writes site/home_prefs.json for fetch_home.py.
    try {
      return fetch("/api/home-prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(homePrefsBody()),
      }).catch(() => null);
    } catch {
      /* file:// or offline */
      return Promise.resolve(null);
    }
  }

  function applyHomePayload(payload) {
    if (!payload || typeof payload !== "object") return false;
    HOME.generatedAt = payload.generatedAt ?? null;
    HOME.gw = payload.gw ?? null;
    HOME.managerId = payload.managerId ?? null;
    HOME.leagueId = payload.leagueId ?? null;
    HOME.leagueName = payload.leagueName ?? null;
    HOME.summary = payload.summary ?? null;
    HOME.squad = Array.isArray(payload.squad) ? payload.squad : [];
    HOME.squadsByEntry = payload.squadsByEntry && typeof payload.squadsByEntry === "object"
      ? payload.squadsByEntry
      : {};
    HOME.standings = Array.isArray(payload.standings) ? payload.standings : [];
    HOME.ownersByElement = payload.ownersByElement || {};
    HOME.elementGw = payload.elementGw && typeof payload.elementGw === "object"
      ? payload.elementGw
      : {};
    HOME.error = payload.error ?? null;
    window.FPL_HOME = HOME;
    homeOwnerPin = null;
    homeViewEntryId = null;
    homeElementGwCache = null;
    return true;
  }

  let homeTargetsRefreshTimer = null;
  let homeTargetsRefreshSeq = 0;

  function scheduleSiteRefreshForHomeTargets({ toast = false } = {}) {
    // Owned pins / tables update immediately from the live squad sync.
    refreshManagerDependentUI();
    if (homeTargetsRefreshTimer) clearTimeout(homeTargetsRefreshTimer);
    const seq = ++homeTargetsRefreshSeq;
    homeTargetsRefreshTimer = setTimeout(() => {
      homeTargetsRefreshTimer = null;
      refreshHomeCacheFromServer({ toast, seq });
    }, 400);
  }

  async function refreshHomeCacheFromServer({ toast = false, seq = 0 } = {}) {
    if (!savedManagerId || !savedLeagueId) {
      refreshManagerDependentUI();
      return false;
    }
    try {
      await persistHomePrefs();
      if (seq && seq !== homeTargetsRefreshSeq) return false;
      const res = await fetch("/api/refresh-home", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(homePrefsBody()),
      });
      if (seq && seq !== homeTargetsRefreshSeq) return false;
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const errBody = await res.json();
          if (errBody && errBody.error) msg = String(errBody.error);
        } catch { /* ignore */ }
        if (toast) {
          showToast({
            title: "Home cache not refreshed",
            message: msg.slice(0, 160),
            icon: "triangle-alert",
          });
        }
        refreshManagerDependentUI();
        return false;
      }
      const data = await res.json();
      if (seq && seq !== homeTargetsRefreshSeq) return false;
      if (!(data && data.ok && data.home)) {
        refreshManagerDependentUI();
        return false;
      }
      applyHomePayload(data.home);
      refreshManagerDependentUI();
      if (toast) {
        showToast({
          title: "Home updated",
          message: `GW${data.home.gw ?? "?"} · ${data.home.leagueName || "league"}`,
          icon: "check",
        });
      }
      return true;
    } catch {
      // Static host / offline — UI still refreshed from live squad ownership.
      refreshManagerDependentUI();
      return false;
    }
  }

  const LIVE_HOME_API = String(window.FPL_LIVE_API || "").replace(/\/$/, "");
  let homeLivePollTimer = null;
  let homeLiveLastPollAt = 0;
  let homeLiveLastPollOk = false;

  function homeLiveApiUrl() {
    if (LIVE_HOME_API) return `${LIVE_HOME_API}/api/home`;
    // Same-origin proxy (local serve.py or Vercel /api/home → DO droplet).
    if (
      location.hostname === "localhost"
      || location.hostname === "127.0.0.1"
      || location.hostname.endsWith("vercel.app")
      || location.hostname === "fpl-explorer.vercel.app"
    ) {
      return "/api/home";
    }
    return "";
  }

  function homeLivePayloadMatchesPrefs(home) {
    if (!home || !savedManagerId) return false;
    if (String(home.leagueId) !== HOME_LEAGUE_ID) return false;
    return TRACKED_MANAGER_IDS.map(String).includes(String(savedManagerId));
  }

  async function pollHomeFromLiveServer() {
    const url = homeLiveApiUrl();
    if (!url || state.page !== "home") return;
    if (!savedManagerId || !savedLeagueId) return;
    homeLiveLastPollAt = Date.now();
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        homeLiveLastPollOk = false;
        syncHomeCountLabel();
        return;
      }
      const data = await res.json();
      if (!(data && data.ok && data.home)) {
        homeLiveLastPollOk = false;
        syncHomeCountLabel();
        return;
      }
      if (!homeLivePayloadMatchesPrefs(data.home)) {
        homeLiveLastPollOk = false;
        syncHomeCountLabel();
        return;
      }
      homeLiveLastPollOk = true;
      applyHomePayload(data.home);
      renderHome();
    } catch {
      homeLiveLastPollOk = false;
      syncHomeCountLabel();
    }
  }

  function syncHomeLivePolling() {
    if (homeLivePollTimer) {
      clearInterval(homeLivePollTimer);
      homeLivePollTimer = null;
    }
    if (!homeLiveApiUrl() || state.page !== "home") return;
    if (!savedManagerId || !savedLeagueId) return;
    homeLiveLastPollOk = false;
    homeLiveLastPollAt = 0;
    pollHomeFromLiveServer();
    homeLivePollTimer = setInterval(pollHomeFromLiveServer, 60_000);
  }

  function syncHomeCountLabel() {
    if (!el.homeCountLabel) return;
    const linked = !!(savedManagerId && savedLeagueId);
    const hasPayload = !!(HOME && HOME.summary && HOME.managerId && HOME.leagueId);
    el.homeCountLabel.classList.remove("is-live", "is-live-stale", "is-live-offline");

    if (!linked) {
      el.homeCountLabel.textContent = "No manager linked";
      el.homeCountLabel.removeAttribute("title");
      return;
    }
    if (!hasPayload) {
      el.homeCountLabel.textContent = "Refresh home to load";
      el.homeCountLabel.removeAttribute("title");
      return;
    }

    const when = fmtMarketsUpdated(HOME.generatedAt);
    let text = `GW${HOME.gw || "?"}`;
    if (when) text += ` · Updated ${when}`;
    if (HOME.generatedAt) {
      el.homeCountLabel.title = `Data refreshed ${HOME.generatedAt.replace("T", " ").replace("Z", " UTC")}`;
    } else {
      el.homeCountLabel.removeAttribute("title");
    }

    const liveUrl = homeLiveApiUrl();
    if (liveUrl) {
      const polledRecently = homeLiveLastPollAt && Date.now() - homeLiveLastPollAt < 120_000;
      if (homeLiveLastPollOk && polledRecently) {
        text += " · Live";
        el.homeCountLabel.classList.add("is-live");
      } else if (homeLiveLastPollAt && polledRecently) {
        text += " · Live offline";
        el.homeCountLabel.classList.add("is-live-offline");
      } else if (!homeLiveLastPollAt) {
        text += " · Connecting…";
      } else {
        text += " · Live offline";
        el.homeCountLabel.classList.add("is-live-stale");
      }
    }

    el.homeCountLabel.textContent = text;
  }

  function homeKickoffParts(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    try {
      return {
        day: d.toLocaleString(undefined, { weekday: "short" }).toUpperCase(),
        // Always 24h — compact MP stack (no AM/PM).
        time: d.toLocaleString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      };
    } catch {
      return null;
    }
  }

  function homeKickoffHTML(iso) {
    const parts = homeKickoffParts(iso);
    if (!parts) return `<span class="home-mp-line home-kickoff">—</span>`;
    return `<span class="home-mp-line home-kickoff" title="${escapeHtml(`${parts.day} ${parts.time}`)}"><span class="home-kickoff-day">${escapeHtml(parts.day)}</span><span class="home-kickoff-time">${escapeHtml(parts.time)}</span></span>`;
  }

  function formatHomeRank(n) {
    if (n == null || n === "" || Number(n) <= 0) return "—";
    const v = Number(n);
    if (v >= 1e6) {
      const m = v / 1e6;
      return `${m >= 10 ? m.toFixed(1) : m.toFixed(2).replace(/0$/, "")}M`;
    }
    if (v >= 1e4) return `${(v / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
    return v.toLocaleString();
  }

  function homeRankDeltaPlaces(current, previous) {
    const cur = Number(current);
    const prev = Number(previous);
    if (!Number.isFinite(cur) || !Number.isFinite(prev) || cur <= 0 || prev <= 0) return null;
    return prev - cur;
  }

  function formatHomeRankDelta(places) {
    const abs = Math.abs(Number(places) || 0);
    if (abs >= 1e6) {
      const m = abs / 1e6;
      return `${m >= 10 ? m.toFixed(1) : m.toFixed(2).replace(/0$/, "")}M`;
    }
    if (abs >= 1e4) return `${(abs / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
    return abs.toLocaleString();
  }

  function setHomeRankDelta(elDelta, places) {
    if (!elDelta) return;
    const delta = places;
    if (delta == null || !Number.isFinite(delta)) {
      elDelta.hidden = true;
      elDelta.className = "home-rank-delta";
      elDelta.innerHTML = "";
      elDelta.removeAttribute("title");
      elDelta.removeAttribute("aria-label");
      return;
    }
    const up = delta > 0;
    const flat = delta === 0;
    const cls = flat ? "is-flat" : up ? "is-up" : "is-down";
    const icon = flat ? "minus" : up ? "trending-up" : "trending-down";
    const label = flat
      ? "Rank unchanged vs last gameweek"
      : `${up ? "Up" : "Down"} ${formatHomeRankDelta(delta)} places vs last gameweek`;
    elDelta.hidden = false;
    elDelta.className = `home-rank-delta ${cls}`;
    elDelta.title = label;
    elDelta.setAttribute("aria-label", label);
    elDelta.innerHTML = iconHTML(icon);
  }

  function homeTopPercentLabel(rank, totalPlayers) {
    const r = Number(rank);
    const n = Number(totalPlayers);
    if (!Number.isFinite(r) || !Number.isFinite(n) || r <= 0 || n <= 0) return "";
    const pct = (r / n) * 100;
    if (pct <= 0.1) return "Top 0.1%";
    if (pct <= 1) return "Top 1%";
    if (pct <= 5) return "Top 5%";
    if (pct <= 10) return "Top 10%";
    return "";
  }

  function setHomeOverallPct(elPct, rank, totalPlayers) {
    if (!elPct) return;
    const label = homeTopPercentLabel(rank, totalPlayers);
    if (!label) {
      elPct.hidden = true;
      elPct.textContent = "";
      return;
    }
    elPct.hidden = false;
    elPct.textContent = label;
  }

  function homeSquadFixtures(row) {
    if (Array.isArray(row.fixtures) && row.fixtures.length) return row.fixtures;
    return [{
      opp: row.opp || "—",
      oppHa: row.oppHa || "",
      kickoff: row.kickoff,
      live: !!row.live,
      finished: row.matchStatus === "finished",
      minutes: row.minutes,
    }];
  }


  // Squad ↔ standings: squad tap filters standings by owner; standings tap switches
  // the whole Home view to that manager's team. Pin = { type: "element", id }.
  let homeOwnerPin = null;
  let homeOwnerBindingsReady = false;
  let homeViewEntryId = null;
  // Mobile Home player lookup (search FAB → profile + club matchups).
  let homeLookupPlayer = null;
  let homeElementGwCache = null;

  function homeConfiguredEntryId() {
    const id = Number(savedManagerId);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  function homeActiveViewEntryId() {
    const configured = homeConfiguredEntryId();
    const view = homeViewEntryId != null ? Number(homeViewEntryId) : configured;
    return Number.isFinite(view) ? view : null;
  }

  function homeIsViewingOtherManager() {
    const configured = homeConfiguredEntryId();
    const active = homeActiveViewEntryId();
    return configured != null && active != null && active !== configured;
  }

  function homeStandingForEntry(entryId) {
    const id = Number(entryId);
    if (!Number.isFinite(id)) return null;
    return (HOME.standings || []).find((r) => Number(r.entry) === id) || null;
  }

  function homeSquadForEntry(entryId) {
    const id = Number(entryId);
    if (!Number.isFinite(id)) return [];
    const map = (HOME && HOME.squadsByEntry) || {};
    const cached = map[String(id)] || map[id];
    if (Array.isArray(cached) && cached.length) return cached;
    if (id === homeConfiguredEntryId()) return Array.isArray(HOME.squad) ? HOME.squad : [];
    return [];
  }

  function homeSummaryForView(entryId) {
    const configured = homeConfiguredEntryId();
    const id = Number(entryId);
    if (!Number.isFinite(id)) return HOME.summary || {};
    const row = homeStandingForEntry(id);
    const payloadSummary =
      HOME.summary && Number(HOME.managerId) === id ? HOME.summary : null;
    if (row) {
      return {
        gwPoints: row.gwPointsLive,
        overallPoints: row.overallPoints ?? row.total,
        overallRank: row.overallRank,
        overallRankPrev: payloadSummary?.overallRankPrev ?? null,
        leagueRank: row.rankLive ?? row.rankOfficial,
        leagueRankPrev: payloadSummary?.leagueRankPrev ?? null,
        totalPlayers: HOME.summary?.totalPlayers,
        eventPointsOfficial: row.eventTotalOfficial,
        teamName: row.entryName || "",
        managerName: row.playerName || "",
        activeChip: row.activeChip,
      };
    }
    if (id === configured && HOME.summary) return HOME.summary;
    return HOME.summary || {};
  }

  function homeViewBannerLabel(entryId) {
    const row = homeStandingForEntry(entryId);
    if (row && row.entryName) return row.entryName;
    const summary = homeSummaryForView(entryId);
    return summary.teamName || summary.managerName || "Manager";
  }

  function setHomeViewEntry(entryId) {
    const id = Number(entryId);
    if (!Number.isFinite(id)) return;
    const configured = homeConfiguredEntryId();
    if (id === homeViewEntryId || (homeViewEntryId == null && id === configured)) {
      clearHomeViewEntry();
      return;
    }
    homeViewEntryId = id;
    homeOwnerPin = null;
    renderHome();
  }

  function clearHomeViewEntry() {
    if (homeViewEntryId == null) return;
    homeViewEntryId = null;
    homeOwnerPin = null;
    renderHome();
  }

  function syncHomeViewBanner() {
    const viewingOther = homeIsViewingOtherManager();
    if (el.homeViewBanner) el.homeViewBanner.hidden = !viewingOther;
    if (el.homeBento) el.homeBento.classList.toggle("is-viewing-manager", viewingOther);
    if (viewingOther && el.homeViewBannerName) {
      el.homeViewBannerName.textContent = homeViewBannerLabel(homeActiveViewEntryId());
    }
  }

  function homeOwnersForElement(elementId) {
    if (elementId == null || elementId === "") return new Set();
    const map = (HOME && HOME.ownersByElement) || {};
    const list = map[elementId] || map[String(elementId)] || [];
    return new Set(list.map(Number).filter((n) => Number.isFinite(n)));
  }

  function homeElementsForEntry(entryId) {
    if (entryId == null || entryId === "") return new Set();
    const entry = Number(entryId);
    if (!Number.isFinite(entry)) return new Set();
    const map = (HOME && HOME.ownersByElement) || {};
    const out = new Set();
    Object.keys(map).forEach((eid) => {
      const list = map[eid] || [];
      if (list.map(Number).includes(entry)) out.add(Number(eid));
    });
    return out;
  }

  function syncHomeOwnerHighlights() {
    const configuredEntry = homeConfiguredEntryId();
    const viewingEntry = homeActiveViewEntryId();
    const viewingOther = homeIsViewingOtherManager();
    const elementPin = homeOwnerPin && homeOwnerPin.type === "element" ? homeOwnerPin : null;
    const ownerEntries = elementPin ? homeOwnersForElement(elementPin.id) : null;
    const configuredOwned = configuredEntry != null
      ? homeElementsForEntry(configuredEntry)
      : new Set();

    if (el.homeSquadBody) {
      el.homeSquadBody.classList.remove("has-owner-filter");
      el.homeSquadBody.querySelectorAll("tr.home-squad-row").forEach((tr) => {
        const eid = Number(tr.dataset.element);
        const isConfiguredOverlap =
          viewingOther && Number.isFinite(eid) && configuredOwned.has(eid);
        const isPinned =
          elementPin && Number.isFinite(eid) && Number(elementPin.id) === eid;
        tr.hidden = false;
        tr.classList.toggle("is-owner-match", isConfiguredOverlap && !isPinned);
        tr.classList.toggle("is-owner-pinned", isPinned);
        tr.classList.remove("is-owner-source");
      });
    }
    if (el.homeStandingsBody) {
      el.homeStandingsBody.classList.toggle("has-owner-filter", !!elementPin);
      el.homeStandingsBody.querySelectorAll("tr[data-entry]").forEach((tr) => {
        const entry = Number(tr.dataset.entry);
        const show = !elementPin || (ownerEntries && ownerEntries.has(entry));
        tr.hidden = !show;
        tr.classList.remove("is-owner-source", "is-owner-pinned", "is-owner-match");
        tr.classList.toggle("is-view-active", Number.isFinite(entry) && entry === viewingEntry);
        tr.classList.toggle(
          "is-configured-manager",
          viewingOther && Number.isFinite(entry) && entry === configuredEntry
        );
      });
    }
  }

  function homeOwnerSame(a, b) {
    return !!a && !!b && a.type === b.type && Number(a.id) === Number(b.id);
  }

  function bindHomeOwnerHighlighting() {
    if (homeOwnerBindingsReady) return;
    if (!el.homeSquadBody || !el.homeStandingsBody) return;
    homeOwnerBindingsReady = true;

    function toggleSquadOwner(tr) {
      if (!tr || !el.homeSquadBody.contains(tr)) return;
      const eid = Number(tr.dataset.element);
      if (!Number.isFinite(eid)) return;
      const next = { type: "element", id: eid };
      homeOwnerPin = homeOwnerSame(homeOwnerPin, next) ? null : next;
      syncHomeOwnerHighlights();
    }

    function toggleStandingOwner(tr) {
      if (!tr || !el.homeStandingsBody.contains(tr)) return;
      const entry = Number(tr.dataset.entry);
      if (!Number.isFinite(entry)) return;
      setHomeViewEntry(entry);
    }

    el.homeSquadBody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr.home-squad-row");
      if (!tr || !el.homeSquadBody.contains(tr)) return;
      e.preventDefault();
      toggleSquadOwner(tr);
    });

    el.homeStandingsBody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-entry]");
      if (!tr || !el.homeStandingsBody.contains(tr)) return;
      e.preventDefault();
      toggleStandingOwner(tr);
    });

    el.homeSquadBody.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tr = e.target.closest("tr.home-squad-row");
      if (!tr || !el.homeSquadBody.contains(tr)) return;
      e.preventDefault();
      toggleSquadOwner(tr);
    });

    el.homeStandingsBody.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tr = e.target.closest("tr[data-entry]");
      if (!tr || !el.homeStandingsBody.contains(tr)) return;
      e.preventDefault();
      toggleStandingOwner(tr);
    });
  }

  function homeSquadRowHTML(row, maxAbsImp = 100) {
    const teamBadge = badgeHTML(row.team, "home-crest") ||
      `<span class="home-crest-fallback">${escapeHtml((row.team || "?").slice(0, 3))}</span>`;
    const tags = [];
    if (row.isCaptain) tags.push(`<span class="home-role-tag home-role-c">C</span>`);
    if (row.isVice) tags.push(`<span class="home-role-tag home-role-a">A</span>`);
    const fx = homeSquadFixtures(row);
    const pts = row.gwPoints != null ? Number(row.gwPoints) : null;
    const ptsHi = pts != null && pts >= 8;
    const ptsHTML = pts == null
      ? "—"
      : `<span class="home-pts${ptsHi ? " is-hot" : ""}${pts === 0 ? " is-zero" : ""}">${escapeHtml(String(pts))}</span>`;

    const mpHTML = fx.map((f) => {
      if (f.live || f.finished) {
        const mins = f.minutes != null ? f.minutes : row.minutes;
        const dot = f.live
          ? `<span class="home-status-dot is-live" aria-label="Live"></span>`
          : `<span class="home-status-dot is-done" aria-label="Played"></span>`;
        return `<span class="home-mp-line">${escapeHtml(String(mins ?? "—"))}′${dot}</span>`;
      }
      return homeKickoffHTML(f.kickoff || row.kickoff);
    }).join("");

    const oppHTML = fx.map((f) => {
      const crest = badgeHTML(f.opp, "home-crest home-crest-sm") ||
        `<span class="home-crest-fallback home-crest-sm">${escapeHtml((f.opp || "?").slice(0, 3))}</span>`;
      const homeIcon = f.oppHa === "H" ? iconHTML("house-solid", "home-ha-icon") : "";
      return `<span class="home-opp-line">${crest}${homeIcon}</span>`;
    }).join("");

    const impRaw = row.imp != null ? Number(row.imp) : (row.impMock != null ? Number(row.impMock) : 0);
    const imp = Number.isFinite(impRaw) ? Math.round(impRaw) : 0;
    const scale = Math.max(1, Number(maxAbsImp) || 1);
    const barPct = Math.min(100, (Math.abs(imp) / scale) * 100);
    const impSign = imp > 0 ? "is-pos" : imp < 0 ? "is-neg" : "is-flat";
    const impLabel = `${Math.abs(imp)}%`;
    const benchCls = row.onBench ? " home-row-bench" : "";
    return `<tr class="home-squad-row${benchCls}" data-element="${escapeHtml(String(row.element ?? ""))}" role="button" tabindex="0" aria-label="Show managers who own ${escapeHtml(row.name || "this player")}">
      <td class="home-col-player">
        <div class="home-player-cell">
          ${teamBadge}
          <div class="home-player-text">
            <div class="home-player-name">${escapeHtml(row.name || "—")}${tags.join("")}</div>
          </div>
        </div>
      </td>
      <td class="home-col-pts">${ptsHTML}</td>
      <td class="home-col-mp"><div class="home-fx-stack">${mpHTML}</div></td>
      <td class="home-col-opp"><div class="home-fx-stack home-fx-opp">${oppHTML}</div></td>
      <td class="home-col-imp">
        <div class="home-imp ${impSign}">
          <span class="home-imp-track"><span class="home-imp-fill ${impSign}" style="width:${barPct}%"></span></span>
          <span class="home-imp-pct">${escapeHtml(impLabel)}</span>
        </div>
      </td>
    </tr>`;
  }


  function homeNextDeadlineLabel() {
    const next = GAMEWEEKS && GAMEWEEKS.next;
    const cur = GAMEWEEKS && GAMEWEEKS.current;
    let gw = next && next.deadlineTime ? next : null;
    if (!gw && cur && cur.deadlineTime) {
      const t = Date.parse(cur.deadlineTime);
      if (Number.isFinite(t) && t > Date.now()) gw = cur;
    }
    if (!gw || !gw.deadlineTime) return "";
    const d = new Date(gw.deadlineTime);
    if (Number.isNaN(d.getTime())) return "";
    const msLeft = d.getTime() - Date.now();
    // Only surface the countdown once the deadline is within 48 hours.
    if (msLeft <= 0 || msLeft > 48 * 60 * 60 * 1000) return "";
    let when = "";
    try {
      const day = d.toLocaleString(undefined, { weekday: "short" });
      const date = d.toLocaleString(undefined, { month: "short", day: "numeric" });
      const time = d.toLocaleString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      when = `${day} ${date} · ${time}`;
    } catch {
      when = d.toISOString();
    }
    const id = gw.id != null ? `GW${gw.id}` : "Next GW";
    return `${id} deadline · ${when}`;
  }

  function homeElementGwMap() {
    if (homeElementGwCache) return homeElementGwCache;
    homeElementGwCache = (HOME && HOME.elementGw) || {};
    return homeElementGwCache;
  }

  function homeElementGwStats(elementId) {
    const id = Number(elementId);
    if (!Number.isFinite(id)) {
      return { pts: 0, live: false, minutes: 0, status: "scheduled" };
    }
    const row = homeElementGwMap()[String(id)] || homeElementGwMap()[id] || {};
    return {
      pts: Number(row.pts) || 0,
      live: !!row.live,
      minutes: Number(row.minutes) || 0,
      status: row.status || "scheduled",
    };
  }

  function homeSearchGwTier(stats) {
    if (stats.live && stats.pts > 0) return 0;
    if (stats.live) return 1;
    if (stats.status === "finished" && stats.pts > 0) return 2;
    if (stats.pts > 0) return 3;
    return 4;
  }

  function homeSearchGwCompare(a, b) {
    const sa = homeElementGwStats(homeLookupElementId(a));
    const sb = homeElementGwStats(homeLookupElementId(b));
    const ta = homeSearchGwTier(sa);
    const tb = homeSearchGwTier(sb);
    if (ta !== tb) return ta - tb;
    if (sb.pts !== sa.pts) return sb.pts - sa.pts;
    if (sb.minutes !== sa.minutes) return sb.minutes - sa.minutes;
    return 0;
  }

  function homeSearchSortRows(rows) {
    return rows.slice().sort((a, b) =>
      homeSearchGwCompare(a, b) || String(a.name || "").localeCompare(String(b.name || ""))
    );
  }

  // Home ownership/standings use live FPL element ids — always search the
  // current-season catalog (2026/27), not the OPTA 2025/26 list.
  function homeSearchCatalog() {
    return (season2627Data().players && season2627Data().players.combined) || [];
  }

  function homeLookupElementId(row) {
    return fplElementIdForRow(row);
  }

  function homeLeagueOwnsElement(elementId) {
    const owners = homeOwnersForElement(elementId);
    return !!(owners && owners.size);
  }

  function homePlayerStatSpecs(position) {
    const pos = String(position || "").toUpperCase();
    const byPos = {
      GK: [
        { key: "saves", label: "Saves", decimals: 0 },
        { key: "cleanSheets", label: "CS", decimals: 0 },
        { key: "goalsConceded", label: "GC", decimals: 0 },
        { key: "pts", label: "Pts", decimals: 0 },
      ],
      DEF: [
        { key: "cleanSheets", label: "CS", decimals: 0 },
        { key: "defCon", label: "DefCon", decimals: 0 },
        { key: "goalsConceded", label: "GC", decimals: 0 },
        { key: "__gi", label: "G+A", decimals: 0 },
      ],
      MID: [
        { key: "assists", label: "Assists", decimals: 0 },
        { key: "goals", label: "Goals", decimals: 0 },
        { key: "xgi", label: "xGI", decimals: 1 },
        { key: "defCon", label: "DefCon", decimals: 0 },
      ],
      FWD: [
        { key: "goals", label: "Goals", decimals: 0 },
        { key: "assists", label: "Assists", decimals: 0 },
        { key: "xg", label: "xG", decimals: 1 },
        { key: "xgi", label: "xGI", decimals: 1 },
      ],
    };
    return byPos[pos] || byPos.FWD;
  }

  function homePlayerStatsHTML(row) {
    if (!row) return "";
    return homePlayerStatSpecs(row.position)
      .map((spec) => {
        const raw = feedRowStatValue(row, spec.key);
        const shown = feedStatDisplay(raw, spec.decimals);
        return `<div class="home-lookup-stat"><span class="home-lookup-stat-val">${escapeHtml(shown)}</span><span class="home-lookup-stat-lbl">${escapeHtml(spec.label)}</span></div>`;
      })
      .join("");
  }

  function homePlayerProfileHTML(row, { ownershipNote = "" } = {}) {
    if (!row) return "";
    const initials = String(row.name || "?")
      .split(/[\s.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?";
    const photo = feedPlayerPhotoUrl(row.code);
    const teamLabel = row.team ? teamNameForSeason(row.team) : "";
    const badge = row.team ? badgeHTML(row.team, "home-lookup-badge") : "";
    const owned = currentOwnership(row.code);
    const metaBits = [];
    if (row.position) metaBits.push(posBadgeHTML(row.position));
    if (row.price != null) metaBits.push(`<span>£${Number(row.price).toFixed(1)}m</span>`);
    if (owned != null) metaBits.push(`<span>${Number(owned).toFixed(1)}% TSB</span>`);
    if (teamLabel) metaBits.push(`<span>${escapeHtml(teamLabel)}</span>`);
    const photoBlock = photo
      ? `<img class="home-lookup-photo" src="${escapeHtml(photo)}" alt="" width="52" height="52" loading="lazy" data-initials="${escapeHtml(initials)}" />`
      : `<span class="home-lookup-photo home-lookup-photo-fallback" aria-hidden="true">${escapeHtml(initials)}</span>`;
    const teamAccent = TEAM_SCATTER_ACCENT[row.team] || "";
    const accentStyle = teamAccent ? `--home-lookup-accent:${teamAccent};` : "";
    return `<article class="home-lookup-card"${accentStyle ? ` style="${accentStyle}"` : ""}>
      <div class="home-lookup-head">
        <div class="home-lookup-photo-wrap">
          ${photoBlock}
          ${badge}
        </div>
        <div class="home-lookup-id">
          <h3 class="home-lookup-name">${escapeHtml(row.name || "—")}</h3>
          <p class="home-lookup-meta">${metaBits.join("")}</p>
        </div>
      </div>
      <div class="home-lookup-stats">${homePlayerStatsHTML(row)}</div>
      ${ownershipNote ? `<p class="home-lookup-ownership-note">${escapeHtml(ownershipNote)}</p>` : ""}
    </article>`;
  }

  function homePlayerMatchupHTML(teamCode) {
    if (!teamCode) {
      return `<div class="ftt-empty">No club fixtures available.</div>`;
    }
    const highlightMaps = fixtureHighlightMaps();
    const rankMaps = fixtureRankMaps();
    const fixtures = planningFixturesForTeam(teamCode, FIXTURE_TT_COUNT);
    const profile = teamMatchupProfile(teamCode, fixtures, rankMaps);
    return `<article class="schedule-card home-lookup-schedule-card" data-team="${escapeHtml(teamCode)}">${fixtureCardHTML(
      teamCode,
      highlightMaps,
      rankMaps,
      {
        fixtures,
        showMeta: false,
        showTeamInfo: true,
        showMatchups: true,
        matchupProfile: profile,
      }
    )}</article>`;
  }

  function homeSearchResultRowHTML(row) {
    const badge = row.team ? badgeHTML(row.team) : "";
    const team = row.team ? teamNameForSeason(row.team) : "";
    const meta = [row.position, team, row.price != null ? `£${Number(row.price).toFixed(1)}m` : null]
      .filter(Boolean)
      .join(" · ");
    const id = homeLookupElementId(row);
    return `<button type="button" class="home-search-row" data-home-search-id="${escapeHtml(String(id ?? ""))}" data-home-search-code="${escapeHtml(String(row.code ?? ""))}">
      ${badge}
      <span class="home-search-row-text">
        <span class="home-search-row-name">${escapeHtml(row.name || "—")}</span>
        <span class="home-search-row-meta">${escapeHtml(meta)}</span>
      </span>
    </button>`;
  }

  function homeSearchFilteredRows(query) {
    const q = String(query || "").trim().toLowerCase();
    const catalog = homeSearchCatalog();
    if (!q) return homeSearchSortRows(catalog).slice(0, 40);
    const scored = [];
    for (const row of catalog) {
      const name = String(row.name || "").toLowerCase();
      const team = String(row.team || "").toLowerCase();
      const teamFull = String(teamNameForSeason(row.team) || "").toLowerCase();
      if (!name.includes(q) && !team.includes(q) && !teamFull.includes(q)) continue;
      const starts = name.startsWith(q) ? 0 : 1;
      scored.push({ row, starts, name });
    }
    scored.sort((a, b) =>
      a.starts - b.starts
      || homeSearchGwCompare(a.row, b.row)
      || a.name.localeCompare(b.name)
    );
    return scored.slice(0, 60).map((x) => x.row);
  }

  function homeSearchSheetHTML(query = "") {
    const rows = homeSearchFilteredRows(query);
    const list = rows.length
      ? rows.map(homeSearchResultRowHTML).join("")
      : `<div class="home-search-empty">No players match “${escapeHtml(query)}”.</div>`;
    return `<div class="home-search-sheet">
      <div class="home-search-input-wrap">
        <input id="home-search-input" class="home-search-input" type="search" enterkeyhint="search"
          placeholder="Search players" value="${escapeHtml(query)}" autocomplete="off" />
      </div>
      <div class="home-search-results" id="home-search-results">${list}</div>
    </div>`;
  }

  function bindHomeSearchSheetEvents() {
    const input = document.getElementById("home-search-input");
    const results = document.getElementById("home-search-results");
    if (input) {
      input.addEventListener("input", () => {
        if (!results) return;
        const rows = homeSearchFilteredRows(input.value);
        results.innerHTML = rows.length
          ? rows.map(homeSearchResultRowHTML).join("")
          : `<div class="home-search-empty">No players match “${escapeHtml(input.value)}”.</div>`;
      });
      requestAnimationFrame(() => {
        try { input.focus({ preventScroll: true }); } catch { input.focus(); }
      });
    }
    if (results) {
      results.addEventListener("click", (e) => {
        const btn = e.target.closest(".home-search-row");
        if (!btn || !results.contains(btn)) return;
        const code = Number(btn.getAttribute("data-home-search-code"));
        const id = Number(btn.getAttribute("data-home-search-id"));
        const row = homeSearchCatalog().find((r) =>
          (Number.isFinite(code) && Number(r.code) === code) ||
          (Number.isFinite(id) && homeLookupElementId(r) === id)
        );
        if (!row) return;
        setHomePlayerLookup(row);
        closeMobileSheet();
      });
    }
  }

  function openHomeSearchSheet() {
    openMobileSheet({
      title: "",
      html: homeSearchSheetHTML(""),
      key: "home-search",
    });
    bindHomeSearchSheetEvents();
  }

  function syncHomeSearchBtn() {
    if (!el.homeSearchBtn) return;
    const clearMode = !!homeLookupPlayer;
    const iconUse = el.homeSearchBtn.querySelector("use");
    if (iconUse) iconUse.setAttribute("href", clearMode ? "#i-x" : "#i-search");
    const label = clearMode ? "Clear player search" : "Search players";
    el.homeSearchBtn.title = label;
    el.homeSearchBtn.setAttribute("aria-label", label);
    el.homeSearchBtn.classList.toggle("is-clear", clearMode);
    el.homeSearchBtn.setAttribute("aria-pressed", clearMode ? "true" : "false");
    el.homeSearchBtn.classList.toggle("on", clearMode);
  }

  function clearHomePlayerLookup({ rerender = true } = {}) {
    homeLookupPlayer = null;
    if (homeOwnerPin && homeOwnerPin.type === "element") {
      homeOwnerPin = null;
    }
    syncHomeSearchBtn();
    if (rerender) syncHomeLookupUI();
  }

  function setHomePlayerLookup(row) {
    if (!row) {
      clearHomePlayerLookup();
      return;
    }
    homeLookupPlayer = row;
    syncHomeSearchBtn();
    syncHomeLookupUI();
  }

  function syncHomeLookupUI() {
    if (!el.homeBento) return;
    const active = !!homeLookupPlayer;
    el.homeBento.classList.toggle("is-player-lookup", active);

    if (!active) {
      el.homeBento.classList.remove("has-lookup-owners");
      if (el.homePlayerProfile) {
        el.homePlayerProfile.hidden = true;
        el.homePlayerProfile.innerHTML = "";
      }
      if (el.homePlayerMatchup) {
        el.homePlayerMatchup.hidden = true;
        el.homePlayerMatchup.innerHTML = "";
      }
      if (el.homeSquadPanel) el.homeSquadPanel.hidden = false;
      if (el.homeStandingsPanel) el.homeStandingsPanel.hidden = false;
      syncHomeOwnerHighlights();
      return;
    }

    const elementId = homeLookupElementId(homeLookupPlayer);
    const hasOwners = homeLeagueOwnsElement(elementId);
    el.homeBento.classList.toggle("has-lookup-owners", hasOwners);

    let ownershipNote = "";
    if (Number.isFinite(elementId) && !hasOwners) {
      const leagueLabel = HOME.leagueName || "this league";
      ownershipNote = `No managers in ${leagueLabel} own this player.`;
    }

    if (el.homePlayerProfile) {
      el.homePlayerProfile.hidden = false;
      el.homePlayerProfile.innerHTML = homePlayerProfileHTML(homeLookupPlayer, { ownershipNote });
      el.homePlayerProfile.querySelectorAll("img.home-lookup-photo").forEach((img) => {
        img.addEventListener("error", () => {
          const fallback = document.createElement("span");
          fallback.className = "home-lookup-photo home-lookup-photo-fallback";
          fallback.setAttribute("aria-hidden", "true");
          fallback.textContent = img.getAttribute("data-initials") || "?";
          img.replaceWith(fallback);
        }, { once: true });
      });
    }
    if (el.homeSquadPanel) el.homeSquadPanel.hidden = true;
    if (el.homeStandingsPanel) el.homeStandingsPanel.hidden = !hasOwners;

    if (hasOwners && Number.isFinite(elementId)) {
      homeOwnerPin = { type: "element", id: elementId };
    } else {
      if (homeOwnerPin && homeOwnerPin.type === "element") homeOwnerPin = null;
    }
    syncHomeOwnerHighlights();

    if (el.homePlayerMatchup) {
      el.homePlayerMatchup.hidden = false;
      el.homePlayerMatchup.innerHTML = homePlayerMatchupHTML(homeLookupPlayer.team);
      upgradeNativeTitles(el.homePlayerMatchup);
    }
  }

  function renderHome() {
    if (!el.homePage) return;
    const linked = !!(savedManagerId && savedLeagueId);
    const hasPayload = !!(HOME && HOME.summary && HOME.managerId && HOME.leagueId);
    const prefsMatch =
      hasPayload
      && String(HOME.leagueId) === HOME_LEAGUE_ID
      && TRACKED_MANAGER_IDS.map(String).includes(String(savedManagerId));
    const showEmpty = !linked || !hasPayload;

    if (el.homeEmpty) el.homeEmpty.hidden = !showEmpty;
    if (el.homeBento) el.homeBento.hidden = showEmpty;
    if (showEmpty && el.homeEmptyTitle && el.homeEmptyCopy) {
      if (!linked) {
        el.homeEmptyTitle.textContent = "Pick a manager";
        el.homeEmptyCopy.textContent =
          "Choose one of the four SoCal Big Guy managers in Preferences for live Home data.";
      } else {
        el.homeEmptyTitle.textContent = "Home cache not loaded";
        el.homeEmptyCopy.textContent =
          "Manager and league are linked. Run refresh home (or refresh data) to build the dashboard cache.";
      }
    }
    if (el.homeCountLabel) syncHomeCountLabel();
    if (el.homePageSubtitle) {
      if (!linked) {
        el.homePageSubtitle.textContent = "Link a manager and league in Preferences to personalize Home.";
      } else if (!prefsMatch && hasPayload) {
        el.homePageSubtitle.textContent = "Cached Home data is for a different manager/league — run refresh home.";
      } else {
        const viewEntry = homeActiveViewEntryId();
        const viewingOther = homeIsViewingOtherManager();
        const s = viewingOther
          ? homeSummaryForView(viewEntry)
          : (HOME.summary || {});
        const bits = [s.teamName, s.managerName].filter(Boolean);
        el.homePageSubtitle.textContent = bits.length
          ? viewingOther
            ? `${bits.join(" · ")} — viewing another manager's team.`
            : `${bits.join(" · ")} — live GW scoring from the last refresh.`
          : "Your manager squad and mini-league gameweek standings from the last refresh.";
      }
    }
    if (showEmpty) {
      if (el.homeDeadline) el.homeDeadline.hidden = true;
      if (el.homeViewBanner) el.homeViewBanner.hidden = true;
      return;
    }

    const viewEntry = homeActiveViewEntryId();
    const viewingOther = homeIsViewingOtherManager();
    const summary = homeSummaryForView(viewEntry);
    if (el.homeDeadline) {
      const label = homeNextDeadlineLabel();
      el.homeDeadline.textContent = label;
      el.homeDeadline.hidden = !label;
    }
    if (el.homeGwHeading) {
      el.homeGwHeading.textContent =
        HOME.gw != null ? `GW ${HOME.gw} points` : "GW points";
    }
    if (el.homeGwPoints) el.homeGwPoints.textContent = String(summary.gwPoints ?? "—");
    if (el.homeOverallRankNum) {
      el.homeOverallRankNum.textContent = formatHomeRank(summary.overallRank);
    } else if (el.homeOverallRank) {
      el.homeOverallRank.textContent = formatHomeRank(summary.overallRank);
    }
    setHomeRankDelta(
      el.homeOverallRankDelta,
      viewingOther ? null : homeRankDeltaPlaces(summary.overallRank, summary.overallRankPrev)
    );
    setHomeOverallPct(
      el.homeOverallPct,
      viewingOther ? null : summary.overallRank,
      viewingOther ? null : summary.totalPlayers
    );
    if (el.homeTotalPoints) el.homeTotalPoints.textContent = formatHomeRank(summary.overallPoints);
    if (el.homeLeagueRankNum) {
      el.homeLeagueRankNum.textContent = formatHomeRank(summary.leagueRank);
    } else if (el.homeLeagueRank) {
      el.homeLeagueRank.textContent = formatHomeRank(summary.leagueRank);
    }
    setHomeRankDelta(
      el.homeLeagueRankDelta,
      viewingOther ? null : homeRankDeltaPlaces(summary.leagueRank, summary.leagueRankPrev)
    );
    if (el.homeGwMeta) {
      const chip = summary.activeChip ? String(summary.activeChip) : "";
      el.homeGwMeta.innerHTML = chip
        ? `<span class="home-chip">${escapeHtml(chip)}</span>`
        : "";
    }
    if (el.homeSquadGwLabel) {
      el.homeSquadGwLabel.textContent = HOME.gw != null ? `Gameweek ${HOME.gw}` : "";
    }
    if (el.homeLeagueTitle) {
      el.homeLeagueTitle.textContent = HOME.leagueName || "";
    }
    if (el.homeSquadBody) {
      const rows = homeSquadForEntry(viewEntry);
      const maxAbsImp = Math.max(
        1,
        ...rows.map((r) => {
          const v = r.imp != null ? Number(r.imp) : Number(r.impMock) || 0;
          return Number.isFinite(v) ? Math.abs(v) : 0;
        })
      );
      const parts = [];
      let benchLabeled = false;
      for (const r of rows) {
        if (r.onBench && !benchLabeled) {
          parts.push(
            `<tr class="home-bench-divider"><th scope="rowgroup" colspan="5">Bench</th></tr>`
          );
          benchLabeled = true;
        }
        parts.push(homeSquadRowHTML(r, maxAbsImp));
      }
      el.homeSquadBody.innerHTML = parts.join("") ||
        `<tr><td colspan="5">No squad picks in cache.</td></tr>`;
    }
    if (el.homeStandingsBody) {
      const configuredEntry = homeConfiguredEntryId();
      const rows = Array.isArray(HOME.standings) ? HOME.standings : [];
      el.homeStandingsBody.innerHTML = rows.map((r) => {
        const entry = Number(r.entry);
        const isConfigured = Number.isFinite(configuredEntry) && entry === configuredEntry;
        const isViewActive = Number.isFinite(viewEntry) && entry === viewEntry;
        const rowCls = [
          isConfigured && !viewingOther ? "is-you" : "",
          viewingOther && isViewActive ? "is-view-active" : "",
          viewingOther && isConfigured ? "is-configured-manager" : "",
        ].filter(Boolean).join(" ");
        const inPlay = Number(r.inPlay);
        const toPlay = Number(r.toPlay);
        const playTitle = "In play · still to play (active picks; Bench Boost can exceed 11)";
        const playHTML = (Number.isFinite(inPlay) && Number.isFinite(toPlay))
          ? `<span class="home-play-counts" title="${escapeHtml(playTitle)}"><span class="home-play-live${inPlay > 0 ? " is-active" : ""}">${escapeHtml(String(inPlay))}</span><span class="home-play-sep">·</span><span class="home-play-left${toPlay > 0 ? " is-active" : ""}">${escapeHtml(String(toPlay))}</span></span>`
          : "—";
        const labelName = r.playerName || r.entryName || "this manager";
        return `<tr class="${rowCls}" data-entry="${escapeHtml(String(r.entry ?? ""))}" role="button" tabindex="0" aria-label="View ${escapeHtml(labelName)} team">
          <td class="home-col-rank">${escapeHtml(String(r.rankLive ?? r.rankOfficial ?? "—"))}</td>
          <td class="home-col-manager">
            <span class="home-standings-name">${escapeHtml(r.playerName || "—")}</span>
            <span class="home-standings-entry">${escapeHtml(r.entryName || "")}</span>
          </td>
          <td class="home-col-play">${playHTML}</td>
          <td class="home-col-gw">${escapeHtml(String(r.gwPointsLive ?? "—"))}</td>
          <td class="home-col-total">${escapeHtml(String(r.total ?? "—"))}</td>
        </tr>`;
      }).join("") || `<tr><td colspan="5">No standings.</td></tr>`;
    }
    bindHomeOwnerHighlighting();
    syncHomeViewBanner();
    syncHomeOwnerHighlights();
    syncHomeLookupUI();
  }

  async function applyManagerId(rawId, { quiet = false, render = true, seedPlannerIfEmpty = true } = {}) {
    const id = String(rawId || "").trim();
    if (!id) {
      clearManagerId({ quiet, render });
      return false;
    }
    if (!/^\d+$/.test(id) || Number(id) <= 0) {
      if (!quiet) {
        showToast({ title: "Invalid manager", message: "Pick a manager from the list.", icon: "triangle-alert" });
      }
      return false;
    }
    if (!trackedManagerById(id)) {
      if (!quiet) {
        showToast({
          title: "Unknown manager",
          message: "That ID isn’t in the tracked list. Refresh leagues data.",
          icon: "triangle-alert",
        });
      }
      return false;
    }
    savedManagerId = id;
    try {
      localStorage.setItem(FPL_ID_KEY, id);
    } catch {
      /* private browsing */
    }
    persistHomePrefs();
    if (el.fplManagerSelect && el.fplManagerSelect.value !== id) {
      el.fplManagerSelect.value = id;
    }
    rebuildLeagueSelect();
    try {
      await syncManagerFromApi(id, { seedPlannerIfEmpty, quiet });
    } catch (err) {
      ownedCodes = new Set();
      syncFplIdStatus();
      if (!quiet) {
        showToast({
          title: "Could not sync FPL team",
          message: err && err.message ? err.message : "Check the connection and try again.",
          icon: "triangle-alert",
        });
      }
      if (render) scheduleSiteRefreshForHomeTargets({ toast: false });
      return false;
    }
    if (render) scheduleSiteRefreshForHomeTargets({ toast: !quiet });
    return true;
  }

  function clearManagerId({ quiet = false, render = true } = {}) {
    savedManagerId = null;
    savedLeagueId = null;
    ownedCodes = new Set();
    state.actualMeta = null;
    try {
      localStorage.removeItem(FPL_ID_KEY);
      localStorage.removeItem(FPL_LEAGUE_KEY);
      localStorage.removeItem(TEAM_ACTUAL_KEY);
    } catch {
      /* private browsing */
    }
    persistHomePrefs();
    if (el.fplManagerSelect) el.fplManagerSelect.value = "";
    rebuildLeagueSelect();
    if (state.teamMode === "actual") {
      applySquadSnapshot({ squad: [], captain: null, vice: null });
    }
    syncFplIdStatus();
    syncTeamModeUI();
    if (!quiet) {
      showToast({ title: "FPL link cleared", message: "Actual team link removed. Planner draft is unchanged.", icon: "info" });
    }
    if (render) scheduleSiteRefreshForHomeTargets({ toast: !quiet });
  }

  async function restoreManagerId() {
    let saved = "";
    let savedLeague = "";
    let mode = "actual";
    try {
      saved = localStorage.getItem(FPL_ID_KEY) || "";
      savedLeague = localStorage.getItem(FPL_LEAGUE_KEY) || "";
      // Default Actual; only stay on Planner when explicitly stored.
      mode = localStorage.getItem(TEAM_MODE_KEY) === "planner" ? "planner" : "actual";
    } catch {
      saved = "";
      savedLeague = "";
      mode = "actual";
    }
    const actual = loadActualSnapshot();
    if (actual) {
      state.actualMeta = actual.meta || null;
      ownedCodes = new Set(actual.squad.map((s) => s.code));
    }
    populateManagerSelect();
    syncFixedHomeLeague({ persist: true, quiet: true });
    if (saved && trackedManagerById(saved)) {
      savedManagerId = saved;
      if (el.fplManagerSelect) el.fplManagerSelect.value = saved;
      rebuildLeagueSelect();
      state.teamMode = "planner";
      loadTeamDraft();
      try {
        await syncManagerFromApi(saved, { seedPlannerIfEmpty: true, quiet: true });
      } catch {
        syncFplIdStatus();
      }
    } else {
      if (saved && !trackedManagerById(saved)) {
        // Migrated free-text ID no longer in tracked list — leave unlinked.
        try {
          localStorage.removeItem(FPL_ID_KEY);
          localStorage.removeItem(FPL_LEAGUE_KEY);
        } catch {
          /* private browsing */
        }
      }
      savedManagerId = null;
      savedLeagueId = null;
      rebuildLeagueSelect();
      state.teamMode = "planner";
      loadTeamDraft();
      syncFplIdStatus();
    }
    setTeamMode(mode, { render: false, persist: false });
    persistHomePrefs();
    refreshManagerDependentUI();
  }

  function requestResyncPlanner(fromBtn) {
    if (!savedManagerId) {
      showToast({ title: "No manager linked", message: "Pick a manager in Preferences first.", icon: "triangle-alert" });
      return;
    }
    if (state.teamMode !== "planner") {
      showToast({ title: "Switch to Planner", message: "Resync copies Actual into the Planner draft.", icon: "info" });
      return;
    }
    const btn = fromBtn || el.teamResyncToolbar || el.teamResyncBtn;
    armConfirmButton(btn, {
      onConfirm: async () => {
        setPrefsOpen(false);
        try {
          const payload = await fetchManagerSquad(savedManagerId);
          const snap = await ingestManagerSquad(payload, { seedPlannerIfEmpty: false });
          state.teamMode = "planner";
          try {
            localStorage.setItem(TEAM_MODE_KEY, "planner");
          } catch {
            /* private browsing */
          }
          applySquadSnapshot(snap);
          saveTeamDraft();
          syncTeamModeUI();
          renderTeam();
          showToast({
            title: "Planner resynced",
            message: payload.hasPicks
              ? `Copied ${payload.squad.length} picks from Actual.`
              : payload.message || "Actual had no published picks — planner cleared.",
            icon: "circle-check",
          });
        } catch (err) {
          showToast({
            title: "Resync failed",
            message: err && err.message ? err.message : "Could not reach the FPL proxy.",
            icon: "triangle-alert",
          });
        }
      },
    });
  }

  function isOwnedRow(row) {
    return state.view === "players" && row && row.code != null && ownedCodes.has(row.code);
  }

  function ownedFlagHTML(row) {
    if (!isOwnedRow(row)) return "";
    return `<span class="owned-flag"${tipAttr("In your squad")} aria-label="In your squad">${ownedPinSVG()}</span>`;
  }

  function playerNameHTML(row) {
    const icons = ownedFlagHTML(row);
    const name = String(row.name || "");
    const prefix = name.slice(0, 4);
    const rest = name.slice(4);
    return `<div class="player-name-line"><span class="player-name"><span class="player-name-prefix">${escapeHtml(prefix)}</span><span class="player-name-rest">${escapeHtml(rest)}</span></span><span class="player-name-icons">${icons}</span></div>`;
  }

  function playerCrestHTML(teamCode, tip) {
    const inner = badgeHTML(teamCode, "player-cell-badge");
    if (!inner) return "";
    return tip
      ? `<span class="player-cell-crest"${tip}>${inner}</span>`
      : `<span class="player-cell-crest">${inner}</span>`;
  }

  /** Flat identity: crest | name / sub — no copy wrapper (keeps crest column tight). */
  function playerIdentityHTML(crestHTML, nameHTML, subHTML) {
    return `<div class="player-cell">${crestHTML || ""}${nameHTML}${subHTML || ""}</div>`;
  }

  function posBadgeHTML(position, opts) {
    const raw = String(position || "").toUpperCase();
    const pos = raw === "GKP" ? "GK" : raw;
    if (!/^(GK|DEF|MID|FWD)$/.test(pos)) return "";
    const label = (opts && opts.label) || pos;
    const attrs = (opts && opts.attrs) || "";
    return `<span class="pos-badge pos-${pos}"${attrs}>${escapeHtml(label)}</span>`;
  }

  function isNumericCol(col) {
    return (
      col.type !== "pos" &&
      col.type !== "name" &&
      col.type !== "team" &&
      col.type !== "check" &&
      col.type !== "player"
    );
  }

  // Intensity 1 = first in the highlighted band, 0 = last (melts into the row).
  // Ease-in keeps colour on true leaders; the tail of the band is near-invisible.
  function rankBandIntensity(i, n) {
    if (n <= 1) return 1;
    return Math.pow(1 - i / (n - 1), 1.55);
  }

  // Value gap within the highlighted band: best → 1, edge of band → 0.
  // A runaway leader saturates harder than a tight pack at the same ranks.
  // `best`/`worst` are the slice endpoints after best-first sort (works for
  // both higher-better and lower-better columns).
  function valueBandIntensity(val, best, worst) {
    const span = best - worst;
    if (Math.abs(span) < 1e-12) return 1;
    const t = (val - worst) / span;
    return Math.pow(Math.min(1, Math.max(0, t)), 0.85);
  }

  // Mix rank position with value gap so order stays readable but big leads punch.
  // Relative (filtered) mode leans harder on value so standouts in a small cohort
  // read clearly even when ranks are only a few slots apart.
  const ENHANCE_RANK_WEIGHT = 0.4;
  const ENHANCE_VALUE_WEIGHT = 0.6;
  const ENHANCE_RELATIVE_RANK_WEIGHT = 0.25;
  const ENHANCE_RELATIVE_VALUE_WEIGHT = 0.75;

  function enhanceBandIntensity(i, n, val, best, worst) {
    const rankI = rankBandIntensity(i, n);
    const valueI = valueBandIntensity(val, best, worst);
    if (state.enhanceRelative) {
      return ENHANCE_RELATIVE_RANK_WEIGHT * rankI + ENHANCE_RELATIVE_VALUE_WEIGHT * valueI;
    }
    return ENHANCE_RANK_WEIGHT * rankI + ENHANCE_VALUE_WEIGHT * valueI;
  }

  function intensitiesForBand(slice) {
    if (!slice.length) return new Map();
    const best = slice[0].val;
    const worst = slice[slice.length - 1].val;
    return new Map(
      slice.map((x, i) => [x.key, enhanceBandIntensity(i, slice.length, x.val, best, worst)])
    );
  }

  function effectiveEnhancePct() {
    if (!state.enhanceRelative) return state.enhancePct;
    return Math.min(ENHANCE_PCT_MAX, Math.max(state.enhancePct, ENHANCE_RELATIVE_FLOOR));
  }

  // Builds { colKey: { top: Map(rowKey -> intensity), bottom: Map(...) } }
  // for the columns visible in the current view. Default bands use the full
  // player/team population; Relative mode passes the filtered rows and a
  // boosted topN so small cohorts still get a readable highlight band.
  // Players rank only the best values (green). Teams — a much smaller
  // population — rank both the best and worst (green "target" / red "avoid"),
  // with the bottom set drawn only from values outside the top set so the
  // two never overlap. Zero-valued cells are excluded from ranking (they're
  // always visually demoted instead). Intensity blends rank order with value
  // gap inside the band so large leads read stronger than a tight pack.
  function buildHighlightMaps(rows) {
    const maps = {};
    const isTeams = state.view === "teams";
    const pct = effectiveEnhancePct();
    const topN = Math.max(1, Math.round((rows.length * pct) / 100));
    visibleColumns().forEach((col) => {
      if (!isNumericCol(col) || ENHANCE_EXCLUDE.has(col.key)) return;
      const lowerBetter = LOWER_BETTER.has(col.key);
      const withVals = rows
        .filter((r) => isStatAvailable(r, col))
        .map((r) => ({ key: rowKey(r), val: displayValue(r, col) || 0 }))
        .filter((x) => Math.abs(x.val) > 1e-9);
      if (withVals.length < 2) return;
      const minV = Math.min(...withVals.map((x) => x.val));
      const maxV = Math.max(...withVals.map((x) => x.val));
      if (maxV === minV) return; // no variance, nothing meaningful to rank

      // Rank individual rows, not distinct values — a value shared by 5
      // players fills 5 rank slots, not one, so ties don't compress the
      // effective top-N down to fewer highlighted rows than intended.
      withVals.sort((a, b) => (lowerBetter ? a.val - b.val : b.val - a.val));

      const topSlice = withVals.slice(0, Math.min(topN, withVals.length));
      const top = intensitiesForBand(topSlice);

      const bottom = new Map();
      if (isTeams) {
        const remaining = withVals.slice(topSlice.length);
        const bottomSlice = remaining.slice(-Math.min(topN, remaining.length)).reverse();
        intensitiesForBand(bottomSlice).forEach((intensity, key) => bottom.set(key, intensity));
      }

      maps[col.key] = { top, bottom };
    });
    return maps;
  }

  // Price and TSB% are excluded from the top/bottom% Enhance system (levels,
  // not rate stats — tinting “most expensive/owned” isn’t useful).

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function visibleColumns() {
    if (state.page === "opta") return cols();
    return cols().filter((c) => c.pin || !state.hiddenCols.has(c.key));
  }

  function fmtNum(v, decimals) {
    if (v === undefined || v === null || Number.isNaN(v)) return "–";
    const n = Number(v);
    const abs = Math.abs(n);
    if (abs >= 1000) {
      const signed = n < 0 ? "-" : "";
      return `${signed}${(abs / 1000).toFixed(1)}k`;
    }
    if (decimals === 0) return String(Math.round(n));
    return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  // Whether column i starts a new section group (e.g. "Goal Threat" ->
  // "Creativity") — used to draw a subtle vertical divider at that boundary
  // in both header rows and every body row, so the section groupings read
  // as columns even once you're deep in a long scrolled table.
  function isSectionBoundary(vcols, i) {
    if (i === 0) return false;
    return (vcols[i].section || null) !== (vcols[i - 1].section || null);
  }

  function buildSectionRow(vcols) {
    const tr = document.createElement("tr");
    tr.className = "section-row";
    // Sticky opaque filler above the frozen name column so scrolling
    // section labels (e.g. Goal Threat) never show through.
    let i = 0;
    if (vcols.length && vcols[0].pin) {
      const lead = document.createElement("th");
      lead.className = "sec-sticky-lead";
      tr.appendChild(lead);
      i = 1;
    }
    while (i < vcols.length) {
      const section = vcols[i].section || null;
      let span = 1;
      while (i + span < vcols.length && (vcols[i + span].section || null) === section) span++;
      const th = document.createElement("th");
      th.colSpan = span;
      th.textContent = section || "";
      if (i > 0) th.classList.add("sec-divider");
      tr.appendChild(th);
      i += span;
    }
    return tr;
  }

  // Caveat only while a set-piece column has no absolute #1 in the data.
  const COLUMN_CAVEATS = {
    cornersOrder:
      "Some clubs still have no FPL #1 corner taker listed — only published #1/#2 show.",
  };

  function columnCaveat(col) {
    const note = COLUMN_CAVEATS[col.key];
    if (!note) return null;
    return DATA.players.combined.some((p) => p[col.key] === 1) ? null : note;
  }

  function buildColumnHeaderRow(vcols) {
    const tr = document.createElement("tr");
    vcols.forEach((c, i) => {
      const th = document.createElement("th");
      th.textContent = c.label;
      const caveat = columnCaveat(c);
      setTip(th, caveat ? `${c.title || c.label} — ${caveat}` : c.title || c.label);
      if (caveat) {
        const star = document.createElement("span");
        star.className = "col-caveat";
        star.textContent = "*";
        th.appendChild(star);
      }
      th.classList.add("col-" + (c.type || "num"));
      if (CORE_COL_KEYS.has(c.key)) th.classList.add("col-core");
      if (isSectionBoundary(vcols, i)) th.classList.add("sec-divider");
      if (state.sortKey === c.key) {
        th.classList.add("sorted");
        const arrow = document.createElement("span");
        arrow.className = "arrow";
        arrow.innerHTML = iconHTML(state.sortDir === "asc" ? "chevron-up" : "chevron-down");
        th.appendChild(arrow);
      }
      th.addEventListener("click", () => {
        if (state.sortKey === c.key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = c.key;
          state.sortDir = c.type && c.type !== "check" ? "asc" : "desc";
        }
        renderTable({ preserveOptaScroll: true });
      });
      tr.appendChild(th);
    });
    return tr;
  }

  function renderHead() {
    const vcols = visibleColumns();
    el.tableHead.innerHTML = "";
    el.tableHead.appendChild(buildSectionRow(vcols));
    el.tableHead.appendChild(buildColumnHeaderRow(vcols));
  }

  function cellHTML(row, col) {
    if (col.key === "player") {
      const teamCode = updatesOverlayOn() && row.newTeam ? row.newTeam : row.team;
      const position = updatesOverlayOn() && row.newPosition ? row.newPosition : row.position;
      const teamChanged = updatesOverlayOn() && row.newTeam && row.newTeam !== row.team;
      const posChanged = updatesOverlayOn() && row.newPosition && row.newPosition !== row.position;
      const crest = playerCrestHTML(
        teamCode,
        teamChanged ? tipAttr(`Was ${TEAM_NAMES[row.team] || row.team}`) : ""
      );
      const posTip = posChanged ? tipAttr(`Was ${row.position}`) : "";
      const sub = `<div class="player-cell-sub">${posBadgeHTML(position, { attrs: posTip })}</div>`;
      return playerIdentityHTML(crest, playerNameHTML(row), sub);
    }
    if (col.key === "name") {
      const pos = LEAGUE_POSITIONS[row.team];
      const seasonLabel = LEAGUE_POSITIONS_META.seasonLabel || "Premier League";
      const posHTML = pos != null
        ? `<span class="team-league-pos"${tipAttr(`${pos}${ordinalSuffix(pos)} in the ${seasonLabel}`)}>${pos}${ordinalSuffix(pos)}</span>`
        : "";
      const name = `<div class="player-name-line"><span class="player-name">${escapeHtml(row.name)}</span>${posHTML}</div>`;
      return playerIdentityHTML(playerCrestHTML(row.team), name, "");
    }
    if (col.key === "price") {
      return fmtDisplayValue(displayValue(row, col), col);
    }
    if (col.key === "owned") {
      return fmtOwnedPct(currentOwnership(row.code));
    }
    if (col.type === "check") {
      const mark = setPieceDisplayRank(row, col.key);
      if (mark == null) return "";
      if (mark === 1) {
        return `<span class="check-mark"${tipAttr("1st choice")}><svg class="check-mark-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg></span>`;
      }
      return `<span class="check-mark check-mark-rank"${tipAttr(`${mark}${ordinalSuffix(mark)} choice`)}>${mark}</span>`;
    }
    if (!isStatApplicable(row, col)) {
      return `<span${tipAttr(notApplicableReason(row, col))}>–</span>`;
    }
    const unsupportedReason = sourceUnsupportedReason(row, col);
    if (unsupportedReason) return sourceUnsupportedHTML(unsupportedReason);
    const val = displayValue(row, col);
    const defconDot = col.key === "__cbitr" ? defconDotHTML(row) : "";
    const text = fmtDisplayValue(val, col);
    return defconDot ? `<span class="cell-inline align-end">${text}${defconDot}</span>` : text;
  }

  function ordinalSuffix(n) {
    const rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return "th";
    switch (n % 10) {
      case 1: return "st";
      case 2: return "nd";
      case 3: return "rd";
      default: return "th";
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // Desktop-like hover vs touch-first. Desktop UX stays on the fine path;
  // coarse remaps tips / rankings cross-highlight to taps.
  const FINE_HOVER_MQ = window.matchMedia("(hover: hover) and (pointer: fine)");
  const NARROW_MQ = window.matchMedia("(max-width: 720px)");

  function teamLandscapeViewport() {
    const vv = window.visualViewport;
    const w = vv ? vv.width : window.innerWidth;
    const h = vv ? vv.height : window.innerHeight;
    if (w <= h || h > 580) return false;
    return !hasFineHover() || w <= 1024;
  }

  function syncMobileLayoutClass() {
    document.documentElement.classList.toggle("is-mobile-layout", NARROW_MQ.matches);
  }
  syncMobileLayoutClass();
  function hasFineHover() {
    return FINE_HOVER_MQ.matches;
  }
  // Bottom sheet on touch-first devices, and on narrow viewports even when the
  // browser reports fine hover (common on phones / hybrid tablets).
  function preferMobileSheet() {
    return !hasFineHover() || NARROW_MQ.matches;
  }
  // Match the stacked-filter layout breakpoint: column toggles live in the
  // Filters tray/panel instead of a separate right rail + toolbar button.
  const COLUMNS_IN_FILTERS_MQ = window.matchMedia("(max-width: 900px)");
  function columnsLiveInFilters() {
    return preferMobileSheet() || COLUMNS_IN_FILTERS_MQ.matches;
  }

  const mobileFilterHomes = new Map();
  const mobileViewHomes = new Map();

  function syncMobileChromeFade() {
    const fade = el.mobileChromeFade;
    const show =
      preferMobileSheet() &&
      ((!el.mobileFilterDock || !el.mobileFilterDock.hidden) ||
        (!el.mobileViewDock || !el.mobileViewDock.hidden));
    if (fade) {
      fade.hidden = true;
      fade.setAttribute("aria-hidden", "true");
    }
    document.documentElement.classList.toggle("has-mobile-bottom-dock", show);
    if (!show) resetMobileChromeScrollHide();
    syncMobileScrollportHeight();
    scheduleOptaMobileNameColWidth();
  }

  function syncMobileScrollportHeight() {
    const root = document.documentElement;
    if (!NARROW_MQ.matches || (state.page !== "opta" && state.page !== "expected")) {
      root.style.removeProperty("--mobile-scrollport-min-h");
      return;
    }
    const scrollport =
      state.page === "opta"
        ? document.querySelector("#opta-page > .table-wrap")
        : document.querySelector("#expected-page .barbell-wrap");
    if (!scrollport || scrollport.offsetParent === null) {
      root.style.removeProperty("--mobile-scrollport-min-h");
      return;
    }
    const vv = window.visualViewport;
    const viewportBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const top = scrollport.getBoundingClientRect().top;
    const minH = Math.max(180, Math.floor(viewportBottom - top));
    root.style.setProperty("--mobile-scrollport-min-h", `${minH}px`);
  }

  let mobileChromeScrollLast = 0;
  let mobileChromeScrollTicking = false;
  let mobileChromeScrollHidden = false;

  function mobileChromeScrollActive() {
    if (state.page === "ownership") return false;
    return (
      preferMobileSheet() &&
      (document.documentElement.classList.contains("has-mobile-bottom-dock") ||
        document.documentElement.classList.contains("has-mobile-filter-fab") ||
        document.documentElement.classList.contains("has-mobile-view-dock"))
    );
  }

  function setMobileChromeScrollHidden(hidden) {
    if (mobileChromeScrollHidden === hidden) return;
    mobileChromeScrollHidden = hidden;
    document.documentElement.classList.toggle("mobile-chrome-scroll-hidden", hidden);
  }

  function resetMobileChromeScrollHide() {
    const main = document.querySelector("main.main");
    mobileChromeScrollLast = main ? main.scrollTop : 0;
    setMobileChromeScrollHidden(false);
  }

  function scrollPageContentToTop() {
    const main = document.querySelector("main.main");
    if (!main) return;
    main.scrollTop = 0;
    main.scrollLeft = 0;
  }

  function mobileChromeScrollSources() {
    const sources = [];
    const main = document.querySelector("main.main");
    if (main) sources.push(main);
    if (NARROW_MQ.matches) {
      if (state.page === "opta") {
        optaTableWraps().forEach((wrap) => {
          if (wrap && !sources.includes(wrap)) sources.push(wrap);
        });
      } else if (state.page === "team") {
        teamTableScrollWraps().forEach((wrap) => {
          if (wrap && !sources.includes(wrap)) sources.push(wrap);
        });
      } else if (state.page === "expected") {
        const barbell = expectedScrollWrap();
        if (barbell && !sources.includes(barbell)) sources.push(barbell);
      }
    }
    return sources;
  }

  function onMobileChromeScroll(source) {
    if (!mobileChromeScrollActive()) {
      resetMobileChromeScrollHide();
      return;
    }
    const node = source || document.querySelector("main.main");
    if (!node) return;
    const y = node.scrollTop;
    const dy = y - mobileChromeScrollLast;
    if (y <= 16) {
      setMobileChromeScrollHidden(false);
    } else if (dy > 10) {
      setMobileChromeScrollHidden(true);
    } else if (dy < -6) {
      setMobileChromeScrollHidden(false);
    }
    mobileChromeScrollLast = y;
  }

  function bindMobileChromeScrollHide() {
    mobileChromeScrollSources().forEach((node) => {
      if (!node || node.dataset.mobileChromeScroll === "1") return;
      node.dataset.mobileChromeScroll = "1";
      node.addEventListener(
        "scroll",
        () => {
          if (mobileChromeScrollTicking) return;
          mobileChromeScrollTicking = true;
          requestAnimationFrame(() => {
            mobileChromeScrollTicking = false;
            onMobileChromeScroll(node);
          });
        },
        { passive: true }
      );
    });
    const main = document.querySelector("main.main");
    mobileChromeScrollLast = main ? main.scrollTop : 0;
  }

  function rememberMobileFilterHome(btn) {
    if (!btn || mobileFilterHomes.has(btn)) return;
    mobileFilterHomes.set(btn, {
      parent: btn.parentElement,
      next: btn.nextElementSibling,
    });
  }

  function restoreMobileFilterHome(btn) {
    if (!btn) return;
    btn.classList.remove("mobile-filter-fab");
    const home = mobileFilterHomes.get(btn);
    if (!home || !home.parent || !document.contains(home.parent)) return;
    if (home.next && home.next.parentElement === home.parent) {
      home.parent.insertBefore(btn, home.next);
    } else {
      home.parent.appendChild(btn);
    }
  }

  function restoreAllMobileFilterButtons() {
    [
      el.sidebarToggle,
      el.marketsSlidersToggle,
      el.scheduleSlidersToggle,
      el.homeSearchBtn,
    ].forEach(restoreMobileFilterHome);
  }

  function mobileFilterButtonForPage() {
    const page = state.page;
    if (page === "home") return el.homeSearchBtn || null;
    if (page === "markets") return el.marketsSlidersToggle || null;
    if (page === "schedule") return el.scheduleSlidersToggle || null;
    if (page === "team" && !state.teamPickerSlot) return null;
    if (el.sidebar && el.sidebar.style.display === "none") return null;
    if (el.sidebarToggle && el.sidebarToggle.style.display === "none") return null;
    return el.sidebarToggle || null;
  }

  function mobileViewTabsEl() {
    return el.tabPlayers ? el.tabPlayers.closest(".tabs") : null;
  }

  function mobileViewTabsVisible() {
    const page = state.page;
    // Home has no Players/Teams split — keep the bottom dock clear.
    if (
      page === "home" ||
      page === "team" ||
      page === "markets" ||
      page === "schedule"
    ) {
      return false;
    }
    const tabs = mobileViewTabsEl();
    if (!tabs || tabs.style.display === "none") return false;
    return true;
  }

  function rememberMobileViewHome(tabs) {
    if (!tabs || mobileViewHomes.has(tabs)) return;
    mobileViewHomes.set(tabs, {
      parent: tabs.parentElement,
      next: tabs.nextElementSibling,
    });
  }

  function restoreMobileViewHome(tabs) {
    if (!tabs) return;
    tabs.classList.remove("mobile-view-tabs");
    const home = mobileViewHomes.get(tabs);
    if (!home || !home.parent || !document.contains(home.parent)) {
      if (el.statsToolbarStart) {
        if (el.sidebarToggle && el.sidebarToggle.parentElement === el.statsToolbarStart) {
          el.sidebarToggle.insertAdjacentElement("afterend", tabs);
        } else {
          el.statsToolbarStart.prepend(tabs);
        }
      }
      return;
    }
    if (home.next && home.next.parentElement === home.parent) {
      home.parent.insertBefore(tabs, home.next);
    } else {
      home.parent.appendChild(tabs);
    }
  }

  function syncMobileViewDock() {
    const dock = el.mobileViewDock;
    const tabs = mobileViewTabsEl();
    if (!dock || !tabs) return;
    if (!preferMobileSheet() || !mobileViewTabsVisible()) {
      restoreMobileViewHome(tabs);
      dock.hidden = true;
      dock.setAttribute("aria-hidden", "true");
      document.documentElement.classList.remove("has-mobile-view-dock");
      syncMobileChromeFade();
      return;
    }
    rememberMobileViewHome(tabs);
    if (tabs.parentElement !== dock) dock.appendChild(tabs);
    tabs.classList.add("mobile-view-tabs");
    dock.hidden = false;
    dock.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("has-mobile-view-dock");
    requestAnimationFrame(() => syncSegThumb(tabs, { animate: false }));
    syncMobileChromeFade();
  }

  function syncMobileFilterDock() {
    const dock = el.mobileFilterDock;
    const buttons = [
      el.sidebarToggle,
      el.marketsSlidersToggle,
      el.scheduleSlidersToggle,
      el.homeSearchBtn,
    ].filter(Boolean);
    if (!dock) return;
    if (!preferMobileSheet()) {
      restoreAllMobileFilterButtons();
      if (el.homeSearchBtn) el.homeSearchBtn.hidden = true;
      dock.hidden = true;
      dock.setAttribute("aria-hidden", "true");
      document.documentElement.classList.remove("has-mobile-filter-fab");
      syncMobileChromeFade();
      return;
    }
    const active = mobileFilterButtonForPage();
    buttons.forEach((btn) => {
      if (btn !== active) restoreMobileFilterHome(btn);
    });
    if (el.homeSearchBtn && active !== el.homeSearchBtn) el.homeSearchBtn.hidden = true;
    if (!active) {
      dock.hidden = true;
      dock.setAttribute("aria-hidden", "true");
      document.documentElement.classList.remove("has-mobile-filter-fab");
      syncMobileChromeFade();
      return;
    }
    rememberMobileFilterHome(active);
    if (active.parentElement !== dock) dock.appendChild(active);
    active.classList.add("mobile-filter-fab");
    if (active === el.homeSearchBtn) {
      active.hidden = false;
      syncHomeSearchBtn();
    }
    dock.hidden = false;
    dock.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("has-mobile-filter-fab");
    syncMobileChromeFade();
  }

  function syncMobileChrome() {
    syncMobileFilterDock();
    syncMobileViewDock();
    if (!mobileChromeScrollActive()) resetMobileChromeScrollHide();
    else {
      const main = document.querySelector("main.main");
      mobileChromeScrollLast = main ? main.scrollTop : 0;
    }
    requestAnimationFrame(() => syncMobileScrollportHeight());
  }

  // Horizontal tables/barbells are overflow-x scrollers on mobile; vertical
  // scroll lives on `.main`. Wheel on narrow viewports still chains vertically
  // (trackpad / mouse); touch uses CSS touch-action: pan-x on the inner scroller.
  function bindNestedTableScroll() {
    const main = document.querySelector("main.main");
    if (!main) return;

    function mainMax() {
      return Math.max(0, main.scrollHeight - main.clientHeight);
    }

    document.querySelectorAll(".table-wrap, .barbell-scroll").forEach((inner) => {
      if (inner.dataset.scrollChain === "1") return;
      inner.dataset.scrollChain = "1";

      inner.addEventListener("wheel", (e) => {
        if (!NARROW_MQ.matches) return;
        if (inner.scrollTop > 0) return;
        const max = mainMax();
        if (e.deltaY > 0 && main.scrollTop < max - 1) {
          main.scrollTop += e.deltaY;
          e.preventDefault();
        } else if (e.deltaY < 0 && main.scrollTop > 0) {
          main.scrollTop += e.deltaY;
          e.preventDefault();
        }
      }, { passive: false });
    });
  }

  function comparePanelVisible() {
    return state.compareMode && compareSet().size >= 2;
  }

  function teamComparePanelVisible() {
    return (
      !!state.teamPickerSlot &&
      state.teamCompareMode &&
      state.teamCompareCodes.length >= 1
    );
  }

  let compareScrollSuppress = null;
  let compareScrollRaf = 0;
  let compareScrollPending = null;

  function clearCompareMirror(wrap) {
    const table = wrap && wrap.querySelector(":scope > table");
    if (table) table.style.removeProperty("transform");
  }

  function clearAllCompareMirrors() {
    document
      .querySelectorAll(".compare-table-wrap, #team-compare-wrap .team-table-wrap")
      .forEach(clearCompareMirror);
  }

  function applyCompareScrollFrom(source, target) {
    if (!source || !target) return;
    const left = source.scrollLeft;
    clearCompareMirror(target);
    if (Math.abs(target.scrollLeft - left) > 0.5) {
      compareScrollSuppress = target;
      target.scrollLeft = left;
      requestAnimationFrame(() => {
        if (compareScrollSuppress === target) compareScrollSuppress = null;
      });
    }
    if (nameSimplifyActive()) {
      updateNameColumnSimplify(source, left);
      updateNameColumnSimplify(target, left);
    }
  }

  function scheduleCompareScrollSync(source, target) {
    if (source === compareScrollSuppress) return;
    compareScrollPending = { source, target };
    if (compareScrollRaf) return;
    compareScrollRaf = requestAnimationFrame(() => {
      compareScrollRaf = 0;
      const job = compareScrollPending;
      compareScrollPending = null;
      if (!job) return;
      applyCompareScrollFrom(job.source, job.target);
    });
  }

  function bindCompareTouchScroll(mirrorWrap, scrollWrap) {
    if (!mirrorWrap || mirrorWrap.dataset.compareTouchBound === "1") return;
    mirrorWrap.dataset.compareTouchBound = "1";
    let startX = 0;
    let startScroll = 0;
    mirrorWrap.addEventListener(
      "touchstart",
      (e) => {
        if (!NARROW_MQ.matches || e.touches.length !== 1) return;
        startX = e.touches[0].clientX;
        startScroll = scrollWrap.scrollLeft;
      },
      { passive: true }
    );
    mirrorWrap.addEventListener(
      "touchmove",
      (e) => {
        if (!NARROW_MQ.matches || e.touches.length !== 1) return;
        scrollWrap.scrollLeft = startScroll + (startX - e.touches[0].clientX);
      },
      { passive: true }
    );
  }

  function attachCompareScrollPair(a, b) {
    if (!a || !b || a.dataset.compareScrollBound === "1") return;
    a.dataset.compareScrollBound = "1";
    b.dataset.compareScrollBound = "1";
    a.addEventListener("scroll", () => scheduleCompareScrollSync(a, b), { passive: true });
    b.addEventListener("scroll", () => scheduleCompareScrollSync(b, a), { passive: true });
    bindCompareTouchScroll(b, a);
    applyCompareScrollFrom(a, b);
  }

  function refreshCompareScrollMirrorMode() {
    clearAllCompareMirrors();
    if (comparePanelVisible() && state.page === "opta") {
      const main = el.tableBody && el.tableBody.closest(".table-wrap");
      const compare = el.compareWrap && el.compareWrap.querySelector(".compare-table-wrap");
      if (main && compare) applyCompareScrollFrom(main, compare);
    }
    if (teamComparePanelVisible()) {
      const picker =
        el.teamPickerView && el.teamPickerView.querySelector(".team-picker-table-wrap");
      const teamCompare =
        el.teamCompareWrap && el.teamCompareWrap.querySelector(".team-table-wrap");
      if (picker && teamCompare) applyCompareScrollFrom(picker, teamCompare);
    }
  }

  function bindCompareScrollSync() {
    if (comparePanelVisible() && state.page === "opta") {
      const main = el.tableBody && el.tableBody.closest(".table-wrap");
      const compare = el.compareWrap && el.compareWrap.querySelector(".compare-table-wrap");
      if (main && compare) attachCompareScrollPair(main, compare);
    }
    if (teamComparePanelVisible()) {
      const picker =
        el.teamPickerView && el.teamPickerView.querySelector(".team-picker-table-wrap");
      const teamCompare =
        el.teamCompareWrap && el.teamCompareWrap.querySelector(".team-table-wrap");
      if (picker && teamCompare) attachCompareScrollPair(picker, teamCompare);
    }
  }

  // Team picker table: scroll-linked Player name morph (full ↔ compact).
  // Dead zone after the default (Price/GW) origin so the landing view stays full.
  const NAME_SIMPLIFY_START = 24;
  const NAME_SIMPLIFY_END = 140;
  const nameSimplifyRafs = new WeakMap();

  function nameSimplifyWraps() {
    const wraps = [];
    if (state.page === "opta") {
      const main = el.tableBody && el.tableBody.closest(".table-wrap");
      if (main) wraps.push(main);
      const compare = el.compareWrap && el.compareWrap.querySelector(".compare-table-wrap");
      if (compare) wraps.push(compare);
    }
    if (state.page === "team" && state.teamPickerSlot) {
      const picker =
        el.teamPickerView && el.teamPickerView.querySelector(".team-picker-table-wrap");
      if (picker) wraps.push(picker);
      const teamCompare =
        el.teamCompareWrap &&
        !el.teamCompareWrap.hidden &&
        el.teamCompareWrap.querySelector(".team-table-wrap");
      if (teamCompare) wraps.push(teamCompare);
    }
    return wraps;
  }

  function nameSimplifyActive() {
    if (NARROW_MQ.matches || !hasFineHover()) {
      if (state.page === "team" && state.teamPickerSlot) return true;
    }
    return false;
  }

  let optaMobileNameColW = null;
  let optaMobileNameColRaf = 0;

  function syncOptaMobileNameColWidth() {
    const wraps = optaTableWraps();
    if (!NARROW_MQ.matches || state.page !== "opta") {
      optaMobileNameColW = null;
      wraps.forEach((wrap) => wrap.style.removeProperty("--name-col-w"));
      return;
    }
    const compareBtn = el.compareToggle;
    const mainWrap = wraps[0];
    if (compareBtn && mainWrap && compareBtn.offsetParent !== null) {
      const width = Math.max(
        72,
        Math.round(compareBtn.getBoundingClientRect().right - mainWrap.getBoundingClientRect().left)
      );
      optaMobileNameColW = width;
    }
    if (optaMobileNameColW == null) return;
    const prev = mainWrap && mainWrap.style.getPropertyValue("--name-col-w");
    wraps.forEach((wrap) => wrap.style.setProperty("--name-col-w", `${optaMobileNameColW}px`));
    if (prev !== `${optaMobileNameColW}px`) {
      wraps.forEach(invalidateNameSimplifyOrigin);
    }
  }

  function scheduleOptaMobileNameColWidth() {
    if (optaMobileNameColRaf) cancelAnimationFrame(optaMobileNameColRaf);
    optaMobileNameColRaf = requestAnimationFrame(() => {
      optaMobileNameColRaf = 0;
      syncOptaMobileNameColWidth();
    });
  }

  function nameSimplifyProgress(scrollLeft, origin = 0) {
    const rel = Math.max(0, scrollLeft - origin);
    if (rel <= NAME_SIMPLIFY_START) return 0;
    return Math.min(1, (rel - NAME_SIMPLIFY_START) / (NAME_SIMPLIFY_END - NAME_SIMPLIFY_START));
  }

  function withFullNameColumn(wrap, fn) {
    const prev = wrap.style.getPropertyValue("--name-collapse");
    wrap.style.setProperty("--name-collapse", "0");
    wrap.classList.remove("is-name-simplifying");
    void wrap.offsetWidth;
    const result = fn();
    if (prev) wrap.style.setProperty("--name-collapse", prev);
    else wrap.style.removeProperty("--name-collapse");
    return result;
  }

  // Default view origin = Price/GW snap (desktop 0; mobile core-under). Morph
  // only after panning further right. Measure with the name column at full width
  // so shrinking names cannot pull the origin left.
  function computeNameSimplifyOrigin(wrap) {
    if (!wrap || !wrap.classList.contains("is-core-under")) return 0;
    return withFullNameColumn(wrap, () => {
      const headRow = wrap.querySelector("thead tr:not(.section-row)");
      const pin = headRow && headRow.querySelector("th.col-player, th.col-name");
      const firstStat =
        headRow &&
        headRow.querySelector("th.col-num:not(.col-core), th.col-check:not(.col-core)");
      if (!pin || !firstStat) return 0;
      const delta = firstStat.getBoundingClientRect().left - pin.getBoundingClientRect().right;
      return Math.max(0, Math.round(wrap.scrollLeft + delta));
    });
  }

  function invalidateNameSimplifyOrigin(wrap) {
    if (wrap) delete wrap.dataset.nameSimplifyOrigin;
  }

  function nameSimplifyOrigin(wrap) {
    if (!wrap) return 0;
    const stored = wrap.dataset.nameSimplifyOrigin;
    if (stored != null && stored !== "") return Number(stored);
    const origin = computeNameSimplifyOrigin(wrap);
    wrap.dataset.nameSimplifyOrigin = String(origin);
    return origin;
  }

  function refreshNameSimplifyOrigins() {
    nameSimplifyWraps().forEach((wrap) => {
      invalidateNameSimplifyOrigin(wrap);
      updateNameColumnSimplify(wrap);
    });
  }

  function clearNameColumnSimplify(wrap) {
    if (!wrap) return;
    wrap.classList.remove("name-simplify-ready", "is-name-simplifying");
    wrap.style.removeProperty("--name-collapse");
    wrap.removeAttribute("data-view");
    invalidateNameSimplifyOrigin(wrap);
  }

  function updateNameColumnSimplify(wrap, scrollLeftOverride) {
    if (!wrap || !nameSimplifyActive()) {
      clearNameColumnSimplify(wrap);
      return;
    }
    const scrollLeft = scrollLeftOverride != null ? scrollLeftOverride : wrap.scrollLeft;
    const t = nameSimplifyProgress(scrollLeft, nameSimplifyOrigin(wrap));
    wrap.classList.add("name-simplify-ready");
    wrap.dataset.view = state.page === "team" ? "players" : state.view;
    wrap.style.setProperty("--name-collapse", String(t));
    wrap.classList.toggle("is-name-simplifying", t > 0.02);
  }

  function bindNameColumnSimplify(wrap) {
    if (!wrap || wrap.dataset.nameSimplifyBound === "1") return;
    wrap.dataset.nameSimplifyBound = "1";
    wrap.addEventListener(
      "scroll",
      () => {
        if (nameSimplifyRafs.has(wrap)) return;
        nameSimplifyRafs.set(
          wrap,
          requestAnimationFrame(() => {
            nameSimplifyRafs.delete(wrap);
            updateNameColumnSimplify(wrap);
          })
        );
      },
      { passive: true }
    );
    updateNameColumnSimplify(wrap);
  }

  function syncAllNameColumnSimplifies() {
    nameSimplifyWraps().forEach((wrap) => updateNameColumnSimplify(wrap));
  }

  function bindAllNameColumnSimplifies() {
    if (!nameSimplifyActive()) {
      nameSimplifyWraps().forEach(clearNameColumnSimplify);
      return;
    }
    nameSimplifyWraps().forEach(bindNameColumnSimplify);
  }

  function syncPointerMode() {
    document.documentElement.dataset.pointer = hasFineHover() ? "fine" : "coarse";
  }
  syncPointerMode();

  // Themed replacement for native title tooltips. Prefer setTip / tipAttr over
  // element.title so short labels (column headers, toolbar buttons) use the
  // same popover chrome as the rest of the UI.
  function tipAttr(text) {
    if (text == null || text === "") return "";
    return ` data-tip="${escapeHtml(String(text))}"`;
  }

  function setTip(node, text) {
    if (!node) return;
    if (text == null || text === "") {
      node.removeAttribute("data-tip");
      node.removeAttribute("title");
      return;
    }
    node.setAttribute("data-tip", String(text));
    node.removeAttribute("title");
  }

  function upgradeNativeTitles(root = document) {
    root.querySelectorAll("[title]").forEach((node) => {
      // Page-info already has a rich custom tooltip; leave it alone.
      if (node.classList && node.classList.contains("page-info-btn")) return;
      if (node.closest(".fixture-tooltip, .chart-tooltip, .ui-tooltip")) return;
      const text = node.getAttribute("title");
      if (!text) return;
      setTip(node, text);
    });
  }

  let uiTipTimer = null;
  let uiTipAnchor = null;
  let uiTipHideTimer = null;

  function hideUiTooltip() {
    clearTimeout(uiTipTimer);
    uiTipTimer = null;
    uiTipAnchor = null;
    const tip = el.uiTooltip;
    if (!tip) return;
    tip.classList.remove("visible");
    clearTimeout(uiTipHideTimer);
    uiTipHideTimer = setTimeout(() => {
      if (!tip.classList.contains("visible")) {
        tip.style.display = "none";
        tip.textContent = "";
        tip.innerHTML = "";
      }
    }, 140);
  }

  // ---------------------------------------------------------------------
  // Mobile bottom sheet — tips, prefs, filters, fixture/team ranks.
  // Desktop keeps floating tooltips / dropdowns via hasFineHover().
  // ---------------------------------------------------------------------
  let mobileSheetOpen = false;
  let mobileSheetKey = null;
  let sheetDragStartY = null;
  let sheetDragDy = 0;
  let sheetDragFromHandle = false;
  let matchupEdgeActiveCell = null;
  let sheetHost = null; // { el, parent, nextSibling, cleanup }
  let sheetReturnFocus = null;
  let sheetIgnoreDismissUntil = 0;

  function restoreSheetHost() {
    if (!sheetHost) return;
    const { el: hostEl, parent, nextSibling, cleanup } = sheetHost;
    try {
      if (typeof cleanup === "function") cleanup(hostEl);
    } catch {
      /* host cleanup best-effort */
    }
    if (parent) {
      if (nextSibling && nextSibling.parentNode === parent) parent.insertBefore(hostEl, nextSibling);
      else parent.appendChild(hostEl);
    }
    hostEl.classList.remove("mobile-sheet-hosted");
    sheetHost = null;
  }

  function releaseMobileSheetFocus() {
    const active = document.activeElement;
    if (active && el.mobileSheet && el.mobileSheet.contains(active) && typeof active.blur === "function") {
      active.blur();
    }
    const returnTo = sheetReturnFocus;
    sheetReturnFocus = null;
    if (
      returnTo &&
      returnTo.isConnected &&
      typeof returnTo.focus === "function" &&
      (!el.mobileSheet || !el.mobileSheet.contains(returnTo))
    ) {
      try {
        returnTo.focus({ preventScroll: true });
      } catch {
        try {
          returnTo.focus();
        } catch {
          /* focus restore best-effort */
        }
      }
    }
  }

  function closeMobileSheet() {
    if (!el.mobileSheet || !mobileSheetOpen) return;
    mobileSheetOpen = false;
    const closingKey = mobileSheetKey;
    mobileSheetKey = null;
    sheetDragStartY = null;
    sheetDragDy = 0;
    // Move focus out before aria-hidden — Chrome warns if a descendant stays focused.
    releaseMobileSheetFocus();
    el.mobileSheet.classList.remove("is-open");
    el.mobileSheet.classList.remove("is-home-search");
    el.mobileSheet.setAttribute("aria-hidden", "true");
    document.documentElement.classList.remove("mobile-sheet-active");
    if (el.mobileSheetPanel) {
      el.mobileSheetPanel.style.transform = "";
      el.mobileSheetPanel.style.transition = "";
    }
    $$(".page-info-btn[aria-expanded='true']").forEach((button) => {
      button.setAttribute("aria-expanded", "false");
    });
    $$(".team-rank-info[aria-expanded='true']").forEach((button) => {
      button.setAttribute("aria-expanded", "false");
    });
    if (el.prefsBtn && closingKey === "prefs") el.prefsBtn.setAttribute("aria-expanded", "false");
    if (el.pageTrayBtn && closingKey === "pages") {
      el.pageTrayBtn.setAttribute("aria-expanded", "false");
    }
    if (el.sidebarToggle && closingKey === "filters") {
      el.sidebarToggle.classList.remove("on");
      el.sidebarToggle.setAttribute("aria-pressed", "false");
    }
    if (el.columnsBtn && closingKey === "columns") {
      el.columnsBtn.setAttribute("aria-expanded", "false");
      el.columnsBtn.classList.remove("on");
    }
    if (el.scheduleSlidersToggle && closingKey === "schedule-filters") {
      el.scheduleSlidersToggle.classList.remove("on");
      el.scheduleSlidersToggle.setAttribute("aria-expanded", "false");
    }
    if (el.marketsSlidersToggle && closingKey === "markets-filters") {
      el.marketsSlidersToggle.classList.remove("on");
      el.marketsSlidersToggle.setAttribute("aria-expanded", "false");
    }
    if (el.expectedCatBtn && closingKey === "expected-cats") {
      el.expectedCatBtn.setAttribute("aria-expanded", "false");
    }
    const teamGwSelect = $("#team-gw-select");
    if (teamGwSelect && closingKey === "team-gw") {
      teamGwSelect.setAttribute("aria-expanded", "false");
    }
    if (closingKey === "team-row") {
      teamRowMenuRow = null;
      if (typeof clearTeamRowActions === "function") clearTeamRowActions();
    }
    window.setTimeout(() => {
      if (mobileSheetOpen || !el.mobileSheet) return;
      restoreSheetHost();
      el.mobileSheet.hidden = true;
      if (el.mobileSheetBody) el.mobileSheetBody.innerHTML = "";
      if (el.mobileSheetTitle) {
        el.mobileSheetTitle.classList.remove("mobile-sheet-title-rich");
        el.mobileSheetTitle.textContent = "";
      }
      if (el.mobileSheetReset) el.mobileSheetReset.hidden = true;
    }, 280);
    syncSearchClearBtns();
    syncFiltersResetUI();
  }

  function beginMobileSheetShell({ title = "", titleHtml = "", key = null } = {}) {
    if (!el.mobileSheet || !el.mobileSheetPanel || !el.mobileSheetBody) return false;
    if (!preferMobileSheet()) return false;
    resetMobileChromeScrollHide();
    if (key && mobileSheetOpen && mobileSheetKey === key) {
      closeMobileSheet();
      return false;
    }
    restoreSheetHost();
    hideUiTooltip();
    if (el.teamRankTooltip) {
      el.teamRankTooltip.style.display = "none";
      el.teamRankTooltip.innerHTML = "";
    }
    if (el.matchupEdgeTooltip) {
      el.matchupEdgeTooltip.style.display = "none";
      el.matchupEdgeTooltip.innerHTML = "";
      matchupEdgeActiveCell = null;
    }
    if (el.pageInfoTooltip) {
      el.pageInfoTooltip.style.display = "none";
      el.pageInfoTooltip.innerHTML = "";
      el.pageInfoTooltip.classList.remove("page-info-annotate");
    }
    if (el.scheduleScatterTooltip) {
      el.scheduleScatterTooltip.style.display = "none";
      el.scheduleScatterTooltip.innerHTML = "";
    }
    if (el.fixtureTooltip) {
      el.fixtureTooltip.style.display = "none";
      el.fixtureTooltip.innerHTML = "";
    }

    const opener = document.activeElement;
    sheetReturnFocus =
      opener &&
      opener !== document.body &&
      opener !== document.documentElement &&
      !(el.mobileSheet && el.mobileSheet.contains(opener))
        ? opener
        : sheetReturnFocus;

    mobileSheetKey = key;
    if (el.mobileSheet) {
      el.mobileSheet.classList.toggle("is-home-search", key === "home-search");
    }
    if (el.mobileSheetTitle) {
      if (titleHtml) {
        el.mobileSheetTitle.classList.add("mobile-sheet-title-rich");
        el.mobileSheetTitle.innerHTML = titleHtml;
      } else {
        el.mobileSheetTitle.classList.remove("mobile-sheet-title-rich");
        el.mobileSheetTitle.textContent = title || "";
      }
    }
    el.mobileSheetBody.innerHTML = "";
    el.mobileSheet.hidden = false;
    el.mobileSheet.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("mobile-sheet-active");
    el.mobileSheetPanel.style.transform = "";
    el.mobileSheetPanel.style.transition = "";
    mobileSheetOpen = true;
    // Enable pointer-events immediately so the opening tap cannot fall through
    // the sheet to page tabs underneath (was navigating to Matchups).
    el.mobileSheet.classList.remove("is-open");
    void el.mobileSheet.offsetWidth;
    el.mobileSheet.classList.add("is-open");
    // Ignore backdrop/X dismiss from the same gesture that opened the sheet.
    sheetIgnoreDismissUntil = Date.now() + 450;
    syncSearchClearBtns();
    syncFiltersResetUI();
    return true;
  }

  function openMobileSheet({ title = "", titleHtml = "", html = "", key = null } = {}) {
    if (!beginMobileSheetShell({ title, titleHtml, key })) return;
    el.mobileSheetBody.innerHTML = html || "";
  }

  function openMobileSheetHost({ title = "", titleHtml = "", key = null, hostEl, prepare = null, cleanup = null } = {}) {
    if (!hostEl) return;
    if (!beginMobileSheetShell({ title, titleHtml, key })) return;
    sheetHost = {
      el: hostEl,
      parent: hostEl.parentNode,
      nextSibling: hostEl.nextSibling,
      cleanup,
    };
    hostEl.classList.add("mobile-sheet-hosted");
    if (typeof prepare === "function") prepare(hostEl);
    el.mobileSheetBody.appendChild(hostEl);
    requestAnimationFrame(() => {
      if (typeof syncAllSegThumbs === "function") syncAllSegThumbs({ animate: false });
    });
  }

  function openPlainTipSheet(anchor) {
    if (!anchor) return;
    const html = anchor.getAttribute("data-tip-html");
    const text = anchor.getAttribute("data-tip");
    if (!html && !text) return;
    const title =
      anchor.getAttribute("aria-label") ||
      anchor.getAttribute("title") ||
      "Details";
    const body = html || `<p class="mobile-sheet-plain">${escapeHtml(text)}</p>`;
    const key = `tip:${title}:${text || html || ""}`;
    openMobileSheet({ title, html: body, key });
  }

  if (el.mobileSheet) {
    el.mobileSheet.addEventListener("click", (event) => {
      if (event.target.closest("[data-sheet-dismiss]")) {
        event.preventDefault();
        if (Date.now() < sheetIgnoreDismissUntil) return;
        closeMobileSheet();
      }
    });
    const onDragStart = (event) => {
      if (!mobileSheetOpen || !el.mobileSheetPanel) return;
      const touch = event.touches && event.touches[0];
      if (!touch) return;
      const onHandle = !!event.target.closest("[data-sheet-drag]");
      const body = el.mobileSheetBody;
      if (!onHandle && body && body.scrollTop > 0) return;
      sheetDragFromHandle = onHandle;
      sheetDragStartY = touch.clientY;
      sheetDragDy = 0;
      el.mobileSheetPanel.style.transition = "none";
    };
    const onDragMove = (event) => {
      if (sheetDragStartY == null || !el.mobileSheetPanel) return;
      const touch = event.touches && event.touches[0];
      if (!touch) return;
      const dy = touch.clientY - sheetDragStartY;
      sheetDragDy = Math.max(0, dy);
      if (sheetDragDy > 0 && event.cancelable) event.preventDefault();
      el.mobileSheetPanel.style.transform = `translateY(${sheetDragDy}px)`;
    };
    const onDragEnd = () => {
      if (sheetDragStartY == null || !el.mobileSheetPanel) return;
      const shouldClose = sheetDragDy > 88 || (sheetDragFromHandle && sheetDragDy > 56);
      sheetDragStartY = null;
      el.mobileSheetPanel.style.transition = "";
      if (shouldClose) {
        closeMobileSheet();
      } else {
        el.mobileSheetPanel.style.transform = "";
      }
      sheetDragDy = 0;
      sheetDragFromHandle = false;
    };
    el.mobileSheet.addEventListener("touchstart", onDragStart, { passive: true });
    el.mobileSheet.addEventListener("touchmove", onDragMove, { passive: false });
    el.mobileSheet.addEventListener("touchend", onDragEnd);
    el.mobileSheet.addEventListener("touchcancel", onDragEnd);
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && mobileSheetOpen) closeMobileSheet();
  });

  function positionUiTooltip(anchor) {
    const tip = el.uiTooltip;
    if (!tip || !anchor) return;
    tip.style.display = "block";
    tip.style.visibility = "hidden";
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const rect = anchor.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipW / 2;
    let top = rect.bottom + 8;
    if (top + tipH > window.innerHeight - 8) top = rect.top - tipH - 8;
    if (left < 8) left = 8;
    if (left + tipW > window.innerWidth - 8) left = window.innerWidth - tipW - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, top)}px`;
    tip.style.visibility = "visible";
  }

  function showUiTooltip(anchor) {
    const tip = el.uiTooltip;
    if (!tip || !anchor) return;
    const html = anchor.getAttribute("data-tip-html");
    const text = anchor.getAttribute("data-tip");
    if (!html && !text) return;
    // Don't stack compact tips over Matchups card / edge popovers.
    hideMatchupEdgeTooltip();
    hideTeamRankTooltip();
    hideScheduleScatterTooltip();
    clearTimeout(fixtureTtTimer);
    hideFixtureTooltip();
    clearTimeout(uiTipHideTimer);
    if (html) tip.innerHTML = html;
    else tip.textContent = text;
    tip.classList.remove("visible");
    positionUiTooltip(anchor);
    // Next frame so the opacity/transform transition actually plays.
    requestAnimationFrame(() => tip.classList.add("visible"));
  }

  function tipTargetFrom(node) {
    if (!node || !node.closest) return null;
    // Rich Matchups tips own these targets — skip the compact ui-tooltip.
    if (node.closest(".ftt-verdict-tip, .team-rank-info, .page-info-btn")) return null;
    if (isTeamFixtureFormTipTarget(node)) return null;
    return node.closest("[data-tip], [data-tip-html]");
  }

  function isTeamFixtureFormTipTarget(node) {
    return !!node.closest(
      "#team-page td.col-team-spark, #team-page td.team-heat-cell, #team-page th.col-team-spark, " +
        "#team-picker-view td.col-team-spark, #team-picker-view td.team-heat-cell, #team-picker-view th.col-team-spark, " +
        "#team-compare-wrap td.col-team-spark, #team-compare-wrap td.team-heat-cell"
    );
  }

  document.addEventListener("mouseover", (event) => {
    if (!hasFineHover()) return;
    const target = tipTargetFrom(event.target);
    if (!target) return;
    if (target === uiTipAnchor) return;
    // Hide card tips as soon as we enter an icon tip host (don't wait for delay).
    hideMatchupEdgeTooltip();
    hideTeamRankTooltip();
    hideScheduleScatterTooltip();
    clearTimeout(fixtureTtTimer);
    hideFixtureTooltip();
    clearTimeout(uiTipTimer);
    uiTipAnchor = target;
    uiTipTimer = setTimeout(() => {
      if (uiTipAnchor === target) showUiTooltip(target);
    }, popupDelayMs());
  });

  document.addEventListener("mouseout", (event) => {
    if (!hasFineHover()) return;
    const target = tipTargetFrom(event.target);
    if (!target || target !== uiTipAnchor) return;
    const next = tipTargetFrom(event.relatedTarget);
    if (next === target) return;
    hideUiTooltip();
  });

  // Name / identity chrome tips (ownership pin, crest/pos change, league place)
  // — Statistics + xData. Rankings keeps its own tap behavior.
  function isIdentityChromeTipTarget(tipEl) {
    if (!tipEl || tipEl.closest(".rankings-row")) return false;
    return !!tipEl.closest(".player-cell, .barbell-label, .barbell-group-identity");
  }

  // Touch: tap non-conflicting [data-tip] targets → mobile sheet.
  // Capture phase so identity icons still open even when a parent row handler
  // would otherwise consume the tap (and so we can stopPropagation before
  // compare-row toggle). Skip Rankings entirely. Skip table sort headers —
  // their tips are for hover; a tap must only change sort.
  document.addEventListener(
    "click",
    (event) => {
      if (hasFineHover()) return;
      const target = tipTargetFrom(event.target);
      if (!target) {
        hideUiTooltip();
        return;
      }
      if (target.closest(".rankings-row")) return;
      const identityTip = isIdentityChromeTipTarget(target);
      if (
        !identityTip &&
        (isTeamFixtureFormTipTarget(target) ||
          target.closest(
            "a, button, input, label, select, textarea, summary, thead th, .barbell-head-cell, .schedule-scatter-point, .barbell-dot, .team-rank-info, .ftt-verdict-tip, tbody tr[data-team], .schedule-card, #mobile-sheet"
          ))
      ) {
        return;
      }
      event.preventDefault();
      if (identityTip) event.stopPropagation();
      openPlainTipSheet(target);
    },
    true
  );

  document.addEventListener("focusin", (event) => {
    if (!hasFineHover()) return;
    const target = tipTargetFrom(event.target);
    if (!target) return;
    clearTimeout(uiTipTimer);
    uiTipAnchor = target;
    showUiTooltip(target);
  });

  document.addEventListener("focusout", (event) => {
    if (!hasFineHover()) return;
    const target = tipTargetFrom(event.target);
    if (!target || target !== uiTipAnchor) return;
    hideUiTooltip();
  });

  window.addEventListener("scroll", () => {
    hideUiTooltip();
  }, true);
  window.addEventListener("resize", () => {
    hideUiTooltip();
  });

  function renderBody(rows) {
    const vcols = visibleColumns();
    el.tableBody.innerHTML = "";

    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = vcols.length;
      td.className = "empty-state";
      td.textContent = "No rows match the current filters.";
      tr.appendChild(td);
      el.tableBody.appendChild(tr);
      return;
    }

    const highlightMaps = buildHighlightMaps(
      state.enhanceRelative && state.page === "opta" ? rows : getRows()
    );
    rows.forEach((r) =>
      el.tableBody.appendChild(buildDataRow(r, vcols, highlightMaps))
    );
  }

  function buildDataRow(r, vcols, highlightMaps) {
    const tr = document.createElement("tr");
    const key = rowKey(r);
    const teamCode = currentTeamCode(r);
    if (teamCode) tr.dataset.team = teamCode;
    tr.dataset.rowName = r.name || "";
    if (r.code != null) tr.dataset.playerCode = String(r.code);
    tr.dataset.rowKey = String(key);
    const inCompareSet = compareSet().has(key);
    if (state.compareMode) {
      tr.classList.add("row-selectable");
      if (inCompareSet) tr.classList.add("row-selected");
      tr.setAttribute("aria-selected", inCompareSet ? "true" : "false");
      tr.addEventListener("click", () => toggleCompareRow(key));
    }
    vcols.forEach((c, i) => {
      const td = document.createElement("td");
      td.classList.add("col-" + (c.type || "num"));
      if (CORE_COL_KEYS.has(c.key)) td.classList.add("col-core");
      if (isSectionBoundary(vcols, i)) td.classList.add("sec-divider");
      if (
        c.key === "player" &&
        updatesOverlayOn() &&
        playerHasSeasonUpdate(r)
      ) {
        td.classList.add("has-update-change");
      }
      let inner = cellHTML(r, c);
      td.innerHTML = inner;
      if (isNumericCol(c)) {
        if (!isStatApplicable(r, c)) {
          td.classList.add("zero-val");
        } else if (sourceUnsupportedReason(r, c)) {
          td.classList.add("has-source-warning");
        } else {
          const val = displayValue(r, c) || 0;
          if (Math.abs(val) < 1e-9) {
            td.classList.add("zero-val");
          } else if (highlightMaps && highlightMaps[c.key]) {
            const key = rowKey(r);
            const topIntensity = highlightMaps[c.key].top.get(key);
            const bottomIntensity = highlightMaps[c.key].bottom.get(key);
            if (topIntensity !== undefined) {
              applyEnhanceHighlight(td, "top", topIntensity);
            } else if (bottomIntensity !== undefined) {
              applyEnhanceHighlight(td, "bottom", bottomIntensity);
            }
          }
        }
      }
      tr.appendChild(td);
    });
    return tr;
  }

  function optaTableWraps() {
    const wraps = [];
    const main = el.tableBody && el.tableBody.closest(".table-wrap");
    if (main) wraps.push(main);
    const compare = el.compareWrap && el.compareWrap.querySelector(".compare-table-wrap");
    if (compare) wraps.push(compare);
    return wraps;
  }

  function teamLandscapeSquadWrap() {
    return el.teamSquadView && el.teamSquadView.querySelector(":scope > .team-table-wrap");
  }

  function teamLandscapeActive() {
    return (
      teamLandscapeViewport() &&
      state.page === "team" &&
      !state.teamPickerSlot &&
      !state.teamCompareMode &&
      state.teamCompareCodes.length === 0 &&
      (!el.teamSearchResults || el.teamSearchResults.hidden) &&
      el.teamPage &&
      el.teamPage.style.display !== "none"
    );
  }

  const TEAM_LANDSCAPE_VARS = [
    "--team-landscape-name-w",
    "--team-landscape-stat-w",
    "--team-landscape-spark-w",
    "--team-landscape-heat-w",
  ];

  function clearTeamLandscapeLayout() {
    const root = document.documentElement;
    TEAM_LANDSCAPE_VARS.forEach((v) => root.style.removeProperty(v));
  }

  function syncTeamLandscapeLayout() {
    if (!teamLandscapeActive()) {
      clearTeamLandscapeLayout();
      return;
    }
    const vv = window.visualViewport;
    const w = vv ? vv.width : window.innerWidth;
    const pad = 10;
    const usable = Math.max(320, w - pad * 2);
    const nameW = Math.round(Math.min(148, Math.max(92, usable * 0.135)));
    const statW = Math.round(Math.min(44, Math.max(28, usable * 0.05)));
    const sparkW = Math.round(Math.min(58, Math.max(36, usable * 0.068)));
    const fixed = nameW + 5 * statW + sparkW;
    const heatW = Math.max(36, Math.floor((usable - fixed) / 6));
    const root = document.documentElement;
    root.style.setProperty("--team-landscape-name-w", `${nameW}px`);
    root.style.setProperty("--team-landscape-stat-w", `${statW}px`);
    root.style.setProperty("--team-landscape-spark-w", `${sparkW}px`);
    root.style.setProperty("--team-landscape-heat-w", `${heatW}px`);
  }

  function tableHeadSplitStickyActive() {
    return NARROW_MQ.matches || teamLandscapeActive();
  }

  function syncTableHeadHeights(wrap) {
    if (!wrap) return;
    if (!tableHeadSplitStickyActive()) {
      wrap.classList.remove("is-head-h-synced");
      wrap.style.removeProperty("--table-sec-h");
      wrap.style.removeProperty("--table-head-h");
      return;
    }
    const secRow = wrap.querySelector("thead tr.section-row");
    if (!secRow) return;
    wrap.classList.remove("is-head-h-synced");
    const secH = Math.ceil(secRow.getBoundingClientRect().height);
    const headRow = wrap.querySelector("thead tr:not(.section-row)");
    const headH = headRow ? Math.ceil(headRow.getBoundingClientRect().height) : 0;
    if (secH > 0) wrap.style.setProperty("--table-sec-h", `${secH}px`);
    if (headH > 0) wrap.style.setProperty("--table-head-h", `${headH}px`);
    wrap.classList.add("is-head-h-synced");
  }

  function syncTeamTableHeadHeights() {
    if (state.page !== "team" || !el.teamPage) return;
    el.teamPage.querySelectorAll(".table-wrap.team-table-wrap").forEach(syncTableHeadHeights);
  }

  let teamHeadHeightSyncRaf = 0;
  function scheduleTeamTableHeadHeightSync() {
    if (teamHeadHeightSyncRaf) cancelAnimationFrame(teamHeadHeightSyncRaf);
    teamHeadHeightSyncRaf = requestAnimationFrame(() => {
      teamHeadHeightSyncRaf = requestAnimationFrame(() => {
        teamHeadHeightSyncRaf = 0;
        syncTeamTableHeadHeights();
      });
    });
  }

  let teamLandscapeSyncRaf = 0;
  let teamLandscapeWasActive = false;

  function scheduleTeamLandscapeSync() {
    if (teamLandscapeSyncRaf) cancelAnimationFrame(teamLandscapeSyncRaf);
    teamLandscapeSyncRaf = requestAnimationFrame(() => {
      teamLandscapeSyncRaf = 0;
      syncTeamLandscapeMode();
    });
  }

  function syncTeamLandscapeMode() {
    const active = teamLandscapeActive();
    const entering = active && !teamLandscapeWasActive;
    teamLandscapeWasActive = active;
    document.documentElement.classList.toggle("is-team-landscape", active);
    if (!active) {
      clearTeamLandscapeLayout();
      scheduleTeamTableHeadHeightSync();
      return;
    }
    if (mobileSheetOpen) closeMobileSheet();
    syncTeamLandscapeLayout();
    const wrap = teamLandscapeSquadWrap();
    if (entering && wrap) wrap.scrollTop = 0;
    scheduleTeamTableHeadHeightSync();
  }

  function teamTableScrollWraps() {
    const wraps = [];
    if (state.teamPickerSlot) {
      const picker =
        el.teamPickerView && el.teamPickerView.querySelector(".team-picker-table-wrap");
      if (picker) wraps.push(picker);
      const compare =
        el.teamCompareWrap &&
        !el.teamCompareWrap.hidden &&
        el.teamCompareWrap.querySelector(".team-table-wrap");
      if (compare) wraps.push(compare);
    } else {
      const squad =
        el.teamSquadView && el.teamSquadView.querySelector(":scope > .team-table-wrap");
      if (squad) wraps.push(squad);
      const search =
        el.teamSearchResults &&
        !el.teamSearchResults.hidden &&
        el.teamSearchResults.querySelector(".team-table-wrap");
      if (search) wraps.push(search);
    }
    return wraps;
  }

  function expectedScrollWrap() {
    return el.barbellWrap && el.barbellWrap.querySelector(".barbell-scroll");
  }

  function visibleCoreCount() {
    return visibleColumns().filter((c) => CORE_COL_KEYS.has(c.key)).length;
  }

  function syncTeamPickerCoreUnder() {
    const under = state.page === "team" && !!state.teamPickerSlot && NARROW_MQ.matches;
    const picker =
      el.teamPickerView && el.teamPickerView.querySelector(".team-picker-table-wrap");
    if (picker) {
      picker.classList.toggle("is-core-under", under);
      invalidateNameSimplifyOrigin(picker);
    }
    const teamCompare =
      el.teamCompareWrap &&
      !el.teamCompareWrap.hidden &&
      el.teamCompareWrap.querySelector(".team-table-wrap");
    if (teamCompare) {
      teamCompare.classList.toggle("is-core-under", under);
      invalidateNameSimplifyOrigin(teamCompare);
    }
  }

  function syncCoreUnderName() {
    const under = visibleCoreCount() > 0 && NARROW_MQ.matches && state.page === "opta";
    optaTableWraps().forEach((wrap) => {
      wrap.classList.toggle("is-core-under", under);
      invalidateNameSimplifyOrigin(wrap);
    });
  }

  function snapOptaToGameStats() {
    optaTableWraps().forEach((wrap) => {
      if (!wrap.classList.contains("is-core-under")) {
        if (!NARROW_MQ.matches) wrap.scrollLeft = 0;
        return;
      }
      wrap.scrollLeft = computeNameSimplifyOrigin(wrap);
    });
  }

  function resetScrollWraps(wraps) {
    wraps.forEach((wrap) => {
      if (!wrap) return;
      wrap.scrollLeft = 0;
      invalidateNameSimplifyOrigin(wrap);
    });
  }

  function renderTable(opts = {}) {
    const preserveOptaScroll = !!opts.preserveOptaScroll;
    clearTimeout(fixtureTtTimer);
    hideFixtureTooltip();
    if (state.page === "ownership") {
      renderOwnership();
      syncFiltersResetUI();
      syncTeamSearchHost();
      return;
    }
    if (state.page === "team") {
      renderTeam();
      syncFiltersResetUI();
      return;
    }
    const filtered = applyFilters(getRows());
    // Resolve Relative default before building highlight maps.
    syncEnhanceRelativeUI();
    const sorted = sortRows(filtered);
    const highlightFilterKey = state.page === "opta" ? optaHighlightFilterKey(filtered.length) : "";
    const highlightsChanged =
      state.page === "opta" &&
      (opts.animateHighlights === true ||
        (highlightFilterKey && highlightFilterKey !== lastOptaHighlightFilterKey));
    if (state.page === "opta") lastOptaHighlightFilterKey = highlightFilterKey;
    renderHead();
    renderBody(sorted);
    el.countLabel.textContent = `${filtered.length.toLocaleString()} of ${getRows().length.toLocaleString()} shown`;
    renderCompareTable();
    if (state.page === "expected") renderExpected();
    if (state.page === "rankings") renderRankings();
    bindAllNameColumnSimplifies();
    if (state.page === "opta") bindMobileChromeScrollHide();
    syncFiltersResetUI();
    syncCoreUnderName();
    syncTeamSearchHost();
    if (highlightsChanged && el.optaPage) {
      requestAnimationFrame(() => startOptaHighlightEnter(el.optaPage));
    }
    requestAnimationFrame(() => {
      if (opts.resetScroll) {
        resetScrollWraps(optaTableWraps());
        refreshNameSimplifyOrigins();
      } else if (preserveOptaScroll) {
        refreshNameSimplifyOrigins();
      } else {
        snapOptaToGameStats();
        requestAnimationFrame(() => {
          snapOptaToGameStats();
          refreshNameSimplifyOrigins();
        });
      }
      syncMobileScrollportHeight();
      scheduleOptaMobileNameColWidth();
    });
  }

  // ---------------------------------------------------------------------
  // Fixture hover tooltip (upcoming 7, opponent season stats)
  // ---------------------------------------------------------------------
  // Player rows use the matched 2026/27 FPL team when available (transfers
  // already applied in build.py via bootstrap-static); otherwise fall back
  // to last season's club. Team rows always use their own code.
  function currentTeamCode(row) {
    if (state.view === "teams") return row.team;
    // 2026/27 rows already use next-season team; on 2025/26 prefer the match.
    return row.newTeam || row.team || null;
  }

  function opponentStatsForFixture(fx) {
    // Opponent's venue-split profile: if we are home they are away, and vice versa.
    const split = fx.ha === "H" ? "away" : "home";
    return TEAM_STATS[split][fx.opp] || TEAM_STATS.combined[fx.opp] || null;
  }

  function fmtTtStat(v, decimals) {
    if (v == null || Number.isNaN(v)) return "—";
    return fmtNum(v, decimals);
  }

  const FIXTURE_TT_STATS = [
    { key: "xg", decimals: 1 },
    { key: "goals", decimals: 0 },
    { key: "xgc", decimals: 1 },
    { key: "goalsConceded", decimals: 0 },
    { key: "cleanSheets", decimals: 0 },
  ];

  // Rank tooltip opponents against every team in the matching venue split,
  // never just the seven opponents shown. Highlighting follows the complete
  // 20-team rank maps, including provisional ranks for promoted clubs.
  // topN is absolute (top & bottom N ranks), not a percentage.
  function fixtureHighlightMaps(topN = state.scheduleEnhanceTopN) {
    const maps = { home: {}, away: {} };
    const rankMaps = fixtureRankMaps();
    const band = Math.max(1, Math.round(topN));
    ["home", "away"].forEach((split) => {
      FIXTURE_TT_STATS.forEach(({ key }) => {
        const rankMap = rankMaps[split][key];
        if (!rankMap || rankMap.size < 2) return;
        const ranked = Array.from(rankMap, ([teamCode, rank]) => ({ key: teamCode, rank }))
          .sort((a, b) => a.rank - b.rank);
        const n = Math.max(1, Math.min(band, ranked.length));
        const topSlice = ranked.slice(0, n);
        const bottomSlice = ranked.slice(-n).reverse();
        maps[split][key] = {
          top: new Map(topSlice.map((x, i) => [x.key, rankBandIntensity(i, topSlice.length)])),
          bottom: new Map(bottomSlice.map((x, i) => [x.key, rankBandIntensity(i, bottomSlice.length)])),
        };
      });
    });
    return maps;
  }

  // Competition ranks for measured clubs, plus explicit provisional ranks for
  // the promoted clubs. No synthetic raw values are introduced.
  function fixtureRankMaps() {
    const maps = { home: {}, away: {} };
    ["home", "away"].forEach((split) => {
      const teams = Object.values(TEAM_STATS[split]);
      FIXTURE_TT_STATS.forEach(({ key }) => {
        const lowerBetter = LOWER_BETTER.has(key);
        const ranked = teams
          .map((team) => ({ key: team.team, val: team[key] || 0 }))
          .filter((x) => Math.abs(x.val) > 1e-9)
          .sort((a, b) => (lowerBetter ? a.val - b.val : b.val - a.val));
        if (!ranked.length) return;

        const rankByKey = new Map();
        let i = 0;
        while (i < ranked.length) {
          let j = i + 1;
          while (j < ranked.length && ranked[j].val === ranked[i].val) j++;
          const denseRank = i + 1;
          for (let k = i; k < j; k++) rankByKey.set(ranked[k].key, denseRank);
          i = j;
        }
        PROVISIONAL_TEAM_RANKS.forEach((rank, code) => {
          rankByKey.set(code, rank);
        });
        maps[split][key] = rankByKey;
      });
    });
    return maps;
  }

  function fixtureStatCell(teamCode, split, key, value, decimals, highlightMaps, rankMaps) {
    // Tooltip always shows ranks + enhance-style highlighting. Colours are
    // inverted relative to the main table: these are the *opponent's*
    // figures, so being top of a category (rank 1) is a hard fixture and
    // reads red, bottom reads green.
    let style = "";
    let extraClass = "";
    const ranks = highlightMaps[split] && highlightMaps[split][key];
    const topIntensity = ranks && ranks.top.get(teamCode);
    const bottomIntensity = ranks && ranks.bottom.get(teamCode);
    if (topIntensity !== undefined) {
      // Opponent top = hard fixture → red.
      const paint = enhanceHighlightInlineStyle("bottom", topIntensity);
      style = ` style="${paint.style}"`;
      extraClass = paint.strongClass;
    } else if (bottomIntensity !== undefined) {
      const paint = enhanceHighlightInlineStyle("top", bottomIntensity);
      style = ` style="${paint.style}"`;
      extraClass = paint.strongClass;
    }
    const rank = rankMaps[split] && rankMaps[split][key] && rankMaps[split][key].get(teamCode);
    const text = rank == null ? "—" : String(rank);
    const provisionalRank = PROVISIONAL_TEAM_RANKS.has(teamCode);
    const title = rank == null
      ? ""
      : provisionalRank
        ? ` title="Provisional rank — no prior-season OPTA data"`
        : ` title="${escapeHtml(fmtTtStat(value, decimals))}"`;
    // First defending column (xGC) gets a left rule to split attack from defence.
    const baseCls = key === "xgc" ? "ftt-def-start" : "";
    const clsName = `${baseCls}${extraClass}`.trim();
    const cls = clsName ? ` class="${clsName}"` : "";
    return `<td${cls}${style}${title}>${text}</td>`;
  }

  function rankOf(rankMaps, split, key, teamCode) {
    const map = rankMaps[split] && rankMaps[split][key];
    if (!map) return null;
    const rank = map.get(teamCode);
    return rank == null ? null : rank;
  }

  // Blend expected and actual ranks for a side of the ball. Every component
  // must be present — promoted clubs with no OPTA row return null so the
  // matchup finder leaves those fixtures unmarked.
  function compositeAttackRank(rankMaps, split, teamCode) {
    const xg = rankOf(rankMaps, split, "xg", teamCode);
    const goals = rankOf(rankMaps, split, "goals", teamCode);
    if (xg == null || goals == null) return null;
    const w = state.scheduleExpectedWeight / 100;
    return w * xg + (1 - w) * goals;
  }

  function compositeDefenceRank(rankMaps, split, teamCode) {
    const xgc = rankOf(rankMaps, split, "xgc", teamCode);
    const gc = rankOf(rankMaps, split, "goalsConceded", teamCode);
    const cs = rankOf(rankMaps, split, "cleanSheets", teamCode);
    if (xgc == null || gc == null || cs == null) return null;
    const w = state.scheduleExpectedWeight / 100;
    return w * xgc + (1 - w) * ((gc + cs) / 2);
  }

  // Positive advantage = favorable for the card team. Attack compares our
  // attack to their defence; defence compares our defence to their attack.
  // Ranks are already 1 = strongest on every key, so no sign flip is needed.
  function matchupEdges(teamCode, fx, rankMaps) {
    const tSplit = fx.ha === "H" ? "home" : "away";
    const oSplit = fx.ha === "H" ? "away" : "home";
    const ourAttack = compositeAttackRank(rankMaps, tSplit, teamCode);
    const ourDefence = compositeDefenceRank(rankMaps, tSplit, teamCode);
    const theirAttack = compositeAttackRank(rankMaps, oSplit, fx.opp);
    const theirDefence = compositeDefenceRank(rankMaps, oSplit, fx.opp);

    const attackEdge =
      ourAttack == null || theirDefence == null ? null : theirDefence - ourAttack;
    const defenceEdge =
      ourDefence == null || theirAttack == null ? null : theirAttack - ourDefence;

    return {
      attackEdge,
      defenceEdge,
      ourAttack,
      ourDefence,
      theirAttack,
      theirDefence,
      attackOn: attackEdge != null && attackEdge >= state.scheduleEdgeMin,
      defenceOn: defenceEdge != null && defenceEdge >= state.scheduleEdgeMin,
    };
  }

  function fmtEdge(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const rounded = Math.round(n * 10) / 10;
    return (rounded > 0 ? "+" : "") + String(rounded);
  }

  function fmtComposite(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return (Math.round(n * 10) / 10).toFixed(1);
  }

  function fmtMatchupScore(n) {
    if (n == null || Number.isNaN(n)) return "0";
    return String(Math.round(n * 10) / 10);
  }

  function matchupEdgeTooltipHTML(edges) {
    const blocks = [];
    if (edges.attackOn) {
      blocks.push(`<div class="met-block met-attack">
        <div class="met-head">${iconHTML("swords", "ftt-attack-icon")}<span>Favorable attack</span></div>
        <div class="met-edge">Advantage <strong>${escapeHtml(fmtEdge(edges.attackEdge))}</strong></div>
        <div class="met-compare">
          <div class="met-row"><span>Your attack</span><span class="met-val">${escapeHtml(fmtComposite(edges.ourAttack))}</span></div>
          <div class="met-row"><span>Their defence</span><span class="met-val">${escapeHtml(fmtComposite(edges.theirDefence))}</span></div>
        </div>
      </div>`);
    }
    if (edges.defenceOn) {
      blocks.push(`<div class="met-block met-defence">
        <div class="met-head">${iconHTML("shield-half", "ftt-defence-icon")}<span>Favorable defence</span></div>
        <div class="met-edge">Advantage <strong>${escapeHtml(fmtEdge(edges.defenceEdge))}</strong></div>
        <div class="met-compare">
          <div class="met-row"><span>Your defence</span><span class="met-val">${escapeHtml(fmtComposite(edges.ourDefence))}</span></div>
          <div class="met-row"><span>Their attack</span><span class="met-val">${escapeHtml(fmtComposite(edges.theirAttack))}</span></div>
        </div>
      </div>`);
    }
    if (!blocks.length) return "";
    return `${blocks.join('<div class="met-divider"></div>')}
      <div class="met-foot">Ranks · 1 is strongest · advantage = how many places better you are</div>`;
  }

  function matchupVerdictCell(teamCode, fx, rankMaps) {
    const edges = matchupEdges(teamCode, fx, rankMaps);
    const icons = [];
    const attrs = [];
    if (edges.attackOn) {
      icons.push(iconHTML("swords", "ftt-attack-icon"));
      attrs.push(`data-attack-edge="${edges.attackEdge}"`);
      attrs.push(`data-our-attack="${edges.ourAttack}"`);
      attrs.push(`data-their-defence="${edges.theirDefence}"`);
    }
    if (edges.defenceOn) {
      icons.push(iconHTML("shield-half", "ftt-defence-icon"));
      attrs.push(`data-defence-edge="${edges.defenceEdge}"`);
      attrs.push(`data-our-defence="${edges.ourDefence}"`);
      attrs.push(`data-their-attack="${edges.theirAttack}"`);
    }
    const body = icons.length ? icons.join("") : "";
    const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
    return {
      html: `<td class="ftt-verdict${icons.length ? " ftt-verdict-tip" : ""}"${attrStr}>${body}</td>`,
      attackOn: edges.attackOn,
      defenceOn: edges.defenceOn,
    };
  }

  function teamRankTooltipHTML(teamCode) {
    const highlightMaps = fixtureHighlightMaps();
    const rankMaps = fixtureRankMaps();
    const teamLabel = TEAM_NAMES[teamCode] || teamCode;
    const rows = ["home", "away"].map((split) => {
      const stats = TEAM_STATS[split][teamCode] || null;
      return `<tr>
        <td class="team-rank-venue">${split === "home" ? "Home" : "Away"}</td>
        ${FIXTURE_TT_STATS.map(({ key, decimals }) =>
          fixtureStatCell(teamCode, split, key, stats && stats[key], decimals, highlightMaps, rankMaps)
        ).join("")}
      </tr>`;
    }).join("");
    return `<div class="ftt-head">${badgeHTML(teamCode)}<span>${escapeHtml(teamLabel)}</span></div>
      <table class="ftt-table team-rank-table">
        <thead><tr>
          <th>Split</th>
          <th title="Expected goals rank">xG</th>
          <th title="Goals rank">G</th>
          <th class="ftt-def-start" title="Expected goals conceded rank">xGC</th>
          <th title="Goals conceded rank">GC</th>
          <th title="Clean sheets rank">CS</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="ftt-note">Team ranks vs all clubs by venue (1 = strongest, 20 = weakest). Promoted-club ranks are provisional.</div>`;
  }

  function fixtureCardHTML(teamCode, highlightMaps, rankMaps, options = {}) {
    const fixtures = options.fixtures || planningFixturesForTeam(teamCode, FIXTURE_TT_COUNT);
    const showMeta = options.showMeta !== false;
    const showTeamInfo = options.showTeamInfo === true;
    const showMatchups = options.showMatchups === true;
    const matchupProfile = options.matchupProfile || null;
    const teamLabel = TEAM_NAMES[teamCode] || teamCode;
    const scoreSummary = matchupProfile
      ? `<div class="matchup-score-summary" aria-label="Attack advantage ${fmtMatchupScore(matchupProfile.attackScore)} across ${matchupProfile.attackCount} fixtures; defence advantage ${fmtMatchupScore(matchupProfile.defenceScore)} across ${matchupProfile.defenceCount} fixtures">
          <span class="matchup-score matchup-score-attack" aria-label="Attack advantage ${fmtMatchupScore(matchupProfile.attackScore)}, ${matchupProfile.attackCount} favorable fixture${matchupProfile.attackCount === 1 ? "" : "s"}">
            ${iconHTML("swords", "ftt-attack-icon")}<strong>${fmtMatchupScore(matchupProfile.attackScore)}</strong><small>· ${matchupProfile.attackCount}</small>
          </span>
          <span class="matchup-score matchup-score-defence" aria-label="Defence advantage ${fmtMatchupScore(matchupProfile.defenceScore)}, ${matchupProfile.defenceCount} favorable fixture${matchupProfile.defenceCount === 1 ? "" : "s"}">
            ${iconHTML("shield-half", "ftt-defence-icon")}<strong>${fmtMatchupScore(matchupProfile.defenceScore)}</strong><small>· ${matchupProfile.defenceCount}</small>
          </span>
        </div>`
      : "";
    const infoButton = showTeamInfo
      ? `<button type="button" class="team-rank-info" data-team="${escapeHtml(teamCode)}"
          aria-label="Show ${escapeHtml(teamLabel)} home and away ranks">${iconHTML("info")}</button>`
      : "";
    const headActions = scoreSummary || infoButton
      ? `<div class="ftt-head-actions">${scoreSummary}${infoButton}</div>`
      : "";
    // Sheet titles with badge + player/team — omit the redundant in-body head
    // (and the "Next N" line) unless there are matchup score actions to show.
    const sheetMode = options.sheetMode === true;
    let header = "";
    if (sheetMode) {
      if (headActions) header = `<div class="ftt-head ftt-head-sheet">${headActions}</div>`;
    } else {
      const headName = options.headName || teamLabel;
      header = `<div class="ftt-head">${badgeHTML(teamCode)}<span>${escapeHtml(headName)}</span>
      ${showMeta ? `<span class="ftt-sub">next ${fixtures.length}</span>` : ""}
      ${headActions}
      </div>`;
    }
    if (!fixtures.length) {
      return `${header}<div class="ftt-empty">${showMeta ? "No upcoming fixtures" : "No fixtures in this range"}</div>`;
    }
    const rows = fixtures.map((fx) => {
      const stats = opponentStatsForFixture(fx);
      const split = fx.ha === "H" ? "away" : "home";
      const verdict = showMatchups ? matchupVerdictCell(teamCode, fx, rankMaps) : null;
      return `<tr>
        <td class="ftt-gw">${fx.gw}</td>
        <td class="ftt-opp"><span>${badgeHTML(fx.opp)}${escapeHtml(fx.opp)}</span></td>
        <td class="ftt-ha">${fx.ha}${fx.ha === "H" ? iconHTML("star", "ftt-home-star") : ""}</td>
        ${fixtureStatCell(fx.opp, split, "xg", stats && stats.xg, 1, highlightMaps, rankMaps)}
        ${fixtureStatCell(fx.opp, split, "goals", stats && stats.goals, 0, highlightMaps, rankMaps)}
        ${fixtureStatCell(fx.opp, split, "xgc", stats && stats.xgc, 1, highlightMaps, rankMaps)}
        ${fixtureStatCell(fx.opp, split, "goalsConceded", stats && stats.goalsConceded, 0, highlightMaps, rankMaps)}
        ${fixtureStatCell(fx.opp, split, "cleanSheets", stats && stats.cleanSheets, 0, highlightMaps, rankMaps)}
        ${verdict ? verdict.html : ""}
      </tr>`;
    }).join("");
    return `${header}<table class="ftt-table${showMatchups ? " ftt-table-matchups" : ""}">
        <thead>
          <tr>
            <th>GW</th>
            <th>Opp</th>
            <th></th>
            <th title="Opponent expected goals rank (venue split)">xG</th>
            <th title="Opponent goals rank (venue split)">G</th>
            <th class="ftt-def-start" title="Opponent expected goals conceded rank (venue split)">xGC</th>
            <th title="Opponent goals conceded rank (venue split)">GC</th>
            <th title="Opponent clean sheets rank (venue split)">CS</th>
            ${showMatchups ? `<th class="ftt-verdict" title="Favorable matchups for ${escapeHtml(teamLabel)}"></th>` : ""}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${showMeta ? `<div class="ftt-note">Opp ranks vs all teams on that venue split (1 = best, 20 = worst; promoted ranks provisional) · soft green = easier, red = tougher (quieter green in dark mode)</div>` : ""}`;
  }

  function fixtureTooltipHTML(teamCode, options = {}) {
    const population = Math.max(
      Object.keys(TEAM_STATS.home || {}).length,
      Object.keys(TEAM_STATS.away || {}).length,
      20
    );
    const tipTopN = Math.max(1, Math.round((population * FIXTURE_TT_ENHANCE_PCT) / 100));
    return fixtureCardHTML(
      teamCode,
      fixtureHighlightMaps(tipTopN),
      fixtureRankMaps(),
      options
    );
  }

  function syncScheduleMatchupControls() {
    // Analyze output is always on for Matchups.
    if (el.scheduleScatter) el.scheduleScatter.style.display = "";
    el.scheduleGrid.classList.add("schedule-grid-matchups", "schedule-grid-analyze");
  }

  // Aggregate qualifying fixture edges into attack and defence scores for the
  // current GW range. Counts explain how many fixtures contributed to each sum.
  function teamMatchupProfile(teamCode, fixtures, rankMaps) {
    let attackCount = 0;
    let defenceCount = 0;
    let attackScore = 0;
    let defenceScore = 0;
    let signedAttackTotal = 0;
    let signedDefenceTotal = 0;
    let signedAttackCount = 0;
    let signedDefenceCount = 0;
    fixtures.forEach((fx) => {
      const edges = matchupEdges(teamCode, fx, rankMaps);
      if (edges.attackEdge != null) {
        signedAttackTotal += edges.attackEdge;
        signedAttackCount += 1;
      }
      if (edges.defenceEdge != null) {
        signedDefenceTotal += edges.defenceEdge;
        signedDefenceCount += 1;
      }
      if (edges.attackOn) {
        attackCount += 1;
        attackScore += edges.attackEdge;
      }
      if (edges.defenceOn) {
        defenceCount += 1;
        defenceScore += edges.defenceEdge;
      }
    });
    return {
      teamCode,
      fixtures,
      attackCount,
      defenceCount,
      attackScore,
      defenceScore,
      totalScore: attackScore + defenceScore,
      edgeCount: attackCount + defenceCount,
      signedAttackAvg: signedAttackCount ? signedAttackTotal / signedAttackCount : 0,
      signedDefenceAvg: signedDefenceCount ? signedDefenceTotal / signedDefenceCount : 0,
      signedAttackCount,
      signedDefenceCount,
    };
  }

  function scheduleQuadrantLabel(attackScore, defenceScore) {
    if (attackScore >= 0 && defenceScore >= 0) return "Favorable attack + defence";
    if (attackScore >= 0) return "Favorable attack";
    if (defenceScore >= 0) return "Favorable defence";
    return "Tough attack + defence";
  }

  function pageInfoIsMobile() {
    return preferMobileSheet();
  }

  function spitRow(symbol, text, symbolClass = "") {
    const cls = symbolClass ? `spit-symbol ${symbolClass}` : "spit-symbol";
    return `<div class="spit-row"><span class="${cls}">${symbol}</span><span>${text}</span></div>`;
  }

  function spitSection(title, rows) {
    return `<div class="spit-section"><h4>${title}</h4><div class="spit-list">${rows.join("")}</div></div>`;
  }

  function spitHead(icon, title) {
    if (pageInfoIsMobile()) return "";
    return `<div class="spit-head">${iconHTML(icon)}<span>${title}</span></div>`;
  }

  function spitIntro(text) {
    return `<p class="spit-intro">${text}</p>`;
  }

  function spitNote(text) {
    return `<div class="spit-note">${text}</div>`;
  }

  function spitRank(label) {
    return `<span class="spit-rank">${label}</span>`;
  }

  function spitMedalsHTML() {
    return `<i class="spit-medal gold"></i><i class="spit-medal silver"></i><i class="spit-medal bronze"></i>`;
  }

  function matchupPageInfoHTML() {
    const mobile = pageInfoIsMobile();
    const iconRows = [
      spitRow(iconHTML("sliders-horizontal"), "Gameweek range, Highlight Ranks, Expected/Actual blend, and Flag threshold."),
      spitRow(
        `${iconHTML("swords", "ftt-attack-icon")} ${iconHTML("shield-half", "ftt-defence-icon")}`,
        "Attack / defence edge when Advantage ≥ Flag threshold."
      ),
    ];
    if (!mobile) {
      iconRows.push(spitRow(iconHTML("info"), "On a card — that club’s own home/away attack &amp; defence ranks."));
    }
    // Static hi-res captures of a real card; pins are HTML overlays (not baked into the PNG).
    return `${spitHead("calendar-days", "How Matchups works")}
      ${spitIntro("Find clubs with a soft upcoming run for attack and/or defence.")}
      ${spitSection("Icons", iconRows)}
      <div class="spit-annotate">
        <p class="spit-annotate-lead">Fixture card key</p>
        <div class="spit-annotate-figure" aria-hidden="true">
          <img class="spit-annotate-img spit-annotate-img-dark" src="img/matchup-card-guide-dark.png" width="888" height="670" alt="" decoding="async" />
          <img class="spit-annotate-img spit-annotate-img-light" src="img/matchup-card-guide-light.png" width="888" height="670" alt="" decoding="async" />
          <ol class="spit-pins">
            <li class="spit-pin" style="--x:74%;--y:6.5%">1</li>
            <li class="spit-pin" style="--x:95.5%;--y:6.5%">2</li>
            <li class="spit-pin" style="--x:21%;--y:20%">3</li>
            <li class="spit-pin" style="--x:41%;--y:20%">4</li>
            <li class="spit-pin" style="--x:93%;--y:20%">5</li>
          </ol>
        </div>
        <ol class="spit-annotate-key">
          <li><span class="spit-pin" aria-hidden="true">1</span><span><strong>Score chips</strong> — sum of Advantages on flagged fixtures, then count.</span></li>
          <li><span class="spit-pin" aria-hidden="true">2</span><span><strong>Info</strong> — this club’s home/away attack &amp; defence ranks.</span></li>
          <li><span class="spit-pin" aria-hidden="true">3</span><span><strong>Home star</strong> — home for the team on the card.</span></li>
          <li><span class="spit-pin" aria-hidden="true">4</span><span><strong>Opp ranks (1–20)</strong> — venue-matched; 1 = strongest. Soft green / tough red cell tint (quieter green in dark mode).</span></li>
          <li><span class="spit-pin" aria-hidden="true">5</span><span><strong>${iconHTML("swords", "ftt-attack-icon")} / ${iconHTML("shield-half", "ftt-defence-icon")}</strong> — flagged attack or defence edge.</span></li>
        </ol>
      </div>
      ${spitNote("Scatter averages every fixture (not only flagged). Promoted clubs use provisional ranks 18–20.")}`;
  }

  function pageInfoTooltipHTML() {
    const mobile = pageInfoIsMobile();

    if (state.page === "home") {
      return `${spitHead("house", "How Home works")}
        ${spitIntro("Live GW dashboard for your Preferences manager + league (auto-subs & chips from last refresh).")}
        ${spitSection("Reading", [
          spitRow(spitRank("GW pts"), "Active picks × multiplier after auto-subs. Bench Boost counts all 15."),
          spitRow(spitRank("MP dots"), "Green = fixture in play. Grey = finished (incl. FPL provisional FT). Kickoff time = not started."),
          spitRow(spitRank("Hot PTS"), "Highlighted when a player has scored 8+ this GW."),
          spitRow(spitRank("IMP"), "Your multiplier share vs league top third (100% unique XI, 200% C, 300% TC). Green ahead, red behind."),
          spitRow(spitRank("Left"), "Standings: in play (green) · still to play among active picks (BB can exceed 11)."),
          spitRow(spitRank("Own"), "Hover/click a squad player or standings manager to cross-highlight shared ownership."),
          ...(mobile
            ? [spitRow(spitRank("Search"), "Search any player: profile replaces summary cards, hides squad, highlights league owners (or hides standings), and shows club fixtures.")]
            : []),
          spitRow(spitRank("Refresh"), "Changing manager/league auto-refreshes Home + owned pins (local server). Or run refresh home."),
        ])}`;
    }

    if (state.page === "rankings") {
      const iconRows = [
        spitRow(spitMedalsHTML(), "Places 1–3 on each card.", "spit-medals"),
        spitRow(spitOwnedPinHTML(), "In your FPL squad (Preferences → Manager)."),
      ];
      const reading = [
        spitRow(spitRank("Place"), "Among the current filters (and any pinned compares) — not the full unfiltered list. Default mins/price cuts stop low-minute Per 90 outliers from taking #1."),
        spitRow(
          spitRank(mobile ? "Tap" : "Pin"),
          mobile
            ? "Tap a row to pin (up to five). Pins stay on every card after you filter (e.g. a mid vs Forwards), sorted by value. Colour key above the cards; clears when switching Players / Teams."
            : "Click to pin up to five. Pins stay on every card after you filter (e.g. a mid vs Forwards), sorted by value. Hover cross-highlights the same name across cards."
        ),
      ];
      return `${spitHead("podium", "How Rankings works")}
        ${spitIntro("Top 10 boards for OPTA and FPL metrics, grouped Key Stats, Attacking, and Defending.")}
        ${spitSection("Icons", iconRows)}
        ${spitSection("Reading", reading)}`;
    }

    if (state.page === "expected") {
      const iconRows = [
        spitRow(spitRank("Cat"), "Category — toolbar dropdown"),
        spitRow(`<i class="spit-expected"></i>`, "Expected value on the track"),
        spitRow(`<i class="spit-easy"></i>`, "Outperforming expectation"),
        spitRow(`<i class="spit-tough"></i>`, "Underperforming expectation"),
        spitRow(`<i class="spit-even"></i>`, "Even — actual ≈ expected"),
        spitRow(spitOwnedPinHTML(), "In your FPL squad"),
      ];
      const reading = [
        ...(state.expectedSplit === "compare"
          ? [spitRow(spitRank("Split"), "Home and away side by side for the same players or teams.")]
          : []),
        spitRow(spitRank("Bar"), "Expected → actual. Moving dashes show the gap direction."),
        spitRow(
          spitRank("Diff"),
          "Actual − expected. Pill intensity scales with gap size. For xGC, a negative Diff can still be green (conceded less than expected)."
        ),
      ];
      const intro = isNextSeason()
        ? "FPL expected vs actual for 2026/27 — home/away from live match venue."
        : "Expected (x) vs actual — who over- or underperformed.";
      return `${spitHead("chart-gantt", "How Expected Data works")}
        ${spitIntro(intro)}
        ${spitSection("Icons", iconRows)}
        ${spitSection("Reading", reading)}
        ${spitNote("Green/red here is over/under vs expectation — not Matchups fixture difficulty. Soft green is quieter in dark mode.")}`;
    }

    if (state.page === "ownership") {
      const reading = [
        spitRow(spitRank("Players"), "Latest check-in’s top 100 owned names after filters. Grey lines until you pick one."),
        spitRow(spitRank("Teams"), "Average ownership of each club’s top 20 most-owned players at that check-in."),
        spitRow(spitRank("Trend"), "Last / Last 3 / Last 7 in Filters picks the lookback. Top 5 risers and fallers are ranked across the full ownership set (team/position chips only hide lines). Matching movers color green or red; everyone else stays grey. The chart x-axis zooms to the window."),
        spitRow(spitRank("Axis"), "X is a snapshot date, not a gameweek. Y zooms to the lines on screen."),
        spitRow(spitRank(mobile ? "Tap" : "Select"), mobile
          ? "Tap a line or a Riser/Faller to pin it. A selection card appears above the chart — use ✕ to clear."
          : "Click a Riser/Faller (or a line) to pin it in club color; other lines go faint. Click again or empty space to unpin. Hover a line for the player/club card."),
      ];
      return `${spitHead("trending-up", "How Ownership works")}
        ${spitIntro("FPL selected-by% (TSB%) across saved check-ins.")}
        ${spitSection("Reading", reading)}
        ${spitNote("This page reads the saved ownership cache — it does not call the FPL API live.")}`;
    }

    if (state.page === "markets") {
      const iconRows = [
        spitRow(spitRank("View"), mobile ? "Goals and CS% or Scoreline — in Markets filters" : "Goals and CS% or Scoreline — next to the slider button"),
        spitRow(iconHTML("sliders-horizontal"), "Color thresholds and Compare window"),
      ];
      const reading = [
        spitRow(spitRank("Goals"), "Poisson λ from de-vigged 1X2 + totals — projected goals per side."),
        spitRow(spitRank("CS%"), "P(opponent scores 0) under that model — not a native book market."),
        spitRow(spitRank("Scoreline"), "Exact-score matrix (% in cells). Goals view lists top likely scores."),
        spitRow(spitRank("Color"), "Green/red bands on Goals and CS%; deeper past the threshold. Soft green is quieter in dark mode."),
        spitRow(spitRank("Compare"), "Last run or Last 72 hr — movement vs prior odds pull."),
      ];
      return `${spitHead("candlestick", "How Markets works")}
        ${spitIntro("Upcoming PL fixtures: projected goals, clean-sheet %, and likely scorelines from bookmaker odds.")}
        ${spitSection("Icons", iconRows)}
        ${spitSection("Reading", reading)}`;
    }

    if (state.page === "team") {
      const iconRows = [
        spitRow(iconHTML("plus"), "Empty row — add a player of that position (Planner only)"),
        spitRow(
          spitRank("Row"),
          mobile
            ? "Tap a planner player for captain, vice, bench, replace, or remove."
            : "Right-click a planner player for captain, vice, bench, replace, or remove."
        ),
        spitRow(iconHTML("scale"), "Compare — pick up to 5 players in the squad or picker"),
      ];
      const reading = [
        spitRow(spitRank("Actual"), "Read-only copy of your linked manager squad from the FPL API."),
        spitRow(spitRank("Planner"), "Editable local draft. Survives refresh. Resync in Preferences overwrites it from Actual."),
        spitRow(spitRank("Rules"), "15 players · £100.0m · max 3 per club · 2 GKP / 5 DEF / 5 MID / 3 FWD."),
        spitRow(spitRank("XI"), "Formation follows starters (3–5 DEF, 2–5 MID, 1–3 FWD). Bench holds the rest."),
        spitRow(spitRank("Stats"), `Pts, xPts, xGI, xG, xA from ${teamStatsSeasonLabel()} (matched by FPL code). Green cell wash is rank among that position (same top-% band as Statistics Enhance). New signings / zero rows show –.`),
        spitRow(spitRank("Form"), "Sparkline of mock recent form. Tap it (or the column header) to switch to TSB% from ownership check-ins."),
        spitRow(spitRank("Set pieces"), "PK / FK / CK — FPL #1 (green check). FK/CK also show #2."),
        spitRow(spitRank("Heat"), "Six fixture columns from the selected gameweek (left of the line). Defaults to the next GW once the current one has started, so you can plan ahead."),
        spitRow(
          spitRank("Select"),
          mobile
            ? "Empty slot or Replace opens the player list and search. Back or Escape returns to the squad. Budget stats hide while picking."
            : "Empty slot or Replace opens the player list and search. Filters (including Affordable) open then. Back or Escape returns to the squad."
        ),
        spitRow(spitRank("Affordable"), "In Filters while picking — hides anyone above remaining Bank. Replace credits the outgoing player's price."),
        spitRow(spitRank("Squad"), "Preferences → Resync or Clear planner. Actual is unchanged by Clear."),
        spitRow(spitRank("Pins"), mobile
          ? "Compare mode — tap squad or picker rows to pin up to 5. Compare mode is off while pins exist."
          : "Compare mode — click squad or picker rows to pin up to 5. Compare mode is off while pins exist."),
        spitRow(spitRank("Compare"), "With no pins, Compare mode selects instead of add/replace. Hover a squad or result row to highlight stat winners."),
        spitRow(spitRank("Prices"), "2026/27 FPL list. Link a Manager in Preferences to import Actual."),
      ];
      const intro = state.teamMode === "actual"
        ? "Read-only view of your linked FPL squad. Switch to Planner to draft changes."
        : "Editable 15-man planner within £100.0m. Resync in Preferences replaces this with your linked Actual team.";
      return `${spitHead("shirt", "How Team works")}
        ${spitIntro(intro)}
        ${spitSection("Icons", iconRows)}
        ${spitSection("Reading", reading)}`;
    }

    if (state.page === "schedule") {
      return matchupPageInfoHTML();
    }

    // Statistics (default)
    const iconRows = [
      spitRow(iconHTML("refresh-ccw-dot"), "2026/27 matched price, club, and position on 2025/26 rows"),
      spitRow(iconHTML("scale"), "Compare — tap the toolbar button, then pick up to five rows"),
    ];
    iconRows.push(
      spitRow(spitOwnedPinHTML(), "In your FPL squad (Preferences → Manager)"),
      spitRow(
        spitCheckMarkHTML("spit-check-mark spit-check-mark--threshold"),
        "DefCon check — earned DC points by hitting the match threshold (DEF 10 CBIT / MID·FWD 12 CBIRT). Not a per-90 rate. Blue in light mode, red in dark mode."
      ),
      spitRow(
        spitCheckMarkHTML("spit-check-mark spit-check-mark--setpiece"),
        "Set-piece — FPL #1 (green check). FK/CK also show #2."
      ),
      spitRow(iconHTML("triangle-alert", "source-unsupported"), "Source can’t fill this cell")
    );
    const reading = [
      spitRow(spitRank("TSB%"), "FPL selected-by-% from the latest ownership check-in."),
      spitRow(
        spitRank("Tint"),
        "Green/red Highlight Top/Bottom on raw values (default top/bottom 5% for Players). Bands vs all Players/Teams — filters don’t shrink them unless Relative is on. Stronger wash when a leader pulls clear of the band; soft green is quieter in dark mode."
      ),
      spitRow(
        spitRank("Fixtures"),
        mobile
          ? "Tap a data cell for upcoming fixtures and opponent ranks by venue."
          : "Click a data cell (not the name column) for upcoming fixtures and opponent ranks by venue. Click again to dismiss."
      ),
      spitRow(spitRank("–"), "Stat doesn’t apply (e.g. saves for an outfielder)."),
    ];
    return `${spitHead("table", "How Statistics works")}
      ${spitIntro("Season OPTA and FPL stats — filter, sort, and compare Players or Teams.")}
      ${spitSection("Icons", iconRows)}
      ${spitSection("Reading", reading)}`;
  }

  function shuffleCopy(items) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function renderScheduleScatter(profiles) {
    if (!el.scheduleScatter) return;
    const maxAttack = Math.max(1, ...profiles.map((p) => Math.abs(p.signedAttackAvg)));
    const maxDefence = Math.max(1, ...profiles.map((p) => Math.abs(p.signedDefenceAvg)));
    // Random DOM order so overlapping badges don't always stack the same way.
    const points = shuffleCopy(profiles).map((profile) => {
      const left = 50 + (profile.signedAttackAvg / maxAttack) * 43;
      const top = 50 - (profile.signedDefenceAvg / maxDefence) * 43;
      const teamLabel = TEAM_NAMES[profile.teamCode] || profile.teamCode;
      const quadrant = scheduleQuadrantLabel(profile.signedAttackAvg, profile.signedDefenceAvg);
      const accent = TEAM_SCATTER_ACCENT[profile.teamCode];
      const accentStyle = accent ? `;--scatter-accent:${accent}` : "";
      return `<button type="button" class="schedule-scatter-point"
        style="left:${left.toFixed(2)}%;top:${top.toFixed(2)}%${accentStyle}"
        data-team="${escapeHtml(profile.teamCode)}"
        data-attack="${profile.signedAttackAvg}"
        data-defence="${profile.signedDefenceAvg}"
        data-attack-favorable="${profile.attackCount}"
        data-defence-favorable="${profile.defenceCount}"
        data-attack-included="${profile.signedAttackCount}"
        data-defence-included="${profile.signedDefenceCount}"
        aria-label="${escapeHtml(`${teamLabel}: attack advantage ${fmtEdge(profile.signedAttackAvg)}, defence advantage ${fmtEdge(profile.signedDefenceAvg)}; ${quadrant}. Click to jump to card.`)}">
        ${badgeHTML(profile.teamCode) || `<span class="schedule-scatter-code">${escapeHtml(profile.teamCode)}</span>`}
      </button>`;
    }).join("");
    el.scheduleScatter.innerHTML = `
      <div class="schedule-scatter-head">
        <div>
          <h3>Schedule balance</h3>
          <p>Average fixture advantage across the selected gameweeks.</p>
        </div>
        <div class="schedule-scatter-key">
          <span>${iconHTML("swords", "ftt-attack-icon")} Better attack →</span>
          <span>${iconHTML("shield-half", "ftt-defence-icon")} Better defence ↑</span>
        </div>
      </div>
      <div class="schedule-scatter-plot">
        <div class="schedule-quadrant schedule-quadrant-defence"></div>
        <div class="schedule-quadrant schedule-quadrant-both"></div>
        <div class="schedule-quadrant schedule-quadrant-tough"></div>
        <div class="schedule-quadrant schedule-quadrant-attack"></div>
        <div class="schedule-scatter-axis schedule-scatter-axis-x"></div>
        <div class="schedule-scatter-axis schedule-scatter-axis-y"></div>
        <span class="schedule-axis-label schedule-axis-x-bad">Worse attacking schedule</span>
        <span class="schedule-axis-label schedule-axis-x-good">Better attacking schedule</span>
        <span class="schedule-axis-label schedule-axis-y-good">Better defensive schedule</span>
        <span class="schedule-axis-label schedule-axis-y-bad">Worse defensive schedule</span>
        <div class="schedule-scatter-points">${points}</div>
      </div>`;
  }

  function scheduleCardHTML(profile, highlightMaps, rankMaps) {
    const noEdges = state.scheduleMatchups && profile.edgeCount === 0;
    return `<article class="schedule-card${noEdges ? " schedule-card-no-edges" : ""}"
      id="schedule-card-${escapeHtml(profile.teamCode)}"
      data-team="${escapeHtml(profile.teamCode)}">${fixtureCardHTML(
      profile.teamCode,
      highlightMaps,
      rankMaps,
      {
        fixtures: profile.fixtures,
        showMeta: false,
        showTeamInfo: true,
        showMatchups: state.scheduleMatchups,
        matchupProfile: state.scheduleMatchups ? profile : null,
      }
    )}</article>`;
  }

  let scheduleCardFlashTimer = null;

  function focusScheduleCard(teamCode) {
    if (!teamCode || !el.scheduleGrid) return;
    const card = el.scheduleGrid.querySelector(`.schedule-card[data-team="${CSS.escape(teamCode)}"]`);
    if (!card) return;
    hideScheduleScatterTooltip();
    $$(".schedule-card.schedule-card-flash").forEach((elCard) => {
      elCard.classList.remove("schedule-card-flash");
    });
    if (scheduleCardFlashTimer) {
      clearTimeout(scheduleCardFlashTimer);
      scheduleCardFlashTimer = null;
    }
    // Force a reflow so re-clicking the same badge restarts the pulse.
    void card.offsetWidth;
    card.classList.add("schedule-card-flash");
    card.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" });
    scheduleCardFlashTimer = setTimeout(() => {
      card.classList.remove("schedule-card-flash");
      scheduleCardFlashTimer = null;
    }, 2400);
  }

  function renderSchedule() {
    hideTeamRankTooltip();
    hideMatchupEdgeTooltip();
    hideScheduleScatterTooltip();
    hidePageInfoTooltip();
    syncScheduleMatchupControls();
    const teamCodes = Object.keys(FIXTURES_BY_TEAM).sort((a, b) =>
      (TEAM_NAMES[a] || a).localeCompare(TEAM_NAMES[b] || b)
    );
    const highlightMaps = fixtureHighlightMaps();
    const rankMaps = fixtureRankMaps();
    const profiles = teamCodes.map((teamCode) => {
      const fixtures = (FIXTURES_BY_TEAM[teamCode] || []).filter((fixture) =>
        fixture.gw >= state.scheduleGwMin && fixture.gw <= state.scheduleGwMax
      );
      return teamMatchupProfile(teamCode, fixtures, rankMaps);
    });

    renderScheduleScatter(profiles);
    el.scheduleGrid.innerHTML = profiles.map((profile) =>
      scheduleCardHTML(profile, highlightMaps, rankMaps)
    ).join("");
    upgradeNativeTitles(el.scheduleGrid);

    el.scheduleRangeLabel.textContent =
      state.scheduleGwMin === state.scheduleGwMax
        ? `GW${state.scheduleGwMin}`
        : `GW${state.scheduleGwMin}–GW${state.scheduleGwMax}`;
  }

  function popupDelayMs() {
    return FIXTURE_TT_DELAY_MS;
  }
  let fixtureTtTimer = null;
  let fixtureTtActiveTeam = null;
  let fixtureTtPendingTeam = null;
  let fixtureTtPendingTr = null;
  let fixtureTtPointer = { x: 0, y: 0 };
  let fixtureTtActiveTr = null;

  function hideFixtureTooltip() {
    if (!el.fixtureTooltip) return;
    el.fixtureTooltip.style.display = "none";
    el.fixtureTooltip.innerHTML = "";
    fixtureTtActiveTeam = null;
    fixtureTtActiveTr = null;
    fixtureTtPendingTeam = null;
    fixtureTtPendingTr = null;
  }

  function positionFixtureTooltip() {
    const tip = el.fixtureTooltip;
    tip.style.display = "block";
    tip.style.visibility = "hidden";
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;

    let left = fixtureTtPointer.x + 16;
    let top = fixtureTtPointer.y + 16;
    if (left + tipW > window.innerWidth - 8) left = fixtureTtPointer.x - tipW - 16;
    if (top + tipH > window.innerHeight - 8) top = fixtureTtPointer.y - tipH - 16;
    if (left < 8) left = 8;
    if (top < 8) top = 8;

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = "visible";
  }

  function showFixtureTooltip(tr) {
    const teamCode = tr.dataset.team;
    if (!teamCode || !el.fixtureTooltip) return;
    // Row may have been re-rendered while the delay was pending.
    if (!tr.isConnected) return;
    hideUiTooltip();
    fixtureTtActiveTeam = teamCode;
    fixtureTtActiveTr = tr;
    fixtureTtPendingTeam = null;
    const rowName = (tr.dataset.rowName || "").trim();
    const headName = state.view === "players" && rowName ? rowName : null;
    el.fixtureTooltip.innerHTML = fixtureTooltipHTML(
      teamCode,
      headName ? { headName } : {}
    );
    positionFixtureTooltip();
  }

  function toggleFixtureTooltipFromClick(tr, event) {
    const teamCode = tr && tr.dataset.team;
    if (!teamCode || !el.fixtureTooltip) return;
    fixtureTtPointer = { x: event.clientX, y: event.clientY };
    clearTimeout(fixtureTtTimer);
    if (
      fixtureTtActiveTr === tr &&
      fixtureTtActiveTeam === teamCode &&
      el.fixtureTooltip.style.display !== "none"
    ) {
      hideFixtureTooltip();
      return;
    }
    showFixtureTooltip(tr);
  }

  function isSourceWarningTarget(target) {
    return target instanceof Element && !!target.closest(".source-unsupported");
  }

  function isFixtureTtNameColumnTarget(node) {
    return !!(node && node.closest && node.closest("td.col-player, td.col-name"));
  }

  function isFixtureTtIconTipTarget(node) {
    // Compact [data-tip] icons (threshold check, set-piece, etc.) own the hover —
    // don't stack the fixtures card tip underneath them.
    return !!tipTargetFrom(node);
  }

  function bindFixtureTooltipSurface(tbody, scrollRoot) {
    if (!tbody) return;
    tbody.addEventListener("mousemove", (e) => {
      if (!hasFineHover()) return;
      if (el.fixtureTooltip.style.display === "none") return;
      if (!fixtureTtActiveTr || !fixtureTtActiveTr.contains(e.target)) return;
      if (
        isSourceWarningTarget(e.target) ||
        isFixtureTtNameColumnTarget(e.target) ||
        isFixtureTtIconTipTarget(e.target)
      ) {
        return;
      }
      fixtureTtPointer = { x: e.clientX, y: e.clientY };
      if (fixtureTtActiveTeam) positionFixtureTooltip();
    });
    tbody.addEventListener("mouseout", (e) => {
      if (!hasFineHover()) return;
      if (!fixtureTtActiveTr || el.fixtureTooltip.style.display === "none") return;
      const fromRow = e.target.closest("tbody tr[data-team]");
      if (fromRow !== fixtureTtActiveTr) return;
      const to = e.relatedTarget;
      if (to instanceof Node && fixtureTtActiveTr.contains(to)) return;
      hideFixtureTooltip();
    });
    tbody.addEventListener("click", (e) => {
      if (state.page !== "opta") return;
      if (state.compareMode) return; // row click selects for compare
      if (e.target.closest("a, button")) return;
      if (isFixtureTtNameColumnTarget(e.target)) {
        hideFixtureTooltip();
        return;
      }
      const tr = e.target.closest("tbody tr[data-team]");
      if (!tr || !tbody.contains(tr)) {
        hideFixtureTooltip();
        return;
      }
      const team = tr.dataset.team;
      if (!team) return;

      if (hasFineHover()) {
        e.stopPropagation();
        toggleFixtureTooltipFromClick(tr, e);
        return;
      }

      clearTimeout(fixtureTtTimer);
      hideFixtureTooltip();
      const rowName = (tr.dataset.rowName || "").trim();
      const teamLabel = TEAM_NAMES[team] || team;
      const title = state.view === "players" && rowName ? rowName : teamLabel;
      const key = `fixture:${team}:${rowName || team}`;
      if (mobileSheetOpen && mobileSheetKey === key) {
        closeMobileSheet();
        return;
      }
      openMobileSheet({
        title,
        titleHtml: `${badgeHTML(team)}<span>${escapeHtml(title)}</span>`,
        html: fixtureTooltipHTML(team, { sheetMode: true }),
        key,
      });
    });
    if (scrollRoot) {
      scrollRoot.addEventListener("scroll", () => {
        clearTimeout(fixtureTtTimer);
        hideFixtureTooltip();
      }, { passive: true });
    }
  }

  bindFixtureTooltipSurface(el.tableBody, el.tableBody && el.tableBody.closest(".table-wrap"));
  bindFixtureTooltipSurface(el.compareBody, el.compareWrap && el.compareWrap.querySelector(".compare-table-wrap"));

  document.addEventListener("click", (e) => {
    if (!el.fixtureTooltip || el.fixtureTooltip.style.display === "none") return;
    if (!hasFineHover()) return;
    if (e.target.closest("#fixture-tooltip")) return;
    if (e.target.closest("#opta-page tbody tr[data-team], #compare-body tr[data-team]")) return;
    hideFixtureTooltip();
  });

  let teamRankPointer = { x: 0, y: 0 };

  function hideTeamRankTooltip() {
    if (!el.teamRankTooltip) return;
    el.teamRankTooltip.style.display = "none";
    el.teamRankTooltip.innerHTML = "";
    $$(".team-rank-info[aria-expanded='true']").forEach((button) => {
      button.setAttribute("aria-expanded", "false");
    });
  }

  function positionTeamRankTooltip() {
    const tip = el.teamRankTooltip;
    if (!tip) return;
    tip.style.display = "block";
    tip.style.visibility = "hidden";
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    let left = teamRankPointer.x + 12;
    let top = teamRankPointer.y + 12;
    if (left + tipW > window.innerWidth - 8) left = teamRankPointer.x - tipW - 12;
    if (top + tipH > window.innerHeight - 8) top = teamRankPointer.y - tipH - 12;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
    tip.style.visibility = "visible";
  }

  function showTeamRankTooltip(button, event) {
    if (!button || !el.teamRankTooltip) return;
    const teamCode = button.dataset.team;
    if (!teamCode) return;
    hideUiTooltip();
    if (event) {
      teamRankPointer = { x: event.clientX, y: event.clientY };
    } else {
      const rect = button.getBoundingClientRect();
      teamRankPointer = { x: rect.right, y: rect.bottom };
    }
    button.setAttribute("aria-expanded", "true");
    el.teamRankTooltip.innerHTML = teamRankTooltipHTML(teamCode);
    positionTeamRankTooltip();
  }

  let matchupEdgePointer = { x: 0, y: 0 };

  function hideMatchupEdgeTooltip() {
    if (!el.matchupEdgeTooltip) return;
    el.matchupEdgeTooltip.style.display = "none";
    el.matchupEdgeTooltip.innerHTML = "";
    matchupEdgeActiveCell = null;
  }

  function positionMatchupEdgeTooltip() {
    const tip = el.matchupEdgeTooltip;
    if (!tip) return;
    tip.style.display = "block";
    tip.style.visibility = "hidden";
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    let left = matchupEdgePointer.x + 14;
    let top = matchupEdgePointer.y + 14;
    if (left + tipW > window.innerWidth - 8) left = matchupEdgePointer.x - tipW - 14;
    if (top + tipH > window.innerHeight - 8) top = matchupEdgePointer.y - tipH - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
    tip.style.visibility = "visible";
  }

  function edgesFromVerdictCell(cell) {
    const num = (key) => {
      const raw = cell.dataset[key];
      if (raw == null || raw === "") return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    const attackEdge = num("attackEdge");
    const defenceEdge = num("defenceEdge");
    return {
      attackEdge,
      defenceEdge,
      ourAttack: num("ourAttack"),
      ourDefence: num("ourDefence"),
      theirAttack: num("theirAttack"),
      theirDefence: num("theirDefence"),
      attackOn: attackEdge != null,
      defenceOn: defenceEdge != null,
    };
  }

  function showMatchupEdgeTooltip(cell, event) {
    if (!cell || !el.matchupEdgeTooltip || !cell.classList.contains("ftt-verdict-tip")) return;
    hideUiTooltip();
    if (event) {
      matchupEdgePointer = { x: event.clientX, y: event.clientY };
    } else {
      const rect = cell.getBoundingClientRect();
      matchupEdgePointer = { x: rect.right, y: rect.bottom };
    }
    matchupEdgeActiveCell = cell;
    el.matchupEdgeTooltip.innerHTML = matchupEdgeTooltipHTML(edgesFromVerdictCell(cell));
    positionMatchupEdgeTooltip();
  }

  let scheduleHoverTimer = null;
  el.scheduleGrid.addEventListener("mouseover", (event) => {
    if (!hasFineHover()) return;
    // Compact icon tips (slider info, etc.) take priority — don't open card tips underneath.
    if (tipTargetFrom(event.target) || (el.uiTooltip && el.uiTooltip.classList.contains("visible"))) {
      clearTimeout(scheduleHoverTimer);
      return;
    }
    const button = event.target.closest(".team-rank-info");
    const verdict = event.target.closest(".ftt-verdict-tip");
    if (!button && !verdict) return;
    const x = event.clientX;
    const y = event.clientY;
    clearTimeout(scheduleHoverTimer);
    scheduleHoverTimer = setTimeout(() => {
      if (button) {
        hideMatchupEdgeTooltip();
        showTeamRankTooltip(button, { clientX: x, clientY: y });
        return;
      }
      hideTeamRankTooltip();
      showMatchupEdgeTooltip(verdict, { clientX: x, clientY: y });
    }, popupDelayMs());
  });
  el.scheduleGrid.addEventListener("mousemove", (event) => {
    if (!hasFineHover()) return;
    if (tipTargetFrom(event.target) || (el.uiTooltip && el.uiTooltip.classList.contains("visible"))) {
      hideMatchupEdgeTooltip();
      hideTeamRankTooltip();
      return;
    }
    const button = event.target.closest(".team-rank-info");
    if (button && el.teamRankTooltip && el.teamRankTooltip.style.display !== "none") {
      teamRankPointer = { x: event.clientX, y: event.clientY };
      positionTeamRankTooltip();
      return;
    }
    const verdict = event.target.closest(".ftt-verdict-tip");
    if (verdict && el.matchupEdgeTooltip && el.matchupEdgeTooltip.style.display !== "none") {
      matchupEdgePointer = { x: event.clientX, y: event.clientY };
      positionMatchupEdgeTooltip();
    }
  });
  el.scheduleGrid.addEventListener("mouseout", (event) => {
    if (!hasFineHover()) return;
    const button = event.target.closest(".team-rank-info");
    if (button && !(event.relatedTarget && button.contains(event.relatedTarget))) {
      clearTimeout(scheduleHoverTimer);
      hideTeamRankTooltip();
    }
    const verdict = event.target.closest(".ftt-verdict-tip");
    if (verdict && !(event.relatedTarget && verdict.contains(event.relatedTarget))) {
      clearTimeout(scheduleHoverTimer);
      hideMatchupEdgeTooltip();
    }
  });
  function openTeamRankSheet(teamCode) {
    if (!teamCode) return;
    const key = `team-rank:${teamCode}`;
    if (mobileSheetOpen && mobileSheetKey === key) {
      closeMobileSheet();
      return;
    }
    const teamLabel = TEAM_NAMES[teamCode] || teamCode;
    $$(".team-rank-info[aria-expanded='true']").forEach((button) => {
      button.setAttribute("aria-expanded", "false");
    });
    openMobileSheet({
      title: teamLabel,
      html: teamRankTooltipHTML(teamCode),
      key,
    });
    const btn =
      el.scheduleGrid &&
      el.scheduleGrid.querySelector(`.team-rank-info[data-team="${CSS.escape(teamCode)}"]`);
    if (btn) btn.setAttribute("aria-expanded", "true");
  }

  el.scheduleGrid.addEventListener("click", (event) => {
    if (hasFineHover()) return;
    if (event.target.closest("#mobile-sheet")) return;

    const verdict = event.target.closest(".ftt-verdict-tip");
    if (verdict) {
      event.preventDefault();
      event.stopPropagation();
      hideTeamRankTooltip();
      if (matchupEdgeActiveCell === verdict) {
        hideMatchupEdgeTooltip();
      } else {
        showMatchupEdgeTooltip(verdict, event);
      }
      return;
    }

    const button = event.target.closest(".team-rank-info");
    if (button) {
      event.preventDefault();
      event.stopPropagation();
      hideMatchupEdgeTooltip();
      openTeamRankSheet(button.dataset.team);
      return;
    }

    const card = event.target.closest(".schedule-card");
    if (card && card.dataset.team) {
      event.preventDefault();
      hideMatchupEdgeTooltip();
      openTeamRankSheet(card.dataset.team);
      return;
    }

    hideTeamRankTooltip();
    hideMatchupEdgeTooltip();
  });
  el.scheduleGrid.addEventListener("focusin", (event) => {
    if (!hasFineHover()) return;
    const button = event.target.closest(".team-rank-info");
    if (button) showTeamRankTooltip(button);
  });
  el.scheduleGrid.addEventListener("focusout", (event) => {
    if (!hasFineHover()) return;
    if (event.target.closest(".team-rank-info")) hideTeamRankTooltip();
  });

  let pageInfoAnchor = null;

  function pageInfoButtons() {
    return $$(".page-info-btn");
  }

  function activePageInfoBtn() {
    const pane = typeof pagePaneFor === "function" ? pagePaneFor(state.page) : null;
    if (!preferMobileSheet() && pane) {
      const btn = pane.querySelector(".page-info-btn:not(.page-info-nav-btn)");
      if (btn) return btn;
    }
    if (el.pageInfoNavBtn) return el.pageInfoNavBtn;
    if (pane) {
      const btn = pane.querySelector(".page-info-btn:not(.page-info-nav-btn)");
      if (btn) return btn;
    }
    return pageInfoButtons()[0] || null;
  }

  function clearPageInfoExpanded() {
    pageInfoButtons().forEach((btn) => btn.setAttribute("aria-expanded", "false"));
  }

  let pageInfoHoverTimer = null;

  function hidePageInfoTooltip() {
    clearTimeout(pageInfoHoverTimer);
    pageInfoHoverTimer = null;
    if (!el.pageInfoTooltip) return;
    el.pageInfoTooltip.style.display = "none";
    el.pageInfoTooltip.innerHTML = "";
    el.pageInfoTooltip.classList.remove("page-info-annotate");
    clearPageInfoExpanded();
    pageInfoAnchor = null;
  }

  function positionPageInfoTooltip() {
    const tip = el.pageInfoTooltip;
    const anchor = pageInfoAnchor || activePageInfoBtn();
    if (!tip || !anchor) return;
    // Size class before measuring so annotate width/height are correct on first paint.
    tip.classList.toggle("page-info-annotate", !!tip.querySelector(".spit-annotate"));
    tip.style.visibility = "hidden";
    tip.style.display = "block";
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    const rect = anchor.getBoundingClientRect();
    let left = Math.min(rect.left, window.innerWidth - tipW - 8);
    let top = rect.bottom + 10;
    if (top + tipH > window.innerHeight - 8) {
      top = Math.max(8, rect.top - tipH - 10);
    }
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = "visible";
  }

  function syncPageInfoButton() {
    const labels = {
      home: "How Home works",
      opta: "How Statistics works",
      rankings: "How Rankings works",
      expected: "How Expected Data works",
      schedule: "How Matchups works",
      ownership: "How Ownership works",
      markets: "How Markets works",
      team: "How Team works",
    };
    pageInfoButtons().forEach((btn) => {
      const pane = btn.closest(".page-pane");
      let page = state.page;
      if (pane) {
        if (pane.id === "home-page") page = "home";
        else if (pane.id === "opta-page") page = "opta";
        else if (pane.id === "rankings-page") page = "rankings";
        else if (pane.id === "expected-page") page = "expected";
        else if (pane.id === "schedule-page") page = "schedule";
        else if (pane.id === "ownership-page") page = "ownership";
        else if (pane.id === "markets-page") page = "markets";
        else if (pane.id === "team-page") page = "team";
      }
      const label = labels[page] || "How this page works";
      btn.removeAttribute("title");
      btn.removeAttribute("data-tip");
      btn.setAttribute("aria-label", label);
    });
  }

  function showPageInfoTooltip(anchor) {
    const btn = anchor || activePageInfoBtn();
    if (!btn || !el.pageInfoTooltip) return;
    pageInfoAnchor = btn;
    if (preferMobileSheet()) {
      const title = btn.getAttribute("aria-label") || "How this page works";
      const key = `page-info:${state.page}`;
      if (mobileSheetOpen && mobileSheetKey === key) {
        closeMobileSheet();
        return;
      }
      openMobileSheet({
        title,
        html: pageInfoTooltipHTML(),
        key,
      });
      clearPageInfoExpanded();
      btn.setAttribute("aria-expanded", "true");
      return;
    }
    hideUiTooltip();
    hideTeamRankTooltip();
    hideMatchupEdgeTooltip();
    hideScheduleScatterTooltip();
    clearPageInfoExpanded();
    btn.setAttribute("aria-expanded", "true");
    el.pageInfoTooltip.innerHTML = pageInfoTooltipHTML();
    positionPageInfoTooltip();
  }

  document.addEventListener("mouseover", (event) => {
    const btn = event.target.closest && event.target.closest(".page-info-btn");
    if (!btn || preferMobileSheet()) return;
    clearTimeout(pageInfoHoverTimer);
    pageInfoHoverTimer = setTimeout(() => {
      if (!btn.isConnected) return;
      showPageInfoTooltip(btn);
    }, popupDelayMs());
  });
  document.addEventListener("mouseout", (event) => {
    const btn = event.target.closest && event.target.closest(".page-info-btn");
    if (!btn || preferMobileSheet()) return;
    if (event.relatedTarget && btn.contains(event.relatedTarget)) return;
    clearTimeout(pageInfoHoverTimer);
    hidePageInfoTooltip();
  });
  document.addEventListener("click", (event) => {
    const btn = event.target.closest && event.target.closest(".page-info-btn");
    if (!btn) return;
    if (!preferMobileSheet()) return;
    event.preventDefault();
    showPageInfoTooltip(btn);
  });
  document.addEventListener("focusin", (event) => {
    const btn = event.target.closest && event.target.closest(".page-info-btn");
    if (!btn || preferMobileSheet()) return;
    showPageInfoTooltip(btn);
  });
  document.addEventListener("focusout", (event) => {
    const btn = event.target.closest && event.target.closest(".page-info-btn");
    if (!btn || preferMobileSheet()) return;
    if (event.relatedTarget && btn.contains(event.relatedTarget)) return;
    hidePageInfoTooltip();
  });

  let scheduleScatterPointer = { x: 0, y: 0 };
  let scatterHoverTimer = null;

  function hideScheduleScatterTooltip() {
    clearTimeout(scatterHoverTimer);
    scatterHoverTimer = null;
    if (!el.scheduleScatterTooltip) return;
    el.scheduleScatterTooltip.style.display = "none";
    el.scheduleScatterTooltip.innerHTML = "";
  }

  function positionScheduleScatterTooltip() {
    const tip = el.scheduleScatterTooltip;
    if (!tip) return;
    tip.style.display = "block";
    tip.style.visibility = "hidden";
    const tipW = tip.offsetWidth;
    const tipH = tip.offsetHeight;
    let left = scheduleScatterPointer.x + 14;
    let top = scheduleScatterPointer.y + 14;
    if (left + tipW > window.innerWidth - 8) left = scheduleScatterPointer.x - tipW - 14;
    if (top + tipH > window.innerHeight - 8) top = scheduleScatterPointer.y - tipH - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
    tip.style.visibility = "visible";
  }

  function scatterScoreTone(score) {
    if (score > 0.05) return { label: "Favorable", cls: "positive" };
    if (score < -0.05) return { label: "Tough", cls: "negative" };
    return { label: "Neutral", cls: "neutral" };
  }

  function scheduleScatterTooltipHTML(point) {
    const number = (key) => {
      const value = Number(point.dataset[key]);
      return Number.isFinite(value) ? value : 0;
    };
    const teamCode = point.dataset.team;
    const teamLabel = TEAM_NAMES[teamCode] || teamCode;
    const attack = number("attack");
    const defence = number("defence");
    const attackFavorable = number("attackFavorable");
    const defenceFavorable = number("defenceFavorable");
    const attackIncluded = number("attackIncluded");
    const defenceIncluded = number("defenceIncluded");
    const attackTone = scatterScoreTone(attack);
    const defenceTone = scatterScoreTone(defence);
    const range = state.scheduleGwMin === state.scheduleGwMax
      ? `GW${state.scheduleGwMin}`
      : `GW${state.scheduleGwMin}–GW${state.scheduleGwMax}`;
    return `<div class="sst-head">${badgeHTML(teamCode)}<span>${escapeHtml(teamLabel)}</span></div>
      <div class="sst-quadrant">${escapeHtml(scheduleQuadrantLabel(attack, defence))}</div>
      <div class="sst-metrics">
        <div class="sst-metric sst-attack">
          <div class="sst-metric-head">${iconHTML("swords", "ftt-attack-icon")}<span>Attacking schedule</span><strong class="${attackTone.cls}">${escapeHtml(fmtEdge(attack))}</strong></div>
          <div class="sst-metric-sub">${attackTone.label} · ${attackFavorable} of ${attackIncluded} fixtures flagged (≥${state.scheduleEdgeMin} ranks better)</div>
        </div>
        <div class="sst-metric sst-defence">
          <div class="sst-metric-head">${iconHTML("shield-half", "ftt-defence-icon")}<span>Defensive schedule</span><strong class="${defenceTone.cls}">${escapeHtml(fmtEdge(defence))}</strong></div>
          <div class="sst-metric-sub">${defenceTone.label} · ${defenceFavorable} of ${defenceIncluded} fixtures flagged (≥${state.scheduleEdgeMin} ranks better)</div>
        </div>
      </div>
      <div class="sst-context">
        <span>${range}</span><span>${state.scheduleExpectedWeight}% expected / ${100 - state.scheduleExpectedWeight}% actual</span>
      </div>
      <div class="sst-note">Position uses the average advantage across every fixture — tough games pull a team left or down. Flag threshold only affects icons and counts, not badge placement.</div>`;
  }

  function showScheduleScatterTooltip(point, event) {
    if (!point || !el.scheduleScatterTooltip) return;
    hideUiTooltip();
    if (event) {
      scheduleScatterPointer = { x: event.clientX, y: event.clientY };
    } else {
      const rect = point.getBoundingClientRect();
      scheduleScatterPointer = { x: rect.right, y: rect.bottom };
    }
    el.scheduleScatterTooltip.innerHTML = scheduleScatterTooltipHTML(point);
    positionScheduleScatterTooltip();
  }

  if (el.scheduleScatter) {
    el.scheduleScatter.addEventListener("mouseover", (event) => {
      if (!hasFineHover()) return;
      const point = event.target.closest(".schedule-scatter-point");
      if (!point) return;
      const x = event.clientX;
      const y = event.clientY;
      clearTimeout(scatterHoverTimer);
      scatterHoverTimer = setTimeout(() => {
        showScheduleScatterTooltip(point, { clientX: x, clientY: y });
      }, popupDelayMs());
    });
    el.scheduleScatter.addEventListener("mousemove", (event) => {
      if (!hasFineHover()) return;
      const point = event.target.closest(".schedule-scatter-point");
      if (!point || !el.scheduleScatterTooltip || el.scheduleScatterTooltip.style.display === "none") return;
      scheduleScatterPointer = { x: event.clientX, y: event.clientY };
      positionScheduleScatterTooltip();
    });
    el.scheduleScatter.addEventListener("mouseout", (event) => {
      if (!hasFineHover()) return;
      const point = event.target.closest(".schedule-scatter-point");
      if (!point || (event.relatedTarget && point.contains(event.relatedTarget))) return;
      hideScheduleScatterTooltip();
    });
    el.scheduleScatter.addEventListener("focusin", (event) => {
      const point = event.target.closest(".schedule-scatter-point");
      if (point) showScheduleScatterTooltip(point);
    });
    el.scheduleScatter.addEventListener("focusout", (event) => {
      if (event.target.closest(".schedule-scatter-point")) hideScheduleScatterTooltip();
    });
    el.scheduleScatter.addEventListener("click", (event) => {
      const point = event.target.closest(".schedule-scatter-point");
      if (!point) return;
      // Touch: show the tip, then jump — desktop click just jumps (hover already informed).
      if (!hasFineHover()) showScheduleScatterTooltip(point, event);
      focusScheduleCard(point.dataset.team);
    });
  }

  // ---------------------------------------------------------------------
  // Toast notifications
  // ---------------------------------------------------------------------
  let toastTimer = null;
  let toastEl = null;

  function hideToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    if (!toastEl) return;
    const node = toastEl;
    toastEl = null;
    node.classList.remove("visible");
    node.classList.add("leaving");
    window.setTimeout(() => node.remove(), 200);
  }

  function showToast({ title, message, icon = "info", duration = 4200 } = {}) {
    hideToast();
    if (!el.toastRoot) return;
    const node = document.createElement("div");
    node.className = "toast";
    node.setAttribute("role", "status");
    node.innerHTML = `
      <span class="toast-icon">${iconHTML(icon)}</span>
      <div class="toast-body">
        ${title ? `<div class="toast-title">${title}</div>` : ""}
        ${message ? `<div class="toast-msg">${message}</div>` : ""}
      </div>`;
    el.toastRoot.appendChild(node);
    toastEl = node;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => node.classList.add("visible"));
    });
    toastTimer = window.setTimeout(hideToast, duration);
  }

  // ---------------------------------------------------------------------
  // Compare mode
  // ---------------------------------------------------------------------
  function toggleCompareRow(key) {
    const set = compareSet();
    if (set.has(key)) {
      set.delete(key);
    } else if (set.size < MAX_COMPARE) {
      set.add(key);
      hideToast();
    } else {
      showToast({
        title: "Compare",
        message: `You can compare up to ${MAX_COMPARE} ${state.view === "teams" ? "teams" : "players"}.`,
        icon: "scale",
      });
      return false;
    }
    renderTable({ preserveOptaScroll: true });
    return true;
  }

  function compareHighlightMap(selectedRows) {
    const maps = {};
    visibleColumns().forEach((col) => {
      if (!isNumericCol(col) || ENHANCE_EXCLUDE.has(col.key)) return;
      const lowerBetter = LOWER_BETTER.has(col.key);
      const withVals = selectedRows
        .filter((r) => isStatAvailable(r, col))
        .map((r) => ({ key: rowKey(r), val: displayValue(r, col) || 0 }))
        .filter((x) => Math.abs(x.val) > 1e-9);
      if (withVals.length < 2) return;
      const best = lowerBetter
        ? Math.min(...withVals.map((x) => x.val))
        : Math.max(...withVals.map((x) => x.val));
      const winners = new Set(withVals.filter((x) => x.val === best).map((x) => x.key));
      if (winners.size < withVals.length) maps[col.key] = winners;
    });
    return maps;
  }

  function syncComparePanelRows(wrap, body, rowSelector = "tbody tr") {
    if (!wrap) return;
    if (!body) {
      wrap.style.removeProperty("--compare-rows");
      return;
    }
    const count = body.querySelectorAll(rowSelector).length;
    if (count > 0) wrap.style.setProperty("--compare-rows", String(count));
    else wrap.style.removeProperty("--compare-rows");
  }

  function renderCompareTable() {
    const set = compareSet();
    const compareOn = comparePanelVisible();
    if (el.optaPage) el.optaPage.classList.toggle("has-compare", compareOn);
    if (!compareOn) {
      el.compareWrap.style.display = "none";
      syncComparePanelRows(el.compareWrap, null);
      return;
    }
    el.compareWrap.style.display = "";

    const vcols = visibleColumns();
    const allRows = getRows();
    const selectedRows = Array.from(set)
      .map((key) => allRows.find((r) => rowKey(r) === key))
      .filter(Boolean);

    el.compareTitle.textContent = `Comparing ${selectedRows.length} ${state.view}`;

    el.compareHead.innerHTML = "";
    el.compareHead.appendChild(buildSectionRow(vcols));
    el.compareHead.appendChild(buildColumnHeaderRow(vcols));

    const winnerMap = compareHighlightMap(selectedRows);

    el.compareBody.innerHTML = "";
    selectedRows.forEach((r) => {
      const tr = document.createElement("tr");
      const key = rowKey(r);
      const teamCode = currentTeamCode(r);
      if (teamCode) tr.dataset.team = teamCode;
      tr.dataset.rowName = r.name || "";
      tr.classList.add("row-selectable");
      tr.addEventListener("click", () => toggleCompareRow(key));
      vcols.forEach((c, i) => {
        const td = document.createElement("td");
        td.classList.add("col-" + (c.type || "num"));
        if (CORE_COL_KEYS.has(c.key)) td.classList.add("col-core");
        if (isSectionBoundary(vcols, i)) td.classList.add("sec-divider");
        if (
          c.key === "player" &&
          updatesOverlayOn() &&
          playerHasSeasonUpdate(r)
        ) {
          td.classList.add("has-update-change");
        }
        td.innerHTML = cellHTML(r, c);
        if (isNumericCol(c)) {
          if (!isStatApplicable(r, c)) {
            td.classList.add("zero-val");
          } else if (sourceUnsupportedReason(r, c)) {
            td.classList.add("has-source-warning");
          } else {
            const val = displayValue(r, c) || 0;
            if (Math.abs(val) < 1e-9) {
              td.classList.add("zero-val");
            } else if (winnerMap[c.key] && winnerMap[c.key].has(key)) {
              td.classList.add("highlight-top");
              td.style.backgroundColor = positiveFill(0.24);
            }
          }
        }
        tr.appendChild(td);
      });
      el.compareBody.appendChild(tr);
    });
    syncComparePanelRows(el.compareWrap, el.compareBody);
    bindCompareScrollSync();
  }

  // ---------------------------------------------------------------------
  // Columns settings panel
  // ---------------------------------------------------------------------
  function renderColumnsPanel() {
    if (!el.columnsList) return;
    el.columnsList.innerHTML = "";
    // Statistics shows all columns; no toggle UI.
  }

  // ---------------------------------------------------------------------
  // Expected vs. actual page — barbell (dumbbell) chart
  // ---------------------------------------------------------------------
  // Every expected/actual pair we actually have data for. "gi" (xGI vs
  // G+A) and "conceded" (xGC vs GC) apply to players too now; "cs" stays
  // team-only since there's no player-level "expected clean sheets" stat
  // anywhere in the FPL API to pair against actual clean sheets — see
  // expectedCats(). lowerBetter flips the over/underperform color so that,
  // e.g., conceding fewer goals than xGC reads as green even though
  // actual < expected.
  //
  // combinedOnly marks categories whose fields only exist on the combined
  // (season-total) view — the FPL API data backing them (xgc, goalsConceded)
  // has no home/away split. See updateExpectedSplitAvailability().
  const PLAYER_EXPECTED_CATS = [
    { key: "goals", label: "xG vs Goals", expectedKey: "xg", actualKey: "goals", expectedLabel: "xG", actualLabel: "Goals", expectedDecimals: 1, actualDecimals: 0, lowerBetter: false },
    { key: "assists", label: "xA vs Assists", expectedKey: "xa", actualKey: "assists", expectedLabel: "xA", actualLabel: "Assists", expectedDecimals: 1, actualDecimals: 0, lowerBetter: false },
    // combinedOnly only for 2025/26 (history_past has no venue split). 2026/27 has H/A from live+fixtures.
    { key: "gi", label: "xGI vs G+A", expectedKey: "xgi", actualKey: "__gi", expectedLabel: "xGI", actualLabel: "G+A", expectedDecimals: 1, actualDecimals: 0, lowerBetter: false, combinedOnly: true },
    { key: "conceded", label: "xGC vs Conceded", expectedKey: "xgc", actualKey: "goalsConceded", expectedLabel: "xGC", actualLabel: "GC", expectedDecimals: 1, actualDecimals: 0, lowerBetter: true, combinedOnly: true },
  ];
  const TEAM_EXPECTED_CATS = [
    { key: "goals", label: "xG vs Goals", expectedKey: "xg", actualKey: "goals", expectedLabel: "xG", actualLabel: "Goals", expectedDecimals: 1, actualDecimals: 0, lowerBetter: false },
    { key: "conceded", label: "xGC vs Conceded", expectedKey: "xgc", actualKey: "goalsConceded", expectedLabel: "xGC", actualLabel: "GC", expectedDecimals: 1, actualDecimals: 0, lowerBetter: true },
    { key: "cs", label: "xCS vs Clean Sheets", expectedKey: "xcs", actualKey: "cleanSheets", expectedLabel: "xCS", actualLabel: "CS", expectedDecimals: 1, actualDecimals: 0, lowerBetter: false },
  ];
  const EXPECTED_DIFF_EPSILON = 0.05;

  function expectedCats() {
    const cats = state.view === "players" ? PLAYER_EXPECTED_CATS : TEAM_EXPECTED_CATS;
    if (!isNextSeason()) return cats;
    // xCS is Hub/OPTA-only — no FPL equivalent for 2026/27.
    return cats.filter((c) => c.expectedKey !== "xcs" && c.actualKey !== "xcs");
  }

  function currentExpectedCat() {
    const cats = expectedCats();
    return cats.find((c) => c.key === state.expectedCat) || cats[0];
  }

  // score is sign-adjusted so positive always means "outperforming
  // expectation" and negative always means "underperforming" — for
  // lowerBetter categories (xGC) that means actual < expected scores
  // positive, since conceding less than expected is the good outcome.
  function expectedRowValues(row, cat) {
    const expected = row[cat.expectedKey] || 0;
    const actual = row[cat.actualKey] || 0;
    const score = cat.lowerBetter ? expected - actual : actual - expected;
    return { expected, actual, score };
  }

  function expectedPerfClass(score) {
    if (score > EXPECTED_DIFF_EPSILON) return "over";
    if (score < -EXPECTED_DIFF_EPSILON) return "under";
    return "even";
  }

  function sortExpectedRows(rows, cat) {
    const dir = state.expectedSortDir === "asc" ? 1 : -1;
    return rows.slice().sort((a, b) => {
      if (state.expectedSortKey === "name") return dir * a.name.localeCompare(b.name);
      const va = expectedRowValues(a, cat);
      const vb = expectedRowValues(b, cat);
      if (state.expectedSortKey === "expected") return dir * (va.expected - vb.expected);
      if (state.expectedSortKey === "actual") return dir * (va.actual - vb.actual);
      return dir * (va.score - vb.score); // diff — over/underperformance
    });
  }

  function setExpectedCatMenuOpen(open) {
    if (!el.expectedCatToolbar || !el.expectedCatBtn || !el.expectedCatMenu) return;
    if (preferMobileSheet()) open = false;
    el.expectedCatToolbar.classList.toggle("open", open);
    el.expectedCatMenu.classList.toggle("open", open);
    el.expectedCatBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function syncExpectedCatToolbar() {
    if (!el.expectedCatToolbar || !el.expectedCatBtn || !el.expectedCatLabel) return;
    const show = state.page === "expected";
    el.expectedCatToolbar.hidden = !show;
    if (!show) {
      setExpectedCatMenuOpen(false);
      return;
    }
    const cat = currentExpectedCat();
    el.expectedCatLabel.textContent = cat.label;
    el.expectedCatBtn.title = cat.label;
    el.expectedCatBtn.setAttribute("aria-label", `xData category: ${cat.label}`);
    const expanded = preferMobileSheet()
      ? mobileSheetOpen && mobileSheetKey === "expected-cats"
      : el.expectedCatMenu?.classList.contains("open");
    el.expectedCatBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function buildExpectedCatMenu() {
    if (!el.expectedCatMenu) return;
    const cats = expectedCats();
    const active = currentExpectedCat();
    el.expectedCatMenu.innerHTML = "";
    cats.forEach((c) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "menuitem");
      btn.className = "page-tab-menu-item";
      btn.textContent = c.label;
      btn.classList.toggle("active", c.key === active.key);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.expectedCat = c.key;
        setExpectedCatMenuOpen(false);
        if (state.page === "expected") renderExpected();
        else setPage("expected");
        syncExpectedCatToolbar();
      });
      el.expectedCatMenu.appendChild(btn);
    });
  }

  function openExpectedCatSheet() {
    const cats = expectedCats();
    const active = currentExpectedCat();
    const html = `<div class="mobile-sheet-cat-list" role="menu" aria-label="xData categories">${cats
      .map(
        (c) =>
          `<button type="button" role="menuitem" class="page-tab-menu-item${
            c.key === active.key ? " active" : ""
          }" data-expected-cat="${escapeHtml(c.key)}">${escapeHtml(c.label)}</button>`
      )
      .join("")}</div>`;
    openMobileSheet({ title: "xData category", html, key: "expected-cats" });
    if (el.expectedCatBtn) el.expectedCatBtn.setAttribute("aria-expanded", "true");
    if (!el.mobileSheetBody) return;
    el.mobileSheetBody.querySelectorAll("[data-expected-cat]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-expected-cat");
        if (!key) return;
        state.expectedCat = key;
        closeMobileSheet();
        syncExpectedCatToolbar();
        if (state.page === "expected") renderExpected();
        else setPage("expected");
      });
    });
  }

  // Split rows for this page are read independently of the shared
  // Total/Home/Away control (state.split) used by the OPTA table, since only
  // this page supports a 4th "Compare" mode that shows a Home row and an Away
  // row per player/team — a shape the other pages' rendering doesn't understand.
  // Still follows the settings season toggle (2025/26 OPTA vs 2026/27 FPL).
  function expectedSplitRows(split) {
    if (isNextSeason()) {
      const next = season2627Data();
      return state.view === "players" ? next.players[split] : next.teams[split];
    }
    return state.view === "players" ? DATA.players[split] : DATA.teams[split];
  }

  function buildSplitMap(split) {
    const map = new Map();
    expectedSplitRows(split).forEach((r) => map.set(rowKey(r), r));
    return map;
  }

  // Scale sticks just under the head; keep --barbell-head-h in sync so they
  // abut with no gap (and no overlap that would clip axis labels).
  function syncBarbellHeadHeight() {
    const sticky = el.barbellHead && el.barbellHead.parentElement;
    if (!sticky || !el.barbellHead) return;
    sticky.style.setProperty("--barbell-head-h", `${el.barbellHead.offsetHeight}px`);
  }

  function buildExpectedHead(cat) {
    el.barbellHead.innerHTML = "";
    const compareMode = state.expectedSplit === "compare";
    el.barbellHead.classList.toggle("is-compare", compareMode);
    const specs = [
      { key: "name", label: state.view === "players" ? "Player" : "Team", cls: "" },
      ...(compareMode ? [{ key: null, label: "", cls: "bh-loc" }] : []),
      { key: null, label: "", cls: "bh-track" },
      { key: "expected", label: cat.expectedLabel, cls: "" },
      { key: "actual", label: cat.actualLabel, cls: "" },
      { key: "diff", label: "Diff", cls: "" },
    ];
    specs.forEach((s) => {
      const div = document.createElement("div");
      div.className = ("barbell-head-cell " + s.cls).trim();
      div.textContent = s.label;
      if (s.key) {
        if (state.expectedSortKey === s.key) {
          div.classList.add("sorted");
          div.innerHTML = `${escapeHtml(s.label)} ${iconHTML(state.expectedSortDir === "asc" ? "chevron-up" : "chevron-down")}`;
        } else {
          div.textContent = s.label;
        }
        div.addEventListener("click", () => {
          if (state.expectedSortKey === s.key) {
            state.expectedSortDir = state.expectedSortDir === "asc" ? "desc" : "asc";
          } else {
            state.expectedSortKey = s.key;
            state.expectedSortDir = s.key === "name" ? "asc" : "desc";
          }
          renderExpected({ resetScroll: true });
        });
      }
      el.barbellHead.appendChild(div);
    });
    syncBarbellHeadHeight();
  }

  // Floating hover tooltip for barbell dots, positioned against barbell-wrap
  // and scoped to this page's own element.
  function expectedDotTooltipHTML(row, statLabel, value, decimals, locSuffix) {
    const meta = state.view === "players" ? `${row.team} · ${row.position}` : row.team;
    const name = locSuffix ? `${row.name} (${locSuffix})` : row.name;
    return `
      <div class="tt-name">${badgeHTML(row.team)}${escapeHtml(name)}</div>
      <div class="tt-meta">${meta}</div>
      <div class="tt-row"><span>${statLabel}</span><b>${fmtNum(value, decimals)}</b></div>
    `;
  }

  function showExpectedTooltip(evt, html) {
    el.expectedTooltip.innerHTML = html;
    el.expectedTooltip.style.display = "block";
    positionExpectedTooltip(evt);
  }

  function positionExpectedTooltip(evt) {
    const wrapRect = el.barbellWrap.getBoundingClientRect();
    let left = evt.clientX - wrapRect.left + 14;
    let top = evt.clientY - wrapRect.top + 14;
    const ttRect = el.expectedTooltip.getBoundingClientRect();
    if (left + ttRect.width > wrapRect.width) left = evt.clientX - wrapRect.left - ttRect.width - 14;
    if (top + ttRect.height > wrapRect.height) top = evt.clientY - wrapRect.top - ttRect.height - 14;
    el.expectedTooltip.style.left = Math.max(4, left) + "px";
    el.expectedTooltip.style.top = Math.max(4, top) + "px";
  }

  let expectedTipTimer = null;

  function hideExpectedTooltip() {
    clearTimeout(expectedTipTimer);
    expectedTipTimer = null;
    if (!el.expectedTooltip) return;
    el.expectedTooltip.style.display = "none";
    delete el.expectedTooltip.dataset.dot;
  }

  // locSuffix is "Home"/"Away" in Compare mode, null otherwise.
  // maxVal scales the track dots; maxAbsDiff scales Diff pill intensity so
  // near-zero gaps stay faint and the biggest swings in the current list
  // read strongest (gradient-centric around 0).
  // omitIdentity: Compare-mode split rows — H/A tag only; name lives on the group.
  function buildBarbellRow(row, cat, maxVal, maxAbsDiff, locSuffix, { omitIdentity = false } = {}) {
    const { expected, actual, score } = expectedRowValues(row, cat);
    const perf = expectedPerfClass(score);
    const pctExpected = Math.max(0, Math.min(100, (expected / maxVal) * 100));
    const pctActual = Math.max(0, Math.min(100, (actual / maxVal) * 100));
    const lo = Math.min(pctExpected, pctActual);
    const hi = Math.max(pctExpected, pctActual);

    const div = document.createElement("div");
    div.className = "barbell-row";
    if (locSuffix) div.classList.add(locSuffix === "Home" ? "loc-home" : "loc-away");
    if (omitIdentity) div.classList.add("is-split");

    if (omitIdentity) {
      const loc = document.createElement("div");
      loc.className = "barbell-loc";
      loc.innerHTML = `<span class="loc-tag">${locSuffix === "Home" ? "Home" : "Away"}</span>`;
      div.appendChild(loc);
    } else {
      const label = document.createElement("div");
      label.className = "barbell-label";
      if (row.code != null) label.dataset.playerCode = String(row.code);
      if (row.team) label.dataset.team = String(currentTeamCode(row) || row.team);
      label.dataset.rowName = row.name || "";
      label.dataset.rowKey = String(rowKey(row));
      const tagHTML = locSuffix
        ? `<span class="loc-tag">${locSuffix === "Home" ? "H" : "A"}</span>`
        : "";
      let subHTML = "";
      if (state.view === "players" && row.position) {
        subHTML = `<div class="player-cell-sub">${posBadgeHTML(row.position)}${tagHTML}</div>`;
      } else if (state.view === "teams") {
        const leaguePos = LEAGUE_POSITIONS[row.team];
        const seasonLabel = LEAGUE_POSITIONS_META.seasonLabel || "Premier League";
        const leagueHTML =
          leaguePos != null
            ? `<span class="team-league-pos"${tipAttr(`${leaguePos}${ordinalSuffix(leaguePos)} in the ${seasonLabel}`)}>${leaguePos}${ordinalSuffix(leaguePos)}</span>`
            : "";
        if (leagueHTML || tagHTML) {
          subHTML = `<div class="player-cell-sub">${leagueHTML}${tagHTML}</div>`;
        }
      } else if (tagHTML) {
        subHTML = `<div class="player-cell-sub">${tagHTML}</div>`;
      }
      label.innerHTML = playerIdentityHTML(
        playerCrestHTML(row.team),
        playerNameHTML(row),
        subHTML
      );
      setTip(label, state.view === "players" ? `${row.name} — ${row.team}, ${row.position}` : row.name);
      div.appendChild(label);
    }

    const track = document.createElement("div");
    track.className = "barbell-track";
    const flowDir =
      perf === "even" || Math.abs(pctActual - pctExpected) < 0.4
        ? ""
        : pctActual > pctExpected
          ? "flow-right"
          : "flow-left";
    const antsHTML = flowDir
      ? `<div class="barbell-ants-clip"><div class="barbell-ants" aria-hidden="true"></div></div>`
      : "";
    track.innerHTML = `
      <div class="barbell-connector ${perf}${flowDir ? ` ${flowDir}` : ""}" style="left:${lo}%; width:${Math.max(0, hi - lo)}%">${antsHTML}</div>
      <div class="barbell-dot expected" style="left:${pctExpected}%"></div>
      <div class="barbell-dot actual ${perf}" style="left:${pctActual}%"></div>
    `;
    const expDot = track.querySelector(".barbell-dot.expected");
    const actDot = track.querySelector(".barbell-dot.actual");
    [
      [expDot, cat.expectedLabel, expected, cat.expectedDecimals],
      [actDot, cat.actualLabel, actual, cat.actualDecimals],
    ].forEach(([dot, statLabel, value, decimals]) => {
      const tipHTML = () => expectedDotTooltipHTML(row, statLabel, value, decimals, locSuffix);
      dot.addEventListener("mouseenter", (evt) => {
        if (!hasFineHover()) return;
        clearTimeout(expectedTipTimer);
        const html = tipHTML();
        const x = evt.clientX;
        const y = evt.clientY;
        expectedTipTimer = setTimeout(() => {
          showExpectedTooltip({ clientX: x, clientY: y }, html);
        }, popupDelayMs());
      });
      dot.addEventListener("mousemove", (evt) => {
        if (!hasFineHover()) return;
        positionExpectedTooltip(evt);
      });
      dot.addEventListener("mouseleave", () => {
        if (!hasFineHover()) return;
        hideExpectedTooltip();
      });
      dot.addEventListener("click", (evt) => {
        if (hasFineHover()) return;
        evt.stopPropagation();
        if (el.expectedTooltip && el.expectedTooltip.style.display !== "none" && el.expectedTooltip.dataset.dot === String(statLabel)) {
          hideExpectedTooltip();
          delete el.expectedTooltip.dataset.dot;
          return;
        }
        showExpectedTooltip(evt, tipHTML());
        if (el.expectedTooltip) el.expectedTooltip.dataset.dot = String(statLabel);
      });
    });
    div.appendChild(track);

    const expEl = document.createElement("div");
    expEl.className = "barbell-value";
    expEl.textContent = fmtNum(expected, cat.expectedDecimals);
    div.appendChild(expEl);

    const actEl = document.createElement("div");
    actEl.className = "barbell-value";
    actEl.textContent = fmtNum(actual, cat.actualDecimals);
    div.appendChild(actEl);

    const diffEl = document.createElement("div");
    diffEl.className = "barbell-value";
    const diffRaw = actual - expected;
    const diffText = (diffRaw > 0 ? "+" : "") + fmtNum(diffRaw, cat.expectedDecimals);
    const intensity = maxAbsDiff > 0 ? Math.min(1, Math.abs(diffRaw) / maxAbsDiff) : 0;
    // Sqrt softens mid-range so values near zero stay clearly faint.
    const t = Math.sqrt(intensity);
    const bgA = (0.04 + t * 0.22).toFixed(3);
    const fgA = (0.4 + t * 0.6).toFixed(3);
    const pill = document.createElement("span");
    pill.className = `diff-pill ${perf}`;
    pill.textContent = diffText;
    if (perf !== "even") {
      pill.style.setProperty("--diff-a", bgA);
      pill.style.setProperty("--diff-c", fgA);
    }
    diffEl.appendChild(pill);
    div.appendChild(diffEl);

    return div;
  }

  function buildBarbellCompareIdentity(row) {
    const identity = document.createElement("div");
    identity.className = "barbell-group-identity";
    if (row.code != null) identity.dataset.playerCode = String(row.code);
    if (row.team) identity.dataset.team = String(currentTeamCode(row) || row.team);
    identity.dataset.rowName = row.name || "";
    identity.dataset.rowKey = String(rowKey(row));
    let subHTML = "";
    if (state.view === "players" && row.position) {
      subHTML = `<div class="player-cell-sub">${posBadgeHTML(row.position)}</div>`;
    } else if (state.view === "teams") {
      const leaguePos = LEAGUE_POSITIONS[row.team];
      const seasonLabel = LEAGUE_POSITIONS_META.seasonLabel || "Premier League";
      if (leaguePos != null) {
        subHTML = `<div class="player-cell-sub"><span class="team-league-pos"${tipAttr(`${leaguePos}${ordinalSuffix(leaguePos)} in the ${seasonLabel}`)}>${leaguePos}${ordinalSuffix(leaguePos)}</span></div>`;
      }
    }
    identity.innerHTML = playerIdentityHTML(
      playerCrestHTML(row.team),
      playerNameHTML(row),
      subHTML
    );
    setTip(identity, state.view === "players" ? `${row.name} — ${row.team}, ${row.position}` : row.name);
    return identity;
  }

  function buildBarbellCompareGroup(baseRow, homeRow, awayRow, cat, maxVal, maxAbsDiff) {
    const group = document.createElement("div");
    group.className = "barbell-group is-compare";
    group.appendChild(buildBarbellCompareIdentity(baseRow));
    const splits = document.createElement("div");
    splits.className = "barbell-group-splits";
    splits.appendChild(buildBarbellRow(homeRow || baseRow, cat, maxVal, maxAbsDiff, "Home", { omitIdentity: true }));
    splits.appendChild(buildBarbellRow(awayRow || baseRow, cat, maxVal, maxAbsDiff, "Away", { omitIdentity: true }));
    group.appendChild(splits);
    return group;
  }

  // Round a positive value up to a clean 1/1.2/1.5/2/2.5/3/4/5/6/8/10 × 10^n.
  function niceCeil(value) {
    if (!(value > 0) || !Number.isFinite(value)) return 1;
    const exp = Math.floor(Math.log10(value));
    const pow = 10 ** exp;
    const frac = value / pow;
    const candidates = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    const niceFrac = candidates.find((c) => frac <= c + 1e-12) ?? 10;
    return niceFrac * pow;
  }

  // Even ticks from min..max using a 1/2/2.5/5 × 10^n step. Returns
  // { ticks, niceMax } so the plot domain can snap to the last label.
  function niceTicks(min, max, count) {
    const range = Math.max(max - min, Number.EPSILON);
    const rough = range / Math.max(count, 1);
    const exp = Math.floor(Math.log10(rough));
    const pow = 10 ** exp;
    const frac = rough / pow;
    let step;
    if (frac <= 1) step = 1 * pow;
    else if (frac <= 2) step = 2 * pow;
    else if (frac <= 2.5) step = 2.5 * pow;
    else if (frac <= 5) step = 5 * pow;
    else step = 10 * pow;

    const niceMax = Math.ceil(max / step - 1e-9) * step;
    const ticks = [];
    for (let t = min; t <= niceMax + step * 1e-9; t += step) {
      ticks.push(Number((Math.round(t / step) * step).toPrecision(12)));
    }
    return { ticks, niceMax, step };
  }

  function formatScaleTick(t, step, fallbackDecimals) {
    if (step >= 1) return fmtNum(t, 0);
    if (step >= 0.1) return fmtNum(t, 1);
    if (step >= 0.01) return fmtNum(t, 2);
    return fmtNum(t, fallbackDecimals);
  }

  // Scale domain for the barbell chart + Diff pills. Always from the full
  // (unfiltered) universe for the current view/split/category so search and
  // sidebar filters only change which rows appear — not how long a bar looks.
  function expectedScaleDomain(cat, compareMode, baseSplit) {
    let universe = expectedSplitRows(baseSplit).filter((r) =>
      state.view === "players" ? r.mins > 0 : r.gp > 0
    );
    universe = universe.filter((r) => {
      const { expected, actual } = expectedRowValues(r, cat);
      return Math.abs(expected) > 1e-9 || Math.abs(actual) > 1e-9;
    });
    const homeMap = compareMode ? buildSplitMap("home") : null;
    const awayMap = compareMode ? buildSplitMap("away") : null;
    let maxVal = 0;
    let maxAbsDiff = 0;
    universe.forEach((r) => {
      const pool = compareMode
        ? [homeMap.get(rowKey(r)), awayMap.get(rowKey(r))].filter(Boolean)
        : [r];
      pool.forEach((pr) => {
        const { expected, actual } = expectedRowValues(pr, cat);
        maxVal = Math.max(maxVal, expected, actual);
        maxAbsDiff = Math.max(maxAbsDiff, Math.abs(actual - expected));
      });
    });
    maxVal = niceCeil(maxVal * 1.08 || 1);
    const tickInfo = niceTicks(0, maxVal, 4);
    maxVal = tickInfo.niceMax || maxVal;
    return { maxVal, maxAbsDiff, tickInfo };
  }

  // Subtle x-axis ruler, shares the barbell grid so ticks land under the
  // same 0..maxVal scale the dots use.
  function buildExpectedScale(maxVal, cat, tickInfo) {
    const compareMode = state.expectedSplit === "compare";
    el.barbellScale.innerHTML = "";
    el.barbellScale.classList.toggle("is-compare", compareMode);
    el.barbellScale.appendChild(document.createElement("div"));
    if (compareMode) el.barbellScale.appendChild(document.createElement("div"));

    const { ticks, step } = tickInfo || niceTicks(0, maxVal, 4);
    const trackCell = document.createElement("div");
    trackCell.className = "barbell-scale-track";
    ticks.forEach((t) => {
      const pct = Math.max(0, Math.min(100, (t / maxVal) * 100));
      const tick = document.createElement("div");
      tick.className = "barbell-scale-tick";
      tick.style.left = pct + "%";
      const label = document.createElement("span");
      label.textContent = formatScaleTick(t, step, cat.expectedDecimals);
      tick.appendChild(label);
      trackCell.appendChild(tick);
    });
    el.barbellScale.appendChild(trackCell);

    for (let i = 0; i < 3; i++) el.barbellScale.appendChild(document.createElement("div"));
  }

  // Disables Home/Away/Compare on the split segment for combinedOnly
  // categories (no per-split data to show), bouncing the user back to
  // Total if they were sitting on a split that just became unavailable —
  // e.g. switching from "xG vs Goals" to "xGC vs Conceded" while on Home.
  function updateExpectedSplitAvailability(cat) {
    // 2026/27 has venue splits from live+fixtures; combinedOnly only binds 2025/26.
    const restricted = !!cat.combinedOnly && !isNextSeason();
    if (restricted && state.expectedSplit !== "combined") state.expectedSplit = "combined";
    $$("#expected-split-seg button").forEach((b) => {
      const isCombined = b.dataset.split === "combined";
      const disabled = restricted && !isCombined;
      b.disabled = disabled;
      b.classList.toggle("disabled", disabled);
      b.classList.toggle("active", b.dataset.split === state.expectedSplit);
      setTip(b, disabled ? "Combined view only — this stat has no home/away split in the FPL API" : "");
    });
    syncSegThumb(el.expectedSplitSeg);
  }

  function renderExpected(opts = {}) {
    const cat = currentExpectedCat();
    updateExpectedSplitAvailability(cat);
    const compareMode = state.expectedSplit === "compare";
    buildExpectedCatMenu();
    syncExpectedCatToolbar();
    hideExpectedTooltip();

    el.expectedTitle.querySelector(".page-title-text").textContent = "Expected Data";

    if (isNextSeason()) {
      el.expectedSub.textContent = compareMode
        ? "2026/27 home and away side by side (venue from fixtures + live stats)."
        : "FPL expected vs actual for 2026/27 — Home/Away from match venue.";
    } else {
      el.expectedSub.textContent = compareMode
        ? "Home and away side by side for the same players or teams."
        : "Compare expected (x) stats with what actually happened — who overperformed or underperformed.";
    }

    // Compare mode always groups by the combined (whole-season) totals —
    // the Home/Away rows within a group come from their own splits, but
    // which players/teams make the list, and the default sort order, are
    // anchored to the season-wide picture rather than either single split.
    const baseSplit = compareMode ? "combined" : state.expectedSplit;
    let rows = applyFilters(expectedSplitRows(baseSplit)).filter((r) => (state.view === "players" ? r.mins > 0 : r.gp > 0));
    rows = rows.filter((r) => {
      const { expected, actual } = expectedRowValues(r, cat);
      return Math.abs(expected) > 1e-9 || Math.abs(actual) > 1e-9;
    });

    buildExpectedHead(cat);
    el.barbellBody.innerHTML = "";

    if (!rows.length) {
      el.barbellScale.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No rows match the current filters.";
      el.barbellBody.appendChild(empty);
      if (NARROW_MQ.matches) bindMobileChromeScrollHide();
      return;
    }

    const sorted = sortExpectedRows(rows, cat);
    const homeMap = compareMode ? buildSplitMap("home") : null;
    const awayMap = compareMode ? buildSplitMap("away") : null;
    const { maxVal, maxAbsDiff, tickInfo } = expectedScaleDomain(cat, compareMode, baseSplit);
    buildExpectedScale(maxVal, cat, tickInfo);

    if (!compareMode) {
      sorted.forEach((r) => el.barbellBody.appendChild(buildBarbellRow(r, cat, maxVal, maxAbsDiff, null)));
    } else {
      sorted.forEach((r) => {
        const key = rowKey(r);
        el.barbellBody.appendChild(
          buildBarbellCompareGroup(r, homeMap.get(key), awayMap.get(key), cat, maxVal, maxAbsDiff)
        );
      });
    }
    if (NARROW_MQ.matches) bindMobileChromeScrollHide();
    if (opts.resetScroll) {
      requestAnimationFrame(() => {
        const scroll = expectedScrollWrap();
        if (scroll) scroll.scrollLeft = 0;
      });
    }
    requestAnimationFrame(() => syncMobileScrollportHeight());
  }

  // ---------------------------------------------------------------------
  // Rankings page — top-10 metric cards by category section
  // ---------------------------------------------------------------------
  const RANKINGS_TOP_N = 10;

  // Rankings groups metrics by how people actually shop for them, which is a
  // coarser split than the OPTA table's column sections — headline outcomes
  // first, then the volume stats that drive them. Deliberately independent of
  // col.section so re-grouping here never disturbs the table's header bands.
  // Order within each list is the card order on screen.
  const RANKINGS_SECTIONS = {
    players: [
      { label: "Key Stats", keys: ["pts", "goals", "assists", "__gi", "xg", "xa", "xgi", "xPts", "bonus"] },
      { label: "Attacking", keys: ["shots", "shotsOnTarget", "touchesBox", "bigChances", "keyPasses", "bigChancesCreated", "bps"] },
      { label: "Defending", keys: ["cleanSheets", "saves", "__cbitr", "defCon"] },
    ],
    teams: [
      { label: "Key Stats", keys: ["pts", "goals", "xg", "gd", "xgd"] },
      { label: "Attacking", keys: ["shots", "shotsOnTarget", "touchesBox", "bigChances"] },
      { label: "Defending", keys: ["cleanSheets", "xcs", "goalsConceded", "xgc"] },
    ],
  };

  function rankingsSectionsForView() {
    const sections = RANKINGS_SECTIONS[state.view] || [];
    if (!isNextSeason()) return sections;
    const hide = state.view === "players" ? PLAYER_OPTA_ONLY_COL_KEYS : TEAM_OPTA_ONLY_COL_KEYS;
    return sections
      .map((sec) => ({
        ...sec,
        keys: sec.keys.filter((k) => !hide.has(k)),
      }))
      .filter((sec) => sec.keys.length);
  }

  // Card titles intentionally differ from the OPTA table's detailed tooltips.
  // metricDisplayTitle() / METRIC_TITLE_OVERRIDES keep Rankings concise without
  // changing any existing table labels or explanatory hover text.

  // Click-to-pin: up to five subjects stay highlighted across every card, each
  // holding its own colour slot until it's unpinned. Slots are reused lowest
  // first so removing the 2nd pin frees colour 2 for the next click. Pinned
  // rows are also retained on cards after filters hide them from the top-N
  // (e.g. pin a midfielder, filter Forwards → mid stays for comparison).
  const RANKINGS_MAX_PINS = 5;

  function isRankingsMetricCol(col) {
    return isNumericCol(col) && !ENHANCE_EXCLUDE.has(col.key);
  }

  function rankingsColumnsForSection(section) {
    const spec = rankingsSectionsForView().find((s) => s.label === section);
    if (!spec) return [];
    const byKey = new Map(cols().map((col) => [col.key, col]));
    return spec.keys
      .map((key) => byKey.get(key))
      .filter((col) => {
        if (!col || !isRankingsMetricCol(col)) return false;
        // 2025/26 FPL season totals have no home/away breakdown — omit those cards.
        // 2026/27 derives venue splits from live + fixtures.
        if (
          state.view === "players" &&
          !isNextSeason() &&
          FPL_SEASON_TOTAL_ONLY.has(col.key) &&
          state.split !== "combined"
        ) {
          return false;
        }
        return true;
      });
  }

  // A section only earns a divider once it has at least one card to show, so
  // the combined-only groups drop out on Home/Away rather than leaving a
  // heading above an empty stretch of grid.
  function rankingsSections() {
    return rankingsSectionsForView()
      .map((s) => ({ label: s.label, metricCols: rankingsColumnsForSection(s.label) }))
      .filter((s) => s.metricCols.length > 0);
  }

  function rankableEntries(rows, col) {
    const lowerBetter = LOWER_BETTER.has(col.key);
    return rows
      .filter((r) => isStatAvailable(r, col))
      .map((r) => ({ row: r, key: String(rowKey(r)), val: rankingsValue(r, col) || 0 }))
      .filter((x) => Math.abs(x.val) > 1e-9)
      .sort((a, b) => (lowerBetter ? a.val - b.val : b.val - a.val));
  }

  // Rankings use the same display values as Statistics (totals / Per 90 / Per £m).
  function rankingsValue(row, col) {
    return displayValue(row, col);
  }

  function fmtRankingsValue(value, col) {
    return fmtDisplayValue(value, col);
  }

  // Competition ranks over a sorted entry list: tied values share a rank and
  // the next distinct value skips ahead.
  function denseRankMap(entries) {
    const map = new Map();
    let i = 0;
    while (i < entries.length) {
      let j = i + 1;
      while (j < entries.length && entries[j].val === entries[i].val) j++;
      for (let k = i; k < j; k++) map.set(entries[k].key, i + 1);
      i = j;
    }
    return map;
  }

  // Places match the filtered board: rank among current filters (plus any
  // pinned subjects merged in for compare). Ranking vs the full unfiltered
  // list made Per 90 / Per £m look oddly high — low-minute outliers take the
  // top overall places while the default mins/price filters hide them.
  function topRankedForCol(rows, col, populationForPins) {
    const filteredEntries = rankableEntries(rows, col);
    const leaders = filteredEntries.slice(0, RANKINGS_TOP_N).map((e) => ({
      row: e.row,
      key: e.key,
      val: e.val,
      retained: false,
    }));
    const present = new Set(leaders.map((e) => e.key));
    const pinPool = rankableEntries(populationForPins || rows, col);
    const byKey = new Map(pinPool.map((e) => [e.key, e]));
    for (const pinKey of state.rankingsPins) {
      if (present.has(pinKey)) continue;
      const entry = byKey.get(pinKey);
      if (!entry) continue;
      leaders.push({
        row: entry.row,
        key: entry.key,
        val: entry.val,
        retained: true,
      });
      present.add(pinKey);
    }

    // Rank universe = everyone still in the filter, plus retained pins.
    const rankUniverse = new Map(filteredEntries.map((e) => [e.key, e]));
    for (const e of leaders) {
      if (e.retained) rankUniverse.set(e.key, { row: e.row, key: e.key, val: e.val });
    }
    const lowerBetter = LOWER_BETTER.has(col.key);
    const ranked = [...rankUniverse.values()].sort((a, b) =>
      lowerBetter ? a.val - b.val : b.val - a.val
    );
    const ranks = denseRankMap(ranked);

    leaders.sort((a, b) => (lowerBetter ? a.val - b.val : b.val - a.val));
    return leaders.map((e) => ({
      row: e.row,
      val: e.val,
      rank: ranks.get(e.key) ?? null,
      retained: e.retained,
    }));
  }

  function rankingsIdentityHTML(row) {
    let meta = "";
    if (state.view === "players") {
      const pos = row.position || "";
      const price = effectivePrice(row);
      const priceLabel = price ? `£${Number(price).toFixed(1)}m` : "";
      const bits = [];
      if (pos) bits.push(posBadgeHTML(pos));
      if (priceLabel) bits.push(`<span>${escapeHtml(priceLabel)}</span>`);
      meta = bits.join("");
    } else {
      const pos = LEAGUE_POSITIONS[row.team];
      if (pos != null) {
        const seasonLabel = LEAGUE_POSITIONS_META.seasonLabel || "Premier League";
        meta = `<span${tipAttr(`${pos}${ordinalSuffix(pos)} in the ${seasonLabel}`)}>${pos}${ordinalSuffix(pos)}</span>`;
      }
    }
    const nameHTML = `<span class="rankings-name">${escapeHtml(row.name)}</span>`;
    const metaHTML = meta ? `<span class="rankings-meta">${meta}</span>` : "";
    return `${playerCrestHTML(row.team)}<span class="rankings-identity-text"><span class="rankings-name-line">${nameHTML}${ownedFlagHTML(row)}</span>${metaHTML}</span>`;
  }

  function rankingsCardHTML(col, rows, referenceRows) {
    const leaders = topRankedForCol(rows, col, referenceRows);
    const title = metricDisplayTitle(col);
    const keyLabel = col.label;
    const scale = leaders.reduce((m, e) => Math.max(m, Math.abs(e.val) || 0), 0) || 1;
    const body = leaders.length
      ? `<ol class="rankings-list">${leaders
          .map((entry, barI) => {
            const medal =
              entry.rank === 1 ? "gold" : entry.rank === 2 ? "silver" : entry.rank === 3 ? "bronze" : "";
            const key = String(rowKey(entry.row));
            const pin = state.rankingsPins.indexOf(key);
            const pinCls = pin >= 0 ? ` is-pinned pin-${pin + 1}` : "";
            const retainedCls = entry.retained ? " is-pin-retained" : "";
            const pct = Math.max(8, Math.min(100, (Math.abs(entry.val) / scale) * 100));
            const valueLabel = fmtRankingsValue(entry.val, col);
            const compareNote = entry.retained ? " (pinned compare)" : "";
            return `<li class="rankings-row${medal ? ` medal-${medal}` : ""}${pinCls}${retainedCls}"
              data-row-key="${escapeHtml(key)}"${entry.row.code != null ? ` data-player-code="${escapeHtml(String(entry.row.code))}"` : ""}${entry.row.team ? ` data-team="${escapeHtml(String(currentTeamCode(entry.row) || entry.row.team))}"` : ""} role="button" tabindex="0"
              aria-pressed="${pin >= 0 ? "true" : "false"}"
              aria-label="${escapeHtml(`${entry.rank == null ? "–" : entry.rank}. ${entry.row.name}, ${valueLabel}${compareNote}`)}">
              <span class="rankings-rank">${entry.rank == null ? "–" : entry.rank}</span>
              <span class="rankings-identity">${rankingsIdentityHTML(entry.row)}</span>
              <span class="rankings-meter">
                <span class="rankings-bar" style="--bar-pct:${pct.toFixed(2)}%;--bar-i:${barI}">
                  <span class="rankings-value">${valueLabel}</span>
                </span>
              </span>
            </li>`;
          })
          .join("")}</ol>`
      : `<div class="rankings-empty">No ranked values for the current filters.</div>`;
    return `<article class="rankings-card">
      <div class="rankings-card-head">
        <div>
          <h3>${escapeHtml(title)}</h3>
          <span class="rankings-card-key">${escapeHtml(keyLabel)}</span>
        </div>
      </div>
      ${body}
    </article>`;
  }

  // Pinned subjects survive filter changes and view switches, so the label
  // shown in the legend is resolved from the current population where
  // possible and falls back to the raw key for anyone filtered out.
  function rankingsPinLabel(key) {
    const match = getRows().find((r) => String(rowKey(r)) === key);
    if (!match) return key;
    return state.view === "players" ? `${match.name} · ${match.team}` : match.name;
  }

  function renderRankingsPinBar() {
    if (!el.rankingsPinBar) return;
    const pins = state.rankingsPins;
    if (!pins.length) {
      el.rankingsPinBar.innerHTML = "";
      el.rankingsPinBar.style.display = "none";
      return;
    }
    el.rankingsPinBar.style.display = "";
    const chips = pins
      .map((key, i) => {
        const label = rankingsPinLabel(key);
        return `<button type="button" class="rankings-pin-chip pin-${i + 1}" data-pin-key="${escapeHtml(key)}"
          aria-label="Unpin ${escapeHtml(label)}"${tipAttr(`Unpin ${label}`)}>
          <span class="rankings-pin-dot" aria-hidden="true"></span>${escapeHtml(label)}
          ${iconHTML("x", "rankings-pin-x")}
        </button>`;
      })
      .join("");
    const full = pins.length >= RANKINGS_MAX_PINS
      ? `<span class="rankings-pin-hint">Max ${RANKINGS_MAX_PINS} — unpin one to add another</span>`
      : "";
    el.rankingsPinBar.innerHTML = `
      <span class="rankings-pin-label">Pinned</span>
      ${chips}
      ${full}
      <button type="button" class="ghost-btn rankings-pin-clear" id="rankings-pin-clear">Clear</button>`;
  }

  function syncRankingsPinClasses() {
    if (!el.rankingsGrid) return;
    el.rankingsGrid.querySelectorAll(".rankings-row").forEach((row) => {
      const pin = state.rankingsPins.indexOf(row.dataset.rowKey);
      row.classList.toggle("is-pinned", pin >= 0);
      for (let i = 1; i <= RANKINGS_MAX_PINS; i++) row.classList.toggle(`pin-${i}`, pin === i - 1);
      row.setAttribute("aria-pressed", pin >= 0 ? "true" : "false");
    });
    renderRankingsPinBar();
  }

  function toggleRankingsPin(key) {
    if (!key) return;
    const pins = state.rankingsPins;
    const at = pins.indexOf(key);
    if (at >= 0) {
      pins.splice(at, 1);
    } else {
      if (pins.length >= RANKINGS_MAX_PINS) return;
      pins.push(key);
    }
    // Re-render so pinned subjects outside the filtered top-N stay/appear on cards.
    // Skip the grow-in — that animation is for first paint / filter changes.
    if (state.page === "rankings") renderRankings({ animateBars: false });
    else syncRankingsPinClasses();
  }

  function clearRankingsCrossHover() {
    if (!el.rankingsGrid) return;
    el.rankingsGrid.querySelectorAll(".rankings-row.is-cross-hover").forEach((row) => {
      row.classList.remove("is-cross-hover");
    });
    delete el.rankingsGrid.dataset.hoverKey;
  }

  function setRankingsCrossHover(key) {
    if (!el.rankingsGrid || key == null || key === "") {
      clearRankingsCrossHover();
      return;
    }
    const next = String(key);
    if (el.rankingsGrid.dataset.hoverKey === next) return;
    clearRankingsCrossHover();
    el.rankingsGrid.dataset.hoverKey = next;
    el.rankingsGrid.querySelectorAll(".rankings-row").forEach((row) => {
      if (row.dataset.rowKey === next) row.classList.add("is-cross-hover");
    });
  }

  function animateRankingsBars() {
    if (!el.rankingsGrid) return;
    const bars = el.rankingsGrid.querySelectorAll(".rankings-bar");
    if (!bars.length) return;
    bars.forEach((bar) => bar.classList.remove("is-drawn"));
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const draw = () => bars.forEach((bar) => bar.classList.add("is-drawn"));
    if (reduce) {
      draw();
      return;
    }
    // Two frames so width:0 paints before transitioning to --bar-pct.
    requestAnimationFrame(() => {
      requestAnimationFrame(draw);
    });
  }

  function renderRankings({ animateBars = true } = {}) {
    if (!el.rankingsGrid) return;
    clearRankingsCrossHover();
    const filtered = applyFilters(getRows());
    const total = getRows().length;
    el.rankingsCountLabel.textContent = `${filtered.length.toLocaleString()} of ${total.toLocaleString()} ${state.view} ranked`;

    const sections = rankingsSections();
    if (!sections.length) {
      el.rankingsGrid.innerHTML = `<div class="empty-state">No ranking metrics are available for this view and venue split.</div>`;
      renderRankingsPinBar();
      return;
    }

    // Rank among the filtered population (pins looked up from the full list).
    const populationForPins = getRows();
    el.rankingsGrid.innerHTML = sections
      .map((section) => {
        const cards = section.metricCols
          .map((col) => rankingsCardHTML(col, filtered, populationForPins))
          .join("");
        return `<div class="rankings-divider"><span>${escapeHtml(section.label)}</span></div>${cards}`;
      })
      .join("");
    renderRankingsPinBar();
    if (animateBars) {
      animateRankingsBars();
    } else {
      el.rankingsGrid.querySelectorAll(".rankings-bar").forEach((bar) => {
        bar.classList.add("is-drawn");
      });
    }
  }

  if (el.rankingsGrid) {
    el.rankingsGrid.addEventListener("pointerover", (e) => {
      if (!hasFineHover()) return;
      const row = e.target.closest(".rankings-row");
      if (!row || !el.rankingsGrid.contains(row)) return;
      setRankingsCrossHover(row.dataset.rowKey);
    });
    el.rankingsGrid.addEventListener("pointerout", (e) => {
      if (!hasFineHover()) return;
      const row = e.target.closest(".rankings-row");
      if (!row) return;
      const next =
        e.relatedTarget && typeof e.relatedTarget.closest === "function"
          ? e.relatedTarget.closest(".rankings-row")
          : null;
      if (next && el.rankingsGrid.contains(next)) return;
      clearRankingsCrossHover();
    });
    el.rankingsGrid.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const row = e.target.closest(".rankings-row");
      if (!row || !el.rankingsGrid.contains(row)) return;
      // Mobile: pin on first tap (no sticky cross-highlight preview).
      if (!hasFineHover()) clearRankingsCrossHover();
      toggleRankingsPin(row.dataset.rowKey);
    });
    el.rankingsGrid.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const row = e.target.closest(".rankings-row");
      if (!row || !el.rankingsGrid.contains(row)) return;
      e.preventDefault();
      toggleRankingsPin(row.dataset.rowKey);
    });
  }

  // Touch: dismiss sticky rankings highlight (if any) / xData tips when tapping away.
  document.addEventListener("click", (e) => {
    if (hasFineHover()) return;
    if (el.rankingsGrid && el.rankingsGrid.dataset.hoverKey && !e.target.closest(".rankings-row")) {
      clearRankingsCrossHover();
    }
    if (
      el.expectedTooltip &&
      el.expectedTooltip.style.display !== "none" &&
      !e.target.closest(".barbell-dot")
    ) {
      hideExpectedTooltip();
    }
  });

  if (el.rankingsPinBar) {
    el.rankingsPinBar.addEventListener("click", (e) => {
      if (e.target.closest("#rankings-pin-clear")) {
        state.rankingsPins.length = 0;
        if (state.page === "rankings") renderRankings();
        else syncRankingsPinClasses();
        return;
      }
      const chip = e.target.closest("[data-pin-key]");
      if (chip) toggleRankingsPin(chip.dataset.pinKey);
    });
  }

  // ---------------------------------------------------------------------
  // Team builder — 15-man FPL draft (2026/27 prices), XI + bench, 6-GW heat
  // ---------------------------------------------------------------------
  const TEAM_BUDGET = 100;
  const TEAM_CLUB_MAX = 3;
  const TEAM_SQUAD_MAX = { GK: 2, DEF: 5, MID: 5, FWD: 3 };
  const TEAM_XI_MIN = { GK: 1, DEF: 3, MID: 2, FWD: 1 };
  const TEAM_XI_MAX = { GK: 1, DEF: 5, MID: 5, FWD: 3 };
  const TEAM_HEAT_N = 6;
  const TEAM_DRAFT_KEY = "fpl-explorer-team-draft";
  const TEAM_POS_LABEL = { GK: "GKP", DEF: "DEF", MID: "MID", FWD: "FWD" };
  // XI sections top-to-bottom (attack first), then Bench below.
  const TEAM_VIEW_POS_ORDER = ["FWD", "MID", "DEF", "GK"];
  const TEAM_STAT_COLS = [
    { key: "pts", label: "Pts", decimals: 0, title: "Total FPL points" },
    { key: "xPts", label: "xPts", decimals: 1, title: "Expected FPL points" },
    { key: "xgi", label: "xGI", decimals: 1, title: "Expected goal involvements" },
    { key: "xg", label: "xG", decimals: 1, title: "Expected goals" },
    { key: "xa", label: "xA", decimals: 1, title: "Expected assists" },
  ];
  const TEAM_SETPIECE_COLS = [
    { key: "penaltiesOrder", label: "PK", title: "1st-choice penalty taker" },
    { key: "directFreekicksOrder", label: "FK", title: "1st-choice direct free kick taker" },
    { key: "cornersOrder", label: "CK", title: "1st-choice corners & indirect free kick taker" },
  ];

  function teamMoney(n) {
    return Math.round((Number(n) || 0) * 10) / 10;
  }

  function teamCatalog() {
    return season2627Data().players.combined || [];
  }

  function teamPlayerByCode(code) {
    if (code == null || code === "") return null;
    const n = Number(code);
    return (
      teamCatalog().find((p) => p.code === n || String(p.code) === String(code)) || null
    );
  }

  function teamCurrentGw() {
    return planningGameweek();
  }

  function teamClampGwStart(start) {
    return Math.min(
      SCHEDULE_GW_MAX,
      Math.max(SCHEDULE_GW_MIN, Number(start) || SCHEDULE_GW_MIN)
    );
  }

  function teamHeatGws() {
    const start = teamClampGwStart(state.teamGwStart ?? teamCurrentGw());
    const gws = [];
    for (let i = 0; i < TEAM_HEAT_N; i++) gws.push(start + i);
    return gws;
  }

  function teamShiftGw(delta) {
    const next = teamClampGwStart((state.teamGwStart ?? teamCurrentGw()) + delta);
    if (next === state.teamGwStart) return;
    state.teamGwStart = next;
    renderTeam();
  }

  let teamPriorByCodeCache = null;
  let teamPriorByCodeSeason = null;
  function teamPriorByCode() {
    if (teamPriorByCodeCache && teamPriorByCodeSeason === state.season) {
      return teamPriorByCodeCache;
    }
    const map = new Map();
    const source = isNextSeason()
      ? (season2627Data().players.combined || [])
      : ((DATA.players && DATA.players.combined) || []);
    source.forEach((row) => {
      if (row && row.code != null) map.set(Number(row.code), row);
    });
    teamPriorByCodeCache = map;
    teamPriorByCodeSeason = state.season;
    return map;
  }

  function teamPriorRow(code) {
    if (code == null || code === "") return null;
    return teamPriorByCode().get(Number(code)) || null;
  }

  function teamStatsSeasonLabel() {
    return isNextSeason() ? "2026/27" : "2025/26";
  }

  let teamPosRankCache = null;
  let teamPosRankSeason = null;
  function teamPosRankMaps() {
    if (teamPosRankCache && teamPosRankSeason === state.season) return teamPosRankCache;
    const maps = {};
    const prior = isNextSeason()
      ? (season2627Data().players.combined || [])
      : ((DATA.players && DATA.players.combined) || []);
    TEAM_STAT_COLS.forEach((col) => {
      maps[col.key] = {};
      POSITIONS.forEach((pos) => {
        const entries = prior
          .filter((r) => r.position === pos && r.code != null)
          .map((r) => ({ code: Number(r.code), val: Number(r[col.key]) || 0 }))
          .filter((x) => Math.abs(x.val) > 1e-9)
          .sort((a, b) => b.val - a.val);
        const rank = new Map();
        let i = 0;
        while (i < entries.length) {
          let j = i + 1;
          while (j < entries.length && entries[j].val === entries[i].val) j++;
          for (let k = i; k < j; k++) rank.set(entries[k].code, i + 1);
          i = j;
        }
        maps[col.key][pos] = rank;
      });
    });
    teamPosRankCache = maps;
    teamPosRankSeason = state.season;
    return maps;
  }

  function teamDataColCount(opts) {
    opts = opts || {};
    const price = opts.price ? 1 : 0;
    const ownership = opts.ownership ? 1 : 0;
    const setp = opts.setPieces ? TEAM_SETPIECE_COLS.length : 0;
    return 1 + price + ownership + TEAM_STAT_COLS.length + 1 + setp + teamHeatGws().length;
  }

  function teamDefaultSortDir(key) {
    if (key === "player") return "asc";
    if (TEAM_SETPIECE_COLS.some((c) => c.key === key)) return "asc";
    return "desc";
  }

  function teamSortTh(key, label, extraClass, title, opts) {
    if (opts && opts.plain) {
      return `<th class="${extraClass || ""}"${tipAttr(title || label)}>${escapeHtml(label)}</th>`;
    }
    const sorted = state.teamSortKey === key;
    const arrow = sorted
      ? `<span class="arrow">${iconHTML(state.teamSortDir === "asc" ? "chevron-up" : "chevron-down")}</span>`
      : "";
    return `<th class="${extraClass}${sorted ? " sorted" : ""}" data-team-sort="${escapeHtml(key)}"${tipAttr(title || label)}>${escapeHtml(label)}${arrow}</th>`;
  }

  function teamSparkMetricIsOwned() {
    return state.teamSparkMetric === "owned";
  }

  function teamSparkHeadHTML(opts) {
    const owned = teamSparkMetricIsOwned();
    const label = owned ? "TSB%" : "Form";
    if (opts && opts.plain) {
      return `<th class="col-team-spark">${escapeHtml(label)}</th>`;
    }
    return `<th class="col-team-spark" data-team-spark-toggle="1">${escapeHtml(label)}</th>`;
  }

  function toggleTeamSparkMetric() {
    state.teamSparkMetric = teamSparkMetricIsOwned() ? "form" : "owned";
    renderTeam();
  }

  function teamMetricHeadHTML(opts) {
    const plain = !!(opts && opts.plain);
    const stats = TEAM_STAT_COLS.map((col, i) =>
      teamSortTh(
        col.key,
        col.label,
        "col-num col-team-stat",
        `${col.title} · ${teamStatsSeasonLabel()}`,
        { plain }
      )
    ).join("");
    const spark = teamSparkHeadHTML({ plain });
    const setp =
      opts && opts.setPieces
        ? TEAM_SETPIECE_COLS.map((col) =>
            teamSortTh(col.key, col.label, "col-check col-team-setpiece", col.title, { plain })
          ).join("")
        : "";
    return `${stats}${spark}${setp}`;
  }

  function teamSectionHeadHTML(opts) {
    opts = opts || {};
    const statsN =
      (opts.price ? 1 : 0) +
      (opts.ownership ? 1 : 0) +
      TEAM_STAT_COLS.length +
      1 +
      (opts.setPieces ? TEAM_SETPIECE_COLS.length : 0);
    const heatN = teamHeatGws().length;
    return `<tr class="section-row"><th class="sec-sticky-lead"></th><th class="sec-divider" colspan="${statsN}">Statistics</th><th class="sec-divider" colspan="${heatN}">Fixtures</th></tr>`;
  }

  function teamHeadRowsHTML(colRowInner, opts) {
    opts = opts || {};
    return `${teamSectionHeadHTML(opts)}<tr>${colRowInner}</tr>`;
  }

  function teamSectionHeatFillHTML() {
    return teamHeatGws()
      .map(
        (gw, i) =>
          `<td class="team-section-fill team-heat-cell${i === 0 ? " sec-divider" : ""}${teamHeatAnchorClass(
            gw
          )}"></td>`
      )
      .join("");
  }

  function teamSectionRowHTML(label, enterI, extraClass, colOpts) {
    const heatN = teamHeatGws().length;
    const statsN = Math.max(0, teamDataColCount(colOpts) - 1 - heatN);
    const cls = extraClass ? ` ${extraClass}` : "";
    return `<tr class="section-row team-section-row${cls}" style="--enter-i:${enterI}">
      <th class="col-player">${escapeHtml(label)}</th>
      ${statsN ? `<td class="team-section-fill" colspan="${statsN}"></td>` : ""}
      ${teamSectionHeatFillHTML()}
    </tr>`;
  }

  function teamMessageRowHTML(message, extraClass, colOpts) {
    const rest = Math.max(0, teamDataColCount(colOpts) - 1);
    const cls = extraClass ? ` ${extraClass}` : "team-empty-row";
    return `<tr class="${cls}">
      <td class="col-player">${escapeHtml(message)}</td>
      ${rest ? `<td class="team-section-fill" colspan="${rest}"></td>` : ""}
    </tr>`;
  }

  const teamTrendCache = new Map();
  function teamMockTrend(code) {
    const key = Number(code);
    if (teamTrendCache.has(key)) return teamTrendCache.get(key);
    let s = (Math.imul(key || 1, 2654435761) || 1) >>> 0;
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const prior = teamPriorRow(code);
    const pts = prior && Number.isFinite(Number(prior.pts)) ? Number(prior.pts) : 60;
    const mean = Math.max(0.8, pts / 38);
    const series = [];
    let v = mean * (0.7 + rand() * 0.6);
    for (let i = 0; i < 8; i++) {
      v = Math.max(0, v + (rand() - 0.47) * mean * 0.85);
      series.push(Math.round(v * 10) / 10);
    }
    teamTrendCache.set(key, series);
    return series;
  }

  let teamOwnedSeriesCache = new Map();
  let teamOwnedSeriesCacheN = -1;
  function teamOwnedSeries(code) {
    const checkIns = ownershipCheckIns();
    if (teamOwnedSeriesCacheN !== checkIns.length) {
      const map = new Map();
      for (const ci of checkIns) {
        for (const p of ci.players || []) {
          if (p == null || p.code == null) continue;
          const v = Number(p.owned);
          if (!Number.isFinite(v)) continue;
          const k = Number(p.code);
          let arr = map.get(k);
          if (!arr) {
            arr = [];
            map.set(k, arr);
          }
          arr.push(v);
        }
      }
      teamOwnedSeriesCache = map;
      teamOwnedSeriesCacheN = checkIns.length;
    }
    const arr = teamOwnedSeriesCache.get(Number(code));
    if (!arr || !arr.length) return [];
    return arr.length > 12 ? arr.slice(-12) : arr;
  }

  function teamSparkSeries(row) {
    if (!row || row.code == null) return [];
    return teamSparkMetricIsOwned() ? teamOwnedSeries(row.code) : teamMockTrend(row.code);
  }

  function teamSparkSvg(series, tone) {
    const w = 64;
    const h = 22;
    const pad = 2;
    const n = series.length;
    const lo = Math.min(...series);
    const hi = Math.max(...series);
    const rng = hi - lo || 1;
    const pts = series.map((v, i) => {
      const x = n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - pad * 2);
      const y = h - pad - ((v - lo) / rng) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const end = pts[pts.length - 1].split(",");
    const line = n >= 2 ? `<polyline points="${pts.join(" ")}" />` : "";
    return `<svg class="team-spark ${tone}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${line}<circle cx="${end[0]}" cy="${end[1]}" r="1.8" /></svg>`;
  }

  function teamSparkCellHTML(row) {
    const series = teamSparkSeries(row);
    if (!series.length) {
      return `<td class="col-team-spark is-blank" data-team-spark-toggle="1"><span class="team-spark-empty">–</span></td>`;
    }
    const first = series[0];
    const last = series[series.length - 1];
    const delta = last - first;
    const span = Math.max(...series) - Math.min(...series) || 1;
    const tone = series.length < 2 || Math.abs(delta) < span * 0.12 ? "is-flat" : delta > 0 ? "is-up" : "is-down";
    return `<td class="col-team-spark" data-team-spark-toggle="1">${teamSparkSvg(series, tone)}</td>`;
  }

  function teamSortValue(row, key) {
    if (!row) return key === "player" ? "" : -Infinity;
    if (key === "player") return String(row.name || "").toLowerCase();
    if (key === "price") return Number(row.price) || 0;
    if (key === "owned") return currentOwnership(row.code) ?? -Infinity;
    if (key === "trend") {
      const series = teamSparkSeries(row);
      if (series.length < 2) return series.length === 1 ? series[0] : -Infinity;
      return series[series.length - 1] - series[0];
    }
    if (TEAM_SETPIECE_COLS.some((c) => c.key === key)) {
      const mark = setPieceDisplayRank(row, key);
      return mark == null ? 99 : mark;
    }
    const prior = teamPriorRow(row.code);
    const raw = prior ? Number(prior[key]) : NaN;
    return Number.isFinite(raw) ? raw : -Infinity;
  }

  function compareTeamRows(a, b) {
    const key = state.teamSortKey;
    if (!key || !a || !b) return 0;
    const av = teamSortValue(a, key);
    const bv = teamSortValue(b, key);
    if (typeof av === "string" || typeof bv === "string") {
      const cmp = String(av).localeCompare(String(bv));
      return state.teamSortDir === "asc" ? cmp : -cmp;
    }
    if (av !== bv) return state.teamSortDir === "asc" ? av - bv : bv - av;
    return String(a.name || "").localeCompare(String(b.name || ""));
  }

  function sortTeamSlots(slots) {
    if (!state.teamSortKey) return slots;
    return slots.slice().sort((a, b) => compareTeamRows(teamPlayerByCode(a.code), teamPlayerByCode(b.code)));
  }

  function teamRankLabel(rank) {
    if (rank == null || !Number.isFinite(Number(rank))) return "";
    return `#${Number(rank)}`;
  }

  function teamStatEnhance(rank, pos, col) {
    const rankMap = teamPosRankMaps()[col.key] && teamPosRankMaps()[col.key][pos];
    if (!rankMap || rank == null) return { cls: "", style: "" };
    const n = rankMap.size;
    const band = Math.max(1, Math.round((n * ENHANCE_PCT_PLAYERS) / 100));
    if (rank > band) return { cls: "", style: "" };
    const paint = enhanceHighlightPaint("top", rankBandIntensity(rank - 1, band));
    if (paint.skip) return { cls: "", style: "" };
    let extra = " is-enhanced";
    if (paint.emphasize || paint.strong) extra += " highlight-top";
    if (paint.strong) extra += " highlight-strong";
    return { cls: extra, style: `--hl-fill:${paint.backgroundColor}` };
  }

  function teamStatCellHTML(prior, pos, col, extraClass) {
    const cls = `col-num col-team-stat${extraClass ? ` ${extraClass}` : ""}`;
    if (!prior) {
      return `<td class="${cls} is-blank" data-team-stat="${escapeHtml(col.key)}">–</td>`;
    }
    const raw = Number(prior[col.key]);
    if (!Number.isFinite(raw) || Math.abs(raw) < 1e-9) {
      return `<td class="${cls} is-blank" data-team-stat="${escapeHtml(col.key)}">–</td>`;
    }
    const rank = teamPosRankMaps()[col.key][pos] && teamPosRankMaps()[col.key][pos].get(Number(prior.code));
    const hl = teamStatEnhance(rank, pos, col);
    const style = hl.style ? ` style="${hl.style}"` : "";
    return `<td class="${cls}${hl.cls}" data-team-stat="${escapeHtml(col.key)}"${style}>${fmtNum(raw, col.decimals)}</td>`;
  }

  function teamSetPieceCellHTML(row, col) {
    const mark = setPieceDisplayRank(row, col.key);
    if (mark == null) return `<td class="col-check col-team-setpiece"></td>`;
    if (mark === 1) {
      return `<td class="col-check col-team-setpiece"><span class="check-mark"${tipAttr("#1 choice")}><svg class="check-mark-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg></span></td>`;
    }
    return `<td class="col-check col-team-setpiece"><span class="check-mark check-mark-rank"${tipAttr(`${teamRankLabel(mark)} choice`)}>${escapeHtml(teamRankLabel(mark))}</span></td>`;
  }

  function teamMetricCellsHTML(row, opts) {
    const prior = teamPriorRow(row.code);
    const stats = TEAM_STAT_COLS.map((col) => teamStatCellHTML(prior, row.position, col)).join("");
    const spark = teamSparkCellHTML(row);
    const setp =
      opts && opts.setPieces
        ? TEAM_SETPIECE_COLS.map((col) => teamSetPieceCellHTML(row, col)).join("")
        : "";
    return `${stats}${spark}${setp}`;
  }

  function teamCompareHas(code) {
    return state.teamCompareCodes.some((c) => teamCodeEq(c, code));
  }

  function toggleTeamCompareCode(code) {
    if (code == null || code === "") return false;
    const key = Number(code) || code;
    const i = state.teamCompareCodes.findIndex((c) => teamCodeEq(c, key));
    if (i >= 0) {
      state.teamCompareCodes.splice(i, 1);
      return true;
    }
    if (state.teamCompareCodes.length >= MAX_COMPARE) {
      showToast({
        title: "Compare",
        message: `You can compare up to ${MAX_COMPARE} players.`,
        icon: "scale",
      });
      return false;
    }
    state.teamCompareCodes.push(key);
    return true;
  }

  function clearTeamCompareSelection() {
    state.teamCompareCodes.length = 0;
    state.teamHoverCompareCode = null;
  }

  function teamCompareHighlightMap(rows) {
    const maps = {};
    const list = (rows || []).filter(Boolean);
    TEAM_STAT_COLS.forEach((col) => {
      const withVals = list
        .map((r) => {
          const prior = teamPriorRow(r.code);
          const val = prior ? Number(prior[col.key]) : NaN;
          return { key: String(r.code), val };
        })
        .filter((x) => Number.isFinite(x.val) && Math.abs(x.val) > 1e-9);
      if (withVals.length < 2) return;
      const best = Math.max(...withVals.map((x) => x.val));
      const winners = new Set(withVals.filter((x) => x.val === best).map((x) => x.key));
      if (winners.size < withVals.length) maps[col.key] = winners;
    });
    return maps;
  }

  function teamSearchCardOpen() {
    return !!(el.teamSearchResults && !el.teamSearchResults.hidden);
  }

  function teamVisibleSearchCompareRows() {
    const q = teamSearchQuery();
    const { available } = q ? teamAutocompleteMatches(q) : { available: [] };
    const rows = [];
    const seen = new Set();
    const add = (row) => {
      if (!row || row.code == null) return;
      const key = String(row.code);
      if (seen.has(key)) return;
      seen.add(key);
      rows.push(row);
    };
    available.forEach((m) => add(m.row));
    state.teamCompareCodes.forEach((code) => add(teamPlayerByCode(code)));
    return rows;
  }

  function teamActiveCompareRows() {
    if (state.teamHoverCompareCode != null && teamSearchCardOpen()) {
      const rows = teamVisibleSearchCompareRows();
      const hoverRow = teamPlayerByCode(state.teamHoverCompareCode);
      if (hoverRow && !rows.some((r) => teamCodeEq(r.code, hoverRow.code))) rows.push(hoverRow);
      return rows;
    }
    if (state.teamCompareCodes.length >= 2) {
      return state.teamCompareCodes.map((code) => teamPlayerByCode(code)).filter(Boolean);
    }
    return [];
  }

  function paintTeamCompareWinners() {
    if (!el.teamPage) return;
    const map = teamCompareHighlightMap(teamActiveCompareRows());
    el.teamPage.querySelectorAll("td[data-team-stat]").forEach((td) => {
      const tr = td.closest("tr[data-team-code]");
      const col = td.getAttribute("data-team-stat");
      const code = tr && tr.dataset.teamCode;
      const win = !!(map[col] && code != null && map[col].has(String(code)));
      td.classList.toggle("is-compare-win", win);
      if (win) td.style.backgroundColor = positiveFill(0.24);
      else td.style.removeProperty("background-color");
    });
    el.teamPage.querySelectorAll("tr[data-team-code]").forEach((tr) => {
      if (tr.closest("#team-search-results, #team-compare-wrap")) {
        tr.classList.remove("row-selected");
        if (state.teamCompareMode) tr.classList.add("row-selectable");
        else tr.classList.remove("row-selectable");
        return;
      }
      const selected = teamCompareHas(tr.dataset.teamCode);
      tr.classList.toggle("row-selected", selected);
      if (state.teamCompareMode) tr.classList.add("row-selectable");
      else if (!selected) tr.classList.remove("row-selectable");
    });
  }

  function syncTeamCompareBtn() {
    if (!el.teamCompareBtn) return;
    const picking = !!state.teamPickerSlot;
    if (!picking) {
      if (state.teamCompareMode) state.teamCompareMode = false;
      if (state.teamCompareCodes.length) clearTeamCompareSelection();
      el.teamCompareBtn.hidden = true;
      return;
    }
    el.teamCompareBtn.hidden = false;
    const on = !!state.teamCompareMode;
    const blocked = !teamIsEditable();
    el.teamCompareBtn.classList.toggle("on", on);
    el.teamCompareBtn.classList.toggle("is-disabled", blocked);
    el.teamCompareBtn.setAttribute("aria-pressed", on ? "true" : "false");
    el.teamCompareBtn.setAttribute("aria-disabled", blocked ? "true" : "false");
    el.teamCompareBtn.disabled = blocked;
    el.teamCompareBtn.title = !teamIsEditable()
      ? "Switch to Planner to compare and edit"
      : "Click up to 5 players to compare";
  }

  function renderTeamCompareWrap() {
    if (!el.teamCompareWrap) return;
    if (!state.teamPickerSlot || !teamComparePanelVisible()) {
      el.teamCompareWrap.hidden = true;
      if (el.teamCompareBody) el.teamCompareBody.innerHTML = "";
      syncComparePanelRows(el.teamCompareWrap, null);
      return;
    }
    const rows = state.teamCompareCodes.map((code) => teamPlayerByCode(code)).filter(Boolean);
    el.teamCompareWrap.hidden = false;
    if (el.teamCompareTitle) {
      el.teamCompareTitle.textContent = `Comparing ${rows.length} player${rows.length === 1 ? "" : "s"}`;
    }
    const heatHead = teamHeatHeadHTML();
    const colOpts = { price: true, ownership: true, setPieces: true };
    if (el.teamCompareHead) {
      el.teamCompareHead.innerHTML = teamHeadRowsHTML(
        `${teamSortTh("player", "Player", "col-player", "Player", { plain: true })}${teamSortTh("price", "£m", "col-num col-core team-price", "Price (£m)", { plain: true })}${teamSortTh("owned", "TSB%", "col-num col-core col-team-owned", "FPL selected-by-% (TSB)", { plain: true })}${teamMetricHeadHTML({ plain: true, setPieces: true, price: true })}${heatHead}`,
        colOpts
      );
    }
    if (el.teamCompareBody) {
      el.teamCompareBody.innerHTML = rows
        .map((row, i) => {
          const heat = teamHeatCellsHTML(row.team);
          const nameHTML = `<div class="player-name-line"><span class="player-name">${escapeHtml(row.name)}</span></div>`;
          const sub = `<div class="player-cell-sub">${posBadgeHTML(row.position, { label: TEAM_POS_LABEL[row.position] })}</div>`;
          const crest = playerCrestHTML(row.team, tipAttr(teamNameForSeason(row.team)));
          return `<tr class="row-selectable" style="--enter-i:${i}" data-team-code="${escapeHtml(String(row.code))}">
            <td class="col-player">${playerIdentityHTML(crest, nameHTML, sub)}</td>
            <td class="col-num col-core team-price">${Number(row.price).toFixed(1)}</td>
            <td class="col-num col-core col-team-owned">${fmtOwnedPct(currentOwnership(row.code))}</td>
            ${teamMetricCellsHTML(row, { setPieces: true, price: true })}
            ${heat}
          </tr>`;
        })
        .join("");
    }
    syncComparePanelRows(el.teamCompareWrap, el.teamCompareBody);
    bindCompareScrollSync();
  }

  function loadTeamDraft() {
    try {
      const raw = localStorage.getItem(TEAM_DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.squad)) return;
      state.teamSquad = parsed.squad
        .filter((s) => s && s.code != null && TEAM_SQUAD_MAX[s.position])
        .slice(0, 15)
        .map((s) => ({
          code: Number(s.code) || s.code,
          position: s.position,
          starter: !!s.starter,
          benchOrder: Number.isFinite(s.benchOrder) ? s.benchOrder : 0,
        }));
      state.teamCaptainCode = parsed.captain != null ? Number(parsed.captain) || parsed.captain : null;
      state.teamViceCode = parsed.vice != null ? Number(parsed.vice) || parsed.vice : null;
      normalizeTeamRoles();
    } catch {
      /* private browsing / bad JSON */
    }
  }

  function saveTeamDraft() {
    if (state.teamMode === "actual") return;
    try {
      localStorage.setItem(
        TEAM_DRAFT_KEY,
        JSON.stringify({
          version: 1,
          squad: state.teamSquad,
          captain: state.teamCaptainCode,
          vice: state.teamViceCode,
        })
      );
    } catch {
      /* private browsing */
    }
  }

  function teamSpent() {
    return teamMoney(
      state.teamSquad.reduce((sum, slot) => {
        const row = teamPlayerByCode(slot.code);
        return sum + (row ? Number(row.price) || 0 : 0);
      }, 0)
    );
  }

  function teamBankRemaining(replaceCode) {
    const replaceRow = replaceCode != null ? teamPlayerByCode(replaceCode) : null;
    return teamMoney(TEAM_BUDGET - teamSpent() + (replaceRow ? Number(replaceRow.price) || 0 : 0));
  }

  function teamRowAffordable(row, replaceCode) {
    if (!row) return false;
    return Number(row.price) <= teamBankRemaining(replaceCode) + 1e-9;
  }

  function syncTeamAffordableCheck() {
    if (!el.teamAffordableCheck) return;
    el.teamAffordableCheck.checked = !!state.teamAffordableOnly;
  }

  function teamClubCounts(ignoreCode) {
    const counts = new Map();
    for (const slot of state.teamSquad) {
      if (ignoreCode != null && slot.code === ignoreCode) continue;
      const row = teamPlayerByCode(slot.code);
      if (!row) continue;
      counts.set(row.team, (counts.get(row.team) || 0) + 1);
    }
    return counts;
  }

  function teamPosCounts(ignoreCode) {
    const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0, total: 0 };
    for (const slot of state.teamSquad) {
      if (ignoreCode != null && slot.code === ignoreCode) continue;
      if (counts[slot.position] != null) counts[slot.position] += 1;
      counts.total += 1;
    }
    return counts;
  }

  function teamStarterCounts(nextSquad) {
    const squad = nextSquad || state.teamSquad;
    const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0, total: 0 };
    for (const slot of squad) {
      if (!slot.starter) continue;
      if (counts[slot.position] != null) counts[slot.position] += 1;
      counts.total += 1;
    }
    return counts;
  }

  function teamXiCapsOk(squad) {
    const c = teamStarterCounts(squad);
    if (c.total > 11) return { ok: false, reason: "full" };
    for (const pos of POSITIONS) {
      if (c[pos] > TEAM_XI_MAX[pos]) return { ok: false, reason: "pos", pos };
    }
    return { ok: true };
  }

  function teamXiLegal(squad) {
    const caps = teamXiCapsOk(squad);
    if (!caps.ok) return false;
    const c = teamStarterCounts(squad);
    let need = 0;
    for (const pos of POSITIONS) {
      need += Math.max(0, TEAM_XI_MIN[pos] - c[pos]);
    }
    return need <= 11 - c.total;
  }

  function normalizeTeamRoles() {
    const starters = new Set(state.teamSquad.filter((s) => s.starter).map((s) => s.code));
    if (state.teamCaptainCode != null && !starters.has(state.teamCaptainCode)) {
      state.teamCaptainCode = null;
    }
    if (state.teamViceCode != null && !starters.has(state.teamViceCode)) {
      state.teamViceCode = null;
    }
    if (state.teamCaptainCode != null && state.teamCaptainCode === state.teamViceCode) {
      state.teamViceCode = null;
    }
    let benchI = 1;
    const bench = state.teamSquad.filter((s) => !s.starter);
    bench.sort((a, b) => {
      if (a.position === "GK" && b.position !== "GK") return -1;
      if (b.position === "GK" && a.position !== "GK") return 1;
      return (a.benchOrder || 0) - (b.benchOrder || 0);
    });
    bench.forEach((s) => {
      s.benchOrder = s.position === "GK" ? 0 : benchI++;
    });
  }

  function teamAddError(row, { starter, replaceCode }) {
    if (!row) return "Player not found.";
    if (state.teamSquad.some((s) => s.code === row.code)) return "Already in your squad.";
    const ignoring = replaceCode;
    const posCounts = teamPosCounts(ignoring);
    if (posCounts[row.position] >= TEAM_SQUAD_MAX[row.position]) {
      return `Squad already has ${TEAM_SQUAD_MAX[row.position]} ${TEAM_POS_LABEL[row.position]}.`;
    }
    if (posCounts.total >= 15) return "Squad is full (15 players).";
    const clubs = teamClubCounts(ignoring);
    if ((clubs.get(row.team) || 0) >= TEAM_CLUB_MAX) {
      return `Already ${TEAM_CLUB_MAX} players from ${teamNameForSeason(row.team)}.`;
    }
    const replaceRow = ignoring != null ? teamPlayerByCode(ignoring) : null;
    const nextSpend = teamMoney(teamSpent() - (replaceRow ? Number(replaceRow.price) || 0 : 0) + (Number(row.price) || 0));
    if (nextSpend > TEAM_BUDGET + 1e-9) {
      const itb = teamMoney(TEAM_BUDGET - teamSpent() + (replaceRow ? Number(replaceRow.price) || 0 : 0));
      return `Needs £${Number(row.price).toFixed(1)}m — £${itb.toFixed(1)}m remaining.`;
    }
    if (starter) {
      const next = state.teamSquad
        .filter((s) => s.code !== ignoring)
        .concat([{ code: row.code, position: row.position, starter: true, benchOrder: 0 }]);
      const caps = teamXiCapsOk(next);
      if (!caps.ok) {
        if (caps.reason === "full") return "Starting XI is full (11 players).";
        return `Starting XI can only have ${TEAM_XI_MAX[caps.pos]} ${TEAM_POS_LABEL[caps.pos]}.`;
      }
    } else {
      const benchCount = state.teamSquad.filter((s) => !s.starter && s.code !== ignoring).length;
      if (benchCount >= 4) return "Bench is full.";
    }
    return null;
  }

  function addTeamPlayer(row, { starter, replaceCode } = {}) {
    if (!teamIsEditable()) {
      showToast({ title: "Actual is read-only", message: "Switch to Planner to change the squad.", icon: "info" });
      return false;
    }
    const err = teamAddError(row, { starter, replaceCode });
    if (err) {
      showToast({ title: "Can't add player", message: err, icon: "triangle-alert" });
      return false;
    }
    if (replaceCode != null) {
      state.teamSquad = state.teamSquad.filter((s) => s.code !== replaceCode);
      if (state.teamCaptainCode === replaceCode) state.teamCaptainCode = null;
      if (state.teamViceCode === replaceCode) state.teamViceCode = null;
    }
    state.teamSquad.push({
      code: Number(row.code) || row.code,
      position: row.position,
      starter: !!starter,
      benchOrder: starter ? 0 : 99,
    });
    normalizeTeamRoles();
    saveTeamDraft();
    return true;
  }

  function removeTeamPlayer(code) {
    if (!teamIsEditable()) return;
    state.teamSquad = state.teamSquad.filter((s) => s.code !== code);
    if (state.teamCaptainCode === code) state.teamCaptainCode = null;
    if (state.teamViceCode === code) state.teamViceCode = null;
    normalizeTeamRoles();
    saveTeamDraft();
  }

  function setTeamCaptain(code) {
    if (!teamIsEditable()) return;
    const slot = state.teamSquad.find((s) => s.code === code);
    if (!slot || !slot.starter) {
      showToast({ title: "Captain", message: "Captain must be in the starting XI.", icon: "triangle-alert" });
      return;
    }
    state.teamCaptainCode = code;
    if (state.teamViceCode === code) state.teamViceCode = null;
    saveTeamDraft();
    renderTeam();
  }

  function setTeamVice(code) {
    if (!teamIsEditable()) return;
    const slot = state.teamSquad.find((s) => s.code === code);
    if (!slot || !slot.starter) {
      showToast({ title: "Vice-captain", message: "Vice-captain must be in the starting XI.", icon: "triangle-alert" });
      return;
    }
    if (state.teamCaptainCode === code) state.teamCaptainCode = null;
    state.teamViceCode = code;
    saveTeamDraft();
    renderTeam();
  }

  function teamCodeEq(a, b) {
    return a == b || Number(a) === Number(b);
  }

  function teamXiAfterSwapOk(squad) {
    const c = teamStarterCounts(squad);
    if (c.total > 11) return false;
    for (const pos of POSITIONS) {
      if (c[pos] > TEAM_XI_MAX[pos]) return false;
    }
    if (c.total === 11) {
      for (const pos of POSITIONS) {
        if (c[pos] < TEAM_XI_MIN[pos]) return false;
      }
    } else if (!teamXiLegal(squad)) {
      return false;
    }
    return squad.filter((s) => !s.starter).length <= 4;
  }

  function teamSwappedSquad(promoteCode, demoteCode) {
    return state.teamSquad.map((s) => {
      if (teamCodeEq(s.code, promoteCode)) return { ...s, starter: true, benchOrder: 0 };
      if (teamCodeEq(s.code, demoteCode)) return { ...s, starter: false, benchOrder: 99 };
      return { ...s };
    });
  }

  function teamSwapLegal(promoteCode, demoteCode) {
    const incoming = state.teamSquad.find((s) => teamCodeEq(s.code, promoteCode));
    const outgoing = state.teamSquad.find((s) => teamCodeEq(s.code, demoteCode));
    if (!incoming || !outgoing || incoming.starter || !outgoing.starter) return false;
    return teamXiAfterSwapOk(teamSwappedSquad(promoteCode, demoteCode));
  }

  function teamSwapPartnerCodes(code) {
    const slot = state.teamSquad.find((s) => teamCodeEq(s.code, code));
    if (!slot) return [];
    return state.teamSquad
      .filter((s) => s.starter !== slot.starter)
      .filter((s) =>
        slot.starter ? teamSwapLegal(s.code, slot.code) : teamSwapLegal(slot.code, s.code)
      )
      .map((s) => s.code);
  }

  function cancelTeamSub({ silent } = {}) {
    if (state.teamSubCode == null) return;
    state.teamSubCode = null;
    if (!silent) renderTeam();
  }

  function beginTeamSub(code) {
    if (!teamIsEditable()) return false;
    const partners = teamSwapPartnerCodes(code);
    if (!partners.length) {
      showToast({
        title: "Can't substitute",
        message: "No legal swap for that player with the current XI.",
        icon: "triangle-alert",
      });
      return false;
    }
    state.teamSubCode = code;
    renderTeam();
    return true;
  }

  function completeTeamSub(targetCode) {
    const src = state.teamSquad.find((s) => teamCodeEq(s.code, state.teamSubCode));
    const tgt = state.teamSquad.find((s) => teamCodeEq(s.code, targetCode));
    if (!src || !tgt) return false;
    const promoteCode = src.starter ? tgt.code : src.code;
    const demoteCode = src.starter ? src.code : tgt.code;
    if (!teamSwapLegal(promoteCode, demoteCode)) return false;
    state.teamSquad = teamSwappedSquad(promoteCode, demoteCode);
    state.teamSubCode = null;
    normalizeTeamRoles();
    saveTeamDraft();
    renderTeam();
    return true;
  }

  function renderTeamSubBar() {
    if (!el.teamSubBar) return;
    const code = state.teamSubCode;
    if (code == null) {
      el.teamSubBar.hidden = true;
      el.teamSubBar.innerHTML = "";
      if (el.teamPage) el.teamPage.classList.remove("is-subbing");
      return;
    }
    const slot = state.teamSquad.find((s) => teamCodeEq(s.code, code));
    const row = teamPlayerByCode(code);
    const name = row && row.name ? row.name : "this player";
    const fromBench = slot && !slot.starter;
    el.teamSubBar.hidden = false;
    if (el.teamPage) el.teamPage.classList.add("is-subbing");
    el.teamSubBar.innerHTML = `
      <span>${fromBench ? "Select a starter to swap with" : "Select a bench player to swap with"} <strong>${escapeHtml(name)}</strong></span>
      <button type="button" class="ghost-btn" id="team-sub-cancel">Cancel</button>`;
  }

  function toggleTeamStarter(code) {
    if (!teamIsEditable()) return;
    if (state.teamSubCode != null) {
      if (teamCodeEq(state.teamSubCode, code)) {
        cancelTeamSub();
        return;
      }
      if (completeTeamSub(code)) return;
      showToast({
        title: "Can't swap",
        message: "That player isn't a legal substitute for the current XI.",
        icon: "triangle-alert",
      });
      return;
    }
    const slot = state.teamSquad.find((s) => teamCodeEq(s.code, code));
    if (!slot) return;
    const next = state.teamSquad.map((s) =>
      teamCodeEq(s.code, code) ? { ...s, starter: !s.starter, benchOrder: s.starter ? 0 : 99 } : { ...s }
    );
    if (teamXiAfterSwapOk(next)) {
      state.teamSquad = next;
      normalizeTeamRoles();
      saveTeamDraft();
      renderTeam();
      return;
    }
    beginTeamSub(code);
  }

  function clearTeamSquad() {
    if (!teamIsEditable()) return;
    state.teamSquad = [];
    state.teamCaptainCode = null;
    state.teamViceCode = null;
    closeTeamPicker({ silent: true });
    cancelTeamSub({ silent: true });
    saveTeamDraft();
    renderTeam();
  }

  let confirmModalResolver = null;

  function closeConfirmModal(ok) {
    if (!el.confirmModal) return;
    el.confirmModal.hidden = true;
    const resolve = confirmModalResolver;
    confirmModalResolver = null;
    if (resolve) resolve(!!ok);
  }

  function openConfirmModal({ title, message, okLabel = "Confirm" } = {}) {
    if (!el.confirmModal) return Promise.resolve(false);
    if (el.confirmModalTitle) el.confirmModalTitle.textContent = title || "Confirm";
    if (el.confirmModalMsg) el.confirmModalMsg.textContent = message || "";
    if (el.confirmModalOk) el.confirmModalOk.textContent = okLabel;
    el.confirmModal.hidden = false;
    requestAnimationFrame(() => {
      const cancelBtn = el.confirmModal.querySelector("[data-confirm-cancel].ghost-btn");
      (cancelBtn || el.confirmModalOk)?.focus();
    });
    return new Promise((resolve) => {
      confirmModalResolver = resolve;
    });
  }

  function requestClearTeamSquad(fromBtn) {
    if (!teamIsEditable()) {
      showToast({ title: "Actual is read-only", message: "Switch to Planner to clear the draft.", icon: "info" });
      return;
    }
    if (!state.teamSquad.length) return;
    const btn = fromBtn || el.teamClearToolbar || el.teamClearBtn;
    armConfirmButton(btn, {
      onConfirm: () => {
        setPrefsOpen(false);
        clearTeamSquad();
      },
    });
  }

  function openTeamPicker({ position, starter, replaceCode }) {
    if (!teamIsEditable()) {
      showToast({ title: "Actual is read-only", message: "Switch to Planner to add or replace players.", icon: "info" });
      return;
    }
    cancelTeamSub({ silent: true });
    state.teamPickerSlot = { position, starter: !!starter, replaceCode: replaceCode ?? null };
    state.search = "";
    if (el.search) el.search.value = "";
    syncSearchClearBtns();
    state.posFilter = new Set();
    // Full price range in picker — don't carry Statistics' £4.5m+ default.
    state.priceMin = bounds.price.min;
    state.priceMax = bounds.price.max;
    if (typeof updatePriceSlider === "function") updatePriceSlider();
    syncFilterChipUI();
    // Picker filters start collapsed, but subsequent filter-driven renders must
    // preserve the user's open/closed choice.
    if (!preferMobileSheet() && el.sidebar) {
      el.sidebar.classList.add("collapsed");
      if (el.sidebarToggle) {
        el.sidebarToggle.classList.remove("on");
        el.sidebarToggle.setAttribute("aria-pressed", "false");
      }
    }
    renderTeam();
    if (el.search && teamSearchAlwaysOpen()) {
      requestAnimationFrame(() => {
        try {
          el.search.focus({ preventScroll: true });
        } catch {
          el.search.focus();
        }
      });
    } else if (el.search && state.page === "team") {
      openMobileSearch();
    }
  }

  function closeTeamPicker({ silent } = {}) {
    state.teamPickerSlot = null;
    state.teamCompareMode = false;
    clearTeamCompareSelection();
    state.search = "";
    if (el.search) el.search.value = "";
    syncSearchClearBtns();
    if (!silent) {
      syncFilterChipUI();
      renderTeam();
    } else {
      syncTeamPickerChrome();
    }
  }

  function syncTeamPickingClass() {
    const picking = state.page === "team" && !!state.teamPickerSlot;
    document.documentElement.classList.toggle("is-team-picking", picking);
    if (el.subtoolbar && state.page === "team") {
      el.subtoolbar.classList.toggle("is-team-picking", picking && preferMobileSheet());
    }
  }

  function syncTeamCompareHost() {
    if (!el.teamCompareBtn || !el.teamToolbarControls) return;
    const mobile = preferMobileSheet();
    const picking = state.page === "team" && !!state.teamPickerSlot;
    el.teamCompareBtn.hidden = !picking;
    if (!picking) {
      if (el.teamCompareBtn.parentElement !== el.teamToolbarControls) {
        el.teamToolbarControls.insertBefore(el.teamCompareBtn, el.teamToolbarControls.firstChild);
      }
      return;
    }
    if (mobile && el.statsToolbarActions) {
      if (el.teamCompareBtn.parentElement !== el.statsToolbarActions) {
        el.statsToolbarActions.appendChild(el.teamCompareBtn);
      }
    } else if (el.teamHeaderInlineActions) {
      if (el.teamCompareBtn.parentElement !== el.teamHeaderInlineActions) {
        el.teamHeaderInlineActions.appendChild(el.teamCompareBtn);
      }
    } else if (el.teamCompareBtn.parentElement !== el.teamToolbarControls) {
      el.teamToolbarControls.insertBefore(el.teamCompareBtn, el.teamToolbarControls.firstChild);
    }
  }

  function syncTeamPickerToolbarOrder() {
    if (!preferMobileSheet() || state.page !== "team" || !state.teamPickerSlot || !el.statsToolbarActions) {
      return;
    }
    const bar = el.statsToolbarActions;
    if (el.teamPickerCancel && el.teamPickerCancel.parentElement === bar) {
      bar.insertBefore(el.teamPickerCancel, bar.firstChild);
    }
    if (el.teamCompareBtn && el.teamCompareBtn.parentElement === bar) {
      const beforeSearch =
        el.searchWrap && el.searchWrap.parentElement === bar ? el.searchWrap : null;
      if (el.teamCompareBtn !== beforeSearch) {
        bar.insertBefore(el.teamCompareBtn, beforeSearch);
      }
    }
    if (el.searchWrap && el.searchWrap.parentElement === bar) {
      bar.appendChild(el.searchWrap);
    }
  }

  let teamPickerPickGuard = 0;

  function commitTeamPickerSelection(code, event) {
    if (!state.teamPickerSlot) return false;
    if (event) {
      if (event.target.closest("th[data-team-sort], td.col-team-spark, th.col-team-spark")) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
    }
    const now = Date.now();
    if (now - teamPickerPickGuard < 450) return false;
    if (state.teamCompareMode) {
      toggleTeamCompareCode(code);
      renderTeam();
      teamPickerPickGuard = now;
      return true;
    }
    const row = teamPlayerByCode(code);
    const slot = state.teamPickerSlot;
    if (!row || !slot) return false;
    if (!addTeamPlayer(row, { starter: slot.starter, replaceCode: slot.replaceCode })) {
      return false;
    }
    teamPickerPickGuard = now;
    closeTeamPicker();
    return true;
  }

  function bindTeamPickerSelection() {
    if (!el.teamPickerView || el.teamPickerView.dataset.pickBound === "1") return;
    el.teamPickerView.dataset.pickBound = "1";
    let tap = null;

    el.teamPickerView.addEventListener(
      "click",
      (e) => {
        if (!state.teamPickerSlot) return;
        const pickRow = e.target.closest("tr.team-picker-row[data-team-pick]");
        if (!pickRow || !el.teamPickerView.contains(pickRow)) return;
        commitTeamPickerSelection(pickRow.dataset.teamPick, e);
      },
      true
    );

    el.teamPickerView.addEventListener(
      "pointerdown",
      (e) => {
        if (!state.teamPickerSlot) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const pickRow = e.target.closest("tr.team-picker-row[data-team-pick]");
        if (!pickRow || !el.teamPickerView.contains(pickRow)) {
          tap = null;
          return;
        }
        tap = { x: e.clientX, y: e.clientY, code: pickRow.dataset.teamPick, id: e.pointerId };
      },
      { passive: true, capture: true }
    );

    el.teamPickerView.addEventListener(
      "pointerup",
      (e) => {
        if (!tap || e.pointerId !== tap.id) return;
        const pickRow = e.target.closest("tr.team-picker-row[data-team-pick]");
        if (!pickRow || pickRow.dataset.teamPick !== tap.code) {
          tap = null;
          return;
        }
        const dx = Math.abs(e.clientX - tap.x);
        const dy = Math.abs(e.clientY - tap.y);
        tap = null;
        if (dx > 14 || dy > 14) return;
        if (!(preferMobileSheet() || !hasFineHover())) return;
        commitTeamPickerSelection(pickRow.dataset.teamPick, e);
      },
      true
    );
  }

  function syncTeamPickerCancelHost() {
    if (!el.teamPickerCancel) return;
    const mobile = preferMobileSheet();
    const picking = state.page === "team" && !!state.teamPickerSlot;
    const headerHost = el.teamPickerHeaderActions;
    const subEnd = el.subtoolbar && el.subtoolbar.querySelector(".topbar-end-cluster");
    if (mobile && picking && el.statsToolbarActions) {
      if (el.teamPickerCancel.parentElement !== el.statsToolbarActions) {
        el.statsToolbarActions.insertBefore(el.teamPickerCancel, el.statsToolbarActions.firstChild);
      }
    } else if (
      mobile &&
      picking &&
      subEnd &&
      el.searchWrap &&
      el.searchWrap.parentElement === subEnd
    ) {
      if (el.teamPickerCancel.parentElement !== subEnd) {
        subEnd.insertBefore(el.teamPickerCancel, el.searchWrap);
      }
    } else if (headerHost && el.teamPickerCancel.parentElement !== headerHost) {
      headerHost.appendChild(el.teamPickerCancel);
    }
  }

  function syncTeamCompareWrapHost() {
    if (!el.teamCompareWrap || !el.teamPage) return;
    const picking = !!state.teamPickerSlot;
    const squadHome = el.teamSubBar || el.teamSquadView;
    if (picking && el.teamPickerView) {
      if (el.teamCompareWrap.parentElement !== el.teamPickerView) {
        el.teamPickerView.insertBefore(el.teamCompareWrap, el.teamPickerView.firstChild);
      }
    } else if (squadHome && el.teamCompareWrap.parentElement !== el.teamPage) {
      el.teamPage.insertBefore(el.teamCompareWrap, squadHome);
    }
  }

  function syncTeamPickerChrome() {
    const picking = state.page === "team" && !!state.teamPickerSlot;
    syncTeamPickingClass();
    syncTeamSearchHost();
    syncTeamPickerCancelHost();
    syncTeamCompareWrapHost();
    if (el.teamPage) el.teamPage.classList.toggle("is-picking", picking);
    if (el.teamPickerCancel) el.teamPickerCancel.hidden = !picking;
    if (el.teamPickerHeaderActions) {
      el.teamPickerHeaderActions.hidden = !picking || preferMobileSheet();
    }
    if (el.teamBudgetBar) el.teamBudgetBar.hidden = picking;
    if (el.teamSquadView) el.teamSquadView.hidden = picking;
    if (el.teamPickerView) el.teamPickerView.hidden = !picking;
    syncTeamCompareHost();
    syncTeamPickerToolbarOrder();
    const hideSidebar = state.page === "schedule" || state.page === "markets" || state.page === "home" || (state.page === "team" && !picking);
    if (el.sidebar) el.sidebar.style.display = hideSidebar ? "none" : "";
    if (el.sidebarToggle) {
      el.sidebarToggle.style.display = state.page === "team" && !picking ? "none" : "";
    }
    if (el.subtoolbar && state.page === "team") {
      el.subtoolbar.style.display = "";
      el.subtoolbar.classList.remove("is-markets-mobile");
    }
    if (state.page === "team" && el.ownedFilterGroup) {
      el.ownedFilterGroup.style.display = picking ? "none" : "";
    }
    syncMobileChrome();
  }

  function applyTeamPickerFilters(rows) {
    const q = (state.search || "").trim().toLowerCase();
    const lock = state.teamPickerSlot && state.teamPickerSlot.position;
    const inSquad = new Set(state.teamSquad.map((s) => s.code));
    const replaceCode = state.teamPickerSlot && state.teamPickerSlot.replaceCode;
    return rows.filter((r) => {
      if (r.code == null) return false;
      if (excludeDepartedPlayer(r)) return false;
      if (inSquad.has(r.code) && r.code !== replaceCode) return false;
      if (lock && filterPosition(r) !== lock) return false;
      if (!lock && state.posFilter.size && !state.posFilter.has(filterPosition(r))) return false;
      if (state.teamFilter.size && !state.teamFilter.has(filterTeamCode(r))) return false;
      const price = effectivePrice(r);
      if (price < state.priceMin || price > state.priceMax) return false;
      if (state.setPieceTakersOnly && !isSetPieceTaker(r)) return false;
      if (state.teamAffordableOnly && !teamRowAffordable(r, replaceCode)) return false;
      if (q && !playerSearchHaystack(r).includes(q)) return false;
      return true;
    });
  }

  function teamHeatWindowStart() {
    return teamClampGwStart(state.teamGwStart ?? teamCurrentGw());
  }

  function teamHeatGwInSeason(gw) {
    return gw >= SCHEDULE_GW_MIN && gw <= SCHEDULE_GW_MAX;
  }

  function teamHeatAnchorClass(gw) {
    return teamHeatGwInSeason(gw) && gw === teamHeatWindowStart() ? " is-anchor" : "";
  }

  function teamHeatOppLabel(fx) {
    const code = String(fx.opp || "");
    if (!code) return "–";
    return fx.ha === "A" ? code.toLowerCase() : code.toUpperCase();
  }

  function teamHeatCellHTML(teamCode, gw, isFirst) {
    const fixtures = (FIXTURES_BY_TEAM[teamCode] || []).filter((fx) => fx.gw === gw);
    const divide = isFirst ? " sec-divider" : "";
    if (!fixtures.length) {
      return `<td class="team-heat-cell is-blank${divide}${teamHeatAnchorClass(gw)}"><span class="team-heat-label">–</span></td>`;
    }
    const fx = fixtures[0];
    const label = fixtures.map(teamHeatOppLabel).join("+");
    const d = Number(fx.difficulty);
    const fdr = Number.isFinite(d) && d >= 1 && d <= 5 ? d : null;
    let style = "";
    let extraClass = fdr != null ? ` fdr-${fdr}` : "";
    if (fdr === 1) {
      const paint = fdrHighlightInlineStyle("easy", 1);
      style = ` style="${paint.style}"`;
      extraClass += paint.strongClass;
    } else if (fdr === 2) {
      const paint = fdrHighlightInlineStyle("easy", 0.48);
      style = ` style="${paint.style}"`;
      extraClass += paint.strongClass;
    } else if (fdr === 4) {
      const paint = fdrHighlightInlineStyle("hard", 0.48);
      style = ` style="${paint.style}"`;
      extraClass += paint.strongClass;
    } else if (fdr === 5) {
      const paint = fdrHighlightInlineStyle("hard", 1);
      style = ` style="${paint.style}"`;
      extraClass += paint.strongClass;
    }
    return `<td class="team-heat-cell${extraClass}${divide}${teamHeatAnchorClass(gw)}"${style}><span class="team-heat-label">${escapeHtml(label)}</span></td>`;
  }

  function teamHeatHeadHTML() {
    return teamHeatGws()
      .map((gw, i) => {
        const label = teamHeatGwInSeason(gw) ? `GW${gw}` : "–";
        return `<th class="col-heat${i === 0 ? " sec-divider" : ""}${teamHeatAnchorClass(gw)}">${label}</th>`;
      })
      .join("");
  }

  function teamHeatCellsHTML(teamCode) {
    return teamHeatGws().map((gw, i) => teamHeatCellHTML(teamCode, gw, i === 0)).join("");
  }

  function teamPlayerCellHTML(row, slot) {
    const isC = slot && state.teamCaptainCode === row.code;
    const isV = slot && state.teamViceCode === row.code;
    const role = isC
      ? `<span class="team-role-badge is-c"${tipAttr("Captain")}>C</span>`
      : isV
        ? `<span class="team-role-badge is-v"${tipAttr("Vice-captain")}>V</span>`
        : "";
    const nameHTML = `<div class="player-name-line"><span class="player-name">${escapeHtml(row.name)}</span>${role}</div>`;
    const sub = `<div class="player-cell-sub">${posBadgeHTML(row.position, { label: TEAM_POS_LABEL[row.position] })}<span>${Number(row.price).toFixed(1)}M</span></div>`;
    const crest = playerCrestHTML(row.team, tipAttr(teamNameForSeason(row.team)));
    return playerIdentityHTML(crest, nameHTML, sub);
  }

  function teamRowMenuItemHTML({ attrs, icon, label, on = false, danger = false }) {
    const check = on ? `<span class="team-row-menu-check">${iconHTML("check")}</span>` : "";
    return `<button type="button" class="settings-switch-row team-row-menu-item${on ? " is-on" : ""}${danger ? " is-danger" : ""}" role="menuitem" ${attrs}>
      <span class="team-row-menu-icon" aria-hidden="true">${icon}</span>
      <span class="settings-switch-text"><span class="settings-switch-label">${escapeHtml(label)}</span></span>
      ${check}
    </button>`;
  }

  function teamRowMenuItemsHTML(row, slot) {
    const code = escapeHtml(String(row.code));
    const isC = state.teamCaptainCode === row.code;
    const isV = state.teamViceCode === row.code;
    const roleItems = slot.starter
      ? [
          teamRowMenuItemHTML({
            attrs: `data-team-captain="${code}"`,
            icon: `<span class="team-role-badge is-c">C</span>`,
            label: "Captain",
            on: isC,
          }),
          teamRowMenuItemHTML({
            attrs: `data-team-vice="${code}"`,
            icon: `<span class="team-role-badge is-v">V</span>`,
            label: "Vice-captain",
            on: isV,
          }),
          teamRowMenuItemHTML({
            attrs: `data-team-toggle-xi="${code}"`,
            icon: iconHTML("chevron-down"),
            label: "Move to bench",
          }),
        ].join("")
      : teamRowMenuItemHTML({
          attrs: `data-team-toggle-xi="${code}"`,
          icon: iconHTML("chevron-up"),
          label: "Move to XI",
        });
    const squadItems = [
      teamRowMenuItemHTML({
        attrs: `data-team-replace="${code}" data-team-replace-pos="${escapeHtml(row.position)}" data-team-replace-starter="${slot.starter ? "1" : "0"}"`,
        icon: iconHTML("refresh-ccw-dot"),
        label: "Replace",
      }),
      teamRowMenuItemHTML({
        attrs: `data-team-remove="${code}"`,
        icon: iconHTML("x"),
        label: "Remove",
        danger: true,
      }),
    ];
    return `<section class="settings-section">
          <div class="settings-section-label">Role</div>
          ${roleItems}
        </section>
        <section class="settings-section">
          <div class="settings-section-label">Squad</div>
          ${squadItems.join("")}
        </section>`;
  }

  function teamRowMenuHTML(row, slot) {
    return `<div class="settings-panel-head">
        <h4 id="team-row-menu-title">${escapeHtml(row.name)}</h4>
        <p class="settings-panel-sub">${escapeHtml(TEAM_POS_LABEL[row.position] || row.position)} · ${escapeHtml(teamNameForSeason(row.team))} · £${Number(row.price).toFixed(1)}m</p>
      </div>
      <div class="settings-panel-body team-row-menu-body">
        ${teamRowMenuItemsHTML(row, slot)}
      </div>`;
  }

  function clearTeamRowActions(exceptRow) {
    $$("#team-page tr.team-player-row.is-actions-open").forEach((row) => {
      if (row !== exceptRow) row.classList.remove("is-actions-open");
    });
  }

  let teamRowMenuOpenedAt = 0;
  let teamRowMenuRow = null;

  function teamRowMenuAllowed() {
    return teamIsEditable() && !state.teamPickerSlot && state.teamSubCode == null;
  }

  function teamRowMenuIsOpen() {
    return (
      !!(el.teamRowMenu && el.teamRowMenu.classList.contains("open")) ||
      !!(mobileSheetOpen && mobileSheetKey === "team-row")
    );
  }

  function teamSquadPlayerRowFromNode(node) {
    if (!node || !node.closest) return null;
    const row = node.closest("#team-squad-view tr.team-player-row[data-team-code]");
    if (!row || row.closest("#team-search-results")) return null;
    return row;
  }

  function closeTeamRowMenu({ force } = {}) {
    if (!force && Date.now() - teamRowMenuOpenedAt < 350) return;
    if (mobileSheetOpen && mobileSheetKey === "team-row") {
      closeMobileSheet();
      return;
    }
    if (el.teamRowMenu) {
      el.teamRowMenu.classList.remove("open");
      el.teamRowMenu.setAttribute("aria-hidden", "true");
      el.teamRowMenu.innerHTML = "";
      el.teamRowMenu.style.left = "";
      el.teamRowMenu.style.top = "";
    }
    teamRowMenuRow = null;
    clearTeamRowActions();
  }

  function hideTeamRowActionsPopup() {
    closeTeamRowMenu({ force: true });
  }

  function positionTeamRowMenu(x, y) {
    const menu = el.teamRowMenu;
    if (!menu) return;
    const pad = 8;
    const w = menu.offsetWidth || 240;
    const h = menu.offsetHeight || 280;
    let left = x;
    let top = y;
    if (left + w > window.innerWidth - pad) left = x - w;
    if (top + h > window.innerHeight - pad) top = y - h;
    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - h - pad));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function menuPointFromEvent(e, rowEl) {
    if (e && Number.isFinite(e.clientX) && (e.clientX || e.clientY)) {
      return { x: e.clientX, y: e.clientY };
    }
    const r = rowEl.getBoundingClientRect();
    return { x: r.left + 16, y: r.bottom - 4 };
  }

  function openTeamRowSheet(rowEl, row, slot) {
    hideUiTooltip();
    if (el.prefsPanel && el.prefsPanel.classList.contains("open")) setPrefsOpen(false);
    if (el.teamRowMenu && el.teamRowMenu.classList.contains("open")) {
      el.teamRowMenu.classList.remove("open");
      el.teamRowMenu.setAttribute("aria-hidden", "true");
      el.teamRowMenu.innerHTML = "";
    }
    clearTeamRowActions();
    rowEl.classList.add("is-actions-open");
    teamRowMenuRow = rowEl;
    teamRowMenuOpenedAt = Date.now();
    const sub = `${TEAM_POS_LABEL[row.position] || row.position} · ${teamNameForSeason(row.team) || row.team} · £${Number(row.price).toFixed(1)}m`;
    openMobileSheet({
      title: row.name,
      html: `<p class="team-row-sheet-sub">${escapeHtml(sub)}</p>
        <div class="team-row-menu-body">${teamRowMenuItemsHTML(row, slot)}</div>`,
      key: "team-row",
    });
    if (!el.mobileSheetBody) return;
    el.mobileSheetBody.querySelectorAll(".team-row-menu-item").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        applyTeamRowAction(ev.currentTarget);
      });
    });
  }

  function openTeamRowMenuAt(rowEl, e) {
    const code = Number(rowEl.dataset.teamCode) || rowEl.dataset.teamCode;
    const slot = state.teamSquad.find((s) => teamCodeEq(s.code, code));
    const row = slot ? teamPlayerByCode(slot.code) : null;
    if (!slot || !row || !teamRowMenuAllowed()) {
      closeTeamRowMenu({ force: true });
      return;
    }
    if (preferMobileSheet()) {
      openTeamRowSheet(rowEl, row, slot);
      return;
    }
    if (!el.teamRowMenu) {
      closeTeamRowMenu({ force: true });
      return;
    }
    hideUiTooltip();
    if (el.prefsPanel && el.prefsPanel.classList.contains("open")) setPrefsOpen(false);
    clearTeamRowActions();
    rowEl.classList.add("is-actions-open");
    teamRowMenuRow = rowEl;
    el.teamRowMenu.innerHTML = teamRowMenuHTML(row, slot);
    el.teamRowMenu.classList.add("open");
    el.teamRowMenu.setAttribute("aria-hidden", "false");
    teamRowMenuOpenedAt = Date.now();
    const pt = menuPointFromEvent(e, rowEl);
    positionTeamRowMenu(pt.x, pt.y);
    requestAnimationFrame(() => {
      if (!teamRowMenuIsOpen()) return;
      positionTeamRowMenu(pt.x, pt.y);
      el.teamRowMenu.focus({ preventScroll: true });
    });
  }

  function applyTeamRowAction(target) {
    if (!target || !target.closest) return false;
    const remove = target.closest("[data-team-remove]");
    if (remove) {
      closeTeamRowMenu({ force: true });
      removeTeamPlayer(Number(remove.dataset.teamRemove) || remove.dataset.teamRemove);
      renderTeam();
      return true;
    }
    const replace = target.closest("[data-team-replace]");
    if (replace) {
      closeTeamRowMenu({ force: true });
      openTeamPicker({
        position: replace.dataset.teamReplacePos,
        starter: replace.dataset.teamReplaceStarter === "1",
        replaceCode: Number(replace.dataset.teamReplace) || replace.dataset.teamReplace,
      });
      return true;
    }
    const cap = target.closest("[data-team-captain]");
    if (cap) {
      closeTeamRowMenu({ force: true });
      setTeamCaptain(Number(cap.dataset.teamCaptain) || cap.dataset.teamCaptain);
      return true;
    }
    const vice = target.closest("[data-team-vice]");
    if (vice) {
      closeTeamRowMenu({ force: true });
      setTeamVice(Number(vice.dataset.teamVice) || vice.dataset.teamVice);
      return true;
    }
    const toggle = target.closest("[data-team-toggle-xi]");
    if (toggle) {
      closeTeamRowMenu({ force: true });
      toggleTeamStarter(Number(toggle.dataset.teamToggleXi) || toggle.dataset.teamToggleXi);
      return true;
    }
    return false;
  }

  function teamFilledRowHTML(slot, enterI) {
    const row = teamPlayerByCode(slot.code);
    if (!row) return "";
    const subPartners =
      state.teamSubCode == null
        ? null
        : new Set(teamSwapPartnerCodes(state.teamSubCode).map((c) => String(c)));
    const heat = teamHeatCellsHTML(row.team);
    let subClass = "";
    if (state.teamSubCode != null && teamCodeEq(slot.code, state.teamSubCode)) subClass = " is-sub-source";
    else if (subPartners && subPartners.has(String(slot.code))) subClass = " is-sub-target";
    return `<tr class="team-player-row${subClass}" style="--enter-i:${enterI}" data-team-code="${escapeHtml(String(row.code))}"${subClass === " is-sub-target" ? ' role="button"' : ""}>
      <td class="col-player"><div class="team-player-id">${teamPlayerCellHTML(row, slot)}</div></td>
      ${teamMetricCellsHTML(row)}
      ${heat}
    </tr>`;
  }

  function teamEmptyRowHTML(pos, starter, enterI) {
    const label = starter ? `Add ${TEAM_POS_LABEL[pos]}` : `Add ${TEAM_POS_LABEL[pos]} to bench`;
    const metrics = TEAM_STAT_COLS.map(
      (col) => `<td class="col-num col-team-stat is-blank"></td>`
    ).join("");
    const spark = `<td class="col-team-spark is-blank" data-team-spark-toggle="1"></td>`;
    const heat = teamHeatGws()
      .map(
        (gw, i) =>
          `<td class="team-heat-cell is-blank${i === 0 ? " sec-divider" : ""}${teamHeatAnchorClass(gw)}"></td>`
      )
      .join("");
    return `<tr class="team-empty-row" style="--enter-i:${enterI}" data-team-add-pos="${pos}" data-team-add-starter="${starter ? "1" : "0"}" role="button" tabindex="0">
      <td class="col-player">
        <span class="team-add-slot">${iconHTML("plus")}<span>${escapeHtml(label)}</span></span>
      </td>
      ${metrics}${spark}${heat}
    </tr>`;
  }

  function teamEmptyPlan() {
    const filled = teamPosCounts();
    const xiEmpty = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    const benchEmpty = [];
    const proposed = state.teamSquad.map((s) => ({ ...s }));
    for (const pos of POSITIONS) {
      const remaining = TEAM_SQUAD_MAX[pos] - filled[pos];
      for (let i = 0; i < remaining; i++) {
        const asStarter = {
          code: `empty-${pos}-${i}`,
          position: pos,
          starter: true,
          benchOrder: 0,
        };
        if (teamXiLegal(proposed.concat([asStarter]))) {
          proposed.push(asStarter);
          xiEmpty[pos] += 1;
        } else {
          proposed.push({ ...asStarter, starter: false });
          benchEmpty.push(pos);
        }
      }
    }
    return { xiEmpty, benchEmpty };
  }

  function teamFormationLabel() {
    const c = teamStarterCounts();
    if (c.DEF + c.MID + c.FWD === 0) return "–";
    return `${c.DEF}-${c.MID}-${c.FWD}`;
  }

  function renderTeamGwNav() {
    if (!el.teamGwNav) return;
    const start = teamClampGwStart(state.teamGwStart ?? teamCurrentGw());
    state.teamGwStart = start;
    const minStart = SCHEDULE_GW_MIN;
    const maxStart = SCHEDULE_GW_MAX;
    const label = `GW${start}`;
    if (preferMobileSheet()) {
      const open = !!(mobileSheetOpen && mobileSheetKey === "team-gw");
      el.teamGwNav.innerHTML = `
        <button type="button" class="ghost-btn team-gw-select-btn" id="team-gw-select"
          aria-haspopup="dialog" aria-expanded="${open ? "true" : "false"}"
          aria-label="Selected gameweek, ${label}">
          <span class="team-gw-range">${label}</span>
          ${iconHTML("chevron-down", "page-tab-caret")}
        </button>`;
      return;
    }
    el.teamGwNav.innerHTML = `
      <button type="button" class="ghost-btn icon-only-btn" id="team-gw-prev" ${start <= minStart ? "disabled" : ""} aria-label="Previous gameweek">${iconHTML("chevron-left")}</button>
      <span class="team-gw-range">${label}</span>
      <button type="button" class="ghost-btn icon-only-btn" id="team-gw-next" ${start >= maxStart ? "disabled" : ""} aria-label="Next gameweek">${iconHTML("chevron-right")}</button>`;
  }

  function openTeamGwSheet() {
    const start = teamClampGwStart(state.teamGwStart ?? teamCurrentGw());
    const windowGws = new Set(teamHeatGws().filter(teamHeatGwInSeason));
    const cells = [];
    for (let gw = SCHEDULE_GW_MIN; gw <= SCHEDULE_GW_MAX; gw++) {
      const cls = [
        "team-gw-sheet-cell",
        gw === start ? "is-start" : "",
        windowGws.has(gw) ? "is-in-window" : "",
      ]
        .filter(Boolean)
        .join(" ");
      cells.push(
        `<button type="button" class="${cls}" data-team-gw="${gw}" aria-current="${
          gw === start ? "true" : "false"
        }">${gw}</button>`
      );
    }
    openMobileSheet({
      title: "Gameweek",
      html: `<div class="team-gw-sheet-grid" role="listbox" aria-label="Gameweeks">${cells.join("")}</div>`,
      key: "team-gw",
    });
    const selectBtn = $("#team-gw-select");
    if (selectBtn) selectBtn.setAttribute("aria-expanded", "true");
    if (!el.mobileSheetBody) return;
    el.mobileSheetBody.querySelectorAll("[data-team-gw]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const gw = Number(btn.getAttribute("data-team-gw"));
        if (!Number.isFinite(gw)) return;
        const next = teamClampGwStart(gw);
        closeMobileSheet();
        if (next === state.teamGwStart) return;
        state.teamGwStart = next;
        renderTeam();
      });
    });
  }

  function renderTeamBudgetBar() {
    if (!el.teamBudgetBar) return;
    const spent = teamSpent();
    const itb = teamMoney(TEAM_BUDGET - spent);
    const n = state.teamSquad.length;
    const clubs = teamClubCounts();
    const overClub = [...clubs.entries()].filter(([, c]) => c > TEAM_CLUB_MAX);
    const cap = teamPlayerByCode(state.teamCaptainCode);
    const vice = teamPlayerByCode(state.teamViceCode);
    const bankTone = itb < -1e-9 ? "is-neg" : itb > 1e-9 ? "is-pos" : "";
    const picking = !!state.teamPickerSlot;
    el.teamBudgetBar.classList.toggle("is-picking", picking);
    el.teamBudgetBar.hidden = picking;
    if (picking) {
      el.teamBudgetBar.innerHTML = "";
      return;
    }
    el.teamBudgetBar.classList.remove("is-over", "is-low");
    el.teamBudgetBar.innerHTML = `
      <div class="team-budget-stat${bankTone ? ` ${bankTone}` : ""}">
        <span class="team-budget-label">Bank</span>
        <strong>£${itb.toFixed(1)}m</strong>
      </div>
      <div class="team-budget-stat team-budget-spent">
        <span class="team-budget-label">Spent</span>
        <strong>£${spent.toFixed(1)}m</strong>
      </div>
      <div class="team-budget-stat">
        <span class="team-budget-label">Squad</span>
        <strong>${n}/15</strong>
      </div>
      <div class="team-budget-stat team-budget-formation">
        <span class="team-budget-label">Formation</span>
        <strong>${escapeHtml(teamFormationLabel())}</strong>
      </div>
      <div class="team-budget-stat team-budget-cap-vice">
        <span class="team-budget-label">C / V</span>
        <strong>${cap ? escapeHtml(cap.name) : "–"} / ${vice ? escapeHtml(vice.name) : "–"}</strong>
      </div>
      ${
        overClub.length
          ? `<div class="team-budget-warn">${overClub.map(([t, c]) => `${t} ${c}/${TEAM_CLUB_MAX}`).join(" · ")}</div>`
          : ""
      }`;
  }

  const TEAM_SEARCH_LIMIT = 8;

  function teamSearchQuery() {
    return (state.search || "").trim().toLowerCase();
  }

  function teamSearchHaystack(row) {
    return `${row.name || ""} ${row.team || ""} ${teamNameForSeason(row.team)}`.toLowerCase();
  }

  function teamSearchPts(row) {
    const prior = teamPriorRow(row.code);
    return Number((prior && prior.pts) || row.pts) || 0;
  }

  function teamSearchScore(row, q) {
    if (!q) return 99;
    const name = String(row.name || "").toLowerCase();
    const team = String(row.team || "").toLowerCase();
    const teamName = teamNameForSeason(row.team).toLowerCase();
    const tokens = name.split(/[\s.]+/).filter(Boolean);
    const last = tokens[tokens.length - 1] || "";
    if (name === q || team === q) return 0;
    if (name.startsWith(q)) return 1;
    if (last.startsWith(q)) return 2;
    if (tokens.some((t) => t.startsWith(q))) return 3;
    if (name.includes(q)) return 4;
    if (team.startsWith(q) || teamName.startsWith(q)) return 5;
    if (team.includes(q) || teamName.includes(q)) return 6;
    if (teamSearchHaystack(row).includes(q)) return 7;
    return 99;
  }

  function teamSlotByCode(code) {
    return state.teamSquad.find((s) => String(s.code) === String(code)) || null;
  }

  function teamSquadSlotNote(slot) {
    if (!slot) return "In squad";
    const pos = TEAM_POS_LABEL[slot.position] || slot.position;
    return slot.starter ? `XI · ${pos}` : `Bench · ${pos}`;
  }

  function teamPreferredAddSlot(row) {
    if (!teamAddError(row, { starter: true })) return { starter: true };
    return { starter: false };
  }

  function teamSearchSort(a, b) {
    if (a.score !== b.score) return a.score - b.score;
    const pts = teamSearchPts(b.row) - teamSearchPts(a.row);
    if (pts) return pts;
    return String(a.row.name).localeCompare(String(b.row.name));
  }

  function teamAutocompleteMatches(q) {
    if (!q) return { available: [] };
    const available = teamCatalog()
      .map((row) => ({
        row,
        score: teamSearchScore(row, q),
        slot: teamSlotByCode(row.code),
      }))
      .filter((x) => x.score < 99)
      .filter((x) => !x.slot)
      .filter((x) => !state.teamAffordableOnly || teamRowAffordable(x.row))
      .sort(teamSearchSort)
      .slice(0, TEAM_SEARCH_LIMIT);
    return { available };
  }

  function teamSearchRowHTML(row, slot, i, opts) {
    const heat = teamHeatCellsHTML(row.team);
    const inSquad = !!slot;
    const pinned = teamCompareHas(row.code);
    const note = inSquad
      ? `<span class="team-search-in">${escapeHtml(teamSquadSlotNote(slot))}</span>`
      : "";
    const nameHTML = `<div class="player-name-line"><span class="player-name">${escapeHtml(row.name)}</span>${note}</div>`;
    const sub = `<div class="player-cell-sub">${posBadgeHTML(row.position, { label: TEAM_POS_LABEL[row.position] })}<span>${Number(row.price).toFixed(1)}M</span></div>`;
    const crest = playerCrestHTML(row.team, tipAttr(teamNameForSeason(row.team)));
    const selectable = state.teamCompareMode || pinned ? " row-selectable" : "";
    const cls = `team-search-row${inSquad && !(opts && opts.pin) ? " is-in-squad" : ""}${opts && opts.pin ? " is-pinned-row" : ""}${selectable}`;
    const id = `team-search-opt-${escapeHtml(String(row.code))}`;
    return `<tr class="${cls}" id="${id}" style="--enter-i:${i}" data-team-code="${escapeHtml(String(row.code))}" role="option">
      <td class="col-player"><div class="team-player-id">${playerIdentityHTML(crest, nameHTML, sub)}</div></td>
      ${teamMetricCellsHTML(row)}
      ${heat}
    </tr>`;
  }

  function teamPinnedRows() {
    return state.teamCompareCodes.map((code) => teamPlayerByCode(code)).filter(Boolean);
  }

  function teamSearchNavCodes() {
    if (!el.teamSearchBody) return [];
    return [...el.teamSearchBody.querySelectorAll("tr.team-search-row[data-team-code]")].map(
      (tr) => Number(tr.dataset.teamCode) || tr.dataset.teamCode
    );
  }

  function teamSearchRowByCode(code) {
    if (!el.teamSearchBody || code == null) return null;
    const key = String(code);
    return [...el.teamSearchBody.querySelectorAll("tr.team-search-row[data-team-code]")].find((tr) =>
      teamCodeEq(tr.dataset.teamCode, key)
    );
  }

  function syncTeamSearchCombobox() {
    if (!el.search) return;
    el.search.removeAttribute("role");
    el.search.removeAttribute("aria-autocomplete");
    el.search.removeAttribute("aria-controls");
    el.search.removeAttribute("aria-expanded");
    el.search.removeAttribute("aria-activedescendant");
  }

  function applyTeamSearchActive(code, { scroll = false } = {}) {
    const codes = teamSearchNavCodes();
    if (!codes.length) {
      state.teamSearchActiveCode = null;
      if (el.search) el.search.removeAttribute("aria-activedescendant");
      return;
    }
    const match = code != null ? codes.find((c) => teamCodeEq(c, code)) : null;
    state.teamSearchActiveCode = match != null ? match : codes[0];
    el.teamSearchBody.querySelectorAll("tr.team-search-row.is-active").forEach((tr) => {
      tr.classList.remove("is-active");
      tr.removeAttribute("aria-selected");
    });
    const row = teamSearchRowByCode(state.teamSearchActiveCode);
    if (row) {
      row.classList.add("is-active");
      row.setAttribute("aria-selected", "true");
      if (scroll) row.scrollIntoView({ block: "nearest" });
      if (el.search && row.id) el.search.setAttribute("aria-activedescendant", row.id);
    }
  }

  function clearTeamHoverCompare() {
    if (state.teamHoverCompareCode == null) {
      paintTeamCompareWinners();
      return;
    }
    state.teamHoverCompareCode = null;
    paintTeamCompareWinners();
  }

  function setTeamHoverCompare(code) {
    if (code == null || code === "") {
      clearTeamHoverCompare();
      return;
    }
    if (state.teamHoverCompareCode != null && teamCodeEq(state.teamHoverCompareCode, code)) return;
    state.teamHoverCompareCode = Number(code) || code;
    paintTeamCompareWinners();
  }

  let teamSearchIgnoreHover = false;

  function moveTeamSearchActive(delta) {
    flushTeamSearchInput();
    if (!teamSearchCardOpen()) return;
    const codes = teamSearchNavCodes();
    if (!codes.length) return;
    const cur = codes.findIndex((c) => teamCodeEq(c, state.teamSearchActiveCode));
    const next =
      cur < 0 ? (delta > 0 ? 0 : codes.length - 1) : (cur + delta + codes.length) % codes.length;
    teamSearchIgnoreHover = true;
    applyTeamSearchActive(codes[next], { scroll: true });
    clearTeamHoverCompare();
  }

  function pinTeamSearchActive() {
    flushTeamSearchInput();
    if (!teamSearchCardOpen()) return;
    if (state.teamSearchActiveCode == null) applyTeamSearchActive(null);
    const code = state.teamSearchActiveCode;
    if (code == null) return;
    if (!toggleTeamCompareCode(code)) return;
    if (teamSearchQuery()) clearTeamSearchQuery({ keepFocus: true });
    renderTeam();
    focusTeamSearchInput();
  }

  function focusTeamSearchInput() {
    if (!el.search) return;
    try {
      el.search.focus({ preventScroll: true });
    } catch {
      el.search.focus();
    }
  }

  function clearTeamSearchQuery({ keepFocus = true } = {}) {
    if (el.search) el.search.value = "";
    state.search = "";
    state.teamSearchActiveCode = null;
    syncSearchClearBtns();
    if (keepFocus) focusTeamSearchInput();
  }

  function flushTeamSearchInput() {
    if (!el.search) return;
    clearTimeout(searchTimer);
    const val = el.search.value;
    if (state.search === val) return;
    state.search = val;
    if (state.page === "team" && !state.teamPickerSlot) return;
    if (state.page === "team") renderTeam();
  }

  function renderTeamSearchResults() {
    if (!el.teamSearchResults) return;
    if (state.teamPickerSlot) {
      el.teamSearchResults.hidden = true;
      el.teamSearchResults.classList.remove("is-pin-stash");
      state.teamSearchActiveCode = null;
      clearTeamHoverCompare();
      syncTeamSearchCombobox();
      return;
    }
    const q = teamSearchQuery();
    const pins = teamPinnedRows();
    if (!q && !pins.length) {
      el.teamSearchResults.hidden = true;
      el.teamSearchResults.classList.remove("is-pin-stash");
      state.teamSearchActiveCode = null;
      clearTeamHoverCompare();
      syncTeamSearchCombobox();
      return;
    }
    const { available } = q ? teamAutocompleteMatches(q) : { available: [] };
    const pinSet = new Set(pins.map((row) => String(row.code)));
    const availableVis = available.filter((m) => !pinSet.has(String(m.row.code)));
    const stashPins = pins;
    const pinStashOnly = !q && stashPins.length > 0;
    el.teamSearchResults.hidden = false;
    el.teamSearchResults.classList.toggle("is-pin-stash", pinStashOnly);
    syncTeamSearchCombobox();
    if (el.teamSearchTitle) {
      const nPin = stashPins.length;
      const nAdd = availableVis.length;
      if (pinStashOnly) el.teamSearchTitle.textContent = `${nPin} pinned`;
      else if (!nAdd && !nPin) el.teamSearchTitle.textContent = `No matches for “${q}”`;
      else if (!nAdd && nPin) el.teamSearchTitle.textContent = `No matches for “${q}” · ${nPin} pinned`;
      else if (nPin && nAdd) el.teamSearchTitle.textContent = `${nAdd} match${nAdd === 1 ? "" : "es"} · ${nPin} pinned`;
      else if (nPin) el.teamSearchTitle.textContent = `${nPin} pinned`;
      else el.teamSearchTitle.textContent = `${nAdd} match${nAdd === 1 ? "" : "es"} for “${q}”`;
    }
    const hint = el.teamSearchResults.querySelector(".team-search-hint");
    const hasRows = !!(availableVis.length || stashPins.length);
    if (hint) {
      hint.textContent = pinStashOnly
        ? "↑↓ · Enter or click to unpin"
        : "↑↓ to choose · Enter or click to pin";
      hint.hidden = !hasRows;
    }
    if (el.teamSearchClearPins) el.teamSearchClearPins.hidden = !stashPins.length;
    const heatHead = teamHeatHeadHTML();
    if (el.teamSearchHead) {
      el.teamSearchHead.innerHTML = teamHeadRowsHTML(
        `${teamSortTh("player", "Player", "col-player", "Player", { plain: true })}${teamMetricHeadHTML({ plain: true })}${heatHead}`
      );
    }
    if (!el.teamSearchBody) return;
    if (!availableVis.length && !stashPins.length) {
      el.teamSearchBody.innerHTML = teamMessageRowHTML("No players match that search.", "team-search-empty");
      state.teamSearchActiveCode = null;
      if (el.search) el.search.removeAttribute("aria-activedescendant");
      return;
    }
    const rows = [];
    let i = 0;
    if (stashPins.length) {
      if (!pinStashOnly) {
        rows.push(teamSectionRowHTML(`${stashPins.length} pinned`, i++, "is-pinned-section"));
      }
      stashPins.forEach((row) => rows.push(teamSearchRowHTML(row, teamSlotByCode(row.code), i++, { pin: true })));
    }
    if (availableVis.length) {
      if (stashPins.length) {
        rows.push(teamSectionRowHTML("Matches", i++));
      }
      availableVis.forEach((m) => rows.push(teamSearchRowHTML(m.row, null, i++)));
    }
    el.teamSearchBody.innerHTML = rows.join("");
    applyTeamSearchActive(state.teamSearchActiveCode);
  }

  function renderTeamSquadTables() {
    const heatHead = teamHeatHeadHTML();
    const plan = teamEmptyPlan();
    let enterI = 0;
    const rows = [];
    for (const pos of TEAM_VIEW_POS_ORDER) {
      const starters = sortTeamSlots(state.teamSquad.filter((s) => s.starter && s.position === pos));
      if (!starters.length && !plan.xiEmpty[pos]) continue;
      rows.push(teamSectionRowHTML(TEAM_POS_LABEL[pos], enterI++));
      starters.forEach((slot) => {
        rows.push(teamFilledRowHTML(slot, enterI++));
      });
      for (let i = 0; i < plan.xiEmpty[pos]; i++) {
        rows.push(teamEmptyRowHTML(pos, true, enterI++));
      }
    }
    if (!rows.length) {
      rows.push(teamEmptyRowHTML("GK", true, enterI++));
    }
    rows.push(teamSectionRowHTML("Bench", enterI++, "team-bench-divider"));
    const bench = sortTeamSlots(state.teamSquad.filter((s) => !s.starter));
    if (!state.teamSortKey) bench.sort((a, b) => (a.benchOrder || 0) - (b.benchOrder || 0));
    bench.forEach((slot) => {
      rows.push(teamFilledRowHTML(slot, enterI++));
    });
    plan.benchEmpty.forEach((pos) => {
      rows.push(teamEmptyRowHTML(pos, false, enterI++));
    });
    if (el.teamSquadHead) {
      el.teamSquadHead.innerHTML = teamHeadRowsHTML(
        `${teamSortTh("player", "Player", "col-player")}${teamMetricHeadHTML()}${heatHead}`
      );
    }
    if (el.teamSquadBody) el.teamSquadBody.innerHTML = rows.join("");
  }

  function renderTeamPicker() {
    const slot = state.teamPickerSlot;
    if (!slot || !el.teamPickerBody) return;
    const rows = applyTeamPickerFilters(teamCatalog()).slice();
    if (state.teamSortKey) rows.sort(compareTeamRows);
    else rows.sort((a, b) => (b.price || 0) - (a.price || 0) || String(a.name).localeCompare(String(b.name)));
    const heatHead = teamHeatHeadHTML();
    if (el.teamPickerHead) {
      el.teamPickerHead.innerHTML = teamHeadRowsHTML(
        `${teamSortTh("player", "Player", "col-player")}${teamSortTh("price", "£m", "col-num col-core team-price")}${teamSortTh("owned", "TSB%", "col-num col-core col-team-owned", "FPL selected-by-% (TSB)")}${teamMetricHeadHTML({ setPieces: true, price: true })}${heatHead}`,
        { price: true, ownership: true, setPieces: true }
      );
    }
    if (!rows.length) {
      el.teamPickerBody.innerHTML = teamMessageRowHTML(
        "No players match the current filters.",
        "team-empty-row",
        { price: true, ownership: true, setPieces: true }
      );
      return;
    }
    el.teamPickerBody.innerHTML = rows
      .map((row, i) => {
        const heat = teamHeatCellsHTML(row.team);
        const nameHTML = `<div class="player-name-line"><span class="player-name">${escapeHtml(row.name)}</span></div>`;
        const sub = `<div class="player-cell-sub">${posBadgeHTML(row.position, { label: TEAM_POS_LABEL[row.position] })}</div>`;
        const crest = playerCrestHTML(row.team, tipAttr(teamNameForSeason(row.team)));
        const selected = teamCompareHas(row.code);
        const selectedCls = selected ? " row-selected" : "";
        const selectableCls = state.teamCompareMode ? " row-selectable" : "";
        const identity = playerIdentityHTML(crest, nameHTML, sub);
        return `<tr class="team-picker-row${selectableCls}${selectedCls}" style="--enter-i:${i}" data-team-code="${escapeHtml(String(row.code))}" data-team-pick="${escapeHtml(String(row.code))}" role="button" tabindex="0">
          <td class="col-player">${identity}</td>
          <td class="col-num col-core team-price">${Number(row.price).toFixed(1)}</td>
          <td class="col-num col-core col-team-owned">${fmtOwnedPct(currentOwnership(row.code))}</td>
          ${teamMetricCellsHTML(row, { setPieces: true, price: true })}
          ${heat}
        </tr>`;
      })
      .join("");
  }

  function syncTeamPickerChips() {
    syncFilterChipUI();
  }

  function renderTeam(opts = {}) {
    if (!el.teamPage) return;
    if (state.teamGwStart == null) state.teamGwStart = teamClampGwStart(teamCurrentGw());
    normalizeTeamRoles();
    state.teamHoverCompareCode = null;
    hideTeamRowActionsPopup();
    syncTeamModeUI();
    const picking = !!state.teamPickerSlot;
    el.teamPage.classList.toggle(
      "is-comparing",
      picking && (!!state.teamCompareMode || state.teamCompareCodes.length > 0)
    );
    syncTeamCompareBtn();
    syncTeamPickerChrome();
    syncTeamAffordableCheck();
    syncTeamPlannerPrefsBtns();
    renderTeamGwNav();
    renderTeamBudgetBar();
    renderTeamSubBar();
    renderTeamCompareWrap();
    syncTeamPickerChips();
    if (picking) renderTeamPicker();
    else {
      if (el.teamSearchResults) {
        el.teamSearchResults.hidden = true;
        el.teamSearchResults.classList.remove("is-pin-stash");
      }
      state.teamSearchActiveCode = null;
      renderTeamSquadTables();
    }
    upgradeNativeTitles(el.teamPage);
    paintTeamCompareWinners();
    bindAllNameColumnSimplifies();
    syncTeamPickerCoreUnder();
    requestAnimationFrame(() => {
      if (opts.resetScroll) resetScrollWraps(teamTableScrollWraps());
      refreshNameSimplifyOrigins();
      syncTeamLandscapeMode();
      scheduleTeamTableHeadHeightSync();
    });
    if (NARROW_MQ.matches) bindMobileChromeScrollHide();
    syncTeamLandscapeMode();
    scheduleTeamTableHeadHeightSync();
  }

  function applyTeamPageBounds() {
    const next = computeBounds("2026-27");
    bounds.price.min = next.price.min;
    bounds.price.max = next.price.max;
    bounds.mins.min = next.mins.min;
    bounds.mins.max = next.mins.max;
    state.priceMin = Math.min(Math.max(4.5, bounds.price.min), bounds.price.max);
    state.priceMax = bounds.price.max;
    state.minsMin = 0;
    state.minsMax = bounds.mins.max;
    if (typeof updatePriceSlider === "function") updatePriceSlider();
    if (typeof updateMinsSlider === "function") updateMinsSlider();
  }

  function restoreSeasonFilterBounds() {
    const next = computeBounds(state.season);
    bounds.price.min = next.price.min;
    bounds.price.max = next.price.max;
    bounds.mins.min = next.mins.min;
    bounds.mins.max = next.mins.max;
  }

  function handleTeamUiClick(e) {
    if (e.target.closest("#team-picker-cancel")) {
      e.preventDefault();
      e.stopPropagation();
      closeTeamPicker();
      return;
    }
    if (e.target.closest("#team-gw-prev")) {
      teamShiftGw(-1);
      return;
    }
    if (e.target.closest("#team-gw-next")) {
      teamShiftGw(1);
      return;
    }
    if (e.target.closest("#team-gw-select")) {
      if (mobileSheetOpen && mobileSheetKey === "team-gw") closeMobileSheet();
      else openTeamGwSheet();
      return;
    }
    if (e.target.closest("#team-compare-btn")) {
      e.preventDefault();
      e.stopPropagation();
      if (!state.teamPickerSlot) return;
      if (!teamIsEditable()) {
        showToast({ title: "Actual is read-only", message: "Switch to Planner to compare and edit.", icon: "info" });
        return;
      }
      state.teamCompareMode = !state.teamCompareMode;
      if (state.teamCompareMode) {
        showToast({
          title: "Compare mode",
          message: `Click up to ${MAX_COMPARE} players in the table to compare side by side.`,
          icon: "scale",
        });
      } else {
        hideToast();
      }
      renderTeam();
      return;
    }
    if (e.target.closest("#team-compare-clear") || e.target.closest("#team-search-clear-pins")) {
      clearTeamCompareSelection();
      renderTeam();
      return;
    }
    const sparkHit = e.target.closest("td.col-team-spark, th.col-team-spark");
    if (sparkHit && (sparkHit.matches("th.col-team-spark") || hasFineHover())) {
      e.preventDefault();
      e.stopPropagation();
      toggleTeamSparkMetric();
      return;
    }
    const searchPinRow = e.target.closest("#team-search-results tr.team-search-row[data-team-code]");
    if (searchPinRow) {
      e.preventDefault();
      e.stopPropagation();
      if (!toggleTeamCompareCode(searchPinRow.dataset.teamCode)) return;
      if (teamSearchQuery()) clearTeamSearchQuery({ keepFocus: false });
      renderTeam();
      focusTeamSearchInput();
      return;
    }
    if (state.teamCompareMode) {
      const selectable = e.target.closest(
        "tr.team-player-row[data-team-code], tr.team-search-row[data-team-code], tr.team-picker-row[data-team-code]"
      );
      if (
        selectable &&
        !e.target.closest(".team-act") &&
        !(selectable.classList.contains("team-player-row") && state.teamSubCode != null)
      ) {
        toggleTeamCompareCode(selectable.dataset.teamCode);
        renderTeam();
        return;
      }
    }
    if (e.target.closest("#team-compare-wrap tr[data-team-code]")) {
      const compareRow = e.target.closest("#team-compare-wrap tr[data-team-code]");
      if (compareRow) {
        toggleTeamCompareCode(compareRow.dataset.teamCode);
        renderTeam();
        return;
      }
    }
    if (e.target.closest("#team-sub-cancel")) {
      cancelTeamSub();
      return;
    }
    const sortTh = e.target.closest("th[data-team-sort]");
    if (sortTh) {
      const key = sortTh.getAttribute("data-team-sort");
      if (state.teamSortKey === key) {
        state.teamSortDir = state.teamSortDir === "asc" ? "desc" : "asc";
      } else {
        state.teamSortKey = key;
        state.teamSortDir = teamDefaultSortDir(key);
      }
      renderTeam({ resetScroll: true });
      return;
    }
    const pick = e.target.closest("[data-team-pick]");
    if (pick) {
      if (e.target.closest("#team-compare-wrap")) return;
      if (pick.closest("#team-picker-view")) return;
      const row = teamPlayerByCode(Number(pick.dataset.teamPick) || pick.dataset.teamPick);
      const slot = state.teamPickerSlot;
      if (row && slot && addTeamPlayer(row, { starter: slot.starter, replaceCode: slot.replaceCode })) {
        closeTeamPicker();
      }
      return;
    }
    const add = e.target.closest("[data-team-add-pos]");
    if (add) {
      openTeamPicker({
        position: add.dataset.teamAddPos,
        starter: add.dataset.teamAddStarter === "1",
      });
      return;
    }
    if (applyTeamRowAction(e.target)) return;
    if (state.teamSubCode != null) {
      const subRow = e.target.closest("tr.team-player-row[data-team-code]");
      if (subRow) {
        toggleTeamStarter(Number(subRow.dataset.teamCode) || subRow.dataset.teamCode);
        return;
      }
    }
    const filled = teamSquadPlayerRowFromNode(e.target);
    if (filled && teamRowMenuAllowed() && preferMobileSheet()) {
      e.stopPropagation();
      if (teamRowMenuIsOpen() && teamRowMenuRow === filled) closeTeamRowMenu({ force: true });
      else openTeamRowMenuAt(filled, e);
      return;
    }
    closeTeamRowMenu();
  }

  function handleTeamUiKeydown(e) {
    if (e.key === "Escape" && state.teamPickerSlot) {
      e.preventDefault();
      closeTeamPicker();
      return;
    }
    if (e.key === "Escape" && state.teamSubCode != null) {
      e.preventDefault();
      cancelTeamSub();
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest("[data-team-add-pos], [data-team-pick]");
    if (!row) return;
    e.preventDefault();
    row.click();
  }

  if (el.teamPage) {
    el.teamPage.addEventListener("click", handleTeamUiClick);
    el.teamPage.addEventListener("keydown", handleTeamUiKeydown);
  }
  if (el.teamToolbarControls) {
    el.teamToolbarControls.addEventListener("click", handleTeamUiClick);
  }
  if (el.teamCompareBtn) {
    el.teamCompareBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleTeamUiClick(e);
    });
  }
  if (el.teamPickerCancel) {
    el.teamPickerCancel.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeTeamPicker();
    });
  }
  if (el.teamRowMenu) {
    el.teamRowMenu.addEventListener("click", (e) => {
      e.stopPropagation();
      applyTeamRowAction(e.target);
    });
    el.teamRowMenu.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  document.addEventListener("contextmenu", (e) => {
    if (e.target.closest("#confirm-modal, #team-row-menu, input, textarea, select")) {
      return;
    }
    const squadRow = teamSquadPlayerRowFromNode(e.target);
    if (squadRow && state.page === "team" && teamRowMenuAllowed()) {
      e.preventDefault();
      openTeamRowMenuAt(squadRow, e);
    }
  });
  document.addEventListener("click", (e) => {
    if (el.teamRowMenu && el.teamRowMenu.contains(e.target)) return;
    if (el.mobileSheet && el.mobileSheet.contains(e.target)) return;
    closeTeamRowMenu();
  });
  document.addEventListener(
    "scroll",
    (e) => {
      if (teamRowMenuIsOpen()) {
        if (el.teamRowMenu && e.target && el.teamRowMenu.contains(e.target)) return;
        if (el.mobileSheet && e.target && el.mobileSheet.contains(e.target)) return;
        if (mobileSheetOpen && mobileSheetKey === "team-row") return;
        closeTeamRowMenu({ force: true });
      }
    },
    true
  );
  window.addEventListener("resize", () => {
    if (!(mobileSheetOpen && mobileSheetKey === "team-row")) {
      closeTeamRowMenu({ force: true });
    }
  });
  if (el.teamSquadView) {
    el.teamSquadView.addEventListener("pointerover", (e) => {
      if (!hasFineHover()) return;
      const row = e.target.closest("tr.team-player-row[data-team-code]");
      if (!row || row.closest("#team-search-results") || !el.teamSquadView.contains(row)) return;
      const code = Number(row.dataset.teamCode) || row.dataset.teamCode;
      setTeamHoverCompare(code);
    });
    el.teamSquadView.addEventListener("pointerout", (e) => {
      const row = e.target.closest("tr.team-player-row[data-team-code]");
      if (!row || row.closest("#team-search-results")) return;
      const rel = e.relatedTarget;
      if (rel && row.contains(rel)) return;
      const nextRow = rel && rel.closest && rel.closest("tr.team-player-row[data-team-code]");
      const nextSquad =
        nextRow && el.teamSquadView.contains(nextRow) && !nextRow.closest("#team-search-results");
      const nextSearch =
        rel && rel.closest && rel.closest("#team-search-results tr.team-search-row[data-team-code]");
      if (state.teamHoverCompareCode != null && !nextSquad && !nextSearch) clearTeamHoverCompare();
    });
    el.teamSquadView.addEventListener("pointerleave", () => {
      clearTeamHoverCompare();
    });
  }
  if (el.teamSearchResults) {
    el.teamSearchResults.addEventListener("pointerover", (e) => {
      if (teamSearchIgnoreHover) return;
      const row = e.target.closest("tr.team-search-row[data-team-code]");
      if (!row || !el.teamSearchResults.contains(row)) return;
      const code = Number(row.dataset.teamCode) || row.dataset.teamCode;
      if (state.teamSearchActiveCode == null || !teamCodeEq(state.teamSearchActiveCode, code)) {
        applyTeamSearchActive(code);
      }
      setTeamHoverCompare(code);
    });
    el.teamSearchResults.addEventListener("pointerout", (e) => {
      const row = e.target.closest("tr.team-search-row[data-team-code]");
      if (!row) return;
      const rel = e.relatedTarget;
      if (rel && row.contains(rel)) return;
      const nextSearch =
        rel && rel.closest && rel.closest("#team-search-results tr.team-search-row[data-team-code]");
      const nextSquad =
        rel &&
        rel.closest &&
        rel.closest("#team-squad-view tr.team-player-row[data-team-code]");
      if (state.teamHoverCompareCode != null && !nextSearch && !nextSquad) clearTeamHoverCompare();
    });
    el.teamSearchResults.addEventListener("pointerleave", () => {
      clearTeamHoverCompare();
    });
    el.teamSearchResults.addEventListener("mousemove", () => {
      teamSearchIgnoreHover = false;
    });
  }
  if (el.confirmModal) {
    el.confirmModal.addEventListener("click", (e) => {
      if (e.target.closest("[data-confirm-cancel]")) {
        closeConfirmModal(false);
        return;
      }
      if (e.target.closest("#confirm-modal-ok")) {
        closeConfirmModal(true);
      }
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (el.confirmModal && !el.confirmModal.hidden) {
      e.preventDefault();
      closeConfirmModal(false);
      return;
    }
    if (teamRowMenuIsOpen()) {
      e.preventDefault();
      closeTeamRowMenu({ force: true });
      return;
    }
    if (mobileSheetOpen) return;
    if (state.page === "team" && state.teamPickerSlot) {
      e.preventDefault();
      closeTeamPicker();
    } else if (state.page === "team" && state.teamSubCode != null) {
      e.preventDefault();
      cancelTeamSub();
    }
  });

  loadTeamDraft();
  syncTeamPlannerPrefsBtns();
  bindTeamPickerSelection();

  // ---------------------------------------------------------------------
  // Shared player photo / stat helpers (formerly Feed; also Home + Ownership)
  function feedPlayerPhotoUrl(code) {
    if (code == null || code === "") return "";
    // FPL bootstrap `photo` is "{code}.jpg"; current PL CDN path (25/26) is
    // premierleague25/…/{code}.png (no "p" prefix). Older p{code} 250x250
    // URLs 403 for many new/promoted players (e.g. Igor Jesus).
    return `https://resources.premierleague.com/premierleague25/photos/players/110x140/${code}.png`;
  }

  function detectLocaleClockFormat() {
    try {
      const parts = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).formatToParts(
        new Date(2024, 0, 1, 15, 0, 0)
      );
      return parts.some((p) => p.type === "dayPeriod") ? "12" : "24";
    } catch {
      return "12";
    }
  }

  const clockFormat = detectLocaleClockFormat();

  function localeTimeOptions() {
    if (clockFormat === "24") {
      return { hour: "2-digit", minute: "2-digit", hour12: false };
    }
    return { hour: "numeric", minute: "2-digit", hour12: true };
  }

  function feedStatDisplay(value, decimals) {
    if (value == null || value === "" || Number.isNaN(Number(value))) return "—";
    const n = Number(value);
    if (decimals === 0) return String(Math.round(n));
    return n.toFixed(decimals);
  }

  function feedRowStatValue(row, key) {
    if (!row) return null;
    if (key === "__gi") return (Number(row.goals) || 0) + (Number(row.assists) || 0);
    if (key === "owned") return currentOwnership(row.code);
    const v = row[key];
    return v == null ? null : v;
  }


  function fmtMarketsKickoffParts(iso) {
    if (!iso) return { day: "", date: "", time: "" };
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { day: "", date: "", time: "" };
    try {
      const day = d.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase();
      const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const time = d.toLocaleTimeString(undefined, localeTimeOptions());
      return { day, date, time };
    } catch {
      return { day: "", date: "", time: iso };
    }
  }

  function fmtMarketsUpdated(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    try {
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        ...localeTimeOptions(),
      });
    } catch {
      return iso;
    }
  }

  function marketsBookLabel(key) {
    if (!key) return "";
    const labels = {
      pinnacle: "Pinnacle",
      betfair_ex_uk: "Betfair EX",
      betfair_ex_eu: "Betfair EX",
      williamhill: "William Hill",
      unibet_uk: "Unibet",
      ladbrokes_uk: "Ladbrokes",
      paddypower: "Paddy Power",
      skybet: "Sky Bet",
    };
    if (labels[key]) return labels[key];
    return String(key)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function marketsApiLabel() {
    const source = (MARKETS.meta || {}).source;
    if (!source) return "";
    if (source === "the-odds-api") return "The Odds API";
    return String(source);
  }

  function marketsPrimaryBookKey() {
    const counts = new Map();
    for (const fx of MARKETS.fixtures || []) {
      const key = fx.books && fx.books.primary;
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let best = "";
    let bestN = -1;
    for (const [key, n] of counts) {
      if (n > bestN) {
        best = key;
        bestN = n;
      }
    }
    return best;
  }

  function marketsAttributionText() {
    const parts = [];
    if (MARKETS.generatedAt) {
      const when = fmtMarketsUpdated(MARKETS.generatedAt);
      if (when) parts.push(`Updated ${when}`);
    }
    const api = marketsApiLabel();
    if (api) parts.push(api);
    const book = marketsBookLabel(marketsPrimaryBookKey());
    if (book) parts.push(`Odds: ${book}`);
    const hours = marketsCompareHours();
    if (state.marketsCompare !== "current") {
      const snap = pickMarketsHistorySnapshot(hours);
      if (snap && snap.generatedAt) {
        const vs = fmtMarketsUpdated(snap.generatedAt);
        if (vs) parts.push(`vs ${vs}`);
        else parts.push(state.marketsCompare === "last" ? "vs last run" : "vs last 72h");
      } else {
        parts.push(
          state.marketsCompare === "last" ? "No prior run yet" : "No ~72h snapshot yet"
        );
      }
    }
    return parts.join(" · ");
  }

  function marketsTeamLabel(side) {
    if (!side) return "—";
    return TEAM_NAMES[side.code] || side.code || side.name || "—";
  }

  /** Heat band for goals / CS cells — high = strong, low = weak. */
  function clampMarketsHeat(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return MARKETS_HEAT_DEFAULT;
    return Math.min(MARKETS_HEAT_MAX, Math.max(MARKETS_HEAT_MIN, Math.round(n / 5) * 5));
  }

  function loadMarketsHeat(key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null || raw === "") return MARKETS_HEAT_DEFAULT;
      return clampMarketsHeat(raw);
    } catch {
      return MARKETS_HEAT_DEFAULT;
    }
  }

  function saveMarketsHeat(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* private browsing */
    }
  }

  state.marketsHeatGoals = loadMarketsHeat(MARKETS_HEAT_GOALS_KEY);
  state.marketsHeatCs = loadMarketsHeat(MARKETS_HEAT_CS_KEY);

  /** Map a 0–100 strength → high/low cutoffs for one metric. Default 50 = original bands. */
  function marketsMetricThresholds(kind, strength) {
    const t = (clampMarketsHeat(strength) - 50) / 50; // -1 … +1
    if (kind === "goals") {
      return {
        high: 1.85 - t * 0.35, // 2.20 → 1.50
        low: 1.0 + t * 0.25, // 0.75 → 1.25
      };
    }
    return {
      high: 38 - t * 10, // 48 → 28
      low: 18 + t * 7, // 11 → 25
    };
  }

  function marketsHeatTone(kind, value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return "mid";
    const strength = kind === "goals" ? state.marketsHeatGoals : state.marketsHeatCs;
    const th = marketsMetricThresholds(kind, strength);
    const span = Math.max(th.high - th.low, kind === "goals" ? 0.4 : 8);
    const veryHigh = th.high + span * 0.5;
    const veryLow = th.low - span * 0.5;
    if (v >= veryHigh) return "very-high";
    if (v < veryLow) return "very-low";
    if (v >= th.high) return "high";
    if (v < th.low) return "low";
    return "mid";
  }

  function formatMarketsGoalsHeatLabel(strength) {
    const th = marketsMetricThresholds("goals", strength);
    return `≥${th.high.toFixed(2)} / <${th.low.toFixed(2)}`;
  }

  function formatMarketsCsHeatLabel(strength) {
    const th = marketsMetricThresholds("cs", strength);
    return `≥${Math.round(th.high)}% / <${Math.round(th.low)}%`;
  }

  function marketsScoreRowHTML(score, prob, homeCode, awayCode) {
    const parts = String(score || "").split("-");
    const hs = parts[0] != null ? parts[0].trim() : "—";
    const as = parts[1] != null ? parts[1].trim() : "—";
    return `<div class="markets-score-row">
      ${badgeHTML(homeCode, "markets-score-badge")}
      <span class="markets-score-pill">${escapeHtml(hs)}&nbsp;-&nbsp;${escapeHtml(as)}</span>
      ${badgeHTML(awayCode, "markets-score-badge")}
      <span class="markets-score-pct">${Number(prob).toFixed(0)}%</span>
    </div>`;
  }

  // A/B graduated: every matchup uses a Poisson score matrix in Scoreline view.
  const MARKETS_SCORE_MATRIX_MAX = 4;

  function poissonPmf(k, lam) {
    const L = Math.max(0, Number(lam) || 0);
    if (L <= 0) return k === 0 ? 1 : 0;
    let fact = 1;
    for (let i = 2; i <= k; i++) fact *= i;
    return Math.exp(-L) * Math.pow(L, k) / fact;
  }

  function marketsScoreMatrixHTML(fx) {
    const lh = Number(fx.goals?.home);
    const la = Number(fx.goals?.away);
    if (!Number.isFinite(lh) || !Number.isFinite(la)) {
      return `<div class="markets-scores-empty">—</div>`;
    }
    const maxG = MARKETS_SCORE_MATRIX_MAX;
    const cells = [];
    let peak = 0;
    for (let i = 0; i <= maxG; i++) {
      for (let j = 0; j <= maxG; j++) {
        const p = poissonPmf(i, lh) * poissonPmf(j, la);
        if (p > peak) peak = p;
        cells.push({ i, j, p });
      }
    }
    const homeCode = fx.home?.code || "H";
    const awayCode = fx.away?.code || "A";
    const homeBadge =
      playerCrestHTML(homeCode) ||
      `<span class="markets-score-matrix-code">${escapeHtml(homeCode)}</span>`;
    const awayBadge =
      playerCrestHTML(awayCode) ||
      `<span class="markets-score-matrix-code">${escapeHtml(awayCode)}</span>`;

    let xNums = "";
    for (let j = 0; j <= maxG; j++) {
      xNums += `<span class="markets-score-matrix-x">${j}</span>`;
    }

    let grid = "";
    for (let i = 0; i <= maxG; i++) {
      grid += `<span class="markets-score-matrix-y">${i}</span>`;
      for (let j = 0; j <= maxG; j++) {
        const cell = cells[i * (maxG + 1) + j];
        const pct = cell.p * 100;
        const intensity = peak > 0 ? cell.p / peak : 0;
        const hot = pct >= 1.5;
        grid += `<span class="markets-score-matrix-cell${hot ? " is-hot" : ""}" style="--msm-p:${intensity.toFixed(
          3
        )}" title="${i}-${j}: ${pct.toFixed(1)}%"><span class="msm-pct">${
          pct < 0.5 ? "·" : pct.toFixed(0) + "%"
        }</span></span>`;
      }
    }

    return `<div class="markets-score-matrix" role="img" aria-label="Exact-score odds matrix, ${escapeHtml(
      homeCode
    )} rows vs ${escapeHtml(awayCode)} columns">
      <div class="markets-score-matrix-x-head">
        <span class="markets-score-matrix-pad" aria-hidden="true"></span>
        <div class="markets-score-matrix-x-block">
          <span class="markets-score-matrix-axis-label markets-score-matrix-x-badge" title="${escapeHtml(
            fx.away?.name || awayCode
          )} goals">${awayBadge}<span class="markets-score-matrix-team">${escapeHtml(awayCode)}</span></span>
          <div class="markets-score-matrix-x-nums">${xNums}</div>
        </div>
      </div>
      <div class="markets-score-matrix-body">
        <span class="markets-score-matrix-axis-label markets-score-matrix-y-badge" title="${escapeHtml(
          fx.home?.name || homeCode
        )} goals">${homeBadge}<span class="markets-score-matrix-team">${escapeHtml(homeCode)}</span></span>
        <div class="markets-score-matrix-grid">${grid}</div>
      </div>
    </div>`;
  }

  function marketsCompareHours() {
    if (state.marketsCompare === "72h") return 72;
    return 0;
  }

  function pickMarketsHistorySnapshot(hoursAgo) {
    const hist = Array.isArray(MARKETS.history) ? MARKETS.history : [];
    if (!hist.length) return null;
    if (!hoursAgo) {
      // Last run = most recent retained snapshot.
      let best = null;
      let bestT = -Infinity;
      for (const snap of hist) {
        const t = Date.parse(snap && snap.generatedAt);
        if (!Number.isFinite(t)) continue;
        if (t >= bestT) {
          bestT = t;
          best = snap;
        }
      }
      return best;
    }
    const target = Date.now() - hoursAgo * 3600 * 1000;
    let best = null;
    let bestScore = Infinity;
    for (const snap of hist) {
      const t = Date.parse(snap && snap.generatedAt);
      if (!Number.isFinite(t)) continue;
      const dist = Math.abs(t - target);
      // Prefer snapshots at or before the lookback target.
      const score = t > target ? dist + 6 * 3600 * 1000 : dist;
      if (score < bestScore) {
        bestScore = score;
        best = snap;
      }
    }
    return best;
  }

  function marketsBaselineMap() {
    if (state.marketsCompare === "current") return null;
    const hours = marketsCompareHours(); // 0 => last run
    const snap = pickMarketsHistorySnapshot(hours);
    if (!snap || !Array.isArray(snap.fixtures)) return null;
    const byId = new Map();
    for (const fx of snap.fixtures) {
      if (!fx || fx.id == null) continue;
      byId.set(String(fx.id), fx);
    }
    return { generatedAt: snap.generatedAt || "", byId };
  }

  function marketsBaselineSide(baselineFx, role) {
    if (!baselineFx) return null;
    const goals = baselineFx.goals || {};
    const cs = baselineFx.cleanSheet || {};
    return {
      goals: role === "home" ? Number(goals.home) : Number(goals.away),
      cs: role === "home" ? Number(cs.home) : Number(cs.away),
    };
  }

  function marketsStatDeltaHTML(current, past, { decimals = 2, suffix = "", kind = "goals" } = {}) {
    if (state.marketsCompare === "current") return "";
    if (!Number.isFinite(current) || !Number.isFinite(past)) {
      return `<span class="markets-stat-delta markets-stat-delta-empty" title="No earlier snapshot for this fixture">—</span>`;
    }
    const delta = current - past;
    const eps = kind === "cs" ? 0.51 : 0.015;
    if (Math.abs(delta) < eps) {
      return `<span class="markets-stat-delta markets-stat-delta-flat" title="Unchanged vs earlier pull">${iconHTML(
        "minus"
      )}<span>0${suffix}</span></span>`;
    }
    const up = delta > 0;
    const abs = Math.abs(delta).toFixed(decimals);
    const tip = `${up ? "Up" : "Down"} ${abs}${suffix} vs earlier pull`;
    return `<span class="markets-stat-delta markets-stat-delta-${
      up ? "up" : "down"
    }" title="${escapeHtml(tip)}">${iconHTML(up ? "trending-up" : "trending-down")}<span>${
      up ? "+" : "−"
    }${escapeHtml(abs)}${escapeHtml(suffix)}</span></span>`;
  }

  function marketsTeamRowHTML(side, goals, cs, role, baselineSide) {
    const code = side?.code || "";
    const label = marketsTeamLabel(side);
    const gTone = marketsHeatTone("goals", goals);
    const cTone = marketsHeatTone("cs", cs);
    const sideMark =
      role === "home"
        ? `<span class="markets-side-mark" title="Home" aria-label="Home">H</span>`
        : `<span class="markets-side-mark" title="Away" aria-label="Away">A</span>`;
    const pastGoals =
      baselineSide && Number.isFinite(Number(baselineSide.goals))
        ? Number(baselineSide.goals)
        : null;
    const pastCs =
      baselineSide && Number.isFinite(Number(baselineSide.cs))
        ? Number(baselineSide.cs)
        : null;
    return `<div class="markets-team-row markets-team-row-${role}" data-team="${escapeHtml(code)}">
      <div class="markets-team-cell" data-team="${escapeHtml(code)}">
        ${playerCrestHTML(code)}
        <span class="markets-side-name">${escapeHtml(label)}</span>
        ${sideMark}
      </div>
      <div class="markets-stat markets-stat-${gTone}" title="Projected goals">
        <span class="markets-stat-stack">
          <span class="markets-stat-value" data-count-to="${Number(goals)}" data-count-decimals="2">${Number(goals).toFixed(2)}</span>
          ${marketsStatDeltaHTML(Number(goals), pastGoals, { decimals: 2, kind: "goals" })}
        </span>
      </div>
      <div class="markets-stat markets-stat-${cTone}" title="Clean sheet %">
        <span class="markets-stat-stack">
          <span class="markets-stat-value" data-count-to="${Math.round(Number(cs))}" data-count-decimals="0" data-count-suffix="%">${Math.round(Number(cs))}%</span>
          ${marketsStatDeltaHTML(Number(cs), pastCs, { decimals: 0, suffix: "%", kind: "cs" })}
        </span>
      </div>
    </div>`;
  }

  function marketsLocalDateKey(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function marketsDateDividerHTML(iso) {
    const when = fmtMarketsKickoffParts(iso);
    const label = [when.day, when.date].filter(Boolean).join(" · ") || "Upcoming";
    return `<div class="markets-divider" role="heading" aria-level="3"><span>${escapeHtml(label)}</span></div>`;
  }

  function marketsCardViews() {
    return [
      { key: "stats", label: "Goals and CS%" },
      { key: "scoreline", label: "Scoreline" },
    ];
  }

  function currentMarketsCardView() {
    const views = marketsCardViews();
    return views.find((v) => v.key === state.marketsCardView) || views[0];
  }

  function setMarketsCardView(key, { rerender = true } = {}) {
    const views = marketsCardViews();
    if (!views.some((v) => v.key === key)) return;
    if (state.marketsCardView === key) return;
    state.marketsCardView = key;
    syncMarketsViewControls();
    if (rerender) renderMarkets();
  }

  function syncMarketsViewControls() {
    const marketsMobile = preferMobileSheet() && state.page === "markets";
    const marketsDesktop = !preferMobileSheet() && state.page === "markets";
    syncMarketsViewSeg();
    const viewControl = el.marketsViewControl;
    if (viewControl && el.marketsHeaderActions && el.marketsControls) {
      if (preferMobileSheet()) {
        if (viewControl.parentElement !== el.marketsControls) {
          el.marketsControls.insertBefore(viewControl, el.marketsControls.firstChild);
        }
      } else if (viewControl.parentElement !== el.marketsHeaderActions) {
        el.marketsHeaderActions.insertBefore(
          viewControl,
          el.marketsSlidersToggle || el.marketsHeaderActions.firstChild
        );
      }
    }
    // Sliders live under Markets only: header on desktop; mobile FAB dock.
    if (el.marketsSlidersToggle && el.marketsHeaderActions) {
      if (marketsMobile) {
        if (
          el.marketsSlidersToggle.parentElement !== el.marketsHeaderActions &&
          el.marketsSlidersToggle.parentElement !== el.mobileFilterDock
        ) {
          el.marketsHeaderActions.appendChild(el.marketsSlidersToggle);
        }
        el.marketsSlidersToggle.hidden = false;
      } else {
        if (el.marketsSlidersToggle.parentElement !== el.marketsHeaderActions) {
          el.marketsHeaderActions.appendChild(el.marketsSlidersToggle);
        }
        el.marketsSlidersToggle.hidden = !marketsDesktop;
      }
    }
    syncMobileChrome();
  }

  function marketsCardHTML(fx, baseline) {
    const homeCode = fx.home?.code || "";
    const awayCode = fx.away?.code || "";
    const goalsH = Number(fx.goals?.home);
    const goalsA = Number(fx.goals?.away);
    const csH = Number(fx.cleanSheet?.home);
    const csA = Number(fx.cleanSheet?.away);
    const when = fmtMarketsKickoffParts(fx.commenceTime);
    const topScores = (fx.topScores || []).slice(0, 3);
    const kickLabel = [when.day, when.date, when.time].filter(Boolean).join(" ");
    const pastFx =
      baseline && fx.id != null ? baseline.byId.get(String(fx.id)) : null;
    const homeBase = marketsBaselineSide(pastFx, "home");
    const awayBase = marketsBaselineSide(pastFx, "away");
    const compareCls = state.marketsCompare !== "current" ? " markets-card-compare" : "";
    const scorelineMode = state.marketsCardView === "scoreline";

    if (scorelineMode) {
      const matrixHTML = marketsScoreMatrixHTML(fx);
      const hasMatrix = !matrixHTML.includes("markets-scores-empty");
      const scoresHTML = hasMatrix
        ? matrixHTML
        : topScores.length
          ? topScores.map((s) => marketsScoreRowHTML(s.score, s.prob, homeCode, awayCode)).join("")
          : `<div class="markets-scores-empty">—</div>`;
      return `<article class="markets-card markets-card-scoreline${hasMatrix ? " markets-card-matrix" : ""}${compareCls}">
        <div class="markets-body markets-body-scoreline">
          <div class="markets-scoreline-head">
            <span class="markets-col-head markets-col-head-team markets-kickoff"${kickLabel ? ` title="${escapeHtml(kickLabel)}"` : ""}>${escapeHtml(when.time || "")}</span>
          </div>
          <div class="${hasMatrix ? "markets-scores-matrix-wrap" : "markets-scores-list markets-scores-list-solo"}" aria-label="${hasMatrix ? "Score matrix" : "Most likely scores"}">${scoresHTML}</div>
        </div>
      </article>`;
    }

    return `<article class="markets-card markets-card-stats${compareCls}">
      <div class="markets-body">
        <div class="markets-body-heads markets-body-heads-solo">
          <div class="markets-col-heads">
            <span class="markets-col-head markets-col-head-team markets-kickoff"${kickLabel ? ` title="${escapeHtml(kickLabel)}"` : ""}>${escapeHtml(when.time || "")}</span>
            <span class="markets-col-head">Goals</span>
            <span class="markets-col-head">CS%</span>
          </div>
        </div>
        <div class="markets-body-rows markets-body-rows-solo">
          <div class="markets-teams">
            ${marketsTeamRowHTML(fx.home, goalsH, csH, "home", homeBase)}
            ${marketsTeamRowHTML(fx.away, goalsA, csA, "away", awayBase)}
          </div>
        </div>
      </div>
    </article>`;
  }

  function syncMarketsAttribution() {
    if (!el.marketsAttribution) return;
    const text = marketsAttributionText();
    if (!text) {
      el.marketsAttribution.hidden = true;
      el.marketsAttribution.textContent = "";
      return;
    }
    el.marketsAttribution.hidden = false;
    el.marketsAttribution.textContent = text;
  }

  function syncMarketsCompareSeg() {
    if (!el.marketsCompareSeg) return;
    $$("#markets-compare-seg button[data-markets-compare]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.marketsCompare === state.marketsCompare);
    });
    syncSegThumb(el.marketsCompareSeg, { animate: false });
  }

  function syncMarketsViewSeg() {
    if (!el.marketsViewSeg) return;
    $$("#markets-view-seg button[data-markets-view]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.marketsView === state.marketsCardView);
    });
    syncSegThumb(el.marketsViewSeg, { animate: false });
    if (el.marketsControls) {
      el.marketsControls.classList.toggle("is-scoreline-view", state.marketsCardView === "scoreline");
    }
  }

  function renderMarkets() {
    const root = el.marketsGrid;
    if (!root) return;
    const fixtures = MARKETS.fixtures || [];
    syncMarketsCompareSeg();
    syncMarketsViewSeg();
    syncMarketsAttribution();
    if (!fixtures.length) {
      root.innerHTML = `<div class="empty-state markets-empty">
        <p>No market odds loaded yet.</p>
        <p class="markets-empty-hint">Add <code>ODDS_API_KEY</code> to the project <code>.env</code>, then run:</p>
        <pre class="markets-empty-cmd">python3 site/fetch_markets.py</pre>
      </div>`;
      return;
    }

    const baseline = marketsBaselineMap();
    const groups = new Map();
    for (const fx of fixtures) {
      const key = marketsLocalDateKey(fx.commenceTime) || "_";
      let group = groups.get(key);
      if (!group) {
        group = { sampleIso: fx.commenceTime, fixtures: [] };
        groups.set(key, group);
      }
      group.fixtures.push(fx);
    }

    const parts = [];
    for (const group of groups.values()) {
      parts.push(marketsDateDividerHTML(group.sampleIso));
      for (const fx of group.fixtures) parts.push(marketsCardHTML(fx, baseline));
    }
    root.innerHTML = parts.join("");
    syncMarketsViewControls();
  }

  // Ownership page — multi-line selected_by% over manual check-ins
  // ---------------------------------------------------------------------
  const OWNERSHIP_TOP_PLAYERS = 100;
  const OWNERSHIP_TEAM_TOP_N = 20;
  const OWNERSHIP_PAD = { top: 18, right: 18, bottom: 32, left: 42 };
  const OWNERSHIP_POINT_HIT = 16;
  const OWNERSHIP_LINE_HIT = 10;
  const OWNERSHIP_PLAYER_TREND_CARD_N = 5;
  const OWNERSHIP_TEAM_TREND_CARD_N = 5;

  let ownershipHoverKey = null;
  let ownershipHoverIndex = null;
  let ownershipTipStats = null;
  let ownershipPinnedKey = null;
  let ownershipPinnedFromChart = false;
  let ownershipTipTimer = null;
  let ownershipSeriesCache = [];
  let ownershipLayout = null;
  let ownershipRo = null;

  function ownershipCheckIns() {
    return Array.isArray(OWNERSHIP.checkIns) ? OWNERSHIP.checkIns : [];
  }

  function ownershipCatalogByCode() {
    const map = new Map();
    const combined = (DATA.players && DATA.players.combined) || [];
    for (const row of combined) {
      if (row && row.code != null) map.set(Number(row.code), row);
    }
    return map;
  }

  function fmtOwnershipDate(iso) {
    if (!iso) return "";
    const [y, m, d] = String(iso).split("-").map(Number);
    if (!y || !m || !d) return String(iso);
    const dt = new Date(Date.UTC(y, m - 1, d));
    try {
      return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
    } catch {
      return `${d} ${m}/${y}`;
    }
  }

  function fmtOwnedPct(v) {
    if (v == null || Number.isNaN(v)) return "—";
    return Number(v).toFixed(1);
  }

  function ownershipDelta(curr, prev) {
    if (curr == null || prev == null) return null;
    return Math.round((Number(curr) - Number(prev)) * 10) / 10;
  }

  function ownershipTrendWindowSpan() {
    const n = Number(state.ownershipTrendWindow);
    return n === 3 || n === 7 ? n : 1;
  }

  // Chart x-axis follows the trend window: span steps ⇒ span+1 check-ins
  // (the endpoints of the delta used for risers/fallers).
  function ownershipChartWindow(checkIns = ownershipCheckIns()) {
    const all = Array.isArray(checkIns) ? checkIns : [];
    const span = ownershipTrendWindowSpan();
    const count = Math.min(all.length, span + 1);
    const startIdx = Math.max(0, all.length - count);
    const endIdx = all.length ? all.length - 1 : -1;
    return {
      startIdx,
      endIdx,
      count,
      checkIns: count ? all.slice(startIdx) : [],
    };
  }

  function ownershipTrendCardLimit() {
    return state.view === "teams" ? OWNERSHIP_TEAM_TREND_CARD_N : OWNERSHIP_PLAYER_TREND_CARD_N;
  }

  // Rank movers without team/pos chips so filters only subset the chart —
  // coloring stays the global top-N, not "top-N of this club".
  function ownershipTrendRankSeries() {
    return state.view === "teams"
      ? buildOwnershipTeamSeries({ ignoreTeamPos: true })
      : buildOwnershipPlayerSeries({ ignoreTeamPos: true });
  }

  function ownershipTrendColoredKeys(rankSeries) {
    const scored = (rankSeries || []).map((s) => ({
      series: s,
      trend: ownershipTrendScore(s),
    }));
    const cardLimit = ownershipTrendCardLimit();
    const keys = new Set();
    scored
      .filter((x) => x.trend.kind === "riser")
      .sort(compareOwnershipTrends)
      .slice(0, cardLimit)
      .forEach((x) => keys.add(x.series.key));
    scored
      .filter((x) => x.trend.kind === "faller")
      .sort(compareOwnershipTrends)
      .slice(0, cardLimit)
      .forEach((x) => keys.add(x.series.key));
    return keys;
  }

  // Score the window delta only — top-N coloring is applied later via _trendCard.
  function ownershipTrendScore(series) {
    const owned = (series.points || [])
      .filter((pt) => pt && pt.owned != null && !Number.isNaN(Number(pt.owned)))
      .map((pt) => Number(pt.owned));
    if (owned.length < 2) {
      return {
        kind: "flat",
        recent: 0,
        net: 0,
        current: owned.length ? owned[owned.length - 1] : null,
      };
    }
    const last = owned[owned.length - 1];
    const span = ownershipTrendWindowSpan();
    const fromIdx = Math.max(0, owned.length - 1 - span);
    const recent = Math.round((last - owned[fromIdx]) * 10) / 10;
    const net = Math.round((last - owned[0]) * 10) / 10;
    const current = last;
    let kind = "flat";
    if (recent > 0) kind = "riser";
    else if (recent < 0) kind = "faller";
    return { kind, recent, net, current };
  }

  function fmtOwnershipTrendDelta(delta) {
    if (delta == null || Number.isNaN(delta)) return "—";
    const n = Number(delta);
    if (n > 0) return `+${n.toFixed(1)}`;
    return n.toFixed(1);
  }

  function ownershipTrendCardHTML(series, trend) {
    const badge = series.team ? badgeHTML(series.team) : "";
    const deltaCls =
      trend.kind === "riser" ? "is-up" : trend.kind === "faller" ? "is-down" : "is-flat";
    const meta =
      series.kind === "team" ? "" : series.position ? series.position : "";
    const owned = Number(trend.current);
    const recent = Number(trend.recent);
    const ownedAttr = Number.isFinite(owned)
      ? ` data-count-to="${owned}" data-count-decimals="1"`
      : "";
    const deltaAttr = Number.isFinite(recent)
      ? ` data-count-to="${recent}" data-count-decimals="1" data-count-signed="1"`
      : "";
    return `<button type="button" class="ownership-trend-row" data-ownership-key="${escapeHtml(series.key)}">
      <span class="ownership-trend-identity">${badge}<span class="ownership-trend-name">${escapeHtml(series.name || "")}</span></span>
      ${meta ? `<span class="ownership-trend-meta">${escapeHtml(meta)}</span>` : ""}
      <span class="ownership-trend-owned"${ownedAttr}>${escapeHtml(fmtOwnedPct(trend.current))}</span>
      <span class="ownership-trend-delta ${deltaCls}"${deltaAttr}>${escapeHtml(fmtOwnershipTrendDelta(trend.recent))}</span>
    </button>`;
  }

  function compareOwnershipTrends(a, b) {
    const ar = Math.abs(a.trend.recent);
    const br = Math.abs(b.trend.recent);
    if (ar !== br) return br - ar;
    const an = Math.abs(a.trend.net);
    const bn = Math.abs(b.trend.net);
    if (an !== bn) return bn - an;
    return (b.trend.current || 0) - (a.trend.current || 0);
  }

  function ownershipSeriesTrend(series) {
    return series && (series._trend || ownershipTrendScore(series));
  }

  function ownershipSeriesTrendQualifies(series) {
    // Colored only when this series made the top-N riser/faller cards.
    return !!(series && series._trendCard);
  }

  function syncOwnershipTrendingUI() {
    if (el.ownershipTrendCards) {
      el.ownershipTrendCards.hidden = state.page !== "ownership";
    }
    syncOwnershipTrendWindowUI();
  }

  function syncOwnershipTrendWindowUI({ animate = false } = {}) {
    if (!el.ownershipTrendWindowSeg) return;
    const cur = String(ownershipTrendWindowSpan());
    el.ownershipTrendWindowSeg.querySelectorAll("[data-trend-window]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.trendWindow === cur);
    });
    syncSegThumb(el.ownershipTrendWindowSeg, { animate });
  }

  function renderOwnershipTrendCards(series, coloredKeys) {
    if (!el.ownershipTrendRisers || !el.ownershipTrendFallers) return;
    const keySet = coloredKeys || new Set();
    const scored = (series || []).map((s) => ({
      series: s,
      trend: s._trend || ownershipTrendScore(s),
    }));
    // Cards list global top movers that remain after team/pos filters —
    // not a re-ranked top-N of the filtered club/position alone.
    const risers = scored
      .filter((x) => keySet.has(x.series.key) && x.trend.kind === "riser")
      .sort(compareOwnershipTrends);
    const fallers = scored
      .filter((x) => keySet.has(x.series.key) && x.trend.kind === "faller")
      .sort(compareOwnershipTrends);
    (series || []).forEach((item) => {
      item._trendCard = keySet.has(item.key);
    });
    const empty = `<div class="ownership-trend-empty">No top movers match the current filters.</div>`;
    el.ownershipTrendRisers.innerHTML = risers.length
      ? risers.map((x) => ownershipTrendCardHTML(x.series, x.trend)).join("")
      : empty;
    el.ownershipTrendFallers.innerHTML = fallers.length
      ? fallers.map((x) => ownershipTrendCardHTML(x.series, x.trend)).join("")
      : empty;
    syncOwnershipTrendCollapse();
    syncOwnershipTrendingUI();
  }

  function syncOwnershipTrendCollapse() {
    const riserCol = el.ownershipTrendCards && el.ownershipTrendCards.querySelector(".ownership-trend-col.is-risers");
    const fallerCol = el.ownershipTrendCards && el.ownershipTrendCards.querySelector(".ownership-trend-col.is-fallers");
    if (riserCol) {
      riserCol.classList.toggle("is-collapsed", !!state.ownershipRisersCollapsed);
      const btn = riserCol.querySelector("[data-ownership-collapse='risers']");
      if (btn) btn.setAttribute("aria-expanded", state.ownershipRisersCollapsed ? "false" : "true");
    }
    if (fallerCol) {
      fallerCol.classList.toggle("is-collapsed", !!state.ownershipFallersCollapsed);
      const btn = fallerCol.querySelector("[data-ownership-collapse='fallers']");
      if (btn) btn.setAttribute("aria-expanded", state.ownershipFallersCollapsed ? "false" : "true");
    }
  }

  function ownershipPlayerPassesFilters(p, catalog, { ignoreTeamPos = false } = {}) {
    if (!ignoreTeamPos && state.posFilter.size && !state.posFilter.has(p.position)) return false;
    if (!ignoreTeamPos && state.teamFilter.size && !state.teamFilter.has(p.team)) return false;
    const price = Number(p.price);
    if (Number.isFinite(price) && (price < state.priceMin || price > state.priceMax)) return false;
    if (!Number.isFinite(Number(p.owned)) || Number(p.owned) < state.ownedMin) return false;
    if (!isNextSeason() && HAS_PRICE_DATA) {
      const row = catalog.get(Number(p.code));
      if (excludeDepartedPlayer(row)) return false;
    }
    const q = state.search.trim().toLowerCase();
    if (q) {
      const hay = `${p.name || ""} ${p.team || ""} ${teamNameForSeason(p.team) || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function ownershipTeamPassesFilters(team, name, { ignoreTeamPos = false } = {}) {
    if (!ignoreTeamPos && state.teamFilter.size && !state.teamFilter.has(team)) return false;
    const q = state.search.trim().toLowerCase();
    if (q) {
      const hay = `${name || ""} ${team || ""} ${teamNameForSeason(team) || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function teamTopNAvg(players, n) {
    if (!players || players.length < n) return null;
    const sorted = players.slice().sort((a, b) => (b.owned || 0) - (a.owned || 0) || a.code - b.code);
    const top = sorted.slice(0, n);
    const sum = top.reduce((s, p) => s + (Number(p.owned) || 0), 0);
    return { owned: Math.round((sum / n) * 10) / 10, n, sample: top[0] };
  }

  function ownershipOwnedValues(series, startIdx = null, endIdx = null) {
    return (series || []).flatMap((item) =>
      (item.points || [])
        .filter((point) => {
          if (!point) return false;
          if (startIdx != null && point.i < startIdx) return false;
          if (endIdx != null && point.i > endIdx) return false;
          return true;
        })
        .map((point) => Number(point.owned))
        .filter(Number.isFinite)
    );
  }

  function ownershipScaleRange(series, startIdx = null, endIdx = null) {
    const values = ownershipOwnedValues(series, startIdx, endIdx);
    const dataMax = values.length ? Math.max(...values) : 10;
    const dataMin = values.length ? Math.min(...values) : 0;
    return niceOwnershipRange(dataMin, dataMax);
  }

  function buildOwnershipPlayerSeries({ ignoreTeamPos = false } = {}) {
    const checkIns = ownershipCheckIns();
    if (!checkIns.length) return [];
    const catalog = ownershipCatalogByCode();
    const latest = checkIns[checkIns.length - 1];
    const universe = (latest.players || []).filter((p) =>
      ownershipPlayerPassesFilters(p, catalog, { ignoreTeamPos })
    );
    const top = universe
      .slice()
      .sort((a, b) => (b.owned || 0) - (a.owned || 0) || a.code - b.code)
      .slice(0, OWNERSHIP_TOP_PLAYERS);
    const byCodeAt = checkIns.map((ci) => {
      const map = new Map();
      (ci.players || []).forEach((p) => map.set(Number(p.code), p));
      return map;
    });
    return top.map((seed) => {
      const points = checkIns.map((ci, i) => {
        const hit = byCodeAt[i].get(Number(seed.code));
        if (!hit) return { i, checkedAt: ci.checkedAt, owned: null, player: null };
        return { i, checkedAt: ci.checkedAt, owned: Number(hit.owned), player: hit };
      });
      const last = points.filter((pt) => pt.player).pop();
      const player = (last && last.player) || seed;
      return {
        key: `p:${seed.code}`,
        kind: "player",
        code: Number(seed.code),
        name: player.name,
        team: player.team,
        position: player.position,
        price: player.price,
        points,
        filteredCount: universe.length,
      };
    });
  }

  function buildOwnershipTeamSeries({ ignoreTeamPos = false } = {}) {
    const checkIns = ownershipCheckIns();
    if (!checkIns.length) return [];
    const perCheckIn = checkIns.map((ci) => {
      const byTeam = new Map();
      (ci.players || []).forEach((p) => {
        if (!p.team) return;
        if (!byTeam.has(p.team)) byTeam.set(p.team, []);
        byTeam.get(p.team).push(p);
      });
      const map = new Map();
      byTeam.forEach((list, team) => {
        const agg = teamTopNAvg(list, OWNERSHIP_TEAM_TOP_N);
        if (agg) map.set(team, agg);
      });
      return map;
    });
    const latestMap = perCheckIn[perCheckIn.length - 1];
    const teams = Array.from(latestMap.keys()).filter((team) =>
      ownershipTeamPassesFilters(team, teamNameForSeason(team), { ignoreTeamPos })
    );
    teams.sort((a, b) => (latestMap.get(b).owned || 0) - (latestMap.get(a).owned || 0) || a.localeCompare(b));
    return teams.map((team) => {
      const points = checkIns.map((ci, i) => {
        const hit = perCheckIn[i].get(team);
        if (!hit) return { i, checkedAt: ci.checkedAt, owned: null, n: null };
        return { i, checkedAt: ci.checkedAt, owned: hit.owned, n: hit.n };
      });
      return {
        key: `t:${team}`,
        kind: "team",
        team,
        name: teamNameForSeason(team) || team,
        points,
        filteredCount: teams.length,
      };
    });
  }

  function ownershipPolylines(points, xAt, yAt, startIdx = null, endIdx = null) {
    const lines = [];
    let cur = [];
    points.forEach((pt) => {
      if (
        startIdx != null &&
        endIdx != null &&
        (pt.i < startIdx || pt.i > endIdx)
      ) {
        if (cur.length) lines.push(cur);
        cur = [];
        return;
      }
      if (pt.owned == null || Number.isNaN(pt.owned)) {
        if (cur.length) lines.push(cur);
        cur = [];
        return;
      }
      cur.push({ x: xAt(pt.i), y: yAt(pt.owned), i: pt.i, owned: pt.owned });
    });
    if (cur.length) lines.push(cur);
    return lines;
  }

  // Catmull–Rom → cubic Bezier so series pass through each check-in smoothly
  // instead of sharp polyline corners.
  function pathFromPts(pts) {
    if (!pts.length) return "";
    if (pts.length === 1) return `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    if (pts.length === 2) {
      return `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} L${pts[1].x.toFixed(1)} ${pts[1].y.toFixed(1)}`;
    }
    let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return d;
  }

  function distPointSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-6) {
      const ex = px - ax;
      const ey = py - ay;
      return Math.hypot(ex, ey);
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function niceOwnershipStep(range) {
    const span = Math.max(0, Number(range) || 0);
    if (span <= 8) return 1;
    if (span <= 16) return 2;
    if (span <= 40) return 5;
    return 10;
  }

  function niceOwnershipRange(rawMin, rawMax) {
    const dataMax = Math.max(0, Number(rawMax) || 0);
    const dataMin = Math.max(0, Number(rawMin) || 0);
    const span = Math.max(dataMax - dataMin, 4);
    const pad = Math.max(span * 0.06, 0.6);
    let yMin = Math.max(0, dataMin - pad);
    let yMax = Math.min(100, dataMax + pad);
    if (yMax <= yMin) yMax = Math.min(100, yMin + span);
    const step = niceOwnershipStep(yMax - yMin);
    yMin = Math.floor(yMin / step) * step;
    yMax = Math.ceil(yMax / step) * step;
    if (yMax <= yMin) yMax = yMin + step;
    return { yMin, yMax, step };
  }

  function ownershipUsesSelectionCard() {
    // Touch / narrow: selection lives in a dedicated card, not a floating tip over the plot.
    return NARROW_MQ.matches || !hasFineHover();
  }

  function hideOwnershipSelection() {
    if (!el.ownershipSelection) return;
    el.ownershipSelection.hidden = true;
    el.ownershipSelection.innerHTML = "";
  }

  function clearOwnershipSelection() {
    ownershipPinnedKey = null;
    ownershipPinnedFromChart = false;
    setOwnershipHover(null, null);
    hideOwnershipTooltip();
  }

  function bindOwnershipTipPhotoFallback(root) {
    if (!root) return;
    root.querySelectorAll("img.own-tip-photo").forEach((img) => {
      img.addEventListener("error", () => {
        const fallback = document.createElement("span");
        fallback.className = "own-tip-photo own-tip-photo-fallback";
        fallback.setAttribute("aria-hidden", "true");
        fallback.textContent = img.getAttribute("data-initials") || "?";
        img.replaceWith(fallback);
      }, { once: true });
    });
  }

  function showOwnershipSelection(series, ptIndex) {
    if (!el.ownershipSelection || !series) return;
    const rollFrom = ownershipTipStats && ownershipTipStats.key === series.key ? ownershipTipStats : null;
    const body = ownershipTooltipHTML(series, ptIndex, rollFrom);
    if (!body) return;
    el.ownershipSelection.innerHTML = `<div class="ownership-selection-card">
      <button type="button" class="ownership-selection-close" aria-label="Clear selection">${iconHTML("x")}</button>
      ${body}
    </div>`;
    el.ownershipSelection.hidden = false;
    bindOwnershipTipPhotoFallback(el.ownershipSelection);
    mountAndAnimateStatRolls(el.ownershipSelection, { duration: 720 });
    const data = ownershipTooltipPointData(series, ptIndex);
    if (data) {
      ownershipTipStats = snapshotOwnershipTipStats(series, data.idx, data.pt, data.delta, data.trend);
    }
  }

  function hideOwnershipTooltip() {
    clearTimeout(ownershipTipTimer);
    ownershipTipTimer = null;
    ownershipTipStats = null;
    if (el.ownershipTooltip) el.ownershipTooltip.style.display = "none";
    hideOwnershipSelection();
  }

  function ownershipInitials(name) {
    return String(name || "?")
      .split(/[\s.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?";
  }

  function ownershipTooltipDeltaMeta(delta) {
    if (delta == null) {
      return { label: "Change", value: "First snapshot", cls: "is-flat", numeric: null };
    }
    const cls = delta > 0 ? "is-up" : delta < 0 ? "is-down" : "is-flat";
    const sign = delta > 0 ? "+" : "";
    return { label: "vs last check-in", value: `${sign}${delta.toFixed(1)} pp`, cls, numeric: delta };
  }

  function statRollFormat(value, decimals, signed) {
    if (!Number.isFinite(Number(value))) return "";
    let n = Number(value);
    let sign = "";
    if (signed) {
      if (n > 0) sign = "+";
      else if (n < 0) sign = "-";
      n = Math.abs(n);
    } else if (n < 0) {
      sign = "-";
      n = Math.abs(n);
    }
    return `${sign}${n.toFixed(decimals)}`;
  }

  function statRollSpan(to, opts = {}) {
    const {
      from = null,
      decimals = 0,
      signed = false,
      suffix = "",
      className = "",
      textFallback = "—",
    } = opts;
    if (to == null || Number.isNaN(Number(to))) {
      return `<span class="${className}">${escapeHtml(textFallback)}</span>`;
    }
    const attrs = [
      `class="stat-roll${className ? ` ${className}` : ""}"`,
      `data-count-to="${Number(to)}"`,
      `data-count-decimals="${decimals}"`,
    ];
    if (signed) attrs.push('data-count-signed="1"');
    if (suffix) attrs.push(`data-count-suffix="${suffix}"`);
    if (from != null && Number.isFinite(Number(from))) attrs.push(`data-count-from="${Number(from)}"`);
    return `<span ${attrs.join(" ")}></span>`;
  }

  function statRollAlignChars(fromVal, toVal, decimals, signed) {
    const fromStr = statRollFormat(fromVal, decimals, signed);
    const toStr = statRollFormat(toVal, decimals, signed);
    const len = Math.max(fromStr.length, toStr.length);
    const chars = [];
    for (let i = 0; i < len; i++) {
      const fromCh = fromStr.padStart(len, " ")[i];
      const toCh = toStr.padStart(len, " ")[i];
      if (toCh === " " && fromCh === " ") continue;
      chars.push({ from: fromCh, to: toCh });
    }
    return chars;
  }

  function buildStatRollDigitWheel(fromDigit, toDigit) {
    const wheel = document.createElement("span");
    wheel.className = "stat-roll-digit";
    const strip = document.createElement("span");
    strip.className = "stat-roll-strip";
    for (let cycle = 0; cycle < 2; cycle++) {
      for (let d = 0; d <= 9; d++) {
        const cell = document.createElement("span");
        cell.textContent = String(d);
        strip.appendChild(cell);
      }
    }
    wheel.appendChild(strip);
    const h = () => wheel.clientHeight || parseFloat(getComputedStyle(wheel).fontSize) || 16;
    const setDigit = (digit, extraRows) => {
      const row = Number(digit) + (extraRows || 0) * 10;
      strip.style.transform = `translateY(${-row * h()}px)`;
    };
    setDigit(fromDigit);
    wheel._statRollStrip = strip;
    wheel._statRollSet = setDigit;
    wheel._statRollHeight = h;
    return wheel;
  }

  function animateStatRollDigitWheel(wheel, fromDigit, toDigit, duration) {
    const strip = wheel._statRollStrip;
    if (!strip) return;
    const h = wheel._statRollHeight();
    let fromIdx = Number(fromDigit);
    let toIdx = Number(toDigit);
    if (toIdx < fromIdx) toIdx += 10;
    strip.style.transition = "none";
    strip.style.transform = `translateY(${-fromIdx * h}px)`;
    void strip.offsetHeight;
    strip.style.transition = `transform ${duration}ms cubic-bezier(0.16, 1, 0.3, 1)`;
    strip.style.transform = `translateY(${-toIdx * h}px)`;
    const settle = () => {
      strip.style.transition = "none";
      strip.style.transform = `translateY(${-Number(toDigit) * h}px)`;
    };
    strip.addEventListener("transitionend", (evt) => {
      if (evt.propertyName !== "transform") return;
      settle();
    }, { once: true });
    window.setTimeout(settle, duration + 60);
  }

  function renderStatRollNode(node, fromVal, toVal, opts = {}) {
    const decimals = Number(opts.decimals) || 0;
    const signed = !!opts.signed;
    const suffix = opts.suffix || "";
    const chars = statRollAlignChars(fromVal, toVal, decimals, signed);
    node.textContent = "";
    node.setAttribute("aria-label", `${statRollFormat(toVal, decimals, signed)}${suffix}`);
    chars.forEach(({ from, to }) => {
      if (to >= "0" && to <= "9" && from >= "0" && from <= "9") {
        node.appendChild(buildStatRollDigitWheel(from, to));
        return;
      }
      const span = document.createElement("span");
      span.className = "stat-roll-static";
      span.textContent = to === " " ? "" : to;
      node.appendChild(span);
    });
    if (suffix) {
      const suf = document.createElement("span");
      suf.className = "stat-roll-static stat-roll-suffix";
      suf.textContent = suffix;
      node.appendChild(suf);
    }
  }

  function finishStatRollNode(node) {
    const to = Number(node.dataset.countTo);
    const decimals = Number(node.dataset.countDecimals) || 0;
    const signed = node.dataset.countSigned === "1";
    const suffix = node.dataset.countSuffix || "";
    if (!Number.isFinite(to)) {
      node.textContent = "—";
      return;
    }
    renderStatRollNode(node, to, to, { decimals, signed, suffix });
  }

  function animateStatRollNode(node, opts = {}) {
    const to = Number(node.dataset.countTo);
    if (!Number.isFinite(to)) return;
    const from =
      node.dataset.countFrom != null && Number.isFinite(Number(node.dataset.countFrom))
        ? Number(node.dataset.countFrom)
        : to;
    const decimals = Number(node.dataset.countDecimals) || 0;
    const signed = node.dataset.countSigned === "1";
    const suffix = node.dataset.countSuffix || "";
    const duration = opts.duration != null ? opts.duration : 520;
    renderStatRollNode(node, from, to, { decimals, signed, suffix });
    const chars = statRollAlignChars(from, to, decimals, signed);
    let digitIdx = 0;
    chars.forEach(({ from: fromCh, to: toCh }) => {
      if (!(toCh >= "0" && toCh <= "9" && fromCh >= "0" && fromCh <= "9")) return;
      const wheel = node.querySelectorAll(".stat-roll-digit")[digitIdx];
      digitIdx += 1;
      if (wheel) animateStatRollDigitWheel(wheel, fromCh, toCh, duration);
    });
  }

  function mountAndAnimateStatRolls(root, opts = {}) {
    if (!root) return;
    const duration = opts.duration != null ? opts.duration : 520;
    const run = () => {
      const nodes = [...root.querySelectorAll(".stat-roll[data-count-to]")];
      if (!nodes.length) return;
      if (prefersReducedMotion()) {
        nodes.forEach(finishStatRollNode);
        return;
      }
      nodes.forEach((node) => animateStatRollNode(node, { duration }));
    };
    requestAnimationFrame(run);
  }

  function snapshotOwnershipTipStats(series, ptIndex, pt, delta, trend) {
    return {
      key: series.key,
      index: ptIndex,
      owned: pt && pt.owned != null ? Number(pt.owned) : null,
      delta: delta != null ? Number(delta) : null,
      trendRecent: trend && trend.kind !== "flat" ? Number(trend.recent) : null,
      trendNet: trend && trend.kind !== "flat" ? Number(trend.net) : null,
    };
  }

  function ownershipTooltipPointData(series, ptIndex) {
    const pts = series.points || [];
    let idx = ptIndex;
    if (idx == null || !pts[idx] || pts[idx].owned == null) {
      idx = -1;
      for (let i = pts.length - 1; i >= 0; i--) {
        if (pts[i] && pts[i].owned != null) {
          idx = i;
          break;
        }
      }
    }
    const pt = pts[idx];
    if (!pt) return null;
    let prev = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (pts[i] && pts[i].owned != null) {
        prev = pts[i];
        break;
      }
    }
    const delta = ownershipDelta(pt.owned, prev && prev.owned);
    const trend = ownershipSeriesTrendQualifies(series) ? ownershipSeriesTrend(series) : null;
    return { pt, idx, delta, trend };
  }

  function ownershipTooltipHTML(series, ptIndex, rollFrom) {
    const data = ownershipTooltipPointData(series, ptIndex);
    if (!data) return "";
    const { pt, delta, trend } = data;
    const deltaMeta = ownershipTooltipDeltaMeta(delta);
    const trendCls =
      trend && trend.kind === "riser"
        ? "is-up"
        : trend && trend.kind === "faller"
          ? "is-down"
          : "is-flat";
    const when = fmtOwnershipDate(pt.checkedAt);
    const ownedRoll = statRollSpan(pt.owned, {
      ...(rollFrom && rollFrom.key === series.key && rollFrom.owned != null
        ? { from: rollFrom.owned }
        : {}),
      decimals: 1,
      className: "own-tip-owned-roll",
    });
    const deltaRoll =
      deltaMeta.numeric != null
        ? statRollSpan(deltaMeta.numeric, {
            ...(rollFrom && rollFrom.key === series.key && rollFrom.delta != null
              ? { from: rollFrom.delta }
              : {}),
            decimals: 1,
            signed: true,
            suffix: " pp",
            className: "own-tip-change-roll",
          })
        : `<span class="own-tip-change-roll is-text">${escapeHtml(deltaMeta.value)}</span>`;
    const trendBlock =
      trend && trend.kind !== "flat"
        ? `<div class="own-tip-trend ${trendCls}"><span class="own-tip-trend-label">Trend window</span><span class="own-tip-trend-val">${statRollSpan(
            trend.recent,
            {
              ...(rollFrom && rollFrom.key === series.key && rollFrom.trendRecent != null
                ? { from: rollFrom.trendRecent }
                : {}),
              decimals: 1,
              signed: true,
            }
          )}<span class="stat-roll-static"> pp recent · </span>${statRollSpan(trend.net, {
            ...(rollFrom && rollFrom.key === series.key && rollFrom.trendNet != null
              ? { from: rollFrom.trendNet }
              : {}),
            decimals: 1,
            signed: true,
          })}<span class="stat-roll-static"> pp net</span></span></div>`
        : "";

    if (series.kind === "team") {
      const badge = series.team ? badgeHTML(series.team) : "";
      return `<div class="own-tip">
        <div class="own-tip-head">
          <div class="own-tip-id">
            <div class="own-tip-name">${badge}${escapeHtml(series.name)}</div>
          </div>
        </div>
        <div class="own-tip-stat">
          <div class="own-tip-owned-block">
            <span class="own-tip-owned">${ownedRoll}<span class="own-tip-unit">%</span></span>
            <span class="own-tip-owned-label">TSB at snapshot</span>
          </div>
          <div class="own-tip-change ${deltaMeta.cls}">
            <span class="own-tip-change-val">${deltaRoll}</span>
            <span class="own-tip-change-label">${escapeHtml(deltaMeta.label)}</span>
          </div>
        </div>
        ${trendBlock}
        <div class="own-tip-when">${escapeHtml(when)}</div>
      </div>`;
    }

    const player = pt.player || series;
    const photo = feedPlayerPhotoUrl(series.code);
    const initials = ownershipInitials(player.name || series.name);
    const photoBlock = photo
      ? `<img class="own-tip-photo" src="${escapeHtml(photo)}" alt="" width="40" height="50" data-initials="${escapeHtml(initials)}" />`
      : `<span class="own-tip-photo own-tip-photo-fallback" aria-hidden="true">${escapeHtml(initials)}</span>`;
    const badge = player.team ? badgeHTML(player.team) : "";
    const metaBits = [];
    if (player.position) metaBits.push(posBadgeHTML(player.position));
    if (player.price != null) metaBits.push(`<span>£${Number(player.price).toFixed(1)}m</span>`);
    return `<div class="own-tip">
      <div class="own-tip-head">
        ${photoBlock}
        <div class="own-tip-id">
          <div class="own-tip-name">${badge}${escapeHtml(player.name || series.name)}</div>
          ${metaBits.length ? `<div class="own-tip-sub">${metaBits.join("")}</div>` : ""}
        </div>
      </div>
      <div class="own-tip-stat">
        <div class="own-tip-owned-block">
          <span class="own-tip-owned">${ownedRoll}<span class="own-tip-unit">%</span></span>
          <span class="own-tip-owned-label">TSB at snapshot</span>
        </div>
        <div class="own-tip-change ${deltaMeta.cls}">
          <span class="own-tip-change-val">${deltaRoll}</span>
          <span class="own-tip-change-label">${escapeHtml(deltaMeta.label)}</span>
        </div>
      </div>
      ${trendBlock}
      <div class="own-tip-when">${escapeHtml(when)}</div>
    </div>`;
  }

  function showOwnershipTooltip(clientX, clientY, series, ptIndex) {
    if (!series) return;
    if (ownershipUsesSelectionCard()) {
      if (el.ownershipTooltip) el.ownershipTooltip.style.display = "none";
      showOwnershipSelection(series, ptIndex);
      return;
    }
    if (!el.ownershipTooltip || !el.ownershipChartWrap) return;
    hideOwnershipSelection();
    const rollFrom = ownershipTipStats && ownershipTipStats.key === series.key ? ownershipTipStats : null;
    const html = ownershipTooltipHTML(series, ptIndex, rollFrom);
    if (!html) return;
    el.ownershipTooltip.innerHTML = html;
    bindOwnershipTipPhotoFallback(el.ownershipTooltip);
    el.ownershipTooltip.style.display = "block";
    positionOwnershipTooltip(clientX, clientY);
    mountAndAnimateStatRolls(el.ownershipTooltip, { duration: 520 });
    const data = ownershipTooltipPointData(series, ptIndex);
    if (data) {
      ownershipTipStats = snapshotOwnershipTipStats(series, data.idx, data.pt, data.delta, data.trend);
    }
  }

  function positionOwnershipTooltip(clientX, clientY) {
    if (!el.ownershipTooltip || !el.ownershipChartWrap) return;
    const wrap = el.ownershipChartWrap.getBoundingClientRect();
    let left = clientX - wrap.left + 14;
    let top = clientY - wrap.top + 14;
    const ttW = el.ownershipTooltip.offsetWidth || 220;
    const ttH = el.ownershipTooltip.offsetHeight || 120;
    if (left + ttW > wrap.width - 6) left = clientX - wrap.left - ttW - 14;
    if (top + ttH > wrap.height - 6) top = clientY - wrap.top - ttH - 14;
    el.ownershipTooltip.style.left = `${Math.max(6, left)}px`;
    el.ownershipTooltip.style.top = `${Math.max(6, top)}px`;
  }

  function ownershipLastOwnedIndex(series) {
    if (!series || !series.points) return null;
    for (let i = series.points.length - 1; i >= 0; i--) {
      if (series.points[i] && series.points[i].owned != null) return i;
    }
    return null;
  }

  function ownershipSeriesPointClient(series, ptIndex) {
    if (!series || ptIndex == null) return null;
    const svg = el.ownershipChart && el.ownershipChart.querySelector("svg");
    if (!svg) return null;
    const svgRect = svg.getBoundingClientRect();
    if (!svgRect.width || !svgRect.height) return null;
    let svgX = null;
    let svgY = null;
    (series._drawn || []).forEach((line) => {
      if (svgX != null) return;
      const pt = line.find((p) => p.i === ptIndex);
      if (pt) {
        svgX = pt.x;
        svgY = pt.y;
      }
    });
    if (svgX == null && ownershipLayout) {
      const pt = series.points && series.points[ptIndex];
      if (!pt || pt.owned == null) return null;
      svgX = ownershipLayout.xAt(ptIndex);
      svgY = ownershipLayout.yAt(pt.owned);
    }
    if (svgX == null) return null;
    const vb = svg.viewBox.baseVal;
    return {
      clientX: svgRect.left + (svgX / vb.width) * svgRect.width,
      clientY: svgRect.top + (svgY / vb.height) * svgRect.height,
      index: ptIndex,
    };
  }

  function showOwnershipTooltipForSeries(series, ptIndex) {
    const pt = ownershipSeriesPointClient(series, ptIndex);
    if (!pt) return;
    showOwnershipTooltip(pt.clientX, pt.clientY, series, pt.index);
  }

  function scrollOwnershipChartIntoView(afterScroll) {
    if (hasFineHover()) return;
    const wrap = el.ownershipChartWrap;
    if (!wrap) return;
    const main = document.querySelector("main.main");
    const behavior = prefersReducedMotion() ? "auto" : "smooth";
    const done = () => {
      if (typeof afterScroll === "function") afterScroll();
    };
    if (main) {
      const wrapRect = wrap.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      const topGap = 12;
      if (wrapRect.top < mainRect.top + topGap || wrapRect.bottom > mainRect.bottom - 8) {
        main.scrollTo({
          top: Math.max(0, main.scrollTop + wrapRect.top - mainRect.top - topGap),
          behavior,
        });
        if (behavior === "auto") done();
        else setTimeout(done, 400);
      } else {
        done();
      }
    } else {
      wrap.scrollIntoView({ behavior, block: "start" });
      if (behavior === "auto") done();
      else setTimeout(done, 400);
    }
  }

  function ownershipAccentForSeries(series) {
    if (!series) return "";
    return TEAM_SCATTER_ACCENT[series.team] || "";
  }

  function hoverOwnershipSeries(key, { index = null, showTip = false, tipClientX, tipClientY, fromChart = false } = {}) {
    const series = key ? ownershipSeriesCache.find((s) => s.key === key) : null;
    if (!series) {
      setOwnershipHover(null, null);
      hideOwnershipTooltip();
      return;
    }
    const idx = index != null ? index : ownershipLastOwnedIndex(series);
    setOwnershipHover(key, idx, { fromChart });
    if (showTip && tipClientX != null && tipClientY != null) {
      showOwnershipTooltip(tipClientX, tipClientY, series, idx);
    }
  }

  function restoreOwnershipPin() {
    if (!ownershipPinnedKey) {
      setOwnershipHover(null, null);
      hideOwnershipTooltip();
      return;
    }
    const series = ownershipSeriesCache.find((s) => s.key === ownershipPinnedKey);
    if (!series) {
      ownershipPinnedKey = null;
      ownershipPinnedFromChart = false;
      setOwnershipHover(null, null);
      hideOwnershipTooltip();
      return;
    }
    hoverOwnershipSeries(ownershipPinnedKey, { fromChart: ownershipPinnedFromChart });
  }

  function pinOwnershipSeries(key, { fromChart = false } = {}) {
    if (!key || ownershipPinnedKey === key) {
      ownershipPinnedKey = null;
      ownershipPinnedFromChart = false;
      setOwnershipHover(null, null);
      hideOwnershipTooltip();
      return false;
    }
    ownershipPinnedKey = key;
    ownershipPinnedFromChart = fromChart;
    hoverOwnershipSeries(key, { fromChart });
    return true;
  }

  function setOwnershipHover(key, index, { fromChart = false } = {}) {
    if (
      index != null &&
      ownershipLayout &&
      ownershipLayout.startIdx != null &&
      ownershipLayout.endIdx != null
    ) {
      index = Math.max(ownershipLayout.startIdx, Math.min(ownershipLayout.endIdx, index));
    }
    ownershipHoverKey = key;
    ownershipHoverIndex = index;
    if (el.ownershipChartWrap) {
      el.ownershipChartWrap.classList.toggle("is-focused", !!key);
    }
    if (!el.ownershipChart) return;
    const series = key ? ownershipSeriesCache.find((s) => s.key === key) : null;
    const accent = ownershipAccentForSeries(series);
    el.ownershipChart.querySelectorAll(".ownership-line").forEach((node) => {
      const match = node.getAttribute("data-key") === key;
      const isTrendLine = node.classList.contains("is-riser") || node.classList.contains("is-faller");
      node.classList.toggle("is-active", !!key && match);
      node.classList.toggle("is-dim", !!key && !match);
      node.classList.toggle("is-chart-selected", !!key && match && fromChart);
      if (match && fromChart && accent && !isTrendLine) {
        node.style.setProperty("--ownership-accent", accent);
        node.style.stroke = accent;
      } else {
        node.style.removeProperty("--ownership-accent");
        node.style.stroke = "";
      }
    });
    if (el.ownershipTrendCards) {
      el.ownershipTrendCards.querySelectorAll("[data-ownership-key]").forEach((row) => {
        row.classList.toggle("is-active", !!key && row.getAttribute("data-ownership-key") === key);
      });
    }
    const svg = el.ownershipChart.querySelector("svg");
    if (svg && key) {
      svg.querySelectorAll(`.ownership-line[data-key="${key}"]`).forEach((node) => {
        svg.appendChild(node);
      });
    }
    const guide = el.ownershipChart.querySelector(".ownership-hover-guide");
    if (guide && ownershipLayout && index != null && ownershipLayout.xAt) {
      const x = ownershipLayout.xAt(index);
      guide.setAttribute("x1", x.toFixed(1));
      guide.setAttribute("x2", x.toFixed(1));
      guide.style.display = key ? "" : "none";
    } else if (guide) {
      guide.style.display = "none";
    }
  }

  function hitTestOwnershipAmong(candidates, px, py) {
    if (!candidates.length || !ownershipLayout) return null;
    let bestPoint = null;
    let bestPointD = OWNERSHIP_POINT_HIT;
    candidates.forEach((s) => {
      (s._drawn || []).forEach((line) => {
        line.forEach((pt) => {
          const d = Math.hypot(px - pt.x, py - pt.y);
          if (d < bestPointD) {
            bestPointD = d;
            bestPoint = { series: s, index: pt.i, d };
          }
        });
      });
    });
    if (bestPoint) return bestPoint;
    let bestLine = null;
    let bestLineD = OWNERSHIP_LINE_HIT;
    candidates.forEach((s) => {
      (s._drawn || []).forEach((line) => {
        for (let i = 1; i < line.length; i++) {
          const a = line[i - 1];
          const b = line[i];
          const d = distPointSeg(px, py, a.x, a.y, b.x, b.y);
          if (d < bestLineD) {
            bestLineD = d;
            const useB = Math.hypot(px - b.x, py - b.y) < Math.hypot(px - a.x, py - a.y);
            bestLine = { series: s, index: useB ? b.i : a.i, d };
          }
        }
        if (line.length === 1) {
          const d = Math.hypot(px - line[0].x, py - line[0].y);
          if (d < bestLineD) {
            bestLineD = d;
            bestLine = { series: s, index: line[0].i, d };
          }
        }
      });
    });
    return bestLine;
  }

  function hitTestOwnership(px, py) {
    const series = ownershipSeriesCache;
    if (!series.length || !ownershipLayout) return null;
    if (state.page === "ownership") {
      const trend = series.filter((s) => ownershipSeriesTrendQualifies(s));
      const hit = hitTestOwnershipAmong(trend, px, py);
      if (hit) return hit;
    }
    return hitTestOwnershipAmong(series, px, py);
  }

  function ownershipPointerToSvg(evt) {
    const svg = el.ownershipChart && el.ownershipChart.querySelector("svg");
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const vb = svg.viewBox.baseVal;
    const x = ((evt.clientX - rect.left) / rect.width) * vb.width;
    const y = ((evt.clientY - rect.top) / rect.height) * vb.height;
    return { x, y };
  }

  function onOwnershipPointerMove(evt) {
    const pt = ownershipPointerToSvg(evt);
    if (!pt) return;
    const hit = ownershipPinnedKey
      ? hitTestOwnershipAmong(
          ownershipSeriesCache.filter((s) => s.key === ownershipPinnedKey),
          pt.x,
          pt.y
        )
      : hitTestOwnership(pt.x, pt.y);
    if (!hit) {
      if (ownershipPinnedKey) {
        hideOwnershipTooltip();
        return;
      }
      if (ownershipHoverKey) {
        setOwnershipHover(null, null);
        hideOwnershipTooltip();
      }
      return;
    }
    const changed = ownershipHoverKey !== hit.series.key || ownershipHoverIndex !== hit.index;
    setOwnershipHover(hit.series.key, hit.index, { fromChart: true });
    if (hasFineHover()) {
      clearTimeout(ownershipTipTimer);
      if (changed || !el.ownershipTooltip || el.ownershipTooltip.style.display === "none") {
        showOwnershipTooltip(evt.clientX, evt.clientY, hit.series, hit.index);
      } else {
        positionOwnershipTooltip(evt.clientX, evt.clientY);
      }
    }
  }

  function onOwnershipPointerLeave() {
    hideOwnershipTooltip();
    restoreOwnershipPin();
  }

  function onOwnershipClick(evt) {
    const pt = ownershipPointerToSvg(evt);
    if (!pt) return;
    const hit = hitTestOwnership(pt.x, pt.y);
    if (!hit) {
      if (ownershipPinnedKey) {
        ownershipPinnedKey = null;
        ownershipPinnedFromChart = false;
        setOwnershipHover(null, null);
      }
      hideOwnershipTooltip();
      return;
    }
    if (hasFineHover()) {
      const pinned = pinOwnershipSeries(hit.series.key, { fromChart: true });
      if (pinned) {
        setOwnershipHover(hit.series.key, hit.index, { fromChart: true });
        showOwnershipTooltip(evt.clientX, evt.clientY, hit.series, hit.index);
      }
      return;
    }
    if (
      el.ownershipTooltip &&
      el.ownershipTooltip.style.display !== "none" &&
      ownershipHoverKey === hit.series.key &&
      ownershipHoverIndex === hit.index
    ) {
      ownershipPinnedKey = null;
      ownershipPinnedFromChart = false;
      hideOwnershipTooltip();
      setOwnershipHover(null, null);
      return;
    }
    ownershipPinnedKey = hit.series.key;
    ownershipPinnedFromChart = true;
    setOwnershipHover(hit.series.key, hit.index, { fromChart: true });
    showOwnershipTooltip(evt.clientX, evt.clientY, hit.series, hit.index);
  }

  function ownershipChartTitleText() {
    const base =
      state.view === "teams" ? "Club average selected-by %" : "Selected-by % over check-ins";
    const windowLabel =
      state.ownershipTrendWindow === 1
        ? "last check-in"
        : state.ownershipTrendWindow === 3
          ? "last 3 check-ins"
          : "last 7 check-ins";
    const n = ownershipTrendCardLimit();
    return `${base} · ${windowLabel} · top ${n}`;
  }

  function syncOwnershipChartTitle() {
    if (!el.ownershipChartTitle) return;
    const title = ownershipChartTitleText();
    el.ownershipChartTitle.textContent = title;
    if (el.ownershipChart) {
      el.ownershipChart.setAttribute("aria-label", title);
    }
  }

  let ownershipLastSize = "";

  function renderOwnership() {
    if (!el.ownershipChart) return;
    hideOwnershipTooltip();
    syncOwnershipChartTitle();
    const checkIns = ownershipCheckIns();
    const rankSeries = ownershipTrendRankSeries();
    rankSeries.forEach((s) => {
      s._trend = ownershipTrendScore(s);
    });
    const coloredKeys = ownershipTrendColoredKeys(rankSeries);
    const series =
      state.view === "teams" ? buildOwnershipTeamSeries() : buildOwnershipPlayerSeries();
    series.forEach((s) => {
      s._trend = ownershipTrendScore(s);
      s._trendCard = coloredKeys.has(s.key);
    });
    ownershipSeriesCache = series;
    renderOwnershipTrendCards(series, coloredKeys);
    if (el.ownershipChartWrap) {
      el.ownershipChartWrap.classList.add("is-trending");
    }

    if (el.ownershipCountLabel) {
      if (!checkIns.length) {
        el.ownershipCountLabel.textContent = "No check-ins";
      } else if (state.view === "teams") {
        el.ownershipCountLabel.textContent = `${series.length} club${series.length === 1 ? "" : "s"}`;
      } else {
        const filtered = series.length ? series[0].filteredCount : 0;
        el.ownershipCountLabel.textContent = `Top ${series.length} of ${filtered.toLocaleString()} players`;
      }
    }

    const wrap = el.ownershipChartWrap || el.ownershipChart;
    const chartBox = el.ownershipChart || wrap;
    const w = Math.max(320, wrap.clientWidth || 640);
    const mobileChart = NARROW_MQ.matches;
    const measuredH = chartBox.clientHeight || Math.max(0, wrap.clientHeight - 42);
    const h = mobileChart ? Math.max(240, measuredH || 280) : Math.max(260, measuredH || 380);
    ownershipLastSize = `${wrap.clientWidth}x${chartBox.clientHeight || measuredH}`;
    const pad = { ...OWNERSHIP_PAD };
    if (mobileChart) pad.bottom = 56;
    const innerW = Math.max(40, w - pad.left - pad.right);
    const innerH = Math.max(40, h - pad.top - pad.bottom);
    const view = ownershipChartWindow(checkIns);
    const viewCheckIns = view.checkIns;
    const n = viewCheckIns.length;
    const xAt = (i) => {
      if (n <= 1) return pad.left + innerW / 2;
      const local = i - view.startIdx;
      return pad.left + (local / (n - 1)) * innerW;
    };
    const { yMin, yMax, step: tickStep } = ownershipScaleRange(
      series,
      view.startIdx,
      view.endIdx
    );
    const ySpan = Math.max(yMax - yMin, 1e-6);
    const yAt = (owned) => pad.top + (1 - (owned - yMin) / ySpan) * innerH;
    ownershipLayout = {
      w,
      h,
      pad,
      innerW,
      innerH,
      xAt,
      yAt,
      yMin,
      yMax,
      n,
      startIdx: view.startIdx,
      endIdx: view.endIdx,
    };

    if (!checkIns.length) {
      el.ownershipChart.innerHTML = `<div class="ownership-empty">No ownership check-ins yet. Run <code>python3 site/fetch_ownership.py</code> to capture the current FPL selected-by-%.</div>`;
      return;
    }
    if (!series.length) {
      el.ownershipChart.innerHTML = `<div class="ownership-empty">No players or clubs match the current filters.</div>`;
      return;
    }

    const yTicks = [];
    for (let v = yMin; v <= yMax + 1e-6; v += tickStep) yTicks.push(v);

    series.forEach((s) => {
      s._drawn = ownershipPolylines(s.points, xAt, yAt, view.startIdx, view.endIdx);
    });

    const grid = yTicks
      .map((v) => {
        const y = yAt(v);
        return `<line class="ownership-grid-line" x1="${pad.left}" x2="${w - pad.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" />
          <text class="ownership-axis-label is-y" x="${pad.left - 8}" y="${(y + 3).toFixed(1)}">${Number.isInteger(v) ? v : v.toFixed(1)}%</text>`;
      })
      .join("");

    const xLabels = viewCheckIns
      .map((ci, localI) => {
        const x = xAt(view.startIdx + localI);
        return `<text class="ownership-axis-label is-x" x="${x.toFixed(1)}" y="${h - 10}">${escapeHtml(fmtOwnershipDate(ci.checkedAt))}</text>`;
      })
      .join("");

    const trendClass = (s) => {
      const trend = ownershipSeriesTrend(s);
      if (!ownershipSeriesTrendQualifies(s) || !trend) return "";
      if (trend.kind === "riser") return " is-riser";
      if (trend.kind === "faller") return " is-faller";
      return "";
    };

    const lineMarkup = (list) =>
      list
        .map((s) =>
          (s._drawn || [])
            .map((line) => {
              if (line.length === 1) return "";
              return `<path class="ownership-line${trendClass(s)}" data-key="${escapeHtml(s.key)}" d="${pathFromPts(line)}" />`;
            })
            .join("")
        )
        .join("");

    const fieldSeries = series.filter((s) => !ownershipSeriesTrendQualifies(s));
    const trendSeries = series.filter((s) => ownershipSeriesTrendQualifies(s));
    const lines = lineMarkup(fieldSeries) + lineMarkup(trendSeries);

    el.ownershipChart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true">
        ${grid}
        <line class="ownership-hover-guide" x1="0" x2="0" y1="${pad.top}" y2="${h - pad.bottom}" style="display:none" />
        ${lines}
        ${xLabels}
      </svg>`;

    const svg = el.ownershipChart.querySelector("svg");
    if (svg && !svg._ownershipBound) {
      svg._ownershipBound = true;
      svg.addEventListener("mousemove", onOwnershipPointerMove);
      svg.addEventListener("mouseleave", onOwnershipPointerLeave);
      svg.addEventListener("click", onOwnershipClick);
    } else if (svg) {
      // innerHTML replaced the node; rebind
      svg.addEventListener("mousemove", onOwnershipPointerMove);
      svg.addEventListener("mouseleave", onOwnershipPointerLeave);
      svg.addEventListener("click", onOwnershipClick);
    }

    if (ownershipPinnedKey && !series.some((s) => s.key === ownershipPinnedKey)) {
      ownershipPinnedKey = null;
      ownershipPinnedFromChart = false;
    }
    const focusKey = ownershipPinnedKey || ownershipHoverKey;
    if (focusKey) {
      const still = series.find((s) => s.key === focusKey);
      if (still) {
        const fromChart = ownershipPinnedKey ? ownershipPinnedFromChart : false;
        setOwnershipHover(still.key, ownershipHoverIndex, { fromChart });
      }
      else {
        ownershipPinnedKey = null;
        ownershipPinnedFromChart = false;
        setOwnershipHover(null, null);
      }
    } else if (el.ownershipChartWrap) {
      el.ownershipChartWrap.classList.remove("is-focused");
    }

    if (typeof ResizeObserver !== "undefined" && wrap && !ownershipRo) {
      ownershipRo = new ResizeObserver(() => {
        if (state.page !== "ownership") return;
        const box = el.ownershipChartWrap || el.ownershipChart;
        const key = `${box.clientWidth}x${box.clientHeight}`;
        if (key === ownershipLastSize) return;
        renderOwnership();
      });
      ownershipRo.observe(wrap);
    }

    syncFiltersResetUI();
  }

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function animateOwnershipLines() {
    if (!el.ownershipChart || prefersReducedMotion()) return;
    const paths = [...el.ownershipChart.querySelectorAll("path.ownership-line")];
    paths.forEach((path, i) => {
      let len = 0;
      try {
        len = path.getTotalLength();
      } catch {
        return;
      }
      if (!Number.isFinite(len) || len < 2) return;
      path.style.strokeDasharray = `${len}`;
      path.style.strokeDashoffset = `${len}`;
      path.style.transition = "none";
      void path.getBoundingClientRect();
      const delay = Math.min(i, 28) * 0.012;
      path.style.transition = `stroke-dashoffset 0.95s var(--ease-out, cubic-bezier(0.16, 1, 0.3, 1)) ${delay}s`;
      path.style.strokeDashoffset = "0";
      const clear = () => {
        path.style.strokeDasharray = "";
        path.style.strokeDashoffset = "";
        path.style.transition = "";
      };
      path.addEventListener("transitionend", (evt) => {
        if (evt.propertyName !== "stroke-dashoffset") return;
        clear();
      }, { once: true });
      window.setTimeout(clear, 1400 + delay * 1000);
    });
  }

  function startOwnershipEnterMotion(pane) {
    animateOwnershipLines();
    startStatCountUp(pane, ".ownership-trend-owned[data-count-to], .ownership-trend-delta[data-count-to]");
  }


  const PAGE_KEY = "fpl-explorer-page";
  const PAGES = ["home", "opta", "rankings", "ownership", "expected", "schedule", "markets", "team"];

  function storedPage() {
    try {
      const saved = localStorage.getItem(PAGE_KEY);
      if (saved === "notes") return "opta";
      const page = PAGES.includes(saved) ? saved : "home";
      return page;
    } catch {
      return "home";
    }
  }

  function pagePaneFor(page) {
    if (page === "home") return el.homePage;
    if (page === "opta") return el.optaPage;
    if (page === "rankings") return el.rankingsPage;
    if (page === "ownership") return el.ownershipPage;
    if (page === "expected") return el.expectedPage;
    if (page === "schedule") return el.schedulePage;
    if (page === "markets") return el.marketsPage;
    if (page === "team") return el.teamPage;
    return null;
  }

  function playPageEnter(pane) {
    if (!pane) return;
    pane.classList.remove("is-entering", "is-enter-pending", "is-hl-entering");
    clearTimeout(pane._enterClear);
    if (pane._countUpRaf) {
      cancelAnimationFrame(pane._countUpRaf);
      pane._countUpRaf = 0;
    }
    if (pane._hlEnterRaf) {
      cancelAnimationFrame(pane._hlEnterRaf);
      pane._hlEnterRaf = 0;
    }
    if (pane.id === "opta-page") pane.style.removeProperty("--hl-sat");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Never animate Statistics table rows. Opacity/transform on <tr> with
    // fill-mode `both` sticks at 0 in WebKit (and some Chromium), so the
    // landing page shows only the header bar until a view toggle recreates rows.
    // Highlight fills still ease in (see startOptaHighlightEnter).
    if (pane.id === "opta-page") {
      startOptaHighlightEnter(pane);
      return;
    }

    const slowEnter = pane.id === "schedule-page";
    const rankingsEnter = pane.id === "rankings-page";
    const expectedEnter = pane.id === "expected-page";
    const marketsEnter = pane.id === "markets-page";
    const ownershipEnter = pane.id === "ownership-page";
    const optaEnter = pane.id === "opta-page";

    // Stamp stagger indices before the class is applied so delayed rows /
    // cards / badges all share one wave. Cap is enforced in CSS too.
    const staggerSel = [
      ".table-wrap > table > tbody > tr",
      ".barbell-body > .barbell-row",
      ".barbell-body > .barbell-group",
      ".schedule-grid > .schedule-card",
      ".schedule-scatter-head",
      ".schedule-scatter-point",
      ".team-player-row",
      ".team-empty-row",
      ".team-picker-row",
      ".team-budget-bar",
      ".team-section-row",
      ".home-panel",
      ".home-squad-table tbody tr",
      ".home-standings-table tbody tr",
    ].join(", ");
    pane.querySelectorAll(staggerSel).forEach((node, i) => {
      node.style.setProperty("--enter-i", String(i));
      node.querySelectorAll(".barbell-track").forEach((track) => {
        track.style.setProperty("--enter-i", String(i));
      });
    });
    // Matchups: cards get their own 0-based index so the post-scatter
    // cascade doesn't inherit the scatter-point indices.
    if (slowEnter) {
      pane.querySelectorAll(".schedule-scatter-point").forEach((node, i) => {
        node.style.setProperty("--enter-i", String(i));
      });
      pane.querySelectorAll(".schedule-grid > .schedule-card").forEach((node, i) => {
        node.style.setProperty("--enter-i", String(i));
      });
    }
    // Rankings rows: same index within every card so all lists cascade together.
    pane.querySelectorAll(".rankings-list").forEach((list) => {
      list.querySelectorAll(":scope > .rankings-row").forEach((row, i) => {
        row.style.setProperty("--enter-i", String(i));
      });
    });
    if (marketsEnter) {
      pane.querySelectorAll(".markets-divider").forEach((node, i) => {
        node.style.setProperty("--enter-i", String(i));
      });
      pane.querySelectorAll(".markets-grid > .markets-card").forEach((node, i) => {
        node.style.setProperty("--enter-i", String(i));
      });
    }

    // Hide settled content immediately so display:none → visible never
    // flashes the finished layout before the enter animation starts.
    pane.classList.add("is-enter-pending");

    // Wait two frames so the pending hide has painted, then start enter
    // (avoids browsers skipping the animation on the same frame as show).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (pane.style.display === "none") {
          pane.classList.remove("is-enter-pending");
          return;
        }
        void pane.offsetWidth;
        pane.classList.remove("is-enter-pending");
        pane.classList.add("is-entering");
        if (marketsEnter) startStatCountUp(pane, ".markets-stat-value[data-count-to]");
        if (ownershipEnter) startOwnershipEnterMotion(pane);
        if (rankingsEnter) animateRankingsBars();
        // Matchups cards cascade with scatter (no wait for scatter to finish).
        const clearMs = expectedEnter
          ? 2400
          : rankingsEnter
            ? 1800
            : slowEnter
              ? 1800
              : marketsEnter
                ? 3200
                : ownershipEnter
                  ? 2400
                  : optaEnter
                    ? 1600
                    : 1500;
        pane._enterClear = setTimeout(() => pane.classList.remove("is-entering"), clearMs);
      });
    });
  }

  function startOptaHighlightEnter(pane) {
    if (!pane) return;
    if (pane._hlEnterRaf) {
      cancelAnimationFrame(pane._hlEnterRaf);
      pane._hlEnterRaf = 0;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pane.classList.remove("is-hl-entering");
      pane.style.setProperty("--hl-sat", "1");
      return;
    }
    pane.classList.add("is-hl-entering");
    pane.style.setProperty("--hl-sat", "0");
    const duration = 2500;
    const ease = (t) => t * t * (3 - 2 * t);
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      pane.style.setProperty("--hl-sat", String(ease(t)));
      if (t < 1) {
        pane._hlEnterRaf = requestAnimationFrame(tick);
        return;
      }
      pane.style.setProperty("--hl-sat", "1");
      pane.classList.remove("is-hl-entering");
      pane._hlEnterRaf = 0;
    };
    pane._hlEnterRaf = requestAnimationFrame(tick);
  }

  function startStatCountUp(pane, selector) {
    const nodes = [...pane.querySelectorAll(selector)];
    if (!nodes.length) return;
    nodes.forEach((node) => {
      const target = Number(node.dataset.countTo);
      if (!Number.isFinite(target)) return;
      if (!node.dataset.countDecimals) node.dataset.countDecimals = "1";
      node.classList.add("stat-roll");
      node.dataset.countFrom = "0";
      node.textContent = "";
    });
    mountAndAnimateStatRolls(pane, { duration: 2000 });
  }

  function resetSearchAndFiltersForNavigation({ rerender = false } = {}) {
    state.search = "";
    if (el.search) el.search.value = "";
    if (el.searchWrap) el.searchWrap.classList.remove("search-open");
    if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "false");

    state.posFilter.clear();
    state.teamFilter.clear();
    state.setPieceTakersOnly = false;
    if (el.setpieceTakersCheck) el.setpieceTakersCheck.checked = false;
    state.teamAffordableOnly = false;
    if (el.teamAffordableCheck) el.teamAffordableCheck.checked = false;
    const coreDefaults = statisticsCoreFilterDefaults(state.valueMode);
    state.priceMin = coreDefaults.priceMin;
    state.priceMax = coreDefaults.priceMax;
    state.ownedMin = coreDefaults.ownedMin;
    state.minsMin = coreDefaults.minsMin;
    state.minsMax = coreDefaults.minsMax;
    if (typeof syncFilterChipUI === "function") syncFilterChipUI();
    if (typeof updatePriceSlider === "function") updatePriceSlider();
    if (typeof updateOwnedSlider === "function") updateOwnedSlider();
    if (typeof updateMinsSlider === "function") updateMinsSlider();
    if (typeof syncFiltersResetUI === "function") syncFiltersResetUI();

    syncSearchClearBtns();
    if (rerender) {
      if (state.page === "opta" || state.page === "rankings" || state.page === "team" || state.page === "ownership") renderTable();
      if (state.page === "rankings") renderRankings();
    }
  }

  function pageTrayIsOpen() {
    return !!(mobileSheetOpen && mobileSheetKey === "pages");
  }

  function setPageTrayOpen(open) {
    if (!el.pageTrayBtn || !el.pageTabs) return;
    if (!NARROW_MQ.matches) {
      if (mobileSheetOpen && mobileSheetKey === "pages") closeMobileSheet();
      el.pageTrayBtn.setAttribute("aria-expanded", "false");
      return;
    }
    if (open) {
      openMobileSheetHost({
        title: "Pages",
        key: "pages",
        hostEl: el.pageTabs,
      });
      el.pageTrayBtn.setAttribute(
        "aria-expanded",
        mobileSheetOpen && mobileSheetKey === "pages" ? "true" : "false"
      );
    } else if (mobileSheetKey === "pages") {
      closeMobileSheet();
    } else {
      el.pageTrayBtn.setAttribute("aria-expanded", "false");
    }
  }

  function syncPageNavLabelCenter() {
    const cluster = el.pageNavCenter;
    const label = el.pageTrayLabel;
    const nav = el.pageNav;
    if (!cluster || !label || !nav) return;
    if (!preferMobileSheet()) {
      cluster.style.removeProperty("--page-nav-label-offset");
      return;
    }
    cluster.style.setProperty("--page-nav-label-offset", "0px");
    requestAnimationFrame(() => {
      const navRect = nav.getBoundingClientRect();
      const navMid = navRect.left + navRect.width / 2;
      const labelRect = label.getBoundingClientRect();
      const labelMid = labelRect.left + labelRect.width / 2;
      cluster.style.setProperty("--page-nav-label-offset", `${navMid - labelMid}px`);
    });
  }

  function syncPageTrayTrigger() {
    if (!el.pageTrayBtn) return;
    const btn =
      (el.pageTabs && el.pageTabs.querySelector(".page-tab-btn.active[id]")) ||
      (el.pageTabs && el.pageTabs.querySelector(".page-tab-btn.active"));
    const useEl = btn && btn.querySelector("svg.icon:not(.page-tab-caret) use");
    const href = useEl && (useEl.getAttribute("href") || useEl.getAttribute("xlink:href"));
    if (href && el.pageTrayIconUse) el.pageTrayIconUse.setAttribute("href", href);
    const label = btn
      ? Array.from(btn.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join(" ")
      : "";
    if (el.pageTrayLabel && label) el.pageTrayLabel.textContent = label;
    el.pageTrayBtn.setAttribute("aria-label", label ? `Pages, ${label}` : "Pages");
    syncPageNavLabelCenter();
  }

  function setPage(page) {
    if (page === "notes") page = "opta";
    const prev = state.page;
    state.page = page;
    if (prev !== page) {
      scrollPageContentToTop();
      resetMobileChromeScrollHide();
    }
    try {
      localStorage.setItem(PAGE_KEY, page);
    } catch {
      // Private browsing or a full quota — the page just won't persist.
    }
    clearTimeout(fixtureTtTimer);
    hideFixtureTooltip();
    hideOwnershipTooltip();
    hidePageInfoTooltip();
    hideTeamRowActionsPopup();
    closeMobileSheet();
    if (prev !== page) {
      if (prev === "team") {
        restoreSeasonFilterBounds();
        closeTeamPicker({ silent: true });
      }
      if (page === "team") {
        applyTeamPageBounds();
        if (prev !== "team") state.teamGwStart = teamClampGwStart(teamCurrentGw());
      }
      if (page === "schedule" && prev !== "schedule") {
        const [lo, hi] = defaultScheduleGwWindow();
        state.scheduleGwMin = lo;
        state.scheduleGwMax = hi;
      }
      resetSearchAndFiltersForNavigation({ rerender: false });
      if (page === "team" || prev === "team") buildTeamFilterChips();
    }
    if (page !== "team" && el.subtoolbar) el.subtoolbar.classList.remove("is-team-picking");
    syncTeamSearchHost();
    syncTeamCompareHost();
    syncSearchClearBtns();
    syncPageInfoButton();
    syncAllNameColumnSimplifies();
    el.pageOpta.classList.toggle("active", page === "opta");
    el.pageRankings.classList.toggle("active", page === "rankings");
    if (el.pageHome) el.pageHome.classList.toggle("active", page === "home");
    if (el.pageOwnership) el.pageOwnership.classList.toggle("active", page === "ownership");
    el.pageExpected.classList.toggle("active", page === "expected");
    el.pageSchedule.classList.toggle("active", page === "schedule");
    if (el.pageMarkets) el.pageMarkets.classList.toggle("active", page === "markets");
    if (el.pageTeam) el.pageTeam.classList.toggle("active", page === "team");
    syncPageTabCloneActive(page);
    document.documentElement.dataset.page = page;
    syncPageTrayTrigger();
    setPageTrayOpen(false);
    if (el.homePage) el.homePage.style.display = page === "home" ? "" : "none";
    el.optaPage.style.display = page === "opta" ? "" : "none";
    el.rankingsPage.style.display = page === "rankings" ? "" : "none";
    if (el.ownershipPage) el.ownershipPage.style.display = page === "ownership" ? "" : "none";
    el.expectedPage.style.display = page === "expected" ? "" : "none";
    el.schedulePage.style.display = page === "schedule" ? "" : "none";
    if (el.marketsPage) el.marketsPage.style.display = page === "markets" ? "" : "none";
    if (el.teamPage) el.teamPage.style.display = page === "team" ? "" : "none";
    syncTeamLandscapeMode();
    const isMarkets = page === "markets";
    const isHome = page === "home";
    // Schedule and Markets hide the subtoolbar; Markets view picker lives in filters.
    const hideSubtoolbar =
      page === "schedule" ||
      isMarkets ||
      isHome ||
      (preferMobileSheet() && page === "rankings");
    el.subtoolbar.style.display = hideSubtoolbar ? "none" : "";
    el.subtoolbar.classList.toggle("is-markets-mobile", isMarkets && preferMobileSheet());
    el.subtoolbar.classList.toggle("is-expected-mobile", page === "expected" && preferMobileSheet());
    el.subtoolbar.classList.toggle("is-opta-mobile", page === "opta" && preferMobileSheet());
    el.sidebar.style.display =
      page === "schedule" || isMarkets || isHome || (page === "team" && !state.teamPickerSlot)
        ? "none"
        : "";
    if (el.sidebarToggle) {
      el.sidebarToggle.style.display =
        page === "team" && !state.teamPickerSlot ? "none" : "";
    }
    if (el.statsToolbarStart) el.statsToolbarStart.style.display = isMarkets || isHome ? "none" : "";
    if (el.statsToolbarActions) el.statsToolbarActions.style.display = isHome ? "none" : "";
    if (el.teamToolbarControls) el.teamToolbarControls.hidden = page !== "team";
    if (el.teamToolbarMode) el.teamToolbarMode.hidden = page !== "team";
    if (prev !== page) disarmConfirmButton();
    syncTeamPlannerPrefsBtns();
    if (el.columnsSidebar) {
      el.columnsSidebar.style.display = "none";
    }
    el.tableOnlyToggles.style.display = "none";
    if (el.newpriceWrap) el.newpriceWrap.style.display = "none";
    if (el.compareToggle) {
      el.compareToggle.style.display = page === "opta" ? "" : "none";
    }
    if (page !== "opta") {
      state.enhanceRelative = false;
      enhanceRelativeUserOff = false;
    }
    syncEnhanceRelativeUI();
    if (el.columnsBtn) el.columnsBtn.style.display = "none";
    syncColumnsPanelHost();
    syncHighlightUI();
    renderColumnsPanel();
    if (page !== "opta") {
      setColumnsOpen(false);
    }
    // Expected Data keeps its own Fixture Location control (adds Compare),
    // swapped into the same sidebar slot as the shared Total/Home/Away group.
    el.splitGroup.style.display =
      page === "expected" || page === "team" || page === "ownership" ? "none" : "";
    if (el.expectedSplitGroup) {
      el.expectedSplitGroup.style.display = page === "expected" ? "" : "none";
    }
    const viewTabs = el.tabPlayers && el.tabPlayers.closest(".tabs");
    if (viewTabs) viewTabs.style.display = page === "team" ? "none" : "";
    if (page === "team") {
      if (state.view !== "players") {
        state.view = "players";
        el.tabPlayers.classList.add("active");
        el.tabTeams.classList.remove("active");
      }
      el.valueModeGroup.style.display = "none";
      el.minutesFilterGroup.style.display = "none";
      el.positionFilterGroup.style.display = "";
      el.priceFilterGroup.style.display = "";
      if (el.ownedFilterGroup) el.ownedFilterGroup.style.display = "";
      if (el.setpieceFilterGroup) el.setpieceFilterGroup.style.display = "";
      if (el.teamAffordableGroup) el.teamAffordableGroup.style.display = "";
    } else {
      el.valueModeGroup.style.display = state.view === "players" ? "" : "none";
      el.minutesFilterGroup.style.display = state.view === "players" ? "" : "none";
      el.priceFilterGroup.style.display = state.view === "players" ? "" : "none";
      if (el.ownedFilterGroup) el.ownedFilterGroup.style.display = state.view === "players" ? "" : "none";
      el.positionFilterGroup.style.display = state.view === "players" ? "" : "none";
      if (el.setpieceFilterGroup) {
        el.setpieceFilterGroup.style.display = state.view === "players" ? "" : "none";
      }
      if (el.teamAffordableGroup) el.teamAffordableGroup.style.display = "none";
    }
    if (page === "ownership") {
      el.valueModeGroup.style.display = "none";
      el.minutesFilterGroup.style.display = "none";
      if (el.setpieceFilterGroup) el.setpieceFilterGroup.style.display = "none";
      el.tableOnlyToggles.style.display = "none";
      if (el.compareToggle) el.compareToggle.style.display = "none";
    }
    if (el.ownershipTrendingGroup) {
      el.ownershipTrendingGroup.style.display = page === "ownership" ? "" : "none";
    }
    if (page !== "home") {
      clearHomePlayerLookup({ rerender: false });
      if (el.homeBento) {
        el.homeBento.classList.remove("is-player-lookup", "has-lookup-owners");
      }
      if (el.homePlayerProfile) {
        el.homePlayerProfile.hidden = true;
        el.homePlayerProfile.innerHTML = "";
      }
      if (el.homePlayerMatchup) {
        el.homePlayerMatchup.hidden = true;
        el.homePlayerMatchup.innerHTML = "";
      }
      if (el.homeSquadPanel) el.homeSquadPanel.hidden = false;
      if (el.homeStandingsPanel) el.homeStandingsPanel.hidden = false;
    }
    if (page !== "ownership") {
      if (el.ownershipTrendCards) el.ownershipTrendCards.hidden = true;
      hideOwnershipSelection();
    } else {
      syncOwnershipTrendingUI();
    }
    if (page !== "expected") setExpectedCatMenuOpen(false);
    if (page === "rankings") {
      renderRankings();
    } else if (page === "home") {
      renderHome();
    } else if (page === "ownership") {
      renderOwnership();
    } else if (page === "expected") {
      renderExpected();
    } else if (page === "schedule") {
      updateScheduleGwSlider();
      renderSchedule();
    } else if (page === "markets") {
      renderMarkets();
    } else if (page === "opta") {
      renderTable();
    } else if (page === "team") {
      renderTeam();
    }
    syncTeamPickingClass();
    // Enter after content is in the DOM so the animation covers real layout.
    playPageEnter(pagePaneFor(page));
    requestAnimationFrame(() => {
      syncAllSegThumbs({ animate: false });
      requestAnimationFrame(() => {
        scrollActivePageTabIntoView({ instant: true });
      });
      if (page === "ownership") renderOwnership();
    });
    syncExpectedCatToolbar();
    syncMarketsViewControls();
    syncMobileChrome();
    syncHomeLivePolling();
    if (pageTabWheelEnabled() && pageTabWheelBuilt) recenterActivePageTabSoon();
  }

  if (el.pageHome) el.pageHome.addEventListener("click", () => setPage("home"));
  if (el.homeViewBannerClear) {
    el.homeViewBannerClear.addEventListener("click", (e) => {
      e.preventDefault();
      clearHomeViewEntry();
    });
  }
  if (el.homeSearchBtn) {
    el.homeSearchBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.page !== "home") setPage("home");
      if (homeLookupPlayer) {
        clearHomePlayerLookup();
        return;
      }
      if (mobileSheetOpen && mobileSheetKey === "home-search") {
        closeMobileSheet();
        return;
      }
      openHomeSearchSheet();
    });
  }
  if (el.homePlayerMatchup) {
    el.homePlayerMatchup.addEventListener("click", (e) => {
      if (e.target.closest("#mobile-sheet")) return;
      const verdict = e.target.closest(".ftt-verdict-tip");
      if (verdict && el.homePlayerMatchup.contains(verdict)) {
        e.preventDefault();
        e.stopPropagation();
        hideTeamRankTooltip();
        if (matchupEdgeActiveCell === verdict) hideMatchupEdgeTooltip();
        else showMatchupEdgeTooltip(verdict, e);
        return;
      }
      const info = e.target.closest(".team-rank-info");
      if (!info || !el.homePlayerMatchup.contains(info)) return;
      e.preventDefault();
      e.stopPropagation();
      hideMatchupEdgeTooltip();
      const teamCode = info.getAttribute("data-team");
      if (preferMobileSheet() || !hasFineHover()) {
        openTeamRankSheet(teamCode);
        info.setAttribute("aria-expanded", "true");
      } else {
        showTeamRankTooltip(info, e);
      }
    });
  }
  el.pageOpta.addEventListener("click", () => setPage("opta"));
  el.pageRankings.addEventListener("click", () => setPage("rankings"));
  if (el.pageOwnership) el.pageOwnership.addEventListener("click", () => setPage("ownership"));
  if (el.ownershipTrendWindowSeg) {
    el.ownershipTrendWindowSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-trend-window]");
      if (!btn) return;
      const next = Number(btn.dataset.trendWindow);
      if (next !== 1 && next !== 3 && next !== 7) return;
      if (next === state.ownershipTrendWindow) return;
      state.ownershipTrendWindow = next;
      syncOwnershipTrendWindowUI({ animate: true });
      syncFiltersResetUI();
      if (state.page === "ownership") renderOwnership();
    });
  }
  if (el.ownershipSelection) {
    el.ownershipSelection.addEventListener("click", (e) => {
      const close = e.target.closest(".ownership-selection-close");
      if (!close || !el.ownershipSelection.contains(close)) return;
      e.preventDefault();
      clearOwnershipSelection();
    });
  }
  if (el.ownershipTrendCards) {
    el.ownershipTrendCards.addEventListener("pointerover", (e) => {
      if (!hasFineHover()) return;
      if (ownershipPinnedKey) return;
      const row = e.target.closest("[data-ownership-key]");
      if (!row || !el.ownershipTrendCards.contains(row)) return;
      if (e.relatedTarget && row.contains(e.relatedTarget)) return;
      const key = row.getAttribute("data-ownership-key");
      if (!key || ownershipHoverKey === key) return;
      const series = ownershipSeriesCache.find((s) => s.key === key);
      hoverOwnershipSeries(key, { fromChart: false });
      if (series) showOwnershipTooltipForSeries(series, ownershipLastOwnedIndex(series));
    });
    // Clear only when the pointer leaves the cards entirely — clearing per row
    // would blink the chart while scrubbing between names.
    el.ownershipTrendCards.addEventListener("pointerleave", () => {
      if (!hasFineHover()) return;
      if (ownershipPinnedKey) {
        restoreOwnershipPin();
        return;
      }
      if (!ownershipHoverKey) return;
      setOwnershipHover(null, null);
      hideOwnershipTooltip();
    });
    el.ownershipTrendCards.addEventListener("click", (e) => {
      const toggle = e.target.closest("[data-ownership-collapse]");
      if (toggle && el.ownershipTrendCards.contains(toggle)) {
        e.preventDefault();
        const which = toggle.getAttribute("data-ownership-collapse");
        if (which === "risers") state.ownershipRisersCollapsed = !state.ownershipRisersCollapsed;
        else if (which === "fallers") state.ownershipFallersCollapsed = !state.ownershipFallersCollapsed;
        else return;
        syncOwnershipTrendCollapse();
        return;
      }
      const row = e.target.closest("[data-ownership-key]");
      if (!row) return;
      const key = row.getAttribute("data-ownership-key");
      const series = ownershipSeriesCache.find((s) => s.key === key);
      if (!series) return;
      const pinned = pinOwnershipSeries(key, { fromChart: false });
      if (!pinned) return;
      const lastIdx = ownershipLastOwnedIndex(series);
      const showTip = () => showOwnershipTooltipForSeries(series, lastIdx);
      showTip();
      scrollOwnershipChartIntoView(showTip);
    });
  }
  if (el.pageTeam) el.pageTeam.addEventListener("click", () => setPage("team"));
  el.pageExpected.addEventListener("click", () => setPage("expected"));
  if (el.expectedCatBtn) {
    el.expectedCatBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.page !== "expected") return;
      if (preferMobileSheet()) {
        if (mobileSheetOpen && mobileSheetKey === "expected-cats") {
          closeMobileSheet();
          syncExpectedCatToolbar();
          return;
        }
        openExpectedCatSheet();
        syncExpectedCatToolbar();
        return;
      }
      buildExpectedCatMenu();
      setExpectedCatMenuOpen(!el.expectedCatMenu?.classList.contains("open"));
    });
  }
  el.pageSchedule.addEventListener("click", () => setPage("schedule"));
  if (el.pageTrayBtn) {
    el.pageTrayBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPageTrayOpen(!pageTrayIsOpen());
    });
  }
  if (el.pageMarkets) {
    el.pageMarkets.addEventListener("click", () => setPage("markets"));
  }
  document.addEventListener("click", (e) => {
    if (preferMobileSheet()) return;
    if (!el.expectedCatMenu?.classList.contains("open")) return;
    if (el.expectedCatToolbar?.contains(e.target)) return;
    setExpectedCatMenuOpen(false);
  });
  window.addEventListener("resize", () => {
    syncPageTabsScrollHints();
    if (pageTabWheelEnabled() && pageTabWheelBuilt) {
      scrollActivePageTabIntoView({ instant: true });
    }
    syncExpectedCatToolbar();
    syncMarketsViewControls();
    syncBarbellHeadHeight();
    if (preferMobileSheet()) setExpectedCatMenuOpen(false);
  });

  let pageTabWheelBuilt = false;
  let pageTabWheelLock = false;
  let pageTabWheelUnlockTimer = 0;
  let pageTabWheelGen = 0;
  let pageTabFocusEl = null;
  let pageTabWheelBooted = false;

  function pageTabWheelEnabled() {
    return !!(el.pageTabs && !NARROW_MQ.matches);
  }

  function pageKeyFromTabBtn(btn) {
    if (!btn) return null;
    const id = btn.id || "";
    if (id === "page-home") return "home";
    if (id === "page-opta") return "opta";
    if (id === "page-rankings") return "rankings";
    if (id === "page-ownership") return "ownership";
    if (id === "page-team") return "team";
    if (id === "page-expected") return "expected";
    if (id === "page-schedule") return "schedule";
    if (id === "page-markets") return "markets";
    const host = btn.closest("[data-page-clone]");
    return host ? host.getAttribute("data-page-clone") : null;
  }

  function clonePageTabNode(node) {
    const clone = node.cloneNode(true);
    clone.classList.add("page-tab-clone");
    clone.removeAttribute("id");
    clone.removeAttribute("data-page-tab-origin");
    clone.setAttribute("aria-hidden", "true");
    clone.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    clone.querySelectorAll("[aria-controls]").forEach((n) => n.removeAttribute("aria-controls"));
    clone.querySelectorAll(".dropdown-panel, .page-tab-menu").forEach((n) => n.remove());
    clone.querySelectorAll(".page-tab-btn").forEach((btn) => {
      btn.removeAttribute("id");
      btn.setAttribute("tabindex", "-1");
      btn.setAttribute("aria-hidden", "true");
    });
    const origBtn = node.matches(".page-tab-btn") ? node : node.querySelector(".page-tab-btn");
    const page = pageKeyFromTabBtn(origBtn);
    if (page) clone.setAttribute("data-page-clone", page);
    if (clone.matches(".page-tab-btn")) clone.setAttribute("tabindex", "-1");
    return clone;
  }

  function pageTabOrigins() {
    if (!el.pageTabs) return [];
    return [...el.pageTabs.children].filter(
      (n) => n.hasAttribute("data-page-tab-origin") && !n.classList.contains("page-tab-clone")
    );
  }

  function pageTabHostsForPage(page) {
    const tabs = el.pageTabs;
    if (!tabs || !page) return [];
    const hosts = [];
    tabs.querySelectorAll(`[data-page-clone="${page}"]`).forEach((node) => hosts.push(node));
    const idByPage = {
      home: "page-home",
      opta: "page-opta",
      rankings: "page-rankings",
      ownership: "page-ownership",
      team: "page-team",
      expected: "page-expected",
      schedule: "page-schedule",
      markets: "page-markets",
    };
    const btn = idByPage[page] ? tabs.querySelector(`#${idByPage[page]}`) : null;
    if (btn && tabs.contains(btn)) hosts.push(btn.closest(".page-tab-dropdown") || btn);
    return hosts;
  }

  function scrollLeftToCenterHost(host) {
    if (!host || !el.pageTabs) return 0;
    return el.pageTabs.scrollLeft + pageTabDeltaToCenter(host);
  }

  function bestPageTabCenterHost(page) {
    const tabs = el.pageTabs;
    const w = pageTabSetWidth();
    const hosts = pageTabHostsForPage(page);
    if (!tabs || !hosts.length) return null;
    if (!pageTabWheelBuilt || w < 8) {
      const originBtn = tabs.querySelector(".page-tab-btn.active[id]");
      if (originBtn && tabs.contains(originBtn)) {
        return originBtn.closest(".page-tab-dropdown") || originBtn;
      }
      return hosts[0];
    }
    const inBand = hosts.filter((host) => {
      const sl = scrollLeftToCenterHost(host);
      return sl >= w - 2 && sl < 2 * w - 2;
    });
    const pool = inBand.length ? inBand : hosts;
    return pool.reduce((best, host) => {
      if (!best) return host;
      return Math.abs(pageTabDeltaToCenter(host)) < Math.abs(pageTabDeltaToCenter(best)) ? host : best;
    }, null);
  }

  function pageTabSetWidth() {
    const tabs = el.pageTabs;
    const origins = pageTabOrigins();
    if (!tabs || !origins.length) return 0;
    const first = origins[0];
    const last = origins[origins.length - 1];
    const gap = parseFloat(getComputedStyle(tabs).columnGap || getComputedStyle(tabs).gap) || 0;
    return last.offsetLeft + last.offsetWidth + gap - first.offsetLeft;
  }

  function wrapPageTabsScroll() {
    const tabs = el.pageTabs;
    if (!tabs || !pageTabWheelBuilt || pageTabWheelLock) return;
    const w = pageTabSetWidth();
    if (w < 8) return;
    let sl = tabs.scrollLeft;
    let guard = 0;
    while (sl < w && guard < 4) {
      sl += w;
      guard += 1;
    }
    while (sl >= 2 * w && guard < 4) {
      sl -= w;
      guard += 1;
    }
    if (Math.abs(sl - tabs.scrollLeft) > 1) tabs.scrollLeft = sl;
  }

  function syncPageTabCloneActive(page) {
    if (!el.pageTabs) return;
    el.pageTabs.querySelectorAll("[data-page-clone]").forEach((node) => {
      const btn = node.matches(".page-tab-btn") ? node : node.querySelector(".page-tab-btn");
      if (btn) btn.classList.toggle("active", node.getAttribute("data-page-clone") === page);
    });
  }

  function teardownPageTabWheel() {
    if (!el.pageTabs) return;
    el.pageTabs.querySelectorAll(".page-tab-clone").forEach((n) => n.remove());
    pageTabOrigins().forEach((n) => n.removeAttribute("data-page-tab-origin"));
    el.pageTabs.classList.remove("is-wheel");
    pageTabWheelBuilt = false;
    pageTabWheelLock = false;
  }

  function buildPageTabWheel() {
    const tabs = el.pageTabs;
    if (!tabs || pageTabWheelBuilt) return;
    const originals = [...tabs.children];
    if (!originals.length) return;
    originals.forEach((n) => n.setAttribute("data-page-tab-origin", "1"));
    const before = document.createDocumentFragment();
    const after = document.createDocumentFragment();
    originals.forEach((n) => before.appendChild(clonePageTabNode(n)));
    originals.forEach((n) => after.appendChild(clonePageTabNode(n)));
    tabs.insertBefore(before, tabs.firstChild);
    tabs.appendChild(after);
    tabs.classList.add("is-wheel");
    pageTabWheelBuilt = true;
    syncPageTabCloneActive(state.page);
  }

  function syncPageTabWheel() {
    if (pageTabWheelEnabled()) {
      const was = pageTabWheelBuilt;
      buildPageTabWheel();
      if (!was && pageTabWheelBuilt) {
        requestAnimationFrame(() => {
          scrollActivePageTabIntoView({ instant: true });
        });
      }
    } else {
      teardownPageTabWheel();
    }
    if (el.pageTabsClip) el.pageTabsClip.classList.toggle("is-wheel", pageTabWheelBuilt);
    if (el.pageTabsClip && !pageTabWheelBuilt) el.pageTabsClip.classList.remove("is-ready");
  }

  function markPageTabsReady() {
    if (el.pageTabsClip && pageTabWheelBuilt) el.pageTabsClip.classList.add("is-ready");
  }

  function pageTabsAreScrollable() {
    const tabs = el.pageTabs;
    if (!tabs || NARROW_MQ.matches) return false;
    if (pageTabWheelBuilt) return true;
    return tabs.scrollWidth > tabs.clientWidth + 2;
  }

  function unlockPageTabWheel() {
    if (!pageTabWheelLock) return;
    pageTabWheelLock = false;
    wrapPageTabsScroll();
    syncPageTabsScrollHints();
  }

  function pageTabDeltaToCenter(target) {
    if (!target) return 0;
    const tabRect = target.getBoundingClientRect();
    const screenMid = window.innerWidth / 2;
    return tabRect.left + tabRect.width / 2 - screenMid;
  }

  function originActivePageTabHost() {
    const tabs = el.pageTabs;
    if (!tabs) return null;
    const originBtn = tabs.querySelector(".page-tab-btn.active[id]");
    if (!originBtn || !tabs.contains(originBtn)) return null;
    return originBtn.closest(".page-tab-dropdown") || originBtn;
  }

  function centerPageTabEl(target) {
    const tabs = el.pageTabs;
    if (!tabs || !target) return;
    let host = target;
    let delta = pageTabDeltaToCenter(host);
    if (Math.abs(delta) < 0.5) {
      wrapPageTabsScroll();
      return;
    }
    tabs.scrollLeft += delta;
    wrapPageTabsScroll();
    host = bestPageTabCenterHost(state.page) || host;
    delta = pageTabDeltaToCenter(host);
    if (Math.abs(delta) >= 0.5) tabs.scrollLeft += delta;
    wrapPageTabsScroll();
    host = bestPageTabCenterHost(state.page) || host;
    delta = pageTabDeltaToCenter(host);
    if (Math.abs(delta) >= 0.5) tabs.scrollLeft += delta;
  }

  function pageTabHostFromNode(node) {
    if (!node || !el.pageTabs || !el.pageTabs.contains(node)) return null;
    const clone = node.closest("[data-page-clone]");
    if (clone) return clone;
    const origin = node.closest("[data-page-tab-origin]");
    if (origin) return origin.closest(".page-tab-dropdown") || origin;
    const btn = node.closest(".page-tab-btn");
    if (btn) return btn.closest(".page-tab-dropdown") || btn;
    return null;
  }

  function scrollActivePageTabIntoView(opts = {}) {
    const tabs = el.pageTabs;
    if (!tabs) return;
    if (!pageTabWheelBooted) opts = { ...opts, instant: true };
    if (!pageTabWheelEnabled()) {
      if (!pageTabsAreScrollable()) return;
      const activeBtn = tabs.querySelector(".page-tab-btn.active[id]") || tabs.querySelector(".page-tab-btn.active");
      if (!activeBtn) return;
      const target = activeBtn.closest(".page-tab-dropdown") || activeBtn;
      const tabsRect = tabs.getBoundingClientRect();
      const tabRect = target.getBoundingClientRect();
      const pad = 12;
      if (tabRect.left < tabsRect.left + pad) {
        tabs.scrollLeft -= tabsRect.left + pad - tabRect.left;
      } else if (tabRect.right > tabsRect.right - pad) {
        tabs.scrollLeft += tabRect.right - (tabsRect.right - pad);
      }
      syncPageTabsScrollHints();
      return;
    }
    if (!pageTabWheelBuilt) buildPageTabWheel();
    let target = null;
    const w = pageTabSetWidth();
    if (pageTabFocusEl && tabs.contains(pageTabFocusEl)) {
      const focusSl = scrollLeftToCenterHost(pageTabFocusEl);
      if (!pageTabWheelBuilt || w < 8 || (focusSl >= w - 2 && focusSl < 2 * w - 2)) {
        target = pageTabFocusEl;
      }
    }
    pageTabFocusEl = null;
    if (!target) target = bestPageTabCenterHost(state.page);
    if (!target) return;
    centerPageTabEl(target);
    syncPageTabsScrollHints();
    markPageTabsReady();
  }

  function recenterActivePageTabSoon() {
    requestAnimationFrame(() => {
      scrollActivePageTabIntoView({ instant: true });
      requestAnimationFrame(() => scrollActivePageTabIntoView({ instant: true }));
    });
  }

  function syncPageTabsScrollHints() {
    const tabs = el.pageTabs;
    const clip = el.pageTabsClip;
    if (!tabs || !clip) return;
    if (pageTabWheelBuilt) {
      clip.classList.add("has-more-left", "has-more-right");
      return;
    }
    const maxScroll = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
    if (maxScroll < 2) {
      clip.classList.remove("has-more-left", "has-more-right");
      return;
    }
    const left = tabs.scrollLeft;
    // Subpixel scrollLeft often never reaches maxScroll exactly.
    clip.classList.toggle("has-more-left", left > 1);
    clip.classList.toggle("has-more-right", left < maxScroll - 2);
  }

  if (el.pageTabs) {
    el.pageTabs.addEventListener("scroll", () => {
      if (!pageTabWheelLock) wrapPageTabsScroll();
      syncPageTabsScrollHints();
    }, { passive: true });
    el.pageTabs.addEventListener(
      "click",
      (e) => {
        if (!e.target.closest(".dropdown-panel, .page-tab-menu")) {
          const host = pageTabHostFromNode(e.target);
          if (host) pageTabFocusEl = host;
        }
        const clone = e.target.closest("[data-page-clone]");
        if (!clone || !el.pageTabs.contains(clone)) return;
        const page = clone.getAttribute("data-page-clone");
        if (!page) return;
        e.preventDefault();
        e.stopPropagation();
        pageTabFocusEl = clone;
        setPage(page);
      },
      true
    );
    el.pageTabs.addEventListener(
      "wheel",
      (e) => {
        if (!pageTabWheelEnabled()) return;
        if (e.ctrlKey) return;
        const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        if (!dx) return;
        e.preventDefault();
        el.pageTabs.scrollLeft += dx;
      },
      { passive: false }
    );
    if (typeof ResizeObserver !== "undefined") {
      const tabsRo = new ResizeObserver(() => {
        syncPageTabsScrollHints();
        if (pageTabWheelBuilt) scrollActivePageTabIntoView({ instant: true });
      });
      tabsRo.observe(el.pageTabs);
      if (el.pageTabsClip) tabsRo.observe(el.pageTabsClip);
    }
    syncPageTabWheel();
  }

  // Brand mark always returns to Home with a full refresh so filters
  // and ephemeral UI state reset alongside the page switch.
  const brandHome = document.querySelector("#brand-home");
  if (brandHome) {
    brandHome.addEventListener("click", (e) => {
      e.preventDefault();
      try {
        localStorage.setItem(PAGE_KEY, "home");
      } catch {
        // Private browsing — reload still lands on the default page.
      }
      location.reload();
    });
  }

  // ---------------------------------------------------------------------
  // Wire up controls
  // ---------------------------------------------------------------------
  function setView(view) {
    state.view = view;
    document.documentElement.dataset.view = view;
    state.sortKey = "pts";
    state.sortDir = "desc";
    state.hiddenCols = new Set();
    state.compareMode = false;
    state.compareSelection.players.clear();
    state.compareSelection.teams.clear();
    // Player ids and team codes share the same pin list, so a view switch
    // would otherwise leave pins that can never match a visible row.
    state.rankingsPins.length = 0;
    resetSearchAndFiltersForNavigation({ rerender: false });
    el.compareToggle.classList.remove("on");
    hideToast();
    el.tabPlayers.classList.toggle("active", view === "players");
    el.tabTeams.classList.toggle("active", view === "teams");
    syncSegThumb(el.tabPlayers.closest(".tabs"));
    el.positionFilterGroup.style.display = view === "players" ? "" : "none";
    if (el.setpieceFilterGroup) el.setpieceFilterGroup.style.display = view === "players" ? "" : "none";
    el.minutesFilterGroup.style.display = view === "players" ? "" : "none";
    el.priceFilterGroup.style.display = view === "players" ? "" : "none";
    if (el.ownedFilterGroup) el.ownedFilterGroup.style.display = view === "players" ? "" : "none";
    el.valueModeGroup.style.display = view === "players" ? "" : "none";
    if (state.page === "ownership") {
      el.valueModeGroup.style.display = "none";
      el.minutesFilterGroup.style.display = "none";
      if (el.setpieceFilterGroup) el.setpieceFilterGroup.style.display = "none";
    }
    state.enhancePct = view === "players" ? ENHANCE_PCT_PLAYERS : ENHANCE_PCT_TEAMS;
    updateEnhancePctSlider();
    syncHighlightUI();
    if (view !== "players" && state.valueMode !== "total") {
      setValueMode("total", { rerender: false });
    }
    renderColumnsPanel();
    if (state.page === "expected") renderExpected();
    else {
      buildExpectedCatMenu();
      syncExpectedCatToolbar();
    }
    renderTable();
    if (state.page === "opta" && el.optaPage) {
      requestAnimationFrame(() => startOptaHighlightEnter(el.optaPage));
    }
    syncAllNameColumnSimplifies();
    if (view === "players") {
      requestAnimationFrame(() => syncSegThumb(el.valueModeSeg, { animate: false }));
    }
    syncMobileChrome();
  }

  el.tabPlayers.addEventListener("click", () => setView("players"));
  el.tabTeams.addEventListener("click", () => setView("teams"));

  el.splitSeg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-split]");
    if (!btn) return;
    state.split = btn.dataset.split;
    $$("#split-seg button").forEach((b) => b.classList.toggle("active", b === btn));
    syncSegThumb(el.splitSeg);
    renderTable();
  });

  el.expectedSplitSeg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-split]");
    if (!btn || btn.disabled) return;
    state.expectedSplit = btn.dataset.split;
    $$("#expected-split-seg button").forEach((b) => b.classList.toggle("active", b === btn));
    syncSegThumb(el.expectedSplitSeg);
    renderExpected();
  });

  let searchTimer;

  function syncSearchClearBtns() {
    const pairs = [
      { input: el.search, btn: el.searchClearBtn, wrap: el.searchWrap },
    ];
    for (const { input, btn, wrap } of pairs) {
      if (!btn) continue;
      const open = !wrap || wrap.classList.contains("search-open");
      const hasQuery = !!(input && String(input.value || "").trim());
      btn.hidden = !(open && hasQuery);
    }
  }

  function clearMainSearch() {
    if (preferMobileSheet() && !mainSearchAlwaysOpen() && !mobileSearchAlwaysOpen()) {
      closeMobileSearch({ clear: true });
    } else if (el.search) {
      el.search.value = "";
      el.search.focus({ preventScroll: true });
      state.search = "";
      syncSearchClearBtns();
    } else {
      state.search = "";
      syncSearchClearBtns();
    }
    if (state.page === "team") {
      if (!state.teamPickerSlot) return;
      renderTeam();
    } else if (state.page !== "rankings") renderTable();
  }

  function teamSearchAlwaysOpen() {
    return state.page === "team" && !!state.teamPickerSlot && !preferMobileSheet();
  }

  function searchAlwaysOpen() {
    return (
      mainSearchAlwaysOpen() ||
      mobileSearchAlwaysOpen() ||
      (state.page === "team" && !!state.teamPickerSlot)
    );
  }

  function mainSearchAlwaysOpen() {
    if (state.page === "team") return teamSearchAlwaysOpen();
    return state.page === "opta" && !preferMobileSheet();
  }

  function mobileSearchAlwaysOpen() {
    return (
      preferMobileSheet() &&
      (state.page === "ownership" ||
        state.page === "expected" ||
        state.page === "opta" ||
        (state.page === "team" && !!state.teamPickerSlot))
    );
  }

  function syncTeamSearchHost() {
    if (!el.searchWrap) return;
    const pickingMobile =
      preferMobileSheet() && state.page === "team" && !!state.teamPickerSlot;
    const home = el.searchHome;
    if (pickingMobile && el.statsToolbarActions) {
      if (el.searchWrap.parentElement !== el.statsToolbarActions) {
        el.statsToolbarActions.appendChild(el.searchWrap);
      }
    } else if (home && el.searchWrap.parentElement !== home) {
      home.appendChild(el.searchWrap);
    }
    // Rankings: no search — hide the control entirely.
    // Team squad view: search only while picking a player.
    const hideSearch =
      state.page === "rankings" ||
      (state.page === "team" && !state.teamPickerSlot);
    el.searchWrap.style.display = hideSearch ? "none" : "";
    el.searchWrap.classList.toggle("team-search-always-open", teamSearchAlwaysOpen());
    el.searchWrap.classList.toggle(
      "stats-search-always-open",
      state.page === "opta" && !preferMobileSheet()
    );
    el.searchWrap.classList.toggle("mobile-search-always-open", mobileSearchAlwaysOpen());
    if (state.page === "rankings") {
      el.searchWrap.classList.remove("search-open");
      if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "false");
    } else if (
      mainSearchAlwaysOpen() ||
      mobileSearchAlwaysOpen() ||
      (state.page === "team" && state.teamPickerSlot)
    ) {
      el.searchWrap.classList.add("search-open");
      if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "true");
    } else if (!(el.search && el.search.value.trim())) {
      el.searchWrap.classList.remove("search-open");
      if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "false");
    }
    syncSearchClearBtns();
    syncTeamSearchCombobox();
    if (state.page === "opta") scheduleOptaMobileNameColWidth();
  }

  function closeMobileSearch({ clear = false } = {}) {
    if (!el.searchWrap) return;
    const alwaysOpen = searchAlwaysOpen();
    if (alwaysOpen && !clear) return;
    if (clear) {
      if (el.search) el.search.value = "";
      state.search = "";
      syncSearchClearBtns();
      if (alwaysOpen) return;
    }
    el.searchWrap.classList.remove("search-open");
    if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "false");
    syncSearchClearBtns();
  }

  function openMobileSearch() {
    if (!el.searchWrap) return;
    el.searchWrap.classList.add("search-open");
    if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "true");
    syncSearchClearBtns();
    requestAnimationFrame(() => {
      el.search.focus({ preventScroll: true });
    });
  }

    if (el.searchToggle) {
    el.searchToggle.addEventListener("click", (e) => {
      e.preventDefault();
      if (mainSearchAlwaysOpen()) return;
      if (el.searchWrap.classList.contains("search-open")) closeMobileSearch();
      else openMobileSearch();
    });
  }

  document.addEventListener("click", (e) => {
    if (searchAlwaysOpen()) return;
    if (!el.searchWrap) return;
    if (!el.searchWrap.classList.contains("search-open")) return;
    if (el.searchWrap.contains(e.target)) return;
    if (el.search && el.search.value.trim()) return;
    closeMobileSearch();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!el.searchWrap?.classList.contains("search-open")) return;
    if (searchAlwaysOpen()) return;
    closeMobileSearch();
    el.search.blur();
  });

  el.search.addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const val = e.target.value;
    syncSearchClearBtns();
    searchTimer = setTimeout(() => {
      state.search = val;
      if (state.page === "rankings") return;
      if (state.page === "team") {
        if (!state.teamPickerSlot) return;
        renderTeam();
        return;
      }
      renderTable();
    }, 120);
  });

  el.search.addEventListener("keydown", (e) => {
    if (state.page !== "team" || state.teamPickerSlot) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveTeamSearchActive(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    pinTeamSearchActive();
  });

  el.search.addEventListener("focus", () => {
    if (el.searchWrap && !el.searchWrap.classList.contains("search-open")) {
      openMobileSearch();
    }
    syncSearchClearBtns();
  });

  if (el.searchClearBtn) {
    el.searchClearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearMainSearch();
    });
  }


  function setupDualSlider({
    minInput,
    maxInput,
    fillEl,
    minLabelEl,
    maxLabelEl,
    boundsMin,
    boundsMax,
    // Optional live bounds (mutated on season switch). When set, overrides
    // the static boundsMin/boundsMax each paint.
    getBounds = null,
    step,
    get,
    set,
    format,
    onInput = renderTable,
  }) {
    function rangeBounds() {
      if (getBounds) return getBounds();
      return { min: boundsMin, max: boundsMax };
    }

    function syncInputBounds() {
      const { min, max } = rangeBounds();
      [minInput, maxInput].forEach((inp) => {
        inp.min = min;
        inp.max = max;
        inp.step = step;
      });
    }
    syncInputBounds();

    function updateUI() {
      syncInputBounds();
      const { min: bMin, max: bMax } = rangeBounds();
      const [curMin, curMax] = get();
      minInput.value = curMin;
      maxInput.value = curMax;
      const span = bMax - bMin || 1;
      const pctMin = ((curMin - bMin) / span) * 100;
      const pctMax = ((curMax - bMin) / span) * 100;
      fillEl.style.left = pctMin + "%";
      fillEl.style.right = 100 - pctMax + "%";
      minLabelEl.textContent = format(curMin);
      maxLabelEl.textContent = format(curMax);
    }

    minInput.addEventListener("input", () => {
      fillEl.classList.add("is-live");
      const [, curMax] = get();
      const v = Math.min(Number(minInput.value), curMax);
      set(v, curMax);
      updateUI();
      onInput();
    });
    maxInput.addEventListener("input", () => {
      fillEl.classList.add("is-live");
      const [curMin] = get();
      const v = Math.max(Number(maxInput.value), curMin);
      set(curMin, v);
      updateUI();
      onInput();
    });
    const endLive = () => fillEl.classList.remove("is-live");
    minInput.addEventListener("change", endLive);
    maxInput.addEventListener("change", endLive);
    minInput.addEventListener("pointerup", endLive);
    maxInput.addEventListener("pointerup", endLive);

    updateUI();
    return updateUI;
  }

  const updatePriceSlider = setupDualSlider({
    minInput: el.priceMin,
    maxInput: el.priceMax,
    fillEl: el.priceFill,
    minLabelEl: el.priceMinLabel,
    maxLabelEl: el.priceMaxLabel,
    getBounds: () => bounds.price,
    step: 0.1,
    get: () => [state.priceMin, state.priceMax],
    set: (lo, hi) => {
      state.priceMin = lo;
      state.priceMax = hi;
    },
    format: (v) => "£" + v.toFixed(1) + "m",
  });

  const updateMinsSlider = setupDualSlider({
    minInput: el.minsMin,
    maxInput: el.minsMax,
    fillEl: el.minsFill,
    minLabelEl: el.minsMinLabel,
    maxLabelEl: el.minsMaxLabel,
    getBounds: () => bounds.mins,
    step: 10,
    get: () => [state.minsMin, state.minsMax],
    set: (lo, hi) => {
      state.minsMin = lo;
      state.minsMax = hi;
    },
    format: (v) => fmtNum(v, 0),
  });

  const updateScheduleGwSlider = setupDualSlider({
    minInput: el.scheduleGwMin,
    maxInput: el.scheduleGwMax,
    fillEl: el.scheduleGwFill,
    minLabelEl: el.scheduleGwMinLabel,
    maxLabelEl: el.scheduleGwMaxLabel,
    boundsMin: SCHEDULE_GW_MIN,
    boundsMax: SCHEDULE_GW_MAX,
    step: 1,
    get: () => [state.scheduleGwMin, state.scheduleGwMax],
    set: (lo, hi) => {
      state.scheduleGwMin = lo;
      state.scheduleGwMax = hi;
    },
    format: (v) => `GW${v}`,
    onInput: renderSchedule,
  });

  // Single-thumb variant of setupDualSlider, for the Enhance highlight-%
  // control — one value, fill runs from the track's left edge to the thumb.
  function setupSingleSlider({
    input,
    fillEl,
    labelEl,
    boundsMin,
    boundsMax,
    step,
    get,
    set,
    format,
    onInput = renderTable,
  }) {
    input.min = boundsMin;
    input.max = boundsMax;
    input.step = step;

    function updateUI() {
      const v = get();
      input.value = v;
      const span = boundsMax - boundsMin || 1;
      fillEl.style.left = "0%";
      fillEl.style.width = ((v - boundsMin) / span) * 100 + "%";
      labelEl.textContent = format(v);
    }

    input.addEventListener("input", () => {
      fillEl.classList.add("is-live");
      set(Number(input.value));
      updateUI();
      onInput();
    });
    const endLive = () => fillEl.classList.remove("is-live");
    input.addEventListener("change", endLive);
    input.addEventListener("pointerup", endLive);

    updateUI();
    return updateUI;
  }

  // Sidebar Enhance % (Statistics) and Matchups Highlight Ranks are independent —
  // Matchups is always a team view, so it uses absolute top/bottom place counts.
  let updateEnhancePctSlider = () => {};
  let updateScheduleEnhancePctSlider = () => {};
  const updateOwnedSlider = setupSingleSlider({
    input: el.ownedMin,
    fillEl: el.ownedMinFill,
    labelEl: el.ownedMinLabel,
    boundsMin: 0,
    boundsMax: OWNERSHIP_FILTER_MAX,
    step: 0.5,
    get: () => state.ownedMin,
    set: (value) => {
      state.ownedMin = value;
    },
    format: (value) => `${value.toFixed(1)}+`,
  });

  updateEnhancePctSlider = setupSingleSlider({
    input: el.enhancePct,
    fillEl: el.enhancePctFill,
    labelEl: el.enhancePctLabel,
    boundsMin: ENHANCE_PCT_MIN,
    boundsMax: ENHANCE_PCT_MAX,
    step: 1,
    get: () => state.enhancePct,
    set: (v) => {
      state.enhancePct = v;
    },
    format: (v) => `Top ${v}%`,
    onInput: renderTable,
  });

  updateScheduleEnhancePctSlider = setupSingleSlider({
    input: el.scheduleEnhancePct,
    fillEl: el.scheduleEnhancePctFill,
    labelEl: el.scheduleEnhancePctLabel,
    boundsMin: SCHEDULE_ENHANCE_TOP_MIN,
    boundsMax: SCHEDULE_ENHANCE_TOP_MAX,
    step: 1,
    get: () => state.scheduleEnhanceTopN,
    set: (v) => {
      state.scheduleEnhanceTopN = v;
    },
    format: (v) => `Top/Bottom ${v}`,
    onInput: renderSchedule,
  });

  const updateScheduleExpectedWeightSlider = setupSingleSlider({
    input: el.scheduleExpectedWeight,
    fillEl: el.scheduleExpectedWeightFill,
    labelEl: el.scheduleExpectedWeightLabel,
    boundsMin: 0,
    boundsMax: 100,
    step: 5,
    get: () => state.scheduleExpectedWeight,
    set: (v) => {
      state.scheduleExpectedWeight = v;
    },
    format: (v) => `${v} / ${100 - v}`,
    onInput: renderSchedule,
  });

  const scheduleEdgeMinInfo = $("#schedule-edge-min-info");
  if (scheduleEdgeMinInfo) {
    scheduleEdgeMinInfo.setAttribute(
      "data-tip-html",
      `Determines how many ranked values difference required to trigger matchup advantage ${iconHTML("swords", "ftt-attack-icon")} / ${iconHTML("shield-half", "ftt-defence-icon")}.`
    );
  }

  const updateScheduleEdgeMinSlider = setupSingleSlider({
    input: el.scheduleEdgeMin,
    fillEl: el.scheduleEdgeMinFill,
    labelEl: el.scheduleEdgeMinLabel,
    boundsMin: SCHEDULE_EDGE_MIN,
    boundsMax: SCHEDULE_EDGE_MAX,
    step: 1,
    get: () => state.scheduleEdgeMin,
    set: (v) => {
      state.scheduleEdgeMin = v;
    },
    format: (v) => `≥ ${v} ranks better`,
    onInput: renderSchedule,
  });

  let updateMarketsHeatGoalsSlider = () => {};
  let updateMarketsHeatCsSlider = () => {};
  if (el.marketsHeatGoals && el.marketsHeatGoalsFill && el.marketsHeatGoalsLabel) {
    updateMarketsHeatGoalsSlider = setupSingleSlider({
      input: el.marketsHeatGoals,
      fillEl: el.marketsHeatGoalsFill,
      labelEl: el.marketsHeatGoalsLabel,
      boundsMin: MARKETS_HEAT_MIN,
      boundsMax: MARKETS_HEAT_MAX,
      step: 5,
      get: () => state.marketsHeatGoals,
      set: (v) => {
        state.marketsHeatGoals = clampMarketsHeat(v);
        saveMarketsHeat(MARKETS_HEAT_GOALS_KEY, state.marketsHeatGoals);
      },
      format: formatMarketsGoalsHeatLabel,
      onInput: renderMarkets,
    });
  }
  if (el.marketsHeatCs && el.marketsHeatCsFill && el.marketsHeatCsLabel) {
    updateMarketsHeatCsSlider = setupSingleSlider({
      input: el.marketsHeatCs,
      fillEl: el.marketsHeatCsFill,
      labelEl: el.marketsHeatCsLabel,
      boundsMin: MARKETS_HEAT_MIN,
      boundsMax: MARKETS_HEAT_MAX,
      step: 5,
      get: () => state.marketsHeatCs,
      set: (v) => {
        state.marketsHeatCs = clampMarketsHeat(v);
        saveMarketsHeat(MARKETS_HEAT_CS_KEY, state.marketsHeatCs);
      },
      format: formatMarketsCsHeatLabel,
      onInput: renderMarkets,
    });
  }

  if (el.marketsCompareSeg) {
    el.marketsCompareSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-markets-compare]");
      if (!btn || !el.marketsCompareSeg.contains(btn)) return;
      const mode = btn.dataset.marketsCompare;
      if (mode !== "current" && mode !== "last" && mode !== "72h") return;
      if (mode === state.marketsCompare) return;
      state.marketsCompare = mode;
      syncMarketsCompareSeg();
      renderMarkets();
    });
  }

  if (el.marketsViewSeg) {
    el.marketsViewSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-markets-view]");
      if (!btn || !el.marketsViewSeg.contains(btn)) return;
      const key = btn.dataset.marketsView;
      if (key !== "stats" && key !== "scoreline") return;
      setMarketsCardView(key);
    });
  }

  syncMarketsViewControls();
  syncMobileChrome();

  function setMarketsSlidersOpen(open) {
    if (!el.marketsControls || !el.marketsSlidersToggle) return;
    if (!hasFineHover()) {
      if (open) {
        openMobileSheetHost({
          title: "Markets filters",
          key: "markets-filters",
          hostEl: el.marketsControls,
          prepare(host) {
            host.hidden = false;
            host.classList.remove("is-collapsed");
          },
          cleanup(host) {
            host.hidden = true;
            host.classList.add("is-collapsed");
          },
        });
        el.marketsSlidersToggle.classList.add("on");
        el.marketsSlidersToggle.setAttribute("aria-expanded", "true");
        el.marketsSlidersToggle.title = "Hide color threshold sliders";
        el.marketsSlidersToggle.setAttribute("aria-label", "Hide color threshold sliders");
        requestAnimationFrame(() => {
          updateMarketsHeatGoalsSlider();
          updateMarketsHeatCsSlider();
          syncMarketsCompareSeg();
          syncMarketsViewSeg();
        });
      } else if (mobileSheetKey === "markets-filters") {
        closeMobileSheet();
      } else {
        el.marketsControls.hidden = true;
        el.marketsControls.classList.add("is-collapsed");
        el.marketsSlidersToggle.classList.remove("on");
        el.marketsSlidersToggle.setAttribute("aria-expanded", "false");
        el.marketsSlidersToggle.title = "Show color threshold sliders";
        el.marketsSlidersToggle.setAttribute("aria-label", "Show color threshold sliders");
      }
      return;
    }
    el.marketsControls.hidden = !open;
    el.marketsControls.classList.toggle("is-collapsed", !open);
    el.marketsSlidersToggle.classList.toggle("on", open);
    el.marketsSlidersToggle.setAttribute("aria-expanded", open ? "true" : "false");
    el.marketsSlidersToggle.title = open ? "Hide color threshold sliders" : "Show color threshold sliders";
    el.marketsSlidersToggle.setAttribute(
      "aria-label",
      open ? "Hide color threshold sliders" : "Show color threshold sliders"
    );
    if (open) {
      requestAnimationFrame(() => {
        updateMarketsHeatGoalsSlider();
        updateMarketsHeatCsSlider();
        syncMarketsCompareSeg();
        syncMarketsViewSeg();
      });
    }
  }

  if (el.marketsSlidersToggle) {
    el.marketsSlidersToggle.addEventListener("click", () => {
      if (!hasFineHover()) {
        setMarketsSlidersOpen(!(mobileSheetOpen && mobileSheetKey === "markets-filters"));
        return;
      }
      setMarketsSlidersOpen(el.marketsControls.hidden);
    });
  }

  function setScheduleSlidersOpen(open) {
    if (!el.scheduleControls || !el.scheduleSlidersToggle) return;
    if (!hasFineHover()) {
      if (open) {
        openMobileSheetHost({
          title: "Matchup filters",
          key: "schedule-filters",
          hostEl: el.scheduleControls,
          prepare(host) {
            host.hidden = false;
            host.classList.remove("is-collapsed");
          },
          cleanup(host) {
            host.hidden = true;
            host.classList.add("is-collapsed");
          },
        });
        el.scheduleSlidersToggle.classList.add("on");
        el.scheduleSlidersToggle.setAttribute("aria-expanded", "true");
        el.scheduleSlidersToggle.title = "Hide matchup sliders";
        el.scheduleSlidersToggle.setAttribute("aria-label", "Hide matchup sliders");
        requestAnimationFrame(() => {
          updateScheduleGwSlider();
          updateScheduleEnhancePctSlider();
          updateScheduleExpectedWeightSlider();
          updateScheduleEdgeMinSlider();
        });
      } else if (mobileSheetKey === "schedule-filters") {
        closeMobileSheet();
      } else {
        el.scheduleControls.hidden = true;
        el.scheduleControls.classList.add("is-collapsed");
        el.scheduleSlidersToggle.classList.remove("on");
        el.scheduleSlidersToggle.setAttribute("aria-expanded", "false");
        el.scheduleSlidersToggle.title = "Show matchup sliders";
        el.scheduleSlidersToggle.setAttribute("aria-label", "Show matchup sliders");
      }
      return;
    }
    el.scheduleControls.hidden = !open;
    el.scheduleControls.classList.toggle("is-collapsed", !open);
    el.scheduleSlidersToggle.classList.toggle("on", open);
    el.scheduleSlidersToggle.setAttribute("aria-expanded", open ? "true" : "false");
    el.scheduleSlidersToggle.title = open ? "Hide matchup sliders" : "Show matchup sliders";
    el.scheduleSlidersToggle.setAttribute("aria-label", open ? "Hide matchup sliders" : "Show matchup sliders");
    if (open) {
      // Fills were measured while collapsed — refresh now that layout is visible.
      requestAnimationFrame(() => {
        updateScheduleGwSlider();
        updateScheduleEnhancePctSlider();
        updateScheduleExpectedWeightSlider();
        updateScheduleEdgeMinSlider();
      });
    }
  }

  if (el.scheduleSlidersToggle) {
    el.scheduleSlidersToggle.addEventListener("click", () => {
      if (!hasFineHover()) {
        setScheduleSlidersOpen(!(mobileSheetOpen && mobileSheetKey === "schedule-filters"));
        return;
      }
      setScheduleSlidersOpen(el.scheduleControls.hidden);
    });
  }

  syncScheduleMatchupControls();

  function onResetFiltersClick(event) {
    event.preventDefault();
    event.stopPropagation();
    resetFiltersToDefault();
  }
  if (el.resetFilters) el.resetFilters.addEventListener("click", onResetFiltersClick);
  if (el.mobileSheetReset) el.mobileSheetReset.addEventListener("click", onResetFiltersClick);

  if (el.setpieceTakersCheck) {
    el.setpieceTakersCheck.addEventListener("change", () => {
      state.setPieceTakersOnly = !!el.setpieceTakersCheck.checked;
      syncFiltersResetUI();
      if (state.page === "team") renderTeam();
      else if (state.page === "ownership") renderOwnership();
      else renderTable();
    });
  }

  if (el.teamAffordableCheck) {
    el.teamAffordableCheck.addEventListener("change", () => {
      state.teamAffordableOnly = !!el.teamAffordableCheck.checked;
      syncFiltersResetUI();
      renderTable();
    });
  }

  // Total / Per 90 / Per £m are mutually exclusive — the segmented control
  // always leaves exactly one option selected.
  function setValueMode(mode, { rerender = true } = {}) {
    state.valueMode = mode;
    $$("#value-mode-seg button").forEach((b) =>
      b.classList.toggle("active", b.dataset.valueMode === mode)
    );
    syncSegThumb(el.valueModeSeg);
    if (state.page === "opta" && state.view === "players") {
      applyStatisticsCoreFilterDefaults(mode);
      syncFiltersResetUI();
    }
    if (rerender) renderTable();
  }

  el.valueModeSeg.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-value-mode]");
    if (!btn || btn.dataset.valueMode === state.valueMode) return;
    setValueMode(btn.dataset.valueMode);
  });

  // ---------------------------------------------------------------------
  // Season switch (2025/26 OPTA vs zero-stat 2026/27 FPL squad preview)
  // ---------------------------------------------------------------------
  function applySeasonBounds() {
    const next = computeBounds(state.season);
    bounds.price.min = next.price.min;
    bounds.price.max = next.price.max;
    bounds.mins.min = next.mins.min;
    bounds.mins.max = next.mins.max;
    applyStatisticsCoreFilterDefaults(state.valueMode);
  }

  function syncSeasonSeg() {
    if (!el.seasonSeg) return;
    Array.from(el.seasonSeg.querySelectorAll("button[data-season]")).forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.season === state.season);
    });
    if (typeof syncSegThumb === "function") syncSegThumb(el.seasonSeg, { animate: false });
  }

  function syncSeasonChrome() {
    const next = isNextSeason();
    if (el.seasonSelect && el.seasonSelect.value !== state.season) {
      el.seasonSelect.value = state.season;
    }
    syncSeasonSeg();
    if (el.newpriceWrap) el.newpriceWrap.style.display = "none";
  }

  function setSeason(season, { rerender = true } = {}) {
    if (season !== "2025-26" && season !== "2026-27") return;
    if (state.season === season) return;
    state.season = season;
    teamPriorByCodeCache = null;
    teamPriorByCodeSeason = null;
    teamPosRankCache = null;
    teamPosRankSeason = null;
    // Drop team filters that don't exist in the destination season's chip set.
    const allowed = new Set(teamCodesForSeason());
    state.teamFilter.forEach((code) => {
      if (!allowed.has(code)) state.teamFilter.delete(code);
    });
    state.compareSelection.players.clear();
    state.compareSelection.teams.clear();
    state.rankingsPins.length = 0;
    // 2026/27 uses live FPL season totals — default sort by points.
    if (state.view === "players") {
      state.sortKey = "pts";
      state.sortDir = "desc";
    }
    hideToast();
    applySeasonBounds();
    if (state.page === "team") applyTeamPageBounds();
    buildTeamFilterChips();
    syncFilterChipUI();
    syncSeasonChrome();
    if (rerender) {
      renderTable();
      if (state.page === "expected") renderExpected();
      if (state.page === "rankings") renderRankings();
      if (state.page === "schedule") renderSchedule();
      if (state.page === "team") renderTeam();
    }
  }

  if (el.seasonSelect) {
    el.seasonSelect.addEventListener("change", () => {
      setSeason(el.seasonSelect.value);
    });
  }
  if (el.seasonSeg) {
    el.seasonSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-season]");
      if (!btn || !el.seasonSeg.contains(btn)) return;
      setSeason(btn.dataset.season);
      btn.blur();
    });
  }

  // ---------------------------------------------------------------------
  // 2026/27 price toggle + manual-review list for build-time price matches
  // (see match_new_season_prices() in site/build.py). Matching runs at
  // build time — players who need a human to disambiguate their 2026/27
  // price show up in DATA.priceMatchIssues rather than being guessed at.
  // ---------------------------------------------------------------------
  function syncShowNewPriceUI() {
    if (el.newpriceToggle) el.newpriceToggle.classList.toggle("on", updatesOverlayOn());
  }

  if (el.newpriceToggle) {
    el.newpriceToggle.addEventListener("click", () => {
      if (isNextSeason()) return;
      state.showNewPrice = !state.showNewPrice;
      syncShowNewPriceUI();
      showToast({
        title: state.showNewPrice ? "Enabled" : "Disabled",
        message: "new season price, Position, Teams",
        icon: "refresh-ccw-dot",
      });
      renderTable();
    });
  }

  syncShowNewPriceUI();
  syncSeasonChrome();

  function renderPriceIssuesPanel() {
    const issues = DATA.priceMatchIssues || [];
    if (!issues.length) {
      el.newpriceIssuesBadge.style.display = "none";
      return;
    }
    el.newpriceIssuesBadge.style.display = "";
    el.newpriceIssuesBadge.textContent = `⚠ ${issues.length}`;
    el.newpriceIssuesPanel.innerHTML = `
      <h4>Needs manual price match</h4>
      <p class="issues-note">These names matched more than one 2026/27 player and couldn't be narrowed down automatically. Add an entry to <code>site/price_overrides.json</code> (pid → FPL player <code>code</code>) and rebuild.</p>
      ${issues
        .map(
          (i) => `
        <div class="issue-row">
          <div class="issue-head">${escapeHtml(i.name)} <span class="issue-meta">${i.team} · ${i.position}</span></div>
          <div class="issue-cands">
            ${i.candidates
              .map(
                (c) =>
                  `<div class="issue-cand">${escapeHtml(c.firstName)} ${escapeHtml(c.secondName)} — ${c.team} ${c.position}, £${c.price.toFixed(1)}m <span class="issue-code">code ${c.code}</span></div>`
              )
              .join("") || escapeHtml(i.reason)}
          </div>
        </div>
      `
        )
        .join("")}
    `;
  }

  if (el.newpriceIssuesBadge) {
    el.newpriceIssuesBadge.addEventListener("click", () => {
      el.newpriceIssuesPanel.classList.toggle("open");
    });
  }
  document.addEventListener("click", (e) => {
    if (
      !el.newpriceIssuesPanel ||
      el.newpriceIssuesPanel.contains(e.target) ||
      (el.newpriceIssuesBadge && el.newpriceIssuesBadge.contains(e.target))
    ) {
      return;
    }
    el.newpriceIssuesPanel.classList.remove("open");
  });

  // Highlight Top/Bottom % is always on for Statistics; show the slider
  // whenever that page is active. Default bands use the full view; Relative
  // ranks against the filtered rows when a narrowing filter is active (on by
  // default; user can turn off until filters clear).
  function optaFiltersNarrowPopulation() {
    if (state.page !== "opta") return false;
    const all = getRows();
    if (!all.length) return false;
    // Departed players are always excluded — don't count that as a "filter".
    const baseline =
      state.view === "players" ? all.filter((r) => !excludeDepartedPlayer(r)) : all;
    const filtered = applyFilters(all);
    return filtered.length >= 2 && filtered.length < baseline.length;
  }

  function optaHighlightFilterKey(filteredCount) {
    return [
      state.view,
      state.split,
      state.valueMode,
      state.search.trim().toLowerCase(),
      [...state.posFilter].sort().join(","),
      [...state.teamFilter].sort().join(","),
      state.priceMin,
      state.priceMax,
      state.ownedMin,
      state.minsMin,
      state.minsMax,
      state.setPieceTakersOnly ? 1 : 0,
      state.enhancePct,
      state.enhanceRelative ? 1 : 0,
      filteredCount,
    ].join("|");
  }

  function syncEnhanceRelativeUI() {
    const btn = el.enhanceRelativeBtn;
    const show = state.page === "opta" && optaFiltersNarrowPopulation();
    if (!show) {
      state.enhanceRelative = false;
      enhanceRelativeUserOff = false;
    } else if (!enhanceRelativeUserOff) {
      state.enhanceRelative = true;
    }
    if (!btn) {
      syncHighlightUI();
      return;
    }
    // .ghost-btn sets display:inline-flex, which overrides the [hidden] UA rule —
    // set display explicitly (same pattern as Compare) so Relative never leaks
    // onto xData / Rankings / Team / etc.
    btn.hidden = !show;
    btn.style.display = show ? "" : "none";
    btn.classList.toggle("on", !!state.enhanceRelative);
    btn.setAttribute("aria-pressed", state.enhanceRelative ? "true" : "false");
    const tip = state.enhanceRelative
      ? "Highlights ranked against the filtered rows — click for full-table bands"
      : "Rank green/red highlights against the current filtered rows";
    setTip(btn, tip);
    syncHighlightUI();
  }

  function syncHighlightUI() {
    el.enhancePctGroup.style.display = state.page === "opta" ? "" : "none";
    if (el.enhancePctHint) {
      if (state.enhanceRelative) {
        const pct = effectiveEnhancePct();
        el.enhancePctHint.textContent = `of filtered ${state.view} (${pct}%)`;
      } else {
        el.enhancePctHint.textContent = `of all ${state.view}`;
      }
    }
  }

  el.compareToggle.addEventListener("click", () => {
    state.compareMode = !state.compareMode;
    el.compareToggle.classList.toggle("on", state.compareMode);
    if (state.compareMode) {
      const noun = state.view === "teams" ? "teams" : "players";
      showToast({
        title: "Compare mode",
        message: `Click up to ${MAX_COMPARE} ${noun} in the table to compare side by side.`,
        icon: "scale",
      });
    } else {
      hideToast();
    }
    renderTable({ preserveOptaScroll: true });
    syncTeamSearchHost();
  });

  if (el.enhanceRelativeBtn) {
    el.enhanceRelativeBtn.addEventListener("click", () => {
      if (!optaFiltersNarrowPopulation()) {
        state.enhanceRelative = false;
        enhanceRelativeUserOff = false;
        syncEnhanceRelativeUI();
        return;
      }
      state.enhanceRelative = !state.enhanceRelative;
      enhanceRelativeUserOff = !state.enhanceRelative;
      syncEnhanceRelativeUI();
      if (state.enhanceRelative) {
        showToast({
          title: "Relative highlights",
          message: "Green/red bands now rank within the filtered rows.",
          icon: "sparkles",
        });
      } else {
        hideToast();
      }
      renderTable({ preserveOptaScroll: true });
    });
  }
  el.compareClear.addEventListener("click", () => {
    compareSet().clear();
    renderTable({ preserveOptaScroll: true });
  });

  el.sidebarToggle.addEventListener("click", () => {
    if (!hasFineHover()) {
      if (mobileSheetOpen && mobileSheetKey === "filters") {
        closeMobileSheet();
        return;
      }
      openMobileSheetHost({
        title: "Filters",
        key: "filters",
        hostEl: el.sidebar,
        prepare(host) {
          host.classList.remove("collapsed");
        },
        cleanup(host) {
          host.classList.add("collapsed");
        },
      });
      el.sidebarToggle.classList.add("on");
      el.sidebarToggle.setAttribute("aria-pressed", "true");
      requestAnimationFrame(() => syncAllSegThumbs({ animate: false }));
      return;
    }
    const collapsed = el.sidebar.classList.toggle("collapsed");
    el.sidebarToggle.classList.toggle("on", !collapsed);
    el.sidebarToggle.setAttribute("aria-pressed", collapsed ? "false" : "true");
    if (!collapsed) {
      requestAnimationFrame(() => syncAllSegThumbs({ animate: false }));
    }
  });

  // ---------------------------------------------------------------------
  // Appearance (device → light → dark). Default is always device/system.
  // Accent chrome color (tabs, toggles, selection, icons) via --blue-hsl.
  // Data green/red (--positive / --negative) stay fixed and independent.
  // ---------------------------------------------------------------------
  const THEME_KEY = "fpl-explorer-theme";
  const ACCENT_KEY = "fpl-explorer-accent";
  const THEME_ORDER = ["system", "light", "dark"];
  const THEME_META = {
    system: { icon: "monitor", label: "Device" },
    light: { icon: "sun", label: "Light" },
    dark: { icon: "moon", label: "Dark" },
  };
  const ACCENT_OPTIONS = [
    { id: "blue", label: "Blue", light: "217 91% 60%", dark: "217 91% 60%", swatch: "217 91% 60%" },
    { id: "teal", label: "Teal", light: "173 80% 36%", dark: "172 66% 50%", swatch: "172 66% 45%" },
    { id: "emerald", label: "Emerald", light: "160 84% 39%", dark: "160 70% 45%", swatch: "160 72% 40%" },
    { id: "indigo", label: "Indigo", light: "239 84% 67%", dark: "239 84% 72%", swatch: "239 84% 67%" },
    { id: "violet", label: "Violet", light: "262 72% 50%", dark: "263 70% 65%", swatch: "262 72% 58%" },
    { id: "rose", label: "Rose", light: "346 77% 50%", dark: "347 77% 60%", swatch: "346 77% 55%" },
    { id: "amber", label: "Amber", light: "32 95% 44%", dark: "38 92% 50%", swatch: "32 95% 48%" },
  ];
  const ACCENT_BY_ID = Object.fromEntries(ACCENT_OPTIONS.map((a) => [a.id, a]));

  function currentThemeMode() {
    const stored = localStorage.getItem(THEME_KEY);
    return THEME_ORDER.includes(stored) ? stored : "system";
  }

  function currentAccentId() {
    const stored = localStorage.getItem(ACCENT_KEY);
    return ACCENT_BY_ID[stored] ? stored : "blue";
  }

  function themePrefersDark(mode = currentThemeMode()) {
    if (mode === "dark") return true;
    if (mode === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function syncThemeCycleButton(mode) {
    if (!el.themeCycleBtn) return;
    const meta = THEME_META[mode] || THEME_META.system;
    const label = `Theme: ${meta.label}`;
    setTip(el.themeCycleBtn, label);
    el.themeCycleBtn.setAttribute("aria-label", label);
    el.themeCycleBtn.setAttribute("title", label);
    el.themeCycleBtn.innerHTML = iconHTML(meta.icon);
  }

  function syncThemeSeg(mode) {
    if (!el.themeSeg) return;
    Array.from(el.themeSeg.querySelectorAll("button[data-theme-mode]")).forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themeMode === mode);
    });
    if (typeof syncSegThumb === "function") syncSegThumb(el.themeSeg, { animate: false });
  }

  function syncAccentSwatches(id) {
    if (!el.accentSwatches) return;
    Array.from(el.accentSwatches.querySelectorAll(".prefs-accent-swatch")).forEach((btn) => {
      const on = btn.dataset.accent === id;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    });
  }

  function applyAccent(id, { persist = true } = {}) {
    const accent = ACCENT_BY_ID[id] || ACCENT_BY_ID.blue;
    const hsl = themePrefersDark() ? accent.dark : accent.light;
    document.documentElement.style.setProperty("--blue-hsl", hsl);
    // Clear any earlier experiment that wrote data colours onto the root.
    document.documentElement.style.removeProperty("--positive");
    document.documentElement.style.removeProperty("--negative");
    document.documentElement.removeAttribute("data-accent");
    if (persist) {
      try {
        localStorage.setItem(ACCENT_KEY, accent.id);
      } catch {
        // ignore
      }
    }
    syncAccentSwatches(accent.id);
  }

  function applyTheme(mode) {
    const next = THEME_ORDER.includes(mode) ? mode : "system";
    if (next === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", next);
    }
    localStorage.setItem(THEME_KEY, next);
    syncThemeCycleButton(next);
    syncThemeSeg(next);
    applyAccent(currentAccentId(), { persist: false });
  }

  function buildAccentSwatches() {
    if (!el.accentSwatches) return;
    el.accentSwatches.innerHTML = ACCENT_OPTIONS.map(
      (a) =>
        `<button type="button" class="prefs-accent-swatch" role="radio"
          data-accent="${a.id}" title="${a.label}" aria-label="${a.label} accent"
          style="--swatch-hsl: ${a.swatch}"></button>`
    ).join("");
  }

  if (el.themeCycleBtn) {
    el.themeCycleBtn.addEventListener("click", () => {
      const current = currentThemeMode();
      const next = THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
      applyTheme(next);
    });
  }

  if (el.themeSeg) {
    el.themeSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-theme-mode]");
      if (!btn || !el.themeSeg.contains(btn)) return;
      applyTheme(btn.dataset.themeMode || "system");
      btn.blur();
    });
  }

  if (el.accentSwatches) {
    el.accentSwatches.addEventListener("click", (e) => {
      const btn = e.target.closest(".prefs-accent-swatch");
      if (!btn || !el.accentSwatches.contains(btn)) return;
      applyAccent(btn.dataset.accent || "blue");
    });
  }

  const systemThemeMq = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystemThemeChange = () => {
    if (currentThemeMode() === "system") applyAccent(currentAccentId(), { persist: false });
  };
  if (systemThemeMq.addEventListener) systemThemeMq.addEventListener("change", onSystemThemeChange);
  else if (systemThemeMq.addListener) systemThemeMq.addListener(onSystemThemeChange);

  buildAccentSwatches();
  applyTheme(currentThemeMode());
  applyAccent(currentAccentId());

  // Drop legacy UI-scale zoom so fixed chrome widths stay stable.
  try {
    localStorage.removeItem("fpl-explorer-ui-scale");
    localStorage.removeItem("fpl-explorer-font-pair");
    localStorage.removeItem("fpl-explorer-font-pair-v2");
    localStorage.removeItem("fpl-explorer-clock-format");
    localStorage.removeItem("fpl-explorer-fixture-tt-delay");
  } catch {
    /* private browsing */
  }
  document.documentElement.style.removeProperty("--ui-scale");

  syncPageInfoButton();

  function setPrefsOpen(open) {
    if (!el.prefsPanel || !el.prefsBtn) return;
    if (open) syncTeamPlannerPrefsBtns();
    if (!hasFineHover()) {
      if (open) {
        openMobileSheetHost({
          title: "Preferences",
          key: "prefs",
          hostEl: el.prefsPanel,
          prepare(host) {
            host.classList.add("open");
          },
          cleanup(host) {
            host.classList.remove("open");
          },
        });
        el.prefsBtn.setAttribute("aria-expanded", "true");
      } else if (mobileSheetKey === "prefs") {
        closeMobileSheet();
      } else {
        el.prefsPanel.classList.remove("open");
        el.prefsBtn.setAttribute("aria-expanded", "false");
      }
      return;
    }
    el.prefsPanel.classList.toggle("open", open);
    el.prefsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      requestAnimationFrame(() => syncThemeSeg(currentThemeMode()));
    }
  }

  function syncColumnsPanelHost() {
    if (!el.columnsList) return;
    if (el.sidebarColumnsHost) el.sidebarColumnsHost.hidden = true;
    if (el.columnsBtn) {
      el.columnsBtn.style.display = "none";
      el.columnsBtn.setAttribute("aria-expanded", "false");
      el.columnsBtn.classList.remove("on");
    }
    if (el.columnsSidebar) {
      el.columnsSidebar.style.display = "none";
      el.columnsSidebar.classList.add("collapsed");
    }
    if (mobileSheetOpen && mobileSheetKey === "columns") closeMobileSheet();
  }

  function setColumnsOpen(open) {
    if (!el.columnsSidebar || !el.columnsBtn) return;
    // Narrow / sheet: columns live inside Filters — no separate panel.
    if (columnsLiveInFilters()) {
      el.columnsSidebar.classList.add("collapsed");
      el.columnsBtn.setAttribute("aria-expanded", "false");
      el.columnsBtn.classList.remove("on");
      if (mobileSheetOpen && mobileSheetKey === "columns") closeMobileSheet();
      return;
    }
    el.columnsSidebar.classList.toggle("collapsed", !open);
    el.columnsBtn.setAttribute("aria-expanded", open ? "true" : "false");
    el.columnsBtn.classList.toggle("on", open);
  }

  if (el.columnsBtn) {
    el.columnsBtn.addEventListener("click", () => {
      if (columnsLiveInFilters()) return;
      setPrefsOpen(false);
      setColumnsOpen(el.columnsSidebar.classList.contains("collapsed"));
    });
  }

  function bindMqChange(mq, fn) {
    if (!mq) return;
    if (typeof mq.addEventListener === "function") mq.addEventListener("change", fn);
    else if (typeof mq.addListener === "function") mq.addListener(fn);
  }
  bindMqChange(FINE_HOVER_MQ, () => {
    syncPointerMode();
    syncColumnsPanelHost();
    refreshNameSimplifyOrigins();
    syncExpectedCatToolbar();
    syncMarketsViewControls();
    syncMobileChrome();
  });
  bindMqChange(NARROW_MQ, () => {
    syncColumnsPanelHost();
    refreshNameSimplifyOrigins();
    resetMobileChromeScrollHide();
    syncExpectedCatToolbar();
    syncMarketsViewControls();
    syncMobileChrome();
    syncTeamPickerCancelHost();
    setPageTrayOpen(false);
    syncPageTrayTrigger();
    syncPageTabWheel();
    if (state.page === "team") renderTeam();
    if (state.page === "opta") {
      syncCoreUnderName();
      scheduleOptaMobileNameColWidth();
      requestAnimationFrame(() => {
        snapOptaToGameStats();
        requestAnimationFrame(() => {
          snapOptaToGameStats();
          refreshNameSimplifyOrigins();
        });
      });
    }
  });
  bindMqChange(COLUMNS_IN_FILTERS_MQ, syncColumnsPanelHost);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleTeamLandscapeSync);
    window.visualViewport.addEventListener("scroll", scheduleTeamLandscapeSync);
  }
  window.addEventListener("resize", scheduleTeamLandscapeSync);
  window.addEventListener("orientationchange", scheduleTeamLandscapeSync);
  syncColumnsPanelHost();

  if (el.prefsBtn && el.prefsPanel) {
    el.prefsBtn.addEventListener("click", () => {
      const open = hasFineHover()
        ? !el.prefsPanel.classList.contains("open")
        : !(mobileSheetOpen && mobileSheetKey === "prefs");
      setColumnsOpen(false);
      setPrefsOpen(open);
    });
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest("#mobile-sheet")) return;
    if (
      el.prefsPanel &&
      !el.prefsPanel.contains(e.target) &&
      el.prefsBtn &&
      !el.prefsBtn.contains(e.target)
    ) {
      setPrefsOpen(false);
    }
  });

  if (el.fplManagerSelect) {
    el.fplManagerSelect.addEventListener("change", () => {
      applyManagerId(el.fplManagerSelect.value);
    });
  }
  if (el.fplIdClear) {
    el.fplIdClear.addEventListener("click", () => clearManagerId());
  }
  if (el.teamModeSeg) {
    el.teamModeSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-team-mode]");
      if (!btn) return;
      disarmConfirmButton();
      setTeamMode(btn.getAttribute("data-team-mode"));
    });
  }
  function bindTeamPlannerAction(btn, action) {
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (action === "resync") requestResyncPlanner(btn);
      else if (action === "clear") requestClearTeamSquad(btn);
    });
  }
  bindTeamPlannerAction(el.teamResyncBtn, "resync");
  bindTeamPlannerAction(el.teamClearBtn, "clear");
  bindTeamPlannerAction(el.teamResyncToolbar, "resync");
  bindTeamPlannerAction(el.teamClearToolbar, "clear");

  // ---------------------------------------------------------------------
  // Sliding selection thumb for .tabs / .segmented button groups
  // ---------------------------------------------------------------------
  function ensureSegThumb(container) {
    let thumb = container.querySelector(":scope > .seg-thumb");
    if (!thumb) {
      thumb = document.createElement("span");
      thumb.className = "seg-thumb";
      thumb.setAttribute("aria-hidden", "true");
      container.insertBefore(thumb, container.firstChild);
    }
    return thumb;
  }

  function syncSegThumb(container, { animate = true } = {}) {
    if (!container) return;
    const thumb = ensureSegThumb(container);
    const active = container.querySelector(":scope > .tab-btn.active, :scope > button.active");
    if (!active || !active.offsetWidth) {
      thumb.classList.remove("is-ready");
      const visible = !!(container.offsetWidth && container.offsetParent);
      if (!visible || container._thumbRetry) return;
      container._thumbRetry = requestAnimationFrame(() => {
        container._thumbRetry = 0;
        syncSegThumb(container, { animate: false });
      });
      return;
    }
    if (container._thumbRetry) {
      cancelAnimationFrame(container._thumbRetry);
      container._thumbRetry = 0;
    }

    // Use offset* (layout CSS px) — getBoundingClientRect drifts under html zoom.
    const x = active.offsetLeft;
    const y = active.offsetTop;
    const w = active.offsetWidth;
    const h = active.offsetHeight;

    if (!animate || !thumb.classList.contains("is-ready")) {
      thumb.classList.add("no-motion");
    }
    thumb.style.width = `${w}px`;
    thumb.style.height = `${h}px`;
    thumb.style.transform = `translate(${x}px, ${y}px)`;
    thumb.classList.add("is-ready");
    if (thumb.classList.contains("no-motion")) {
      // Force layout so removing no-motion doesn't animate from 0.
      void thumb.offsetWidth;
      thumb.classList.remove("no-motion");
    }
  }

  function syncAllSegThumbs(opts) {
    $$(".tabs, .segmented").forEach((elSeg) => syncSegThumb(elSeg, opts));
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------
  async function init() {
    buildStaticFilters();
    upgradeNativeTitles();
    renderPriceIssuesPanel();
    // Filters start closed on every page and viewport; the toolbar button opens them.
    el.sidebar.classList.add("collapsed");
    el.sidebarToggle.classList.remove("on");
    el.sidebarToggle.setAttribute("aria-pressed", "false");
    // Paint Statistics immediately. Manager sync is networked and used to
    // block this, so first open showed an empty header bar until Players was tapped.
    setView("players");
    buildExpectedCatMenu();
    setPage(storedPage());
    // Position sliding thumbs after layout (sidebar/page visibility settled).
    // Rebuild the landing table after the first layout: WebKit often leaves a
    // sticky-header-only paint until tbody is recreated while the wrap is sized.
    requestAnimationFrame(() => {
      syncAllSegThumbs({ animate: false });
      syncPageTabsScrollHints();
      scrollActivePageTabIntoView({ instant: true });
      if (state.page === "opta") renderTable();
      requestAnimationFrame(() => {
        syncAllSegThumbs({ animate: false });
        syncPageTabsScrollHints();
        scrollActivePageTabIntoView({ instant: true });
        if (state.page === "opta") renderTable();
      });
    });
    window.addEventListener("load", () => {
      syncAllSegThumbs({ animate: false });
      scrollActivePageTabIntoView({ instant: true });
      if (state.page === "opta") renderTable();
      requestAnimationFrame(() => {
        pageTabWheelBooted = true;
      });
    }, { once: true });
    window.addEventListener("pageshow", () => {
      if (el.optaPage) el.optaPage.classList.remove("is-entering", "is-enter-pending", "is-hl-entering");
      syncAllSegThumbs({ animate: false });
      scrollActivePageTabIntoView({ instant: true });
    });
    [50, 250].forEach((ms) => {
      window.setTimeout(() => syncAllSegThumbs({ animate: false }), ms);
    });
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => syncAllSegThumbs({ animate: false }));
      $$(".tabs, .segmented").forEach((elSeg) => ro.observe(elSeg));
      if (el.barbellHead) {
        const headRo = new ResizeObserver(() => syncBarbellHeadHeight());
        headRo.observe(el.barbellHead);
      }
    }
    window.addEventListener("resize", () => {
      syncAllSegThumbs({ animate: false });
      syncTeamSearchHost();
      syncTeamCompareHost();
      syncPageTabsScrollHints();
      syncPageNavLabelCenter();
      refreshNameSimplifyOrigins();
      syncMobileScrollportHeight();
      scheduleOptaMobileNameColWidth();
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => {
        syncMobileScrollportHeight();
        scheduleOptaMobileNameColWidth();
      });
      window.visualViewport.addEventListener("scroll", syncMobileScrollportHeight);
    }
    if (typeof NARROW_MQ.addEventListener === "function") {
      NARROW_MQ.addEventListener("change", () => {
        syncMobileLayoutClass();
        syncTeamSearchHost();
        syncTeamCompareHost();
        syncTeamPickerCancelHost();
        syncPageNavLabelCenter();
        syncCoreUnderName();
        syncTeamPickerCoreUnder();
        bindAllNameColumnSimplifies();
        refreshNameSimplifyOrigins();
        refreshCompareScrollMirrorMode();
        bindMobileChromeScrollHide();
        syncMobileScrollportHeight();
        scheduleOptaMobileNameColWidth();
        scheduleTeamTableHeadHeightSync();
        disarmConfirmButton();
        syncTeamPlannerPrefsBtns();
      });
    } else if (typeof NARROW_MQ.addListener === "function") {
      NARROW_MQ.addListener(() => {
        syncMobileLayoutClass();
        syncTeamSearchHost();
        syncTeamCompareHost();
        syncTeamPickerCancelHost();
        syncPageNavLabelCenter();
        syncCoreUnderName();
        syncTeamPickerCoreUnder();
        bindAllNameColumnSimplifies();
        refreshNameSimplifyOrigins();
        refreshCompareScrollMirrorMode();
        bindMobileChromeScrollHide();
        syncMobileScrollportHeight();
        scheduleOptaMobileNameColWidth();
        scheduleTeamTableHeadHeightSync();
        disarmConfirmButton();
        syncTeamPlannerPrefsBtns();
      });
    }
    bindAllNameColumnSimplifies();
    bindNestedTableScroll();
    bindMobileChromeScrollHide();
    try {
      await restoreManagerId();
    } catch {
      syncFplIdStatus();
    }
    renderTable();
  }

  init();
})();
