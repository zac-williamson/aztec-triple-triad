/// Prove Hand circuit.
/// Proves that a player owns 5 specific cards without revealing which ones.
/// Commits to card IDs using poseidon2 hash with a blinding factor.
///
/// Public inputs:
///   card_commit_hash - poseidon2 hash commitment of the player's hand
///
/// Private inputs:
///   card_ids - the 5 card token IDs
///   blinding_factor - blinding factor (e.g. poseidon2_hash([nhk_app_secret, contract_address]))
///
/// Commitment format (6 fields):
///   poseidon2_hash([card_ids[0], card_ids[1], card_ids[2], card_ids[3], card_ids[4], blinding_factor])

use poseidon::poseidon2::Poseidon2;

/// Hardcoded card rank database: 50 cards with ranks [top, right, bottom, left].
/// Index 0 is unused (card IDs are 1-50).
fn get_card_ranks(card_id: u32) -> [Field; 4] {
    // Card ranks: [top, right, bottom, left]
    // Index 0 = dummy for 1-based card IDs
    assert((card_id >= 1) & (card_id <= 50), "Invalid card ID for rank lookup");

    // Level 1 - Common (IDs 1-10)
    if card_id == 1 { [1, 4, 1, 5] }        // Mudwalker
    else if card_id == 2 { [5, 1, 1, 3] }    // Blushy
    else if card_id == 3 { [1, 3, 3, 5] }    // Snowdrop
    else if card_id == 4 { [6, 1, 1, 2] }    // Sunny
    else if card_id == 5 { [2, 3, 1, 5] }    // Inkwell
    else if card_id == 6 { [2, 1, 4, 4] }    // Stripes
    else if card_id == 7 { [1, 5, 4, 1] }    // Barkeeper
    else if card_id == 8 { [3, 1, 5, 2] }    // Dotty
    else if card_id == 9 { [2, 1, 6, 1] }    // Penny
    else if card_id == 10 { [4, 3, 2, 4] }   // Peaches
    // Level 2 - Uncommon (IDs 11-20)
    else if card_id == 11 { [2, 6, 1, 6] }   // Freckles
    else if card_id == 12 { [7, 1, 3, 1] }   // Camo
    else if card_id == 13 { [6, 2, 2, 3] }   // Neon
    else if card_id == 14 { [5, 3, 3, 4] }   // Glow Bug
    else if card_id == 15 { [6, 1, 4, 3] }   // Limelight
    else if card_id == 16 { [3, 4, 5, 3] }   // Marble
    else if card_id == 17 { [5, 3, 2, 5] }   // Sapphire
    else if card_id == 18 { [5, 1, 3, 5] }   // Jefferson
    else if card_id == 19 { [5, 2, 5, 2] }   // Longfoot
    else if card_id == 20 { [4, 2, 4, 5] }   // Featherfin
    // Level 3 - Rare (IDs 21-30)
    else if card_id == 21 { [3, 7, 2, 5] }   // Lilac
    else if card_id == 22 { [5, 2, 5, 5] }   // Patches
    else if card_id == 23 { [6, 6, 3, 3] }   // Faded
    else if card_id == 24 { [6, 3, 6, 3] }   // Gold Dust
    else if card_id == 25 { [3, 5, 5, 5] }   // Phantom
    else if card_id == 26 { [7, 5, 1, 3] }   // Ash
    else if card_id == 27 { [7, 1, 5, 3] }   // Cocoa
    else if card_id == 28 { [5, 3, 6, 3] }   // Ringmaster
    else if card_id == 29 { [5, 6, 2, 4] }   // Goldrush
    else if card_id == 30 { [4, 4, 7, 2] }   // Swampling
    // Level 4 - Epic (IDs 31-40)
    else if card_id == 31 { [3, 6, 4, 7] }   // Glitter
    else if card_id == 32 { [7, 2, 3, 7] }   // Starfield
    else if card_id == 33 { [2, 3, 7, 7] }   // Specter
    else if card_id == 34 { [6, 5, 5, 5] }   // Saffron
    else if card_id == 35 { [4, 7, 6, 2] }   // Stardust
    else if card_id == 36 { [2, 3, 7, 8] }   // Achoque
    else if card_id == 37 { [1, 7, 6, 4] }   // Zacapu
    else if card_id == 38 { [7, 3, 1, 6] }   // Laguna
    else if card_id == 39 { [7, 4, 4, 4] }   // Streamwalker
    else if card_id == 40 { [3, 7, 3, 6] }   // Digger
    // Level 5 - Legendary (IDs 41-50)
    else if card_id == 41 { [6, 7, 3, 7] }   // Eclipse
    else if card_id == 42 { [6, 5, 8, 4] }   // Kaleidoscope
    else if card_id == 43 { [6, 5, 6, 6] }   // Twinned
    else if card_id == 44 { [3, 6, 7, 8] }   // Sparkletail
    else if card_id == 45 { [7, 6, 5, 6] }   // Riddler
    else if card_id == 46 { [3, 10, 2, 1] }  // Rosita
    else if card_id == 47 { [6, 2, 6, 7] }   // Brooklet
    else if card_id == 48 { [5, 5, 7, 6] }   // Whisper
    else if card_id == 49 { [7, 7, 4, 2] }   // Misty
    else { [7, 2, 7, 4] }                    // Lerma (card_id == 50)
}

