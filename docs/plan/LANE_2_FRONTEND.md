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

### Loser +20 token reward — BLOCKED ON LANE 1 (contract change required)
The harness `test.fail()` sentinel (`packages/playtest/.../full-game.spec.ts`,
"loser +20 token reward is discovered in-session") is a real app bug. Root
cause confirmed: **it is NOT frontend-fixable as-is.**

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
