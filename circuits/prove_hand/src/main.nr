/// Open-cards proof (docs/plan/PRIVATE_GAMES.md section 6).
///
/// Triple Triad's "three open" rule shows each player three of the opponent's
/// five cards from the start. The relay used to enforce it by holding both
/// hands in plaintext; now each player reveals their own three, peer to peer,
/// and proves them against the hand commitment their commit tx recorded:
///
///   public:  card_commit_hash -- the record's hand_commit
///            open_cards       -- the hand's first three slots, as committed
///   private: card_ids, blinding_factor
///
/// The remaining two cards stay hidden until they are played, when each move
/// proof publishes its card and slot. Verified by the opponent's client only;
/// nothing on-chain checks this proof.
use poseidon::poseidon2::Poseidon2;

fn main(
    card_commit_hash: pub Field,
    open_cards: pub [Field; 3],
    card_ids: [Field; 5],
    blinding_factor: Field,
) {
    for i in 0..5 {
        let id = card_ids[i] as u32;
        assert((id as Field) == card_ids[i], "Card ID must be <= 256");
        assert(id >= 1, "Card ID must be >= 1");
        assert(id <= 256, "Card ID must be <= 256");
        for j in (i + 1)..5 {
            assert(card_ids[i] != card_ids[j], "Duplicate card IDs not allowed");
        }
    }

    let mut to_hash: [Field; 6] = [0; 6];
    for i in 0..5 {
        to_hash[i] = card_ids[i];
    }
    to_hash[5] = blinding_factor;
    assert(Poseidon2::hash(to_hash, 6) == card_commit_hash, "Card commitment mismatch");

    for i in 0..3 {
        assert(card_ids[i] == open_cards[i], "Open card is not in the committed hand");
    }
}

// ====================== TESTS ======================

fn commit_of(card_ids: [Field; 5], blinding_factor: Field) -> Field {
    let mut to_hash: [Field; 6] = [0; 6];
    for i in 0..5 {
        to_hash[i] = card_ids[i];
    }
    to_hash[5] = blinding_factor;
    Poseidon2::hash(to_hash, 6)
}

#[test]
fn the_first_three_slots_are_the_open_cards() {
    let hand: [Field; 5] = [12, 200, 7, 99, 256];
    main(commit_of(hand, 4242), [12, 200, 7], hand, 4242);
}

#[test(should_fail_with = "Open card is not in the committed hand")]
fn an_open_card_must_be_in_the_hand() {
    let hand: [Field; 5] = [12, 200, 7, 99, 256];
    main(commit_of(hand, 4242), [12, 200, 8], hand, 4242);
}

#[test(should_fail_with = "Open card is not in the committed hand")]
fn the_open_cards_are_the_first_three_slots_in_order() {
    // 99 is in the hand, but in slot 3: a player cannot choose to reveal a
    // different three than they committed as open.
    let hand: [Field; 5] = [12, 200, 7, 99, 256];
    main(commit_of(hand, 4242), [12, 200, 99], hand, 4242);
}

#[test(should_fail_with = "Card commitment mismatch")]
fn the_hand_must_be_the_committed_one() {
    let hand: [Field; 5] = [12, 200, 7, 99, 256];
    main(commit_of(hand, 4242), [12, 200, 7], hand, 4243);
}

#[test(should_fail_with = "Duplicate card IDs not allowed")]
fn a_hand_repeats_no_card() {
    let hand: [Field; 5] = [12, 200, 12, 99, 256];
    main(commit_of(hand, 1), [12, 200, 12], hand, 1);
}

#[test(should_fail_with = "Card ID must be >= 1")]
fn card_zero_is_not_a_card() {
    let hand: [Field; 5] = [0, 200, 7, 99, 256];
    main(commit_of(hand, 1), [0, 200, 7], hand, 1);
}

#[test(should_fail_with = "Card ID must be <= 256")]
fn card_257_is_not_a_card() {
    let hand: [Field; 5] = [12, 200, 7, 99, 257];
    main(commit_of(hand, 1), [12, 200, 7], hand, 1);
}
