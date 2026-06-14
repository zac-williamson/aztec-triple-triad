# Repeatable acceptance — STATUS (orchestrator, 06-14)

## OUTCOME
Repeatable acceptance achieved on a clean machine after fixing the harness
cleanup gap and one latent harness false-negative. **Both clean fixed-code runs
GREEN — 5/5 games each, real proofs, no carryover, backend healthy through the
game-5 settlement.** The two original "intermittent hangs" did NOT recur; they
were one root cause (backend death), enabled by the cleanup gap.

## ROOT CAUSES (from the artifacts — NOT what the prior notes assumed)

**The two "hangs" are ONE root cause: the backend WS relay PROCESS died
mid-proof.** Silent (no JS crash, no `.ips`); confirmed dead because teardown
logged no "backend stopped" in either run, and every browser reconnect got
`ERR_CONNECTION_REFUSED`. It surfaced at two different layers, which is why it
looked like two bugs:
- **Run #1 (onboarding 420s):** alice's Aztec onboarding *succeeded* (wallet
  deployed, 5 cards imported, `aztecStatus=connected`) — only `ws.connected`
  stayed false because the backend was gone. NOT a proving stall; NOT the
  keepalive reset (the keepalive fixed a *different* symptom).
- **Run #2 (game-5 1500s):** 4 games clean; game 5 played all 9 moves and the
  winner settled **on-chain** (`txHash` logged) — but with the backend dead she
  could not relay the won-card note, so the loser's `opponentSettled` never set.
  NOT a game-5 state/carryover bug; NOT proof-chain reuse.

**Why the backend died — the cleanup gap, not "memory is fine".** The plan's
"82% free, not memory pressure" was a steady-state reading. Live `[mem@…]`
logging shows the runs execute at ~0.1 GiB free / swap ~93% full / compressor
thrashing. The campaign launches one **detached** Chromium per player (own
process group) for GPU isolation; Playwright only kills those on a graceful
worker exit, so a SIGKILLed worker **orphaned** them and they leaked across the
day's runs. That accumulated ~400 MB×N of orphaned browsers contending for
RAM/GPU/CPU — enough to (a) starve the prover (run #1's account-deploy proof took
**198s** vs **~18s** on a clean stack) and (b) sustain the memory-pressure window
during the heavy settlement proof until the OS killed the backend. Removing the
leak removes the enabler: on a clean stack the proof window is brief and the
backend survives.

## FIXES (committed on lane/8-playtest)
1. **Reap leaked per-player Chromium** (`247fdd2`). Record each browser's
   group-leader pid (diffed from the OS — `@playwright/test`'s Browser exposes
   none) and reap survivors by process group in globalSetup/globalTeardown/
   stop-stack, guarded by a command check against pid recycling. Proven by
   `scripts/probe-browser-cleanup.ts` (`b75d2f7`) and by zero leaked Chromium
   after the re-runs.
2. **Fail-fast backend-liveness + memory logging** (`247fdd2`). A `/health`
   signal raced inside `withDeadline` across onboarding/packs/every game, so a
   recurrence fails in ~15s, timestamped, instead of as a far-away phase
   timeout. Diagnosis, not a mask — no retries, no fallbacks.
3. **Loser-multiset false-negative** (`22d761b`). `loserExpect.set(claimed, 0)`
   left a `[claimed,0]` entry the actual multiset never has, so a game the
   product settled correctly failed `expectEventually` after 180s. Surfaced when
   the random pack draw left the loser a single copy of the claimed id — which
   both clean runs #1/#2 hit in game 1 (the GREEN run got lucky duplicates).
   Drop the entry at the last copy.

## RE-RUN PASS RATE (clean machine)
- Run 1 (pre-fix): FAIL — loser-multiset false-negative, game 1. (No backend
  death; original hangs did not recur.)
- Run 2 (pre-fix): FAIL — same false-negative, game 1.
- **Run 3 (fixed `22d761b`): GREEN — 5/5 games, 19 real ClientIVC proofs, 0
  ERR_CONNECTION_REFUSED, game-5 settle relay completed.**
- **Run 4 (fixed): GREEN — 5/5 games, 19 real proofs, 0 ERR_CONNECTION_REFUSED,
  20 settle relays. Free RAM hit 0.09 GiB at game 5 (load 16.9) — same pressure
  as the dead runs — and the backend survived.**

**Pass rate: 2/2 on the fixed code (5/5 games each).** Both clean re-runs reached
and passed the game-5 settlement that hung run #2 — the backend stayed healthy
throughout. Dispositive: clean stack ⇒ GREEN 2/2; polluted stack ⇒ backend dead
2/2. No masking, no retries around any hang; every failure was root-caused.
