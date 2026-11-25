//! Committing a hand prepares its payouts; releasing them hands the cards back
//! to their owner without anyone else knowing who that is
//! (docs/plan/PRIVATE_GAMES.md sections 3.2-3.5).
use crate::TripleTriadNFT;
use crate::card_note::CardNote;
use crate::test::utils;
use crate::test_support;
use arena_token::ArenaToken;
use aztec::{
    note::note_interface::NoteHash,
    protocol::address::AztecAddress,
    test::helpers::test_environment::{CallPrivateOptions, TestEnvironment},
};
use uint_note::UintNote;

global REWARD: u128 = 20;
global HAND: [Field; 5] = [1, 2, 3, 4, 5];

/// A player holding cards 1..5 with a note nonce of 5, plus the account
/// standing in for the game contract.
unconstrained fn setup_hand() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let (mut env, nft, minter, player, game) = utils::setup_with_game();
    for i in 0..5 {
        env.call_private(minter, TripleTriadNFT::at(nft).mint_to_private(player, HAND[i], 0));
    }
    test_support::init_note_nonce(env, nft, player, 5);
    (env, nft, player, game)
}

/// `commit_hand` as the game contract sends it: inside the player's own tx,
/// where the player's keys are in scope. Here the game is a stand-in account,
/// so the player's scope is added explicitly.
unconstrained fn commit_as_game(
    env: TestEnvironment,
    nft: AztecAddress,
    game: AztecAddress,
    player: AztecAddress,
    hand: [Field; 5],
) -> [Field; 8] {
    env.call_private_opts(
        game,
        CallPrivateOptions::new().with_additional_scopes([player]),
        TripleTriadNFT::at(nft).commit_hand(player, hand, REWARD),
    )
}

unconstrained fn secrets_of(env: TestEnvironment, nft: AztecAddress, player: AztecAddress, nonce: Field) -> [Field; 8] {
    env.view_private(player, TripleTriadNFT::at(nft).compute_game_secrets(nonce))
}

#[test]
unconstrained fn committing_takes_the_five_cards_and_advances_the_nonce() {
    let (env, nft, player, game) = setup_hand();
    assert_eq(test_support::cards_of(env, nft, player).len(), 5);

    let _ = commit_as_game(env, nft, game, player, HAND);

    assert_eq(test_support::cards_of(env, nft, player).len(), 0, "the hand must leave the collection");
    let nonce = env.execute_utility(TripleTriadNFT::at(nft).get_note_nonce(player));
    assert_eq(nonce, 13, "the nonce must move past the 8 secrets this game derived");
}

#[test]
unconstrained fn the_prepared_payouts_are_exactly_what_the_owner_can_rebuild() {
    let (env, nft, player, game) = setup_hand();
    let preview = env.view_private(player, TripleTriadNFT::at(nft).preview_commit(player, HAND, 5, REWARD));
    let prepared = commit_as_game(env, nft, game, player, HAND);
    assert_eq(prepared, preview, "the preview must be what the commit prepares");

    let secrets = secrets_of(env, nft, player, 5);
    let card_slot = TripleTriadNFT::storage_layout().private_nfts.slot;
    for i in 0..5 {
        let expected = CardNote { card_id: HAND[i] }.compute_note_hash(player, card_slot, secrets[1 + i]);
        assert_eq(prepared[1 + i], expected, "return note must be the owner's card with the owner's randomness");
    }
    let hand_commit = aztec::protocol::hash::poseidon2_hash([HAND[0], HAND[1], HAND[2], HAND[3], HAND[4], secrets[0]]);
    assert_eq(prepared[0], hand_commit, "hand commitment must be the move circuit's formula");
    let reward = UintNote { value: REWARD }.compute_note_hash(
        player,
        ArenaToken::storage_layout().balances.slot,
        secrets[7],
    );
    assert_eq(prepared[7], reward, "reward note must be the owner's, for the reward amount");
}

#[test]
unconstrained fn two_games_never_share_payouts() {
    let (env, nft, player, game) = setup_hand();
    let first = commit_as_game(env, nft, game, player, HAND);
    // The same five cards, committed again at the advanced nonce.
    let later = env.view_private(player, TripleTriadNFT::at(nft).preview_commit(player, HAND, 13, REWARD));
    for i in 0..8 {
        assert(first[i] != later[i], "a later game must not reuse any prepared value");
    }
}

#[test]
unconstrained fn released_returns_come_back_to_their_owner() {
    let (env, nft, player, game) = setup_hand();
    let prepared = commit_as_game(env, nft, game, player, HAND);
    let secrets = secrets_of(env, nft, player, 5);

    let mut hashes: [Field; 10] = [0; 10];
    for i in 0..5 {
        hashes[i] = prepared[1 + i];
    }
    env.call_private(game, TripleTriadNFT::at(nft).release_game_cards(hashes, 5, 0, 0));
    let tx = test_support::last_tx_for_import();

    for i in 0..5 {
        test_support::import_card(env, nft, player, HAND[i], secrets[1 + i], tx);
    }
    assert_eq(test_support::cards_of(env, nft, player).len(), 5, "all five cards must be back");
}

#[test]
unconstrained fn a_prize_completes_into_the_winners_partial_note() {
    let (env, nft, player, game) = setup_hand();
    let prepared = commit_as_game(env, nft, game, player, HAND);
    let secrets = secrets_of(env, nft, player, 5);

    // Release nothing but the prize: card 99, into the player's prize partial.
    env.call_private(game, TripleTriadNFT::at(nft).release_game_cards([0; 10], 0, prepared[6], 99));
    let tx = test_support::last_tx_for_import();

    test_support::import_card(env, nft, player, 99, secrets[6], tx);
    let cards = test_support::cards_of(env, nft, player);
    assert_eq(cards.len(), 1);
    assert_eq(cards.get(0), 99, "the prize must arrive as the card that was won");
}

#[test(should_fail_with = "Duplicate card IDs not allowed")]
unconstrained fn a_hand_with_a_repeated_card_cannot_be_committed() {
    let (env, nft, player, game) = setup_hand();
    let _ = commit_as_game(env, nft, game, player, [1, 2, 3, 4, 1]);
}

#[test(should_fail_with = "Could not find all 5 cards")]
unconstrained fn a_card_the_player_does_not_hold_cannot_be_committed() {
    let (env, nft, player, game) = setup_hand();
    let _ = commit_as_game(env, nft, game, player, [1, 2, 3, 4, 6]);
}

#[test(should_fail_with = "Only game contract can call")]
unconstrained fn a_player_cannot_commit_directly() {
    let (env, nft, player, _game) = setup_hand();
    let _ = env.call_private(player, TripleTriadNFT::at(nft).commit_hand(player, HAND, REWARD));
}

#[test(should_fail_with = "Only the owner or game contract can preview")]
unconstrained fn a_stranger_cannot_preview_someone_elses_payouts() {
    let (mut env, nft, player, _game) = setup_hand();
    let stranger = env.create_light_account();
    let _ = env.view_private(stranger, TripleTriadNFT::at(nft).preview_commit(player, HAND, 5, REWARD));
}
