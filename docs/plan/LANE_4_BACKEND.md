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

### Item I — backend Fee Juice faucet (Option B) — DONE 2026-06-13
ITEM_I_ONBOARDING.md, "Integration scope → Lane 4". `POST /faucet { l2Address } →
{ claim, reused }` bridges Fee Juice from the Sepolia treasury (via the proven
`scripts/lib/feeJuiceBridge`) and returns a consumable claim the frontend feeds
to `deployAndRegister({ feeJuiceClaim })`. The treasury L1 key is server-only and
never enters any response.

Design (keeps the relay Aztec-free — the one ground-rule tension this item
forces, minimized):
- `src/faucet/FaucetService.ts` holds the abuse logic and depends only on an
  injected `FaucetClaimBackend` + local types — zero SDK, fully unit-tested.
  Three caps bound treasury spend: **one claim per L2 address** (reuses the
  existing persistent claim store — pending→returned idempotently, consumed→409),
  **per-IP/day** (`FAUCET_IP_DAILY_LIMIT`, default 5), **global/day**
  (`FAUCET_GLOBAL_DAILY_LIMIT`, default 200 — the "capped mint": per-claim amount
  is fixed on-chain, so capping count caps the mint). Reservations roll back on
  bridge failure so a Sepolia hiccup never burns a user's allowance; an in-flight
  guard stops a double-click double-bridging one address.
- `src/faucet/createTreasuryFaucet.ts` is the ONLY Aztec-touching file, via
  RUNTIME dynamic imports of string-typed specifiers (`FEE_JUICE_BRIDGE_PATH`,
  `@aztec/aztec.js/node`). No static `@aztec` import, no `@aztec` in the backend
  `package.json`, no TS6059 from importing across `scripts/` — `tsc` and the relay
  stay SDK-free. `createServer` only ever sees the `FaucetService` interface.
- Wire it via `FAUCET_ENABLED=true`; if the wiring can't build, the composition
  root logs `[faucet] disabled — <reason>` and runs relay-only (non-gating).

**HTTP wire contract (→Lane 2 consumes; →Lane 8 asserts):**
`POST /faucet` body `{ l2Address: string }` →
- `200 { claim: { l2Address, claimAmount, claimSecret, claimSecretHash,
  messageHash, messageLeafIndex }, reused: boolean }` — all strings; mirrors the
  consumable fields of `scripts/lib/feeJuiceBridge.SerializedClaim`, so Lane 2
  deserializes with the existing `deserializeClaim` (inject `Fr`).
- `400 { error }` malformed/missing address or bad JSON · `409` already funded /
  claim in progress · `429` ip/global rate limited · `413` oversized body ·
  `503 { error: 'bridge_failed' }` → Lane 2 falls back to the manual
  `FundingPrompt`. The first call blocks for the L1→L2 bridge (minutes); a repeat
  returns the same claim instantly with `reused: true`.

**Lane 8 note:** new HTTP route only (`POST /faucet`); WS protocol unchanged.

**Box wiring (F3):** prod runs plain `node` while the bridge module is TS-only —
`FEE_JUICE_BRIDGE_PATH` must point at compiled JS, and the hardened systemd unit
needs `ReadWritePaths` for the private dir. Both documented in
`deploy/DEPLOY.md §2g` + `triad-backend.service`; finishing it on the live box is
F3.

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

### Item I — backend faucet (2026-06-13)

- **The "keep the backend Aztec-free" rule is deliberately bent, not broken.**
  The orchestrator scoped Option B (faucet wraps `bridgeFeeJuice`) to this lane,
  so SOME Aztec touch is unavoidable. It is quarantined to one runtime-only file
  (`createTreasuryFaucet.ts`) behind dynamic imports; the relay's `tsc` build,
  its `package.json`, and all faucet *logic* remain SDK-free and unit-tested.
- **A static import from `scripts/lib/` is impossible** from the backend: TS6059
  (scripts/ is outside the backend `rootDir`), and it would drag `@aztec/*` into
  the relay build. Hence the injected-loader + dynamic-import design. Verified by
  probe.
- **`scripts/lib/feeJuiceBridge.ts` is NOT moved to a shared package.** The doc's
  own `packages/aztec-fee/` proposal would edit Lane 6's `scripts/` and its two
  importers — out of lane for a 0.5d task. The orchestrator's "or import from
  scripts/lib" sanctioned referencing it; the runtime-loader does so without a
  static dependency.
- **Prod loads the bridge as compiled JS, not TS.** The systemd unit runs plain
  `node` (no tsx; `ProtectHome=read-only` blocks npx), so `FEE_JUICE_BRIDGE_PATH`
  must point at transpiled JS and the unit needs `ReadWritePaths` for the claim
  store + key. Documented in `deploy/`; the actual box step is F3. The faucet is
  off by default, so this merge changes nothing until explicitly enabled.
- **Rate limiters are in-memory, single-process.** The hard treasury bound is the
  persistent per-address claim store (survives restart); per-IP/global caps are a
  cost/DoS guard and reset on restart. Fine for one Lightsail box; if scaled out,
  move the counters to Redis (noted in `DailyRateLimiter`).
- **X-Forwarded-For is trusted** because the backend is only reachable via nginx
  in prod. The per-IP cap is a soft guard, not a security boundary — the
  per-address + global caps are the hard limits, so XFF spoofing only costs an
  attacker against the global/day budget.
- **`FaucetClaim` (the HTTP wire type) is the backend's API contract**, not a
  duplicate of the lib's `SerializedClaim`: it carries only the 5 consumable
  fields + address, dropping the internal `status`/`bridgedAt`. The adapter maps
  between them.
- **A `consumed` claim returns 409, not a re-bridge.** Once an account is funded
  + deployed it doesn't need more Fee Juice; a repeat is abuse or confusion. If a
  legit re-fund need ever appears, add an explicit admin path rather than
  loosening this.
- **No live integration test in the suite.** The real bridge needs Sepolia +
  treasury ETH; like `feeJuiceBridge.test.ts`, that path is env-gated. Coverage
  here is the service + HTTP + adapter-mapping with injected fakes (35 tests).

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
