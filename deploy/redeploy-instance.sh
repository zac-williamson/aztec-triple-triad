#!/usr/bin/env bash
# Deploy a new contract instance and repoint everything at it, in one run.
#
# Written because doing this by hand cost two outages in one night: a missed
# `git pull` left the bot running an artifact whose contract class no longer
# existed, so it failed EVERY join; and a raw `cp` of a systemd unit that is
# actually a template installed `WorkingDirectory=__REPO_DIR__` and took the
# health probe down. Neither is the kind of mistake that gets made twice by a
# script.
#
#   ./deploy/redeploy-instance.sh              # full: contracts, web, box, cards
#   ./deploy/redeploy-instance.sh --no-cards   # skip the ~25min re-mint
#
# Needs the deployer key and the Vercel token; run it where those live, never
# on the box.
set -euo pipefail

cd "$(dirname "$0")/.."
BOX="${ARENA_BOX:-ubuntu@13.42.161.225}"
KEY="${ARENA_KEY:-$HOME/.ssh/aztec_deploy}"
REMOTE_DIR="${ARENA_REMOTE_DIR:-/home/ubuntu/axolotl-arena-server}"
CARDS="${ARENA_BOT_CARDS:-1000}"
WS_URL="${ARENA_WS_URL:-wss://ws.aztec-arena.com}"
DO_CARDS=1
[ "${1:-}" = "--no-cards" ] && DO_CARDS=0

say() { printf '\n=== %s ===\n' "$1"; }
ssh_box() { ssh -i "$KEY" -o ConnectTimeout=30 "$BOX" "$@"; }

say "1/7  compile contracts"
( cd packages/contracts && aztec compile )

say "2/7  deploy to testnet"
set -a; eval "$(grep -E '^DEPLOYER_(SECRET|SALT|SIGNING_KEY)=' ~/.aztec-triad-private/deployer-testnet-key.txt)"; set +a
export AZTEC_PXE_URL="${AZTEC_PXE_URL:-https://v5.testnet.rpc.aztec-labs.com}"
npx tsx scripts/deploy-testnet.ts

# deploy-testnet.ts writes a LOCAL ws url into the testnet env, which would
# point the deployed site at nothing.
sed -i.bak "s|^VITE_WS_URL=.*|VITE_WS_URL=${WS_URL}|" packages/frontend/.env.testnet
rm -f packages/frontend/.env.testnet.bak

NFT=$(grep '^VITE_NFT_CONTRACT_ADDRESS=' packages/frontend/.env.testnet | cut -d= -f2)
GAME=$(grep '^VITE_GAME_CONTRACT_ADDRESS=' packages/frontend/.env.testnet | cut -d= -f2)
TOKEN=$(grep '^VITE_TOKEN_CONTRACT_ADDRESS=' packages/frontend/.env.testnet | cut -d= -f2)
printf '  NFT   %s\n  Game  %s\n  Token %s\n' "$NFT" "$GAME" "$TOKEN"

say "3/7  ship artifacts and commit"
npm run copy-contracts >/dev/null
git add -A packages/frontend/.env.testnet packages/frontend/public/contracts
git commit -q -m "chore: point at redeployed instance

NFT   ${NFT}
Game  ${GAME}
Token ${TOKEN}" || echo "  (nothing to commit)"
git push -q origin "$(git rev-parse --abbrev-ref HEAD)"

say "4/7  sync Vercel env and redeploy the site"
npx tsx scripts/sync-vercel-env.ts

