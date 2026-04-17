#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Parse flags
FRESH=0
for arg in "$@"; do
  case "$arg" in
    --fresh|-f)
      FRESH=1
      ;;
    --help|-h)
      echo "Usage: $0 [--fresh|-f]"
      echo ""
      echo "  --fresh, -f   Wipe Redis data (games, sessions, queue, inboxes)"
      echo "                before starting the backend. Use for a clean slate."
      exit 0
      ;;
  esac
done

echo -e "${CYAN}=== Axolotl Arena — Dev Startup ===${NC}"
echo ""

# ─── Step 0: Check Aztec sandbox ───
echo -e "${YELLOW}Checking Aztec sandbox...${NC}"
if curl -s -X POST http://localhost:8080 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"node_getVersion","params":[],"id":1}' 2>/dev/null | grep -q result; then
  echo -e "${GREEN}  ✓ Aztec sandbox is running at http://localhost:8080${NC}"
else
  echo -e "${RED}  ✗ Aztec sandbox is NOT running.${NC}"
  echo ""
  echo "  Start it in a separate terminal first:"
  echo ""
  echo "    bash start-sandbox.sh"
  echo ""
  echo "  Wait until you see block production, then re-run this script."
  exit 1
fi

# ─── Step 1: Compile contracts & circuits (skip if artifacts exist) ───
echo ""
CONTRACTS_DIR="$ROOT_DIR/packages/contracts"
CIRCUITS_DIR="$ROOT_DIR/circuits"

echo -e "${YELLOW}Compiling contracts...${NC}"
cd "$CONTRACTS_DIR"
aztec compile
echo -e "${GREEN}  ✓ Contracts compiled${NC}"
cd "$ROOT_DIR"

echo -e "${YELLOW}Compiling circuits...${NC}"
cd "$CIRCUITS_DIR"
nargo compile
echo -e "${GREEN}  ✓ Circuits compiled${NC}"
cd "$ROOT_DIR"

# ─── Step 2: Copy artifacts to frontend ───
echo ""
echo -e "${YELLOW}Copying artifacts to frontend/public...${NC}"
npm run copy-circuits 2>/dev/null && echo -e "${GREEN}  ✓ Circuits copied${NC}"
npm run copy-contracts 2>/dev/null && echo -e "${GREEN}  ✓ Contracts copied${NC}"

