//! Abandonment without public state: claim, contest and finalize, timed from
//! the blocks their nullifiers landed in (docs/plan/PRIVATE_GAMES.md 3.4).
use crate::{DISPUTE_SECONDS, MIN_ABANDON_SECONDS, TripleTriadGame};
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

unconstrained fn claim(env: TestEnvironment, from: AztecAddress, game: AztecAddress, r1: [Field; 9], r2: [Field; 9], side: Field, claim_no: Field, clock_block: u32) -> u32 {
    env.call_private(from, TripleTriadGame::at(game).claim_abandoned_game(KEY, r1, r2, side, claim_no, clock_block));
    env.last_block_number()
}

unconstrained fn contest(env: TestEnvironment, from: AztecAddress, game: AztecAddress, r1: [Field; 9], r2: [Field; 9], side: Field, claim_no: Field, claim_side: Field, claim_block: u32) -> u32 {
    env.call_private(
        from,
        TripleTriadGame::at(game).contest_abandonment(KEY, r1, r2, side, claim_no, claim_side, claim_block - 1),
    );
    env.last_block_number()
}

unconstrained fn finalize(env: TestEnvironment, from: AztecAddress, game: AztecAddress, r1: [Field; 9], r2: [Field; 9], claim_no: Field, claim_side: Field, claim_block: u32) {
    env.call_private(
        from,
        TripleTriadGame::at(game).finalize_abandoned_game(KEY, r1, r2, claim_no, claim_side, claim_block),
    );
}

#[test(should_fail_with = "Too soon to call this game abandoned")]
unconstrained fn a_claim_right_after_joining_is_too_soon() {
    let (env, game, _nft, _p1, p2, r1, r2, joined_at) = joined();
    let _ = claim(env, p2, game, r1, r2, 2, 1, joined_at);
}

#[test]
unconstrained fn an_uncontested_claim_unwinds_the_game_for_both_players() {
    let (env, game, nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let claimed_at = claim(env, p2, game, r1, r2, 2, 1, joined_at);
    wait(env, DISPUTE_SECONDS);
    // Anyone may finalize: here the claimant.
    finalize(env, p2, game, r1, r2, 1, 2, claimed_at);
    let tx = test_support::last_tx_for_import();

    let s1 = utils::secrets(env, nft, p1);
    let s2 = utils::secrets(env, nft, p2);
    for i in 0..5 {
        test_support::import_card(env, nft, p1, P1_HAND[i], s1[1 + i], tx);
        test_support::import_card(env, nft, p2, P2_HAND[i], s2[1 + i], tx);
    }
    utils::assert_cards(env, nft, p1, P1_HAND);
    utils::assert_cards(env, nft, p2, P2_HAND);
}

#[test(should_fail_with = "Dispute window not elapsed")]
unconstrained fn a_claim_cannot_be_finalized_inside_its_window() {
    let (env, game, _nft, _p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let claimed_at = claim(env, p2, game, r1, r2, 2, 1, joined_at);
    wait(env, DISPUTE_SECONDS - 1);
    finalize(env, p2, game, r1, r2, 1, 2, claimed_at);
}

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn a_contested_claim_cannot_be_finalized() {
    let (env, game, _nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let claimed_at = claim(env, p2, game, r1, r2, 2, 1, joined_at);
    let _ = contest(env, p1, game, r1, r2, 1, 1, 2, claimed_at);
    wait(env, DISPUTE_SECONDS);
    finalize(env, p2, game, r1, r2, 1, 2, claimed_at);
}

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

#[test]
unconstrained fn a_full_transcript_outranks_a_standing_claim() {
    let (env, game, _nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let _ = claim(env, p2, game, r1, r2, 2, 1, joined_at);
    // The winner comes back inside the window and settles normally.
    utils::settle(env, p1, game, r1, r2, utils::transcript(r1[1], r2[1], 1), 1);
}

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn a_settled_game_cannot_be_unwound() {
    let (env, game, _nft, p1, p2, r1, r2, joined_at) = joined();
    wait(env, MIN_ABANDON_SECONDS);
    let claimed_at = claim(env, p2, game, r1, r2, 2, 1, joined_at);
    utils::settle(env, p1, game, r1, r2, utils::transcript(r1[1], r2[1], 1), 1);
    wait(env, DISPUTE_SECONDS);
    finalize(env, p2, game, r1, r2, 1, 2, claimed_at);
}
