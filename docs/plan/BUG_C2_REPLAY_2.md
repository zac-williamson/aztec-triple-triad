# P0 (round 2) — the C2 chained-mask approach is fundamentally broken; replace it

Playtest attempt 6 (instrumented, not inferred) cleared EVERY prior blocker — P2 move
proofs 4/4 clean, 9/9 submitted, canSettle reached, settlement starts — then failed
**client-side at proof-chain assembly**: `Error: Proof chain broken at step 1 (sortProofChain)`.
**Owner: Lane 1 (circuit + contract) leads; Lane 2 (prover) follows.** This is the LAST blocker.

## Evidence (hard, from instrumentation)
- Step 0 = P1 move 0: `endStateHash=…3117`, `p1_placed_after=1`.
- Step 1 needs a proof with `startStateHash=…3117`. P2's move-1 proof encodes `p1_placed=0`.
- Across P2's proofs the P1-mask value is `0,0,0,7` — P2 only learns P1's mask move-by-move from
  relayed proofs, **always lagging**.

## Root cause — why the mask design can't work (and why my earlier gate review was wrong)
The C2 fix folds **per-player placed-slot masks** into the shared, chained 23-field state hash.
But a player's mask is **privately derived** from its own committed-hand-slot usage; the opponent
learns it **only via the async-relayed move proof** (`useGamePlay.ts:261`). So P1's `endStateHash`
(real P1 mask) never equals P2's `startStateHash` (stale P1 mask) at the P1→P2 boundary — the
chain is unassemblable. My review assumed `MOVE_PROVEN` (gameState+moveProof) being atomic meant
P2 always had P1's latest mask before proving; the instrumented `0,0,0,7` shows it does not.
**Putting privately-derived per-player state into a hash that must agree across async peers cannot
work.** Don't try to patch the ordering — drop the approach.

## Required fix
1. **Revert the chained masks**: remove `p1_placed`/`p2_placed` from `hash_board_state` (23→back to
   the prior field count), the move-circuit private inputs, the contract `compute_initial_state_hash`,
   and the frontend prover (Lane 2). The board-state hash must again contain only publicly-agreed
   state.
2. **Replace C2 replay-prevention with a SOUND, SELF-CONTAINED move-circuit check** (no cross-player
   chaining). The playtest proposed "the placed card isn't already on a cell owned by
   `current_player`" — ⚠ that uses the cell's **current owner**, which is the **finding-19 capture
   trap**: if `current_player` captured an opponent's same-id card, that cell is now owned by
   `current_player` while the player legitimately still holds its own copy in hand → **false reject**
   (reachable with duplicate decks + capture). Do NOT ship current-owner.

   **Recommended — (a′) original-owner check.** Reject iff a cell has `id == card_id` AND
   `originalOwner == current_player`. Sound: capture never changes who FIRST placed a card, so it
   blocks true replay without false-rejecting captured-id collisions. Add `originalOwner` to the
   move-circuit board encoding. **Key point: `originalOwner` is publicly-agreed** — both peers see
   every placement and derive it identically from the board, so unlike the private masks it is safe
   in the shared chained hash (no divergence). Public-input count stays 6 (originalOwner rides in the
   board preimage, like masks did, but it actually agrees across peers).

   **Alternative — (agg) aggregate distinctness.** Expose `card_id` as a move public input (cards are
   already visible once placed) and have `process_game` assert per-player (by move-index parity)
   distinct card_ids. No board-encoding change, but it grows move public inputs 6→7 (ripples into
   `process_game` parsing + `dummy_move`'s signature). Your call vs (a′) on blast radius.

3. **Coordinate the whole change**: circuit + `dummy_move` (if (agg)) + contract
   `compute_initial_state_hash` + Lane-2 prover (`proofWorker.computeBoardStateHash`,
   `generateGameMoveProof`, `useGamePlay` — drop the mask chaining entirely) + TS engine, all in
   lockstep. Spec the Lane-2 changes in `LANE_2_FRONTEND.md` as you did last round.

## Tests / acceptance
- Keep finding-19's duplicate-deck + capture-collision circuit tests passing (they're the soundness
  guard for the replacement). Add/confirm a test that the **proof chain assembles** across the
  P1↔P2 boundary (the thing that just broke) — i.e. consecutive moves' state hashes agree without
  any per-player private state in them.