fn main(
    // Public inputs
    card_commit_hash: pub Field,
    // Private inputs
    card_ids: [Field; 5],
    blinding_factor: Field,
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

#[test]
fn test_prove_hand() {
    let card_ids: [Field; 5] = [1, 2, 3, 4, 5];
    let blinding_factor: Field = 12345;

    let commit = test_compute_commit(card_ids, blinding_factor);

    main(commit, card_ids, blinding_factor);
}

#[test]
fn test_prove_hand_high_card_ids() {
    let card_ids: [Field; 5] = [46, 47, 48, 49, 50];
    let blinding_factor: Field = 99999;

    let commit = test_compute_commit(card_ids, blinding_factor);

    main(commit, card_ids, blinding_factor);
}

#[test]
fn test_prove_hand_level4_cards() {
    let card_ids: [Field; 5] = [31, 32, 33, 34, 35];
    let blinding_factor: Field = 55555;

    let commit = test_compute_commit(card_ids, blinding_factor);

    main(commit, card_ids, blinding_factor);
}

#[test]
fn test_prove_hand_mixed_levels() {
    let card_ids: [Field; 5] = [1, 15, 25, 35, 50];
    let blinding_factor: Field = 777;

    let commit = test_compute_commit(card_ids, blinding_factor);

    main(commit, card_ids, blinding_factor);
}

#[test(should_fail_with = "Card ID must be >= 1")]
fn test_fail_card_id_zero() {
    let card_ids: [Field; 5] = [0, 2, 3, 4, 5];
    let blinding_factor: Field = 12345;
    let commit = test_compute_commit(card_ids, blinding_factor);

    main(commit, card_ids, blinding_factor);
}

#[test(should_fail_with = "Card ID must be <= 50")]
fn test_fail_card_id_too_high() {
    let card_ids: [Field; 5] = [1, 2, 3, 4, 51];
    let blinding_factor: Field = 12345;
    let commit = test_compute_commit(card_ids, blinding_factor);

    main(commit, card_ids, blinding_factor);
}

#[test(should_fail_with = "Duplicate card IDs not allowed")]
fn test_fail_duplicate_card_ids() {
    let card_ids: [Field; 5] = [1, 2, 3, 4, 1];
    let blinding_factor: Field = 12345;
    let commit = test_compute_commit(card_ids, blinding_factor);

    main(commit, card_ids, blinding_factor);
}

#[test(should_fail_with = "Card commitment mismatch")]
fn test_fail_wrong_commitment() {
    let card_ids: [Field; 5] = [1, 2, 3, 4, 5];
    let blinding_factor: Field = 12345;
    let wrong_commit: Field = 0xdeadbeef;

    main(wrong_commit, card_ids, blinding_factor);
}

#[test(should_fail_with = "Card commitment mismatch")]
fn test_fail_wrong_blinding_factor() {
    let card_ids: [Field; 5] = [1, 2, 3, 4, 5];
    let blinding_factor: Field = 12345;
    let commit = test_compute_commit(card_ids, blinding_factor);

    // Use wrong blinding factor
    main(commit, card_ids, 99999);
}
