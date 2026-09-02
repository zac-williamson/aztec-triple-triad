#!/usr/bin/env bash
# What the arena is doing, right now, on one screen.
#
# Written because I did not have this. Diagnosing a live game meant grepping
# the journal and the systemd log after the fact and inferring the state, and
# that inference was wrong as often as right: seven move proofs read as nine, a
# sweep assumed to have run that had not, a game believed committed that never
# was. Several production runs were spent on guesses this would have answered.
#
#   ./scripts/watch-arena.sh            # refresh every 5s until interrupted
#   ./scripts/watch-arena.sh 15         # every 15s
#   ONCE=1 ./scripts/watch-arena.sh     # a single snapshot
set -uo pipefail

BOX="${ARENA_BOX:-ubuntu@13.42.161.225}"
KEY="${ARENA_KEY:-$HOME/.ssh/aztec_deploy}"
EVERY="${1:-5}"

snapshot() {
  ssh -i "$KEY" -o ConnectTimeout=10 -o BatchMode=yes "$BOX" \
    'curl -s --max-time 8 http://127.0.0.1:5175/health' 2>/dev/null
}

render() {
  python3 - "$@" <<'PY'
import sys, json, datetime

raw = sys.stdin.read().strip()
now = datetime.datetime.now().strftime('%H:%M:%S')
if not raw:
    print(f"[{now}]  BOT UNREACHABLE — it is down, or still importing notes at startup")
    sys.exit(0)
try:
    d = json.loads(raw)
except Exception:
    print(f"[{now}]  unparseable health: {raw[:120]}")
    sys.exit(0)

flag = 'OK ' if d.get('healthy') else 'BAD'
print(f"[{now}] {flag} {d.get('state','?'):<8} cards={d.get('spendableCards')} "
      f"stranded={d.get('cardsStranded')} failures={d.get('totalFailures')} "
      f"fj={str(d.get('feeJuice','?'))[:4]}…")

g = d.get('game')
if g:
    # The two that decide whether walking away costs cards, first.
    stake = 'CARDS AT STAKE' if g.get('committed') else 'nothing committed'
    turn = 'OUR TURN' if g.get('oweAMove') else 'their turn'
    gone = g.get('opponentGoneFor')
    away = f"opponent gone {gone}s" if gone is not None else 'opponent present'
    print(f"          game {str(g.get('relayGameId'))[:12]}  p{g.get('playerNumber')}  "
          f"{stake}  {turn}  {away}")
    print(f"          proofs={g.get('moveProofs')}/9  hands="
          f"{'me' if g.get('myHandProof') else '--'}/"
          f"{'them' if g.get('opponentHandProof') else '----'}  "
          f"age={g.get('ageSeconds')}s{'  SETTLING' if g.get('settling') else ''}")
else:
    print("          no game in progress")

for e in d.get('journal', []):
    why = e.get('blockedBy') or 'READY TO CLAIM'
    print(f"          held {e['onChainGameId'][:12]}  proofs={e['moveProofs']}/9  "
          f"age={e['ageSeconds'] // 60}min  {why}")

if d.get('lastError'):
    print(f"          last error: {str(d['lastError'])[:110]}")
PY
}

if [ "${ONCE:-0}" = "1" ]; then
  snapshot | render
  exit 0
fi

echo "watching ${BOX} — ctrl-c to stop"
while true; do
  snapshot | render
  sleep "$EVERY"
done
