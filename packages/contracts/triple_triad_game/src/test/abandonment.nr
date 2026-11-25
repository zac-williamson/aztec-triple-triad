//! Abandonment without public state: claim, contest and finalize, timed from
//! the blocks their nullifiers landed in, and the open card the player who
//! walked away forfeits (docs/plan/PRIVATE_GAMES.md 3.4).
use crate::{DISPUTE_SECONDS, MIN_ABANDON_SECONDS, NO_FORFEIT, TripleTriadGame};
use crate::test::utils::{self, KEY, P1_HAND, P2_HAND};
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use triple_triad_nft::test_support;

/// A joined game, and the block its join landed in.
unconstrained fn joined() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress, [Field; 9], [Field; 9], u32) {
    let (env, game, nft, _token, player1, player2) = utils::setup_game();
    let record_1 = utils::create(env, game, player1);
    let record_2 = utils::join(env, game, player2, record_1);
    (env, game, nft, player1, player2, record_1, record_2, env.last_block_number())
}

/// Mine an empty block `seconds` after the last one.
unconstrained fn wait(env: TestEnvironment, seconds: u64) {
    env.mine_block_at(env.last_block_timestamp() + seconds);
}

/// `side`'s open-cards proof inputs: the hand commitment in their record and
/// the hand's first three cards.
unconstrained fn open_inputs(r1: [Field; 9], r2: [Field; 9], side: Field) -> [Field; 4] {
    if side == 1 {
        [r1[1], P1_HAND[0], P1_HAND[1], P1_HAND[2]]
    } else {
        [r2[1], P2_HAND[0], P2_HAND[1], P2_HAND[2]]
    }
}

/// A claim with explicit open-cards inputs. TXE runs a private function
/// without proving it, so the proof and VK are zeros: what IS checked is
/// everything the contract does with the inputs.
unconstrained fn claim_with(
    env: TestEnvironment,
    from: AztecAddress,
    game: AztecAddress,
    r1: [Field; 9],
    r2: [Field; 9],
    side: Field,
    claim_no: Field,
    clock_block: u32,
    inputs: [Field; 4],
    forfeit_slot: Field,
) -> u32 {
    let p: [Field; 458] = [0; 458];
    let vk: [Field; 115] = [0; 115];
    env.call_private(
        from,
        TripleTriadGame::at(game).claim_abandoned_game(KEY, r1, r2, side, claim_no, clock_block, vk, p, inputs, forfeit_slot),
    );
    env.last_block_number()
}

/// A claim taking the other player's open card at `forfeit_slot`, or nothing
/// (NO_FORFEIT, proving the claimant's own open cards), as a client makes it.
unconstrained fn claim_taking(
    env: TestEnvironment,
    from: AztecAddress,
    game: AztecAddress,
    r1: [Field; 9],
    r2: [Field; 9],
    side: Field,
    claim_no: Field,
    clock_block: u32,
    forfeit_slot: Field,
) -> u32 {
    let proven = crate::open_cards_side(side, forfeit_slot);
    claim_with(env, from, game, r1, r2, side, claim_no, clock_block, open_inputs(r1, r2, proven), forfeit_slot)
}

/// A claim that takes nothing: the timing and contest rules do not depend on
/// the forfeit.
unconstrained fn claim(env: TestEnvironment, from: AztecAddress, game: AztecAddress, r1: [Field; 9], r2: [Field; 9], side: Field, claim_no: Field, clock_block: u32) -> u32 {
    claim_taking(env, from, game, r1, r2, side, claim_no, clock_block, NO_FORFEIT)
}

unconstrained fn contest(env: TestEnvironment, from: AztecAddress, game: AztecAddress, r1: [Field; 9], r2: [Field; 9], side: Field, claim_no: Field, claim_side: Field, claim_block: u32) -> u32 {
    env.call_private(
        from,
        TripleTriadGame::at(game).contest_abandonment(KEY, r1, r2, side, claim_no, claim_side, claim_block - 1),
    );
    env.last_block_number()
}

unconstrained fn finalize_terms(
    env: TestEnvironment,
    from: AztecAddress,
    game: AztecAddress,
    r1: [Field; 9],
    r2: [Field; 9],
    claim_no: Field,
    claim_side: Field,
    claim_block: u32,
    forfeit_slot: Field,
    forfeit_card: Field,
) {
    env.call_private(
        from,
        TripleTriadGame::at(game).finalize_abandoned_game(KEY, r1, r2, claim_no, claim_side, claim_block, forfeit_slot, forfeit_card),
    );
}

