# Future Improvements

## ~~Abandoned-game counter-claim (2026-06-12)~~ — RESOLVED 2026-09-11

The original entry: the dispute window protected only against a false claim on a
*finished* game, and a mid-game false claim had no recourse, because a
counter-claim presenting a longer chain was impossible once the first claim had
consumed the `active` status.

Two things landed instead of the counter-claim as described.

**`contest_abandonment`** lets either player object inside `DISPUTE_SECONDS`
(600s) with no proof at all, returning the game to active and restarting the
abandonment clock. Cheaper than a longer-chain counter-claim and strictly more
available: an honest player who is merely slow does not have to prove anything,
and one who cannot prove a longer chain (because they have no moves yet) is not
locked out.

**F9's fix** covers the finished-game case properly. The old defence — settle
inside the window — rested on `settle_game` gating on the `settled` flag alone,
and that gap was closed when complete games became claimable, because a claimed
game still reads as unsettled. Settlement is now explicitly accepted from status
5 while neither player has recovered, so a verified nine-move transcript
outranks a claim whatever `n` the claimant chose. A claim-time check could not
substitute: the claimant simply truncates, and no contract can distinguish a
truncated prefix from a genuinely unfinished game.

**What remains, and why it is not the same problem.** Contest is once per player,
so an attacker who claims, absorbs the contest, waits out the restarted hour and
claims again leaves the honest player nothing to answer with. For a FINISHED
game that no longer costs anything — the winner settles instead. For a MID-GAME
claim there is no transcript to settle with, so the game unwinds into per-player
recovery: each side re-mints its own five cards and nothing changes hands. The
cost is the game, not the cards. Worth revisiting if abandonment claims ever get
cheaper or cards ever carry real value; not worth a second proof-carrying code
path now.

See `docs/ARCHITECTURE.md` §8.

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
