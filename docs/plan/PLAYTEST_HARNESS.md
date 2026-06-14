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

### Acceptance attempt 3 (after lanes 1+2 merged the fee fix) — two more findings

16. **Fee fix missed `deploy-contracts.ts` (Lane 1/6 coverage gap).** The
    headroom helper (`scripts/lib/feeSettings.ts`, `getCurrentMinFees × 3`) was
    wired into `deploy-testnet.ts` and `fund-testnet.ts` but NOT
    `deploy-contracts.ts` — the local-sandbox deploy the harness runs, whose
    `sendAs` carries no `fee` option at all (stock 1.5× cap). So the local
    deploy still flaked. I temp-patched the exact mirror locally
    (`fee: { gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) } }`
    on every send + the account deploy) → deploy then SUCCEEDED, validating both
    the fix and that it was the only deploy-side gap. Patch reverted (not my
    lane); diff reported to the orchestrator for Lane 1/6.
17. **GATE-BLOCKING — deferred move-proof reconstruction (Lane 2
    `useGamePlay.ts`).** With the deploy fixed, the game played to `active` and
    all proofs generated, but settlement never started: `canSettle` stayed
    false because P2 submitted 0 of 4 move proofs (backend relay confirms only
    P1's 5 SUBMIT_MOVE_PROOF). Cause, from P2's log:
    `[useGamePlay] Processing 2 queued move(s)` →
    `Deferred move proof failed: Circuit execution failed: Card already placed on board`
    (×4). Moves placed before the hand proof is ready are queued in
    `pendingMovesRef`; the deferred processor rebuilds each move's board from
    `gameStateHistoryRef.get(move.moveNumber)`, but the snapshot it gets already
    contains the card being placed (move-number vs occupied-count keying is
    off under 4.3.1's WS/proof-readiness timing), so the `game_move` circuit
    rejects it. The winner therefore never collects 9/9 → `canSettle` false →
    no settlement. Latent on 4.2 (timing never queued moves); 4.3.1 exposes it.
    Real fast-play bug (a human placing before proofs finish hits the same path),
    not a harness artifact — the harness drove valid clicks. Fix belongs to
    Lane 2 (snapshot keying in the deferred-move path). Acceptance run BLOCKED
    on this until it lands.

### Acceptance attempt 4 (after all 3 fixes merged) — finding 18

18. **GATE-BLOCKING — deferred-move fix was incomplete; the LIVE move-proof
    path still loses P2's pre-move board (Lane 2 `useGamePlay.ts`).** With the
    three fixes merged (deploy fee headroom ✓, deferred-move replay ✓,
    loser-token import ✓), the deploy succeeded and the game played to a
    correct 7–3 game-over (the on-screen board matched the rules mirror at all
    9 states). But settlement still never started: **P1 generated all 5 of its
    move proofs cleanly; P2 generated 0 of 4 — every one failed `Circuit
    execution failed: Card already placed on board`** (1 on the deferred path,
    3 on the live path), so P2 submitted 0 move proofs (backend relay confirms),
    the winner never reached 9/9, `canSettle` stayed false, and `waitCanSettle`
    timed out. Root cause: move proofs must be built against the board BEFORE
    the move, but the live path reads `boardBefore = ws.gameState.board`
    (`useGamePlay.ts:352`) inside an async handler; for the joiner (P2) that
    value has already advanced to include the just-placed card by proof-gen
    time (it races the WS GAME_STATE broadcast). The on-screen board is correct
    (cross-check passes) — only the async proof-gen reads stale-forward state.
    Lane-2 fixed this for the DEFERRED path (capture full pre-move state into
    `pendingMovesRef`); the SAME fix must apply to the LIVE path — capture the
    pre-move board at click time and pass it, never re-read `ws.gameState.board`
    after an `await`. P1/P2 asymmetry (P1 proofs prompt, P2 lags) is why it's
    joiner-only. Real fast-play bug, not a harness artifact. BLOCKED on the
    live-path capture fix landing in Lane 2.

### Acceptance attempt 5 — finding 19 + CORRECTION of findings 17/18

19. **GATE-BLOCKING — the real cause was never board capture; it's the C2
    card-replay check vs identical starter decks (Lane 1, circuit + card
    model).** After lane-2's deferred + live-path board-clone fixes both
    merged, P2 STILL generated 0/4 move proofs, same `Card already placed on
    board`, unchanged. That ruled out board capture: a *correct* pre-move board
    legitimately contains P1's cards. The actual assertion is
    `circuits/game_move/src/main.nr:128`:
    `for i in 0..9 { assert(board_before[i*2] != card_id, "Card already placed on board") }`
    — a GLOBAL, owner-blind replay check (C2, added by `b72cf42`/`47912b8`,
    ABSENT at the 4.2 merge-base; that's why Phase 1 on 4.2 passed). Its premise
    ("card ids are unique NFTs") is false here: `STARTER_CARD_IDS = [1,2,3,4,5]`
    mints the SAME ids to every player. So P1 places ids 1–5 first (no
    collision, 5/5 proofs OK); P2 then places its ids 1–4, each already on the
    board from P1 -> C2 rejects all 4. `applyMove` (TS) passes because it only
    checks cell-occupancy, hence the failure surfaces only in the circuit.
    **Consequence: no two fresh players can complete a game on 4.3.1** — a real
    game-breaking bug, not a harness artifact (both fresh players genuinely hold
    starter deck 1–5).
    **CORRECTION:** my attempt-3/4 reports misattributed "Card already placed"
    to a deferred/live board-capture race (Lane 2). That was wrong — the symptom
    was C2 card-id collision from the start; lane-2's two clone fixes (`14df546`,
    `0a06e2d`) cannot affect it and should be re-evaluated on their own merits.
    **Fix (Lane 1), two options:**
    (a) make C2 owner-aware — reject only when the same id is already on the
    board AND owned by `current_player` (`board_before[i*2]==card_id &
    board_before[i*2+1]==current_player`); lane-1 must confirm this still
    prevents replay across capture-driven ownership flips; OR
    (b) mint globally-unique token_ids per player so card_ids really are unique
    NFTs (keeps C2 global/sound; needs a separate card-type lookup for
    art/ranks). The harness could sidestep with disjoint decks, but that would
    MASK a real game-breaking bug, so it does not. BLOCKED on the Lane 1 fix.

### Acceptance attempt 6 — finding 20 (the C2 fix's chosen approach breaks proof chaining)

The C2 fix shipped as a per-player placed-slot mask folded into a new 23-field
state-hash anchor (lane-1 `ca698e2`/`8d4e528` + lane-2 prover `90e9393`).
Result: **P2's move proofs now generate (4/4, zero "Card already placed") and
both players submit 9/9 → `canSettle` reached → winner picks a card →
settlement starts.** Every earlier blocker is cleared. But settlement then
fails CLIENT-SIDE assembling the proof chain (no tx sent):
`Error: Proof chain broken at step 1` (`useGameSettlement.ts` sortProofChain).

20. **GATE-BLOCKING — per-player placed masks in the SHARED chained state hash
    can't agree across players (lanes 1 + 2).** sortProofChain links proofs by
    `endStateHash[i] == startStateHash[i+1]`; the C2 anchor now folds both
    players' placed-slot masks into that hash. Instrumented dump (reverted):
    - step 0 = P1 move 0: `end=…3117`, `p1_placed_after=1, p2=0` (P1 placed slot 0).
    - step 1 wants `start=…3117`; the intended next proof is **P2's move 1**, but
      its proof encodes `p1_placed=0` (P2 thought P1 had placed NOTHING). P2's
      proofs carry `p1a = 0,0,0,7` — it only learns P1's mask move-by-move from
      received proofs, lagging.
    Root cause: a player's placed mask is derived from its OWN private hand-slot
    usage; the opponent learns it only via the relayed move proof
    (`useGamePlay.ts:261` OR-ing `p1/p2PlacedAfter` into a local ref), which is
    async and lags under normal/fast play. So P1's `endStateHash` (real P1 mask)
    never equals P2's `startStateHash` (stale P1 mask) at the boundary — the
    chain is unassemblable. This is inherent to putting per-player,
    privately-derived masks into a SHARED hash that must chain across players.
    **Fix direction (lanes 1/2):** don't chain the masks. Do C2 replay-prevention
    self-contained inside each move circuit using the current player's private
    committed card_ids + the board's per-cell owner field (both already private
    inputs) — "the placed card_id is not already on a board cell owned by
    current_player" — needing NO mask in the shared state hash and reverting the
    21→23-field anchor. BLOCKED on this.

(Harness robustness, fixed in-lane this attempt: the orchestrator now syncs
`public/` circuit+contract artifacts from `target/` before serving — the
committed `public/contracts` copy was stale after the C2 merge and would
mismatch the deployed ABI once a run reaches `process_game`.)

### Acceptance attempt 7 — GREEN ✅ (A1+A2 upgrade validated end-to-end)

C2 round-2 (testnet `318a791`): chained masks reverted across circuit + contract
+ prover; replaced with the sound original-owner check on a 30-field, **publicly
agreed** state hash (both peers derive per-cell original-owners identically from
the board), so the proof chain assembles across the P1→P2 boundary.

`2 passed (6.3m)` on a fresh 4.3.1 stack:
- **Deliverable** (5.3m): two contexts onboard (Fee-Juice deploy + faucet) →
  matchmake → 9 click-driven moves with per-move board cross-check → all 9 move
  proofs (0 "Card already placed") → `canSettle` → winner claims a loser card →
  `process_game` settles on-chain (`txHash 0x0863aa…`) → three layers asserted:
  winner PXE +1 incl. the claimed card / loser PXE −1, winner token +20, public
  `game_status == settled` + on-chain players == both browser accounts, backend
  room finished/released.
- **Loser +20 token** (132ms): the ArenaToken reward note imported and the
  balance reached 120 (sentinel flipped from test.fail to expect-pass — now
  passing).

Every blocker the gate surfaced (vite cold-optimize, fee headroom incl. the
deploy-contracts.ts coverage gap, C2 card-replay vs identical decks, the C2
mask-chaining regression) is fixed; this run exercises the full real-proof path
on 4.3.1. NOTE for go-live hygiene: the committed `packages/frontend/public/`
contract/circuit copies lag `target/` after contract changes — the harness syncs
them at boot, but lane-6/the build should commit them in sync (or gitignore the
public build outputs).

### Attempt 8 — confirmation pass GREEN ✅

Second consecutive fresh-stack green on 4.3.1 (`2 passed`, 5.9m), run to rule out
the earlier intermittent deploy fee-headroom race — it did NOT recur (deploy: 0
`-32702`, clean settle on-chain + loser +20). Two consecutive green (att.7 6.3m,
att.8 5.9m) → A1+A2 upgrade validated repeatably; harness ready to merge.

## C-multi campaign (pack-open + 5 consecutive games) — harness findings

21. **WebGL Context Lost mid-campaign = shared GPU process, not an app leak
    (HARNESS fix).** The long pack+multi-game session repeatedly froze right
    after packs with `THREE.WebGLRenderer: Context Lost` then a dead page.
    Root-caused by instrumenting (not guessing): across two frozen runs both
    tabs lost their context 16 ms and 56 ms apart, then froze together —
    simultaneity is the signature of ONE shared GPU process dying, not
    independent per-tab R3F dispose leaks (those desync). Both players ran as
    `browser.newContext()` in ONE Chromium process → ONE GPU process; sustained
    ClientIVC proving starves it until the context drops, killing both tabs.
    Fix: one isolated Chromium PROCESS per player (`src/browser.ts`
    `launchIsolatedBrowser` + `PlayerDriver.launch`) so GPU budgets are
    per-player; plus a WebGL context probe (`installWebglProbe`, addInitScript)
    logged per phase to confirm live-count stays low. Single-game (full-game.spec)
    never hit this — its proving load is short enough that the shared GPU process
    survives; only the multi-game duration exposed it. See docs/plan/BUG_WEBGL_HANG.md.
22. **Hang guards must fail-fast on a wedged page, not at the proof budget.** The
    `withDeadline` (15/25 min) and per-read `withTimeout` (180 s) guards DID fire
    (Node timers, page-independent) but only at the happy-path budget. Added a
    per-driver liveness watchdog (`startWatchdog`): `page.on('crash')` immediate,
    or ~60 s of unanswerable pings → rejects a `driver.dead` promise that
    `withDeadline` and `waitPhase` race against. A wedged page fails in ~1–2 min.
    **CORRECTION (this claim was wrong):** the watchdog originally ALSO declared
    death on a WebGL context "lost & not restored >120 s" — which **false-
    positived and killed a healthy game mid-proof** (assumption 25). It now keys
    ONLY on unresponsiveness; the WebGL probe is diagnostics-only.
23. **The real "guards didn't fire" bug was UNBOUNDED CLICKS, not the watchdog.**
    Playwright's default `actionTimeout` is **0 (unbounded)**, and `use.actionTimeout`
    does NOT reach contexts we launch ourselves — so a bare `.click()` on a wedged
    page hangs to the 60-min test timeout. Proven with `scripts/probe-frozen-guard.ts`
    (while(true) on the page main thread): `Promise.race([evaluate, NodeTimer])` fires
    at the timer (reads were fine), but an unbounded click HUNG past 6 s; a bounded
    click rejects at the timeout. Fix: `context.setDefaultTimeout(60s)` +
    `setDefaultNavigationTimeout(120s)` on every launched context (`src/browser.ts`) and
    `actionTimeout`/`navigationTimeout` in the config. The proof now ASSERTS read+click+
    watchdog all fail fast (exits non-zero otherwise) — run it to re-verify.
24. **Post-pack wedge = a real lane-2 FRONTEND bug the harness caught (not WebGL,
    not the harness).** With clicks bounded, the run failed fast at `hand-confirm`
    with `5/5 cards selected` and the button enabled, but the **TxNotificationCenter
    toast (`.txnc-root`, z-index 1400, `pointer-events:auto`) intercepts the
    CardSelector "Play!" button (z-index ~15)**, and the **pack-tx notification is
    stuck in "Preparing"** (never clears after the pack mines) so the overlay
    persists. Multi-game/pack-specific (full-game never opens a pack). Per Zac's
    no-masking bar the harness does NOT dismiss the toast (it would re-block at
    settlement and hide the bug); fix dispatched to lane-2 (toast must not intercept
    game-button clicks; pack notification must clear on completion). Harness blocked
    on that fix, then rebase + re-run to reach the carryover games.
25. **Watchdog WebGL-death path was a FALSE POSITIVE — killed a healthy game
    (fixed).** After the lane-2 toast fix merged, the run finally cleared packs →
    matchmaking → **into game 1** (the game's SwampScene `<Canvas>` mounted,
    `live=1`, 8 move proofs generated). But the watchdog then declared `PAGE DEAD —
    WebGL context lost & not restored for 129s` and killed a demonstrably healthy
    game. Cause: React **`StrictMode`** (main.tsx) dev-double-mounts every R3F
    `<Canvas>` (`CREATED #1 live=1`, `CREATED #2 live=2`, `LOST live=1` within
    113 ms at mount) — the orphaned first mount's `webglcontextlost` fires while
    the live canvas renders fine; the probe set `lostSinceEpoch` on ANY loss, so
    the watchdog tripped 120 s later. Also fundamentally wrong for this harness:
    testkit gates MenuScene off, so `live==0` is the NORMAL menu state. Fix:
    the watchdog keys ONLY on unresponsiveness (`page.crash` + dead pings); the
    WebGL probe is diagnostics-only. Real wedges are still caught (ping-fail, or
    the bounded per-op timeouts). This is a correction to MY OWN guard, not a mask
    — the game was provably progressing when wrongly killed.

## Carryover hypothesis matrix (C-multi prep — root-cause the FIRST failure instantly)

The campaign plays 5 games in ONE session with NO stack reset, so anything from
game *i* that is not reset can leak into game *i+1*. Seven candidates, each with
the reset path it implicates and the per-game signal that uniquely fingerprints
it — so the first failure points straight at the owning lane. The harness already
covers most; three gaps got a crisp deterministic check added (no masks, no
retries — they only make a real bug fail *louder/sooner*, never hide one).

| # | Carryover | Owner / reset path | Distinguishing per-game signal | Status |
|---|-----------|--------------------|--------------------------------|--------|
| 1 | Leftover move/hand proofs | lane-2 `useGamePlay` reset (`collectedMoveProofs`, `myHandProof`, `opponentHandProof`) | `chain.canSettle=true` at game start (full leftover) | **covered** (canSettle check). Partial leftover (proofs present but < 11 so canSettle stays false → corrupt transcript at settle) is NOT visible: the snapshot exposes no proof *count*. Open — recommend lane-2 expose `collectedMoveProofs.length` in the testkit snapshot; not added (would be a speculative cross-lane contract change). |
| 2 | Leftover settlement state | lane-2 `useGameSettlement.resetForMenu` | `settleTxStatus≠idle` / `opponentSettled` / `takenCardId≠null` / `onChainError` at start | **covered** |
| 3 | Backend room not released | lane-4 `GameManager.releasePlayersFromGame` | players split into two rooms (`gameId` mismatch) **OR** both re-join game *i*'s stale room (`wsGameId == prev`) | mismatch covered; **stale-reuse was a GAP → added** (`seen.wsGameIds`) |
| 4 | playerNumber carryover | lane-4 matchmaking assignment | `byNumber.size≠2` (both got the same number) | **covered** |
| 5 | Card note recycle / nullifier reuse / PXE discovery lag | contract re-mints unwagered hand cards at settle; PXE must rescan | pre-game count/multiset wrong; hand proof fails; mid-game commit ≠ `pre−5` | **covered** (count + exact multiset + mid-game `−HAND`) |
| 6 | `game_id` / `randomness` reuse | contract (lane-1) — both derived IN-CIRCUIT | `onChainGameId == prev game's` (settled into the same on-chain slot) | **GAP → added** (`seen.onChainGameIds`) |
| 7 | Frontend session/board not reset | lane-2 `useGameSession`/`useGame` (`returnToMenu`→`handleBackToMenu`) | board NOT empty at game start (stale `gameState`/board) | only caught indirectly (a later `waitBoardCount(1)` would *time out* with a confusing message) → **GAP → added** crisp board-empty check |

Diagnostics added to `playOneGame` for gaps 3/6/7 (all deterministic asserts in
the existing no-carryover region, labelled with the owning lane):
- gap 3: `wsGameId` must be unseen across games (else: re-joined a prior room — lane-4).
- gap 7: every board cell empty right after `waitInGame` (else: stale `gameState` — lane-2).
- gap 6: `onChainGameId` must be unseen across games (else: `game_id`/randomness reuse — lane-1/contract).
