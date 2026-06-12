# Lane 5 — QA & Release Validation

Branch `lane/5-qa` · Worktree `worktrees/lane-5-qa`
Owns: `docs/plan/CAMPAIGN_BACKLOG.md`, acceptance sign-offs, release smoke tests.
This lane CONSUMES the playtest harness (built by Lane 8) — it does not build it.

## Mission
Be the gate: nothing version-critical merges without a green real-proof harness run,
and the live deployment doesn't ship without a clean smoke pass. Until the harness
lands, convert tribal testing knowledge into an executable campaign backlog.

## Sequence

### Now (before harness Phase 1 lands): CAMPAIGN_BACKLOG.md (1–2d)
Write the campaign specs Lane 8 will implement — each with setup, steps, and the
three-layer assertions (frontend / backend / chain-public / chain-private). Minimum
set:
1. **ladder-with-pack** (Zac's scenario): 4 games, winner-takes-card validated each
   time, open pack (+10 cards, −100 tokens), play again.
2. Draw game → both keep cards, draw settlement path (`settle_game_draw`).
3. Abandoned game: opponent quits after N moves → claim with dummy-proof padding →
   5-block dispute window → settle; claimant +1 card +20 tokens, opponent's
   remainder to public ownership.
4. Cancel unjoined game → cards re-minted to creator.
5. Mid-game disconnect + RESUME within grace period → game continues; buffered
   inbox messages (proofs) replay correctly.
6. Settlement race: loser navigates to menu before winner settles → loser still
   receives post-settle cards (the `settlementInfoRef` bug class).
7. Pack purchase with insufficient tokens → clean rejection, no state change.
8. New-player onboarding: fresh account → starter cards 1–5 + 100 tokens.
9. Token economy over a session: balances exact after N games + M packs.
10. Two concurrent games (4 players) → no cross-game state bleed in backend/relay.

### After harness Phase 1: acceptance duty
- Run real-proof acceptance before Lane 1/2 merge A1 and A2 (this is the upgrade's
  safety net). Sign off in the PR.
- Own nightly real-proof CI results: triage failures (Playwright trace, video,
  console, PXE logs, state dumps), file findings against the owning lane.

### At F3: release smoke
Per DEPLOY.md: two browsers against the LIVE site, full game with settlement on
real testnet, plus campaign #8 (onboarding) against production endpoints.
Verify COOP/COEP headers on Vercel (SharedArrayBuffer/WASM proving breaks silently
without them).

## Cross-lane contracts
- **Provide:** campaign specs (→8), merge sign-offs (→1,2), bug reports (→all).
- **Consume:** harness + artifacts (←8), live endpoints (←4,6).

## Constraints
- Real-proof runs are slow (~30–60 min per campaign) — schedule them, don't block
  interactive work on them. Fast-mode green is necessary but NOT sufficient for
  version-bump merges.

## ASSUMPTIONS
Discovered while writing CAMPAIGN_BACKLOG.md (2026-06-12). Full detail with
file:line evidence lives in CAMPAIGN_BACKLOG.md §5; one line each here.

- **QA-A1**: opponent-hand sanitization hiding only the last 2 of 5 hand slots
  (`HIDDEN_COUNT = 2`, server.ts:194) is intended design, not a privacy leak.
- **QA-A2**: note-nonce delta is +6 per player per game (gameRandomness is
  `[Field; 6]`) — fixture determinism depends on it; unconfirmed in
  `commit_five_nfts_create/join` (open question #6 → Lane 1).
- **QA-A3**: sandbox blocks advance only on txs, so C3's dispute-window wait is
  `advanceBlocks(5)` via cheat-code or filler txs, never wall-clock.
- **QA-A4**: C5 pins the current 60s disconnect grace (server.ts:14); work item
  G must not change behavior within that window. C5b is spec'd only after G.
- **Hand-size invariant** (drives C1/C9 design): a 5-card player who loses a
  game drops to 4 cards and cannot field the next game — consecutive-game
  campaigns must script outcomes and schedule pack purchases
  (CAMPAIGN_BACKLOG.md §1.5).
- **Fast-mode blind spot**: with dummy VKs, `claim_abandoned_game`'s
  real-vs-dummy VK discrimination collapses — C3 fidelity requires real-proof
  mode, in addition to the known proof-format-drift blind spot.

Findings filed against other lanes during this work: QA-F1 (onboarding
double-claim unguarded on-chain → Lane 1), QA-F2 ("3 test assertion fixes" in
work item G look already-fixed → Lane 4 verify), QA-F3 (abandoned-claim never
releases the backend room → Lane 4 + Lane 2). Detail: CAMPAIGN_BACKLOG.md §5.
