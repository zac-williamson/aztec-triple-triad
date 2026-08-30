#!/usr/bin/env bash
# Arena health check. Exits non-zero with a one-line reason, so it works as a
# cron job piped to mail, a systemd OnFailure, or an uptime probe's command.
#
#   ./check-arena-health.sh                 # defaults below
#   BOT_HEALTH_URL=... RELAY_URL=... ./check-arena-health.sh
#
# Two signals matter and neither pages on its own today:
#
#   healthy=false      the bot hit a commit/proof/settle failure it did not
#                      recover from.
#   spendable < floor  the bot is running out of cards. This is the one that
#                      hurts, because an out-of-cards bot goes IDLE — correct
#                      behaviour, indistinguishable from a quiet night, and
#                      silent until someone notices the arena has no opponent.
set -uo pipefail

BOT_HEALTH_URL="${BOT_HEALTH_URL:-http://localhost:5175/health}"
RELAY_URL="${RELAY_URL:-http://localhost:5174/metrics}"
CARD_FLOOR="${CARD_FLOOR:-25}"
STRANDED_CEILING="${STRANDED_CEILING:-25}"
# Fee Juice, in whole units. The bot pays its own fees for every commit and
# settlement; empty is worse than idle, because it still plays full games it
# then cannot settle, locking five cards each time.
FEE_JUICE_FLOOR="${FEE_JUICE_FLOOR:-50}"
# Cards the bot owns on-chain but cannot see. Any at all is a permanent loss.
UNIMPORTED_CEILING="${UNIMPORTED_CEILING:-0}"

fail() { echo "CRITICAL: $*"; exit 2; }
warn() { echo "WARNING: $*"; exit 1; }

relay=$(curl -fsS -m 10 "$RELAY_URL" 2>/dev/null) \
  || fail "relay is not answering $RELAY_URL — nobody can play at all"

bot=$(curl -fsS -m 10 "$BOT_HEALTH_URL" 2>/dev/null) \
  || fail "bot is not answering $BOT_HEALTH_URL — players will find no opponent"

read -r healthy stranded spendable feejuice unimported last_error <<<"$(printf '%s' "$bot" | node -e '
  let raw = ""; process.stdin.on("data", d => raw += d).on("end", () => {
    const h = JSON.parse(raw);
    // spendableCards is absent on an off-chain bot; -1 means "not applicable".
    // Fee Juice exceeds the safe integer range, so it stays a string here and
    // is compared in whole units below. (No apostrophes in this block: it is
    // inside a single-quoted shell argument.)
    const fj = h.feeJuice === undefined ? -1n : BigInt(h.feeJuice);
    process.stdout.write([
      h.healthy, h.cardsStranded ?? 0, h.spendableCards ?? -1,
      fj < 0n ? -1 : fj / (10n ** 18n),
      h.cardsUnimported ?? 0,
      (h.lastError ?? "none").replace(/\s+/g, " ").slice(0, 120),
    ].join(" "));
  });
')" || fail "bot /health returned something that is not JSON"

[ "$healthy" = "true" ] || fail "bot reports unhealthy — lastError: $last_error"

if [ "$spendable" != "-1" ] && [ "$spendable" -lt "$CARD_FLOOR" ]; then
  # Not merely a warning at zero: by the time it IS zero the arena has already
  # been running without an opponent.
  fail "bot has $spendable spendable cards (floor $CARD_FLOOR) — top it up before it goes idle"
fi

if [ "$feejuice" != "-1" ] && [ "$feejuice" -lt "$FEE_JUICE_FLOOR" ]; then
  # Not a warning: a bot that cannot pay cannot settle, and an unsettled game
  # locks five of its cards and strands the player it was playing.
  fail "bot has ${feejuice} Fee Juice (floor $FEE_JUICE_FLOOR) — bridge more before it cannot settle"
fi

if [ "$unimported" -gt "$UNIMPORTED_CEILING" ]; then
  fail "$unimported card(s) owned on-chain but missing from the bot's wallet — note imports are failing"
fi

if [ "$stranded" -gt "$STRANDED_CEILING" ]; then
  warn "$stranded cards stranded in unsettled games — check the abandonment sweep is running"
fi

echo "OK: relay up, bot healthy, $spendable spendable, ${feejuice} FJ, $stranded stranded"
