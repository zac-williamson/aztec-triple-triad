//! Only the game contract may make the mints a game ends with
//! (docs/plan/AUDIT_INVARIANTS.md, Z1). A player calling one directly mints any
//! card they name, so each of the four must refuse everyone but the game.
use crate::TripleTriadNFT;
use crate::test::utils;

#[test(should_fail_with = "Only game contract can call")]
unconstrained fn a_player_cannot_make_the_winner_mint() {
    let (env, nft, _minter, player, _game) = utils::setup_with_game();
    env.call_private(
        player,
        TripleTriadNFT::at(nft).mint_for_game_winner([1, 2, 3, 4, 5, 6], player, [1; 6]),
    );
}

#[test(should_fail_with = "Only game contract can call")]
unconstrained fn a_player_cannot_make_the_loser_mint() {
    let (env, nft, _minter, player, _game) = utils::setup_with_game();
    env.call_private(
        player,
        TripleTriadNFT::at(nft).mint_for_game_loser([1, 2, 3, 4], player, [1; 4]),
    );
}

#[test(should_fail_with = "Only game contract can call")]
unconstrained fn a_player_cannot_make_the_cancel_mint() {
    let (env, nft, _minter, player, _game) = utils::setup_with_game();
    env.call_private(player, TripleTriadNFT::at(nft).mint_for_game_draw([1, 2, 3, 4, 5], player));
}

#[test(should_fail_with = "Only game contract can call")]
unconstrained fn a_player_cannot_make_the_draw_mint() {
    let (env, nft, _minter, player, _game) = utils::setup_with_game();
    env.call_private(
        player,
        TripleTriadNFT::at(nft).mint_for_game_draw_offchain([1, 2, 3, 4, 5], player, [1; 5]),
    );
}

/// The positive control: the same call from the game contract goes through,
/// so the four above fail on who calls, not on a broken fixture.
#[test]
unconstrained fn the_game_contract_can_make_the_winner_mint() {
    let (env, nft, _minter, player, game) = utils::setup_with_game();
    env.call_private(
        game,
        TripleTriadNFT::at(nft).mint_for_game_winner([1, 2, 3, 4, 5, 6], player, [1, 2, 3, 4, 5, 6]),
    );
}
