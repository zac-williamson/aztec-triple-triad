# @axolotl-arena/playtest

Autonomous end-to-end playtest harness (lane 8). Two real browser contexts
click through real games on the local Aztec sandbox; the harness validates
frontend, backend, and chain state after every meaningful transition.
Design doc: `docs/plan/PLAYTEST_HARNESS.md`.

## Run the Phase 1 campaign

```bash
# one-shot (boots sandbox → deploys → backend → frontend, runs, tears down)
cd packages/playtest
npx playwright test

# inner dev loop (keep the stack up between runs)
npx tsx scripts/boot-stack.ts
PLAYTEST_REUSE_STACK=1 npx playwright test
npx tsx scripts/stop-stack.ts
```

Prerequisites: `aztec` CLI at the pinned 4.2 version, contracts/circuits
compiled (`packages/contracts/target`, `circuits/target`), root
`npm install --legacy-peer-deps` done, `npx playwright install chromium`.

Reuse-mode caveat: campaign determinism (starter cards, fresh token balances,
fresh backend rooms) only holds on the FIRST run against a stack. Re-running a
campaign against a used stack fails its baseline assertions by design — boot a
fresh stack for acceptance runs.

## Architecture

| Piece | File | Role |
|-------|------|------|
| Stack orchestrator | `src/stack.ts`, `global-setup.ts` | Owns sandbox/deploy/backend/frontend lifecycle; per-run logs in `.artifacts/run-*/` |
| Interaction layer | `packages/frontend/src/testkit/` | `window.__triadTest`: live-camera projection to canvas pixels, state snapshots, PXE reads on the app's serial queue |
| Player driver | `src/player.ts` | DOM screens via testids, 3D board via real pointer events, state-predicate waits (no sleeps) |
| Rules mirror | `src/expected.ts` | game-logic replay; board cross-checked on both browsers after every move |
| Chain validator | `src/chain.ts` | Harness-owned node client; public game status/players, independent of both PXEs |
| Campaign | `tests/full-game.spec.ts` | Phase 1: one full click-driven game + three-layer settlement assertions |

On failure Playwright keeps trace/video/screenshots in `.artifacts/test-output`,
and each run directory holds sandbox/deploy/backend/frontend logs plus per-player
browser console logs — everything the triage loop needs.

## Stack ownership

`stack.json` (per-run) and `standalone-stack.json` (boot-stack.ts) record who
booted what. `globalTeardown` only kills stacks with mode `run`; `stop-stack.ts`
only kills `standalone` ones. Detached children write straight to their log
files — never pipe a detached child through the parent (EPIPE kills it when
the parent exits).
