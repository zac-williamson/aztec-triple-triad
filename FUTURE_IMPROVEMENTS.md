# Future Improvements

## Abandoned-game counter-claim (2026-06-12)

The 5-block dispute window after `claim_abandoned_game`
(`packages/contracts/triple_triad_game/src/main.nr:491-494`) currently protects
against exactly one attack: a false abandonment claim against a *finished* game,
which the accused defeats by running `process_game` inside the window
(`settle_game` gates on the `game_settled` flag only, `main.nr:761-762`; the
abandonment settle then fails its `!settled` assert, `main.nr:496-497`).

There is no recourse for a false claim *mid-game*: a counter-claim presenting a
longer valid move chain is impossible because `claim_abandoned_game_public`
requires status `active` (`main.nr:385-386`), which the first claim already
consumed. A fix would allow a counter-claim while status is `abandoned_claimed`
that supersedes the original iff it presents strictly more valid moves, resetting
the dispute clock. Until then, the dispute window is a delay, not a remedy, for
mid-game disputes. See `docs/ARCHITECTURE.md` §8.

## Backend session staleness (2026-04-15)

The current session system has gaps in how staleness is detected:

- **`SessionData.lastSeen` is dead data.** Stored on create/RESUME but never read by any code path. No comparison or expiry check uses it.
- **MemoryGameStore has no session TTL.** Only Redis sessions auto-expire (2h). In-memory sessions persist forever until explicit `deleteSession`.
- **No `cleanupStaleSessions` in the periodic cleanup loop.** The 5-minute cleanup runs `cleanupStaleGames` and `cleanupStaleQueue` but not sessions.
- **RESUME accepts any session returned by `getSession`.** No check that the session is "fresh" (e.g., `lastSeen` within 24h). After a server crash, a 2-hour-old session with a stale `clients` map gap is accepted unconditionally.

**Recommended fixes:**

1. Enforce `lastSeen` on RESUME — reject sessions older than `SESSION_STALE_MS` (e.g., 24h), create a new session instead, log the event.
2. Add session TTL equivalent to MemoryGameStore (match Redis 2h behavior) or remove the memory path in favor of Redis-only.
3. Add `cleanupStaleSessions` to the `CLEANUP_INTERVAL_MS` loop.
4. If `lastSeen` is kept, wire it into all the above. If we decide not to use it, delete the field from `SessionData` rather than leave dead state.

## Full settlement E2E test (2026-04-16)

The stale-closure bug where `handleSettle`'s `useCallback` captured a ws object from an earlier render (leaving `ws.opponentCardIds` empty at settle time) was not caught by any unit test. The reason: to catch it via a unit test, you have to execute `handleSettle` all the way to the point where it reads ws state in the backfill code, which requires populating the hook's internal state: `phase === 'active'`, both hand proofs, `settlementInfoRef`, and 9 move proofs.

Populating all of that through the public interface requires a full flow: mocked contracts + proof generation + 9 `handlePlaceCard` calls with synthesized board states + `ws.lastMoveProof` updates for opponent moves + ws state updates for each GAME_STATE broadcast. That's an E2E test, not a unit test.

**Recommended: Playwright test that plays a real 9-move game end-to-end.** Two browser contexts, real backend, matchmaking, full settlement. This would catch any integration bug across useGame, useWebSocket, txManager, and the Aztec contract interactions — not just the stale closure fix. The existing `useGame.settleFlow.test.ts` gets us partway (correct stateful ws mock, verifies memoization invariants) but cannot substitute for true E2E coverage.

The test file also includes a comment block clearly documenting what the unit test covers vs. what requires E2E.