/// Finalize a claim that took nothing.
unconstrained fn finalize(env: TestEnvironment, from: AztecAddress, game: AztecAddress, r1: [Field; 9], r2: [Field; 9], claim_no: Field, claim_side: Field, claim_block: u32) {
    finalize_terms(env, from, game, r1, r2, claim_no, claim_side, claim_block, NO_FORFEIT, 0);
}

/// Import a whole hand's returns, except `skip_slot` (5 for none).
unconstrained fn import_returns(env: TestEnvironment, nft: AztecAddress, owner: AztecAddress, hand: [Field; 5], skip_slot: u32, tx: (Field, [Field; 64], u32, Field)) {
    let s = utils::secrets(env, nft, owner);
    for i in 0..5 {
        if i != skip_slot {
            test_support::import_card(env, nft, owner, hand[i], s[1 + i], tx);
        }
    }
}

/// Import the card a claim took, as the claimant's prize note.
unconstrained fn import_forfeit(env: TestEnvironment, nft: AztecAddress, claimant: AztecAddress, card: Field, tx: (Field, [Field; 64], u32, Field)) {
    let s = utils::secrets(env, nft, claimant);
    test_support::import_card(env, nft, claimant, card, s[6], tx);
}

// --- timing ---

#[test(should_fail_with = "Too soon to call this game abandoned")]
unconstrained fn a_claim_right_after_joining_is_too_soon() {
    let (env, game, _nft, _p1, p2, r1, r2, joined_at) = joined();
    let _ = claim(env, p2, game, r1, r2, 2, 1, joined_at);
}

