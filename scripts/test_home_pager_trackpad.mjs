#!/usr/bin/env node
/**
 * Unit tests for Home pager trackpad helpers (extracted from site/app.js).
 * Run: node scripts/test_home_pager_trackpad.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "site/app.js"), "utf8");

function extractFn(name) {
  const re = new RegExp(
    `function ${name}\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\}\\n\\n  (?:/\\*\\*|function )`
  );
  const m = src.match(re);
  if (!m) throw new Error(`Could not extract ${name} from app.js`);
  const full = src.slice(m.index, m.index + m[0].length);
  // Trim the trailing lookahead junk — rematch to balanced end.
  const start = src.indexOf(`function ${name}`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return src.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Unbalanced braces for ${name}`);
}

const code = [
  extractFn("homePagerNormalizeWheelDeltas"),
  extractFn("homePagerWheelIsHorizontal"),
].join("\n");

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(`${code}\nthis.homePagerNormalizeWheelDeltas = homePagerNormalizeWheelDeltas;\nthis.homePagerWheelIsHorizontal = homePagerWheelIsHorizontal;`, ctx);

const { homePagerNormalizeWheelDeltas, homePagerWheelIsHorizontal } = ctx;

// --- normalize ---
{
  const a = homePagerNormalizeWheelDeltas(40, 10, false);
  assert.equal(a.dx, 40);
  assert.equal(a.dy, 10);
}
{
  const a = homePagerNormalizeWheelDeltas(5, 40, true);
  assert.equal(a.dx, 40);
  assert.equal(a.dy, 0);
}

// --- horizontal claim (old strict |dx|>|dy| would fail several of these) ---
assert.equal(homePagerWheelIsHorizontal(30, 10, 0.55), true, "clear horizontal");
assert.equal(homePagerWheelIsHorizontal(30, 40, 0.55), true, "diagonal still claims (30 >= 40*0.55)");
assert.equal(homePagerWheelIsHorizontal(20, 50, 0.55), false, "mostly vertical rejected");
assert.equal(homePagerWheelIsHorizontal(0.5, 0.1, 0.55), false, "tiny noise ignored");
assert.equal(homePagerWheelIsHorizontal(48, 48, 0.55), true, "equal axes claim");

// Old gate (|dx| > |dy|) would reject Ownership→Schedule style pans:
assert.equal(homePagerWheelIsHorizontal(35, 40, 0.55), true, "regress: slight vertical leak still pages");
assert.equal(35 > 40, false, "sanity: old gate would have rejected");

console.log("ok — home pager trackpad helpers");
