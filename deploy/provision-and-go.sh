#!/usr/bin/env bash
# One-shot, NON-INTERACTIVE backend bring-up for a fresh Ubuntu 22.04 EC2/Lightsail box.
# Does everything provision-lightsail.sh did PLUS the env/systemd/nginx/TLS steps that
# used to be manual — no prompts, idempotent, safe to re-run.
#
# Run ON the box (after SSHing in), or drive it over SSH from the orchestrator.
# Configure via env vars (defaults target aztec-arena.com):
#
#   WS_DOMAIN=ws.aztec-arena.com \
#   FRONTEND_ORIGIN=https://www.aztec-arena.com \
#   LE_EMAIL=you@example.com \
#   bash provision-and-go.sh
#
# certbot is skipped (with a clear message) until the WS_DOMAIN A-record resolves
# to THIS box — so it's safe to run before DNS has propagated, then re-run.

set -euo pipefail

WS_DOMAIN="${WS_DOMAIN:-ws.aztec-arena.com}"
FRONTEND_ORIGIN="${FRONTEND_ORIGIN:-https://www.aztec-arena.com}"
LE_EMAIL="${LE_EMAIL:-}"
REPO_URL="${REPO_URL:-https://github.com/zac-williamson/aztec-triple-triad.git}"
REPO_BRANCH="${REPO_BRANCH:-testnet}"
REPO_DIR="${REPO_DIR:-$HOME/axolotl-arena-server}"

echo "=== 1. System packages (node 22, redis, nginx, certbot) ==="
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git build-essential
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y redis-server nginx certbot python3-certbot-nginx
sudo systemctl enable --now redis-server
redis-cli ping

echo "=== 2. Clone / update repo (branch $REPO_BRANCH) ==="
if [[ ! -d "$REPO_DIR/.git" ]]; then
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR"
else
  git -C "$REPO_DIR" fetch origin "$REPO_BRANCH"
  git -C "$REPO_DIR" reset --hard "origin/$REPO_BRANCH"
fi
cd "$REPO_DIR"

echo "=== 3. Install + build (backend is address-agnostic — no contract addrs needed) ==="
npm install --legacy-peer-deps
npm run build --workspace=@axolotl-arena/game-logic
npm run build --workspace=@axolotl-arena/backend

echo "=== 4. Backend env + systemd unit ==="
sudo tee /etc/triad-backend.env >/dev/null <<ENV
NODE_ENV=production
WS_PORT=5174
REDIS_URL=redis://localhost:6379
ALLOWED_ORIGINS=${FRONTEND_ORIGIN}
ENV
sudo chmod 600 /etc/triad-backend.env
sudo cp deploy/triad-backend.service /etc/systemd/system/triad-backend.service
sudo sed -i "s|__REPO_DIR__|${REPO_DIR}|g" /etc/systemd/system/triad-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now triad-backend
sleep 2
sudo systemctl is-active triad-backend && curl -fsS "http://localhost:5174/health" && echo " <- backend healthy on :5174"

echo "=== 5. Nginx reverse proxy for $WS_DOMAIN ==="
sudo cp deploy/nginx-triad.conf /etc/nginx/sites-available/triad
sudo sed -i "s/ws\.YOURDOMAIN\.com/${WS_DOMAIN}/g" /etc/nginx/sites-available/triad
sudo ln -sf /etc/nginx/sites-available/triad /etc/nginx/sites-enabled/triad
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo "=== 6. TLS via certbot (only if DNS already points here) ==="
MY_IP="$(curl -fsS https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
DNS_IP="$(getent hosts "$WS_DOMAIN" | awk '{print $1}' | head -1 || true)"
if [[ -n "$MY_IP" && "$DNS_IP" == "$MY_IP" ]]; then
  if [[ -z "$LE_EMAIL" ]]; then
    sudo certbot --nginx -d "$WS_DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
  else
    sudo certbot --nginx -d "$WS_DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect
  fi
  echo "=== DONE — backend live at wss://${WS_DOMAIN} ==="
  curl -fsS "https://${WS_DOMAIN}/health" && echo " <- HTTPS health OK"
else
  echo "!! Skipped certbot: ${WS_DOMAIN} resolves to '${DNS_IP:-nothing}', this box is '${MY_IP}'."
  echo "   Backend is already live on http://localhost:5174 behind nginx :80."
  echo "   Once the A-record propagates, re-run this script (or just the certbot line) to get TLS."
fi
