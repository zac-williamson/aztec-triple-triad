use crate::TripleTriadNFT;
use crate::test::utils;
use aztec::note::constants::MAX_NOTES_PER_PAGE;

unconstrained fn count_private_cards(
    env: aztec::test::helpers::test_environment::TestEnvironment,
    contract_address: aztec::protocol::address::AztecAddress,
    player: aztec::protocol::address::AztecAddress,
) -> u32 {
    let (cards, _) = env.execute_utility(
        TripleTriadNFT::at(contract_address).get_nfts_for_user(player, 0),
    );
    let mut count: u32 = 0;
    for i in 0..MAX_NOTES_PER_PAGE {
        if cards[i] != 0 {
            count += 1;
        }
    }
    count
}

// --- commit_five_nfts_create returns non-zero values ---

#[test]
unconstrained fn commit_create_returns_nonzero_values() {
    let (mut env, contract_address, minter, player) = utils::setup();

    // Mint 5 cards
    for i in 0..5 {
        env.call_private(
            minter,
            TripleTriadNFT::at(contract_address).mint_to_private(player, (i + 1) as Field, 0),
        );
    }
    env.call_private(
        player,
        TripleTriadNFT::at(contract_address).test_init_nonce(5),
    );

    let result: [Field; 3] = env.call_private(
        player,
        TripleTriadNFT::at(contract_address).commit_five_nfts_create(player, [1, 2, 3, 4, 5]),
    );

    // result = [card_commit_hash, player_state_hash, game_id]
    assert(result[0] != 0, "card_commit_hash should be non-zero");
    assert(result[1] != 0, "player_state_hash should be non-zero");
    assert(result[2] != 0, "game_id should be non-zero");
}

// --- commit_five_nfts_join returns non-zero values ---

#[test]
unconstrained fn commit_join_returns_nonzero_values() {
    let (mut env, contract_address, minter, player) = utils::setup();

    // Mint 5 cards
    for i in 0..5 {
        env.call_private(
            minter,
            TripleTriadNFT::at(contract_address).mint_to_private(player, (i + 1) as Field, 0),
        );
    }
    env.call_private(
        player,
        TripleTriadNFT::at(contract_address).test_init_nonce(5),
    );

    let result: [Field; 2] = env.call_private(
        player,
        TripleTriadNFT::at(contract_address).commit_five_nfts_join(player, [1, 2, 3, 4, 5], 42),
    );

    // result = [card_commit_hash, player_state_hash]
    assert(result[0] != 0, "card_commit_hash should be non-zero");
    assert(result[1] != 0, "player_state_hash should be non-zero");
}

// --- commit_create different nonces produce different game_ids ---

#[test]
unconstrained fn different_nonces_produce_different_game_ids() {
    let (mut env, contract_address, minter, player) = utils::setup();

    // First set: mint cards [1..5] and commit
    for i in 0..5 {
        env.call_private(
            minter,
            TripleTriadNFT::at(contract_address).mint_to_private(player, (i + 1) as Field, 0),
        );
    }
    env.call_private(
        player,
        TripleTriadNFT::at(contract_address).test_init_nonce(5),
    );
    let result1: [Field; 3] = env.call_private(
        player,
        TripleTriadNFT::at(contract_address).commit_five_nfts_create(player, [1, 2, 3, 4, 5]),
    );

    // Second set: mint cards [11..15] and commit
    for i in 0..5 {
        env.call_private(
            minter,
            TripleTriadNFT::at(contract_address).mint_to_private(player, (i + 11) as Field, 0),
        );
    }
    // Nonce is now different (popped during first commit, new one pushed)
    // The test_init_nonce pushes a new nonce, but we need to check if one exists
    // After commit_five_nfts_create pops the nonce, there's no nonce left.
    // We need to push a new one.
    env.call_private(
        player,
        TripleTriadNFT::at(contract_address).test_init_nonce(10),
    );
    let result2: [Field; 3] = env.call_private(
        player,
        TripleTriadNFT::at(contract_address).commit_five_nfts_create(player, [11, 12, 13, 14, 15]),
    );

    // Different nonce values should produce different game_ids
    assert(result1[2] != result2[2], "game_ids should differ for different nonces");
}

// --- mint_to_private access control from game_contract ---

#[test(should_fail_with = "Only game contract or owner can commit")]
unconstrained fn commit_rejects_unauthorized_caller() {
    let (mut env, contract_address, minter, player) = utils::setup();

    // Mint 5 cards to player
    for i in 0..5 {
        env.call_private(
            minter,
            TripleTriadNFT::at(contract_address).mint_to_private(player, (i + 1) as Field, 0),
        );
    }
    env.call_private(
        player,
        TripleTriadNFT::at(contract_address).test_init_nonce(5),
    );

    // Minter (not game contract or player) tries to commit player's cards
    let _: [Field; 3] = env.call_private(
        minter,
        TripleTriadNFT::at(contract_address).commit_five_nfts_create(player, [1, 2, 3, 4, 5]),
    );
}
