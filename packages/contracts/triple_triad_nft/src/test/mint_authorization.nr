//! Only the game contract may move cards in and out of a game
//! (docs/plan/AUDIT_INVARIANTS.md, Z1). `release_game_cards` pushes whatever
//! note hashes it is given, so a player able to call it could release any card
//! to anyone; `commit_hand` consumes a player's cards.
use crate::TripleTriadNFT;
use crate::test::utils;

#[test(should_fail_with = "Only game contract can call")]
unconstrained fn a_player_cannot_release_game_cards() {
    let (env, nft, _minter, player, _game) = utils::setup_with_game();
    env.call_private(player, TripleTriadNFT::at(nft).release_game_cards([1; 10], 10, 1, 7));
}

#[test(should_fail_with = "Only game contract can call")]
unconstrained fn a_player_cannot_commit_a_hand() {
    let (env, nft, _minter, player, _game) = utils::setup_with_game();
    let _ = env.call_private(player, TripleTriadNFT::at(nft).commit_hand(player, [1, 2, 3, 4, 5], 20));
}

/// The positive control: the same release from the game contract goes
/// through, so the refusals above are about who calls, not a broken fixture.
#[test]
unconstrained fn the_game_contract_can_release_game_cards() {
    let (env, nft, _minter, _player, game) = utils::setup_with_game();
    env.call_private(game, TripleTriadNFT::at(nft).release_game_cards([1; 10], 10, 1, 7));
}

#[test(should_fail_with = "count exceeds batch size")]
unconstrained fn a_release_cannot_overrun_its_batch() {
    let (env, nft, _minter, _player, game) = utils::setup_with_game();
    env.call_private(game, TripleTriadNFT::at(nft).release_game_cards([1; 10], 11, 0, 0));
}
