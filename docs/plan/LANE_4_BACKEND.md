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
