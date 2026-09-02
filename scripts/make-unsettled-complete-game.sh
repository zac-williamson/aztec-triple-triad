#!/usr/bin/env bash
# Produce the one state the abandonment path could never be tested against: a
# COMPLETE game that nobody settles.
#
# It is genuinely hard to reach by hand. A draw is always settled — player 1
# does it, and the bot settles it as fallback if they do not. A win is settled
# by the winner within about a minute. So the only route is to let the winner
# finish the game, wait for its last move proof to reach the opponent, and cut
# it off before the settlement transaction is built.
#
# Three earlier attempts missed that window, each leaving 7 or 8 proofs instead
# of 9, because they triggered off the harness's own log. This triggers off the
# BOT's live state instead — moveProofs == 9 is the exact moment — which is why
# the bot had to be made observable first.
set -uo pipefail
cd "$(dirname "$0")/.."

BOX="${ARENA_BOX:-ubuntu@13.42.161.225}"
KEY="${ARENA_KEY:-$HOME/.ssh/aztec_deploy}"
OUT="${OUT_DIR:-.artifacts/unsettled}"
mkdir -p "$OUT"
LOG="$OUT/run-$(date -u +%Y%m%dT%H%M%SZ).log"

bot_field() {  # $1 = python expression over the health dict `d`
  ssh -i "$KEY" -o ConnectTimeout=10 -o BatchMode=yes "$BOX" \
    'curl -s --max-time 8 http://127.0.0.1:5175/health' 2>/dev/null \
  | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
try: d = json.loads(raw)
except Exception: print(''); sys.exit(0)
try: print($1)
except Exception: print('')
"
}

echo "── starting a game → $LOG"
SHOT_DIR="$OUT/shots" PROOF_THREADS="${PROOF_THREADS:-6}" \
  nohup npx tsx packages/playtest/scripts/prod-play.mts > "$LOG" 2>&1 &
sleep 5

for _ in $(seq 1 360); do
  pgrep -f prod-play.mts >/dev/null || { echo "the run ended on its own — see $LOG"; exit 1; }

  proofs="$(bot_field "d.get('game',{}).get('moveProofs') if d.get('game') else ''")"
  if [ "$proofs" = "9" ]; then
    # Every proof is in. The winner has not built its settlement yet, so cutting
    # here leaves a complete transcript that nobody has settled.
    pkill -f prod-play.mts
    echo "CUT at 9/9 proofs — the game is complete and unsettled"
    grep -E "game over|claiming" "$LOG" | tail -2
    exit 0
  fi
  if grep -q "^RESULT:" "$LOG" 2>/dev/null; then
    # A draw, or a win settled faster than we could cut it. Both are fine
    # outcomes for the arena and useless for this test.
    echo "settled before the cut: $(grep '^RESULT:' "$LOG" | tail -1)"
    exit 2
  fi
  sleep 5
done
echo "timed out waiting for a complete game"; exit 1
