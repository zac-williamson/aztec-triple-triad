# Lane 4 — Backend (relay server, ops)

Branch `lane/4-backend` · Worktree `worktrees/lane-4-backend`
Owns: `packages/backend/`, `deploy/`.
The backend has ZERO Aztec dependencies — this lane is never blocked by the upgrade.

## Mission
Close the known robustness gaps, give the house bot its matchmaking hook, and own
the Lightsail side of go-live.

## Sequence

### G — Session staleness + test fixes (0.5–1d) — START HERE
FUTURE_IMPROVEMENTS.md (2026-04-15) is the spec, implement all four points:
1. Enforce `lastSeen` on RESUME — reject sessions older than `SESSION_STALE_MS`
   (24h), create fresh session, log it.
2. Give MemoryGameStore session TTL parity with Redis (2h) — or delete the memory
   path in favor of Redis-only.
3. Add `cleanupStaleSessions` to the 5-minute cleanup loop (currently only games +
   queue are swept).
4. If `lastSeen` stays, wire it everywhere; if not, delete the dead field.
Plus: fix the 3 failing hand-sanitization tests in `server.test.ts` — they assert
all 5 opponent cards hidden; the server intentionally hides only the last 2
(indices 3–4). Test bug, not server bug.
Also un-skip and triage the 30 skipped backend tests (handshake/matchmaking detail).

### QA-F3 — abandoned-settlement room release (backend half) — DONE 2026-06-12
Backend gap (CAMPAIGN_BACKLOG.md §5, QA-F3): abandoned games never reached the
GAME_OVER path, so `releasePlayersFromGame` never ran and the claimant stayed
bound to the dead room until the 30-min sweep, blocking new games (C3's L2
assertion).

Fix: new client→server message **`ABANDONED_GAME_SETTLED { gameId }`**, sent by
the claimant after `settle_abandoned_game` is mined. The server
(`GameManager.settleAbandonedGame`) marks the room finished with the sender as
winner, releases BOTH players' bindings, and emits a standard `GAME_OVER` to
the sender and (if connected) the opponent. Idempotent: duplicate reports
re-send `GAME_OVER` and keep the first reporter as winner. The room itself
persists until the stale sweep, same as normal finishes, so `/games/{id}` and
`GET_GAME` report `finished` + winner in the interim.

**Frontend half (→Lane 2) — expected client flow:**
- In the `settle_abandoned_game` `postEffects` (`useGame.ts:1780`, after
  `importNotes`), send `{ type: 'ABANDONED_GAME_SETTLED', gameId: ws.gameId }`.
  Send it ONLY after the settle tx is mined — the message means "settled",
  not "settling"; the server unbinds both players the moment it arrives.
- The server replies with a standard `GAME_OVER` (winner = claimant's role,
  board not full). The claimant's UI is already past the game screen, so this
  must be a no-op there; a reconnected-mid-window opponent receives the same
  `GAME_OVER` live and their UI should accept it mid-board.
- An `ERROR 'Game not found'` reply is benign (room already swept after a
  >30-min claim flow; the bindings were swept with it) — ignore it.
- Optional parity: also send `SETTLE_STARTED { gameId, selectedCardId:
  claimedCardId }` (computed at `useGame.ts:1761`) when the abandoned settle
  begins, so an offline opponent's inbox gets the buffered
  `OPPONENT_SETTLING` card info, same as the normal settle flow.

**Lane 8 note:** one additive client→server type (`ABANDONED_GAME_SETTLED`);
server→client vocabulary unchanged; `/games/{id}` can now report
`finished`/winner for abandoned games.

### D2 hook — bot matchmaking trigger (0.5d) — when Lane 3 starts D2
Flag-gated (`BOT_ENABLED`): expose queue-wait-time signal; when a human waits > N
seconds, notify the bot service (or let the bot poll `/health`-style endpoint).
Keep the server agnostic — the bot is just another WS client.

### F3 (Lightsail half) — go-live ops (0.5–1d) — after A3
Per `deploy/DEPLOY.md`: provision instance ($5 Ubuntu 22.04, static IP), run
`provision-lightsail.sh`, DNS `ws.<domain>` (Zac provides domain), `certbot --nginx`,
configure `triad-backend.env` (`ALLOWED_ORIGINS` = Vercel domain, `REDIS_URL`),
start systemd unit. Smoke: `/health` over TLS, WS upgrade through nginx.
Search-replace `YOURDOMAIN`/`YOURUSER` placeholders across `deploy/*` once the real
domain exists.

