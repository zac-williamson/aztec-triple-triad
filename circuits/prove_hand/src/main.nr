/// Prove Hand circuit.
/// Proves that a player owns 5 specific cards without revealing which ones.
/// Commits to card IDs using poseidon2 hash with a blinding factor.
/// Also proves knowledge of the opponent's player_state_hash preimage,
/// which constrains the randomness the opponent committed to for note re-creation.
///
/// Public inputs:
///   card_commit_hash - poseidon2 hash commitment of the player's hand
///   opponent_player_state_hash - poseidon2 hash of opponent's 6 randomness values
///
/// Private inputs:
///   card_ids - the 5 card token IDs
///   blinding_factor - blinding factor (poseidon2_hash([nhk_app_secret, contract_address, game_id]))
///   opponent_randomness - the opponent's 6 randomness values (preimage of opponent_player_state_hash)
///
/// Commitment format (6 fields):
///   poseidon2_hash([card_ids[0], card_ids[1], card_ids[2], card_ids[3], card_ids[4], blinding_factor])

use poseidon::poseidon2::Poseidon2;

fn main(
    // Public inputs
    card_commit_hash: pub Field,
    opponent_player_state_hash: pub Field,
    // Private inputs
    card_ids: [Field; 5],
    blinding_factor: Field,
    opponent_randomness: [Field; 6],
) {
    // 1. Verify all card IDs are valid (1-50) and unique
    for i in 0..5 {
        let id = card_ids[i] as u32;
        assert(id >= 1, "Card ID must be >= 1");
        assert(id <= 50, "Card ID must be <= 50");

        // Check uniqueness against all subsequent cards
        for j in (i + 1)..5 {
            assert(card_ids[i] != card_ids[j], "Duplicate card IDs not allowed");
        }
    }

    // 2. Compute commitment and verify it matches the public input
    let mut to_hash: [Field; 6] = [0; 6];
    for i in 0..5 {
        to_hash[i] = card_ids[i];
    }
    to_hash[5] = blinding_factor;
    let computed_commit = Poseidon2::hash(to_hash, 6);
    assert(computed_commit == card_commit_hash, "Card commitment mismatch");

    // 3. Verify opponent_player_state_hash preimage
    // This proves the prover knows the opponent's 6 randomness values,
    // which constrains what randomness can be used during settlement.
    let computed_opponent_state = Poseidon2::hash(opponent_randomness, 6);
    assert(
        computed_opponent_state == opponent_player_state_hash,
        "Opponent player state hash mismatch",
    );
}

// ====================== TESTS ======================

/// Helper to compute card_commit_hash in tests
fn test_compute_commit(card_ids: [Field; 5], blinding_factor: Field) -> Field {
    let mut to_hash: [Field; 6] = [0; 6];
    for i in 0..5 {
        to_hash[i] = card_ids[i];
    }
    to_hash[5] = blinding_factor;
    Poseidon2::hash(to_hash, 6)
}

/// Helper to compute player_state_hash in tests
fn test_compute_state_hash(randomness: [Field; 6]) -> Field {
    Poseidon2::hash(randomness, 6)
}

#[test]
fn test_prove_hand() {
    let card_ids: [Field; 5] = [1, 2, 3, 4, 5];
    let blinding_factor: Field = 12345;
    let opponent_randomness: [Field; 6] = [100, 200, 300, 400, 500, 600];

    let commit = test_compute_commit(card_ids, blinding_factor);
    let opp_state = test_compute_state_hash(opponent_randomness);

    main(commit, opp_state, card_ids, blinding_factor, opponent_randomness);
}

#[test]
fn test_prove_hand_high_card_ids() {
    let card_ids: [Field; 5] = [46, 47, 48, 49, 50];
    let blinding_factor: Field = 99999;
    let opponent_randomness: [Field; 6] = [11, 22, 33, 44, 55, 66];

    let commit = test_compute_commit(card_ids, blinding_factor);
    let opp_state = test_compute_state_hash(opponent_randomness);

    main(commit, opp_state, card_ids, blinding_factor, opponent_randomness);
}

