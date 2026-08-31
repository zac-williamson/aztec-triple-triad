#!/usr/bin/env bash
# Play a real game on the deployed app and say whether it worked.
#
# One green run is an anecdote. Almost everything found in this codebase came
# from repetition — a queue that only floods under load, a handshake that only
# stalls when a sweep is mid-pass — so this exists to be run repeatedly and to
# fail loudly, not to be run once and remembered fondly.
#
#   ./scripts/prod-smoke.sh              # one game
#   RUNS=3 ./scripts/prod-smoke.sh       # three, sequentially
#
# It CANNOT run on the relay box: it needs the treasury key (which is
# deliberately not there) and it runs a browser and client-side proving, which
# would compete with the bot for two cores. Run it where the treasury key is.
#
# Each run funds a throwaway Sepolia account with 0.02 ETH and refunds the
# remainder, so the standing cost is gas only — a few thousandths of an ETH.
set -uo pipefail

cd "$(dirname "$0")/.."
RUNS="${RUNS:-1}"
OUT="${PROD_SMOKE_DIR:-.artifacts/prod-smoke}"
mkdir -p "$OUT"

pass=0
fail=0
for i in $(seq 1 "$RUNS"); do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  log="$OUT/$stamp.log"
  echo "── run $i/$RUNS → $log"

  if PROOF_THREADS="${PROOF_THREADS:-6}" SHOT_DIR="$OUT" \
     npx tsx packages/playtest/scripts/prod-play.mts >"$log" 2>&1; then
    # Exit zero is necessary but not sufficient, so prod-play prints one
    # fixed-shape verdict line and this reads that. It used to grep for
    # settlement wording instead, matched none of the three settlement paths'
    # actual prose, and reported a good game — bot won, cards handed back,
    # reward paid — as a failure.
    if grep -q "^RESULT: pass" "$log"; then
      echo "   PASS  $(grep -oE '^RESULT: .*' "$log" | tail -1)"
      pass=$((pass + 1))
    else
      echo "   FAIL  $(grep -oE '^RESULT: .*' "$log" | tail -1 || echo 'no verdict line — see the log')"
      echo "         see $log"
      fail=$((fail + 1))
    fi
  else
    echo "   FAIL  $(grep -oE 'FAILED: .*|EXPECTED .*' "$log" | tail -1)"
    echo "         see $log"
    fail=$((fail + 1))
  fi
done

echo
echo "prod-smoke: $pass passed, $fail failed of $RUNS"
# A history worth grepping when someone asks "when did this last work".
printf '%s  pass=%d fail=%d\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$pass" "$fail" >> "$OUT/history.txt"
[ "$fail" -eq 0 ]
