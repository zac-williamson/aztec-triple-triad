# Campaign: multi-game-with-packs (C-multi) — Zac's priority

**Why:** historically a *single* game works but playing *multiple consecutive* games raises
many errors (state carryover, note-discovery, session/proof-chain reuse across games). This
campaign exists to surface that class of bug. Real proofs, real UI clicks (testkit), three-layer
validation — same rigor as C1.

## Flow

**Setup:** two fresh players, Alice + Bob, each onboarded with the 5 starter cards.

**Pack open (both):** each player opens ONE card pack → +10 cards → **15 cards each**. Validate
post-pack: each player's on-chain card count is 15 (5 starter + 10 pack), and the menu/board UI
reflects 15. (Card-pack flow uses `create_and_push_note` → the frontend must `import_note` per
card; assert the new cards are actually discoverable, not just minted.)

**Then play FIVE consecutive games** (same Alice + Bob, same session). For EACH game i in 1..5:
1. One player **creates** a game wagering a chosen card; the other **joins** wagering theirs.
   Assert the game is created on-chain (both players see `status: playing`).
2. Play the game to completion via the **real UI** (full move sequence, real hand+move proofs,
   relayed P2P) — alternate who wins across the five games so both the win and loss paths are
   exercised more than once.
3. Settle on-chain (`process_game`) and assert it **succeeds** (the wagered card transfers).
4. **VALIDATE after each game (all three layers):**
   - **Chain:** game settled; the winner's card count went +1, the loser's −1; the specific
     wagered token moved owner; both players' game bindings released (can start the next game).
   - **Token economy:** balances match the expected ledger after this game's wager/reward.
   - **Frontend state:** the menu shows each player's correct post-game card count and the result;
     no stale board/proof state leaks into game i+1.
   - **No carryover:** game i+1's create starts from a clean slate (no leftover move proofs,
     hand proofs, pendingMoves, masks/owners, or session mappings from game i).

## Acceptance

- All five games create + settle green, with per-game state correct. Report a per-game table
  (game #, winner, card counts before/after, settle ok?).
- If it breaks (expected, per Zac), STOP at the first failing game and report: which game #, which
  layer, the exact error, and the suspected carryover source (with file:line if you can localize) —
  route candidates: frontend session/proof state reset (lane-2), backend room/session lifecycle
  (lane-4), or note-discovery across games (lane-1/2).
- Do NOT sidestep by resetting the whole stack between games — the point is consecutive games in one
  session. A fresh-stack-per-game run would mask the bug.

## Reuse

Build on the existing harness (`packages/playtest/src/player.ts`, `chain.ts`, `expected.ts`,
testkit). Add as a new spec (e.g. `tests/multi-game.spec.ts`). The C1 ladder-with-pack fixture in
`docs/plan/CAMPAIGN_BACKLOG.md` §C1 is the closest reference for the economics ladder.