say "5/7  stop the bot and park the previous instance"
# Parked, never deleted: the manifest is the ONLY record of an untagged note's
# plaintext, and the journal is the only record that cards are locked.
ssh_box "set -e
  sudo systemctl stop triad-bot
  sudo sed -i 's|^VITE_NFT_CONTRACT_ADDRESS=.*|VITE_NFT_CONTRACT_ADDRESS=${NFT}|' /etc/triad-bot.env
  sudo sed -i 's|^VITE_GAME_CONTRACT_ADDRESS=.*|VITE_GAME_CONTRACT_ADDRESS=${GAME}|' /etc/triad-bot.env
  sudo sed -i 's|^VITE_TOKEN_CONTRACT_ADDRESS=.*|VITE_TOKEN_CONTRACT_ADDRESS=${TOKEN}|' /etc/triad-bot.env
  ts=\$(date +%s)
  sudo mv /var/lib/triad-bot/arena-bot-0.json /var/lib/triad-bot/arena-bot-0.json.parked-\$ts 2>/dev/null || true
  sudo rm -f /var/lib/triad-bot/arena-bot-0.json.imported.json
  sudo mkdir -p /var/lib/triad-bot/games-0.parked
  sudo sh -c 'mv /var/lib/triad-bot/games-0/* /var/lib/triad-bot/games-0.parked/ 2>/dev/null || true'"

if [ "$DO_CARDS" = "1" ]; then
  say "6/7  mint the bot a stock on the new NFT (~25 min)"
  mv packages/bot/.artifacts/arena-bot-0.json "packages/bot/.artifacts/arena-bot-0.json.parked-$(date +%s)" 2>/dev/null || true
  rm -f packages/bot/.artifacts/arena-bot-0.json.imported.json
  set -a; . packages/frontend/.env.testnet; set +a
  npx tsx scripts/provision-arena-bot.ts --index 0 --cards "$CARDS"
  cp packages/bot/.artifacts/arena-bot-0.json \
     ~/.aztec-triad-private/manifest-backups/"arena-bot-0.$(date +%Y%m%dT%H%M%S).json"
  scp -i "$KEY" packages/bot/.artifacts/arena-bot-0.json "$BOX":/tmp/arena-bot-0.json
  ssh_box "sudo mv /tmp/arena-bot-0.json /var/lib/triad-bot/arena-bot-0.json
    sudo chown ubuntu:ubuntu /var/lib/triad-bot/arena-bot-0.json
    sudo chmod 600 /var/lib/triad-bot/arena-bot-0.json"
else
  say "6/7  skipping the re-mint (--no-cards)"
fi

say "7/7  pull, rebuild and restart on the box"
# The pull is the step whose absence cost an outage: without it the bot runs a
# contract artifact whose class id no longer exists and fails every join.
ssh_box "set -eo pipefail
  cd '$REMOTE_DIR'
  git checkout -- package-lock.json 2>/dev/null || true
  git pull --ff-only
  npm run build --workspace=@axolotl-arena/game-logic
  npm run build --workspace=@axolotl-arena/backend
  npm run build --workspace=@axolotl-arena/bot
  # Units are TEMPLATES: copying them raw installs __REPO_DIR__ literally and
  # the unit will not load at all. That took the health probe down once.
  for u in triad-backend triad-bot triad-health triad-health-alert@; do
    if [ -f deploy/\$u.service ]; then
      sudo cp deploy/\$u.service /etc/systemd/system/\$u.service
      sudo sed -i \"s|__REPO_DIR__|$REMOTE_DIR|g\" /etc/systemd/system/\$u.service
    fi
  done
  sudo systemctl daemon-reload
  sudo systemctl restart triad-backend triad-bot"

say "verify"
sleep 20
echo "relay:  $(curl -s --max-time 20 https://ws.aztec-arena.com/health || echo UNREACHABLE)"
echo "arena:  $(curl -s --max-time 20 https://ws.aztec-arena.com/arena-health || echo UNREACHABLE)"
ssh_box "echo \"health OnFailure: [\$(systemctl show triad-health.service -p OnFailure --value)]\""
echo
echo "Now play one: ./scripts/prod-smoke.sh   (do NOT deploy while it runs —"
echo "a deploy replaces the chunks an open tab is still using and its proofs fail)"
