/// Prove Hand circuit.
/// Proves that a player owns 5 specific cards without revealing which ones.
/// Commits to card IDs, their ranks, and nullifier secrets.
/// Also derives a Grumpkin ECDH public key for encrypted communication.
///
/// Public inputs:
///   card_commit - hash commitment of the player's hand (includes ranks)
///   player_address - the player's Aztec address (as Field)
///   game_id - unique game identifier
///   grumpkin_public_key_x - x-coordinate of player's Grumpkin public key
///   grumpkin_public_key_y - y-coordinate of player's Grumpkin public key
///
/// Private inputs:
///   player_secret - player's secret key (used to bind commitment to player)
///   card_ids - the 5 card token IDs
///   card_ranks - ranks for each of the 5 cards [top, right, bottom, left]
///   card_nullifier_secrets - 5 nullifier secrets for each card
///   grumpkin_private_key - player's Grumpkin private key for ECDH
///
/// Commitment format (33 fields):
///   hash(player_secret, player_address, game_id,
///        card_ids[5],
///        card_ranks[0..4], card_ranks[1..4], ..., card_ranks[4..4],
///        nullifier_secrets[5])

use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, multi_scalar_mul};

/// Grumpkin generator point G
global G: EmbeddedCurvePoint = EmbeddedCurvePoint {
    x: 0x083e7911d835097629f0067531fc15cafd79a89beecb39903f69572c636f4a5a,
    y: 0x1a7f5efaad7f315c25a918f30cc8d7333fccab7ad7c90f14de81bcc528f9935d,
    is_infinite: false,
};

/// Derive Grumpkin public key from private key: pub_key = private_key * G
fn derive_public_key(private_key: Field) -> EmbeddedCurvePoint {
    multi_scalar_mul([G], [EmbeddedCurveScalar::from_field(private_key)])
}

