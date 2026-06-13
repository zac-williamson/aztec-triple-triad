# P0 — C2 replay check is owner-blind, breaks all 2-fresh-player games (4.3.1)

Found by playtest attempt 5 (the real bug behind attempts 3/4's misdiagnosis).
**Owner: Lane 1 (circuits + contracts).** Blocks F3 go-live.

## Symptom
P2/the joiner generates 0/4 move proofs, every one failing with
`Card already placed on board`. Winner never reaches 9/9 → settlement times out.
Two fresh players genuinely cannot finish a game on 4.3.1.

## Root cause (verified)
`circuits/game_move/src/main.nr:124-129`:
```noir
// ===== 4b. Verify the card is not already on the board (C2: replay prevention) =====
// Card ids are unique NFTs, so a card can occupy at most one cell. ...
for i in 0..9 {
    assert(board_before[i * 2] != card_id, "Card already placed on board");
}
```
The comment's premise — "card ids are unique NFTs" — is **false**: `STARTER_CARD_IDS = [1,2,3,4,5]`
mints the *same* ids to every player. So P1 places ids 1–5 (5/5 proofs fine); P2 then plays its
ids 1–4, each already on the board from P1 → this owner-blind check rejects all four.
`applyMove` (TS engine) only checks cell-occupancy, so it passes — the divergence only ever
surfaces in the circuit. Added since 4.2 (commits b72cf42 / 47912b8, "C2 prevent card replay
exploit"), which is why phase-1 on the 4.2 merge-base passed.
Board encoding: `board_before[i*2]` = card id, `board_before[i*2+1]` = owner.

## The real invariant to enforce
"Each player may place each of their 5 *committed hand* cards at most once."
The board-presence check is a proxy for that, sound **only if** card ids are globally unique.

## Fix options (Lane 1 to choose — soundness notes are the important part)

- **(a) current-owner-aware check** — reject only if `board_before[i*2]==card_id &&
  board_before[i*2+1]==current_player`. **⚠ UNSOUND — do not ship as-is.** Triple Triad flips
  ownership on capture: if `current_player` has *captured* an opponent's card whose id matches a
  card still in their hand, the board shows that id owned by `current_player`, and (a) will
  *falsely reject* their legitimate hand play. With duplicate decks + captures this is a real,
  reachable state → still game-breaking.

- **(a′) original-owner-aware check** — reject only if a cell has `id==card_id` AND
  `originalOwner==current_player`. **Sound**: capture doesn't change who *first placed* a card, so
  it prevents true replay without false-rejecting captured-id collisions. Cost: the circuit board
  encoding currently carries only (id, owner); you'd add `originalOwner` to the board representation
  → ripples into the board hash and the `game-logic` TS mirror (keep them in lockstep per CLAUDE.md).

- **(b) globally-unique token_ids** — mint unique ids per card so the owner-blind check is genuinely
  sound. Most aligned with "cards are private NFTs," but largest blast radius: decouple token_id from
  card *type*, add a type→art/ranks lookup, and check the card commitment + `card_data` rank lookups
  still work (ranks must key off type, not token_id).

- **(c) move the check to aggregation** — if `process_game`/`aggregate` can see each move's
  (player, card_id) it could assert per-player distinctness and drop the per-move board proxy
  entirely. Only viable if card_id is exposable there without breaking move-proof privacy — you know
  the public/private input layout; rule in or out.

My orchestrator read: (a) is a trap (looks simplest, is unsound). (a′) is the most surgical *sound*
fix; (b) is the "correct NFT model" but heavier. Your call — pick on soundness + blast radius, and
say which in your STATUS.

## Ground rules / acceptance
- A rule change moves the TS engine, the circuits, AND their tests together (CLAUDE.md). Add a test
  that **fails without the fix**: two players with identical decks `[1..5]`, P2 must place its cards
  (incl. after a capture-driven id collision) — proofs must verify.
- Do NOT make the harness sidestep with disjoint decks (would mask the bug) — playtest already
  refused that.
- Compile contracts with `aztec compile`, circuits with `nargo compile`; run TXE tests.
- When done + green, STATUS so I gate-review and merge; playtest then re-runs (attempt 6).
- Note: lane-2's clone fixes (14df546, 0a06e2d) are NOT this fix; they stand on their own merits
  (a correct pre-move board legitimately holds the opponent's cards). Don't revert as part of this.

## Resolution (Lane 1) — per-player placed-slot mask (a variant of c, in-proof state)

Shipped a fifth option instead of (a′): a **per-player placed-hand-slot bitmask** carried as
chained state inside each move proof.

- Each player has a 5-bit mask (`p1_placed`, `p2_placed`). On a move, the placed card is mapped to
  its slot in the mover's committed hand (`prove_hand` enforces distinct hand ids, so the slot is
  unique), and the circuit asserts that slot's bit is unset, then sets it in the end state.
  `circuits/game_move/src/main.nr` §4b (`:141-163`), masks threaded through `hash_board_state`.
- **Sound**: directly enforces the real invariant ("each player places each committed hand card at
  most once") rather than the board-presence proxy.
- **Capture-immune**: masks track *placement*, never board ownership, so the (a) capture trap is
  structurally impossible — a captured card whose id matches a hand card cannot false-reject.
- **Duplicate-deck-immune**: masks are per player, so shared `STARTER_CARD_IDS=[1..5]` are fine.
- **Lowest blast radius vs (a′)**: board encoding stays `(id, owner)` and the public-input count
  stays 6 (masks fold into the existing start/end state hashes, not new public inputs), so
  `process_game`/recursive verification is untouched. The masks are two extra *private* inputs to
  `game_move` plus two extra fields in the state-hash preimage (21 → 23).

**Tests (all green).**
- Circuit (`game_move`, 29 tests): added `test_duplicate_deck_p2_plays_shared_id` and
  `test_duplicate_deck_p2_plays_captured_collision` (identical decks `[1..5]`, P2 plays a shared id
  incl. after a capture flips that id onto P2's side). Verified **failing-first**: both fail under a
  temporarily re-inserted owner-blind scan, pass with the mask. `test_card_replay_rejected` still
  rejects a true same-slot replay.
- TS engine (`game-logic`, 40 tests): added two mirror tests. The engine was already correct (it
  addresses cards by hand slot and the board by position), so these are regression guards that lock
  the engine in lockstep with the circuit, not a behavior change.

**Cross-lane (Lane 2 frontend) — REQUIRED before this fix works end to end.** The state-hash
preimage and `game_move`'s private inputs changed, so the browser prover must match:
1. `packages/frontend/src/aztec/proofWorker.ts` `computeBoardStateHash` — append `p1_placed`,
   `p2_placed` to the pedersen preimage (21 → 23 fields).
2. `generateGameMoveProof` — accept before-masks, compute after-masks (set the mover's placed slot
   bit), pass them to both `computeBoardStateHash` calls and add `p1_placed_before`/
   `p2_placed_before` to the witness map.
3. The move-proof caller (`hooks/useProofGeneration.ts` / `useGamePlay.ts`) must track each player's
   placed-slot bitmask across the game (slot = index in the *committed* 5-card hand) and chain it:
   move *i*'s after-masks are move *i+1*'s before-masks; first move's before-masks are `(0,0)`.
4. `useGameSettlement.ts` initial-state hash (`:781`) must pass `0, 0` for the masks.
5. Update the Lane 2 hash mirror tests (`proofWorker.test.ts`, `proofIntegration.test.ts`).
Details mirrored into `docs/plan/LANE_2_FRONTEND.md`.
