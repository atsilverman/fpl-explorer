#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 24.04 droplet ($6 / 1 GB recommended).
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/atsilverman/fpl-explorer/main/deploy/digitalocean/setup.sh | bash
# Or after clone:
#   ./deploy/digitalocean/setup.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/fpl-explorer}"
REPO="${REPO:-https://github.com/atsilverman/fpl-explorer.git}"
MANAGER_ID="${FPL_HOME_MANAGER_ID:-296817}"
LEAGUE_ID="${FPL_HOME_LEAGUE_ID:-954157}"

echo "==> Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git python3 python3-venv curl

echo "==> Cloning app to ${APP_DIR}"
if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" pull --ff-only
else
  git clone "${REPO}" "${APP_DIR}"
fi

cd "${APP_DIR}"
python3 -m venv .venv

echo "==> Writing home_prefs.json"
cat > site/home_prefs.json <<EOF
{
  "managerId": ${MANAGER_ID},
  "leagueId": ${LEAGUE_ID}
}
EOF

echo "==> Initial fetch"
.venv/bin/python3 site/fetch_home.py

echo "==> Installing systemd unit"
cp deploy/digitalocean/fpl-live.service /etc/systemd/system/fpl-live.service
systemctl daemon-reload
systemctl enable fpl-live
systemctl restart fpl-live

echo "==> Status"
sleep 2
systemctl --no-pager status fpl-live || true
curl -sf "http://127.0.0.1:8080/health" | python3 -m json.tool || echo "Health check pending…"

cat <<'MSG'

Done. Live server listens on http://127.0.0.1:8080

Next steps:
  1. Open port 443/80 and put Caddy/nginx in front for HTTPS (see deploy/digitalocean/README.md)
  2. Set window.FPL_LIVE_API in site/index.html to your public URL
  3. Redeploy Vercel

Logs: journalctl -u fpl-live -f
MSG