/// Hardcoded card rank database: 50 cards with ranks [top, right, bottom, left].
/// Index 0 is unused (card IDs are 1-50).
fn get_card_ranks(card_id: u32) -> [Field; 4] {
    // Card ranks: [top, right, bottom, left]
    // Index 0 = dummy for 1-based card IDs
    assert((card_id >= 1) & (card_id <= 50), "Invalid card ID for rank lookup");

    // Level 1 cards (IDs 1-10)
    if card_id == 1 { [1, 4, 1, 5] }        // Geezard
    else if card_id == 2 { [5, 1, 1, 3] }    // Funguar
    else if card_id == 3 { [1, 3, 3, 5] }    // Bite Bug
    else if card_id == 4 { [6, 1, 1, 2] }    // Red Bat
    else if card_id == 5 { [2, 3, 1, 5] }    // Blobra
    else if card_id == 6 { [2, 1, 4, 4] }    // Gayla
    else if card_id == 7 { [1, 5, 4, 1] }    // Gesper
    else if card_id == 8 { [3, 1, 5, 2] }    // Fastitocalon-F
    else if card_id == 9 { [2, 1, 6, 1] }    // Blood Soul
    else if card_id == 10 { [4, 3, 2, 4] }   // Caterchipillar
    // Level 2 cards (IDs 11-20)
    else if card_id == 11 { [2, 6, 1, 6] }   // Cockatrice
    else if card_id == 12 { [7, 1, 3, 1] }   // Grat
    else if card_id == 13 { [6, 2, 2, 3] }   // Buel
    else if card_id == 14 { [5, 3, 3, 4] }   // Mesmerize
    else if card_id == 15 { [6, 1, 4, 3] }   // Glacial Eye
    else if card_id == 16 { [3, 4, 5, 3] }   // Belhelmel
    else if card_id == 17 { [5, 3, 2, 5] }   // Thrustaevis
    else if card_id == 18 { [5, 1, 3, 5] }   // Anacondaur
    else if card_id == 19 { [5, 2, 5, 2] }   // Creeps
    else if card_id == 20 { [4, 2, 4, 5] }   // Grendel
    // Level 3 cards (IDs 21-30)
    else if card_id == 21 { [3, 7, 2, 5] }   // Jelleye
    else if card_id == 22 { [5, 2, 5, 5] }   // Grand Mantis
    else if card_id == 23 { [6, 6, 3, 3] }   // Forbidden
    else if card_id == 24 { [6, 3, 6, 3] }   // Armadodo
    else if card_id == 25 { [3, 5, 5, 5] }   // Tri-Face
    else if card_id == 26 { [7, 5, 1, 3] }   // Fastitocalon
    else if card_id == 27 { [7, 1, 5, 3] }   // Snow Lion
    else if card_id == 28 { [5, 3, 6, 3] }   // Ochu
    else if card_id == 29 { [5, 6, 2, 4] }   // SAM08G
    else if card_id == 30 { [4, 4, 7, 2] }   // Death Claw
    // Level 4 cards (IDs 31-40)
    else if card_id == 31 { [3, 6, 4, 7] }   // Tonberry
    else if card_id == 32 { [7, 2, 3, 7] }   // Abyss Worm
    else if card_id == 33 { [2, 3, 7, 7] }   // Turtapod
    else if card_id == 34 { [6, 5, 5, 5] }   // Vysage
    else if card_id == 35 { [4, 7, 6, 2] }   // T-Rexaur
    else if card_id == 36 { [2, 3, 7, 8] }   // Bomb
    else if card_id == 37 { [1, 7, 6, 4] }   // Blitz
    else if card_id == 38 { [7, 3, 1, 6] }   // Wendigo
    else if card_id == 39 { [7, 4, 4, 4] }   // Torama
    else if card_id == 40 { [3, 7, 3, 6] }   // Imp
    // Level 5 cards (IDs 41-50)
    else if card_id == 41 { [6, 7, 3, 7] }   // Blue Dragon
    else if card_id == 42 { [6, 5, 8, 4] }   // Abadon
    else if card_id == 43 { [6, 5, 6, 6] }   // Iron Giant
    else if card_id == 44 { [3, 6, 7, 8] }   // Behemoth
    else if card_id == 45 { [7, 6, 5, 6] }   // Chimera
    else if card_id == 46 { [3, 10, 2, 1] }  // PuPu
    else if card_id == 47 { [6, 2, 6, 7] }   // Elastoid
    else if card_id == 48 { [5, 5, 7, 6] }   // GIM47N
    else if card_id == 49 { [7, 7, 4, 2] }   // Malboro
    else { [7, 2, 7, 4] }                    // Ruby Dragon (card_id == 50)
}

/// Compute the card commitment hash from all hand data including ranks.
/// Format: hash(player_secret, player_address, game_id,
///              card_ids[5], card_ranks[5*4], nullifier_secrets[5])
/// Total: 33 fields
fn compute_card_commit(
    player_secret: Field,
    player_address: Field,
    game_id: Field,
    card_ids: [Field; 5],
    card_ranks: [[Field; 4]; 5],
    nullifier_secrets: [Field; 5],
) -> Field {
    let mut hash_inputs: [Field; 33] = [0; 33];
    hash_inputs[0] = player_secret;
    hash_inputs[1] = player_address;
    hash_inputs[2] = game_id;
    for i in 0..5 {
        hash_inputs[3 + i] = card_ids[i];
    }
    for i in 0..5 {
        for j in 0..4 {
            hash_inputs[8 + i * 4 + j] = card_ranks[i][j];
        }
    }
    for i in 0..5 {
        hash_inputs[28 + i] = nullifier_secrets[i];
    }
    std::hash::pedersen_hash(hash_inputs)
}

