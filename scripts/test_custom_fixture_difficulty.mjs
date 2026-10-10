#!/usr/bin/env node
/**
 * Ensures custom team-difficulty sliders (localStorage store) always flow through
 * resolveFixtureDifficulty into every FDR presentation surface when ratings exist.
 *
 * Run: node scripts/test_custom_fixture_difficulty.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "site/app.js"), "utf8");

/**
 * Extract a 2-space-indented `function name` from app.js through the next
 * sibling `function` / block comment. Avoids brace-counting inside templates.
 */
function extractFn(name) {
  const needle = `  function ${name}(`;
  const start = src.indexOf(needle);
  if (start < 0) throw new Error(`Could not find ${name} in app.js`);
  const searchFrom = start + needle.length;
  const nextFn = src.indexOf("\n  function ", searchFrom);
  const nextBlock = src.indexOf("\n  /*", searchFrom);
  let end = src.length;
  if (nextFn >= 0) end = Math.min(end, nextFn);
  if (nextBlock >= 0) end = Math.min(end, nextBlock);
  return src.slice(start, end);
}

function fnBodyContains(fnName, needle) {
  return extractFn(fnName).includes(needle);
}

/** Surfaces that must paint FDR via resolveFixtureDifficulty when custom colors are on. */
const FDR_CONSUMERS = [
  {
    id: "fixtures-pills",
    label: "Fixtures page GW pills",
    fn: "fixturesPillHTMLFromList",
  },
  {
    id: "fixtures-sos-total",
    label: "Fixtures SOS totals / sort",
    fn: "fixturesTeamSosTotal",
  },
  {
    id: "fixtures-gw-diff",
    label: "Fixtures per-GW difficulty",
    fn: "fixturesTeamGwDifficulty",
  },
  {
    id: "home-squad-schedule",
    label: "Home Team · Schedule pills",
    fn: "homeSquadSchedulePillHTML",
  },
  {
    id: "home-pitch-gw",
    label: "Home pitch next-opp strip",
    fn: "homeSquadPitchOppMeta",
  },
  {
    id: "home-pitch-fixtures",
    label: "Home pitch fixtures strip",
    fn: "homeSquadPitchFixturesStripHTML",
  },
  {
    id: "home-player-team-schedule",
    label: "Player/team detail Schedule card",
    fn: "homePlayerMatchupHTML",
    // Enables wash flag; fixtureCardHTML resolves FDR
    requires: ["customFdrWash", "fixtureCardHTML"],
  },
  {
    id: "fixture-card-wash",
    label: "fixtureCardHTML custom FDR wash",
    fn: "fixtureCardHTML",
    requires: ["resolveFixtureDifficulty", "customFdrWash"],
  },
  {
    id: "report-fx-pills",
    label: "Report fixture pills",
    fn: "reportFixturePillsHTML",
    // Indirect: calls homeSquadSchedulePillHTML
    via: "homeSquadSchedulePillHTML",
  },
];

/** Intentionally not custom-FDR (locked ranks / OPTA edges). */
const INTENTIONAL_NON_CUSTOM = [
  {
    id: "matchups-schedule-cards",
    label: "Matchups Schedule cards",
    fn: "scheduleCardHTML",
    reason: "Strength of Schedule keeps OPTA/FPL ranks (customFdrWash not passed)",
  },
  {
    id: "team-strength",
    label: "Team details Strength table",
    fn: "teamDetailsStrengthHTML",
    reason: "Venue attack/defence ranks, not FDR pills",
  },
  {
    id: "matchup-edges",
    label: "Matchup edge / scatter scores",
    fn: "teamMatchupProfile",
    reason: "Uses matchupEdges ranks, not fixture difficulty colors",
  },
];

// --- Unit: resolution logic (extracted from app.js) ---
const harness = `
const TEAM_DIFFICULTY_DEFAULT = 3;
let teamDifficultyStore = {
  version: 2,
  ratings: {},
  useOnFixtures: true,
  useOnMatchups: false,
  completedOnce: false,
  advanced: false,
};
let state = { fixturesSosMode: "all" };

${extractFn("clampDifficultyRating")}
${extractFn("teamDifficultyHasCustomRatings")}
${extractFn("teamDifficultyUsesFixtures")}
${extractFn("customTeamAxis")}
${extractFn("resolveFixtureDifficulty")}

this.setStore = (next) => { teamDifficultyStore = next; };
this.setSosMode = (m) => { state.fixturesSosMode = m; };
this.clampDifficultyRating = clampDifficultyRating;
this.teamDifficultyUsesFixtures = teamDifficultyUsesFixtures;
this.customTeamAxis = customTeamAxis;
this.resolveFixtureDifficulty = resolveFixtureDifficulty;
`;

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(harness, ctx);

