use crate::ArenaToken;
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};

/// Deploy ArenaToken and return (env, contract, admin, user).
/// Does NOT set nft_contract/game_contract -- call setup_full() for that.
pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let user = env.create_light_account();

    let initializer_call = ArenaToken::interface().constructor(admin);
    let contract_address = env.deploy("ArenaToken").with_public_initializer(admin, initializer_call);

    (env, contract_address, admin, user)
}

/// Deploy ArenaToken with nft_contract and game_contract set to dummy accounts.
/// This allows mint_private/burn_from to work without "uninitialized PublicImmutable" errors.
pub unconstrained fn setup_full() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let (mut env, contract_address, admin, user) = setup();

    let nft_account = env.create_light_account();
    let game_account = env.create_light_account();

    env.call_public(admin, ArenaToken::at(contract_address).set_nft_contract(nft_account));
    env.call_public(admin, ArenaToken::at(contract_address).set_game_contract(game_account));

    (env, contract_address, admin, user, nft_account, game_account)
}