#[test(should_fail_with = "Dispute window not elapsed")]
unconstrained fn a_claim_cannot_be_finalized_inside_its_window() {
    let (env, game, _nft, _p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let claimed_at = claim(env, p2, game, r1, r2, 2, 1, joined_at);
    wait(env, DISPUTE_SECONDS - 1);
    finalize(env, p2, game, r1, r2, 1, 2, claimed_at);
}

// --- the forfeit ---

#[test]
unconstrained fn an_uncontested_claim_takes_one_of_the_leavers_open_cards() {
    let (env, game, nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    // Player 2 stayed: it takes player 1's open card in slot 2 (card 3).
    let claimed_at = claim_taking(env, p2, game, r1, r2, 2, 1, joined_at, 2);
    wait(env, DISPUTE_SECONDS);
    finalize_terms(env, p2, game, r1, r2, 1, 2, claimed_at, 2, P1_HAND[2]);
    let tx = test_support::last_tx_for_import();

    import_returns(env, nft, p2, P2_HAND, 5, tx);
    import_forfeit(env, nft, p2, P1_HAND[2], tx);
    import_returns(env, nft, p1, P1_HAND, 2, tx);
    // Six and four: the card moved, and no card was made or lost.
    utils::assert_cards(env, nft, p2, [3, 6, 7, 8, 9, 10]);
    utils::assert_cards(env, nft, p1, [1, 2, 4, 5]);
}

#[test]
unconstrained fn player_one_can_claim_a_card_from_player_two() {
    let (env, game, nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let claimed_at = claim_taking(env, p1, game, r1, r2, 1, 1, joined_at, 1);
    wait(env, DISPUTE_SECONDS);
    finalize_terms(env, p1, game, r1, r2, 1, 1, claimed_at, 1, P2_HAND[1]);
    let tx = test_support::last_tx_for_import();

    import_returns(env, nft, p1, P1_HAND, 5, tx);
    import_forfeit(env, nft, p1, P2_HAND[1], tx);
    import_returns(env, nft, p2, P2_HAND, 1, tx);
    utils::assert_cards(env, nft, p1, [1, 2, 3, 4, 5, 7]);
    utils::assert_cards(env, nft, p2, [6, 8, 9, 10]);
}

#[test]
unconstrained fn the_leaver_can_finalize_but_still_pays_the_card() {
    let (env, game, nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let claimed_at = claim_taking(env, p2, game, r1, r2, 2, 1, joined_at, 0);
    wait(env, DISPUTE_SECONDS);
    // The player who left comes back after the window and finalizes to get
    // their other four: the notes were prepared for their owners at commit.
    finalize_terms(env, p1, game, r1, r2, 1, 2, claimed_at, 0, P1_HAND[0]);
    let tx = test_support::last_tx_for_import();

    import_returns(env, nft, p1, P1_HAND, 0, tx);
    import_returns(env, nft, p2, P2_HAND, 5, tx);
    import_forfeit(env, nft, p2, P1_HAND[0], tx);
    utils::assert_cards(env, nft, p1, [2, 3, 4, 5]);
    utils::assert_cards(env, nft, p2, [1, 6, 7, 8, 9, 10]);
}

// The claim's terms nullifier names the card it took; "nothing taken" was
// never pushed, so there is nothing to prove membership of.
#[test(should_fail_with = "Nullifier membership witness not found")]
unconstrained fn the_leaver_cannot_finalize_as_if_nothing_was_taken() {
    let (env, game, _nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let claimed_at = claim_taking(env, p2, game, r1, r2, 2, 1, joined_at, 0);
    wait(env, DISPUTE_SECONDS);
    finalize(env, p1, game, r1, r2, 1, 2, claimed_at);
}

#[test(should_fail_with = "Nullifier membership witness not found")]
unconstrained fn finalizing_cannot_swap_in_a_better_card() {
    let (env, game, _nft, _p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let claimed_at = claim_taking(env, p2, game, r1, r2, 2, 1, joined_at, 0);
    wait(env, DISPUTE_SECONDS);
    finalize_terms(env, p2, game, r1, r2, 1, 2, claimed_at, 1, P1_HAND[1]);
}

#[test]
unconstrained fn a_claim_that_takes_nothing_returns_both_hands() {
    let (env, game, nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    // A claimant who never got the other player's open cards proves its own.
    let claimed_at = claim(env, p2, game, r1, r2, 2, 1, joined_at);
    wait(env, DISPUTE_SECONDS);
    finalize(env, p1, game, r1, r2, 1, 2, claimed_at);
    let tx = test_support::last_tx_for_import();

    import_returns(env, nft, p1, P1_HAND, 5, tx);
    import_returns(env, nft, p2, P2_HAND, 5, tx);
    utils::assert_cards(env, nft, p1, P1_HAND);
    utils::assert_cards(env, nft, p2, P2_HAND);
}

#[test(should_fail_with = "Open cards are not that player's committed hand")]
unconstrained fn a_claim_cannot_take_from_the_claimants_own_hand() {
    let (env, game, _nft, _p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let _ = claim_with(env, p2, game, r1, r2, 2, 1, joined_at, open_inputs(r1, r2, 2), 0);
}

#[test(should_fail_with = "Open cards are not that player's committed hand")]
unconstrained fn a_claim_that_takes_nothing_proves_the_claimants_own_cards() {
    let (env, game, _nft, _p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let _ = claim_with(env, p2, game, r1, r2, 2, 1, joined_at, open_inputs(r1, r2, 1), NO_FORFEIT);
}

#[test(should_fail_with = "Open cards are not that player's committed hand")]
unconstrained fn open_cards_from_another_game_are_refused() {
    let (env, game, _nft, _p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let _ = claim_with(env, p2, game, r1, r2, 2, 1, joined_at, [12345, P1_HAND[0], P1_HAND[1], P1_HAND[2]], 0);
}

#[test(should_fail_with = "Forfeit slot must be an open card (0-2) or none (3)")]
unconstrained fn a_claim_cannot_take_a_hidden_card() {
    let (env, game, _nft, _p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let _ = claim_with(env, p2, game, r1, r2, 2, 1, joined_at, open_inputs(r1, r2, 1), 4);
}

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn a_contest_clears_the_forfeit() {
    let (env, game, _nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let claimed_at = claim_taking(env, p2, game, r1, r2, 2, 1, joined_at, 0);
    let _ = contest(env, p1, game, r1, r2, 1, 1, 2, claimed_at);
    wait(env, DISPUTE_SECONDS);
    finalize_terms(env, p2, game, r1, r2, 1, 2, claimed_at, 0, P1_HAND[0]);
}

#[test]
unconstrained fn a_claim_after_a_contest_carries_its_own_forfeit() {
    let (env, game, nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let first = claim_taking(env, p2, game, r1, r2, 2, 1, joined_at, 0);
    let contested_at = contest(env, p1, game, r1, r2, 1, 1, 2, first);
    wait(env, MIN_ABANDON_SECONDS);
    let second = claim_taking(env, p2, game, r1, r2, 2, 2, contested_at, 1);
    wait(env, DISPUTE_SECONDS);
    finalize_terms(env, p2, game, r1, r2, 2, 2, second, 1, P1_HAND[1]);
    let tx = test_support::last_tx_for_import();

    import_returns(env, nft, p2, P2_HAND, 5, tx);
    import_forfeit(env, nft, p2, P1_HAND[1], tx);
    import_returns(env, nft, p1, P1_HAND, 1, tx);
    utils::assert_cards(env, nft, p2, [2, 6, 7, 8, 9, 10]);
    utils::assert_cards(env, nft, p1, [1, 3, 4, 5]);
}

// --- contests ---

#[test(should_fail_with = "Dispute window has closed")]
unconstrained fn a_contest_after_the_window_is_refused() {
    let (env, game, _nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let claimed_at = claim(env, p2, game, r1, r2, 2, 1, joined_at);
    wait(env, DISPUTE_SECONDS);
    let _ = contest(env, p1, game, r1, r2, 1, 1, 2, claimed_at);
}

#[test(should_fail_with = "A claimant cannot contest their own claim")]
unconstrained fn a_claimant_cannot_contest_their_own_claim() {
    let (env, game, _nft, _p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let claimed_at = claim(env, p2, game, r1, r2, 2, 1, joined_at);
    let _ = contest(env, p2, game, r1, r2, 2, 1, 2, claimed_at);
}

#[test(should_fail_with = "Claimant must be a player in this game")]
unconstrained fn only_a_player_can_claim() {
    let (mut env, game, _nft, _p1, _p2, r1, r2, joined_at) = joined();
    let stranger = env.create_light_account();
    wait(env, MIN_ABANDON_SECONDS);
    let _ = claim(env, stranger, game, r1, r2, 1, 1, joined_at);
}

#[test(should_fail_with = "Claimant must be a player in this game")]
unconstrained fn a_player_cannot_claim_from_the_other_seat() {
    let (env, game, _nft, _p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let _ = claim(env, p2, game, r1, r2, 1, 1, joined_at);
}

#[test]
unconstrained fn a_contest_restarts_the_clock_for_the_next_claim() {
    let (env, game, _nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let first = claim(env, p2, game, r1, r2, 2, 1, joined_at);
    let contested_at = contest(env, p1, game, r1, r2, 1, 1, 2, first);
    wait(env, MIN_ABANDON_SECONDS);
    // The second claim is timed from the contest.
    let _ = claim(env, p2, game, r1, r2, 2, 2, contested_at);
}

#[test(should_fail_with = "Too soon to call this game abandoned")]
unconstrained fn a_second_claim_too_soon_after_a_contest_is_refused() {
    let (env, game, _nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let first = claim(env, p2, game, r1, r2, 2, 1, joined_at);
    let contested_at = contest(env, p1, game, r1, r2, 1, 1, 2, first);
    wait(env, MIN_ABANDON_SECONDS - 1);
    let _ = claim(env, p2, game, r1, r2, 2, 2, contested_at);
}

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn each_side_contests_once() {
    let (env, game, _nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let first = claim(env, p2, game, r1, r2, 2, 1, joined_at);
    let contested_at = contest(env, p1, game, r1, r2, 1, 1, 2, first);
    wait(env, MIN_ABANDON_SECONDS);
    let second = claim(env, p2, game, r1, r2, 2, 2, contested_at);
    let _ = contest(env, p1, game, r1, r2, 1, 2, 2, second);
}

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn a_claim_number_is_used_once() {
    let (env, game, _nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let _ = claim(env, p2, game, r1, r2, 2, 1, joined_at);
    let _ = claim(env, p1, game, r1, r2, 1, 1, joined_at);
}

// --- settlement outranks a claim ---

#[test]
unconstrained fn a_full_transcript_outranks_a_standing_claim() {
    let (env, game, _nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let _ = claim_taking(env, p2, game, r1, r2, 2, 1, joined_at, 0);
    // The winner comes back inside the window and settles normally.
    utils::settle(env, p1, game, r1, r2, utils::transcript(r1[1], r2[1], 1), 1);
}

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn a_settled_game_cannot_be_unwound() {
    let (env, game, _nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let claimed_at = claim_taking(env, p2, game, r1, r2, 2, 1, joined_at, 0);
    utils::settle(env, p1, game, r1, r2, utils::transcript(r1[1], r2[1], 1), 1);
    wait(env, DISPUTE_SECONDS);
    finalize_terms(env, p2, game, r1, r2, 1, 2, claimed_at, 0, P1_HAND[0]);
}
