# Playtest Harness (H+) — Design

Lane 8 · Worktree `worktrees/playtest` · Branch `lane/8-playtest`
New code lives in `packages/playtest/` plus `packages/frontend/src/testkit/` (additive).

## Mission

Fully autonomous end-to-end playtesting: two real browsers click through real games,
and the harness validates **frontend + backend + blockchain** state after every
meaningful transition. Target campaign (from Zac, verbatim intent): *"two players play
a game, winner takes a loser card, validate winner/loser card state is correct,
continue 4 times, open a pack of cards, play more games."* Replaces the ~20-minute
manual two-browser test loop.

## Why naive automation failed before (the four obstacles)

1. **WebGL play surface** — board cells/hand cards are raycast three.js meshes
   (`BoardCell3D.tsx:47`, `PlayerHand3D.tsx:277`); no DOM inside the canvas.
2. **Private state is per-tab** — each tab's EmbeddedWallet/PXE holds the card notes
   in its own IndexedDB. No external script can see whether the loser's card arrived.
3. **Proof latency** — 9 move proofs × 10–30s + settlement makes a game minutes long;
   sleep-based waits flake, default timeouts give up.
4. **Outcome nondeterminism** — "winner takes a card" must be validated without
   pre-knowing the winner, across three layers updating at different times.

## Architecture (five pieces)

### 1. Stack orchestrator (Playwright globalSetup)
Boots sandbox (`start-sandbox.sh`), deploys via `scripts/deploy-contracts.ts`
(fresh deploy per campaign → deterministic starter state: both players hold cards
1–5), flushes Redis, starts backend + frontend dev server. Tears down or resets
between campaigns.

### 2. Interaction layer — real clicks on the 3D board
`frontend/src/testkit/` (gated by `import.meta.env.VITE_TESTKIT`, never in prod
builds) exposes `window.__triadTest`:
- `getScreenXY(target)` — projects a cell/hand-card's world position through the live
  camera (`Vector3.project`) to viewport coords. Playwright then issues a **real
  pointer event on the canvas** at that point → flows through R3F's actual raycaster
  into the actual `onClick`. Same code path as a human; coordinates computed, not
  hardcoded.
- `placeCard(handIdx, row, col)` — direct-dispatch escape hatch ("fast interaction"
  mode). Click mode is the default so the pointer pipeline stays covered.
- Read hooks for assertions: `getPrivateCards()`, `getTokenBalance()`,
  `getGamePhase()`, etc. — these call the app's own wallet utilities
  (`get_nfts_for_user`, `get_balance`) against THAT TAB's PXE.
- HUD/menus/card-selector/settlement-picker/pack-opening are plain DOM — standard
  selectors; fill in missing `data-testid`s (some exist already, e.g.
  `GameScreen3D.tsx:224`).
- Verify in Phase 1 that the camera is deterministic during play; if free-orbit is
  enabled mid-game, testkit pins it.

### 3. Three-layer validators — placed where the data lives
- **Private chain state** (cards, tokens): asserted INSIDE each browser context via
  `page.evaluate` → `__triadTest` read hooks. Winner asserts +1 card incl. the
  specific claimed card; loser asserts −1 and its absence.
- **Public chain state** (game_status, settled flag, public owners, events): from the
  harness's own Node client (reuse `packages/integration/src/`) — independent of both
  browsers, catches "frontend thinks it settled but chain disagrees."
- **Backend**: existing `/health`, `/games/{id}` endpoints + Redis reads — game
  cleaned up, sessions sane.
- **No sleeps.** Subscribe to the app's tx-progress events (`txProgress.ts`,
  April instrumentation) via `page.exposeFunction`; wait on events
  ("settle tx mined", "note imported") with generous ceilings.
- **Move-by-move rules cross-check**: the harness precomputes the expected board via
  `@axolotl-arena/game-logic` and asserts the UI matches after every placement — a
  rules divergence between frontend, circuit, and TS engine is caught at the exact
  move it occurs.

