use crate::compute_initial_state_hash;

// Regression guard for the C2 fix (BUG_C2_REPLAY). Settlement anchors move[0]'s
// start_state to the contract's canonical initial-state hash; that hash must use
// the SAME preimage as game_move's `hash_board_state` for an empty board, or the
// first move never matches and process_game/claim_abandoned_game revert with
// "First move start_state does not match initial state".
//
// The C2 fix bumped the circuit's preimage from 21 to 23 fields (two per-player
// placed-slot masks). The contract anchor had to follow; one of its two copies
// was missed at first. This test exercises the (now deduplicated) anchor so a
// field-count or layout regression is caught without needing real recursive
// proofs.
#[test]
fn initial_state_hash_matches_empty_board_23_field_preimage() {
    // Empty board (18 zero cells), scores [5, 5], current_turn 1, and both
    // placed-slot masks 0 -- exactly what the circuit hashes for an unplayed game.
    let mut expected_inputs: [Field; 23] = [0; 23];
    expected_inputs[18] = 5;
    expected_inputs[19] = 5;
    expected_inputs[20] = 1;
    // expected_inputs[21] = p1_placed = 0, expected_inputs[22] = p2_placed = 0
    let expected = std::hash::pedersen_hash(expected_inputs);
    assert(
        compute_initial_state_hash() == expected,
        "initial-state anchor must equal the 23-field empty-board hash",
    );
}

#[test]
fn initial_state_hash_rejects_pre_fix_21_field_preimage() {
    // The pre-C2-fix anchor hashed only 21 fields (no masks). It MUST differ, or
    // a partial revert would silently reintroduce the settlement break.
    let mut legacy_inputs: [Field; 21] = [0; 21];
    legacy_inputs[18] = 5;
    legacy_inputs[19] = 5;
    legacy_inputs[20] = 1;
    let legacy = std::hash::pedersen_hash(legacy_inputs);
    assert(
        compute_initial_state_hash() != legacy,
        "initial-state anchor must not match the pre-fix 21-field hash",
    );
}