# ─── Step 3: Deploy contracts ───
echo ""
if [ -f packages/frontend/.env ] && grep -q "VITE_GAME_CONTRACT_ADDRESS" packages/frontend/.env; then
  echo -e "${YELLOW}Existing .env found with contract addresses:${NC}"
  grep "VITE_NFT_CONTRACT_ADDRESS\|VITE_GAME_CONTRACT_ADDRESS\|VITE_TOKEN_CONTRACT_ADDRESS" packages/frontend/.env | sed 's/^/  /'
  echo ""
  read -p "  Re-deploy contracts? (y/N): " REDEPLOY
  if [[ "$REDEPLOY" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Deploying contracts...${NC}"
    npx tsx scripts/deploy-contracts.ts
    echo -e "${GREEN}  ✓ Contracts deployed${NC}"
  else
    echo -e "${GREEN}  ✓ Using existing deployment${NC}"
  fi
else
  echo -e "${YELLOW}No contract addresses found. Deploying contracts...${NC}"
  npx tsx scripts/deploy-contracts.ts
  echo -e "${GREEN}  ✓ Contracts deployed${NC}"
fi

# ─── Step 4: Update .env.devnet to match .env ───
cp packages/frontend/.env packages/frontend/.env.devnet
echo -e "${GREEN}  ✓ .env.devnet synced${NC}"

# ─── Step 5: Start Redis ───
echo ""
REDIS_PORT=6379
REDIS_STARTED=""
if /opt/homebrew/bin/redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  echo -e "${GREEN}  ✓ Redis already running on port $REDIS_PORT${NC}"
else
  echo -e "${YELLOW}Starting Redis on port $REDIS_PORT...${NC}"
  if [ -x /opt/homebrew/opt/redis/bin/redis-server ]; then
    /opt/homebrew/opt/redis/bin/redis-server --daemonize yes --port "$REDIS_PORT" --loglevel warning
    REDIS_STARTED=1
    sleep 1
    if /opt/homebrew/bin/redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
      echo -e "${GREEN}  ✓ Redis started${NC}"
    else
      echo -e "${RED}  ✗ Redis failed to start — backend will use in-memory store${NC}"
      REDIS_STARTED=""
    fi
  else
    echo -e "${RED}  ✗ Redis not installed (brew install redis) — backend will use in-memory store${NC}"
    REDIS_PORT=""
  fi
fi
if /opt/homebrew/bin/redis-cli -p "${REDIS_PORT:-6379}" ping >/dev/null 2>&1; then
  export REDIS_URL="redis://localhost:$REDIS_PORT"
else
  export REDIS_URL=""
fi

# ─── Step 5b: Wipe Redis data if --fresh flag was passed ───
if [[ "$FRESH" == "1" ]]; then
  if [[ -n "$REDIS_URL" ]]; then
    echo ""
    echo -e "${YELLOW}--fresh flag: wiping Redis data (games, sessions, queue, inboxes)...${NC}"
    # Target every key pattern the backend writes (see RedisGameStore header).
    # Use xargs so the del call is skipped when the pattern matches nothing.
    for pattern in 'game:*' 'player:*' 'session:*' 'inbox:*' 'queue'; do
      keys=$(/opt/homebrew/bin/redis-cli -p "$REDIS_PORT" --no-raw keys "$pattern" | tr -d '"')
      if [[ -n "$keys" ]]; then
        count=$(echo "$keys" | wc -l | tr -d ' ')
        echo "$keys" | xargs /opt/homebrew/bin/redis-cli -p "$REDIS_PORT" del >/dev/null
        echo -e "${GREEN}  ✓ Deleted $count key(s) matching '$pattern'${NC}"
      fi
    done
    echo -e "${GREEN}  ✓ Redis wiped${NC}"
  else
    echo ""
    echo -e "${YELLOW}  --fresh flag ignored: Redis not available${NC}"
  fi
fi

# ─── Step 6: Start backend WebSocket server ───
echo ""
echo -e "${YELLOW}Starting backend WebSocket server...${NC}"
cd "$ROOT_DIR/packages/backend"
REDIS_URL="$REDIS_URL" npx tsx src/server.ts &
BACKEND_PID=$!
cd "$ROOT_DIR"
echo -e "${GREEN}  ✓ Backend started (PID: $BACKEND_PID) on ws://localhost:5174${NC}"

# ─── Step 7: Start frontend Vite dev server (devnet mode) ───
echo ""
echo -e "${YELLOW}Starting frontend Vite dev server (devnet mode)...${NC}"
cd "$ROOT_DIR/packages/frontend"
npx vite --mode devnet &
FRONTEND_PID=$!
cd "$ROOT_DIR"

# Wait a moment for Vite to print its URL
sleep 3
echo ""
echo -e "${CYAN}=== All services running ===${NC}"
echo ""
echo -e "  Aztec sandbox:  ${GREEN}http://localhost:8080${NC}"
if [[ -n "$REDIS_URL" ]]; then
  echo -e "  Redis:          ${GREEN}${REDIS_URL}${NC}"
  echo -e "  Backend WS:     ${GREEN}ws://localhost:5174${NC} (Redis-backed)"
else
  echo -e "  Redis:          ${RED}not running${NC}"
  echo -e "  Backend WS:     ${GREEN}ws://localhost:5174${NC} (in-memory)"
fi
echo -e "  Frontend:       ${GREEN}http://localhost:3000${NC}"
echo ""
echo -e "${YELLOW}To play:${NC}"
echo "  1. Open http://localhost:3000 in two browser tabs"
echo "  2. Open Card Packs to hunt for cards (need at least 5)"
echo "  3. Click Play → Select 5 cards → Play!"
echo "  4. Do the same in the second tab — matchmaking pairs you automatically"
echo "  5. Take turns placing cards on the 3×3 board"
echo ""
echo -e "Press ${RED}Ctrl+C${NC} to stop all services."

# Cleanup on exit
cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down...${NC}"
  kill $BACKEND_PID 2>/dev/null && echo "  Backend stopped"
  kill $FRONTEND_PID 2>/dev/null && echo "  Frontend stopped"
  if [[ "${REDIS_STARTED:-}" == "1" ]]; then
    /opt/homebrew/bin/redis-cli -p "$REDIS_PORT" shutdown 2>/dev/null && echo "  Redis stopped"
  fi
  exit 0
}
trap cleanup SIGINT SIGTERM

# Wait for either process to exit
wait
