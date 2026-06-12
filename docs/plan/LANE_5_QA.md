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
