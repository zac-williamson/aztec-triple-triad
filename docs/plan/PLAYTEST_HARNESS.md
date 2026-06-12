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

| Phase | Deliverable | Est. |
|-------|------------|------|
| 1 | Orchestrator + one full click-driven game on the 4.2 sandbox, two contexts, three-layer settlement assertions | 3–4d |
| 2 | Campaign DSL, collection/pack flows, fast-proof mode (needs Lane 1's dummy_hand + deploy flag) | 2–3d |
| 3 | CI wiring (fast campaigns per-merge, real-proof nightly; Chromium needs SwiftShader for WebGL in CI) + artifact pipeline | 1–2d |

Build Phase 1 against the STILL-WORKING 4.2 local sandbox — it becomes the acceptance
suite for the A1/A2 upgrade before any migration commit is trusted.

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
