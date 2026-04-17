#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REDIS_PORT=6379
TXE_PORT=8082
CLEANUP_PIDS=()
FAILED=0

cleanup() {
  for pid in "${CLEANUP_PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  # Shut down Redis if we started it
  if [[ "${REDIS_STARTED:-}" == "1" ]]; then
    /opt/homebrew/bin/redis-cli -p "$REDIS_PORT" shutdown 2>/dev/null || true
  fi
}
trap cleanup EXIT

header() {
  echo ""
  echo "═══════════════════════════════════════════════════"
  echo "  $1"
  echo "═══════════════════════════════════════════════════"
}

run_or_fail() {
  if ! "$@"; then
    FAILED=1
    echo "  FAILED: $*"
  fi
}

# ── Redis ────────────────────────────────────────────────
header "Starting Redis"

if /opt/homebrew/bin/redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  echo "  Redis already running on port $REDIS_PORT"
else
  echo "  Starting Redis on port $REDIS_PORT..."
  /opt/homebrew/opt/redis/bin/redis-server --daemonize yes --port "$REDIS_PORT" --loglevel warning
  REDIS_STARTED=1
  sleep 1
  if ! /opt/homebrew/bin/redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    echo "  ERROR: Redis failed to start. Install with: brew install redis"
    echo "  Continuing without Redis tests..."
    export REDIS_URL=""
  else
    echo "  Redis ready"
  fi
fi
export REDIS_URL="redis://localhost:$REDIS_PORT"

# ── TypeScript tests ─────────────────────────────────────
header "Game Logic"
cd "$ROOT/packages/game-logic"
run_or_fail npx vitest run

header "Backend (+ Redis store)"
cd "$ROOT/packages/backend"
run_or_fail npx vitest run

header "Frontend"
cd "$ROOT/packages/frontend"
run_or_fail npx vitest run

header "Integration (proof generation)"
cd "$ROOT/packages/integration"
run_or_fail npx vitest run

# ── Contract tests (TXE) ────────────────────────────────
header "Starting TXE"

TXE_BIN="/Users/zac/.aztec/current/node_modules/.bin/txe"
if [[ ! -x "$TXE_BIN" ]]; then
  echo "  TXE not found at $TXE_BIN -- skipping contract tests"
  echo "  Install Aztec toolchain to enable contract tests"
else
  # Ensure contracts are compiled with AVM transpilation
  if [[ ! -f "$ROOT/packages/contracts/target/arena_token-ArenaToken.json" ]]; then
    echo "  Compiling contracts (aztec compile)..."
    cd "$ROOT/packages/contracts"
    aztec compile
  fi

  # Ensure cross-crate symlinks exist
  cd "$ROOT/packages/contracts/target"
  ln -sf arena_token-ArenaToken.json triple_triad_nft-ArenaToken.json 2>/dev/null || true
  ln -sf arena_token-ArenaToken.json triple_triad_game-ArenaToken.json 2>/dev/null || true
  ln -sf triple_triad_nft-TripleTriadNFT.json triple_triad_game-TripleTriadNFT.json 2>/dev/null || true

  # Kill any existing TXE
  pkill -f "txe" 2>/dev/null || true
  sleep 1

  TXE_PORT=$TXE_PORT "$TXE_BIN" &
  TXE_PID=$!
  CLEANUP_PIDS+=("$TXE_PID")
  sleep 3

  if ! curl -s "http://127.0.0.1:$TXE_PORT" >/dev/null 2>&1; then
    echo "  TXE failed to start -- skipping contract tests"
  else
    echo "  TXE ready on port $TXE_PORT"

    header "ArenaToken contracts"
    cd "$ROOT/packages/contracts/arena_token"
    run_or_fail nargo test --oracle-resolver "http://127.0.0.1:$TXE_PORT"

    # Restart TXE between contract suites (avoids state bleed)
    kill "$TXE_PID" 2>/dev/null || true
    sleep 2
    TXE_PORT=$TXE_PORT "$TXE_BIN" &
    TXE_PID=$!
    CLEANUP_PIDS+=("$TXE_PID")
    sleep 3

    header "TripleTriadNFT contracts"
    cd "$ROOT/packages/contracts/triple_triad_nft"
    run_or_fail nargo test --oracle-resolver "http://127.0.0.1:$TXE_PORT"

    kill "$TXE_PID" 2>/dev/null || true
    sleep 2
    TXE_PORT=$TXE_PORT "$TXE_BIN" &
    TXE_PID=$!
    CLEANUP_PIDS+=("$TXE_PID")
    sleep 3

    header "TripleTriadGame contracts"
    cd "$ROOT/packages/contracts/triple_triad_game"
    run_or_fail nargo test --oracle-resolver "http://127.0.0.1:$TXE_PORT"
  fi
fi

# ── Summary ──────────────────────────────────────────────
header "Summary"
if [[ "$FAILED" -eq 0 ]]; then
  echo "  All tests passed."
else
  echo "  Some tests FAILED. See output above."
  exit 1
fi