const {
  setStore,
  setSosMode,
  clampDifficultyRating,
  teamDifficultyUsesFixtures,
  customTeamAxis,
  resolveFixtureDifficulty,
} = ctx;

const ARS_HARD = {
  H: { atk: 5, def: 4 },
  A: { atk: 5, def: 5 },
};
const BOU_EASY = {
  H: { atk: 1, def: 1 },
  A: { atk: 2, def: 1 },
};

function withCustom(ratings) {
  setStore({
    version: 2,
    ratings,
    useOnFixtures: true,
    useOnMatchups: false,
    completedOnce: true,
    advanced: true,
  });
}

// Clamp
assert.equal(clampDifficultyRating(1), 1);
assert.equal(clampDifficultyRating(5), 5);
assert.equal(clampDifficultyRating(0), 1);
assert.equal(clampDifficultyRating(9), 5);
assert.equal(clampDifficultyRating("3.4"), 3);

// No ratings → official FDR
withCustom({});
assert.equal(teamDifficultyUsesFixtures(), false);
assert.equal(resolveFixtureDifficulty({ opp: "ARS", ha: "H", difficulty: 3 }, "all"), 3);

// Ratings present → always applied (no toggle)
withCustom({ ARS: ARS_HARD });
assert.equal(teamDifficultyUsesFixtures(), true);
assert.equal(
  resolveFixtureDifficulty({ opp: "ARS", ha: "H", difficulty: 2 }, "all"),
  5,
  "ratings present → custom FDR (toggle removed)"
);

// Custom on: venue flip (you home → face opp away side)
withCustom({ ARS: ARS_HARD, BOU: BOU_EASY });
assert.equal(teamDifficultyUsesFixtures(), true);
assert.equal(customTeamAxis("ARS", "A", "atk"), 5);
assert.equal(customTeamAxis("ARS", "A", "def"), 5);
assert.equal(customTeamAxis("BOU", "H", "def"), 1);

// You (any) home vs ARS → opp plays away → use ARS.A
assert.equal(
  resolveFixtureDifficulty({ opp: "ARS", ha: "H", difficulty: 2 }, "all"),
  5,
  "home vs ARS → max(ARS away atk/def)=5, not official 2"
);
// You away vs BOU → opp home → use BOU.H
assert.equal(
  resolveFixtureDifficulty({ opp: "BOU", ha: "A", difficulty: 4 }, "all"),
  1,
  "away vs BOU → max(BOU home atk/def)=1, not official 4"
);

// Axis modes: atk SOS = opp defence; def SOS = opp attack
withCustom({
  XYZ: { H: { atk: 2, def: 5 }, A: { atk: 1, def: 4 } },
});
setSosMode("atk");
assert.equal(
  resolveFixtureDifficulty({ opp: "XYZ", ha: "H", difficulty: 3 }, "atk"),
  4,
  "atk mode → opp away defence"
);
assert.equal(
  resolveFixtureDifficulty({ opp: "XYZ", ha: "A", difficulty: 3 }, "atk"),
  5,
  "atk mode → opp home defence"
);
setSosMode("def");
assert.equal(
  resolveFixtureDifficulty({ opp: "XYZ", ha: "H", difficulty: 3 }, "def"),
  1,
  "def mode → opp away attack"
);
assert.equal(
  resolveFixtureDifficulty({ opp: "XYZ", ha: "A", difficulty: 3 }, "def"),
  2,
  "def mode → opp home attack"
);
setSosMode("all");
assert.equal(
  resolveFixtureDifficulty({ opp: "XYZ", ha: "A", difficulty: 3 }, "all"),
  5,
  "all mode → max(atk,def) on opp home side"
);

// Missing club falls back to official
assert.equal(
  resolveFixtureDifficulty({ opp: "UNK", ha: "H", difficulty: 3 }, "all"),
  3,
  "unknown opp → official"
);

// --- Static audit: consumers call resolveFixtureDifficulty ---
const failures = [];
const results = [];

