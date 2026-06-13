# Lane 2 — Frontend (React, hooks, SDK integration)

Branch `lane/2-frontend` · Worktree `worktrees/lane-2-frontend`
Owns: `packages/frontend/src/` (hooks, aztec/, components, components3d, App.tsx).
**Internal order is STRICT — these items share files: B → A2 fixes → C → D1b.**

## Mission
Decompose the 1,834-line `useGame.ts` monolith, absorb the 4.3.1 SDK migration,
then build the privacy-visibility panel and practice-mode UI on the cleaned base.

## Sequence

### B — useGame decomposition (2–3d) — START HERE
Split `hooks/useGame.ts` into:
- `useGameSession` — onChainPhase machine (`idle→creating→awaiting_join→active...`),
  create/join/cancel pipeline, `settlementInfoRef` seeding.
- `useGamePlay` — move queue, proof orchestration (`pendingMovesRef`,
  `gameStateHistoryRef`, deferred move processing).
- `useGameSettlement` — `handleSettle`, settlement waits/promise resolvers, note
  relay + import, post-settle card persistence.
Keep a thin `useGame` facade so `App.tsx` and tests don't churn. The 9 test files
(~4.8k LOC, incl. `useGame.settleFlow.test.ts`'s stateful WS mock) are the net —
they must pass unmodified (or with mechanical import updates only).
Preserve the ref-vs-state architecture and its comments (`useGame.ts:88-126`) — it
encodes real race-condition fixes (stale-closure settle bug, see
FUTURE_IMPROVEMENTS.md).

### A2 — TS/SDK upgrade to 4.3.1 (2–3d) — after B; needs Lane 1's artifacts
- Bump every `@aztec/*` to 4.3.1 across frontend/integration/scripts package.jsons
  (single atomic commit, announced — touches files outside this lane by agreement).
- Regenerate + adopt codegen wrappers from Lane 1.
- Expect churn in: `aztec/connectToAztec.ts` (account create/deploy, fee),
  `aztec/instrumentedWallet` (broke on the last rc bump — commit `adf425e`),
  `aztec/txManager.ts`, `aztec/noteImporter.ts` (`import_note` flow broke on the
  last bump too — commit `673d772`), `proofWorker.ts` (proof field count!).
- Acceptance: Lane 8 harness full game on local 4.3.1 sandbox.

### C — Privacy visibility panel (1–3d)
New `ChainViewPanel` + GameHUD toggle: "you see / chain sees" (actual hand vs
`card_commit` hash), live proof ticker (subscribe to existing `txProgress.ts`
events; timings per proof), settlement anatomy (11 proofs → 1 tx, tx hash link).
All data already exists in hook state — this is presentation. This panel IS the demo.

### D1b — Practice mode UI (1d) — uses Lane 3's `chooseBotMove`
Generalize the tutorial loop (`tutorial/useTutorial.ts` already drives game-logic
locally with a CPU opponent — `pickCpuCell`) into an unscripted practice screen
reusing `GameScreen3D`. Menu entry. No chain, no backend.

### I — Funding/onboarding path (0.5d spike + 1–2d) — after A2/A3
Spike what faucet the 4.3.1 testnet exposes (node info shows a `feeAssetHandler`
on Sepolia). Then: in-app "request funds" → poll balance → auto-continue, replacing
the manual FundingPrompt flow. **SponsoredFPC remains banned** — Fee Juice only.

**Reference (orchestrator, for when A3 unblocks this):** model the L1→L2
Fee Juice flow on **aztec-kit `apps/bridge`** (gregojuice) — the canonical
bridge implementation — and **aztec-kit `packages/common`**, which has
bridging helpers worth reusing. Our existing `aztec/fundDevnet.ts`
(`fundAccountOnDevnet`, used by `connectToAztec` + `deploy-contracts.ts`) is
the devnet bridge; item I generalizes that into the testnet faucet/onboarding
UX. Note gregojuice is already this repo's port source for
`instrumentedWallet.ts`.

## Cross-lane contracts
- **Consume:** artifacts/codegen + proof-shape notices (←1), `chooseBotMove` (←3),
  testkit spec coordination (←8: one `main.tsx` import + HUD `data-testid`s —
  additive, review their PR fast).
- **Provide:** stable post-B hook structure (→7 docs frontend sections, →8 testkit
  integration), merged `.webp` switch rebase point for Lane 6's F1.

## Constraints
- EmbeddedWallet only; serial PXE ops; safe `toFr` helper for all simulate results;
  `import_note` after every `create_and_push_note` tx; `--legacy-peer-deps`.
- `tsc --noEmit` stays at 0 errors (it is clean today — keep it that way).

## ASSUMPTIONS (discovered during item B — useGame decomposition)

1. **The 9 test files importing useGame are the behavioral net.** They pass
   with zero edits (no import updates needed): `useGame.ts` re-exports
   `VALID_TRANSITIONS`, `OnChainPhase`, `mapWinnerId`, `TxStatus`,
   `ProofStatus` from their new homes. `GameScreen.tsx` also imports
   `TxStatus` from `useGame` — that re-export is load-bearing.
2. **Dead refs removed** (commit "refactor(frontend): remove dead
   pipelineDoneResolveRef and lastSettleTxHashRef"). `pipelineDoneResolveRef` was
   resolved in pipeline postEffects but no code ever registered a waiter;
   `lastSettleTxHashRef` was written on settle/loser-import and no-op
   cleared, never read for a decision. Verified by grep before removal; no
   observable behavior change, so no test accompanies it.
3. **Session-side `cardIdsRef` writes were redundant.** The ref's only read
   (`generateMoveProofForPlacement`'s handData) is gated on `myHandProof`,
   which only exists after `generateHandProofFromState` wrote the identical
   facade `cardIds` value to that ref. The duplicate writes in
   `createGameOnChain`/`prepareJoinGame` were dropped; the ref is now
   private to `useGamePlay`.
4. **`handlePlay` intentionally does not restore `myHandProof`** from
   localStorage — after a reload `handProofGeneratedRef` is fresh and the
   own-hand proof regenerates from saved card IDs + blinding factor. Now
   documented on `useGamePlay.restoreFromSave`.
5. **`settleTxHash`/`settleError` are set but not yet rendered.** Kept and
   exposed on `UseGameSettlementReturn` because item C (privacy panel)
   surfaces settlement anatomy; deleting them would churn C.
6. **Effect-order shift is safe.** Sub-hook effects now run before facade
   effects in a commit (previously interleaved in one hook). The only
   cross-group pair (facade reset-on-menu vs settlement's loser-import/
   abandoned triggers) is order-insensitive: `ws.leaveGame()` clears the ws
   fields those effects key on before `screen` flips to `main-menu`.
7. **Cross-hook contracts are stable-identity functions, not raw refs**
   (`getPhase`, `waitForActivePhase`, `getSettlementInfo`,
   `backfillSettlementInfoFromWs`, `getMoveProofs`, `waitFor*Proofs`…).
   This is what keeps `handleSettle` memoized (the stale-closure settle bug
   regression pinned by `useGame.settleFlow.test.ts`). Anything added to a
   hook's public surface must keep this property.

### From item C (chain-view panel) + QA-F3 frontend half

8. **txProgress events cover wallet txs only** (create/join/settle via
   instrumentedWallet) — client-side circuit proofs never pass through the
   wallet. Per-proof timings therefore come from a new optional
   `durationMs` on `SerializedProof`, set by proofWorker (which already
   measured and discarded it). A relayed proof carries the PROVER's
   timing — the opponent's number is theirs.
9. **Move proofs carry no player attribution** (`MoveProofData` has no
   player field; both card commits appear in every proof), so the panel's
   ticker lists move proofs in arrival order without "you/them" labels.
10. **QA-F3 reply handling needs no code**: the server's GAME_OVER response
    re-enters the idempotent GAME_OVER path, and a benign
    `ERROR 'Game not found'` only sets `ws.error`, which has no UI
    consumer (verified by grep — nothing renders it).

### From item A2 (4.3.1 SDK migration + SponsoredFPC removal)

11. **npm tag confirmed**: `@aztec/*@4.3.1` all exist (verified via
    `npm view`); `@noir-lang/noir_js@1.0.0-beta.21` (plain release) matches
    lane-1's nargo. Lane 1's "presumed 4.3.1" assumption is now confirmed.
12. **The public SDK surface the app uses survived 4.2→4.3.1 unchanged**
    (tsc clean with zero source edits outside the two below). The churn was
    confined to wallet INTERNALS used by instrumentedWallet:
    `completeFeeOptionsForEstimation` is gone (one
    `completeFeeOptions({ from, feePayer, gasSettings, forEstimation })`
    config object now), `simulateViaEntrypoint` takes `additionalScopes` +
    `sendMessagesAs`, `pxe.proveTx` takes `{ scopes, senderForTags }`.
    Verified against the installed 4.3.1 wallet-sdk source, not docs.
13. **`UltraHonkBackend` now requires an explicit `Barretenberg` api**
    (second constructor arg) — fixed in integration's noir-backend; the
    frontend already passed it.
14. **Fee Juice default**: omitting the `fee` option makes the sending
    account pay natively from its own balance
    (`AccountFeePaymentMethodOptions.PREEXISTING_FEE_JUICE` in 4.3.1's
    completeFeeOptions). All game/pack txs now rely on this; accounts are
    funded at onboarding (bridge+claim on devnet, manual bridge on testnet).
    The deploy script bridges to its deployer via the same
    `fundAccountOnDevnet` helper the app uses.
15. **No proof-shape change** (lane-1 verified: proof 500 fields, VK 115) —
    `proofWorker.ts` needed no size changes; contract method signatures the
    frontend calls (incl. `import_note`'s 8 params) are unchanged in the
    migrated contracts, so the 673d772-style churn did not recur.
16. **CLAUDE.md §Versions + ground rules updated in this commit** (stale
    4.2 pins + "legacy SponsoredFPC usages remain" parenthetical) — a
    1-section cross-lane touch on Lane 7's file, flagged at the gate.

### From the A2 gate follow-up (integration SponsoredFPC — caught at gate)

17. **My first "zero SponsoredFPC anywhere" was wrong**: I scoped the grep
    to `packages/integration/src`, but the usage was in
    `packages/integration/tests/`. Two compounding blind spots hid it:
    integration's tsconfig `exclude: ["tests"]` (so the e2e files are in NO
    `tsc` gate) and the `@ts-nocheck` header on each. Lesson: a ban scan
    must be a plain repo-wide `grep`, never gated on tsc/test runs.
18. **The two live e2e tests** (`e2e-aztec-settlement`, `e2e-full-game-flow`)
    migrated to Fee Juice: a shared `fundAndDeployAccount` helper in
    `e2e-helpers.ts` reuses the existing `fundAccountOnDevnet` bridge
    (no duplication) — bridge + claim at account deploy, then native
    payment (`sendAs` drops the `fee` option). Mirrors the proven, merged
    `deploy-contracts.ts` pattern exactly.
19. **Neither e2e test runs in CI**: vitest's `include` is a 4-file
    allowlist that omits `e2e-*`, and they need a live PXE + Anvil L1 for
    the bridge. So, like the real-proof gate, I verified them by transform
    (esbuild bundle resolves the local import graph) + `tsx` import-graph
    resolution, NOT execution. A Lane 8 / sandbox run is the true gate.
20. **`tests/debugging/*` deleted (9 files), not archived**: diagnostic
    repros from the closed nullifier/IDB/cooldown investigation — never run
    (vitest excluded the dir), unreferenced, and the April test report
    (`docs/history/test_report_2026-04.md:174`) itself prescribed deleting
    them. Their findings already live in `docs/history` as narrative
    reports; the executable `.test.ts` scratch is not doc-archaeology, so
    `git rm` (history preserves them) over a move. The now-dead
    `exclude: ['tests/debugging/**']` was removed from the vitest config.

### From item D1b (practice-mode UI)

21. **Practice mirrors the tutorial's chainless full-screen pattern**, not a
    `useGame` `Screen`. Like `tutorialScreen`, `practiceScreen` is local
    `AppInner` boolean state that early-returns before the menu/game routing —
    so practice touches neither the `Screen` union nor `useGame`. No chain,
    no backend, no `useGame` involvement at all.
22. **`usePractice` is the generalized tutorial loop**: same
    `createGame`/`placeCard` core with the scripted scenes/dialogue/triggers
    stripped and `pickCpuCell` replaced by game-logic `chooseBotMove`
    (random/greedy/lookahead). The human is player1 and moves first
    (createGame's default turn); the bot replies on a short timer so the
    placed card is visible first.
23. **Seed threads to BOTH deal and bot**: `createSeededRng(seed)` deals the
    hands and `chooseBotMove({ seed: seed + moveCount })` picks each bot move,
    so a fixed seed reproduces the entire match (pinned by a test). The UI
    passes no seed → `Math.random` for varied play; tests pass `seed` +
    `botDelayMs: 0`.
24. **GameScreen3D/GameHUD reused as-is except one additive `practiceMode`
    prop** that suppresses GameHUD's chain-coupled game-over UI (settlement
    card-picker + "+20 Arena Tokens" banner + "opponent settling"). Practice
    renders its own win/loss/draw overlay. The prop defaults false, so the
    real-game path is untouched; the suppression has its own GameHUD test.
25. **Hands are dealt from the full `CARD_DATABASE`** (10 distinct cards,
    5 each) — practice is self-contained and does not read the player's
    on-chain collection. `dealHands` is new because the old frontend
    `getRandomHand*` helpers were removed in the cards.ts dedup (item b).

## Open handoffs (playtest sweep, 2026-06-13)

### Lane 8 testkit touchpoints — SIGNED OFF
Reviewed `git show lane/8-playtest` on every file the testkit touches in this
lane's ownership. **Acceptable — prod-inert.** Details:
- All activation is gated behind `TESTKIT_ENABLED` (`testkit/enabled.ts`),
  which is `import.meta.env.VITE_TESTKIT === '1'` — a static-false constant in
  prod, so `install.ts`'s `import('./api')` (the heavy `api`/`contract`/
  `project` graph) is dead-code-eliminated.
- The touchpoints to my files are: (a) static `data-testid`s
  (CardSelector/MainMenu/TutorialPrompt/GameHUD/SettlementCardPicker) and
  Three.js mesh `name`s (BoardCell3D/PlayerHand3D via `testkit/names.ts`) —
  fully inert attributes; (b) three integration points — `useTestkitBridge`
  (App), `useGameScreenBridge` (GameScreen3D), `<SceneBridge/>` (SwampScene) —
  each calls its hooks unconditionally (correct) but early-returns the effect
  body on `!TESTKIT_ENABLED`. `registry.ts` is statically bundled but has no
  module-load side effects, so it's inert when unpublished.
- Two minor, non-blocking notes for Lane 8: (1) `enabled.ts`'s "every testkit
  code path is dead-code-eliminated" is slightly overstated — the *bridge*
  modules are statically imported (bundled but inert); only the dynamic
  `import('./api')` graph is DCE'd. (2) Their GameHUD `data-testid="back-to-lobby"`
  additions sit inside the gameOver block my D1b `practiceMode` change wrapped
  in `!practiceMode && …` — a trivial rebase overlap when both land; the
  testids belong on the chain-path buttons, unaffected by the practice path.

### Loser +20 token reward — RESOLVED (Lane 1 contract + this lane's import)
**Update (2026-06-13):** Lane 1 shipped the ArenaToken change (live on testnet
via the updatable redeploy): `mint_reward(to, amount, player_randomness)`
(create_and_push with recipient-derivable randomness), the
`compute_reward_randomness(player_randomness) -> Field` getter, and
`import_note(owner, value: u128, randomness, tx_hash, …)`. `process_game` now
mints the loser via `mint_reward(opponent, 20, opponent_randomness)`. This lane
wired the frontend import: on the loser side, `useGameSettlement`'s
`incomingNoteData` effect calls `importTokenRewardNote` (in `noteImporter.ts`),
which recomputes the note randomness from the loser's OWN per-game randomness
(`session.getSettlementInfo().gameRandomness`) and injects it via the token
contract's `import_note` — mirroring the card import. The old 5×2s
refresh-poll (which masked the never-discovered note) is gone; one
`refreshTokenBalance` after the deterministic import suffices. Pinned by
`useGameSettlement.loserToken.test.ts`; the harness sentinel flips green.

The original finding (kept for context):
The harness `test.fail()` sentinel (`packages/playtest/.../full-game.spec.ts`,
"loser +20 token reward is discovered in-session") was a real app bug. Root
cause: **it was NOT frontend-fixable as-is.**

- `process_game` rewards both players via `ArenaToken::mint_private(addr, 20)`
  (`triple_triad_game/main.nr:704-706`), which does
  `balances.at(to).add(20).deliver(MessageDelivery.ONCHAIN_CONSTRAINED)`
  (`arena_token/main.nr:66`). The **winner** sees their note (their own PXE
  proved the settle tx); the **loser** never discovers theirs in-session —
  ONCHAIN_CONSTRAINED tagged-log scanning doesn't surface it for the
  non-submitting party (harness assumption 13).
- The card flow works cross-PXE only because the NFT contract exposes a
  **recipient-importable** note: deterministic, recipient-derivable
  randomness (`derive_note_randomness` /
  `compute_note_randomness(nonce, count) -> [Field;10]`) + an
  `import_note(owner, value, randomness, tx_hash, unique_note_hashes[64],
  num_note_hashes, first_nullifier, recipient)` function. The winner relays
  `(txHash, randomness)` and the loser injects the note via `import_note`
  (`useGameSettlement.importNotes` → `noteImporter.importNotesFromTx`).
- **ArenaToken exposes neither** `import_note` nor any randomness-revealing
  getter (only `mint_private`/`burn_from`/`get_balance`/setters), so the loser
  cannot import the reward note the way cards are imported, and the winner has
  no randomness to relay.

**What Lane 1 must add to ArenaToken (mirror the NFT pattern):**
1. Mint the reward note with **deterministic, recipient-derivable randomness**
   (same `derive_note_randomness` family the NFT uses) instead of an opaque
   `ONCHAIN_CONSTRAINED` balance delivery — so the note hash lands in the tx
   effects and is reconstructable by the recipient.
2. A frontend-callable getter to obtain that randomness (NFT analog:
   `compute_note_randomness`), so the winner can relay it / the loser derive it.
3. An `import_note(...)` `unconstrained` function on ArenaToken mirroring the
   NFT's, letting the recipient inject the balance note into their PXE from
   `(txHash, randomness, tx-effect data)`.

**Frontend half (this lane, once the contract lands):** relay the loser's
token-reward `(tokenId-or-amount, randomness)` alongside the card notes in the
winner's `handleSettle` postEffects (`useGameSettlement.ts:439`
`capturedRelayNoteData`), and in the loser's `incomingNoteData` effect call the
ArenaToken `import_note` next to the card import — then `refreshTokenBalance`
reflects +20. Ship with a test; the harness sentinel flips green.

### Fee headroom (4.3.1 playtest gate fix, 2026-06-13)

26. **Every tx send sets `maxFeesPerGas = currentBaseFee × FEE_HEADROOM_MULTIPLIER`**
    via `src/aztec/feeSettings.ts` (`gasSettingsWithHeadroom(node)`). The L2
    base fee (`node.getCurrentMinFees()` — the 4.3.1 name for what the playtest
    called `getCurrentBaseFees`) rises with demand; the wallet's default
    `completeFeeOptions` sets `maxFeesPerGas` to base × a tiny `minFeePadding`,
    so a tx computed against a momentarily-low base fee REJECTS when the fee
    climbs during proving (observed `maxFeesPerGas.feePerL2Gas=21600000 <
    gasFees.feePerL2Gas`; harness assumption 15). `completeFeeOptions` honors a
    caller-provided `gasSettings.maxFeesPerGas`, so passing a partial
    `fee: { gasSettings: { maxFeesPerGas } }` (the wallet fills gasLimits from
    estimation) is all that's needed. Wired on all 9 frontend send paths:
    onboarding deploy+mint / deploy-only / mint-only (`connectToAztec`),
    `create_game`/`join_game` (`useGameSession`),
    `process_game`/`claim_abandoned_game`/`settle_abandoned_game`
    (`useGameSettlement`), `purchase_card_pack` (`useCardPacks`).

**`FEE_HEADROOM_MULTIPLIER = 3` is the CANONICAL value → Lane 1 scripts.**
`scripts/deploy-*.ts` send their own txs (account deploy, contract deploys,
mints) and must use the same headroom so on-chain and in-app share one fee
policy. They can import `gasSettingsWithHeadroom` / `FEE_HEADROOM_MULTIPLIER`
directly from `packages/frontend/src/aztec/feeSettings.ts` (deploy-contracts.ts
already imports `fundAccountOnDevnet` from frontend src), or replicate
`base × 3`. If the canonical multiplier ever changes, change it in
`feeSettings.ts` and re-announce to Lane 1.

### C2 replay fix — board-state hash now carries placed-slot masks → FROM LANE 1 (REQUIRED)

27. **The `game_move` circuit changed (BUG_C2_REPLAY P0 fix). The browser prover
    must match or EVERY move proof will fail with a state-hash mismatch.** Root
    cause recap: `STARTER_CARD_IDS=[1..5]` are shared across players, so the old
    owner-blind board scan rejected P2's legitimate plays of ids already on the
    board. Lane 1 replaced it with a **per-player placed-hand-slot bitmask**
    (`p1_placed`, `p2_placed`) carried as chained state in each move proof. The
    public-input count is unchanged (still 6); the masks fold into the existing
    start/end state hashes and are two new *private* inputs to `game_move`.

    Required frontend changes (all in `src/aztec/proofWorker.ts` unless noted):
    - **Re-sync the circuit bytecode** — Lane 1 recompiled `game_move`
      (`circuits/target/game_move.json`, committed). Run `npm run copy-circuits`
      to refresh `packages/frontend/public/circuits/game_move.json` (the old
      committed copy is stale and expects the old 17 inputs). **This must land in
      the SAME commit/merge as the proofWorker changes below** — new bytecode
      with old prover code (or vice versa) hard-errors on input/hash mismatch.
    - **`computeBoardStateHash`** — append two params `p1Placed, p2Placed` and
      add them to the pedersen preimage **after `currentTurn`**: the array is now
      `[board[18], scores[0], scores[1], currentTurn, p1Placed, p2Placed]`
      (21 → 23 fields). Mirrors `hash_board_state` (`circuits/game_move/src/main.nr:32-48`).
    - **`generateGameMoveProof`** — accept `p1PlacedBefore, p2PlacedBefore`;
      compute after-masks by setting the *mover's* placed-slot bit
      (`afterMask = beforeMask | (1 << slot)`, where `slot` = index of `cardId`
      in the mover's **committed** `player_card_ids`, NOT the shrinking live
      hand); pass before-masks to the `boardBefore` hash and after-masks to the
      `boardAfter` hash; add `p1_placed_before`/`p2_placed_before` to the witness
      `inputs` map (the circuit's two new private inputs).
    - **Caller** (`hooks/useGamePlay.ts` / `useProofGeneration.ts`) — track the
      running `(p1Placed, p2Placed)` pair across the game and **chain** it: move
      *i*'s after-masks are move *i+1*'s before-masks. First move's before-masks
      are `(0, 0)`. Both players' masks live in every move's hash; only the
      mover's changes per move.
    - **`hooks/useGameSettlement.ts:781`** — the initial empty-board hash must
      pass `0, 0` for the masks so it equals the first move's `boardBefore` hash.
    - **Tests** — update the hash mirrors in `src/aztec/__tests__/proofWorker.test.ts`
      and `src/__tests__/proofIntegration.test.ts` (any hardcoded 21-field hash
      or `computeBoardStateHash` call). Add a duplicate-deck end-to-end mirror of
      Lane 1's `test_duplicate_deck_*` if integration coverage allows.

    Full rationale + the circuit-side test evidence are in
    `docs/plan/BUG_C2_REPLAY.md` (Resolution section). The slot is well-defined
    because `prove_hand` enforces distinct ids within a hand.

28. **DONE (2026-06-13).** All 5 steps landed in one commit with the refreshed
    `public/circuits/game_move.json`. `proofIntegration.test.ts` executes the
    REAL circuit with the 23-field hash + mask inputs (incl. a new
    same-slot-replay reject mirroring Lane 1's `test_card_replay_rejected`) —
    the authoritative mirror, so no separate `proofWorker.test.ts` hash mirror
    was needed (it only tests pure field utils). **Discovered requirement
    beyond the 5 steps — cross-player mask relay:** the opponent's
    committed-hand slot is underivable locally (the live hand is spliced, the
    commit order is private), so the running pair can't be tracked from board
    observation alone. The mover's after-mask pair is carried in `MoveProofData`
    (`p1PlacedAfter`/`p2PlacedAfter`, optional) and rides opaquely through the
    backend's `MOVE_PROVEN` relay; the receiver OR's it into the running pair
    (OR is monotonic, so order-robust). Own moves advance our own slot bit
    (committed-hand index, matching proofWorker). The deferred path captures
    before-masks at queue time like the board; restore reconstructs the pair by
    OR-ing all saved proofs' after-masks. No backend/protocol-shape change —
    `MoveProofData` is forwarded as an opaque object.

29. **DONE (2026-06-13) — Item I onboarding frontend (Option B, Zac GO).** The
    testnet self-funding gap is closed on the frontend. New files:
    `aztec/requestFeeJuiceClaim.ts` (faucet abstraction) +
    `components/FundingProgress.tsx` (zero-action "Getting You Set Up" screen).
    `useAztec.connect` testnet branch: when `AZTEC_CONFIG.faucetUrl` is set →
    status `funding` → `requestFeeJuiceClaim(faucetUrl, l2Address)` →
    `deployAndRegister({ feeJuiceClaim })` (the proven combined deploy+mint) →
    `connected`, auto-continuing to the menu. The three deploy paths
    (already-deployed restore, devnet, faucet) now share one local `runDeploy`
    helper so fees/labels/wiring can't drift. **Degraded fallback preserved:** a
    faucet *request* failure → `needs-funding` → existing `FundingPrompt` (manual
    bridge). A deploy failure after a good claim is a real error (outer catch),
    NOT a silent manual fallback. **SponsoredFPC stays banned** — the faucet
    bridges real Fee Juice the account claims at deploy. New config:
    `VITE_FAUCET_URL` (empty → manual-only, unchanged behavior). Tests:
    `requestFeeJuiceClaim.test.ts` (claim deserialization, non-OK + incomplete
    throws), `useAztec.faucet.test.ts` (testnet branch reaches `connected` with
    the claim threaded; faucet error → `needs-funding` with no deploy; no-URL →
    manual), App.integration adds funding/deploying-overlay + needs-funding
    fallback routing. **Cross-lane dependency (Lane 4, ~0.5d):** `POST
    {faucetUrl}/faucet { l2Address }` must bridge via the treasury and return a
    JSON claim with at least `{ claimAmount, claimSecret, messageLeafIndex }` (a
    superset of `scripts/lib/feeJuiceBridge.ts`'s `SerializedClaim` — extra
    fields are ignored), responding ONLY after the L1→L2 message is included so
    the claim is immediately consumable. Until that endpoint + `VITE_FAUCET_URL`
    exist, testnet onboarding stays on the manual `FundingPrompt` (no
    regression).

### C2 replay fix ROUND 2 — REVERT the masks, mirror original-owners → FROM LANE 1 (REQUIRED)

30. **Notes 27–28 are SUPERSEDED. The chained placed-slot masks are fundamentally
    broken and Lane 1 has removed them.** Playtest attempt 6 proved it: a player's
    mask is privately derived, so the opponent only learns it from the lagging
    async relay (the `0,0,0,7` evidence) — P1's `endStateHash` never equals P2's
    `startStateHash`, and `sortProofChain` fails (`Proof chain broken at step 1`).
    The cross-player mask relay you added in note 28 (`MoveProofData.p1PlacedAfter`/
    `p2PlacedAfter`, OR-ed into a running pair) cannot fix this — it always lags by
    a move. Full analysis: `docs/plan/BUG_C2_REPLAY_2.md`.

    Lane 1 replaced the masks with a **self-contained original-owner check**: a
    move is rejected iff a board cell holds the placed `card_id` AND that cell's
    ORIGINAL owner is the mover. `original_owner` is publicly agreed (both peers
    derive it from the shared placements; capture never changes it), so the chain
    assembles. Public-input count stays **6**. Required frontend changes (mostly
    `src/aztec/proofWorker.ts`):
    - **Re-sync the bytecode** — `npm run copy-circuits` to refresh
      `public/circuits/game_move.json` (new `game_move` committed by Lane 1).
      **Same commit/merge as the code below** — mismatched bytecode/prover
      hard-errors.
    - **Drop all mask state.** Remove `p1Placed`/`p2Placed` params, the
      `(1 << slot)` after-mask math, the witness inputs `p1_placed_before`/
      `p2_placed_before`, the `MoveProofData.p1PlacedAfter`/`p2PlacedAfter` fields,
      the OR-relay in `useGamePlay`, and the running-pair chaining + restore. Revert
      note-28's `MoveProofData` shape change.
    - **`computeBoardStateHash`** — replace the two mask params with one
      `originalOwners: number[] /*len 9*/`; preimage becomes
      `[board[18], scores[0], scores[1], currentTurn, ...originalOwners]` = **30
      fields** (masks were 23). Mirrors `hash_board_state`
      (`circuits/game_move/src/main.nr:32-49`); original_owners occupy indices 21..30.
    - **`generateGameMoveProof`** — pass `original_owners_before` and
      `original_owners_after: Field[9]` to the witness and to the two hash calls.
      Both come straight from the SHARED board state — no private data, no
      chaining. Derive them from the game state's per-cell original owner (the
      `game-logic` board cell already has `originalOwner`): `before[i]` = original
      owner of cell `i` in the pre-move board (0 if empty); `after` = `before` with
      the placed cell set to the mover (captures never change it).
    - **`useGameSettlement.ts` initial hash** — pass `originalOwners = [0×9]` for
      the empty board (replaces the `0, 0` masks).
    - **Tests** — `proofIntegration.test.ts` executes the real circuit: update it
      to the 30-field hash + original-owner inputs; KEEP the duplicate-deck and
      same-slot-replay mirrors (they're the soundness guard) and ADD a P1→P2
      boundary chain-assembly assertion (P2's `startStateHash` == P1's
      `endStateHash`, derived without private state) — mirrors Lane 1's
      `test_proof_chain_assembles_across_player_boundary`.

    The original owner is well-defined from the public move history; you do NOT
    need any private hand info to compute it (that was the masks' fatal flaw).

31. **DONE (2026-06-13) — C2 round-2 prover revert landed.** Merged testnet
    (419f23e) and reverted note-28's masks to mirror the original-owner check, in
    one commit with the refreshed `public/circuits/game_move.json`. Changes:
    `proofWorker.computeBoardStateHash` now hashes 30 fields `[board[18],
    scores[2], current_turn, original_owners[9]]`; `generateGameMoveProof` drops
    the `(1<<slot)` mask math and the `p1/p2PlacedAfter` return, takes
    `originalOwnersBefore/After: number[9]` and threads them to the two hash
    calls + the `original_owners_before/after` witness. `useProofGeneration`
    gained `encodeOriginalOwners(board)` (parallels `encodeBoardState`, same cell
    order) and derives both arrays from the structured before/after boards — so
    `useGamePlay` lost ALL mask state (`placedMasksRef`, `committedCardIdsRef`,
    `advanceOwnMask`, the `lastMoveProof` OR-relay, the deferred mask capture,
    the restore reconstruction) with nothing threaded in its place. `types.ts`
    dropped `MoveProofData.p1/p2PlacedAfter`; `useGameSettlement` initial hash
    passes `originalOwners=[0×9]`. **Why this is simpler than the masks:**
    original owners ride entirely in the publicly-agreed board snapshot the hook
    already captures (immediate + deferred), so there is no per-player private
    state, no cross-player relay, and no chaining — the bug class is gone, not
    patched. Tests: `proofIntegration.test.ts` (real circuit, refreshed bytecode)
    updated to 30-field + original-owner inputs; kept the capture +
    original-owner-replay-reject mirrors, ADDED a finding-19 duplicate-deck
    capture-collision POSITIVE test (a current-owner check would false-reject it)
    and a P1→P2 boundary chain-assembly assertion (P2's start hash == P1's end
    hash, derived without private state — the exact thing that broke).
    `useGamePlay.placedMasks.test.tsx` deleted. Full suite 311/311, tsc clean.
