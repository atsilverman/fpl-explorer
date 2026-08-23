# DigitalOcean live Home server

Minute-by-minute FPL live updates for the Home dashboard (configured manager, league standings, squads, `elementGw` search ranking) without redeploying the static site.

## Is this achievable?

**Yes.** Your repo already has everything needed:

| Piece | Role |
|-------|------|
| [`site/fetch_home.py`](../site/fetch_home.py) | Pulls FPL live + fixtures + league picks, runs [`live_scoring.py`](../site/live_scoring.py) (auto-subs, chips, Defcon, minutes, live status) |
| [`site/live_server.py`](../site/live_server.py) | Polls `fetch_home.py` on an interval and serves `GET /api/home` |
| Static site (Vercel) | UI; polls the DO API when `window.FPL_LIVE_API` is set |

One DO droplet polls FPL **once per minute** (during live fixtures) and serves **all users** — far better than per-browser FPL calls or git deploy cycles.

## Architecture

```
┌─────────────┐     every 60s (live)      ┌──────────────────┐
│  FPL API    │ ◄──────────────────────── │  DO Droplet      │
│  live/picks │                           │  live_server.py  │
└─────────────┘                           │  + fetch_home.py │
                                          └────────┬─────────┘
                                                   │ GET /api/home
┌─────────────┐                                    │
│   Vercel    │ ◄── browser polls every 60s ───────┘
│  (static)   │
└─────────────┘
```

### What refreshes each cycle

- **`elementGw`** — all players: GW points, minutes, live/finished
- **Focus manager** — squad, summary cards, chips
- **League** — live standings, all squads (`squadsByEntry`), ownership map

### API cost per refresh (~14-manager league)

Roughly **30+ FPL requests** (bootstrap, live, fixtures, history, picks + entry per league member). At **1/min during live games** that is fine for a personal/league tool. The server **slows to 5 min** when no fixtures are live.

## Droplet setup (Ubuntu 24.04)

### Quick setup (recommended)

On a **$6/mo / 1 GB** droplet as root:

```bash
git clone https://github.com/atsilverman/fpl-explorer.git /opt/fpl-explorer
cd /opt/fpl-explorer
FPL_HOME_MANAGER_ID=296817 FPL_HOME_LEAGUE_ID=954157 sudo -E bash deploy/digitalocean/setup.sh
```

Or override manager/league via env vars before running `setup.sh`.

### Manual setup

- **Size:** Basic $6/mo (1 vCPU, 1 GB) is enough — avoid $4/512MB
- **Image:** Ubuntu 24.04 LTS
- Optional: attach a domain (`live.yourdomain.com`) → droplet IP

### 1. Create droplet

```bash
sudo apt update && sudo apt install -y git python3 python3-venv

sudo useradd -r -m -d /opt/fpl-explorer -s /usr/sbin/nologin fpl-live || true
sudo mkdir -p /opt/fpl-explorer
sudo chown $USER:$USER /opt/fpl-explorer

git clone https://github.com/atsilverman/fpl-explorer.git /opt/fpl-explorer
cd /opt/fpl-explorer
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
# No extra pip deps — stdlib + your scripts only
```

### 3. Configure manager / league

```bash
cat > /opt/fpl-explorer/site/home_prefs.json <<'EOF'
{
  "managerId": 296817,
  "leagueId": 954157
}
EOF
```

Or set environment variables in the systemd unit (see below).

### 4. Test manually

```bash
cd /opt/fpl-explorer
.venv/bin/python3 site/fetch_home.py
.venv/bin/python3 site/live_server.py --port 8080
# curl http://127.0.0.1:8080/health
# curl http://127.0.0.1:8080/api/home | head -c 500
```

### 5. systemd service

```bash
sudo cp /opt/fpl-explorer/deploy/digitalocean/fpl-live.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fpl-live
sudo systemctl status fpl-live
journalctl -u fpl-live -f
```

### 6. HTTPS (recommended)

Put **Caddy** or **nginx** in front for TLS:

```bash
sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
live.yourdomain.com {
    reverse_proxy localhost:8080
}
```

```bash
sudo systemctl reload caddy
```

### 7. Wire the static site

In [`site/index.html`](../index.html), set (before `app.js`):

```html
<script>window.FPL_LIVE_API = "https://live.yourdomain.com";</script>
```

Redeploy Vercel. On Home, the app polls `/api/home` every 60s when that URL is set and manager/league match the user’s Preferences.

## Endpoints

| Path | Description |
|------|-------------|
| `GET /api/home` | `{ ok: true, home: { ... FPL_HOME payload ... } }` |
| `GET /health` | `{ ok, generatedAt, intervalSec, lastError, fetching }` |

CORS is `*` so the Vercel origin can fetch directly.

## Environment variables

| Variable | Default | Meaning |
|----------|---------|---------|
| `FPL_HOME_MANAGER_ID` | `home_prefs.json` | Focus manager |
| `FPL_HOME_LEAGUE_ID` | `home_prefs.json` | Mini-league |
| `LIVE_SERVER_PORT` | `8080` | HTTP port |
| `LIVE_INTERVAL_LIVE` | `60` | Poll interval when fixtures are live |
| `LIVE_INTERVAL_IDLE` | `300` | Poll interval otherwise |

## Limitations & next steps

1. **One league per server** — `home_prefs.json` drives the cache. Multi-league would mean multiple daemon instances or extending `fetch_home` to loop tracked leagues.
2. **User prefs vs server prefs** — Browser Preferences (localStorage) must match the server’s manager/league to apply live polls; mismatch falls back to static `home_data.js`.
3. **Per-user managers** — Would need server-side prefs (POST `/api/home-prefs`) + auth, or on-demand fetch by entry id.
4. **FPL rate limits** — No official cap; stay at 1/min live max. Do not expose an endpoint that triggers full league fetch per user.

## Updating

```bash
cd /opt/fpl-explorer
git pull
sudo systemctl restart fpl-live
```
