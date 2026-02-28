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

echo -e "${CYAN}=== Aztec Triple Triad — Dev Startup ===${NC}"
echo ""

# ─── Step 0: Check Aztec sandbox ───
echo -e "${YELLOW}Checking Aztec sandbox...${NC}"
if curl -s http://localhost:8080/api/getNodeInfo > /dev/null 2>&1; then
  echo -e "${GREEN}  ✓ Aztec sandbox is running at http://localhost:8080${NC}"
else
  echo -e "${RED}  ✗ Aztec sandbox is NOT running.${NC}"
  echo ""
  echo "  Start it in a separate terminal first:"
  echo ""
  echo "    aztec start --local-network"
  echo ""
  echo "  Wait until you see 'Aztec Node started' then re-run this script."
  exit 1
fi

# ─── Step 1: Copy circuit + contract artifacts to frontend ───
echo ""
echo -e "${YELLOW}Copying artifacts to frontend/public...${NC}"
npm run copy-circuits 2>/dev/null && echo -e "${GREEN}  ✓ Circuits copied${NC}"
npm run copy-contracts 2>/dev/null && echo -e "${GREEN}  ✓ Contracts copied${NC}"

# ─── Step 2: Deploy contracts (if needed) ───
echo ""
if [ -f packages/frontend/.env ] && grep -q "VITE_GAME_CONTRACT_ADDRESS" packages/frontend/.env; then
  echo -e "${YELLOW}Existing .env found with contract addresses:${NC}"
  grep "VITE_NFT_CONTRACT_ADDRESS\|VITE_GAME_CONTRACT_ADDRESS" packages/frontend/.env | sed 's/^/  /'
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

# ─── Step 3: Start backend WebSocket server ───
echo ""
echo -e "${YELLOW}Starting backend WebSocket server...${NC}"
cd "$ROOT_DIR/packages/backend"
npx tsx src/server.ts &
BACKEND_PID=$!
cd "$ROOT_DIR"
echo -e "${GREEN}  ✓ Backend started (PID: $BACKEND_PID) on ws://localhost:5174${NC}"

# ─── Step 4: Start frontend Vite dev server ───
echo ""
echo -e "${YELLOW}Starting frontend Vite dev server...${NC}"
cd "$ROOT_DIR/packages/frontend"
npx vite &
FRONTEND_PID=$!
cd "$ROOT_DIR"

# Wait a moment for Vite to print its URL
sleep 3
echo ""
echo -e "${CYAN}=== All services running ===${NC}"
echo ""
echo -e "  Aztec sandbox:  ${GREEN}http://localhost:8080${NC}"
echo -e "  Backend WS:     ${GREEN}ws://localhost:5174${NC}"
echo -e "  Frontend:       ${GREEN}http://localhost:5173${NC}  (check Vite output above for actual port)"
echo ""
echo -e "${YELLOW}To play:${NC}"
echo "  1. Open http://localhost:5173 in two browser tabs"
echo "  2. Tab 1: Select 5 cards → Create Game"
echo "  3. Tab 2: Select 5 cards → Enter Game ID → Join Game"
echo "  4. Play! Take turns placing cards on the 3×3 board"
echo ""
echo -e "Press ${RED}Ctrl+C${NC} to stop all services."

# Cleanup on exit
cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down...${NC}"
  kill $BACKEND_PID 2>/dev/null && echo "  Backend stopped"
  kill $FRONTEND_PID 2>/dev/null && echo "  Frontend stopped"
  exit 0
}
trap cleanup SIGINT SIGTERM

# Wait for either process to exit
wait
