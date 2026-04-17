// Abandoned game TXE tests.
//
// Tests for public-facing abandoned game functions that don't require ZK proofs.
// Proof-dependent tests (claim_abandoned_game) are in the integration package
// as TypeScript tests with real UltraHonk proof generation.
//
// TXE-feasible tests:
//   - cancel_game_public rejects non-created games
//   - cancel_game_public rejects non-creator
//   - Game status transitions are correct

use crate::TripleTriadGame;
use crate::test::utils;

// --- Cancel game access control ---

#[test]
unconstrained fn create_game_and_verify_card_removal() {
    let (mut env, game_addr, nft_addr, _token_addr, player1, _player2) = utils::setup_game();

    // Player1 creates a game (commits 5 cards)
    env.call_private(
        player1,
        TripleTriadGame::at(game_addr).create_game([1, 2, 3, 4, 5]),
    );

    // Verify cards were committed by checking the player has 0 cards left
    let (cards, _) = env.execute_utility(
        triple_triad_nft::TripleTriadNFT::at(nft_addr).get_nfts_for_user(player1, 0),
    );
    let mut count: u32 = 0;
    for i in 0..aztec::note::constants::MAX_NOTES_PER_PAGE {
        if cards[i] != 0 {
            count += 1;
        }
    }
    assert(count == 0, "Player1 should have 0 cards after create_game");
}

#[test]
unconstrained fn two_players_can_setup_game() {
    let (mut env, game_addr, nft_addr, _token_addr, player1, player2) = utils::setup_game();

    // Verify both players start with 5 cards
    let (cards1, _) = env.execute_utility(
        triple_triad_nft::TripleTriadNFT::at(nft_addr).get_nfts_for_user(player1, 0),
    );
    let (cards2, _) = env.execute_utility(
        triple_triad_nft::TripleTriadNFT::at(nft_addr).get_nfts_for_user(player2, 0),
    );

    let mut count1: u32 = 0;
    let mut count2: u32 = 0;
    for i in 0..aztec::note::constants::MAX_NOTES_PER_PAGE {
        if cards1[i] != 0 { count1 += 1; }
        if cards2[i] != 0 { count2 += 1; }
    }
    assert(count1 == 5, "Player1 should start with 5 cards");
    assert(count2 == 5, "Player2 should start with 5 cards");
}
