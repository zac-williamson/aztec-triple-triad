use crate::compute_initial_state_hash;

// Regression guard for the C2 replay fix. Settlement anchors move[0]'s
// start_state to the contract's canonical initial-state hash; that hash must use
// the SAME preimage as game_move's `hash_board_state` for an empty board, or the
// first move never matches and process_game/claim_abandoned_game revert with
// "First move start_state does not match initial state".
//
// History: pre-C2 the preimage was 21 fields (board + scores + turn). The first
// C2 attempt added two private placed-slot masks (23 fields) -- abandoned because
// the masks couldn't agree across async peers (BUG_C2_REPLAY_2). The shipped fix
// uses an original-owner check: 9 per-cell original owners ride in the preimage
// (30 fields), all 0 for the empty board. This test pins the 30-field form and
// rejects both prior forms, without needing real recursive proofs.
#[test]
fn initial_state_hash_matches_empty_board_30_field_preimage() {
    // Empty board (18 zero cells), scores [5, 5], current_turn 1, and 9 original
    // owners all 0 -- exactly what the circuit hashes for an unplayed game.
    let mut expected_inputs: [Field; 30] = [0; 30];
    expected_inputs[18] = 5;
    expected_inputs[19] = 5;
    expected_inputs[20] = 1;
    // expected_inputs[21..30] = original owners = 0 (empty board)
    let expected = std::hash::pedersen_hash(expected_inputs);
    assert(
        compute_initial_state_hash() == expected,
        "initial-state anchor must equal the 30-field empty-board hash",
    );
}

#[test]
fn initial_state_hash_rejects_pre_c2_21_field_preimage() {
    // The pre-C2 anchor hashed only 21 fields. It MUST differ.
    let mut legacy_inputs: [Field; 21] = [0; 21];
    legacy_inputs[18] = 5;
    legacy_inputs[19] = 5;
    legacy_inputs[20] = 1;
    let legacy = std::hash::pedersen_hash(legacy_inputs);
    assert(
        compute_initial_state_hash() != legacy,
        "initial-state anchor must not match the pre-C2 21-field hash",
    );
}

#[test]
fn initial_state_hash_rejects_abandoned_mask_23_field_preimage() {
    // The abandoned chained-mask design hashed 23 fields (two placed masks). A
    // revert to it would reintroduce the cross-peer chain break -- catch it.
    let mut mask_inputs: [Field; 23] = [0; 23];
    mask_inputs[18] = 5;
    mask_inputs[19] = 5;
    mask_inputs[20] = 1;
    let mask_hash = std::hash::pedersen_hash(mask_inputs);
    assert(
        compute_initial_state_hash() != mask_hash,
        "initial-state anchor must not match the abandoned 23-field mask hash",
    );
}
