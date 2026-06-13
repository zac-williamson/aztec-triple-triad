#!/usr/bin/env bash
# One-shot provision script for a fresh Ubuntu 22.04 Lightsail (or EC2) box.
# Run ONCE after SSHing in. Safe to re-run — apt and npm installs are idempotent.
#
# Usage:
#   ssh ubuntu@<lightsail-ip>
#   curl -sL https://raw.githubusercontent.com/YOURUSER/aztec-triple-triad/main/deploy/provision-lightsail.sh | bash
# or copy this file to the box and: bash provision-lightsail.sh
#
# What it does:
#   1. System packages (node 22, redis, nginx, certbot, git)
#   2. Clone the repo into ~/aztec-triple-triad
#   3. npm install (monorepo)
#   4. Install the triad-backend systemd unit (not yet started — needs env file)
#   5. Install the Nginx config (not yet enabled — needs certbot)

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/zac-williamson/aztec-triple-triad.git}"
REPO_BRANCH="${REPO_BRANCH:-testnet}"
REPO_DIR="${REPO_DIR:-$HOME/axolotl-arena-server}"

echo "=== 1. System packages ==="
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git build-essential

# Node 22 via NodeSource
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "node: $(node -v)"

sudo apt-get install -y redis-server nginx certbot python3-certbot-nginx

# Redis listens on loopback by default on Ubuntu — verify.
sudo systemctl enable --now redis-server
redis-cli ping  # expect PONG

echo "=== 2. Clone / pull repo ==="
if [[ ! -d "$REPO_DIR/.git" ]]; then
  git clone --branch "$REPO_BRANCH" "$REPO_URL" "$REPO_DIR"
else
  git -C "$REPO_DIR" fetch origin "$REPO_BRANCH"
  git -C "$REPO_DIR" checkout "$REPO_BRANCH"
  git -C "$REPO_DIR" reset --hard "origin/$REPO_BRANCH"
fi
cd "$REPO_DIR"

echo "=== 3. npm install ==="
npm install --legacy-peer-deps

echo "=== 3b. build backend (compiled JS for systemd ExecStart) ==="
npm run build --workspace=@axolotl-arena/game-logic
npm run build --workspace=@axolotl-arena/backend

echo "=== 4. Install systemd unit ==="
sudo cp deploy/triad-backend.service /etc/systemd/system/triad-backend.service
sudo sed -i "s|__REPO_DIR__|${REPO_DIR}|g" /etc/systemd/system/triad-backend.service
sudo systemctl daemon-reload
echo "systemd unit installed. NOT started yet — you still need to:"
echo "  sudo cp deploy/triad-backend.env.example /etc/triad-backend.env"
echo "  sudo nano /etc/triad-backend.env   # set ALLOWED_ORIGINS to your Vercel domain"
echo "  sudo chmod 600 /etc/triad-backend.env"
echo "  sudo systemctl enable --now triad-backend"

echo "=== 5. Install Nginx config (not yet enabled) ==="
sudo cp deploy/nginx-triad.conf /etc/nginx/sites-available/triad
echo "Nginx config staged. Next steps:"
echo "  sudo nano /etc/nginx/sites-available/triad   # replace ws.YOURDOMAIN.com"
echo "  sudo ln -sf /etc/nginx/sites-available/triad /etc/nginx/sites-enabled/triad"
echo "  sudo nginx -t && sudo systemctl reload nginx"
echo "  sudo certbot --nginx -d ws.YOURDOMAIN.com"

echo ""
echo "=== Provisioning complete ==="
echo "Finish the manual steps above, then the backend will be live on wss://ws.YOURDOMAIN.com"
