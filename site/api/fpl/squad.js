const FPL_BASE = "https://fantasy.premierleague.com/api";
const UA = "fpl-explorer/1.0 (+vercel-proxy)";
const POS_BY_TYPE = { 1: "GK", 2: "DEF", 3: "MID", 4: "FWD" };

let bootstrapCache = null;
let bootstrapCachedAt = 0;
const BOOTSTRAP_TTL_MS = 30 * 60 * 1000;

function json(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

async function fplGet(path) {
  const res = await fetch(`${FPL_BASE}${path}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

async function getBootstrap() {
  const now = Date.now();
  if (bootstrapCache && now - bootstrapCachedAt < BOOTSTRAP_TTL_MS) return bootstrapCache;
  const { ok, status, data } = await fplGet("/bootstrap-static/");
  if (!ok || !data) {
    const err = new Error(`bootstrap-static failed (${status})`);
    err.status = status || 502;
    throw err;
  }
  bootstrapCache = data;
  bootstrapCachedAt = now;
  return data;
}

function resolveGw(bootstrap, entry) {
  const events = Array.isArray(bootstrap.events) ? bootstrap.events : [];
  const current = events.find((e) => e.is_current);
  const next = events.find((e) => e.is_next);
  const fromEntry = Number(entry && entry.current_event);
  if (Number.isFinite(fromEntry) && fromEntry > 0) return fromEntry;
  if (current && current.id) return Number(current.id);
  if (next && next.id) return Number(next.id);
  return 1;
}

function gwLabel(bootstrap, gw, hasPicks) {
  const events = Array.isArray(bootstrap.events) ? bootstrap.events : [];
  const ev = events.find((e) => Number(e.id) === Number(gw));
  const name = ev && ev.name ? String(ev.name) : `Gameweek ${gw}`;
  if (!hasPicks && ev && ev.is_next && !ev.is_current) return "Preseason";
  if (!hasPicks && Number(gw) <= 1) return "Preseason";
  return name;
}

function mapPicks(bootstrap, picksPayload) {
  const byId = new Map((bootstrap.elements || []).map((e) => [e.id, e]));
  const picks = Array.isArray(picksPayload && picksPayload.picks) ? picksPayload.picks : [];
  let captain = null;
  let vice = null;
  const squad = [];
  picks.forEach((pick) => {
    const el = byId.get(pick.element);
    if (!el) return;
    const position = POS_BY_TYPE[el.element_type] || "MID";
    const slotPos = Number(pick.position) || 0;
    const starter = slotPos >= 1 && slotPos <= 11;
    const benchOrder = starter ? 0 : Math.max(0, slotPos - 12);
    const code = Number(el.code);
    if (pick.is_captain) captain = code;
    if (pick.is_vice_captain) vice = code;
    squad.push({
      code,
      element: pick.element,
      position,
      starter,
      benchOrder,
      name: el.web_name || el.second_name || String(code),
      teamId: el.team,
    });
  });
  return { squad, captain, vice };
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }
  if (req.method !== "GET") {
    return json(res, 405, { ok: false, error: "Method not allowed" });
  }

  const id = String((req.query && req.query.id) || "").trim();
  if (!/^\d+$/.test(id) || Number(id) <= 0) {
    return json(res, 400, { ok: false, error: "Invalid manager ID" });
  }

  try {
    const bootstrap = await getBootstrap();
    const entryRes = await fplGet(`/entry/${id}/`);
    if (!entryRes.ok || !entryRes.data) {
      const status = entryRes.status === 404 ? 404 : 502;
      return json(res, status, {
        ok: false,
        error: entryRes.status === 404 ? "Manager not found" : "FPL entry lookup failed",
      });
    }
    const entry = entryRes.data;
    const gw = resolveGw(bootstrap, entry);
    const picksRes = await fplGet(`/entry/${id}/event/${gw}/picks/`);
    const hasPicks = !!(picksRes.ok && picksRes.data && Array.isArray(picksRes.data.picks));
    const mapped = hasPicks
      ? mapPicks(bootstrap, picksRes.data)
      : { squad: [], captain: null, vice: null };
    const teamsById = new Map((bootstrap.teams || []).map((t) => [t.id, t.short_name]));
    mapped.squad.forEach((slot) => {
      slot.team = teamsById.get(slot.teamId) || null;
      delete slot.teamId;
    });
    const history = (picksRes.data && picksRes.data.entry_history) || {};
    return json(res, 200, {
      ok: true,
      managerId: id,
      teamName: entry.name || "",
      managerName: [entry.player_first_name, entry.player_last_name].filter(Boolean).join(" "),
      gw,
      gwLabel: gwLabel(bootstrap, gw, hasPicks),
      hasPicks,
      syncedAt: new Date().toISOString(),
      bank: history.bank != null ? Number(history.bank) / 10 : null,
      value: history.value != null ? Number(history.value) / 10 : null,
      squad: mapped.squad,
      captain: mapped.captain,
      vice: mapped.vice,
      message: hasPicks
        ? null
        : "No published FPL picks yet for this gameweek (common in preseason before the squad is set).",
    });
  } catch (err) {
    return json(res, err.status || 502, {
      ok: false,
      error: err.message || "FPL proxy failed",
    });
  }
};
