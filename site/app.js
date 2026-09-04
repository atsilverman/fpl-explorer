/* FPL Data Explorer — client-side filter/sort/group/aggregate over the
   embedded season data in data.js. No build step needed to browse; run
   build.py again if the source CSVs change. */

(function () {
  "use strict";

  const DATA = window.FPL_DATA;
  const MARKETS = window.FPL_MARKETS || { generatedAt: null, meta: {}, fixtures: [] };
  const OWNERSHIP = window.FPL_OWNERSHIP || { generatedAt: null, checkIns: [] };
  const PRICES = window.FPL_PRICE_CHANGES || {
    generatedAt: null,
    players: [],
    nextChangeAt: null,
    actualChanges: [],
  };
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
    chipWindow: null,
    ownersByElement: {},
    elementGw: {},
    leaguePicksStatus: null,
    transfersSchemaVersion: 0,
    transfersByEntry: {},
    gwAwaitingKickoff: null,
    error: null,
  };
  if (HOME.transfersSchemaVersion == null) HOME.transfersSchemaVersion = 0;
  if (HOME.gwAwaitingKickoff == null) HOME.gwAwaitingKickoff = null;
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
  // Badge SVGs have no index.html ?v= — bump when crest tiles change so browsers
  // don't keep serving cached legacy tall shields under the same path.
  const BADGE_CACHE_V = "5";
  function badgeSrc(src) {
    if (!src) return src;
    const join = src.includes("?") ? "&" : "?";
    return `${src}${join}v=${BADGE_CACHE_V}`;
  }
  // Club primary — team abbreviations (Ownership etc.), photo/crest rings, scatter.
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

  function teamAccentDecl(teamCode) {
    const accent = TEAM_SCATTER_ACCENT[teamCode];
    return accent ? `--team-accent:${accent}` : "";
  }

  function teamAccentRelativeLuminance(hex) {
    if (!hex || hex[0] !== "#" || hex.length < 7) return 1;
    const n = parseInt(hex.slice(1, 7), 16);
    const channels = [16, 8, 0].map((shift) => ((n >> shift) & 255) / 255);
    const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }

  /** Inline attrs for club-code tags in player sublines (Ownership, Prices, …). */
  function teamTagAttrs(teamCode) {
    const accent = TEAM_SCATTER_ACCENT[teamCode];
    if (!accent) return { style: "", className: "" };
    const darkAccent = teamAccentRelativeLuminance(accent) < 0.15;
    return {
      style: ` style="--team-accent:${accent}"`,
      className: darkAccent ? " is-dark-team-accent" : "",
    };
  }

  /** Class + style attrs for a thin club-colour ring around photos / crests. */
  function teamRingAttrs(teamCode) {
    const decl = teamAccentDecl(teamCode);
    if (!decl) return { className: "", attr: "" };
    return { className: " has-team-ring", attr: ` style="${decl}"` };
  }
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
  // Exact abbreviation queries ("ARS", "MUN") must match club codes, not
  // accidental name substrings (e.g. "ars" in Strand Larsen).
  const KNOWN_TEAM_CODES_LOWER = new Set(
    [...ALL_TEAM_CODES, ...TEAM_CODES, ...Object.keys(TEAM_NAMES)].map((c) =>
      String(c || "").toLowerCase()
    )
  );
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
  // Prefer live Home GW when the static ownership/data.js triad lags behind FPL.
  function activeGameweek() {
    const liveGw = livePlanningGw();
    const cur = Number(GAMEWEEKS.current && GAMEWEEKS.current.id);
    if (Number.isFinite(liveGw) && liveGw > 0) {
      if (!Number.isFinite(cur) || liveGw >= cur) return liveGw;
    }
    if (Number.isFinite(cur)) return cur;
    const nxt = Number(GAMEWEEKS.next && GAMEWEEKS.next.id);
    if (Number.isFinite(nxt)) return nxt;
    const meta = DATA.fixturesMeta || {};
    const active = Number(meta.activeGw != null ? meta.activeGw : meta.currentGw);
    if (Number.isFinite(active)) return active;
    return SCHEDULE_GW_MIN;
  }

  /** Live display GW from Home cache when linked (may run ahead of static bundles). */
  function livePlanningGw() {
    const liveGw = Number(HOME && HOME.gw);
    return Number.isFinite(liveGw) && liveGw > 0 ? liveGw : null;
  }

  /** True after next GW deadline while FPL still marks the prior GW as current. */
  function postDeadlineBeforeNextCurrent() {
    const cur = GAMEWEEKS.current;
    const nxt = GAMEWEEKS.next;
    if (!cur || !nxt || cur.id == null || nxt.id == null) return false;
    if (Number(cur.id) >= Number(nxt.id)) return false;
    const liveGw = livePlanningGw();
    if (Number.isFinite(liveGw) && liveGw >= Number(nxt.id)) return false;
    const dl = Date.parse(nxt.deadlineTime);
    return Number.isFinite(dl) && Date.now() >= dl;
  }

  // Planning horizon: next GW while current is live; else next/active.
  // During post-deadline blackout, stay on current until FPL flips is_current.
  function planningGameweek() {
    if (postDeadlineBeforeNextCurrent()) {
      return activeGameweek();
    }
    const liveGw = livePlanningGw();
    const cur = Number(GAMEWEEKS.current && GAMEWEEKS.current.id);
    const nxt = Number(GAMEWEEKS.next && GAMEWEEKS.next.id);

    // Static bundle behind live Home (common between ownership check-ins).
    if (Number.isFinite(liveGw) && Number.isFinite(cur) && liveGw > cur) {
      return Math.min(Math.max(liveGw + 1, SCHEDULE_GW_MIN), SCHEDULE_GW_MAX);
    }
    // Bundle current matches live but next id is stale (still equals current).
    if (
      Number.isFinite(liveGw)
      && liveGw === cur
      && Number.isFinite(nxt)
      && nxt <= liveGw
    ) {
      return Math.min(Math.max(liveGw + 1, SCHEDULE_GW_MIN), SCHEDULE_GW_MAX);
    }

    let n;
    if (Number.isFinite(cur)) {
      n = Number.isFinite(nxt) ? nxt : cur + 1;
    } else if (Number.isFinite(nxt)) {
      n = nxt;
    } else if (Number.isFinite(liveGw)) {
      n = liveGw + 1;
    } else {
      n = Number(activeGameweek());
    }
    if (Number.isFinite(n) && n >= SCHEDULE_GW_MIN) {
      return Math.min(n, SCHEDULE_GW_MAX);
    }
    return SCHEDULE_GW_MIN;
  }

  function syncPlanningHorizon({ rerender = false } = {}) {
    const [lo, hi] = defaultScheduleGwWindow();
    let changed = false;
    if (state.scheduleGwMin < lo) {
      state.scheduleGwMin = lo;
      state.scheduleGwMax = hi;
      changed = true;
    }
    const horizon = teamClampPlanGw(planningGameweek());
    if (state.teamGwStart == null || state.teamGwStart < horizon) {
      state.teamGwStart = horizon;
      loadPlannerGwState(horizon);
      saveTeamDraft();
      changed = true;
    }
    if (changed && rerender) {
      if (state.page === "team") renderTeam();
      else if (state.page === "schedule") renderSchedule();
      else if (state.page === "home") renderHome({ settleQuiet: true });
    }
    return changed;
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
    const ring = teamRingAttrs(teamCode);
    const cls = `badge-img${ring.className}${className ? ` ${className}` : ""}`;
    const accentDecl = teamAccentDecl(teamCode);
    const fitAttr = (imgSrc) => {
      const pct = CREST_FIT_PCT[imgSrc];
      const decls = [];
      if (pct && pct < 100) decls.push(`--crest-fit:${pct}%`);
      if (accentDecl) decls.push(accentDecl);
      return decls.length ? ` style="${decls.join(";")}"` : "";
    };
    const light = badgeSrc(src);
    const darkSrc = TEAM_BADGES_DARK[teamCode];
    if (!darkSrc) return `<img class="${cls}" src="${light}"${fitAttr(src)} alt="" />`;
    return (
      `<img class="${cls} badge-img-light" src="${light}"${fitAttr(src)} alt="" />` +
      `<img class="${cls} badge-img-dark" src="${badgeSrc(darkSrc)}"${fitAttr(darkSrc)} alt="" />`
    );
  }

  function teamCrestFallbackHTML(teamCode, className) {
    const ring = teamRingAttrs(teamCode);
    const cls = `${className || "home-crest-fallback"}${ring.className}`;
    return `<span class="${cls}"${ring.attr} aria-hidden="true">${escapeHtml(String(teamCode || "?").slice(0, 3))}</span>`;
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

  function scheduleHighlightFill(alpha) {
    return `hsl(var(--schedule-spectrum-fall) / ${alpha})`;
  }

  function scheduleHighlightPaint(kind, intensity) {
    return spectrumHighlightPaint(kind === "top", intensity, {
      easy: "hsl(var(--blue-hsl))",
      hard: "hsl(var(--schedule-spectrum-fall))",
      easyFill: (alpha) => `hsl(var(--blue-hsl) / ${alpha})`,
      hardFill: scheduleHighlightFill,
    });
  }

  function scheduleHighlightInlineStyle(kind, intensity) {
    const paint = scheduleHighlightPaint(kind, intensity);
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

  /**
   * Official FPL FDR is 1 (easiest) → 5 (hardest). Five discrete wash steps
   * so Team heat / Home fixtures read as a continuous easy→hard ramp.
   * `quiet` softens the wash (Home squad cells).
   */
  const FDR_RAMP = Object.freeze({
    1: { kind: "easy", intensity: 1 },
    2: { kind: "easy", intensity: 0.58 },
    3: { kind: "mid", intensity: 0.34 },
    4: { kind: "hard", intensity: 0.58 },
    5: { kind: "hard", intensity: 1 },
  });

  function fdrRampInlineStyle(fdr, { quiet = false, schedulePalette = false } = {}) {
    const n = Math.round(Number(fdr));
    const spec = FDR_RAMP[n];
    if (!spec) return { className: "", styleAttr: "", strongClass: "" };
    if (spec.kind === "mid") {
      const dark = themePrefersDark();
      const alpha = quiet
        ? dark ? 0.28 : 0.36
        : dark ? 0.42 : 0.55;
      return {
        className: ` fdr-${n}`,
        styleAttr: ` style="background-color:hsl(var(--muted) / ${alpha.toFixed(3)})"`,
        strongClass: "",
      };
    }
    const intensity = quiet ? Math.min(1, spec.intensity * 0.4) : spec.intensity;
    const paint = schedulePalette
      ? scheduleHighlightInlineStyle(spec.kind === "easy" ? "top" : "bottom", intensity)
      : fdrHighlightInlineStyle(spec.kind, intensity);
    return {
      className: ` fdr-${n}`,
      styleAttr: paint.style ? ` style="${paint.style}"` : "",
      strongClass: quiet ? "" : paint.strongClass || "",
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
  const PRICES_PROGRESS_MIN = 90;
  const PRICES_PROGRESS_MAX = 200;
  const PRICES_PROGRESS_DEFAULT = 90;
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
          element: src.element ?? null,
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
    page: "home", // home | live | opta | rankings | ownership | prices | expected | schedule | markets | team
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
    // Relative stays off until the user presses it while filters are active.
    enhancePct: ENHANCE_PCT_PLAYERS,
    enhanceRelative: false,
    scheduleEnhanceTopN: SCHEDULE_ENHANCE_TOP_DEFAULT,
    compareMode: false,
    compareSelection: { players: new Set(), teams: new Set() },
    sortKey: "price",
    sortDir: "desc",
    statsPage: 1,
    statsPageSize: 50,
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
    marketsCompare: "current", // current | 24h | 72h
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
    plannerAnchor: null, // { gw, ft, bank, managerId }
    plannerPlans: {}, // gw string -> { squad, captain, vice }
    actualMeta: null, // { syncedAt, gw, gwLabel, teamName, managerName, hasPicks, message }
    ownershipMoverKind: "risers", // risers | fallers
    ownershipViewMode: "table", // table | treemap
    ownershipTreeWindow: "d7", // d7 | d3 | d1
    ownershipSortKey: "d14",
    ownershipSortDir: "desc",
    pricesViewMode: "prediction", // prediction | actual
    pricesActualSortKey: "default", // default | changedAt | name | change | before | after
    pricesActualSortDir: "desc",
    pricesActualSortTouched: false,
    pricesActualShowAll: false,
    pricesPredictionShowAll: false,
    pricesMoverKind: "risers", // risers | fallers (mobile table toggle)
    pricesProgressMinAbs: 90, // |progress| floor — slider 90…200
    liveMode: "feed", // feed | defcon | points | bonus
    liveMatchups: new Set(), // empty = all matchups
    liveStatus: "all", // all | live | owned
    liveFeedOwnedFilter: "league", // all | league — league = hide players nobody in league owns
    liveSortKey: "ts", // feed: ts|impact|name; defcon: actions|…; points: pts|…; bonus: bps
    liveSortDir: "desc",
  };
  state.teamSearchPins = state.teamCompareCodes;

  const MAX_COMPARE = 5;
  let lastOptaHighlightFilterKey = "";
  let lastOptaPaginationKey = "";

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
  const latestOwnershipPriceByCode = new Map(
    ((latestOwnershipCheckIn && latestOwnershipCheckIn.players) || [])
      .filter((player) => player && player.code != null && player.price != null)
      .map((player) => [Number(player.code), Number(player.price)])
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
    pageLive: $("#page-live"),
    pageOpta: $("#page-opta"),
    pageRankings: $("#page-rankings"),
    pageOwnership: $("#page-ownership"),
    pagePrices: $("#page-prices"),
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
    livePage: $("#live-page"),
    livePageSubtitle: $("#live-page-subtitle"),
    liveCountLabel: $("#live-count-label"),
    liveTable: $("#live-table"),
    liveTableHead: $("#live-table-head"),
    liveTableBody: $("#live-table-body"),
    liveTableWrap: $("#live-table-wrap"),
    liveBonusWrap: $("#live-bonus-wrap"),
    liveBonusGrid: $("#live-bonus-grid"),
    liveFeedWrap: $("#live-feed-wrap"),
    liveFeedTable: $("#live-feed-table"),
    liveFeedHead: $("#live-feed-head"),
    liveFeedBody: $("#live-feed-body"),
    liveFeedFilters: $("#live-feed-filters"),
    liveFeedOwnedSeg: $("#live-feed-owned-seg"),
    liveUpdatedFooter: $("#live-updated-footer"),
    liveFiltersGroup: $("#live-filters-group"),
    liveModeSeg: $("#live-mode-seg"),
    liveMatchupFilters: $("#live-matchup-filters"),
    liveStatusSeg: $("#live-status-seg"),
    homePageSubtitle: $("#home-page-subtitle"),
    homeCountLabel: $("#home-count-label"),
    homeDesktopSearch: $("#home-desktop-search"),
    homeDesktopSearchInput: $("#home-desktop-search-input"),
    homeDesktopSearchClear: $("#home-desktop-search-clear"),
    homeDesktopSearchResults: $("#home-desktop-search-results"),
    homeUpdatedFooter: $("#home-updated-footer"),
    homeEmpty: $("#home-empty"),
    homeEmptyTitle: $("#home-empty-title"),
    homeEmptyCopy: $("#home-empty-copy"),
    homeManagerModal: $("#home-manager-modal"),
    homeManagerSelect: $("#home-manager-select"),
    homeManagerContinue: $("#home-manager-continue"),
    homeBento: $("#home-bento"),
    homeDeadline: $("#home-deadline"),
    homeViewBanner: $("#home-view-banner"),
    homeViewBannerName: $("#home-view-banner-name"),
    homeViewBannerClear: $("#home-view-banner-clear"),
    homeOwnerBanner: $("#home-owner-banner"),
    homeOwnerBannerName: $("#home-owner-banner-name"),
    homeOwnerBannerClear: $("#home-owner-banner-clear"),
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
    homeSquadViewLabel: $("#home-squad-view-label"),
    homeLeagueTitle: $("#home-league-title"),
    homeStandingsViewLabel: $("#home-standings-view-label"),
    homeSquadBody: $("#home-squad-body"),
    homeSquadSplit: $("#home-squad-split"),
    homeSquadPtsMount: $("#home-squad-pts-mount"),
    homeSquadPagePts: $("#home-squad-page-pts"),
    homeSquadFixturesBody: $("#home-squad-fixtures-body"),
    homeSquadFixturesHead: $("#home-squad-fixtures-head"),
    homeSquadFixturesCols: $("#home-squad-fixtures-cols"),
    homeSquadOwnershipBody: $("#home-squad-ownership-body"),
    homeSquadOwnershipHead: $("#home-squad-ownership-head"),
    homeSquadOwnershipCols: $("#home-squad-ownership-cols"),
    homeSquadPtsBody: $("#home-squad-pts-body"),
    homeSquadPtsHead: $("#home-squad-pts-head"),
    homeSquadPtsCols: $("#home-squad-pts-cols"),
    homeSquadTrack: $("#home-squad-track"),
    homeSquadDots: $("#home-squad-dots"),
    homeStandingsBody: $("#home-standings-body"),
    homeStandingsTransfersBody: $("#home-standings-transfers-body"),
    homeStandingsCaptainsBody: $("#home-standings-captains-body"),
    homeStandingsChipsBody: $("#home-standings-chips-body"),
    homeTransfersStatus: $("#home-transfers-status"),
    homeTransfersTableWrap: $("#home-transfers-table-wrap"),
    homeStandingsTrack: $("#home-standings-track"),
    homeStandingsDots: $("#home-standings-dots"),
    homeSummaryCards: $("#home-summary-cards"),
    homeSquadPanel: $("#home-squad-panel"),
    homeStandingsPanel: $("#home-standings-panel"),
    homeFeedPanel: $("#home-feed-panel"),
    homeFeedTrack: $("#home-feed-track"),
    homeFeedDots: $("#home-feed-dots"),
    homeFeedViewLabel: $("#home-feed-view-label"),
    homeFeedHead: $("#home-feed-head"),
    homeFeedBody: $("#home-feed-body"),
    homeFeedAllHead: $("#home-feed-all-head"),
    homeFeedAllBody: $("#home-feed-all-body"),
    homeFeedCountLabel: $("#home-feed-count-label"),
    homeTablesGrid: $(".home-tables-grid"),
    homeStandingsLookupEmpty: $("#home-standings-lookup-empty"),
    homePlayerProfile: $("#home-player-profile"),
    homePlayerMatchup: $("#home-player-matchup"),
    homeSearchBtn: $("#home-search-btn"),
    subtoolbar: $("#subtoolbar"),
    statsToolbarStart: $("#stats-toolbar-start"),
    statsToolbarActions: $("#stats-toolbar-actions"),
    optaPage: $("#opta-page"),
    optaPageSubtitle: $("#opta-page-subtitle"),
    optaTableFooter: $("#opta-table-footer"),
    optaPagination: $("#opta-pagination"),
    optaUpdatedText: $("#opta-updated-text"),
    rankingsPage: $("#rankings-page"),
    rankingsPageSubtitle: $("#rankings-page-subtitle"),
    rankingsPinBar: $("#rankings-pin-bar"),
    rankingsGrid: $("#rankings-grid"),
    rankingsCountLabel: $("#rankings-count-label"),
    rankingsUpdatedFooter: $("#rankings-updated-footer"),
    ownershipPage: $("#ownership-page"),
    ownershipTableWrap: $("#ownership-table-wrap"),
    ownershipTableHead: $("#ownership-table-head"),
    ownershipTableBody: $("#ownership-table-body"),
    ownershipMoverSeg: $("#ownership-mover-seg"),
    ownershipWindowSeg: $("#ownership-window-seg"),
    ownershipCountLabel: $("#ownership-count-label"),
    ownershipTreemapToggle: $("#ownership-treemap-toggle"),
    ownershipTreemap: $("#ownership-treemap"),
    ownershipTreemapPlot: $("#ownership-treemap-plot"),
    ownershipTreemapEmpty: $("#ownership-treemap-empty"),
    ownershipUpdatedFooter: $("#ownership-updated-footer"),
    pricesPage: $("#prices-page"),
    pricesCountdownValue: $("#prices-countdown-value"),
    pricesCountdownSub: $("#prices-countdown-sub"),
    pricesNextUpdateFooter: $("#prices-next-update-footer"),
    pricesNextUpdateValue: $("#prices-next-update-value"),
    pricesNextUpdateSub: $("#prices-next-update-sub"),
    pricesViewSeg: $("#prices-view-seg"),
    pricesMoverKindSeg: $("#prices-mover-kind-seg"),
    pricesActualScopeSeg: $("#prices-actual-scope-seg"),
    pricesPredictionScopeSeg: $("#prices-prediction-scope-seg"),
    pricesCountdownBar: $("#prices-countdown-bar"),
    pricesCountLabel: $("#prices-count-label"),
    pricesPredictionWrap: $("#prices-prediction-wrap"),
    pricesPredictionPanels: $("#prices-prediction-panels"),
    pricesRisersWrap: $("#prices-risers-wrap"),
    pricesRisersHead: $("#prices-risers-head"),
    pricesRisersBody: $("#prices-risers-body"),
    pricesFallersWrap: $("#prices-fallers-wrap"),
    pricesFallersHead: $("#prices-fallers-head"),
    pricesFallersBody: $("#prices-fallers-body"),
    pricesActualWrap: $("#prices-actual-wrap"),
    pricesActualPanels: $("#prices-actual-panels"),
    pricesActualRisersWrap: $("#prices-actual-risers-wrap"),
    pricesActualRisersHead: $("#prices-actual-risers-head"),
    pricesActualRisersBody: $("#prices-actual-risers-body"),
    pricesActualFallersWrap: $("#prices-actual-fallers-wrap"),
    pricesActualFallersHead: $("#prices-actual-fallers-head"),
    pricesActualFallersBody: $("#prices-actual-fallers-body"),
    pricesUpdatedFooter: $("#prices-updated-footer"),
    teamPage: $("#team-page"),
    teamUpdatedFooter: $("#team-updated-footer"),
    teamPageSubtitle: $("#team-page-subtitle"),
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
    teamPickerHeaderActions: $("#team-picker-header-actions"),
    teamPickerCancel: $("#team-picker-cancel"),
    searchHome: $(".topbar-end-cluster"),
    expectedPage: $("#expected-page"),
    expectedUpdatedFooter: $("#expected-updated-footer"),
    schedulePage: $("#schedule-page"),
    scheduleUpdatedFooter: $("#schedule-updated-footer"),
    scheduleGrid: $("#schedule-grid"),
    marketsPage: $("#markets-page"),
    marketsGrid: $("#markets-grid"),
    marketsAttribution: $("#markets-attribution"),
    marketsControls: $("#markets-controls"),
    marketsToolbar: $("#markets-toolbar"),
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
    marketsHeaderTop: $("#markets-page .markets-header-top"),
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
    prefsBtn: $("#prefs-btn"),
    prefsPanel: $("#prefs-panel"),
    fplManagerSelect: $("#fpl-manager-select"),
    fplLeagueLabel: $("#fpl-league-label"),
    fplIdClear: $("#fpl-id-clear"),
    prefsPlannerSection: $("#prefs-planner-section"),
    posFilters: $("#pos-filters"),
    teamFilters: $("#team-filters"),
    priceMin: $("#price-min"),
    priceMax: $("#price-max"),
    priceMinLabel: $("#price-min-label"),
    priceMaxLabel: $("#price-max-label"),
    priceFill: $("#price-fill"),
    pricesProgressMin: $("#prices-progress-min"),
    pricesProgressMinLabel: $("#prices-progress-min-label"),
    pricesProgressMinFill: $("#prices-progress-min-fill"),
    pricesProgressFilterGroup: $("#prices-progress-filter-group"),
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
        if (state.page === "live") renderLive({ animate: true });
        else renderTable();
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
        if (state.page === "live") renderLive({ animate: true });
        else renderTable();
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
    if (state.page === "live" && state.liveMatchups.size) return true;
    if (state.page === "live" && state.liveStatus !== "all") return true;
    if (state.page === "live" && state.liveMode === "feed" && state.liveFeedOwnedFilter !== "league") return true;
    const coreDefaults = statisticsCoreFilterDefaults(state.valueMode);
    if (state.priceMin !== coreDefaults.priceMin || state.priceMax !== coreDefaults.priceMax) return true;
    if (state.ownedMin !== coreDefaults.ownedMin) return true;
    if (state.minsMin !== coreDefaults.minsMin || state.minsMax !== coreDefaults.minsMax) return true;
    if (state.setPieceTakersOnly) return true;
    if (state.page === "team" && state.teamAffordableOnly) return true;
    if (state.valueMode !== "total") return true;
    if (state.split !== "combined") return true;
    if (state.enhancePct !== defaultEnhancePct()) return true;
    if (state.page === "opta" && state.hiddenCols.size) return true;
    if (state.page === "prices" && state.pricesProgressMinAbs !== PRICES_PROGRESS_DEFAULT) return true;
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
    state.liveMatchups.clear();
    state.liveStatus = "all";
    state.liveFeedOwnedFilter = "league";
    const coreDefaults = statisticsCoreFilterDefaults(state.valueMode);
    state.priceMin = coreDefaults.priceMin;
    state.priceMax = coreDefaults.priceMax;
    state.ownedMin = coreDefaults.ownedMin;
    state.minsMin = coreDefaults.minsMin;
    state.minsMax = coreDefaults.minsMax;
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
    state.hiddenCols = new Set();
    updateEnhancePctSlider();
    syncEnhanceRelativeUI();
    updatePriceSlider();
    updateOwnedSlider();
    updateMinsSlider();
    state.pricesProgressMinAbs = PRICES_PROGRESS_DEFAULT;
    if (typeof updatePricesProgressSlider === "function") updatePricesProgressSlider();
    syncFilterChipUI();
    syncLiveStatusSeg();
    syncLiveFeedOwnedSeg();
    syncFiltersResetUI();
    renderColumnsPanel();
    renderTable();
    if (state.page === "ownership") renderOwnership();
    if (state.page === "prices") renderPrices();
    if (state.page === "live") renderLive({ animate: true });
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
        if (q && !playerMatchesSearch(r, q)) return false;
      } else {
        if (state.teamFilter.size && !state.teamFilter.has(r.team)) return false;
        if (q && !teamRowMatchesSearch(r, q)) return false;
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
  // Updates is on (when matched). In 2026/27 mode prefer ownership check-in £
  // (refreshed with bootstrap) over build-time data.js.
  function effectivePrice(row) {
    if (updatesOverlayOn() && row.price2627 != null) return row.price2627;
    if (isNextSeason() && row && row.code != null) {
      const live = latestOwnershipPriceByCode.get(Number(row.code));
      if (Number.isFinite(live)) return live;
    }
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

  function playerMatchesSearch(row, q) {
    if (!q) return true;
    if (KNOWN_TEAM_CODES_LOWER.has(q)) {
      const team = String(filterTeamCode(row) || "").toLowerCase();
      const prev = String(row.team || "").toLowerCase();
      return team === q || prev === q;
    }
    return playerSearchHaystack(row).includes(q);
  }

  function teamRowMatchesSearch(row, q) {
    if (!q) return true;
    const code = String(row.team || "").toLowerCase();
    if (KNOWN_TEAM_CODES_LOWER.has(q)) return code === q;
    const hay = `${row.name || ""} ${row.team || ""} ${teamNameForSeason(row.team)}`.toLowerCase();
    return hay.includes(q);
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
  // points (hit the match threshold at least once). Teal via .threshold-dot.
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

  function spitHighlightSwatch(kind = "top") {
    const cls = kind === "top" ? "spit-highlight-top" : "spit-highlight-bottom";
    return `<span class="spit-highlight ${cls} spit-ui-swatch" aria-hidden="true">8.2</span>`;
  }

  function spitMarketsStatSwatch(tone, label) {
    return `<span class="markets-stat markets-stat-${tone} spit-markets-swatch spit-ui-swatch" aria-hidden="true"><span class="markets-stat-value">${label}</span></span>`;
  }

  function spitMarketsDeltaSwatch(dir) {
    const cls = dir === "up" ? "markets-stat-delta-up" : "markets-stat-delta-down";
    const sign = dir === "up" ? "+" : "−";
    return `<span class="markets-stat-delta ${cls} spit-ui-swatch" aria-hidden="true">${iconHTML(
      dir === "up" ? "trending-up" : "trending-down"
    )}<span>${sign}0.12</span></span>`;
  }

  function spitOwnershipLineSwatch(kind) {
    const cls =
      kind === "riser" ? "is-riser" : kind === "faller" ? "is-faller" : "is-grey";
    return `<svg class="spit-ownership-line ${cls} spit-ui-swatch" viewBox="0 0 40 12" aria-hidden="true"><path d="M2 9 L12 7 L22 5 L38 3" /></svg>`;
  }

  function spitOwnershipDeltaSwatch(kind) {
    const cls = kind === "up" ? "is-up" : kind === "down" ? "is-down" : "is-flat";
    const text = kind === "up" ? "+1.0" : kind === "down" ? "−0.8" : "0.0";
    return `<span class="ownership-trend-delta ${cls} spit-ui-swatch" aria-hidden="true">${text}</span>`;
  }

  function spitRankingsBarSwatch() {
    return `<span class="rankings-bar is-drawn spit-rankings-bar spit-ui-swatch" style="--bar-pct:72%" aria-hidden="true"><span class="rankings-value">12.4</span></span>`;
  }

  function spitRankingsPinSwatch() {
    return `<span class="rankings-pin-chip pin-1 spit-rankings-pin spit-ui-swatch" aria-hidden="true"><span class="rankings-pin-dot"></span>Pin</span>`;
  }

  function spitTeamRoleSwatch(role) {
    const cls = role === "c" ? "is-c" : "is-v";
    const label = role === "c" ? "C" : "V";
    return `<span class="team-role-badge ${cls} spit-ui-swatch" aria-hidden="true">${label}</span>`;
  }

  function spitDiffPillSwatch(kind) {
    const cls = kind === "over" ? "over" : kind === "under" ? "under" : "even";
    const text = kind === "over" ? "+1.2" : kind === "under" ? "−0.8" : "0.0";
    return `<span class="diff-pill ${cls} spit-ui-swatch" aria-hidden="true">${text}</span>`;
  }

  function spitBarbellTrackSwatch() {
    return `<span class="spit-barbell-track spit-ui-swatch" aria-hidden="true"><span class="spit-barbell-expected"></span><span class="spit-barbell-actual"></span></span>`;
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
    return true;
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
    syncPlannerPageUI();
    if (state.page === "home") {
      // Defer DOM rebuild while Home enter is playing so squad/stats don't
      // flash a second paint mid-animation.
      renderHome({ deferDuringEnter: true, settleQuiet: true });
      syncHomeLivePolling();
    } else if (state.page === "live") {
      renderLive({ quiet: true });
      syncHomeLivePolling();
    } else if (state.page === "rankings") renderRankings({ animateBars: false });
    else if (state.page === "team") renderTeam();
    else if (state.page === "opta") renderTable();
    else renderTable();
  }

  function trackedManagerOptionsHTML() {
    const opts = ['<option value="">Select manager…</option>'];
    const allowed = new Set(TRACKED_MANAGER_IDS.map(String));
    for (const m of LEAGUES.managers || []) {
      if (!allowed.has(String(m.id))) continue;
      const label = m.teamName ? `${m.name} — ${m.teamName}` : m.name;
      opts.push(
        `<option value="${escapeHtml(String(m.id))}">${escapeHtml(label)}</option>`
      );
    }
    return opts.join("");
  }

  function populateManagerSelect() {
    if (!el.fplManagerSelect) return;
    const selected = savedManagerId || "";
    el.fplManagerSelect.innerHTML = trackedManagerOptionsHTML();
    el.fplManagerSelect.value = selected;
    if (selected && el.fplManagerSelect.value !== selected) {
      el.fplManagerSelect.value = "";
    }
  }

  function populateHomeManagerSelect() {
    if (!el.homeManagerSelect) return;
    const prev = el.homeManagerSelect.value || "";
    el.homeManagerSelect.innerHTML = trackedManagerOptionsHTML();
    if (prev && [...el.homeManagerSelect.options].some((o) => o.value === prev)) {
      el.homeManagerSelect.value = prev;
    } else {
      el.homeManagerSelect.value = "";
    }
    syncHomeManagerContinue();
  }

  function syncHomeManagerContinue() {
    if (!el.homeManagerContinue) return;
    const id = el.homeManagerSelect ? String(el.homeManagerSelect.value || "").trim() : "";
    el.homeManagerContinue.disabled = !id;
  }

  function setHomeManagerModalOpen(open) {
    if (!el.homeManagerModal) return;
    if (open) {
      populateHomeManagerSelect();
      el.homeManagerModal.hidden = false;
      el.homeManagerModal.setAttribute("aria-hidden", "false");
      requestAnimationFrame(() => {
        try {
          if (el.homeManagerSelect) el.homeManagerSelect.focus({ preventScroll: true });
        } catch {
          if (el.homeManagerSelect) el.homeManagerSelect.focus();
        }
      });
    } else {
      el.homeManagerModal.hidden = true;
      el.homeManagerModal.setAttribute("aria-hidden", "true");
    }
  }

  function clearHomeDashboardStats() {
    if (el.homeDeadline) el.homeDeadline.hidden = true;
    if (el.homeViewBanner) el.homeViewBanner.hidden = true;
    if (el.homeOwnerBanner) el.homeOwnerBanner.hidden = true;
    if (el.homeGwHeading) el.homeGwHeading.textContent = "GW points";
    if (el.homeGwPoints) el.homeGwPoints.textContent = "—";
    if (el.homeGwMeta) el.homeGwMeta.innerHTML = "";
    const overallRankEl = el.homeOverallRankNum || el.homeOverallRank;
    if (overallRankEl) overallRankEl.textContent = "—";
    if (el.homeTotalPoints) el.homeTotalPoints.textContent = "—";
    const leagueRankEl = el.homeLeagueRankNum || el.homeLeagueRank;
    if (leagueRankEl) leagueRankEl.textContent = "—";
    setHomeRankDelta(el.homeOverallRankDelta, null);
    setHomeRankDelta(el.homeLeagueRankDelta, null);
    setHomeOverallPct(el.homeOverallPct, null, null);
    if (el.homeSquadGwLabel) el.homeSquadGwLabel.textContent = "";
    if (el.homeLeagueTitle) el.homeLeagueTitle.textContent = "";
    if (el.homeSquadBody) el.homeSquadBody.innerHTML = "";
    if (el.homeSquadFixturesBody) el.homeSquadFixturesBody.innerHTML = "";
    if (el.homeSquadFixturesHead) el.homeSquadFixturesHead.innerHTML = "";
    if (el.homeSquadFixturesCols) el.homeSquadFixturesCols.innerHTML = "";
    if (el.homeSquadOwnershipBody) el.homeSquadOwnershipBody.innerHTML = "";
    if (el.homeSquadOwnershipHead) el.homeSquadOwnershipHead.innerHTML = "";
    if (el.homeSquadOwnershipCols) el.homeSquadOwnershipCols.innerHTML = "";
    if (el.homeSquadPtsBody) el.homeSquadPtsBody.innerHTML = "";
    if (el.homeSquadPtsHead) el.homeSquadPtsHead.innerHTML = "";
    if (el.homeSquadPtsCols) el.homeSquadPtsCols.innerHTML = "";
    if (el.homeStandingsBody) el.homeStandingsBody.innerHTML = "";
    if (el.homeStandingsTransfersBody) el.homeStandingsTransfersBody.innerHTML = "";
    if (el.homeStandingsCaptainsBody) el.homeStandingsCaptainsBody.innerHTML = "";
    if (el.homeStandingsChipsBody) el.homeStandingsChipsBody.innerHTML = "";
    if (el.homeTransfersStatus) {
      el.homeTransfersStatus.hidden = true;
      el.homeTransfersStatus.textContent = "";
    }
    if (el.homeStandingsLookupEmpty) {
      el.homeStandingsLookupEmpty.hidden = true;
      el.homeStandingsLookupEmpty.textContent = "";
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

  function syncPlannerPageUI() {
    if (el.teamPage) {
      el.teamPage.dataset.teamMode = "planner";
      el.teamPage.classList.remove("is-actual-readonly");
    }
    if (el.teamPageSubtitle) {
      el.teamPageSubtitle.textContent = savedManagerId
        ? "Plan lineups and transfers by gameweek — synced from your FPL manager. Live squad is on Home."
        : "Plan lineups and transfers by gameweek. Link a manager in Preferences to sync. Live squad is on Home.";
    }
    syncTeamPlannerPrefsBtns();
  }

  function syncTeamPlannerPrefsBtns() {
    const canResync = !!savedManagerId;
    const canClear = !!state.teamSquad.length;
    const desktop = !NARROW_MQ.matches;
    const onPlanner = state.page === "team";

    if (el.prefsPlannerSection) {
      el.prefsPlannerSection.hidden = !onPlanner;
    }

    const syncOne = (btn, { show, enabled }) => {
      if (!btn) return;
      btn.hidden = !show;
      btn.disabled = !enabled;
      if (!show || !enabled) disarmConfirmButton(btn);
    };

    // Prefs buttons: mobile Planner only (desktop uses toolbar).
    syncOne(el.teamResyncBtn, { show: onPlanner && canResync && !desktop, enabled: canResync });
    syncOne(el.teamClearBtn, { show: onPlanner && canClear && !desktop, enabled: canClear });
    // Toolbar: desktop Planner page.
    const onTeamDesktop = desktop && onPlanner;
    syncOne(el.teamResyncToolbar, { show: onTeamDesktop && canResync, enabled: canResync });
    syncOne(el.teamClearToolbar, { show: onTeamDesktop && canClear, enabled: canClear });
  }

  async function ingestManagerSquad(payload, { resetPlanner = false, seedPlannerIfEmpty = false } = {}) {
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
    const anchorGw = Number(payload.gw) || teamCurrentGw();
    const planGw = planningGameweek();
    const historyCurrent = Array.isArray(payload.historyCurrent) ? payload.historyCurrent : [];
    state.plannerAnchor = {
      gw: anchorGw,
      ft: computeFreeTransfersAtGw(historyCurrent, planGw),
      bank: payload.bank != null ? Number(payload.bank) : null,
      managerId: String(payload.managerId || savedManagerId || ""),
      squad: clonePlannerSquad(snap.squad),
      captain: snap.captain ?? null,
      vice: snap.vice ?? null,
      historyCurrent,
    };
    if (resetPlanner || (seedPlannerIfEmpty && payload.hasPicks && plannerDraftIsEmpty())) {
      resetPlannerFromSnap(snap, { gw: anchorGw });
    }
    syncFplIdStatus();
    syncPlannerPageUI();
    return snap;
  }

  async function syncManagerFromApi(managerId, { seedPlannerIfEmpty = false, quiet = false } = {}) {
    const payload = await fetchManagerSquad(managerId);
    await ingestManagerSquad(payload, { seedPlannerIfEmpty });
    if (!quiet) {
      showToast({
        title: payload.hasPicks ? "FPL squad synced" : "Manager linked",
        message: payload.hasPicks
          ? `${payload.squad.length} picks · ${payload.gwLabel || "GW"} · ${payload.freeTransfers ?? "?"} FT`
          : payload.message || "No published picks yet — planner stays empty until FPL publishes them.",
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

  /** home_prefs.json + fetch_home rebuild — local serve.py only (not Vercel static). */
  function homeLocalServerAvailable() {
    if (location.protocol === "file:") return false;
    const host = location.hostname;
    return host === "localhost" || host === "127.0.0.1";
  }

  function persistHomePrefs() {
    if (!homeLocalServerAvailable()) return Promise.resolve(null);
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

  function mergeHomeOverallRankPrev(incomingRows, priorHome, incomingGw) {
    const priorGw = Number(priorHome?.gw);
    const nextGw = Number(incomingGw);
    if (Number.isFinite(priorGw) && Number.isFinite(nextGw) && priorGw !== nextGw) {
      return incomingRows;
    }
    const priorByEntry = new Map();
    for (const row of priorHome?.standings || []) {
      const eid = Number(row?.entry);
      const prev = Number(row?.overallRankPrev);
      if (Number.isFinite(eid) && eid > 0 && Number.isFinite(prev) && prev > 0) {
        priorByEntry.set(eid, prev);
      }
    }
    const priorSummaryPrev = Number(priorHome?.summary?.overallRankPrev);
    const priorMgr = Number(priorHome?.managerId);
    if (
      Number.isFinite(priorMgr) && priorMgr > 0
      && Number.isFinite(priorSummaryPrev) && priorSummaryPrev > 0
    ) {
      priorByEntry.set(priorMgr, priorSummaryPrev);
    }
    if (!priorByEntry.size || !Array.isArray(incomingRows)) return incomingRows;
    return incomingRows.map((row) => {
      if (!row || typeof row !== "object") return row;
      const prev = Number(row.overallRankPrev);
      if (Number.isFinite(prev) && prev > 0) return row;
      const kept = priorByEntry.get(Number(row.entry));
      return kept ? { ...row, overallRankPrev: kept } : row;
    });
  }

  function homeTransfersAreCanonical(byEntry, schemaVersion) {
    const ver = Number(schemaVersion);
    // Explicit v2 payloads from fetch_home are authoritative (including empty maps).
    if (Number.isFinite(ver) && ver >= 2) return true;
    if (!byEntry || typeof byEntry !== "object") return false;
    const groups = Object.values(byEntry);
    if (!groups.length) return false;
    let paired = 0;
    for (const t of groups) {
      if (!t || typeof t !== "object") continue;
      for (const m of t.moves || []) {
        if (!m || typeof m !== "object") continue;
        const outType = m.out && m.out.elementType != null ? Number(m.out.elementType) : NaN;
        const inType = m.in && m.in.elementType != null ? Number(m.in.elementType) : NaN;
        // Legacy payloads omit elementType — treat as non-canonical.
        if (!Number.isFinite(outType) || !Number.isFinite(inType) || outType <= 0 || inType <= 0) {
          return false;
        }
        if (outType !== inType) return false;
        paired += 1;
      }
    }
    return paired > 0;
  }

  function homeSyncStandingsTransfers(standings, byEntry) {
    const map = byEntry && typeof byEntry === "object" ? byEntry : {};
    return (Array.isArray(standings) ? standings : []).map((row) => {
      if (!row || row.entry == null) return row;
      const t = map[String(row.entry)];
      if (!t) {
        if (row.transfers == null) return row;
        const next = { ...row };
        delete next.transfers;
        return next;
      }
      return { ...row, transfers: t };
    });
  }

  function applyHomePayload(payload, { skipFeedIngest = false, fromSessionSnapshot = false, fromLivePoll = false } = {}) {
    if (!payload || typeof payload !== "object") return false;
    const priorHome = {
      gw: HOME.gw ?? null,
      standings: Array.isArray(HOME.standings) ? HOME.standings : [],
      summary: HOME.summary && typeof HOME.summary === "object" ? HOME.summary : null,
      managerId: HOME.managerId ?? null,
      transfersByEntry: HOME.transfersByEntry && typeof HOME.transfersByEntry === "object"
        ? HOME.transfersByEntry
        : {},
      transfersSchemaVersion: Number(HOME.transfersSchemaVersion) || 0,
    };
    if (payload.summary && HOME.summary && typeof payload.summary === "object") {
      const incoming = payload.summary;
      const prev = HOME.summary;
      const inRank = Number(incoming.overallRank);
      const inPrev = Number(incoming.overallRankPrev);
      const curRank = Number(prev.overallRank);
      const curPrev = Number(prev.overallRankPrev);
      // Live server can briefly serve picks-stale overall rank (== prev) mid-GW.
      if (
        Number.isFinite(inRank) && Number.isFinite(curRank) && inRank > 0 && curRank > 0
        && Number.isFinite(inPrev) && Number.isFinite(curPrev) && inPrev > 0 && curPrev > 0
        && inRank === inPrev && curRank !== inRank && curPrev === inPrev
      ) {
        incoming.overallRank = curRank;
      }
      if (
        !(Number.isFinite(inPrev) && inPrev > 0) && Number.isFinite(curPrev) && curPrev > 0
        && (!Number.isFinite(Number(priorHome.gw)) || Number(priorHome.gw) === Number(payload.gw))
      ) {
        incoming.overallRankPrev = curPrev;
      }
    } else if (payload.summary && typeof payload.summary === "object") {
      const inPrev = Number(payload.summary.overallRankPrev);
      const curPrev = Number(priorHome.summary?.overallRankPrev);
      if (
        !(Number.isFinite(inPrev) && inPrev > 0) && Number.isFinite(curPrev) && curPrev > 0
        && (!Number.isFinite(Number(priorHome.gw)) || Number(priorHome.gw) === Number(payload.gw))
      ) {
        payload.summary = { ...payload.summary, overallRankPrev: curPrev };
      }
    }
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
    HOME.standings = mergeHomeOverallRankPrev(
      Array.isArray(payload.standings) ? payload.standings : [],
      priorHome,
      payload.gw ?? null
    );
    HOME.chipWindow = payload.chipWindow && typeof payload.chipWindow === "object"
      ? payload.chipWindow
      : null;
    HOME.ownersByElement = payload.ownersByElement || {};
    HOME.elementGw = payload.elementGw && typeof payload.elementGw === "object"
      ? payload.elementGw
      : {};
    if (!skipFeedIngest && payload.gw != null && payload.elementGw && typeof payload.elementGw === "object") {
      const onFeedPage = state.page === "live" || state.page === "home";
      if (onFeedPage) {
        liveFeedIngest(Number(payload.gw), liveElementMapForGw(Number(payload.gw)));
      }
    }
    HOME.leaguePicksStatus = payload.leaguePicksStatus && typeof payload.leaguePicksStatus === "object"
      ? payload.leaguePicksStatus
      : null;
    HOME.gwAwaitingKickoff = Object.prototype.hasOwnProperty.call(payload, "gwAwaitingKickoff")
      ? payload.gwAwaitingKickoff === true
      : null;
    const incomingTransfers = payload.transfersByEntry && typeof payload.transfersByEntry === "object"
      ? payload.transfersByEntry
      : {};
    const incomingSchema = Number(payload.transfersSchemaVersion);
    const incomingCanonical = homeTransfersAreCanonical(
      incomingTransfers,
      Number.isFinite(incomingSchema) ? incomingSchema : 0
    );
    const priorCanonical = homeTransfersAreCanonical(
      priorHome.transfersByEntry,
      priorHome.transfersSchemaVersion
    );
    // Never let legacy live/session pairing overwrite canonical transfers (static or v2 live).
    const keepPriorTransfers = priorCanonical && !incomingCanonical;
    HOME.transfersByEntry = keepPriorTransfers ? priorHome.transfersByEntry : incomingTransfers;
    HOME.transfersSchemaVersion = keepPriorTransfers
      ? Math.max(2, priorHome.transfersSchemaVersion || 0)
      : (incomingCanonical ? Math.max(2, Number.isFinite(incomingSchema) ? incomingSchema : 2) : 0);
    HOME.standings = homeSyncStandingsTransfers(HOME.standings, HOME.transfersByEntry);
    HOME.error = payload.error ?? null;
    homeSanitizePreKickoffScores();
    window.FPL_HOME = HOME;
    if (fromSessionSnapshot) homeBootstrapSource = "session";
    else if (fromLivePoll) homeBootstrapSource = "live";
    homeOwnerPin = null;
    homeViewEntryId = null;
    homeElementGwCache = null;
    syncPlanningHorizon({ rerender: state.page === "home" || state.page === "team" || state.page === "schedule" });
    syncLiveNavChrome();
    if (!fromSessionSnapshot && (fromLivePoll || homeLivePollReady())) {
      persistHomeSessionSnapshot(HOME);
    }
    return true;
  }

  let homeTargetsRefreshTimer = null;
  let homeTargetsRefreshSeq = 0;

  function scheduleSiteRefreshForHomeTargets({ toast = false, animateHomeEnter = false } = {}) {
    if (animateHomeEnter && state.page === "home" && el.homePage) {
      setHomeManagerModalOpen(false);
      homePageEnterArmed = true;
      homeLiveApplyAfterEnter = true;
      primeOptaHighlightEnter(el.homePage);
      renderHome({ leaveRollsPending: true });
      playPageEnter(el.homePage);
    } else {
      // Owned pins / tables update immediately from the live squad sync.
      refreshManagerDependentUI();
    }
    if (homeTargetsRefreshTimer) clearTimeout(homeTargetsRefreshTimer);
    if (!homeLocalServerAvailable()) return;
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
    if (!homeLocalServerAvailable()) {
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
        // Static host (Vercel) has no local rebuild — prefs still saved in the browser.
        if (res.status === 404 || res.status === 405 || res.status === 501) {
          let msg = "Home rebuild needs the local server (python3 site/serve.py).";
          try {
            const errBody = await res.json();
            if (errBody && errBody.error) msg = String(errBody.error);
          } catch { /* ignore */ }
          refreshManagerDependentUI();
          if (toast) {
            showToast({
              title: "Manager saved",
              message: msg.slice(0, 160),
              icon: "info",
            });
          }
          return false;
        }
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
      applyHomePayload(data.home, { fromLivePoll: true });
      homeLiveLastSuccessAt = Date.now();
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
  const HOME_LIVE_FETCH_MS = 12_000;
  const HOME_LIVE_POLL_LIVE_MS = 15_000;
  const HOME_LIVE_POLL_IDLE_MS = 60_000;
  const HOME_SESSION_SNAPSHOT_KEY = "fpl_home_live_v3";
  let homeLivePollTimer = null;
  let homeLivePollIntervalMs = HOME_LIVE_POLL_IDLE_MS;
  let homeLiveLastPollAt = 0;
  let homeLiveLastPollOk = false;
  let homeLiveLastSuccessAt = 0;
  let homeLivePollInFlight = false;
  let homeLivePollAttempted = false;
  let homeLivePollFlight = null;
  let homeRenderQueued = false;
  let homeEnterMotionToken = 0;
  /** Defer poll-driven renderHome until enter animation clears (mobile). Poll still runs. */
  let homeLiveApplyAfterEnter = false;
  /** null | 'session' | 'live' — source of the current trusted volatile stats. */
  let homeBootstrapSource = null;
  /** True from setPage(home) until playPageEnter arms is-entering — blocks poll rebuild flash. */
  let homePageEnterArmed = false;
  let homeLivePrefetchStarted = false;
  const HOME_SUMMARY_ROLL_MS = 2800;
  const HOME_VIEW_SWITCH_ROLL_MS = 2400;
  const HOME_ENTER_CLEAR_MS = HOME_SUMMARY_ROLL_MS + 120;
  const HOME_RANK_BORDER_REVEAL_RATIO = 0.18;
  const HOME_SCROLL_TOP_MS = 920;
  let homeScrollAnimToken = 0;
  let homeRankBorderRevealTimer = null;

  function primeOptaHighlightEnter(pane) {
    if (!pane || prefersReducedMotion()) return;
    if (pane._hlEnterRaf) {
      cancelAnimationFrame(pane._hlEnterRaf);
      pane._hlEnterRaf = 0;
    }
    pane.classList.add("is-hl-entering");
    pane.style.setProperty("--hl-sat", "0");
  }

  function finishHighlightSatEnter(pane) {
    if (!pane) return;
    if (pane._hlEnterRaf) {
      cancelAnimationFrame(pane._hlEnterRaf);
      pane._hlEnterRaf = 0;
    }
    pane.style.setProperty("--hl-sat", "1");
    pane.classList.remove("is-hl-entering");
  }

  function homeIsEnterBusy() {
    return !!(
      homePageEnterArmed ||
      (el.homePage &&
        (el.homePage.classList.contains("is-entering") ||
          el.homePage.classList.contains("is-enter-pending")))
    );
  }

  function flushHomeRenderAfterEnter() {
    if (!homeLiveApplyAfterEnter) return;
    homeLiveApplyAfterEnter = false;
    if (homeRenderQueued) {
      homeRenderQueued = false;
      renderHome({ settleQuiet: true });
    }
    syncHomeLivePolling({ skipImmediate: true });
  }

  function flushHomeEnterDeferred() {
    if (homeRenderQueued) {
      homeRenderQueued = false;
      renderHome({ settleQuiet: true });
    } else {
      if (el.homePage) finishHomeStatRolls(el.homePage);
      if (state.page === "home" && homeSquadIsWideLayout()) {
        requestAnimationFrame(() => {
          if (state.page !== "home" || !homeSquadIsWideLayout()) return;
          settleHomeTablesLayout({ standingsPageIdx: homeStandingsActivePageIndex() });
        });
      }
    }
    flushHomeRenderAfterEnter();
  }

  function resetHomeLivePollState() {
    homeLiveLastPollAt = 0;
    homeLiveLastPollOk = false;
    homeLiveLastSuccessAt = 0;
    homeLivePollInFlight = false;
    homeLivePollAttempted = false;
    homeLivePollFlight = null;
    homeBootstrapSource = null;
  }

  function stopHomeLivePolling() {
    if (homeLivePollTimer) {
      clearInterval(homeLivePollTimer);
      homeLivePollTimer = null;
    }
    homeLiveApplyAfterEnter = false;
  }

  function homeLiveApiUrl() {
    if (LIVE_HOME_API) return `${LIVE_HOME_API}/api/home`;
    // Same-origin /api/home (Vercel proxy or local serve.py). Skip file:// previews.
    if (location.protocol === "file:") return "";
    if (location.protocol === "http:" || location.protocol === "https:") {
      return "/api/home";
    }
    return "";
  }

  function homeLivePayloadMatchesPrefs(home) {
    if (!home || !home.managerId) return false;
    if (String(home.leagueId) !== HOME_LEAGUE_ID) return false;
    return TRACKED_MANAGER_IDS.map(String).includes(String(home.managerId));
  }

  function homeSquadFingerprint(squad) {
    if (!Array.isArray(squad)) return "";
    return squad
      .map((r) => [
        r.element,
        r.gwPoints,
        r.basePoints,
        r.minutes,
        r.matchStatus,
        r.live ? 1 : 0,
        r.imp,
        ...(r.fixtures || []).map((f) =>
          [f.minutes, f.live ? 1 : 0, f.finished ? 1 : 0].join(",")
        ),
      ].join(":"))
      .join("|");
  }

  function homeLivePollInterval() {
    return liveGwHasActiveGames() ? HOME_LIVE_POLL_LIVE_MS : HOME_LIVE_POLL_IDLE_MS;
  }

  function resyncHomeLivePollInterval() {
    const next = homeLivePollInterval();
    if (!homeLivePollTimer || next === homeLivePollIntervalMs) return;
    homeLivePollIntervalMs = next;
    clearInterval(homeLivePollTimer);
    homeLivePollTimer = setInterval(() => {
      if (document.hidden) return;
      pollHomeFromLiveServer();
    }, homeLivePollIntervalMs);
  }

  function homeElementGwFingerprint(home) {
    const eg = home && home.elementGw;
    if (!eg || typeof eg !== "object") return "";
    let count = 0;
    let goals = 0;
    let maxMins = 0;
    let pts = 0;
    let minsSum = 0;
    let liveCount = 0;
    for (const row of Object.values(eg)) {
      if (!row || typeof row !== "object") continue;
      count += 1;
      goals += Number(row.goals) || 0;
      const mins = Number(row.minutes) || 0;
      maxMins = Math.max(maxMins, mins);
      minsSum += mins;
      pts += Number(row.pts) || 0;
      if (row.live || String(row.status || "").toLowerCase() === "live") liveCount += 1;
    }
    return `${count}:${goals}:${maxMins}:${pts}:${minsSum}:${liveCount}`;
  }

  function homeLivePollReady() {
    if (!homeLiveApiUrl() || !savedLeagueId) return false;
    if (savedManagerId) return true;
    const baked = HOME && HOME.managerId;
    return !!(baked && TRACKED_MANAGER_IDS.map(String).includes(String(baked)));
  }

  function homeStandingsFingerprint(rows) {
    if (!Array.isArray(rows)) return "";
    return rows
      .map((r) => [
        r.entry,
        r.rankOfficial,
        r.rankLive,
        r.total,
        r.gwPointsLive,
        r.eventTotalOfficial,
        r.inPlay,
        r.toPlay,
      ].join(":"))
      .join("|");
  }

  function homeTransfersFingerprint(byEntry) {
    if (!byEntry || typeof byEntry !== "object") return "";
    return Object.keys(byEntry)
      .sort()
      .map((key) => {
        const t = byEntry[key] || {};
        const moves = Array.isArray(t.moves) ? t.moves : [];
        const moveFp = moves
          .map((m) => {
            const outId = m && m.out && m.out.id != null ? m.out.id : "";
            const inId = m && m.in && m.in.id != null ? m.in.id : "";
            return `${outId}>${inId}`;
          })
          .join(",");
        return `${key}:${t.count ?? ""}:${t.cost ?? ""}:${t.activeChip || ""}:${moveFp}`;
      })
      .join("|");
  }

  function homeSummaryFingerprint(summary) {
    if (!summary || typeof summary !== "object") return "";
    return [
      summary.gwPoints,
      summary.overallPoints,
      summary.overallRank,
      summary.leagueRank,
      summary.leagueRankPrev,
    ].join(":");
  }

  function homeLivePayloadPending() {
    return homeBootstrapPhase() === "pending" && homeLivePollInFlight;
  }

  /** 'static' = no live API; 'pending' = awaiting first trusted payload; 'session' | 'live' = trusted. */
  function homeBootstrapPhase() {
    if (!homeLivePollReady()) return "static";
    if (homeLiveLastSuccessAt > 0) {
      return homeBootstrapSource === "session" ? "session" : "live";
    }
    return "pending";
  }

  function homeCanShowVolatileStats() {
    return homeBootstrapPhase() !== "pending";
  }

  /** True between FPL flipping is_current and the first GW fixture kickoff. */
  function homeGwAwaitingKickoff() {
    if (HOME && HOME.gwAwaitingKickoff === true) return true;
    if (HOME && HOME.gwAwaitingKickoff === false) return false;
    let anyFx = false;
    let anyStarted = false;
    const scanRows = (rows) => {
      for (const row of rows || []) {
        for (const fx of row.fixtures || []) {
          anyFx = true;
          if (fx && (fx.live || fx.finished)) anyStarted = true;
        }
      }
    };
    scanRows(HOME && HOME.squad);
    const byEntry = (HOME && HOME.squadsByEntry) || {};
    Object.keys(byEntry).forEach((k) => scanRows(byEntry[k]));
    if (anyStarted) return false;
    if (!anyFx) return false;
    const standings = (HOME && HOME.standings) || [];
    if (!standings.length) return true;
    let anyToPlay = false;
    for (const row of standings) {
      if ((Number(row && row.inPlay) || 0) > 0) return false;
      if ((Number(row && row.toPlay) || 0) > 0) anyToPlay = true;
    }
    return anyToPlay;
  }

  /** Drop leftover prior-GW totals while the new current GW has not kicked off. */
  function homeSanitizePreKickoffScores() {
    if (!homeGwAwaitingKickoff()) return;
    if (HOME.summary && typeof HOME.summary === "object") {
      HOME.summary = {
        ...HOME.summary,
        gwPoints: 0,
        eventPointsOfficial: 0,
      };
    }
    HOME.standings = (Array.isArray(HOME.standings) ? HOME.standings : []).map((row) => {
      if (!row || typeof row !== "object") return row;
      return { ...row, gwPointsLive: 0, eventTotalOfficial: 0 };
    });
    const zeroSquadPts = (rows) =>
      (Array.isArray(rows) ? rows : []).map((row) => {
        if (!row || typeof row !== "object") return row;
        return { ...row, gwPoints: 0 };
      });
    HOME.squad = zeroSquadPts(HOME.squad);
    const nextByEntry = {};
    const byEntry = HOME.squadsByEntry && typeof HOME.squadsByEntry === "object"
      ? HOME.squadsByEntry
      : {};
    Object.keys(byEntry).forEach((key) => {
      nextByEntry[key] = zeroSquadPts(byEntry[key]);
    });
    HOME.squadsByEntry = nextByEntry;
  }

  /** Baked HOME can retain stale live flags between refreshes — wait for live poll or session snapshot. */
  function homeTrustLiveMatchState() {
    return homeCanShowVolatileStats();
  }

  function homeSessionSnapshotKey(home) {
    if (!home || home.managerId == null || home.leagueId == null || home.gw == null) return "";
    return `${home.managerId}:${home.leagueId}:${home.gw}`;
  }

  function homeSessionSnapshotPrefsKey() {
    const mid = savedManagerId || (HOME && HOME.managerId);
    const lid = HOME_LEAGUE_ID;
    const gw = HOME && HOME.gw;
    if (!mid || !lid || gw == null) return "";
    return `${mid}:${lid}:${gw}`;
  }

  function homeSessionSnapshotPayload(home) {
    return {
      generatedAt: home.generatedAt ?? null,
      gw: home.gw ?? null,
      managerId: home.managerId ?? null,
      leagueId: home.leagueId ?? null,
      leagueName: home.leagueName ?? null,
      summary: home.summary ?? null,
      squad: Array.isArray(home.squad) ? home.squad : [],
      squadsByEntry: home.squadsByEntry && typeof home.squadsByEntry === "object" ? home.squadsByEntry : {},
      standings: Array.isArray(home.standings) ? home.standings : [],
      chipWindow: home.chipWindow && typeof home.chipWindow === "object" ? home.chipWindow : null,
      ownersByElement: home.ownersByElement || {},
      elementGw: home.elementGw && typeof home.elementGw === "object" ? home.elementGw : {},
      leaguePicksStatus: home.leaguePicksStatus && typeof home.leaguePicksStatus === "object"
        ? home.leaguePicksStatus
        : null,
      transfersSchemaVersion: Number(home.transfersSchemaVersion) || 0,
      transfersByEntry: home.transfersByEntry && typeof home.transfersByEntry === "object"
        ? home.transfersByEntry
        : {},
      gwAwaitingKickoff:
        home.gwAwaitingKickoff === true
          ? true
          : home.gwAwaitingKickoff === false
            ? false
            : null,
    };
  }

  function persistHomeSessionSnapshot(home) {
    try {
      if (!home || !homeLivePayloadMatchesPrefs(home)) return;
      const key = homeSessionSnapshotKey(home);
      if (!key) return;
      sessionStorage.setItem(
        HOME_SESSION_SNAPSHOT_KEY,
        JSON.stringify({ key, savedAt: Date.now(), payload: homeSessionSnapshotPayload(home) })
      );
    } catch {
      /* private browsing */
    }
  }

  function hydrateHomeFromSessionSnapshot() {
    try {
      const prefsKey = homeSessionSnapshotPrefsKey();
      if (!prefsKey) return false;
      const raw = sessionStorage.getItem(HOME_SESSION_SNAPSHOT_KEY);
      if (!raw) return false;
      const snap = JSON.parse(raw);
      if (!snap || snap.key !== prefsKey || !snap.payload) return false;
      if (!homeLivePayloadMatchesPrefs(snap.payload)) return false;
      // Keep baked static transfers until a canonical live payload arrives — session
      // copies are the main source of wrong-then-right flashes on the transfers card.
      const bakedTransfers = HOME.transfersByEntry && typeof HOME.transfersByEntry === "object"
        ? HOME.transfersByEntry
        : {};
      const bakedSchema = Number(HOME.transfersSchemaVersion) || 0;
      const payload = { ...snap.payload };
      delete payload.transfersByEntry;
      delete payload.transfersSchemaVersion;
      if (Array.isArray(payload.standings)) {
        payload.standings = payload.standings.map((row) => {
          if (!row || row.transfers == null) return row;
          const next = { ...row };
          delete next.transfers;
          return next;
        });
      }
      applyHomePayload(payload, { skipFeedIngest: true, fromSessionSnapshot: true });
      if (homeTransfersAreCanonical(bakedTransfers, bakedSchema)) {
        HOME.transfersByEntry = bakedTransfers;
        HOME.transfersSchemaVersion = Math.max(2, bakedSchema || 0);
        HOME.standings = homeSyncStandingsTransfers(HOME.standings, HOME.transfersByEntry);
      }
      homeLiveLastSuccessAt = Number(snap.savedAt) || Date.now();
      return true;
    } catch {
      return false;
    }
  }

  function homeSquadRowGwPoints(row, eg) {
    if (!homeCanShowVolatileStats()) return null;
    if (homeGwAwaitingKickoff()) return 0;
    if (row && row.gwPoints != null && Number.isFinite(Number(row.gwPoints))) {
      return Number(row.gwPoints);
    }
    if (eg && eg.pts != null && Number.isFinite(Number(eg.pts))) {
      return Number(eg.pts);
    }
    return null;
  }

  function homeDisplayGwPoints({ surface, row, squadRow, eg } = {}) {
    if (surface === "squad") return homeSquadRowGwPoints(squadRow, eg);
    if (surface === "standings" || surface === "summary") {
      return row ? homeStandingsGwPoints(row) : null;
    }
    return null;
  }

  function homeSquadShowLoading(viewEntry) {
    if (!savedManagerId || !savedLeagueId) return false;
    if ((homeSquadForEntry(viewEntry) || []).length) return false;
    if (!homeLivePollReady()) return false;
    if (homeCanShowVolatileStats()) return false;
    if (homeLivePollInFlight) return true;
    return true;
  }

  function homeStandingsShowLoading() {
    if (!homeLivePollReady()) return false;
    if (Array.isArray(HOME.standings) && HOME.standings.length) return false;
    if (homeCanShowVolatileStats()) return false;
    if (homeLivePollInFlight) return true;
    return true;
  }

  function homeSquadLoadingHTML(colspan, rows = 5) {
    let html = "";
    for (let i = 0; i < rows; i += 1) {
      html += `<tr class="home-squad-loading-row" aria-hidden="true"><td colspan="${colspan}"><span class="home-squad-loading-bar" style="--load-i:${i}"></span></td></tr>`;
    }
    return html;
  }

  function homeSquadEmptyHTML(colspan) {
    return `<tr><td colspan="${colspan}">No team picks in cache.</td></tr>`;
  }

  function ensureLiveFeedFromHome() {
    const gw = HOME && HOME.gw;
    if (!Number.isFinite(Number(gw)) || !HOME.elementGw) return;
    const egMap = liveElementMapForGw(Number(gw));
    if (!egMap || !Object.keys(egMap).length) return;
    if (liveFeedGw === Number(gw) && liveFeedEvents.length) return;
    liveFeedIngest(Number(gw), egMap);
  }

  function settleHomeAfterLivePoll({ rerender = true } = {}) {
    if (state.page !== "home" || !el.homePage) return;
    syncHomeCountLabel();
    const enterBusy = homeIsEnterBusy();
    if (rerender) renderHome({ settleQuiet: true, deferDuringEnter: enterBusy });
    if (!enterBusy) {
      el.homePage.classList.remove("is-enter-pending", "is-entering");
      finishHomeStatRolls(el.homePage);
    }
  }

  function pollHomeFromLiveServer() {
    if (homeLivePollFlight) return homeLivePollFlight;
    homeLivePollFlight = pollHomeFromLiveServerOnce().finally(() => {
      homeLivePollFlight = null;
    });
    return homeLivePollFlight;
  }

  async function pollHomeFromLiveServerOnce() {
    const url = homeLiveApiUrl();
    if (!url || !homeLivePollReady()) return;
    if (document.hidden) return;
    homeLivePollInFlight = true;
    homeLiveLastPollAt = Date.now();
    const squadWasEmpty = !(Array.isArray(HOME.squad) && HOME.squad.length);
    const ac = new AbortController();
    const fetchTimer = setTimeout(() => ac.abort(), HOME_LIVE_FETCH_MS);
    try {
      const res = await fetch(url, { cache: "no-store", signal: ac.signal });
      if (!res.ok) {
        homeLiveLastPollOk = false;
        syncHomeCountLabel();
        settleHomeAfterLivePoll();
        return;
      }
      const data = await res.json();
      if (!(data && data.ok && data.home)) {
        homeLiveLastPollOk = false;
        syncHomeCountLabel();
        settleHomeAfterLivePoll();
        return;
      }
      if (!homeLivePayloadMatchesPrefs(data.home)) {
        homeLiveLastPollOk = false;
        syncHomeCountLabel();
        settleHomeAfterLivePoll();
        return;
      }
      homeLiveLastPollOk = true;
      homeLiveLastSuccessAt = Date.now();
      if (!homeBootstrapSource) homeBootstrapSource = "live";
      const priorStandingsFp = homeStandingsFingerprint(HOME.standings);
      const priorSummaryFp = homeSummaryFingerprint(HOME.summary);
      const priorEgFp = homeElementGwFingerprint(HOME);
      const priorSquadFp = homeSquadFingerprint(HOME.squad);
      const priorTransfersFp = homeTransfersFingerprint(HOME.transfersByEntry);
      const incomingStandingsFp = homeStandingsFingerprint(data.home.standings);
      const incomingSummaryFp = homeSummaryFingerprint(data.home.summary);
      const incomingEgFp = homeElementGwFingerprint(data.home);
      const incomingSquadFp = homeSquadFingerprint(data.home.squad);
      const incomingTransfersFp = homeTransfersFingerprint(data.home.transfersByEntry);
      if (
        priorStandingsFp === incomingStandingsFp
        && priorSummaryFp === incomingSummaryFp
        && priorEgFp === incomingEgFp
        && priorSquadFp === incomingSquadFp
        && priorTransfersFp === incomingTransfersFp
        && String(HOME.generatedAt || "") === String(data.home.generatedAt || "")
      ) {
        persistHomeSessionSnapshot(HOME);
        syncLiveNavChrome();
        resyncHomeLivePollInterval();
        settleHomeAfterLivePoll({ rerender: false });
        return;
      }
      const sameElementGw =
        priorEgFp === incomingEgFp
        && priorSquadFp === incomingSquadFp
        && String(HOME.generatedAt || "") === String(data.home.generatedAt || "")
        && String(HOME.managerId || "") === String(data.home.managerId || "")
        && String(HOME.leagueId || "") === String(data.home.leagueId || "");
      applyHomePayload(data.home, { skipFeedIngest: sameElementGw, fromLivePoll: true });
      const standingsChanged = priorStandingsFp !== homeStandingsFingerprint(HOME.standings);
      const summaryChanged = priorSummaryFp !== homeSummaryFingerprint(HOME.summary);
      const elementGwChanged = priorEgFp !== incomingEgFp;
      const squadChanged = priorSquadFp !== homeSquadFingerprint(HOME.squad);
      const transfersChanged = priorTransfersFp !== homeTransfersFingerprint(HOME.transfersByEntry);
      resyncHomeLivePollInterval();
      if (!standingsChanged && !summaryChanged && !elementGwChanged && !squadChanged && !transfersChanged) {
        syncLiveNavChrome();
        settleHomeAfterLivePoll({ rerender: false });
        return;
      }
      if (state.page === "home") {
        const enterBusy = homeIsEnterBusy();
        if (enterBusy && homeLiveApplyAfterEnter) {
          homeRenderQueued = true;
        } else {
          renderHome({ deferDuringEnter: enterBusy && !squadWasEmpty, settleQuiet: true });
        }
      } else if (state.page === "live") {
        if (liveIsEnterBusy()) liveRenderQueued = true;
        else {
          renderLive({ quiet: true });
          livePollRefreshMotion();
        }
      } else syncLiveNavChrome();
    } catch {
      homeLiveLastPollOk = false;
      if (state.page === "home") settleHomeAfterLivePoll();
    } finally {
      clearTimeout(fetchTimer);
      homeLivePollInFlight = false;
      homeLivePollAttempted = true;
    }
  }

  function syncHomeLivePolling({ skipImmediate = false } = {}) {
    if (!homeLivePollReady()) {
      stopHomeLivePolling();
      syncLiveNavChrome();
      return;
    }
    if (!homeLivePollTimer) {
      homeLivePollIntervalMs = homeLivePollInterval();
      if (!skipImmediate && !document.hidden) pollHomeFromLiveServer();
      homeLivePollTimer = setInterval(() => {
        if (document.hidden) return;
        pollHomeFromLiveServer();
      }, homeLivePollIntervalMs);
    } else {
      resyncHomeLivePollInterval();
    }
    syncLiveNavChrome();
  }

  function prefetchHomeLiveCache() {
    if (homeLivePrefetchStarted) return;
    if (!homeLivePollReady()) return;
    homeLivePrefetchStarted = true;
    syncHomeLivePolling();
  }

  function syncHomeCountLabel() {
    if (!el.homeCountLabel && !el.homeUpdatedFooter) return;
    const linked = !!(savedManagerId && savedLeagueId);
    const hasPayload = !!(HOME && HOME.summary && HOME.managerId && HOME.leagueId);

    const setLabels = (text, { title = null, showFooter = false } = {}) => {
      if (el.homeCountLabel) {
        el.homeCountLabel.classList.remove("is-live", "is-live-stale", "is-live-offline");
        // Timestamp lives in the bottom footer; status strings stay in the header.
        const headerText = showFooter ? "" : text;
        el.homeCountLabel.textContent = headerText;
        if (!showFooter && title) setTip(el.homeCountLabel, title);
        else setTip(el.homeCountLabel, "");
      }
      if (el.homeUpdatedFooter) {
        el.homeUpdatedFooter.textContent = text;
        if (title) setTip(el.homeUpdatedFooter, title);
        else setTip(el.homeUpdatedFooter, "");
        el.homeUpdatedFooter.hidden = !showFooter || !text;
      }
    };

    if (!linked) {
      setLabels("No manager linked", { showFooter: false });
      return;
    }
    if (!hasPayload) {
      setLabels("Refresh home to load", { showFooter: false });
      return;
    }

    const when = fmtMarketsUpdated(pageDataUpdatedIso("home"));
    const homeUpdatedIso = pageDataUpdatedIso("home");
    const text = when ? `Updated ${when}` : "";
    const title = homeUpdatedIso
      ? `Data refreshed ${String(homeUpdatedIso).replace("T", " ").replace("Z", " UTC")}`
      : null;
    setLabels(text, { title, showFooter: !!text });
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
      // Always keep one decimal so the odometer has a tenths column.
      return `${m.toFixed(1)}M`;
    }
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
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
    if (abs >= 1e6) return `${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}K`;
    return abs.toLocaleString();
  }

  function homeRankDeltaHTML(places, { compact = false } = {}) {
    if (places == null || !Number.isFinite(places) || places === 0) return "";
    const up = places > 0;
    const cls = up ? "is-up" : "is-down";
    const icon = up ? "caret-up" : "caret-down";
    const n = formatHomeRankDelta(places);
    const label = `${up ? "Up" : "Down"} ${n} places vs last gameweek`;
    return `<span class="home-rank-delta${compact ? " is-compact" : ""} ${cls}"${tipAttr(label)} aria-label="${escapeHtml(label)}">${iconHTML(icon)}<span class="home-rank-delta-n">${n}</span></span>`;
  }

  function setHomeRankDelta(elDelta, places, { muted = false, animateRoll = false } = {}) {
    if (!elDelta) return;
    if (places == null || !Number.isFinite(places) || places === 0) {
      elDelta.hidden = true;
      elDelta.className = "home-rank-delta";
      elDelta.innerHTML = "";
      elDelta.removeAttribute("title");
      elDelta.removeAttribute("aria-label");
      return;
    }
    const up = places > 0;
    const cls = up ? "is-up" : "is-down";
    const icon = up ? "caret-up" : "caret-down";
    const n = homeRankDeltaValueHTML(places, { animateRoll });
    const label = `${up ? "Up" : "Down"} ${formatHomeRankDelta(places)} places vs last gameweek`;
    elDelta.hidden = false;
    elDelta.className = `home-rank-delta ${cls}${muted ? " is-chrome-muted" : ""}`;
    setTip(elDelta, label);
    elDelta.setAttribute("aria-label", label);
    elDelta.innerHTML = `${iconHTML(icon)}<span class="home-rank-delta-n">${n}</span>`;
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


  // Squad ↔ standings: squad tap opens player lookup (detail card + owner
  // highlight in standings); standings tap switches the whole Home view to that
  // manager's team. Pin = { type: "element", id }.
  let homeOwnerPin = null;
  let homeOwnerBindingsReady = false;
  let homeCrossHoverElement = null;
  let homeStandingsPagerReady = false;
  let homeSquadPagerReady = false;
  let homeSquadPagerTarget = null;
  let homeFeedPagerReady = false;
  const HOME_SQUAD_VIEW_LABELS = ["Starting XI", "Points", "Ownership", "Schedule"];
  const HOME_SQUAD_VIEW_LABELS_WIDE = ["Starting XI", "Ownership", "Schedule"];
  const HOME_STANDINGS_VIEW_LABELS = ["Table", "Transfers", "Captaincy", "Chips"];
  const HOME_FEED_VIEW_LABELS = ["League", "All"];
  let homeViewEntryId = null;
  // Live standings sort — default total pts desc; Live/Left/GW/Total/# are clickable.
  // Home league table — fixed sort: total pts desc, rank asc tiebreak.
  // Mobile Home player lookup (search FAB → profile + club matchups).
  let homeLookupPlayer = null;
  let homeLookupStatMode = 0;
  let homeLookupCardBound = false;

  const HOME_LOOKUP_STAT_MODES = [
    { key: "values", label: "", className: "" },
    { key: "overall", label: "Rank · All", className: "is-rank-overall" },
    { key: "position", label: "Rank · POS", className: "is-rank-pos" },
  ];
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

  function homePositiveRank(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function homeSummaryForView(entryId) {
    const configured = homeConfiguredEntryId();
    const id = Number(entryId);
    if (!Number.isFinite(id)) return HOME.summary || {};
    const row = homeStandingForEntry(id);
    const payloadSummary =
      HOME.summary && Number(HOME.managerId) === id ? HOME.summary : null;
    if (row) {
      const overallRank =
        homePositiveRank(row.overallRank) ?? homePositiveRank(payloadSummary?.overallRank);
      const overallPoints =
        Math.max(Number(row.total) || 0, Number(row.overallPoints) || 0) ||
        Number(payloadSummary?.overallPoints) ||
        null;
      return {
        gwPoints: homeStandingsGwPoints(row),
        overallPoints,
        overallRank,
        overallRankPrev:
          homePositiveRank(row.overallRankPrev) ??
          (payloadSummary ? homePositiveRank(payloadSummary.overallRankPrev) : null),
        leagueRank: row.rankOfficial ?? row.rankLive,
        leagueRankPrev:
          row.rankPrev != null
            ? Number(row.rankPrev)
            : row.lastRank != null
              ? Number(row.lastRank)
              : payloadSummary?.leagueRankPrev ?? null,
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
    if (!Number.isFinite(id)) return false;
    const configured = homeConfiguredEntryId();
    const hadLookup = !!homeLookupPlayer;
    // Selecting a manager exits player lookup so Team / summary reset for that view.
    if (hadLookup) clearHomePlayerLookup({ rerender: false });
    if (id === homeViewEntryId) {
      return clearHomeViewEntry();
    }
    if (homeViewEntryId == null && id === configured) {
      if (!hadLookup) return false;
      homeOwnerPin = null;
      homeRenderQueued = false;
      renderHome({ animateView: true });
      return true;
    }
    homeViewEntryId = id;
    homeOwnerPin = null;
    homeRenderQueued = false;
    renderHome({ animateView: true });
    return true;
  }

  function clearHomeViewEntry() {
    if (homeLookupPlayer) clearHomePlayerLookup({ rerender: false });
    if (homeViewEntryId == null) return false;
    homeViewEntryId = null;
    homeOwnerPin = null;
    homeRenderQueued = false;
    renderHome({ animateView: true });
    return true;
  }

  function hideHomeViewBannerToast() {
    const banner = el.homeViewBanner;
    if (!banner) return;
    banner.hidden = true;
    banner.classList.remove("is-visible", "is-leaving");
  }

  function hideHomeOwnerBannerToast() {
    const banner = el.homeOwnerBanner;
    if (!banner) return;
    banner.hidden = true;
    banner.classList.remove("is-visible", "is-leaving");
  }

  function homeOwnerBannerPlayerName() {
    if (!homeOwnerPin || homeOwnerPin.type !== "element") return "";
    const eid = Number(homeOwnerPin.id);
    let name = "";
    forEachHomeSquadRow((tr) => {
      if (Number(tr.dataset.element) === eid) {
        const n = tr.querySelector(".home-player-name-text");
        if (n) name = n.textContent.trim();
      }
    });
    if (name) return name;
    const squad = homeSquadForEntry(homeActiveViewEntryId()) || [];
    const row = squad.find((r) => Number(r.element) === eid);
    return (row && row.name) || "Player";
  }

  function clearHomeOwnerPin() {
    if (homeLookupPlayer) {
      clearHomePlayerLookup();
      return true;
    }
    if (!homeOwnerPin) return false;
    homeOwnerPin = null;
    syncHomeOwnerHighlights();
    syncHomeOwnerBanner();
    return true;
  }

  function syncHomeViewBanner() {
    const viewingOther = homeIsViewingOtherManager();
    if (el.homeBento) el.homeBento.classList.toggle("is-viewing-manager", viewingOther);
    const banner = el.homeViewBanner;
    if (!banner) return;
    // In-flow top banner (all viewports). Prefer viewing over ownership pin.
    if (viewingOther) {
      hideHomeOwnerBannerToast();
      if (el.homeViewBannerName) {
        el.homeViewBannerName.textContent = homeViewBannerLabel(homeActiveViewEntryId());
      }
    }
    banner.hidden = !viewingOther;
    banner.classList.remove("is-visible", "is-leaving");
  }

  function syncHomeOwnerBanner() {
    const banner = el.homeOwnerBanner;
    if (!banner) return;
    // Lookup mode uses the player detail card — skip the ownership toast.
    const pinOn =
      !!(homeOwnerPin && homeOwnerPin.type === "element") &&
      !homeIsViewingOtherManager() &&
      !homeLookupPlayer;
    if (!pinOn) {
      hideHomeOwnerBannerToast();
      return;
    }
    hideHomeViewBannerToast();
    if (el.homeOwnerBannerName) {
      el.homeOwnerBannerName.textContent = homeOwnerBannerPlayerName();
    }
    banner.hidden = false;
    banner.classList.remove("is-visible", "is-leaving");
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

    if (el.homeSquadBody) {
      el.homeSquadBody.classList.remove("has-owner-filter");
    }
    if (el.homeSquadFixturesBody) {
      el.homeSquadFixturesBody.classList.remove("has-owner-filter");
    }
    if (el.homeSquadPtsBody) {
      el.homeSquadPtsBody.classList.remove("has-owner-filter");
    }
    if (el.homeSquadOwnershipBody) {
      el.homeSquadOwnershipBody.classList.remove("has-owner-filter");
    }
    forEachHomeSquadRow((tr) => {
      const eid = Number(tr.dataset.element);
      const isPinned =
        elementPin && Number.isFinite(eid) && Number(elementPin.id) === eid;
      tr.hidden = false;
      tr.classList.remove("is-owner-match", "is-owner-source");
      tr.classList.toggle("is-owner-pinned", isPinned);
    });
    if (el.homeStandingsBody) el.homeStandingsBody.classList.remove("has-owner-filter");
    if (el.homeStandingsTransfersBody) {
      el.homeStandingsTransfersBody.classList.remove("has-owner-filter");
    }
    if (el.homeStandingsCaptainsBody) {
      el.homeStandingsCaptainsBody.classList.remove("has-owner-filter");
    }
    if (el.homeStandingsChipsBody) el.homeStandingsChipsBody.classList.remove("has-owner-filter");
    forEachHomeStandingsRow((tr) => {
      const entry = Number(tr.dataset.entry);
      const ownsPinned = !!(elementPin && ownerEntries && ownerEntries.has(entry));
      // Unowned lookup: empty message replaces the list — don't keep demoted rows.
      const hideForEmptyLookup =
        !!(elementPin && ownerEntries && ownerEntries.size === 0);
      tr.hidden = hideForEmptyLookup;
      tr.classList.remove("is-owner-source", "is-owner-pinned");
      tr.classList.toggle("is-owner-match", ownsPinned);
      tr.classList.toggle(
        "is-owner-demote",
        !!(elementPin && ownerEntries && ownerEntries.size > 0 && !ownsPinned)
      );
      tr.classList.toggle(
        "is-view-active",
        viewingOther && Number.isFinite(entry) && entry === viewingEntry
      );
      tr.classList.toggle(
        "is-configured-manager",
        viewingOther && Number.isFinite(entry) && entry === configuredEntry
      );
    });
  }

  function homeCaptainsForEntry(entryId) {
    const squad = homeSquadForEntry(entryId);
    return {
      captain: squad.find((r) => r.isCaptain) || null,
      vice: squad.find((r) => r.isVice) || null,
    };
  }

  /** True when every GW fixture is finished and the player recorded 0 minutes. */
  function homePlayerGwFinishedWithoutMinutes(player) {
    if (!player) return false;
    const mins = Number(player.minutes) || 0;
    const fxs = homeSquadFixtures(player);
    if (fxs.length) {
      if (fxs.some((fx) => !fx.finished)) return false;
      const fxMins = fxs.reduce((n, fx) => n + (Number(fx.minutes) || 0), 0);
      return mins <= 0 && fxMins <= 0;
    }
    return player.matchStatus === "finished" && mins <= 0;
  }

  /** Single Captain column when the League card is narrow (mobile or split grid). */
  function homeLeagueCompactCaptains() {
    const track = el.homeStandingsTrack;
    if (track && track.clientWidth > 0) return track.clientWidth <= 900;
    return NARROW_MQ.matches || window.innerWidth <= 900;
  }

  /**
   * Compact captains view: if the named captain finished with 0', show vice
   * (FPL auto-captaincy) and mark the swap. Wide desktop keeps both columns.
   */
  function homeEffectiveCaptainPick(captain, vice) {
    if (
      homeLeagueCompactCaptains()
      && captain
      && vice
      && homePlayerGwFinishedWithoutMinutes(captain)
    ) {
      return { player: vice, autoSubbed: true, original: captain };
    }
    return { player: captain, autoSubbed: false, original: null };
  }

  function homeLeagueMaxCaptainPts() {
    const rows = Array.isArray(HOME.standings) ? HOME.standings : [];
    let max = null;
    for (const r of rows) {
      const { captain, vice } = homeCaptainsForEntry(Number(r.entry));
      const { player } = homeEffectiveCaptainPick(captain, vice);
      if (!player) continue;
      const pts = homeGwAwaitingKickoff()
        ? 0
        : player.gwPoints != null
          ? Number(player.gwPoints)
          : null;
      if (!Number.isFinite(pts)) continue;
      if (max == null || pts > max) max = pts;
    }
    return max;
  }

  function homeCaptainPickHTML(player, { autoSubbed = false, original = null } = {}) {
    if (!player) return "—";
    const teamBadge = badgeHTML(player.team, "home-crest home-crest-captain") ||
      teamCrestFallbackHTML(player.team, "home-crest-fallback home-crest-captain");
    const pts = homeGwAwaitingKickoff()
      ? 0
      : player.gwPoints != null
        ? Number(player.gwPoints)
        : null;
    const ptsHTML = Number.isFinite(pts)
      ? `<span class="home-captain-pts">${statRollSpan(pts, { from: 0, decimals: 0, className: "home-stat-roll" })}</span>`
      : "";
    const fromName = original && original.name ? original.name : "Captain";
    const subHTML = autoSubbed
      ? `<span class="home-captain-sub"${tipAttr(`Vice on as captain — ${fromName} did not play`)} aria-label="Vice on as captain">${iconHTML("repeat-2", "home-captain-sub-icon")}</span>`
      : "";
    return `<span class="home-captain-pick${autoSubbed ? " is-auto-sub" : ""}">${teamBadge}<span class="home-captain-pick-text"><span class="home-captain-name-row"><span class="home-captain-name">${escapeHtml(player.name || "—")}</span>${subHTML}</span>${ptsHTML}</span></span>`;
  }

  function homeStandingsRowClasses(entry, { configuredEntry, viewEntry, viewingOther }) {
    const isConfigured = Number.isFinite(configuredEntry) && entry === configuredEntry;
    const isViewActive = Number.isFinite(viewEntry) && entry === viewEntry;
    return [
      isConfigured && !viewingOther ? "is-you" : "",
      viewingOther && isViewActive ? "is-view-active" : "",
      viewingOther && isConfigured ? "is-configured-manager" : "",
    ].filter(Boolean).join(" ");
  }

  function forEachHomeStandingsRow(fn) {
    [el.homeStandingsBody, el.homeStandingsTransfersBody, el.homeStandingsCaptainsBody, el.homeStandingsChipsBody].forEach((body) => {
      if (!body) return;
      body.querySelectorAll("tr[data-entry]").forEach(fn);
    });
  }

  function forEachHomeSquadRow(fn) {
    [el.homeSquadBody, el.homeSquadFixturesBody, el.homeSquadPtsBody, el.homeSquadOwnershipBody].forEach((body) => {
      if (!body) return;
      body.querySelectorAll("tr.home-squad-row").forEach(fn);
    });
  }

  function homeStandingsManagerCellsHTML(row, { configuredEntry, viewingOther, showActiveChip = false } = {}) {
    const entry = Number(row.entry);
    const rankVal = homeStandingsRankValue(row);
    const rankPrev = row.rankPrev != null ? Number(row.rankPrev) : (row.lastRank != null ? Number(row.lastRank) : null);
    const deltaPlaces = homeRankDeltaPlaces(rankVal, rankPrev);
    const deltaHTML = homeRankDeltaHTML(deltaPlaces, { compact: true });
    const rankHTML = rankVal != null && Number.isFinite(rankVal)
      ? `<span class="home-rank-cell"><span class="home-rank-cell-num">${escapeHtml(formatHomeRank(rankVal))}</span>${deltaHTML}</span>`
      : "—";
    const showConfiguredPin =
      !!viewingOther &&
      Number.isFinite(configuredEntry) &&
      entry === configuredEntry;
    const pin = showConfiguredPin
      ? `<span class="owned-flag home-owned-flag"${tipAttr("Your manager")} aria-label="Your manager">${ownedPinSVG()}</span>`
      : "";
    const chipBadge = showActiveChip ? homeActiveChipBadgeHTML(row) : "";
    return `<td class="home-col-rank">${rankHTML}</td>
      <td class="home-col-manager">
        <div class="home-standings-manager">
          <span class="home-standings-name"><span class="home-standings-name-text">${escapeHtml(row.playerName || "—")}</span>${chipBadge}${pin}</span>
          <span class="home-standings-entry">${escapeHtml(row.entryName || "")}</span>
        </div>
      </td>`;
  }

  function homeStandingsSortValue(row, key) {
    if (key === "live") {
      const n = homeStandingsRowInPlayCount(row);
      return n > 0 ? n : 0;
    }
    if (key === "left") {
      const n = Number(row.toPlay);
      return Number.isFinite(n) ? n : null;
    }
    if (key === "gw") {
      return homeStandingsGwPoints(row);
    }
    if (key === "total") {
      const n = row.total != null ? Number(row.total) : null;
      return n != null && Number.isFinite(n) ? n : null;
    }
    const rank = homeStandingsRankValue(row);
    return rank != null && Number.isFinite(rank) ? rank : null;
  }

  /**
   * GW points for display/sort. While this manager has starters in play, use our live
   * engine; once their XI is done (inPlay === 0), FPL event_total is authoritative
   * even if other league fixtures remain this GW (toPlay may still be > 0).
   */
  function homeStandingsRowInPlayCount(row) {
    if (!homeCanShowVolatileStats()) return 0;
    const n = Number(row && row.inPlay);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function homeStandingsRowToPlayCount(row) {
    if (!homeCanShowVolatileStats()) return null;
    const n = Number(row && row.toPlay);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function homeStandingsGwPoints(row) {
    if (homeGwAwaitingKickoff()) return 0;
    const official = row.eventTotalOfficial != null ? Number(row.eventTotalOfficial) : null;
    const live = row.gwPointsLive != null ? Number(row.gwPointsLive) : null;
    if (!homeCanShowVolatileStats()) {
      if (official != null && Number.isFinite(official)) return official;
      return null;
    }
    const inPlay = homeStandingsRowInPlayCount(row);
    const hasLiveMinutes = inPlay > 0;
    if (!hasLiveMinutes && official != null && Number.isFinite(official)) {
      return official;
    }
    if (hasLiveMinutes && live != null && Number.isFinite(live)) return live;
    if (live != null && Number.isFinite(live)) return live;
    return official != null && Number.isFinite(official) ? official : null;
  }

  /** True when the linked manager has a starter in a fixture that is in play. */
  function homeConfiguredHasLiveMinutes() {
    const entry = homeConfiguredEntryId();
    if (entry == null) return false;
    const squad = homeSquadForEntry(entry);
    return squad.some((row) => row && row.starter && homeSquadRowIsInPlay(row));
  }

  let homeSummaryRankChromePending = false;

  function clearHomeRankBorderRevealTimer() {
    if (homeRankBorderRevealTimer) {
      clearTimeout(homeRankBorderRevealTimer);
      homeRankBorderRevealTimer = null;
    }
  }

  function clearHomeSummaryRankChrome() {
    clearHomeRankBorderRevealTimer();
    if (el.homeBento) el.homeBento.classList.remove("is-rank-chrome-staged");
    setHomeRankDelta(el.homeOverallRankDelta, null);
    setHomeRankDelta(el.homeLeagueRankDelta, null);
    setHomeOverallPct(el.homeOverallPct, null, null);
    const overallPanel = el.homeOverallRank && el.homeOverallRank.closest(".home-stat-panel");
    const leaguePanel = el.homeLeagueRank && el.homeLeagueRank.closest(".home-stat-panel");
    [overallPanel, leaguePanel].forEach((panel) => {
      if (panel) panel.classList.remove("is-rank-border-up", "is-rank-border-down");
    });
  }

  function homeSummaryRankDeltaPlaces(summary, key) {
    if (key === "overall") {
      return summary.overallRankPrev == null
        ? null
        : homeRankDeltaPlaces(summary.overallRank, summary.overallRankPrev);
    }
    return summary.leagueRankPrev == null
      ? null
      : homeRankDeltaPlaces(summary.leagueRank, summary.leagueRankPrev);
  }

  function applyHomeSummaryRankDeltas(summary, { viewingOther = false, muted = false, animateRoll = false } = {}) {
    setHomeRankDelta(
      el.homeOverallRankDelta,
      homeSummaryRankDeltaPlaces(summary, "overall"),
      { muted, animateRoll }
    );
    setHomeOverallPct(
      el.homeOverallPct,
      viewingOther ? null : summary.overallRank,
      viewingOther ? null : summary.totalPlayers
    );
    setHomeRankDelta(
      el.homeLeagueRankDelta,
      homeSummaryRankDeltaPlaces(summary, "league"),
      { muted, animateRoll }
    );
  }

  function revealHomeSummaryRankBorders() {
    clearHomeRankBorderRevealTimer();
    if (el.homeBento) el.homeBento.classList.remove("is-rank-chrome-staged");
    [el.homeOverallRankDelta, el.homeLeagueRankDelta].forEach((node) => {
      if (node) node.classList.remove("is-chrome-muted");
    });
    syncHomeRankPanelBorders();
  }

  function stageHomeSummaryRankChrome(summary, { viewingOther = false } = {}) {
    if (el.homeBento) el.homeBento.classList.add("is-rank-chrome-staged");
    const overallPanel = el.homeOverallRank && el.homeOverallRank.closest(".home-stat-panel");
    const leaguePanel = el.homeLeagueRank && el.homeLeagueRank.closest(".home-stat-panel");
    [overallPanel, leaguePanel].forEach((panel) => {
      if (panel) panel.classList.remove("is-rank-border-up", "is-rank-border-down");
    });
    applyHomeSummaryRankDeltas(summary, { viewingOther, muted: true, animateRoll: true });
  }

  function scheduleHomeSummaryRankBorderReveal(rollMs, token) {
    clearHomeRankBorderRevealTimer();
    const delay = Math.max(120, Math.round(rollMs * HOME_RANK_BORDER_REVEAL_RATIO));
    homeRankBorderRevealTimer = setTimeout(() => {
      homeRankBorderRevealTimer = null;
      if (token !== homeEnterMotionToken) return;
      revealHomeSummaryRankBorders();
    }, delay);
  }

  function applyHomeSummaryRankChrome(summary, { viewingOther = false } = {}) {
    clearHomeRankBorderRevealTimer();
    if (el.homeBento) el.homeBento.classList.remove("is-rank-chrome-staged");
    applyHomeSummaryRankDeltas(summary, { viewingOther, muted: false });
    syncHomeRankPanelBorders();
  }

  function homeShouldDeferSummaryRankChrome({ animateView = false, settleQuiet = false } = {}) {
    if (settleQuiet || prefersReducedMotion()) return false;
    if (animateView || homeSummaryRankChromePending || homePageEnterArmed) return true;
    return !!(el.homePage && el.homePage.classList.contains("is-enter-pending"));
  }

  function syncHomeLiveChrome() {
    if (!el.homeBento) return;
    const live = homeConfiguredHasLiveMinutes();
    el.homeBento.classList.toggle("has-live-minutes", live);
  }

  function syncHomeRankPanelBorders() {
    if (!el.homeBento) return;
    const overallPanel = el.homeOverallRank && el.homeOverallRank.closest(".home-stat-panel");
    const leaguePanel = el.homeLeagueRank && el.homeLeagueRank.closest(".home-stat-panel");
    [overallPanel, leaguePanel].forEach((panel) => {
      if (panel) panel.classList.remove("is-rank-border-up", "is-rank-border-down");
    });

    const summary = homeSummaryForView(homeActiveViewEntryId());
    const overallDelta =
      summary.overallRankPrev == null
        ? null
        : homeRankDeltaPlaces(summary.overallRank, summary.overallRankPrev);
    const leagueDelta =
      summary.leagueRankPrev == null
        ? null
        : homeRankDeltaPlaces(summary.leagueRank, summary.leagueRankPrev);

    if (overallPanel && Number.isFinite(overallDelta) && overallDelta !== 0) {
      overallPanel.classList.add(overallDelta > 0 ? "is-rank-border-up" : "is-rank-border-down");
    }
    if (leaguePanel && Number.isFinite(leagueDelta) && leagueDelta !== 0) {
      leaguePanel.classList.add(leagueDelta > 0 ? "is-rank-border-up" : "is-rank-border-down");
    }
  }

  function homeStandingsRankValue(row) {
    if (row.rankOfficial != null) {
      const n = Number(row.rankOfficial);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (row.rankLive != null) {
      const n = Number(row.rankLive);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  }

  function sortedHomeStandingsRows(rows) {
    return rows.slice().sort((a, b) => {
      const av = homeStandingsSortValue(a, "total");
      const bv = homeStandingsSortValue(b, "total");
      const aOk = av != null;
      const bOk = bv != null;
      if (!aOk && !bOk) return 0;
      if (!aOk) return 1;
      if (!bOk) return -1;
      if (av !== bv) return bv - av;
      const ar = homeStandingsSortValue(a, "rank");
      const br = homeStandingsSortValue(b, "rank");
      if (ar == null && br == null) return 0;
      if (ar == null) return 1;
      if (br == null) return -1;
      return ar - br;
    });
  }

  // Top-5 GW / Total band with Statistics-style rank+value fade intensity.
  function buildHomeStandingsTopMaps(rows) {
    const TOP_N = 5;
    const maps = { gw: new Map(), total: new Map() };
    function fill(map, key) {
      const withVals = rows
        .map((r) => ({ entry: Number(r.entry), val: homeStandingsSortValue(r, key) }))
        .filter((x) => Number.isFinite(x.entry) && x.val != null && Math.abs(x.val) > 1e-9);
      if (withVals.length < 2) return;
      withVals.sort((a, b) => b.val - a.val);
      const maxV = withVals[0].val;
      const minV = withVals[withVals.length - 1].val;
      if (maxV === minV) return;
      const slice = withVals.slice(0, Math.min(TOP_N, withVals.length));
      const best = slice[0].val;
      const worst = slice[slice.length - 1].val;
      slice.forEach((x, i) => {
        map.set(x.entry, enhanceBandIntensity(i, slice.length, x.val, best, worst));
      });
    }
    fill(maps.gw, "gw");
    fill(maps.total, "total");
    return maps;
  }

  function homeStandingsCountHTML(value, { className = "home-stat-roll", from = 0, decimals = 0, signed = false, suffix = "" } = {}) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    return statRollSpan(Number(value), {
      from,
      decimals,
      signed,
      suffix,
      className,
    });
  }

  function homeStandingsPillHTML(value, intensity) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const roll = homeStandingsCountHTML(n, { className: "home-stat-roll" });
    // null = outside top-5 band. 0 = weakest of the five (still tinted).
    if (intensity == null || !Number.isFinite(Number(intensity))) {
      if (value === 0) {
        return `<span class="home-standings-metric is-zero">${roll}</span>`;
      }
      return `<span class="home-standings-metric">${roll}</span>`;
    }
    // Floor so 5th never melts to bare white; leaders still reach full strength.
    const boosted = 0.34 + 0.66 * Math.min(1, Math.max(0, Number(intensity)));
    const paint = enhanceHighlightPaint("top", boosted);
    if (paint.skip) {
      if (value === 0) {
        return `<span class="home-standings-metric is-zero">${roll}</span>`;
      }
      return `<span class="home-standings-metric">${roll}</span>`;
    }
    const parts = [`--hl-fill:${paint.backgroundColor}`];
    if (paint.color) parts.push(`--hl-text:${paint.color}`);
    const cls = [
      "home-standings-pill",
      paint.emphasize ? "is-emphasize" : "",
      paint.strong ? "is-strong" : "",
    ].filter(Boolean).join(" ");
    return `<span class="${cls}" style="${parts.join(";")}">${roll}</span>`;
  }

  /** True when any league manager has active picks in a live fixture. */
  function homeLeagueHasLivePicks() {
    if (!homeCanShowVolatileStats()) return false;
    const rows = Array.isArray(HOME.standings) ? HOME.standings : [];
    return rows.some((r) => homeStandingsRowInPlayCount(r) > 0);
  }

  function syncHomeStandingsLiveColumn() {
    const table = el.homeStandingsBody && el.homeStandingsBody.closest("table");
    if (!table) return;
    table.classList.toggle("has-live-picks", homeLeagueHasLivePicks());
  }

  function homeStandingsLiveRowHTML(row, { configuredEntry, viewEntry, viewingOther, topMaps }) {
    const entry = Number(row.entry);
    const rowCls = homeStandingsRowClasses(entry, { configuredEntry, viewEntry, viewingOther });
    const inPlay = homeStandingsRowInPlayCount(row);
    const toPlay = homeStandingsRowToPlayCount(row);
    const liveTitle = "Active picks in play (Bench Boost can exceed 11)";
    const leftTitle = "Still to play this gameweek";
    const gwPts = homeStandingsGwPoints(row);
    const totalPts = row.total != null ? Number(row.total) : null;
    const hasPlay = toPlay != null;
    const liveHTML = hasPlay
      ? (inPlay > 0
        ? `<span class="ownership-pill home-standings-live-pill is-active"${tipAttr(liveTitle)}>${homeStandingsCountHTML(inPlay)}</span>`
        : `<span class="ownership-pill home-standings-live-pill is-zero"${tipAttr(liveTitle)}>${homeStandingsCountHTML(inPlay)}</span>`)
      : "—";
    const leftHTML = hasPlay
      ? `<span class="home-play-left${toPlay > 0 ? " is-active" : " is-zero"}" title="${escapeHtml(leftTitle)}">${homeStandingsCountHTML(toPlay)}</span>`
      : "—";
    const playHTML = hasPlay
      ? `<span class="home-play-split"${tipAttr(`${liveTitle}. ${leftTitle}`)}>
          <span class="home-play-live${inPlay > 0 ? " is-active" : " is-zero"}">${homeStandingsCountHTML(inPlay)}</span>
          <span class="home-play-split-sep" aria-hidden="true">/</span>
          <span class="home-play-left${toPlay > 0 ? " is-active" : " is-zero"}">${homeStandingsCountHTML(toPlay)}</span>
        </span>`
      : "—";
    const gwIntensity = topMaps && topMaps.gw ? topMaps.gw.get(entry) : null;
    const totalIntensity = topMaps && topMaps.total ? topMaps.total.get(entry) : null;
    const gwHTML = gwPts != null && Number.isFinite(gwPts)
      ? homeStandingsPillHTML(gwPts, gwIntensity)
      : "—";
    const totalHTML = totalPts != null && Number.isFinite(totalPts)
      ? homeStandingsPillHTML(totalPts, totalIntensity)
      : "—";
    const labelName = row.playerName || row.entryName || "this manager";
    return `<tr class="${rowCls}" data-entry="${escapeHtml(String(row.entry ?? ""))}" role="button" tabindex="0" aria-label="View ${escapeHtml(labelName)} team">
      ${homeStandingsManagerCellsHTML(row, { configuredEntry, viewingOther, showActiveChip: true })}
      <td class="home-col-live">${liveHTML}</td>
      <td class="home-col-left">${leftHTML}</td>
      <td class="home-col-play">${playHTML}</td>
      <td class="home-col-gw">${gwHTML}</td>
      <td class="home-col-total">${totalHTML}</td>
    </tr>`;
  }

  function renderHomeStandingsCaptainsBody() {
    if (!el.homeStandingsCaptainsBody) return;
    if (homeStandingsShowLoading()) {
      el.homeStandingsCaptainsBody.innerHTML = homeSquadLoadingHTML(4, 8);
      return;
    }
    const configuredEntry = homeConfiguredEntryId();
    const viewEntry = homeActiveViewEntryId();
    const viewingOther = homeIsViewingOtherManager();
    const rows = Array.isArray(HOME.standings) ? HOME.standings : [];
    const compact = homeLeagueCompactCaptains();
    const topCaptainPts = homeLeagueMaxCaptainPts();
    const opts = { configuredEntry, viewEntry, viewingOther, topCaptainPts };
    const captainsTable = el.homeStandingsCaptainsBody.closest("table");
    if (captainsTable) captainsTable.classList.toggle("is-compact-captains", compact);
    el.homeStandingsCaptainsBody.innerHTML = rows.map((r) =>
      homeCaptainsRowHTML(r, opts)
    ).join("") || `<tr><td colspan="${compact ? 3 : 4}">No standings.</td></tr>`;
  }

  function renderHomeStandingsLiveBody() {
    if (!el.homeStandingsBody) return;
    if (homeStandingsShowLoading()) {
      el.homeStandingsBody.innerHTML = homeSquadLoadingHTML(7, 8);
      syncHomeStandingsLiveColumn();
      return;
    }
    const configuredEntry = homeConfiguredEntryId();
    const viewEntry = homeActiveViewEntryId();
    const viewingOther = homeIsViewingOtherManager();
    const rows = Array.isArray(HOME.standings) ? HOME.standings : [];
    const sorted = sortedHomeStandingsRows(rows);
    const topMaps = buildHomeStandingsTopMaps(rows);
    const opts = { configuredEntry, viewEntry, viewingOther, topMaps };
    el.homeStandingsBody.innerHTML = sorted.map((r) =>
      homeStandingsLiveRowHTML(r, opts)
    ).join("") || `<tr><td colspan="7">No standings.</td></tr>`;
    syncHomeStandingsLiveColumn();
    syncHomeOwnerHighlights();
    syncHomeStandingsLayout(homeStandingsActivePageIndex(), { animate: false, allowShrink: true });
  }

  function homeCaptainsRowHTML(row, { configuredEntry, viewEntry, viewingOther, topCaptainPts }) {
    const entry = Number(row.entry);
    const rowCls = homeStandingsRowClasses(entry, { configuredEntry, viewEntry, viewingOther });
    const { captain, vice } = homeCaptainsForEntry(entry);
    const effective = homeEffectiveCaptainPick(captain, vice);
    const shown = effective.player;
    const shownPts = homeGwAwaitingKickoff()
      ? 0
      : shown && shown.gwPoints != null
        ? Number(shown.gwPoints)
        : null;
    const isTopCaptain =
      Number.isFinite(topCaptainPts)
      && topCaptainPts > 0
      && Number.isFinite(shownPts)
      && shownPts === topCaptainPts;
    const labelName = row.playerName || row.entryName || "this manager";
    return `<tr class="${rowCls}" data-entry="${escapeHtml(String(row.entry ?? ""))}" role="button" tabindex="0" aria-label="View ${escapeHtml(labelName)} team">
      ${homeStandingsManagerCellsHTML(row, { configuredEntry, viewingOther })}
      <td class="home-col-captain${isTopCaptain ? " is-top-captain" : ""}">${homeCaptainPickHTML(shown, {
        autoSubbed: effective.autoSubbed,
        original: effective.original,
      })}</td>${
        homeLeagueCompactCaptains()
          ? ""
          : `<td class="home-col-vice">${homeCaptainPickHTML(vice)}</td>`
      }
    </tr>`;
  }

  const HOME_CHIP_ORDER = ["wildcard", "freehit", "bboost", "3xc"];
  const HOME_CHIP_ABBR = {
    wildcard: "WC",
    freehit: "FH",
    bboost: "BB",
    "3xc": "TC",
  };

  function homeActiveChipName(row) {
    const active = row.activeChip ? String(row.activeChip).trim() : "";
    if (active && HOME_CHIP_ABBR[active]) return active;
    const chips = row.chips && typeof row.chips === "object" ? row.chips : {};
    for (const name of HOME_CHIP_ORDER) {
      const chip = chips[name];
      if (chip && chip.status === "active") return name;
    }
    return null;
  }

  function homeActiveChipBadgeHTML(row) {
    const name = homeActiveChipName(row);
    if (!name) return "";
    const abbr = HOME_CHIP_ABBR[name] || name.toUpperCase();
    const chips = row.chips && typeof row.chips === "object" ? row.chips : {};
    const chip = chips[name];
    const title = chip && chip.label
      ? `${chip.label} active this gameweek`
      : `${abbr} active this gameweek`;
    return `<span class="home-standings-chip-badge"${tipAttr(title)} aria-label="${escapeHtml(title)}">${escapeHtml(abbr)}</span>`;
  }

  function homeChipCellHTML(chip) {
    const status = chip && chip.status ? String(chip.status) : "available";
    const label = chip && chip.label ? String(chip.label) : "";
    const ev = chip && chip.event != null ? Number(chip.event) : null;
    const gwLabel = Number.isFinite(ev) ? String(ev) : "\u00a0";
    if (status === "active") {
      return `<span class="home-chip-cell is-active" title="${escapeHtml(label)} active this GW"><span class="home-chip-cell-mark" aria-hidden="true"></span><span class="home-chip-cell-gw">${escapeHtml(gwLabel)}</span></span>`;
    }
    if (status === "used") {
      return `<span class="home-chip-cell is-used" title="${escapeHtml(label)} used GW${escapeHtml(Number.isFinite(ev) ? String(ev) : "")}"><span class="home-chip-cell-mark" aria-hidden="true"></span><span class="home-chip-cell-gw">${escapeHtml(gwLabel)}</span></span>`;
    }
    return `<span class="home-chip-cell is-available" title="${escapeHtml(label || "Chip")} still available"><span class="home-chip-cell-mark" aria-hidden="true"></span><span class="home-chip-cell-gw" aria-hidden="true">${escapeHtml(gwLabel)}</span></span>`;
  }

  function homeChipsRowHTML(row, { configuredEntry, viewEntry, viewingOther }) {
    const entry = Number(row.entry);
    const rowCls = homeStandingsRowClasses(entry, { configuredEntry, viewEntry, viewingOther });
    const chips = row.chips && typeof row.chips === "object" ? row.chips : {};
    const cells = HOME_CHIP_ORDER.map((name) => {
      return `<td class="home-col-chip">${homeChipCellHTML(chips[name])}</td>`;
    }).join("");
    const labelName = row.playerName || row.entryName || "this manager";
    return `<tr class="${rowCls}" data-entry="${escapeHtml(String(row.entry ?? ""))}" role="button" tabindex="0" aria-label="View ${escapeHtml(labelName)} team">
      ${homeStandingsManagerCellsHTML(row, { configuredEntry, viewingOther })}
      ${cells}
    </tr>`;
  }

  function homeElementGwPts(elementId) {
    if (homeGwAwaitingKickoff()) return 0;
    const rec = (HOME.elementGw || {})[String(elementId)];
    if (!rec || typeof rec !== "object") return 0;
    const n = Number(rec.pts);
    return Number.isFinite(n) ? n : 0;
  }

  function homeTransferMovePtsDelta(move) {
    if (homeGwAwaitingKickoff()) return 0;
    if (move && move.ptsDelta != null && Number.isFinite(Number(move.ptsDelta))) {
      return Number(move.ptsDelta);
    }
    const inPts = move?.in?.gwPoints != null && Number.isFinite(Number(move.in.gwPoints))
      ? Number(move.in.gwPoints)
      : homeElementGwPts(move?.in?.id);
    const outPts = move?.out?.gwPoints != null && Number.isFinite(Number(move.out.gwPoints))
      ? Number(move.out.gwPoints)
      : homeElementGwPts(move?.out?.id);
    return inPts - outPts;
  }

  function homeTransferPtsDeltaHTML(delta) {
    const n = Number(delta);
    if (!Number.isFinite(n)) return "";
    if (n === 0) return `<span class="home-transfer-pts is-flat">0</span>`;
    const cls = n > 0 ? "is-up" : "is-down";
    const text = n > 0 ? `+${n}` : `−${Math.abs(n)}`;
    return `<span class="home-transfer-pts ${cls}">${text}</span>`;
  }

  function homeTransferMoveHTML(move) {
    const out = move && move.out ? move.out : null;
    const inn = move && move.in ? move.in : null;
    // Belt-and-suspenders: never render cross-position pairs if types are known.
    const outType = out && out.elementType != null ? Number(out.elementType) : NaN;
    const inType = inn && inn.elementType != null ? Number(inn.elementType) : NaN;
    if (Number.isFinite(outType) && Number.isFinite(inType) && outType > 0 && inType > 0 && outType !== inType) {
      return "";
    }
    const parts = [];
    if (out && out.name) {
      parts.push(`<span class="home-transfer-out">${escapeHtml(out.name)}</span>`);
    }
    if (out && inn) {
      parts.push(`<span class="home-transfer-arrow" aria-hidden="true">→</span>`);
    }
    if (inn && inn.name) {
      parts.push(`<span class="home-transfer-in">${escapeHtml(inn.name)}</span>`);
    }
    const deltaHTML = homeTransferPtsDeltaHTML(homeTransferMovePtsDelta(move));
    return parts.length
      ? `<span class="home-transfer-move">${parts.join("")}${deltaHTML}</span>`
      : "";
  }

  function homeTransfersCellHTML(transfers) {
    if (!transfers || typeof transfers !== "object") return "—";
    const moves = Array.isArray(transfers.moves) ? transfers.moves : [];
    if (!moves.length) return "—";
    const moveHTML = moves.map((m) => homeTransferMoveHTML(m)).filter(Boolean).join("");
    if (!moveHTML) return "—";
    const cost = Number(transfers.cost) || 0;
    const hitCount = cost > 0 ? Math.max(1, Math.round(cost / 4)) : 0;
    const hit = transfers.hit && cost > 0
      ? `<span class="home-transfer-hit"${tipAttr(
          hitCount === 1
            ? `Transfer hit −${cost}: one transfer beyond free transfers`
            : `Transfer hits −${cost}: ${hitCount} transfers beyond free transfers`
        )}><span class="home-transfer-hit-label">Hit</span><span class="home-transfer-hit-cost">−${cost}</span></span>`
      : "";
    const chip = transfers.activeChip === "freehit"
      ? `<span class="home-transfer-chip">FH</span>`
      : transfers.activeChip === "wildcard"
        ? `<span class="home-transfer-chip">WC</span>`
        : "";
    const multi = moves.length > 1;
    return `<span class="home-transfers-cell${multi ? " is-multi" : ""}">${moveHTML}${hit}${chip}</span>`;
  }

  function homeTransfersTableScrollEl() {
    return el.homeTransfersTableWrap;
  }

  function resetHomeTransfersTableScroll() {
    const wrap = homeTransfersTableScrollEl();
    if (wrap) wrap.scrollTop = 0;
  }

  function homeTransfersStatusLabel() {
    const status = HOME.leaguePicksStatus;
    if (!status || typeof status !== "object") return "";
    if (status.transfersReady) return "";
    const ready = status.ready != null ? Number(status.ready) : 0;
    const total = status.total != null ? Number(status.total) : 0;
    if (status.blackout) {
      return `Waiting for FPL… (${ready}/${total} squads ready)`;
    }
    if (total > 0 && ready < total) {
      return `Waiting for FPL… (${ready}/${total} squads ready)`;
    }
    return "";
  }

  function homeTransfersRowHTML(row, { configuredEntry, viewEntry, viewingOther }) {
    const entry = Number(row.entry);
    const rowCls = homeStandingsRowClasses(entry, { configuredEntry, viewEntry, viewingOther });
    // Prefer transfersByEntry (canonical) over standings-embedded copies — session
    // snapshots can carry stale pairings on row.transfers after a pairing fix.
    const transfers = (HOME.transfersByEntry && HOME.transfersByEntry[String(row.entry)])
      || row.transfers
      || null;
    const labelName = row.playerName || row.entryName || "this manager";
    return `<tr class="${rowCls}" data-entry="${escapeHtml(String(row.entry ?? ""))}" role="button" tabindex="0" aria-label="View ${escapeHtml(labelName)} team">
      ${homeStandingsManagerCellsHTML(row, { configuredEntry, viewingOther })}
      <td class="home-col-transfers">${homeTransfersCellHTML(transfers)}</td>
    </tr>`;
  }

  function syncHomeStandingsPagerDots(activeIndex) {
    if (!el.homeStandingsDots) return;
    el.homeStandingsDots.querySelectorAll(".home-standings-dot").forEach((dot, i) => {
      const on = i === activeIndex;
      dot.classList.toggle("is-active", on);
      dot.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (el.homeStandingsViewLabel) {
      el.homeStandingsViewLabel.textContent =
        HOME_STANDINGS_VIEW_LABELS[activeIndex] || HOME_STANDINGS_VIEW_LABELS[0];
    }
  }

  function homeStandingsPageWidth() {
    return el.homeStandingsTrack ? el.homeStandingsTrack.clientWidth || 1 : 1;
  }

  function homeStandingsPageScrollLeft(index) {
    return Math.max(0, index) * homeStandingsPageWidth();
  }

  function homeStandingsActivePageIndex() {
    if (!el.homeStandingsTrack) return 0;
    const pages = [...el.homeStandingsTrack.querySelectorAll(".home-standings-page")];
    if (!pages.length) return 0;
    const w = homeStandingsPageWidth();
    return Math.max(0, Math.min(pages.length - 1, Math.round(el.homeStandingsTrack.scrollLeft / w)));
  }

  function snapHomeStandingsPage(index) {
    if (!el.homeStandingsTrack) return;
    const pages = [...el.homeStandingsTrack.querySelectorAll(".home-standings-page")];
    if (!pages[index]) return;
    const target = homeStandingsPageScrollLeft(index);
    if (Math.abs(el.homeStandingsTrack.scrollLeft - target) > 1) {
      el.homeStandingsTrack.scrollTo({ left: target, behavior: "auto" });
    }
  }

  function syncHomeStandingsTrackHeight(activeIndex, { animate = true, allowShrink = true } = {}) {
    if (!el.homeStandingsTrack) return;
    const pages = [...el.homeStandingsTrack.querySelectorAll(".home-standings-page")];
    if (!pages.length) {
      el.homeStandingsTrack.style.height = "";
      el.homeStandingsTrack.style.maxHeight = "";
      if (el.homeTransfersTableWrap) el.homeTransfersTableWrap.style.maxHeight = "";
      return;
    }
    const idx =
      activeIndex != null && Number.isFinite(activeIndex)
        ? Math.max(0, Math.min(pages.length - 1, activeIndex))
        : homeStandingsActivePageIndex();
    const page = pages[idx];
    if (!page) return;
    // Pin Transfers to the Table viewport and scroll inside (desktop + mobile).
    // Prefer Table page height; fall back to Captains/Chips if Table is empty.
    let measurePage = idx === 1 ? pages[0] : page;
    if (idx === 1) {
      const tableH = pages[0]
        ? Math.ceil(Math.max(pages[0].scrollHeight, pages[0].offsetHeight))
        : 0;
      if (!(tableH > 0)) {
        for (let i = 0; i < pages.length; i += 1) {
          if (i === 1) continue;
          const alt = Math.ceil(Math.max(pages[i].scrollHeight, pages[i].offsetHeight));
          if (alt > 0) {
            measurePage = pages[i];
            break;
          }
        }
      }
    }
    let h = Math.ceil(Math.max(measurePage.scrollHeight, measurePage.offsetHeight));
    if (!(h > 0)) return;
    const prev = parseFloat(el.homeStandingsTrack.style.height) || 0;
    if (!allowShrink && prev > 0) h = Math.max(h, prev);
    const next = `${h}px`;
    // Always clamp min/max so flex content-size can't reopen the card on scroll.
    el.homeStandingsTrack.style.minHeight = "0";
    el.homeStandingsTrack.style.maxHeight = idx === 1 ? next : "";
    if (el.homeTransfersTableWrap) {
      el.homeTransfersTableWrap.style.maxHeight = idx === 1 ? next : "";
    }
    if (pages[1]) {
      pages[1].style.height = idx === 1 ? next : "";
      pages[1].style.maxHeight = idx === 1 ? next : "";
      pages[1].style.minHeight = "0";
      pages[1].style.overflow = "hidden";
    }
    if (el.homeStandingsTrack.style.height === next) return;
    if (!animate) {
      el.homeStandingsTrack.style.transition = "none";
      el.homeStandingsTrack.style.height = next;
      void el.homeStandingsTrack.offsetHeight;
      el.homeStandingsTrack.style.removeProperty("transition");
      return;
    }
    el.homeStandingsTrack.style.height = next;
  }

  /** Equalize header + per-manager row heights across Table / Captains / Chips.
   *  Transfers rows stay natural height; the table scrolls inside a fixed viewport. */
  function syncHomeStandingsRowHeights() {
    const transfersTable =
      el.homeStandingsTransfersBody && el.homeStandingsTransfersBody.closest("table");
    const coreTables = [
      el.homeStandingsBody && el.homeStandingsBody.closest("table"),
      el.homeStandingsCaptainsBody && el.homeStandingsCaptainsBody.closest("table"),
      el.homeStandingsChipsBody && el.homeStandingsChipsBody.closest("table"),
    ].filter(Boolean);
    const allTables = transfersTable ? [...coreTables, transfersTable] : coreTables;
    if (allTables.length < 2 && !coreTables.length) return;

    const clearRowHeights = (table) => {
      table.querySelectorAll("thead tr, tbody tr[data-entry]").forEach((tr) => {
        tr.style.height = "";
      });
    };

    // Desktop equal-share rows come from CSS (height: 1px trick); drop stale mobile heights.
    if (homeSquadIsDesktopLayout()) {
      allTables.forEach(clearRowHeights);
      return;
    }

    const measureTr = (tr) => {
      const prev = tr.style.height;
      tr.style.height = "auto";
      const h = Math.ceil(tr.getBoundingClientRect().height);
      tr.style.height = prev;
      return h;
    };

    const heads = allTables.map((t) => t.querySelector("thead tr")).filter(Boolean);
    if (heads.length > 1) {
      const maxHead = Math.max(...heads.map(measureTr));
      if (maxHead > 0) {
        const px = `${maxHead}px`;
        heads.forEach((tr) => {
          tr.style.height = px;
        });
      }
    }

    allTables.forEach(clearRowHeights);
    if (transfersTable) {
      transfersTable.querySelectorAll("tbody tr[data-entry]").forEach((tr) => {
        tr.style.height = "";
      });
    }

    const byEntry = new Map();
    coreTables.forEach((table) => {
      table.querySelectorAll("tbody tr[data-entry]").forEach((tr) => {
        const key = String(tr.dataset.entry || "");
        if (!key) return;
        if (!byEntry.has(key)) byEntry.set(key, []);
        byEntry.get(key).push(tr);
      });
    });
    byEntry.forEach((trs) => {
      if (trs.length < 1) return;
      const maxH = Math.max(...trs.map(measureTr));
      if (!(maxH > 0)) return;
      const px = `${maxH}px`;
      trs.forEach((tr) => {
        tr.style.height = px;
      });
    });
  }

  /** Align wide squad live + pts halves; show split immediately, measure after paint. */
  function settleHomeSquadSplitLayout({ deferMeasure = false } = {}) {
    if (!homeSquadIsWideLayout()) {
      document.documentElement.classList.remove("home-squad-layout-ready");
      return;
    }
    document.documentElement.classList.add("home-squad-layout-ready");
    const measure = () => syncHomeSquadRowHeights();
    if (deferMeasure) {
      requestAnimationFrame(() => requestAnimationFrame(measure));
    } else {
      measure();
    }
  }

  function settleHomeTablesLayout({ standingsPageIdx } = {}) {
    const idx =
      standingsPageIdx != null && Number.isFinite(standingsPageIdx)
        ? standingsPageIdx
        : homeStandingsActivePageIndex();
    syncHomeSquadRowHeights();
    syncHomeStandingsRowHeights();
    syncHomeTablesGridHeight();
    syncHomeStandingsTrackHeight(idx, { animate: false, allowShrink: true });
    syncHomeSquadTrackHeight(undefined, { animate: false });
    if (homeSquadIsWideLayout()) {
      document.documentElement.classList.add("home-squad-layout-ready");
    }
  }

  function syncHomeTablesGridHeight() {
    if (!el.homeTablesGrid || !el.homeSquadPanel || !el.homeStandingsPanel) return;
    const feed = el.homeFeedPanel;
    const panels = [el.homeSquadPanel, el.homeStandingsPanel];
    if (feed) panels.push(feed);

    const clearPanelHeights = () => {
      panels.forEach((p) => {
        if (!p) return;
        p.style.height = "";
        p.style.minHeight = "";
        p.style.removeProperty("align-self");
      });
      el.homeTablesGrid.style.removeProperty("--home-tables-panel-h");
    };

    if (!homeSquadIsWideLayout() || !homeSquadIsDesktopLayout()) {
      clearPanelHeights();
      return;
    }

    // Measure squad + standings at intrinsic height without display:none on
    // the feed (that reflowed the whole grid and delayed enter by hundreds of ms).
    [el.homeSquadPanel, el.homeStandingsPanel].forEach((p) => {
      p.style.height = "auto";
      p.style.minHeight = "0";
      p.style.alignSelf = "start";
    });
    void el.homeTablesGrid.offsetHeight;

    const cap = Math.max(
      Math.ceil(el.homeStandingsPanel.getBoundingClientRect().height),
      Math.ceil(el.homeSquadPanel.getBoundingClientRect().height)
    );
    [el.homeSquadPanel, el.homeStandingsPanel].forEach((p) => {
      p.style.removeProperty("align-self");
    });

    if (!(cap > 0)) {
      clearPanelHeights();
      return;
    }

    const px = `${cap}px`;
    el.homeTablesGrid.style.setProperty("--home-tables-panel-h", px);
    panels.forEach((p) => {
      if (!p) return;
      p.style.height = px;
      p.style.minHeight = px;
    });
  }

  function syncHomeStandingsLayout(activeIndex, opts) {
    syncHomeStandingsRowHeights();
    syncHomeStandingsTrackHeight(activeIndex, opts);
    requestAnimationFrame(() => {
      syncHomeTablesGridHeight();
    });
  }

  function setHomeStandingsPage(index, { smooth = true } = {}) {
    if (!el.homeStandingsTrack) return;
    const pages = [...el.homeStandingsTrack.querySelectorAll(".home-standings-page")];
    if (!pages[index]) return;
    if (index === 1) resetHomeTransfersTableScroll();
    el.homeStandingsTrack.scrollTo({
      left: homeStandingsPageScrollLeft(index),
      behavior: smooth ? "smooth" : "auto",
    });
    syncHomeStandingsPagerDots(index);
    syncHomeStandingsLayout(index);
  }

  function bindHomeStandingsPager() {
    if (homeStandingsPagerReady) return;
    if (!el.homeStandingsTrack || !el.homeStandingsDots) return;
    homeStandingsPagerReady = true;
    const dots = [...el.homeStandingsDots.querySelectorAll(".home-standings-dot")];
    dots.forEach((dot, i) => {
      dot.addEventListener("click", () => {
        setHomeStandingsPage(i);
      });
    });
    let scrollSettleTimer = null;
    const onScrollSettled = () => {
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = null;
      const idx = homeStandingsActivePageIndex();
      snapHomeStandingsPage(idx);
      syncHomeStandingsPagerDots(idx);
      syncHomeStandingsLayout(idx, homeIsEnterBusy() ? { animate: false } : undefined);
    };
    const onScrollTick = () => {
      syncHomeStandingsPagerDots(homeStandingsActivePageIndex());
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = setTimeout(onScrollSettled, 140);
    };
    el.homeStandingsTrack.addEventListener("scroll", onScrollTick, { passive: true });
    el.homeStandingsTrack.addEventListener("scrollend", onScrollSettled, { passive: true });
    bindHomeStandingsNestedSwipe();
    let lastCompactCaptains = homeLeagueCompactCaptains();
    window.addEventListener("resize", () => {
      if (state.page !== "home") return;
      const idx = homeStandingsActivePageIndex();
      snapHomeStandingsPage(idx);
      syncHomeStandingsLayout(idx, { animate: false });
      const compact = homeLeagueCompactCaptains();
      if (compact !== lastCompactCaptains) {
        lastCompactCaptains = compact;
        renderHomeStandingsCaptainsBody();
        syncHomeStandingsRowHeights();
      }
    });
    requestAnimationFrame(() => syncHomeStandingsLayout(0, { animate: false, allowShrink: true }));
  }

  /**
   * Transfers nests a vertical scroller inside the horizontal league pager.
   * Live drag-scrubbing scrollLeft fights iOS scroll-snap and "glitches" without
   * changing page. Mobile-friendly approach: axis-lock, then discrete page fling
   * (next/prev) on release — vertical stays native list scroll.
   */
  function bindHomeStandingsNestedSwipe() {
    const track = el.homeStandingsTrack;
    const nested = el.homeTransfersTableWrap;
    if (!track || track.dataset.nestedSwipeBound === "1") return;
    track.dataset.nestedSwipeBound = "1";

    const SLOP_PX = 14;
    const FLING_PX = 52;
    const X_DOMINANCE = 1.2;
    let gesture = null; // { x, y, axis, startIdx, armed }

    const pageCount = () => track.querySelectorAll(".home-standings-page").length;

    const blockTrailingClick = () => {
      const blockClick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        track.removeEventListener("click", blockClick, true);
      };
      track.addEventListener("click", blockClick, true);
      window.setTimeout(() => track.removeEventListener("click", blockClick, true), 0);
    };

    const begin = (x, y) => {
      gesture = {
        x,
        y,
        axis: null,
        startIdx: homeStandingsActivePageIndex(),
        armed: false,
      };
    };

    const move = (x, y, ev) => {
      if (!gesture) return;
      const dx = x - gesture.x;
      const dy = y - gesture.y;
      if (gesture.axis == null) {
        if (Math.hypot(dx, dy) < SLOP_PX) return;
        // Require clear horizontal intent so vertical list scroll stays easy.
        gesture.axis = Math.abs(dx) > Math.abs(dy) * X_DOMINANCE ? "x" : "y";
        if (gesture.axis === "y") {
          gesture = null;
          return;
        }
        gesture.armed = true;
      }
      if (gesture.axis === "x" && ev && ev.cancelable) {
        ev.preventDefault();
      }
    };

    const end = (x) => {
      if (!gesture) return;
      const dx = x - gesture.x;
      const startIdx = gesture.startIdx;
      const armed = gesture.armed && gesture.axis === "x";
      gesture = null;
      if (!armed) return;
      let next = startIdx;
      if (dx <= -FLING_PX) next = Math.min(pageCount() - 1, startIdx + 1);
      else if (dx >= FLING_PX) next = Math.max(0, startIdx - 1);
      if (next === startIdx) return;
      blockTrailingClick();
      setHomeStandingsPage(next, { smooth: true });
    };

    const cancel = () => {
      gesture = null;
    };

    // Touch (iOS Safari / Android) — more reliable than pointer capture here.
    track.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        if (e.target.closest("button, a, input, textarea, label")) return;
        begin(e.touches[0].clientX, e.touches[0].clientY);
      },
      { passive: true }
    );
    track.addEventListener(
      "touchmove",
      (e) => {
        if (!gesture || e.touches.length !== 1) return;
        move(e.touches[0].clientX, e.touches[0].clientY, e);
      },
      { passive: false }
    );
    track.addEventListener(
      "touchend",
      (e) => {
        const t = e.changedTouches && e.changedTouches[0];
        end(t ? t.clientX : (gesture ? gesture.x : 0));
      },
      { passive: true }
    );
    track.addEventListener("touchcancel", cancel, { passive: true });

    // Mouse / test-browser drag: same discrete fling (no live scrub).
    track.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      if (e.target.closest("button, a, input, textarea, label")) return;
      begin(e.clientX, e.clientY);
      gesture.pointerId = e.pointerId;
    });
    track.addEventListener(
      "pointermove",
      (e) => {
        if (!gesture || gesture.pointerId !== e.pointerId) return;
        move(e.clientX, e.clientY, e);
      },
      { passive: false }
    );
    track.addEventListener("pointerup", (e) => {
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      end(e.clientX);
    });
    track.addEventListener("pointercancel", (e) => {
      if (!gesture || gesture.pointerId !== e.pointerId) return;
      cancel();
    });

    // Trackpad horizontal over the nested list → page fling.
    if (nested) {
      let wheelAcc = 0;
      let wheelTimer = 0;
      nested.addEventListener(
        "wheel",
        (e) => {
          const absX = Math.abs(e.deltaX);
          const absY = Math.abs(e.deltaY);
          if (absX <= absY || absX < 1) return;
          e.preventDefault();
          wheelAcc += e.deltaX;
          clearTimeout(wheelTimer);
          wheelTimer = window.setTimeout(() => {
            const acc = wheelAcc;
            wheelAcc = 0;
            const idx = homeStandingsActivePageIndex();
            if (acc > FLING_PX) setHomeStandingsPage(Math.min(pageCount() - 1, idx + 1));
            else if (acc < -FLING_PX) setHomeStandingsPage(Math.max(0, idx - 1));
          }, 80);
        },
        { passive: false }
      );
    }
  }

  function homeFeedPageWidth() {
    return el.homeFeedTrack ? el.homeFeedTrack.clientWidth || 1 : 1;
  }

  function homeFeedPageScrollLeft(index) {
    return Math.max(0, index) * homeFeedPageWidth();
  }

  function homeFeedActivePageIndex() {
    if (!el.homeFeedTrack) return 0;
    const pages = [...el.homeFeedTrack.querySelectorAll(".home-feed-page")];
    if (!pages.length) return 0;
    const w = homeFeedPageWidth();
    return Math.max(0, Math.min(pages.length - 1, Math.round(el.homeFeedTrack.scrollLeft / w)));
  }

  function snapHomeFeedPage(index) {
    if (!el.homeFeedTrack) return;
    const pages = [...el.homeFeedTrack.querySelectorAll(".home-feed-page")];
    if (!pages[index]) return;
    const target = homeFeedPageScrollLeft(index);
    if (Math.abs(el.homeFeedTrack.scrollLeft - target) > 1) {
      el.homeFeedTrack.scrollTo({ left: target, behavior: "auto" });
    }
  }

  function homeFeedPageEventCount(pageIndex) {
    const body = pageIndex === 0 ? el.homeFeedBody : el.homeFeedAllBody;
    if (!body) return 0;
    return body.querySelectorAll("tr.home-feed-row").length;
  }

  function syncHomeFeedCountLabel(activeIndex) {
    if (!el.homeFeedCountLabel || !HOME || HOME.gw == null) return;
    const idx =
      activeIndex != null && Number.isFinite(activeIndex) ? activeIndex : homeFeedActivePageIndex();
    const n = homeFeedPageEventCount(idx);
    el.homeFeedCountLabel.textContent = `${n} · GW${HOME.gw}`;
  }

  function syncHomeFeedPagerDots(activeIndex) {
    if (!el.homeFeedDots) return;
    el.homeFeedDots.querySelectorAll(".home-feed-dot").forEach((dot, i) => {
      const on = i === activeIndex;
      dot.classList.toggle("is-active", on);
      dot.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (el.homeFeedViewLabel) {
      el.homeFeedViewLabel.textContent =
        HOME_FEED_VIEW_LABELS[activeIndex] || HOME_FEED_VIEW_LABELS[0];
    }
    syncHomeFeedCountLabel(activeIndex);
  }

  function setHomeFeedPage(index, { smooth = true } = {}) {
    if (!el.homeFeedTrack) return;
    const pages = [...el.homeFeedTrack.querySelectorAll(".home-feed-page")];
    if (!pages[index]) return;
    if (index === 1 && HOME && HOME.gw != null) ensureHomeFeedAllRendered(Number(HOME.gw));
    el.homeFeedTrack.scrollTo({
      left: homeFeedPageScrollLeft(index),
      behavior: smooth ? "smooth" : "auto",
    });
    syncHomeFeedPagerDots(index);
  }

  function bindHomeFeedPager() {
    if (homeFeedPagerReady) return;
    if (!el.homeFeedTrack || !el.homeFeedDots) return;
    homeFeedPagerReady = true;
    const dots = [...el.homeFeedDots.querySelectorAll(".home-feed-dot")];
    dots.forEach((dot, i) => {
      dot.addEventListener("click", () => {
        setHomeFeedPage(i);
      });
    });
    let scrollSettleTimer = null;
    const onScrollSettled = () => {
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = null;
      const idx = homeFeedActivePageIndex();
      if (idx === 1 && HOME && HOME.gw != null) ensureHomeFeedAllRendered(Number(HOME.gw));
      snapHomeFeedPage(idx);
      syncHomeFeedPagerDots(idx);
    };
    const onScrollTick = () => {
      syncHomeFeedPagerDots(homeFeedActivePageIndex());
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = setTimeout(onScrollSettled, 140);
    };
    el.homeFeedTrack.addEventListener("scroll", onScrollTick, { passive: true });
    el.homeFeedTrack.addEventListener("scrollend", onScrollSettled, { passive: true });
    window.addEventListener("resize", () => {
      if (state.page !== "home") return;
      const idx = homeFeedActivePageIndex();
      snapHomeFeedPage(idx);
      syncHomeFeedPagerDots(idx);
    });
    requestAnimationFrame(() => syncHomeFeedPagerDots(0));
  }

  const HOME_SQUAD_FIXTURE_GWS_DESKTOP = 5;
  const HOME_SQUAD_FIXTURE_GWS_WIDE = 8;
  const HOME_SQUAD_FIXTURE_GWS_MOBILE = 4;

  function homeSquadFixtureGwCount() {
    if (NARROW_MQ.matches) return HOME_SQUAD_FIXTURE_GWS_MOBILE;
    if (homeSquadIsWideLayout()) return HOME_SQUAD_FIXTURE_GWS_WIDE;
    return HOME_SQUAD_FIXTURE_GWS_DESKTOP;
  }

  function homeSquadFixtureGwList() {
    // Include the Home scoring GW (current) so fixture FDR matches the squad label.
    // Fall back to planning horizon when Home is not linked yet.
    const homeGw = Number(HOME && HOME.gw);
    const start =
      Number.isFinite(homeGw) && homeGw > 0 ? homeGw : planningGameweek();
    const limit = homeSquadFixtureGwCount();
    const gws = [];
    for (let gw = start; gw <= SCHEDULE_GW_MAX && gws.length < limit; gw += 1) {
      gws.push(gw);
    }
    return gws;
  }

  function syncHomeSquadPagerDots(activeIndex) {
    if (!el.homeSquadDots) return;
    const wide = homeSquadIsWideLayout();
    const logical = homeSquadLogicalPageIndex(activeIndex);
    const labels = wide ? HOME_SQUAD_VIEW_LABELS_WIDE : HOME_SQUAD_VIEW_LABELS;
    el.homeSquadDots.querySelectorAll(".home-squad-dot").forEach((dot) => {
      const page = Number(dot.dataset.page);
      if (!Number.isFinite(page)) return;
      const dotLogical = wide ? (page === 1 ? -1 : page <= 0 ? 0 : page - 1) : page;
      const on = dotLogical === logical;
      dot.classList.toggle("is-active", on);
      dot.setAttribute("aria-selected", on ? "true" : "false");
    });
    if (el.homeSquadViewLabel) {
      el.homeSquadViewLabel.textContent = labels[logical] || labels[0];
    }
  }

  function homeSquadLogicalPageIndex(physicalIndex) {
    if (!homeSquadIsWideLayout()) return physicalIndex;
    if (physicalIndex <= 0) return 0;
    if (physicalIndex === 1) return -1;
    return physicalIndex - 1;
  }

  function homeSquadPageScrollLeft(physicalIndex) {
    if (!el.homeSquadTrack) return 0;
    const pages = [...el.homeSquadTrack.querySelectorAll(".home-squad-page")];
    let idx = physicalIndex;
    if (homeSquadIsWideLayout() && idx === 1) idx = 0;
    const page = pages[idx];
    return page ? page.offsetLeft : 0;
  }

  function snapHomeSquadPage(physicalIndex) {
    if (!el.homeSquadTrack) return;
    const target = homeSquadPageScrollLeft(physicalIndex);
    if (Math.abs(el.homeSquadTrack.scrollLeft - target) > 1) {
      el.homeSquadTrack.scrollLeft = target;
    }
  }

  function homeSquadActivePageIndex() {
    if (!el.homeSquadTrack) return 0;
    const allPages = [...el.homeSquadTrack.querySelectorAll(".home-squad-page")];
    const candidates = homeSquadIsWideLayout()
      ? allPages.filter((_, i) => i !== 1)
      : allPages;
    if (!candidates.length) return 0;
    const scrollLeft = el.homeSquadTrack.scrollLeft;
    let best = candidates[0];
    let bestDist = Math.abs(best.offsetLeft - scrollLeft);
    for (let i = 1; i < candidates.length; i++) {
      const page = candidates[i];
      const dist = Math.abs(page.offsetLeft - scrollLeft);
      if (dist < bestDist) {
        bestDist = dist;
        best = page;
      }
    }
    return Math.max(0, allPages.indexOf(best));
  }

  function homeSquadIsDesktopLayout() {
    return typeof window.matchMedia === "function"
      && window.matchMedia("(min-width: 901px)").matches;
  }

  /** Desktop Home: instant scroll during enter (summary rolls still odometer). */
  function homeSnapsScrollOnDesktop() {
    return homeSquadIsDesktopLayout();
  }

  function homeSquadIsWideLayout() {
    return HOME_SQUAD_WIDE_MQ.matches;
  }

  let homeSquadWideLayoutActive = null;

  function syncHomeSquadWideLayout() {
    const wide = homeSquadIsWideLayout();
    document.documentElement.classList.toggle("home-squad-wide", wide);
    syncHomeSquadPtsMount();
    return wide;
  }

  function syncHomeSquadPtsMount() {
    if (!el.homeSquadSplit || !el.homeSquadPtsMount || !el.homeSquadPagePts) return;
    const target = homeSquadIsWideLayout() ? el.homeSquadSplit : el.homeSquadPagePts;
    if (el.homeSquadPtsMount.parentElement !== target) {
      target.appendChild(el.homeSquadPtsMount);
    }
  }

  function syncHomeSquadTrackHeight(activeIndex, { animate = true, allowShrink = true } = {}) {
    if (!el.homeSquadTrack) return;
    // Desktop: CSS flex-stretches the track; don't pin content height.
    if (homeSquadIsDesktopLayout()) {
      el.homeSquadTrack.style.height = "";
      return;
    }
    const pages = [...el.homeSquadTrack.querySelectorAll(".home-squad-page")];
    if (!pages.length) {
      el.homeSquadTrack.style.height = "";
      return;
    }
    const idx =
      activeIndex != null && Number.isFinite(activeIndex)
        ? Math.max(0, Math.min(pages.length - 1, activeIndex))
        : homeSquadActivePageIndex();
    const page = pages[idx];
    if (!page) return;
    let h = Math.ceil(Math.max(page.scrollHeight, page.offsetHeight));
    if (!(h > 0)) return;
    const prev = parseFloat(el.homeSquadTrack.style.height) || 0;
    if (!allowShrink && prev > 0) h = Math.max(h, prev);
    const next = `${h}px`;
    if (el.homeSquadTrack.style.height === next) return;
    if (!animate) {
      el.homeSquadTrack.style.transition = "none";
      el.homeSquadTrack.style.height = next;
      void el.homeSquadTrack.offsetHeight;
      el.homeSquadTrack.style.removeProperty("transition");
      return;
    }
    el.homeSquadTrack.style.height = next;
  }

  function syncHomeSquadRowHeights() {
    const wide = homeSquadIsWideLayout();
    const liveTable = el.homeSquadBody && el.homeSquadBody.closest("table");
    const ptsTable = el.homeSquadPtsBody && el.homeSquadPtsBody.closest("table");
    const fixturesTable = el.homeSquadFixturesBody && el.homeSquadFixturesBody.closest("table");
    const ownershipTable = el.homeSquadOwnershipBody && el.homeSquadOwnershipBody.closest("table");
    const tables = wide
      ? [liveTable, ptsTable].filter(Boolean)
      : [liveTable, ptsTable, fixturesTable, ownershipTable].filter(Boolean);
    if (!tables.length) return;

    tables.forEach((table) => {
      table.querySelectorAll("thead tr, tbody tr.home-squad-row, tbody tr.home-bench-divider").forEach((tr) => {
        tr.style.height = "";
      });
    });

    // Single-table desktop uses CSS equal-share rows; wide split uses uniform JS rows.
    if (homeSquadIsDesktopLayout() && !wide) return;
    if (wide && tables.length >= 2) {
      syncHomeSquadWideRowHeights(tables);
      return;
    }
    if (tables.length < 2) return;

    const heads = tables.map((t) => t.querySelector("thead tr")).filter(Boolean);
    if (heads.length > 1) {
      const maxHead = Math.max(...heads.map((tr) => tr.getBoundingClientRect().height));
      if (maxHead > 0) {
        const px = `${Math.ceil(maxHead)}px`;
        heads.forEach((tr) => {
          tr.style.height = px;
        });
      }
    }

    const byElement = new Map();
    tables.forEach((table) => {
      table.querySelectorAll("tbody tr.home-squad-row").forEach((tr) => {
        const key = String(tr.dataset.element || "");
        if (!key) return;
        if (!byElement.has(key)) byElement.set(key, []);
        byElement.get(key).push(tr);
      });
    });
    byElement.forEach((trs) => {
      if (trs.length < 2) return;
      const maxH = Math.max(...trs.map((tr) => tr.getBoundingClientRect().height));
      if (!(maxH > 0)) return;
      const px = `${Math.ceil(maxH)}px`;
      trs.forEach((tr) => {
        tr.style.height = px;
      });
    });

    const dividers = tables.map((t) => [...t.querySelectorAll("tbody tr.home-bench-divider")]);
    const maxDiv = Math.max(0, ...dividers.map((list) => list.length));
    for (let i = 0; i < maxDiv; i += 1) {
      const pair = dividers.map((list) => list[i]).filter(Boolean);
      if (pair.length < 2) continue;
      const maxH = Math.max(...pair.map((tr) => tr.getBoundingClientRect().height));
      if (!(maxH > 0)) continue;
      const px = `${Math.ceil(maxH)}px`;
      pair.forEach((tr) => {
        tr.style.height = px;
      });
    }
  }

  function syncHomeSquadWideRowHeights(tables) {
    const liveTable = tables[0];
    const ptsTable = tables[1];
    if (!liveTable || !ptsTable) return;

    const heads = [liveTable, ptsTable].map((t) => t.querySelector("thead tr")).filter(Boolean);
    if (heads.length) {
      const maxHead = Math.max(...heads.map((tr) => tr.getBoundingClientRect().height));
      if (maxHead > 0) {
        const px = `${Math.ceil(maxHead)}px`;
        heads.forEach((tr) => {
          tr.style.height = px;
        });
      }
    }

    const liveRows = [...liveTable.querySelectorAll("tbody tr.home-squad-row, tbody tr.home-bench-divider")];
    const ptsRows = [...ptsTable.querySelectorAll("tbody tr.home-squad-row, tbody tr.home-bench-divider")];
    const groups = liveRows.map((live, i) => ({
      live,
      pts: ptsRows[i] || null,
      isDivider: live.classList.contains("home-bench-divider"),
    }));
    if (!groups.length) return;

    let dividerH = 28;
    const playerGroups = [];
    groups.forEach((g) => {
      if (g.isDivider) {
        const h = Math.max(
          g.live.getBoundingClientRect().height,
          g.pts ? g.pts.getBoundingClientRect().height : 0,
          28
        );
        dividerH = Math.max(dividerH, h);
      } else {
        playerGroups.push(g);
      }
    });

    const dividerPx = `${Math.ceil(dividerH)}px`;
    groups.filter((g) => g.isDivider).forEach((g) => {
      g.live.style.height = dividerPx;
      if (g.pts) g.pts.style.height = dividerPx;
    });

    if (!playerGroups.length) return;

    let uniformH = 0;
    playerGroups.forEach(({ live, pts }) => {
      const h = Math.max(
        live.getBoundingClientRect().height,
        pts ? pts.getBoundingClientRect().height : 0
      );
      if (h > uniformH) uniformH = h;
    });
    if (!(uniformH > 0)) return;

    const rowPx = `${Math.ceil(uniformH)}px`;
    playerGroups.forEach(({ live, pts }) => {
      live.style.height = rowPx;
      if (pts) pts.style.height = rowPx;
    });
  }

  function syncHomeSquadLayout(activeIndex, opts = {}) {
    const { animate = true, allowShrink = true } = opts;
    const wide = homeSquadIsWideLayout();
    syncHomeSquadRowHeights();
    if (wide) {
      if (el.homeSquadTrack) void el.homeSquadTrack.offsetHeight;
      syncHomeSquadRowHeights();
    }
    syncHomeSquadTrackHeight(activeIndex, { animate, allowShrink });
    if (wide && !animate) {
      syncHomeTablesGridHeight();
      syncHomeSquadRowHeights();
    } else {
      requestAnimationFrame(() => {
        syncHomeTablesGridHeight();
        if (wide) syncHomeSquadRowHeights();
      });
    }
  }

  function setHomeSquadPage(physicalIndex, { smooth = true } = {}) {
    if (!el.homeSquadTrack) return;
    const pages = [...el.homeSquadTrack.querySelectorAll(".home-squad-page")];
    let idx = physicalIndex;
    if (homeSquadIsWideLayout() && idx === 1) idx = 0;
    if (!pages[idx]) return;
    homeSquadPagerTarget = idx;
    el.homeSquadTrack.scrollTo({
      left: homeSquadPageScrollLeft(idx),
      behavior: smooth ? "smooth" : "auto",
    });
    syncHomeSquadPagerDots(idx);
    syncHomeSquadLayout(idx);
    if (!smooth) homeSquadPagerTarget = null;
  }

  function bindHomeSquadPager() {
    if (homeSquadPagerReady) return;
    if (!el.homeSquadTrack || !el.homeSquadDots) return;
    homeSquadPagerReady = true;
    const dots = [...el.homeSquadDots.querySelectorAll(".home-squad-dot")];
    dots.forEach((dot) => {
      dot.addEventListener("click", () => {
        const page = Number(dot.dataset.page);
        if (!Number.isFinite(page)) return;
        setHomeSquadPage(page);
      });
    });
    let scrollSettleTimer = null;
    const onScrollSettled = () => {
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = null;
      homeSquadPagerTarget = null;
      const idx = homeSquadActivePageIndex();
      snapHomeSquadPage(idx);
      syncHomeSquadPagerDots(idx);
      syncHomeSquadTrackHeight(idx, homeIsEnterBusy() ? { animate: false } : undefined);
    };
    const onScrollTick = () => {
      const idx =
        homeSquadPagerTarget != null ? homeSquadPagerTarget : homeSquadActivePageIndex();
      syncHomeSquadPagerDots(idx);
      clearTimeout(scrollSettleTimer);
      scrollSettleTimer = setTimeout(onScrollSettled, 140);
    };
    el.homeSquadTrack.addEventListener("scroll", onScrollTick, { passive: true });
    el.homeSquadTrack.addEventListener("scrollend", onScrollSettled, { passive: true });
    window.addEventListener("resize", () => {
      if (state.page !== "home") return;
      const wide = syncHomeSquadWideLayout();
      if (homeSquadWideLayoutActive != null && wide !== homeSquadWideLayoutActive) {
        homeSquadWideLayoutActive = wide;
        const idx = homeSquadActivePageIndex();
        renderHome({ deferDuringEnter: true });
        if (wide && idx === 1) setHomeSquadPage(0, { smooth: false });
        else if (state.page === "home") settleHomeTablesLayout();
        else syncHomeSquadLayout(idx, { animate: false });
        return;
      }
      homeSquadWideLayoutActive = wide;
      const nextCount = homeSquadFixtureGwList().length;
      const fixturesTable = el.homeSquadFixturesBody && el.homeSquadFixturesBody.closest("table");
      const prevCount = fixturesTable
        ? Number(fixturesTable.getAttribute("data-fx-cols"))
        : nextCount;
      if (Number.isFinite(prevCount) && prevCount !== nextCount) {
        renderHome({ deferDuringEnter: true });
        return;
      }
      if (state.page === "home") settleHomeTablesLayout();
      else syncHomeSquadLayout();
    });
    homeSquadWideLayoutActive = syncHomeSquadWideLayout();
    requestAnimationFrame(() => {
      if (state.page === "home") settleHomeTablesLayout();
      else syncHomeSquadLayout(0);
    });
  }

  function animateHomeScrollTo(node, { top = 0, left = 0, duration = HOME_SCROLL_TOP_MS } = {}) {
    const isWin = node === window;
    const startTop = isWin ? window.scrollY : node.scrollTop;
    const startLeft = isWin ? window.scrollX : node.scrollLeft;
    const token = ++homeScrollAnimToken;
    if (prefersReducedMotion() || duration <= 0 || (state.page === "home" && homeSnapsScrollOnDesktop())) {
      if (isWin) window.scrollTo(left, top);
      else {
        node.scrollTop = top;
        node.scrollLeft = left;
      }
      return;
    }
    const start = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const frame = (now) => {
      if (token !== homeScrollAnimToken) return;
      const t = Math.min(1, (now - start) / duration);
      const e = ease(t);
      const y = startTop + (top - startTop) * e;
      const x = startLeft + (left - startLeft) * e;
      if (isWin) window.scrollTo(x, y);
      else {
        node.scrollTop = y;
        node.scrollLeft = x;
      }
      if (t < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  function homeScrollPageToTop() {
    if (!NARROW_MQ.matches) return;
    const main = document.querySelector("main.main");
    requestAnimationFrame(() => {
      if (main) {
        animateHomeScrollTo(main, { top: 0, left: 0, duration: HOME_SCROLL_TOP_MS });
        return;
      }
      animateHomeScrollTo(window, { top: 0, left: 0, duration: HOME_SCROLL_TOP_MS });
    });
  }

  function homeCrossHoverEnabled() {
    return (
      state.page === "home"
      && homeSquadIsWideLayout()
      && homeSquadIsDesktopLayout()
      && typeof window.matchMedia === "function"
      && window.matchMedia("(hover: hover) and (pointer: fine)").matches
    );
  }

  function clearHomeCrossHover() {
    if (homeCrossHoverElement == null) return;
    homeCrossHoverElement = null;
    document.querySelectorAll("#home-page .is-home-cross-hover").forEach((node) => {
      node.classList.remove("is-home-cross-hover");
    });
  }

  function setHomeCrossHover(elementId) {
    if (!homeCrossHoverEnabled()) {
      clearHomeCrossHover();
      return;
    }
    const eid = Number(elementId);
    if (!Number.isFinite(eid)) {
      clearHomeCrossHover();
      return;
    }
    if (homeCrossHoverElement === eid) return;
    clearHomeCrossHover();
    homeCrossHoverElement = eid;

    forEachHomeSquadRow((tr) => {
      if (Number(tr.dataset.element) === eid) tr.classList.add("is-home-cross-hover");
    });

    const owners = homeOwnersForElement(eid);
    forEachHomeStandingsRow((tr) => {
      const entry = Number(tr.dataset.entry);
      if (owners.has(entry)) tr.classList.add("is-home-cross-hover");
    });

    if (el.homeFeedPanel) {
      el.homeFeedPanel.querySelectorAll("tr.home-feed-row").forEach((tr) => {
        if (Number(tr.dataset.element) === eid) tr.classList.add("is-home-cross-hover");
      });
    }
  }

  function bindHomeCrossHover() {
    if (!el.homeSquadTrack || !el.homeTablesGrid) return;

    const hoverRowSelector = "tr.home-squad-row, tr.home-feed-row";

    function bindHomeCrossHoverSource(container) {
      if (!container) return;
      container.addEventListener("mouseover", (e) => {
        if (!homeCrossHoverEnabled()) return;
        const tr = e.target.closest(hoverRowSelector);
        if (!tr || !container.contains(tr)) return;
        setHomeCrossHover(tr.dataset.element);
      });
      container.addEventListener("mouseout", (e) => {
        if (!homeCrossHoverEnabled()) return;
        const tr = e.target.closest(hoverRowSelector);
        if (!tr || !container.contains(tr)) return;
        const related = e.relatedTarget;
        const toRow = related && related.closest && related.closest(hoverRowSelector);
        if (toRow && el.homeTablesGrid.contains(toRow)) {
          setHomeCrossHover(toRow.dataset.element);
          return;
        }
        clearHomeCrossHover();
      });
    }

    bindHomeCrossHoverSource(el.homeSquadTrack);
    bindHomeCrossHoverSource(el.homeFeedTrack);

    el.homeTablesGrid.addEventListener("mouseleave", () => {
      clearHomeCrossHover();
    });
  }

  function bindHomeScrollHoverGuard() {
    if (!el.homePage) return;
    const main = document.querySelector("main.main");
    let clearTimer = 0;
    const arm = () => {
      if (state.page !== "home") return;
      clearHomeCrossHover();
      el.homePage.classList.add("is-scroll-interaction");
      clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => {
        el.homePage.classList.remove("is-scroll-interaction");
      }, 160);
    };
    const scrollNodes = [
      main,
      el.homeSquadTrack,
      el.homeStandingsTrack,
      el.homeFeedTrack,
      ...(el.homeFeedPanel ? [...el.homeFeedPanel.querySelectorAll(".home-feed-scroll")] : []),
    ].filter(Boolean);
    scrollNodes.forEach((node) => {
        node.addEventListener("scroll", arm, { passive: true });
        node.addEventListener("touchmove", arm, { passive: true });
      });
  }

  function bindHomeOwnerHighlighting() {
    if (homeOwnerBindingsReady) return;
    if (!el.homeSquadTrack || !el.homeStandingsTrack) return;
    homeOwnerBindingsReady = true;
    bindHomeStandingsPager();
    bindHomeSquadPager();
    bindHomeFeedPager();
    bindHomeScrollHoverGuard();
    bindHomeCrossHover();

    function bindHomeRowTap(container, rowSelector, onRow) {
      if (!container) return;
      let touchStart = null;
      let touchMoved = false;
      const MOVE_PX = 10;

      container.addEventListener(
        "touchstart",
        (e) => {
          if (e.touches.length !== 1) return;
          touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
          touchMoved = false;
        },
        { passive: true }
      );
      container.addEventListener(
        "touchmove",
        (e) => {
          if (!touchStart || e.touches.length !== 1) return;
          const dx = e.touches[0].clientX - touchStart.x;
          const dy = e.touches[0].clientY - touchStart.y;
          if (Math.hypot(dx, dy) > MOVE_PX) touchMoved = true;
        },
        { passive: true }
      );
      container.addEventListener(
        "touchend",
        () => {
          touchStart = null;
        },
        { passive: true }
      );
      container.addEventListener("click", (e) => {
        const tr = e.target.closest(rowSelector);
        if (!tr || !container.contains(tr)) return;
        if (touchMoved) {
          touchMoved = false;
          return;
        }
        e.preventDefault();
        onRow(tr);
      });
    }

    function toggleSquadOwner(tr) {
      if (!tr || !el.homeSquadTrack.contains(tr)) return;
      const eid = Number(tr.dataset.element);
      if (!Number.isFinite(eid)) return;
      if (homeLookupPlayer && homeLookupElementId(homeLookupPlayer) === eid) {
        clearHomePlayerLookup();
        return;
      }
      const row = homeLookupRowForElement(eid);
      if (!row) return;
      const wasViewingOther = homeIsViewingOtherManager();
      if (wasViewingOther) {
        homeViewEntryId = null;
        homeLookupPlayer = row;
        homeLookupStatMode = 0;
        if (el.homeDesktopSearchInput) {
          el.homeDesktopSearchInput.value = "";
          el.homeDesktopSearchInput.placeholder = row.name || "Search players";
          el.homeDesktopSearchInput.blur();
        }
        hideHomeDesktopSearchResults();
        syncHomeSearchBtn();
        homeRenderQueued = false;
        renderHome({ animateView: true });
      } else {
        setHomePlayerLookup(row);
      }
      homeScrollPageToTop();
    }

    function toggleStandingOwner(tr) {
      if (!tr || !el.homeStandingsTrack.contains(tr)) return;
      const entry = Number(tr.dataset.entry);
      if (!Number.isFinite(entry)) return;
      if (setHomeViewEntry(entry)) homeScrollPageToTop();
    }

    bindHomeRowTap(el.homeSquadTrack, "tr.home-squad-row", toggleSquadOwner);
    bindHomeRowTap(el.homeStandingsTrack, "tr[data-entry]", toggleStandingOwner);

    el.homeSquadTrack.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tr = e.target.closest("tr.home-squad-row");
      if (!tr || !el.homeSquadTrack.contains(tr)) return;
      e.preventDefault();
      toggleSquadOwner(tr);
    });

    el.homeStandingsTrack.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tr = e.target.closest("tr[data-entry]");
      if (!tr || !el.homeStandingsTrack.contains(tr)) return;
      e.preventDefault();
      toggleStandingOwner(tr);
    });
  }

  function homeSquadPlayerCellHTML(row, { configuredPin = false } = {}) {
    const teamBadge = badgeHTML(row.team, "home-crest") ||
      teamCrestFallbackHTML(row.team, "home-crest-fallback");
    const tags = [];
    if (row.isCaptain) tags.push(`<span class="home-role-tag home-role-c">C</span>`);
    if (row.isVice) tags.push(`<span class="home-role-tag home-role-a">A</span>`);
    if (row.autoSubIn) {
      const from = row.autoSubWithName || "starter";
      tags.push(
        `<span class="home-autosub-tag is-in"${tipAttr(`Auto-sub on for ${from}`)} aria-label="Auto-sub on for ${escapeHtml(from)}">${iconHTML("caret-up", "home-autosub-icon")}</span>`
      );
    } else if (row.autoSubOut) {
      const to = row.autoSubWithName || "bench";
      tags.push(
        `<span class="home-autosub-tag is-out"${tipAttr(`Auto-subbed off — ${to} on`)} aria-label="Auto-subbed off for ${escapeHtml(to)}">${iconHTML("caret-down", "home-autosub-icon")}</span>`
      );
    }
    const pin = configuredPin
      ? `<span class="owned-flag home-owned-flag"${tipAttr("In your team")} aria-label="In your team">${ownedPinSVG()}</span>`
      : "";
    return `<td class="home-col-player">
        <div class="home-player-cell">
          ${teamBadge}
          <div class="home-player-text">
            <div class="home-player-name"><span class="home-player-name-text">${escapeHtml(row.name || "—")}</span>${tags.join("")}${pin}</div>
          </div>
        </div>
      </td>`;
  }

  function homeFeedPlayerCellHTML(player, pos) {
    const team = player && player.team;
    const teamBadge = badgeHTML(team, "home-crest") ||
      teamCrestFallbackHTML(team, "home-crest-fallback");
    const name = (player && player.name) || "—";
    return `<td class="home-col-player">
        <div class="home-player-cell">
          ${teamBadge}
          <div class="home-player-text">
            <div class="home-player-name"><span class="home-player-name-text">${escapeHtml(name)}</span></div>
          </div>
        </div>
      </td>`;
  }

  function homeSquadFdrCellPaint(fixtures) {
    const diffs = (fixtures || [])
      .map((fx) => Number(fx.difficulty))
      .filter((d) => Number.isFinite(d) && d >= 1 && d <= 5);
    if (!diffs.length) return { className: "", style: "" };
    // DGW: use the hardest fixture so tough doubles still read clearly.
    const fdr = Math.max(...diffs);
    const ramp = fdrRampInlineStyle(fdr, { quiet: true, schedulePalette: true });
    return { className: ramp.className, style: ramp.styleAttr };
  }

  function homeSquadFixtureCellHTML(team, gw) {
    const list = (FIXTURES_BY_TEAM[team] || []).filter((fx) => Number(fx.gw) === Number(gw));
    if (!list.length) {
      return {
        inner: `<span class="home-fx-blank" title="No fixture">—</span>`,
        className: " is-blank",
        style: "",
      };
    }
    const parts = list.map((fx) => {
      const crest = badgeHTML(fx.opp, "home-crest home-crest-sm") ||
        teamCrestFallbackHTML(fx.opp, "home-crest-fallback home-crest-sm");
      const ha = fx.ha || fx.oppHa || "";
      const homeIcon = ha === "H" ? iconHTML("house-solid", "home-ha-icon") : "";
      const title = `${fx.opp || "?"}${ha === "H" ? " (H)" : ha === "A" ? " (A)" : ""}${
        fx.kickoff ? ` · ${fx.kickoff}` : ""
      }`;
      return `<span class="home-opp-line" title="${escapeHtml(title)}">${crest}${homeIcon}</span>`;
    });
    const fdr = homeSquadFdrCellPaint(list);
    return {
      inner: `<div class="home-fx-stack home-fx-opp">${parts.join("")}</div>`,
      className: fdr.className,
      style: fdr.style,
    };
  }

  function homeSquadRowAriaLabel(name) {
    return `Show details and managers who own ${name || "this player"}`;
  }

  function homeLookupRowForElement(elementId) {
    const eid = Number(elementId);
    if (!Number.isFinite(eid)) return null;
    const fromCatalog = homeSearchCatalog().find((r) => homeLookupElementId(r) === eid);
    if (fromCatalog) return fromCatalog;
    const squad = homeSquadForEntry(homeActiveViewEntryId()) || [];
    return squad.find((r) => Number(r.element) === eid) || null;
  }

  function homeSquadOwnershipScoreForRow(row, byCode) {
    const code = Number(row.code);
    if (!Number.isFinite(code)) return null;
    const history = byCode.get(code);
    const score = history && history.length ? ownershipScoreRow(history) : null;
    if (score) {
      return { live: score.live, d1: score.d1, d3: score.d3 };
    }
    const live = currentOwnership(code);
    if (live == null || !Number.isFinite(Number(live))) return null;
    return { live: Number(live), d1: null, d3: null };
  }

  function homeSquadOwnershipContext(squad) {
    const checkIns = ownershipCheckIns();
    const byCode = checkIns.length >= 2 ? ownershipPlayerHistoryMaps(checkIns) : new Map();
    const pricesByCode = new Map();
    for (const p of PRICES.players || []) {
      if (p && p.code != null) pricesByCode.set(Number(p.code), p);
    }
    const scores = squad.map((row) => homeSquadOwnershipScoreForRow(row, byCode));
    return { byCode, pricesByCode, scores };
  }

  function homeSquadOwnershipRowHTML(row, opts, ctx, score) {
    const { pricesByCode } = ctx;
    const benchCls = row.onBench ? " home-row-bench" : "";
    const priceRow = pricesByCode.get(Number(row.code));
    const priceCell = `<td class="home-col-price">${
      priceRow && pricesIsVeryLikelyMover(priceRow) ? pricesStatusPillHTML(priceRow) : "—"
    }</td>`;
    const live = score ? score.live : null;
    const d1 = score ? score.d1 : null;
    const d3 = score ? score.d3 : null;
    return `<tr class="home-squad-row${benchCls}" data-element="${escapeHtml(String(row.element ?? ""))}" role="button" tabindex="0" aria-label="${escapeHtml(homeSquadRowAriaLabel(row.name))}">
      ${homeSquadPlayerCellHTML(row, opts)}
      <td class="home-col-own-tsb col-num">${ownershipPillHTML(live, { live: true })}</td>
      <td class="home-col-own-d1 col-num">${ownershipDeltaPillHTML(d1, { quiet: true })}</td>
      <td class="home-col-own-d3 col-num">${ownershipDeltaPillHTML(d3)}</td>
      ${priceCell}
    </tr>`;
  }

  function homeSquadFixturesRowHTML(row, gws, opts = {}) {
    const benchCls = row.onBench ? " home-row-bench" : "";
    const cells = gws.map((gw) => {
      const cell = homeSquadFixtureCellHTML(row.team, gw);
      return `<td class="home-col-fx${cell.className}"${cell.style}>${cell.inner}</td>`;
    }).join("");
    return `<tr class="home-squad-row${benchCls}" data-element="${escapeHtml(String(row.element ?? ""))}" role="button" tabindex="0" aria-label="${escapeHtml(homeSquadRowAriaLabel(row.name))}">
      ${homeSquadPlayerCellHTML(row, opts)}
      ${cells}
    </tr>`;
  }

  const HOME_IMP_BAR_MAX = 200;

  function homeImpBarVisual(impRaw) {
    const imp = Number.isFinite(Number(impRaw)) ? Math.round(Number(impRaw)) : 0;
    const abs = Math.abs(imp);
    // Bar fill: 0 at 0, full at ±200 (100% unique XI, 200% captain, 300% TC on the label).
    const barPct = Math.min(100, (abs / HOME_IMP_BAR_MAX) * 100);
    if (abs < 1) {
      return { imp: 0, barPct: 0, sign: "is-flat", fillStyle: "--imp-pct:0%" };
    }
    const sign = imp > 0 ? "is-pos" : "is-neg";
    // Multi-step tone: faint differentials → saturated at captain-level IMP.
    const mag = Math.min(1, abs / HOME_IMP_BAR_MAX);
    const tone = 0.2 + 0.8 * Math.pow(mag, 0.85);
    const dark = themePrefersDark();
    const isPos = imp > 0;
    let fill;
    if (tone < 0.45) {
      const alpha = (dark ? 0.28 + tone * 0.5 : 0.32 + tone * 0.55).toFixed(3);
      fill = isPos ? positiveFill(alpha) : negativeFill(alpha);
    } else if (tone < 0.78) {
      const alpha = (dark ? 0.48 + (tone - 0.45) * 0.7 : 0.55 + (tone - 0.45) * 0.85).toFixed(3);
      fill = isPos ? positiveHighlightFill(alpha) : negativeFill(alpha);
    } else {
      const blackPct = Math.round(6 + ((tone - 0.78) / 0.22) * 14);
      const base = isPos ? "hsl(var(--positive))" : "hsl(var(--negative))";
      fill = `color-mix(in srgb, ${base} ${100 - blackPct}%, black)`;
    }
    return {
      imp,
      barPct,
      sign,
      fillStyle: `--imp-pct:${barPct}%;--imp-fill:${fill}`,
    };
  }

  function homeSquadRowHTML(row, opts = {}) {
    const fx = homeSquadFixtures(row);
    const pts = homeSquadRowGwPoints(row);
    const ptsHTML = homePtsPillHTML(pts, { rollClassName: "home-stat-roll home-pts-roll" });

    const mpHTML = fx.map((f) => {
      const inPlay = homeSquadFixtureIsInPlay(f);
      if (inPlay || f.finished) {
        const mins = f.minutes != null ? f.minutes : row.minutes;
        const dot = inPlay
          ? `<span class="home-status-dot is-live" aria-label="Live"></span>`
          : `<span class="home-status-dot is-done" aria-label="Played"></span>`;
        const minsHTML =
          mins != null && Number.isFinite(Number(mins))
            ? statRollSpan(Number(mins), {
                from: 0,
                decimals: 0,
                suffix: "′",
                className: "home-stat-roll home-mp-roll",
              })
            : `${escapeHtml(String(mins ?? "—"))}′`;
        return `<span class="home-mp-line">${minsHTML}${dot}</span>`;
      }
      return homeKickoffHTML(f.kickoff || row.kickoff);
    }).join("");

    const oppHTML = fx.map((f) => {
      const crest = badgeHTML(f.opp, "home-crest home-crest-sm") ||
        teamCrestFallbackHTML(f.opp, "home-crest-fallback home-crest-sm");
      const homeIcon = f.oppHa === "H" ? iconHTML("house-solid", "home-ha-icon") : "";
      return `<span class="home-opp-line">${crest}${homeIcon}</span>`;
    }).join("");

    const impRaw = row.imp != null ? Number(row.imp) : (row.impMock != null ? Number(row.impMock) : 0);
    const impVis = homeImpBarVisual(impRaw);
    const impLabel = `${Math.abs(impVis.imp)}%`;
    const impPctHTML = statRollSpan(Math.abs(impVis.imp), {
      from: 0,
      decimals: 0,
      suffix: "%",
      className: "home-stat-roll home-imp-roll",
      textFallback: impLabel,
    });
    const benchCls = row.onBench ? " home-row-bench" : "";
    return `<tr class="home-squad-row${benchCls}" data-element="${escapeHtml(String(row.element ?? ""))}" role="button" tabindex="0" aria-label="${escapeHtml(homeSquadRowAriaLabel(row.name))}">
      ${homeSquadPlayerCellHTML(row, opts)}
      <td class="home-col-pts">${ptsHTML}</td>
      <td class="home-col-mp"><div class="home-fx-stack">${mpHTML}</div></td>
      <td class="home-col-opp"><div class="home-fx-stack home-fx-opp">${oppHTML}</div></td>
      <td class="home-col-imp">
        <div class="home-imp ${impVis.sign}">
          <span class="home-imp-track"><span class="home-imp-fill ${impVis.sign}" style="${impVis.fillStyle}"></span></span>
          <span class="home-imp-pct">${impPctHTML}</span>
        </div>
      </td>
    </tr>`;
  }


  function homeNextDeadlineLabel() {
    const liveGw = livePlanningGw();
    const next = GAMEWEEKS && GAMEWEEKS.next;
    const cur = GAMEWEEKS && GAMEWEEKS.current;
    let gw = next && next.deadlineTime ? next : null;
    // Static triad behind live Home: next may still be the Home current GW.
    if (gw && Number.isFinite(liveGw) && Number(gw.id) <= liveGw) {
      gw = null;
    }
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

  const HOME_SQUAD_PTS_PREFERRED = [
    { key: "pts", label: "Pts", title: "Gameweek points" },
    { key: "goals", label: "G", title: "Goals scored" },
    { key: "assists", label: "A", title: "Assists" },
    { key: "cleanSheets", label: "CS", title: "Clean sheets" },
    { key: "defConHit", label: "DC", title: "Defensive contribution threshold hit (+2 pts)" },
    { key: "bonus", label: "B", title: "Bonus points" },
    { key: "saves", label: "Sv", title: "Saves (GK)", flexible: true },
  ];

  const HOME_SQUAD_PTS_FALLBACKS = [
    { key: "yellowCards", label: "YC", title: "Yellow cards" },
    { key: "redCards", label: "RC", title: "Red cards" },
    { key: "penaltiesSaved", label: "PS", title: "Penalties saved" },
    { key: "ownGoals", label: "OG", title: "Own goals", narrow: true },
    { key: "penaltiesMissed", label: "PM", title: "Penalties missed", narrow: true },
  ];

  function homeElementGwRecord(elementId) {
    const map = homeElementGwMap();
    return map[String(elementId)] || map[elementId] || {};
  }

  function homeSquadPtsEntry(row) {
    const eg = homeElementGwRecord(row.element);
    const etype = Number(eg.elementType) || Number(row.elementType) || 0;
    const pos = LIVE_POS_BY_TYPE[etype] || null;
    const rule = pos && DEFCON_RULES[pos];
    const threshold = rule ? rule.threshold : null;
    const actions = pos && pos !== "GK" ? liveDefconActions(eg, pos) : null;
    return {
      row,
      eg,
      pos,
      threshold,
      actions: actions == null ? 0 : actions,
    };
  }

  function homeSquadPtsColHasValue(entries, colKey) {
    for (const entry of entries) {
      const { eg, pos } = entry;
      if (colKey === "defConHit") {
        if (eg.defConHit) return true;
        continue;
      }
      if (colKey === "saves") {
        if (pos === "GK" && Number(eg.saves) > 0) return true;
        continue;
      }
      const n = Number(eg[colKey]);
      if (Number.isFinite(n) && n !== 0) return true;
    }
    return false;
  }

  function homeSquadPtsColumns(entries) {
    const used = new Set(["pts"]);
    const cols = [{ ...HOME_SQUAD_PTS_PREFERRED[0] }];
    for (const col of HOME_SQUAD_PTS_PREFERRED.slice(1)) {
      let pick = col;
      if (col.flexible && !homeSquadPtsColHasValue(entries, col.key)) {
        const fb = HOME_SQUAD_PTS_FALLBACKS.find(
          (c) => !used.has(c.key) && homeSquadPtsColHasValue(entries, c.key)
        );
        if (fb) pick = fb;
      }
      cols.push(pick);
      used.add(pick.key);
    }
    return cols;
  }

  function homePtsPillHTML(value, { rollClassName = "home-stat-roll live-stat-roll" } = {}) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    const roll = statRollSpan(Number(value), {
      from: 0,
      decimals: 0,
      className: rollClassName,
      rollKind: "pts",
    });
    return livePointsPillHTML("pts", roll);
  }

  function homeSquadPtsCellHTML(entry, col) {
    if (col.key === "pts") {
      const raw = homeSquadRowGwPoints(entry.row, entry.eg);
      if (!Number.isFinite(raw)) return "—";
      return homePtsPillHTML(raw);
    }
    return livePointsCellHTML(entry, col);
  }

  function homeSquadPtsRowHTML(entry, cols, opts = {}) {
    const showPlayer = opts.showPlayer !== false;
    const cells = cols
      .map((col) => {
        const inner = homeSquadPtsCellHTML(entry, col);
        const cls = ["home-col-stat", "col-num", col.narrow ? "col-num-narrow" : ""]
          .filter(Boolean)
          .join(" ");
        return `<td class="${cls}">${inner}</td>`;
      })
      .join("");
    const benchCls = entry.row.onBench ? " home-row-bench" : "";
    return `<tr class="home-squad-row${benchCls}" data-element="${escapeHtml(String(entry.row.element ?? ""))}" role="button" tabindex="0" aria-label="${escapeHtml(homeSquadRowAriaLabel(entry.row.name))}">
      ${showPlayer ? homeSquadPlayerCellHTML(entry.row, opts) : ""}
      ${cells}
    </tr>`;
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
      homeSearchGwCompare(a, b)
      || homeSearchAttentionCompare(a, b)
      || String(a.name || "").localeCompare(String(b.name || ""))
    );
  }

  /** League ownership, then TSB — surfaces interesting picks when search opens. */
  function homeSearchAttentionCompare(a, b) {
    const ownA = homeOwnersForElement(homeLookupElementId(a)).size;
    const ownB = homeOwnersForElement(homeLookupElementId(b)).size;
    if (ownB !== ownA) return ownB - ownA;
    const tsbA = Number(currentOwnership(a.code));
    const tsbB = Number(currentOwnership(b.code));
    const na = Number.isFinite(tsbA) ? tsbA : -1;
    const nb = Number.isFinite(tsbB) ? tsbB : -1;
    return nb - na;
  }

  function homeSearchMetricTone(kind, value, total) {
    if (kind === "league") {
      const n = Number(value) || 0;
      if (n <= 0) return "";
      const r = total > 0 ? n / total : 0;
      if (n >= 3 || r >= 0.75) return "is-hot";
      if (n >= 2 || r >= 0.5) return "is-warm";
      return "is-soft";
    }
    if (kind === "tsb") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 5) return "";
      if (n >= 40) return "is-hot";
      if (n >= 15) return "is-warm";
      return "is-soft";
    }
    return "";
  }

  function homeSearchMetricHTML(text, tone) {
    if (!tone) return escapeHtml(text);
    return `<span class="home-search-metric ${tone}">${escapeHtml(text)}</span>`;
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

  function homeLeagueOwnershipLabel(elementId) {
    const owners = homeOwnersForElement(elementId);
    const total = Array.isArray(HOME.standings) ? HOME.standings.length : 0;
    if (!total) return "—";
    return `${owners.size}/${total}`;
  }

  function homeLookupPlayerKey(row) {
    return String(row.code ?? homeLookupElementId(row) ?? "");
  }

  function homeLookupStatSpecList(row) {
    const season = homePlayerStatSpecs(row.position).map((s) => ({
      id: s.key,
      key: s.key,
      label: s.label,
      decimals: s.decimals,
      lowerBetter: LOWER_BETTER.has(s.key),
      rankable: true,
    }));
    // Home search always uses the 2026/27 FPL catalog — omit Hub/OPTA-only stats.
    return [
      { id: "gwPts", label: "GW pts", lowerBetter: false, allowHot: true, rankable: true },
      ...season,
      { id: "league", label: "League", lowerBetter: false, rankable: false },
      { id: "tsb", label: "TSB", lowerBetter: false, rankable: false },
    ];
  }

  function homeLookupStatRawValue(row, spec) {
    const elementId = homeLookupElementId(row);
    switch (spec.id) {
      case "gwPts": {
        const pts = homeElementGwStats(elementId).pts;
        return Number.isFinite(Number(pts)) ? Number(pts) : null;
      }
      case "league":
        return homeOwnersForElement(elementId).size;
      case "tsb": {
        const tsb = currentOwnership(row.code);
        return tsb != null && Number.isFinite(Number(tsb)) ? Number(tsb) : null;
      }
      default: {
        const raw = feedRowStatValue(row, spec.key);
        return raw == null || raw === "" || Number.isNaN(Number(raw)) ? null : Number(raw);
      }
    }
  }

  function homeLookupRankMapsForRow(row, modeKey) {
    const maps = new Map();
    if (modeKey === "values") return maps;
    const pos = String(row.position || "").toUpperCase();
    const population =
      modeKey === "position"
        ? homeSearchCatalog().filter((r) => String(r.position || "").toUpperCase() === pos)
        : homeSearchCatalog();
    for (const spec of homeLookupStatSpecList(row)) {
      if (spec.rankable === false) continue;
      const entries = population
        .map((r) => ({
          key: homeLookupPlayerKey(r),
          val: homeLookupStatRawValue(r, spec),
        }))
        .filter((x) => x.key && x.val != null && Number.isFinite(x.val));
      entries.sort((a, b) => (spec.lowerBetter ? a.val - b.val : b.val - a.val));
      maps.set(spec.id, denseRankMap(entries));
    }
    return maps;
  }

  function homeLookupStatDisplay(row, spec, modeKey, rankMaps) {
    // Rank views only for game stats — League / TSB stay as raw context values.
    if (modeKey !== "values" && spec.rankable !== false) {
      const rank = rankMaps.get(spec.id)?.get(homeLookupPlayerKey(row));
      const n = Number(rank);
      const topRank = Number.isFinite(n) && n > 0 && n <= 10;
      return { value: fmtHomeLookupRank(rank), hot: false, isRank: true, topRank };
    }
    const elementId = homeLookupElementId(row);
    switch (spec.id) {
      case "gwPts": {
        const pts = homeElementGwStats(elementId).pts;
        const n = pts != null ? Number(pts) : 0;
        return { value: String(n), hot: false, isRank: false, topRank: false };
      }
      case "league":
        return {
          value: homeLeagueOwnershipLabel(elementId),
          hot: false,
          isRank: false,
          topRank: false,
        };
      case "tsb": {
        const tsb = currentOwnership(row.code);
        return {
          value: tsb != null ? `${Number(tsb).toFixed(1)}%` : "—",
          hot: false,
          isRank: false,
          topRank: false,
        };
      }
      default: {
        const raw = feedRowStatValue(row, spec.key);
        return {
          value: feedStatDisplay(raw, spec.decimals),
          hot: false,
          isRank: false,
          topRank: false,
        };
      }
    }
  }

  function homeLookupStatCard(value, label, { hot = false, isRank = false, topRank = false } = {}) {
    const rankCls = isRank ? (topRank ? " is-rank-val" : " is-rank-muted") : "";
    const hotCls = hot ? " is-hot" : "";
    return `<div class="home-lookup-stat${hotCls}${rankCls}"><span class="home-lookup-stat-val">${escapeHtml(String(value ?? "—"))}</span><span class="home-lookup-stat-lbl">${escapeHtml(label)}</span></div>`;
  }

  function fmtHomeLookupRank(rank) {
    const n = Number(rank);
    if (!Number.isFinite(n) || n <= 0) return "—";
    const i = Math.round(n);
    return `${i}${ordinalSuffix(i)}`;
  }

  function homePlayerProfileCardsHTML(row, modeKey = "values") {
    if (!row) return "";
    const rankMaps = homeLookupRankMapsForRow(row, modeKey);
    return homeLookupStatSpecList(row)
      .map((spec) => {
        const shown = homeLookupStatDisplay(row, spec, modeKey, rankMaps);
        return homeLookupStatCard(shown.value, spec.label, {
          hot: shown.hot,
          isRank: shown.isRank,
          topRank: shown.topRank,
        });
      })
      .join("");
  }

  function homeLookupStatModeMeta() {
    return HOME_LOOKUP_STAT_MODES[homeLookupStatMode] || HOME_LOOKUP_STAT_MODES[0];
  }

  function refreshHomeLookupCardDisplay() {
    const card = el.homePlayerProfile && el.homePlayerProfile.querySelector(".home-lookup-card");
    if (!card || !homeLookupPlayer) return;
    const mode = homeLookupStatModeMeta();
    card.classList.remove("is-rank-overall", "is-rank-pos");
    if (mode.className) card.classList.add(mode.className);
    card.dataset.rankMode = mode.key;
    const modeEl = card.querySelector(".home-lookup-mode");
    if (modeEl) {
      modeEl.textContent = mode.label;
      modeEl.hidden = !mode.label;
    }
    const statsEl = card.querySelector(".home-lookup-stats");
    if (statsEl) statsEl.innerHTML = homePlayerProfileCardsHTML(homeLookupPlayer, mode.key);
  }

  function cycleHomeLookupStatMode() {
    if (!homeLookupPlayer) return;
    homeLookupStatMode = (homeLookupStatMode + 1) % HOME_LOOKUP_STAT_MODES.length;
    refreshHomeLookupCardDisplay();
  }

  function bindHomeLookupCard() {
    if (homeLookupCardBound || !el.homePlayerProfile) return;
    homeLookupCardBound = true;
    el.homePlayerProfile.addEventListener("click", (e) => {
      if (!e.target.closest(".home-lookup-card")) return;
      cycleHomeLookupStatMode();
    });
    el.homePlayerProfile.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest(".home-lookup-card");
      if (!card || !el.homePlayerProfile.contains(card)) return;
      e.preventDefault();
      cycleHomeLookupStatMode();
    });
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

  function homePlayerProfileHTML(row) {
    if (!row) return "";
    const initials = String(row.name || "?")
      .split(/[\s.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0])
      .join("")
      .toUpperCase() || "?";
    const photo = feedPlayerPhotoUrl(row.code);
    const badge = row.team ? badgeHTML(row.team, "home-lookup-badge") : "";
    const metaBits = [];
    if (row.position) metaBits.push(posBadgeHTML(row.position));
    const price = effectivePrice(row);
    if (price) {
      metaBits.push(
        `<span class="home-lookup-price">£${escapeHtml(Number(price).toFixed(1))}m</span>`
      );
    }
    const photoBlock = photo
      ? `<img class="home-lookup-photo" src="${escapeHtml(photo)}" alt="" width="52" height="52" loading="lazy" data-initials="${escapeHtml(initials)}" />`
      : `<span class="home-lookup-photo home-lookup-photo-fallback is-photo-icon" aria-hidden="true">${iconHTML("user", "player-photo-fallback-icon")}</span>`;
    const teamAccent = TEAM_SCATTER_ACCENT[row.team] || "";
    const accentStyle = teamAccent ? `--home-lookup-accent:${teamAccent};` : "";
    const photoRing = teamRingAttrs(row.team);
    const mode = homeLookupStatModeMeta();
    return `<article class="home-lookup-card is-lookup-tappable${mode.className ? ` ${mode.className}` : ""}" data-rank-mode="${escapeHtml(mode.key)}" role="button" tabindex="0" aria-label="Player stats. Tap to cycle rank views."${accentStyle ? ` style="${accentStyle}"` : ""}>
      <span class="home-lookup-corner" aria-hidden="true">
        <span class="home-lookup-mode"${mode.label ? "" : " hidden"}>${escapeHtml(mode.label)}</span>
        ${iconHTML("mouse-pointer-click", "home-lookup-tap-icon")}
      </span>
      <div class="home-lookup-head">
          <div class="home-lookup-photo-wrap${photoRing.className}"${photoRing.attr}>
          <div class="home-lookup-photo-clip">${photoBlock}</div>
          ${badge}
        </div>
        <div class="home-lookup-id">
          <h3 class="home-lookup-name">${escapeHtml(row.name || "—")}</h3>
          ${metaBits.length ? `<p class="home-lookup-meta">${metaBits.join("")}</p>` : ""}
        </div>
      </div>
      <div class="home-lookup-stats">${homePlayerProfileCardsHTML(row, mode.key)}</div>
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
    const id = homeLookupElementId(row);
    const owners = homeOwnersForElement(id).size;
    const leagueTotal = Array.isArray(HOME.standings) ? HOME.standings.length : 0;
    const leagueOwn = homeLeagueOwnershipLabel(id);
    const tsb = currentOwnership(row.code);
    const leagueTone = leagueOwn !== "—"
      ? homeSearchMetricTone("league", owners, leagueTotal)
      : "";
    const tsbTone = tsb != null ? homeSearchMetricTone("tsb", Number(tsb)) : "";
    const metaBits = [];
    if (row.position) metaBits.push(escapeHtml(row.position));
    if (leagueOwn !== "—") {
      metaBits.push(homeSearchMetricHTML(`${leagueOwn} league`, leagueTone));
    }
    if (tsb != null) {
      metaBits.push(homeSearchMetricHTML(`${Number(tsb).toFixed(1)}% TSB`, tsbTone));
    }
    if (row.price != null) metaBits.push(escapeHtml(`£${Number(row.price).toFixed(1)}m`));
    return `<button type="button" class="home-search-row" data-home-search-id="${escapeHtml(String(id ?? ""))}" data-home-search-code="${escapeHtml(String(row.code ?? ""))}">
      ${badge}
      <span class="home-search-row-text">
        <span class="home-search-row-name">${escapeHtml(row.name || "—")}</span>
        <span class="home-search-row-meta">${metaBits.join(" · ")}</span>
      </span>
    </button>`;
  }

  function homeSearchFilteredRows(query) {
    const q = String(query || "").trim().toLowerCase();
    const catalog = homeSearchCatalog();
    if (!q) return homeSearchSortRows(catalog).slice(0, 40);
    const exactTeam = KNOWN_TEAM_CODES_LOWER.has(q);
    const scored = [];
    for (const row of catalog) {
      const name = String(row.name || "").toLowerCase();
      const team = String(row.team || "").toLowerCase();
      const teamFull = String(teamNameForSeason(row.team) || "").toLowerCase();
      if (exactTeam) {
        if (team !== q) continue;
      } else if (!name.includes(q) && !team.includes(q) && !teamFull.includes(q)) {
        continue;
      }
      const starts = name.startsWith(q) ? 0 : 1;
      scored.push({ row, starts, name });
    }
    scored.sort((a, b) =>
      a.starts - b.starts
      || homeSearchGwCompare(a.row, b.row)
      || homeSearchAttentionCompare(a.row, b.row)
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
      const refreshSheetViewport = () => {
        syncVisualViewportInsets();
        if (results && results.scrollTop > 0) {
          // Keep the list usable as the keyboard animates.
          results.scrollTop = Math.min(results.scrollTop, results.scrollHeight);
        }
      };
      input.addEventListener("input", () => {
        if (!results) return;
        const rows = homeSearchFilteredRows(input.value);
        results.innerHTML = rows.length
          ? rows.map(homeSearchResultRowHTML).join("")
          : `<div class="home-search-empty">No players match “${escapeHtml(input.value)}”.</div>`;
        refreshSheetViewport();
      });
      input.addEventListener("focus", refreshSheetViewport);
      input.addEventListener("blur", () => {
        scheduleMobileViewportReset({ force: true });
      });
      requestAnimationFrame(() => {
        try { input.focus({ preventScroll: true }); } catch { input.focus(); }
        refreshSheetViewport();
        window.setTimeout(refreshSheetViewport, 80);
        window.setTimeout(refreshSheetViewport, 320);
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
    if (NARROW_MQ.matches) {
      clearHomePlayerLookup({ rerender: false });
      if (el.homeBento) el.homeBento.classList.add("is-search-open");
    }
    openMobileSheet({
      title: "",
      html: homeSearchSheetHTML(""),
      key: "home-search",
    });
    bindHomeSearchSheetEvents();
  }

  function syncHomeDesktopSearchUI() {
    const wrap = el.homeDesktopSearch;
    const input = el.homeDesktopSearchInput;
    const clearBtn = el.homeDesktopSearchClear;
    const results = el.homeDesktopSearchResults;
    if (!wrap) return;
    const onHome = state.page === "home";
    const desktop = !NARROW_MQ.matches;
    wrap.hidden = !(onHome && desktop);
    if (!onHome || !desktop) {
      if (results) {
        results.hidden = true;
        results.innerHTML = "";
      }
      wrap.classList.remove("is-open");
      return;
    }
    if (clearBtn) clearBtn.hidden = !homeLookupPlayer && !(input && String(input.value || "").trim());
    if (homeLookupPlayer && input && document.activeElement !== input) {
      // Reflect the active lookup when not typing.
      if (!String(input.value || "").trim()) {
        input.placeholder = homeLookupPlayer.name || "Search players";
      }
    } else if (input && !homeLookupPlayer) {
      input.placeholder = "Search players";
    }
  }

  function renderHomeDesktopSearchResults(query) {
    const results = el.homeDesktopSearchResults;
    const wrap = el.homeDesktopSearch;
    if (!results) return;
    const q = String(query || "").trim();
    if (!q) {
      results.hidden = true;
      results.innerHTML = "";
      if (wrap) wrap.classList.remove("is-open");
      return;
    }
    const rows = homeSearchFilteredRows(q);
    results.innerHTML = rows.length
      ? rows.map(homeSearchResultRowHTML).join("")
      : `<div class="home-search-empty">No players match “${escapeHtml(q)}”.</div>`;
    results.hidden = false;
    if (wrap) wrap.classList.add("is-open");
  }

  function hideHomeDesktopSearchResults() {
    const results = el.homeDesktopSearchResults;
    const wrap = el.homeDesktopSearch;
    if (!results) return;
    results.hidden = true;
    results.innerHTML = "";
    if (wrap) wrap.classList.remove("is-open");
  }

  function syncHomeSearchBtn() {
    if (el.homeSearchBtn) {
      const clearMode = !!homeLookupPlayer;
      const iconUse = el.homeSearchBtn.querySelector("use");
      if (iconUse) iconUse.setAttribute("href", clearMode ? "#i-x" : "#i-search");
      const label = clearMode ? "Clear player search" : "Search players";
      setTip(el.homeSearchBtn, label);
      el.homeSearchBtn.setAttribute("aria-label", label);
      el.homeSearchBtn.classList.toggle("is-clear", clearMode);
      el.homeSearchBtn.setAttribute("aria-pressed", clearMode ? "true" : "false");
      el.homeSearchBtn.classList.toggle("on", clearMode);
      // Mobile nav only — desktop uses the expanded header search.
      el.homeSearchBtn.hidden = state.page !== "home" || !NARROW_MQ.matches;
    }
    syncHomeDesktopSearchUI();
  }

  function clearHomePlayerLookup({ rerender = true } = {}) {
    homeLookupPlayer = null;
    homeLookupStatMode = 0;
    if (homeOwnerPin && homeOwnerPin.type === "element") {
      homeOwnerPin = null;
    }
    if (el.homeDesktopSearchInput) {
      el.homeDesktopSearchInput.value = "";
      el.homeDesktopSearchInput.placeholder = "Search players";
    }
    hideHomeDesktopSearchResults();
    syncHomeSearchBtn();
    if (rerender) syncHomeLookupUI();
  }

  function setHomePlayerLookup(row) {
    if (!row) {
      clearHomePlayerLookup();
      return;
    }
    homeLookupPlayer = row;
    homeLookupStatMode = 0;
    if (el.homeDesktopSearchInput) {
      el.homeDesktopSearchInput.value = "";
      el.homeDesktopSearchInput.placeholder = row.name || "Search players";
      el.homeDesktopSearchInput.blur();
    }
    hideHomeDesktopSearchResults();
    syncHomeSearchBtn();
    syncHomeLookupUI();
  }

  function syncHomeStandingsLookupEmpty(hasOwners) {
    const empty = el.homeStandingsLookupEmpty;
    const pager = el.homeStandingsPanel && el.homeStandingsPanel.querySelector(".home-standings-pager");
    if (!empty) return;
    if (!homeLookupPlayer) {
      empty.hidden = true;
      empty.textContent = "";
      if (pager) pager.hidden = false;
      return;
    }
    if (hasOwners) {
      empty.hidden = true;
      empty.textContent = "";
      if (pager) pager.hidden = false;
      return;
    }
    const leagueLabel = HOME.leagueName || "this league";
    empty.textContent = `No managers in ${leagueLabel} own this player.`;
    empty.hidden = false;
    if (pager) pager.hidden = true;
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
      syncHomeStandingsLookupEmpty(true);
      syncHomeOwnerHighlights();
      return;
    }

    const elementId = homeLookupElementId(homeLookupPlayer);
    const hasOwners = homeLeagueOwnsElement(elementId);
    el.homeBento.classList.toggle("has-lookup-owners", hasOwners);

    if (Number.isFinite(elementId)) {
      homeOwnerPin = { type: "element", id: elementId };
    } else if (homeOwnerPin && homeOwnerPin.type === "element") {
      homeOwnerPin = null;
    }

    if (el.homePlayerProfile) {
      el.homePlayerProfile.hidden = false;
      el.homePlayerProfile.innerHTML = homePlayerProfileHTML(homeLookupPlayer);
      bindHomeLookupCard();
      bindOwnershipPhotoFallback(el.homePlayerProfile);
    }

    // Lookup replaces Team with the club matchup; Standings shows ownership.
    if (el.homeSquadPanel) el.homeSquadPanel.hidden = true;
    if (el.homeStandingsPanel) el.homeStandingsPanel.hidden = false;
    if (el.homePlayerMatchup) {
      el.homePlayerMatchup.hidden = false;
      el.homePlayerMatchup.innerHTML = homePlayerMatchupHTML(homeLookupPlayer.team);
      upgradeNativeTitles(el.homePlayerMatchup);
    }
    syncHomeStandingsLookupEmpty(hasOwners);
    syncHomeOwnerHighlights();
  }

  function homeRankRollSpec(v) {
    const n = Number(v);
    if (n >= 1e6) {
      return { value: n / 1e6, decimals: 1, suffix: "M" };
    }
    if (n >= 1e3) {
      return { value: n / 1e3, decimals: 1, suffix: "K" };
    }
    return { value: n, decimals: 0, suffix: "" };
  }

  function homeRankStatRollHTML(to, from) {
    if (to == null || !Number.isFinite(Number(to)) || Number(to) <= 0) return "—";
    const spec = homeRankRollSpec(Number(to));
    // Always roll from 0 on enter (same unit). Avoid from===to which skips the odometer.
    let fromVal = 0;
    if (from != null && Number.isFinite(Number(from)) && Number(from) > 0) {
      const fromSpec = homeRankRollSpec(Number(from));
      fromVal = fromSpec.suffix === spec.suffix ? fromSpec.value : 0;
    }
    return statRollSpan(spec.value, {
      from: fromVal,
      decimals: spec.decimals,
      suffix: spec.suffix,
      className: "home-stat-roll",
    });
  }

  function homeRankDeltaValueHTML(places, { animateRoll = false } = {}) {
    const abs = Math.abs(Number(places));
    if (!Number.isFinite(abs) || abs <= 0) return "—";
    if (animateRoll) return homeRankStatRollHTML(abs, 0);
    return formatHomeRankDelta(places);
  }

  function renderHomeSummaryStats(summary, { enterPending = false } = {}) {
    void enterPending;
    const gwVal = homeGwAwaitingKickoff()
      ? 0
      : summary.gwPoints != null && Number.isFinite(Number(summary.gwPoints))
        ? Number(summary.gwPoints)
        : null;
    if (el.homeGwPoints) {
      if (gwVal == null) {
        el.homeGwPoints.textContent = "—";
      } else {
        el.homeGwPoints.innerHTML = statRollSpan(gwVal, {
          from: 0,
          decimals: 0,
          className: "home-stat-roll",
        });
      }
    }
    const overallRankEl = el.homeOverallRankNum || el.homeOverallRank;
    if (overallRankEl) {
      if (summary.overallRank == null || !Number.isFinite(Number(summary.overallRank)) || Number(summary.overallRank) <= 0) {
        overallRankEl.textContent = "—";
      } else {
        overallRankEl.innerHTML = homeRankStatRollHTML(Number(summary.overallRank), 0);
      }
    }
    if (el.homeTotalPoints) {
      if (summary.overallPoints == null || !Number.isFinite(Number(summary.overallPoints))) {
        el.homeTotalPoints.textContent = "—";
      } else {
        el.homeTotalPoints.innerHTML = homeRankStatRollHTML(Number(summary.overallPoints), 0);
      }
    }
    const leagueRankEl = el.homeLeagueRankNum || el.homeLeagueRank;
    if (leagueRankEl) {
      if (summary.leagueRank == null || !Number.isFinite(Number(summary.leagueRank)) || Number(summary.leagueRank) <= 0) {
        leagueRankEl.textContent = "—";
      } else {
        leagueRankEl.innerHTML = homeRankStatRollHTML(Number(summary.leagueRank), 0);
      }
    }
  }

  function finishHomeStatRolls(root, { summary = true, tables = true } = {}) {
    if (!root) return;
    if (summary) {
      root.querySelectorAll(".home-summary-cards .home-stat-roll[data-count-to]").forEach(finishStatRollNode);
    }
    if (tables) {
      root.querySelectorAll(
        ".home-stat-roll[data-count-to], .live-stat-roll[data-count-to], .ownership-stat-roll[data-count-to]"
      ).forEach((node) => {
        if (node.closest(".home-summary-cards")) return;
        finishStatRollNode(node);
      });
    }
  }

  function mountHomeSummaryRollsAtStart(root) {
    if (!root || prefersReducedMotion()) return;
    root.querySelectorAll(".home-summary-cards .home-stat-roll[data-count-to]").forEach((node) => {
      const to = Number(node.dataset.countTo);
      if (!Number.isFinite(to)) return;
      const from =
        node.dataset.countFrom != null && Number.isFinite(Number(node.dataset.countFrom))
          ? Number(node.dataset.countFrom)
          : 0;
      renderStatRollNode(node, from, from, {
        decimals: Number(node.dataset.countDecimals) || 0,
        signed: node.dataset.countSigned === "1",
        suffix: node.dataset.countSuffix || "",
      });
    });
  }

  function prepareHomeStatRolls() {
    // Summary cards are rebuilt so rolls always start at 0; squad / league / feed
    // rolls are already mounted as empty .home-stat-roll nodes from renderHome.
    const summary = homeSummaryForView(homeActiveViewEntryId());
    const specs = [
      { el: el.homeGwPoints, value: summary.gwPoints, kind: "int" },
      { el: el.homeOverallRankNum || el.homeOverallRank, value: summary.overallRank, kind: "rank" },
      { el: el.homeTotalPoints, value: summary.overallPoints, kind: "rank" },
      { el: el.homeLeagueRankNum || el.homeLeagueRank, value: summary.leagueRank, kind: "rank" },
    ];
    specs.forEach(({ el: node, value, kind }) => {
      if (!node) return;
      if (kind === "rank") {
        if (value == null || !Number.isFinite(Number(value)) || Number(value) <= 0) {
          node.textContent = "—";
          return;
        }
        node.innerHTML = homeRankStatRollHTML(Number(value), 0);
        return;
      }
      if (value == null || !Number.isFinite(Number(value))) {
        node.textContent = "—";
        return;
      }
      node.innerHTML = statRollSpan(Number(value), {
        from: 0,
        decimals: 0,
        className: "home-stat-roll",
      });
    });
  }

  function animateHomeImpBars(root, { animate = true } = {}) {
    const scope = root || el.homePage;
    if (!scope) return;
    const fills = [...scope.querySelectorAll(".home-imp-fill")];
    if (!fills.length) return;
    const snapDrawn = () => {
      fills.forEach((fill) => {
        fill.style.transition = "none";
        fill.classList.add("is-drawn");
      });
      // Clear inline transition after paint so a later enter can animate once.
      requestAnimationFrame(() => {
        fills.forEach((fill) => {
          if (!fill.isConnected) return;
          fill.style.removeProperty("transition");
        });
      });
    };
    if (!animate || prefersReducedMotion() || (state.page === "home" && homeSquadIsDesktopLayout())) {
      snapDrawn();
      return;
    }
    // Reset width without animating the collapse, then grow once.
    fills.forEach((fill) => {
      fill.style.transition = "none";
      fill.classList.remove("is-drawn");
    });
    void scope.offsetWidth;
    fills.forEach((fill) => fill.style.removeProperty("transition"));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fills.forEach((fill) => fill.classList.add("is-drawn"));
      });
    });
  }

  function homeHeroRollNodes(pane) {
    if (!pane) return [];
    return [...pane.querySelectorAll(".home-summary-cards .home-stat-roll[data-count-to]")];
  }

  function startHomeEnterMotion(pane, { duration = HOME_SUMMARY_ROLL_MS } = {}) {
    const finishAll = () => {
      homeSummaryRankChromePending = false;
      clearHomeRankBorderRevealTimer();
      if (!pane) return;
      finishHighlightSatEnter(pane);
      finishHomeStatRolls(pane);
      animateHomeImpBars(pane, { animate: false });
      const summary = homeSummaryForView(homeActiveViewEntryId());
      applyHomeSummaryRankChrome(summary, { viewingOther: homeIsViewingOtherManager() });
    };
    if (!pane || prefersReducedMotion()) {
      finishAll();
      return;
    }
    const token = ++homeEnterMotionToken;
    // Tables, feed, IMP, and rank chrome snap immediately — only summary cards roll briefly.
    finishHomeStatRolls(pane, { summary: false, tables: true });
    animateHomeImpBars(pane, { animate: false });
    finishHighlightSatEnter(pane);
    homeSummaryRankChromePending = false;
    const summary = homeSummaryForView(homeActiveViewEntryId());
    applyHomeSummaryRankChrome(summary, { viewingOther: homeIsViewingOtherManager() });

    let summaryRolls = homeHeroRollNodes(pane);
    if (!summaryRolls.length) {
      prepareHomeStatRolls();
      mountHomeSummaryRollsAtStart(pane);
      summaryRolls = homeHeroRollNodes(pane);
    }
    const rollMs = Math.max(400, Number(duration) || HOME_SUMMARY_ROLL_MS);
    summaryRolls.forEach((node) => animateStatRollNode(node, { duration: rollMs }));
    window.setTimeout(() => {
      if (token !== homeEnterMotionToken) return;
      summaryRolls.forEach(finishStatRollNode);
    }, rollMs + 48);
  }

  function renderHomeUnlinked() {
    if (el.homeEmpty) el.homeEmpty.hidden = true;
    if (el.homeBento) el.homeBento.hidden = true;
    clearHomeDashboardStats();
    if (el.homePageSubtitle) {
      el.homePageSubtitle.textContent =
        "Link a manager to personalize Home live scoring and standings.";
    }
    setHomeManagerModalOpen(true);
  }

  function renderHome({ deferDuringEnter = false, animateView = false, settleQuiet = false, leaveRollsPending = false } = {}) {
    if (deferDuringEnter && homeIsEnterBusy()) {
      syncHomeSquadWideLayout();
      homeRenderQueued = true;
      return;
    }
    homeRenderQueued = false;
    clearHomeCrossHover();
    if (!el.homePage) return;
    syncHomeSquadWideLayout();
    // settleQuiet: post-enter / live rebuild — never restart enter motion.
    const noManager = !savedManagerId;
    const linked = !!(savedManagerId && savedLeagueId);
    const hasPayload = !!(HOME && HOME.summary && HOME.managerId && HOME.leagueId);
    const prefsMatch =
      hasPayload
      && String(HOME.leagueId) === HOME_LEAGUE_ID
      && TRACKED_MANAGER_IDS.map(String).includes(String(savedManagerId));
    const showEmpty = !linked || !hasPayload;
    if (noManager) {
      renderHomeUnlinked();
      if (el.homeCountLabel) syncHomeCountLabel();
      return;
    }

    setHomeManagerModalOpen(false);
    if (el.homeEmpty) el.homeEmpty.hidden = !showEmpty;
    if (el.homeBento) el.homeBento.hidden = showEmpty;
    if (showEmpty && el.homeBento) el.homeBento.classList.remove("has-live-minutes");
    if (showEmpty) {
      clearHomeDashboardStats();
      if (el.homeEmptyTitle && el.homeEmptyCopy) {
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
          : "Your manager team and mini-league gameweek standings from the last refresh.";
      }
    }
    if (showEmpty) {
      if (el.homeDeadline) el.homeDeadline.hidden = true;
      if (el.homeViewBanner) el.homeViewBanner.hidden = true;
      if (el.homeOwnerBanner) el.homeOwnerBanner.hidden = true;
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
      el.homeGwHeading.textContent = "GW points";
    }
    renderHomeSummaryStats(summary, {
      enterPending: leaveRollsPending || homePageEnterArmed || homeIsEnterBusy(),
    });
    if (leaveRollsPending || homePageEnterArmed || homeIsEnterBusy()) {
      mountHomeSummaryRollsAtStart(el.homePage);
    }
    const deferRankChrome = homeShouldDeferSummaryRankChrome({ animateView, settleQuiet });
    if (deferRankChrome) {
      if (homeSummaryRankChromePending) {
        stageHomeSummaryRankChrome(summary, { viewingOther });
      } else {
        clearHomeSummaryRankChrome();
      }
    } else {
      applyHomeSummaryRankChrome(summary, { viewingOther });
    }
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
    if (el.homeSquadBody || el.homeSquadFixturesBody || el.homeSquadFixturesHead || el.homeSquadPtsBody || el.homeSquadOwnershipBody) {
      const rows = homeSquadForEntry(viewEntry);
      const configuredOwned = viewingOther && homeConfiguredEntryId() != null
        ? homeElementsForEntry(homeConfiguredEntryId())
        : new Set();
      const pinOpts = (r) => ({
        configuredPin: viewingOther && configuredOwned.has(Number(r.element)),
      });
      const ptsEntries = rows.map(homeSquadPtsEntry);
      const ptsCols = homeSquadPtsColumns(ptsEntries);
      const wideSquad = homeSquadIsWideLayout();
      const ptsDisplayCols = wideSquad ? ptsCols.slice(1) : ptsCols;
      const ptsShowPlayer = !wideSquad;
      const ptsColCount = ptsShowPlayer ? 1 + ptsDisplayCols.length : ptsDisplayCols.length;
      const ptsTable = el.homeSquadPtsBody && el.homeSquadPtsBody.closest("table");
      if (ptsTable) ptsTable.classList.toggle("is-wide-split", wideSquad);
      if (el.homeSquadBody) {
        const parts = [];
        let benchLabeled = false;
        for (const r of rows) {
          if (r.onBench && !benchLabeled) {
            parts.push(
              `<tr class="home-bench-divider"><th scope="rowgroup" colspan="5">Bench</th></tr>`
            );
            benchLabeled = true;
          }
          parts.push(homeSquadRowHTML(r, pinOpts(r)));
        }
        el.homeSquadBody.innerHTML = parts.join("") ||
          (homeSquadShowLoading(viewEntry)
            ? homeSquadLoadingHTML(5)
            : homeSquadEmptyHTML(5));
      }
      const gws = homeSquadFixtureGwList();
      if (el.homeSquadFixturesCols) {
        el.homeSquadFixturesCols.innerHTML =
          `<col class="home-col-player" />` +
          gws.map(() => `<col class="home-col-fx" />`).join("");
      }
      if (el.homeSquadFixturesHead) {
        el.homeSquadFixturesHead.innerHTML =
          `<th scope="col" class="home-col-player">Player</th>` +
          gws.map(
            (gw) =>
              `<th scope="col" class="home-col-fx">GW${escapeHtml(String(gw))}</th>`
          ).join("");
      }
      if (el.homeSquadFixturesBody) {
        const parts = [];
        let benchLabeled = false;
        const colspan = Math.max(2, 1 + gws.length);
        for (const r of rows) {
          if (r.onBench && !benchLabeled) {
            parts.push(
              `<tr class="home-bench-divider"><th scope="rowgroup" colspan="${colspan}">Bench</th></tr>`
            );
            benchLabeled = true;
          }
          parts.push(homeSquadFixturesRowHTML(r, gws, pinOpts(r)));
        }
        el.homeSquadFixturesBody.innerHTML = parts.join("") ||
          (homeSquadShowLoading(viewEntry)
            ? homeSquadLoadingHTML(colspan)
            : homeSquadEmptyHTML(colspan));
      }
      const fixturesTable = el.homeSquadFixturesBody && el.homeSquadFixturesBody.closest("table");
      if (fixturesTable) fixturesTable.setAttribute("data-fx-cols", String(gws.length));
      if (el.homeSquadOwnershipCols || el.homeSquadOwnershipHead || el.homeSquadOwnershipBody) {
        const ownCtx = homeSquadOwnershipContext(rows);
        const ownColCount = 5;
        if (el.homeSquadOwnershipCols) {
          el.homeSquadOwnershipCols.innerHTML =
            `<col class="home-col-player" />` +
            `<col class="home-col-own-tsb" />` +
            `<col class="home-col-own-d1" />` +
            `<col class="home-col-own-d3" />` +
            `<col class="home-col-price" />`;
        }
        if (el.homeSquadOwnershipHead) {
          el.homeSquadOwnershipHead.innerHTML =
            `<th scope="col" class="home-col-player">Player</th>` +
            `<th scope="col" class="home-col-own-tsb col-num"${tipAttr("Live ownership (TSB)")}>TSB</th>` +
            `<th scope="col" class="home-col-own-d1 col-num"${tipAttr("1-day ownership change")}>1d</th>` +
            `<th scope="col" class="home-col-own-d3 col-num"${tipAttr("3-day ownership change")}>3d</th>` +
            `<th scope="col" class="home-col-price"${tipAttr("Predicted price rise / fall")}>Price</th>`;
        }
        if (el.homeSquadOwnershipBody) {
          const ownParts = [];
          let ownBenchLabeled = false;
          rows.forEach((r, i) => {
            if (r.onBench && !ownBenchLabeled) {
              ownParts.push(
                `<tr class="home-bench-divider"><th scope="rowgroup" colspan="${ownColCount}">Bench</th></tr>`
              );
              ownBenchLabeled = true;
            }
            ownParts.push(
              homeSquadOwnershipRowHTML(r, pinOpts(r), ownCtx, ownCtx.scores[i])
            );
          });
          el.homeSquadOwnershipBody.innerHTML = ownParts.join("") ||
            (homeSquadShowLoading(viewEntry)
              ? homeSquadLoadingHTML(ownColCount)
              : homeSquadEmptyHTML(ownColCount));
        }
      }
      if (el.homeSquadPtsCols) {
        el.homeSquadPtsCols.innerHTML =
          (ptsShowPlayer ? `<col class="home-col-player" />` : "") +
          ptsDisplayCols.map(() => `<col class="home-col-stat" />`).join("");
      }
      if (el.homeSquadPtsHead) {
        el.homeSquadPtsHead.innerHTML =
          (ptsShowPlayer ? `<th scope="col" class="home-col-player">Player</th>` : "") +
          ptsDisplayCols
            .map(
              (col) =>
                `<th scope="col" class="home-col-stat col-num${col.narrow ? " col-num-narrow" : ""}"${tipAttr(col.title || col.label)}>${escapeHtml(col.label)}</th>`
            )
            .join("");
      }
      if (el.homeSquadPtsBody) {
        const parts = [];
        let benchLabeled = false;
        for (const entry of ptsEntries) {
          if (entry.row.onBench && !benchLabeled) {
            parts.push(
              wideSquad
                ? `<tr class="home-bench-divider home-bench-divider-spacer" aria-hidden="true"><th scope="rowgroup" colspan="${ptsColCount}"></th></tr>`
                : `<tr class="home-bench-divider"><th scope="rowgroup" colspan="${ptsColCount}">Bench</th></tr>`
            );
            benchLabeled = true;
          }
          parts.push(
            homeSquadPtsRowHTML(entry, ptsDisplayCols, {
              ...pinOpts(entry.row),
              showPlayer: ptsShowPlayer,
            })
          );
        }
        el.homeSquadPtsBody.innerHTML = parts.join("") ||
          (homeSquadShowLoading(viewEntry)
            ? homeSquadLoadingHTML(ptsColCount)
            : homeSquadEmptyHTML(ptsColCount));
      }
      syncHomeSquadPtsMount();
    }
    if (el.homeStandingsBody) {
      renderHomeStandingsLiveBody();
    }
    if (el.homeStandingsTransfersBody) {
      const configuredEntry = homeConfiguredEntryId();
      let rows = Array.isArray(HOME.standings) ? HOME.standings : [];
      const opts = { configuredEntry, viewEntry, viewingOther };
      const statusLabel = homeTransfersStatusLabel();
      if (el.homeTransfersStatus) {
        if (statusLabel) {
          el.homeTransfersStatus.hidden = false;
          el.homeTransfersStatus.textContent = statusLabel;
        } else {
          el.homeTransfersStatus.hidden = true;
          el.homeTransfersStatus.textContent = "";
        }
      }
      el.homeStandingsTransfersBody.innerHTML = homeStandingsShowLoading()
        ? homeSquadLoadingHTML(3, 8)
        : rows.map((r) => homeTransfersRowHTML(r, opts)).join("") || `<tr><td colspan="3">No standings.</td></tr>`;
      requestAnimationFrame(() => {
        resetHomeTransfersTableScroll();
      });
    }
    if (el.homeStandingsCaptainsBody) {
      renderHomeStandingsCaptainsBody();
    }
    if (el.homeStandingsChipsBody) {
      const configuredEntry = homeConfiguredEntryId();
      const rows = Array.isArray(HOME.standings) ? HOME.standings : [];
      const opts = { configuredEntry, viewEntry, viewingOther };
      el.homeStandingsChipsBody.innerHTML = homeStandingsShowLoading()
        ? homeSquadLoadingHTML(6, 8)
        : rows.map((r) => homeChipsRowHTML(r, opts)).join("") || `<tr><td colspan="6">No standings.</td></tr>`;
      const chipsTable = el.homeStandingsChipsBody.closest("table");
      if (chipsTable) {
        const halfLabel = (HOME.chipWindow && HOME.chipWindow.label) || "First half";
        chipsTable.setAttribute("data-chip-half", halfLabel);
      }
    }
    if (leaveRollsPending || homePageEnterArmed || homeIsEnterBusy()) {
      finishHomeStatRolls(el.homePage, { summary: false, tables: true });
    }
    bindHomeOwnerHighlighting();
    syncHomeViewBanner();
    syncHomeOwnerBanner();
    syncHomeOwnerHighlights();
    syncHomeLiveChrome();
    syncLiveNavChrome();
    syncHomeLookupUI();
    syncHomeSquadPagerDots(homeSquadActivePageIndex());
    const standingsPageIdx = homeStandingsActivePageIndex();
    syncHomeStandingsPagerDots(standingsPageIdx);
    settleHomeSquadSplitLayout({ deferMeasure: true });
    const feedGw = HOME.gw != null ? Number(HOME.gw) : null;
    if (feedGw != null && homeSquadIsWideLayout()) renderHomeFeed(feedGw);
    requestAnimationFrame(() => {
      if (state.page !== "home") return;
      settleHomeTablesLayout({ standingsPageIdx });
    });
    const enterBusyNow = homeIsEnterBusy();
    const snapRolls = !leaveRollsPending && !animateView && !enterBusyNow;
    if (snapRolls) {
      finishHomeStatRolls(el.homePage, { summary: !homePageEnterArmed });
      animateHomeImpBars(el.homePage, { animate: false });
    }
    requestAnimationFrame(() => {
      if (animateView && !settleQuiet) {
        startHomeEnterMotion(el.homePage, { duration: HOME_VIEW_SWITCH_ROLL_MS });
      }
    });
  }

  async function applyManagerId(rawId, { quiet = false, render = true, seedPlannerIfEmpty = true, animateHomeEnter = false } = {}) {
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
      if (render) scheduleSiteRefreshForHomeTargets({ toast: false, animateHomeEnter });
      return false;
    }
    if (render) scheduleSiteRefreshForHomeTargets({ toast: !quiet, animateHomeEnter });
    return true;
  }

  function clearManagerId({ quiet = false, render = true } = {}) {
    stopHomeLivePolling();
    resetHomeLivePollState();
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
    syncFplIdStatus();
    syncPlannerPageUI();
    if (!quiet) {
      showToast({ title: "FPL link cleared", message: "Manager link removed. Planner draft is unchanged.", icon: "info" });
    }
    if (render) scheduleSiteRefreshForHomeTargets({ toast: !quiet });
  }

  async function restoreManagerId({ deferHome = false } = {}) {
    let saved = "";
    try {
      saved = localStorage.getItem(FPL_ID_KEY) || "";
    } catch {
      saved = "";
    }
    const actual = loadActualSnapshot();
    if (actual) {
      state.actualMeta = actual.meta || null;
      ownedCodes = new Set(actual.squad.map((s) => s.code));
    }
    populateManagerSelect();
    syncFixedHomeLeague({ persist: true, quiet: true });
    loadTeamDraft();
    if (saved && trackedManagerById(saved)) {
      savedManagerId = saved;
      if (el.fplManagerSelect) el.fplManagerSelect.value = saved;
      rebuildLeagueSelect();
      if (!deferHome) prefetchHomeLiveCache();
      try {
        await syncManagerFromApi(saved, { seedPlannerIfEmpty: true, quiet: true });
      } catch {
        syncFplIdStatus();
      }
    } else {
      if (saved && !trackedManagerById(saved)) {
        try {
          localStorage.removeItem(FPL_ID_KEY);
          localStorage.removeItem(FPL_LEAGUE_KEY);
        } catch {
          /* private browsing */
        }
      }
      savedManagerId = null;
      syncFixedHomeLeague({ persist: true, quiet: true });
      rebuildLeagueSelect();
      syncFplIdStatus();
    }
    persistHomePrefs();
    if (deferHome) {
      syncFplIdStatus();
      syncPlannerPageUI();
    } else {
      refreshManagerDependentUI();
    }
  }

  function requestResyncPlanner(fromBtn) {
    if (!savedManagerId) {
      showToast({ title: "No manager linked", message: "Pick a manager in Preferences first.", icon: "triangle-alert" });
      return;
    }
    const btn = fromBtn || el.teamResyncToolbar || el.teamResyncBtn;
    armConfirmButton(btn, {
      onConfirm: async () => {
        setPrefsOpen(false);
        try {
          const payload = await fetchManagerSquad(savedManagerId);
          await ingestManagerSquad(payload, { resetPlanner: true });
          renderTeam();
          showToast({
            title: "Planner resynced",
            message: payload.hasPicks
              ? `Copied ${payload.squad.length} picks · ${payload.freeTransfers ?? "?"} FT`
              : payload.message || "FPL had no published picks — planner cleared.",
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
    if (!row || row.code == null || row.kind === "team") return false;
    if (!ownedCodes.has(row.code)) return false;
    if (state.page === "ownership" || state.page === "prices") return true;
    return state.view === "players";
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
    const ring = teamRingAttrs(teamCode);
    const tipBit = tip || "";
    return tip
      ? `<span class="player-cell-crest${ring.className}"${tipBit}${ring.attr}>${inner}</span>`
      : `<span class="player-cell-crest${ring.className}"${ring.attr}>${inner}</span>`;
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
  // Players rank only the best values (blue). Teams — a much smaller
  // population — rank both the best and worst (blue "target" / orange "avoid"),
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
      return tableOwnershipIdentityHTML(row, {
        kind: "players",
        teamCode,
        position,
        teamTip: teamChanged ? tipAttr(`Was ${TEAM_NAMES[row.team] || row.team}`) : "",
        posTip: posChanged ? tipAttr(`Was ${row.position}`) : "",
      });
    }
    if (col.key === "name") {
      return tableOwnershipIdentityHTML(row, { kind: "teams" });
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
  const HOME_SQUAD_WIDE_MQ = window.matchMedia("(min-width: 1400px)");

  function teamLandscapeViewport() {
    const vv = window.visualViewport;
    const w = vv ? vv.width : window.innerWidth;
    const h = vv ? vv.height : window.innerHeight;
    if (w <= h || h > 580) return false;
    return !hasFineHover() || w <= 1024;
  }

  function syncMobileLayoutClass() {
    document.documentElement.classList.toggle("is-mobile-layout", NARROW_MQ.matches);
    syncMobileTopChromeInset();
  }
  syncMobileLayoutClass();

  // iOS Safari: focusing search scrolls the layout viewport (even with
  // overflow:hidden + preventScroll). After the keyboard dismisses, scrollY /
  // visualViewport.offsetTop can stay non-zero and crop .page-nav under the
  // status bar / Dynamic Island.
  let mobileViewportResetTimer = 0;
  function homeSearchInputFocused() {
    const active = document.activeElement;
    return !!(active && active.id === "home-search-input");
  }
  function syncVisualViewportInsets() {
    const root = document.documentElement;
    const vv = window.visualViewport;
    if (!vv) {
      root.style.removeProperty("--vv-height");
      root.style.removeProperty("--vv-offset-top");
      root.style.removeProperty("--vv-keyboard-inset");
      syncMobileTopChromeInset();
      return;
    }
    const keyboardInset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.style.setProperty("--vv-height", `${Math.round(vv.height)}px`);
    root.style.setProperty("--vv-offset-top", `${Math.round(vv.offsetTop)}px`);
    root.style.setProperty("--vv-keyboard-inset", `${Math.round(keyboardInset)}px`);
    syncMobileTopChromeInset();
  }

  function syncMobileTopChromeInset() {
    const root = document.documentElement;
    if (!NARROW_MQ.matches) {
      root.style.removeProperty("--mobile-page-nav-h");
      root.style.removeProperty("--mobile-top-chrome-h");
      return;
    }
    let total = 0;
    if (el.pageNav) {
      const navH = Math.ceil(el.pageNav.getBoundingClientRect().height);
      root.style.setProperty("--mobile-page-nav-h", `${navH}px`);
      total += navH;
    }
    const sub = el.subtoolbar;
    if (sub) {
      const subStyle = window.getComputedStyle(sub);
      if (subStyle.display !== "none" && subStyle.visibility !== "hidden") {
        total += Math.ceil(sub.getBoundingClientRect().height);
      }
    }
    root.style.setProperty("--mobile-top-chrome-h", `${total}px`);
  }
  function resetMobileViewportOffset() {
    if (!NARROW_MQ.matches) return;
    // Keep the Home search sheet pinned to the visual viewport while typing.
    if (homeSearchInputFocused() || (mobileSheetOpen && mobileSheetKey === "home-search")) {
      syncVisualViewportInsets();
      return;
    }
    const html = document.documentElement;
    const body = document.body;
    const y =
      window.scrollY ||
      html.scrollTop ||
      body.scrollTop ||
      0;
    const vv = window.visualViewport;
    const vvTop = vv ? vv.offsetTop : 0;
    if (y === 0 && vvTop === 0) {
      syncVisualViewportInsets();
      return;
    }
    window.scrollTo(0, 0);
    html.scrollTop = 0;
    body.scrollTop = 0;
    syncVisualViewportInsets();
  }
  function scheduleMobileViewportReset({ force = false } = {}) {
    if (!NARROW_MQ.matches) return;
    // Don't fight Safari while the keyboard is up for search.
    if (!force && el.search && document.activeElement === el.search) return;
    if (!force && homeSearchInputFocused()) {
      syncVisualViewportInsets();
      return;
    }
    resetMobileViewportOffset();
    requestAnimationFrame(resetMobileViewportOffset);
    if (mobileViewportResetTimer) clearTimeout(mobileViewportResetTimer);
    // Keyboard dismiss animation — retry while Safari settles.
    mobileViewportResetTimer = window.setTimeout(() => {
      mobileViewportResetTimer = 0;
      if (!force && el.search && document.activeElement === el.search) return;
      if (!force && homeSearchInputFocused()) {
        syncVisualViewportInsets();
        return;
      }
      resetMobileViewportOffset();
      window.setTimeout(() => {
        if (!force && el.search && document.activeElement === el.search) return;
        if (!force && homeSearchInputFocused()) {
          syncVisualViewportInsets();
          return;
        }
        resetMobileViewportOffset();
      }, 280);
    }, 60);
  }
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
      mobileDocksActive() &&
      ((!el.mobileFilterDock || !el.mobileFilterDock.hidden) ||
        (!el.mobileViewDock || !el.mobileViewDock.hidden));
    if (fade) {
      fade.hidden = !show;
      fade.setAttribute("aria-hidden", show ? "false" : "true");
    }
    document.documentElement.classList.toggle("has-mobile-bottom-dock", show);
    if (!show) resetMobileChromeScrollHide();
    syncMobileScrollportHeight();
    scheduleOptaMobileNameColWidth();
  }

  function syncMobileScrollportHeight() {
    const root = document.documentElement;
    const ownershipTree =
      NARROW_MQ.matches && state.page === "ownership" && ownershipIsTreemap();
    // Expected + Ownership treemap: nested fill. Stats / Ownership table /
    // Planner: page-level .main scroll (no fill height).
    const expectedFill = state.page === "expected";
    if (!NARROW_MQ.matches || (!expectedFill && !ownershipTree)) {
      root.style.removeProperty("--mobile-scrollport-min-h");
      return;
    }
    const scrollport = ownershipTree
      ? el.ownershipTreemap
      : document.querySelector("#expected-page .barbell-wrap");
    if (!scrollport || scrollport.hidden || scrollport.offsetParent === null) {
      root.style.removeProperty("--mobile-scrollport-min-h");
      return;
    }
    const vv = window.visualViewport;
    const viewportBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    const top = scrollport.getBoundingClientRect().top;
    let reserve = 0;
    if (
      ownershipTree &&
      el.ownershipUpdatedFooter &&
      !el.ownershipUpdatedFooter.hidden
    ) {
      reserve = Math.ceil(el.ownershipUpdatedFooter.getBoundingClientRect().height) + 8;
    } else if (
      expectedFill &&
      el.expectedUpdatedFooter &&
      !el.expectedUpdatedFooter.hidden
    ) {
      reserve = Math.ceil(el.expectedUpdatedFooter.getBoundingClientRect().height) + 8;
    }
    const minH = Math.max(
      ownershipTree ? 320 : 180,
      Math.floor(viewportBottom - top - reserve)
    );
    const prev = root.style.getPropertyValue("--mobile-scrollport-min-h");
    root.style.setProperty("--mobile-scrollport-min-h", `${minH}px`);
    if (ownershipTree && prev !== `${minH}px`) scheduleOwnershipTreemapRelayout();
  }

  let mobileChromeScrollLast = 0;
  let mobileChromeScrollTicking = false;
  let mobileChromeScrollHidden = false;

  function mobileChromeScrollActive() {
    if (state.page === "ownership" && ownershipIsTreemap()) return false;
    return (
      mobileDocksActive() &&
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
    if (main) {
      main.scrollTop = 0;
      main.scrollLeft = 0;
    }
    if (!NARROW_MQ.matches) return;
    if (state.page === "opta") {
      optaTableWraps().forEach((wrap) => {
        wrap.scrollTop = 0;
        wrap.scrollLeft = 0;
      });
    } else if (state.page === "ownership" && el.ownershipTableWrap) {
      el.ownershipTableWrap.scrollTop = 0;
      el.ownershipTableWrap.scrollLeft = 0;
    } else if (state.page === "prices") {
      const wraps = pricesActiveTableWraps();
      wraps.forEach((wrap) => {
        wrap.scrollTop = 0;
        wrap.scrollLeft = 0;
      });
      if (el.pricesPredictionWrap && pricesViewMode() === "prediction") {
        el.pricesPredictionWrap.scrollTop = 0;
        el.pricesPredictionWrap.scrollLeft = 0;
      }
    } else if (state.page === "expected") {
      const barbell = expectedScrollWrap();
      if (barbell) {
        barbell.scrollTop = 0;
        barbell.scrollLeft = 0;
      }
    }
  }

  function mobileChromeScrollSources() {
    const sources = [];
    const main = document.querySelector("main.main");
    if (main) sources.push(main);
    if (NARROW_MQ.matches) {
      if (state.page === "expected") {
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
    ].forEach(restoreMobileFilterHome);
  }

  function mobileFilterButtonForPage() {
    const page = state.page;
    if (page === "home") return null;
    if (page === "markets") return el.marketsSlidersToggle || null;
    if (page === "schedule") return el.scheduleSlidersToggle || null;
    if (page === "team" && !state.teamPickerSlot) return null;
    if (page === "live" && state.liveMode === "bonus") return null;
    if (el.sidebar && el.sidebar.style.display === "none") return null;
    if (el.sidebarToggle && el.sidebarToggle.style.display === "none") return null;
    return el.sidebarToggle || null;
  }

  function filtersSidebarHidden() {
    const page = state.page;
    return (
      page === "schedule" ||
      page === "markets" ||
      page === "home" ||
      (page === "team" && !state.teamPickerSlot) ||
      (page === "live" && state.liveMode === "bonus")
    );
  }

  function filtersToggleHidden() {
    return (
      (state.page === "team" && !state.teamPickerSlot) ||
      (state.page === "live" && state.liveMode === "bonus")
    );
  }

  function syncFiltersChrome() {
    if (el.sidebar) el.sidebar.style.display = filtersSidebarHidden() ? "none" : "";
    if (el.sidebarToggle) el.sidebarToggle.style.display = filtersToggleHidden() ? "none" : "";
    if (
      state.page === "live" &&
      state.liveMode === "bonus" &&
      mobileSheetOpen &&
      mobileSheetKey === "filters"
    ) {
      closeMobileSheet();
    }
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
      page === "schedule" ||
      page === "prices"
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
    if (!mobileDocksActive() || !mobileViewTabsVisible()) {
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
    ].filter(Boolean);
    if (!dock) return;
    if (!mobileDocksActive()) {
      restoreAllMobileFilterButtons();
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
    dock.hidden = false;
    dock.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("has-mobile-filter-fab");
    syncMobileChromeFade();
  }

  function mobileDocksActive() {
    return NARROW_MQ.matches;
  }

  function syncSubtoolbarViewport(page = state.page) {
    if (!el.subtoolbar) return;
    const isMarkets = page === "markets";
    const isHome = page === "home";
    const isLive = page === "live";
    const hideSubtoolbar =
      page === "schedule" ||
      (isMarkets && preferMobileSheet()) ||
      isHome ||
      (preferMobileSheet() && page === "rankings");
    el.subtoolbar.style.display = hideSubtoolbar ? "none" : "";
    el.subtoolbar.classList.toggle("is-markets-mobile", isMarkets && preferMobileSheet());
    el.subtoolbar.classList.toggle("is-expected-mobile", page === "expected" && preferMobileSheet());
    el.subtoolbar.classList.toggle("is-opta-mobile", page === "opta" && preferMobileSheet());
    const viewTabs = el.tabPlayers && el.tabPlayers.closest(".tabs");
    if (viewTabs) {
      viewTabs.style.display =
        page === "team" || page === "live" || page === "prices" ? "none" : "";
    }
  }

  let viewportLayoutSyncTimer = 0;
  let pricesViewportNarrow = NARROW_MQ.matches;

  function handlePricesViewportBreakpointChange() {
    const isNarrow = NARROW_MQ.matches;
    if (isNarrow === pricesViewportNarrow) return false;
    pricesViewportNarrow = isNarrow;
    pricesActualColumnsFailedAt = 0;
    pricesPredictionColumnsFailedAt = 0;
    if (state.page === "prices") {
      requestAnimationFrame(() => {
        renderPrices({ preserveScroll: true });
      });
    }
    return true;
  }

  function scheduleViewportLayoutSync({ immediate = false } = {}) {
    const run = () => {
      viewportLayoutSyncTimer = 0;
      const breakpointFlip = handlePricesViewportBreakpointChange();
      syncMobileLayoutClass();
      syncMobileChrome();
      syncSubtoolbarViewport();
      syncColumnsPanelHost();
      syncTeamSearchHost();
      syncTeamCompareHost();
      syncTeamPickerCancelHost();
      syncPageNavLabelCenter();
      syncPageTabsScrollHints();
      syncAllSegThumbs({ animate: false });
      refreshNameSimplifyOrigins();
      syncMobileScrollportHeight();
      syncMobileTopChromeInset();
      scheduleOptaMobileNameColWidth();
      scheduleTeamTableHeadHeightSync();
      syncExpectedCatToolbar();
      syncMarketsViewControls();
      syncBarbellHeadHeight();
      syncBarbellCompareNameWidth();
      scheduleOwnershipTreemapRelayout();
      if (!breakpointFlip && state.page === "prices" && pricesViewMode() === "prediction") {
        schedulePricesPredictionColumnsSync();
      }
      if (!breakpointFlip && state.page === "prices" && pricesViewMode() === "actual") {
        schedulePricesActualColumnsSync();
      }
      if (state.page === "opta") {
        syncCoreUnderName();
        syncLivePointsCoreUnder();
      }
      if (state.page === "team") syncTeamPickerCoreUnder();
      bindMobileChromeScrollHide();
      if (preferMobileSheet()) setExpectedCatMenuOpen(false);
      if (state.page === "home") {
        syncHomeSquadWideLayout();
        if (homeSquadIsWideLayout()) settleHomeTablesLayout();
      }
    };
    if (immediate) {
      if (viewportLayoutSyncTimer) clearTimeout(viewportLayoutSyncTimer);
      viewportLayoutSyncTimer = 0;
      run();
      return;
    }
    if (viewportLayoutSyncTimer) clearTimeout(viewportLayoutSyncTimer);
    viewportLayoutSyncTimer = window.setTimeout(run, 80);
  }

  function syncMobileChrome() {
    syncMobileFilterDock();
    syncMobileViewDock();
    syncHomeSearchBtn();
    if (!mobileChromeScrollActive()) resetMobileChromeScrollHide();
    else {
      const main = document.querySelector("main.main");
      mobileChromeScrollLast = main ? main.scrollTop : 0;
    }
    requestAnimationFrame(() => syncMobileScrollportHeight());
  }

  // Expected (and Ownership treemap) own both axes natively.
  // Stats / Ownership table / Planner / Prices: content-sized tables + .main page scroll.
  // iOS won't vertical-scroll .main through overflow-x wraps, so we chain
  // vertical touch to .main and apply a short fling for free-scroll feel.
  function bindNestedTableScroll() {
    const main = document.querySelector("main.main");
    if (!main) return;

    function mainMax() {
      return Math.max(0, main.scrollHeight - main.clientHeight);
    }

    function pageOwnsVerticalScroll() {
      return (
        state.page === "expected" ||
        (state.page === "ownership" && ownershipIsTreemap())
      );
    }

    function needsMainTouchChain() {
      return (
        NARROW_MQ.matches &&
        (state.page === "opta" ||
          state.page === "team" ||
          state.page === "live" ||
          state.page === "prices" ||
          (state.page === "ownership" && !ownershipIsTreemap()))
      );
    }

    let flingRaf = 0;
    function stopMainFling() {
      if (flingRaf) {
        cancelAnimationFrame(flingRaf);
        flingRaf = 0;
      }
    }

    function startMainFling(velocityPxPerMs) {
      stopMainFling();
      let v = velocityPxPerMs;
      if (Math.abs(v) < 0.15) return;
      // Cap so a hard flick doesn't teleport.
      v = Math.max(-2.8, Math.min(2.8, v));
      const friction = 0.0035;
      let last = performance.now();
      const step = (now) => {
        const dt = Math.min(34, now - last);
        last = now;
        const max = mainMax();
        const next = Math.min(max, Math.max(0, main.scrollTop + v * dt));
        main.scrollTop = next;
        const sign = v < 0 ? -1 : 1;
        v -= sign * friction * dt;
        if (sign * v <= 0.02 || next <= 0 || next >= max - 0.5) {
          flingRaf = 0;
          return;
        }
        flingRaf = requestAnimationFrame(step);
      };
      flingRaf = requestAnimationFrame(step);
    }

    document
      .querySelectorAll(
        ".table-wrap, .barbell-scroll, .live-bonus-wrap, #prices-prediction-wrap, #prices-actual-wrap"
      )
      .forEach((inner) => {
      if (inner.dataset.scrollChain === "1") return;
      inner.dataset.scrollChain = "1";

      inner.addEventListener(
        "wheel",
        (e) => {
          if (!NARROW_MQ.matches || pageOwnsVerticalScroll()) return;
          if (inner.scrollTop > 0) return;
          const max = mainMax();
          if (e.deltaY > 0 && main.scrollTop < max - 1) {
            main.scrollTop += e.deltaY;
            e.preventDefault();
          } else if (e.deltaY < 0 && main.scrollTop > 0) {
            main.scrollTop += e.deltaY;
            e.preventDefault();
          }
        },
        { passive: false }
      );

      let touchStartX = 0;
      let touchStartY = 0;
      let touchLastY = 0;
      let touchLastT = 0;
      let touchAxis = null;
      let touchVelY = 0;

      inner.addEventListener(
        "touchstart",
        (e) => {
          if (!needsMainTouchChain() || e.touches.length !== 1) return;
          stopMainFling();
          touchStartX = e.touches[0].clientX;
          touchStartY = e.touches[0].clientY;
          touchLastY = touchStartY;
          touchLastT = performance.now();
          touchAxis = null;
          touchVelY = 0;
        },
        { passive: true }
      );

      inner.addEventListener(
        "touchmove",
        (e) => {
          if (!needsMainTouchChain() || e.touches.length !== 1) return;
          const x = e.touches[0].clientX;
          const y = e.touches[0].clientY;
          const dx = x - touchStartX;
          const dy = y - touchStartY;
          if (touchAxis == null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
            touchAxis = Math.abs(dy) > Math.abs(dx) * 1.15 ? "y" : "x";
          }
          if (touchAxis !== "y") return;
          const now = performance.now();
          const dt = Math.max(1, now - touchLastT);
          const delta = touchLastY - y;
          touchVelY = delta / dt;
          touchLastY = y;
          touchLastT = now;
          const max = mainMax();
          const next = Math.min(max, Math.max(0, main.scrollTop + delta));
          if (next !== main.scrollTop) {
            main.scrollTop = next;
            e.preventDefault();
          } else if ((delta > 0 && main.scrollTop >= max) || (delta < 0 && main.scrollTop <= 0)) {
            // At edge — still claim the gesture so iOS doesn't rubber-band oddly.
            e.preventDefault();
          }
        },
        { passive: false }
      );

      const endTouch = () => {
        if (!needsMainTouchChain() || touchAxis !== "y") return;
        startMainFling(touchVelY);
        touchAxis = null;
      };
      inner.addEventListener("touchend", endTouch, { passive: true });
      inner.addEventListener("touchcancel", endTouch, { passive: true });
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

  // Dead zone after the default (Price) origin so the landing view stays full.
  // Statistics collapse finishes after a short pan — not at the last column.
  const NAME_SIMPLIFY_START = 28;
  const NAME_SIMPLIFY_END = 220;
  const OPTA_NAME_SIMPLIFY_END = 110;
  const nameSimplifyRafs = new WeakMap();

  function nameSimplifyWraps() {
    const wraps = [];
    if (state.page === "opta") {
      const main = el.tableBody && el.tableBody.closest(".table-wrap");
      if (main) wraps.push(main);
      const compare = el.compareWrap && el.compareWrap.querySelector(".compare-table-wrap");
      if (compare) wraps.push(compare);
    }
    if (state.page === "team") {
      teamTableScrollWraps().forEach((wrap) => wraps.push(wrap));
    }
    if (state.page === "ownership" && el.ownershipTableWrap && !el.ownershipTableWrap.hidden) {
      wraps.push(el.ownershipTableWrap);
    }
    if (state.page === "prices") {
      pricesActiveTableWraps().forEach((wrap) => {
        if (wrap && !wrap.hidden) wraps.push(wrap);
      });
    }
    if (state.page === "expected") {
      const scroll = expectedScrollWrap();
      if (scroll) wraps.push(scroll);
    }
    if (
      state.page === "live" &&
      state.liveMode === "points" &&
      el.liveTableWrap &&
      !el.liveTableWrap.hidden
    ) {
      wraps.push(el.liveTableWrap);
    }
    return wraps;
  }

  function nameSimplifyHost(scrollEl) {
    if (!scrollEl) return null;
    if (scrollEl.classList.contains("barbell-scroll")) {
      return scrollEl.closest(".barbell-wrap") || scrollEl;
    }
    return scrollEl;
  }

  function nameSimplifyActive() {
    if (!(NARROW_MQ.matches || !hasFineHover())) return false;
    return (
      state.page === "ownership" ||
      state.page === "prices" ||
      state.page === "expected" ||
      state.page === "opta" ||
      state.page === "team" ||
      (state.page === "live" && state.liveMode === "points")
    );
  }

  let optaMobileNameColW = null;
  let ownershipMobileNameColW = null;
  let pricesMobileNameColW = null;
  let liveMobileNameColW = null;
  let mobileNameColRaf = 0;

  // Hug identity content (Planner-tight). Cap is only a safety rail — not a target.
  const MOBILE_NAME_COL_MIN = 152;
  const OWNERSHIP_MOBILE_NAME_COL_MIN = 168;
  const MOBILE_NAME_COL_MAX_FRAC = 0.58;
  const MOBILE_NAME_COL_SLACK = 10;
  const PRICES_ACTUAL_MOBILE_PLAYER_MIN = 96;
  const PRICES_ACTUAL_MOBILE_CHANGE_MIN = 44;
  const PRICES_ACTUAL_MOBILE_AFTER_MIN = 58;

  function measureInlineContentWidth(el) {
    if (!el) return 0;
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      let w = 0;
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) w = Math.max(w, rects[i].width);
      if (w > 0) return Math.ceil(w);
    } catch (_) {
      /* fall through */
    }
    return Math.ceil(el.scrollWidth || 0);
  }

  function measureNameLineIntrinsicWidth(nameLine) {
    if (!nameLine) return 0;
    const cs = getComputedStyle(nameLine);
    const gap = parseFloat(cs.gap) || 0;
    const kids = nameLine.querySelectorAll(":scope > *");
    let w = 0;
    kids.forEach((el, i) => {
      w += Math.ceil(el.getBoundingClientRect().width);
      if (i > 0) w += gap;
    });
    return w;
  }

  function measureNameColWidth(wrap, { minW = MOBILE_NAME_COL_MIN, hugContent = false, slack = MOBILE_NAME_COL_SLACK } = {}) {
    if (!wrap) return minW;
    const hug = hugContent || !!wrap.querySelector(".live-points-table");
    const prevColW = wrap.style.getPropertyValue("--name-col-w");
    const prevCollapse = wrap.style.getPropertyValue("--name-collapse");
    // Expand so sub-line chips aren't clipped while measuring intrinsic widths.
    wrap.style.setProperty("--name-col-w", hug ? `${minW}px` : "640px");
    wrap.style.setProperty("--name-collapse", "0");
    wrap.classList.remove("is-name-simplifying");
    if (hug) wrap.classList.add("is-name-col-measure");
    void wrap.offsetWidth;
    let max = minW;
    wrap.querySelectorAll("tbody td.col-player, tbody td.col-name").forEach((td) => {
      const cs = getComputedStyle(td);
      const pad =
        (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const id = td.querySelector(".ownership-id");
      if (id) {
        const idCs = getComputedStyle(id);
        const gap = parseFloat(idCs.columnGap || idCs.gap) || 0;
        const rank = id.querySelector(".ownership-rank");
        const thumb = id.querySelector(".ownership-photo, .ownership-crest");
        const text = id.querySelector(".ownership-id-text");
        let content = 0;
        let parts = 0;
        if (rank) {
          content += Math.ceil(rank.getBoundingClientRect().width);
          parts += 1;
        }
        if (thumb) {
          content += Math.ceil(thumb.getBoundingClientRect().width);
          parts += 1;
        }
        if (text) {
          const nameLine = text.querySelector(".player-name-line");
          const name = text.querySelector(".player-name");
          const sub = text.querySelector(".ownership-id-sub");
          const nameW = nameLine
            ? hug
              ? measureNameLineIntrinsicWidth(nameLine)
              : measureInlineContentWidth(nameLine)
            : measureInlineContentWidth(name);
          let subW = 0;
          if (sub) {
            const bits = Array.from(sub.children);
            if (bits.length) {
              const first = bits[0].getBoundingClientRect();
              const last = bits[bits.length - 1].getBoundingClientRect();
              subW = Math.max(0, Math.ceil(last.right - first.left));
            }
          }
          content += Math.max(nameW, subW);
          parts += 1;
        }
        if (parts > 1) content += gap * (parts - 1);
        max = Math.max(max, content + Math.ceil(pad));
        return;
      }
      const cell = td.querySelector(".player-cell");
      if (cell) {
        const name = cell.querySelector(".player-name");
        const sub = cell.querySelector(".player-cell-sub");
        const crest = cell.querySelector(".player-cell-crest");
        const cellCs = getComputedStyle(cell);
        const gap = parseFloat(cellCs.columnGap || cellCs.gap) || 0;
        let content = crest ? Math.ceil(crest.getBoundingClientRect().width) : 0;
        const textW = Math.max(
          measureInlineContentWidth(name),
          sub ? measureInlineContentWidth(sub) : 0
        );
        if (crest && textW) content += gap;
        content += textW;
        max = Math.max(max, content + Math.ceil(pad));
        return;
      }
      max = Math.max(max, minW);
    });
    if (prevColW) wrap.style.setProperty("--name-col-w", prevColW);
    else wrap.style.removeProperty("--name-col-w");
    if (prevCollapse) wrap.style.setProperty("--name-collapse", prevCollapse);
    else wrap.style.removeProperty("--name-collapse");
    wrap.classList.remove("is-name-col-measure");
    return max + slack;
  }

  function syncOptaMobileNameColWidth() {
    const wraps = optaTableWraps();
    if (!NARROW_MQ.matches || state.page !== "opta") {
      optaMobileNameColW = null;
      wraps.forEach((wrap) => {
        wrap.style.removeProperty("--name-col-w");
        wrap.removeAttribute("data-view");
      });
      return;
    }
    const mainWrap = wraps[0];
    if (mainWrap) {
      const measured = measureNameColWidth(mainWrap, {
        minW: MOBILE_NAME_COL_MIN,
        hugContent: true,
      });
      const cap = Math.round(mainWrap.clientWidth * MOBILE_NAME_COL_MAX_FRAC);
      optaMobileNameColW = Math.max(
        MOBILE_NAME_COL_MIN,
        Math.min(measured, cap)
      );
    } else {
      optaMobileNameColW = null;
    }
    if (optaMobileNameColW == null) return;
    const prev = mainWrap && mainWrap.style.getPropertyValue("--name-col-w");
    wraps.forEach((wrap) => {
      wrap.dataset.view = state.view;
      wrap.style.setProperty("--name-col-w", `${optaMobileNameColW}px`);
    });
    if (prev !== `${optaMobileNameColW}px`) {
      wraps.forEach(invalidateNameSimplifyOrigin);
    }
  }

  function syncOwnershipMobileNameColWidth() {
    const wrap = el.ownershipTableWrap;
    if (
      !NARROW_MQ.matches ||
      state.page !== "ownership" ||
      !wrap ||
      wrap.hidden ||
      ownershipIsTreemap()
    ) {
      ownershipMobileNameColW = null;
      if (wrap) wrap.style.removeProperty("--name-col-w");
      return;
    }
    const measured = measureNameColWidth(wrap, {
      minW: OWNERSHIP_MOBILE_NAME_COL_MIN,
      hugContent: true,
    });
    const cap = Math.round(wrap.clientWidth * MOBILE_NAME_COL_MAX_FRAC);
    ownershipMobileNameColW = Math.max(
      OWNERSHIP_MOBILE_NAME_COL_MIN,
      Math.min(measured, cap)
    );
    const prev = wrap.style.getPropertyValue("--name-col-w");
    wrap.style.setProperty("--name-col-w", `${ownershipMobileNameColW}px`);
    if (prev !== `${ownershipMobileNameColW}px`) {
      invalidateNameSimplifyOrigin(wrap);
    }
  }

  const LIVE_POINTS_NAME_COL_MIN = 128;
  const LIVE_POINTS_MOBILE_NAME_COL_W = 118;

  function syncLivePointsNameColWidth() {
    const wrap = el.liveTableWrap;
    if (state.page !== "live" || state.liveMode !== "points" || !wrap || wrap.hidden) {
      liveMobileNameColW = null;
      if (wrap) {
        wrap.style.removeProperty("--name-col-w");
        wrap.removeAttribute("data-view");
      }
      return;
    }
    if (NARROW_MQ.matches) {
      liveMobileNameColW = LIVE_POINTS_MOBILE_NAME_COL_W;
      wrap.dataset.view = "players";
      wrap.style.setProperty("--name-col-w", `${liveMobileNameColW}px`);
      return;
    }
    const measured = measureNameColWidth(wrap, {
      minW: LIVE_POINTS_NAME_COL_MIN,
      hugContent: true,
      slack: 4,
    });
    const cap = Math.round(wrap.clientWidth * 0.28);
    liveMobileNameColW = Math.max(LIVE_POINTS_NAME_COL_MIN, Math.min(measured, cap));
    const prev = wrap.style.getPropertyValue("--name-col-w");
    wrap.dataset.view = "players";
    wrap.style.setProperty("--name-col-w", `${liveMobileNameColW}px`);
    if (prev !== `${liveMobileNameColW}px`) invalidateNameSimplifyOrigin(wrap);
  }

  /** Lock Live Points name column before enter motion so PTS doesn't jump after measure. */
  function primeLivePointsTableLayout() {
    if (
      state.page !== "live" ||
      state.liveMode !== "points" ||
      !el.liveTableWrap ||
      el.liveTableWrap.hidden ||
      !nameSimplifyActive()
    ) {
      return;
    }
    syncLivePointsNameColWidth();
    const wrap = el.liveTableWrap;
    const host = nameSimplifyHost(wrap) || wrap;
    host.classList.add("name-simplify-ready");
    host.dataset.view = "players";
    host.style.setProperty("--name-collapse", "0");
    host.classList.remove("is-name-simplifying");
  }

  function pricesViewMode() {
    return state.pricesViewMode === "actual" ? "actual" : "prediction";
  }

  function pricesPredictionTableWraps() {
    return [el.pricesRisersWrap, el.pricesFallersWrap].filter(Boolean);
  }

  function pricesActualTableWraps() {
    return [el.pricesActualRisersWrap, el.pricesActualFallersWrap].filter(Boolean);
  }

  function pricesActiveTableWraps() {
    if (pricesViewMode() === "actual") {
      return pricesActualTableWraps();
    }
    return pricesPredictionTableWraps();
  }

  function syncPricesMobileNameColWidth() {
    const wraps = pricesActiveTableWraps();
    if (!NARROW_MQ.matches || state.page !== "prices" || !wraps.length) {
      pricesMobileNameColW = null;
      wraps.forEach((wrap) => wrap.style.removeProperty("--name-col-w"));
      return;
    }
    if (pricesViewMode() === "actual") {
      wraps.forEach((wrap) => wrap.style.removeProperty("--name-col-w"));
      pricesMobileNameColW = null;
      return;
    }
    pricesMobileNameColW = null;
    wraps.forEach((wrap) => wrap.style.removeProperty("--name-col-w"));
  }

  function scheduleOptaMobileNameColWidth() {
    if (mobileNameColRaf) cancelAnimationFrame(mobileNameColRaf);
    mobileNameColRaf = requestAnimationFrame(() => {
      mobileNameColRaf = 0;
      syncOptaMobileNameColWidth();
      syncOwnershipMobileNameColWidth();
      syncPricesMobileNameColWidth();
      syncLivePointsNameColWidth();
      if (state.page === "prices" && pricesViewMode() === "actual") {
        syncPricesActualColumnWidths();
      }
    });
  }

  function nameSimplifyProgress(scrollLeft, origin = 0, wrap = null) {
    // Ownership still maps the full remaining pan (short table). Statistics /
    // Planner finish compact well before the last column.
    if (wrap && (state.page === "ownership" || state.page === "prices")) {
      const maxScroll = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
      if (maxScroll <= 0) return 0;
      const linear = Math.min(1, Math.max(0, scrollLeft) / maxScroll);
      return linear * linear * (3 - 2 * linear);
    }
    const rel = Math.max(0, scrollLeft - origin);
    if (rel <= NAME_SIMPLIFY_START) return 0;
    const end =
      state.page === "opta" ||
      state.page === "team" ||
      (state.page === "live" && state.liveMode === "points")
        ? OPTA_NAME_SIMPLIFY_END
        : NAME_SIMPLIFY_END;
    const linear = Math.min(1, (rel - NAME_SIMPLIFY_START) / Math.max(1, end - NAME_SIMPLIFY_START));
    // smoothstep — soft after the initial drag, soft landing at compact
    return linear * linear * (3 - 2 * linear);
  }

  function withFullNameColumn(wrap, fn) {
    const host = nameSimplifyHost(wrap) || wrap;
    const prev = host.style.getPropertyValue("--name-collapse");
    host.style.setProperty("--name-collapse", "0");
    host.classList.remove("is-name-simplifying");
    void host.offsetWidth;
    const result = fn();
    if (prev) host.style.setProperty("--name-collapse", prev);
    else host.style.removeProperty("--name-collapse");
    return result;
  }

  // Default Statistics origin = left edge of Price (£m / first Core col).
  // Morph only after panning further right. Measure with the name column at
  // full width so shrinking names cannot pull the origin left.
  function computeNameSimplifyOrigin(wrap) {
    if (!wrap || !wrap.classList.contains("is-core-under")) return 0;
    return withFullNameColumn(wrap, () => {
      const headRow = wrap.querySelector("thead tr:not(.section-row)");
      const pin = headRow && headRow.querySelector("th.col-player, th.col-name");
      const price =
        headRow &&
        headRow.querySelector("th.col-core, th.col-num[data-live-sort='pts'], th.col-num");
      if (!pin || !price) return 0;
      const delta = price.getBoundingClientRect().left - pin.getBoundingClientRect().right;
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

  function clearNameColumnSimplify(scrollEl) {
    if (!scrollEl) return;
    const host = nameSimplifyHost(scrollEl);
    [scrollEl, host].forEach((node) => {
      if (!node) return;
      node.classList.remove("name-simplify-ready", "is-name-simplifying");
      node.style.removeProperty("--name-collapse");
      node.removeAttribute("data-view");
    });
    invalidateNameSimplifyOrigin(scrollEl);
  }

  function updateNameColumnSimplify(scrollEl, scrollLeftOverride) {
    if (!scrollEl || !nameSimplifyActive()) {
      clearNameColumnSimplify(scrollEl);
      return;
    }
    const host = nameSimplifyHost(scrollEl);
    const scrollLeft = scrollLeftOverride != null ? scrollLeftOverride : scrollEl.scrollLeft;
    const t = nameSimplifyProgress(scrollLeft, nameSimplifyOrigin(scrollEl), scrollEl);
    host.classList.add("name-simplify-ready");
    host.dataset.view =
      state.page === "team" || (state.page === "live" && state.liveMode === "points")
        ? "players"
        : state.view;
    host.style.setProperty("--name-collapse", String(t));
    host.classList.toggle("is-name-simplifying", t > 0.02);
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
      if (el.ownershipTableWrap) clearNameColumnSimplify(el.ownershipTableWrap);
      pricesActiveTableWraps().forEach((wrap) => clearNameColumnSimplify(wrap));
      const barbellScroll = expectedScrollWrap();
      if (barbellScroll) clearNameColumnSimplify(barbellScroll);
      return;
    }
    nameSimplifyWraps().forEach((wrap) => {
      bindNameColumnSimplify(wrap);
      updateNameColumnSimplify(wrap);
    });
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
    if (el.homeBento) el.homeBento.classList.remove("is-search-open");
    scheduleMobileViewportReset({ force: true });
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
      setTip(el.scheduleSlidersToggle, "Show matchup filters");
      el.scheduleSlidersToggle.setAttribute("aria-label", "Show matchup filters");
    }
    if (el.marketsSlidersToggle && closingKey === "markets-filters") {
      el.marketsSlidersToggle.classList.remove("on");
      el.marketsSlidersToggle.setAttribute("aria-expanded", "false");
      setTip(el.marketsSlidersToggle, "Show filters");
      el.marketsSlidersToggle.setAttribute("aria-label", "Show filters");
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

  function renderBody(rows, highlightPopulation = null) {
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
      state.enhanceRelative && state.page === "opta"
        ? highlightPopulation || rows
        : getRows()
    );
    rows.forEach((r) =>
      el.tableBody.appendChild(buildDataRow(r, vcols, highlightMaps))
    );
    bindOwnershipPhotoFallback(el.tableBody);
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

  function syncLivePointsCoreUnder() {
    const wrap = el.liveTableWrap;
    if (!wrap) return;
    const under =
      NARROW_MQ.matches && state.page === "live" && state.liveMode === "points" && !wrap.hidden;
    wrap.classList.toggle("is-core-under", under);
    invalidateNameSimplifyOrigin(wrap);
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

  function captureScrollWraps(wraps) {
    return wraps.filter(Boolean).map((wrap) => ({
      wrap,
      top: wrap.scrollTop,
      left: wrap.scrollLeft,
    }));
  }

  function restoreScrollWraps(snaps) {
    if (!snaps || !snaps.length) return;
    const apply = () => {
      snaps.forEach(({ wrap, top, left }) => {
        if (!wrap) return;
        wrap.scrollTop = top;
        wrap.scrollLeft = left;
      });
    };
    apply();
    requestAnimationFrame(apply);
  }

  function renderTable(opts = {}) {
    const preserveOptaScroll = !!opts.preserveOptaScroll;
    const optaScrollSnap =
      state.page === "opta" && preserveOptaScroll
        ? captureScrollWraps(optaTableWraps())
        : null;
    clearTimeout(fixtureTtTimer);
    hideFixtureTooltip();
    if (state.page === "ownership") {
      renderOwnership();
      syncFiltersResetUI();
      syncTeamSearchHost();
      return;
    }
    if (state.page === "prices") {
      renderPrices();
      syncFiltersResetUI();
      syncTeamSearchHost();
      return;
    }
    if (state.page === "live") {
      renderLive({ quiet: true });
      syncFiltersResetUI();
      return;
    }
    if (state.page === "team") {
      renderTeam();
      syncFiltersResetUI();
      return;
    }
    const filtered = applyFilters(getRows());
    // Resolve Relative visibility before building highlight maps.
    syncEnhanceRelativeUI();
    const sorted = sortRows(filtered);
    const highlightFilterKey = state.page === "opta" ? optaHighlightFilterKey(filtered.length) : "";
    const highlightsChanged =
      state.page === "opta" &&
      (opts.animateHighlights === true ||
        (highlightFilterKey && highlightFilterKey !== lastOptaHighlightFilterKey));
    if (state.page === "opta") lastOptaHighlightFilterKey = highlightFilterKey;

    let bodyRows = sorted;
    let highlightPopulation = null;
    if (state.page === "opta") {
      const pageKey = optaPaginationDatasetKey();
      if (pageKey !== lastOptaPaginationKey) {
        state.statsPage = 1;
        lastOptaPaginationKey = pageKey;
      }
      const pageSize = state.statsPageSize || 50;
      const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize) || 1);
      if (state.statsPage > totalPages) state.statsPage = totalPages;
      if (state.statsPage < 1) state.statsPage = 1;
      const start = (state.statsPage - 1) * pageSize;
      bodyRows = sorted.slice(start, start + pageSize);
      if (state.enhanceRelative) highlightPopulation = sorted;
    }

    renderHead();
    renderBody(bodyRows, highlightPopulation);
    el.countLabel.textContent = `${filtered.length.toLocaleString()} of ${getRows().length.toLocaleString()} shown`;
    if (state.page === "opta") syncOptaTableFooter(sorted);
    else if (el.optaTableFooter) el.optaTableFooter.hidden = true;
    renderCompareTable();
    if (state.page === "expected") renderExpected();
    if (state.page === "rankings") {
      // Avoid a second DOM rebuild while page-enter is in flight (init calls
      // renderTable() right after setPage). That wipe+replay looked like a reload.
      const pane = el.rankingsPage;
      const entering =
        pane &&
        (pane.classList.contains("is-entering") ||
          pane.classList.contains("is-enter-pending"));
      if (!entering) renderRankings({ animateBars: false });
    }
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
        restoreScrollWraps(optaScrollSnap);
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

  function fixtureStatCell(teamCode, split, key, value, decimals, highlightMaps, rankMaps, { schedulePalette = false } = {}) {
    // Tooltip always shows ranks + enhance-style highlighting. Colours are
    // inverted relative to the main table: these are the *opponent's*
    // figures, so being top of a category (rank 1) is a hard fixture and
    // reads pink on Matchups cards, orange elsewhere; bottom reads blue.
    const highlight = schedulePalette ? scheduleHighlightInlineStyle : enhanceHighlightInlineStyle;
    let style = "";
    let extraClass = "";
    const ranks = highlightMaps[split] && highlightMaps[split][key];
    const topIntensity = ranks && ranks.top.get(teamCode);
    const bottomIntensity = ranks && ranks.bottom.get(teamCode);
    if (topIntensity !== undefined) {
      const paint = highlight("bottom", topIntensity);
      style = ` style="${paint.style}"`;
      extraClass = paint.strongClass;
    } else if (bottomIntensity !== undefined) {
      const paint = highlight("top", bottomIntensity);
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
      const cellOpts = { schedulePalette: showMatchups };
      return `<tr>
        <td class="ftt-gw">${fx.gw}</td>
        <td class="ftt-opp"><span>${badgeHTML(fx.opp)}${escapeHtml(fx.opp)}</span></td>
        <td class="ftt-ha">${fx.ha}${fx.ha === "H" ? iconHTML("star", "ftt-home-star") : ""}</td>
        ${fixtureStatCell(fx.opp, split, "xg", stats && stats.xg, 1, highlightMaps, rankMaps, cellOpts)}
        ${fixtureStatCell(fx.opp, split, "goals", stats && stats.goals, 0, highlightMaps, rankMaps, cellOpts)}
        ${fixtureStatCell(fx.opp, split, "xgc", stats && stats.xgc, 1, highlightMaps, rankMaps, cellOpts)}
        ${fixtureStatCell(fx.opp, split, "goalsConceded", stats && stats.goalsConceded, 0, highlightMaps, rankMaps, cellOpts)}
        ${fixtureStatCell(fx.opp, split, "cleanSheets", stats && stats.cleanSheets, 0, highlightMaps, rankMaps, cellOpts)}
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
      ${showMeta ? `<div class="ftt-note">Opp ranks vs all teams on that venue split (1 = best, 20 = worst; promoted ranks provisional) · soft blue = easier, pink = tougher (quieter blue in dark mode)</div>` : ""}`;
  }

  function fixtureTooltipHTML(teamCode, options = {}) {
    const population = Math.max(
      Object.keys(TEAM_STATS.home || {}).length,
      Object.keys(TEAM_STATS.away || {}).length,
      20
    );
    const tipTopN = Math.max(1, Math.round((population * FIXTURE_TT_ENHANCE_PCT) / 100));
    const highlightMaps = fixtureHighlightMaps(tipTopN);
    const rankMaps = fixtureRankMaps();
    const showMatchups =
      options.showMatchups != null
        ? options.showMatchups
        : state.page === "opta" && state.view === "teams";
    const merged = { ...options, showMatchups };
    if (showMatchups && !merged.matchupProfile) {
      const fixtures = merged.fixtures || planningFixturesForTeam(teamCode, FIXTURE_TT_COUNT);
      merged.matchupProfile = teamMatchupProfile(teamCode, fixtures, rankMaps);
    }
    return fixtureCardHTML(teamCode, highlightMaps, rankMaps, merged);
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
      spitRow(
        `${iconHTML("swords", "ftt-attack-icon")} ${iconHTML("shield-half", "ftt-defence-icon")}`,
        "Attack / defence edge when Advantage ≥ Flag threshold."
      ),
        spitRow(iconHTML("funnel"), "Gameweek range, Highlight Ranks, Expected/Actual blend, and Flag threshold."),
    ];
    if (!mobile) {
      iconRows.push(spitRow(iconHTML("info"), "On a card — that club’s own home/away attack &amp; defence ranks."));
    }
    // Static hi-res captures of a real card; pins are HTML overlays (not baked into the PNG).
    return `${spitHead("calendar-days", "How Matchups works")}
      ${spitIntro("Find clubs with a soft upcoming run for attack and/or defence.")}
      ${spitSection("Legend", iconRows)}
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
          <li><span class="spit-pin" aria-hidden="true">4</span><span><strong>Opp ranks (1–20)</strong> — venue-matched; soft blue / tough pink tint.</span></li>
          <li><span class="spit-pin" aria-hidden="true">5</span><span><strong>${iconHTML("swords", "ftt-attack-icon")} / ${iconHTML("shield-half", "ftt-defence-icon")}</strong> — flagged attack or defence edge.</span></li>
        </ol>
      </div>
      ${spitNote("Scatter averages every fixture (not only flagged). Promoted clubs use provisional ranks 18–20.")}`;
  }

  function pageInfoTooltipHTML() {
    const mobile = pageInfoIsMobile();

    if (state.page === "home") {
      const legend = [
        spitRow(
          `<span class="home-status-dot is-live spit-home-swatch" aria-hidden="true"></span>`,
          "Fixture in play"
        ),
        spitRow(
          `<span class="home-status-dot is-done spit-home-swatch" aria-hidden="true"></span>`,
          "Fixture finished (incl. FPL provisional FT)"
        ),
        spitRow(
          `<span class="home-imp is-pos spit-home-swatch" aria-hidden="true"><span class="home-imp-track"><span class="home-imp-fill is-pos is-drawn" style="--imp-pct:70%;--imp-fill:hsl(var(--positive) / 0.78)"></span></span><span class="home-imp-pct">70%</span></span>`,
          "IMP ahead of league top third",
          "spit-symbol-wide"
        ),
        spitRow(
          `<span class="home-imp is-neg spit-home-swatch" aria-hidden="true"><span class="home-imp-track"><span class="home-imp-fill is-neg is-drawn" style="--imp-pct:55%;--imp-fill:hsl(var(--negative) / 0.7)"></span></span><span class="home-imp-pct">55%</span></span>`,
          "IMP behind league top third",
          "spit-symbol-wide"
        ),
        spitRow(
          `<span class="home-play-live is-active spit-home-swatch">2</span>`,
          "Live — active picks in play (Bench Boost can exceed 11)"
        ),
        spitRow(
          `<span class="home-play-left is-active spit-home-swatch">3</span>`,
          "Left — still to play this gameweek"
        ),
        spitRow(
          `<span class="home-role-tag home-role-c spit-home-swatch">C</span><span class="home-role-tag home-role-a spit-home-swatch">A</span>`,
          "Captain / vice on the squad list"
        ),
        spitRow(
          spitOwnedPinHTML(),
          "Also in your configured squad (when viewing another manager)"
        ),
        spitRow(
          `<span class="home-chip-cell is-available spit-home-swatch" aria-hidden="true"><span class="home-chip-cell-mark"></span></span>`,
          "Chip still available (this half)"
        ),
        spitRow(
          `<span class="home-chip-cell is-used spit-home-swatch" aria-hidden="true"><span class="home-chip-cell-mark"></span><span class="home-chip-cell-gw">4</span></span>`,
          "Chip used — number is the gameweek"
        ),
        spitRow(
          `<span class="home-chip-cell is-active spit-home-swatch" aria-hidden="true"><span class="home-chip-cell-mark"></span><span class="home-chip-cell-gw">1</span></span>`,
          "Chip active this gameweek"
        ),
      ];
      const reading = [
        spitRow(spitRank("GW pts"), "Active picks × multiplier after auto-subs. Bench Boost counts all 15."),
        spitRow(
          spitRank("Own"),
          mobile
            ? "Tap a player name to highlight owners in standings (others fade). Swipe the team card for points breakdown and fixtures. Click a standings manager to view their team — Exit returns to yours."
            : "Click a team player to highlight owners in standings (others fade). Click a standings manager to view their team — Exit returns to yours."
        ),
        spitRow(
          spitRank("Pts"),
          mobile
            ? "Second team swipe — GW stat pills (G, A, CS, DC, B, Sv); Sv → YC when no keeper saves."
            : "GW stat pills beside Starting XI on wide screens, or team page 2 — same Live Points colors; Sv → YC when no keeper saves."
        ),
        spitRow(
          spitRank("Schedule"),
          "Upcoming fixtures — crest + home icon; FPL difficulty wash (blue easy → pink hard)."
        ),
        spitRow(spitRank("Chips"), "Standings swipe → Chips: WC / FH / BB / TC for the current half only (second half appears from GW20)."),
        ...(mobile
          ? [spitRow(spitRank("Search"), "Search any player: profile replaces summary cards, hides team, highlights owners in standings, and shows club fixtures.")]
          : []),
        spitRow(spitRank("Refresh"), "Changing manager auto-rebuilds Home on the local server (python3 site/serve.py)."),
      ];
      return `${spitHead("house", "How Home works")}
        ${spitIntro("Live GW dashboard for your Preferences manager + league (auto-subs & chips from last refresh).")}
        ${spitSection("Legend", legend)}
        ${spitSection("Reading", reading)}`;
    }

    if (state.page === "rankings") {
      const legend = [
        spitRow(spitMedalsHTML(), "Places 1–3 on each card.", "spit-medals"),
        spitRow(spitRankingsBarSwatch(), "Bar length — value within the card (longer = higher)."),
        spitRow(spitRankingsPinSwatch(), "Pinned compare — up to five, colour-coded across cards."),
        spitRow(spitOwnedPinHTML(), "In your FPL squad (Preferences → Manager)."),
      ];
      const reading = [
        spitRow(spitRank("Place"), "Rank within current filters and pins — not the full list. Default mins/price cuts limit Per 90 outliers."),
        spitRow(
          spitRank(mobile ? "Tap" : "Pin"),
          mobile
            ? "Tap to pin up to five names. Pins persist across filters; colour key above the cards."
            : "Pin up to five names. Pins persist across filters; hover cross-highlights the same name."
        ),
      ];
      return `${spitHead("podium", "How Rankings works")}
        ${spitIntro(isNextSeason()
          ? "Top 10 leaderboards for FPL season stats, grouped into Key Stats, Attacking, and Defending."
          : "Top 10 boards for OPTA and FPL metrics, grouped Key Stats, Attacking, and Defending.")}
        ${spitSection("Legend", legend)}
        ${spitSection("Reading", reading)}`;
    }

    if (state.page === "expected") {
      const legend = [
        spitRow(spitBarbellTrackSwatch(), "Expected dot → actual bar on the track"),
        spitRow(`<i class="spit-easy"></i>`, "Outperforming expectation"),
        spitRow(`<i class="spit-tough"></i>`, "Underperforming expectation"),
        spitRow(`<i class="spit-even"></i>`, "Even — actual ≈ expected"),
        spitRow(spitDiffPillSwatch("over"), "Diff pill — actual above expected"),
        spitRow(spitDiffPillSwatch("under"), "Diff pill — actual below expected"),
        spitRow(spitOwnedPinHTML(), "In your FPL squad"),
      ];
      const reading = [
        spitRow(spitRank("Cat"), "Category — toolbar dropdown"),
        ...(state.expectedSplit === "compare"
          ? [spitRow(spitRank("Split"), "Home and away side by side for the same players or teams.")]
          : []),
        spitRow(spitRank("Bar"), "Expected → actual. Moving dashes show the gap direction."),
        spitRow(
          spitRank("Diff"),
          "Actual − expected. Pill intensity scales with gap size. For xGC, a negative Diff can still be blue (conceded less than expected)."
        ),
      ];
      const intro = isNextSeason()
        ? "FPL expected vs actual for 2026/27 — home/away from live match venue."
        : "Expected (x) vs actual — who over- or underperformed.";
      return `${spitHead("chart-gantt", "How Expected Data works")}
        ${spitIntro(intro)}
        ${spitSection("Legend", legend)}
        ${spitSection("Reading", reading)}
        ${spitNote("Blue/orange here is over/under vs expectation — not Matchups fixture difficulty. Soft blue is quieter in dark mode.")}`;
    }

    if (state.page === "ownership") {
      const legend = [
        spitRow(`<span class="ownership-pill is-live spit-ui-swatch">12.4</span>`, "Live TSB% — latest check-in"),
        spitRow(`<span class="ownership-delta is-up spit-ui-swatch">+1.2</span>`, "Ownership up over that window"),
        spitRow(`<span class="ownership-delta is-down spit-ui-swatch">−0.8</span>`, "Ownership down over that window"),
        spitRow(spitOwnershipLineSwatch("riser"), "14-day sparkline — start and end % labeled"),
        spitRow(spitOwnedPinHTML(), "In your FPL squad (Preferences → Manager)."),
      ];
      const reading = [
        spitRow(spitRank("Risers"), "Top 20 14-day TSB% increases, ranked before team/position filters."),
        spitRow(spitRank("Fallers"), "Top 20 14-day TSB% decreases. Toggle in the bar above the table."),
        spitRow(spitRank("Treemap"), "Top movers by 7d / 3d / 24h Δ as tiles (largest changes only). Toggle beside the count."),
        spitRow(spitRank("Players"), "Photo, name, team, price, and position. Sort any numeric column."),
        spitRow(spitRank("Teams"), "Average TSB% of each club’s 20 most-owned players at that check-in."),
        spitRow(spitRank("Windows"), "7d / 3d / 24h use the nearest snapshot on or before that many days before the latest check-in."),
      ];
      return `${spitHead("trending-up", "How Ownership works")}
        ${spitIntro("FPL selected-by% (TSB%) movers from the saved ownership cache.")}
        ${spitSection("Legend", legend)}
        ${spitSection("Reading", reading)}
        ${spitNote("This page reads the saved ownership cache — it does not call the FPL API live.")}`;
    }

    if (state.page === "prices") {
      const mobile = NARROW_MQ.matches;
      const isActual = pricesViewMode() === "actual";
      const legend = isActual
        ? [
            spitRow(
              `<span class="prices-section-arrow is-rise spit-ui-swatch">${iconHTML("trending-up")}</span>`,
              "Colored arrow beside Risers / Fallers — direction for the whole table"
            ),
            spitRow(spitOwnedPinHTML(), "In your FPL squad (Preferences → Manager)."),
          ]
        : mobile
        ? [
            spitRow(`<span class="prices-section-arrow is-rise spit-ui-swatch">${iconHTML("trending-up")}</span>`, "Colored arrow beside Risers / Fallers — direction for the whole table"),
            spitRow(`<span class="prices-progress-pill is-rise spit-ui-swatch"><span>+101.2%</span></span>`, "Progress toward next £0.1m change"),
            spitRow(`<span class="ownership-spark prices-spark is-up spit-ui-swatch"><span class="ownership-spark-lab">+12.1%</span><svg class="ownership-spark-svg" viewBox="0 0 92 28" width="92" height="28" aria-hidden="true"><polyline points="2,20 46,12 90,6" /><circle cx="90" cy="6" r="1.8" /></svg><span class="ownership-spark-lab">+95.2%</span></span>`, "3-day progress sparkline — start and end % labeled"),
            spitRow(spitOwnedPinHTML(), "In your FPL squad (Preferences → Manager)."),
          ]
        : [
            spitRow(`<span class="prices-section-arrow is-rise spit-ui-swatch">${iconHTML("trending-up")}</span>`, "Colored arrow beside Risers / Fallers — direction for the whole table"),
            spitRow(`<span class="prices-progress-pill is-rise spit-ui-swatch"><span>+101.2%</span></span>`, "Progress toward next £0.1m change"),
            spitRow(`<span class="ownership-spark prices-spark is-up spit-ui-swatch"><span class="ownership-spark-lab">+12.1%</span><svg class="ownership-spark-svg" viewBox="0 0 92 28" width="92" height="28" aria-hidden="true"><polyline points="2,20 46,12 90,6" /><circle cx="90" cy="6" r="1.8" /></svg><span class="ownership-spark-lab">+95.2%</span></span>`, "3-day progress sparkline — start and end % labeled"),
            spitRow(spitOwnedPinHTML(), "In your FPL squad (Preferences → Manager)."),
          ];
      const reading = isActual
        ? [
            spitRow(spitRank("Prediction vs Actual"), "Prediction shows FPL’s price-change predictor. Actual lists confirmed £0.1m moves from bootstrap snapshot diffs (backfilled where daily snapshots exist)."),
            spitRow(spitRank("Before / After"), "Price immediately before and after the detected change."),
            spitRow(spitRank("Date"), "When the change was detected (check-in timestamp)."),
            spitRow(spitRank("Player"), "Photo, crest ring, team, price, position — same as Ownership."),
          ]
        : [
            spitRow(spitRank("Filter"), "Only Very/Likely rise and drop tags — excludes “Unlikely to change”."),
            ...(mobile
              ? [
                  spitRow(spitRank("Risers / Fallers"), "Direction badge beside each section title — green rise, red fall."),
                ]
              : [
                  spitRow(spitRank("Risers / Fallers"), "Direction badge beside each section title — green rise, red fall."),
                ]),
            spitRow(spitRank("Risers / Fallers"), "Two stacked tables — risers above, fallers below, each ranked by largest |progress|."),
            spitRow(spitRank("3d trend"), "Progress % spark over the last 3 days of 4-hour check-ins. Line colour follows 3d Δ (green up, red down)."),
            spitRow(spitRank("Progress filter"), "Sidebar slider sets minimum |progress| (±90%–±200%, default ±90%)."),
            spitRow(spitRank("Countdown"), "Time until the next daily price update. Change time is shown in your local timezone."),
            spitRow(spitRank("Player"), "Photo, crest ring, team, price, position — same as Ownership."),
          ];
      const intro = isActual
        ? "Confirmed £0.1m price moves from bootstrap snapshot diffs."
        : "Official FPL price-change predictor from 4-hour bootstrap check-ins.";
      const note = isActual
        ? "Actual log starts empty on deploy and fills as daily/4h fetches detect changes."
        : "Refreshed every 4 hours via fetch_prices.py. FPL updates predictor data ~every 15 minutes.";
      return `${spitHead("pound-sterling", "How Prices works")}
        ${spitIntro(intro)}
        ${spitSection("Legend", legend)}
        ${spitSection("Reading", reading)}
        ${spitNote(note)}`;
    }

    if (state.page === "live") {
      const legend = [
        spitRow(
          `<span class="live-feed-impact is-pos spit-home-swatch" aria-hidden="true"><span class="live-feed-impact-val">+3.5</span><span class="live-feed-impact-suffix"> vs avg</span></span>`,
          "League impact — pts gained or lost vs avg opponent (captain 2×).",
          "spit-symbol-wide"
        ),
        spitRow(
          `<span class="live-feed-event-label spit-home-swatch" aria-hidden="true">Goal</span>`,
          "Feed event label.",
          "spit-symbol-wide"
        ),
        spitRow(
          `<span class="home-imp is-pos spit-home-swatch" aria-hidden="true"><span class="home-imp-track"><span class="home-imp-fill is-pos is-drawn" style="--imp-pct:70%;--imp-fill:hsl(var(--positive) / 0.78)"></span></span></span>`,
          "DefCon progress — solid blue fill when threshold hit (+2 pts).",
          "spit-symbol-wide"
        ),
        spitRow(
          `<span class="threshold-dot"><svg class="check-mark-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg></span>`,
          "DefCon earned this match."
        ),
        spitRow(`<span class="live-card-dot is-yc spit-home-swatch" aria-hidden="true"></span>`, "Yellow card (Points mode)."),
        spitRow(
          `<span class="live-bonus-status is-live spit-home-swatch" aria-hidden="true"><span class="home-status-dot is-live"></span> Live</span>`,
          "Bonus card in play — green border; live cards sort first.",
          "spit-symbol-wide"
        ),
        spitRow(spitOwnedPinHTML(), "In your FPL squad (Preferences → Manager)."),
      ];
      const reading = [
        spitRow(spitRank("Modes"), "Feed / DefCon / Points / Bonus — current gameweek only."),
        spitRow(spitRank("Feed"), "Newest first — goals, assists, cards, DefCon, appearance pts; bonus only after that match hits 60′."),
        spitRow(spitRank("Total"), "Running GW pts for that player; pill color scales with haul size."),
        spitRow(spitRank("Impact"), "Pts change × your ownership edge vs league avg. Unique picks swing most; shared picks ~0."),
        spitRow(spitRank("Threshold"), "DEF 10 CBIT · MID/FWD 12 CBIRT · GK ineligible."),
        spitRow(spitRank("Points"), "Sortable GW stats — Pts, G, A, CS, Sv, DC, bonus, cards."),
        spitRow(spitRank("Bonus"), "Per fixture after 60′ — BPS bars; top three projected 3/2/1."),
        spitRow(spitRank("Filters"), "Matchup badges, team, position, All/Live/Owned."),
      ];
      return `${spitHead("circle-play", "How Gameweek works")}
        ${spitIntro("Current-GW live stats — event feed, DefCon progress, gameweek points, and per-fixture bonus projections.")}
        ${spitSection("Legend", legend)}
        ${spitSection("Reading", reading)}`;
    }

    if (state.page === "markets") {
      const legend = [
        spitRow(spitMarketsStatSwatch("high", "1.82"), "Goals / CS% — above your blue threshold"),
        spitRow(spitMarketsStatSwatch("low", "18%"), "Goals / CS% — below your orange threshold"),
        spitRow(spitMarketsDeltaSwatch("up"), "Compare mode — moved up vs earlier pull"),
        spitRow(spitMarketsDeltaSwatch("down"), "Compare mode — moved down vs earlier pull"),
      ];
      const reading = [
        spitRow(spitRank("View"), mobile ? "Goals and CS% or Scoreline — in the Filters sheet" : "Goals and CS% or Scoreline — in the toolbar above the title"),
        spitRow(iconHTML("scale"), "Compare window — Current / Last 24 hr / Last 72 hr (both card views)"),
        spitRow(spitRank("Goals"), "Poisson λ from de-vigged 1X2 + totals — projected goals per side."),
        spitRow(spitRank("CS%"), "P(opponent scores 0) under that model — not a native book market."),
        spitRow(spitRank("Scoreline"), "Exact-score matrix (% in cells). Goals view lists top likely scores."),
        spitRow(spitRank("Color"), "Blue/orange bands on Goals and CS%; deeper past the threshold. Soft blue is quieter in dark mode."),
        spitRow(spitRank("Compare"), "Last 24 hr or Last 72 hr — movement vs prior odds pull."),
      ];
      return `${spitHead("candlestick", "How Markets works")}
        ${spitIntro("Upcoming PL fixtures: projected goals, clean-sheet %, and likely scorelines from bookmaker odds.")}
        ${spitSection("Legend", legend)}
        ${spitSection("Reading", reading)}`;
    }

    if (state.page === "team") {
      const legend = [
        spitRow(`${spitTeamRoleSwatch("c")}${spitTeamRoleSwatch("v")}`, "Captain / vice on the squad"),
        spitRow(
          spitCheckMarkHTML("spit-check-mark spit-check-mark--setpiece"),
          "Set-piece — FPL #1 (check mark). FK/CK also show #2."
        ),
        spitRow(spitHighlightSwatch("top"), "Stat cell wash — rank among that position (same band as Statistics Enhance)."),
        spitRow(iconHTML("plus"), "Empty row — add a player of that position"),
        spitRow(iconHTML("scale"), "Compare — pick up to 5 players in the squad or picker"),
      ];
      const reading = [
        spitRow(
          spitRank("Row"),
          mobile
            ? "Tap a player for captain, vice, bench, replace, or remove."
            : "Right-click a player for captain, vice, bench, replace, or remove."
        ),
        spitRow(spitRank("Rules"), "15 players · £100.0m · max 3 per club · 2 GKP / 5 DEF / 5 MID / 3 FWD."),
        spitRow(spitRank("Live"), "Your live FPL squad and scoring are on Home — this page is for planning ahead."),
        spitRow(spitRank("XI"), "Formation follows starters (3–5 DEF, 2–5 MID, 1–3 FWD). Bench holds the rest."),
        spitRow(spitRank("Stats"), isNextSeason()
          ? `Pts, xGI, xG, xA from ${teamStatsSeasonLabel()} FPL season totals. New signings show –.`
          : `Pts, xPts, xGI, xG, xA from ${teamStatsSeasonLabel()}. New signings show –.`),
        spitRow(spitRank("Form"), "Sparkline of GW points (needs 2+ gameweeks)."),
        spitRow(spitRank("GW"), "Picker sets the planning window; six fixture heat columns start from that GW (blue easy → pink hard)."),
        spitRow(
          spitRank("Select"),
          mobile
            ? "Empty slot or Replace opens search. Affordable filter hides players above Bank."
            : "Empty slot or Replace opens search and filters (incl. Affordable)."
        ),
        spitRow(spitRank("Transfers"), "FT used/available (e.g. 0/1). Unused roll over (+1/GW, max 5). Extra transfers cost −4."),
        spitRow(spitRank("Squad"), "Resync copies your linked FPL squad. Clear removes planned picks from this GW onward."),
        spitRow(spitRank("Compare"), mobile
          ? "Pin up to 5 players to compare stats; Compare mode selects when no pins."
          : "Pin up to 5 players to compare stats; Compare mode selects when no pins."),
        spitRow(spitRank("Prices"), "2026/27 FPL list. Link a Manager in Preferences to sync from FPL."),
      ];
      const intro =
        "Plan your squad by gameweek — subs, transfers, and fixtures. Syncs from your linked FPL manager. Your live team is on Home.";
      return `${spitHead("shirt", "How Planner works")}
        ${spitIntro(intro)}
        ${spitSection("Legend", legend)}
        ${spitSection("Reading", reading)}`;
    }

    if (state.page === "schedule") {
      return matchupPageInfoHTML();
    }

    // Statistics (default)
    const legend = [
      spitRow(spitHighlightSwatch("top"), "Highlight Top — in the top band for that stat"),
      spitRow(spitHighlightSwatch("bottom"), "Highlight Bottom — in the bottom band for that stat"),
      spitRow(spitOwnedPinHTML(), "In your FPL squad (Preferences → Manager)"),
      spitRow(
        spitCheckMarkHTML("spit-check-mark spit-check-mark--threshold"),
        "DefCon check — earned DC points by hitting the match threshold (DEF 10 CBIT / MID·FWD 12 CBIRT). Not a per-90 rate."
      ),
      spitRow(
        spitCheckMarkHTML("spit-check-mark spit-check-mark--setpiece"),
        "Set-piece — FPL #1 (check mark). FK/CK also show #2."
      ),
      spitRow(iconHTML("refresh-ccw-dot"), "2026/27 matched price, club, and position on 2025/26 rows"),
      spitRow(iconHTML("scale"), "Compare — tap the toolbar button, then pick up to five rows"),
      spitRow(iconHTML("triangle-alert", "source-unsupported"), "Source can’t fill this cell"),
    ];
    const reading = [
      spitRow(spitRank("TSB%"), "FPL selected-by-% from the latest ownership check-in."),
      spitRow(
        spitRank("Tint"),
        "Highlight Top/Bottom bands on raw values (default top/bottom 5%). Relative mode shrinks bands to filtered rows."
      ),
      spitRow(
        spitRank("Fixtures"),
        mobile
          ? "Tap a stat cell for upcoming fixtures and venue-matched opponent ranks (Teams view uses Matchups pink/blue wash)."
          : "Click a stat cell for upcoming fixtures and venue-matched opponent ranks (Teams view uses Matchups pink/blue wash)."
      ),
      spitRow(spitRank("–"), "Stat doesn’t apply (e.g. saves for an outfielder)."),
    ];
    return `${spitHead("table", "How Statistics works")}
      ${spitIntro(isNextSeason()
        ? "2026/27 FPL season stats for players or teams — filter, sort, rank, and compare."
        : "Season OPTA and FPL stats — filter, sort, and compare Players or Teams.")}
      ${spitSection("Legend", legend)}
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
      const accent = teamAccentDecl(profile.teamCode);
      const accentStyle = accent ? `;${accent}` : "";
      return `<button type="button" class="schedule-scatter-point${accent ? " has-team-ring" : ""}"
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
    syncPageUpdatedFooter(el.scheduleUpdatedFooter, pageDataUpdatedIso("schedule"));
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
      live: "How Gameweek works",
      opta: "How Statistics works",
      rankings: "How Rankings works",
      expected: "How Expected Data works",
      schedule: "How Matchups works",
      ownership: "How Ownership works",
      markets: "How Markets works",
      team: "How Planner works",
    };
    pageInfoButtons().forEach((btn) => {
      const pane = btn.closest(".page-pane");
      let page = state.page;
      if (pane) {
        if (pane.id === "home-page") page = "home";
        else if (pane.id === "live-page") page = "live";
        else if (pane.id === "opta-page") page = "opta";
        else if (pane.id === "rankings-page") page = "rankings";
        else if (pane.id === "expected-page") page = "expected";
        else if (pane.id === "schedule-page") page = "schedule";
        else if (pane.id === "ownership-page") page = "ownership";
        else if (pane.id === "prices-page") page = "prices";
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

  // Head-to-head compare winner value. Unlike main-table Enhance bands, zeros
  // count — 0 goals vs 1 has a winner; 0 GC beats 3. Set-piece checks use
  // display rank (lower = better); null = not a taker for that role.
  function compareStatValue(row, col) {
    if (col.type === "check") return setPieceDisplayRank(row, col.key);
    if (!isStatAvailable(row, col)) return null;
    const val = displayValue(row, col);
    return Number.isFinite(Number(val)) ? Number(val) : 0;
  }

  function compareColLowerBetter(col) {
    return col.type === "check" || LOWER_BETTER.has(col.key);
  }

  function compareHighlightMap(selectedRows) {
    const maps = {};
    visibleColumns().forEach((col) => {
      const isCheck = col.type === "check";
      if (!isCheck && (!isNumericCol(col) || ENHANCE_EXCLUDE.has(col.key))) return;
      const lowerBetter = compareColLowerBetter(col);
      const withVals = selectedRows
        .map((r) => ({ key: rowKey(r), val: compareStatValue(r, col) }))
        .filter((x) => x.val != null);
      if (withVals.length < 2) {
        if (isCheck && withVals.length === 1 && selectedRows.length >= 2) {
          maps[col.key] = new Set([withVals[0].key]);
        }
        return;
      }
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
        if (isNumericCol(c) || c.type === "check") {
          if (!isStatApplicable(r, c) && c.type !== "check") {
            td.classList.add("zero-val");
          } else if (sourceUnsupportedReason(r, c)) {
            td.classList.add("has-source-warning");
          } else {
            const isWinner = winnerMap[c.key] && winnerMap[c.key].has(key);
            const val = compareStatValue(r, c);
            if (isWinner) {
              td.classList.add("highlight-top");
              td.style.backgroundColor = positiveFill(0.24);
            } else if (c.type !== "check" && val != null && Math.abs(val) < 1e-9) {
              td.classList.add("zero-val");
            }
          }
        }
        tr.appendChild(td);
      });
      el.compareBody.appendChild(tr);
    });
    bindOwnershipPhotoFallback(el.compareBody);
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
  // e.g., conceding fewer goals than xGC reads as blue even though
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
    setTip(el.expectedCatBtn, "");
    el.expectedCatBtn.setAttribute("aria-label", `Change category, ${cat.label}`);
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

  const BARBELL_COMPARE_NAME_MIN_W = 176;
  const BARBELL_COMPARE_NAME_MIN_W_MOBILE = 124;
  const BARBELL_COMPARE_NAME_MAX_FRAC = 0.34;
  const BARBELL_COMPARE_NAME_MAX_FRAC_MOBILE = 0.4;
  const BARBELL_COMPARE_NAME_SLACK = 8;
  const BARBELL_COMPARE_NAME_SLACK_MOBILE = 6;

  function measureBarbellCompareIdentityWidth(cell) {
    if (!cell) return 0;
    const id = cell.querySelector(".rankings-identity");
    const cs = getComputedStyle(cell);
    const pad =
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    if (!id) return Math.ceil(cell.scrollWidth);
    const idCs = getComputedStyle(id);
    const gap = parseFloat(idCs.columnGap || idCs.gap) || 0;
    const thumb = id.querySelector(".ownership-photo, .ownership-crest");
    const text = id.querySelector(".ownership-id-text");
    let content = 0;
    let parts = 0;
    if (thumb) {
      content += Math.ceil(thumb.getBoundingClientRect().width);
      parts += 1;
    }
    if (text) {
      const nameLine = text.querySelector(".player-name-line");
      const sub = text.querySelector(".ownership-id-sub");
      const nameW = nameLine
        ? measureNameLineIntrinsicWidth(nameLine)
        : measureInlineContentWidth(text.querySelector(".player-name"));
      let subW = 0;
      if (sub) {
        const bits = Array.from(sub.children);
        if (bits.length) {
          const first = bits[0].getBoundingClientRect();
          const last = bits[bits.length - 1].getBoundingClientRect();
          subW = Math.max(0, Math.ceil(last.right - first.left));
        }
      }
      content += Math.max(nameW, subW);
      parts += 1;
    }
    if (parts > 1) content += gap * (parts - 1);
    return content + Math.ceil(pad);
  }

  function syncBarbellCompareNameWidth() {
    const wrap = el.barbellWrap;
    if (!wrap || state.page !== "expected" || state.expectedSplit !== "compare") {
      wrap?.style.removeProperty("--barbell-name-w-compare");
      wrap?.style.removeProperty("--barbell-name-w-compare-full");
      wrap?.classList.remove("is-barbell-compare-measure");
      return;
    }
    const mobile = NARROW_MQ.matches;
    const minW = mobile ? BARBELL_COMPARE_NAME_MIN_W_MOBILE : BARBELL_COMPARE_NAME_MIN_W;
    const maxFrac = mobile ? BARBELL_COMPARE_NAME_MAX_FRAC_MOBILE : BARBELL_COMPARE_NAME_MAX_FRAC;
    const slack = mobile ? BARBELL_COMPARE_NAME_SLACK_MOBILE : BARBELL_COMPARE_NAME_SLACK;
    const identities = wrap.querySelectorAll(".barbell-group-identity");
    if (!identities.length) return;
    const prev = wrap.style.getPropertyValue("--barbell-name-w-compare");
    wrap.classList.add("is-barbell-compare-measure");
    wrap.style.setProperty("--barbell-name-w-compare", `${minW}px`);
    void wrap.offsetWidth;
    let maxW = minW;
    identities.forEach((cell) => {
      maxW = Math.max(maxW, measureBarbellCompareIdentityWidth(cell));
    });
    wrap.classList.remove("is-barbell-compare-measure");
    const scroll = expectedScrollWrap();
    const cap = scroll ? Math.round(scroll.clientWidth * maxFrac) : maxW;
    const next = `${Math.max(minW, Math.min(maxW + slack, cap))}px`;
    wrap.style.setProperty("--barbell-name-w-compare", next);
    if (mobile) wrap.style.setProperty("--barbell-name-w-compare-full", next);
    else wrap.style.removeProperty("--barbell-name-w-compare-full");
    if (prev !== next) syncBarbellHeadHeight();
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
      const extraBits = locSuffix
        ? [`<span class="loc-tag">${locSuffix === "Home" ? "H" : "A"}</span>`]
        : [];
      label.innerHTML = `<div class="rankings-identity ownership-style-id">${ownershipStyleIdentityHTML(row, { extraBits })}</div>`;
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
    identity.innerHTML = `<div class="rankings-identity ownership-style-id">${ownershipStyleIdentityHTML(row)}</div>`;
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
    const scroll = expectedScrollWrap();
    const scrollSnap =
      scroll && !opts.resetScroll
        ? { wrap: scroll, top: scroll.scrollTop, left: scroll.scrollLeft }
        : null;
    const cat = currentExpectedCat();
    updateExpectedSplitAvailability(cat);
    const compareMode = state.expectedSplit === "compare";
    if (el.barbellWrap) el.barbellWrap.classList.toggle("is-compare-mode", compareMode);
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
      syncPageUpdatedFooter(el.expectedUpdatedFooter, pageDataUpdatedIso("expected"));
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
    bindOwnershipPhotoFallback(el.barbellBody);
    if (compareMode) {
      requestAnimationFrame(() => {
        syncBarbellCompareNameWidth();
        syncBarbellHeadHeight();
      });
    }
    if (NARROW_MQ.matches) bindMobileChromeScrollHide();
    if (opts.resetScroll) {
      requestAnimationFrame(() => {
        const sc = expectedScrollWrap();
        if (sc) sc.scrollLeft = 0;
      });
    } else if (scrollSnap) {
      restoreScrollWraps([scrollSnap]);
    }
    requestAnimationFrame(() => syncMobileScrollportHeight());
    syncPageUpdatedFooter(el.expectedUpdatedFooter, pageDataUpdatedIso("expected"));
    bindAllNameColumnSimplifies();
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

  function ownershipStyleIdentityHTML(row, {
    extraBits = [],
    nameExtras = "",
    kind = null,
    showOwned = true,
    teamCode = null,
    position = null,
    teamTip = "",
    posTip = "",
    omitPrice = false,
    usePosBadge = false,
  } = {}) {
    const isPlayers = (kind != null ? kind : state.view) !== "teams";
    let thumb = "";
    let meta = "";
    if (isPlayers) {
      const displayTeam = teamCode || row.team;
      const displayPos = position || row.position;
      thumb = ownershipPhotoHTML(row, displayTeam);
      const teamTag = teamTagAttrs(displayTeam);
      const price = omitPrice ? null : effectivePrice(row);
      const bits = [
        displayTeam
          ? `<span class="ownership-id-team${teamTag.className}"${teamTag.style}${teamTip || ""}>${escapeHtml(displayTeam)}</span>`
          : "",
        price != null && Number.isFinite(Number(price))
          ? `<span class="ownership-id-price">£${Number(price).toFixed(1)}m</span>`
          : "",
        displayPos
          ? usePosBadge
            ? posBadgeHTML(displayPos)
            : `<span${posTip || ""}>${escapeHtml(displayPos)}</span>`
          : "",
        ...extraBits,
      ].filter(Boolean);
      meta = bits.length
        ? `<div class="ownership-id-sub">${bits.join('<span class="ownership-id-sep">|</span>')}</div>`
        : "";
    } else {
      const code = currentTeamCode(row) || row.team;
      thumb =
        badgeHTML(code, "ownership-crest") ||
        teamCrestFallbackHTML(code || row.team, "ownership-photo ownership-photo-fallback");
      const pos = LEAGUE_POSITIONS[row.team];
      const bits = [];
      if (pos != null) {
        const seasonLabel = LEAGUE_POSITIONS_META.seasonLabel || "Premier League";
        bits.push(
          `<span${tipAttr(`${pos}${ordinalSuffix(pos)} in the ${seasonLabel}`)}>${pos}${ordinalSuffix(pos)}</span>`
        );
      }
      bits.push(...extraBits.filter(Boolean));
      meta = bits.length
        ? `<div class="ownership-id-sub">${bits.join('<span class="ownership-id-sep">|</span>')}</div>`
        : "";
    }
    const nameHTML = `<span class="player-name">${escapeHtml(row.name)}</span>`;
    const flags = showOwned ? ownedFlagHTML(row) : "";
    const nameLine = `<span class="player-name-line">${nameHTML}${flags}${nameExtras || ""}</span>`;
    return `${thumb}<span class="ownership-id-text rankings-identity-text">${nameLine}${meta}</span>`;
  }

  /** Table sticky-column identity — same photo + TEAM|£|POS layout as Ownership / Rankings. */
  function tableOwnershipIdentityHTML(row, opts = {}) {
    return `<div class="ownership-id">${ownershipStyleIdentityHTML(row, opts)}</div>`;
  }

  function livePointsIdentityHTML(player, position) {
    return `<div class="ownership-id live-points-id">${ownershipStyleIdentityHTML(player, {
      omitPrice: true,
      position: position || player.position,
    })}</div>`;
  }

  function rankingsIdentityHTML(row, opts = {}) {
    return ownershipStyleIdentityHTML(row, opts);
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

  function renderRankings({ animateBars = true, skipBarDraw = false } = {}) {
    if (!el.rankingsGrid) return;
    clearRankingsCrossHover();
    const filtered = applyFilters(getRows());
    const total = getRows().length;
    el.rankingsCountLabel.textContent = `${filtered.length.toLocaleString()} of ${total.toLocaleString()} ${state.view} ranked`;

    const sections = rankingsSections();
    if (!sections.length) {
      el.rankingsGrid.innerHTML = `<div class="empty-state">No ranking metrics are available for this view and venue split.</div>`;
      renderRankingsPinBar();
      syncPageUpdatedFooter(el.rankingsUpdatedFooter, pageDataUpdatedIso("rankings"));
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
    bindOwnershipPhotoFallback(el.rankingsGrid);
    renderRankingsPinBar();
    if (animateBars) {
      animateRankingsBars();
    } else if (!skipBarDraw) {
      el.rankingsGrid.querySelectorAll(".rankings-bar").forEach((bar) => {
        bar.classList.add("is-drawn");
      });
    }
    syncPageUpdatedFooter(el.rankingsUpdatedFooter, pageDataUpdatedIso("rankings"));
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
        if (state.page === "rankings") renderRankings({ animateBars: false });
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
  const TEAM_FT_MAX = 5;
  const TEAM_FT_AFCON_GW = 16;

  function computeFreeTransfersAtGw(historyCurrent, targetGw) {
    if (!Array.isArray(historyCurrent) || !Number.isFinite(targetGw) || targetGw <= 1) return 1;
    let ft = 1;
    for (const row of historyCurrent) {
      const ev = Number(row.event);
      if (!Number.isFinite(ev) || ev >= targetGw) break;
      if (ev <= 1) continue;
      const transfers = Number(row.event_transfers) || 0;
      const cost = Number(row.event_transfers_cost) || 0;
      const paid = Math.round(cost / 4);
      const freeUsed = Math.max(0, transfers - paid);
      ft = Math.min(TEAM_FT_MAX, ft - freeUsed + 1);
      if (ev + 1 === TEAM_FT_AFCON_GW) ft = TEAM_FT_MAX;
    }
    return ft;
  }

  function ftAtStartOfGw(gw) {
    if (!Number.isFinite(gw) || gw <= 1) return 1;
    const anchor = state.plannerAnchor;
    const anchorGw = plannerAnchorGw();
    if (gw === anchorGw && anchor && Number.isFinite(Number(anchor.ft))) {
      return Number(anchor.ft);
    }
    const hist = anchor && anchor.historyCurrent;
    if (Array.isArray(hist) && hist.length) {
      return computeFreeTransfersAtGw(hist, gw);
    }
    return gw === 2 ? 1 : Number(anchor && anchor.ft) || 1;
  }

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

  function teamStatCols() {
    if (!isNextSeason()) return TEAM_STAT_COLS;
    return TEAM_STAT_COLS.filter((c) => !PLAYER_OPTA_ONLY_COL_KEYS.has(c.key));
  }
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
    return teamClampPlanGw(start);
  }

  function teamHeatGws() {
    const start = teamPlanGw();
    const gws = [];
    for (let i = 0; i < TEAM_HEAT_N; i++) gws.push(start + i);
    return gws;
  }

  function teamShiftGw(delta) {
    setTeamPlanGw(teamPlanGw() + delta);
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
    teamStatCols().forEach((col) => {
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
    return 1 + price + ownership + teamStatCols().length + 1 + setp + teamHeatGws().length;
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

  function teamSparkHeadHTML(opts) {
    if (opts && opts.plain) {
      return `<th class="col-team-spark">Form</th>`;
    }
    return `<th class="col-team-spark"${tipAttr("GW points sparkline")}>Form</th>`;
  }

  function teamMetricHeadHTML(opts) {
    const plain = !!(opts && opts.plain);
    const stats = teamStatCols().map((col, i) =>
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
      teamStatCols().length +
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

  /** GW points series for Form spark — baked formPts from event-live (build.py). */
  function teamFormSeries(row) {
    if (!row || row.code == null) return [];
    const prior = teamPriorRow(row.code) || row;
    let series = Array.isArray(prior.formPts)
      ? prior.formPts.map(Number).filter((v) => Number.isFinite(v))
      : [];
    // Live overlay: refresh/append current GW from Home when a fixture has started.
    const element = fplElementIdForRow(row);
    if (element != null) {
      const eg = (HOME && HOME.elementGw && HOME.elementGw[String(element)]) || null;
      if (eg && eg.status !== "scheduled") {
        const pts = Number(eg.pts);
        if (Number.isFinite(pts)) {
          const homeGw = Number(HOME && HOME.gw);
          if (!series.length) series = [pts];
          else if (Number.isFinite(homeGw) && homeGw > series.length) series = series.concat(pts);
          else series = series.slice(0, -1).concat(pts);
        }
      }
    }
    return series;
  }

  function teamSparkSeries(row) {
    if (!row || row.code == null) return [];
    return teamFormSeries(row);
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
      return `<td class="col-team-spark is-blank"><span class="team-spark-empty">–</span></td>`;
    }
    const first = series[0];
    const last = series[series.length - 1];
    const delta = last - first;
    const span = Math.max(...series) - Math.min(...series) || 1;
    const tone = series.length < 2 || Math.abs(delta) < span * 0.12 ? "is-flat" : delta > 0 ? "is-up" : "is-down";
    return `<td class="col-team-spark">${teamSparkSvg(series, tone)}</td>`;
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
    const stats = teamStatCols().map((col) => teamStatCellHTML(prior, row.position, col)).join("");
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
    teamStatCols().forEach((col) => {
      const withVals = list
        .map((r) => {
          const prior = teamPriorRow(r.code);
          const val = prior ? Number(prior[col.key]) : NaN;
          return { key: String(r.code), val };
        })
        .filter((x) => Number.isFinite(x.val));
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
    el.teamCompareBtn.classList.toggle("on", on);
    el.teamCompareBtn.classList.remove("is-disabled");
    el.teamCompareBtn.setAttribute("aria-pressed", on ? "true" : "false");
    el.teamCompareBtn.removeAttribute("aria-disabled");
    el.teamCompareBtn.disabled = false;
    setTip(el.teamCompareBtn, "Click up to 5 players to compare");
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
          const identity = tableOwnershipIdentityHTML(row, {
            kind: "players",
            showOwned: false,
            omitPrice: true,
          });
          return `<tr class="row-selectable" style="--enter-i:${i}" data-team-code="${escapeHtml(String(row.code))}">
            <td class="col-player">${identity}</td>
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

  function clonePlannerSquad(squad) {
    return (Array.isArray(squad) ? squad : []).map((s) => ({
      code: Number(s.code) || s.code,
      position: s.position,
      starter: !!s.starter,
      benchOrder: Number.isFinite(s.benchOrder) ? s.benchOrder : 0,
    }));
  }

  function plannerSnapFromState() {
    return {
      squad: clonePlannerSquad(state.teamSquad),
      captain: state.teamCaptainCode,
      vice: state.teamViceCode,
    };
  }

  function plannerAnchorGw() {
    const anchor = state.plannerAnchor;
    if (anchor && Number.isFinite(Number(anchor.gw))) return Number(anchor.gw);
    return teamCurrentGw();
  }

  function teamPlanGw() {
    return teamClampPlanGw(state.teamGwStart ?? plannerAnchorGw());
  }

  function teamPlanGwMin() {
    // Forward-looking only: next GW from the FPL API (skip current / finished).
    return planningGameweek();
  }

  function teamClampPlanGw(start) {
    return Math.min(SCHEDULE_GW_MAX, Math.max(teamPlanGwMin(), Number(start) || teamPlanGwMin()));
  }

  function plannerSnapKey(gw) {
    return String(gw);
  }

  function plannerStoredSnap(gw) {
    return state.plannerPlans[plannerSnapKey(gw)] || null;
  }

  function resolvePlannerSnap(gw) {
    const key = plannerSnapKey(gw);
    if (state.plannerPlans[key]) return state.plannerPlans[key];
    for (let g = gw - 1; g >= plannerAnchorGw(); g--) {
      const prev = state.plannerPlans[plannerSnapKey(g)];
      if (prev) return prev;
    }
    const actual = loadActualSnapshot();
    if (actual && actual.squad && actual.squad.length) {
      return { squad: actual.squad, captain: actual.captain, vice: actual.vice };
    }
    return { squad: [], captain: null, vice: null };
  }

  function savePlannerGwState(gw) {
    if (!Number.isFinite(gw)) return;
    state.plannerPlans[plannerSnapKey(gw)] = plannerSnapFromState();
    prunePlannerPlansAfter(gw);
    saveTeamDraft();
  }

  function prunePlannerPlansAfter(gw) {
    for (const key of Object.keys(state.plannerPlans)) {
      if (Number(key) > gw) delete state.plannerPlans[key];
    }
  }

  function loadPlannerGwState(gw) {
    applySquadSnapshot(resolvePlannerSnap(gw));
  }

  function resetPlannerFromSnap(snap, { gw } = {}) {
    const anchorGw = Number(gw) || plannerAnchorGw();
    state.plannerPlans = {};
    applySquadSnapshot(snap);
    state.plannerPlans[plannerSnapKey(anchorGw)] = {
      squad: clonePlannerSquad(snap.squad),
      captain: snap.captain ?? null,
      vice: snap.vice ?? null,
    };
    state.teamGwStart = teamClampPlanGw(planningGameweek());
    saveTeamDraft();
  }

  function plannerSquadCodes(snap) {
    return new Set((snap && snap.squad ? snap.squad : []).map((s) => Number(s.code) || s.code));
  }

  function countPlannerTransfers(prevSnap, nextSnap) {
    if (!prevSnap || !nextSnap) return 0;
    const prev = plannerSquadCodes(prevSnap);
    const next = plannerSquadCodes(nextSnap);
    let out = 0;
    for (const code of prev) if (!next.has(code)) out += 1;
    return out;
  }


  function plannerFtAvailable(gw) {
    if (!Number.isFinite(gw) || gw <= 1) return 1;
    const anchorGw = plannerAnchorGw();
    if (gw <= anchorGw) return ftAtStartOfGw(gw);

    let ft = ftAtStartOfGw(anchorGw);
    let startG = anchorGw;

    // GW1 allows unlimited transfers — first FT week (GW2) always opens with 1.
    if (anchorGw < 2) {
      ft = 1;
      startG = 2;
      if (gw <= 2) return 1;
    } else {
      ft = Math.min(TEAM_FT_MAX, ft - plannerTransfersUsed(anchorGw) + 1);
      if (anchorGw + 1 === TEAM_FT_AFCON_GW) ft = TEAM_FT_MAX;
      startG = anchorGw + 1;
      if (gw <= startG) return Math.max(0, ft);
    }

    for (let g = startG; g < gw; g++) {
      ft = Math.min(TEAM_FT_MAX, ft - plannerTransfersUsed(g) + 1);
      if (g + 1 === TEAM_FT_AFCON_GW) ft = TEAM_FT_MAX;
    }
    return Math.max(0, ft);
  }

  function plannerAnchorBaselineSnap() {
    const anchor = state.plannerAnchor;
    if (anchor && Array.isArray(anchor.squad) && anchor.squad.length) {
      return {
        squad: clonePlannerSquad(anchor.squad),
        captain: anchor.captain ?? null,
        vice: anchor.vice ?? null,
      };
    }
    const actual = loadActualSnapshot();
    if (actual && actual.squad && actual.squad.length) {
      return { squad: actual.squad, captain: actual.captain, vice: actual.vice };
    }
    return { squad: [], captain: null, vice: null };
  }

  function plannerTransfersUsed(gw) {
    const anchorGw = plannerAnchorGw();
    if (gw < anchorGw) return 0;
    const prev =
      gw === anchorGw ? plannerAnchorBaselineSnap() : resolvePlannerSnap(gw - 1);
    const next = plannerStoredSnap(gw) || plannerSnapFromState();
    return countPlannerTransfers(prev, next);
  }

  function plannerHitCost(gw) {
    const used = plannerTransfersUsed(gw);
    const avail = plannerFtAvailable(gw);
    return Math.max(0, used - avail) * 4;
  }

  function setTeamPlanGw(gw, { saveCurrent = true } = {}) {
    const next = teamClampPlanGw(gw);
    const prev = teamPlanGw();
    if (saveCurrent && prev !== next) savePlannerGwState(prev);
    state.teamGwStart = next;
    loadPlannerGwState(next);
    renderTeam();
  }

  function loadTeamDraft() {
    try {
      const raw = localStorage.getItem(TEAM_DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed) return;
      if (parsed.version >= 2) {
        state.plannerAnchor = parsed.anchor || state.plannerAnchor;
        state.plannerPlans = parsed.plans && typeof parsed.plans === "object" ? parsed.plans : {};
        if (Number.isFinite(Number(parsed.planGw))) {
          state.teamGwStart = teamClampPlanGw(Number(parsed.planGw));
        }
        loadPlannerGwState(teamPlanGw());
        return;
      }
      if (!Array.isArray(parsed.squad)) return;
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
      const gw = teamClampPlanGw(planningGameweek());
      state.teamGwStart = gw;
      state.plannerPlans = { [plannerSnapKey(gw)]: plannerSnapFromState() };
    } catch {
      /* private browsing / bad JSON */
    }
  }

  function saveTeamDraft() {
    try {
      state.plannerPlans[plannerSnapKey(teamPlanGw())] = plannerSnapFromState();
      localStorage.setItem(
        TEAM_DRAFT_KEY,
        JSON.stringify({
          version: 2,
          anchor: state.plannerAnchor,
          plans: state.plannerPlans,
          planGw: teamPlanGw(),
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
    if (replaceCode != null) {
      const gw = teamPlanGw();
      const used = plannerTransfersUsed(gw);
      const avail = plannerFtAvailable(gw);
      if (used > avail) {
        showToast({
          title: "Transfer hit",
          message: `${used}/${avail} FT used · −${plannerHitCost(gw)} pts this GW`,
          icon: "info",
        });
      }
    }
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
    state.teamSquad = [];
    state.teamCaptainCode = null;
    state.teamViceCode = null;
    prunePlannerPlansAfter(teamPlanGw() - 1);
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
    syncFiltersChrome();
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
      if (q && !playerMatchesSearch(r, q)) return false;
      return true;
    });
  }

  function teamHeatWindowStart() {
    return teamPlanGw();
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
    const label = fixtures.map(teamHeatOppLabel).join("+");
    const diffs = fixtures
      .map((fx) => Number(fx.difficulty))
      .filter((d) => Number.isFinite(d) && d >= 1 && d <= 5);
    const fdr = diffs.length ? Math.max(...diffs) : null;
    const ramp = fdr != null ? fdrRampInlineStyle(fdr, { schedulePalette: true }) : { className: "", styleAttr: "", strongClass: "" };
    return `<td class="team-heat-cell${ramp.className}${ramp.strongClass}${divide}${teamHeatAnchorClass(gw)}"${ramp.styleAttr}><span class="team-heat-label">${escapeHtml(label)}</span></td>`;
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
    return tableOwnershipIdentityHTML(row, {
      kind: "players",
      showOwned: false,
      nameExtras: role,
    });
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
      <td class="col-player">${teamPlayerCellHTML(row, slot)}</td>
      ${teamMetricCellsHTML(row)}
      ${heat}
    </tr>`;
  }

  function teamEmptyRowHTML(pos, starter, enterI) {
    const label = starter ? `Add ${TEAM_POS_LABEL[pos]}` : `Add ${TEAM_POS_LABEL[pos]} to bench`;
    const metrics = teamStatCols().map(
      (col) => `<td class="col-num col-team-stat is-blank"></td>`
    ).join("");
    const spark = `<td class="col-team-spark is-blank"></td>`;
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
    const start = teamPlanGw();
    state.teamGwStart = start;
    const minStart = teamPlanGwMin();
    const maxStart = SCHEDULE_GW_MAX;
    const label = `GW${start}`;
    if (preferMobileSheet()) {
      const items = [];
      for (let gw = minStart; gw <= maxStart; gw++) {
        items.push(
          `<button type="button" class="team-gw-carousel-item${gw === start ? " is-active" : ""}" data-team-gw="${gw}" aria-current="${gw === start ? "true" : "false"}"><span class="team-gw-carousel-label">GW${gw}</span></button>`
        );
      }
      el.teamGwNav.innerHTML = `
        <div class="team-gw-carousel" id="team-gw-carousel" aria-label="Gameweek">
          <div class="team-gw-carousel-track">${items.join("")}</div>
        </div>`;
      bindTeamGwCarousel();
      return;
    }
    el.teamGwNav.innerHTML = `
      <button type="button" class="ghost-btn icon-only-btn" id="team-gw-prev" ${start <= minStart ? "disabled" : ""} aria-label="Previous gameweek">${iconHTML("chevron-left")}</button>
      <span class="team-gw-range">${label}</span>
      <button type="button" class="ghost-btn icon-only-btn" id="team-gw-next" ${start >= maxStart ? "disabled" : ""} aria-label="Next gameweek">${iconHTML("chevron-right")}</button>`;
  }

  let teamGwCarouselBound = false;
  let teamGwCarouselScrollRaf = 0;

  function syncTeamGwCarouselEdges(track) {
    const carousel = track && track.closest(".team-gw-carousel");
    if (!carousel || !track) return;
    const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
    if (maxScroll < 2) {
      carousel.classList.remove("has-more-left", "has-more-right");
      return;
    }
    const left = track.scrollLeft;
    carousel.classList.remove("has-more-left");
    carousel.classList.toggle("has-more-right", left < maxScroll - 2);
  }

  function bindTeamGwCarousel() {
    const carousel = $("#team-gw-carousel");
    if (!carousel) return;
    const track = carousel.querySelector(".team-gw-carousel-track");
    if (!track) return;

    const leftAlignActive = ({ instant = false } = {}) => {
      const active = track.querySelector(".team-gw-carousel-item.is-active");
      if (!active) return;
      // Keep the selected GW left-aligned (not centered).
      const pad = 12;
      track.scrollTo({
        left: Math.max(0, active.offsetLeft - pad),
        behavior: instant || prefersReducedMotion() ? "auto" : "smooth",
      });
      requestAnimationFrame(() => syncTeamGwCarouselEdges(track));
    };

    requestAnimationFrame(() => {
      leftAlignActive({ instant: true });
      syncTeamGwCarouselEdges(track);
    });

    if (teamGwCarouselBound) return;
    teamGwCarouselBound = true;

    // Delegated: track is rebuilt each render, but nav host stays.
    el.teamGwNav.addEventListener("click", (e) => {
      const btn = e.target.closest(".team-gw-carousel-item[data-team-gw]");
      if (!btn || !el.teamGwNav.contains(btn)) return;
      const gw = Number(btn.getAttribute("data-team-gw"));
      if (!Number.isFinite(gw)) return;
      const next = teamClampPlanGw(gw);
      if (next === teamPlanGw()) {
        leftAlignActive();
        return;
      }
      setTeamPlanGw(next);
    });

    el.teamGwNav.addEventListener(
      "scroll",
      (e) => {
        const t = e.target.closest(".team-gw-carousel-track");
        if (!t || !el.teamGwNav.contains(t)) return;
        if (teamGwCarouselScrollRaf) return;
        teamGwCarouselScrollRaf = requestAnimationFrame(() => {
          teamGwCarouselScrollRaf = 0;
          syncTeamGwCarouselEdges(t);
          const items = [...t.querySelectorAll(".team-gw-carousel-item")];
          if (!items.length) return;
          // Pick the left-most item that has crossed the leading edge.
          const edge = t.scrollLeft + 14;
          let best = items[0];
          let bestDist = Infinity;
          items.forEach((item) => {
            const d = Math.abs(item.offsetLeft - edge);
            if (d < bestDist) {
              bestDist = d;
              best = item;
            }
          });
          items.forEach((item) => {
            const on = item === best;
            item.classList.toggle("is-active", on);
            item.setAttribute("aria-current", on ? "true" : "false");
          });
        });
      },
      true
    );

    el.teamGwNav.addEventListener(
      "scrollend",
      (e) => {
        const t = e.target.closest(".team-gw-carousel-track");
        if (!t || !el.teamGwNav.contains(t)) return;
        syncTeamGwCarouselEdges(t);
        const active = t.querySelector(".team-gw-carousel-item.is-active");
        if (!active) return;
        const gw = Number(active.getAttribute("data-team-gw"));
        if (!Number.isFinite(gw)) return;
        const next = teamClampPlanGw(gw);
        if (next !== teamPlanGw()) setTeamPlanGw(next);
      },
      true
    );
  }

  function openTeamGwSheet() {
    // Mobile uses the GW carousel in the toolbar; keep sheet helper for any legacy calls.
    const start = teamPlanGw();
    const windowGws = new Set(teamHeatGws().filter(teamHeatGwInSeason));
    const cells = [];
    for (let gw = teamPlanGwMin(); gw <= SCHEDULE_GW_MAX; gw++) {
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
    if (!el.mobileSheetBody) return;
    el.mobileSheetBody.querySelectorAll("[data-team-gw]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const gw = Number(btn.getAttribute("data-team-gw"));
        if (!Number.isFinite(gw)) return;
        const next = teamClampPlanGw(gw);
        closeMobileSheet();
        if (next === teamPlanGw()) return;
        setTeamPlanGw(next);
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
    const planGw = teamPlanGw();
    const ftAvail = plannerFtAvailable(planGw);
    const ftUsed = plannerTransfersUsed(planGw);
    const hitCost = plannerHitCost(planGw);
    const ftOver = ftUsed > ftAvail;
    const ftTone = ftOver ? " is-neg" : ftUsed < ftAvail ? " is-pos" : "";
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
      <div class="team-budget-stat${ftTone}" title="Free transfers used this gameweek / available at deadline">
        <span class="team-budget-label">FT</span>
        <strong>${ftUsed}/${ftAvail}</strong>
      </div>
      ${
        hitCost > 0
          ? `<div class="team-budget-stat is-neg"><span class="team-budget-label">Hit</span><strong>−${hitCost}</strong></div>`
          : ""
      }
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
    if (KNOWN_TEAM_CODES_LOWER.has(q)) return team === q ? 0 : 99;
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
    const identity = tableOwnershipIdentityHTML(row, {
      kind: "players",
      showOwned: false,
      nameExtras: note,
    });
    const selectable = state.teamCompareMode || pinned ? " row-selectable" : "";
    const cls = `team-search-row${inSquad && !(opts && opts.pin) ? " is-in-squad" : ""}${opts && opts.pin ? " is-pinned-row" : ""}${selectable}`;
    const id = `team-search-opt-${escapeHtml(String(row.code))}`;
    return `<tr class="${cls}" id="${id}" style="--enter-i:${i}" data-team-code="${escapeHtml(String(row.code))}" role="option">
      <td class="col-player">${identity}</td>
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
    renderTeamSearchResults();
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
        const selected = teamCompareHas(row.code);
        const selectedCls = selected ? " row-selected" : "";
        const selectableCls = state.teamCompareMode ? " row-selectable" : "";
        const identity = tableOwnershipIdentityHTML(row, {
          kind: "players",
          showOwned: false,
          omitPrice: true,
        });
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
    if (state.teamGwStart == null) state.teamGwStart = teamClampPlanGw(planningGameweek());
    normalizeTeamRoles();
    state.teamHoverCompareCode = null;
    hideTeamRowActionsPopup();
    syncPlannerPageUI();
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
    bindOwnershipPhotoFallback(el.teamPage);
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
    syncPageUpdatedFooter(el.teamUpdatedFooter, pageDataUpdatedIso("team"));
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
      renderTeam();
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
  syncPlanningHorizon();
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

  function parseDataIso(iso) {
    if (!iso) return NaN;
    const t = Date.parse(String(iso));
    return Number.isFinite(t) ? t : NaN;
  }

  /** Latest non-empty ISO timestamp from embedded cache bundles (never client "now"). */
  function latestDataIso(...isos) {
    let best = "";
    let bestT = -Infinity;
    for (const iso of isos) {
      if (!iso) continue;
      const t = parseDataIso(iso);
      if (!Number.isFinite(t) || t <= bestT) continue;
      bestT = t;
      best = String(iso);
    }
    return best;
  }

  /** Per-page "Updated" stamp — always from fetch/build bundles, not browser reload. */
  function pageDataUpdatedIso(page = state.page) {
    switch (page) {
      case "home":
        return HOME.generatedAt || null;
      case "live":
        return latestDataIso(HOME.generatedAt, DATA.generatedAt);
      case "ownership":
        return OWNERSHIP.generatedAt || null;
      case "prices":
        return PRICES.generatedAt || null;
      case "markets":
        return MARKETS.generatedAt || null;
      case "opta":
      case "team":
      case "rankings":
        // 2026/27 £ + owned % track ownership check-ins between build.py runs.
        return isNextSeason()
          ? latestDataIso(DATA.generatedAt, OWNERSHIP.generatedAt)
          : DATA.generatedAt || null;
      case "expected":
      case "schedule":
      default:
        return DATA.generatedAt || null;
    }
  }

  function pageUpdatedMeta(iso) {
    if (!iso) return { text: "", title: null };
    const when = fmtMarketsUpdated(iso);
    if (!when) return { text: "", title: null };
    return {
      text: `Updated ${when}`,
      title: `Data refreshed ${String(iso).replace("T", " ").replace("Z", " UTC")}`,
    };
  }

  function syncPageUpdatedFooter(node, iso) {
    if (!node) return;
    const { text, title } = pageUpdatedMeta(iso);
    if (!text) {
      node.textContent = "";
      setTip(node, "");
      node.hidden = true;
      return;
    }
    node.textContent = text;
    if (title) setTip(node, title);
    else setTip(node, "");
    node.hidden = false;
  }

  function optaPaginationDatasetKey() {
    return [
      state.season,
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
      state.sortKey,
      state.sortDir,
      state.showNewPrice ? 1 : 0,
    ].join("|");
  }

  function bindOptaPagination() {
    if (!el.optaPagination || el.optaPagination._bound) return;
    el.optaPagination._bound = true;
    el.optaPagination.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-stats-page]");
      if (!btn || btn.disabled || !el.optaPagination.contains(btn)) return;
      const next = Number(btn.dataset.statsPage);
      if (!Number.isFinite(next) || next < 1 || next === state.statsPage) return;
      state.statsPage = next;
      renderTable({ resetScroll: true });
    });
  }

  function syncOptaTableFooter(sorted) {
    const footer = el.optaTableFooter;
    const nav = el.optaPagination;
    const updated = el.optaUpdatedText;
    if (!footer) return;
    if (state.page !== "opta") {
      footer.hidden = true;
      return;
    }

    const { text, title } = pageUpdatedMeta(pageDataUpdatedIso("opta"));
    if (updated) {
      updated.textContent = text;
      if (title) setTip(updated, title);
      else setTip(updated, "");
      updated.hidden = !text;
    }

    const total = Array.isArray(sorted) ? sorted.length : 0;
    const pageSize = state.statsPageSize || 50;
    const totalPages = Math.max(1, Math.ceil(total / pageSize) || 1);
    const page = Math.min(Math.max(1, state.statsPage || 1), totalPages);
    const showNav = total > pageSize;

    if (nav) {
      if (!showNav) {
        nav.innerHTML = "";
        nav.hidden = true;
      } else {
        const start = (page - 1) * pageSize + 1;
        const end = Math.min(page * pageSize, total);
        nav.hidden = false;
        nav.innerHTML = `
          <button type="button" class="ghost-btn opta-page-btn" data-stats-page="${page - 1}" ${page <= 1 ? "disabled" : ""} aria-label="Previous page">Prev</button>
          <span class="opta-pagination-status">
            <span class="opta-pagination-page">${page} of ${totalPages}</span>
            <span class="opta-pagination-range">${start.toLocaleString()}–${end.toLocaleString()}</span>
          </span>
          <button type="button" class="ghost-btn opta-page-btn" data-stats-page="${page + 1}" ${page >= totalPages ? "disabled" : ""} aria-label="Next page">Next</button>
        `;
        bindOptaPagination();
      }
    }

    footer.hidden = !text && !showNav;
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
        else parts.push(state.marketsCompare === "24h" ? "vs last 24h" : "vs last 72h");
      } else {
        parts.push(
          state.marketsCompare === "24h" ? "No ~24h snapshot yet" : "No ~72h snapshot yet"
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
    if (state.marketsCompare === "24h") return 24;
    if (state.marketsCompare === "72h") return 72;
    return 0;
  }

  function pickMarketsHistorySnapshot(hoursAgo) {
    const hist = Array.isArray(MARKETS.history) ? MARKETS.history : [];
    if (!hist.length || !hoursAgo) return null;
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
    const hours = marketsCompareHours();
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
    const toolbar = el.marketsToolbar;
    const sheetHost = el.marketsControls;
    const toolbarHome =
      el.subtoolbar && el.subtoolbar.querySelector(".topbar-end-cluster");
    if (toolbar && sheetHost && toolbarHome) {
      if (marketsMobile) {
        if (toolbar.parentElement !== sheetHost) sheetHost.appendChild(toolbar);
      } else if (toolbar.parentElement !== toolbarHome) {
        toolbarHome.insertBefore(toolbar, toolbarHome.firstChild);
      }
    }
    if (sheetHost && marketsDesktop) {
      sheetHost.hidden = true;
      sheetHost.classList.add("is-collapsed");
    }
    if (el.marketsSlidersToggle && el.marketsHeaderTop) {
      if (
        el.marketsSlidersToggle.parentElement !== el.marketsHeaderTop &&
        el.marketsSlidersToggle.parentElement !== el.mobileFilterDock
      ) {
        el.marketsHeaderTop.appendChild(el.marketsSlidersToggle);
      }
      el.marketsSlidersToggle.hidden = !marketsMobile;
    }
    syncMobileChrome();
  }

  function marketsScorelineCompareStripHTML(goalsH, goalsA, csH, csA, homeBase, awayBase, homeCode, awayCode) {
    if (state.marketsCompare === "current") return "";
    const pastGH =
      homeBase && Number.isFinite(Number(homeBase.goals)) ? Number(homeBase.goals) : null;
    const pastGA =
      awayBase && Number.isFinite(Number(awayBase.goals)) ? Number(awayBase.goals) : null;
    const pastCH =
      homeBase && Number.isFinite(Number(homeBase.cs)) ? Number(homeBase.cs) : null;
    const pastCA =
      awayBase && Number.isFinite(Number(awayBase.cs)) ? Number(awayBase.cs) : null;
    const side = (code, goals, cs, pastG, pastC, role) => {
      const crest = playerCrestHTML(code) || `<span class="markets-score-matrix-code">${escapeHtml(code || "?")}</span>`;
      return `<div class="markets-scoreline-delta-side markets-scoreline-delta-${role}">
        <span class="markets-scoreline-delta-team">${crest}<span>${escapeHtml(code || "—")}</span></span>
        <span class="markets-scoreline-delta-stat" title="Projected goals">
          <span class="markets-scoreline-delta-lab">G</span>
          <span class="markets-stat-value" data-count-to="${Number(goals)}" data-count-decimals="2">${Number(goals).toFixed(2)}</span>
          ${marketsStatDeltaHTML(Number(goals), pastG, { decimals: 2, kind: "goals" })}
        </span>
        <span class="markets-scoreline-delta-stat" title="Clean sheet %">
          <span class="markets-scoreline-delta-lab">CS</span>
          <span class="markets-stat-value" data-count-to="${Math.round(Number(cs))}" data-count-decimals="0" data-count-suffix="%">${Math.round(Number(cs))}%</span>
          ${marketsStatDeltaHTML(Number(cs), pastC, { decimals: 0, suffix: "%", kind: "cs" })}
        </span>
      </div>`;
    };
    return `<div class="markets-scoreline-deltas" aria-label="Goals and CS% vs earlier odds pull">
      ${side(homeCode, goalsH, csH, pastGH, pastCH, "home")}
      ${side(awayCode, goalsA, csA, pastGA, pastCA, "away")}
    </div>`;
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
      const compareStrip = marketsScorelineCompareStripHTML(
        goalsH,
        goalsA,
        csH,
        csA,
        homeBase,
        awayBase,
        homeCode,
        awayCode
      );
      return `<article class="markets-card markets-card-scoreline${hasMatrix ? " markets-card-matrix" : ""}${compareCls}">
        <div class="markets-body markets-body-scoreline">
          <div class="markets-scoreline-head">
            <span class="markets-col-head markets-col-head-team markets-kickoff"${kickLabel ? ` title="${escapeHtml(kickLabel)}"` : ""}>${escapeHtml(when.time || "")}</span>
          </div>
          ${compareStrip}
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

  // Live page — DefCon progress tracker
  // ---------------------------------------------------------------------
  const LIVE_POS_BY_TYPE = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

  function liveDefaultGw() {
    const homeGw = Number(HOME && HOME.gw);
    if (Number.isFinite(homeGw) && homeGw > 0) return homeGw;
    const cur = Number(
      (DATA.gameweeks && DATA.gameweeks.current) ||
        (DATA.fixturesMeta && DATA.fixturesMeta.currentGw)
    );
    if (Number.isFinite(cur) && cur > 0) return cur;
    return 1;
  }

  function liveEgIsActive(eg) {
    return !!(eg && (eg.live || eg.status === "live"));
  }

  /** In-play only — ignore stale live flags once status is finished. */
  function liveEgIsInPlay(eg) {
    if (!eg || typeof eg !== "object") return false;
    const status = String(eg.status || "").toLowerCase();
    if (status === "finished") return false;
    return !!(eg.live || status === "live");
  }

  function homeSquadFixtureIsInPlay(fx) {
    if (!homeTrustLiveMatchState()) return false;
    return !!(fx && fx.live && !fx.finished);
  }

  function homeSquadRowIsInPlay(row) {
    if (!homeTrustLiveMatchState()) return false;
    if (!row) return false;
    if (row.matchStatus === "finished") return false;
    if (row.live) return true;
    return (row.fixtures || []).some((fx) => homeSquadFixtureIsInPlay(fx));
  }

  /** True when at least one fixture in the current GW is in play. */
  function liveGwHasActiveGames() {
    const gw = liveDefaultGw();
    const homeGw = Number(HOME && HOME.gw);
    const trustHomeLive = homeTrustLiveMatchState();
    if (
      trustHomeLive
      && Number.isFinite(homeGw)
      && homeGw === gw
      && HOME.elementGw
      && typeof HOME.elementGw === "object"
    ) {
      for (const eg of Object.values(HOME.elementGw)) {
        if (liveEgIsInPlay(eg)) return true;
      }
    }
    if (trustHomeLive && Number.isFinite(homeGw) && homeGw === gw && Array.isArray(HOME.squad)) {
      for (const row of HOME.squad) {
        if (homeSquadRowIsInPlay(row)) return true;
      }
    }
    const baked = (DATA.defconByGw || {})[String(gw)] || (DATA.defconByGw || {})[gw] || {};
    for (const eg of Object.values(baked)) {
      if (liveEgIsInPlay(eg)) return true;
    }
    return false;
  }

  function syncLiveNavChrome() {
    document.documentElement.classList.toggle("has-gw-live", liveGwHasActiveGames());
  }

  function liveElementMapForGw(gw) {
    const baked = (DATA.defconByGw || {})[String(gw)] || (DATA.defconByGw || {})[gw] || {};
    const homeGw = Number(HOME && HOME.gw);
    if (!(Number.isFinite(homeGw) && homeGw === gw && HOME.elementGw && typeof HOME.elementGw === "object")) {
      return baked;
    }
    const out = { ...baked };
    for (const [id, eg] of Object.entries(HOME.elementGw)) {
      if (!eg || typeof eg !== "object") continue;
      out[id] = { ...(baked[id] || {}), ...eg };
    }
    return out;
  }

  function livePlayerByElement() {
    if (livePlayerByElementCache) return livePlayerByElementCache;
    const map = new Map();
    const rows = (season2627Data().players && season2627Data().players.combined) || [];
    for (const row of rows) {
      if (!row) continue;
      let eid = row.element != null ? Number(row.element) : NaN;
      if (!Number.isFinite(eid)) eid = Number(fplElementIdForRow(row));
      if (!Number.isFinite(eid)) continue;
      map.set(eid, row);
    }
    livePlayerByElementCache = map;
    return map;
  }

  function liveMatchupsForGw(gw) {
    const seen = new Set();
    const out = [];
    const pushMatchup = (home, away, kickoff) => {
      if (!home || !away) return;
      const key = `${home}|${away}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ id: key, home, away, kickoff: kickoff || null });
    };

    // Upcoming schedule (fixturesByTeam drops finished GWs after FT).
    for (const [team, list] of Object.entries(FIXTURES_BY_TEAM)) {
      for (const fx of list || []) {
        if (Number(fx.gw) !== gw) continue;
        const home = fx.ha === "H" ? team : fx.opp;
        const away = fx.ha === "H" ? fx.opp : team;
        pushMatchup(home, away, fx.kickoff);
      }
    }

    // Finished / in-play GWs still marked current — keep Bonus cards until next GW.
    if (!out.length) {
      const baked =
        (DATA.liveFixturesByGw || {})[String(gw)] || (DATA.liveFixturesByGw || {})[gw] || [];
      for (const fx of baked) {
        if (!fx) continue;
        pushMatchup(fx.home, fx.away, fx.kickoff);
      }
    }

    // Last resort: pair clubs from elementGw fixtureIds (works before rebuild).
    if (!out.length) {
      const egMap = liveElementMapForGw(gw);
      const byElement = livePlayerByElement();
      const byFx = new Map();
      for (const [eidStr, eg] of Object.entries(egMap)) {
        if (!eg || eg.fixtureId == null) continue;
        const player = byElement.get(Number(eidStr));
        if (!player) continue;
        const team = player.team || currentTeamCode(player);
        if (!team) continue;
        const fid = String(eg.fixtureId);
        if (!byFx.has(fid)) byFx.set(fid, new Set());
        byFx.get(fid).add(team);
      }
      const kickoffByTeam = new Map();
      if (HOME && Array.isArray(HOME.squad)) {
        for (const row of HOME.squad) {
          const team = row.team || currentTeamCode(row);
          for (const fx of homeSquadFixtures(row)) {
            if (fx && fx.kickoff && team && !kickoffByTeam.has(team)) {
              kickoffByTeam.set(team, fx.kickoff);
            }
          }
        }
      }
      for (const teams of byFx.values()) {
        const codes = Array.from(teams).sort();
        if (codes.length < 2) continue;
        const home = codes[0];
        const away = codes[1];
        pushMatchup(home, away, kickoffByTeam.get(home) || kickoffByTeam.get(away) || null);
      }
    }

    out.sort((a, b) => {
      const ka = a.kickoff || "";
      const kb = b.kickoff || "";
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
    return out;
  }

  function liveBuildRows(gw, opts = {}) {
    const includeGk = opts.includeGk === true;
    const egMap = liveElementMapForGw(gw);
    const byElement = livePlayerByElement();
    const matchups = liveMatchupsForGw(gw);
    const matchupByTeam = new Map();
    for (const m of matchups) {
      matchupByTeam.set(m.home, m.id);
      matchupByTeam.set(m.away, m.id);
    }
    const rows = [];
    for (const [eidStr, eg] of Object.entries(egMap)) {
      const eid = Number(eidStr);
      const etype = Number(eg.elementType) || 0;
      const pos = LIVE_POS_BY_TYPE[etype];
      if (!pos) continue;
      if (!includeGk && pos === "GK") continue;
      const mins = Number(eg.minutes) || 0;
      const bps = Number(eg.bps) || 0;
      if (includeGk && opts.forBonus && mins <= 0 && bps <= 0) continue;
      // Outfield players who played, or currently live (0' still shown).
      if (!includeGk && mins <= 0 && !(!!eg.live || eg.status === "live")) continue;
      if (includeGk && !opts.forBonus && mins <= 0 && !(!!eg.live || eg.status === "live")) continue;
      const player = byElement.get(eid);
      if (!player) continue;
      const team = player.team || currentTeamCode(player);
      const matchupId = matchupByTeam.get(team) || null;
      const rule = DEFCON_RULES[pos];
      const threshold = rule ? rule.threshold : null;
      const actions = pos === "GK" ? null : liveDefconActions(eg, pos);
      rows.push({
        player,
        eg,
        eid,
        pos,
        team,
        matchupId,
        threshold,
        actions: actions == null ? 0 : actions,
        minutes: mins,
        live: liveEgIsInPlay(eg),
        status: eg.status || "scheduled",
        progress: threshold ? Math.min(1, (actions == null ? 0 : actions) / threshold) : 0,
      });
    }
    return rows;
  }

  function liveDefconActions(eg, pos) {
    const rule = DEFCON_RULES[pos];
    if (!rule || !eg) return null;
    const raw = eg[rule.field];
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function liveDefconBarVisual(actions, threshold) {
    const thr = Number(threshold) || 1;
    const acts = Number.isFinite(Number(actions)) ? Math.max(0, Number(actions)) : 0;
    const pct = Math.min(100, (acts / thr) * 100);
    const hit = acts >= thr;
    const scale = pct < 0.5 ? 0 : Number((pct / 100).toFixed(4));
    return {
      barPct: pct,
      complete: hit,
      // scaleX is far more reliable than clip-path on iOS Safari.
      fillStyle: `--defcon-scale:${scale};--defcon-units:${thr}`,
    };
  }

  function liveAchievedDotHTML(actions, threshold, pos) {
    if (!Number.isFinite(actions) || actions < threshold) return "";
    const title = `DefCon achieved — ${actions} ≥ ${threshold} ${pos} actions (+2 pts)`;
    return `<span class="threshold-dot live-defcon-achieved live-dc-check-enter"${tipAttr(title)}><svg class="check-mark-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg></span>`;
  }

  let liveFeedEvents = [];
  let liveFeedSnapshot = null;
  let liveFeedGw = null;
  let liveFeedSeq = 0;
  let liveFeedIngestFp = "";
  let livePlayerByElementCache = null;
  let homeFeedAllRendered = false;

  function liveFeedEgMapFingerprint(egMap) {
    if (!egMap || typeof egMap !== "object") return "";
    let count = 0;
    let goals = 0;
    let maxMins = 0;
    let pts = 0;
    let minsSum = 0;
    let liveCount = 0;
    for (const row of Object.values(egMap)) {
      if (!row || typeof row !== "object") continue;
      count += 1;
      goals += Number(row.goals) || 0;
      const mins = Number(row.minutes) || 0;
      maxMins = Math.max(maxMins, mins);
      minsSum += mins;
      pts += Number(row.pts) || 0;
      if (row.live || String(row.status || "").toLowerCase() === "live") liveCount += 1;
    }
    return `${count}:${goals}:${maxMins}:${pts}:${minsSum}:${liveCount}`;
  }

  function liveFeedResetIfGwChanged(gw) {
    if (liveFeedGw === gw) return;
    liveFeedGw = gw;
    liveFeedEvents = [];
    liveFeedSnapshot = null;
    liveFeedSeq = 0;
    liveFeedIngestFp = "";
    homeFeedAllRendered = false;
  }

  function liveFeedSnapRecord(eg) {
    if (!eg || typeof eg !== "object") return null;
    return {
      pts: Number(eg.pts) || 0,
      minutes: Number(eg.minutes) || 0,
      bps: Number(eg.bps) || 0,
      bonusEff: 0,
      goals: Number(eg.goals) || 0,
      assists: Number(eg.assists) || 0,
      cleanSheets: Number(eg.cleanSheets) || 0,
      saves: Number(eg.saves) || 0,
      bonus: Number(eg.bonus) || 0,
      yellowCards: Number(eg.yellowCards) || 0,
      redCards: Number(eg.redCards) || 0,
      ownGoals: Number(eg.ownGoals) || 0,
      penaltiesMissed: Number(eg.penaltiesMissed) || 0,
      penaltiesSaved: Number(eg.penaltiesSaved) || 0,
      defConHit: !!eg.defConHit,
    };
  }

  /** Effective bonus pts: FPL bonus when set, else BPS rank projection (3/2/1). */
  function liveFeedEffectiveBonus(rank, apiBonus) {
    const b = Number(apiBonus) || 0;
    if (b > 0) return b;
    const r = Number(rank) || 0;
    if (r >= 1 && r <= 3) return 4 - r;
    return 0;
  }

  /** Players on both clubs in this fixture — used for kickoff/clock, not GW-total mins. */
  function liveFeedMatchupEgEntries(matchup, egMap, byElement) {
    const entries = [];
    if (!matchup) return entries;
    for (const [eidStr, eg] of Object.entries(egMap || {})) {
      if (!eg || typeof eg !== "object") continue;
      const player = byElement.get(Number(eidStr));
      if (!player) continue;
      const team = player.team || currentTeamCode(player);
      if (team !== matchup.home && team !== matchup.away) continue;
      entries.push({
        live: liveEgIsInPlay(eg),
        minutes: Number(eg.minutes) || 0,
        eg,
      });
    }
    return entries;
  }

  /**
   * Feed bonus only after this match’s clock hits 60′ (or FT).
   * In-play minutes only — ignore teammates who already finished a different GW fixture,
   * and do not treat FPL `bonus > 0` as a gate (that can fire well before 60′).
   */
  function liveFeedMatchupBonusEligibleMap(matchups, egMap, byElement) {
    const eligible = new Map();
    for (const m of matchups || []) {
      const entries = liveFeedMatchupEgEntries(m, egMap, byElement);
      const { isLive, finished } = liveMatchupKickoffState(m, entries);
      if (finished) {
        eligible.set(m.id, true);
        continue;
      }
      if (!isLive) {
        eligible.set(m.id, false);
        continue;
      }
      const clock = liveMatchupFixtureMinutes(m, entries);
      eligible.set(m.id, (Number(clock) || 0) >= 60);
    }
    return eligible;
  }

  function liveFeedBonusRankByFixture(egMap, byElement, matchupByTeam, matchupBonusEligible) {
    const byFixture = new Map();
    for (const [eidStr, eg] of Object.entries(egMap || {})) {
      if (!eg || typeof eg !== "object") continue;
      const etype = Number(eg.elementType) || 0;
      if (!LIVE_POS_BY_TYPE[etype]) continue;
      const mins = Number(eg.minutes) || 0;
      const bps = Number(eg.bps) || 0;
      const live = !!eg.live || eg.status === "live";
      if (mins <= 0 && bps <= 0 && !live) continue;
      const player = byElement.get(Number(eidStr));
      if (!player) continue;
      const team = player.team || currentTeamCode(player);
      const matchupId = matchupByTeam.get(team);
      if (!matchupId) continue;
      if (matchupBonusEligible && !matchupBonusEligible.get(matchupId)) continue;
      if (!byFixture.has(matchupId)) byFixture.set(matchupId, []);
      byFixture.get(matchupId).push({
        eidStr,
        bps,
        apiBonus: Number(eg.bonus) || 0,
      });
    }
    const result = new Map();
    for (const entries of byFixture.values()) {
      entries.sort((a, b) => {
        if (b.bps !== a.bps) return b.bps - a.bps;
        return Number(a.eidStr) - Number(b.eidStr);
      });
      entries.forEach((entry, i) => {
        const rank = i + 1;
        result.set(entry.eidStr, {
          rank,
          bps: entry.bps,
          apiBonus: entry.apiBonus,
          effectiveBonus: liveFeedEffectiveBonus(rank, entry.apiBonus),
        });
      });
    }
    return result;
  }

  function liveFeedBonusProjLabel(oldEff, newEff, rank, apiBonus) {
    const o = Number(oldEff) || 0;
    const n = Number(newEff) || 0;
    const d = n - o;
    if (n === 0 && o > 0) return "Out of bonus";
    if (o === 0 && n > 0) {
      if (apiBonus > 0) return n === 1 ? "Bonus point" : `${n} bonus pts`;
      if (n === 3) return "Leads bonus (+3)";
      if (n === 2) return "2nd in bonus (+2)";
      return "3rd in bonus (+1)";
    }
    if (d > 0) {
      return apiBonus > 0
        ? d === 1 ? "Bonus point" : `${d} bonus pts`
        : d === 1 ? "Bonus proj +1" : `Bonus proj +${d}`;
    }
    if (apiBonus > 0) return Math.abs(d) === 1 ? "Bonus −1" : `Bonus −${Math.abs(d)}`;
    return Math.abs(d) === 1 ? "Bonus proj −1" : `Bonus proj −${Math.abs(d)}`;
  }

  function liveFeedApplyBonusEff(nextSnap, bonusMeta) {
    for (const [eidStr, rec] of Object.entries(nextSnap)) {
      const meta = bonusMeta.get(eidStr);
      rec.bonusEff = meta ? meta.effectiveBonus : 0;
    }
  }

  function liveFeedPushBonusProjDiffs(oldSnap, nextSnap, egMap, byElement, matchupByTeam, gw, newEvents, runPtsByEid, { seeding, matchupBonusEligible } = {}) {
    if (seeding || !oldSnap) return;
    const bonusMeta = liveFeedBonusRankByFixture(egMap, byElement, matchupByTeam, matchupBonusEligible);
    liveFeedApplyBonusEff(nextSnap, bonusMeta);
    for (const eidStr of Object.keys(nextSnap)) {
      const old = oldSnap[eidStr];
      if (!old) continue;
      const oldEff = Number(old.bonusEff) || 0;
      const newEff = Number(nextSnap[eidStr].bonusEff) || 0;
      if (newEff === oldEff) continue;

      const eg = egMap[eidStr];
      const eid = Number(eidStr);
      const etype = Number(eg && eg.elementType) || 0;
      const pos = LIVE_POS_BY_TYPE[etype];
      if (!pos) continue;
      const player = byElement.get(eid);
      if (!player) continue;
      const team = player.team || currentTeamCode(player);
      const matchupId = matchupByTeam.get(team) || null;
      if (matchupBonusEligible && (!matchupId || !matchupBonusEligible.get(matchupId))) continue;
      const meta = bonusMeta.get(eidStr) || { rank: 0, apiBonus: 0 };
      const delta = newEff - oldEff;
      if (!delta) continue;
      const snapPts = Number(nextSnap[eidStr].pts) || 0;
      let runPts = runPtsByEid.get(eidStr);
      if (runPts == null) runPts = Number(old.pts) || 0;
      runPts += delta;
      if (snapPts > 0) runPts = Math.max(runPts, snapPts);
      runPtsByEid.set(eidStr, runPts);
      newEvents.push(
        liveFeedMakeEvent({
          eid,
          gw,
          player,
          pos,
          team,
          matchupId,
          live: liveEgIsInPlay(eg),
          kind: "bonus",
          label: liveFeedBonusProjLabel(oldEff, newEff, meta.rank, meta.apiBonus),
          ptsDelta: delta,
          colKey: "bonus",
          totalPts: runPts,
          ts: Date.now(),
        })
      );
    }
  }

  function liveFeedGoalPts(pos) {
    if (pos === "GK" || pos === "DEF") return 6;
    if (pos === "MID") return 5;
    return 4;
  }

  function liveFeedCleanSheetPts(pos) {
    if (pos === "GK" || pos === "DEF") return 4;
    if (pos === "MID") return 1;
    return 0;
  }

  function liveFeedEntryMultiplier(entryId, eid) {
    const squads = HOME && HOME.squadsByEntry;
    if (!squads) return 0;
    const squad = squads[String(entryId)] || squads[entryId];
    if (!Array.isArray(squad)) return 0;
    const pick = squad.find((p) => Number(p.element) === Number(eid));
    if (!pick) return 0;
    return Math.max(0, Number(pick.multiplier) || 1);
  }

  function liveFeedImpactMeta(eid, ptsDelta) {
    const delta = Number(ptsDelta);
    if (!Number.isFinite(delta) || delta === 0) {
      return { net: 0, note: "No points change." };
    }
    const myEntry = Number(savedManagerId);
    if (!myEntry || !HOME || !Array.isArray(HOME.standings) || !HOME.standings.length) {
      return { net: 0, note: "Set manager + league in Preferences for league impact." };
    }
    const opponents = HOME.standings.filter((s) => Number(s.entry) !== myEntry);
    if (!opponents.length) {
      return { net: 0, note: "No league opponents loaded." };
    }
    const myMult = liveFeedEntryMultiplier(myEntry, eid);
    let oppMultSum = 0;
    for (const opp of opponents) oppMultSum += liveFeedEntryMultiplier(opp.entry, eid);
    const avgOppMult = oppMultSum / opponents.length;
    const net = delta * (myMult - avgOppMult);
    let note = "";
    if (myMult <= 0 && avgOppMult <= 0) note = "No league managers own him.";
    else if (myMult <= 0 && avgOppMult > 0) note = "You don't own him — rivals gain on average.";
    else if (myMult > 0 && avgOppMult <= 0) {
      note = myMult >= 2 ? "Only your team — captain doubles the edge." : "Only your team owns him.";
    } else if (Math.abs(net) < 0.05) note = "League-wide ownership — no differential.";
    else if (net > 0) note = myMult >= 2 ? "Your captain gives you the edge." : "You gain vs average opponent.";
    else note = "Rivals benefit more on average.";
    return { net, note, myMult, avgOppMult };
  }

  /** League impact at paint time — never freeze the seed-time HOME/manager snapshot. */
  function liveFeedEventImpact(ev) {
    if (!ev) return { net: 0, note: "" };
    return liveFeedImpactMeta(ev.eid, ev.ptsDelta);
  }

  function liveFeedMakeEvent(raw) {
    liveFeedSeq += 1;
    return {
      id: `${raw.gw}-${raw.eid}-${raw.kind}-${liveFeedSeq}`,
      seq: liveFeedSeq,
      ...raw,
    };
  }

  function liveFeedEventSortKey(ev) {
    const ts = Number(ev && ev.ts) || 0;
    const seq = Number(ev && ev.seq) || 0;
    return ts * 1e6 + seq;
  }

  function liveFeedDiffCounter(oldVal, newVal, fn) {
    const o = Number(oldVal) || 0;
    const n = Number(newVal) || 0;
    const d = n - o;
    if (d <= 0) return;
    // One feed row per stat unit — never batch "2 goals +8" from a single diff.
    for (let i = 0; i < d; i += 1) {
      fn(1, o + i + 1);
    }
  }

  function liveFeedDiffMinutes(oldM, newM, push) {
    const o = Number(oldM) || 0;
    const n = Number(newM) || 0;
    if (o <= 0 && n > 0) {
      if (n >= 60) {
        push("appearance", "Appearance", 1, "pts");
        push("minutes60", "60+ minutes", 1, "pts");
      } else {
        push("appearance", "Appearance", 1, "pts");
      }
    } else if (o > 0 && o < 60 && n >= 60) {
      push("minutes60", "60+ minutes", 1, "pts");
    }
  }

  function liveFeedPushStatDiffs(oldRec, newRec, pos, push, { skipMinutes = false } = {}) {
    if (!skipMinutes) liveFeedDiffMinutes(oldRec.minutes, newRec.minutes, push);
    liveFeedDiffCounter(oldRec.goals, newRec.goals, () =>
      push("goal", "Goal", liveFeedGoalPts(pos), "goals")
    );
    liveFeedDiffCounter(oldRec.assists, newRec.assists, () =>
      push("assist", "Assist", 3, "assists")
    );
    liveFeedDiffCounter(oldRec.cleanSheets, newRec.cleanSheets, () => {
      const p = liveFeedCleanSheetPts(pos);
      if (!p) return;
      push("cleanSheet", "Clean sheet", p, "cleanSheets");
    });
    const oldSavePts = Math.floor((Number(oldRec.saves) || 0) / 3);
    const newSavePts = Math.floor((Number(newRec.saves) || 0) / 3);
    if (newSavePts > oldSavePts) {
      push("saves", "Save points", newSavePts - oldSavePts, "saves");
    }
    // Bonus — liveFeedPushBonusProjDiffs (BPS rank + FPL bonus field).
    liveFeedDiffCounter(oldRec.yellowCards, newRec.yellowCards, () =>
      push("yellowCard", "Yellow card", -1, "yellowCards")
    );
    liveFeedDiffCounter(oldRec.redCards, newRec.redCards, () =>
      push("redCard", "Red card", -3, "redCards")
    );
    liveFeedDiffCounter(oldRec.ownGoals, newRec.ownGoals, () =>
      push("ownGoal", "Own goal", -2, "ownGoals")
    );
    liveFeedDiffCounter(oldRec.penaltiesMissed, newRec.penaltiesMissed, () =>
      push("penMissed", "Penalty missed", -2, "penaltiesMissed")
    );
    liveFeedDiffCounter(oldRec.penaltiesSaved, newRec.penaltiesSaved, () =>
      push("penSaved", "Penalty saved", 5, "penaltiesSaved")
    );
    if (!oldRec.defConHit && newRec.defConHit) {
      push("defCon", "DefCon", 2, "defConHit");
    }
  }

  const LIVE_FEED_EMPTY_REC = {
    minutes: 0,
    goals: 0,
    assists: 0,
    cleanSheets: 0,
    saves: 0,
    bonus: 0,
    yellowCards: 0,
    redCards: 0,
    ownGoals: 0,
    penaltiesMissed: 0,
    penaltiesSaved: 0,
    defConHit: false,
  };

  /** Estimated event minute within a fixture — used for deterministic feed ordering. */
  const LIVE_FEED_KIND_MINUTE = {
    appearance: 1,
    minutes60: 60,
    goal: 22,
    assist: 24,
    cleanSheet: 88,
    saves: 40,
    yellowCard: 32,
    redCard: 48,
    ownGoal: 26,
    penMissed: 52,
    penSaved: 52,
    defCon: 62,
    bonus: 91,
  };

  function liveFeedKickoffMs(matchup) {
    if (!matchup || !matchup.kickoff) return 0;
    const ms = Date.parse(matchup.kickoff);
    return Number.isFinite(ms) ? ms : 0;
  }

  function liveFeedEventTs(matchup, kind, index, eid, eg) {
    const kick = liveFeedKickoffMs(matchup);
    let minute = (LIVE_FEED_KIND_MINUTE[kind] ?? 45) + index;
    if (matchup && eg && liveEgIsInPlay(eg)) {
      const playerMins = Number(eg.minutes) || 0;
      if (
        playerMins > 0
        && ["goal", "assist", "ownGoal", "yellowCard", "redCard", "penMissed", "penSaved", "defCon"].includes(kind)
      ) {
        minute = Math.max(minute, playerMins);
      }
    }
    const eidSkew = Number.isFinite(Number(eid)) ? (Number(eid) % 500) : 0;
    return kick + minute * 60_000 + eidSkew;
  }

  function liveFeedBonusEventTs(matchup, entries, rank, eid) {
    const kick = liveFeedKickoffMs(matchup);
    const { isLive } = liveMatchupKickoffState(matchup, entries);
    const rankSkew = Math.max(0, 4 - (Number(rank) || 0));
    if (isLive) {
      const mins = Math.max(60, Number(liveMatchupFixtureMinutes(matchup, entries)) || 60);
      return kick + mins * 60_000 + rankSkew * 1000 + (Number(eid) % 500);
    }
    return kick + (91 + rankSkew) * 60_000 + (Number(eid) % 500);
  }

  function liveFeedBuildPlayerEvents(rec, ctx, matchup, eg) {
    const events = [];
    const kindCounts = new Map();
    let runPts = 0;
    const push = (kind, label, ptsDelta, colKey) => {
      if (!ptsDelta) return;
      runPts += ptsDelta;
      const idx = kindCounts.get(kind) || 0;
      kindCounts.set(kind, idx + 1);
      events.push(liveFeedMakeEvent({
        ...ctx,
        kind,
        label,
        ptsDelta,
        colKey,
        totalPts: runPts,
        ts: liveFeedEventTs(matchup, kind, idx, ctx.eid, eg),
      }));
    };
    liveFeedPushStatDiffs(LIVE_FEED_EMPTY_REC, rec, ctx.pos, push);
    if (events.length && Number.isFinite(Number(rec.pts))) {
      events[events.length - 1].totalPts = Number(rec.pts);
    }
    return events;
  }

  /** Rebuild feed from current elementGw — same data → same order on every client. */
  function liveFeedBuildEvents(gw, egMap) {
    const byElement = livePlayerByElement();
    const matchups = liveMatchupsForGw(gw);
    const matchupByTeam = new Map();
    const matchupById = new Map();
    for (const m of matchups) {
      matchupByTeam.set(m.home, m.id);
      matchupByTeam.set(m.away, m.id);
      matchupById.set(m.id, m);
    }
    const matchupBonusEligible = liveFeedMatchupBonusEligibleMap(matchups, egMap, byElement);
    const bonusMeta = liveFeedBonusRankByFixture(egMap, byElement, matchupByTeam, matchupBonusEligible);
    const events = [];

    const eidKeys = Object.keys(egMap || {}).sort((a, b) => Number(a) - Number(b));
    for (const eidStr of eidKeys) {
      const eg = egMap[eidStr];
      const rec = liveFeedSnapRecord(eg);
      if (!rec) continue;
      rec.bonusEff = (bonusMeta.get(eidStr) || {}).effectiveBonus || 0;

      const etype = Number(eg.elementType) || 0;
      const pos = LIVE_POS_BY_TYPE[etype];
      if (!pos) continue;

      const eid = Number(eidStr);
      const player = byElement.get(eid);
      if (!player) continue;
      const team = player.team || currentTeamCode(player);
      const matchupId = matchupByTeam.get(team) || null;
      const matchup = matchupId ? matchupById.get(matchupId) : null;
      const ctx = {
        eid,
        gw,
        player,
        pos,
        team,
        matchupId,
        live: liveEgIsInPlay(eg),
      };

      if (rec.minutes > 0 || rec.pts !== 0) {
        events.push(...liveFeedBuildPlayerEvents(rec, ctx, matchup, eg));
      }

      if (rec.bonusEff > 0 && matchupId && matchupBonusEligible.get(matchupId)) {
        const meta = bonusMeta.get(eidStr) || { rank: 0, apiBonus: 0 };
        const mEntries = liveFeedMatchupEgEntries(matchup, egMap, byElement);
        events.push(liveFeedMakeEvent({
          ...ctx,
          kind: "bonus",
          label: liveFeedBonusProjLabel(0, rec.bonusEff, meta.rank, meta.apiBonus),
          ptsDelta: rec.bonusEff,
          colKey: "bonus",
          totalPts: Number(rec.pts) || rec.bonusEff,
          ts: liveFeedBonusEventTs(matchup, mEntries, meta.rank, eid),
        }));
      }
    }
    return events;
  }

  function liveFeedIngest(gw, egMap) {
    if (!Number.isFinite(gw)) return;
    const fp = liveFeedEgMapFingerprint(egMap);
    if (liveFeedGw === gw && liveFeedIngestFp === fp && liveFeedEvents.length) return;
    if (liveFeedIngestFp && liveFeedIngestFp !== fp) homeFeedAllRendered = false;
    liveFeedResetIfGwChanged(gw);
    liveFeedIngestFp = fp;
    liveFeedSeq = 0;
    liveFeedEvents = liveFeedBuildEvents(gw, egMap);
    const nextSnap = {};
    for (const [eidStr, eg] of Object.entries(egMap || {})) {
      const rec = liveFeedSnapRecord(eg);
      if (rec) nextSnap[eidStr] = rec;
    }
    liveFeedSnapshot = nextSnap;
  }

  function liveFeedIsLeagueOwned(eid) {
    const owners = HOME && HOME.ownersByElement && HOME.ownersByElement[String(eid)];
    return Array.isArray(owners) && owners.length > 0;
  }

  function liveFeedFilterEvents(events, { homeEmbed = false, homeLeagueOnly = false } = {}) {
    let out = events;
    const gw = liveDefaultGw();
    if (Number.isFinite(gw)) {
      const byElement = livePlayerByElement();
      const bonusEligible = liveFeedMatchupBonusEligibleMap(
        liveMatchupsForGw(gw),
        liveElementMapForGw(gw),
        byElement
      );
      out = out.filter((e) => e.kind !== "bonus" || (e.matchupId && bonusEligible.get(e.matchupId)));
    }
    if (homeLeagueOnly || (!homeEmbed && state.liveFeedOwnedFilter === "league")) {
      out = out.filter((e) => liveFeedIsLeagueOwned(e.eid));
    }
    if (homeEmbed) return out;
    if (state.liveMatchups.size) {
      out = out.filter((e) => e.matchupId && state.liveMatchups.has(e.matchupId));
    }
    if (state.teamFilter.size) {
      out = out.filter((e) => state.teamFilter.has(e.team));
    }
    if (state.posFilter.size) {
      out = out.filter((e) => state.posFilter.has(e.pos));
    }
    if (state.liveStatus === "live") {
      out = out.filter((e) => e.live);
    } else if (state.liveStatus === "owned") {
      out = out.filter((e) => e.player && e.player.code != null && ownedCodes.has(e.player.code));
    }
    const q = state.search.trim().toLowerCase();
    if (q) {
      out = out.filter((e) => {
        const name = String(e.player.name || "").toLowerCase();
        const team = String(e.team || "").toLowerCase();
        return name.includes(q) || team.includes(q);
      });
    }
    return out;
  }

  function liveFeedSortEvents(events) {
    const dir = state.liveSortDir === "asc" ? 1 : -1;
    const key = state.liveSortKey;
    return events.slice().sort((a, b) => {
      let cmp = 0;
      if (key === "name") {
        cmp = String(a.player.name || "").localeCompare(String(b.player.name || ""));
      } else if (key === "impact") {
        cmp = liveFeedEventImpact(a).net - liveFeedEventImpact(b).net;
        if (cmp === 0) cmp = liveFeedEventSortKey(a) - liveFeedEventSortKey(b);
      } else {
        cmp = liveFeedEventSortKey(a) - liveFeedEventSortKey(b);
      }
      return cmp * dir;
    });
  }

  function liveFeedPtsDeltaHTML(ptsDelta, colKey, { homeEmbed = false } = {}) {
    const n = Number(ptsDelta);
    if (!Number.isFinite(n) || n === 0) return "";
    if (homeEmbed) {
      const roll = statRollSpan(n, {
        from: 0,
        decimals: 0,
        signed: true,
        className: "home-stat-roll home-feed-pts-roll",
        rollKind: "pts",
      });
      return livePointsPillHTML(colKey || (n > 0 ? "pts" : "yellowCards"), roll);
    }
    const sign = n > 0 ? "+" : "−";
    const text = `${sign}${Math.abs(n)}`;
    return livePointsPillHTML(colKey || (n > 0 ? "pts" : "yellowCards"), text);
  }

  function liveFeedImpactHTML(ev, { homeEmbed = false } = {}) {
    const net = liveFeedEventImpact(ev).net;
    if (!Number.isFinite(net)) return "";
    if (homeEmbed) {
      const netAbs = Math.abs(net);
      const decimals = Number.isInteger(netAbs) ? 0 : 1;
      const roll = statRollSpan(net, {
        from: 0,
        decimals,
        signed: true,
        className: "home-stat-roll home-feed-impact-roll",
      });
      return `<span class="live-feed-impact-val">${roll}</span>`;
    }
    const netAbs = Math.abs(net);
    const netSign = net >= 0 ? "+" : "−";
    const val = `${netSign}${netAbs.toFixed(1).replace(/\.0$/, "")}`;
    return `<span class="live-feed-impact-val">${escapeHtml(val)}</span><span class="live-feed-impact-suffix"> vs avg</span>`;
  }

  function liveFeedEventTotalPts(ev) {
    const stored = Number(ev.totalPts);
    if (Number.isFinite(stored)) return stored;
    const snap = liveFeedSnapshot && liveFeedSnapshot[String(ev.eid)];
    if (snap && Number.isFinite(Number(snap.pts))) return Number(snap.pts);
    const eg = liveElementMapForGw(ev.gw)[String(ev.eid)];
    if (eg && Number.isFinite(Number(eg.pts))) return Number(eg.pts);
    return null;
  }

  function liveFeedTotalPtsTone(total) {
    const n = Number(total);
    if (!Number.isFinite(n) || n < 3) return "is-pts";
    if (n >= 15) return "is-total-haul";
    if (n >= 10) return "is-total-hot";
    if (n >= 6) return "is-good";
    return "is-total-warm";
  }

  function liveFeedTotalPtsHTML(ev) {
    const total = liveFeedEventTotalPts(ev);
    if (total == null || !Number.isFinite(total)) return "";
    return livePointsPillHTML("pts", String(total), { tone: liveFeedTotalPtsTone(total) });
  }

  function liveFeedRowHTML(ev, enterI, { compact = false, homeEmbed = false } = {}) {
    const ptsHTML = liveFeedPtsDeltaHTML(ev.ptsDelta, ev.colKey, { homeEmbed: compact && homeEmbed });
    const totalHTML = liveFeedTotalPtsHTML(ev);
    const net = liveFeedEventImpact(ev).net;
    const impactCls = net > 0.05 ? "is-pos" : net < -0.05 ? "is-neg" : "is-neutral";
    const impactHTML = liveFeedImpactHTML(ev, { homeEmbed: compact && homeEmbed });
    const rowCls = compact ? "live-feed-row home-feed-row" : "live-feed-row";
    if (compact && homeEmbed) {
      return `<tr class="${rowCls}" style="--enter-i:${enterI}" data-element="${escapeHtml(String(ev.eid ?? ""))}" data-player-code="${escapeHtml(String(ev.player.code || ""))}">
      ${homeFeedPlayerCellHTML(ev.player, ev.pos)}
      <td class="home-col-feed-event"><span class="home-feed-event-label">${escapeHtml(ev.label)}</span></td>
      <td class="home-col-feed-impact col-num ${impactCls}">${impactHTML}</td>
      <td class="home-col-feed-pts col-num">${ptsHTML}</td>
    </tr>`;
    }
    if (compact) {
      return `<tr class="${rowCls}" style="--enter-i:${enterI}" data-element="${escapeHtml(String(ev.eid ?? ""))}" data-player-code="${escapeHtml(String(ev.player.code || ""))}">
      <td class="col-player">${livePointsIdentityHTML(ev.player, ev.pos)}</td>
      <td class="col-feed-event"><span class="live-feed-event-label">${escapeHtml(ev.label)}</span></td>
      <td class="col-feed-impact ${impactCls}">${impactHTML}</td>
      <td class="col-feed-pts col-num">${ptsHTML}</td>
    </tr>`;
    }
    return `<tr class="${rowCls}" style="--enter-i:${enterI}" data-element="${escapeHtml(String(ev.eid ?? ""))}" data-player-code="${escapeHtml(String(ev.player.code || ""))}">
      <td class="col-player">${livePointsIdentityHTML(ev.player, ev.pos)}</td>
      <td class="col-feed-event"><span class="live-feed-event-label">${escapeHtml(ev.label)}</span></td>
      <td class="col-feed-impact ${impactCls}">${impactHTML}</td>
      <td class="col-feed-pts col-num">${ptsHTML}</td>
      <td class="col-feed-total col-num">${totalHTML}</td>
    </tr>`;
  }

  function renderLiveFeedTable(
    gw,
    { headEl, bodyEl, countEl, compact = false, homeEmbed = false, homeLeagueOnly = false } = {}
  ) {
    if (!headEl || !bodyEl || !Number.isFinite(gw)) return 0;
    liveFeedIngest(gw, liveElementMapForGw(gw));
    let events = liveFeedEvents.filter((e) => e.gw === gw);
    events = liveFeedSortEvents(liveFeedFilterEvents(events, { homeEmbed, homeLeagueOnly }));
    if (compact) {
      headEl.innerHTML = homeEmbed
        ? `<tr>
        <th scope="col" class="home-col-player">Player</th>
        <th scope="col" class="home-col-feed-event">Event</th>
        <th scope="col" class="home-col-feed-impact col-num">Imp</th>
        <th scope="col" class="home-col-feed-pts col-num">Pts</th>
      </tr>`
        : `<tr>
        <th class="col-player">Player</th>
        <th class="col-feed-event">Event</th>
        <th class="col-feed-impact col-num">Imp</th>
        <th class="col-feed-pts col-num">Pts</th>
      </tr>`;
    } else {
      headEl.innerHTML = `<tr>
        <th class="col-player">Player</th>
        <th class="col-feed-event">Event</th>
        <th class="col-feed-impact col-num">Impact</th>
        <th class="col-feed-pts col-num">Pts</th>
        <th class="col-feed-total col-num">Total</th>
      </tr>`;
    }
    const colCount = compact ? 4 : 5;
    const emptyMsg = homeEmbed
      ? homeLeagueOnly
        ? "No league-owned events this GW."
        : "No events this GW."
      : "No events for the current filters.";
    if (!events.length) {
      bodyEl.innerHTML = `<tr class="live-empty-row"><td colspan="${colCount}">${emptyMsg}</td></tr>`;
    } else {
      bodyEl.innerHTML = events.map((ev, i) => liveFeedRowHTML(ev, i, { compact, homeEmbed })).join("");
    }
    if (countEl) {
      countEl.textContent = homeEmbed
        ? `${events.length} · GW${gw}`
        : `${events.length} event${events.length === 1 ? "" : "s"} · GW${gw}`;
    }
    return events.length;
  }

  function ensureHomeFeedAllRendered(gw) {
    if (homeFeedAllRendered || !homeSquadIsWideLayout()) return;
    if (!el.homeFeedAllHead || !el.homeFeedAllBody || !Number.isFinite(Number(gw))) return;
    homeFeedAllRendered = true;
    renderLiveFeedTable(Number(gw), {
      headEl: el.homeFeedAllHead,
      bodyEl: el.homeFeedAllBody,
      compact: true,
      homeEmbed: true,
      homeLeagueOnly: false,
    });
    syncHomeFeedCountLabel(homeFeedActivePageIndex());
  }

  function renderHomeFeed(gw, { includeAll = false } = {}) {
    if (!homeSquadIsWideLayout() || !el.homeFeedBody || !el.homeFeedHead) return;
    renderLiveFeedTable(gw, {
      headEl: el.homeFeedHead,
      bodyEl: el.homeFeedBody,
      compact: true,
      homeEmbed: true,
      homeLeagueOnly: true,
    });
    if (includeAll) ensureHomeFeedAllRendered(gw);
    syncHomeFeedCountLabel(homeFeedActivePageIndex());
  }

  function renderLiveFeed(gw) {
    renderLiveFeedTable(gw, {
      headEl: el.liveFeedHead,
      bodyEl: el.liveFeedBody,
      countEl: el.liveCountLabel,
    });
  }

  function liveFilteredRows(rows) {
    let out = rows;
    if (state.liveMatchups.size) {
      out = out.filter((r) => r.matchupId && state.liveMatchups.has(r.matchupId));
    }
    if (state.teamFilter.size) {
      out = out.filter((r) => state.teamFilter.has(r.team));
    }
    if (state.posFilter.size) {
      out = out.filter((r) => state.posFilter.has(r.pos));
    }
    if (state.liveStatus === "live") {
      out = out.filter((r) => r.live);
    } else if (state.liveStatus === "owned") {
      out = out.filter((r) => r.player && r.player.code != null && ownedCodes.has(r.player.code));
    }
    const q = state.search.trim().toLowerCase();
    if (q) {
      out = out.filter((r) => {
        const name = String(r.player.name || "").toLowerCase();
        const team = String(r.team || "").toLowerCase();
        return name.includes(q) || team.includes(q);
      });
    }
    return out;
  }

  function liveSortRows(rows) {
    const dir = state.liveSortDir === "asc" ? 1 : -1;
    const key = state.liveSortKey;
    const numEg = (entry, field) => {
      const n = Number(entry.eg && entry.eg[field]);
      return Number.isFinite(n) ? n : 0;
    };
    return rows.slice().sort((a, b) => {
      let cmp = 0;
      if (key === "name") {
        cmp = String(a.player.name || "").localeCompare(String(b.player.name || ""));
      } else if (key === "progress") {
        cmp = a.progress - b.progress;
      } else if (key === "actions") {
        cmp = a.actions - b.actions;
        if (cmp === 0) cmp = a.progress - b.progress;
      } else if (key === "defConHit") {
        cmp = (a.eg.defConHit ? 1 : 0) - (b.eg.defConHit ? 1 : 0);
      } else if (
        key === "pts" ||
        key === "goals" ||
        key === "assists" ||
        key === "cleanSheets" ||
        key === "saves" ||
        key === "bps" ||
        key === "bonus" ||
        key === "yellowCards" ||
        key === "redCards" ||
        key === "ownGoals" ||
        key === "penaltiesMissed" ||
        key === "penaltiesSaved" ||
        key === "goalsConceded"
      ) {
        cmp = numEg(a, key) - numEg(b, key);
      } else {
        cmp = a.actions - b.actions;
        if (cmp === 0) cmp = a.progress - b.progress;
      }
      if (cmp === 0) cmp = String(a.player.name || "").localeCompare(String(b.player.name || ""));
      return cmp * dir;
    });
  }

  const LIVE_POINTS_COLS = [
    { key: "pts", label: "Pts", title: "Gameweek points" },
    { key: "goals", label: "G", title: "Goals scored" },
    { key: "assists", label: "A", title: "Assists" },
    { key: "cleanSheets", label: "CS", title: "Clean sheets" },
    { key: "defConHit", label: "DC", title: "Defensive contribution threshold hit (+2 pts)" },
    { key: "bonus", label: "B", title: "Bonus points" },
    { key: "saves", label: "Sv", title: "Saves (GK)" },
    { key: "yellowCards", label: "YC", title: "Yellow cards" },
    { key: "redCards", label: "RC", title: "Red cards" },
    { key: "ownGoals", label: "OG", title: "Own goals", narrow: true },
    { key: "penaltiesMissed", label: "PM", title: "Penalties missed", narrow: true },
    { key: "penaltiesSaved", label: "PS", title: "Penalties saved", narrow: true },
  ];

  function livePointsRowCode(entry) {
    return String(entry.player?.code ?? entry.eid ?? "");
  }

  function livePointsCellSignature(entry, col) {
    if (col.key === "defConHit") return entry.eg.defConHit ? "1" : "";
    if (col.key === "saves" && entry.pos !== "GK") return "";
    const n = Number(entry.eg[col.key]);
    if (!Number.isFinite(n) || n === 0) return "";
    return String(n);
  }

  function livePointsCellSignatureFromTd(td, col) {
    if (col.key === "defConHit") return td.querySelector(".live-defcon-achieved") ? "1" : "";
    const roll = td.querySelector(".live-stat-roll[data-count-to]");
    if (!roll) return "";
    return roll.dataset.countTo || "";
  }

  function snapLivePointsCell(td) {
    if (!td) return;
    td.querySelectorAll(".live-stat-roll[data-count-to]").forEach(finishStatRollNode);
  }

  function livePointsRollNodes(root) {
    return [
      ...(root || el.livePage || document).querySelectorAll(
        ".live-points-pill .live-stat-roll[data-count-to]"
      ),
    ];
  }

  function finishLivePointsStatRolls(root) {
    if (livePointsMotionActive(root)) return;
    livePointsRollNodes(root).forEach(finishStatRollNode);
  }

  function livePointsMotionActive(root = el.livePage) {
    return !!(root && root.dataset.livePointsRolling === "1");
  }

  function snapLivePointsVisible(root = el.livePage) {
    finishLivePointsStatRolls(root);
  }

  /** Same curve as Ownership — shorter for G/A/B, slightly longer for Pts. */
  function livePointsRollDurationMs(node) {
    const to = Number(node.dataset.countTo);
    const mag = Math.abs(to);
    if (!Number.isFinite(mag)) return 420;
    const isPts = node.dataset.countRoll === "pts";
    const min = isPts ? 480 : 380;
    const max = isPts ? 1200 : 720;
    const scaled = min + Math.sqrt(mag) * (isPts ? 120 : 38);
    return Math.round(Math.min(max, Math.max(min, scaled)));
  }

  let livePointsEnterMotionToken = 0;
  const LIVE_POINTS_ROLL_BATCH = 48;

  /** Ownership-style batched odometer — pills stay colored; rolls start immediately. */
  function startLivePointsEnterMotion(pane, { onSettled } = {}) {
    if (!pane) return;
    livePointsEnterMotionToken += 1;
    const token = livePointsEnterMotionToken;
    clearTimeout(pane._livePointsMotionSettle);
    pane.dataset.livePointsRolling = "1";

    const nodes = livePointsRollNodes(pane);
    const finish = () => {
      if (token !== livePointsEnterMotionToken) return;
      pane._livePointsMotionSettle = 0;
      delete pane.dataset.livePointsRolling;
      finishLivePointsStatRolls(pane);
      deferLiveTableLayout();
      if (onSettled) onSettled();
    };

    if (prefersReducedMotion()) {
      finish();
      return;
    }

    if (!nodes.length) {
      delete pane.dataset.livePointsRolling;
      deferLiveTableLayout();
      if (onSettled) onSettled();
      return;
    }

    let maxMs = 420;
    nodes.forEach((node) => {
      maxMs = Math.max(maxMs, livePointsRollDurationMs(node));
    });
    const tailMs = Math.ceil(nodes.length / LIVE_POINTS_ROLL_BATCH) * 17;
    let i = 0;
    const runBatch = () => {
      if (token !== livePointsEnterMotionToken) return;
      const end = Math.min(i + LIVE_POINTS_ROLL_BATCH, nodes.length);
      for (; i < end; i += 1) {
        const node = nodes[i];
        animateStatRollNode(node, { duration: livePointsRollDurationMs(node) });
      }
      if (i < nodes.length) requestAnimationFrame(runBatch);
    };
    // Table is fresh from renderLive — start first batch sync (no double-rAF gap).
    runBatch();
    pane._livePointsMotionSettle = window.setTimeout(finish, maxMs + tailMs + 80);
  }

  /** In-place GW poll update — same player set, no full table rebuild or re-roll. */
  function patchLivePointsTable(rows, gw) {
    const tbody = el.liveTableBody;
    if (!tbody || tbody.querySelector(".live-empty-row")) return false;

    const byCode = new Map(
      [...tbody.querySelectorAll(".live-points-row")].map((tr) => [tr.dataset.playerCode, tr])
    );
    const nextCodes = rows.map(livePointsRowCode);
    if (byCode.size !== nextCodes.length) return false;
    for (const code of nextCodes) {
      if (!byCode.has(code)) return false;
    }

    rows.forEach((entry, i) => {
      const tr = byCode.get(livePointsRowCode(entry));
      if (!tr) return;
      tr.style.setProperty("--enter-i", String(i));
      const numCells = tr.querySelectorAll("td.col-num");
      LIVE_POINTS_COLS.forEach((col, ci) => {
        const td = numCells[ci];
        if (!td) return;
        const nextSig = livePointsCellSignature(entry, col);
        if (livePointsCellSignatureFromTd(td, col) === nextSig) return;
        td.innerHTML = livePointsCellHTML(entry, col);
        snapLivePointsCell(td);
      });
      tbody.appendChild(tr);
    });

    if (el.liveCountLabel) {
      el.liveCountLabel.textContent = `${rows.length} player${rows.length === 1 ? "" : "s"} · GW${gw}`;
    }
    return true;
  }

  function liveDefaultSortForMode(mode) {
    if (mode === "feed") return { key: "ts", dir: "desc" };
    if (mode === "points") return { key: "pts", dir: "desc" };
    if (mode === "bonus") return { key: "bps", dir: "desc" };
    return { key: "actions", dir: "desc" };
  }

  function liveCardDotHTML(kind, count) {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) return "";
    const cls = kind === "yc" ? "live-card-dot is-yc" : "live-card-dot is-rc";
    const label = kind === "yc" ? "Yellow card" : "Red card";
    return `<span class="${cls}" aria-label="${label}"></span>`;
  }

  function livePointsPillTone(colKey) {
    if (colKey === "pts") return "is-pts";
    if (
      colKey === "goals" ||
      colKey === "assists" ||
      colKey === "cleanSheets" ||
      colKey === "saves" ||
      colKey === "penaltiesSaved"
    ) {
      return "is-good";
    }
    if (colKey === "bonus") return "is-bonus";
    if (colKey === "defConHit") return "is-defcon";
    if (colKey === "yellowCards") return "is-warn";
    if (
      colKey === "redCards" ||
      colKey === "ownGoals" ||
      colKey === "penaltiesMissed"
    ) {
      return "is-bad";
    }
    return "";
  }

  function livePointsPillHTML(colKey, text, { bonusPts = null, statCount = null, tone: toneOverride = null } = {}) {
    const tone = toneOverride ?? livePointsPillTone(colKey);
    let extra = "";
    if (colKey === "bonus" && bonusPts != null) {
      const n = Math.max(1, Math.min(3, Math.round(Number(bonusPts)) || 1));
      extra = ` is-bonus-${n}`;
    }
    if (
      (colKey === "goals" || colKey === "assists") &&
      Number.isFinite(Number(statCount)) &&
      Number(statCount) > 1
    ) {
      extra += " is-ga-ring";
    }
    return `<span class="ownership-pill live-points-pill${tone ? ` ${tone}` : ""}${extra}">${text}</span>`;
  }

  function livePointsCellHTML(entry, col) {
    const { eg, pos } = entry;
    if (col.key === "defConHit") {
      if (!eg.defConHit) return "";
      const thr = entry.threshold || (pos === "DEF" ? 10 : 12);
      const acts = entry.actions;
      return livePointsPillHTML(
        col.key,
        `<span class="live-defcon-check-slot">${liveAchievedDotHTML(acts, thr, pos)}</span>`
      );
    }
    if (col.key === "saves" && pos !== "GK") return "";
    const n = Number(eg[col.key]);
    if (!Number.isFinite(n) || n === 0) return "";
    const roll = statRollSpan(n, {
      from: 0,
      decimals: 0,
      className: "live-stat-roll",
      rollKind: col.key === "pts" ? "pts" : "stat",
    });
    return livePointsPillHTML(col.key, roll, {
      bonusPts: col.key === "bonus" ? n : null,
      statCount: n,
    });
  }

  function livePointsRowHTML(entry, enterI) {
    const { player, pos } = entry;
    const cells = LIVE_POINTS_COLS.map((col) => {
      const inner = livePointsCellHTML(entry, col);
      const cls = ["col-num", col.narrow ? "col-num-narrow" : ""].filter(Boolean).join(" ");
      return `<td class="${cls}">${inner}</td>`;
    }).join("");
    return `<tr class="live-points-row" style="--enter-i:${enterI}" data-player-code="${escapeHtml(String(player.code || ""))}">
      <td class="col-player">${livePointsIdentityHTML(player, pos)}</td>
      ${cells}
    </tr>`;
  }

  function liveSortTh(key, label, extraClass, title) {
    const sorted = state.liveSortKey === key;
    const arrow = sorted
      ? `<span class="arrow">${iconHTML(state.liveSortDir === "asc" ? "chevron-up" : "chevron-down")}</span>`
      : "";
    return `<th class="${extraClass || ""}${sorted ? " sorted" : ""}" data-live-sort="${escapeHtml(key)}"${tipAttr(title || label)}>${escapeHtml(label)}${arrow}</th>`;
  }

  function liveRowHTML(entry, enterI) {
    const { player, pos, threshold, actions } = entry;
    const thr = threshold || 12;
    const bar = liveDefconBarVisual(actions, thr);
    const achieved = liveAchievedDotHTML(actions, thr, pos);
    const acts = Number.isFinite(Number(actions)) ? Math.max(0, Number(actions)) : 0;
    const completeCls = bar.complete ? " is-complete" : "";
    const roll = statRollSpan(acts, {
      from: 0,
      decimals: 0,
      className: "live-stat-roll",
    });
    return `<tr class="live-defcon-row" style="--enter-i:${enterI}" data-player-code="${escapeHtml(String(player.code || ""))}">
      <td class="col-player">${tableOwnershipIdentityHTML(player)}</td>
      <td class="col-live-defcon">
        <div class="live-defcon-cell">
          <span class="live-defcon-bar${completeCls}" style="${bar.fillStyle}" data-defcon-units="${thr}">
            <span class="live-defcon-track"><span class="live-defcon-fill"></span></span>
          </span>
          <span class="live-defcon-count">
            <span class="live-defcon-frac">${roll}<span class="live-defcon-thr">/${escapeHtml(String(thr))}</span></span>
            <span class="live-defcon-check-slot">${achieved}</span>
          </span>
        </div>
      </td>
    </tr>`;
  }

  function liveMatchupKickoffState(matchup, entries) {
    const kickoffMs = matchup && matchup.kickoff ? Date.parse(matchup.kickoff) : NaN;
    const isLive = (entries || []).some((r) => r.live || liveEgIsInPlay(r.eg));
    const hasPlayed = (entries || []).some((r) => (Number(r.eg && r.eg.minutes) || 0) > 0);
    const upcoming =
      Number.isFinite(kickoffMs) && kickoffMs > Date.now() && !isLive && !hasPlayed;
    const finished = !isLive && hasPlayed;
    return { isLive, upcoming, finished, kickoffMs };
  }

  /** Max fixture minute for a live matchup (from bonus rows, elementGw, or squad fixtures). */
  function liveMatchupFixtureMinutes(matchup, entries) {
    if (!matchup) return null;
    const { isLive } = liveMatchupKickoffState(matchup, entries);
    if (!isLive) return null;

    let max = 0;
    let found = false;
    const bump = (mins) => {
      const m = Number(mins);
      if (!Number.isFinite(m)) return;
      found = true;
      if (m > max) max = m;
    };

    for (const row of entries || []) {
      if (!(row.live || liveEgIsInPlay(row.eg))) continue;
      bump(row.minutes ?? (row.eg && row.eg.minutes));
    }

    if (!found) {
      const gw = liveDefaultGw();
      const egMap = liveElementMapForGw(gw);
      const players = livePlayerByElement();
      for (const [eidStr, eg] of Object.entries(egMap)) {
        if (!liveEgIsInPlay(eg)) continue;
        const player = players.get(Number(eidStr));
        if (!player) continue;
        const team = player.team || currentTeamCode(player);
        if (team !== matchup.home && team !== matchup.away) continue;
        bump(eg.minutes);
      }
    }

    if (!found && HOME) {
      const scanSquad = (squad) => {
        for (const row of squad || []) {
          const team = row.team || currentTeamCode(row);
          if (team !== matchup.home && team !== matchup.away) continue;
          for (const fx of homeSquadFixtures(row)) {
            if (!fx.live) continue;
            bump(fx.minutes != null ? fx.minutes : row.minutes);
          }
        }
      };
      scanSquad(HOME.squad);
      const byEntry = HOME.squadsByEntry;
      if (byEntry && typeof byEntry === "object") {
        for (const squad of Object.values(byEntry)) scanSquad(squad);
      }
    }

    return found ? max : 0;
  }

  function liveBonusMatchupHeadHTML(matchup, entries) {
    if (!matchup) return "";
    const { isLive, upcoming, finished } = liveMatchupKickoffState(matchup, entries);
    const parts = fmtMarketsKickoffParts(matchup.kickoff);
    let statusHTML = "";
    if (isLive) {
      const mins = liveMatchupFixtureMinutes(matchup, entries);
      const minuteHTML =
        mins != null
          ? `<span class="live-bonus-minute">${escapeHtml(String(mins))}′</span>`
          : "";
      statusHTML = `<span class="live-bonus-status-stack">
        <span class="live-bonus-status is-live"><span class="home-status-dot is-live" aria-hidden="true"></span> Live</span>
        ${minuteHTML}
      </span>`;
    } else if (upcoming) {
      const when = [parts.day, parts.date, parts.time].filter(Boolean).join(" · ");
      statusHTML = when
        ? `<span class="live-bonus-status-stack"><span class="live-bonus-status is-upcoming">${escapeHtml(when)}</span></span>`
        : "";
    } else if (finished) {
      statusHTML =
        '<span class="live-bonus-status-stack"><span class="live-bonus-status is-finished">Full time</span></span>';
    } else if (matchup.kickoff) {
      const when = [parts.day, parts.date, parts.time].filter(Boolean).join(" · ");
      statusHTML = when
        ? `<span class="live-bonus-status-stack"><span class="live-bonus-status">${escapeHtml(when)}</span></span>`
        : "";
    }
    return `<header class="live-bonus-card-head">
      <div class="live-bonus-matchup-center">
        <div class="live-bonus-team">
          ${badgeHTML(matchup.home, "live-bonus-badge")}
          <span class="live-bonus-team-code">${escapeHtml(matchup.home)}</span>
        </div>
        <div class="live-bonus-center">
          ${statusHTML || ""}
        </div>
        <div class="live-bonus-team">
          ${badgeHTML(matchup.away, "live-bonus-badge")}
          <span class="live-bonus-team-code">${escapeHtml(matchup.away)}</span>
        </div>
      </div>
    </header>`;
  }

  const LIVE_BONUS_TOP_N = 10;

  function liveBonusFixtureCardHTML(matchup, entries) {
    const sorted = entries
      .slice()
      .sort((a, b) => (Number(b.eg.bps) || 0) - (Number(a.eg.bps) || 0))
      .slice(0, LIVE_BONUS_TOP_N);
    const scale = sorted.reduce((m, e) => Math.max(m, Number(e.eg.bps) || 0), 0) || 1;
    const { isLive } = liveMatchupKickoffState(matchup, sorted);
    const body = sorted.length
      ? `<ol class="rankings-list live-bonus-list">${sorted
          .map((entry, barI) => {
            const bps = Number(entry.eg.bps) || 0;
            const bonus = Number(entry.eg.bonus) || 0;
            const rank = barI + 1;
            const medal = rank === 1 ? "gold" : rank === 2 ? "silver" : rank === 3 ? "bronze" : "";
            const pct = Math.max(4, Math.min(100, (bps / scale) * 100));
            const projected = rank <= 3 ? 4 - rank : 0;
            const outsideBonus = bonus > 0 ? bonus : projected;
            const bonusOut =
              outsideBonus > 0
                ? `<span class="live-bonus-proj">+${outsideBonus}</span>`
                : `<span class="live-bonus-proj is-empty" aria-hidden="true"></span>`;
            const ariaBonus =
              outsideBonus > 0 ? `, +${outsideBonus} bonus` : "";
            const roll = statRollSpan(bps, {
              from: 0,
              decimals: 0,
              className: "live-stat-roll",
            });
            return `<li class="rankings-row live-bonus-row${medal ? ` medal-${medal}` : ""}"
              data-player-code="${escapeHtml(String(entry.player.code || ""))}" role="button" tabindex="0"
              aria-label="${escapeHtml(`${rank}. ${entry.player.name}, ${bps} BPS${ariaBonus}`)}">
              <span class="rankings-rank">${rank}</span>
              <span class="rankings-identity">${rankingsIdentityHTML(entry.player, { omitPrice: true })}</span>
              <span class="rankings-meter live-bonus-meter">
                <span class="live-bonus-track" aria-hidden="true">
                  <span class="rankings-bar" style="--bar-pct:${pct.toFixed(2)}%;--bar-i:${barI}">
                    <span class="rankings-value">${roll}</span>
                  </span>
                </span>
                ${bonusOut}
              </span>
            </li>`;
          })
          .join("")}</ol>`
      : `<div class="rankings-empty">No BPS rows for the current filters.</div>`;
    return `<article class="rankings-card live-bonus-card${isLive ? " is-fixture-live" : ""}">
      ${liveBonusMatchupHeadHTML(matchup, sorted)}
      ${body}
    </article>`;
  }

  function liveBonusSortFixtures(fixtures, byMatchup) {
    return fixtures.slice().sort((a, b) => {
      const aEntries = byMatchup.get(a.id) || [];
      const bEntries = byMatchup.get(b.id) || [];
      const aLive = liveMatchupKickoffState(a, aEntries).isLive;
      const bLive = liveMatchupKickoffState(b, bEntries).isLive;
      if (aLive !== bLive) return aLive ? -1 : 1;
      const ka = a.kickoff || "";
      const kb = b.kickoff || "";
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }

  function syncLiveMatchupFilters() {
    if (!el.liveMatchupFilters) return;
    const gw = liveDefaultGw();
    const matchups = liveMatchupsForGw(gw);
    const valid = new Set(matchups.map((m) => m.id));
    for (const id of Array.from(state.liveMatchups)) {
      if (!valid.has(id)) state.liveMatchups.delete(id);
    }
    el.liveMatchupFilters.innerHTML = matchups
      .map((m) => {
        const active = state.liveMatchups.has(m.id) ? " active" : "";
        const label = `${m.home} vs ${m.away}`;
        return `<button type="button" class="chip live-matchup-chip${active}" data-live-matchup="${escapeHtml(m.id)}"${tipAttr(label)} aria-pressed="${state.liveMatchups.has(m.id) ? "true" : "false"}">
          <span class="live-matchup-badges">${badgeHTML(m.home, "live-matchup-badge")}<span class="live-matchup-vs">v</span>${badgeHTML(m.away, "live-matchup-badge")}</span>
        </button>`;
      })
      .join("");
  }

  function syncLiveStatusSeg() {
    if (!el.liveStatusSeg) return;
    el.liveStatusSeg.querySelectorAll("[data-live-status]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.liveStatus === state.liveStatus);
    });
    syncSegThumb(el.liveStatusSeg);
  }

  function syncLiveFeedOwnedSeg() {
    if (!el.liveFeedOwnedSeg) return;
    el.liveFeedOwnedSeg.querySelectorAll("[data-live-feed-owned]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.liveFeedOwned === state.liveFeedOwnedFilter);
    });
    syncSegThumb(el.liveFeedOwnedSeg);
  }

  function syncLiveFeedFilters() {
    const show = state.page === "live" && state.liveMode === "feed";
    if (el.liveFeedFilters) el.liveFeedFilters.hidden = !show;
  }

  function syncLiveModeSeg() {
    if (!el.liveModeSeg) return;
    el.liveModeSeg.querySelectorAll("[data-live-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.liveMode === state.liveMode);
    });
    syncSegThumb(el.liveModeSeg);
  }

  function syncLivePosFilterGk() {
    if (state.page !== "live") return;
    const showGk = state.liveMode === "points" || state.liveMode === "bonus";
    $$("#pos-filters .chip").forEach((c) => {
      c.hidden = c.dataset.pos === "GK" && !showGk;
    });
  }

  function liveUpdateFooter(gw) {
    if (!el.liveUpdatedFooter) return;
    const iso =
      Number(HOME && HOME.gw) === gw && HOME.generatedAt ? HOME.generatedAt : pageDataUpdatedIso("live");
    const { text, title } = pageUpdatedMeta(iso);
    el.liveUpdatedFooter.textContent = text || "";
    if (title) setTip(el.liveUpdatedFooter, title);
    else setTip(el.liveUpdatedFooter, "");
    el.liveUpdatedFooter.hidden = !text;
  }

  function liveUpdateSubtitle(mode) {
    if (!el.livePageSubtitle) return;
    if (mode === "feed") {
      el.livePageSubtitle.textContent =
        "Event feed — FPL-relevant actions from live fixtures in chronological order, with points and league impact for your manager.";
    } else if (mode === "points") {
      el.livePageSubtitle.textContent =
        "Gameweek stat table — points, goals, assists, saves, bonus, cards, and DefCon hits for the current GW.";
    } else if (mode === "bonus") {
      el.livePageSubtitle.textContent =
        "Bonus Points System rankings per fixture — top three projected 3/2/1 from BPS within each match (FPL tie-break rules not modeled).";
    } else {
      el.livePageSubtitle.textContent =
        "DefCon tracker — progress toward the +2 defensive contribution threshold (DEF 10 CBIT · MID/FWD 12 CBIRT).";
    }
  }

  function renderLiveDefcon(gw) {
    const rows = liveSortRows(liveFilteredRows(liveBuildRows(gw)));
    el.liveTableHead.innerHTML = `<tr>
      ${liveSortTh("name", "Player", "col-player")}
      ${liveSortTh("actions", "DefCon", "col-live-defcon", "Position-correct actions toward threshold (DEF 10 CBIT · MID/FWD 12 CBIRT)")}
    </tr>`;
    if (!rows.length) {
      el.liveTableBody.innerHTML = `<tr class="live-empty-row"><td colspan="2">No DefCon rows for the current filters.</td></tr>`;
    } else {
      el.liveTableBody.innerHTML = rows.map((r, i) => liveRowHTML(r, i)).join("");
    }
    if (el.liveCountLabel) {
      el.liveCountLabel.textContent = `${rows.length} player${rows.length === 1 ? "" : "s"} · GW${gw}`;
    }
  }

  function renderLivePoints(gw, { patch = false } = {}) {
    const rows = liveSortRows(liveFilteredRows(liveBuildRows(gw, { includeGk: true })));
    if (patch && patchLivePointsTable(rows, gw)) return;

    const colCount = LIVE_POINTS_COLS.length + 1;
    el.liveTableHead.innerHTML = `<tr>
      ${liveSortTh("name", "Player", "col-player")}
      ${LIVE_POINTS_COLS.map((col) =>
        liveSortTh(col.key, col.label, `col-num${col.narrow ? " col-num-narrow" : ""}`, col.title)
      ).join("")}
    </tr>`;
    if (!rows.length) {
      el.liveTableBody.innerHTML = `<tr class="live-empty-row"><td colspan="${colCount}">No points rows for the current filters.</td></tr>`;
    } else {
      el.liveTableBody.innerHTML = rows.map((r, i) => livePointsRowHTML(r, i)).join("");
    }
    if (el.liveCountLabel) {
      el.liveCountLabel.textContent = `${rows.length} player${rows.length === 1 ? "" : "s"} · GW${gw}`;
    }
  }

  function renderLiveBonus(gw) {
    if (!el.liveBonusGrid) return;
    const matchups = liveMatchupsForGw(gw);
    let fixtures = matchups;
    if (state.liveMatchups.size) {
      fixtures = matchups.filter((m) => state.liveMatchups.has(m.id));
    }
    const allRows = liveFilteredRows(liveBuildRows(gw, { includeGk: true, forBonus: true }));
    const byMatchup = new Map();
    for (const row of allRows) {
      if (!row.matchupId) continue;
      if (!byMatchup.has(row.matchupId)) byMatchup.set(row.matchupId, []);
      byMatchup.get(row.matchupId).push(row);
    }
    fixtures = liveBonusSortFixtures(fixtures, byMatchup);
    const cards = fixtures.map((m) => liveBonusFixtureCardHTML(m, byMatchup.get(m.id) || []));
    el.liveBonusGrid.innerHTML = cards.join("");
    if (el.liveCountLabel) {
      const playerCount = allRows.length;
      el.liveCountLabel.textContent = `${fixtures.length} fixture${fixtures.length === 1 ? "" : "s"} · ${playerCount} player${playerCount === 1 ? "" : "s"} · GW${gw}`;
    }
  }

  function settleLiveVisible(root = el.livePage) {
    if (!root) return;
    snapLiveBarsDrawn(root);
    if (state.liveMode === "points" && livePointsMotionActive(root)) return;
    finishLiveStatRolls(root);
  }

  function renderLive({ quiet = false, animate = false } = {}) {
    if (quiet && liveIsEnterBusy()) {
      liveRenderQueued = true;
      return;
    }
    const gw = liveDefaultGw();
    syncLiveMatchupFilters();
    syncLiveStatusSeg();
    syncLiveFeedOwnedSeg();
    syncLiveFeedFilters();
    syncLiveModeSeg();
    syncLivePosFilterGk();
    syncFiltersChrome();
    syncMobileFilterDock();

    const mode = state.liveMode;
    if (el.liveTableWrap) el.liveTableWrap.hidden = mode === "bonus" || mode === "feed";
    if (el.liveFeedWrap) el.liveFeedWrap.hidden = mode !== "feed";
    if (el.liveBonusWrap) el.liveBonusWrap.hidden = mode !== "bonus";
    if (el.liveTable) {
      el.liveTable.classList.toggle("live-defcon-table", mode === "defcon");
      el.liveTable.classList.toggle("live-points-table", mode === "points");
    }
    liveUpdateSubtitle(mode);

    if (mode === "feed") {
      renderLiveFeed(gw);
    } else if (mode === "bonus") {
      renderLiveBonus(gw);
    } else if (mode === "points") {
      if (!el.liveTableBody || !el.liveTableHead) return;
      renderLivePoints(gw, { patch: quiet });
    } else {
      if (!el.liveTableBody || !el.liveTableHead) return;
      renderLiveDefcon(gw);
    }
    liveUpdateFooter(gw);
    syncLiveNavChrome();
    syncLivePointsCoreUnder();
    if (mode === "points") primeLivePointsTableLayout();
    bindOwnershipPhotoFallback(el.livePage);

    if (quiet) {
      if (state.liveMode === "points") snapLivePointsVisible(el.livePage);
      else settleLiveVisible();
      deferLiveTableLayout();
    } else if (liveEnterAwaitingPlay) {
      /* Points / DefCon rolls empty until playLiveEnter or mode motion */
    } else if (liveIsEnterBusy()) {
      if (animate) liveAnimateQueued = true;
      if (state.liveMode !== "points") settleLiveVisible();
    } else if (animate) {
      if (state.liveMode === "points") startLivePointsEnterMotion(el.livePage);
      else startLiveEnterMotion(el.livePage);
    } else {
      if (state.liveMode === "points") finishLivePointsStatRolls(el.livePage);
      else settleLiveVisible();
      deferLiveTableLayout();
    }
  }

  /** Points name-col measure reflows mid-odometer and replays the roll — defer until enter settles. */
  function deferLiveTableLayout() {
    scheduleOptaMobileNameColWidth();
    bindAllNameColumnSimplifies();
    if (el.liveTableWrap && state.liveMode === "points") {
      updateNameColumnSimplify(el.liveTableWrap);
    }
  }

  let liveEnterMotionToken = 0;
  let liveRenderQueued = false;
  let liveAnimateQueued = false;
  /** setPage marks this so renderLive leaves rolls empty until playLiveEnter. */
  let liveEnterAwaitingPlay = false;

  function liveIsEnterBusy() {
    if (!el.livePage) return false;
    if (el.livePage.classList.contains("is-live-entering")) return true;
    if (livePointsMotionActive(el.livePage)) return true;
    if (el.livePage._liveMotionSettle) return true;
    if (el.livePage._livePointsMotionSettle) return true;
    return false;
  }

  function livePollRefreshMotion() {
    if (state.liveMode === "points" || state.liveMode === "feed") return;
    startLiveEnterMotion(el.livePage);
  }

  function flushLiveEnterDeferred() {
    if (livePointsMotionActive(el.livePage)) snapLiveBarsDrawn(el.livePage);
    else settleLiveVisible();
    if (liveRenderQueued) {
      liveRenderQueued = false;
      renderLive({ quiet: true });
      if (state.liveMode !== "points" && !liveAnimateQueued) livePollRefreshMotion();
    }
    if (liveAnimateQueued && el.livePage && !liveIsEnterBusy()) {
      liveAnimateQueued = false;
      if (state.liveMode === "points") startLivePointsEnterMotion(el.livePage);
      else startLiveEnterMotion(el.livePage);
    }
    if (homeLiveApplyAfterEnter) flushHomeRenderAfterEnter();
  }

  function finishLiveStatRolls(root) {
    if (!root) return;
    root.querySelectorAll(".live-stat-roll[data-count-to]").forEach((node) => {
      // Points pills have their own enter / poll settle path.
      if (node.closest(".live-points-pill")) return;
      finishStatRollNode(node);
    });
  }

  function snapLiveBarsDrawn(root) {
    if (!root) return;
    const fills = [...root.querySelectorAll(".live-defcon-fill")];
    const bars = [...root.querySelectorAll(".live-bonus-track .rankings-bar")];
    fills.forEach((fill) => {
      fill.style.transition = "none";
      fill.classList.add("is-drawn");
    });
    bars.forEach((bar) => {
      bar.style.transition = "none";
      bar.classList.add("is-drawn");
    });
    // Drop inline transition after paint so the next motion pass can ease.
    requestAnimationFrame(() => {
      fills.forEach((fill) => {
        if (fill.isConnected) fill.style.removeProperty("transition");
      });
      bars.forEach((bar) => {
        if (bar.isConnected) bar.style.removeProperty("transition");
      });
    });
    root.querySelectorAll(".live-dc-check-enter").forEach((el) => el.classList.add("is-drawn"));
  }

  const LIVE_DEFCON_BAR_MS = 1150;
  const LIVE_DEFCON_BAR_STAGGER_MS = 22;

  function liveDefconBarMotionEndMs(root) {
    if (!root || state.liveMode !== "defcon") return 0;
    let maxDelay = 0;
    root.querySelectorAll(".live-defcon-row").forEach((row) => {
      const i = Number.parseInt(row.style.getPropertyValue("--enter-i"), 10);
      if (Number.isFinite(i)) maxDelay = Math.max(maxDelay, Math.min(i, 24) * LIVE_DEFCON_BAR_STAGGER_MS);
    });
    return maxDelay + LIVE_DEFCON_BAR_MS;
  }

  const LIVE_ROLL_BATCH = 40;

  function livePtsRollDurationMs(value) {
    const mag = Math.abs(Number(value));
    if (!Number.isFinite(mag)) return 680;
    return Math.round(Math.min(1500, Math.max(680, 600 + Math.sqrt(mag) * 140)));
  }

  /** Snappy pill stats (G/A/B/1…) — still rolls from 0. */
  function liveStatRollDurationMs(value) {
    const mag = Math.abs(Number(value));
    if (!Number.isFinite(mag)) return 420;
    return Math.round(Math.min(600, Math.max(380, 340 + Math.sqrt(mag) * 38)));
  }

  function liveDefconRollDurationMs(value) {
    const mag = Math.abs(Number(value));
    if (!Number.isFinite(mag)) return 560;
    return Math.round(Math.min(960, Math.max(560, 500 + Math.sqrt(mag) * 60)));
  }

  function liveRollDurationForNode(node) {
    const to = node.dataset.countTo;
    if (node.dataset.countRoll === "pts") return livePtsRollDurationMs(to);
    if (node.closest(".live-defcon-row, .live-bonus-list")) {
      return node.closest(".live-defcon-row")
        ? liveDefconRollDurationMs(to)
        : liveStatRollDurationMs(to);
    }
    return liveStatRollDurationMs(to);
  }

  /** Batch odometer mounts (DefCon counts + Bonus BPS only). */
  function animateLiveStatRollsBatched(nodes, token) {
    if (!nodes.length) return { maxRoll: 420, tailMs: 0 };
    let maxRoll = 420;
    nodes.forEach((node) => {
      maxRoll = Math.max(maxRoll, liveRollDurationForNode(node));
    });
    const tailMs = Math.ceil(nodes.length / LIVE_ROLL_BATCH) * 17;
    let i = 0;
    const runBatch = () => {
      if (token !== liveEnterMotionToken) return;
      const end = Math.min(i + LIVE_ROLL_BATCH, nodes.length);
      for (; i < end; i += 1) {
        const node = nodes[i];
        animateStatRollNode(node, { duration: liveRollDurationForNode(node) });
      }
      if (i < nodes.length) requestAnimationFrame(runBatch);
    };
    runBatch();
    return { maxRoll, tailMs };
  }

  /** Draw DefCon fills / Bonus meters + roll action/BPS/Pts counts. */
  function playLiveMotion(root, { settleMs = 1100, onSettled } = {}) {
    if (!root) return;
    liveEnterMotionToken += 1;
    const token = liveEnterMotionToken;
    clearTimeout(root._liveMotionSettle);

    const fills = [...root.querySelectorAll(".live-defcon-fill")];
    const bars = [...root.querySelectorAll(".live-bonus-track .rankings-bar")];
    const rolls = [...root.querySelectorAll(".live-stat-roll[data-count-to]")];
    const dcChecks = [...root.querySelectorAll(".live-dc-check-enter")];
    const tableRolls = rolls.filter((node) => !node.closest(".live-points-pill"));

    const settle = () => {
      if (token !== liveEnterMotionToken) return;
      root._liveMotionSettle = 0;
      settleLiveVisible(root);
      deferLiveTableLayout();
      if (onSettled) onSettled();
    };

    if (prefersReducedMotion()) {
      fills.forEach((fill) => {
        fill.style.transition = "none";
        fill.classList.add("is-drawn");
      });
      bars.forEach((bar) => {
        bar.style.transition = "none";
        bar.classList.add("is-drawn");
      });
      rolls.forEach(finishStatRollNode);
      dcChecks.forEach((el) => el.classList.add("is-drawn"));
      settle();
      return;
    }

    const pointsMode = state.liveMode === "points";
    if (pointsMode) {
      startLivePointsEnterMotion(root, { onSettled: () => settle() });
      return;
    }

    // DefCon / Bonus motion below.
    fills.forEach((fill) => {
      fill.style.transition = "none";
      fill.classList.remove("is-drawn");
    });
    bars.forEach((bar) => {
      bar.style.transition = "none";
      bar.classList.remove("is-drawn");
    });
    dcChecks.forEach((el) => el.classList.remove("is-drawn"));

    const draw = () => {
      if (token !== liveEnterMotionToken) return;
      void root.offsetWidth;
      fills.forEach((fill) => fill.style.removeProperty("transition"));
      bars.forEach((bar) => bar.style.removeProperty("transition"));
      fills.forEach((fill) => fill.classList.add("is-drawn"));
      bars.forEach((bar) => bar.classList.add("is-drawn"));
      dcChecks.forEach((el) => el.classList.add("is-drawn"));
      const { maxRoll: tableMax, tailMs } = animateLiveStatRollsBatched(tableRolls, token);
      const motionEnd = Math.max(
        tailMs + tableMax,
        liveDefconBarMotionEndMs(root)
      );
      root._liveMotionSettle = window.setTimeout(
        settle,
        Math.max(settleMs, motionEnd + 120)
      );
    };

    requestAnimationFrame(() => {
      requestAnimationFrame(draw);
    });
  }

  /** Dedicated Live page enter / mode-switch motion. */
  function playLiveEnter(pane) {
    if (!pane) return;
    liveEnterAwaitingPlay = false;
    clearTimeout(pane._enterClear);
    clearTimeout(pane._liveMotionSettle);
    pane._enterClear = 0;
    pane.classList.remove("is-entering", "is-enter-pending", "is-live-entering");

    if (prefersReducedMotion()) {
      settleLiveVisible(pane);
      deferLiveTableLayout();
      flushLiveEnterDeferred();
      return;
    }

    pane.querySelectorAll(".live-bonus-card").forEach((card, i) => {
      card.style.setProperty("--enter-i", String(i));
    });
    pane.querySelectorAll(".live-defcon-row, .live-points-row, .live-feed-row").forEach((row, i) => {
      row.style.setProperty("--enter-i", String(i));
    });

    pane.classList.add("is-live-entering", "is-entering");
    playLiveMotion(pane, {
      onSettled: () => {
        pane.classList.remove("is-live-entering", "is-entering");
        flushLiveEnterDeferred();
      },
    });
  }

  function startLiveEnterMotion(pane) {
    if (!pane) return;
    clearTimeout(pane._enterClear);
    clearTimeout(pane._liveMotionSettle);
    pane._enterClear = 0;
    pane._liveMotionSettle = 0;
    pane.querySelectorAll(".live-bonus-card").forEach((card, i) => {
      card.style.setProperty("--enter-i", String(i));
    });
    pane.querySelectorAll(".live-defcon-row, .live-points-row, .live-feed-row").forEach((row, i) => {
      row.style.setProperty("--enter-i", String(i));
    });
    playLiveMotion(pane, {
      onSettled: () => {
        flushLiveEnterDeferred();
      },
    });
  }

  // Ownership page — sortable TSB% mover table
  // ---------------------------------------------------------------------
  const OWNERSHIP_MOVER_N = 20;
  const OWNERSHIP_TEAM_TOP_N = 20;
  const OWNERSHIP_LOOKBACK_DAYS = { d1: 1, d3: 3, d7: 7, d14: 14 };

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

  function ownershipCheckInMs(iso) {
    const [y, m, d] = String(iso || "").split("-").map(Number);
    if (!y || !m || !d) return NaN;
    return Date.UTC(y, m - 1, d);
  }

  function ownershipMoverKind() {
    return state.ownershipMoverKind === "fallers" ? "fallers" : "risers";
  }

  function resetOwnershipSortForKind(kind) {
    state.ownershipSortKey = "d14";
    state.ownershipSortDir = kind === "fallers" ? "asc" : "desc";
  }

  function teamTopNAvg(players, n) {
    if (!players || players.length < n) return null;
    const sorted = players.slice().sort((a, b) => (b.owned || 0) - (a.owned || 0) || a.code - b.code);
    const top = sorted.slice(0, n);
    const sum = top.reduce((s, p) => s + (Number(p.owned) || 0), 0);
    return { owned: Math.round((sum / n) * 10) / 10, n, sample: top[0] };
  }

  function ownershipPlayerPassesDisplayFilters(p, catalog) {
    if (state.posFilter.size && !state.posFilter.has(p.position)) return false;
    if (state.teamFilter.size && !state.teamFilter.has(p.team)) return false;
    const price = Number(p.price);
    if (Number.isFinite(price) && (price < state.priceMin || price > state.priceMax)) return false;
    if (!isNextSeason() && HAS_PRICE_DATA) {
      const row = catalog.get(Number(p.code));
      if (excludeDepartedPlayer(row)) return false;
    }
    const q = state.search.trim().toLowerCase();
    if (q) {
      if (KNOWN_TEAM_CODES_LOWER.has(q)) {
        if (String(p.team || "").toLowerCase() !== q) return false;
      } else {
        const hay = `${p.name || ""} ${p.team || ""} ${teamNameForSeason(p.team) || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
    }
    return true;
  }

  function ownershipTeamPassesDisplayFilters(team, name) {
    if (state.teamFilter.size && !state.teamFilter.has(team)) return false;
    const q = state.search.trim().toLowerCase();
    if (q) {
      const code = String(team || "").toLowerCase();
      if (KNOWN_TEAM_CODES_LOWER.has(q)) {
        if (code !== q) return false;
      } else {
        const hay = `${name || ""} ${team || ""} ${teamNameForSeason(team) || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
    }
    return true;
  }

  function ownershipOwnedAtOrBefore(history, targetMs) {
    if (!history || !history.length || !Number.isFinite(targetMs)) return null;
    let hit = null;
    for (const pt of history) {
      const ms = ownershipCheckInMs(pt.checkedAt);
      if (!Number.isFinite(ms) || ms > targetMs) continue;
      if (pt.owned == null || Number.isNaN(Number(pt.owned))) continue;
      hit = pt;
    }
    if (hit) return hit;
    const first = history.find((pt) => pt.owned != null && !Number.isNaN(Number(pt.owned)));
    return first || null;
  }

  function ownershipScoreRow(history) {
    const valid = (history || []).filter((pt) => pt && pt.owned != null && Number.isFinite(Number(pt.owned)));
    if (valid.length < 2) return null;
    const livePt = valid[valid.length - 1];
    const live = Number(livePt.owned);
    const liveMs = ownershipCheckInMs(livePt.checkedAt);
    const dayMs = 24 * 60 * 60 * 1000;
    const pt14 = ownershipOwnedAtOrBefore(valid, liveMs - OWNERSHIP_LOOKBACK_DAYS.d14 * dayMs);
    const pt7 = ownershipOwnedAtOrBefore(valid, liveMs - OWNERSHIP_LOOKBACK_DAYS.d7 * dayMs);
    const pt3 = ownershipOwnedAtOrBefore(valid, liveMs - OWNERSHIP_LOOKBACK_DAYS.d3 * dayMs);
    const pt1 = ownershipOwnedAtOrBefore(valid, liveMs - OWNERSHIP_LOOKBACK_DAYS.d1 * dayMs);
    const sparkFromMs = liveMs - OWNERSHIP_LOOKBACK_DAYS.d14 * dayMs;
    let spark = valid.filter((pt) => ownershipCheckInMs(pt.checkedAt) >= sparkFromMs);
    if (spark.length < 2) spark = valid.slice(-Math.min(valid.length, 8));
    const owned7 = pt7 ? Number(pt7.owned) : null;
    const owned3 = pt3 ? Number(pt3.owned) : null;
    const owned1 = pt1 ? Number(pt1.owned) : null;
    const owned14 = pt14 ? Number(pt14.owned) : Number(spark[0].owned);
    const d14 = ownershipDelta(live, owned14);
    if (d14 == null) return null;
    return {
      live,
      owned7,
      owned3,
      owned1,
      owned14,
      d7: ownershipDelta(live, owned7),
      d3: ownershipDelta(live, owned3),
      d1: ownershipDelta(live, owned1),
      d14,
      spark: spark.map((pt) => Number(pt.owned)),
      sparkStart: Number(spark[0].owned),
      sparkEnd: live,
    };
  }

  function ownershipPlayerHistoryMaps(checkIns) {
    const byCode = new Map();
    for (const ci of checkIns) {
      for (const p of ci.players || []) {
        if (!p || p.code == null) continue;
        const k = Number(p.code);
        let arr = byCode.get(k);
        if (!arr) {
          arr = [];
          byCode.set(k, arr);
        }
        const owned = Number(p.owned);
        arr.push({
          checkedAt: ci.checkedAt,
          owned: Number.isFinite(owned) ? owned : null,
          player: p,
        });
      }
    }
    return byCode;
  }

  function buildOwnershipPlayerMoverUniverse() {
    const checkIns = ownershipCheckIns();
    if (checkIns.length < 2) return [];
    const catalog = ownershipCatalogByCode();
    const byCode = ownershipPlayerHistoryMaps(checkIns);
    const latest = checkIns[checkIns.length - 1];
    const rows = [];
    for (const seed of latest.players || []) {
      if (!seed || seed.code == null) continue;
      if (!isNextSeason() && HAS_PRICE_DATA) {
        const row = catalog.get(Number(seed.code));
        if (excludeDepartedPlayer(row)) continue;
      }
      const history = byCode.get(Number(seed.code));
      const score = ownershipScoreRow(history);
      if (!score) continue;
      const last = history.filter((pt) => pt.player).pop();
      const player = (last && last.player) || seed;
      rows.push({
        key: `p:${seed.code}`,
        kind: "player",
        code: Number(seed.code),
        name: player.name,
        team: player.team,
        position: player.position,
        price: player.price,
        ...score,
      });
    }
    return rows;
  }

  function buildOwnershipTeamMoverUniverse() {
    const checkIns = ownershipCheckIns();
    if (checkIns.length < 2) return [];
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
    const teams = new Set();
    perCheckIn.forEach((map) => map.forEach((_, team) => teams.add(team)));
    const rows = [];
    for (const team of teams) {
      const history = checkIns.map((ci, i) => {
        const hit = perCheckIn[i].get(team);
        return {
          checkedAt: ci.checkedAt,
          owned: hit ? hit.owned : null,
        };
      });
      const score = ownershipScoreRow(history);
      if (!score) continue;
      rows.push({
        key: `t:${team}`,
        kind: "team",
        team,
        name: teamNameForSeason(team) || team,
        ...score,
      });
    }
    return rows;
  }

  function compareOwnershipMovers(a, b) {
    const ar = Math.abs(a.d14);
    const br = Math.abs(b.d14);
    if (ar !== br) return br - ar;
    const a7 = Math.abs(a.d7 || 0);
    const b7 = Math.abs(b.d7 || 0);
    if (a7 !== b7) return b7 - a7;
    return (b.live || 0) - (a.live || 0);
  }

  function ownershipMoverUniverse() {
    return state.view === "teams"
      ? buildOwnershipTeamMoverUniverse()
      : buildOwnershipPlayerMoverUniverse();
  }

  function ownershipRankedMovers() {
    const kind = ownershipMoverKind();
    const universe = ownershipMoverUniverse();
    const pool = universe.filter((row) => (kind === "fallers" ? row.d14 < 0 : row.d14 > 0));
    pool.sort(compareOwnershipMovers);
    return pool.slice(0, OWNERSHIP_MOVER_N);
  }

  function ownershipVisibleMovers() {
    const ranked = ownershipRankedMovers();
    const catalog = ownershipCatalogByCode();
    return ranked.filter((row) => {
      if (row.kind === "team") return ownershipTeamPassesDisplayFilters(row.team, row.name);
      return ownershipPlayerPassesDisplayFilters(row, catalog);
    });
  }

  function ownershipSortValue(row, key) {
    if (key === "name") return String(row.name || "").toLowerCase();
    if (key === "owned7") return row.owned7 == null ? -Infinity : row.owned7;
    if (key === "live") return row.live == null ? -Infinity : row.live;
    if (key === "d7") return row.d7 == null ? -Infinity : row.d7;
    if (key === "d3") return row.d3 == null ? -Infinity : row.d3;
    if (key === "d1") return row.d1 == null ? -Infinity : row.d1;
    if (key === "d14") return row.d14 == null ? -Infinity : row.d14;
    return -Infinity;
  }

  function sortOwnershipRows(rows) {
    const key = state.ownershipSortKey || "d14";
    const dir = state.ownershipSortDir === "asc" ? 1 : -1;
    return rows.slice().sort((a, b) => {
      if (key === "name") {
        return dir * String(a.name || "").localeCompare(String(b.name || ""));
      }
      const va = ownershipSortValue(a, key);
      const vb = ownershipSortValue(b, key);
      if (va !== vb) return dir * (va - vb);
      return compareOwnershipMovers(a, b);
    });
  }

  function fmtOwnershipTrendDelta(delta) {
    if (delta == null || Number.isNaN(delta)) return "—";
    const n = Number(delta);
    if (n > 0) return `+${n.toFixed(1)}`;
    return n.toFixed(1);
  }

  function ownershipDeltaClass(delta) {
    if (delta == null || Number.isNaN(delta) || Math.abs(delta) < 0.05) return "is-flat";
    return delta > 0 ? "is-up" : "is-down";
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

  function ownershipPhotoFallbackElement(img) {
    const fallback = document.createElement("span");
    const classes = String(img.className || "")
      .split(/\s+/)
      .filter((c) => c && c !== "ownership-photo" && c !== "home-lookup-photo");
    const isLookup = img.classList.contains("home-lookup-photo");
    fallback.className = [
      isLookup ? "home-lookup-photo home-lookup-photo-fallback" : "ownership-photo ownership-photo-fallback",
      "is-photo-icon",
      ...classes,
    ].filter(Boolean).join(" ");
    fallback.setAttribute("aria-hidden", "true");
    const accent = img.style.getPropertyValue("--team-accent");
    if (accent) fallback.style.setProperty("--team-accent", accent);
    fallback.innerHTML = iconHTML("user", "player-photo-fallback-icon");
    return fallback;
  }

  function replaceBrokenPlayerPhoto(img) {
    if (!(img instanceof HTMLImageElement)) return;
    if (img.dataset.photoFallback === "1") return;
    if (
      !img.classList.contains("ownership-photo")
      && !img.classList.contains("home-lookup-photo")
    ) {
      return;
    }
    img.dataset.photoFallback = "1";
    img.replaceWith(ownershipPhotoFallbackElement(img));
  }

  function bindOwnershipPhotoFallback(root) {
    if (!root) return;
    root.querySelectorAll("img.ownership-photo, img.home-lookup-photo").forEach((img) => {
      if (img.dataset.photoFallbackBound === "1") return;
      img.dataset.photoFallbackBound = "1";
      if (img.complete && img.naturalWidth === 0) {
        replaceBrokenPlayerPhoto(img);
        return;
      }
      img.addEventListener("error", () => replaceBrokenPlayerPhoto(img), { once: true });
    });
  }

  // Capture-phase: img error does not bubble — covers Live and any missed bind.
  document.addEventListener(
    "error",
    (e) => {
      replaceBrokenPlayerPhoto(e.target);
    },
    true
  );

  function ownershipPhotoHTML(row, teamCode, { eager = false } = {}) {
    const initials = ownershipInitials(row.name);
    const photo = feedPlayerPhotoUrl(row.code);
    const team = teamCode || currentTeamCode(row) || row.team;
    const ring = teamRingAttrs(team);
    if (!photo) {
      return `<span class="ownership-photo ownership-photo-fallback is-photo-icon${ring.className}" aria-hidden="true"${ring.attr}>${iconHTML("user", "player-photo-fallback-icon")}</span>`;
    }
    const loading = eager ? "eager" : "lazy";
    return `<img class="ownership-photo${ring.className}" src="${escapeHtml(photo)}" alt="" width="36" height="36" loading="${loading}" decoding="async" data-initials="${escapeHtml(initials)}"${ring.attr} />`;
  }

  function ownershipIdCellHTML(row, rank, { hidePrice = false } = {}) {
    if (row.kind === "team") {
      const crest = badgeHTML(row.team, "ownership-crest") ||
        teamCrestFallbackHTML(row.team, "ownership-photo ownership-photo-fallback");
      return `<div class="ownership-id">
        <span class="ownership-rank">${rank}</span>
        ${crest}
        <div class="ownership-id-text">
          <div class="player-name-line"><span class="player-name">${escapeHtml(row.name || "—")}</span></div>
        </div>
      </div>`;
    }
    const teamTag = teamTagAttrs(row.team);
    const bits = [
      row.team ? `<span class="ownership-id-team${teamTag.className}"${teamTag.style}>${escapeHtml(row.team)}</span>` : "",
      !hidePrice && row.price != null && Number.isFinite(Number(row.price))
        ? `<span class="ownership-id-price">£${Number(row.price).toFixed(1)}m</span>`
        : "",
      row.position ? `<span>${escapeHtml(row.position)}</span>` : "",
    ].filter(Boolean);
    const ownedPin = ownedFlagHTML(row);
    return `<div class="ownership-id">
      <span class="ownership-rank">${rank}</span>
      ${ownershipPhotoHTML(row)}
      <div class="ownership-id-text">
        <div class="player-name-line"><span class="player-name">${escapeHtml(row.name || "—")}</span>${ownedPin}</div>
        ${bits.length ? `<div class="ownership-id-sub">${bits.join("<span class=\"ownership-id-sep\">|</span>")}</div>` : ""}
      </div>
    </div>`;
  }

  function ownershipPillHTML(value, { live = false } = {}) {
    if (value == null || Number.isNaN(Number(value))) {
      return `<span class="ownership-pill is-empty">—</span>`;
    }
    return `<span class="ownership-pill${live ? " is-live" : ""}">${statRollSpan(Number(value), {
      from: 0,
      decimals: 1,
      className: "ownership-stat-roll",
    })}</span>`;
  }

  function ownershipDeltaPillHTML(delta, { quiet = false } = {}) {
    const cls = ownershipDeltaClass(delta);
    const quietCls = quiet && cls === "is-flat" ? " is-quiet" : "";
    if (delta == null || Number.isNaN(Number(delta))) {
      return `<span class="ownership-delta ${cls}${quietCls}">—</span>`;
    }
    return `<span class="ownership-delta ${cls}${quietCls}">${statRollSpan(Number(delta), {
      from: 0,
      decimals: 1,
      signed: true,
      className: "ownership-stat-roll",
    })}</span>`;
  }

  function ownershipSparkHTML(row) {
    const series = row.spark || [];
    if (series.length < 2) {
      return `<span class="ownership-spark-empty">—</span>`;
    }
    const w = 92;
    const h = 28;
    const padX = 2;
    const padY = 4;
    const lo = Math.min(...series);
    const hi = Math.max(...series);
    const rng = hi - lo || 1;
    const n = series.length;
    const pts = series.map((v, i) => {
      const x = padX + (i / (n - 1)) * (w - padX * 2);
      const y = h - padY - ((v - lo) / rng) * (h - padY * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const end = pts[pts.length - 1].split(",");
    const tone = ownershipDeltaClass(row.d14);
    const startLbl = fmtOwnedPct(row.sparkStart);
    const endLbl = fmtOwnedPct(row.sparkEnd);
    return `<span class="ownership-spark ${tone}">
      <span class="ownership-spark-lab">${escapeHtml(startLbl)}</span>
      <svg class="ownership-spark-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
        <polyline points="${pts.join(" ")}" />
        <circle cx="${end[0]}" cy="${end[1]}" r="1.8" />
      </svg>
      <span class="ownership-spark-lab">${escapeHtml(endLbl)}</span>
    </span>`;
  }

  function ownershipSortArrow(key) {
    if (state.ownershipSortKey !== key) return "";
    return `<span class="arrow">${iconHTML(state.ownershipSortDir === "asc" ? "chevron-up" : "chevron-down")}</span>`;
  }

  function ownershipHeadHTML() {
    const th = (key, label, extra = "") =>
      `<th class="${extra}${state.ownershipSortKey === key ? " sorted" : ""}" data-own-sort="${key}">${escapeHtml(label)}${ownershipSortArrow(key)}</th>`;
    return `<tr>
      ${th("name", state.view === "teams" ? "Club" : "Player", "col-player")}
      ${th("owned7", "7d", "col-num")}
      <th class="col-num ownership-col-arrow" aria-hidden="true"></th>
      ${th("live", "Live", "col-num")}
      ${th("d7", "7d Δ", "col-num")}
      ${th("d3", "3d Δ", "col-num")}
      ${th("d1", "24h", "col-num")}
      ${th("d14", "14d trend", "col-num ownership-col-spark")}
    </tr>`;
  }

  function ownershipRowHTML(row, rank) {
    return `<tr data-own-key="${escapeHtml(row.key)}">
      <td class="col-player">${ownershipIdCellHTML(row, rank)}</td>
      <td class="col-num">${ownershipPillHTML(row.owned7)}</td>
      <td class="col-num ownership-col-arrow"><span class="ownership-then-arrow" aria-hidden="true">→</span></td>
      <td class="col-num">${ownershipPillHTML(row.live, { live: true })}</td>
      <td class="col-num">${ownershipDeltaPillHTML(row.d7)}</td>
      <td class="col-num">${ownershipDeltaPillHTML(row.d3)}</td>
      <td class="col-num">${ownershipDeltaPillHTML(row.d1, { quiet: true })}</td>
      <td class="col-num ownership-col-spark">${ownershipSparkHTML(row)}</td>
    </tr>`;
  }

  const OWNERSHIP_TREE_LAYOUT_W = 1000;
  const OWNERSHIP_TREE_LAYOUT_H = 620;
  const OWNERSHIP_TREE_WEIGHT_FLOOR = 0.15;
  /** Top risers / fallers shown as named tiles (no “rest of” bucket). */
  const OWNERSHIP_TREE_TOP_N = 8;

  function ownershipTreemapLayoutSize() {
    const plot = el.ownershipTreemapPlot;
    const cw = plot && plot.clientWidth > 40 ? plot.clientWidth : 0;
    const ch = plot && plot.clientHeight > 40 ? plot.clientHeight : 0;
    if (cw && ch) {
      return { w: cw, h: ch, preferHorizontal: NARROW_MQ.matches };
    }
    let aspect = NARROW_MQ.matches
      ? 0.55
      : OWNERSHIP_TREE_LAYOUT_W / OWNERSHIP_TREE_LAYOUT_H;
    // Phone fallback: portrait so squarify prefers horizontal bands.
    if (NARROW_MQ.matches && aspect > 0.7) aspect = 0.55;
    const h = OWNERSHIP_TREE_LAYOUT_H;
    const w = Math.max(280, Math.round(h * aspect));
    return { w, h, preferHorizontal: NARROW_MQ.matches };
  }

  function ownershipTreeWindow() {
    const w = state.ownershipTreeWindow;
    return w === "d3" || w === "d1" ? w : "d7";
  }

  function ownershipIsTreemap() {
    return state.ownershipViewMode === "treemap";
  }

  function ownershipTreeWindowLabel(key = ownershipTreeWindow()) {
    if (key === "d3") return "3d";
    if (key === "d1") return "24h";
    return "7d";
  }

  function ownershipTreeDelta(row, key = ownershipTreeWindow()) {
    const v = row && row[key];
    return v == null || Number.isNaN(Number(v)) ? null : Number(v);
  }

  function ownershipTreemapShortName(row, maxChars = 10) {
    const limit = Math.max(3, Math.min(18, Number(maxChars) || 10));
    const name = String(row && row.name || "").trim();
    if (!name) return "?";
    if (row.kind === "team") return String(row.team || name).slice(0, Math.min(3, limit));
    const parts = name.split(/\s+/).filter(Boolean);
    const base = parts.length === 1 ? parts[0] : parts[parts.length - 1];
    if (base.length <= limit) return base;
    return `${base.slice(0, Math.max(2, limit - 1))}…`;
  }

  // Squarified treemap (Bruls et al.) — items need { value, ... }.
  function squarifyRects(items, width, height, { preferHorizontal = false } = {}) {
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
      const remW = x1 - x0;
      const remH = y1 - y0;
      // Mobile: bias toward horizontal bands so big movers read as wide tiles.
      const wide = preferHorizontal ? remW > remH * 1.35 : remW >= remH;
      if (wide) {
        const rw = sum / remH;
        let y = y0;
        for (const node of rowNodes) {
          const h = node.area / rw;
          out.push({ ...node, x: x0, y, w: rw, h });
          y += h;
        }
        x0 += rw;
      } else {
        const rh = sum / remW;
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

  function ownershipTreemapPopulation() {
    const catalog = ownershipCatalogByCode();
    const universe = ownershipMoverUniverse();
    return universe.filter((row) => {
      if (row.kind === "team") return ownershipTeamPassesDisplayFilters(row.team, row.name);
      return ownershipPlayerPassesDisplayFilters(row, catalog);
    });
  }

  function ownershipTreemapItems(windowKey) {
    const raw = ownershipTreemapPopulation()
      .map((row) => {
        const delta = ownershipTreeDelta(row, windowKey);
        if (delta == null || Math.abs(delta) < 0.05) return null;
        return {
          row,
          delta,
          value: Math.max(Math.abs(delta), OWNERSHIP_TREE_WEIGHT_FLOOR),
        };
      })
      .filter(Boolean)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || compareOwnershipMovers(a.row, b.row));

    const risers = raw.filter((it) => it.delta > 0).slice(0, OWNERSHIP_TREE_TOP_N);
    const fallers = raw.filter((it) => it.delta < 0).slice(0, OWNERSHIP_TREE_TOP_N);
    return [...risers, ...fallers].sort(
      (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (b.value || 0) - (a.value || 0)
    );
  }

  function ownershipTreeFill(delta) {
    const tone = ownershipDeltaClass(delta);
    if (tone === "is-flat" || delta == null) {
      return { bg: "hsl(var(--muted))", fg: "var(--text-dim)", tone };
    }
    const mag = Math.min(1, Math.abs(Number(delta)) / 8);
    const a = (0.28 + mag * 0.55).toFixed(3);
    if (tone === "is-up") {
      return { bg: `hsl(var(--positive) / ${a})`, fg: "#fff", tone };
    }
    return { bg: `hsl(var(--negative) / ${a})`, fg: "#fff", tone };
  }

  function ownershipTreemapCellHTML(cell, layoutW, layoutH, windowKey) {
    const left = (cell.x / layoutW) * 100;
    const topPct = (cell.y / layoutH) * 100;
    const width = (cell.w / layoutW) * 100;
    const height = (cell.h / layoutH) * 100;
    const area = cell.w * cell.h;
    const isWide = cell.w >= cell.h * 1.05;
    const showDelta = area > 2800 || (isWide && cell.h > 24) || cell.w > 56;
    const showName = isWide
      ? cell.w > 54 && cell.h > 22
      : cell.w > 48 && cell.h > 30;
    const showThumb = isWide
      ? cell.w > 100 && cell.h > 30
      : cell.w > 70 && cell.h > 52;
    const delta = cell.delta;
    const paint = ownershipTreeFill(delta);
    const deltaLbl = fmtOwnershipTrendDelta(delta);
    const charBudget = Math.max(3, Math.floor((cell.w - (showThumb ? 36 : 10)) / 7.2));
    const short = ownershipTreemapShortName(cell.row, charBudget);
    let thumb = "";
    if (showThumb) {
      if (cell.row.kind === "team") {
        thumb =
          badgeHTML(cell.row.team, "ownership-treemap-crest") ||
          teamCrestFallbackHTML(cell.row.team, "ownership-treemap-crest ownership-photo-fallback");
      } else {
        thumb = ownershipPhotoHTML(cell.row, null, { eager: true }).replace(
          /class="ownership-photo/g,
          'class="ownership-photo ownership-treemap-photo'
        );
      }
    }
    const tip = `${cell.row.name} · live ${fmtOwnedPct(cell.row.live)} · ${ownershipTreeWindowLabel(windowKey)} ${deltaLbl}`;
    const cls = [
      "ownership-treemap-cell",
      paint.tone,
      isWide ? "is-wide" : "",
    ].filter(Boolean).join(" ");
    return `<button type="button" class="${cls}"
      style="left:${left.toFixed(2)}%;top:${topPct.toFixed(2)}%;width:${width.toFixed(2)}%;height:${height.toFixed(2)}%;--ot-bg:${paint.bg};--ot-fg:${paint.fg}"
      data-own-key="${escapeHtml(cell.row.key)}"
      aria-label="${escapeHtml(tip)}"${tipAttr(tip)}>
      ${thumb}
      ${showName || showDelta ? `<span class="ownership-treemap-meta">${
        showName ? `<span class="ownership-treemap-name">${escapeHtml(short)}</span>` : ""
      }${showDelta ? `<span class="ownership-treemap-delta">${escapeHtml(deltaLbl)}</span>` : ""}</span>` : ""}
    </button>`;
  }

  let ownershipTreemapLayoutSig = "";
  let ownershipTreemapRelayoutTimer = 0;

  function ownershipTreemapSignature(windowKey, items, layout) {
    const codes = (items || [])
      .map((it) => `${it.row && it.row.key}:${Math.round((it.value || 0) * 1000)}`)
      .join(",");
    return [
      windowKey,
      state.view,
      layout.w,
      layout.h,
      layout.preferHorizontal ? 1 : 0,
      codes,
    ].join("|");
  }

  function renderOwnershipTreemap({ force = false } = {}) {
    if (!el.ownershipTreemapPlot) return;
    const windowKey = ownershipTreeWindow();
    const items = ownershipTreemapItems(windowKey);
    const noun = state.view === "teams" ? "teams" : "movers";

    if (el.ownershipCountLabel) {
      el.ownershipCountLabel.textContent = items.length
        ? `${items.length} ${noun}`
        : `No ${noun}`;
    }

    if (!items.length) {
      ownershipTreemapLayoutSig = "";
      el.ownershipTreemapPlot.innerHTML = "";
      if (el.ownershipTreemapEmpty) el.ownershipTreemapEmpty.hidden = false;
      return;
    }
    if (el.ownershipTreemapEmpty) el.ownershipTreemapEmpty.hidden = true;

    const { w: layoutW, h: layoutH, preferHorizontal } = ownershipTreemapLayoutSize();
    const sig = ownershipTreemapSignature(windowKey, items, {
      w: layoutW,
      h: layoutH,
      preferHorizontal,
    });
    // Skip identical rebuilds — wiping thumbs/crests and reloading imgs is the
    // flicker when opening treemap (size-settle + scrollport height both retrigger).
    if (
      !force &&
      sig === ownershipTreemapLayoutSig &&
      el.ownershipTreemapPlot.childElementCount > 0
    ) {
      return;
    }
    ownershipTreemapLayoutSig = sig;
    const layout = squarifyRects(items, layoutW, layoutH, { preferHorizontal });
    el.ownershipTreemapPlot.innerHTML = layout
      .map((cell) => ownershipTreemapCellHTML(cell, layoutW, layoutH, windowKey))
      .join("");
    bindOwnershipPhotoFallback(el.ownershipTreemapPlot);
    // First paint while flex is settling often has a 0×0 plot — reflow once sized.
    const plot = el.ownershipTreemapPlot;
    if (plot && (plot.clientWidth < 40 || plot.clientHeight < 40)) {
      requestAnimationFrame(() => {
        if (!(state.page === "ownership" && ownershipIsTreemap())) return;
        const next = ownershipTreemapLayoutSize();
        if (next.w === layoutW && next.h === layoutH) return;
        scheduleOwnershipTreemapRelayout();
      });
    }
  }

  function scheduleOwnershipTreemapRelayout() {
    if (!(state.page === "ownership" && ownershipIsTreemap())) return;
    window.clearTimeout(ownershipTreemapRelayoutTimer);
    ownershipTreemapRelayoutTimer = window.setTimeout(() => {
      if (state.page === "ownership" && ownershipIsTreemap()) renderOwnershipTreemap();
    }, 80);
  }

  function syncOwnershipWindowUI({ animate = false } = {}) {
    if (!el.ownershipWindowSeg) return;
    const cur = ownershipTreeWindow();
    el.ownershipWindowSeg.querySelectorAll("[data-ownership-window]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.ownershipWindow === cur);
    });
    syncSegThumb(el.ownershipWindowSeg, { animate });
  }

  function syncOwnershipViewMode() {
    const treemap = ownershipIsTreemap();
    if (el.ownershipPage) el.ownershipPage.classList.toggle("is-treemap", treemap);
    if (el.ownershipMoverSeg) el.ownershipMoverSeg.hidden = treemap;
    if (el.ownershipWindowSeg) el.ownershipWindowSeg.hidden = !treemap;
    if (el.ownershipTableWrap) el.ownershipTableWrap.hidden = treemap;
    if (el.ownershipTreemap) el.ownershipTreemap.hidden = !treemap;
    if (el.ownershipTreemapToggle) {
      el.ownershipTreemapToggle.classList.toggle("on", treemap);
      el.ownershipTreemapToggle.setAttribute("aria-pressed", treemap ? "true" : "false");
    }
    if (treemap) syncOwnershipWindowUI();
  }

  function syncOwnershipMoverUI({ animate = false } = {}) {
    if (!el.ownershipMoverSeg) return;
    const cur = ownershipMoverKind();
    el.ownershipMoverSeg.querySelectorAll("[data-ownership-kind]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.ownershipKind === cur);
    });
    syncSegThumb(el.ownershipMoverSeg, { animate });
  }

  function hideOwnershipTooltip() {}
  function hideOwnershipSelection() {}

  function renderOwnership({ animateEnter = false } = {}) {
    if (!el.ownershipTableBody || !el.ownershipTableHead) return;
    syncOwnershipViewMode();
    syncOwnershipMoverUI();
    const checkIns = ownershipCheckIns();
    const scrollSnap =
      !ownershipIsTreemap() && el.ownershipTableWrap
        ? captureScrollWraps([el.ownershipTableWrap])
        : null;

    if (ownershipIsTreemap()) {
      if (!checkIns.length) {
        if (el.ownershipCountLabel) el.ownershipCountLabel.textContent = "No check-ins";
        if (el.ownershipTreemapPlot) el.ownershipTreemapPlot.innerHTML = "";
        if (el.ownershipTreemapEmpty) {
          el.ownershipTreemapEmpty.hidden = false;
          el.ownershipTreemapEmpty.textContent =
            "No ownership check-ins yet. Run python3 site/fetch_ownership.py to capture selected-by-%.";
        }
      } else {
        if (el.ownershipTreemapEmpty) {
          el.ownershipTreemapEmpty.textContent = "No movers match the current filters.";
        }
        renderOwnershipTreemap();
      }
      syncFiltersResetUI();
      syncPageUpdatedFooter(el.ownershipUpdatedFooter, pageDataUpdatedIso("ownership"));
      // Height settle may change plot size once; signature skip avoids a no-op wipe.
      requestAnimationFrame(() => {
        syncMobileScrollportHeight();
      });
      return;
    }

    const ranked = ownershipRankedMovers();
    const visible = sortOwnershipRows(ownershipVisibleMovers());
    if (el.ownershipCountLabel) {
      if (!checkIns.length) {
        el.ownershipCountLabel.textContent = "No check-ins";
      } else {
        const noun = ownershipMoverKind() === "fallers" ? "fallers" : "risers";
        const shown = visible.length;
        const total = ranked.length;
        el.ownershipCountLabel.textContent =
          shown === total
            ? `${shown} ${noun}`
            : `${shown} of ${total} ${noun}`;
      }
    }
    el.ownershipTableHead.innerHTML = ownershipHeadHTML();
    if (!checkIns.length) {
      el.ownershipTableBody.innerHTML = `<tr class="ownership-empty-row"><td class="col-player" colspan="8">No ownership check-ins yet. Run <code>python3 site/fetch_ownership.py</code> to capture selected-by-%.</td></tr>`;
    } else if (!visible.length) {
      el.ownershipTableBody.innerHTML = `<tr class="ownership-empty-row"><td class="col-player" colspan="8">No ${ownershipMoverKind()} match the current filters.</td></tr>`;
    } else {
      el.ownershipTableBody.innerHTML = visible.map((row, i) => ownershipRowHTML(row, i + 1)).join("");
      bindOwnershipPhotoFallback(el.ownershipTableBody);
    }
    syncFiltersResetUI();
    syncPageUpdatedFooter(el.ownershipUpdatedFooter, pageDataUpdatedIso("ownership"));
    bindAllNameColumnSimplifies();
    scheduleOptaMobileNameColWidth();
    if (scrollSnap) restoreScrollWraps(scrollSnap);
    requestAnimationFrame(() => syncMobileScrollportHeight());
    // Page enter: leave rolls empty — playPageEnter owns the single motion.
    // Risers/fallers toggle: animateEnter starts motion without a full page enter.
    const pageEntering =
      el.ownershipPage &&
      (el.ownershipPage.classList.contains("is-entering") ||
        el.ownershipPage.classList.contains("is-enter-pending"));
    if (animateEnter && el.ownershipPage) {
      el.ownershipPage.classList.add("is-enter-pending");
      startOwnershipEnterMotion(el.ownershipPage);
    } else if (pageEntering) {
      /* empty rolls for playPageEnter */
    } else if (el.ownershipPage) {
      finishOwnershipStatRolls(el.ownershipPage);
    }
  }

  let ownershipEnterMotionToken = 0;
  const OWNERSHIP_ENTER_ROLL_MS_MIN = 420;
  const OWNERSHIP_ENTER_ROLL_MS_MAX = 1600;

  function finishOwnershipStatRolls(root) {
    if (!root) return;
    root.querySelectorAll(".ownership-stat-roll[data-count-to]").forEach(finishStatRollNode);
  }

  /** Larger |value| → longer odometer (ownership % and Δ pills). */
  function ownershipRollDurationMs(value) {
    const mag = Math.abs(Number(value));
    if (!Number.isFinite(mag)) return OWNERSHIP_ENTER_ROLL_MS_MIN;
    const scaled = OWNERSHIP_ENTER_ROLL_MS_MIN + Math.sqrt(mag) * 140;
    return Math.round(
      Math.min(OWNERSHIP_ENTER_ROLL_MS_MAX, Math.max(OWNERSHIP_ENTER_ROLL_MS_MIN, scaled))
    );
  }

  function startOwnershipEnterMotion(pane) {
    if (!pane) return;
    if (prefersReducedMotion()) {
      pane.classList.remove("is-enter-pending");
      finishOwnershipStatRolls(pane);
      return;
    }
    const token = ++ownershipEnterMotionToken;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (token !== ownershipEnterMotionToken) return;
        pane.classList.remove("is-enter-pending");
        const nodes = [...pane.querySelectorAll(".ownership-stat-roll[data-count-to]")];
        if (!nodes.length) return;
        let maxMs = OWNERSHIP_ENTER_ROLL_MS_MIN;
        nodes.forEach((node) => {
          const ms = ownershipRollDurationMs(node.dataset.countTo);
          maxMs = Math.max(maxMs, ms);
          animateStatRollNode(node, { duration: ms });
        });
        window.setTimeout(() => {
          if (token !== ownershipEnterMotionToken) return;
          finishOwnershipStatRolls(pane);
        }, maxMs + 80);
      });
    });
  }

  const PRICES_STATUS_ORDER = {
    very_likely_rise: 0,
    likely_rise: 1,
    very_likely_drop: 2,
    likely_drop: 3,
  };

  function pricesPassesProgressFilter(row) {
    const p = Number(row.progress);
    if (!Number.isFinite(p)) return false;
    return Math.abs(p) >= state.pricesProgressMinAbs;
  }

  function pricesBaseFilteredRows() {
    return (PRICES.players || []).filter((row) => pricesPassesProgressFilter(row));
  }

  function clampPricesScrollAfterUpdate() {
    const main = document.querySelector("main.main");
    if (main) {
      const maxTop = Math.max(0, main.scrollHeight - main.clientHeight);
      if (main.scrollTop > maxTop) main.scrollTop = maxTop;
    }
    if (el.pricesPredictionWrap && pricesViewMode() === "prediction") {
      const wrap = el.pricesPredictionWrap;
      const maxTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
      if (wrap.scrollTop > maxTop) wrap.scrollTop = maxTop;
    }
    pricesActiveTableWraps().forEach((wrap) => {
      const maxLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
      if (wrap.scrollLeft > maxLeft) wrap.scrollLeft = maxLeft;
      invalidateNameSimplifyOrigin(wrap);
      if (nameSimplifyActive()) updateNameColumnSimplify(wrap);
    });
  }

  function settlePricesLayoutAfterUpdate() {
    requestAnimationFrame(() => {
      clampPricesScrollAfterUpdate();
      syncMobileScrollportHeight();
      scheduleOptaMobileNameColWidth();
      syncPricesPredictionColumns();
      syncPricesActualLayout();
      syncSegThumb(el.pricesViewSeg);
      syncSegThumb(el.pricesPredictionScopeSeg);
      syncSegThumb(el.pricesActualScopeSeg);
      requestAnimationFrame(() => {
        clampPricesScrollAfterUpdate();
        syncPricesPredictionColumns();
        syncPricesActualLayout();
        syncSegThumb(el.pricesViewSeg);
        syncSegThumb(el.pricesPredictionScopeSeg);
        syncSegThumb(el.pricesActualScopeSeg);
      });
    });
  }

  const PRICES_PREDICTION_COLUMNS_MIN_W = 960;
  const PRICES_SPARK_FIT_MIN_W = 168;
  let pricesPredictionColumnsFailedAt = 0;
  let pricesPredictionColumnsRaf = 0;
  let pricesPredictionColumnsObserver = null;

  function pricesSparkFits(spark) {
    if (!spark) return true;
    return spark.getBoundingClientRect().width >= PRICES_SPARK_FIT_MIN_W - 1;
  }

  function pricesPredictionTableTruncated(wrap) {
    if (!wrap || wrap.offsetParent === null) return false;
    const table = wrap.querySelector(":scope > table");
    if (table && table.scrollWidth > wrap.clientWidth + 1) return true;
    if (wrap.scrollWidth > wrap.clientWidth + 1) return true;
    const sparks = wrap.querySelectorAll(
      "td.prices-col-spark .prices-spark:not(.prices-spark-empty)"
    );
    for (const spark of sparks) {
      if (!pricesSparkFits(spark)) return true;
    }
    return false;
  }

  function syncPricesPredictionColumns() {
    const panels = el.pricesPredictionPanels;
    if (!panels) return;
    const active =
      !NARROW_MQ.matches &&
      state.page === "prices" &&
      pricesViewMode() === "prediction" &&
      !panels.hidden &&
      panels.offsetParent !== null;
    if (!active) {
      panels.classList.remove("is-columns");
      panels.dataset.columnsFit = "";
      return;
    }

    const vw = window.innerWidth;
    if (vw < PRICES_PREDICTION_COLUMNS_MIN_W) {
      panels.classList.remove("is-columns");
      panels.dataset.columnsFit = "0";
      return;
    }

    const wraps = pricesPredictionTableWraps();
    const canTryColumns =
      panels.classList.contains("is-columns") || vw > pricesPredictionColumnsFailedAt + 40;

    if (!canTryColumns) {
      panels.classList.remove("is-columns");
      panels.dataset.columnsFit = "0";
      return;
    }

    panels.classList.add("is-columns");
    void panels.offsetWidth;
    const truncated = wraps.some((wrap) => pricesPredictionTableTruncated(wrap));
    if (truncated) {
      panels.classList.remove("is-columns");
      panels.dataset.columnsFit = "0";
      pricesPredictionColumnsFailedAt = vw;
      return;
    }

    panels.dataset.columnsFit = "1";
    pricesPredictionColumnsFailedAt = 0;
  }

  function schedulePricesPredictionColumnsSync() {
    if (pricesPredictionColumnsRaf) cancelAnimationFrame(pricesPredictionColumnsRaf);
    pricesPredictionColumnsRaf = requestAnimationFrame(() => {
      pricesPredictionColumnsRaf = requestAnimationFrame(() => {
        pricesPredictionColumnsRaf = 0;
        syncPricesPredictionColumns();
      });
    });
  }

  function bindPricesPredictionColumnsObserver() {
    if (pricesPredictionColumnsObserver || !el.pricesPredictionWrap) return;
    pricesPredictionColumnsObserver = new ResizeObserver(() => {
      if (state.page === "prices" && pricesViewMode() === "prediction") {
        schedulePricesPredictionColumnsSync();
      }
    });
    pricesPredictionColumnsObserver.observe(el.pricesPredictionWrap);
  }

  let _pricesTextMeasureCanvas = null;
  function measurePricesTextWidth(text, refEl) {
    if (!_pricesTextMeasureCanvas) {
      _pricesTextMeasureCanvas = document.createElement("canvas");
    }
    const ctx = _pricesTextMeasureCanvas.getContext("2d");
    const style = refEl ? getComputedStyle(refEl) : null;
    const weight = style?.fontWeight || "400";
    const size = style?.fontSize || "14px";
    const family = style?.fontFamily || "sans-serif";
    ctx.font = `${weight} ${size} ${family}`;
    return ctx.measureText(String(text || "").trim()).width;
  }

  const PRICES_ACTUAL_COLUMNS_MIN_W = 960;
  let pricesActualColumnsFailedAt = 0;

  function pricesActualTableTruncated(wrap) {
    if (!wrap || wrap.offsetParent === null) return false;
    const table = wrap.querySelector(":scope > table");
    if (table && table.scrollWidth > wrap.clientWidth + 1) return true;
    if (wrap.scrollWidth > wrap.clientWidth + 1) return true;
    const dateCells = wrap.querySelectorAll(
      "td.prices-col-date, td.prices-actual-day, th.prices-col-date"
    );
    for (const cell of dateCells) {
      if (cell.clientWidth > 0 && cell.scrollWidth > cell.clientWidth + 1) return true;
    }
    const metricCells = wrap.querySelectorAll(
      "th.prices-col-before, th.prices-col-after, th.prices-col-owned, th.prices-col-league-owned, td.prices-col-before, td.prices-col-after, td.prices-col-owned, td.prices-col-league-owned"
    );
    for (const cell of metricCells) {
      if (cell.offsetParent === null || cell.clientWidth === 0) continue;
      if (cell.scrollWidth > cell.clientWidth + 1) return true;
    }
    return false;
  }

  function applyPricesActualLayout({ columns, hideBefore, hideLeague }) {
    const panels = el.pricesActualPanels;
    const root = el.pricesActualWrap;
    if (!panels || !root) return;
    panels.classList.toggle("is-columns", !!columns);
    root.dataset.actualHideBefore = hideBefore ? "1" : "0";
    root.dataset.actualHideLeague = hideLeague ? "1" : "0";
  }

  function measurePricesCellPadding(cell) {
    if (!cell) return 0;
    const cs = getComputedStyle(cell);
    return (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  }

  function measurePricesActualMobilePlayerWidth(wrap) {
    return measureNameColWidth(wrap, {
      minW: PRICES_ACTUAL_MOBILE_PLAYER_MIN,
      hugContent: true,
      slack: 4,
    });
  }

  function syncPricesActualColumnWidths() {
    const wraps = pricesActualTableWraps();
    const active =
      state.page === "prices" && pricesViewMode() === "actual" && wraps.length;
    const mobile = NARROW_MQ.matches;
    const clearMobileLayoutVars = (wrap) => {
      wrap.style.removeProperty("--prices-actual-date-col-w");
      wrap.style.removeProperty("--prices-actual-tsb-col-w");
      wrap.style.removeProperty("--prices-actual-player-col-w");
      wrap.style.removeProperty("--prices-actual-metric-col-w");
      wrap.style.removeProperty("--prices-actual-change-col-w");
      wrap.style.removeProperty("--prices-actual-after-col-w");
      wrap.style.removeProperty("--name-col-w");
    };
    if (!active) {
      wraps.forEach(clearMobileLayoutVars);
      return;
    }

    const visibleWraps = wraps.filter((wrap) => wrap && !wrap.hidden && wrap.offsetParent !== null);
    if (!visibleWraps.length) return;

    const dateRef =
      visibleWraps[0].querySelector("th.prices-col-date") ||
      visibleWraps[0].querySelector("td.prices-col-date, td.prices-actual-day") ||
      visibleWraps[0];
    const tsbRef =
      visibleWraps[0].querySelector("th.prices-col-owned, td.prices-col-owned") || dateRef;
    const afterRef = visibleWraps[0].querySelector("th.prices-col-after");

    let maxDate = measurePricesTextWidth("Date", dateRef);
    let maxTsb = 0;
    let maxPlayer = PRICES_ACTUAL_MOBILE_PLAYER_MIN;
    let maxAfter = measurePricesTextWidth("After", afterRef);

    visibleWraps.forEach((wrap) => {
      maxPlayer = Math.max(maxPlayer, measurePricesActualMobilePlayerWidth(wrap));
      wrap
        .querySelectorAll("td.prices-col-date, td.prices-actual-day")
        .forEach((cell) => {
          maxDate = Math.max(maxDate, measurePricesTextWidth(cell.textContent, cell));
        });
      wrap.querySelectorAll("td.prices-col-after").forEach((cell) => {
        maxAfter = Math.max(maxAfter, measurePricesTextWidth(cell.textContent, cell));
      });
      if (!mobile) {
        wrap
          .querySelectorAll(
            "th.prices-col-owned, th.prices-col-league-owned, td.prices-col-owned, td.prices-col-league-owned"
          )
          .forEach((cell) => {
            if (cell.offsetParent === null) return;
            const pill = cell.querySelector(".ownership-pill");
            if (pill) {
              maxTsb = Math.max(maxTsb, pill.getBoundingClientRect().width);
            } else {
              maxTsb = Math.max(maxTsb, measurePricesTextWidth(cell.textContent, cell));
            }
          });
      }
    });

    if (mobile) {
      const tableW = Math.max(
        ...visibleWraps.map((wrap) => wrap.clientWidth || 0),
        280
      );
      const dateW = Math.ceil(maxDate + 18);
      const afterPad = Math.max(14, measurePricesCellPadding(afterRef));
      let afterW = Math.max(
        PRICES_ACTUAL_MOBILE_AFTER_MIN,
        Math.ceil(maxAfter + afterPad)
      );
      let playerW = maxPlayer;
      let slack = tableW - (dateW + playerW + afterW);
      if (slack > 0) {
        playerW += slack;
      } else if (slack < 0) {
        playerW = Math.max(PRICES_ACTUAL_MOBILE_PLAYER_MIN, playerW + slack);
      }

      visibleWraps.forEach((wrap) => {
        wrap.style.setProperty("--prices-actual-date-col-w", `${dateW}px`);
        wrap.style.setProperty("--prices-actual-player-col-w", `${playerW}px`);
        wrap.style.setProperty("--prices-actual-metric-col-w", `${afterW}px`);
        wrap.style.removeProperty("--prices-actual-change-col-w");
        wrap.style.removeProperty("--prices-actual-after-col-w");
        wrap.style.removeProperty("--prices-actual-tsb-col-w");
      });
      return;
    }

    const dateW = Math.ceil(maxDate + 16);
    const tsbW = Math.ceil(Math.max(40, maxTsb + 12));

    wraps.forEach((wrap) => {
      clearMobileLayoutVars(wrap);
      wrap.style.setProperty("--prices-actual-date-col-w", `${dateW}px`);
      wrap.style.setProperty("--prices-actual-tsb-col-w", `${tsbW}px`);
    });
  }

  function syncPricesActualLayout() {
    const panels = el.pricesActualPanels;
    const wraps = pricesActualTableWraps();
    const root = el.pricesActualWrap;
    const active =
      !NARROW_MQ.matches &&
      state.page === "prices" &&
      pricesViewMode() === "actual" &&
      panels &&
      root &&
      !root.hidden &&
      panels.offsetParent !== null &&
      wraps.length;

    if (!active) {
      if (panels) {
        panels.classList.remove("is-columns");
        panels.dataset.columnsFit = "";
        panels.dataset.actualCompact = "";
      }
      if (root) {
        root.dataset.actualHideBefore = "";
        root.dataset.actualHideLeague = "";
      }
      syncPricesActualColumnWidths();
      return;
    }

    const vw = window.innerWidth;
    const configs = [
      { columns: true, hideBefore: false, hideLeague: false },
      { columns: true, hideBefore: true, hideLeague: false },
      { columns: true, hideBefore: true, hideLeague: true },
      { columns: false, hideBefore: false, hideLeague: false },
      { columns: false, hideBefore: true, hideLeague: false },
      { columns: false, hideBefore: true, hideLeague: true },
    ];

    const canTryColumns =
      panels.classList.contains("is-columns") || vw > pricesActualColumnsFailedAt + 40;

    let chosen = configs[configs.length - 1];
    for (const cfg of configs) {
      if (cfg.columns) {
        if (vw < PRICES_ACTUAL_COLUMNS_MIN_W || !canTryColumns) continue;
      }
      applyPricesActualLayout(cfg);
      syncPricesActualColumnWidths();
      void panels.offsetWidth;
      if (!wraps.some((wrap) => pricesActualTableTruncated(wrap))) {
        chosen = cfg;
        if (cfg.columns) pricesActualColumnsFailedAt = 0;
        break;
      }
      if (cfg.columns) pricesActualColumnsFailedAt = vw;
    }

    applyPricesActualLayout(chosen);
    syncPricesActualColumnWidths();
    panels.dataset.columnsFit = chosen.columns ? "1" : "0";
    panels.dataset.actualCompact = chosen.hideBefore || chosen.hideLeague ? "1" : "0";
  }

  let pricesActualColumnsRaf = 0;
  function schedulePricesActualColumnsSync() {
    if (pricesActualColumnsRaf) cancelAnimationFrame(pricesActualColumnsRaf);
    pricesActualColumnsRaf = requestAnimationFrame(() => {
      pricesActualColumnsRaf = requestAnimationFrame(() => {
        pricesActualColumnsRaf = 0;
        syncPricesActualLayout();
      });
    });
  }

  let pricesActualColumnsObserver = null;
  function bindPricesActualColumnsObserver() {
    if (pricesActualColumnsObserver || !el.pricesActualWrap) return;
    pricesActualColumnsObserver = new ResizeObserver(() => {
      if (state.page === "prices" && pricesViewMode() === "actual") {
        schedulePricesActualColumnsSync();
      }
    });
    pricesActualColumnsObserver.observe(el.pricesActualWrap);
  }

  let pricesCountdownTimer = null;
  let pricesEnterMotionToken = 0;

  function pricesIsRiser(row) {
    return row.statusKey === "very_likely_rise" || row.statusKey === "likely_rise";
  }

  function pricesIsFaller(row) {
    return row.statusKey === "very_likely_drop" || row.statusKey === "likely_drop";
  }

  function pricesIsVeryLikelyMover(row) {
    return row.statusKey === "very_likely_rise" || row.statusKey === "very_likely_drop";
  }

  function pricesVisibleRows() {
    if (!isNextSeason()) return [];
    const catalog = ownershipCatalogByCode();
    return pricesBaseFilteredRows().filter((row) =>
      ownershipPlayerPassesDisplayFilters(row, catalog)
    );
  }

  function sortPricesPredictionByProgress(rows) {
    return rows.slice().sort((a, b) => {
      const ta = PRICES_STATUS_ORDER[a.statusKey] ?? 9;
      const tb = PRICES_STATUS_ORDER[b.statusKey] ?? 9;
      if (ta !== tb) return ta - tb;
      const pa = Math.abs(Number(a.progress));
      const pb = Math.abs(Number(b.progress));
      const aAbs = Number.isFinite(pa) ? pa : -Infinity;
      const bAbs = Number.isFinite(pb) ? pb : -Infinity;
      if (bAbs !== aAbs) return bAbs - aAbs;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  }

  function pricesVisibleRisers() {
    return sortPricesPredictionByProgress(
      pricesVisibleRows().filter((row) => pricesIsRiser(row))
    );
  }

  function pricesVisibleFallers() {
    return sortPricesPredictionByProgress(
      pricesVisibleRows().filter((row) => pricesIsFaller(row))
    );
  }

  const PRICES_SCOPE_TOP_N = 5;

  function limitPricesScopeRows(rows, catalog) {
    const byOwned = (list) =>
      list.slice().sort((a, b) => {
        const ownA = pricesActualOwnedPct(a, catalog);
        const ownB = pricesActualOwnedPct(b, catalog);
        if (ownA !== ownB) return ownB - ownA;
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
    const keep = new Set(byOwned(rows).slice(0, PRICES_SCOPE_TOP_N));
    return rows.filter((row) => keep.has(row));
  }

  function limitPricesPredictionMovers(rows) {
    if (state.pricesPredictionShowAll) return rows;
    return limitPricesScopeRows(rows, ownershipCatalogByCode());
  }

  function limitPricesActualDayRows(rows, catalog) {
    const rises = rows.filter((row) => row.direction === "rise");
    const falls = rows.filter((row) => row.direction !== "rise");
    const byOwned = (list) =>
      list.slice().sort((a, b) => {
        const ownA = pricesActualOwnedPct(a, catalog);
        const ownB = pricesActualOwnedPct(b, catalog);
        if (ownA !== ownB) return ownB - ownA;
        return String(a.name || "").localeCompare(String(b.name || ""));
      });
    const keep = new Set([
      ...byOwned(rises).slice(0, PRICES_SCOPE_TOP_N),
      ...byOwned(falls).slice(0, PRICES_SCOPE_TOP_N),
    ]);
    return rows.filter((row) => keep.has(row));
  }

  function limitPricesActualRows(rows) {
    if (state.pricesActualShowAll) return rows;
    const catalog = ownershipCatalogByCode();
    if (pricesActualUseDayGroups()) {
      const buckets = new Map();
      const order = [];
      rows.forEach((row) => {
        const day = pricesActualDayKey(row);
        if (!buckets.has(day)) {
          buckets.set(day, []);
          order.push(day);
        }
        buckets.get(day).push(row);
      });
      return order.flatMap((day) => limitPricesActualDayRows(buckets.get(day), catalog));
    }
    return limitPricesActualDayRows(rows, catalog);
  }

  function pricesActualVisibleRows() {
    if (!isNextSeason()) return [];
    const catalog = ownershipCatalogByCode();
    return (PRICES.actualChanges || []).filter((row) =>
      ownershipPlayerPassesDisplayFilters(row, catalog)
    );
  }

  function pricesActualOwnedPct(row, catalog) {
    const hit = catalog.get(Number(row.code));
    const owned = hit && hit.owned != null ? Number(hit.owned) : null;
    return Number.isFinite(owned) ? owned : -Infinity;
  }

  function pricesActualOwnedPctDisplay(row, catalog) {
    const hit = catalog.get(Number(row.code));
    const owned =
      hit && hit.owned != null ? Number(hit.owned) : currentOwnership(row.code);
    return Number.isFinite(owned) ? owned : null;
  }

  function pricesActualLeagueTsbPct(row) {
    const elementId = fplElementIdForRow(row);
    if (elementId == null) return null;
    const owners = homeOwnersForElement(elementId);
    const total = Array.isArray(HOME.standings) ? HOME.standings.length : 0;
    if (!total) return null;
    return Math.round((owners.size / total) * 1000) / 10;
  }

  function pricesActualSortValue(row, key, catalog) {
    if (key === "name") return String(row.name || "").toLowerCase();
    if (key === "change") return row.direction === "rise" ? 1 : 0;
    if (key === "before") return row.before == null ? -Infinity : Number(row.before);
    if (key === "after") return row.after == null ? -Infinity : Number(row.after);
    if (key === "owned") {
      const owned = pricesActualOwnedPctDisplay(row, catalog);
      return owned == null ? -Infinity : owned;
    }
    if (key === "leagueOwned") {
      const league = pricesActualLeagueTsbPct(row);
      return league == null ? -Infinity : league;
    }
    if (key === "changedAt") {
      const ms = Date.parse(row.changedAt || "");
      return Number.isFinite(ms) ? ms : -Infinity;
    }
    return -Infinity;
  }

  function sortPricesActualWithinDay(rows, catalog) {
    return rows.slice().sort((a, b) => {
      const dirA = a.direction === "rise" ? 1 : 0;
      const dirB = b.direction === "rise" ? 1 : 0;
      if (dirA !== dirB) return dirB - dirA;
      const ownA = pricesActualOwnedPct(a, catalog);
      const ownB = pricesActualOwnedPct(b, catalog);
      if (ownA !== ownB) return ownB - ownA;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });
  }

  function sortPricesActualRows(rows) {
    let key = state.pricesActualSortKey || "default";
    if (key === "change") key = "default";
    const dir = state.pricesActualSortDir === "asc" ? 1 : -1;
    const catalog = ownershipCatalogByCode();
    if (key === "default" || key === "changedAt") {
      const buckets = new Map();
      const order = [];
      rows.forEach((row) => {
        const day = pricesActualDayKey(row);
        if (!buckets.has(day)) {
          buckets.set(day, []);
          order.push(day);
        }
        buckets.get(day).push(row);
      });
      const dayDir = key === "changedAt" ? dir : -1;
      order.sort((a, b) => {
        const ta = Date.parse(buckets.get(a)[0]?.changedAt || "");
        const tb = Date.parse(buckets.get(b)[0]?.changedAt || "");
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
          return dayDir * (ta - tb);
        }
        return a.localeCompare(b);
      });
      return order.flatMap((day) => sortPricesActualWithinDay(buckets.get(day), catalog));
    }
    return rows.slice().sort((a, b) => {
      if (key === "name") {
        return dir * String(a.name || "").localeCompare(String(b.name || ""));
      }
      const va = pricesActualSortValue(a, key, catalog);
      const vb = pricesActualSortValue(b, key, catalog);
      if (va !== vb) return dir * (va - vb);
      return String(b.changedAt || "").localeCompare(String(a.changedAt || ""));
    });
  }

  function pricesSortArrow(key) {
    if (state.pricesActualSortKey !== key) return "";
    return `<span class="arrow">${iconHTML(state.pricesActualSortDir === "asc" ? "chevron-up" : "chevron-down")}</span>`;
  }

  function pricesStatusMobileLabel(statusKey) {
    if (statusKey === "very_likely_rise" || statusKey === "very_likely_drop") return "VL";
    if (statusKey === "likely_rise" || statusKey === "likely_drop") return "L";
    return "—";
  }

  function pricesStatusDesktopLabel(statusKey, statusLabel) {
    if (statusKey === "very_likely_rise" || statusKey === "very_likely_drop") return "Very likely";
    if (statusKey === "likely_rise" || statusKey === "likely_drop") return "Likely";
    return statusLabel || "—";
  }

  function pricesStatusPillHTML(row) {
    const cls = `prices-status-pill is-${String(row.statusKey || "").replace(/_/g, "-")}`;
    const mobile = NARROW_MQ.matches;
    const full = row.statusLabel || "—";
    const label = mobile
      ? pricesStatusMobileLabel(row.statusKey)
      : pricesStatusDesktopLabel(row.statusKey, full);
    const shortCls = mobile ? " is-short" : "";
    const up = row.trend === "up";
    const trendLabel = up ? "More transfers in than out" : "More transfers out than in";
    const trendIcon = iconHTML(up ? "trending-up" : "trending-down");
    const tipText =
      mobile && full !== label ? `${full} · ${trendLabel}` : `${label} · ${trendLabel}`;
    const tip = ` title="${escapeHtml(tipText)}" aria-label="${escapeHtml(`${label} — ${trendLabel}`)}"`;
    return `<span class="${cls}${shortCls} has-trend"${tip}><span class="prices-status-trend-icon" aria-hidden="true">${trendIcon}</span><span class="prices-status-label">${escapeHtml(label)}</span></span>`;
  }

  function pricesProgressPillHTML(value, { predicted = false } = {}) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    const n = Number(value);
    const tone = n > 0 ? "is-rise" : n < 0 ? "is-drop" : "is-flat";
    const cls = `prices-progress-pill ${tone}${predicted ? " is-predicted" : ""}`;
    return `<span class="${cls}">${escapeHtml(fmtPricesProgressPct(n))}</span>`;
  }

  function fmtPricesProgressPct(value) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    const n = Number(value);
    const signed = n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
    return `${signed}%`;
  }

  function pricesSparkHTML(row) {
    const series = row.spark || [];
    if (series.length < 2) {
      return `<span class="ownership-spark-empty prices-spark-empty">—</span>`;
    }
    const mobile = NARROW_MQ.matches;
    const w = mobile ? 56 : 92;
    const h = mobile ? 24 : 28;
    const padX = 2;
    const padY = 4;
    const lo = Math.min(...series);
    const hi = Math.max(...series);
    const rng = hi - lo || 1;
    const n = series.length;
    const pts = series.map((v, i) => {
      const x = padX + (i / (n - 1)) * (w - padX * 2);
      const y = h - padY - ((v - lo) / rng) * (h - padY * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const end = pts[pts.length - 1].split(",");
    const tone = ownershipDeltaClass(row.d3);
    const startLbl = fmtPricesProgressPct(row.sparkStart);
    const endLbl = fmtPricesProgressPct(row.sparkEnd);
    return `<span class="ownership-spark prices-spark ${tone}">
      <span class="ownership-spark-lab">${escapeHtml(startLbl)}</span>
      <svg class="ownership-spark-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
        <polyline points="${pts.join(" ")}" />
        <circle cx="${end[0]}" cy="${end[1]}" r="1.8" />
      </svg>
      <span class="ownership-spark-lab">${escapeHtml(endLbl)}</span>
    </span>`;
  }

  function pricesTableColSpan() {
    return 4;
  }

  function pricesActualTableColSpan() {
    return NARROW_MQ.matches ? 3 : 6;
  }

  function pricesHeadHTML() {
    const mobile = NARROW_MQ.matches;
    const th = (label, extra = "") => `<th class="${extra}">${escapeHtml(label)}</th>`;
    return `<tr>
      ${th("Player", "col-player")}
      ${th("Progress", "col-num prices-col-metric")}
      ${th(mobile ? "Predict" : "Predicted", "col-num prices-col-metric")}
      ${th(mobile ? "3d" : "3d trend", "col-num prices-col-spark")}
    </tr>`;
  }

  function pricesRowHTML(row, rank) {
    return `<tr data-prices-code="${escapeHtml(String(row.code ?? ""))}">
      <td class="col-player">${ownershipIdCellHTML(row, rank)}</td>
      <td class="col-num prices-col-metric">${pricesProgressPillHTML(row.progress)}</td>
      <td class="col-num prices-col-metric">${pricesProgressPillHTML(row.predicted, { predicted: true })}</td>
      <td class="col-num prices-col-spark">${pricesSparkHTML(row)}</td>
    </tr>`;
  }

  function pricesActualHeadHTML() {
    const mobile = NARROW_MQ.matches;
    if (mobile) {
      const th = (label, extra = "") => `<th class="${extra}">${escapeHtml(label)}</th>`;
      return `<tr>
        ${th("Date", "col-date prices-col-date")}
        ${th("Player", "col-player")}
        ${th("After", "col-num prices-col-actual-price prices-col-after")}
      </tr>`;
    }
    const th = (key, label, extra = "", title = "") => {
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<th class="${extra}${state.pricesActualSortKey === key ? " sorted" : ""}" data-prices-actual-sort="${key}"${titleAttr}>${escapeHtml(label)}${pricesSortArrow(key)}</th>`;
    };
    return `<tr>
      ${th("changedAt", "Date", "col-date prices-col-date")}
      ${th("name", "Player", "col-player")}
      ${th("before", "Before", "col-num prices-col-actual-price prices-col-before")}
      ${th("after", "After", "col-num prices-col-actual-price prices-col-after")}
      ${th("owned", "All(%)", "col-num prices-col-owned", "TSB% (All)")}
      ${th("leagueOwned", "ML(%)", "col-num prices-col-league-owned", "TSB% (Mini-League)")}
    </tr>`;
  }

  function pricesChangeArrowHTML(direction) {
    const up = direction === "rise";
    const cls = `prices-change-arrow ${up ? "is-rise" : "is-fall"}`;
    const label = up ? "Price rose" : "Price fell";
    return `<span class="${cls}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${iconHTML(up ? "trending-up" : "trending-down")}</span>`;
  }

  function pricesSectionArrowHTML(direction) {
    const up = direction === "rise";
    const cls = `prices-section-mark prices-section-arrow ${up ? "is-rise" : "is-fall"}`;
    const label = up ? "Risers" : "Fallers";
    return `<span class="${cls}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${iconHTML(up ? "trending-up" : "trending-down")}</span>`;
  }

  function syncPricesSectionMarks(root) {
    if (!root) return;
    root.querySelectorAll(".prices-section-divider[data-prices-direction]").forEach((div) => {
      const mark = div.querySelector(".prices-section-mark");
      if (!mark) return;
      const dir = div.dataset.pricesDirection === "fall" ? "fall" : "rise";
      mark.innerHTML = pricesSectionArrowHTML(dir);
    });
  }

  function fmtPricesActualPrice(value) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    return `£${Number(value).toFixed(1)}m`;
  }

  function pricesActualDayKey(rowOrIso) {
    if (rowOrIso && typeof rowOrIso === "object" && rowOrIso.changeNightUk) {
      return rowOrIso.changeNightUk;
    }
    const iso = typeof rowOrIso === "string" ? rowOrIso : rowOrIso?.changedAt;
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    try {
      return d.toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    } catch {
      return "";
    }
  }

  function fmtUkCalendarDateLabel(ukDate) {
    if (!ukDate) return "—";
    const parts = String(ukDate).split("-").map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return "—";
    const [year, month, day] = parts;
    const d = new Date(year, month - 1, day);
    if (Number.isNaN(d.getTime())) return "—";
    try {
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return "—";
    }
  }

  function fmtPricesChangeDateShort(iso, { compact = false } = {}) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    try {
      if (compact) {
        return d.toLocaleDateString(undefined, {
          month: "numeric",
          day: "numeric",
          timeZone: "Europe/London",
        });
      }
      return d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "Europe/London",
      });
    } catch {
      return "—";
    }
  }

  function pricesActualUseDayGroups() {
    const key = state.pricesActualSortKey || "default";
    return key === "default" || key === "changedAt";
  }

  function pricesActualPlayerCellHTML(row, rank) {
    return ownershipIdCellHTML(row, rank, { hidePrice: true });
  }

  function pricesActualMetricCellsHTML(row, catalog) {
    const mobile = NARROW_MQ.matches;
    let html = "";
    if (!mobile) {
      html += `<td class="col-num prices-col-actual-price prices-col-before">${escapeHtml(fmtPricesActualPrice(row.before))}</td>`;
    }
    html += `<td class="col-num prices-col-actual-price prices-col-after">${escapeHtml(fmtPricesActualPrice(row.after))}</td>`;
    if (!mobile) {
      html += `<td class="col-num prices-col-owned">${ownershipPillHTML(pricesActualOwnedPctDisplay(row, catalog), { live: true })}</td>`;
      html += `<td class="col-num prices-col-league-owned">${ownershipPillHTML(pricesActualLeagueTsbPct(row), { live: true })}</td>`;
    }
    return html;
  }

  function pricesActualDateLabel(rowOrIso) {
    if (rowOrIso && typeof rowOrIso === "object" && rowOrIso.changeNightUk) {
      return fmtUkCalendarDateLabel(rowOrIso.changeNightUk);
    }
    return fmtPricesChangeDateShort(
      typeof rowOrIso === "string" ? rowOrIso : rowOrIso?.changedAt
    );
  }

  function pricesActualRowHTML(row, rank, { dateCell = "", catalog = null } = {}) {
    const cat = catalog || ownershipCatalogByCode();
    const dateTd =
      dateCell ||
      `<td class="col-date prices-col-date">${escapeHtml(pricesActualDateLabel(row))}</td>`;
    return `<tr data-prices-code="${escapeHtml(String(row.code ?? ""))}">
      ${dateTd}
      <td class="col-player">${pricesActualPlayerCellHTML(row, rank)}</td>
      ${pricesActualMetricCellsHTML(row, cat)}
    </tr>`;
  }

  function pricesActualBodyHTML(rows) {
    if (!rows.length) return "";
    const catalog = ownershipCatalogByCode();
    if (!pricesActualUseDayGroups()) {
      return rows.map((row, i) => pricesActualRowHTML(row, i + 1, { catalog })).join("");
    }

    const groups = [];
    let group = null;
    rows.forEach((row) => {
      const day = pricesActualDayKey(row);
      if (!group || group.day !== day) {
        group = { day, labelRow: row, rows: [] };
        groups.push(group);
      }
      group.rows.push(row);
    });

    let rank = 1;
    let html = "";
    groups.forEach((g) => {
      g.rows.forEach((row, idx) => {
        const dayStart = idx === 0;
        const dateCell = dayStart
          ? `<td class="col-date prices-col-date prices-actual-day" rowspan="${g.rows.length}">${escapeHtml(pricesActualDateLabel(g.labelRow))}</td>`
          : "";
        const trCls = dayStart ? ' class="prices-actual-day-start"' : "";
        html += `<tr${trCls} data-prices-code="${escapeHtml(String(row.code ?? ""))}">`;
        if (dateCell) html += dateCell;
        html += `<td class="col-player">${pricesActualPlayerCellHTML(row, rank++)}</td>`;
        html += pricesActualMetricCellsHTML(row, catalog);
        html += `</tr>`;
      });
    });
    return html;
  }

  function pricesMoverKind() {
    return state.pricesMoverKind === "fallers" ? "fallers" : "risers";
  }

  function syncPricesMoverKindUI({ animate = false } = {}) {
    if (!el.pricesPage) return;
    const mobile = NARROW_MQ.matches && state.page === "prices";
    if (el.pricesMoverKindSeg) {
      el.pricesMoverKindSeg.hidden = !mobile;
      const kind = pricesMoverKind();
      el.pricesMoverKindSeg.querySelectorAll("[data-prices-mover-kind]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.pricesMoverKind === kind);
      });
      syncSegThumb(el.pricesMoverKindSeg, { animate });
    }
    if (mobile) {
      el.pricesPage.dataset.pricesMover = pricesMoverKind();
    } else {
      delete el.pricesPage.dataset.pricesMover;
    }
  }

  function syncPricesScopeSeg(seg, { show, showAll, topTitle, allTitle }) {
    if (!seg) return;
    seg.hidden = !show;
    const topBtn = seg.querySelector('button[data-prices-scope="top"]');
    const allBtn = seg.querySelector('button[data-prices-scope="all"]');
    if (topBtn) {
      topBtn.title = topTitle;
      const active = !showAll;
      topBtn.classList.toggle("active", active);
      topBtn.setAttribute("aria-pressed", active ? "true" : "false");
    }
    if (allBtn) {
      allBtn.title = allTitle;
      const active = showAll;
      allBtn.classList.toggle("active", active);
      allBtn.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  function syncPricesViewUI() {
    const mode = pricesViewMode();
    if (el.pricesViewSeg) {
      el.pricesViewSeg.querySelectorAll("button[data-prices-view]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.pricesView === mode);
      });
    }
    if (el.pricesPage) {
      el.pricesPage.dataset.pricesView = mode;
    }
    if (el.pricesPredictionWrap) {
      el.pricesPredictionWrap.hidden = mode !== "prediction";
    }
    if (el.pricesActualWrap) {
      el.pricesActualWrap.hidden = mode !== "actual";
    }
    if (el.pricesProgressFilterGroup) {
      el.pricesProgressFilterGroup.style.display =
        state.page === "prices" && mode === "prediction" ? "" : "none";
    }
    if (el.pricesPredictionScopeSeg) {
      syncPricesScopeSeg(el.pricesPredictionScopeSeg, {
        show: state.page === "prices" && mode === "prediction" && isNextSeason(),
        showAll: state.pricesPredictionShowAll,
        topTitle: "Top 5 risers and fallers by ownership",
        allTitle: "Every price mover matching filters",
      });
    }
    if (el.pricesActualScopeSeg) {
      syncPricesScopeSeg(el.pricesActualScopeSeg, {
        show: state.page === "prices" && mode === "actual" && isNextSeason(),
        showAll: state.pricesActualShowAll,
        topTitle: "Top 5 risers and fallers by ownership per day",
        allTitle: "Every recorded price change",
      });
    }
    syncPricesMoverKindUI();
    requestAnimationFrame(() => {
      syncSegThumb(el.pricesViewSeg);
      syncSegThumb(el.pricesMoverKindSeg);
      syncSegThumb(el.pricesPredictionScopeSeg);
      syncSegThumb(el.pricesActualScopeSeg);
    });
  }

  const PRICES_LONDON_TZ = "Europe/London";

  function pricesLondonParts(date) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: PRICES_LONDON_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const out = {};
    for (const p of parts) {
      if (p.type !== "literal") out[p.type] = Number(p.value);
    }
    return out;
  }

  function pricesLondonWallToUtc(year, month, day, hour, minute, second) {
    let utc = Date.UTC(year, month - 1, day, hour, minute, second);
    for (let i = 0; i < 4; i++) {
      const got = pricesLondonParts(new Date(utc));
      const desired = Date.UTC(year, month - 1, day, hour, minute, second);
      const actual = Date.UTC(
        got.year,
        got.month - 1,
        got.day,
        got.hour,
        got.minute,
        got.second
      );
      utc += desired - actual;
    }
    return new Date(utc);
  }

  function pricesAddLondonDays(year, month, day, addDays) {
    const anchor = pricesLondonWallToUtc(year, month, day, 12, 0, 0);
    anchor.setUTCDate(anchor.getUTCDate() + addDays);
    const p = pricesLondonParts(anchor);
    return { year: p.year, month: p.month, day: p.day };
  }

  /** Next 00:00 Europe/London — mirrors price_changes_lib.next_price_change_at_iso(). */
  function pricesNextChangeAtIso(from = new Date()) {
    const p = pricesLondonParts(from);
    let y = p.year;
    let mo = p.month;
    let d = p.day;
    const todayMidnight = pricesLondonWallToUtc(y, mo, d, 0, 0, 0);
    if (from.getTime() >= todayMidnight.getTime()) {
      ({ year: y, month: mo, day: d } = pricesAddLondonDays(y, mo, d, 1));
    }
    return pricesLondonWallToUtc(y, mo, d, 0, 0, 0).toISOString().replace(".000Z", "Z");
  }

  function pricesEffectiveNextChangeAt() {
    const baked = PRICES.nextChangeAt;
    const bakedMs = baked ? new Date(baked).getTime() : NaN;
    if (Number.isFinite(bakedMs) && bakedMs > Date.now()) return baked;
    return pricesNextChangeAtIso();
  }

  function fmtPricesChangeAtLabel(iso) {
    if (!iso) return "Changes at —";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "Changes at —";
    try {
      const time = d.toLocaleTimeString(undefined, {
        ...localeTimeOptions(),
        timeZoneName: "short",
      });
      return `Changes at ${time}`;
    } catch {
      return "Changes at —";
    }
  }

  function fmtPricesCountdownClock(iso) {
    if (!iso) return "—";
    const ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return "00 : 00 : 00";
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${String(h).padStart(2, "0")} : ${String(m).padStart(2, "0")} : ${String(s).padStart(2, "0")}`;
  }

  function syncPricesCountdown() {
    if (state.page !== "prices") {
      if (pricesCountdownTimer) {
        clearInterval(pricesCountdownTimer);
        pricesCountdownTimer = null;
      }
      if (el.pricesNextUpdateFooter) el.pricesNextUpdateFooter.hidden = true;
      return;
    }
    if (el.pricesNextUpdateFooter) {
      el.pricesNextUpdateFooter.hidden = !NARROW_MQ.matches;
    }
    const tick = () => {
      const iso = pricesEffectiveNextChangeAt();
      const clock = fmtPricesCountdownClock(iso);
      const atLabel = fmtPricesChangeAtLabel(iso);
      if (el.pricesCountdownSub) el.pricesCountdownSub.textContent = atLabel;
      if (el.pricesCountdownValue) el.pricesCountdownValue.textContent = clock;
      if (el.pricesNextUpdateSub) el.pricesNextUpdateSub.textContent = atLabel;
      if (el.pricesNextUpdateValue) el.pricesNextUpdateValue.textContent = clock;
      if (el.pricesNextUpdateFooter) {
        el.pricesNextUpdateFooter.hidden = state.page !== "prices" || !NARROW_MQ.matches;
      }
    };
    tick();
    if (!pricesCountdownTimer) {
      pricesCountdownTimer = setInterval(tick, 1000);
    }
  }

  function startPricesEnterMotion(pane) {
    startOwnershipEnterMotion(pane);
  }

  function renderPricesPredictionTable(wrap, headEl, bodyEl, rows, emptyMsg) {
    if (!headEl || !bodyEl) return;
    headEl.innerHTML = pricesHeadHTML();
    if (!rows.length) {
      bodyEl.innerHTML =
        `<tr class="ownership-empty-row"><td class="col-player" colspan="${pricesTableColSpan()}">${emptyMsg}</td></tr>`;
      return;
    }
    bodyEl.innerHTML = rows.map((row, i) => pricesRowHTML(row, i + 1)).join("");
    bindOwnershipPhotoFallback(bodyEl);
  }

  function renderPricesPrediction({ preserveScroll = false } = {}) {
    const scrollSnap =
      preserveScroll && el.pricesPredictionWrap
        ? captureScrollWraps([el.pricesPredictionWrap, ...pricesPredictionTableWraps()])
        : null;

    const pool = PRICES.players || [];
    const basePool = pricesBaseFilteredRows();
    const baseRisers = pricesVisibleRisers();
    const baseFallers = pricesVisibleFallers();
    const risers = limitPricesPredictionMovers(baseRisers);
    const fallers = limitPricesPredictionMovers(baseFallers);
    const totalShown = risers.length + fallers.length;
    const totalBase = baseRisers.length + baseFallers.length;

    if (el.pricesCountLabel) {
      if (!pool.length) {
        el.pricesCountLabel.textContent = "No data";
      } else {
        const scopeHint = state.pricesPredictionShowAll ? "" : " · top 5";
        el.pricesCountLabel.textContent =
          totalShown === totalBase
            ? `${totalShown} movers${scopeHint}`
            : `${totalShown} of ${totalBase} movers${scopeHint}`;
      }
    }

    const emptyPoolMsg =
      "No price data yet. Run <code>python3 site/fetch_ownership.py</code> to refresh bootstrap.";
    const emptyFilterMsg = "No price movers match the current filters.";

    if (!pool.length) {
      renderPricesPredictionTable(
        el.pricesRisersWrap,
        el.pricesRisersHead,
        el.pricesRisersBody,
        [],
        emptyPoolMsg
      );
      renderPricesPredictionTable(
        el.pricesFallersWrap,
        el.pricesFallersHead,
        el.pricesFallersBody,
        [],
        emptyPoolMsg
      );
    } else {
      renderPricesPredictionTable(
        el.pricesRisersWrap,
        el.pricesRisersHead,
        el.pricesRisersBody,
        risers,
        emptyFilterMsg
      );
      renderPricesPredictionTable(
        el.pricesFallersWrap,
        el.pricesFallersHead,
        el.pricesFallersBody,
        fallers,
        emptyFilterMsg
      );
    }

    syncPricesSectionMarks(el.pricesPredictionPanels);

    if (scrollSnap) {
      restoreScrollWraps(scrollSnap);
      requestAnimationFrame(() => syncMobileScrollportHeight());
    } else {
      settlePricesLayoutAfterUpdate();
    }
    if (el.pricesPage) finishOwnershipStatRolls(el.pricesPage);
  }

  function renderPricesActualTable(wrap, headEl, bodyEl, rows, emptyMsg) {
    if (!headEl || !bodyEl) return;
    headEl.innerHTML = pricesActualHeadHTML();
    if (!rows.length) {
      bodyEl.innerHTML =
        `<tr class="ownership-empty-row"><td class="col-player" colspan="${pricesActualTableColSpan()}">${emptyMsg}</td></tr>`;
      return;
    }
    bodyEl.innerHTML = pricesActualBodyHTML(rows);
    bindOwnershipPhotoFallback(bodyEl);
  }

  function renderPricesActual({ preserveScroll = false } = {}) {
    const actualWraps = pricesActualTableWraps();
    if (!el.pricesActualRisersHead || !el.pricesActualRisersBody) return;
    const scrollSnap =
      preserveScroll && actualWraps.length
        ? captureScrollWraps(actualWraps)
        : null;

    const pool = PRICES.actualChanges || [];
    const filtered = pricesActualVisibleRows();
    const sorted = sortPricesActualRows(filtered);
    const visible = limitPricesActualRows(sorted);
    const risers = visible.filter((row) => row.direction === "rise");
    const fallers = visible.filter((row) => row.direction !== "rise");

    if (el.pricesCountLabel) {
      if (!pool.length) {
        el.pricesCountLabel.textContent = "No changes yet";
      } else if (!filtered.length) {
        el.pricesCountLabel.textContent = "No changes match filters";
      } else {
        const noun = filtered.length === 1 ? "change" : "changes";
        const scopeHint = state.pricesActualShowAll
          ? ""
          : pricesActualUseDayGroups()
            ? " · top 5/day"
            : " · top 5";
        if (visible.length === filtered.length) {
          el.pricesCountLabel.textContent = `${filtered.length} ${noun}${scopeHint}`;
        } else {
          el.pricesCountLabel.textContent = `${visible.length} of ${filtered.length} ${noun}${scopeHint}`;
        }
      }
    }

    const emptyPoolMsg =
      "No actual price changes recorded yet. Changes appear after the next bootstrap check-in detects a £0.1m move.";
    const emptyFilterMsg = "No price changes match the current filters.";

    if (!pool.length) {
      renderPricesActualTable(
        el.pricesActualRisersWrap,
        el.pricesActualRisersHead,
        el.pricesActualRisersBody,
        [],
        emptyPoolMsg
      );
      renderPricesActualTable(
        el.pricesActualFallersWrap,
        el.pricesActualFallersHead,
        el.pricesActualFallersBody,
        [],
        emptyPoolMsg
      );
    } else if (!visible.length) {
      renderPricesActualTable(
        el.pricesActualRisersWrap,
        el.pricesActualRisersHead,
        el.pricesActualRisersBody,
        [],
        emptyFilterMsg
      );
      renderPricesActualTable(
        el.pricesActualFallersWrap,
        el.pricesActualFallersHead,
        el.pricesActualFallersBody,
        [],
        emptyFilterMsg
      );
    } else {
      renderPricesActualTable(
        el.pricesActualRisersWrap,
        el.pricesActualRisersHead,
        el.pricesActualRisersBody,
        risers,
        "No risers in this view."
      );
      renderPricesActualTable(
        el.pricesActualFallersWrap,
        el.pricesActualFallersHead,
        el.pricesActualFallersBody,
        fallers,
        "No fallers in this view."
      );
    }

    syncPricesSectionMarks(el.pricesActualPanels);
    bindAllNameColumnSimplifies();
    scheduleOptaMobileNameColWidth();
    if (NARROW_MQ.matches) syncPricesActualColumnWidths();
    if (scrollSnap) {
      restoreScrollWraps(scrollSnap);
      requestAnimationFrame(() => syncMobileScrollportHeight());
    } else {
      settlePricesLayoutAfterUpdate();
    }
    if (el.pricesPage) finishOwnershipStatRolls(el.pricesPage);
  }

  function renderPrices({ animateEnter = false, preserveScroll = false } = {}) {
    syncPricesMoverKindUI();
    if (!el.pricesRisersBody || !el.pricesFallersBody) return;
    syncPricesViewUI();
    syncPricesCountdown();
    syncPageUpdatedFooter(el.pricesUpdatedFooter, pageDataUpdatedIso("prices"));
    syncFiltersResetUI();

    if (!isNextSeason()) {
      if (el.pricesCountLabel) el.pricesCountLabel.textContent = "2026/27 only";
      const msg =
        "Price Change Predictor is available in 2026/27 season mode.";
      if (el.pricesRisersHead) el.pricesRisersHead.innerHTML = pricesHeadHTML();
      if (el.pricesFallersHead) el.pricesFallersHead.innerHTML = pricesHeadHTML();
      if (el.pricesRisersBody) {
        el.pricesRisersBody.innerHTML =
          `<tr class="ownership-empty-row"><td class="col-player" colspan="${pricesTableColSpan()}">${msg}</td></tr>`;
      }
      if (el.pricesFallersBody) {
        el.pricesFallersBody.innerHTML =
          `<tr class="ownership-empty-row"><td class="col-player" colspan="${pricesTableColSpan()}">${msg}</td></tr>`;
      }
      if (el.pricesActualRisersHead) el.pricesActualRisersHead.innerHTML = pricesActualHeadHTML();
      if (el.pricesActualFallersHead) el.pricesActualFallersHead.innerHTML = pricesActualHeadHTML();
      if (el.pricesActualRisersBody) {
        el.pricesActualRisersBody.innerHTML =
          `<tr class="ownership-empty-row"><td class="col-player" colspan="${pricesActualTableColSpan()}">${msg}</td></tr>`;
      }
      if (el.pricesActualFallersBody) {
        el.pricesActualFallersBody.innerHTML =
          `<tr class="ownership-empty-row"><td class="col-player" colspan="${pricesActualTableColSpan()}">${msg}</td></tr>`;
      }
      return;
    }

    if (pricesViewMode() === "actual") {
      renderPricesActual({ preserveScroll });
    } else {
      renderPricesPrediction({ preserveScroll });
      bindAllNameColumnSimplifies();
      scheduleOptaMobileNameColWidth();
    }

    const pageEntering =
      el.pricesPage &&
      (el.pricesPage.classList.contains("is-entering") ||
        el.pricesPage.classList.contains("is-enter-pending"));
    if (animateEnter && el.pricesPage) {
      el.pricesPage.classList.add("is-enter-pending");
      startPricesEnterMotion(el.pricesPage);
    } else if (pageEntering) {
      /* empty rolls for playPageEnter */
    } else if (el.pricesPage) {
      finishOwnershipStatRolls(el.pricesPage);
    }
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
    if (opts.rollKind) attrs.push(`data-count-roll="${escapeHtml(String(opts.rollKind))}"`);
    return `<span ${attrs.join(" ")}></span>`;
  }

  function statRollPadBody(str, len) {
    const m = String(str).match(/^([+-]?)(.*)$/);
    const sign = (m && m[1]) || "";
    const body = (m && m[2]) != null ? m[2] : String(str);
    return sign + body.padStart(Math.max(0, len - sign.length), "0");
  }

  function statRollAlignChars(fromVal, toVal, decimals, signed) {
    const fromStr = statRollFormat(fromVal, decimals, signed);
    const toStr = statRollFormat(toVal, decimals, signed);
    const len = Math.max(fromStr.length, toStr.length);
    // Zero-pad (not spaces) so leading digits odometer from 0 → e.g. 00.0 → 10.0K.
    const fromPad = statRollPadBody(fromStr, len);
    const toPad = statRollPadBody(toStr, len);
    const chars = [];
    for (let i = 0; i < len; i++) {
      chars.push({ from: fromPad[i], to: toPad[i] });
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
    const h = () => {
      const cell = strip.firstElementChild;
      if (cell) {
        const rect = cell.getBoundingClientRect();
        if (rect.height > 0) return rect.height;
      }
      const fs = parseFloat(getComputedStyle(wheel).fontSize);
      return fs > 0 ? fs : 16;
    };
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
    if (wheel._statRollSettleTimer) {
      clearTimeout(wheel._statRollSettleTimer);
      wheel._statRollSettleTimer = 0;
    }
    void wheel.offsetHeight;
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
      wheel._statRollSettleTimer = 0;
      const hh = wheel._statRollHeight() || h;
      strip.style.transition = "none";
      strip.style.transform = `translateY(${-Number(toDigit) * hh}px)`;
    };
    strip.addEventListener("transitionend", (evt) => {
      if (evt.propertyName !== "transform") return;
      settle();
    }, { once: true });
    wheel._statRollSettleTimer = window.setTimeout(settle, duration + 60);
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
    // Plain text settle — avoids frozen half-digits when a second render or
    // enter-clear interrupts CSS transform transitions on digit strips.
    node.textContent = `${statRollFormat(to, decimals, signed)}${suffix}`;
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
    const selector = opts.selector || ".stat-roll[data-count-to]";
    const run = () => {
      const nodes = [...root.querySelectorAll(selector)];
      if (!nodes.length) return;
      if (prefersReducedMotion()) {
        nodes.forEach(finishStatRollNode);
        return;
      }
      nodes.forEach((node) => animateStatRollNode(node, { duration }));
    };
    requestAnimationFrame(run);
  }

  function prefersReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }


  const PAGE_KEY = "fpl-explorer-page";
  // Flip to true when Planner is ready to ship again (nav + prefs section).
  const PLANNER_NAV_ENABLED = false;
  const PAGES = ["home", "live", "opta", "rankings", "ownership", "prices", "expected", "schedule", "markets", "team"];

  function normalizeStoredPage(page) {
    if (page === "notes") return "opta";
    if (!PAGES.includes(page)) return "home";
    if (!PLANNER_NAV_ENABLED && page === "team") return "home";
    return page;
  }

  function syncPlannerNavVisibility() {
    document.documentElement.classList.toggle("planner-nav-enabled", PLANNER_NAV_ENABLED);
    if (el.pageTeam) el.pageTeam.hidden = !PLANNER_NAV_ENABLED;
    if (el.pageTabs) {
      el.pageTabs.querySelectorAll('[data-page-clone="team"]').forEach((node) => {
        node.hidden = !PLANNER_NAV_ENABLED;
      });
    }
    if (pageTabWheelBuilt) {
      teardownPageTabWheel();
      syncPageTabWheel();
    }
  }

  function pageTabOriginIsVisible(node) {
    if (!node || node.classList.contains("page-tab-clone")) return false;
    if (!PLANNER_NAV_ENABLED) {
      const btn = node.matches(".page-tab-btn") ? node : node.querySelector(".page-tab-btn");
      if (pageKeyFromTabBtn(btn) === "team") return false;
    }
    if (node.matches(".page-tab-btn") && node.hidden) return false;
    const btn = node.querySelector(".page-tab-btn");
    if (btn && btn.hidden) return false;
    return true;
  }

  function storedPage() {
    try {
      return normalizeStoredPage(localStorage.getItem(PAGE_KEY));
    } catch {
      return "home";
    }
  }

  function pagePaneFor(page) {
    if (page === "home") return el.homePage;
    if (page === "live") return el.livePage;
    if (page === "opta") return el.optaPage;
    if (page === "rankings") return el.rankingsPage;
    if (page === "ownership") return el.ownershipPage;
    if (page === "prices") return el.pricesPage;
    if (page === "expected") return el.expectedPage;
    if (page === "schedule") return el.schedulePage;
    if (page === "markets") return el.marketsPage;
    if (page === "team") return el.teamPage;
    return null;
  }

  function playPageEnter(pane) {
    if (!pane) return;
    const keepHlSat = pane.id === "opta-page" || pane.id === "home-page";
    pane.classList.remove("is-entering", "is-enter-pending", "is-live-entering");
    if (!keepHlSat) {
      pane.classList.remove("is-hl-entering");
      pane.style.removeProperty("--hl-sat");
    }
    clearTimeout(pane._enterClear);
    if (pane._countUpRaf) {
      cancelAnimationFrame(pane._countUpRaf);
      pane._countUpRaf = 0;
    }
    if (pane._hlEnterRaf) {
      cancelAnimationFrame(pane._hlEnterRaf);
      pane._hlEnterRaf = 0;
    }
    if (pane.id === "home-page") {
      // Invalidate in-flight rolls only. Do NOT flush deferred renders here —
      // that settled/rebuilt mid-start and replayed enter after scroll on iOS.
      homeEnterMotionToken += 1;
      homeSummaryRankChromePending = false;
      clearHomeRankBorderRevealTimer();
    }
    if (pane.id === "ownership-page") {
      ownershipEnterMotionToken += 1;
    }
    if (pane.id === "prices-page") {
      pricesEnterMotionToken += 1;
    }
    if (pane.id === "live-page") {
      // Live uses its own enter path — no pending blank, no <tr> stagger.
      playLiveEnter(pane);
      return;
    }
    // Cancel a previous double-rAF start if setPage/playPageEnter raced.
    pane._enterGen = (pane._enterGen || 0) + 1;
    const enterGen = pane._enterGen;
    if (prefersReducedMotion()) {
      if (pane.id === "home-page") {
        homePageEnterArmed = false;
        finishHighlightSatEnter(pane);
        finishHomeStatRolls(pane);
        animateHomeImpBars(pane, { animate: false });
        const summary = homeSummaryForView(homeActiveViewEntryId());
        applyHomeSummaryRankChrome(summary, { viewingOther: homeIsViewingOtherManager() });
        flushHomeEnterDeferred();
      }
      if (pane.id === "ownership-page") {
        finishOwnershipStatRolls(pane);
      }
      if (pane.id === "prices-page") {
        finishOwnershipStatRolls(pane);
      }
      return;
    }
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
    const pricesEnter = pane.id === "prices-page";
    const homeEnter = pane.id === "home-page";
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
    ].join(", ");
    if (!homeEnter) {
      pane.querySelectorAll(staggerSel).forEach((node, i) => {
        node.style.setProperty("--enter-i", String(i));
        node.querySelectorAll(".barbell-track, .home-imp-fill").forEach((track) => {
          track.style.setProperty("--enter-i", String(i));
        });
      });
    }
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
    // Rankings rows: same index within every card so lists cascade together.
    pane.querySelectorAll(".rankings-list").forEach((list) => {
      list.querySelectorAll(":scope > .rankings-row").forEach((row, i) => {
        row.style.setProperty("--enter-i", String(i));
      });
    });
    // Home: summary cards cascade; squad + standings cards share one index so
    // both tables load together; rows use per-tbody ordinals in lockstep.
    if (homeEnter) {
      const summaryPanels = [...pane.querySelectorAll(".home-summary-cards > .home-panel")];
      summaryPanels.forEach((node, i) => {
        node.style.setProperty("--enter-i", String(i));
      });
      pane.querySelectorAll(".home-tables-grid > .home-panel").forEach((node) => {
        node.style.setProperty("--enter-i", "1");
      });
      pane.querySelectorAll(".home-squad-table tbody, .home-standings-table tbody").forEach((tbody) => {
        tbody.querySelectorAll(":scope > tr").forEach((row, i) => {
          row.style.setProperty("--enter-i", String(Math.min(i, 12)));
          row.querySelectorAll(".home-imp-fill").forEach((track) => {
            track.style.setProperty("--enter-i", String(Math.min(i, 12)));
          });
        });
      });
    }
    if (marketsEnter) {
      pane.querySelectorAll(".markets-divider").forEach((node, i) => {
        node.style.setProperty("--enter-i", String(i));
      });
      pane.querySelectorAll(".markets-grid > .markets-card").forEach((node, i) => {
        node.style.setProperty("--enter-i", String(i));
      });
    }

    // Hide settled content before enter — Home/Live keep cached content visible.
    if (!homeEnter) {
      pane.classList.add("is-enter-pending");
      clearTimeout(pane._enterPendingFallback);
      pane._enterPendingFallback = setTimeout(() => {
        if (!pane.classList.contains("is-enter-pending")) return;
        pane.classList.remove("is-enter-pending", "is-entering");
        if (pane.id === "ownership-page") {
          finishOwnershipStatRolls(pane);
        }
        if (pane.id === "prices-page") {
          finishOwnershipStatRolls(pane);
        }
      }, 8000);
    }

    // Wait two frames so the pending hide has painted, then start enter
    // (avoids browsers skipping the animation on the same frame as show).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (enterGen !== pane._enterGen) return;
        if (pane.style.display === "none") {
          pane.classList.remove("is-enter-pending");
          return;
        }
        void pane.offsetWidth;
        if (!homeEnter) {
          clearTimeout(pane._enterPendingFallback);
          pane._enterPendingFallback = null;
          pane.classList.remove("is-enter-pending");
        }
        if (homeEnter) homePageEnterArmed = false;
        pane.classList.add("is-entering");
        if (marketsEnter) startStatCountUp(pane, ".markets-stat-value[data-count-to]");
        if (rankingsEnter) animateRankingsBars();
        if (homeEnter) startHomeEnterMotion(pane);
        if (ownershipEnter) startOwnershipEnterMotion(pane);
        if (pricesEnter) startPricesEnterMotion(pane);
        // Matchups cards cascade with scatter (no wait for scatter to finish).
        const clearMs = expectedEnter
          ? 2400
          : rankingsEnter
            ? 1800
            : slowEnter
              ? 1800
              : marketsEnter
                ? 3200
                : ownershipEnter || pricesEnter
                  ? 1600
                  : homeEnter
                    ? HOME_ENTER_CLEAR_MS
                    : optaEnter
                      ? 1600
                      : 1500;
        pane._enterClear = setTimeout(() => {
          if (homeEnter) {
            homeEnterMotionToken += 1;
            finishHighlightSatEnter(pane);
            finishHomeStatRolls(pane);
            // Snap IMP before dropping is-entering — changing enter CSS used to
            // restart the width transition (~1s after bars had already finished).
            animateHomeImpBars(pane, { animate: false });
            pane.classList.remove("is-entering");
            flushHomeEnterDeferred();
            return;
          }
          if (ownershipEnter) {
            ownershipEnterMotionToken += 1;
            finishOwnershipStatRolls(pane);
          }
          if (pricesEnter) {
            pricesEnterMotionToken += 1;
            finishOwnershipStatRolls(pane);
          }
          pane.classList.remove("is-entering");
        }, clearMs);
      });
    });
  }

  function startOptaHighlightEnter(pane, { duration = 2500 } = {}) {
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
    const dur = Math.max(400, Number(duration) || 2500);
    const ease = (t) => t * t * (3 - 2 * t);
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
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

  function clearLiveViewFilters() {
    state.liveMatchups.clear();
    state.liveStatus = "all";
    state.posFilter.clear();
    state.teamFilter.clear();
    state.search = "";
    if (el.search) el.search.value = "";
    if (el.searchWrap) el.searchWrap.classList.remove("search-open");
    if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "false");
    syncFilterChipUI();
    syncSearchClearBtns();
    syncLiveStatusSeg();
    syncFiltersResetUI();
  }

  function resetLiveMotionState(pane = el.livePage) {
    liveEnterMotionToken += 1;
    livePointsEnterMotionToken += 1;
    liveRenderQueued = false;
    liveAnimateQueued = false;
    if (!pane) return;
    clearTimeout(pane._enterClear);
    clearTimeout(pane._liveMotionSettle);
    clearTimeout(pane._livePointsMotionSettle);
    pane._enterClear = 0;
    pane._liveMotionSettle = 0;
    pane._livePointsMotionSettle = 0;
    delete pane.dataset.livePointsRolling;
    pane.classList.remove("is-live-entering", "is-entering", "is-enter-pending");
  }

  function resetSearchAndFiltersForNavigation({ rerender = false } = {}) {
    state.search = "";
    if (el.search) el.search.value = "";
    if (el.searchWrap) el.searchWrap.classList.remove("search-open");
    if (el.searchToggle) el.searchToggle.setAttribute("aria-expanded", "false");

    state.posFilter.clear();
    state.teamFilter.clear();
    state.liveMatchups.clear();
    state.liveStatus = "all";
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
    syncLiveStatusSeg();

    syncSearchClearBtns();
    if (rerender) {
      if (state.page === "opta" || state.page === "rankings" || state.page === "team" || state.page === "ownership") renderTable();
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

  function pageNavLabelOffsetPx(cluster) {
    if (!cluster) return 0;
    const raw = cluster.style.getPropertyValue("--page-nav-label-offset").trim();
    if (raw) {
      const inline = parseFloat(raw);
      if (Number.isFinite(inline)) return inline;
    }
    const computed = getComputedStyle(cluster).getPropertyValue("--page-nav-label-offset").trim();
    const n = parseFloat(computed);
    return Number.isFinite(n) ? n : 0;
  }

  function syncPageNavLabelCenter() {
    const cluster = el.pageNavCenter;
    const label = el.pageTrayLabel;
    if (!cluster || !label) return;
    if (!preferMobileSheet()) {
      cluster.style.removeProperty("--page-nav-label-offset");
      cluster.classList.remove("is-label-centered");
      return;
    }
    const apply = () => {
      if (!preferMobileSheet() || !el.pageNavCenter || !el.pageTrayLabel) return;
      const c = el.pageNavCenter;
      const lbl = el.pageTrayLabel;
      const vv = window.visualViewport;
      const screenMid = vv
        ? vv.offsetLeft + vv.width / 2
        : window.innerWidth / 2;
      const labelRect = lbl.getBoundingClientRect();
      if (!labelRect.width) {
        c.style.removeProperty("--page-nav-label-offset");
        c.classList.remove("is-label-centered");
        return;
      }
      // Keep the current offset while measuring so the tray does not flash
      // left (offset 0) before the corrected transform is applied.
      const currentOffset = pageNavLabelOffsetPx(c);
      const labelMid = labelRect.left + labelRect.width / 2;
      const naturalMid = labelMid - currentOffset;
      c.style.setProperty(
        "--page-nav-label-offset",
        `${screenMid - naturalMid}px`
      );
      c.classList.add("is-label-centered");
    };
    apply();
    requestAnimationFrame(apply);
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
    if (state.page === "home" && page !== "home") {
      homePageEnterArmed = false;
      flushHomeRenderAfterEnter();
    }
    page = normalizeStoredPage(page);
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
      if (prev === "live" && page !== "live") {
        resetLiveMotionState(el.livePage);
      }
      if (prev === "team") {
        restoreSeasonFilterBounds();
        closeTeamPicker({ silent: true });
      }
      if (page === "team") {
        applyTeamPageBounds();
        syncPlanningHorizon();
        if (prev !== "team") state.teamGwStart = teamClampPlanGw(planningGameweek());
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
    bindAllNameColumnSimplifies();
    el.pageOpta.classList.toggle("active", page === "opta");
    el.pageRankings.classList.toggle("active", page === "rankings");
    if (el.pageHome) el.pageHome.classList.toggle("active", page === "home");
    if (el.pageLive) el.pageLive.classList.toggle("active", page === "live");
    if (el.pageOwnership) el.pageOwnership.classList.toggle("active", page === "ownership");
    if (el.pagePrices) el.pagePrices.classList.toggle("active", page === "prices");
    el.pageExpected.classList.toggle("active", page === "expected");
    el.pageSchedule.classList.toggle("active", page === "schedule");
    if (el.pageMarkets) el.pageMarkets.classList.toggle("active", page === "markets");
    if (el.pageTeam) el.pageTeam.classList.toggle("active", page === "team");
    syncPageTabCloneActive(page);
    document.documentElement.dataset.page = page;
    syncPageTrayTrigger();
    setPageTrayOpen(false);
    if (el.homePage) el.homePage.style.display = page === "home" ? "" : "none";
    if (el.livePage) el.livePage.style.display = page === "live" ? "" : "none";
    el.optaPage.style.display = page === "opta" ? "" : "none";
    el.rankingsPage.style.display = page === "rankings" ? "" : "none";
    if (el.ownershipPage) el.ownershipPage.style.display = page === "ownership" ? "" : "none";
    if (el.pricesPage) el.pricesPage.style.display = page === "prices" ? "" : "none";
    el.expectedPage.style.display = page === "expected" ? "" : "none";
    el.schedulePage.style.display = page === "schedule" ? "" : "none";
    if (el.marketsPage) el.marketsPage.style.display = page === "markets" ? "" : "none";
    if (el.teamPage) el.teamPage.style.display = page === "team" ? "" : "none";
    syncTeamLandscapeMode();
    const isMarkets = page === "markets";
    const isHome = page === "home";
    const isLive = page === "live";
    // Schedule hides the subtoolbar. Markets desktop uses it for card view + compare.
    syncSubtoolbarViewport(page);
    syncFiltersChrome();
    if (el.statsToolbarStart) el.statsToolbarStart.style.display = isMarkets || isHome ? "none" : "";
    if (el.liveModeSeg) {
      el.liveModeSeg.hidden = !isLive;
      el.liveModeSeg.setAttribute("aria-hidden", isLive ? "false" : "true");
    }
    if (el.statsToolbarActions) el.statsToolbarActions.style.display = isHome ? "none" : "";
    if (el.teamToolbarControls) el.teamToolbarControls.hidden = page !== "team";
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
      page === "expected" || page === "team" || page === "ownership" || page === "prices" || isLive ? "none" : "";
    if (el.expectedSplitGroup) {
      el.expectedSplitGroup.style.display = page === "expected" ? "" : "none";
    }
    if (el.liveFiltersGroup) {
      el.liveFiltersGroup.style.display = isLive ? "" : "none";
    }
    syncSubtoolbarViewport(page);
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
    } else if (isLive) {
      el.valueModeGroup.style.display = "none";
      el.minutesFilterGroup.style.display = "none";
      el.priceFilterGroup.style.display = "none";
      if (el.ownedFilterGroup) el.ownedFilterGroup.style.display = "none";
      if (el.setpieceFilterGroup) el.setpieceFilterGroup.style.display = "none";
      if (el.teamAffordableGroup) el.teamAffordableGroup.style.display = "none";
      el.positionFilterGroup.style.display = "";
      syncLivePosFilterGk();
      syncLiveFeedFilters();
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
      $$("#pos-filters .chip").forEach((c) => {
        c.hidden = false;
      });
    }
    if (page === "ownership") {
      el.valueModeGroup.style.display = "none";
      el.minutesFilterGroup.style.display = "none";
      if (el.setpieceFilterGroup) el.setpieceFilterGroup.style.display = "none";
      if (el.ownedFilterGroup) el.ownedFilterGroup.style.display = "none";
      el.tableOnlyToggles.style.display = "none";
      if (el.compareToggle) el.compareToggle.style.display = "none";
    }
    if (page === "prices") {
      if (state.view !== "players") {
        state.view = "players";
        document.documentElement.dataset.view = "players";
        el.tabPlayers.classList.add("active");
        el.tabTeams.classList.remove("active");
      }
      el.valueModeGroup.style.display = "none";
      el.minutesFilterGroup.style.display = "none";
      if (el.setpieceFilterGroup) el.setpieceFilterGroup.style.display = "none";
      if (el.ownedFilterGroup) el.ownedFilterGroup.style.display = "none";
      if (el.pricesProgressFilterGroup) {
        el.pricesProgressFilterGroup.style.display =
          pricesViewMode() === "prediction" ? "" : "none";
      }
      el.tableOnlyToggles.style.display = "none";
      if (el.compareToggle) el.compareToggle.style.display = "none";
    } else if (el.pricesProgressFilterGroup) {
      el.pricesProgressFilterGroup.style.display = "none";
    }
    if (page !== "home") {
      setHomeManagerModalOpen(false);
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
      if (el.homeStandingsLookupEmpty) {
        el.homeStandingsLookupEmpty.hidden = true;
        el.homeStandingsLookupEmpty.textContent = "";
      }
      const standingsPager =
        el.homeStandingsPanel && el.homeStandingsPanel.querySelector(".home-standings-pager");
      if (standingsPager) standingsPager.hidden = false;
    }
    if (page !== "expected") setExpectedCatMenuOpen(false);
    if (page === "rankings") {
      // Bars animate once via playPageEnter → animateRankingsBars.
      renderRankings({ animateBars: false, skipBarDraw: true });
    } else if (page === "home") {
      homePageEnterArmed = true;
      homeLiveApplyAfterEnter = true;
      syncHomeLivePolling({ skipImmediate: false });
      renderHome({ leaveRollsPending: true });
    } else if (page === "live") {
      // Mark busy before render so we do not double-start motion before playLiveEnter.
      liveEnterAwaitingPlay = true;
      if (el.livePage) el.livePage.classList.add("is-live-entering");
      ensureLiveFeedFromHome();
      renderLive();
    } else if (page === "ownership") {
      if (el.ownershipPage) el.ownershipPage.classList.add("is-enter-pending");
      renderOwnership();
    } else if (page === "prices") {
      if (el.pricesPage) el.pricesPage.classList.add("is-enter-pending");
      renderPrices();
    } else if (page === "expected") {
      renderExpected();
    } else if (page === "schedule") {
      updateScheduleGwSlider();
      renderSchedule();
    } else if (page === "markets") {
      renderMarkets();
    } else if (page === "opta") {
      primeOptaHighlightEnter(el.optaPage);
      renderTable();
    } else if (page === "team") {
      renderTeam();
    }
    syncTeamPickingClass();
    playPageEnter(pagePaneFor(page));
    requestAnimationFrame(() => {
      syncAllSegThumbs({ animate: false });
      requestAnimationFrame(() => {
        scrollActivePageTabIntoView({ instant: true });
      });
      // Ownership is rendered once above; a second rAF render restarted odometers.
    });
    syncExpectedCatToolbar();
    syncMarketsViewControls();
    syncMobileChrome();
    syncMobileTopChromeInset();
    requestAnimationFrame(syncMobileTopChromeInset);
    syncHomeLivePolling();
    if (pageTabWheelEnabled() && pageTabWheelBuilt) recenterActivePageTabSoon();
  }

  if (el.pageHome) el.pageHome.addEventListener("click", () => setPage("home"));
  if (el.pageLive) el.pageLive.addEventListener("click", () => setPage("live"));
  if (el.homeViewBannerClear) {
    el.homeViewBannerClear.addEventListener("click", (e) => {
      e.preventDefault();
      clearHomeViewEntry();
    });
  }
  if (el.homeOwnerBannerClear) {
    el.homeOwnerBannerClear.addEventListener("click", (e) => {
      e.preventDefault();
      clearHomeOwnerPin();
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
  if (el.homeDesktopSearchInput) {
    el.homeDesktopSearchInput.addEventListener("input", () => {
      if (state.page !== "home" || NARROW_MQ.matches) return;
      const q = el.homeDesktopSearchInput.value;
      if (el.homeDesktopSearchClear) {
        el.homeDesktopSearchClear.hidden = !homeLookupPlayer && !String(q || "").trim();
      }
      renderHomeDesktopSearchResults(q);
    });
    el.homeDesktopSearchInput.addEventListener("focus", () => {
      if (state.page !== "home" || NARROW_MQ.matches) return;
      const q = el.homeDesktopSearchInput.value;
      if (String(q || "").trim()) renderHomeDesktopSearchResults(q);
    });
    el.homeDesktopSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        hideHomeDesktopSearchResults();
        el.homeDesktopSearchInput.blur();
      }
    });
  }
  if (el.homeDesktopSearchClear) {
    el.homeDesktopSearchClear.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearHomePlayerLookup();
      if (el.homeDesktopSearchInput) el.homeDesktopSearchInput.focus();
    });
  }
  if (el.homeDesktopSearchResults) {
    el.homeDesktopSearchResults.addEventListener("click", (e) => {
      const btn = e.target.closest(".home-search-row");
      if (!btn || !el.homeDesktopSearchResults.contains(btn)) return;
      const code = Number(btn.getAttribute("data-home-search-code"));
      const id = Number(btn.getAttribute("data-home-search-id"));
      const row = homeSearchCatalog().find((r) =>
        (Number.isFinite(code) && Number(r.code) === code) ||
        (Number.isFinite(id) && homeLookupElementId(r) === id)
      );
      if (!row) return;
      setHomePlayerLookup(row);
    });
  }
  document.addEventListener("pointerdown", (e) => {
    const wrap = el.homeDesktopSearch;
    if (!wrap || wrap.hidden) return;
    if (wrap.contains(e.target)) return;
    hideHomeDesktopSearchResults();
  });
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
  if (el.pagePrices) el.pagePrices.addEventListener("click", () => setPage("prices"));
  if (el.liveModeSeg) {
    el.liveModeSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-live-mode]");
      if (!btn || !el.liveModeSeg.contains(btn)) return;
      const next = btn.dataset.liveMode;
      if (next !== "feed" && next !== "defcon" && next !== "points" && next !== "bonus") return;
      if (next === state.liveMode) return;
      clearLiveViewFilters();
      resetLiveMotionState(el.livePage);
      state.liveMode = next;
      const defSort = liveDefaultSortForMode(next);
      state.liveSortKey = defSort.key;
      state.liveSortDir = defSort.dir;
      renderLive({ animate: true });
    });
  }
  if (el.liveMatchupFilters) {
    el.liveMatchupFilters.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-live-matchup]");
      if (!btn || !el.liveMatchupFilters.contains(btn)) return;
      const id = btn.dataset.liveMatchup;
      if (!id) return;
      toggleSetValue(state.liveMatchups, id);
      renderLive({ animate: true });
    });
  }
  if (el.liveStatusSeg) {
    el.liveStatusSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-live-status]");
      if (!btn || !el.liveStatusSeg.contains(btn)) return;
      const next = btn.dataset.liveStatus;
      if (next !== "all" && next !== "live" && next !== "owned") return;
      if (next === state.liveStatus) return;
      state.liveStatus = next;
      renderLive({ animate: true });
      syncFiltersResetUI();
    });
  }
  if (el.liveFeedOwnedSeg) {
    el.liveFeedOwnedSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-live-feed-owned]");
      if (!btn || !el.liveFeedOwnedSeg.contains(btn)) return;
      const next = btn.dataset.liveFeedOwned;
      if (next !== "all" && next !== "league") return;
      if (next === state.liveFeedOwnedFilter) return;
      state.liveFeedOwnedFilter = next;
      syncLiveFeedOwnedSeg();
      renderLive({ animate: true });
      syncFiltersResetUI();
    });
  }
  if (el.liveTableHead) {
    el.liveTableHead.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-live-sort]");
      if (!th || !el.liveTableHead.contains(th)) return;
      const key = th.dataset.liveSort;
      if (!key) return;
      if (state.liveSortKey === key) {
        state.liveSortDir = state.liveSortDir === "asc" ? "desc" : "asc";
      } else {
        state.liveSortKey = key;
        state.liveSortDir = key === "name" ? "asc" : "desc";
      }
      renderLive({ animate: true });
    });
  }
  if (el.ownershipMoverSeg) {
    el.ownershipMoverSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-ownership-kind]");
      if (!btn || !el.ownershipMoverSeg.contains(btn)) return;
      const next = btn.dataset.ownershipKind === "fallers" ? "fallers" : "risers";
      if (next === ownershipMoverKind()) return;
      state.ownershipMoverKind = next;
      resetOwnershipSortForKind(next);
      syncOwnershipMoverUI({ animate: true });
      if (state.page === "ownership") renderOwnership({ animateEnter: true });
    });
  }
  if (el.ownershipTreemapToggle) {
    el.ownershipTreemapToggle.addEventListener("click", () => {
      state.ownershipViewMode = ownershipIsTreemap() ? "table" : "treemap";
      if (state.page === "ownership") renderOwnership();
    });
  }
  if (el.ownershipWindowSeg) {
    el.ownershipWindowSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-ownership-window]");
      if (!btn || !el.ownershipWindowSeg.contains(btn)) return;
      const next = btn.dataset.ownershipWindow;
      if (next !== "d7" && next !== "d3" && next !== "d1") return;
      if (next === ownershipTreeWindow()) return;
      state.ownershipTreeWindow = next;
      syncOwnershipWindowUI({ animate: true });
      if (state.page === "ownership" && ownershipIsTreemap()) renderOwnershipTreemap();
    });
  }
  if (el.ownershipTableWrap) {
    el.ownershipTableWrap.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-own-sort]");
      if (!th || !el.ownershipTableWrap.contains(th)) return;
      const key = th.getAttribute("data-own-sort");
      if (!key) return;
      if (state.ownershipSortKey === key) {
        state.ownershipSortDir = state.ownershipSortDir === "asc" ? "desc" : "asc";
      } else {
        state.ownershipSortKey = key;
        state.ownershipSortDir = key === "name" ? "asc" : "desc";
      }
      renderOwnership();
    });
  }
  if (el.pricesViewSeg) {
    el.pricesViewSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-prices-view]");
      if (!btn || !el.pricesViewSeg.contains(btn)) return;
      const next = btn.dataset.pricesView;
      if (next !== "prediction" && next !== "actual") return;
      if (next === pricesViewMode()) return;
      if (next === "actual" && !state.pricesActualSortTouched) {
        state.pricesActualSortKey = "default";
        state.pricesActualSortDir = "desc";
      }
      state.pricesViewMode = next;
      syncPricesViewUI();
      if (state.page === "prices") renderPrices({ animateEnter: true });
    });
  }
  if (el.pricesMoverKindSeg) {
    el.pricesMoverKindSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-prices-mover-kind]");
      if (!btn || !el.pricesMoverKindSeg.contains(btn)) return;
      const next = btn.dataset.pricesMoverKind;
      if (next !== "risers" && next !== "fallers") return;
      if (next === pricesMoverKind()) return;
      state.pricesMoverKind = next;
      syncPricesMoverKindUI({ animate: true });
      if (state.page === "prices") {
        requestAnimationFrame(() => {
          syncPricesActualColumnWidths();
          syncMobileScrollportHeight();
        });
      }
    });
  }
  function bindPricesScopeSeg(seg, { getShowAll, setShowAll, rerender }) {
    if (!seg) return;
    seg.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-prices-scope]");
      if (!btn || !seg.contains(btn)) return;
      const scope = btn.dataset.pricesScope;
      if (scope !== "top" && scope !== "all") return;
      const nextShowAll = scope === "all";
      if (nextShowAll === getShowAll()) return;
      setShowAll(nextShowAll);
      syncPricesViewUI();
      if (state.page === "prices") rerender({ preserveScroll: true });
    });
  }
  bindPricesScopeSeg(el.pricesPredictionScopeSeg, {
    getShowAll: () => state.pricesPredictionShowAll,
    setShowAll: (v) => {
      state.pricesPredictionShowAll = v;
    },
    rerender: (opts) => {
      if (pricesViewMode() === "prediction") renderPricesPrediction(opts);
    },
  });
  bindPricesScopeSeg(el.pricesActualScopeSeg, {
    getShowAll: () => state.pricesActualShowAll,
    setShowAll: (v) => {
      state.pricesActualShowAll = v;
    },
    rerender: (opts) => {
      if (pricesViewMode() === "actual") renderPricesActual(opts);
    },
  });
  pricesActualTableWraps().forEach((wrap) => {
    if (!wrap) return;
    wrap.addEventListener("click", (e) => {
      if (NARROW_MQ.matches) return;
      const th = e.target.closest("th[data-prices-actual-sort]");
      if (!th || !wrap.contains(th)) return;
      const key = th.getAttribute("data-prices-actual-sort");
      if (!key) return;
      state.pricesActualSortTouched = true;
      if (state.pricesActualSortKey === key) {
        state.pricesActualSortDir =
          state.pricesActualSortDir === "asc" ? "desc" : "asc";
      } else {
        state.pricesActualSortKey = key;
        state.pricesActualSortDir = key === "name" ? "asc" : "desc";
      }
      renderPrices({ preserveScroll: true });
    });
  });
  if (el.pageTeam) {
    el.pageTeam.addEventListener("click", () => {
      if (!PLANNER_NAV_ENABLED) return;
      setPage("team");
    });
  }
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
    scheduleViewportLayoutSync();
    if (pageTabWheelEnabled() && pageTabWheelBuilt) {
      scrollActivePageTabIntoView({ instant: true });
    }
  });

  let pageTabWheelBuilt = false;
  let pageTabWheelLock = false;
  let pageTabWheelUnlockTimer = 0;
  let pageTabWheelGen = 0;
  let pageTabFocusEl = null;
  let pageTabWheelBooted = false;

  function pageTabWheelEnabled() {
    // Desktop uses a linear Home→…→Markets row. Horizontal scroll + edge fades
    // only appear when the window is too narrow to fit every tab.
    return false;
  }

  function pageKeyFromTabBtn(btn) {
    if (!btn) return null;
    const id = btn.id || "";
    if (id === "page-home") return "home";
    if (id === "page-opta") return "opta";
    if (id === "page-rankings") return "rankings";
    if (id === "page-ownership") return "ownership";
    if (id === "page-prices") return "prices";
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
      (n) => n.hasAttribute("data-page-tab-origin") && pageTabOriginIsVisible(n)
    );
  }

  function pageTabHostsForPage(page) {
    const tabs = el.pageTabs;
    if (!tabs || !page) return [];
    const hosts = [];
    tabs.querySelectorAll(`[data-page-clone="${page}"]`).forEach((node) => hosts.push(node));
    const idByPage = {
      home: "page-home",
      live: "page-live",
      opta: "page-opta",
      rankings: "page-rankings",
      ownership: "page-ownership",
      prices: "page-prices",
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
    const originals = [...tabs.children].filter(pageTabOriginIsVisible);
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
        if (!page || (!PLANNER_NAV_ENABLED && page === "team")) return;
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
        if (NARROW_MQ.matches) return;
        if (e.ctrlKey) return;
        if (!pageTabsAreScrollable()) return;
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

  // Brand mark returns to Home. Use in-app navigation when switching pages
  // so the mobile page tray does not flash; full reload only when already Home.
  const brandHome = document.querySelector("#brand-home");
  if (brandHome) {
    brandHome.addEventListener("click", (e) => {
      e.preventDefault();
      if (state.page === "home") {
        try {
          localStorage.setItem(PAGE_KEY, "home");
        } catch {
          // Private browsing — reload still lands on the default page.
        }
        location.reload();
        return;
      }
      setPage("home");
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
      if (el.ownedFilterGroup) el.ownedFilterGroup.style.display = "none";
    }
    if (state.page === "prices") {
      el.valueModeGroup.style.display = "none";
      el.minutesFilterGroup.style.display = "none";
      if (el.setpieceFilterGroup) el.setpieceFilterGroup.style.display = "none";
      if (el.ownedFilterGroup) el.ownedFilterGroup.style.display = "none";
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
    // Desktop: expanded field like Statistics (mobile uses mobileSearchAlwaysOpen).
    return (
      !preferMobileSheet() &&
      (state.page === "opta" ||
        state.page === "ownership" ||
        state.page === "prices" ||
        state.page === "expected")
    );
  }

  function mobileSearchAlwaysOpen() {
    return (
      preferMobileSheet() &&
      (state.page === "ownership" ||
        state.page === "prices" ||
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
      state.page === "live" ||
      (state.page === "team" && !state.teamPickerSlot);
    el.searchWrap.style.display = hideSearch ? "none" : "";
    el.searchWrap.classList.toggle("team-search-always-open", teamSearchAlwaysOpen());
    el.searchWrap.classList.toggle(
      "stats-search-always-open",
      mainSearchAlwaysOpen() && state.page !== "team"
    );
    el.searchWrap.classList.toggle("mobile-search-always-open", mobileSearchAlwaysOpen());
    if (state.page === "rankings" || state.page === "live") {
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
      resetMobileViewportOffset();
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
    // Undo Safari's scroll-into-view nudge without fighting the open keyboard.
    resetMobileViewportOffset();
  });

  el.search.addEventListener("blur", () => {
    scheduleMobileViewportReset({ force: true });
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

  const updatePricesProgressSlider = setupSingleSlider({
    input: el.pricesProgressMin,
    fillEl: el.pricesProgressMinFill,
    labelEl: el.pricesProgressMinLabel,
    boundsMin: PRICES_PROGRESS_MIN,
    boundsMax: PRICES_PROGRESS_MAX,
    step: 5,
    get: () => state.pricesProgressMinAbs,
    set: (value) => {
      state.pricesProgressMinAbs = value;
    },
    format: (value) => `±${value}%`,
    onInput: () => {
      syncFiltersResetUI();
      if (state.page === "prices") renderPrices({ preserveScroll: false });
      else renderTable();
    },
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
      `Minimum rank gap to flag attack ${iconHTML("swords", "ftt-attack-icon")} or defence ${iconHTML("shield-half", "ftt-defence-icon")} edges on fixture cells.`
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
      if (mode !== "current" && mode !== "24h" && mode !== "72h") return;
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
    if (!preferMobileSheet()) return;
    if (open) {
      openMobileSheetHost({
        title: "Filters",
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
      setTip(el.marketsSlidersToggle, "Hide filters");
      el.marketsSlidersToggle.setAttribute("aria-label", "Hide filters");
      requestAnimationFrame(() => {
        syncMarketsCompareSeg();
        syncMarketsViewSeg();
      });
      return;
    }
    if (mobileSheetKey === "markets-filters") {
      closeMobileSheet();
      return;
    }
    el.marketsControls.hidden = true;
    el.marketsControls.classList.add("is-collapsed");
    el.marketsSlidersToggle.classList.remove("on");
    el.marketsSlidersToggle.setAttribute("aria-expanded", "false");
    setTip(el.marketsSlidersToggle, "Show filters");
    el.marketsSlidersToggle.setAttribute("aria-label", "Show filters");
  }

  if (el.marketsSlidersToggle) {
    el.marketsSlidersToggle.addEventListener("click", () => {
      setMarketsSlidersOpen(!(mobileSheetOpen && mobileSheetKey === "markets-filters"));
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
        setTip(el.scheduleSlidersToggle, "Hide matchup filters");
        el.scheduleSlidersToggle.setAttribute("aria-label", "Hide matchup filters");
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
        setTip(el.scheduleSlidersToggle, "Show matchup filters");
        el.scheduleSlidersToggle.setAttribute("aria-label", "Show matchup filters");
      }
      return;
    }
    el.scheduleControls.hidden = !open;
    el.scheduleControls.classList.toggle("is-collapsed", !open);
    el.scheduleSlidersToggle.classList.toggle("on", open);
    el.scheduleSlidersToggle.setAttribute("aria-expanded", open ? "true" : "false");
    setTip(
      el.scheduleSlidersToggle,
      open ? "Hide matchup filters" : "Show matchup filters"
    );
    el.scheduleSlidersToggle.setAttribute("aria-label", open ? "Hide matchup filters" : "Show matchup filters");
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
      else if (state.page === "prices") renderPrices();
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
    if (el.optaPageSubtitle) {
      el.optaPageSubtitle.textContent = next
        ? "2026/27 FPL season stats for players or teams — filter, sort, rank, and compare."
        : "Season OPTA and FPL stats for players or teams — filter, sort, rank, and compare.";
    }
    if (el.rankingsPageSubtitle) {
      el.rankingsPageSubtitle.textContent = next
        ? "Top 10 leaderboards for FPL season stats, grouped into Key Stats, Attacking, and Defending."
        : "Top 10 leaderboards for OPTA and FPL metrics, grouped into Key Stats, Attacking, and Defending.";
    }
  }

  function setSeason(season, { rerender = true } = {}) {
    if (season !== "2025-26" && season !== "2026-27") return;
    if (state.season === season) return;
    state.season = season;
    teamPriorByCodeCache = null;
    teamPriorByCodeSeason = null;
    teamPosRankCache = null;
    teamPosRankSeason = null;
    if (isNextSeason() && PLAYER_OPTA_ONLY_COL_KEYS.has(state.teamSortKey)) {
      state.teamSortKey = null;
    }
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
    } else if (isNextSeason()) {
      const hide = TEAM_OPTA_ONLY_COL_KEYS;
      if (hide.has(state.sortKey)) {
        state.sortKey = "pts";
        state.sortDir = "desc";
      }
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
      if (state.page === "rankings") renderRankings({ animateBars: false });
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
  // (opt-in) ranks against the filtered rows when a narrowing filter is active.
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
      : "Rank blue/orange highlights against the current filtered rows";
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
        syncEnhanceRelativeUI();
        return;
      }
      state.enhanceRelative = !state.enhanceRelative;
      syncEnhanceRelativeUI();
      if (state.enhanceRelative) {
        showToast({
          title: "Relative highlights",
          message: "Blue/orange bands now rank within the filtered rows.",
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
  // UI chrome and data-rise color use fixed --blue-hsl from CSS.
  // ---------------------------------------------------------------------
  const THEME_KEY = "fpl-explorer-theme";
  const THEME_ORDER = ["system", "light", "dark"];
  const THEME_META = {
    system: { icon: "monitor", label: "Device" },
    light: { icon: "sun", label: "Light" },
    dark: { icon: "moon", label: "Dark" },
  };

  function currentThemeMode() {
    const stored = localStorage.getItem(THEME_KEY);
    return THEME_ORDER.includes(stored) ? stored : "system";
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

  applyTheme(currentThemeMode());

  // Drop legacy UI-scale zoom so fixed chrome widths stay stable.
  try {
    localStorage.removeItem("fpl-explorer-ui-scale");
    localStorage.removeItem("fpl-explorer-font-pair");
    localStorage.removeItem("fpl-explorer-font-pair-v2");
    localStorage.removeItem("fpl-explorer-clock-format");
    localStorage.removeItem("fpl-explorer-fixture-tt-delay");
    localStorage.removeItem("fpl-explorer-accent");
  } catch {
    /* private browsing */
  }
  document.documentElement.style.removeProperty("--ui-scale");
  document.documentElement.style.removeProperty("--blue-hsl");
  document.documentElement.style.removeProperty("--positive");
  document.documentElement.style.removeProperty("--negative");
  document.documentElement.removeAttribute("data-accent");

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
    scheduleViewportLayoutSync({ immediate: true });
  });
  bindMqChange(NARROW_MQ, () => {
    resetMobileChromeScrollHide();
    setPageTrayOpen(false);
    syncPageTrayTrigger();
    syncPageTabWheel();
    scheduleViewportLayoutSync({ immediate: true });
    if (state.page === "home") {
      syncHomeLookupUI();
      renderHome({ deferDuringEnter: true });
    }
    if (state.page === "team") renderTeam();
    if (state.page === "opta") {
      requestAnimationFrame(() => {
        snapOptaToGameStats();
        requestAnimationFrame(() => {
          snapOptaToGameStats();
          refreshNameSimplifyOrigins();
        });
      });
    }
    disarmConfirmButton();
    syncTeamPlannerPrefsBtns();
    syncHomeViewBanner();
    syncHomeSearchBtn();
    refreshCompareScrollMirrorMode();
    bindAllNameColumnSimplifies();
  });
  bindMqChange(HOME_SQUAD_WIDE_MQ, () => {
    const wide = syncHomeSquadWideLayout();
    homeSquadWideLayoutActive = wide;
    scheduleViewportLayoutSync({ immediate: true });
    if (state.page !== "home") return;
    const idx = homeSquadActivePageIndex();
    renderHome({ deferDuringEnter: true });
    if (wide && idx === 1) setHomeSquadPage(0, { smooth: false });
  });
  bindMqChange(COLUMNS_IN_FILTERS_MQ, () => {
    scheduleViewportLayoutSync({ immediate: true });
  });
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
  if (el.homeManagerSelect) {
    el.homeManagerSelect.addEventListener("change", () => {
      syncHomeManagerContinue();
    });
    el.homeManagerSelect.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (!el.homeManagerContinue || el.homeManagerContinue.disabled) return;
      e.preventDefault();
      el.homeManagerContinue.click();
    });
  }
  if (el.homeManagerContinue) {
    el.homeManagerContinue.addEventListener("click", async (e) => {
      e.preventDefault();
      const id = el.homeManagerSelect ? String(el.homeManagerSelect.value || "").trim() : "";
      if (!id) return;
      el.homeManagerContinue.disabled = true;
      try {
        await applyManagerId(id, { quiet: false, animateHomeEnter: true });
      } finally {
        syncHomeManagerContinue();
      }
    });
  }
  if (el.fplIdClear) {
    el.fplIdClear.addEventListener("click", () => clearManagerId());
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
      // BFCache restore can leave enter classes mid-flight; clear so we don't
      // resume a half-finished cascade when the user scrolls.
      document.querySelectorAll(".page-pane.is-entering, .page-pane.is-enter-pending, .page-pane.is-hl-entering, .page-pane.is-live-entering").forEach((pane) => {
        pane.classList.remove("is-entering", "is-enter-pending", "is-hl-entering", "is-live-entering");
      });
      if (el.homePage) {
        homePageEnterArmed = false;
        homeEnterMotionToken += 1;
        finishHighlightSatEnter(el.homePage);
        finishHomeStatRolls(el.homePage);
        animateHomeImpBars(el.homePage, { animate: false });
        flushHomeRenderAfterEnter();
      }
      if (el.ownershipPage) {
        ownershipEnterMotionToken += 1;
        finishOwnershipStatRolls(el.ownershipPage);
      }
      if (el.livePage) {
        liveEnterMotionToken += 1;
        snapLiveBarsDrawn(el.livePage);
        finishLiveStatRolls(el.livePage);
      }
      syncAllSegThumbs({ animate: false });
      scrollActivePageTabIntoView({ instant: true });
    });
    [50, 250].forEach((ms) => {
      window.setTimeout(() => syncAllSegThumbs({ animate: false }), ms);
    });
    if (typeof ResizeObserver !== "undefined") {
      let segThumbRoRaf = 0;
      const ro = new ResizeObserver(() => {
        if (segThumbRoRaf) return;
        segThumbRoRaf = requestAnimationFrame(() => {
          segThumbRoRaf = 0;
          syncAllSegThumbs({ animate: false });
        });
      });
      $$(".tabs, .segmented").forEach((elSeg) => ro.observe(elSeg));
      if (el.barbellHead) {
        const headRo = new ResizeObserver(() => syncBarbellHeadHeight());
        headRo.observe(el.barbellHead);
      }
    }
    window.addEventListener("resize", () => {
      scheduleViewportLayoutSync();
    });
    if (window.visualViewport) {
      syncVisualViewportInsets();
      window.visualViewport.addEventListener("resize", () => {
        syncVisualViewportInsets();
        scheduleViewportLayoutSync();
        scheduleMobileViewportReset();
      });
      window.visualViewport.addEventListener("scroll", () => {
        syncVisualViewportInsets();
        syncMobileScrollportHeight();
        scheduleMobileViewportReset();
      });
    } else {
      document.documentElement.style.setProperty("--vv-height", `${window.innerHeight}px`);
    }
    window.addEventListener("pageshow", scheduleMobileViewportReset);
    window.addEventListener("orientationchange", scheduleMobileViewportReset);
    syncMobileTopChromeInset();
    scheduleMobileViewportReset({ force: true });
    requestAnimationFrame(() => {
      syncMobileTopChromeInset();
      scheduleMobileViewportReset({ force: true });
    });
    bindAllNameColumnSimplifies();
    bindNestedTableScroll();
    bindPricesPredictionColumnsObserver();
    bindPricesActualColumnsObserver();
    bindMobileChromeScrollHide();
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      if (!homeLivePollReady()) return;
      pollHomeFromLiveServer();
    });
    // Manager prefs first so the initial Home paint already has the linked ID.
    try {
      await restoreManagerId({ deferHome: true });
    } catch {
      syncFplIdStatus();
    }
    const page = storedPage();
    if (homeLivePollReady() && page === "home") {
      homeLivePrefetchStarted = true;
      hydrateHomeFromSessionSnapshot();
      homeLiveApplyAfterEnter = true;
      syncHomeLivePolling({ skipImmediate: false });
    } else {
      prefetchHomeLiveCache();
    }
    syncPlannerNavVisibility();
    setPage(page);
    syncLiveNavChrome();
    if (state.page !== "live" && state.page !== "opta") renderTable();
  }

  init();
})();