#[test]
fn test_prove_hand_level4_cards() {
    let card_ids: [Field; 5] = [31, 32, 33, 34, 35];
    let blinding_factor: Field = 55555;
    let opponent_randomness: [Field; 6] = [1, 2, 3, 4, 5, 6];

    let commit = test_compute_commit(card_ids, blinding_factor);
    let opp_state = test_compute_state_hash(opponent_randomness);

    main(commit, opp_state, card_ids, blinding_factor, opponent_randomness);
}

#[test]
fn test_prove_hand_mixed_levels() {
    let card_ids: [Field; 5] = [1, 15, 25, 35, 50];
    let blinding_factor: Field = 777;
    let opponent_randomness: [Field; 6] = [999, 888, 777, 666, 555, 444];

    let commit = test_compute_commit(card_ids, blinding_factor);
    let opp_state = test_compute_state_hash(opponent_randomness);

    main(commit, opp_state, card_ids, blinding_factor, opponent_randomness);
}

#[test(should_fail_with = "Card ID must be >= 1")]
fn test_fail_card_id_zero() {
    let card_ids: [Field; 5] = [0, 2, 3, 4, 5];
    let blinding_factor: Field = 12345;
    let opponent_randomness: [Field; 6] = [1, 2, 3, 4, 5, 6];
    let commit = test_compute_commit(card_ids, blinding_factor);
    let opp_state = test_compute_state_hash(opponent_randomness);

    main(commit, opp_state, card_ids, blinding_factor, opponent_randomness);
}

#[test(should_fail_with = "Card ID must be <= 50")]
fn test_fail_card_id_too_high() {
    let card_ids: [Field; 5] = [1, 2, 3, 4, 51];
    let blinding_factor: Field = 12345;
    let opponent_randomness: [Field; 6] = [1, 2, 3, 4, 5, 6];
    let commit = test_compute_commit(card_ids, blinding_factor);
    let opp_state = test_compute_state_hash(opponent_randomness);

    main(commit, opp_state, card_ids, blinding_factor, opponent_randomness);
}

#[test(should_fail_with = "Duplicate card IDs not allowed")]
fn test_fail_duplicate_card_ids() {
    let card_ids: [Field; 5] = [1, 2, 3, 4, 1];
    let blinding_factor: Field = 12345;
    let opponent_randomness: [Field; 6] = [1, 2, 3, 4, 5, 6];
    let commit = test_compute_commit(card_ids, blinding_factor);
    let opp_state = test_compute_state_hash(opponent_randomness);

    main(commit, opp_state, card_ids, blinding_factor, opponent_randomness);
}

#[test(should_fail_with = "Card commitment mismatch")]
fn test_fail_wrong_commitment() {
    let card_ids: [Field; 5] = [1, 2, 3, 4, 5];
    let blinding_factor: Field = 12345;
    let opponent_randomness: [Field; 6] = [1, 2, 3, 4, 5, 6];
    let wrong_commit: Field = 0xdeadbeef;
    let opp_state = test_compute_state_hash(opponent_randomness);

    main(wrong_commit, opp_state, card_ids, blinding_factor, opponent_randomness);
}

#[test(should_fail_with = "Card commitment mismatch")]
fn test_fail_wrong_blinding_factor() {
    let card_ids: [Field; 5] = [1, 2, 3, 4, 5];
    let blinding_factor: Field = 12345;
    let opponent_randomness: [Field; 6] = [1, 2, 3, 4, 5, 6];
    let commit = test_compute_commit(card_ids, blinding_factor);
    let opp_state = test_compute_state_hash(opponent_randomness);

    // Use wrong blinding factor
    main(commit, opp_state, card_ids, 99999, opponent_randomness);
}

#[test(should_fail_with = "Opponent player state hash mismatch")]
fn test_fail_wrong_opponent_randomness() {
    let card_ids: [Field; 5] = [1, 2, 3, 4, 5];
    let blinding_factor: Field = 12345;
    let opponent_randomness: [Field; 6] = [1, 2, 3, 4, 5, 6];
    let wrong_randomness: [Field; 6] = [99, 98, 97, 96, 95, 94];
    let commit = test_compute_commit(card_ids, blinding_factor);
    let opp_state = test_compute_state_hash(opponent_randomness);

    // Provide wrong opponent randomness
    main(commit, opp_state, card_ids, blinding_factor, wrong_randomness);
}
