use crate::TripleTriadGame;
use triple_triad_nft::TripleTriadNFT;
use arena_token::ArenaToken;
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use compressed_string::FieldCompressedString;

/// Full three-contract setup: ArenaToken + TripleTriadNFT + TripleTriadGame.
/// Returns (env, game_addr, nft_addr, token_addr, player1, player2).
/// Both players have 5 private NFT cards (via mint_to_private) and nonce initialized.
pub unconstrained fn setup_game() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let player1 = env.create_light_account();
    let player2 = env.create_light_account();

    // Deploy ArenaToken
    let token_init = ArenaToken::interface().constructor(admin);
    let token_addr = env.deploy("ArenaToken").with_public_initializer(admin, token_init);

    // Deploy TripleTriadNFT
    let nft_init = TripleTriadNFT::interface().constructor(
        admin,
        FieldCompressedString::from_string("TripleTriadNFT00000000000000000"),
        FieldCompressedString::from_string("TTNFT00000000000000000000000000"),
    );
    let nft_addr = env.deploy("TripleTriadNFT").with_public_initializer(admin, nft_init);

    // Deploy TripleTriadGame (vk hashes are dummy values for TXE tests)
    let game_init = TripleTriadGame::interface().constructor(
        nft_addr,
        1,     // hand_vk_hash (dummy)
        2,     // move_vk_hash (dummy)
        token_addr,
        3,     // dummy_vk_hash (dummy)
    );
    let game_addr = env.deploy("TripleTriadGame").with_public_initializer(admin, game_init);

    // Wire cross-references
    env.call_public(admin, TripleTriadNFT::at(nft_addr).set_game_contract(game_addr));
    env.call_public(admin, TripleTriadNFT::at(nft_addr).set_token_contract(token_addr));
    env.call_public(admin, ArenaToken::at(token_addr).set_nft_contract(nft_addr));
    env.call_public(admin, ArenaToken::at(token_addr).set_game_contract(game_addr));

    // Mint 5 cards to each player via mint_to_private (standard note insertion)
    // Player 1 gets cards [1,2,3,4,5]
    for i in 0..5 {
        env.call_private(
            admin,
            TripleTriadNFT::at(nft_addr).mint_to_private(player1, (i + 1) as Field, 0),
        );
    }
    // Player 2 gets cards [6,7,8,9,10]
    for i in 0..5 {
        env.call_private(
            admin,
            TripleTriadNFT::at(nft_addr).mint_to_private(player2, (i + 6) as Field, 0),
        );
    }

    // Initialize nonce for both players (needed by commit_five_nfts_*)
    env.call_private(
        player1,
        TripleTriadNFT::at(nft_addr).test_init_nonce(5),
    );
    env.call_private(
        player2,
        TripleTriadNFT::at(nft_addr).test_init_nonce(5),
    );

    (env, game_addr, nft_addr, token_addr, player1, player2)
}