- When done + green, STATUS → I gate-review + merge → playtest attempt 7.

## Good news
Attempt 6 proved EVERYTHING ELSE works on 4.3.1: deploy fee headroom, P2 proofs 4/4, 9/9 submitted,
canSettle, settlement starts. This chain-assembly fix is the last blocker before the full 2-player
game completes end-to-end. The playtest also fixed a harness gap in-lane (syncs public/ circuit+
contract artifacts from target/ before serving — committed public/contracts was stale post-C2-merge).

## Resolution (Lane 1) — original-owner check (a′), masks fully reverted

Took the recommended (a′). The chained masks are gone; replay prevention is now a self-contained,
publicly-agreed check.

**Circuit (`game_move`)**
- `hash_board_state` preimage: dropped `p1_placed`/`p2_placed`; added `original_owners[9]` (one per
  cell). Layout `[board[18], scores[2], current_turn, original_owners[9]]` = **30 fields** (was 23).
- `main`: dropped `p1_placed_before`/`p2_placed_before`; added `original_owners_before/after: [Field; 9]`.
- §4b replay check: `reject iff board_before[i].id == card_id && original_owners_before[i] == current_player`.
- New frame-rule asserts: placed cell's `original_owner_after == current_player`; every non-placed
  cell's `original_owner` is immutable; the placed cell was empty in all three lanes (id, owner,
  original_owner). Public-input count stays **6**.
- Why sound + why it chains: `original_owner` is set once at placement and never moves on capture, so
  (i) true replay is caught even after the card is captured back and forth, and (ii) a captured
  same-id card (original_owner = opponent) does NOT false-reject the mover's own copy — the finding-19
  trap. Both peers derive `original_owner` identically from the public move sequence, so P1's
  `end_state_hash` == P2's `start_state_hash` at the boundary (the thing that broke).

**Contract** — `compute_initial_state_hash` 23 → **30** fields (empty board ⇒ all original_owners 0);
both anchors already call the shared helper. Regression test updated to pin 30 and reject BOTH the
21-field (pre-C2) and 23-field (mask-era) forms.

**Tests (all green)**
- `game_move` 30/30: finding-19 duplicate-deck + capture-collision retained and **passing under the
  new check**; empirically re-confirmed failing-first — a temporary swap to a *current*-owner check
  makes the capture-collision test FAIL (the exact trap). Added
  `test_proof_chain_assembles_across_player_boundary`: asserts P2's independently-derived
  `start_state_hash` equals P1's `end_state_hash` with no private state — the round-2 acceptance.
- `triple_triad_game` TXE 9/9; `game-logic` 40/40 (engine already tracks `originalOwner`, unchanged).

**Lane 2 (prover) — REQUIRED, spec in LANE_2_FRONTEND.md note 28.** Revert the masks and mirror the
30-field hash + original-owners; details there. Not end-to-end until Lane 2 lands it (same merge).

**Lane 2 — DONE (2026-06-13), see LANE_2_FRONTEND.md note 31.** Masks reverted; prover mirrors the
30-field hash + `original_owners_before/after` (derived from the shared board snapshot — no chaining,
no relay). `useGamePlay` lost all mask state. `proofIntegration.test.ts` updated to the real 30-field
circuit + a P1→P2 boundary chain-assembly assertion + a finding-19 duplicate-deck capture-collision
positive test (a current-owner check would false-reject it). Full frontend suite green (311/311), tsc
clean. Ready for gate-review + playtest attempt 7.
