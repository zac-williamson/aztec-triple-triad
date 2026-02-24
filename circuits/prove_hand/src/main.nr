/// Prove Hand circuit.
/// Proves that a player owns 5 specific cards without revealing which ones.
///
/// Public inputs:
///   card_commit - hash commitment of the player's hand
///   player_address - the player's Aztec address (as Field)
///   game_id - unique game identifier
///
/// Private inputs:
///   player_secret - player's secret key (used to bind commitment to player)
///   card_ids - the 5 card token IDs
///   card_nullifier_secrets - 5 nullifier secrets for each card

fn commit_hash(inputs: [Field; 13]) -> Field {
    std::hash::pedersen_hash(inputs)
}

fn main(
    // Public inputs
    card_commit: pub Field,
    player_address: pub Field,
    game_id: pub Field,
    // Private inputs
    player_secret: Field,
    card_ids: [Field; 5],
    card_nullifier_secrets: [Field; 5],
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

    // 2. Compute the card commitment
    let mut hash_inputs: [Field; 13] = [0; 13];
    hash_inputs[0] = player_secret;
    hash_inputs[1] = player_address;
    hash_inputs[2] = game_id;
    for i in 0..5 {
        hash_inputs[3 + i] = card_ids[i];
    }
    for i in 0..5 {
        hash_inputs[8 + i] = card_nullifier_secrets[i];
    }

    let computed_commit = commit_hash(hash_inputs);
    assert(computed_commit == card_commit, "Card commitment mismatch");
}

#[test]
fn test_prove_hand() {
    let player_secret: Field = 12345;
    let player_address: Field = 0xabcdef;
    let game_id: Field = 1;
    let card_ids: [Field; 5] = [1, 2, 3, 4, 5];
    let nullifier_secrets: [Field; 5] = [100, 200, 300, 400, 500];

    let mut hash_inputs: [Field; 13] = [0; 13];
    hash_inputs[0] = player_secret;
    hash_inputs[1] = player_address;
    hash_inputs[2] = game_id;
    for i in 0..5 {
        hash_inputs[3 + i] = card_ids[i];
    }
    for i in 0..5 {
        hash_inputs[8 + i] = nullifier_secrets[i];
    }
    let commit = commit_hash(hash_inputs);

    main(commit, player_address, game_id, player_secret, card_ids, nullifier_secrets);
}

#[test]
fn test_prove_hand_high_card_ids() {
    // Test with card IDs near the maximum (50)
    let player_secret: Field = 99999;
    let player_address: Field = 0x1234567890;
    let game_id: Field = 42;
    let card_ids: [Field; 5] = [46, 47, 48, 49, 50];
    let nullifier_secrets: [Field; 5] = [1000, 2000, 3000, 4000, 5000];

    let mut hash_inputs: [Field; 13] = [0; 13];
    hash_inputs[0] = player_secret;
    hash_inputs[1] = player_address;
    hash_inputs[2] = game_id;
    for i in 0..5 {
        hash_inputs[3 + i] = card_ids[i];
    }
    for i in 0..5 {
        hash_inputs[8 + i] = nullifier_secrets[i];
    }
    let commit = commit_hash(hash_inputs);

    main(commit, player_address, game_id, player_secret, card_ids, nullifier_secrets);
}

#[test(should_fail_with = "Card ID must be >= 1")]
fn test_fail_card_id_zero() {
    let player_secret: Field = 12345;
    let player_address: Field = 0xabcdef;
    let game_id: Field = 1;
    let card_ids: [Field; 5] = [0, 2, 3, 4, 5]; // card_id 0 is invalid
    let nullifier_secrets: [Field; 5] = [100, 200, 300, 400, 500];

    let mut hash_inputs: [Field; 13] = [0; 13];
    hash_inputs[0] = player_secret;
    hash_inputs[1] = player_address;
    hash_inputs[2] = game_id;
    for i in 0..5 {
        hash_inputs[3 + i] = card_ids[i];
    }
    for i in 0..5 {
        hash_inputs[8 + i] = nullifier_secrets[i];
    }
    let commit = commit_hash(hash_inputs);

    main(commit, player_address, game_id, player_secret, card_ids, nullifier_secrets);
}

#[test(should_fail_with = "Card ID must be <= 50")]
fn test_fail_card_id_too_high() {
    let player_secret: Field = 12345;
    let player_address: Field = 0xabcdef;
    let game_id: Field = 1;
    let card_ids: [Field; 5] = [1, 2, 3, 4, 51]; // card_id 51 is invalid
    let nullifier_secrets: [Field; 5] = [100, 200, 300, 400, 500];

    let mut hash_inputs: [Field; 13] = [0; 13];
    hash_inputs[0] = player_secret;
    hash_inputs[1] = player_address;
    hash_inputs[2] = game_id;
    for i in 0..5 {
        hash_inputs[3 + i] = card_ids[i];
    }
    for i in 0..5 {
        hash_inputs[8 + i] = nullifier_secrets[i];
    }
    let commit = commit_hash(hash_inputs);

    main(commit, player_address, game_id, player_secret, card_ids, nullifier_secrets);
}

#[test(should_fail_with = "Duplicate card IDs not allowed")]
fn test_fail_duplicate_card_ids() {
    let player_secret: Field = 12345;
    let player_address: Field = 0xabcdef;
    let game_id: Field = 1;
    let card_ids: [Field; 5] = [1, 2, 3, 4, 1]; // duplicate card_id 1
    let nullifier_secrets: [Field; 5] = [100, 200, 300, 400, 500];

    let mut hash_inputs: [Field; 13] = [0; 13];
    hash_inputs[0] = player_secret;
    hash_inputs[1] = player_address;
    hash_inputs[2] = game_id;
    for i in 0..5 {
        hash_inputs[3 + i] = card_ids[i];
    }
    for i in 0..5 {
        hash_inputs[8 + i] = nullifier_secrets[i];
    }
    let commit = commit_hash(hash_inputs);

    main(commit, player_address, game_id, player_secret, card_ids, nullifier_secrets);
}

#[test(should_fail_with = "Card commitment mismatch")]
fn test_fail_wrong_commitment() {
    let player_secret: Field = 12345;
    let player_address: Field = 0xabcdef;
    let game_id: Field = 1;
    let card_ids: [Field; 5] = [1, 2, 3, 4, 5];
    let nullifier_secrets: [Field; 5] = [100, 200, 300, 400, 500];

    let wrong_commit: Field = 0xdeadbeef; // wrong commitment

    main(wrong_commit, player_address, game_id, player_secret, card_ids, nullifier_secrets);
}
