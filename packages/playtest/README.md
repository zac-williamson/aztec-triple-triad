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

## Run the campaign against testnet

```bash
PLAYTEST_TESTNET=1 PLAYTEST_LOCAL_BACKEND=1 \
PLAYTEST_PXE_URL=https://aztec-testnet.drpc.org \
npx playwright test multi-game.spec.ts --config packages/playtest/playwright.config.ts
```

Each player is a single-use account from the pool in
`.artifacts/playtest-accounts.json`, restored with its starter cards instead of
onboarding. **The pool tops itself up:** when no unused account exists for the
NFT under test, the harness provisions a pair from the L1 treasury
(`~/.aztec-triad-private/treasury-l1-key.txt`, needs Sepolia ETH) through
`scripts/provision-playtest-accounts.ts` — about 4 minutes each, logged to
`.artifacts/provision-*.log`, before the player's browser launches. Entries are
stamped with the chain and the NFT (`src/playtestPool.ts`), so after a redeploy
or re-genesis the next run simply provisions a fresh pair.
`PLAYTEST_LOCAL_BACKEND=1` runs a local relay against the live chain, leaving
the production relay alone.

## Run against the DEPLOYED site

```bash
PLAYTEST_TESTNET=1 \
PLAYTEST_FRONTEND_URL='https://www.aztec-arena.com/?e2e=1' \
PLAYTEST_PXE_URL=https://aztec-testnet.drpc.org \
PLAYTEST_BACKEND_URL=https://ws.aztec-arena.com \
npx playwright test new-user-onboarding --config packages/playtest/playwright.config.ts
```

`PLAYTEST_FRONTEND_URL` drives an already-served frontend instead of the vite dev
server the harness would otherwise boot (it then starts no vite and claims no
port).

**The `?e2e=1` is not optional.** The harness's first act is to wait for
`window.__triadTest`, and a production build has `VITE_TESTKIT` statically
false — the testkit's runtime opt-in (`src/testkit/enabled.ts`) is the only way
in. Without it the run dies after three minutes on a `waitForFunction` timeout
that looks like a broken site and is not one. Without it, a green testnet run proves the contracts, the relay and the
client LOGIC — and says nothing about the bundle users actually load. That gap
has cost real time here before: the OPFS proxy 404'd only when served from the
deployed build, and the `__name` addInitScript trap only appeared under a
production bundle. Point it at production when the question is "does the live
site work", not "is the code right".

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
PLAYTEST_PXE_URL=https://aztec-testnet.drpc.org \
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
the losing half — where the loser finds the winner's settle tx and imports its
own returned cards from it — unexercised. That half is where the second bug
lived. Cover it deliberately:

```bash
E2E_PLAY_TO_LOSE=1 PLAYTEST_TESTNET=1 ...   # same vars, plays to lose
```

## Play as a Nulo player (the real wallet extension)

```bash
# serve the app where the live relay accepts it (localhost:3000)
cd packages/frontend && npx vite --mode testnet --port 3000 --strictPort
# then, in another shell
cd packages/playtest && npx tsx scripts/nulo-play.mts            # connect + a game vs the bot
cd packages/playtest && npx tsx scripts/nulo-play.mts --connect-only
```

Everything is real except the hand on the mouse. `src/nulo.ts` downloads Nulo's
Chrome release (checked against the release's SHASUMS256), creates a Nulo wallet
in `.artifacts/nulo/profile` on first use (password and recovery phrase beside
it, 0600), and answers Nulo's windows as a player would: the emoji grid is
confirmed only if it matches the app's, and transactions pay with the account's
own Fee Juice (`NULO_FEE=public|private`), never Nulo's sponsor. A wallet under
20 FJ is topped up first: bridged from the treasury, then claimed for the
account by the deployer (`scripts/claim-fee-juice.ts`), since only Nulo holds
the account's keys. Point `NULO_DIR` at an empty directory to play as a
brand-new Nulo player. Ends with one `RESULT: pass|fail …` line.

## Architecture

| Piece | File | Role |
|-------|------|------|
| Stack orchestrator | `src/stack.ts`, `global-setup.ts` | Owns sandbox/deploy/backend/frontend lifecycle; per-run logs in `.artifacts/run-*/` |
| Interaction layer | `packages/frontend/src/testkit/` | `window.__triadTest`: live-camera projection to canvas pixels, state snapshots, PXE reads on the app's serial queue |
| Player driver | `src/player.ts` | DOM screens via testids, 3D board via real pointer events, state-predicate waits (no sleeps) |
| Rules mirror | `src/expected.ts` | game-logic replay; board cross-checked on both browsers after every move |
| Chain validator | `src/chain.ts` | Harness-owned node client, independent of both PXEs. A private game has no public status or players, so it reads the game's nullifiers: `game_nullifiers` (the Game contract's utility, run in the harness's own wallet) over the key and records the players stored, then the node's nullifier lookups |
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