fn main(
    // Public inputs
    card_commit: pub Field,
    player_address: pub Field,
    game_id: pub Field,
    grumpkin_public_key_x: pub Field,
    grumpkin_public_key_y: pub Field,
    // Private inputs
    player_secret: Field,
    card_ids: [Field; 5],
    card_ranks: [[Field; 4]; 5],
    card_nullifier_secrets: [Field; 5],
    grumpkin_private_key: Field,
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

    // 2. Verify provided card ranks match the hardcoded card database
    for i in 0..5 {
        let expected_ranks = get_card_ranks(card_ids[i] as u32);
        for j in 0..4 {
            assert(
                card_ranks[i][j] == expected_ranks[j],
                "Card ranks do not match database",
            );
        }
    }

    // 3. Verify all ranks are in valid range (1-10)
    for i in 0..5 {
        for j in 0..4 {
            let rank = card_ranks[i][j] as u32;
            assert(rank >= 1, "Rank must be >= 1");
            assert(rank <= 10, "Rank must be <= 10");
        }
    }

    // 4. Compute the card commitment and verify
    let computed_commit = compute_card_commit(
        player_secret,
        player_address,
        game_id,
        card_ids,
        card_ranks,
        card_nullifier_secrets,
    );
    assert(computed_commit == card_commit, "Card commitment mismatch");

    // 5. Derive Grumpkin public key and verify it matches public inputs (FIX-3)
    let computed_pubkey = derive_public_key(grumpkin_private_key);
    assert(computed_pubkey.x == grumpkin_public_key_x, "Grumpkin public key X mismatch");
    assert(computed_pubkey.y == grumpkin_public_key_y, "Grumpkin public key Y mismatch");
}

// ====================== TESTS ======================

/// Helper to compute card_commit in tests
fn test_compute_commit(
    player_secret: Field,
    player_address: Field,
    game_id: Field,
    card_ids: [Field; 5],
    card_ranks: [[Field; 4]; 5],
    nullifier_secrets: [Field; 5],
) -> Field {
    compute_card_commit(player_secret, player_address, game_id, card_ids, card_ranks, nullifier_secrets)
}

/// Helper to derive Grumpkin public key for tests
fn test_derive_pubkey(private_key: Field) -> EmbeddedCurvePoint {
    derive_public_key(private_key)
}

#[test]
fn test_prove_hand() {
    let player_secret: Field = 12345;
    let player_address: Field = 0xabcdef;
    let game_id: Field = 1;
    let card_ids: [Field; 5] = [1, 2, 3, 4, 5];
    let card_ranks: [[Field; 4]; 5] = [
        [1, 4, 1, 5],  // Geezard
        [5, 1, 1, 3],  // Funguar
        [1, 3, 3, 5],  // Bite Bug
        [6, 1, 1, 2],  // Red Bat
        [2, 3, 1, 5],  // Blobra
    ];
    let nullifier_secrets: [Field; 5] = [100, 200, 300, 400, 500];
    let grumpkin_private_key: Field = 42;

    let commit = test_compute_commit(
        player_secret, player_address, game_id,
        card_ids, card_ranks, nullifier_secrets,
    );

    let pubkey = test_derive_pubkey(grumpkin_private_key);

    main(
        commit, player_address, game_id,
        pubkey.x, pubkey.y,
        player_secret, card_ids, card_ranks, nullifier_secrets,
        grumpkin_private_key,
    );
}

#[test]
fn test_prove_hand_high_card_ids() {
    let player_secret: Field = 99999;
    let player_address: Field = 0x1234567890;
    let game_id: Field = 42;
    let card_ids: [Field; 5] = [46, 47, 48, 49, 50];
    let card_ranks: [[Field; 4]; 5] = [
        [3, 10, 2, 1],  // PuPu
        [6, 2, 6, 7],   // Elastoid
        [5, 5, 7, 6],   // GIM47N
        [7, 7, 4, 2],   // Malboro
        [7, 2, 7, 4],   // Ruby Dragon
    ];
    let nullifier_secrets: [Field; 5] = [1000, 2000, 3000, 4000, 5000];
    let grumpkin_private_key: Field = 7777;

    let commit = test_compute_commit(
        player_secret, player_address, game_id,
        card_ids, card_ranks, nullifier_secrets,
    );

    let pubkey = test_derive_pubkey(grumpkin_private_key);

    main(
        commit, player_address, game_id,
        pubkey.x, pubkey.y,
        player_secret, card_ids, card_ranks, nullifier_secrets,
        grumpkin_private_key,
    );
}

