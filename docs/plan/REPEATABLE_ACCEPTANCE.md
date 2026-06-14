# Repeatable acceptance — remaining work (orchestrator, 06-14)

## VERIFIED (done)
- **C-multi GREEN**: `run-2026-06-14T09-05-06` passed 5 consecutive games, NO carryover
  (93 tx-blocks, 19 ClientIVC proofs, clean teardown, per-game economy consistent). Primary
  goal met + independently verified.
- **lane-2 keepalive (`309a9e9`)** fixed the onboarding connection-RESET (`resets=0` post-merge).

## NOT clean yet — the 2× acceptance both failed. Three things to fix (NO mask):
1. **HARNESS cleanup gap (real — fix first).** Your isolated-Chromium-*process* change (one browser
   process per player) is NOT killed by the port-based teardown → Chromium processes leak across
   runs. Fix `global-teardown` (+ `stop-stack`) to kill the browser PROCESSES by pid/process-group,
   not just ports. (It is NOT memory pressure: verified 82% free, only ~4 lingering — the earlier
   "32 processes" miscounted the user's Google Chrome + Steam.)
2. **Onboarding residual stall** (run #1): alice's onboarding timed out at 420s with **NO connection
   reset** — the keepalive fixed the *reset*; this is a DIFFERENT stall. Root-cause what stalled
   alice's onboarding (a different proving/connection stall? the run was on a polluted machine —
   re-test on a clean one first).
3. **Game-5 settlement hang** (run #2): onboarded clean, ran **4 consecutive games (all settle OK**,
   per `multigame-accept-2.log`), then game 5 went `awaiting_settlement → idle`, PHASE TIMEOUT 1500s,
   **no reset**. Intermittent (GREEN did 5/5). Root-cause the late-game settlement hang — proving
   stall, or a real game-5 state issue? (the fail-fast guard caught it, good — not a zombie.)

## DO
Rebase onto testnet → fix the cleanup gap (#1) → re-run C-multi **2× on a clean machine** for
repeatable acceptance. Root-cause #2 and #3 from the artifacts — no retries/fallbacks around the
hangs, root-cause them. STATUS with the real root causes + the re-run pass-rate.

(Context note: you stalled ~11h on a transient API error at 543k tokens; restarted fresh. Your
committed work — GREEN verification, GPU-isolation, watchdog, carryover hypothesis — is safe on the
branch.)
