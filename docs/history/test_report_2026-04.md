Test Suite Analysis Report

  Current Inventory

  ┌─────────────┬────────────┬────────────┬──────────────┬─────────────────────────┐
  │   Package   │ Test Files │ Test Cases │  Framework   │      Last Updated       │
  ├─────────────┼────────────┼────────────┼──────────────┼─────────────────────────┤
  │ game-logic  │ 3          │ ~57        │ Vitest       │ Early (Phase 1)         │
  ├─────────────┼────────────┼────────────┼──────────────┼─────────────────────────┤
  │ backend     │ 4          │ ~138       │ Vitest       │ Recent (Redis refactor) │
  ├─────────────┼────────────┼────────────┼──────────────┼─────────────────────────┤
  │ frontend    │ 9          │ ~112       │ Vitest       │ Mixed                   │
  ├─────────────┼────────────┼────────────┼──────────────┼─────────────────────────┤
  │ integration │ 7+         │ ~35        │ Vitest       │ Early (Phase 5)         │
  ├─────────────┼────────────┼────────────┼──────────────┼─────────────────────────┤
  │ circuits    │ 2          │ ~15        │ Noir #[test] │ Mid-development         │
  ├─────────────┼────────────┼────────────┼──────────────┼─────────────────────────┤
  │ contracts   │ 2          │ ~4         │ Noir TXE     │ Mid-development         │
  ├─────────────┼────────────┼────────────┼──────────────┼─────────────────────────┤
  │ e2e         │ 19         │ ~19        │ Playwright   │ Debugging-era           │
  └─────────────┴────────────┴────────────┴──────────────┴─────────────────────────┘

  Total: ~380 test cases across ~46 files.

  ---
  Package-by-Package Analysis

  1. Game Logic (packages/game-logic) — GOOD

  Coverage: Comprehensive. 90% threshold enforced via vitest config.

  What works well:
  - game.test.ts: Full coverage of createGame, placeCard, capture logic, scoring, game end detection
  - cards.test.ts: Card database integrity, pack/unpack ranks round-trip
  - axolotlCards.test.ts: 256-card database validation, rarity distribution, deterministic card generation

  What's missing:
  - Chain capture depth testing: The BFS capture logic is tested for single captures and multi-adjacent captures, but not for deep chains (card A captures B, B then
  captures C). The circuit game_move does up to 8 BFS passes — the TypeScript engine should be tested at similar depth.
  - Edge case: all 9 moves with maximum captures: A full game where every move triggers chain captures to verify score consistency at each step.

  Recommendation: Add 2-3 chain capture tests. Otherwise this package is solid.

  ---
  2. Backend (packages/backend) — GOOD (with gaps)

  Coverage: GameManager is well-tested. Server integration tests cover the main flows. MemoryGameStore has full coverage.

  What works well:
  - game-manager.test.ts: 40+ tests covering create/join/place/cleanup with the new async GameStore interface
  - memory-game-store.test.ts: 31 tests covering every GameStore method
  - gameId.test.ts: BN254 field validity, uniqueness
  - server.test.ts: Full game flow, proof relay, input validation, CORS, move nonce, session management, inbox replay

  What's broken (pre-existing):
  - 3 hand sanitization tests fail. The tests assert ALL 5 opponent cards are hidden, but the server only hides the last 2 (indices 3-4). The tests are wrong, not the
   server. Fix the test assertions.

  What's missing:
  - Matchmaking tests in server.test.ts: The QUEUE_MATCHMAKING → MATCH_FOUND flow is untested at the WebSocket level. GameManager.queuePlayer and tryMatch are tested,
   but not through the server's message dispatch.
  - RedisGameStore tests: The RedisGameStore has no tests. It implements the same GameStore interface as MemoryGameStore, so running the same test suite against it
  (with a real or mock Redis) would provide coverage.
  - Disconnect + reconnect + continue game: The current reconnection tests verify session resume and inbox replay, but don't test the full flow: P1 creates game → P2
  joins → P1 disconnects → P1 reconnects → P1 places card. This tests that the playerToGame mapping survives reconnection.
  - Concurrent move race condition: Two near-simultaneous PLACE_CARD messages to verify the lock prevents double-processing. Currently tested at the GameManager level
   but not at the WebSocket level.

  Recommendations:
  1. Fix the 3 broken sanitization tests (wrong assertions, ~10 min fix)
  2. Add matchmaking WebSocket test
  3. Add disconnect-reconnect-continue-game test
  4. Optionally: run MemoryGameStore tests against RedisGameStore (requires Redis in CI or skip-if-unavailable)

  ---
  3. Frontend (packages/frontend) — WEAK

  This is where the biggest gaps are. The frontend contains the most complex logic (useGame.ts at 1,700 lines, txManager, proof orchestration) but has the least test
  coverage relative to complexity.

  What exists:

  App.test.ts — 4 tests for mapWinnerId. Trivially testing a 4-line function.

  Card.test.tsx / Board.test.tsx — 16 component render tests. These test presentational components that have simple props→DOM contracts. They're fine but not where
  the bugs live.

  proofWorker.test.ts — 15 tests for field conversion utilities (toFieldHex, bufToHex, numToField, hexToField, encodeBoardState). Good coverage of pure utility
  functions.

  txManager.test.ts — 40+ tests. This is the strongest frontend test file. Covers PXE serialization, priority queue ordering, phase transitions, subscriber
  notifications, concurrent transaction handling, and abandoned game flows. Well-written and current.

  useWebSocket.test.ts — 8 tests with a MockWebSocket. Tests basic message dispatch, malformed JSON handling, and disconnect state reset. Critically outdated —
  doesn't test:
  - Session token management (RESUME, SESSION_ESTABLISHED)
  - Auto-reconnect with exponential backoff
  - addMessageListener synchronous callback
  - OPPONENT_RECONNECTED handling
  - Matchmaking message flow

  cards.test.ts — 8 tests on the 50-card subset database. Outdated — the card database is now 256 cards (tested separately in axolotlCards.test.ts under game-logic).
  This file is redundant with the game-logic tests.

  proofIntegration.test.ts — 20+ tests that actually execute Noir circuits (prove_hand, game_move) with Barretenberg WASM. Tests valid inputs, invalid inputs, and
  boundary conditions. Valuable but slow (WASM compilation). Should be tagged as "slow" or "integration" to separate from fast unit tests.

  App.integration.test.tsx — 3 tests that render the App component with mocked hooks. Verifies hooks don't crash on mount. Minimal value.

  What's completely missing:

  useGame.ts — No tests. This is the 1,700-line orchestration hub with:
  - A 9-state machine (transitionPhase) with validated transitions
  - Settlement flow that reads from settlementInfoRef
  - Proof generation queuing and deferred move processing
  - Board state history snapshots
  - Multiple async pipelines (create, join, settle, abandoned)

  The pure/extractable parts that should be tested:
  - transitionPhase: Given current phase and target, does it accept/reject correctly? Does it resolve activePhaseResolveRef?
  - removeOneOfEach: Given source and toRemove arrays, correct removal behavior
  - mapWinnerId: Already tested in App.test.ts, could move
  - Settlement card ID flow: Given a settlementInfoRef state, does the execute callback read the right values?

  useGameStorage.ts — No tests. Pure localStorage wrapper with a 2-hour staleness check. Fully testable, fast win.

  useCardPacks.ts — No tests. Complex flow (simulate → preview → purchase tx → import notes) but all Aztec interactions need mocking.

  cardStore.ts — No tests. Pure localStorage wrapper (49 lines). Trivially testable.

  fieldUtils.ts — No tests for the newly extracted bytesToFrArray, base64ToFrArray, hexToFr. The existing toFr and toHexString are also untested (they're used
  everywhere but never directly tested).

  contracts.ts — No tests. Caching logic and warmup state machine untested.

  connectToAztec.ts — No tests. Account derivation is complex but all PXE operations need heavy mocking.

  noteImporter.ts — No tests. Retry logic and partial failure handling are untested.

  Recommendations:

  High priority (fast wins — pure functions, no mocks):
  1. fieldUtils.test.ts: Test toFr, toHexString, bytesToFrArray, base64ToFrArray, hexToFr with mock Fr class
  2. cardStore.test.ts: Test load/save/add/remove with mock localStorage
  3. useGameStorage.test.ts: Test save/load/clear/hasGame, especially the 2-hour staleness check
  4. useGame.transitionPhase tests: Extract the transition table and function, test every valid and invalid transition

  Medium priority (need simple mocks):
  5. useWebSocket.test.ts rewrite: Test session token flow, auto-reconnect, all message types, addMessageListener
  6. useGame settlement card state: Test that settlementInfoRef is populated correctly and that handleSettle reads from it (not from React state)

  Low priority (need heavy Aztec mocks, diminishing returns):
  7. useCardPacks flow test
  8. connectToAztec account derivation test
  9. noteImporter retry logic test

  ---
  4. Integration (packages/integration) — STALE

  What exists:
  - proof-utils.test.ts: Base64 round-trip, proof serialization. Fine.
  - prover.test.ts: MockProofBackend + ProofService. Fine but uses mock backend — never tests real circuits.
  - state.test.ts: Board/score/player field conversions. Fine.
  - game-session.test.ts: Full game session with proof exchange using MockProofBackend. Tests the orchestration logic but not real proofs.

  What's stale/irrelevant:
  - 19 Playwright E2E test files: Most appear to be debugging artifacts from the note discovery / nullifier sync battles (e2e-nullifier-sync.test.ts,
  e2e-nullifier-sync-backup.test.ts, e2e-nullifier-sync-inverted.test.ts, e2e-30-note-nullify.test.ts, e2e-cooldown-slots.test.ts, e2e-debug-mint.test.ts,
  e2e-real-3round-diagnostic.test.ts). These were written to diagnose specific PXE issues and don't test application behavior. They require a running Aztec sandbox
  and take 10+ minutes each.

  Recommendations:
  1. Audit the 19 Playwright tests: Determine which are still relevant vs debugging artifacts. Keep e2e-game-flow.test.ts and e2e-aztec-settlement.test.ts if they
  test real flows. Delete the diagnostic/debug files or move to a debugging/ directory.
  2. Add a real-proof integration test: One test that compiles prove_hand + game_move circuits and generates actual proofs (not mock). This catches circuit/TypeScript
   serialization mismatches.
  3. game-session.test.ts should test the full 9-move game with mock proofs — currently it only tests a few moves.

  ---
  5. Noir Circuits and Contracts — ADEQUATE for now

  prove_hand has 8 tests covering valid hands, invalid IDs, duplicates, and boundary values.

  game_move has tests for basic moves and captures but the test count is lower than the circuit complexity warrants. Chain capture testing in particular is thin.

  Contracts have minimal tests (commit_five_nfts, abandoned_game module). These require TXE which is slow. The critical contract logic (process_game proof
  verification, settlement card re-minting) is effectively tested end-to-end via the integration tests.

  Recommendation: No immediate action. Contract tests are hard to write (TXE dependency) and the TypeScript integration tests cover the same flows from the caller's
  side.

  ---
  Summary: Priority-Ordered Action Plan

  Tier 1: Fix broken + write fast pure-function tests

  ┌───────────────────────────────────────────────────────────────────────────┬────────┬─────────────────────────────────────────────────┐
  │                                  Action                                   │ Effort │                     Impact                      │
  ├───────────────────────────────────────────────────────────────────────────┼────────┼─────────────────────────────────────────────────┤
  │ Fix 3 broken hand sanitization tests in server.test.ts                    │ 10 min │ Eliminates noise in test runs                   │
  ├───────────────────────────────────────────────────────────────────────────┼────────┼─────────────────────────────────────────────────┤
  │ Write fieldUtils.test.ts (6 functions, mock Fr)                           │ 30 min │ Covers critical conversion code used everywhere │
  ├───────────────────────────────────────────────────────────────────────────┼────────┼─────────────────────────────────────────────────┤
  │ Write cardStore.test.ts (4 functions, mock localStorage)                  │ 20 min │ Covers card persistence                         │
  ├───────────────────────────────────────────────────────────────────────────┼────────┼─────────────────────────────────────────────────┤
  │ Write useGameStorage.test.ts (4 functions, mock localStorage + staleness) │ 20 min │ Covers game state persistence                   │
  ├───────────────────────────────────────────────────────────────────────────┼────────┼─────────────────────────────────────────────────┤
  │ Delete redundant frontend/src/cards.test.ts                               │ 5 min  │ Same tests exist in game-logic                  │
  └───────────────────────────────────────────────────────────────────────────┴────────┴─────────────────────────────────────────────────┘

  Tier 2: Test the state machine and settlement bug fix

  ┌───────────────────────────────────────────────────────────────────────────────────────┬────────┬────────────────────────────────────────────────────────────┐
  │                                        Action                                         │ Effort │                           Impact                           │
  ├───────────────────────────────────────────────────────────────────────────────────────┼────────┼────────────────────────────────────────────────────────────┤
  │ Write transitionPhase tests (valid/invalid transitions, resolver callbacks)           │ 45 min │ Covers the 9-state machine governing entire game lifecycle │
  ├───────────────────────────────────────────────────────────────────────────────────────┼────────┼────────────────────────────────────────────────────────────┤
  │ Write settlementInfoRef population test (pipeline → WS listener → handleSettle reads) │ 1 hr   │ Validates the card state bug fix                           │
  ├───────────────────────────────────────────────────────────────────────────────────────┼────────┼────────────────────────────────────────────────────────────┤
  │ Rewrite useWebSocket.test.ts for session management + reconnect                       │ 1 hr   │ Covers the new session/reconnect code                      │
  └───────────────────────────────────────────────────────────────────────────────────────┴────────┴────────────────────────────────────────────────────────────┘

  Tier 3: Test full flows and clean up stale tests

  ┌────────────────────────────────────────────────────┬────────┬──────────────────────────────────────────────────┐
  │                       Action                       │ Effort │                      Impact                      │
  ├────────────────────────────────────────────────────┼────────┼──────────────────────────────────────────────────┤
  │ Add matchmaking WebSocket server test              │ 30 min │ Missing flow                                     │
  ├────────────────────────────────────────────────────┼────────┼──────────────────────────────────────────────────┤
  │ Add disconnect-reconnect-continue-game server test │ 45 min │ Tests session resumption E2E                     │
  ├────────────────────────────────────────────────────┼────────┼──────────────────────────────────────────────────┤
  │ Audit and prune 19 Playwright E2E tests            │ 1 hr   │ Remove debugging artifacts, keep real flow tests │
  ├────────────────────────────────────────────────────┼────────┼──────────────────────────────────────────────────┤
  │ Add chain capture depth tests to game-logic        │ 30 min │ Catch BFS bugs                                   │
  └────────────────────────────────────────────────────┴────────┴──────────────────────────────────────────────────┘

  Tier 4: Optional (diminishing returns)

  ┌─────────────────────────────────────────────────────────┬────────┬────────────────────────────────────────────────┐
  │                         Action                          │ Effort │                     Impact                     │
  ├─────────────────────────────────────────────────────────┼────────┼────────────────────────────────────────────────┤
  │ Real-proof integration test (compile + prove + verify)  │ 2 hr   │ Catches serialization bugs between TS and Noir │
  ├─────────────────────────────────────────────────────────┼────────┼────────────────────────────────────────────────┤
  │ RedisGameStore test suite (reuse MemoryGameStore tests) │ 1 hr   │ Needs Redis in CI                              │
  ├─────────────────────────────────────────────────────────┼────────┼────────────────────────────────────────────────┤
  │ useCardPacks flow test with mocked contracts            │ 2 hr   │ Complex mocking for moderate value             │
  └─────────────────────────────────────────────────────────┴────────┴────────────────────────────────────────────────┘
