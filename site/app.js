/* FPL Data Explorer — client-side filter/sort/group/aggregate over the
   embedded season data in data.js. No build step needed to browse; run
   build.py again if the source CSVs change. */

(function () {
  "use strict";

  const DATA = window.FPL_DATA;
  const SOCIAL = window.FPL_SOCIAL || { generatedAt: null, accounts: [], posts: [] };
  const MARKETS = window.FPL_MARKETS || { generatedAt: null, meta: {}, fixtures: [] };
  const OWNERSHIP = window.FPL_OWNERSHIP || { generatedAt: null, checkIns: [] };
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
  const FIXTURE_TT_DELAY_KEY = "fpl-explorer-fixture-tt-delay";
  const CLOCK_FORMAT_KEY = "fpl-explorer-clock-format";
  const FIXTURE_TT_DELAY_SEC_MIN = 0.5;
  const FIXTURE_TT_DELAY_SEC_MAX = 5;
  const FIXTURE_TT_DELAY_SEC_DEFAULT = 1;
  const FIXTURE_TT_COUNT = 7;
  const OWNERSHIP_FILTER_DEFAULT = 5;
  const OWNERSHIP_FILTER_MAX = 100;
  const OWNERSHIP_TREND_THRESHOLD_DEFAULT = 0.5;
  const OWNERSHIP_TREND_THRESHOLD_MAX = 5;
  // Statistics-page fixture tooltip shading — wider than the players Enhance
  // default (10%) so tough/soft opponents read clearly in fixture tips.
  const FIXTURE_TT_ENHANCE_PCT = 30;
  const FIXTURE_GAMEWEEKS = Object.values(FIXTURES_BY_TEAM)
    .flat()
    .map((fixture) => Number(fixture.gw))
    .filter(Number.isFinite);
  const SCHEDULE_GW_MIN = FIXTURE_GAMEWEEKS.length ? Math.min(...FIXTURE_GAMEWEEKS) : 1;
  const SCHEDULE_GW_MAX = FIXTURE_GAMEWEEKS.length ? Math.max(...FIXTURE_GAMEWEEKS) : 38;
  // Whether build.py's 2026/27 price match ran at all — gates the "Include
  // departed players" filter, since without it price2627 is undefined for
  // everyone and there'd be nothing to distinguish "departed" from "just
  // not matched yet".
  const HAS_PRICE_DATA = !!(DATA.newSeasonPriceMeta && DATA.newSeasonPriceMeta.source);

  // Tall shield SVGs (Hull, Arsenal, Villa, …) fill the full crest-box height
  // while roundels leave side slack, so they read larger at the same CSS size.
  // Fit % is precomputed from each file's viewBox aspect (rsvg raster check);
  // square/circular art stays at 100. Regenerate: compare max/min viewBox sides,
  // pct = clamp(74, 100, round(100 * 1.05 / ratio)) when ratio > 1.08.
  const CREST_FIT_PCT = {
    "badges/ARS.svg": 87,
    "badges/AVL.svg": 78,
    "badges/BOU.svg": 80,
    "badges/COV.svg": 81,
    "badges/FUL.svg": 79,
    "badges/HUL.svg": 83,
    "badges/IPS.svg": 84,
    "badges/LEE.svg": 87,
    // Spurs stays at 100: the cockerel is a narrow figure, not a wide shield, so
    // full box height reads the same weight as Liverpool's liver bird.
  };

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

  // Shared intensity ramp for Enhance (green/red) and Team FDR (blue/pink).
  // Intensity 1 = strongest in the band. Low intensities must be able to
  // reach ~0 so the tail melts into the row; leaders still punch.
  // Light-mode easy stays a wash (dark text). Dark mode / hard ends still
  // solidify toward black for white text.
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

  function applyEnhanceHighlight(td, kind, intensity) {
    const paint = enhanceHighlightPaint(kind, intensity);
    if (paint.skip) return;
    if (paint.emphasize || paint.strong) {
      td.classList.add(kind === "top" ? "highlight-top" : "highlight-bottom");
    }
    td.classList.toggle("highlight-strong", paint.strong);
    td.style.backgroundColor = paint.backgroundColor;
    if (paint.color) td.style.color = paint.color;
    else td.style.removeProperty("color");
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

  // ---------------------------------------------------------------------
  // Column definitions
  // ---------------------------------------------------------------------
  const PLAYER_COLS = [
    { key: "player", label: "Player", type: "player", pin: true },
    { key: "price", label: "£m", decimals: 1, group: "Core", title: "Price (£m)" },
    { key: "owned", label: "Own%", decimals: 1, group: "Core", title: "Current FPL ownership" },
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
    { key: "cleanSheets", label: "CS", decimals: 0, group: "Defence", section: "Defensive", rate: true, title: "Clean sheets" },
    { key: "xgd", label: "xGD", decimals: 1, group: "Overall", section: "Overall", rate: true, title: "Expected goal difference (xG − xGC)" },
    { key: "gd", label: "GD", decimals: 0, group: "Overall", section: "Overall", title: "Goal difference (goals − conceded)" },
    { key: "pts", label: "Pts", decimals: 0, group: "Points", section: "FPL", rate: true, title: "Total FPL points scored by the squad", strong: true },
    { key: "__ppg", label: "Pts/GP", decimals: 1, group: "Derived", section: "Derived", derived: true, title: "Points per gameweek played" },
    { key: "__gpg", label: "G/GP", decimals: 1, group: "Derived", section: "Derived", derived: true, title: "Goals per gameweek played" },
  ];

  // Concise display titles shared by Rankings cards and the Columns settings
  // panel. Keep OPTA table header tooltips on col.title — these overrides only
  // change the friendlier labels shown in those surfaces.
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
  const ENHANCE_EXCLUDE = new Set(["price", "owned", "apps", "gp"]);
  const ENHANCE_PCT_MIN = 2;
  const ENHANCE_PCT_MAX = 40;
  const ENHANCE_PCT_PLAYERS = 5;
  const ENHANCE_PCT_TEAMS = 30;
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

  // Zero-stat 2026/27 view: full FPL bootstrap squad (promoted clubs included;
  // relegated clubs absent). Built lazily once from DATA.nextSeasonPlayers.
  const PLAYER_ZERO_KEYS = [
    "apps", "mins", "shots", "shotsOnTarget", "touchesBox", "bigChances",
    "xg", "goals", "keyPasses", "bigChancesCreated", "xa", "assists",
    "xPts", "bps", "bonus", "defCon", "pts",
    "cleanSheets", "goalsConceded", "xgc", "saves", "xgi", "cbit", "cbitr",
  ];
  const TEAM_ZERO_KEYS = [
    "gp", "shots", "shotsOnTarget", "touchesBox", "bigChances", "xg",
    "goals", "xgc", "xcs", "goalsConceded", "cleanSheets", "xgd", "gd", "pts",
  ];
  let season2627Cache = null;

  function teamNameForSeason(code) {
    if (state.page === "team" || isNextSeason()) {
      return NEXT_SEASON_TEAM_NAMES[code] || TEAM_NAMES[code] || code;
    }
    return TEAM_NAMES[code] || code;
  }

  function buildSeason2627Data() {
    const roster = DATA.nextSeasonPlayers || [];
    const players = { home: [], away: [], combined: [] };
    roster.forEach((src) => {
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
      PLAYER_ZERO_KEYS.forEach((k) => {
        row[k] = 0;
      });
      deriveExtra(row, false);
      // No H/A splits yet — same zero row for every fixture-location view.
      ["home", "away", "combined"].forEach((split) => {
        players[split].push({ ...row });
      });
    });

    const teamCodes = NEXT_SEASON_TEAM_CODES.length ? NEXT_SEASON_TEAM_CODES : ALL_TEAM_CODES;
    const teams = { home: [], away: [], combined: [] };
    teamCodes.forEach((code) => {
      const base = {
        team: code,
        name: NEXT_SEASON_TEAM_NAMES[code] || TEAM_NAMES[code] || code,
      };
      TEAM_ZERO_KEYS.forEach((k) => {
        base[k] = 0;
      });
      deriveExtra(base, true);
      ["home", "away", "combined"].forEach((split) => {
        teams[split].push({ ...base });
      });
    });
    return { players, teams };
  }

  function season2627Data() {
    if (!season2627Cache) season2627Cache = buildSeason2627Data();
    return season2627Cache;
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  const state = {
    page: "opta", // opta | rankings | ownership | expected | schedule | feed | markets | team | notes
    season: "2025-26", // 2025-26 | 2026-27
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
    showNewPrice: false,
    hideDeparted: true,
    setPieceTakersOnly: false,
    // Always-on top/bottom % cell tint vs the full Players/Teams view
    // (raw values stay in the cells; filters don't shrink the bands).
    enhancePct: ENHANCE_PCT_PLAYERS,
    scheduleEnhanceTopN: SCHEDULE_ENHANCE_TOP_DEFAULT,
    compareMode: false,
    compareSelection: { players: new Set(), teams: new Set() },
    sortKey: "pts",
    sortDir: "desc",
    hiddenCols: new Set(),
    rankingsPins: [],
    expectedCat: "goals", // goals | assists | gi | conceded | cs
    expectedSortKey: "actual", // diff | expected | actual | name
    expectedSortDir: "desc",
    expectedSplit: "combined", // combined | home | away | compare
    scheduleGwMin: SCHEDULE_GW_MIN,
    scheduleGwMax: Math.min(SCHEDULE_GW_MIN + FIXTURE_TT_COUNT - 1, SCHEDULE_GW_MAX),
    scheduleMatchups: true,
    scheduleExpectedWeight: SCHEDULE_EXPECTED_WEIGHT_DEFAULT,
    scheduleEdgeMin: SCHEDULE_EDGE_DEFAULT,
    feedRange: "today", // today | 3d | 7d
    feedTypeFilter: new Set(), // empty = all post types
    feedTeamFilter: new Set(), // empty = all teams
    feedSelectedCode: null, // treemap selection — filter cards to one player
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
    teamMode: "planner", // planner | actual
    ownershipTrending: false,
    ownershipTrendThreshold: OWNERSHIP_TREND_THRESHOLD_DEFAULT,
    actualMeta: null, // { syncedAt, gw, gwLabel, teamName, managerName, hasPicks, message }
    notes: [],
    notesGroupBy: "none", // none | player | team
  };
  state.teamSearchPins = state.teamCompareCodes;

  const MAX_COMPARE = 5;

  function compareSet() {
    return state.compareSelection[state.view];
  }

  function isNextSeason() {
    return state.season === "2026-27";
  }

  // Updates chrome (arrows / ±) only on 2025/26 data.
  function updatesOverlayOn() {
    return !isNextSeason() && state.showNewPrice;
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
    const price = players.map((p) => p.price);
    const mins = players.map((p) => p.mins);
    return {
      price: { min: Math.min(...price), max: Math.max(...price) },
      mins: { min: 0, max: Math.max(...mins) },
    };
  }

  // Mutable range used by the price/mins dual sliders (updated on season switch).
  const bounds = computeBounds("2025-26");
  function defaultMinPrice() {
    // Player select shows the full catalog; elsewhere keep the £4.5m+ default.
    if (state.page === "team" && state.teamPickerSlot) return bounds.price.min;
    return Math.min(Math.max(4.5, bounds.price.min), bounds.price.max);
  }
  function defaultMinMinutes() {
    return isNextSeason() ? 0 : Math.min(1000, bounds.mins.max);
  }
  state.priceMin = defaultMinPrice();
  state.priceMax = bounds.price.max;
  state.minsMin = defaultMinMinutes();
  state.minsMax = bounds.mins.max;

  function cols() {
    return state.view === "players" ? PLAYER_COLS : TEAM_COLS;
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
    const owned = currentOwnership(row && row.code);
    return owned != null && owned >= state.ownedMin;
  }

  // ---------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const el = {
    pageOpta: $("#page-opta"),
    pageRankings: $("#page-rankings"),
    pageOwnership: $("#page-ownership"),
    pageTeam: $("#page-team"),
    pageNotes: $("#page-notes"),
    pageExpected: $("#page-expected"),
    pageTabs: $("#page-tabs"),
    pageTabsClip: $("#page-tabs-clip"),
    pageNav: document.querySelector(".page-nav"),
    pageTrayBtn: $("#page-tray-btn"),
    pageTrayLabel: $("#page-tray-label"),
    pageTrayIconUse: $("#page-tray-icon-use"),
    expectedTabWrap: $("#expected-tab-wrap"),
    expectedCatMenu: $("#expected-cat-menu"),
    expectedCatToolbar: $("#expected-cat-toolbar"),
    expectedCatBtn: $("#expected-cat-btn"),
    expectedCatLabel: $("#expected-cat-label"),
    pageSchedule: $("#page-schedule"),
    pageFeed: $("#page-feed"),
    pageMarkets: $("#page-markets"),
    marketsTabWrap: $("#markets-tab-wrap"),
    marketsViewMenu: $("#markets-view-menu"),
    marketsViewToolbar: $("#markets-view-toolbar"),
    marketsViewToolbarBtn: $("#markets-view-toolbar-btn"),
    marketsViewToolbarLabel: $("#markets-view-toolbar-label"),
    subtoolbar: $("#subtoolbar"),
    statsToolbarStart: $("#stats-toolbar-start"),
    statsToolbarActions: $("#stats-toolbar-actions"),
    feedToolbarStart: $("#feed-toolbar-start"),
    feedToolbarEnd: $("#feed-toolbar-end"),
    optaPage: $("#opta-page"),
    rankingsPage: $("#rankings-page"),
    rankingsPinBar: $("#rankings-pin-bar"),
    rankingsGrid: $("#rankings-grid"),
    rankingsCountLabel: $("#rankings-count-label"),
    ownershipPage: $("#ownership-page"),
    ownershipChart: $("#ownership-chart"),
    ownershipChartWrap: $("#ownership-chart-wrap"),
    ownershipTooltip: $("#ownership-tooltip"),
    ownershipCountLabel: $("#ownership-count-label"),
    ownershipTrendingGroup: $("#ownership-trending-group"),
    ownershipTrendingToggle: $("#ownership-trending-toggle"),
    ownershipTrendThreshold: $("#ownership-trend-threshold"),
    ownershipTrendThresholdFill: $("#ownership-trend-threshold-fill"),
    ownershipTrendThresholdLabel: $("#ownership-trend-threshold-label"),
    ownershipTrendCards: $("#ownership-trend-cards"),
    ownershipTrendRisers: $("#ownership-trend-risers"),
    ownershipTrendFallers: $("#ownership-trend-fallers"),
    teamPage: $("#team-page"),
    teamPageSubtitle: $("#team-page-subtitle"),
    teamModeSeg: $("#team-mode-seg"),
    teamResyncBtn: $("#team-resync-btn"),
    teamRowMenu: $("#team-row-menu"),
    notesPage: $("#notes-page"),
    notesCollage: $("#notes-collage"),
    notesCountLabel: $("#notes-count-label"),
    notesGroupSeg: $("#notes-group-seg"),
    noteContextMenu: $("#note-context-menu"),
    noteModal: $("#note-modal"),
    noteModalTitle: $("#note-modal-title"),
    noteModalSub: $("#note-modal-sub"),
    noteTextInput: $("#note-text-input"),
    noteModalSave: $("#note-modal-save"),
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
    teamClearBtn: $("#team-clear-btn"),
    teamAffordableGroup: $("#team-affordable-group"),
    teamAffordableCheck: $("#team-affordable-check"),
    teamCompareBtn: $("#team-compare-btn"),
    teamCompareWrap: $("#team-compare-wrap"),
    teamCompareTitle: $("#team-compare-title"),
    teamCompareClear: $("#team-compare-clear"),
    teamCompareHead: $("#team-compare-head"),
    teamCompareBody: $("#team-compare-body"),
    teamToolbarControls: $("#team-toolbar-controls"),
    teamToolbarMode: $("#team-toolbar-mode"),
    searchHome: $(".topbar-end-cluster"),
    expectedPage: $("#expected-page"),
    schedulePage: $("#schedule-page"),
    scheduleGrid: $("#schedule-grid"),
    feedPage: $("#feed-page"),
    feedList: $("#feed-list"),
    feedTrending: $("#feed-trending"),
    feedTreemap: $("#feed-treemap"),
    feedFiltersToggle: $("#feed-filters-toggle"),
    feedControls: $("#feed-controls"),
    feedRangeSeg: $("#feed-range-seg"),
    feedTypeFilters: $("#feed-type-filters"),
    feedTeamFilters: $("#feed-team-filters"),
    feedResetTypes: $("#feed-reset-types"),
    feedResetTeams: $("#feed-reset-teams"),
    feedSearchWrap: $("#feed-search-wrap"),
    feedSearchToggle: $("#feed-search-toggle"),
    feedSearch: $("#feed-search-input"),
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
    marketsHeaderActions: $("#markets-header-actions"),
    scheduleScatter: $("#schedule-scatter"),
    scheduleScatterTooltip: $("#schedule-scatter-tooltip"),
    uiTooltip: $("#ui-tooltip"),
    mobileSheet: $("#mobile-sheet"),
    mobileSheetTitle: $("#mobile-sheet-title"),
    mobileSheetBody: $("#mobile-sheet-body"),
    mobileSheetPanel: document.querySelector("#mobile-sheet .mobile-sheet-panel"),
    mobileSheetReset: $("#mobile-sheet-reset"),
    filtersResetRow: $("#filters-reset-row"),
    searchClearBtn: $("#search-clear-btn"),
    feedSearchClearBtn: $("#feed-search-clear-btn"),
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
    expectedLegend: $("#expected-legend"),
    barbellWrap: $("#barbell-wrap"),
    barbellHead: $("#barbell-head"),
    barbellScale: $("#barbell-scale"),
    barbellBody: $("#barbell-body"),
    expectedTooltip: $("#expected-tooltip"),
    seasonSelect: $("#season-select"),
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
    fplIdInput: $("#fpl-id-input"),
    fplIdSave: $("#fpl-id-save"),
    fplIdClear: $("#fpl-id-clear"),
    fplIdStatus: $("#fpl-id-status"),
    fontPairSelect: $("#font-pair-select"),
    clockFormatSelect: $("#clock-format-select"),
    fixtureTtDelay: $("#fixture-tt-delay"),
    fixtureTtDelayFill: $("#fixture-tt-delay-fill"),
    fixtureTtDelayLabel: $("#fixture-tt-delay-label"),
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
    inactiveFilterGroup: $("#inactive-filter-group"),
    showDepartedCheck: $("#show-departed-check"),
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
    if (state.search.trim()) return true;
    if (state.priceMin !== defaultMinPrice() || state.priceMax !== bounds.price.max) return true;
    if (state.ownedMin !== OWNERSHIP_FILTER_DEFAULT) return true;
    if (state.ownershipTrendThreshold !== OWNERSHIP_TREND_THRESHOLD_DEFAULT) return true;
    if (state.minsMin !== defaultMinMinutes() || state.minsMax !== bounds.mins.max) return true;
    if (!state.hideDeparted) return true;
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
    state.priceMin = defaultMinPrice();
    state.priceMax = bounds.price.max;
    state.ownedMin = OWNERSHIP_FILTER_DEFAULT;
    state.ownershipTrendThreshold = OWNERSHIP_TREND_THRESHOLD_DEFAULT;
    state.minsMin = defaultMinMinutes();
    state.minsMax = bounds.mins.max;
    state.search = "";
    if (el.search) el.search.value = "";
    if (el.searchWrap) el.searchWrap.classList.remove("search-open");
    if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "false");
    syncSearchClearBtns();
    state.hideDeparted = true;
    if (el.showDepartedCheck) el.showDepartedCheck.checked = false;
    state.setPieceTakersOnly = false;
    if (el.setpieceTakersCheck) el.setpieceTakersCheck.checked = false;
    state.teamAffordableOnly = false;
    if (el.teamAffordableCheck) el.teamAffordableCheck.checked = false;
    setValueMode("total", { rerender: false });
    state.split = "combined";
    $$("#split-seg button").forEach((b) => b.classList.toggle("active", b.dataset.split === "combined"));
    syncSegThumb(el.splitSeg);
    state.enhancePct = defaultEnhancePct();
    state.hiddenCols = new Set();
    updateEnhancePctSlider();
    updatePriceSlider();
    updateOwnedSlider();
    updateOwnershipTrendThresholdSlider();
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
        if (!isNextSeason() && HAS_PRICE_DATA && state.hideDeparted && r.price2627 == null) return false;
        if (state.setPieceTakersOnly && !isSetPieceTaker(r)) return false;
        if (state.posFilter.size && !state.posFilter.has(r.position)) return false;
        if (state.teamFilter.size && !state.teamFilter.has(r.team)) return false;
        if (r.price < state.priceMin || r.price > state.priceMax) return false;
        if (!passesOwnershipFilter(r)) return false;
        if (r.mins < state.minsMin || r.mins > state.minsMax) return false;
        if (q) {
          const hay = (r.name + " " + r.team + " " + teamNameForSeason(r.team)).toLowerCase();
          if (!hay.includes(q)) return false;
        }
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

  // Active price for display / Per £m: next-season price while Updates is on
  // (when matched). In 2026/27 mode the row price is already remapped.
  function effectivePrice(row) {
    if (updatesOverlayOn() && row.price2627 != null) return row.price2627;
    return row.price || 0;
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

  // Per-90 defensive-action rate against that position's threshold. Null when
  // the player is ineligible or the raw counts are missing (home/away splits
  // carry no API data, and unmatched players have none at all).
  function defconStatus(row) {
    const pos = defconPosition(row);
    const rule = DEFCON_RULES[pos];
    if (!rule || row.__cbitr == null || !row.mins) return null;
    const per90 = (row.__cbitr / row.mins) * 90;
    return { pos, per90, actions: row.__cbitr, rule, threshold: rule.threshold, meets: per90 >= rule.threshold };
  }

  // Filled check beside CBIT/R for players clearing their threshold on a
  // per-90 basis — a quick read on who is a repeatable defensive-contribution
  // source rather than someone who banked points in heavy-minute games.
  // Uses the same circle-check mark as set-pieces (not the home-fixture star).
  // Color: blue in light mode, red in dark mode (see .threshold-dot).
  function defconDotHTML(row) {
    const status = defconStatus(row);
    if (!status || !status.meets) return "";
    const title = `${status.per90.toFixed(1)} per 90 — clears the ${status.threshold} ${status.pos} threshold`;
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
  const TEAM_MODE_KEY = "fpl-explorer-team-mode";
  const TEAM_ACTUAL_KEY = "fpl-explorer-team-actual";
  const NOTES_KEY = "fpl-explorer-notes-v1";
  let ownedCodes = new Set();
  let savedManagerId = null;
  let noteMenuOpenedAt = 0;
  let noteDraft = null;

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

  function syncFplIdStatus() {
    if (!el.fplIdStatus) return;
    if (!savedManagerId) {
      el.fplIdStatus.textContent = "No manager ID saved.";
      return;
    }
    const n = ownedCodes.size;
    const meta = state.actualMeta;
    const bits = [`ID ${savedManagerId}`];
    if (meta && meta.teamName) bits.push(meta.teamName);
    if (meta && meta.gwLabel) bits.push(meta.gwLabel);
    if (n > 0) bits.push(`${n} pick${n === 1 ? "" : "s"}`);
    else if (meta && meta.hasPicks === false) bits.push("no published picks yet");
    else bits.push("not synced");
    el.fplIdStatus.textContent = bits.join(" · ");
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
    if (el.teamResyncBtn) {
      el.teamResyncBtn.hidden = !savedManagerId || state.teamMode !== "planner";
    }
    if (el.teamPageSubtitle) {
      el.teamPageSubtitle.textContent =
        state.teamMode === "actual"
          ? "Read-only view of your linked FPL squad. Switch to Planner to draft changes."
          : "Editable planner squad (£100.0m). Resync replaces this with your linked Actual team.";
    }
    syncTeamClearBtn();
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

  async function applyManagerId(rawId, { quiet = false, render = true, seedPlannerIfEmpty = true } = {}) {
    const id = String(rawId || "").trim();
    if (!/^\d+$/.test(id) || Number(id) <= 0) {
      if (!quiet) {
        showToast({ title: "Invalid FPL ID", message: "Enter a positive numeric manager ID.", icon: "triangle-alert" });
      }
      return false;
    }
    savedManagerId = id;
    try {
      localStorage.setItem(FPL_ID_KEY, id);
    } catch {
      /* private browsing */
    }
    if (el.fplIdInput) el.fplIdInput.value = id;
    try {
      await syncManagerFromApi(id, { seedPlannerIfEmpty, quiet });
    } catch (err) {
      ownedCodes = new Set();
      syncFplIdStatus();
      if (!quiet) {
        showToast({
          title: "Could not sync FPL team",
          message: err && err.message ? err.message : "Check the ID and try again.",
          icon: "triangle-alert",
        });
      }
      if (render) renderTable();
      return false;
    }
    if (render) renderTable();
    return true;
  }

  function clearManagerId({ quiet = false, render = true } = {}) {
    savedManagerId = null;
    ownedCodes = new Set();
    state.actualMeta = null;
    try {
      localStorage.removeItem(FPL_ID_KEY);
      localStorage.removeItem(TEAM_ACTUAL_KEY);
    } catch {
      /* private browsing */
    }
    if (el.fplIdInput) el.fplIdInput.value = "";
    if (state.teamMode === "actual") {
      applySquadSnapshot({ squad: [], captain: null, vice: null });
    }
    syncFplIdStatus();
    syncTeamModeUI();
    if (!quiet) {
      showToast({ title: "FPL ID cleared", message: "Actual team link removed. Planner draft is unchanged.", icon: "info" });
    }
    if (render) renderTable();
  }

  async function restoreManagerId() {
    let saved = "";
    let mode = "planner";
    try {
      saved = localStorage.getItem(FPL_ID_KEY) || "";
      mode = localStorage.getItem(TEAM_MODE_KEY) === "actual" ? "actual" : "planner";
    } catch {
      saved = "";
      mode = "planner";
    }
    const actual = loadActualSnapshot();
    if (actual) {
      state.actualMeta = actual.meta || null;
      ownedCodes = new Set(actual.squad.map((s) => s.code));
    }
    if (el.fplIdInput && saved) el.fplIdInput.value = saved;
    state.teamMode = "planner";
    loadTeamDraft();
    if (saved) {
      try {
        await syncManagerFromApi(saved, { seedPlannerIfEmpty: true, quiet: true });
      } catch {
        syncFplIdStatus();
      }
    } else {
      syncFplIdStatus();
    }
    setTeamMode(mode, { render: false, persist: false });
  }

  function requestResyncPlanner() {
    if (!savedManagerId) {
      showToast({ title: "No manager linked", message: "Save a Manager ID in Preferences first.", icon: "triangle-alert" });
      return;
    }
    openConfirmModal({
      title: "Resync planner from Actual?",
      message: "This replaces your Planner squad with the latest linked FPL team. Planner-only edits will be lost.",
      okLabel: "Resync planner",
    }).then(async (ok) => {
      if (!ok) return;
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
    return `<div class="player-name-line"><span class="player-name">${escapeHtml(row.name)}</span><span class="player-name-icons">${icons}</span></div>`;
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

  function syncFplIdStatus() {
    if (!el.fplIdStatus) return;
    if (!savedManagerId) {
      el.fplIdStatus.textContent = "No manager ID saved.";
      return;
    }
    const n = ownedCodes.size;
    el.fplIdStatus.textContent =
      n > 0
        ? `ID ${savedManagerId} · ${n} owned player${n === 1 ? "" : "s"} (mock).`
        : `ID ${savedManagerId} · no owned players matched.`;
  }

  async function applyManagerId(rawId, { quiet = false, render = true } = {}) {
    const id = String(rawId || "").trim();
    if (!/^\d+$/.test(id) || Number(id) <= 0) {
      if (!quiet) {
        showToast({ title: "Invalid FPL ID", message: "Enter a positive numeric manager ID.", icon: "triangle-alert" });
      }
      return false;
    }
    savedManagerId = id;
    try {
      localStorage.setItem(FPL_ID_KEY, id);
    } catch {
      /* private browsing */
    }
    if (el.fplIdInput) el.fplIdInput.value = id;
    ownedCodes = await loadOwnedSquad(id);
    syncFplIdStatus();
    if (!quiet) {
      showToast({
        title: "FPL ID saved",
        message: `Loaded ${ownedCodes.size} owned players (mock data).`,
        icon: "circle-check",
      });
    }
    if (render) renderTable();
    return true;
  }

  function clearManagerId({ quiet = false, render = true } = {}) {
    savedManagerId = null;
    ownedCodes = new Set();
    try {
      localStorage.removeItem(FPL_ID_KEY);
    } catch {
      /* private browsing */
    }
    if (el.fplIdInput) el.fplIdInput.value = "";
    syncFplIdStatus();
    if (!quiet) {
      showToast({ title: "FPL ID cleared", message: "Owned-player markers removed.", icon: "info" });
    }
    if (render) renderTable();
  }

  async function restoreManagerId() {
    let saved = "";
    try {
      saved = localStorage.getItem(FPL_ID_KEY) || "";
    } catch {
      saved = "";
    }
    if (el.fplIdInput && saved) el.fplIdInput.value = saved;
    if (saved) await applyManagerId(saved, { quiet: true, render: false });
    else syncFplIdStatus();
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

  // Builds { colKey: { top: Map(rowKey -> intensity), bottom: Map(...) } }
  // for the columns visible in the current view. Bands are always measured
  // against the full player/team population (not the filtered rows). topN is
  // state.enhancePct of that population. Players rank only
  // the best values (green). Teams — a much smaller population — rank
  // both the best and worst (green "target" / red "avoid"), with the
  // bottom set drawn only from values outside the top set so the two never
  // overlap. Zero-valued cells are excluded from ranking (they're always
  // visually demoted instead). Ties share the same intensity.
  function buildHighlightMaps(rows) {
    const maps = {};
    const isTeams = state.view === "teams";
    const topN = Math.max(1, Math.round((rows.length * state.enhancePct) / 100));
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

      const topSlice = withVals.slice(0, topN);
      const top = new Map(topSlice.map((x, i) => [x.key, rankBandIntensity(i, topSlice.length)]));

      const bottom = new Map();
      if (isTeams) {
        const remaining = withVals.slice(topSlice.length);
        const bottomSlice = remaining.slice(-topN).reverse();
        bottomSlice.forEach((x, i) => bottom.set(x.key, rankBandIntensity(i, bottomSlice.length)));
      }

      maps[col.key] = { top, bottom };
    });
    return maps;
  }

  // Price and Own% are excluded from the top/bottom% Enhance system (levels,
  // not rate stats — tinting “most expensive/owned” isn’t useful).

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function visibleColumns() {
    return cols().filter((c) => c.pin || !state.hiddenCols.has(c.key));
  }

  function fmtNum(v, decimals) {
    if (v === undefined || v === null || Number.isNaN(v)) return "–";
    const n = Number(v);
    if (decimals === 0) return Math.round(n).toLocaleString();
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
        renderTable();
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
      const sub = posHTML ? `<div class="player-cell-sub">${posHTML}</div>` : "";
      const name = `<div class="player-name-line"><span class="player-name">${escapeHtml(row.name)}</span></div>`;
      return playerIdentityHTML(playerCrestHTML(row.team), name, sub);
    }
    if (col.key === "price") {
      const val = fmtDisplayValue(displayValue(row, col), col);
      const delta = priceDeltaHTML(row);
      return delta ? `<span class="cell-inline align-end">${val}${delta}</span>` : val;
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

  // Green/red ± beside the replacement price while Updates is on (2025/26 only).
  // Matched at build time in site/build.py (match_new_season_prices).
  function priceDeltaHTML(row) {
    if (!updatesOverlayOn() || row.price2627 == null) return "";
    const delta = row.priceDelta || 0;
    if (Math.abs(delta) < 1e-9) return "";
    const cls = delta > 0 ? "price-up" : "price-down";
    const deltaText = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
    const title = `Was £${row.price.toFixed(1)}m`;
    return `<span class="price-arrow-delta ${cls}"${tipAttr(title)}>${deltaText}</span>`;
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

  // Mobile Statistics name-column scroll morph — disabled for now.
  function nameSimplifyWraps() {
    const wraps = [];
    const main = el.tableBody && el.tableBody.closest(".table-wrap");
    if (main) wraps.push(main);
    const compare = el.compareWrap && el.compareWrap.querySelector(".compare-table-wrap");
    if (compare) wraps.push(compare);
    return wraps;
  }

  function clearNameColumnSimplify(wrap) {
    if (!wrap) return;
    wrap.classList.remove("name-simplify-ready", "is-name-simplifying");
    wrap.style.removeProperty("--name-collapse");
  }

  function syncAllNameColumnSimplifies() {
    nameSimplifyWraps().forEach(clearNameColumnSimplify);
  }

  function bindAllNameColumnSimplifies() {
    syncAllNameColumnSimplifies();
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
    if (el.marketsViewToolbarBtn && closingKey === "markets-view") {
      el.marketsViewToolbarBtn.setAttribute("aria-expanded", "false");
    }
    if (el.feedFiltersToggle && closingKey === "feed-filters") {
      el.feedFiltersToggle.setAttribute("aria-expanded", "false");
      const active = feedFiltersActive();
      el.feedFiltersToggle.classList.toggle("on", active);
      el.feedFiltersToggle.title = active ? "Feed filters (active)" : "Show feed filters";
      el.feedFiltersToggle.setAttribute(
        "aria-label",
        active ? "Show feed filters (filters active)" : "Show feed filters"
      );
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
    return node.closest("[data-tip], [data-tip-html]");
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
        target.closest(
          "a, button, input, label, select, textarea, summary, thead th, .barbell-head-cell, .schedule-scatter-point, .feed-treemap-cell, .barbell-dot, .team-rank-info, .ftt-verdict-tip, tbody tr[data-team], .schedule-card, #mobile-sheet"
        )
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

    const highlightMaps = buildHighlightMaps(getRows());
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
    if (state.compareMode) {
      const selected = compareSet().has(key);
      tr.classList.add("row-selectable");
      if (selected) tr.classList.add("row-selected");
      tr.setAttribute("aria-selected", selected ? "true" : "false");
      tr.addEventListener("click", () => toggleCompareRow(key));
    }
    vcols.forEach((c, i) => {
      const td = document.createElement("td");
      td.classList.add("col-" + (c.type || "num"));
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

  function renderTable() {
    clearTimeout(fixtureTtTimer);
    hideFixtureTooltip();
    if (state.page === "ownership") {
      renderOwnership();
      syncFiltersResetUI();
      return;
    }
    if (state.page === "team") {
      renderTeam();
      syncFiltersResetUI();
      return;
    }
    const filtered = applyFilters(getRows());
    const sorted = sortRows(filtered);
    renderHead();
    renderBody(sorted);
    el.countLabel.textContent = `${filtered.length.toLocaleString()} of ${getRows().length.toLocaleString()} shown`;
    renderCompareTable();
    if (state.page === "expected") renderExpected();
    if (state.page === "rankings") renderRankings();
    bindAllNameColumnSimplifies();
    syncFiltersResetUI();
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
    const fixtures = options.fixtures ||
      (FIXTURES_BY_TEAM[teamCode] || []).slice(0, FIXTURE_TT_COUNT);
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
      ${spitIntro("Soft upcoming runs for attack and/or defence — edges, ranks, and schedule balance.")}
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

    if (state.page === "rankings") {
      const iconRows = [
        spitRow(spitMedalsHTML(), "Places 1–3 on each card.", "spit-medals"),
        spitRow(spitOwnedPinHTML(), "In your FPL squad (Preferences → Manager ID)."),
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
        ${spitIntro("Top 10 leaderboards for OPTA and FPL metrics.")}
        ${spitSection("Icons", iconRows)}
        ${spitSection("Reading", reading)}`;
    }

    if (state.page === "expected") {
      const iconRows = [
        spitRow(`<i class="spit-easy"></i>`, "Outperforming expectation"),
        spitRow(`<i class="spit-tough"></i>`, "Underperforming expectation"),
        spitRow(`<i class="spit-even"></i>`, "Even — actual ≈ expected"),
        spitRow(spitOwnedPinHTML(), "In your FPL squad"),
      ];
      if (mobile) {
        iconRows.unshift(
          spitRow(spitRank("Cat"), "Category — toolbar dropdown")
        );
      }
      const reading = [
        spitRow(spitRank("Bar"), "Expected → actual. Moving dashes show the gap direction."),
        spitRow(
          spitRank("Diff"),
          "Actual − expected. Pill intensity scales with gap size. For xGC, a negative Diff can still be green (conceded less than expected)."
        ),
      ];
      return `${spitHead("chart-gantt", "How Expected Data works")}
        ${spitIntro("Expected (x) vs actual — who over- or underperformed.")}
        ${spitSection("Icons", iconRows)}
        ${spitSection("Reading", reading)}
        ${spitNote("Green/red here is over/under vs expectation — not Matchups fixture difficulty. Soft green is quieter in dark mode.")}`;
    }

    if (state.page === "feed") {
      const iconRows = [
        spitRow(iconHTML("arrow-up-right"), "Open the post"),
        spitRow(spitRank("Type"), "Original / Reply / Quote / Retweet badge — bottom right of each quote"),
      ];
      const reading = [
        ...(mobile
          ? []
          : [spitRow(spitRank("Map"), "Treemap — share of mentions. Click a tile to filter to that player.")]),
        spitRow(spitRank("Card"), "One resolved FPL player. Quotes newest first."),
        spitRow(spitRank("Order"), "Most mentions first, then newest."),
      ];
      return `${spitHead("rss", "How Social Media Feed works")}
        ${spitIntro("Player-mention cards from curated X accounts.")}
        ${spitSection("Icons", iconRows)}
        ${spitSection("Reading", reading)}
        ${spitNote("Refreshing the page never calls X — it only reads the local cache.")}`;
    }

    if (state.page === "ownership") {
      const reading = [
        spitRow(spitRank("Players"), "Latest check-in’s top 100 owned names after filters. Grey lines; hover colorizes the club."),
        spitRow(spitRank("Teams"), "Average ownership of each club’s top 20 most-owned players at that check-in."),
        spitRow(spitRank("Trending"), "Toolbar toggle colors lines by ownership rise/fall and lists Risers / Fallers above the chart."),
        spitRow(spitRank("Axis"), "X is a manual snapshot date, not a gameweek. Run python3 site/fetch_ownership.py to add a check-in."),
        spitRow(spitRank(mobile ? "Tap" : "Hover"), mobile
          ? "Tap a line for the player/club card (photo, badge, price, owned %, change)."
          : "Hover a line for the player/club card (photo, badge, price, owned %, change)."),
      ];
      return `${spitHead("trending-up", "How Ownership works")}
        ${spitIntro("FPL selected-by-% over the check-ins saved in this repo.")}
        ${spitSection("Reading", reading)}
        ${spitNote("The page never calls the FPL API — it only reads ownership_data.js.")}`;
    }

    if (state.page === "markets") {
      const iconRows = [];
      if (mobile) {
        iconRows.push(
          spitRow(spitRank("View"), "Goals and CS% or Scoreline — toolbar dropdown"),
          spitRow(iconHTML("sliders-horizontal"), "Color thresholds and Compare window")
        );
      } else {
        iconRows.push(
          spitRow(spitRank("View"), "Goals and CS% or Scoreline — Markets tab menu"),
          spitRow(iconHTML("sliders-horizontal"), "Color thresholds and Compare window")
        );
      }
      const reading = [
        spitRow(spitRank("Goals"), "Poisson λ from de-vigged 1X2 + totals — projected goals per side."),
        spitRow(spitRank("CS%"), "P(opponent scores 0) under that model — not a native book market."),
        spitRow(spitRank("Scoreline"), "Exact-score matrix (% in cells). Goals view lists top likely scores."),
        spitRow(spitRank("Color"), "Green/red bands on Goals and CS%; deeper past the threshold. Soft green is quieter in dark mode."),
        spitRow(spitRank("Compare"), "Last run or Last 72 hr — movement vs prior odds pull."),
      ];
      return `${spitHead("candlestick", "How Markets works")}
        ${spitIntro("Projected goals, clean-sheet %, and scorelines from bookmaker odds.")}
        ${spitSection("Icons", iconRows)}
        ${spitSection("Reading", reading)}`;
    }

    if (state.page === "team") {
      const iconRows = [
        spitRow(iconHTML("plus"), "Empty row — add a player of that position (Planner only)"),
        spitRow(spitRank("Row"), "Right-click a planner player for captain, vice, bench, replace, remove, or Add note."),
        spitRow(iconHTML("refresh-ccw-dot"), "Resync — replace Planner with the linked Actual FPL squad (confirm first)"),
        spitRow(iconHTML("scale"), "Compare — click up to 5 players in the squad, search, or picker"),
      ];
      const reading = [
        spitRow(spitRank("Actual"), "Read-only copy of your linked manager squad from the FPL API."),
        spitRow(spitRank("Planner"), "Editable local draft (one team). Survives refresh. Resync overwrites it from Actual."),
        spitRow(spitRank("Rules"), "15 players · £100.0m · max 3 per club · 2 GKP / 5 DEF / 5 MID / 3 FWD."),
        spitRow(spitRank("XI"), "Formation follows starters (3–5 DEF, 2–5 MID, 1–3 FWD). Bench holds the rest."),
        spitRow(spitRank("Stats"), "Pts, xPts, xGI, xG, xA from 2025/26 (matched by FPL code). Faint rank is among that position last season. New signings show –."),
        spitRow(spitRank("Set pieces"), "PK / FK / CK — FPL #1 (green check). FK/CK also show #2."),
        spitRow(spitRank("Heat"), "Six consecutive gameweeks. Caps = home, lowercase = away. The right-edge line is the window start. Prev/next shifts by one."),
        spitRow(spitRank("Select"), "Empty slot or Replace opens the player list. Filters (including Affordable) open then. Back or Escape returns to the squad."),
        spitRow(spitRank("Affordable"), "In Filters while picking — hides anyone above remaining Bank. Replace credits the outgoing player's price."),
        spitRow(spitRank("Squad"), "Preferences → Clear planner removes every Planner pick. Actual is unchanged."),
        spitRow(spitRank("Compare"), "Search, then ↑↓ and Enter or click a row to pin (up to 5). Pinning clears the search and keeps the pin list — Compare mode is disabled while pins exist. Hover a squad or search-result row to highlight stat winners. With no pins, Compare mode click-selects instead of add/replace."),
        spitRow(spitRank("Prices"), "2026/27 FPL list. Link a Manager ID to import Actual."),
      ];
      return `${spitHead("shirt", "How Team works")}
        ${spitIntro("Actual is your live FPL squad; Planner is the editable draft you keep locally.")}
        ${spitSection("Icons", iconRows)}
        ${spitSection("Reading", reading)}`;
    }

    if (state.page === "notes") {
      return `${spitHead("sticky-note", "How Notes works")}
        ${spitIntro("Freeform comments on players and clubs, saved with the current gameweek (or Preseason).")}
        ${spitSection("Icons", [
          spitRow(iconHTML("notebook-pen"), "Right-click a player, crest, or team surface → Add note"),
          spitRow(spitRank("Group"), "All · By player · By team"),
        ])}
        ${spitSection("Reading", [
          spitRow(spitRank("Sort"), "Newest notes first."),
          spitRow(spitRank("Confirm"), "Player and club are saved automatically from what you clicked — no picker."),
        ])}`;
    }

    if (state.page === "schedule") {
      return matchupPageInfoHTML();
    }

    // Statistics (default)
    const iconRows = [
      spitRow(iconHTML("refresh-ccw-dot"), "Updates — matched 2026/27 price, club, position"),
      spitRow(iconHTML("scale"), "Compare — up to five rows side by side"),
    ];
    if (!mobile) {
      iconRows.push(spitRow(iconHTML("columns"), "Show/hide metric columns — toolbar"));
    }
    iconRows.push(
      spitRow(spitOwnedPinHTML(), "In your FPL squad (Preferences → Manager ID)"),
      spitRow(
        spitCheckMarkHTML("spit-check-mark spit-check-mark--threshold"),
        "DC threshold check — enough CBIT/R per 90 (10 DEF / 12 MID·FWD). Blue in light mode, red in dark mode."
      ),
      spitRow(
        spitCheckMarkHTML("spit-check-mark spit-check-mark--setpiece"),
        "Set-piece — FPL #1 (green check). FK/CK also show #2."
      ),
      spitRow(iconHTML("triangle-alert", "source-unsupported"), "Source can’t fill this cell")
    );
    const reading = [
      spitRow(
        spitRank("Tint"),
        "Green/red Highlight Top/Bottom on raw values (default top/bottom 5% for Players). Bands vs all Players/Teams — filters don’t shrink them. Soft green fills use a quieter tone in dark mode."
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
      ${spitIntro("Season OPTA and FPL stats — filter, sort, and compare.")}
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

  function clampFixtureTtDelaySec(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return FIXTURE_TT_DELAY_SEC_DEFAULT;
    return Math.min(
      FIXTURE_TT_DELAY_SEC_MAX,
      Math.max(FIXTURE_TT_DELAY_SEC_MIN, Math.round(n * 10) / 10)
    );
  }

  function loadFixtureTtDelaySec() {
    try {
      const raw = localStorage.getItem(FIXTURE_TT_DELAY_KEY);
      if (raw == null || raw === "") return FIXTURE_TT_DELAY_SEC_DEFAULT;
      return clampFixtureTtDelaySec(raw);
    } catch {
      return FIXTURE_TT_DELAY_SEC_DEFAULT;
    }
  }

  let fixtureTtDelaySec = loadFixtureTtDelaySec();
  function popupDelayMs() {
    return Math.round(fixtureTtDelaySec * 1000);
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
    if (pane) {
      const btn = pane.querySelector(".page-info-btn");
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
      opta: "How Statistics works",
      rankings: "How Rankings works",
      expected: "How Expected Data works",
      schedule: "How Matchups works",
      feed: "How Social Media Feed works",
      ownership: "How Ownership works",
      markets: "How Markets works",
      team: "How Team works",
      notes: "How Notes works",
    };
    pageInfoButtons().forEach((btn) => {
      const pane = btn.closest(".page-pane");
      let page = state.page;
      if (pane) {
        if (pane.id === "opta-page") page = "opta";
        else if (pane.id === "rankings-page") page = "rankings";
        else if (pane.id === "expected-page") page = "expected";
        else if (pane.id === "schedule-page") page = "schedule";
        else if (pane.id === "feed-page") page = "feed";
        else if (pane.id === "ownership-page") page = "ownership";
        else if (pane.id === "markets-page") page = "markets";
        else if (pane.id === "team-page") page = "team";
        else if (pane.id === "notes-page") page = "notes";
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
    }
    renderTable();
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

  function renderCompareTable() {
    const set = compareSet();
    if (!state.compareMode || set.size < 2) {
      el.compareWrap.style.display = "none";
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
  }

  // ---------------------------------------------------------------------
  // Columns settings panel
  // ---------------------------------------------------------------------
  function renderColumnsPanel() {
    if (!el.columnsList) return;
    el.columnsList.innerHTML = "";
    el.columnsList.className = "columns-list";
    if (state.page !== "opta") return;

    const groupOrder = [];
    const groups = new Map();
    cols().forEach((c) => {
      if (c.pin) return;
      const g = c.group || "Other";
      if (!groups.has(g)) {
        groups.set(g, []);
        groupOrder.push(g);
      }
      groups.get(g).push(c);
    });
    groupOrder.forEach((g) => {
      const section = document.createElement("section");
      section.className = "columns-section";
      const heading = document.createElement("h3");
      heading.className = "columns-section-label";
      heading.innerHTML = `<span>${escapeHtml(g)}</span>`;
      section.appendChild(heading);
      const grid = document.createElement("div");
      grid.className = "columns-switch-grid";
      groups.get(g).forEach((c) => {
        const row = document.createElement("label");
        row.className = "settings-switch-row";
        const title = metricDisplayTitle(c);
        const text = document.createElement("span");
        text.className = "settings-switch-text";
        text.innerHTML = `<span class="settings-switch-label">${escapeHtml(title)}</span><span class="settings-switch-meta">${escapeHtml(c.label)}</span>`;
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !state.hiddenCols.has(c.key);
        input.setAttribute("aria-label", `Show ${title}`);
        input.addEventListener("change", () => {
          if (input.checked) state.hiddenCols.delete(c.key);
          else state.hiddenCols.add(c.key);
          syncFiltersResetUI();
          renderTable();
        });
        const track = document.createElement("span");
        track.className = "switch-track";
        track.setAttribute("aria-hidden", "true");
        track.innerHTML = `<span class="switch-thumb"></span>`;
        row.appendChild(text);
        row.appendChild(input);
        row.appendChild(track);
        grid.appendChild(row);
      });
      section.appendChild(grid);
      el.columnsList.appendChild(section);
    });
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
    return state.view === "players" ? PLAYER_EXPECTED_CATS : TEAM_EXPECTED_CATS;
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

  function clearExpectedCatMenuPosition() {
    if (!el.expectedCatMenu) return;
    el.expectedCatMenu.classList.remove("is-fixed");
    el.expectedCatMenu.style.left = "";
    el.expectedCatMenu.style.top = "";
    el.expectedCatMenu.style.minWidth = "";
  }

  function positionExpectedCatMenuFixed() {
    if (!el.expectedCatMenu || !el.pageExpected) return;
    const r = el.pageExpected.getBoundingClientRect();
    const menuWidth = Math.max(176, el.expectedCatMenu.offsetWidth || 176);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - menuWidth - 8));
    el.expectedCatMenu.classList.add("is-fixed");
    el.expectedCatMenu.style.left = `${left}px`;
    el.expectedCatMenu.style.top = `${r.bottom + 6}px`;
    el.expectedCatMenu.style.minWidth = `${Math.max(menuWidth, r.width)}px`;
  }

  function setExpectedCatMenuOpen(open) {
    if (!el.expectedTabWrap || !el.pageExpected) return;
    el.expectedTabWrap.classList.toggle("open", open);
    el.pageExpected.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      if (tabMenuNeedsFixedPosition()) {
        requestAnimationFrame(() => {
          positionExpectedCatMenuFixed();
          requestAnimationFrame(positionExpectedCatMenuFixed);
        });
      } else {
        clearExpectedCatMenuPosition();
      }
    } else {
      clearExpectedCatMenuPosition();
    }
  }

  function syncExpectedCatToolbar() {
    if (!el.expectedCatToolbar || !el.expectedCatBtn || !el.expectedCatLabel) return;
    const show = preferMobileSheet() && state.page === "expected";
    el.expectedCatToolbar.hidden = !show;
    if (!show) {
      el.expectedCatBtn.setAttribute("aria-expanded", "false");
      return;
    }
    const cat = currentExpectedCat();
    el.expectedCatLabel.textContent = cat.label;
    el.expectedCatBtn.title = cat.label;
    el.expectedCatBtn.setAttribute("aria-label", `xData category: ${cat.label}`);
    el.expectedCatBtn.setAttribute(
      "aria-expanded",
      mobileSheetOpen && mobileSheetKey === "expected-cats" ? "true" : "false"
    );
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
        setPage("expected");
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
  function expectedSplitRows(split) {
    return state.view === "players" ? DATA.players[split] : DATA.teams[split];
  }

  function buildSplitMap(split) {
    const map = new Map();
    expectedSplitRows(split).forEach((r) => map.set(rowKey(r), r));
    return map;
  }

  function renderExpectedLegend() {
    el.expectedLegend.innerHTML = `
      <span class="legend-item"><span class="legend-dot" style="background:var(--text-faint)"></span>Expected</span>
      <span class="legend-item"><span class="legend-dot" style="background:hsl(var(--positive))"></span>Outperforming</span>
      <span class="legend-item"><span class="legend-dot" style="background:var(--blue)"></span>Even</span>
      <span class="legend-item"><span class="legend-dot" style="background:var(--red)"></span>Underperforming</span>
    `;
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
          renderExpected();
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
    const restricted = !!cat.combinedOnly;
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

  function renderExpected() {
    const cat = currentExpectedCat();
    updateExpectedSplitAvailability(cat);
    const compareMode = state.expectedSplit === "compare";
    buildExpectedCatMenu();
    syncExpectedCatToolbar();
    hideExpectedTooltip();

    el.expectedTitle.querySelector(".page-title-text").textContent = "Expected Data";

    if (isNextSeason()) {
      el.expectedSub.textContent = "Expected vs actual isn’t available for 2026/27 yet.";
      el.barbellHead.innerHTML = "";
      el.barbellScale.innerHTML = "";
      el.barbellBody.innerHTML = "";
      if (el.expectedLegend) el.expectedLegend.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "empty-state expected-empty";
      empty.innerHTML = `
        <p>No expected data for 2026/27.</p>
        <p class="expected-empty-hint">xG, xA, and other expected stats aren’t published for the new season yet. Switch the data season to <strong>2025/26</strong> to browse last year’s expected vs actual.</p>`;
      el.barbellBody.appendChild(empty);
      return;
    }

    renderExpectedLegend();
    el.expectedSub.textContent = compareMode
      ? "Home and away side by side for the same players or teams."
      : "Compare expected (x) stats with what actually happened — who overperformed or underperformed.";

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
    const spec = (RANKINGS_SECTIONS[state.view] || []).find((s) => s.label === section);
    if (!spec) return [];
    const byKey = new Map(cols().map((col) => [col.key, col]));
    return spec.keys
      .map((key) => byKey.get(key))
      .filter((col) => {
        if (!col || !isRankingsMetricCol(col)) return false;
        // FPL season totals have no home/away breakdown — omit those cards.
        if (
          state.view === "players" &&
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
    return (RANKINGS_SECTIONS[state.view] || [])
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
    const n = Number(DATA.fixturesMeta && DATA.fixturesMeta.currentGw);
    if (Number.isFinite(n) && n >= SCHEDULE_GW_MIN) return n;
    return SCHEDULE_GW_MIN;
  }

  function teamClampGwStart(start) {
    const maxStart = Math.max(SCHEDULE_GW_MIN, SCHEDULE_GW_MAX - TEAM_HEAT_N + 1);
    return Math.min(maxStart, Math.max(SCHEDULE_GW_MIN, Number(start) || SCHEDULE_GW_MIN));
  }

  function teamHeatGws() {
    const start = teamClampGwStart(state.teamGwStart ?? teamCurrentGw());
    const gws = [];
    for (let g = start; gws.length < TEAM_HEAT_N && g <= SCHEDULE_GW_MAX; g++) gws.push(g);
    return gws;
  }

  function teamShiftGw(delta) {
    const next = teamClampGwStart((state.teamGwStart ?? teamCurrentGw()) + delta);
    if (next === state.teamGwStart) return;
    state.teamGwStart = next;
    renderTeam();
  }

  let teamPriorByCodeCache = null;
  function teamPriorByCode() {
    if (teamPriorByCodeCache) return teamPriorByCodeCache;
    const map = new Map();
    ((DATA.players && DATA.players.combined) || []).forEach((row) => {
      if (row && row.code != null) map.set(Number(row.code), row);
    });
    teamPriorByCodeCache = map;
    return map;
  }

  function teamPriorRow(code) {
    if (code == null || code === "") return null;
    return teamPriorByCode().get(Number(code)) || null;
  }

  let teamPosRankCache = null;
  function teamPosRankMaps() {
    if (teamPosRankCache) return teamPosRankCache;
    const maps = {};
    const prior = (DATA.players && DATA.players.combined) || [];
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

  function teamMetricHeadHTML(opts) {
    const plain = !!(opts && opts.plain);
    const divideFirst = !(opts && opts.price);
    const stats = TEAM_STAT_COLS.map((col, i) =>
      teamSortTh(
        col.key,
        col.label,
        `col-num col-team-stat${divideFirst && i === 0 ? " sec-divider" : ""}`,
        `${col.title} · 2025/26`,
        { plain }
      )
    ).join("");
    const spark = teamSortTh("trend", "Trend", "col-team-spark", "Mock recent-form trend", { plain });
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
    return `<tr class="section-row"><th class="sec-sticky-lead">Player</th><th class="sec-divider" colspan="${statsN}">Statistics</th><th class="sec-divider" colspan="${heatN}">Fixtures</th></tr>`;
  }

  function teamHeadRowsHTML(colRowInner, opts) {
    opts = opts || {};
    const cols = `<tr>${colRowInner}</tr>`;
    if (opts.noSections) return cols;
    return `${teamSectionHeadHTML(opts)}${cols}`;
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

  function teamSparkCellHTML(row) {
    const series = teamMockTrend(row.code);
    const first = series[0];
    const last = series[series.length - 1];
    const delta = last - first;
    const span = Math.max(...series) - Math.min(...series) || 1;
    const tone = Math.abs(delta) < span * 0.12 ? "is-flat" : delta > 0 ? "is-up" : "is-down";
    const w = 64;
    const h = 22;
    const pad = 2;
    const lo = Math.min(...series);
    const hi = Math.max(...series);
    const rng = hi - lo || 1;
    const pts = series
      .map((v, i) => {
        const x = pad + (i / (series.length - 1)) * (w - pad * 2);
        const y = h - pad - ((v - lo) / rng) * (h - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    const end = pts.slice(pts.lastIndexOf(" ") + 1).split(",");
    const tip = `Mock form · ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} over ${series.length} weeks`;
    return `<td class="col-team-spark"${tipAttr(tip)}><svg class="team-spark ${tone}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts}" /><circle cx="${end[0]}" cy="${end[1]}" r="1.8" /></svg></td>`;
  }

  function teamSortValue(row, key) {
    if (!row) return key === "player" ? "" : -Infinity;
    if (key === "player") return String(row.name || "").toLowerCase();
    if (key === "price") return Number(row.price) || 0;
    if (key === "owned") return currentOwnership(row.code) ?? -Infinity;
    if (key === "trend") {
      const series = teamMockTrend(row.code);
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

  const TEAM_STAT_RANK_FADE = 35;
  const TEAM_STAT_RANK_MAX = 50;

  function teamStatRankHTML(rank) {
    if (rank == null || rank > TEAM_STAT_RANK_MAX) return "";
    const label = `${rank}${ordinalSuffix(rank)}`;
    if (rank > TEAM_STAT_RANK_FADE) {
      return `<span class="team-stat-rank">${escapeHtml(label)}</span>`;
    }
    const t = rankBandIntensity(rank - 1, TEAM_STAT_RANK_FADE);
    if (t < 0.04) {
      return `<span class="team-stat-rank">${escapeHtml(label)}</span>`;
    }
    const mix = Math.max(0, Math.min(100, Math.round(t * 100)));
    const weight = t >= 0.5 ? 650 : 500;
    return `<span class="team-stat-rank is-top" style="color:color-mix(in srgb, hsl(var(--positive)) ${mix}%, var(--text-faint));font-weight:${weight}">${escapeHtml(label)}</span>`;
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
    const val = fmtNum(raw, col.decimals);
    return `<td class="${cls}" data-team-stat="${escapeHtml(col.key)}">
      <span class="team-stat-val">${val}</span>${teamStatRankHTML(rank)}
    </td>`;
  }

  function teamSetPieceCellHTML(row, col) {
    const mark = setPieceDisplayRank(row, col.key);
    if (mark == null) return `<td class="col-check col-team-setpiece"></td>`;
    if (mark === 1) {
      return `<td class="col-check col-team-setpiece"><span class="check-mark"${tipAttr("1st choice")}><svg class="check-mark-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg></span></td>`;
    }
    return `<td class="col-check col-team-setpiece"><span class="check-mark check-mark-rank"${tipAttr(`${mark}${ordinalSuffix(mark)} choice`)}>${mark}</span></td>`;
  }

  function teamMetricCellsHTML(row, opts) {
    const prior = teamPriorRow(row.code);
    const divideFirst = !(opts && opts.price);
    const stats = TEAM_STAT_COLS.map((col, i) =>
      teamStatCellHTML(prior, row.position, col, divideFirst && i === 0 ? "sec-divider" : "")
    ).join("");
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
      td.classList.toggle("highlight-top", win);
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
    const pinned = state.teamCompareCodes.length > 0;
    if (pinned && state.teamCompareMode) state.teamCompareMode = false;
    const on = !!state.teamCompareMode;
    const blocked = pinned || !teamIsEditable();
    el.teamCompareBtn.classList.toggle("on", on);
    el.teamCompareBtn.classList.toggle("is-disabled", blocked);
    el.teamCompareBtn.setAttribute("aria-pressed", on ? "true" : "false");
    el.teamCompareBtn.setAttribute("aria-disabled", blocked ? "true" : "false");
    el.teamCompareBtn.disabled = blocked;
    el.teamCompareBtn.title = pinned
      ? "Clear pinned players to use Compare mode"
      : !teamIsEditable()
        ? "Switch to Planner to compare and edit"
        : "Click up to 5 players to compare";
  }

  function renderTeamCompareWrap() {
    if (!el.teamCompareWrap) return;
    // Pins / compare rows live in the search card so this duplicate stays closed.
    el.teamCompareWrap.hidden = true;
    if (el.teamCompareBody) el.teamCompareBody.innerHTML = "";
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

  function syncTeamClearBtn() {
    if (!el.teamClearBtn) return;
    el.teamClearBtn.disabled = !teamIsEditable() || !state.teamSquad.length;
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

  function requestClearTeamSquad() {
    if (!teamIsEditable()) {
      showToast({ title: "Actual is read-only", message: "Switch to Planner to clear the draft.", icon: "info" });
      return;
    }
    if (!state.teamSquad.length) return;
    openConfirmModal({
      title: "Clear planner?",
      message: "This removes every player from the Planner draft. Your Actual FPL team is unchanged.",
      okLabel: "Clear planner",
    }).then((ok) => {
      if (ok) clearTeamSquad();
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
    if (!silent) {
      syncFilterChipUI();
      renderTeam();
    } else {
      syncTeamPickerChrome();
    }
  }

  function syncTeamPickerChrome() {
    const picking = state.page === "team" && !!state.teamPickerSlot;
    if (el.teamPage) el.teamPage.classList.toggle("is-picking", picking);
    if (el.teamSquadView) el.teamSquadView.hidden = picking;
    if (el.teamPickerView) el.teamPickerView.hidden = !picking;
    syncTeamSearchHost();
    const hideSidebar = state.page === "schedule" || state.page === "markets" || state.page === "feed" || (state.page === "team" && !picking);
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
  }

  function applyTeamPickerFilters(rows) {
    const q = (state.search || "").trim().toLowerCase();
    const lock = state.teamPickerSlot && state.teamPickerSlot.position;
    const inSquad = new Set(state.teamSquad.map((s) => s.code));
    const replaceCode = state.teamPickerSlot && state.teamPickerSlot.replaceCode;
    return rows.filter((r) => {
      if (r.code == null) return false;
      if (inSquad.has(r.code) && r.code !== replaceCode) return false;
      if (lock && r.position !== lock) return false;
      if (!lock && state.posFilter.size && !state.posFilter.has(r.position)) return false;
      if (state.teamFilter.size && !state.teamFilter.has(r.team)) return false;
      if (r.price < state.priceMin || r.price > state.priceMax) return false;
      if (state.setPieceTakersOnly && !isSetPieceTaker(r)) return false;
      if (state.teamAffordableOnly && !teamRowAffordable(r, replaceCode)) return false;
      if (q) {
        const hay = (r.name + " " + r.team + " " + teamNameForSeason(r.team)).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function teamHeatWindowStart() {
    return teamClampGwStart(state.teamGwStart ?? teamCurrentGw());
  }

  function teamHeatAnchorClass(gw) {
    return gw === teamHeatWindowStart() ? " is-anchor" : "";
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
    const fdrWord = fdr == null ? null : ["", "easiest", "easier", "average", "tougher", "toughest"][fdr];
    const extraTip = fixtures.slice(1).map((other) => {
      const od = Number(other.difficulty);
      const word = Number.isFinite(od) ? ` FDR ${od}` : "";
      const loc = other.ha === "H" ? "Home" : "Away";
      return `${other.opp} (${loc})${word}`;
    });
    const tip = [
      `GW${gw} ${fx.ha === "H" ? "Home" : "Away"} vs ${teamNameForSeason(fx.opp) || fx.opp}`,
      fdr != null ? `FPL difficulty ${fdr} (${fdrWord})` : "No FPL difficulty",
      extraTip.length ? `Also ${extraTip.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return `<td class="team-heat-cell${extraClass}${divide}${teamHeatAnchorClass(gw)}"${style}${tipAttr(tip)}><span class="team-heat-label">${escapeHtml(label)}</span></td>`;
  }

  function teamHeatHeadHTML() {
    return teamHeatGws()
      .map((gw, i) => `<th class="col-heat${i === 0 ? " sec-divider" : ""}${teamHeatAnchorClass(gw)}">GW${gw}</th>`)
      .join("");
  }

  function teamHeatCellsHTML(teamCode) {
    return teamHeatGws().map((gw, i) => teamHeatCellHTML(teamCode, gw, i === 0)).join("");
  }

  function syncTeamGwAnchorLine() {
    if (!el.teamPage) return;
    el.teamPage.querySelectorAll(".team-table-wrap").forEach((wrap) => {
      const view = wrap.closest("#team-squad-view, #team-picker-view");
      const th = wrap.querySelector("thead th.col-heat.is-anchor");
      if (!th || (view && view.hidden)) {
        wrap.classList.remove("has-gw-line");
        wrap.style.removeProperty("--team-gw-line-x");
        return;
      }
      wrap.classList.add("has-gw-line");
      wrap.style.setProperty("--team-gw-line-x", `${th.offsetLeft + th.offsetWidth}px`);
    });
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

  function teamRowMenuHTML(row, slot) {
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
        attrs: `data-team-note="${code}"`,
        icon: iconHTML("notebook-pen"),
        label: "Add note",
      }),
      teamRowMenuItemHTML({
        attrs: `data-team-remove="${code}"`,
        icon: iconHTML("x"),
        label: "Remove",
        danger: true,
      }),
    ].join("");
    return `<div class="settings-panel-head">
        <h4 id="team-row-menu-title">${escapeHtml(row.name)}</h4>
        <p class="settings-panel-sub">${escapeHtml(TEAM_POS_LABEL[row.position] || row.position)} · ${escapeHtml(teamNameForSeason(row.team))} · £${Number(row.price).toFixed(1)}m</p>
      </div>
      <div class="settings-panel-body team-row-menu-body">
        <section class="settings-section">
          <div class="settings-section-label">Role</div>
          ${roleItems}
        </section>
        <section class="settings-section">
          <div class="settings-section-label">Squad</div>
          ${squadItems}
        </section>
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
    return !!(el.teamRowMenu && el.teamRowMenu.classList.contains("open"));
  }

  function teamSquadPlayerRowFromNode(node) {
    if (!node || !node.closest) return null;
    const row = node.closest("#team-squad-view tr.team-player-row[data-team-code]");
    if (!row || row.closest("#team-search-results")) return null;
    return row;
  }

  function closeTeamRowMenu({ force } = {}) {
    if (!force && Date.now() - teamRowMenuOpenedAt < 350) return;
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

  function openTeamRowMenuAt(rowEl, e) {
    const code = Number(rowEl.dataset.teamCode) || rowEl.dataset.teamCode;
    const slot = state.teamSquad.find((s) => teamCodeEq(s.code, code));
    const row = slot ? teamPlayerByCode(slot.code) : null;
    if (!slot || !row || !el.teamRowMenu || !teamRowMenuAllowed()) {
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
    const note = target.closest("[data-team-note]");
    if (note) {
      closeTeamRowMenu({ force: true });
      const code = Number(note.dataset.teamNote) || note.dataset.teamNote;
      const row = teamPlayerByCode(code);
      if (row) {
        openNoteModal({
          entityType: "player",
          playerCode: row.code,
          playerName: row.name,
          teamCode: row.team,
          teamName: teamNameForSeason(row.team) || row.team,
        });
      }
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
    return `<tr class="team-empty-row" style="--enter-i:${enterI}" data-team-add-pos="${pos}" data-team-add-starter="${starter ? "1" : "0"}" role="button" tabindex="0">
      <td class="col-player" colspan="${teamDataColCount()}">
        <span class="team-add-slot">${iconHTML("plus")}<span>${escapeHtml(label)}</span></span>
      </td>
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
    const end = start + TEAM_HEAT_N - 1;
    const minStart = SCHEDULE_GW_MIN;
    const maxStart = Math.max(SCHEDULE_GW_MIN, SCHEDULE_GW_MAX - TEAM_HEAT_N + 1);
    el.teamGwNav.innerHTML = `
      <button type="button" class="ghost-btn icon-only-btn" id="team-gw-prev" ${start <= minStart ? "disabled" : ""} aria-label="Previous gameweek">${iconHTML("chevron-left")}</button>
      <span class="team-gw-range">GW${start}–GW${end}</span>
      <button type="button" class="ghost-btn icon-only-btn" id="team-gw-next" ${start >= maxStart ? "disabled" : ""} aria-label="Next gameweek">${iconHTML("chevron-right")}</button>`;
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
    el.teamBudgetBar.classList.remove("is-over", "is-low");
    el.teamBudgetBar.innerHTML = `
      <div class="team-budget-stat${bankTone ? ` ${bankTone}` : ""}">
        <span class="team-budget-label">Bank</span>
        <strong>£${itb.toFixed(1)}m</strong>
      </div>
      <div class="team-budget-stat">
        <span class="team-budget-label">Spent</span>
        <strong>£${spent.toFixed(1)}m</strong>
      </div>
      <div class="team-budget-stat">
        <span class="team-budget-label">Squad</span>
        <strong>${n}/15</strong>
      </div>
      <div class="team-budget-stat">
        <span class="team-budget-label">Formation</span>
        <strong>${escapeHtml(teamFormationLabel())}</strong>
      </div>
      <div class="team-budget-stat">
        <span class="team-budget-label">C / V</span>
        <strong>${cap ? escapeHtml(cap.name) : "–"} / ${vice ? escapeHtml(vice.name) : "–"}</strong>
      </div>
      ${
        overClub.length
          ? `<div class="team-budget-warn">${overClub.map(([t, c]) => `${t} ${c}/${TEAM_CLUB_MAX}`).join(" · ")}</div>`
          : ""
      }
      ${
        picking
          ? `<button type="button" class="ghost-btn icon-label-btn team-picker-cancel" id="team-picker-cancel" aria-label="Back to squad">
              <svg class="icon" aria-hidden="true"><use href="#i-chevron-left"/></svg>
              <span class="btn-label">Back</span>
            </button>`
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
    if (state.page === "team" && !state.teamPickerSlot) {
      el.search.setAttribute("role", "combobox");
      el.search.setAttribute("aria-autocomplete", "list");
      el.search.setAttribute("aria-controls", "team-search-body");
      el.search.setAttribute("aria-expanded", teamSearchCardOpen() ? "true" : "false");
    } else {
      el.search.removeAttribute("role");
      el.search.removeAttribute("aria-autocomplete");
      el.search.removeAttribute("aria-controls");
      el.search.removeAttribute("aria-expanded");
      el.search.removeAttribute("aria-activedescendant");
    }
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
      el.teamSearchBody.innerHTML = `<tr class="team-search-empty"><td class="col-player" colspan="${teamDataColCount()}">No players match that search.</td></tr>`;
      state.teamSearchActiveCode = null;
      if (el.search) el.search.removeAttribute("aria-activedescendant");
      return;
    }
    const cols = teamDataColCount();
    const rows = [];
    let i = 0;
    if (stashPins.length) {
      if (!pinStashOnly) {
        rows.push(
          `<tr class="section-row team-section-row is-pinned-section" style="--enter-i:${i++}"><th colspan="${cols}">${stashPins.length} pinned</th></tr>`
        );
      }
      stashPins.forEach((row) => rows.push(teamSearchRowHTML(row, teamSlotByCode(row.code), i++, { pin: true })));
    }
    if (availableVis.length) {
      if (stashPins.length) {
        rows.push(
          `<tr class="section-row team-section-row" style="--enter-i:${i++}"><th colspan="${cols}">Matches</th></tr>`
        );
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
      rows.push(
        `<tr class="section-row team-section-row" style="--enter-i:${enterI++}"><th colspan="${teamDataColCount()}">${TEAM_POS_LABEL[pos]}</th></tr>`
      );
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
    rows.push(
      `<tr class="section-row team-section-row team-bench-divider" style="--enter-i:${enterI++}"><th colspan="${teamDataColCount()}">Bench</th></tr>`
    );
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
        `${teamSortTh("player", "Player", "col-player")}${teamMetricHeadHTML()}${heatHead}`,
        { noSections: true }
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
        `${teamSortTh("player", "Player", "col-player")}${teamSortTh("price", "£m", "col-num team-price sec-divider")}${teamSortTh("owned", "Own%", "col-num col-team-owned", "Current FPL ownership")}${teamMetricHeadHTML({ setPieces: true, price: true })}${heatHead}`,
        { price: true, ownership: true, setPieces: true, noSections: true }
      );
    }
    if (!rows.length) {
      el.teamPickerBody.innerHTML = `<tr class="team-empty-row"><td class="col-player" colspan="${teamDataColCount({ price: true, ownership: true, setPieces: true })}">No players match the current filters.</td></tr>`;
      return;
    }
    el.teamPickerBody.innerHTML = rows
      .map((row, i) => {
        const heat = teamHeatCellsHTML(row.team);
        const nameHTML = `<div class="player-name-line"><span class="player-name">${escapeHtml(row.name)}</span></div>`;
        const sub = `<div class="player-cell-sub">${posBadgeHTML(row.position, { label: TEAM_POS_LABEL[row.position] })}</div>`;
        const crest = playerCrestHTML(row.team, tipAttr(teamNameForSeason(row.team)));
        const selected = state.teamCompareMode && teamCompareHas(row.code) ? " row-selected" : "";
        const selectable = state.teamCompareMode ? " row-selectable" : "";
        return `<tr class="team-picker-row${selected}${selectable}" style="--enter-i:${i}" data-team-code="${escapeHtml(String(row.code))}" data-team-pick="${escapeHtml(String(row.code))}" role="button" tabindex="0">
          <td class="col-player">${playerIdentityHTML(crest, nameHTML, sub)}</td>
          <td class="col-num team-price sec-divider">${Number(row.price).toFixed(1)}</td>
          <td class="col-num col-team-owned">${fmtOwnedPct(currentOwnership(row.code))}</td>
          ${teamMetricCellsHTML(row, { setPieces: true, price: true })}
          ${heat}
        </tr>`;
      })
      .join("");
  }

  function syncTeamPickerChips() {
    syncFilterChipUI();
  }

  function renderTeam() {
    if (!el.teamPage) return;
    if (state.teamGwStart == null) state.teamGwStart = teamClampGwStart(teamCurrentGw());
    normalizeTeamRoles();
    state.teamHoverCompareCode = null;
    hideTeamRowActionsPopup();
    syncTeamModeUI();
    const picking = !!state.teamPickerSlot;
    el.teamPage.classList.toggle("is-comparing", !!state.teamCompareMode);
    syncTeamCompareBtn();
    syncTeamPickerChrome();
    syncTeamAffordableCheck();
    syncTeamClearBtn();
    renderTeamGwNav();
    renderTeamBudgetBar();
    renderTeamSubBar();
    renderTeamCompareWrap();
    syncTeamPickerChips();
    if (picking) renderTeamPicker();
    else {
      renderTeamSearchResults();
      renderTeamSquadTables();
    }
    upgradeNativeTitles(el.teamPage);
    syncTeamGwAnchorLine();
    paintTeamCompareWinners();
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
    if (e.target.closest("#team-compare-btn")) {
      if (!teamIsEditable()) {
        showToast({ title: "Actual is read-only", message: "Switch to Planner to compare and edit.", icon: "info" });
        return;
      }
      if (state.teamCompareCodes.length) {
        showToast({
          title: "Compare unavailable",
          message: "Clear pinned players first — search pins and Compare mode clash.",
          icon: "scale",
        });
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
      renderTeam();
      return;
    }
    const pick = e.target.closest("[data-team-pick]");
    if (pick) {
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
    if (filled && teamRowMenuAllowed() && !hasFineHover()) {
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
  if (el.teamRowMenu) {
    el.teamRowMenu.addEventListener("click", (e) => {
      e.stopPropagation();
      applyTeamRowAction(e.target);
    });
    el.teamRowMenu.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  document.addEventListener("contextmenu", (e) => {
    if (e.target.closest("#note-modal, #confirm-modal, #team-row-menu, #note-context-menu, input, textarea, select")) {
      return;
    }
    const squadRow = teamSquadPlayerRowFromNode(e.target);
    if (squadRow && state.page === "team" && teamRowMenuAllowed()) {
      e.preventDefault();
      closeNoteContextMenu();
      openTeamRowMenuAt(squadRow, e);
      return;
    }
    const target = resolveNoteTargetFromNode(e.target);
    if (!target) return;
    e.preventDefault();
    openNoteContextMenuAt(target, e.clientX, e.clientY);
  });
  document.addEventListener("click", (e) => {
    if (el.teamRowMenu && el.teamRowMenu.contains(e.target)) return;
    closeTeamRowMenu();
  });
  document.addEventListener(
    "scroll",
    (e) => {
      if (teamRowMenuIsOpen()) {
        if (el.teamRowMenu && e.target && el.teamRowMenu.contains(e.target)) return;
        closeTeamRowMenu({ force: true });
      }
      if (el.noteContextMenu && el.noteContextMenu.classList.contains("open")) {
        if (el.noteContextMenu.contains(e.target)) return;
        closeNoteContextMenu();
      }
    },
    true
  );
  window.addEventListener("resize", () => {
    closeTeamRowMenu({ force: true });
    closeNoteContextMenu();
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
  syncTeamClearBtn();

  // ---------------------------------------------------------------------
  // Feed page — player-mention cards from annotated social_data.js
  // ---------------------------------------------------------------------
  const FEED_HISTORY_DAYS = 7;

  const INDEXABLE_FEED_BASES = new Set([
    "unique_full_alias",
    "unique_lastname",
    "team_context",
    "team_position_context",
    "team_alias",
    "popularity_default",
  ]);

  let feedPlayerByCodeCache = null;

  function feedPlayerPhotoUrl(code) {
    if (code == null || code === "") return "";
    // FPL bootstrap `photo` is "{code}.jpg"; current PL CDN path (25/26) is
    // premierleague25/…/{code}.png (no "p" prefix). Older p{code} 250x250
    // URLs 403 for many new/promoted players (e.g. Igor Jesus).
    return `https://resources.premierleague.com/premierleague25/photos/players/110x140/${code}.png`;
  }

  function feedPlayerCatalog() {
    if (feedPlayerByCodeCache) return feedPlayerByCodeCache;
    const map = new Map();
    const combined = (DATA.players && DATA.players.combined) || [];
    for (const row of combined) {
      if (row && row.code != null) map.set(Number(row.code), { ...row });
    }
    for (const row of DATA.nextSeasonPlayers || []) {
      if (!row || row.code == null) continue;
      const key = Number(row.code);
      const prev = map.get(key);
      if (prev) {
        // Prefer 2025/26 stats; overlay current squad identity when present.
        if (row.team) prev.team = row.team;
        if (row.position) prev.position = row.position;
        if (row.price != null) prev.price = row.price;
        if (row.name) prev.name = row.name;
      } else {
        map.set(key, { ...row });
      }
    }
    feedPlayerByCodeCache = map;
    return map;
  }

  function feedLookupPlayer(code) {
    if (code == null) return null;
    return feedPlayerCatalog().get(Number(code)) || null;
  }

  function localDayKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  const FEED_POST_TYPES = [
    { key: "original", label: "Original" },
    { key: "reply", label: "Reply" },
    { key: "quote", label: "Quote" },
    { key: "retweet", label: "Retweet" },
  ];

  const FEED_RANGE_LABELS = {
    today: "Today",
    "3d": "the last 3 days",
    "7d": "the past week",
  };

  function feedTypeFilterIsDefault() {
    return state.feedTypeFilter.size === 0;
  }

  function feedRangeDayCount(range = state.feedRange) {
    if (range === "3d") return 3;
    if (range === "7d") return FEED_HISTORY_DAYS;
    return 1;
  }

  function feedRangeDayKeys(range = state.feedRange, now = new Date()) {
    const n = feedRangeDayCount(range);
    const keys = [];
    for (let offset = 0; offset < n; offset++) {
      keys.push(
        localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset))
      );
    }
    return keys;
  }

  function feedPostKind(post) {
    const refs = post && post.referencedTweets;
    const types = new Set(
      (Array.isArray(refs) ? refs : [])
        .map((r) => (r && r.type) || "")
        .filter(Boolean)
    );
    if (types.has("retweeted")) return "retweet";
    if (types.has("quoted")) return "quote";
    if (types.has("replied_to") || (post && post.inReplyToUserId)) return "reply";
    return "original";
  }

  function feedFiltersActive() {
    return (
      state.feedRange !== "today" ||
      !feedTypeFilterIsDefault() ||
      state.feedTeamFilter.size > 0
    );
  }

  function syncFeedFiltersToggle() {
    if (!el.feedFiltersToggle) return;
    const active = feedFiltersActive();
    const panelOpen =
      el.feedControls &&
      !el.feedControls.classList.contains("collapsed") &&
      el.feedControls.style.display !== "none";
    const open = panelOpen || (mobileSheetOpen && mobileSheetKey === "feed-filters");
    el.feedFiltersToggle.classList.toggle("on", open || active);
    const label = open ? "Hide feed filters" : "Show feed filters";
    el.feedFiltersToggle.title = active && !open ? "Feed filters (active)" : label;
    el.feedFiltersToggle.setAttribute(
      "aria-label",
      active && !open ? "Show feed filters (filters active)" : label
    );
    el.feedFiltersToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function setFeedFiltersOpen(open) {
    if (!el.feedControls || !el.feedFiltersToggle) return;
    if (!hasFineHover()) {
      if (open) {
        openMobileSheetHost({
          title: "Feed filters",
          key: "feed-filters",
          hostEl: el.feedControls,
          prepare(host) {
            host.style.display = "";
            host.hidden = false;
            host.classList.remove("collapsed");
            buildFeedTypeChips();
            buildFeedTeamChips();
            syncFeedRangeSeg();
          },
          cleanup(host) {
            host.classList.add("collapsed");
            host.style.display = state.page === "feed" ? "" : "none";
          },
        });
        syncFeedFiltersToggle();
      } else if (mobileSheetKey === "feed-filters") {
        closeMobileSheet();
      } else {
        el.feedControls.classList.add("collapsed");
        syncFeedFiltersToggle();
      }
      return;
    }
    el.feedControls.style.display = "";
    el.feedControls.hidden = false;
    el.feedControls.classList.toggle("collapsed", !open);
    if (open) {
      buildFeedTypeChips();
      buildFeedTeamChips();
      syncFeedRangeSeg();
      requestAnimationFrame(() => syncSegThumb(el.feedRangeSeg, { animate: false }));
    }
    syncFeedFiltersToggle();
  }

  function syncFeedRangeSeg() {
    if (!el.feedRangeSeg) return;
    $$("#feed-range-seg button[data-feed-range]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.feedRange === state.feedRange);
    });
    syncSegThumb(el.feedRangeSeg, { animate: false });
  }

  function buildFeedTypeChips() {
    const root = el.feedTypeFilters;
    if (!root) return;
    root.innerHTML = "";
    for (const spec of FEED_POST_TYPES) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip" + (state.feedTypeFilter.has(spec.key) ? " active" : "");
      chip.dataset.feedType = spec.key;
      chip.textContent = spec.label;
      chip.addEventListener("click", () => {
        toggleSetValue(state.feedTypeFilter, spec.key);
        chip.classList.toggle("active", state.feedTypeFilter.has(spec.key));
        syncFeedFiltersToggle();
        renderFeed();
      });
      root.appendChild(chip);
    }
  }

  function buildFeedTeamChips() {
    const root = el.feedTeamFilters;
    if (!root) return;
    root.innerHTML = "";
    teamCodesForSeason().forEach((code) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className =
        "chip team-chip" + (state.feedTeamFilter.has(code) ? " active" : "");
      chip.dataset.feedTeam = code;
      chip.innerHTML = `${badgeHTML(code)}${escapeHtml(code)}`;
      setTip(chip, teamNameForSeason(code));
      chip.addEventListener("click", () => {
        toggleSetValue(state.feedTeamFilter, code);
        chip.classList.toggle("active", state.feedTeamFilter.has(code));
        syncFeedFiltersToggle();
        renderFeed();
      });
      root.appendChild(chip);
    });
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

  function loadClockFormat() {
    try {
      const raw = localStorage.getItem(CLOCK_FORMAT_KEY);
      if (raw === "12" || raw === "24") return raw;
    } catch {
      /* private browsing */
    }
    return detectLocaleClockFormat();
  }

  let clockFormat = loadClockFormat();

  function localeTimeOptions() {
    if (clockFormat === "24") {
      return { hour: "2-digit", minute: "2-digit", hour12: false };
    }
    return { hour: "numeric", minute: "2-digit", hour12: true };
  }

  function formatFeedTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return escapeHtml(String(iso));
    const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return "just now";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
    if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d`;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  /** 0 = just now, 1 = FEED_HISTORY_DAYS (or older). Drives feed-time color mix. */
  function feedTimeAgeProgress(iso) {
    if (!iso) return 1;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 1;
    const ageMs = Math.max(0, Date.now() - d.getTime());
    const maxMs = FEED_HISTORY_DAYS * 86400 * 1000;
    return Math.min(1, ageMs / maxMs);
  }

  function formatFeedAbsolute(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      ...localeTimeOptions(),
    });
  }

  function feedStatDisplay(value, decimals) {
    if (value == null || value === "" || Number.isNaN(Number(value))) return "—";
    const n = Number(value);
    if (decimals === 0) return String(Math.round(n));
    return n.toFixed(decimals);
  }

  function feedPosStatSpecs(position) {
    const pos = String(position || "").toUpperCase();
    if (pos === "GK") {
      return [
        { key: "saves", label: "Saves", decimals: 0 },
        { key: "cleanSheets", label: "CS", decimals: 0 },
        { key: "goalsConceded", label: "GC", decimals: 0 },
      ];
    }
    if (pos === "DEF") {
      return [
        { key: "cleanSheets", label: "CS", decimals: 0 },
        { key: "goalsConceded", label: "GC", decimals: 0 },
        { key: "defCon", label: "DC", decimals: 0 },
        { key: "__gi", label: "G+A", decimals: 0 },
      ];
    }
    if (pos === "MID") {
      return [
        { key: "goals", label: "G", decimals: 0 },
        { key: "assists", label: "A", decimals: 0 },
        { key: "xgi", label: "xGI", decimals: 1 },
        { key: "defCon", label: "DC", decimals: 0 },
      ];
    }
    // FWD (default)
    return [
      { key: "goals", label: "G", decimals: 0 },
      { key: "assists", label: "A", decimals: 0 },
      { key: "xg", label: "xG", decimals: 1 },
      { key: "xa", label: "xA", decimals: 1 },
    ];
  }

  function feedRowStatValue(row, key) {
    if (!row) return null;
    if (key === "__gi") return (Number(row.goals) || 0) + (Number(row.assists) || 0);
    const v = row[key];
    return v == null ? null : v;
  }

  // Competition ranks among same-position players (2025/26 combined). Cached
  // per position for the Feed stat chips.
  let feedStatRankCache = null;

  function feedStatRankMaps(position) {
    const pos = String(position || "").toUpperCase();
    if (!pos) return {};
    if (!feedStatRankCache) feedStatRankCache = new Map();
    if (feedStatRankCache.has(pos)) return feedStatRankCache.get(pos);

    const pool = ((DATA.players && DATA.players.combined) || []).filter(
      (r) => String(r.position || "").toUpperCase() === pos
    );
    const maps = {};
    for (const spec of feedPosStatSpecs(pos)) {
      const lowerBetter = LOWER_BETTER.has(spec.key);
      const entries = pool
        .map((r) => {
          if (r.code == null) return null;
          const val = feedRowStatValue(r, spec.key);
          if (val == null || Number.isNaN(Number(val))) return null;
          return { key: String(r.code), val: Number(val) };
        })
        .filter(Boolean)
        .sort((a, b) => (lowerBetter ? a.val - b.val : b.val - a.val));
      const ranks = new Map();
      let i = 0;
      while (i < entries.length) {
        let j = i + 1;
        while (j < entries.length && entries[j].val === entries[i].val) j += 1;
        for (let k = i; k < j; k += 1) ranks.set(entries[k].key, i + 1);
        i = j;
      }
      maps[spec.key] = { ranks, n: entries.length };
    }
    feedStatRankCache.set(pos, maps);
    return maps;
  }

  function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function linkifyFeedText(text) {
    const raw = String(text || "");
    let html = escapeHtml(raw);
    html = html.replace(/https?:\/\/[^\s<]+/g, (url) => {
      const href = escapeHtml(url);
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
    });
    html = html.replace(
      /(^|[\s(])@([A-Za-z0-9_]{1,15})\b/g,
      (_, pre, handle) =>
        `${pre}<a href="https://x.com/${escapeHtml(handle)}" target="_blank" rel="noopener noreferrer">@${escapeHtml(handle)}</a>`
    );
    return html;
  }

  function feedPlayerMentionAliases(card, post) {
    const aliases = new Set();
    const add = (value) => {
      const s = String(value || "").trim();
      if (s.length >= 2) aliases.add(s);
    };
    add(card && card.name);
    const code = card && card.code != null ? String(card.code) : "";
    const entities = (post && post.analysis && post.analysis.entities) || [];
    for (const e of entities) {
      if (!e || e.type !== "player" || !e.resolved) continue;
      if (code && String(e.code) !== code) continue;
      add(e.mention);
      add(e.name);
    }
    return [...aliases].sort((a, b) => b.length - a.length);
  }

  function highlightFeedPlayerMentions(escapedHtml, aliases) {
    if (!escapedHtml || !aliases || !aliases.length) return escapedHtml;
    const unique = [];
    const seen = new Set();
    for (const alias of aliases) {
      const key = alias.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(alias);
    }
    if (!unique.length) return escapedHtml;
    const pattern = unique.map(escapeRegExp).join("|");
    // Avoid matching inside words (Haaland in FooHaaland) while allowing hyphens.
    const re = new RegExp(`(?<![A-Za-z0-9_])(?:${pattern})(?![A-Za-z0-9_])`, "gi");
    return escapedHtml.replace(
      re,
      (match) => `<mark class="feed-player-mention">${match}</mark>`
    );
  }

  function formatFeedPostBody(text, card, post) {
    let html = escapeHtml(String(text || ""));
    html = highlightFeedPlayerMentions(html, feedPlayerMentionAliases(card, post));
    html = html.replace(/https?:\/\/[^\s<]+/g, (url) => {
      // Skip URLs that were already wrapped or sit inside a mark/tag.
      if (url.includes("<")) return url;
      const href = escapeHtml(url);
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
    });
    // Don't rewrite @handles that landed inside a highlight mark.
    html = html.replace(
      /(^|[\s(])@([A-Za-z0-9_]{1,15})\b/g,
      (full, pre, handle, offset, str) => {
        const before = str.slice(Math.max(0, offset - 24), offset);
        if (/<mark\b[^>]*>[^<]*$/i.test(before)) return full;
        return `${pre}<a href="https://x.com/${escapeHtml(handle)}" target="_blank" rel="noopener noreferrer">@${escapeHtml(handle)}</a>`;
      }
    );
    return html;
  }

  function feedPostsFiltered(posts, { range = state.feedRange } = {}) {
    const keys = new Set(feedRangeDayKeys(range));
    return (posts || []).filter((post) => {
      if (!post.createdAt) return false;
      const created = new Date(post.createdAt);
      if (Number.isNaN(created.getTime())) return false;
      if (!keys.has(localDayKey(created))) return false;
      if (state.feedTypeFilter.size && !state.feedTypeFilter.has(feedPostKind(post))) {
        return false;
      }
      return true;
    });
  }

  function computeFeedMentionCards(posts, { range = state.feedRange } = {}) {
    const scopedPosts = feedPostsFiltered(posts, { range });
    const byCode = new Map();

    for (const post of scopedPosts) {
      const analysis = post.analysis || {};
      // One credit per player per post — repeat name/entity hits must not inflate.
      const seenCodes = new Set();
      for (const e of analysis.entities || []) {
        if (!e || e.type !== "player" || !e.resolved || e.code == null) continue;
        const basis = e.matchBasis || "";
        if (basis && !INDEXABLE_FEED_BASES.has(basis)) continue;
        const key = String(e.code);
        if (seenCodes.has(key)) continue;
        seenCodes.add(key);

        let bucket = byCode.get(key);
        if (!bucket) {
          bucket = {
            code: e.code,
            name: e.name || e.mention,
            team: e.team,
            position: e.position,
            postIds: new Set(),
            latestAt: "",
          };
          byCode.set(key, bucket);
        }
        bucket.name = e.name || bucket.name;
        bucket.team = e.team || bucket.team;
        bucket.position = e.position || bucket.position;
        bucket.postIds.add(String(post.id));
        if (String(post.createdAt || "") > bucket.latestAt) {
          bucket.latestAt = post.createdAt || "";
        }
      }
    }

    const cards = [...byCode.values()]
      .map((bucket) => {
        const row = feedLookupPlayer(bucket.code);
        const name = (row && row.name) || bucket.name;
        const team = (row && (row.newTeam || row.team)) || bucket.team || "";
        const position =
          (row && (row.newPosition || row.position)) || bucket.position || "";
        const price =
          row && row.price2627 != null
            ? row.price2627
            : row && row.price != null
              ? row.price
              : null;
        const pts = row && row.pts != null ? row.pts : null;
        return {
          code: bucket.code,
          name,
          team,
          position,
          price,
          pts,
          row,
          posts: bucket.postIds.size,
          postIds: [...bucket.postIds],
          latestAt: bucket.latestAt,
        };
      })
      .sort((a, b) => sortFeedCards(a, b));

    return {
      range,
      scopedPostCount: scopedPosts.length,
      cards,
    };
  }

  function sortFeedCards(a, b) {
    const byRecent = () =>
      String(b.latestAt || "").localeCompare(String(a.latestAt || ""));
    const byVolume = () => b.posts - a.posts;
    const byName = () => String(a.name || "").localeCompare(String(b.name || ""));
    // Volume desc: most mentions, then most recent, then name.
    return byVolume() || byRecent() || byName();
  }

  function feedPostKindLabel(kind) {
    const hit = FEED_POST_TYPES.find((t) => t.key === kind);
    return (hit && hit.label) || "Original";
  }

  function feedQuoteRowsHTML(postIds, postsById, card) {
    const rows = (postIds || [])
      .map((id) => postsById.get(String(id)))
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    if (!rows.length) {
      return `<p class="feed-trend-empty">No linked posts in the current window.</p>`;
    }
    return rows
      .map((post, i) => {
        const handle = post.handle || "";
        const name = post.authorName || handle;
        const url = post.url || `https://x.com/${handle}/status/${post.id}`;
        const body = formatFeedPostBody(post.text || "", card, post);
        const kind = feedPostKind(post);
        const kindLabel = feedPostKindLabel(kind);
        const avatar = post.authorAvatarUrl
          ? `<img class="feed-source-avatar" src="${escapeHtml(post.authorAvatarUrl)}" alt="" width="32" height="32" loading="lazy" />`
          : `<span class="feed-source-avatar feed-source-avatar-fallback" aria-hidden="true">${escapeHtml((handle || "?").slice(0, 1).toUpperCase())}</span>`;
        return `<article class="feed-source-row" style="--enter-i:${i}">
          <header class="feed-source-head">
            ${avatar}
            <div class="feed-source-identity">
              <div class="feed-source-name-line">
                <span class="feed-source-author">${escapeHtml(name)}</span>
              </div>
              <div class="feed-source-meta-line">
                <a class="feed-handle" href="https://x.com/${escapeHtml(handle)}" target="_blank" rel="noopener noreferrer">@${escapeHtml(handle)}</a>
                <span class="feed-meta-dot" aria-hidden="true">·</span>
                <time class="feed-time" style="--feed-age:${feedTimeAgeProgress(post.createdAt).toFixed(3)}" datetime="${escapeHtml(post.createdAt || "")}"${tipAttr(formatFeedAbsolute(post.createdAt))}>${formatFeedTime(post.createdAt)}</time>
              </div>
            </div>
            <a class="feed-source-open icon-only-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="Open post"${tipAttr("Open post")}>${iconHTML("arrow-up-right")}</a>
          </header>
          <div class="feed-source-text">${body || "<span class='feed-trend-empty'>No text</span>"}</div>
          <footer class="feed-source-foot">
            <span class="feed-post-kind feed-post-kind-${escapeHtml(kind)}">${escapeHtml(kindLabel)}</span>
          </footer>
        </article>`;
      })
      .join("");
  }

  function feedPlayerCardHTML(card, postsById, enterIndex) {
    const initials = String(card.name || "?")
      .split(/[\s.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?";
    const photo = feedPlayerPhotoUrl(card.code);
    const teamLabel = card.team ? teamNameForSeason(card.team) : "";
    const badge = card.team
      ? badgeHTML(card.team, "feed-player-team-badge").replace(
          "<img ",
          `<img${tipAttr(teamLabel)} `
        )
      : "";
    const metaBits = [];
    if (card.position) metaBits.push(posBadgeHTML(card.position));
    if (card.price != null) metaBits.push(`<span>£${Number(card.price).toFixed(1)}m</span>`);
    if (card.pts != null) metaBits.push(`<span>${Number(card.pts)} Pts</span>`);
    const rankMaps = feedStatRankMaps(card.position);
    const posLabel = String(card.position || "").toUpperCase();
    const stats = feedPosStatSpecs(card.position)
      .map((spec) => {
        const raw = feedRowStatValue(card.row, spec.key);
        const shown = feedStatDisplay(raw, spec.decimals);
        const rankInfo = rankMaps[spec.key];
        const rank =
          card.code != null && rankInfo
            ? rankInfo.ranks.get(String(card.code))
            : null;
        const rankHtml =
          rank != null
            ? `<span class="feed-player-stat-rank" title="Rank among ${escapeHtml(posLabel)}s (${rank} of ${rankInfo.n})">#${rank}</span>`
            : "";
        return `<div class="feed-player-stat">
          <span class="feed-player-stat-label">${escapeHtml(spec.label)}</span>
          <span class="feed-player-stat-value">${escapeHtml(shown)}</span>
          ${rankHtml}
        </div>`;
      })
      .join("");
    const photoBlock = photo
      ? `<img class="feed-player-photo" src="${escapeHtml(photo)}" alt="" width="72" height="72" loading="lazy" data-initials="${escapeHtml(initials)}" />`
      : `<span class="feed-player-photo feed-player-photo-fallback" aria-hidden="true">${escapeHtml(initials)}</span>`;
    const teamAccent = TEAM_SCATTER_ACCENT[card.team] || "";
    const accentStyle = teamAccent ? `--feed-team-accent:${teamAccent};` : "";

    return `<article class="rankings-card feed-player-card" id="feed-card-${escapeHtml(String(card.code))}" data-feed-code="${escapeHtml(String(card.code))}" data-team="${escapeHtml(String(card.team || ""))}" style="--enter-i:${enterIndex};${accentStyle}">
      <div class="feed-player-card-top">
        <div class="feed-player-identity">
          <div class="feed-player-photo-wrap">
            ${photoBlock}
            ${badge}
          </div>
          <div class="feed-player-title">
            <h3 class="feed-player-name"><span class="feed-player-name-text">${escapeHtml(card.name)}</span></h3>
            <p class="feed-player-meta">${metaBits.join("")}</p>
          </div>
        </div>
        <div class="feed-player-stats">${stats}</div>
      </div>
      <div class="feed-source-list feed-player-quotes">${feedQuoteRowsHTML(card.postIds, postsById, card)}</div>
    </article>`;
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
    const view = currentMarketsCardView();
    const label = view.label;
    const sheetOpen = mobileSheetOpen && mobileSheetKey === "markets-view";
    const marketsMobile = preferMobileSheet() && state.page === "markets";
    const marketsDesktop = !preferMobileSheet() && state.page === "markets";
    if (el.pageMarkets) {
      el.pageMarkets.setAttribute(
        "aria-expanded",
        el.marketsTabWrap?.classList.contains("open") ? "true" : "false"
      );
    }
    if (el.marketsViewToolbarLabel) el.marketsViewToolbarLabel.textContent = label;
    if (el.marketsViewToolbarBtn) {
      el.marketsViewToolbarBtn.title = label;
      el.marketsViewToolbarBtn.setAttribute("aria-label", `Matchup card view: ${label}`);
      el.marketsViewToolbarBtn.setAttribute("aria-expanded", sheetOpen ? "true" : "false");
    }
    if (el.marketsViewToolbar) {
      el.marketsViewToolbar.hidden = !marketsMobile;
    }
    // Sliders live under Markets only: header on desktop, right of the
    // mobile view dropdown. Always park back in the Markets header when
    // leaving the page so it cannot leak into xData / other toolbars.
    if (el.marketsSlidersToggle && el.marketsHeaderActions) {
      if (marketsMobile && el.marketsViewToolbar) {
        if (el.marketsSlidersToggle.previousElementSibling !== el.marketsViewToolbar) {
          el.marketsViewToolbar.after(el.marketsSlidersToggle);
        }
        el.marketsSlidersToggle.hidden = false;
      } else {
        if (el.marketsSlidersToggle.parentElement !== el.marketsHeaderActions) {
          el.marketsHeaderActions.appendChild(el.marketsSlidersToggle);
        }
        el.marketsSlidersToggle.hidden = !marketsDesktop;
      }
    }
    // Keep Markets mobile chrome in sync on resize / pointer changes.
    if (el.subtoolbar && state.page === "markets") {
      el.subtoolbar.style.display = preferMobileSheet() ? "" : "none";
      el.subtoolbar.classList.toggle("is-markets-mobile", preferMobileSheet());
      if (el.statsToolbarStart) el.statsToolbarStart.style.display = "none";
      if (el.statsToolbarActions) {
        el.statsToolbarActions.style.display = preferMobileSheet() ? "" : "none";
      }
    }
    buildMarketsViewMenu();
  }

  function clearMarketsViewMenuPosition() {
    if (!el.marketsViewMenu) return;
    el.marketsViewMenu.classList.remove("is-fixed");
    el.marketsViewMenu.style.left = "";
    el.marketsViewMenu.style.top = "";
    el.marketsViewMenu.style.minWidth = "";
  }

  function positionMarketsViewMenuFixed() {
    if (!el.marketsViewMenu || !el.pageMarkets) return;
    const r = el.pageMarkets.getBoundingClientRect();
    const menuWidth = Math.max(148, el.marketsViewMenu.offsetWidth || 148);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - menuWidth - 8));
    el.marketsViewMenu.classList.add("is-fixed");
    el.marketsViewMenu.style.left = `${left}px`;
    el.marketsViewMenu.style.top = `${r.bottom + 6}px`;
    el.marketsViewMenu.style.minWidth = `${Math.max(menuWidth, r.width)}px`;
  }

  function setMarketsViewMenuOpen(open) {
    if (!el.marketsTabWrap || !el.pageMarkets) return;
    el.marketsTabWrap.classList.toggle("open", open);
    el.pageMarkets.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      if (tabMenuNeedsFixedPosition()) {
        requestAnimationFrame(() => {
          positionMarketsViewMenuFixed();
          requestAnimationFrame(positionMarketsViewMenuFixed);
        });
      } else {
        clearMarketsViewMenuPosition();
      }
    } else {
      clearMarketsViewMenuPosition();
    }
  }

  function buildMarketsViewMenu() {
    if (!el.marketsViewMenu) return;
    const views = marketsCardViews();
    const active = currentMarketsCardView();
    el.marketsViewMenu.innerHTML = "";
    views.forEach((v) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "menuitem");
      btn.className = "page-tab-menu-item";
      btn.textContent = v.label;
      btn.classList.toggle("active", v.key === active.key);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        setMarketsViewMenuOpen(false);
        setMarketsCardView(v.key, { rerender: false });
        setPage("markets");
      });
      el.marketsViewMenu.appendChild(btn);
    });
  }

  function openMarketsViewSheet() {
    const views = marketsCardViews();
    const active = currentMarketsCardView();
    const html = `<div class="mobile-sheet-cat-list" role="menu" aria-label="Matchup card view">${views
      .map(
        (v) =>
          `<button type="button" role="menuitem" class="page-tab-menu-item${
            v.key === active.key ? " active" : ""
          }" data-markets-view="${escapeHtml(v.key)}">${escapeHtml(v.label)}</button>`
      )
      .join("")}</div>`;
    openMobileSheet({ title: "Matchup view", html, key: "markets-view" });
    if (el.marketsViewToolbarBtn) el.marketsViewToolbarBtn.setAttribute("aria-expanded", "true");
    if (!el.mobileSheetBody) return;
    el.mobileSheetBody.querySelectorAll("[data-markets-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-markets-view");
        if (!key) return;
        closeMobileSheet();
        setMarketsCardView(key);
      });
    });
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

  function renderMarkets() {
    const root = el.marketsGrid;
    if (!root) return;
    const fixtures = MARKETS.fixtures || [];
    syncMarketsCompareSeg();
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

  function feedCardMatchesQuery(card, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    const teamName = card.team ? teamNameForSeason(card.team) : "";
    const hay = [card.name, card.team, teamName, card.position]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  }

  function feedCardMatchesTeamFilter(card) {
    if (!state.feedTeamFilter.size) return true;
    return card.team && state.feedTeamFilter.has(card.team);
  }

  function feedSearchWiderRangeHits(posts, query) {
    if (!(state.feedRange === "today" || state.feedRange === "3d")) return 0;
    const weekMention = computeFeedMentionCards(posts, { range: "7d" });
    return weekMention.cards.filter(
      (card) => feedCardMatchesTeamFilter(card) && feedCardMatchesQuery(card, query)
    ).length;
  }

  function feedWidenRangeHintHTML(count) {
    if (!count) return "";
    const label = count === 1 ? "1 match" : `${count} matches`;
    return `<p class="feed-empty-widen">
      <button type="button" class="feed-widen-range" data-feed-widen="7d">
        ${escapeHtml(label)} in the past week — show Past week
      </button>
    </p>`;
  }

  const FEED_TREEMAP_MAX = 14;
  const FEED_TREEMAP_W = 1000;
  const FEED_TREEMAP_H = 220;

  function feedTreemapIsCompact() {
    try {
      return window.matchMedia("(max-width: 640px)").matches;
    } catch {
      return false;
    }
  }

  function feedTreemapShortName(card) {
    const name = String(card.name || "").trim();
    if (!name) return "?";
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0];
    return parts[parts.length - 1];
  }

  function accentLuminance(hex) {
    const raw = String(hex || "").replace("#", "");
    if (raw.length !== 6) return 0.5;
    const r = parseInt(raw.slice(0, 2), 16) / 255;
    const g = parseInt(raw.slice(2, 4), 16) / 255;
    const b = parseInt(raw.slice(4, 6), 16) / 255;
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function feedTreemapTextColor(accent) {
    return accentLuminance(accent) > 0.55 ? "#111" : "#fff";
  }

  // Squarified treemap (Bruls et al.) — layout only in abstract units.
  function squarifyFeedMentions(items, width, height) {
    const total = items.reduce((sum, d) => sum + d.value, 0);
    if (!total || width <= 0 || height <= 0) return [];
    const nodes = items.map((d) => ({
      ...d,
      area: (d.value / total) * width * height,
    }));
    const out = [];
    let x0 = 0;
    let y0 = 0;
    let x1 = width;
    let y1 = height;
    let row = [];
    let i = 0;

    const shortest = () => Math.min(x1 - x0, y1 - y0);
    const worst = (areas, side) => {
      if (!areas.length) return Infinity;
      const s = areas.reduce((a, b) => a + b, 0);
      const mx = Math.max(...areas);
      const mn = Math.min(...areas);
      return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
    };

    const flush = (rowNodes) => {
      if (!rowNodes.length) return;
      const sum = rowNodes.reduce((a, b) => a + b.area, 0);
      const wide = x1 - x0 >= y1 - y0;
      if (wide) {
        const rw = sum / (y1 - y0);
        let y = y0;
        for (const node of rowNodes) {
          const h = node.area / rw;
          out.push({ ...node, x: x0, y, w: rw, h });
          y += h;
        }
        x0 += rw;
      } else {
        const rh = sum / (x1 - x0);
        let x = x0;
        for (const node of rowNodes) {
          const w = node.area / rh;
          out.push({ ...node, x, y: y0, w, h: rh });
          x += w;
        }
        y0 += rh;
      }
    };

    while (i < nodes.length) {
      const side = shortest();
      const next = nodes[i];
      const rowAreas = row.map((n) => n.area);
      if (!row.length || worst(rowAreas.concat(next.area), side) <= worst(rowAreas, side)) {
        row.push(next);
        i += 1;
      } else {
        flush(row);
        row = [];
      }
    }
    flush(row);
    return out;
  }

  function clearFeedTreemap() {
    if (!el.feedTreemap) return;
    el.feedTreemap.hidden = true;
    el.feedTreemap.classList.remove("is-scrollable");
    el.feedTreemap.innerHTML = "";
  }

  function renderFeedTreemap(cards, rangeLabel) {
    if (!el.feedTreemap) return;
    // Desktop/tablet only — mobile cards already carry the mention list.
    if (feedTreemapIsCompact()) {
      clearFeedTreemap();
      return;
    }
    const selected = state.feedSelectedCode != null ? String(state.feedSelectedCode) : "";
    const top = (cards || [])
      .filter((c) => c && c.posts > 0)
      .slice(0, FEED_TREEMAP_MAX)
      .map((c) => ({
        code: c.code,
        name: c.name,
        shortName: feedTreemapShortName(c),
        team: c.team,
        value: c.posts,
      }));
    if (top.length < 2) {
      clearFeedTreemap();
      return;
    }

    const totalMentions = top.reduce((s, d) => s + d.value, 0);
    const layoutW = FEED_TREEMAP_W;
    const layoutH = FEED_TREEMAP_H;
    const layout = squarifyFeedMentions(top, layoutW, layoutH);
    const selectedCard = selected
      ? top.find((c) => String(c.code) === selected)
      : null;
    const cells = layout
      .map((cell, i) => {
        const accent = TEAM_SCATTER_ACCENT[cell.team] || "#6b7280";
        const text = feedTreemapTextColor(accent);
        const left = (cell.x / layoutW) * 100;
        const topPct = (cell.y / layoutH) * 100;
        const width = (cell.w / layoutW) * 100;
        const height = (cell.h / layoutH) * 100;
        const pct = totalMentions ? Math.round((cell.value / totalMentions) * 100) : 0;
        const showCount = cell.w * cell.h > 9000;
        const showName = cell.w > 70 && cell.h > 36;
        const isSelected = selected && String(cell.code) === selected;
        const tip = isSelected
          ? `${cell.name} · selected — click to clear`
          : `${cell.name} · ${cell.value} post${cell.value === 1 ? "" : "s"} — click to filter`;
        return `<button type="button" class="feed-treemap-cell${isSelected ? " is-selected" : ""}" style="--enter-i:${i};left:${left.toFixed(2)}%;top:${topPct.toFixed(2)}%;width:${width.toFixed(2)}%;height:${height.toFixed(2)}%;--cell-accent:${accent};--cell-fg:${text}" data-feed-card="${escapeHtml(String(cell.code))}" aria-pressed="${isSelected ? "true" : "false"}" aria-label="${escapeHtml(`${cell.name}: ${cell.value} post${cell.value === 1 ? "" : "s"} (${pct}%)${isSelected ? ", selected" : ""}`)}"${tipAttr(tip)}>
          ${showName ? `<span class="feed-treemap-name">${escapeHtml(cell.shortName)}</span>` : ""}
          ${showCount ? `<span class="feed-treemap-count">${cell.value}</span>` : ""}
        </button>`;
      })
      .join("");

    const clearBtn = selectedCard
      ? `<button type="button" class="feed-treemap-clear" data-feed-treemap-clear${tipAttr("Show all players")}>Clear ${escapeHtml(selectedCard.shortName)}</button>`
      : "";

    el.feedTreemap.hidden = false;
    el.feedTreemap.classList.remove("is-scrollable");
    el.feedTreemap.innerHTML = `
      <div class="feed-treemap-head">
        <div>
          <h3>Mention share</h3>
          <p>${
            selectedCard
              ? `Filtered to <strong>${escapeHtml(selectedCard.name)}</strong> — click again or Clear to show all.`
              : `Top players in ${escapeHtml(rangeLabel)} — sized by posts (one count per player per post). Click a tile to filter.`
          }</p>
        </div>
        ${clearBtn}
      </div>
      <div class="feed-treemap-scroll">
        <div class="feed-treemap-plot" role="group" aria-label="Treemap of player mention volume">${cells}</div>
      </div>
    `;

    el.feedTreemap.querySelectorAll(".feed-treemap-cell").forEach((btn) => {
      btn.addEventListener("click", () => {
        const code = btn.getAttribute("data-feed-card");
        if (!code) return;
        state.feedSelectedCode =
          state.feedSelectedCode != null && String(state.feedSelectedCode) === code
            ? null
            : code;
        renderFeed();
      });
    });
    const clearEl = el.feedTreemap.querySelector("[data-feed-treemap-clear]");
    if (clearEl) {
      clearEl.addEventListener("click", () => {
        state.feedSelectedCode = null;
        renderFeed();
      });
    }
  }

  function renderFeed() {
    const root = el.feedTrending || el.feedList;
    if (!root) return;
    syncFeedRangeSeg();
    syncFeedFiltersToggle();
    const posts = SOCIAL.posts || [];
    const accounts = SOCIAL.accounts || [];
    const postsById = new Map(posts.map((p) => [String(p.id), p]));
    const rangeLabel = FEED_RANGE_LABELS[state.feedRange] || "the selected range";
    const query = el.feedSearch ? el.feedSearch.value : "";
    const trimmed = String(query || "").trim();
    const mention = computeFeedMentionCards(posts);

    if (!posts.length) {
      state.feedSelectedCode = null;
      clearFeedTreemap();
      const handles = accounts.map((a) => `@${a.handle}`).filter(Boolean).join(", ") || "@LetsTalk_FPL";
      root.innerHTML = `<div class="empty-state feed-empty">
        <p>No posts loaded yet — player cards need a fetched corpus.</p>
        <p class="feed-empty-hint">Watching ${escapeHtml(handles)}. Add more handles in <code>site/social_accounts.json</code>, then:</p>
        <pre class="feed-empty-cmd">python3 site/fetch_social.py
python3 site/annotate_social.py</pre>
      </div>`;
      return;
    }

    if (!mention.cards.length) {
      state.feedSelectedCode = null;
      clearFeedTreemap();
      const widenCount = trimmed ? feedSearchWiderRangeHits(posts, query) : 0;
      root.innerHTML = `<div class="empty-state feed-empty">
        <p>No player mentions for ${escapeHtml(rangeLabel)}.</p>
        ${
          widenCount
            ? feedWidenRangeHintHTML(widenCount)
            : `<p class="feed-empty-hint">Widen the date range, clear type/team filters, or pull fresher posts.</p>`
        }
      </div>`;
      return;
    }

    const filtered = mention.cards.filter(
      (card) => feedCardMatchesTeamFilter(card) && feedCardMatchesQuery(card, query)
    );
    if (!filtered.length) {
      state.feedSelectedCode = null;
      clearFeedTreemap();
      const widenCount = trimmed ? feedSearchWiderRangeHits(posts, query) : 0;
      root.innerHTML = `<div class="empty-state feed-empty" role="status">
        <p>No players found${trimmed ? ` for “${escapeHtml(trimmed)}”` : ""} in ${escapeHtml(rangeLabel)}.</p>
        ${
          widenCount
            ? feedWidenRangeHintHTML(widenCount)
            : `<p class="feed-empty-hint">Try another name or team, or clear search / filters.</p>`
        }
      </div>`;
      return;
    }

    if (
      state.feedSelectedCode != null &&
      !filtered.some((c) => String(c.code) === String(state.feedSelectedCode))
    ) {
      state.feedSelectedCode = null;
    }

    // Treemap stays on the full filtered set so selection can switch; cards narrow.
    renderFeedTreemap(filtered, rangeLabel);
    const cardsForList =
      state.feedSelectedCode != null
        ? filtered.filter((c) => String(c.code) === String(state.feedSelectedCode))
        : filtered;

    const cards = cardsForList
      .map((card, i) => feedPlayerCardHTML(card, postsById, i))
      .join("");

    root.innerHTML = `<div class="rankings-grid feed-player-grid">${cards}</div>`;

    root.querySelectorAll("img.feed-player-photo").forEach((img) => {
      img.addEventListener("error", () => {
        const fallback = document.createElement("span");
        fallback.className = "feed-player-photo feed-player-photo-fallback";
        fallback.setAttribute("aria-hidden", "true");
        fallback.textContent = img.getAttribute("data-initials") || "?";
        img.replaceWith(fallback);
      });
    });
  }


  // ---------------------------------------------------------------------
  // Ownership page — multi-line selected_by% over manual check-ins
  // ---------------------------------------------------------------------
  const OWNERSHIP_TOP_PLAYERS = 100;
  const OWNERSHIP_TEAM_TOP_N = 20;
  const OWNERSHIP_PAD = { top: 18, right: 18, bottom: 32, left: 42 };
  const OWNERSHIP_POINT_HIT = 16;
  const OWNERSHIP_LINE_HIT = 10;
  const OWNERSHIP_PLAYER_TREND_CARD_N = 5;
  const OWNERSHIP_TEAM_TREND_CARD_N = 8;

  let ownershipHoverKey = null;
  let ownershipHoverIndex = null;
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
    const n = Number(v);
    return `${n.toFixed(n >= 10 || n === 0 ? 1 : 1)}%`;
  }

  function ownershipDelta(curr, prev) {
    if (curr == null || prev == null) return null;
    return Math.round((Number(curr) - Number(prev)) * 10) / 10;
  }

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
    const recent = Math.round((owned[owned.length - 1] - owned[owned.length - 2]) * 10) / 10;
    const net = Math.round((owned[owned.length - 1] - owned[0]) * 10) / 10;
    const current = owned[owned.length - 1];
    const recentThreshold = state.ownershipTrendThreshold;
    const netThreshold = recentThreshold * 2;
    let kind = "flat";
    if (recent >= recentThreshold) kind = "riser";
    else if (recent <= -recentThreshold) kind = "faller";
    else if (Math.abs(recent) < recentThreshold && net >= netThreshold) kind = "riser";
    else if (Math.abs(recent) < recentThreshold && net <= -netThreshold) kind = "faller";
    return { kind, recent, net, current };
  }

  function ownershipTrendAccent(kind) {
    if (kind === "riser") return "hsl(var(--positive))";
    if (kind === "faller") return "hsl(var(--negative))";
    return "";
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
      series.kind === "team"
        ? `Top ${OWNERSHIP_TEAM_TOP_N} avg`
        : series.position
          ? series.position
          : "";
    return `<button type="button" class="ownership-trend-row" data-ownership-key="${escapeHtml(series.key)}">
      <span class="ownership-trend-identity">${badge}<span class="ownership-trend-name">${escapeHtml(series.name || "")}</span></span>
      <span class="ownership-trend-meta">${escapeHtml(meta)}</span>
      <span class="ownership-trend-owned">${escapeHtml(fmtOwnedPct(trend.current))}</span>
      <span class="ownership-trend-delta ${deltaCls}">${escapeHtml(fmtOwnershipTrendDelta(trend.recent))}</span>
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

  function syncOwnershipTrendingUI() {
    const on = !!state.ownershipTrending;
    if (el.ownershipTrendingToggle) {
      el.ownershipTrendingToggle.classList.toggle("on", on);
      el.ownershipTrendingToggle.setAttribute("aria-pressed", on ? "true" : "false");
    }
    if (el.ownershipTrendCards) {
      el.ownershipTrendCards.hidden = state.page !== "ownership";
    }
  }

  function renderOwnershipTrendCards(series) {
    if (!el.ownershipTrendRisers || !el.ownershipTrendFallers) return;
    const scored = (series || [])
      .map((s) => ({ series: s, trend: s._trend || ownershipTrendScore(s) }))
      .filter((x) => x.trend.kind !== "flat");
    const cardLimit =
      state.view === "teams" ? OWNERSHIP_TEAM_TREND_CARD_N : OWNERSHIP_PLAYER_TREND_CARD_N;
    const risers = scored
      .filter((x) => x.trend.kind === "riser")
      .sort(compareOwnershipTrends)
      .slice(0, cardLimit);
    const fallers = scored
      .filter((x) => x.trend.kind === "faller")
      .sort(compareOwnershipTrends)
      .slice(0, cardLimit);
    (series || []).forEach((item) => {
      item._trendCard = false;
    });
    [...risers, ...fallers].forEach((item) => {
      item.series._trendCard = true;
    });
    const empty = `<div class="ownership-trend-empty">No ownership movers match the current filters.</div>`;
    el.ownershipTrendRisers.innerHTML = risers.length
      ? risers.map((x) => ownershipTrendCardHTML(x.series, x.trend)).join("")
      : empty;
    el.ownershipTrendFallers.innerHTML = fallers.length
      ? fallers.map((x) => ownershipTrendCardHTML(x.series, x.trend)).join("")
      : empty;
    syncOwnershipTrendingUI();
  }

  function ownershipPlayerPassesFilters(p, catalog) {
    if (state.posFilter.size && !state.posFilter.has(p.position)) return false;
    if (state.teamFilter.size && !state.teamFilter.has(p.team)) return false;
    const price = Number(p.price);
    if (Number.isFinite(price) && (price < state.priceMin || price > state.priceMax)) return false;
    if (!Number.isFinite(Number(p.owned)) || Number(p.owned) < state.ownedMin) return false;
    if (!isNextSeason() && HAS_PRICE_DATA && state.hideDeparted) {
      const row = catalog.get(Number(p.code));
      if (row && row.price2627 == null) return false;
    }
    const q = state.search.trim().toLowerCase();
    if (q) {
      const hay = `${p.name || ""} ${p.team || ""} ${teamNameForSeason(p.team) || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function ownershipTeamPassesFilters(team, name) {
    if (state.teamFilter.size && !state.teamFilter.has(team)) return false;
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

  function ownershipScaleMax(series) {
    const max = Math.max(
      0,
      ...(series || []).flatMap((item) =>
        (item.points || [])
          .map((point) => Number(point && point.owned))
          .filter(Number.isFinite)
      )
    );
    return niceOwnershipMax(max);
  }

  function buildOwnershipPlayerSeries() {
    const checkIns = ownershipCheckIns();
    if (!checkIns.length) return [];
    const catalog = ownershipCatalogByCode();
    const latest = checkIns[checkIns.length - 1];
    const universe = (latest.players || []).filter((p) => ownershipPlayerPassesFilters(p, catalog));
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

  function buildOwnershipTeamSeries() {
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
      ownershipTeamPassesFilters(team, teamNameForSeason(team))
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

  function ownershipPolylines(points, xAt, yAt) {
    const lines = [];
    let cur = [];
    points.forEach((pt) => {
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

  function niceOwnershipMax(raw) {
    const v = Math.max(10, Number(raw) || 10);
    const padded = v * 1.08;
    const step = padded <= 20 ? 5 : 10;
    return Math.ceil(padded / step) * step;
  }

  function hideOwnershipTooltip() {
    clearTimeout(ownershipTipTimer);
    ownershipTipTimer = null;
    if (!el.ownershipTooltip) return;
    el.ownershipTooltip.style.display = "none";
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

  function ownershipTooltipHTML(series, ptIndex) {
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
    if (!pt) return "";
    let prev = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (pts[i] && pts[i].owned != null) {
        prev = pts[i];
        break;
      }
    }
    const delta = ownershipDelta(pt.owned, prev && prev.owned);
    const trend =
      state.ownershipTrending && series._trendCard ? ownershipTrendScore(series) : null;
    const deltaCls =
      trend && trend.kind === "riser"
        ? "is-up"
        : trend && trend.kind === "faller"
          ? "is-down"
          : delta == null
            ? "is-flat"
            : delta > 0
              ? "is-up"
              : delta < 0
                ? "is-down"
                : "is-flat";
    const deltaTxt =
      delta == null ? "first check-in" : delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
    const when = fmtOwnershipDate(pt.checkedAt);
    const trendRow =
      trend && trend.kind !== "flat"
        ? `<div class="tt-row"><span>Trend</span><b class="tt-delta ${deltaCls}">${escapeHtml(
            `${fmtOwnershipTrendDelta(trend.recent)} recent · ${fmtOwnershipTrendDelta(trend.net)} net`
          )}</b></div>`
        : "";
    if (series.kind === "team") {
      const badge = series.team ? badgeHTML(series.team) : "";
      return `<div class="tt-identity">
          <div class="tt-title">
            <div class="tt-name">${badge}${escapeHtml(series.name)}</div>
            <div class="tt-meta"><span>Top ${OWNERSHIP_TEAM_TOP_N} avg</span></div>
          </div>
        </div>
        <div class="tt-row"><span>Owned</span><b class="tt-owned">${escapeHtml(fmtOwnedPct(pt.owned))}</b></div>
        <div class="tt-row"><span>vs last</span><b class="tt-delta ${deltaCls}">${escapeHtml(deltaTxt)}</b></div>
        ${trendRow}
        <div class="tt-checkin">${escapeHtml(when)}</div>`;
    }
    const player = pt.player || series;
    const photo = feedPlayerPhotoUrl(series.code);
    const initials = ownershipInitials(player.name || series.name);
    const photoBlock = photo
      ? `<img class="tt-photo" src="${escapeHtml(photo)}" alt="" width="44" height="56" data-initials="${escapeHtml(initials)}" />`
      : `<span class="tt-photo tt-photo-fallback" aria-hidden="true">${escapeHtml(initials)}</span>`;
    const badge = player.team ? badgeHTML(player.team) : "";
    const metaBits = [];
    if (player.position) metaBits.push(posBadgeHTML(player.position));
    if (player.price != null) metaBits.push(`<span>£${Number(player.price).toFixed(1)}m</span>`);
    return `<div class="tt-identity">
        ${photoBlock}
        <div class="tt-title">
          <div class="tt-name">${badge}${escapeHtml(player.name || series.name)}</div>
          <div class="tt-meta">${metaBits.join("")}</div>
        </div>
      </div>
      <div class="tt-row"><span>Owned</span><b class="tt-owned">${escapeHtml(fmtOwnedPct(pt.owned))}</b></div>
      <div class="tt-row"><span>vs last</span><b class="tt-delta ${deltaCls}">${escapeHtml(deltaTxt)}</b></div>
      ${trendRow}
      <div class="tt-checkin">${escapeHtml(when)}</div>`;
  }

  function showOwnershipTooltip(clientX, clientY, html) {
    if (!el.ownershipTooltip || !el.ownershipChartWrap) return;
    el.ownershipTooltip.innerHTML = html;
    el.ownershipTooltip.querySelectorAll("img.tt-photo").forEach((img) => {
      img.addEventListener("error", () => {
        const fallback = document.createElement("span");
        fallback.className = "tt-photo tt-photo-fallback";
        fallback.setAttribute("aria-hidden", "true");
        fallback.textContent = img.getAttribute("data-initials") || "?";
        img.replaceWith(fallback);
      }, { once: true });
    });
    el.ownershipTooltip.style.display = "block";
    positionOwnershipTooltip(clientX, clientY);
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

  function ownershipAccentForSeries(series) {
    if (!series) return "";
    if (state.ownershipTrending && series._trendCard && series._trend) {
      return (
        ownershipTrendAccent(series._trend.kind) ||
        TEAM_SCATTER_ACCENT[series.team] ||
        ""
      );
    }
    return TEAM_SCATTER_ACCENT[series.team] || "";
  }

  function hoverOwnershipSeries(key, { index = null, showTip = false, tipClientX, tipClientY } = {}) {
    const series = key ? ownershipSeriesCache.find((s) => s.key === key) : null;
    if (!series) {
      setOwnershipHover(null, null);
      hideOwnershipTooltip();
      return;
    }
    const idx = index != null ? index : ownershipLastOwnedIndex(series);
    setOwnershipHover(key, idx);
    if (showTip && hasFineHover() && tipClientX != null && tipClientY != null) {
      showOwnershipTooltip(tipClientX, tipClientY, ownershipTooltipHTML(series, idx));
    }
  }

  function setOwnershipHover(key, index) {
    ownershipHoverKey = key;
    ownershipHoverIndex = index;
    if (!el.ownershipChart) return;
    const series = key ? ownershipSeriesCache.find((s) => s.key === key) : null;
    const trending = !!state.ownershipTrending;
    const accent = ownershipAccentForSeries(series);
    el.ownershipChart.querySelectorAll(".ownership-line, .ownership-dot").forEach((node) => {
      const match = node.getAttribute("data-key") === key;
      node.classList.toggle("is-active", !!key && match);
      node.classList.toggle("is-dim", !!key && !match);
      if (match && accent) {
        node.style.setProperty("--ownership-accent", accent);
        if (node.tagName.toLowerCase() === "path") node.style.stroke = accent;
        else node.style.fill = accent;
      } else if (!trending) {
        node.style.removeProperty("--ownership-accent");
        node.style.stroke = "";
        node.style.fill = "";
      } else {
        // Keep CSS trend classes; clear hover overrides when not the active series.
        node.style.removeProperty("--ownership-accent");
        node.style.stroke = "";
        node.style.fill = "";
      }
    });
    if (el.ownershipTrendCards) {
      el.ownershipTrendCards.querySelectorAll("[data-ownership-key]").forEach((row) => {
        row.classList.toggle("is-active", !!key && row.getAttribute("data-ownership-key") === key);
      });
    }
    const svg = el.ownershipChart.querySelector("svg");
    if (svg && key) {
      svg.querySelectorAll(`.ownership-line[data-key="${key}"], .ownership-dot[data-key="${key}"]`).forEach((node) => {
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

  function hitTestOwnership(px, py) {
    const series = ownershipSeriesCache;
    const layout = ownershipLayout;
    if (!series.length || !layout) return null;
    let bestPoint = null;
    let bestPointD = OWNERSHIP_POINT_HIT;
    series.forEach((s) => {
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
    series.forEach((s) => {
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
    const hit = hitTestOwnership(pt.x, pt.y);
    if (!hit) {
      if (ownershipHoverKey) {
        setOwnershipHover(null, null);
        hideOwnershipTooltip();
      }
      return;
    }
    const changed = ownershipHoverKey !== hit.series.key || ownershipHoverIndex !== hit.index;
    setOwnershipHover(hit.series.key, hit.index);
    if (hasFineHover()) {
      clearTimeout(ownershipTipTimer);
      const html = ownershipTooltipHTML(hit.series, hit.index);
      if (changed || !el.ownershipTooltip || el.ownershipTooltip.style.display === "none") {
        showOwnershipTooltip(evt.clientX, evt.clientY, html);
      } else {
        positionOwnershipTooltip(evt.clientX, evt.clientY);
      }
    }
  }

  function onOwnershipPointerLeave() {
    setOwnershipHover(null, null);
    hideOwnershipTooltip();
  }

  function onOwnershipClick(evt) {
    if (hasFineHover()) return;
    const pt = ownershipPointerToSvg(evt);
    if (!pt) return;
    const hit = hitTestOwnership(pt.x, pt.y);
    if (!hit) {
      setOwnershipHover(null, null);
      hideOwnershipTooltip();
      return;
    }
    if (
      el.ownershipTooltip &&
      el.ownershipTooltip.style.display !== "none" &&
      ownershipHoverKey === hit.series.key &&
      ownershipHoverIndex === hit.index
    ) {
      hideOwnershipTooltip();
      setOwnershipHover(null, null);
      return;
    }
    setOwnershipHover(hit.series.key, hit.index);
    showOwnershipTooltip(evt.clientX, evt.clientY, ownershipTooltipHTML(hit.series, hit.index));
  }

  let ownershipLastSize = "";

  function renderOwnership() {
    if (!el.ownershipChart) return;
    hideOwnershipTooltip();
    const checkIns = ownershipCheckIns();
    const series =
      state.view === "teams" ? buildOwnershipTeamSeries() : buildOwnershipPlayerSeries();
    series.forEach((s) => {
      s._trend = ownershipTrendScore(s);
    });
    ownershipSeriesCache = series;
    renderOwnershipTrendCards(series);
    if (el.ownershipChartWrap) {
      el.ownershipChartWrap.classList.toggle("is-trending", !!state.ownershipTrending);
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
    const w = Math.max(320, wrap.clientWidth || 640);
    const h = Math.max(260, wrap.clientHeight || 420);
    ownershipLastSize = `${wrap.clientWidth}x${wrap.clientHeight}`;
    const pad = OWNERSHIP_PAD;
    const innerW = Math.max(40, w - pad.left - pad.right);
    const innerH = Math.max(40, h - pad.top - pad.bottom);
    const n = checkIns.length;
    const xAt = (i) => {
      if (n <= 1) return pad.left + innerW / 2;
      return pad.left + (i / (n - 1)) * innerW;
    };
    const yMax = ownershipScaleMax(series);
    const yAt = (owned) => pad.top + (1 - owned / yMax) * innerH;
    ownershipLayout = { w, h, pad, innerW, innerH, xAt, yAt, yMax, n };

    if (!checkIns.length) {
      el.ownershipChart.innerHTML = `<div class="ownership-empty">No ownership check-ins yet. Run <code>python3 site/fetch_ownership.py</code> to capture the current FPL selected-by-%.</div>`;
      return;
    }
    if (!series.length) {
      el.ownershipChart.innerHTML = `<div class="ownership-empty">No players or clubs match the current filters.</div>`;
      return;
    }

    const tickStep = yMax <= 20 ? 5 : 10;
    const yTicks = [];
    for (let v = 0; v <= yMax + 1e-6; v += tickStep) yTicks.push(v);

    series.forEach((s) => {
      s._drawn = ownershipPolylines(s.points, xAt, yAt);
    });

    const grid = yTicks
      .map((v) => {
        const y = yAt(v);
        return `<line class="ownership-grid-line" x1="${pad.left}" x2="${w - pad.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" />
          <text class="ownership-axis-label is-y" x="${pad.left - 8}" y="${(y + 3).toFixed(1)}">${v}%</text>`;
      })
      .join("");

    const xLabels = checkIns
      .map((ci, i) => {
        const x = xAt(i);
        return `<text class="ownership-axis-label is-x" x="${x.toFixed(1)}" y="${h - 10}">${escapeHtml(fmtOwnershipDate(ci.checkedAt))}</text>`;
      })
      .join("");

    const trendClass = (s) => {
      if (!state.ownershipTrending || !s._trendCard || !s._trend) return "";
      if (s._trend.kind === "riser") return " is-riser";
      if (s._trend.kind === "faller") return " is-faller";
      return " is-flat-trend";
    };

    const lines = series
      .map((s) =>
        s._drawn
          .map((line) => {
            if (line.length === 1) return "";
            return `<path class="ownership-line${trendClass(s)}" data-key="${escapeHtml(s.key)}" d="${pathFromPts(line)}" />`;
          })
          .join("")
      )
      .join("");

    const dots = series
      .map((s) =>
        s._drawn
          .flat()
          .map(
            (pt) =>
              `<circle class="ownership-dot${trendClass(s)}" data-key="${escapeHtml(s.key)}" cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="2.1" />`
          )
          .join("")
      )
      .join("");

    el.ownershipChart.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-hidden="true">
        ${grid}
        <line class="ownership-hover-guide" x1="0" x2="0" y1="${pad.top}" y2="${h - pad.bottom}" style="display:none" />
        ${lines}
        ${dots}
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

    if (ownershipHoverKey) {
      const still = series.find((s) => s.key === ownershipHoverKey);
      if (still) setOwnershipHover(still.key, ownershipHoverIndex);
      else setOwnershipHover(null, null);
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


  const PAGE_KEY = "fpl-explorer-page";
  const PAGES = ["opta", "rankings", "ownership", "expected", "schedule", "feed", "markets", "team", "notes"];

  // ---------------------------------------------------------------------
  // Notes (right-click → freeform comments)
  // ---------------------------------------------------------------------
  function noteGwMeta() {
    const gw = teamCurrentGw();
    const label =
      (state.actualMeta && state.actualMeta.gwLabel) ||
      (DATA.fixturesMeta && Number(DATA.fixturesMeta.currentGw) <= 1 ? "Preseason" : null) ||
      `Gameweek ${gw}`;
    const isPreseason = /preseason/i.test(String(label)) || Number(gw) <= 1;
    return { gw, gwLabel: isPreseason ? "Preseason" : label };
  }

  function loadNotes() {
    try {
      const raw = localStorage.getItem(NOTES_KEY);
      if (!raw) {
        state.notes = [];
        return;
      }
      const parsed = JSON.parse(raw);
      state.notes = Array.isArray(parsed && parsed.notes) ? parsed.notes.filter((n) => n && n.id && n.text) : [];
    } catch {
      state.notes = [];
    }
  }

  function saveNotes() {
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify({ version: 1, notes: state.notes }));
    } catch {
      /* private browsing */
    }
  }

  function newNoteId() {
    return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function findPlayerRowByKey(key) {
    if (key == null || key === "") return null;
    const pools = [teamCatalog(), (DATA.players && DATA.players.combined) || []];
    for (const pool of pools) {
      const hit = pool.find(
        (p) => p && (teamCodeEq(p.code, key) || String(p.id) === String(key) || String(p.name) === String(key))
      );
      if (hit) return hit;
    }
    return null;
  }

  function noteTargetFromPlayer(row) {
    if (!row) return null;
    const team = currentTeamCode(row) || row.team;
    return {
      entityType: "player",
      playerCode: row.code != null ? row.code : null,
      playerName: row.name || null,
      teamCode: team || null,
      teamName: team ? teamNameForSeason(team) || TEAM_NAMES[team] || team : null,
      position: row.position || null,
    };
  }

  function noteTargetFromTeam(teamCode) {
    if (!teamCode) return null;
    const code = String(teamCode);
    const known =
      TEAM_NAMES[code] ||
      (DATA.teamNames && DATA.teamNames[code]) ||
      (DATA.fixtureTeamNames && DATA.fixtureTeamNames[code]) ||
      /^[A-Z]{3}$/.test(code);
    if (!known) return null;
    return {
      entityType: "team",
      teamCode: code,
      teamName: teamNameForSeason(code) || TEAM_NAMES[code] || code,
    };
  }

  function resolveNoteTargetFromNode(node) {
    if (!node || !node.closest) return null;

    const playerCodeEl = node.closest("[data-player-code]");
    if (playerCodeEl && playerCodeEl.dataset.playerCode) {
      const row = findPlayerRowByKey(playerCodeEl.dataset.playerCode);
      if (row) return noteTargetFromPlayer(row);
    }

    const teamCodeProp = node.closest("[data-team-code]");
    if (teamCodeProp && teamCodeProp.dataset.teamCode) {
      const row = findPlayerRowByKey(teamCodeProp.dataset.teamCode);
      if (row) return noteTargetFromPlayer(row);
    }

    const feedCard = node.closest("[data-feed-code], [data-feed-card], .feed-player-card");
    if (feedCard) {
      const code = feedCard.dataset.feedCode || feedCard.dataset.feedCard || feedCard.dataset.code || null;
      if (code != null) {
        const row = findPlayerRowByKey(code);
        if (row) return noteTargetFromPlayer(row);
      }
    }

    const pinChip = node.closest("[data-pin-key]");
    if (pinChip && pinChip.dataset.pinKey) {
      const key = pinChip.dataset.pinKey;
      const player = findPlayerRowByKey(key);
      if (player) return noteTargetFromPlayer(player);
      const team = noteTargetFromTeam(key);
      if (team) return team;
    }

    const rankRow = node.closest("[data-row-key]");
    if (rankRow && rankRow.dataset.rowKey) {
      const key = rankRow.dataset.rowKey;
      const player = findPlayerRowByKey(key);
      if (player) return noteTargetFromPlayer(player);
      const team = noteTargetFromTeam(key);
      if (team) return team;
    }

    const namedTeamEl = node.closest("[data-team][data-row-name], tr[data-team][data-row-name]");
    if (namedTeamEl && namedTeamEl.dataset.team && namedTeamEl.dataset.rowName) {
      const team = namedTeamEl.dataset.team;
      const rowName = namedTeamEl.dataset.rowName.trim();
      if (namedTeamEl.dataset.playerCode) {
        const byCode = findPlayerRowByKey(namedTeamEl.dataset.playerCode);
        if (byCode) return noteTargetFromPlayer(byCode);
      }
      const pools = [];
      try {
        pools.push(getRows() || []);
      } catch {
        /* ignore */
      }
      pools.push(teamCatalog(), (DATA.players && DATA.players.combined) || []);
      for (const pool of pools) {
        const match = (pool || []).find(
          (r) =>
            r &&
            r.name === rowName &&
            (currentTeamCode(r) === team || r.team === team || !team)
        );
        if (match && match.code != null) return noteTargetFromPlayer(match);
      }
    }

    const teamEl = node.closest("[data-team]");
    if (teamEl && teamEl.dataset.team) {
      if (teamEl.dataset.playerCode) {
        const row = findPlayerRowByKey(teamEl.dataset.playerCode);
        if (row) return noteTargetFromPlayer(row);
      }
      const team = noteTargetFromTeam(teamEl.dataset.team);
      if (team) return team;
    }

    const crest = node.closest(
      ".player-cell-crest, .badge-img, .feed-player-team-badge, .markets-team-cell, .player-cell, .rankings-identity"
    );
    if (crest) {
      const host =
        crest.closest(
          "[data-player-code], [data-team-code], [data-row-key], [data-team], [data-feed-code], [data-pin-key], .rankings-row, .barbell-label, .barbell-group-identity, .markets-team-row, .schedule-card, .feed-player-card, tr.team-search-row, tr.team-picker-row, tr.team-player-row"
        ) || crest.parentElement;
      if (host && host !== node) return resolveNoteTargetFromNode(host);
    }

    return null;
  }

  function noteContextTitle(target) {
    if (target.playerCode != null || target.playerName) return target.playerName || "Player";
    return target.teamName || target.teamCode || "Team";
  }

  function noteContextSub(target) {
    if (target.playerCode != null || target.playerName) {
      const bits = [];
      const pos = target.position || (findPlayerRowByKey(target.playerCode) || {}).position;
      if (pos) bits.push(TEAM_POS_LABEL[pos] || pos);
      if (target.teamName || target.teamCode) bits.push(target.teamName || target.teamCode);
      return bits.join(" · ") || "Player";
    }
    return "Club";
  }

  function closeNoteContextMenu() {
    if (!el.noteContextMenu) return;
    el.noteContextMenu.classList.remove("open");
    el.noteContextMenu.setAttribute("aria-hidden", "true");
    el.noteContextMenu.innerHTML = "";
  }

  function openNoteContextMenuAt(target, x, y) {
    if (!el.noteContextMenu || !target) return;
    closeTeamRowMenu({ force: true });
    hideUiTooltip();
    const title = noteContextTitle(target);
    const sub = noteContextSub(target);
    const crest = target.teamCode ? playerCrestHTML(target.teamCode) : "";
    el.noteContextMenu.innerHTML = `<div class="settings-panel-head">
        <h4 id="note-context-menu-title">${crest ? `<span class="note-context-crest">${crest}</span>` : ""}${escapeHtml(title)}</h4>
        <p class="settings-panel-sub">${escapeHtml(sub)}</p>
      </div>
      <div class="settings-panel-body team-row-menu-body">
        <section class="settings-section">
          <div class="settings-section-label">Notes</div>
          <button type="button" class="settings-switch-row team-row-menu-item" role="menuitem" data-note-add>
            <span class="team-row-menu-icon" aria-hidden="true">${iconHTML("notebook-pen")}</span>
            <span class="settings-switch-text"><span class="settings-switch-label">Add note</span></span>
          </button>
        </section>
      </div>`;
    el.noteContextMenu.classList.add("open");
    el.noteContextMenu.setAttribute("aria-hidden", "false");
    el.noteContextMenu.setAttribute("aria-labelledby", "note-context-menu-title");
    noteMenuOpenedAt = Date.now();
    noteDraft = { target, x, y };
    const pad = 8;
    const w = el.noteContextMenu.offsetWidth || 260;
    const h = el.noteContextMenu.offsetHeight || 160;
    let left = x;
    let top = y;
    if (left + w > window.innerWidth - pad) left = x - w;
    if (top + h > window.innerHeight - pad) top = y - h;
    left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
    top = Math.max(pad, Math.min(top, window.innerHeight - h - pad));
    el.noteContextMenu.style.left = `${left}px`;
    el.noteContextMenu.style.top = `${top}px`;
    requestAnimationFrame(() => {
      if (!el.noteContextMenu.classList.contains("open")) return;
      const first = el.noteContextMenu.querySelector("[role=menuitem]");
      if (first) first.focus({ preventScroll: true });
    });
  }

  function closeNoteModal() {
    if (!el.noteModal) return;
    el.noteModal.hidden = true;
    noteDraft = null;
    if (el.noteTextInput) el.noteTextInput.value = "";
  }

  function openNoteModal(target) {
    if (!el.noteModal || !target) return;
    closeNoteContextMenu();
    if (!target.playerCode && !target.playerName && !target.teamCode) return;
    noteDraft = { target };
    if (el.noteModalSub) {
      el.noteModalSub.textContent = noteContextSub(target)
        ? `${noteContextTitle(target)} · ${noteContextSub(target)}`
        : noteContextTitle(target);
    }
    if (el.noteTextInput) el.noteTextInput.value = "";
    el.noteModal.hidden = false;
    requestAnimationFrame(() => el.noteTextInput && el.noteTextInput.focus());
  }

  function saveNoteFromModal() {
    if (!noteDraft || !noteDraft.target) return;
    const text = (el.noteTextInput && el.noteTextInput.value || "").trim();
    if (!text) {
      showToast({ title: "Empty note", message: "Write a comment before saving.", icon: "triangle-alert" });
      return;
    }
    const target = noteDraft.target;
    const gw = noteGwMeta();
    const hasPlayer = target.playerCode != null || !!target.playerName;
    state.notes.unshift({
      id: newNoteId(),
      text,
      createdAt: new Date().toISOString(),
      gw: gw.gw,
      gwLabel: gw.gwLabel,
      entityType: hasPlayer ? "player" : "team",
      playerCode: target.playerCode ?? null,
      playerName: target.playerName || null,
      teamCode: target.teamCode || null,
      teamName: target.teamName || null,
    });
    saveNotes();
    closeNoteModal();
    showToast({
      title: "Note saved",
      message: noteContextTitle(target),
      icon: "circle-check",
    });
    if (state.page === "notes") renderNotes();
  }

  function deleteNote(id) {
    state.notes = state.notes.filter((n) => n.id !== id);
    saveNotes();
    renderNotes();
  }

  function noteCardHTML(note) {
    const title =
      note.entityType === "player"
        ? note.playerName || "Player"
        : note.teamName || note.teamCode || "Team";
    const crest = note.teamCode ? playerCrestHTML(note.teamCode) : "";
    const when = note.createdAt ? new Date(note.createdAt).toLocaleString() : "";
    return `<article class="note-card" data-note-id="${escapeHtml(note.id)}">
      <div class="note-card-head">${crest}<div class="note-card-title">${escapeHtml(title)}</div></div>
      <div class="note-card-meta"><span>${escapeHtml(note.gwLabel || `GW ${note.gw}`)}</span><span>${escapeHtml(when)}</span></div>
      <div class="note-card-body">${escapeHtml(note.text)}</div>
      <div class="note-card-actions"><button type="button" class="ghost-btn" data-note-delete="${escapeHtml(note.id)}">Delete</button></div>
    </article>`;
  }

  function renderNotes() {
    if (!el.notesCollage) return;
    const notes = state.notes.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (el.notesCountLabel) el.notesCountLabel.textContent = `${notes.length} note${notes.length === 1 ? "" : "s"}`;
    if (el.notesGroupSeg) {
      el.notesGroupSeg.querySelectorAll("[data-notes-group]").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-notes-group") === state.notesGroupBy);
      });
      syncSegThumb(el.notesGroupSeg, { animate: false });
    }
    if (!notes.length) {
      el.notesCollage.innerHTML = `<div class="notes-empty">No notes yet. Right-click a player, crest, or team row and choose Add note.</div>`;
      return;
    }
    if (state.notesGroupBy === "none") {
      el.notesCollage.innerHTML = notes.map(noteCardHTML).join("");
      return;
    }
    const groups = new Map();
    notes.forEach((n) => {
      const key =
        state.notesGroupBy === "player"
          ? n.entityType === "player"
            ? `p:${n.playerCode || n.playerName}`
            : `t:${n.teamCode}`
          : `t:${n.teamCode || "unknown"}`;
      const label =
        state.notesGroupBy === "player"
          ? n.entityType === "player"
            ? n.playerName || "Player"
            : n.teamName || n.teamCode || "Team"
          : n.teamName || n.teamCode || "Team";
      if (!groups.has(key)) groups.set(key, { label, items: [] });
      groups.get(key).items.push(n);
    });
    el.notesCollage.innerHTML = [...groups.values()]
      .map(
        (g) =>
          `<section class="notes-group-block"><h3 class="notes-group-title">${escapeHtml(g.label)}</h3>${g.items
            .map(noteCardHTML)
            .join("")}</section>`
      )
      .join("");
  }

  function storedPage() {
    try {
      const saved = localStorage.getItem(PAGE_KEY);
      return PAGES.includes(saved) ? saved : "opta";
    } catch {
      return "opta";
    }
  }

  function pagePaneFor(page) {
    if (page === "opta") return el.optaPage;
    if (page === "rankings") return el.rankingsPage;
    if (page === "ownership") return el.ownershipPage;
    if (page === "expected") return el.expectedPage;
    if (page === "schedule") return el.schedulePage;
    if (page === "feed") return el.feedPage;
    if (page === "markets") return el.marketsPage;
    if (page === "team") return el.teamPage;
    if (page === "notes") return el.notesPage;
    return null;
  }

  function playPageEnter(pane) {
    if (!pane) return;
    pane.classList.remove("is-entering", "is-enter-pending");
    clearTimeout(pane._enterClear);
    if (pane._countUpRaf) {
      cancelAnimationFrame(pane._countUpRaf);
      pane._countUpRaf = 0;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // iOS/WebKit often applies tr { opacity:0 } from animation-fill backwards
    // and never plays the animation, so Statistics stays blank until a
    // Teams/Players re-render recreates the rows.
    if (pane.id === "opta-page" && NARROW_MQ.matches) return;

    const slowEnter = pane.id === "schedule-page";
    const rankingsEnter = pane.id === "rankings-page";
    const expectedEnter = pane.id === "expected-page";
    const marketsEnter = pane.id === "markets-page";
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
      ".feed-treemap-head",
      ".feed-treemap-cell",
      ".feed-trending .feed-player-card",
      ".feed-trending .feed-source-row",
      ".team-player-row",
      ".team-empty-row",
      ".team-picker-row",
      ".team-budget-bar",
      ".team-section-row",
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
    // Feed: treemap cells get their own index (already set in HTML); cards
    // restart so they don't inherit the treemap stagger.
    if (pane.id === "feed-page") {
      pane.querySelectorAll(".feed-treemap-cell").forEach((node, i) => {
        node.style.setProperty("--enter-i", String(i));
      });
      pane.querySelectorAll(".feed-trending .feed-player-card").forEach((node, i) => {
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
        if (marketsEnter) startMarketsStatCountUp(pane);
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
                : optaEnter
                  ? 1600
                  : 1500;
        pane._enterClear = setTimeout(() => pane.classList.remove("is-entering"), clearMs);
      });
    });
  }

  function startMarketsStatCountUp(pane) {
    const nodes = [...pane.querySelectorAll(".markets-stat-value[data-count-to]")];
    if (!nodes.length) return;
    const duration = 2000;
    const easeOut = (t) => 1 - (1 - t) ** 3;
    nodes.forEach((node) => {
      const target = Number(node.dataset.countTo);
      const decimals = Number(node.dataset.countDecimals);
      const suffix = node.dataset.countSuffix || "";
      if (!Number.isFinite(target)) return;
      const dec = Number.isFinite(decimals) ? decimals : 0;
      node.textContent = `${(0).toFixed(dec)}${suffix}`;
      node._countTarget = target;
      node._countDecimals = dec;
      node._countSuffix = suffix;
    });

    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const p = easeOut(t);
      nodes.forEach((node) => {
        const target = node._countTarget;
        if (!Number.isFinite(target)) return;
        const value = target * p;
        node.textContent = `${value.toFixed(node._countDecimals)}${node._countSuffix || ""}`;
      });
      if (t < 1) {
        pane._countUpRaf = requestAnimationFrame(tick);
      } else {
        nodes.forEach((node) => {
          if (!Number.isFinite(node._countTarget)) return;
          node.textContent = `${Number(node._countTarget).toFixed(node._countDecimals)}${node._countSuffix || ""}`;
        });
        pane._countUpRaf = 0;
      }
    };
    pane._countUpRaf = requestAnimationFrame(tick);
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
    state.priceMin = defaultMinPrice();
    state.priceMax = bounds.price.max;
    state.ownedMin = OWNERSHIP_FILTER_DEFAULT;
    state.minsMin = defaultMinMinutes();
    state.minsMax = bounds.mins.max;
    if (typeof syncFilterChipUI === "function") syncFilterChipUI();
    if (typeof updatePriceSlider === "function") updatePriceSlider();
    if (typeof updateOwnedSlider === "function") updateOwnedSlider();
    if (typeof updateMinsSlider === "function") updateMinsSlider();
    if (typeof syncFiltersResetUI === "function") syncFiltersResetUI();

    if (el.feedSearch) el.feedSearch.value = "";
    if (el.feedSearchWrap && !feedSearchAlwaysOpen()) {
      el.feedSearchWrap.classList.remove("search-open");
      if (el.feedSearchToggle) el.feedSearchToggle.setAttribute("aria-expanded", "false");
    }
    state.feedTeamFilter.clear();
    state.feedTypeFilter.clear();
    state.feedRange = "today";
    state.feedSelectedCode = null;
    if (typeof syncFeedRangeSeg === "function") syncFeedRangeSeg();
    if (typeof buildFeedTypeChips === "function") buildFeedTypeChips();
    if (typeof buildFeedTeamChips === "function") buildFeedTeamChips();
    if (typeof syncFeedFiltersToggle === "function") syncFeedFiltersToggle();

    syncSearchClearBtns();
    if (rerender) {
      if (state.page === "feed") renderFeed();
      else if (state.page === "opta" || state.page === "rankings" || state.page === "team" || state.page === "ownership") renderTable();
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

  function syncPageTrayTrigger() {
    if (!el.pageTrayBtn) return;
    const btn = el.pageTabs && el.pageTabs.querySelector(".page-tab-btn.active");
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
  }

  function setPage(page) {
    const prev = state.page;
    state.page = page;
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
    closeNoteContextMenu();
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
      resetSearchAndFiltersForNavigation({ rerender: false });
      if (page === "team" || prev === "team") buildTeamFilterChips();
    }
    if (page === "feed") syncFeedSearchLayout();
    syncTeamSearchHost();
    syncSearchClearBtns();
    syncPageInfoButton();
    syncAllNameColumnSimplifies();
    el.pageOpta.classList.toggle("active", page === "opta");
    el.pageRankings.classList.toggle("active", page === "rankings");
    if (el.pageOwnership) el.pageOwnership.classList.toggle("active", page === "ownership");
    el.pageExpected.classList.toggle("active", page === "expected");
    el.pageSchedule.classList.toggle("active", page === "schedule");
    if (el.pageFeed) el.pageFeed.classList.toggle("active", page === "feed");
    if (el.pageMarkets) el.pageMarkets.classList.toggle("active", page === "markets");
    if (el.pageTeam) el.pageTeam.classList.toggle("active", page === "team");
    if (el.pageNotes) el.pageNotes.classList.toggle("active", page === "notes");
    document.documentElement.dataset.page = page;
    syncPageTrayTrigger();
    setPageTrayOpen(false);
    el.optaPage.style.display = page === "opta" ? "" : "none";
    el.rankingsPage.style.display = page === "rankings" ? "" : "none";
    if (el.ownershipPage) el.ownershipPage.style.display = page === "ownership" ? "" : "none";
    el.expectedPage.style.display = page === "expected" ? "" : "none";
    el.schedulePage.style.display = page === "schedule" ? "" : "none";
    if (el.feedPage) el.feedPage.style.display = page === "feed" ? "" : "none";
    if (el.marketsPage) el.marketsPage.style.display = page === "markets" ? "" : "none";
    if (el.teamPage) el.teamPage.style.display = page === "team" ? "" : "none";
    if (el.notesPage) el.notesPage.style.display = page === "notes" ? "" : "none";
    const isMarkets = page === "markets";
    // Schedule has no subtoolbar. Markets hides it on desktop, but keeps a
    // minimal mobile bar for the G+CS% / Scoreline picker (like xData).
    const hideSubtoolbar =
      page === "schedule" ||
      page === "notes" ||
      (isMarkets && !preferMobileSheet());
    const isFeed = page === "feed";
    el.subtoolbar.style.display = hideSubtoolbar ? "none" : "";
    el.subtoolbar.classList.toggle("is-markets-mobile", isMarkets && preferMobileSheet());
    el.sidebar.style.display =
      page === "schedule" || isMarkets || isFeed || page === "notes" || (page === "team" && !state.teamPickerSlot)
        ? "none"
        : "";
    if (el.sidebarToggle) {
      el.sidebarToggle.style.display =
        page === "team" && !state.teamPickerSlot ? "none" : page === "notes" ? "none" : "";
    }
    if (el.statsToolbarStart) el.statsToolbarStart.style.display = isFeed || isMarkets || page === "notes" ? "none" : "";
    if (el.statsToolbarActions) el.statsToolbarActions.style.display = isFeed || page === "notes" ? "none" : "";
    if (el.teamToolbarControls) el.teamToolbarControls.hidden = page !== "team";
    if (el.teamToolbarMode) el.teamToolbarMode.hidden = page !== "team";
    if (el.feedToolbarStart) el.feedToolbarStart.style.display = isFeed ? "" : "none";
    if (el.feedToolbarEnd) el.feedToolbarEnd.style.display = isFeed ? "" : "none";
    if (el.feedControls) {
      if (isFeed) {
        el.feedControls.style.display = "";
        el.feedControls.hidden = false;
        syncFeedFiltersToggle();
      } else {
        el.feedControls.classList.add("collapsed");
        el.feedControls.style.display = "none";
        syncFeedFiltersToggle();
      }
    }
    if (el.columnsSidebar) {
      // Right rail is desktop-only; mid-width embeds columns in Filters.
      // Mobile Statistics has no column toggles.
      el.columnsSidebar.style.display =
        page === "opta" && !columnsLiveInFilters() && !preferMobileSheet() ? "" : "none";
    }
    el.tableOnlyToggles.style.display = page === "opta" ? "" : "none";
    if (el.compareToggle) el.compareToggle.style.display = page === "opta" ? "" : "none";
    if (el.columnsBtn) {
      el.columnsBtn.style.display =
        page === "opta" && !columnsLiveInFilters() && !preferMobileSheet() ? "" : "none";
    }
    syncColumnsPanelHost();
    syncHighlightUI();
    renderColumnsPanel();
    if (page !== "opta") {
      setColumnsOpen(false);
    }
    // Expected Data keeps its own Fixture Location control (adds Compare),
    // swapped into the same sidebar slot as the shared Total/Home/Away group.
    el.splitGroup.style.display =
      page === "expected" || page === "team" || page === "notes" || page === "ownership" ? "none" : "";
    if (el.expectedSplitGroup) {
      el.expectedSplitGroup.style.display = page === "expected" ? "" : "none";
    }
    const viewTabs = el.tabPlayers && el.tabPlayers.closest(".tabs");
    if (viewTabs) viewTabs.style.display = page === "team" || page === "notes" ? "none" : "";
    if (page === "team") {
      if (state.view !== "players") {
        state.view = "players";
        el.tabPlayers.classList.add("active");
        el.tabTeams.classList.remove("active");
      }
      el.valueModeGroup.style.display = "none";
      el.minutesFilterGroup.style.display = "none";
      el.inactiveFilterGroup.style.display = "none";
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
      el.inactiveFilterGroup.style.display =
        state.view === "players" && HAS_PRICE_DATA && !isNextSeason() ? "" : "none";
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
    if (page !== "ownership") {
      if (el.ownershipTrendCards) el.ownershipTrendCards.hidden = true;
    } else {
      syncOwnershipTrendingUI();
    }
    if (page !== "expected") setExpectedCatMenuOpen(false);
    if (page !== "markets") setMarketsViewMenuOpen(false);
    if (page === "rankings") {
      renderRankings();
    } else if (page === "ownership") {
      renderOwnership();
    } else if (page === "expected") {
      renderExpected();
    } else if (page === "schedule") {
      renderSchedule();
    } else if (page === "feed") {
      renderFeed();
    } else if (page === "markets") {
      renderMarkets();
    } else if (page === "opta") {
      renderTable();
    } else if (page === "team") {
      renderTeam();
    } else if (page === "notes") {
      renderNotes();
    }
    // Enter after content is in the DOM so the animation covers real layout.
    playPageEnter(pagePaneFor(page));
    requestAnimationFrame(() => {
      syncAllSegThumbs({ animate: false });
      scrollActivePageTabIntoView();
      if (page === "ownership") renderOwnership();
    });
    syncExpectedCatToolbar();
    syncMarketsViewControls();
  }

  el.pageOpta.addEventListener("click", () => setPage("opta"));
  el.pageRankings.addEventListener("click", () => setPage("rankings"));
  if (el.pageOwnership) el.pageOwnership.addEventListener("click", () => setPage("ownership"));
  if (el.ownershipTrendingToggle) {
    el.ownershipTrendingToggle.addEventListener("click", () => {
      state.ownershipTrending = !state.ownershipTrending;
      syncOwnershipTrendingUI();
      if (state.page === "ownership") renderOwnership();
    });
  }
  if (el.ownershipTrendCards) {
    el.ownershipTrendCards.addEventListener("pointerover", (e) => {
      if (!hasFineHover()) return;
      const row = e.target.closest("[data-ownership-key]");
      if (!row || !el.ownershipTrendCards.contains(row)) return;
      if (e.relatedTarget && row.contains(e.relatedTarget)) return;
      const key = row.getAttribute("data-ownership-key");
      if (!key || ownershipHoverKey === key) return;
      hoverOwnershipSeries(key);
    });
    // Clear only when the pointer leaves the cards entirely — clearing per row
    // would blink the chart while scrubbing between names.
    el.ownershipTrendCards.addEventListener("pointerleave", () => {
      if (!hasFineHover()) return;
      if (!ownershipHoverKey) return;
      setOwnershipHover(null, null);
      hideOwnershipTooltip();
    });
    el.ownershipTrendCards.addEventListener("click", (e) => {
      const row = e.target.closest("[data-ownership-key]");
      if (!row) return;
      const key = row.getAttribute("data-ownership-key");
      const series = ownershipSeriesCache.find((s) => s.key === key);
      if (!series) return;
      const lastIdx = ownershipLastOwnedIndex(series);
      setOwnershipHover(key, lastIdx);
      if (hasFineHover()) {
        const wrap = el.ownershipChartWrap && el.ownershipChartWrap.getBoundingClientRect();
        if (wrap) {
          showOwnershipTooltip(
            wrap.left + wrap.width * 0.72,
            wrap.top + wrap.height * 0.28,
            ownershipTooltipHTML(series, lastIdx)
          );
        }
      }
    });
  }
  if (el.pageTeam) el.pageTeam.addEventListener("click", () => setPage("team"));
  if (el.pageNotes) el.pageNotes.addEventListener("click", () => setPage("notes"));
  el.pageExpected.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Mobile / narrow: plain page tab — category lives in the toolbar.
    if (preferMobileSheet()) {
      setExpectedCatMenuOpen(false);
      setPage("expected");
      return;
    }
    // Desktop wide: toggle the category menu. Hover still opens via CSS + mouseenter.
    buildExpectedCatMenu();
    const willOpen = !el.expectedTabWrap.classList.contains("open");
    setExpectedCatMenuOpen(willOpen);
    setPage("expected");
  });
  if (el.expectedCatBtn) {
    el.expectedCatBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!preferMobileSheet() || state.page !== "expected") return;
      if (mobileSheetOpen && mobileSheetKey === "expected-cats") {
        closeMobileSheet();
        syncExpectedCatToolbar();
        return;
      }
      openExpectedCatSheet();
      syncExpectedCatToolbar();
    });
  }
  el.pageSchedule.addEventListener("click", () => setPage("schedule"));
  if (el.pageFeed) el.pageFeed.addEventListener("click", () => setPage("feed"));
  if (el.pageTrayBtn) {
    el.pageTrayBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setPageTrayOpen(!pageTrayIsOpen());
    });
  }
  let marketsMenuCloseTimer = 0;
  function cancelMarketsMenuClose() {
    window.clearTimeout(marketsMenuCloseTimer);
  }
  function armMarketsMenuClose() {
    cancelMarketsMenuClose();
    marketsMenuCloseTimer = window.setTimeout(() => {
      if (el.marketsTabWrap?.matches(":hover")) return;
      if (el.marketsViewMenu?.matches(":hover")) return;
      setMarketsViewMenuOpen(false);
    }, 180);
  }

  if (el.pageMarkets) {
    el.pageMarkets.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Mobile / narrow: plain page tab — view picker lives in the toolbar.
      if (preferMobileSheet()) {
        setMarketsViewMenuOpen(false);
        setPage("markets");
        requestAnimationFrame(scrollActivePageTabIntoView);
        return;
      }
      // Desktop: same as xData — toggle the view menu and land on Markets.
      cancelMarketsMenuClose();
      buildMarketsViewMenu();
      const willOpen = !el.marketsTabWrap?.classList.contains("open");
      setMarketsViewMenuOpen(willOpen);
      setPage("markets");
      requestAnimationFrame(scrollActivePageTabIntoView);
    });
  }
  // Mobile: also accept taps on the wrap (caret/gap) so the last tab isn't missed.
  if (el.marketsTabWrap) {
    el.marketsTabWrap.addEventListener(
      "click",
      (e) => {
        if (!preferMobileSheet()) return;
        if (e.target.closest("#page-markets")) return; // button handler already ran
        e.preventDefault();
        e.stopPropagation();
        setMarketsViewMenuOpen(false);
        setPage("markets");
        requestAnimationFrame(scrollActivePageTabIntoView);
      },
      true
    );
  }
  if (el.marketsTabWrap) {
    el.marketsTabWrap.addEventListener("mouseenter", () => {
      if (preferMobileSheet()) return;
      if (!hasFineHover()) return;
      cancelMarketsMenuClose();
      buildMarketsViewMenu();
      setMarketsViewMenuOpen(true);
    });
    el.marketsTabWrap.addEventListener("mouseleave", () => {
      if (preferMobileSheet()) return;
      if (!hasFineHover()) return;
      armMarketsMenuClose();
    });
  }
  if (el.marketsViewMenu) {
    el.marketsViewMenu.addEventListener("mouseenter", () => {
      if (preferMobileSheet()) return;
      if (!hasFineHover()) return;
      cancelMarketsMenuClose();
    });
    el.marketsViewMenu.addEventListener("mouseleave", () => {
      if (preferMobileSheet()) return;
      if (!hasFineHover()) return;
      armMarketsMenuClose();
    });
  }
  if (el.expectedTabWrap) {
    el.expectedTabWrap.addEventListener("mouseenter", () => {
      if (preferMobileSheet()) return;
      if (!hasFineHover()) return;
      buildExpectedCatMenu();
      setExpectedCatMenuOpen(true);
    });
    el.expectedTabWrap.addEventListener("mouseleave", () => {
      if (preferMobileSheet()) return;
      if (!hasFineHover()) return;
      setExpectedCatMenuOpen(false);
    });
  }
  document.addEventListener("click", (e) => {
    if (preferMobileSheet()) return;
    if (!hasFineHover()) return;
    if (!el.expectedTabWrap || !el.expectedTabWrap.classList.contains("open")) return;
    if (!el.expectedTabWrap.contains(e.target)) setExpectedCatMenuOpen(false);
  });
  document.addEventListener("click", (e) => {
    if (preferMobileSheet()) return;
    if (!hasFineHover()) return;
    if (!el.marketsTabWrap || !el.marketsTabWrap.classList.contains("open")) return;
    if (!el.marketsTabWrap.contains(e.target)) setMarketsViewMenuOpen(false);
  });
  window.addEventListener("resize", () => {
    syncPageTabsScrollHints();
    syncExpectedCatToolbar();
    syncMarketsViewControls();
    syncBarbellHeadHeight();
    if (preferMobileSheet()) {
      setExpectedCatMenuOpen(false);
      setMarketsViewMenuOpen(false);
      return;
    }
    if (!hasFineHover()) return;
    if (el.expectedTabWrap?.classList.contains("open")) {
      if (tabMenuNeedsFixedPosition()) {
        positionExpectedCatMenuFixed();
      } else {
        clearExpectedCatMenuPosition();
      }
    }
    if (el.marketsTabWrap?.classList.contains("open")) {
      if (tabMenuNeedsFixedPosition()) {
        positionMarketsViewMenuFixed();
      } else {
        clearMarketsViewMenuPosition();
      }
    }
  });
  window.addEventListener(
    "scroll",
    () => {
      if (!hasFineHover()) return;
      if (el.expectedTabWrap?.classList.contains("open")) setExpectedCatMenuOpen(false);
    },
    true
  );

  function pageTabsAreScrollable() {
    const tabs = el.pageTabs;
    if (!tabs || NARROW_MQ.matches) return false;
    return tabs.scrollWidth > tabs.clientWidth + 2;
  }

  function scrollActivePageTabIntoView() {
    const tabs = el.pageTabs;
    if (!tabs || !pageTabsAreScrollable()) return;
    const activeBtn = tabs.querySelector(".page-tab-btn.active");
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
  }

  function tabMenuNeedsFixedPosition() {
    // Absolute menus under a scrollable tab strip force overflow:visible,
    // which resets scrollLeft and makes the rightmost tab (Markets) jump away.
    return (
      !hasFineHover() ||
      pageTabsAreScrollable() ||
      window.matchMedia("(max-width: 1100px)").matches
    );
  }

  function syncPageTabsScrollHints() {
    const tabs = el.pageTabs;
    const clip = el.pageTabsClip;
    if (!tabs || !clip) return;
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
    el.pageTabs.addEventListener("scroll", syncPageTabsScrollHints, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      const tabsRo = new ResizeObserver(() => syncPageTabsScrollHints());
      tabsRo.observe(el.pageTabs);
      if (el.pageTabsClip) tabsRo.observe(el.pageTabsClip);
    }
  }

  // Brand mark always returns to OPTA (home) with a full refresh so filters
  // and ephemeral UI state reset alongside the page switch.
  const brandHome = document.querySelector("#brand-home");
  if (brandHome) {
    brandHome.addEventListener("click", (e) => {
      e.preventDefault();
      try {
        localStorage.setItem(PAGE_KEY, "opta");
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
    state.sortKey = view === "players" && isNextSeason() ? "price" : "pts";
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
    el.inactiveFilterGroup.style.display =
      view === "players" && HAS_PRICE_DATA && !isNextSeason() ? "" : "none";
    el.valueModeGroup.style.display = view === "players" ? "" : "none";
    el.newpriceWrap.style.display = view === "players" && !isNextSeason() ? "" : "none";
    if (state.page === "ownership") {
      el.valueModeGroup.style.display = "none";
      el.minutesFilterGroup.style.display = "none";
      if (el.setpieceFilterGroup) el.setpieceFilterGroup.style.display = "none";
      el.newpriceWrap.style.display = "none";
    }
    state.enhancePct = view === "players" ? ENHANCE_PCT_PLAYERS : ENHANCE_PCT_TEAMS;
    updateEnhancePctSlider();
    syncHighlightUI();
    if (view !== "players" && state.valueMode !== "total") {
      setValueMode("total", { rerender: false });
    }
    if ((view !== "players" || isNextSeason()) && state.showNewPrice) {
      state.showNewPrice = false;
      el.newpriceIssuesPanel.classList.remove("open");
      syncShowNewPriceUI();
    }
    renderColumnsPanel();
    if (state.page === "expected") renderExpected();
    else {
      buildExpectedCatMenu();
      syncExpectedCatToolbar();
    }
    renderTable();
    if (view === "players") {
      requestAnimationFrame(() => syncSegThumb(el.valueModeSeg, { animate: false }));
    }
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

  if (el.feedFiltersToggle) {
    el.feedFiltersToggle.addEventListener("click", () => {
      const open = hasFineHover()
        ? el.feedControls && el.feedControls.classList.contains("collapsed")
        : !(mobileSheetOpen && mobileSheetKey === "feed-filters");
      setFeedFiltersOpen(!!open);
    });
  }

  if (el.feedRangeSeg) {
    el.feedRangeSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-feed-range]");
      if (!btn) return;
      const range = btn.dataset.feedRange;
      if (!range || range === state.feedRange) return;
      if (range !== "today" && range !== "3d" && range !== "7d") return;
      state.feedRange = range;
      syncFeedRangeSeg();
      syncFeedFiltersToggle();
      renderFeed();
    });
  }

  const feedResultsRoot = el.feedTrending || el.feedList;
  if (feedResultsRoot) {
    feedResultsRoot.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-feed-widen]");
      if (!btn) return;
      const range = btn.dataset.feedWiden;
      if (range !== "today" && range !== "3d" && range !== "7d") return;
      if (range === state.feedRange) return;
      state.feedRange = range;
      syncFeedRangeSeg();
      syncFeedFiltersToggle();
      renderFeed();
    });
  }

  function clearFeedTypeFilter() {
    state.feedTypeFilter.clear();
    buildFeedTypeChips();
    syncFeedFiltersToggle();
    renderFeed();
  }

  function clearFeedTeamFilter() {
    state.feedTeamFilter.clear();
    buildFeedTeamChips();
    syncFeedFiltersToggle();
    renderFeed();
  }

  if (el.feedResetTypes) {
    el.feedResetTypes.addEventListener("click", clearFeedTypeFilter);
    el.feedResetTypes.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        clearFeedTypeFilter();
      }
    });
  }
  if (el.feedResetTeams) {
    el.feedResetTeams.addEventListener("click", clearFeedTeamFilter);
    el.feedResetTeams.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        clearFeedTeamFilter();
      }
    });
  }

  function feedSearchAlwaysOpen() {
    return !hasFineHover() || NARROW_MQ.matches;
  }

  function closeFeedSearch({ clear = false } = {}) {
    if (!el.feedSearchWrap) return;
    if (feedSearchAlwaysOpen()) {
      if (clear && el.feedSearch) {
        el.feedSearch.value = "";
        renderFeed();
      }
      syncSearchClearBtns();
      return;
    }
    el.feedSearchWrap.classList.remove("search-open");
    if (el.feedSearchToggle) el.feedSearchToggle.setAttribute("aria-expanded", "false");
    if (clear && el.feedSearch) {
      el.feedSearch.value = "";
      renderFeed();
    }
    syncSearchClearBtns();
  }

  function openFeedSearch() {
    if (!el.feedSearchWrap) return;
    el.feedSearchWrap.classList.add("search-open");
    if (el.feedSearchToggle) el.feedSearchToggle.setAttribute("aria-expanded", "true");
    syncSearchClearBtns();
    requestAnimationFrame(() => {
      if (el.feedSearch) el.feedSearch.focus({ preventScroll: true });
    });
  }

  function syncFeedSearchLayout() {
    if (!el.feedSearchWrap) return;
    if (feedSearchAlwaysOpen()) {
      el.feedSearchWrap.classList.add("search-open", "feed-search-always-open");
      if (el.feedSearchToggle) el.feedSearchToggle.setAttribute("aria-expanded", "true");
    } else {
      el.feedSearchWrap.classList.remove("feed-search-always-open");
      if (!(el.feedSearch && el.feedSearch.value.trim())) {
        el.feedSearchWrap.classList.remove("search-open");
        if (el.feedSearchToggle) el.feedSearchToggle.setAttribute("aria-expanded", "false");
      }
    }
    syncSearchClearBtns();
  }

  if (el.feedSearchToggle) {
    el.feedSearchToggle.addEventListener("click", () => {
      if (feedSearchAlwaysOpen()) return;
      if (el.feedSearchWrap && el.feedSearchWrap.classList.contains("search-open")) {
        closeFeedSearch();
      } else {
        openFeedSearch();
      }
    });
  }

  if (el.feedSearch) {
    let feedSearchTimer;
    el.feedSearch.addEventListener("input", () => {
      syncSearchClearBtns();
      clearTimeout(feedSearchTimer);
      feedSearchTimer = setTimeout(() => renderFeed(), 120);
    });
    el.feedSearch.addEventListener("focus", () => {
      syncSearchClearBtns();
    });
    el.feedSearch.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (feedSearchAlwaysOpen()) {
          if (el.feedSearch.value) {
            el.feedSearch.value = "";
            renderFeed();
            syncSearchClearBtns();
          } else {
            el.feedSearch.blur();
          }
        } else {
          closeFeedSearch();
        }
      }
    });
  }

  document.addEventListener("click", (e) => {
    if (feedSearchAlwaysOpen()) return;
    if (!el.feedSearchWrap || !el.feedSearchWrap.classList.contains("search-open")) return;
    if (el.feedSearchWrap.contains(e.target)) return;
    if (el.feedSearch && el.feedSearch.value.trim()) return;
    closeFeedSearch();
  });

  let searchTimer;

  function syncSearchClearBtns() {
    const pairs = [
      { input: el.search, btn: el.searchClearBtn, wrap: el.searchWrap },
      { input: el.feedSearch, btn: el.feedSearchClearBtn, wrap: el.feedSearchWrap },
    ];
    for (const { input, btn, wrap } of pairs) {
      if (!btn) continue;
      const open = !wrap || wrap.classList.contains("search-open");
      const hasQuery = !!(input && String(input.value || "").trim());
      btn.hidden = !(open && hasQuery);
    }
  }

  function clearMainSearch() {
    if (el.search) {
      el.search.value = "";
      el.search.focus({ preventScroll: true });
    }
    state.search = "";
    syncSearchClearBtns();
    if (state.page === "team") renderTeam();
    else if (state.page !== "rankings") renderTable();
  }

  function clearFeedSearchInput() {
    if (el.feedSearch) {
      el.feedSearch.value = "";
      el.feedSearch.focus({ preventScroll: true });
    }
    syncSearchClearBtns();
    renderFeed();
  }

  function teamSearchAlwaysOpen() {
    return state.page === "team" && !preferMobileSheet();
  }

  function mainSearchAlwaysOpen() {
    return (state.page === "team" || state.page === "opta") && !preferMobileSheet();
  }

  function syncTeamSearchHost() {
    if (!el.searchWrap) return;
    const home = el.searchHome;
    if (home && el.searchWrap.parentElement !== home) home.appendChild(el.searchWrap);
    // Rankings: no search — hide the control entirely.
    el.searchWrap.style.display = state.page === "rankings" ? "none" : "";
    el.searchWrap.classList.toggle("team-search-always-open", teamSearchAlwaysOpen());
    el.searchWrap.classList.toggle(
      "stats-search-always-open",
      state.page === "opta" && !preferMobileSheet()
    );
    if (state.page === "rankings") {
      el.searchWrap.classList.remove("search-open");
      if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "false");
    } else if (mainSearchAlwaysOpen()) {
      el.searchWrap.classList.add("search-open");
      if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "true");
    } else if (!(el.search && el.search.value.trim())) {
      el.searchWrap.classList.remove("search-open");
      if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "false");
    }
    syncSearchClearBtns();
    syncTeamSearchCombobox();
  }

  function closeMobileSearch({ clear = false } = {}) {
    if (!el.searchWrap) return;
    if (mainSearchAlwaysOpen() && !clear) return;
    el.searchWrap.classList.remove("search-open");
    if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "false");
    if (clear) {
      if (el.search) el.search.value = "";
      state.search = "";
    }
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
    if (mainSearchAlwaysOpen()) return;
    if (!el.searchWrap) return;
    if (!el.searchWrap.classList.contains("search-open")) return;
    if (el.searchWrap.contains(e.target)) return;
    if (el.search && el.search.value.trim()) return;
    closeMobileSearch();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!el.searchWrap?.classList.contains("search-open")) return;
    if (mainSearchAlwaysOpen()) return;
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
      if (state.page === "team") renderTeam();
      else renderTable();
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
  if (el.feedSearchClearBtn) {
    el.feedSearchClearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearFeedSearchInput();
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
    format: (v) => Math.round(v).toLocaleString(),
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
    format: (value) => `${value.toFixed(1)}%+`,
  });

  const updateOwnershipTrendThresholdSlider = setupSingleSlider({
    input: el.ownershipTrendThreshold,
    fillEl: el.ownershipTrendThresholdFill,
    labelEl: el.ownershipTrendThresholdLabel,
    boundsMin: 0.1,
    boundsMax: OWNERSHIP_TREND_THRESHOLD_MAX,
    step: 0.1,
    get: () => state.ownershipTrendThreshold,
    set: (value) => {
      state.ownershipTrendThreshold = value;
    },
    format: (value) =>
      `${value.toFixed(1)} pp recent · ${(value * 2).toFixed(1)} pp net`,
    onInput: renderOwnership,
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

  if (el.fixtureTtDelay && el.fixtureTtDelayFill && el.fixtureTtDelayLabel) {
    setupSingleSlider({
      input: el.fixtureTtDelay,
      fillEl: el.fixtureTtDelayFill,
      labelEl: el.fixtureTtDelayLabel,
      boundsMin: FIXTURE_TT_DELAY_SEC_MIN,
      boundsMax: FIXTURE_TT_DELAY_SEC_MAX,
      step: 0.1,
      get: () => fixtureTtDelaySec,
      set: (v) => {
        fixtureTtDelaySec = clampFixtureTtDelaySec(v);
        try {
          localStorage.setItem(FIXTURE_TT_DELAY_KEY, String(fixtureTtDelaySec));
        } catch {
          /* private browsing */
        }
      },
      format: (v) => `${clampFixtureTtDelaySec(v).toFixed(1)}s`,
      onInput: () => {},
    });
  }

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

  if (el.marketsViewToolbarBtn) {
    el.marketsViewToolbarBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!preferMobileSheet() || state.page !== "markets") return;
      if (mobileSheetOpen && mobileSheetKey === "markets-view") {
        closeMobileSheet();
        syncMarketsViewControls();
        return;
      }
      openMarketsViewSheet();
      syncMarketsViewControls();
    });
  }
  buildMarketsViewMenu();
  syncMarketsViewControls();

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

  if (HAS_PRICE_DATA) {
    el.showDepartedCheck.addEventListener("change", () => {
      state.hideDeparted = !el.showDepartedCheck.checked;
      renderTable();
    });
  }

  if (el.setpieceTakersCheck) {
    el.setpieceTakersCheck.addEventListener("change", () => {
      state.setPieceTakersOnly = !!el.setpieceTakersCheck.checked;
      syncFiltersResetUI();
      renderTable();
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
    state.priceMin = defaultMinPrice();
    state.priceMax = bounds.price.max;
    state.ownedMin = OWNERSHIP_FILTER_DEFAULT;
    state.minsMin = defaultMinMinutes();
    state.minsMax = bounds.mins.max;
    updatePriceSlider();
    updateOwnedSlider();
    updateMinsSlider();
  }

  function syncSeasonChrome() {
    const next = isNextSeason();
    if (el.seasonSelect && el.seasonSelect.value !== state.season) {
      el.seasonSelect.value = state.season;
    }
    el.newpriceWrap.style.display = state.view === "players" && !next ? "" : "none";
    el.inactiveFilterGroup.style.display =
      state.view === "players" && HAS_PRICE_DATA && !next ? "" : "none";
    if (next) {
      state.showNewPrice = false;
      el.newpriceIssuesPanel.classList.remove("open");
      syncShowNewPriceUI();
    }
  }

  function setSeason(season, { rerender = true } = {}) {
    if (season !== "2025-26" && season !== "2026-27") return;
    if (state.season === season) return;
    state.season = season;
    // Drop team filters that don't exist in the destination season's chip set.
    const allowed = new Set(teamCodesForSeason());
    state.teamFilter.forEach((code) => {
      if (!allowed.has(code)) state.teamFilter.delete(code);
    });
    state.compareSelection.players.clear();
    state.compareSelection.teams.clear();
    state.rankingsPins.length = 0;
    // 2026/27 is preseason zeros — price is the useful default sort.
    if (state.view === "players") {
      state.sortKey = isNextSeason() ? "price" : "pts";
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

  // ---------------------------------------------------------------------
  // 2026/27 price toggle + manual-review list for build-time price matches
  // (see match_new_season_prices() in site/build.py). Matching runs at
  // build time — players who need a human to disambiguate their 2026/27
  // price show up in DATA.priceMatchIssues rather than being guessed at.
  // ---------------------------------------------------------------------
  function syncShowNewPriceUI() {
    el.newpriceToggle.classList.toggle("on", state.showNewPrice);
  }

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

  el.newpriceIssuesBadge.addEventListener("click", () => {
    el.newpriceIssuesPanel.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!el.newpriceIssuesPanel.contains(e.target) && !el.newpriceIssuesBadge.contains(e.target)) {
      el.newpriceIssuesPanel.classList.remove("open");
    }
  });

  // Highlight Top/Bottom % is always on for Statistics; show the slider
  // whenever that page is active. Bands always use the full view.
  function syncHighlightUI() {
    el.enhancePctGroup.style.display = state.page === "opta" ? "" : "none";
    if (el.enhancePctHint) {
      el.enhancePctHint.textContent = `of all ${state.view}`;
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
    renderTable();
  });

  el.compareClear.addEventListener("click", () => {
    compareSet().clear();
    renderTable();
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

  // ---------------------------------------------------------------------
  // TEMP font lab — swap --sans / --mono across the app while evaluating pairs
  // ---------------------------------------------------------------------
  const FONT_PAIR_KEY = "fpl-explorer-font-pair-v2";
  const FONT_PAIR_DEFAULT = "manrope-fira";
  const FONT_PAIRS = {
    system: {
      sans: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    },
    "inter-jb": {
      sans: '"Inter", ui-sans-serif, system-ui, sans-serif',
      mono: '"JetBrains Mono", ui-monospace, monospace',
    },
    plex: {
      sans: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
      mono: '"IBM Plex Mono", ui-monospace, monospace',
    },
    "jakarta-jb": {
      sans: '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif',
      mono: '"JetBrains Mono", ui-monospace, monospace',
    },
    source: {
      sans: '"Source Sans 3", ui-sans-serif, system-ui, sans-serif',
      mono: '"Source Code Pro", ui-monospace, monospace',
    },
    dm: {
      sans: '"DM Sans", ui-sans-serif, system-ui, sans-serif',
      mono: '"DM Mono", ui-monospace, monospace',
    },
    "manrope-fira": {
      sans: '"Manrope", ui-sans-serif, system-ui, sans-serif',
      mono: '"Fira Code", ui-monospace, monospace',
    },
    "figtree-plex": {
      sans: '"Figtree", ui-sans-serif, system-ui, sans-serif',
      mono: '"IBM Plex Mono", ui-monospace, monospace',
    },
    "sora-jb": {
      sans: '"Sora", ui-sans-serif, system-ui, sans-serif',
      mono: '"JetBrains Mono", ui-monospace, monospace',
    },
    space: {
      sans: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
      mono: '"Space Mono", ui-monospace, monospace',
    },
  };

  function applyFontPair(id) {
    const resolved = id in FONT_PAIRS ? id : FONT_PAIR_DEFAULT;
    const pair = FONT_PAIRS[resolved];
    const root = document.documentElement;
    root.style.setProperty("--sans", pair.sans);
    root.style.setProperty("--mono", pair.mono);
    root.setAttribute("data-font-pair", resolved);
    try {
      localStorage.setItem(FONT_PAIR_KEY, resolved);
    } catch {
      /* private browsing */
    }
    if (el.fontPairSelect) el.fontPairSelect.value = resolved;
  }

  if (el.fontPairSelect) {
    let saved = FONT_PAIR_DEFAULT;
    try {
      saved = localStorage.getItem(FONT_PAIR_KEY) || FONT_PAIR_DEFAULT;
    } catch {
      saved = FONT_PAIR_DEFAULT;
    }
    applyFontPair(saved);
    el.fontPairSelect.addEventListener("change", () => {
      applyFontPair(el.fontPairSelect.value);
    });
  }

  // Drop legacy UI-scale zoom so fixed chrome widths stay stable.
  try {
    localStorage.removeItem("fpl-explorer-ui-scale");
    localStorage.removeItem("fpl-explorer-font-pair");
  } catch {
    /* private browsing */
  }
  document.documentElement.style.removeProperty("--ui-scale");

  function applyClockFormat(value) {
    clockFormat = value === "24" ? "24" : "12";
    try {
      localStorage.setItem(CLOCK_FORMAT_KEY, clockFormat);
    } catch {
      /* private browsing */
    }
    if (el.clockFormatSelect) el.clockFormatSelect.value = clockFormat;
    if (typeof renderMarkets === "function") renderMarkets();
    if (typeof renderFeed === "function" && state.page === "feed") renderFeed();
  }

  if (el.clockFormatSelect) {
    el.clockFormatSelect.value = clockFormat;
    el.clockFormatSelect.addEventListener("change", () => {
      applyClockFormat(el.clockFormatSelect.value);
    });
  }

  syncPageInfoButton();

  function setPrefsOpen(open) {
    if (!el.prefsPanel || !el.prefsBtn) return;
    if (open) syncTeamClearBtn();
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
  }

  function syncColumnsPanelHost() {
    if (!el.columnsList) return;
    const inFilters = columnsLiveInFilters();
    const mobile = preferMobileSheet();
    // Statistics column toggles stay out of the mobile Filters sheet — no
    // Columns toolbar icon there either. Mid-width desktop still embeds them.
    const optaInFilters = state.page === "opta" && inFilters && !mobile;
    const host = optaInFilters ? el.sidebarColumnsHost : el.columnsSidebar;
    if (host && el.columnsList.parentElement !== host) {
      host.appendChild(el.columnsList);
    }
    if (el.sidebarColumnsHost) {
      el.sidebarColumnsHost.hidden = !optaInFilters;
    }
    if (el.columnsBtn) {
      el.columnsBtn.style.display =
        state.page === "opta" && !inFilters && !mobile ? "" : "none";
      if (inFilters || mobile) {
        el.columnsBtn.setAttribute("aria-expanded", "false");
        el.columnsBtn.classList.remove("on");
      }
    }
    if (el.columnsSidebar) {
      el.columnsSidebar.style.display =
        state.page === "opta" && !inFilters && !mobile ? "" : "none";
      if (inFilters || mobile) el.columnsSidebar.classList.add("collapsed");
    }
    // Close a leftover Columns sheet if the layout flipped to in-filters.
    if ((inFilters || mobile) && mobileSheetOpen && mobileSheetKey === "columns") {
      closeMobileSheet();
    }
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
    syncAllNameColumnSimplifies();
    syncExpectedCatToolbar();
    syncMarketsViewControls();
  });
  bindMqChange(NARROW_MQ, () => {
    syncColumnsPanelHost();
    syncAllNameColumnSimplifies();
    syncExpectedCatToolbar();
    syncMarketsViewControls();
    setPageTrayOpen(false);
    syncPageTrayTrigger();
  });
  bindMqChange(COLUMNS_IN_FILTERS_MQ, syncColumnsPanelHost);
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

  if (el.fplIdSave) {
    el.fplIdSave.addEventListener("click", () => {
      applyManagerId(el.fplIdInput ? el.fplIdInput.value : "");
    });
  }
  if (el.fplIdClear) {
    el.fplIdClear.addEventListener("click", () => clearManagerId());
  }
  if (el.teamModeSeg) {
    el.teamModeSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-team-mode]");
      if (!btn) return;
      setTeamMode(btn.getAttribute("data-team-mode"));
    });
  }
  if (el.teamResyncBtn) {
    el.teamResyncBtn.addEventListener("click", () => requestResyncPlanner());
  }
  if (el.notesGroupSeg) {
    el.notesGroupSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-notes-group]");
      if (!btn) return;
      state.notesGroupBy = btn.getAttribute("data-notes-group") || "none";
      renderNotes();
    });
  }
  if (el.notesCollage) {
    el.notesCollage.addEventListener("click", (e) => {
      const del = e.target.closest("[data-note-delete]");
      if (!del) return;
      const id = del.getAttribute("data-note-delete");
      openConfirmModal({
        title: "Delete note?",
        message: "This removes the comment permanently from this browser.",
        okLabel: "Delete",
      }).then((ok) => {
        if (ok) deleteNote(id);
      });
    });
  }
  if (el.noteModal) {
    el.noteModal.addEventListener("click", (e) => {
      if (e.target.closest("[data-note-cancel]")) {
        closeNoteModal();
        return;
      }
      if (e.target.closest("#note-modal-save")) saveNoteFromModal();
    });
  }
  if (el.noteContextMenu) {
    el.noteContextMenu.addEventListener("click", (e) => {
      if (e.target.closest("[data-note-add]") && noteDraft && noteDraft.target) {
        openNoteModal(noteDraft.target);
      }
    });
    el.noteContextMenu.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  document.addEventListener("pointerdown", (e) => {
    if (!el.noteContextMenu || !el.noteContextMenu.classList.contains("open")) return;
    if (Date.now() - noteMenuOpenedAt < 350) return;
    if (e.target.closest("#note-context-menu")) return;
    closeNoteContextMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (el.noteModal && !el.noteModal.hidden) {
      closeNoteModal();
      return;
    }
    closeNoteContextMenu();
  });
  if (el.teamClearBtn) {
    el.teamClearBtn.addEventListener("click", () => {
      setPrefsOpen(false);
      requestClearTeamSquad();
    });
  }
  if (el.fplIdInput) {
    el.fplIdInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyManagerId(el.fplIdInput.value);
      }
    });
  }

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
      return;
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
    buildFeedTypeChips();
    buildFeedTeamChips();
    syncFeedRangeSeg();
    syncFeedSearchLayout();
    upgradeNativeTitles();
    renderPriceIssuesPanel();
    loadNotes();
    await restoreManagerId();
    // Filters start closed on every page and viewport; the toolbar button opens them.
    el.sidebar.classList.add("collapsed");
    el.sidebarToggle.classList.remove("on");
    el.sidebarToggle.setAttribute("aria-pressed", "false");
    setView("players");
    buildExpectedCatMenu();
    // setView renders the OPTA table, so restoring the page comes last.
    setPage(storedPage());
    // Position sliding thumbs after layout (sidebar/page visibility settled).
    requestAnimationFrame(() => {
      syncAllSegThumbs({ animate: false });
      syncPageTabsScrollHints();
      requestAnimationFrame(() => {
        syncAllSegThumbs({ animate: false });
        syncPageTabsScrollHints();
      });
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
      syncFeedSearchLayout();
      syncTeamSearchHost();
      syncPageTabsScrollHints();
      syncAllNameColumnSimplifies();
    });
    if (typeof NARROW_MQ.addEventListener === "function") {
      NARROW_MQ.addEventListener("change", () => {
        syncFeedSearchLayout();
        syncTeamSearchHost();
      });
    } else if (typeof NARROW_MQ.addListener === "function") {
      NARROW_MQ.addListener(() => {
        syncFeedSearchLayout();
        syncTeamSearchHost();
      });
    }
    bindAllNameColumnSimplifies();
  }

  init();
})();
