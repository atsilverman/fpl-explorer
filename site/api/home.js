const LIVE_ORIGIN = (process.env.FPL_LIVE_ORIGIN || "http://159.203.184.115:8080").replace(
  /\/$/,
  ""
);
const UA = "fpl-explorer/1.0 (+vercel-live-proxy)";

function json(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
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

  try {
    const upstream = await fetch(`${LIVE_ORIGIN}/api/home`, {
      headers: { Accept: "application/json", "User-Agent": UA },
    });
    const text = await upstream.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!upstream.ok || !data) {
      return json(res, upstream.status === 404 ? 502 : upstream.status || 502, {
        ok: false,
        error: (data && data.error) || `Live server unreachable (${upstream.status})`,
      });
    }
    return json(res, 200, data);
  } catch (err) {
    return json(res, 502, {
      ok: false,
      error: err && err.message ? err.message : "Live server proxy failed",
    });
  }
};
