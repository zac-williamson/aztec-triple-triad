//! Creating, joining and cancelling private games
//! (docs/plan/PRIVATE_GAMES.md section 3.4).
use crate::TripleTriadGame;
use crate::test::utils::{self, KEY, NONCE, P1_HAND, P2_HAND};
use triple_triad_nft::test_support;

#[test]
unconstrained fn creating_commits_the_hand_and_returns_a_record() {
    let (env, game, nft, _token, player1, _player2) = utils::setup_game();
    let record = utils::create(env, game, player1);
    assert_eq(test_support::cards_of(env, nft, player1).len(), 0, "the hand must leave the collection");
    for i in 0..9 {
        assert(record[i] != 0, "every record field is a real hash");
    }
}

#[test]
unconstrained fn the_preview_is_the_record_the_create_commits() {
    let (env, game, _nft, _token, player1, _player2) = utils::setup_game();
    let preview: [Field; 9] =
        env.view_private(player1, TripleTriadGame::at(game).preview_record(KEY, P1_HAND, NONCE));
    let record = utils::create(env, game, player1);
    assert_eq(preview, record, "the client's preview must be exactly what create_game commits");
}

#[test]
unconstrained fn a_second_player_joins_with_the_key_and_the_record() {
    let (env, game, nft, _token, player1, player2) = utils::setup_game();
    let record_1 = utils::create(env, game, player1);
    let record_2 = utils::join(env, game, player2, record_1);
    assert_eq(test_support::cards_of(env, nft, player2).len(), 0, "the joiner's hand must leave");
    assert(record_2[0] != record_1[0], "two players have two seats");
}

#[test(should_fail_with = "reading an unknown nullifier")]
unconstrained fn joining_needs_the_shared_key() {
    let (env, game, _nft, _token, player1, player2) = utils::setup_game();
    let record_1 = utils::create(env, game, player1);
    // Without the key the game id is different and no such game exists.
    let _: [Field; 9] =
        env.call_private(player2, TripleTriadGame::at(game).join_game(KEY + 1, record_1, P2_HAND));
}

#[test(should_fail_with = "reading an unknown nullifier")]
unconstrained fn joining_needs_the_creators_real_record() {
    let (env, game, _nft, _token, player1, player2) = utils::setup_game();
    let mut record_1 = utils::create(env, game, player1);
    // A record with one return note swapped is a different game, which was
    // never created.
    record_1[2] = 12345;
    let _ = utils::join(env, game, player2, record_1);
}

#[test(should_fail_with = "Cannot join your own game")]
unconstrained fn a_player_cannot_join_their_own_game() {
    let (env, game, nft, _token, player1, _player2, admin) = utils::setup_game_with_admin();
    let record_1 = utils::create(env, game, player1);
    // Give player 1 a second hand to join with.
    let second: [Field; 5] = [21, 22, 23, 24, 25];
    utils::give(env, nft, admin, player1, second);
    let _: [Field; 9] = env.call_private(player1, TripleTriadGame::at(game).join_game(KEY, record_1, second));
}

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn a_game_is_joined_once() {
    let (mut env, game, nft, _token, player1, player2, admin) = utils::setup_game_with_admin();
    let record_1 = utils::create(env, game, player1);
    let _ = utils::join(env, game, player2, record_1);
    let hand_3: [Field; 5] = [11, 12, 13, 14, 15];
    let player3 = utils::player_with(&mut env, nft, admin, hand_3);
    let _: [Field; 9] = env.call_private(player3, TripleTriadGame::at(game).join_game(KEY, record_1, hand_3));
}

#[test]
unconstrained fn cancelling_gives_the_creator_exactly_their_hand_back() {
    let (env, game, nft, _token, player1, _player2) = utils::setup_game();
    let record_1 = utils::create(env, game, player1);
    env.call_private(player1, TripleTriadGame::at(game).cancel_game(KEY, record_1));
    let tx = test_support::last_tx_for_import();

    let s = utils::secrets(env, nft, player1);
    for i in 0..5 {
        test_support::import_card(env, nft, player1, P1_HAND[i], s[1 + i], tx);
    }
    utils::assert_cards(env, nft, player1, P1_HAND);
}

#[test(should_fail_with = "Only the game creator can cancel")]
unconstrained fn only_the_creator_can_cancel() {
    let (env, game, _nft, _token, player1, player2) = utils::setup_game();
    let record_1 = utils::create(env, game, player1);
    env.call_private(player2, TripleTriadGame::at(game).cancel_game(KEY, record_1));
}

#[test(should_fail_with = "reading an unknown nullifier")]
unconstrained fn a_cancel_cannot_name_other_cards() {
    // The old cancel minted whatever ids the caller passed. Now the only thing
    // a creator can pass is a record, and a record with different return notes
    // belongs to a game that was never created.
    let (env, game, _nft, _token, player1, _player2) = utils::setup_game();
    let mut record_1 = utils::create(env, game, player1);
    record_1[2] = 98765;
    env.call_private(player1, TripleTriadGame::at(game).cancel_game(KEY, record_1));
}

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn a_joined_game_cannot_be_cancelled() {
    let (env, game, _nft, _token, player1, player2) = utils::setup_game();
    let record_1 = utils::create(env, game, player1);
    let _ = utils::join(env, game, player2, record_1);
    env.call_private(player1, TripleTriadGame::at(game).cancel_game(KEY, record_1));
}

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn a_cancelled_game_cannot_be_joined() {
    let (env, game, _nft, _token, player1, player2) = utils::setup_game();
    let record_1 = utils::create(env, game, player1);
    env.call_private(player1, TripleTriadGame::at(game).cancel_game(KEY, record_1));
    let _ = utils::join(env, game, player2, record_1);
}

#[test(should_fail_with = "duplicate nullifiers")]
unconstrained fn a_game_is_cancelled_once() {
    let (env, game, _nft, _token, player1, _player2) = utils::setup_game();
    let record_1 = utils::create(env, game, player1);
    env.call_private(player1, TripleTriadGame::at(game).cancel_game(KEY, record_1));
    env.call_private(player1, TripleTriadGame::at(game).cancel_game(KEY, record_1));
}