for (const surface of FDR_CONSUMERS) {
  const body = extractFn(surface.fn);
  let ok = true;
  let detail = "";
  if (surface.via) {
    ok = body.includes(surface.via) && fnBodyContains(surface.via, "resolveFixtureDifficulty");
    detail = ok
      ? `via ${surface.via} → resolveFixtureDifficulty`
      : `expected ${surface.fn} → ${surface.via} → resolveFixtureDifficulty`;
  } else if (surface.requires) {
    const missing = surface.requires.filter((n) => !body.includes(n));
    ok = missing.length === 0;
    detail = ok
      ? `requires ${surface.requires.join(" + ")}`
      : `missing ${missing.join(", ")}`;
  } else {
    ok = body.includes("resolveFixtureDifficulty");
    detail = ok ? "calls resolveFixtureDifficulty" : "MISSING resolveFixtureDifficulty";
  }
  results.push({ ...surface, ok, detail });
  if (!ok) failures.push(surface.id);
}

// Fixture tooltip / schedule cards must NOT silently claim custom wash unless opted in
{
  const sched = extractFn("scheduleCardHTML");
  assert.ok(
    !sched.includes("customFdrWash"),
    "Matchups scheduleCardHTML must not enable customFdrWash (ranks stay OPTA/FPL)"
  );
  results.push({
    id: "matchups-no-custom-wash",
    label: "Matchups cards omit customFdrWash",
    ok: true,
    detail: "intentional — SOS ranks unchanged",
  });
}

// homePlayerMatchupHTML must enable wash when custom on
assert.ok(
  fnBodyContains("homePlayerMatchupHTML", "customFdrWash"),
  "player/team Schedule must pass customFdrWash"
);

// refresh path must re-paint Home + Fixtures + open schedule cards
{
  const refresh = extractFn("refreshTeamDifficultyConsumers");
  for (const needle of [
    "renderFixturesPage",
    "renderHome",
    "syncHomePitchCardStrips",
    "refreshOpenHomeScheduleCards",
  ]) {
    assert.ok(refresh.includes(needle), `refreshTeamDifficultyConsumers must call ${needle}`);
  }
  results.push({
    id: "refresh-consumers",
    label: "refreshTeamDifficultyConsumers re-paints Home/Fixtures/details",
    ok: true,
    detail: "renderFixturesPage + renderHome + pitch strips + open schedule cards",
  });
}

// Only seed / official tooltip label may read fx.difficulty for FDR numbers
{
  const directReads = [];
  const re = /\bfx\.difficulty\b/g;
  let m;
  while ((m = re.exec(src))) {
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const lineEnd = src.indexOf("\n", m.index);
    const line = src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim();
    const lineNo = src.slice(0, m.index).split("\n").length;
    // Allowed: seed from FPL, resolveFixtureDifficulty official fallback, tooltip "FPL N" label
    // Seed wizard medians, resolve() official fallback, tooltip "FPL N" label only.
    const allowed =
      line.includes("const official") ||
      line.includes("Number(fx && fx.difficulty)") ||
      line.includes("Number(fx.difficulty)") ||
      line.includes("fx.difficulty != null ? fx.difficulty");
    if (!allowed) directReads.push({ lineNo, line });
  }
  assert.equal(
    directReads.length,
    0,
    `Unexpected fx.difficulty reads (bypass resolve):\n${directReads
      .map((d) => `  L${d.lineNo}: ${d.line}`)
      .join("\n")}`
  );
  results.push({
    id: "no-bypass",
    label: "No presentation path reads fx.difficulty for wash",
    ok: true,
    detail: "only seed + official fallback + tooltip FPL label",
  });
}

if (failures.length) {
  console.error("FAIL — custom FDR consumers missing resolveFixtureDifficulty:");
  for (const r of results.filter((x) => x.ok === false)) {
    console.error(`  ✗ ${r.label} (${r.fn}): ${r.detail}`);
  }
  process.exit(1);
}

console.log("ok — custom fixture difficulty\n");
console.log("Resolution");
console.log("  ✓ no ratings → official FDR");
console.log("  ✓ ratings present → always applied (no toggle)");
console.log("  ✓ venue-flipped opponent ratings");
console.log("  ✓ all / atk / def SOS modes");
console.log("");
console.log("Presentation surfaces (must use custom when ratings exist)");
for (const r of results.filter((x) => FDR_CONSUMERS.some((c) => c.id === x.id) || x.id === "refresh-consumers" || x.id === "no-bypass" || x.id === "matchups-no-custom-wash")) {
  const mark = r.ok ? "✓" : "✗";
  console.log(`  ${mark} ${r.label}`);
  if (r.detail) console.log(`      ${r.detail}`);
}
console.log("");
console.log("Intentionally not custom FDR");
for (const s of INTENTIONAL_NON_CUSTOM) {
  console.log(`  · ${s.label}`);
  console.log(`      ${s.reason}`);
}