#[test]
fn test_prove_hand_level4_cards() {
    let player_secret: Field = 55555;
    let player_address: Field = 0xbeef;
    let game_id: Field = 7;
    let card_ids: [Field; 5] = [31, 32, 33, 34, 35];
    let card_ranks: [[Field; 4]; 5] = [
        [3, 6, 4, 7],  // Tonberry
        [7, 2, 3, 7],  // Abyss Worm
        [2, 3, 7, 7],  // Turtapod
        [6, 5, 5, 5],  // Vysage
        [4, 7, 6, 2],  // T-Rexaur
    ];
    let nullifier_secrets: [Field; 5] = [10, 20, 30, 40, 50];
    let grumpkin_private_key: Field = 12345678;

    let commit = test_compute_commit(
        player_secret, player_address, game_id,
        card_ids, card_ranks, nullifier_secrets,
    );

    let pubkey = test_derive_pubkey(grumpkin_private_key);

    main(
        commit, player_address, game_id,
        pubkey.x, pubkey.y,
        player_secret, card_ids, card_ranks, nullifier_secrets,
        grumpkin_private_key,
    );
}

#[test]
fn test_grumpkin_key_derivation() {
    // Verify that different private keys produce different public keys
    let pk1 = test_derive_pubkey(1);
    let pk2 = test_derive_pubkey(2);
    assert(pk1.x != pk2.x, "Different private keys should give different public keys");
}

#[test(should_fail_with = "Card ID must be >= 1")]
fn test_fail_card_id_zero() {
    let player_secret: Field = 12345;
    let player_address: Field = 0xabcdef;
    let game_id: Field = 1;
    let card_ids: [Field; 5] = [0, 2, 3, 4, 5];
    let card_ranks: [[Field; 4]; 5] = [
        [0, 0, 0, 0],
        [5, 1, 1, 3],
        [1, 3, 3, 5],
        [6, 1, 1, 2],
        [2, 3, 1, 5],
    ];
    let nullifier_secrets: [Field; 5] = [100, 200, 300, 400, 500];
    let grumpkin_private_key: Field = 42;

    let commit = test_compute_commit(
        player_secret, player_address, game_id,
        card_ids, card_ranks, nullifier_secrets,
    );
    let pubkey = test_derive_pubkey(grumpkin_private_key);

    main(
        commit, player_address, game_id,
        pubkey.x, pubkey.y,
        player_secret, card_ids, card_ranks, nullifier_secrets,
        grumpkin_private_key,
    );
}

#[test(should_fail_with = "Card ID must be <= 50")]
fn test_fail_card_id_too_high() {
    let player_secret: Field = 12345;
    let player_address: Field = 0xabcdef;
    let game_id: Field = 1;
    let card_ids: [Field; 5] = [1, 2, 3, 4, 51];
    let card_ranks: [[Field; 4]; 5] = [
        [1, 4, 1, 5],
        [5, 1, 1, 3],
        [1, 3, 3, 5],
        [6, 1, 1, 2],
        [0, 0, 0, 0],
    ];
    let nullifier_secrets: [Field; 5] = [100, 200, 300, 400, 500];
    let grumpkin_private_key: Field = 42;

    let commit = test_compute_commit(
        player_secret, player_address, game_id,
        card_ids, card_ranks, nullifier_secrets,
    );
    let pubkey = test_derive_pubkey(grumpkin_private_key);

    main(
        commit, player_address, game_id,
        pubkey.x, pubkey.y,
        player_secret, card_ids, card_ranks, nullifier_secrets,
        grumpkin_private_key,
    );
}

