#!/usr/bin/env bash
# Pull latest code, reinstall deps if needed, restart the backend.
# Run from the Lightsail box.

set -euo pipefail

REPO_DIR="$HOME/aztec-triple-triad"
cd "$REPO_DIR"

echo "=== git pull ==="
git pull --ff-only

echo "=== npm install ==="
npm install --legacy-peer-deps

echo "=== restart backend ==="
sudo systemctl restart triad-backend
sleep 2
sudo systemctl status triad-backend --no-pager | head -15

echo ""
echo "=== tail logs (Ctrl+C to exit) ==="
sudo journalctl -u triad-backend -f --since "1 minute ago"