### 4. Speed tiers — dummy-VK fast mode
The slow part is proving. `dummy_move` is already a constraint-free circuit with the
same public-input shape as `game_move`. **Lane 1 delivers** a ~10-line `dummy_hand`
twin + a `--permissive-vks` flag on the deploy script that registers dummy-circuit VK
hashes. Frontend behind `VITE_FAST_PROOFS` proves with dummy circuits (sub-second)
while the ENTIRE on-chain path stays real: recursive verification in `process_game`,
nullification, re-minting, transfers, rewards.
- Fast mode: est. 1.5–3 min/game → the 4-games+pack campaign in ~10–15 min, unattended.
- Real-proof mode: est. 5–15 min/game → nightly / pre-merge fidelity gate. The one bug
  class fast mode cannot see is proof-format drift (the 508→500-field kind), which is
  exactly what real mode exists to catch.

### 5. Campaign DSL + the AI triage loop

```ts
campaign('ladder-with-pack', async ({ p1, p2, chain }) => {
  for (let i = 0; i < 4; i++) {
    const result = await playFullGame(p1, p2, { policy: 'greedy' }); // D1a brain, adapts to actual winner
    await expectSettlement(result, {
      winnerGains: result.claimedCard,   // asserted in winner PXE, loser PXE,
      tokens: { p1: +20, p2: +20 },      // public game status, backend cleanup
    });
  }
  await openPack(p1);
  await expectCollection(p1, { cards: +10, tokens: -100 });
  await playFullGame(p1, p2);
});
```

On failure: Playwright trace + video + console + PXE logs + a three-layer state dump
at the failed assertion. Claude reads the artifacts, diagnoses, patches, reruns —
that loop replaces the manual cycle. Deterministic campaigns are the regression net;
exploratory AI-driven play (headed browser, same hooks) is the authoring/debugging
layer on top.

## Phases