#[test(should_fail_with = "Duplicate card IDs not allowed")]
fn test_fail_duplicate_card_ids() {
    let player_secret: Field = 12345;
    let player_address: Field = 0xabcdef;
    let game_id: Field = 1;
    let card_ids: [Field; 5] = [1, 2, 3, 4, 1];
    let card_ranks: [[Field; 4]; 5] = [
        [1, 4, 1, 5],
        [5, 1, 1, 3],
        [1, 3, 3, 5],
        [6, 1, 1, 2],
        [1, 4, 1, 5],
    ];
    let nullifier_secrets: [Field; 5] = [100, 200, 300, 400, 500];
    let grumpkin_private_key: Field = 42;

    let commit = test_compute_commit(
        player_secret, player_address, game_id,
        card_ids, card_ranks, nullifier_secrets,
    );
    let pubkey = test_derive_pubkey(grumpkin_private_key);

    main(
        commit, player_address, game_id,
        pubkey.x, pubkey.y,
        player_secret, card_ids, card_ranks, nullifier_secrets,
        grumpkin_private_key,
    );
}

#[test(should_fail_with = "Card commitment mismatch")]
fn test_fail_wrong_commitment() {
    let player_secret: Field = 12345;
    let player_address: Field = 0xabcdef;
    let game_id: Field = 1;
    let card_ids: [Field; 5] = [1, 2, 3, 4, 5];
    let card_ranks: [[Field; 4]; 5] = [
        [1, 4, 1, 5],
        [5, 1, 1, 3],
        [1, 3, 3, 5],
        [6, 1, 1, 2],
        [2, 3, 1, 5],
    ];
    let nullifier_secrets: [Field; 5] = [100, 200, 300, 400, 500];
    let grumpkin_private_key: Field = 42;
    let pubkey = test_derive_pubkey(grumpkin_private_key);

    let wrong_commit: Field = 0xdeadbeef;

    main(
        wrong_commit, player_address, game_id,
        pubkey.x, pubkey.y,
        player_secret, card_ids, card_ranks, nullifier_secrets,
        grumpkin_private_key,
    );
}

#[test(should_fail_with = "Card ranks do not match database")]
fn test_fail_wrong_card_ranks() {
    let player_secret: Field = 12345;
    let player_address: Field = 0xabcdef;
    let game_id: Field = 1;
    let card_ids: [Field; 5] = [1, 2, 3, 4, 5];
    let card_ranks: [[Field; 4]; 5] = [
        [10, 10, 10, 10],  // WRONG ranks for Geezard
        [5, 1, 1, 3],
        [1, 3, 3, 5],
        [6, 1, 1, 2],
        [2, 3, 1, 5],
    ];
    let nullifier_secrets: [Field; 5] = [100, 200, 300, 400, 500];
    let grumpkin_private_key: Field = 42;

    let commit = test_compute_commit(
        player_secret, player_address, game_id,
        card_ids, card_ranks, nullifier_secrets,
    );
    let pubkey = test_derive_pubkey(grumpkin_private_key);

    main(
        commit, player_address, game_id,
        pubkey.x, pubkey.y,
        player_secret, card_ids, card_ranks, nullifier_secrets,
        grumpkin_private_key,
    );
}

#[test(should_fail_with = "Grumpkin public key X mismatch")]
fn test_fail_wrong_grumpkin_pubkey() {
    let player_secret: Field = 12345;
    let player_address: Field = 0xabcdef;
    let game_id: Field = 1;
    let card_ids: [Field; 5] = [1, 2, 3, 4, 5];
    let card_ranks: [[Field; 4]; 5] = [
        [1, 4, 1, 5],
        [5, 1, 1, 3],
        [1, 3, 3, 5],
        [6, 1, 1, 2],
        [2, 3, 1, 5],
    ];
    let nullifier_secrets: [Field; 5] = [100, 200, 300, 400, 500];
    let grumpkin_private_key: Field = 42;

    let commit = test_compute_commit(
        player_secret, player_address, game_id,
        card_ids, card_ranks, nullifier_secrets,
    );

    // Use wrong public key (from a different private key)
    let wrong_pubkey = test_derive_pubkey(99);

    main(
        commit, player_address, game_id,
        wrong_pubkey.x, wrong_pubkey.y,
        player_secret, card_ids, card_ranks, nullifier_secrets,
        grumpkin_private_key,
    );
}
