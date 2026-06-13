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

# ── Noir toolchain (pinned via .aztecrc) ────────────────
# The bare `aztec`/`nargo` on PATH can silently resolve to a different
# installed version (.aztecrc is only honored in $PWD; bare nargo lives in
# internal-bin, off PATH — docs/plan/LANE_1_CHAIN.md ASSUMPTIONS #3/#4).
# Always use the versioned binaries for the pinned toolchain.
AZTEC_VERSION="$(grep -v '^#' "$ROOT/.aztecrc" | tr -d '[:space:]')"
AZTEC_BIN="$HOME/.aztec/versions/$AZTEC_VERSION/bin"

if [[ ! -x "$AZTEC_BIN/aztec" ]]; then
  echo "ERROR: Aztec toolchain $AZTEC_VERSION not found at $AZTEC_BIN"
  echo "Install it with: VERSION=$AZTEC_VERSION bash <(curl -fsSL https://install.aztec.network)"
  exit 1
fi

TXE_LAUNCH_COUNT=0
start_txe() {
  TXE_LAUNCH_COUNT=$((TXE_LAUNCH_COUNT + 1))
  local logfile="/tmp/txe-$$-$TXE_LAUNCH_COUNT.log"
  "$AZTEC_BIN/aztec" start --txe --port "$TXE_PORT" > "$logfile" 2>&1 &
  TXE_PID=$!
  CLEANUP_PIDS+=("$TXE_PID")
  # Ready = process still alive AND the port actually accepts a connection.
  # Don't trust the "listening" log line alone — verify reachability, and bail
  # immediately (with the log) if the process dies, rather than waiting 60s.
  for _ in $(seq 1 60); do
    if ! kill -0 "$TXE_PID" 2>/dev/null; then
      echo "ERROR: TXE process exited during startup on port $TXE_PORT:"
      cat "$logfile"
      exit 1
    fi
    if grep -q "listening on port $TXE_PORT" "$logfile" \
       && curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$TXE_PORT"; then
      return 0
    fi
    sleep 1
  done
  echo "ERROR: TXE did not become ready on port $TXE_PORT within 60s:"
  cat "$logfile"
  exit 1
}

stop_txe() {
  kill "$TXE_PID" 2>/dev/null || true
  wait "$TXE_PID" 2>/dev/null || true
}

header "Circuit tests"
cd "$ROOT/circuits"
run_or_fail "$AZTEC_BIN/aztec-nargo" test

# ── Contract tests (TXE) ────────────────────────────────
# Ensure contracts are compiled with AVM transpilation
if [[ ! -f "$ROOT/packages/contracts/target/arena_token-ArenaToken.json" ]]; then
  echo "  Compiling contracts (aztec compile)..."
  cd "$ROOT/packages/contracts"
  "$AZTEC_BIN/aztec" compile
fi

# Each contract package gets a fresh TXE — suites assume clean TXE state.
# --test-threads 1: parallel test functions race TXE's per-test LMDB store
# setup (mdb_txn_begin EINVAL under load) — same serial-execution constraint
# as PXE (ground rule #6). Diagnosis in LANE_6_ASSETS_INFRA.md ASSUMPTIONS.
header "ArenaToken contracts"
start_txe
cd "$ROOT/packages/contracts/arena_token"
run_or_fail "$AZTEC_BIN/aztec-nargo" test --test-threads 1 --oracle-resolver "http://127.0.0.1:$TXE_PORT"
stop_txe

header "TripleTriadNFT contracts"
start_txe
cd "$ROOT/packages/contracts/triple_triad_nft"
run_or_fail "$AZTEC_BIN/aztec-nargo" test --test-threads 1 --oracle-resolver "http://127.0.0.1:$TXE_PORT"
stop_txe

header "TripleTriadGame contracts"
start_txe
cd "$ROOT/packages/contracts/triple_triad_game"
run_or_fail "$AZTEC_BIN/aztec-nargo" test --test-threads 1 --oracle-resolver "http://127.0.0.1:$TXE_PORT"
stop_txe

# ── Summary ──────────────────────────────────────────────
header "Summary"
if [[ "$FAILED" -eq 0 ]]; then
  echo "  All tests passed."
else
  echo "  Some tests FAILED. See output above."
  exit 1
fi
