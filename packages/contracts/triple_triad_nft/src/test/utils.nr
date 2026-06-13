use crate::TripleTriadNFT;
use arena_token::ArenaToken;
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use compressed_string::FieldCompressedString;

/// Basic setup: deploy NFT with game_contract set to a dummy address.
/// Sufficient for tests using get_cards_for_new_player_test and commit_five_nfts_*.
pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let minter = env.create_light_account();
    let player = env.create_light_account();

    let initializer_call = TripleTriadNFT::interface().constructor(
        minter,
        FieldCompressedString::from_string("TripleTriadNFT00000000000000000"),
        FieldCompressedString::from_string("TTNFT00000000000000000000000000"),
    );
    let contract_address =
        env.deploy("TripleTriadNFT").with_public_initializer(minter, initializer_call);

    // Set game_contract to a dummy so commit_five_nfts_* assert doesn't fail
    let game_dummy = env.create_light_account();
    env.call_public(minter, TripleTriadNFT::at(contract_address).set_game_contract(game_dummy));

    (env, contract_address, minter, player)
}

/// Full setup: deploy NFT + ArenaToken, wire cross-references.
/// Use for tests that call get_cards_for_new_player (which mints 100 Arena Tokens).
pub unconstrained fn setup_full() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let (mut env, nft_address, minter, player) = setup();

    // Deploy ArenaToken
    let token_init = ArenaToken::interface().constructor(minter);
    let token_address = env.deploy("@arena_token/ArenaToken").with_public_initializer(minter, token_init);

    // Wire cross-references
    env.call_public(minter, TripleTriadNFT::at(nft_address).set_token_contract(token_address));
    env.call_public(minter, ArenaToken::at(token_address).set_nft_contract(nft_address));

    let game_dummy = env.create_light_account();
    env.call_public(minter, ArenaToken::at(token_address).set_game_contract(game_dummy));

    (env, nft_address, token_address, minter, player)
}
