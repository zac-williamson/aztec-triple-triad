#!/usr/bin/env bash
# Pull latest code, reinstall deps, rebuild backend, restart the service.
# Run from the Lightsail box.
#
# The REPO_DIR env var defaults to ~/axolotl-arena-server (the path the
# provision script clones into). Override if you cloned elsewhere.

set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/axolotl-arena-server}"
cd "$REPO_DIR"

echo "=== git pull ==="
git pull --ff-only

echo "=== npm install ==="
npm install --legacy-peer-deps

echo "=== build game-logic (backend workspace dep) ==="
npm run build --workspace=@axolotl-arena/game-logic

echo "=== build backend ==="
npm run build --workspace=@axolotl-arena/backend

echo "=== restart backend ==="
sudo systemctl restart triad-backend
sleep 2
sudo systemctl status triad-backend --no-pager | head -15

echo ""
echo "=== tail logs (Ctrl+C to exit) ==="
sudo journalctl -u triad-backend -f --since "1 minute ago"
