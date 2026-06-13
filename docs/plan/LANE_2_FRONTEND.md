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