## Cross-lane contracts
- **Provide:** queue-wait hook (→3), live backend endpoint (→6's Vercel env, →8's
  staging campaigns), `/games/{id}` state endpoint stability (→8 validators).
- **Consume:** nothing hard. Coordinate message-type additions with Lane 8 (they
  assert on backend state) and Lane 2 (useWebSocket consumes the protocol).

## Constraints
- Don't change the WS message protocol shape without flagging Lanes 2 and 8 —
  buffered-inbox semantics (HAND_PROOF, MOVE_PROVEN, NOTE_DATA, OPPONENT_SETTLING,
  OPPONENT_AZTEC_INFO) are load-bearing for offline players.
- Keep the backend Aztec-free. Anything chain-aware belongs in `packages/bot/`.

## ASSUMPTIONS

### Item G — session staleness (2026-06-12)

- **The "3 failing hand-sanitization tests" were already fixed** in `4403e2e`
  (2026-04-17): assertions match the server's HIDDEN_COUNT=2 (first 3 visible,
  last 2 hidden) and the suite was green at fork point. The brief was stale on
  this; no test changes were needed.
- **The 30 skipped tests are the entire RedisGameStore suite**, gated on
  `describe.skipIf(!REDIS_URL)` — environment-gated by design, not broken.
  Verified 33/33 green (incl. 3 new sweep tests) against a local
  `redis-server --port 6390` on 2026-06-12. CI could un-gate them with a Redis
  service container (Lane 6, E3a/E3b).
- **Memory store kept** (spec offered "or delete the memory path"): the whole
  test suite and `npm run dev` run storeless; Redis-only would force a
  redis-server onto every contributor and CI job. TTL parity chosen instead.
- **PING refreshes the session** — interpreted as part of "wire `lastSeen`
  everywhere". Without it, a client connected continuously for >2h never
  slides its session TTL (RESUME is the only other refresh) and loses the
  session on its next blip — a real pre-existing bug under Redis.
- **The 24h RESUME check is defense-in-depth and normally unreachable**: both
  stores now expire sessions at 2h idle, so the 24h branch only fires if TTL
  semantics drift. Tested by injecting a `sessionTtlMs: Infinity` store.
- **`createdAt` stays** as write-only debugging metadata; the spec only
  condemned `lastSeen` as dead state.
- **playerId↔sessionToken is 1:1 for life** (fresh uuid pair per session,
  never re-bound), so deleting a stale session's reverse mapping is safe; the
  store sweep still guards with a points-at-this-token check so synthetic
  test states behave precisely.
- **No protocol change**: stale-RESUME rejection reuses the existing
  `SESSION_ESTABLISHED { resumed: false }` path, and `useWebSocket.ts`
  unconditionally overwrites its stored token on that message — no Lane 2/8
  coordination required.

### QA-F3 backend half — abandoned-settlement release (2026-06-12)

- **Trust model**: the relay accepts `ABANDONED_GAME_SETTLED` from either room
  member without chain verification — consistent with `TX_CONFIRMED` /
  `SETTLE_STARTED`, which are equally unverified. The reported winner only
  affects the off-chain room mirror; cards and rewards are decided on-chain.
  Verifying would require making the backend Aztec-aware, which the lane
  constraints forbid.
- **An offline opponent gets no buffered GAME_OVER** — `GAME_OVER` is not in
  `BUFFERED_MESSAGE_TYPES`, and this is pre-existing behavior for NORMAL
  finishes too (an offline loser's GAME_OVER is dropped; their mapping is
  already released). After an abandoned settle, the returning opponent
  resumes unbound (`gameId: null`) and learns the outcome from the chain
  (C3's L4-P2 assertion checks exactly that way). Adding GAME_OVER to the
  buffered set would be a protocol-semantics change for Lanes 2+8 to weigh —
  filed as a finding, deliberately not done here.
- **The room is not deleted on abandoned settle**, only marked finished and
  unbound — identical to the normal-finish lifecycle, so `/games/{id}`
  stays truthful for ~30 min and a mid-window reconnecting opponent gets a
  coherent finished-room RESUME instead of a vanished game.
- **GAME_LIFECYCLE_SPEC.md does not cover the WS relay protocol** (it specs
  contract functions; it never mentions the abandoned WS flow), so no spec
  doc required updating — `packages/backend/src/types.ts` is the protocol's
  source of truth.
