# Future Improvements

## ~~Backend session staleness (2026-04-15)~~ — RESOLVED 2026-06-12 (Lane 4, item G)

All four recommended fixes landed on `lane/4-backend`:

1. RESUME now rejects sessions whose `lastSeen` is older than `SESSION_STALE_MS`
   (24h), deletes them, logs the rejection, and issues a fresh session
   (`server.ts`, defense-in-depth behind the store TTL).
2. `MemoryGameStore` enforces the shared `SESSION_TTL_MS` (2h) — lazily on
   `getSession` plus via the periodic sweep. The memory path was kept (tests and
   local dev depend on it); Redis derives its key TTL from the same constant.
3. `cleanupStaleSessions` is part of the `GameStore` contract (both stores) and
   runs in the periodic cleanup loop alongside games and queue.
4. `lastSeen` is now load-bearing: read by the RESUME check, the lazy TTL, and
   the sweep — and refreshed on PING so a long-lived connection's session
   cannot expire out from under it mid-game.

## Full settlement E2E test (2026-04-16)

The stale-closure bug where `handleSettle`'s `useCallback` captured a ws object from an earlier render (leaving `ws.opponentCardIds` empty at settle time) was not caught by any unit test. The reason: to catch it via a unit test, you have to execute `handleSettle` all the way to the point where it reads ws state in the backfill code, which requires populating the hook's internal state: `phase === 'active'`, both hand proofs, `settlementInfoRef`, and 9 move proofs.

Populating all of that through the public interface requires a full flow: mocked contracts + proof generation + 9 `handlePlaceCard` calls with synthesized board states + `ws.lastMoveProof` updates for opponent moves + ws state updates for each GAME_STATE broadcast. That's an E2E test, not a unit test.

**Recommended: Playwright test that plays a real 9-move game end-to-end.** Two browser contexts, real backend, matchmaking, full settlement. This would catch any integration bug across useGame, useWebSocket, txManager, and the Aztec contract interactions — not just the stale closure fix. The existing `useGame.settleFlow.test.ts` gets us partway (correct stateful ws mock, verifies memoization invariants) but cannot substitute for true E2E coverage.

The test file also includes a comment block clearly documenting what the unit test covers vs. what requires E2E.
