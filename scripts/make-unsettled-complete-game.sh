#!/usr/bin/env bash
# Produce the one state the abandonment path could never be tested against: a
# COMPLETE game that nobody settles.
#
# It is genuinely hard to reach by hand. A draw is always settled — player 1
# does it, and the bot settles it as fallback if they do not. A win is settled
# by the winner within about a minute.
#
# Four earlier attempts tried to RACE that: run a normal game and kill the
# harness the instant the bot reported nine move proofs. Every one lost. Three
# cut at seven or eight proofs (an INCOMPLETE transcript — a different contract
# branch that looks identical in the log) and the fourth was beaten to the
# punch by the winner's own settlement. Polling something every five seconds
# over SSH cannot win a race against a decision made in-process.
#
# So the harness now decides not to settle: STOP_BEFORE_SETTLE=1 makes it wait
# until the bot confirms it holds all nine move proofs, then walk away. This
# script only has to run it and read the verdict.
#
# A run is only useful if WE win — the bot settles anything else. That is a
# coin flip, so retry a few times.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT="${OUT_DIR:-.artifacts/unsettled}"
ATTEMPTS="${ATTEMPTS:-4}"
mkdir -p "$OUT"

for attempt in $(seq 1 "$ATTEMPTS"); do
  LOG="$OUT/run-$(date -u +%Y%m%dT%H%M%SZ).log"
  echo "── attempt $attempt/$ATTEMPTS → $LOG"

  STOP_BEFORE_SETTLE=1 SHOT_DIR="$OUT/shots" PROOF_THREADS="${PROOF_THREADS:-6}" \
    npx tsx packages/playtest/scripts/prod-play.mts > "$LOG" 2>&1
  code=$?

  verdict="$(grep '^RESULT:' "$LOG" | tail -1)"
  echo "   $verdict"

  case "$verdict" in
    RESULT:\ cut*)
      echo
      echo "COMPLETE UNSETTLED GAME CREATED."
      grep -E "game over|STOP_BEFORE_SETTLE" "$LOG" | tail -3
      echo
      echo "The bot's sweep will claim it with n=9 once it passes MIN_ABANDON_SECONDS"
      echo "(3600s). Watch it at https://ws.aztec-arena.com/arena-health — it appears"
      echo "under journal[] with the countdown in blockedBy."
      exit 0
      ;;
    *cut=skipped:*)
      # The game still settled — the harness only declines to settle when it
      # can actually produce the state we want. Nothing is left holding cards.
      echo "   not usable — retrying"
      ;;
    *)
      echo "   run failed (exit $code) — see $LOG"
      tail -5 "$LOG"
      ;;
  esac
done

echo "no attempt produced a win we could walk away from; run again"
exit 1
