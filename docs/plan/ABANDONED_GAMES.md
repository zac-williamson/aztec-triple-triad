# Abandoned-game handling — permissionless, with clean UX (June 2026)

**Goal (Zac):** a player abandons (no move in 60s) → frontend warns BOTH players → the
non-abandoning player triggers dispute resolution AND resolves it (a smart-contract delay
allows disputes to be contested + resolved) → claims a card from the abandoner if any cards
were played (if none played, both recover their original cards). Permissionless. Clean UX.
**Deliverable:** an E2E playtest of exactly this.

## KEY FINDING — this is ~80% already built (investigation, two Explore agents)

### Already exists (REUSE, do not rebuild)
- **Contract `packages/contracts/triple_triad_game/src/main.nr`:**
  - `claim_abandoned_game` (`:256-416`): verifies 2 hand proofs + 1-8 real move proofs + dummy
    padding (`circuits/dummy_move`, zero-constraint), validates partial chain + genesis, **opponent-turn
    parity check** (`:388-394`, can't claim on your own turn), records `game_claim_player` +
    `game_claim_block = context.block_number()`, status → `5` (abandoned_claimed).
  - `settle_abandoned_game` (`:427-534`): enforces **dispute window** `current_block - claim_block >= 5`
    (`~60s`, `:511-513`); claimant re-mints their 5 cards + claims 1 opponent card (`claimed_card_id != 0`)
    OR both recover (`claimed_card_id == 0` → opponent's cards minted to public ownership); status → `3`.
  - Game statuses (`:98`): 0 none,1 created,2 active,3 settled,4 cancelled,**5 abandoned_claimed**.
  - Time primitive: `context.block_number()` (no timestamp/DelayedPublicMutable used).
- **Frontend `packages/frontend/src/hooks/useGameSettlement.ts`:**
  - `handleAbandonedGame()` (`:483-707`): prove hand + dummy moves → `claim_abandoned_game` → wait the
    65s dispute window → `settle_abandoned_game`. Returns `{ isClaimingAbandoned, abandonedDisputeCountdown }`.
  - **Currently auto-triggered only on `ws.opponentDisconnected && moves played`** (`:700-707`).
- **Backend**: network disconnect detection (`OPPONENT_DISCONNECTED`, 60s reconnect window, keeps the game
  for recovery); `room.lastActivity` updated on `PLACE_CARD`; note relay + ws buffering.

### Missing (BUILD — the 20%)
1. **Backend — present-but-idle detection.** Today abandonment only fires on a network **disconnect**.
   Need a **per-move 60s inactivity timer**: track `room.lastMoveTimestamp`; in the cleanup interval (or a
   tighter timer) detect `now - lastMoveTimestamp >= 60s` while `status==='playing'`, and broadcast a
   warning to BOTH players. Add the message type + add it to `BUFFERED_MESSAGE_TYPES`.
2. **Frontend — warn both + wire the claim.** Handle the warning: show both players an "opponent isn't
   moving / you may forfeit" banner with a live countdown; give the NON-idle player a "Claim abandoned game"
   action that calls the existing `handleAbandonedGame()` — i.e. extend its trigger from
   `opponentDisconnected` to also "60s-no-move warning" (opponent present but idle). Surface
   `abandonedDisputeCountdown` during the contract dispute window.
3. **(Phase 2) Contract — contestable disputes (counter-claim).** The dispute window currently only DELAYS
   settlement; the abandoner cannot yet CONTEST by submitting their move during the window. For full
   "disputes can be contested" + permissionless robustness, add `counter_claim_abandoned_game` (abandoner
   submits a strictly-longer valid move chain during the window → updates claimant/claim_block or invalidates
   the false claim). Listed in FUTURE_IMPROVEMENTS. **Not required for the Phase-1 playtest** (genuine
   abandonment, abandoner does not contest) but required for the complete feature.

## Message contract (backend ↔ frontend — both build to this)
- Server→Client (BUFFERED): `GAME_ABANDONMENT_WARNING { gameId, idlePlayer: 'player1'|'player2',
  secondsIdle, secondsUntilClaimable }` — broadcast to both players when the player-whose-turn-it-is has not
  moved for >=60s. Re-sent/updated as the window progresses; cleared if a move arrives.
- Frontend reaction: if I am NOT `idlePlayer` → show "opponent isn't moving" + countdown + enable
  "Claim abandoned game" (→ `handleAbandonedGame()`); if I AM `idlePlayer` → show "move now or forfeit".

## Decisions (made autonomously — no blocking questions)
- **Reuse** the existing contract claim/settle + the frontend `handleAbandonedGame()`; Phase 1 is detection +
  warning + UX-wiring + a playtest. **No contract change in Phase 1** → ideally **no testnet redeploy**
  (VERIFY the deployed contract already exposes claim/settle_abandoned_game; redeploy only if missing).
- **60s** no-move threshold (matches the contract's ~60s/5-block window + the existing 60s disconnect window).
- Backend changes require a **box redeploy** (`deploy/update-backend.sh`) before the harness can exercise
  them (the harness drives the live relay). Frontend changes → Vercel.
- **Draw IS possible** (corrected) — the existing draw branch stays.

## Build order
- **Phase 1 (playtest target):** backend inactivity timer + warning → frontend warn-both + wire claim →
  box+Vercel redeploy → harness playtest: P1 stops moving 60s → both warned → P2 triggers
  `claim_abandoned_game` → waits the on-chain dispute window → `settle_abandoned_game` → P2 claims a card
  (or both recover if 0 moves) → verify on-chain (status `3` via abandonment, card transferred / both recovered).
- **Phase 2 (full robustness):** `counter_claim_abandoned_game` (contestable) + UX + redeploy + a contest playtest.

## Verify EARLY
- Does the DEPLOYED testnet game contract expose `claim_abandoned_game` / `settle_abandoned_game`? (If the
  testnet deploy predates these functions, a fresh `deploy-testnet.ts` redeploy is needed before any playtest.)
