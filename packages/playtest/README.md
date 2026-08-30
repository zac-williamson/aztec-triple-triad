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

Prerequisites: `aztec` CLI at the pinned version (see CLAUDE.md), contracts/circuits
compiled (`packages/contracts/target`, `circuits/target`), root
`npm install --legacy-peer-deps` done, `npx playwright install chromium`.

Reuse-mode caveat: campaign determinism (starter cards, fresh token balances,
fresh backend rooms) only holds on the FIRST run against a stack. Re-running a
campaign against a used stack fails its baseline assertions by design — boot a
fresh stack for acceptance runs.

## Run the new-player onboarding acceptance test

Proves the claim the rest of the harness deliberately skips: that somebody
holding **only an Ethereum account with testnet ETH** can reach a settled game.
Every other spec seeds a pre-provisioned, already-funded account from the pool
(`seed`), which is the fastest way to test gameplay and the surest way never to
test onboarding.

```bash
PLAYTEST_TESTNET=1 \
PLAYTEST_PXE_URL=https://v5.testnet.rpc.aztec-labs.com \
PLAYTEST_BACKEND_URL=https://ws.aztec-arena.com \
npx playwright test new-user-onboarding --config packages/playtest/playwright.config.ts
```

It generates a throwaway Sepolia key, funds it from the treasury
(`~/.aztec-triad-private/treasury-l1-key.txt`), installs it as `window.ethereum`
via `src/walletShim.ts`, and then touches nothing else: the browser buys the fee
asset, bridges it, deploys its Aztec account claiming the bridged Fee Juice,
mints starter cards, queues on the **live** relay, plays the deployed bot, and
settles. Leftover ETH goes back to the treasury at the end.

Only the wallet UI is simulated — the key, chain, contracts and money are real,
which is the point. This is what caught the `DepositToAztecPublic` ABI bug that
every mocked unit test agreed was fine.

Settlement has two halves and the default strategy usually wins, which leaves
the losing half — where the winner has to hand back the loser's returned cards
— unexercised. That is where the second bug lived. Cover it deliberately:

```bash
E2E_PLAY_TO_LOSE=1 PLAYTEST_TESTNET=1 ...   # same vars, plays to lose
```

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