| Phase | Deliverable | Est. | Status |
|-------|------------|------|--------|
| 1 | Orchestrator + one full click-driven game on the 4.2 sandbox, two contexts, three-layer settlement assertions | 3–4d | **COMPLETE** (2026-06-12) |
| 2 | Campaign DSL, collection/pack flows, fast-proof mode (needs Lane 1's dummy_hand + deploy flag) | 2–3d | blocked on Lane 1 dummy_hand |
| 3 | CI wiring (fast campaigns per-merge, real-proof nightly; Chromium needs SwiftShader for WebGL in CI) + artifact pipeline | 1–2d | not started |

Build Phase 1 against the STILL-WORKING 4.2 local sandbox — it becomes the acceptance
suite for the A1/A2 upgrade before any migration commit is trusted.

### Phase 1 evidence (against 4.2 sandbox, `v4.2.0-aztecnr-rc.2`)

`packages/playtest/tests/full-game.spec.ts` — `describe.serial` of two tests:
- **Deliverable** (test 1): onboard two contexts → matchmake → 9 real canvas
  clicks with per-move board cross-check vs the rules mirror → winner claims a
  loser card → assert all three layers: private cards (winner +1 incl. the
  specific claimed card, loser −1 incl. its absence) + winner token, public
  `game_status == settled` and on-chain players == the two browser accounts,
  backend room finished/released. **Passes.**
- **Tracked finding** (test 2, `test.fail`): loser +20 token reward discovery —
  see assumption 13. Stays green-as-expected; flips red when fixed.

Repeatability: two consecutive full fresh-stack runs (own sandbox boot + deploy
+ teardown each) green — run A 9.0m, run B 8.1m — plus a reuse-mode run. Real
proving puts a game at ~5–6 min; that is proving physics, the Phase-2 fast-proof
tier (Lane 1 `dummy_hand`) is the inner-loop accelerator. WebGL in headless
Chromium needs `--use-angle=metal` locally / SwiftShader-GL in CI
(`scripts/probe-webgl.ts`, `PLAYTEST_ANGLE=swiftshader`).

## Constraints & notes

- Two Playwright contexts have isolated storage → two isolated PXE/IndexedDBs,
  matching production. The serial-PXE rule applies WITHIN each player, as in prod.
- Campaign determinism: fresh deploy per campaign; both players start with cards 1–5;
  bot policy seeded.
- Coordinate with Lane 2 on the `main.tsx` import line and HUD testids (additive).
- After Lane 6's F1 merges, card art is .webp — testkit must not assume .png paths.

## Risks (honest)

- Real-proof campaigns stay ~30–60 min — proving physics, not tooling. Fast mode is
  the inner loop; real mode gates milestones.
- Fast mode can mask proof-shape bugs → never ship an upgrade on fast-mode green alone.
- Canvas projection assumes a deterministic camera (Phase 1 verification item).
- WebGL in CI requires SwiftShader/headed-xvfb config — known-solvable, budget for it.

## ASSUMPTIONS (Phase 1 implementation — discovered, written down per ground rules)

1. **Lane 2 touchpoints are 4 one-liners + names/testids, not just the main.tsx
   import.** Hook state (`aztec`, `game`) is only reachable inside `AppInner`, the
   camera only inside the R3F Canvas, and click-gating state only inside
   `GameScreen3D`. Footprint (all additive, all no-op without `VITE_TESTKIT=1`):
   `main.tsx` install import (negotiated), `App.tsx` `useTestkitBridge(aztec, game)`,
   `GameScreen3D` `useGameScreenBridge(...)`, `SwampScene` `<SceneBridge/>`,
   `name=` props on the BoardCell3D click mesh + PlayerHand3D hit plane (the 3D
   analog of the negotiated data-testids), and testids on menu/selector/settlement
   DOM. Needs Lane 2 sign-off at merge.
2. **Camera drift is benign.** The play camera oscillates ±0.03 m on a ~60 s period
   (`CameraController.tsx`); projection reads the live camera at click time, so the
   error within click latency is < 0.001 m against a 0.30 m cell half-width. Free
   orbit is never enabled during play — no pinning needed.
3. **Hand clicks are hover-proof.** `PlayerHand3D` hit-tests an invisible plane with
   X-strip boundaries; the hover pop-up animation moves card visuals, not strips.
   The testkit aims at strip centers from the same exported fan math the component
   uses (`getCardFanTransform`).
4. **The click-vs-animation race is gated, not retried.** The app drops cell clicks
   while a fly/capture animation runs (by design). The driver requires
   my-turn ∧ no-animation ∧ no-selection stable across 3 consecutive polls before
   clicking — deterministic gating on real state; a dropped click then fails the
   run loudly.
5. **Testkit PXE reads ride the app's serial queue.** Private reads
   (`get_nfts_for_user`, `get_balance`) are enqueued via `txManager.enqueuePxe`
   FIFO (no gameId, lowest priority) — the per-wallet serial-PXE ground rule is
   enforced by construction.
6. **Backend "Redis flush" = fresh in-memory process.** The orchestrator starts the
   backend without `REDIS_URL`; a fresh process is the deterministic clean slate.
   Redis-backed parity is Lane 4's concern, not a Phase 1 campaign dependency.
7. **The 4.2 sandbox path uses SponsoredFPC** (deploy script + in-app fees). The
   master-plan ban governs new work and the 4.3.1 migration (Lane 1/2); the
   harness drives the app as it exists on 4.2 and asserts behavior, not fee plumbing.
8. **Deterministic baseline:** fresh deploy per campaign; onboarding mints cards
   1–5 + 100 Arena Tokens per player; settlement pays +20 to BOTH players; pack
   cost 100. The scripted policy (hand slot 0 → first empty cell, row-major) is
   decisive: player1 wins 7–3; loser board cards {1,2,3,4}.
9. **Private state after settlement is eventually consistent by design** (PXE
   discovers token/card notes by block scanning). Settlement assertions poll those
   reads to a deadline; public chain status (settled=3) is the immediate truth.
10. **Eight known-good `game_status` values** (0 none, 1 created, 2 active,
    3 settled, 4 cancelled, 5 abandoned_claimed) — the public-layer validator
    asserts 3 after settlement and that on-chain players match the two browser
    accounts.
11. **Cross-lane packaging defect (Lane 3):** `@axolotl-arena/game-logic`
    compiles to ESM (`module: ESNext`) but its package.json declares no
    `"type"`, so plain-Node CJS consumers cannot `require()` it (vite/tsx/vitest
    consumers tolerate it). The harness esbuild-bundles the package's own
    source per run (`global-setup.ts` → `expected.ts`); the 1-line root fix
    `"type": "module"` belongs to Lane 3 (diff reported to the orchestrator).
12. **Devnet funding race (Lane 2 finding):** two concurrent onboardings both
    bridge Fee Juice from the SAME hardcoded anvil account (`fundDevnet.ts`),
    and ERC20 `approve` is owner+spender-keyed — player A's deposit consumes
    player B's allowance between B's approve and deposit
    (`ERC20InsufficientAllowance`, campaign run 8). The campaign onboards
    players sequentially; a real fix is per-player L1 accounts (anvil derives
    many) or approve-per-deposit atomicity in the funding helper.
13. **Loser token discovery (open finding, lanes 1/2):** settlement mints +20
    to both players as ONCHAIN_CONSTRAINED notes tagged by the game contract.
    The winner sees theirs immediately (their own PXE proved the settle tx);
    the loser depends on tagged-log block scanning and read 100 (not 120) for
    the full 120s window in run 7. Diagnostic 6-min ceiling added to determine
    slow-vs-never; if never, the loser's reward is undiscoverable in-session —
    exactly the class of bug the harness exists to catch.

## 4.3.1 acceptance gate (A1+A2 migration) — findings

Ran after merging the 4.3.1 `testnet` (A1 contracts + A2 SDK + funder). The
merge auto-resolved (my testkit touches are additive to lane-2's refactors),
both packages typecheck on the 4.3.1 SDK, CLI/artifacts are 4.3.1.

14. **Vite cold-optimize reload (fixed in-lane).** First boot after the SDK
    bump leaves a cold `.vite` cache; the dev server optimizes the
    dynamically-imported `@aztec` deps in the background while serving, the
    test's first page load races it, and Vite force-reloads mid-onboarding —
    restarting wallet deploy+mint in a loop that never finishes the 420s
    budget (0 "cards minted"). Not a migration bug — pure tooling race.
    Fixed: the orchestrator runs `vite optimize` to completion before serving
    (`stack.ts` bootFrontend), so the server starts with a warm, complete
    cache and never mid-load reloads.
15. **GATE-BLOCKING — no fee headroom anywhere (lanes 1 + 2).** On 4.3.1 the
    sandbox L2 base fee (`gasFees.feePerL2Gas`) rises as the deploy's own tx
    volume fills blocks, but every tx-sending path sets `maxFeesPerGas` from a
    no-headroom estimate, so a later tx is rejected once the base crosses it:
    `maxFeesPerGas.feePerL2Gas=21600000 < gasFees.feePerL2Gas=25900000`
    (`-32702`). INTERMITTENT and timing-dependent (deploy: 2 pass / 1 fail on
    identical config). No fee-bump idiom exists in any script or in
    `instrumentedWallet.ts` — so deploy (Lane 1 `deploy-contracts.ts`),
    onboarding, AND settlement (Lane 2 `instrumentedWallet.ts` gas estimation)
    all share the gap. Fix: set `maxFeesPerGas` with headroom — query
    `node.getCurrentBaseFees()` and multiply (≥2–3×), or pad the estimation's
    `maxFeesPerGas` component. The harness cannot mask this with a retry
    (quality bar) and cannot edit those lanes' files; the 4.3.1 acceptance run
    is BLOCKED on this fix landing in lanes 1 + 2.
