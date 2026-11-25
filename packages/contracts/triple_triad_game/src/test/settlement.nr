//! Settling a finished game releases each player's prepared notes, and each
//! player imports theirs from the settlement tx with data they already hold
//! (docs/plan/PRIVATE_GAMES.md sections 3.4 and 5.4).
use crate::test::utils::{self, P1_HAND, P2_HAND};
use triple_triad_nft::test_support;

/// A created and joined game: `(env, game, nft, token, p1, p2, record_1, record_2)`.
unconstrained fn joined() -> (aztec::test::helpers::test_environment::TestEnvironment, aztec::protocol::address::AztecAddress, aztec::protocol::address::AztecAddress, aztec::protocol::address::AztecAddress, aztec::protocol::address::AztecAddress, aztec::protocol::address::AztecAddress, [Field; 9], [Field; 9]) {
    let (env, game, nft, token, player1, player2) = utils::setup_game();
    let record_1 = utils::create(env, game, player1);
    let record_2 = utils::join(env, game, player2, record_1);
    (env, game, nft, token, player1, player2, record_1, record_2)
}

#[test]
unconstrained fn player_1_wins_and_takes_the_card_player_2_placed() {
    let (env, game, nft, token, p1, p2, r1, r2) = joined();
    let moves = utils::transcript(r1[1], r2[1], 1);
    // Move 3 is player 2's second placement: slot 1, card 7.
    utils::settle(env, p1, game, r1, r2, moves, 3);
    let tx = test_support::last_tx_for_import();
    let (_, _, released, _) = tx;
    // 9 returns + the prize + 2 rewards: the same as a draw, so the count
    // never tells an observer the result.
    assert_eq(released, 12, "a win releases exactly 12 notes");

    let s1 = utils::secrets(env, nft, p1);
    let s2 = utils::secrets(env, nft, p2);
    for i in 0..5 {
        test_support::import_card(env, nft, p1, P1_HAND[i], s1[1 + i], tx);
    }
    test_support::import_card(env, nft, p1, 7, s1[6], tx);
    for i in 0..5 {
        if i != 1 {
            test_support::import_card(env, nft, p2, P2_HAND[i], s2[1 + i], tx);
        }
    }
    utils::import_reward(env, token, p1, s1[7], tx);
    utils::import_reward(env, token, p2, s2[7], tx);

    utils::assert_cards(env, nft, p1, [1, 2, 3, 4, 5, 7]);
    utils::assert_cards(env, nft, p2, [6, 8, 9, 10]);
    assert_eq(utils::balance(env, token, p1), 20);
    assert_eq(utils::balance(env, token, p2), 20);
}

#[test]
unconstrained fn player_2_wins_and_takes_the_card_player_1_placed() {
    let (env, game, nft, token, p1, p2, r1, r2) = joined();
    let moves = utils::transcript(r1[1], r2[1], 2);
    // Move 8 is player 1's last placement: slot 4, card 5.
    utils::settle(env, p2, game, r1, r2, moves, 8);
    let tx = test_support::last_tx_for_import();

    let s1 = utils::secrets(env, nft, p1);
    let s2 = utils::secrets(env, nft, p2);
    for i in 0..5 {
        test_support::import_card(env, nft, p2, P2_HAND[i], s2[1 + i], tx);
    }
    test_support::import_card(env, nft, p2, 5, s2[6], tx);
    for i in 0..4 {
        test_support::import_card(env, nft, p1, P1_HAND[i], s1[1 + i], tx);
    }
    utils::import_reward(env, token, p1, s1[7], tx);
    utils::import_reward(env, token, p2, s2[7], tx);

    utils::assert_cards(env, nft, p2, [5, 6, 7, 8, 9, 10]);
    utils::assert_cards(env, nft, p1, [1, 2, 3, 4]);
    assert_eq(utils::balance(env, token, p1), 20);
    assert_eq(utils::balance(env, token, p2), 20);
}

#[test]
unconstrained fn a_draw_gives_both_hands_back() {
    let (env, game, nft, token, p1, p2, r1, r2) = joined();
    let moves = utils::transcript(r1[1], r2[1], 3);
    utils::settle(env, p1, game, r1, r2, moves, 0);
    let tx = test_support::last_tx_for_import();
    let (_, _, released, _) = tx;
    assert_eq(released, 12, "a draw releases exactly 12 notes, like a win");

    let s1 = utils::secrets(env, nft, p1);
    let s2 = utils::secrets(env, nft, p2);
    for i in 0..5 {
        test_support::import_card(env, nft, p1, P1_HAND[i], s1[1 + i], tx);
        test_support::import_card(env, nft, p2, P2_HAND[i], s2[1 + i], tx);
    }
    utils::import_reward(env, token, p1, s1[7], tx);
    utils::import_reward(env, token, p2, s2[7], tx);
    utils::assert_cards(env, nft, p1, P1_HAND);
    utils::assert_cards(env, nft, p2, P2_HAND);
    assert_eq(utils::balance(env, token, p2), 20);
}

#[test]
unconstrained fn anyone_holding_the_records_and_transcript_can_settle() {
    let (mut env, game, nft, _token, p1, _p2, r1, r2) = joined();
    let stranger = env.create_light_account();
    utils::settle(env, stranger, game, r1, r2, utils::transcript(r1[1], r2[1], 1), 1);
    let tx = test_support::last_tx_for_import();
    // The winner still gets the prize: who settled does not matter.
    let s1 = utils::secrets(env, nft, p1);
    test_support::import_card(env, nft, p1, 6, s1[6], tx);
    utils::assert_cards(env, nft, p1, [6]);
}

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn a_game_settles_once() {
    let (env, game, _nft, _token, p1, _p2, r1, r2) = joined();
    let moves = utils::transcript(r1[1], r2[1], 1);
    utils::settle(env, p1, game, r1, r2, moves, 1);
    utils::settle(env, p1, game, r1, r2, moves, 1);
}

#[test(should_fail_with = "The prize must be a card the loser placed")]
unconstrained fn the_winner_cannot_take_their_own_card() {
    let (env, game, _nft, _token, p1, _p2, r1, r2) = joined();
    // Move 2 is player 1's own placement.
    utils::settle(env, p1, game, r1, r2, utils::transcript(r1[1], r2[1], 1), 2);
}

#[test(should_fail_with = "Move proof card_commit_2 mismatch")]
unconstrained fn moves_must_be_bound_to_this_games_hands() {
    let (env, game, _nft, _token, p1, _p2, r1, r2) = joined();
    utils::settle(env, p1, game, r1, r2, utils::transcript(r1[1], 777, 1), 1);
}

#[test(should_fail_with = "reading an unknown nullifier")]
unconstrained fn settlement_needs_the_joiners_real_record() {
    let (env, game, _nft, _token, p1, _p2, r1, r2) = joined();
    let mut forged = r2;
    // A joiner record with a return note pointing elsewhere was never joined.
    forged[3] = 4242;
    utils::settle(env, p1, game, r1, forged, utils::transcript(r1[1], r2[1], 1), 1);
}
