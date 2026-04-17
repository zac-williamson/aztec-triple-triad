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

// Mint 5 cards individually using mint_to_private (standard note insertion).
// Also creates a note_nonce so commit_five_nfts_* can pop it.
unconstrained fn mint_starter_cards(
    env: &mut aztec::test::helpers::test_environment::TestEnvironment,
    contract_address: aztec::protocol::address::AztecAddress,
    minter: aztec::protocol::address::AztecAddress,
    player: aztec::protocol::address::AztecAddress,
) {
    for i in 0..5 {
        env.call_private(
            minter,
            TripleTriadNFT::at(contract_address).mint_to_private(player, (i + 1) as Field, 0),
        );
    }
    // Initialize nonce for player (needed by commit_five_nfts_*)
    env.call_private(
        player,
        TripleTriadNFT::at(contract_address).test_init_nonce(5),
    );
}

#[test]
unconstrained fn commit_five_nfts_create_removes_notes() {
    let (mut env, contract_address, minter, player) = utils::setup();

    mint_starter_cards(&mut env, contract_address, minter, player);

    assert(count_private_cards(env, contract_address, player) == 5, "Expected 5 cards after minting");

    let _: [Field; 3] = env.call_private(
        player,
        TripleTriadNFT::at(contract_address).commit_five_nfts_create(player, [1, 2, 3, 4, 5]),
    );

    assert(count_private_cards(env, contract_address, player) == 0, "Expected 0 cards after commit");
}

#[test]
unconstrained fn commit_five_nfts_join_removes_notes() {
    let (mut env, contract_address, minter, player) = utils::setup();

    mint_starter_cards(&mut env, contract_address, minter, player);

    assert(count_private_cards(env, contract_address, player) == 5, "Expected 5 cards after minting");

    let _: [Field; 2] = env.call_private(
        player,
        TripleTriadNFT::at(contract_address).commit_five_nfts_join(player, [1, 2, 3, 4, 5], 42),
    );

    assert(count_private_cards(env, contract_address, player) == 0, "Expected 0 cards after commit");
}

#[test]
unconstrained fn commit_five_nfts_with_duplicate_leaves_one() {
    let (mut env, contract_address, minter, player) = utils::setup();

    // Mint 6 cards: [1,2,3,4,5] + an extra card 6
    for i in 0..6 {
        env.call_private(
            minter,
            TripleTriadNFT::at(contract_address).mint_to_private(player, (i + 1) as Field, 0),
        );
    }
    env.call_private(
        player,
        TripleTriadNFT::at(contract_address).test_init_nonce(5),
    );

    assert(count_private_cards(env, contract_address, player) == 6, "Expected 6 cards after minting");

    // Commit 5 notes: [1,2,3,4,5] -- should leave card 6 remaining
    let _: [Field; 3] = env.call_private(
        player,
        TripleTriadNFT::at(contract_address).commit_five_nfts_create(player, [1, 2, 3, 4, 5]),
    );

    let (cards_after, _) = env.execute_utility(
        TripleTriadNFT::at(contract_address).get_nfts_for_user(player, 0),
    );

    let mut remaining_count: u32 = 0;
    let mut remaining_id: Field = 0;
    for i in 0..MAX_NOTES_PER_PAGE {
        if cards_after[i] != 0 {
            remaining_count += 1;
            remaining_id = cards_after[i];
        }
    }
    assert(remaining_count == 1, "Expected 1 card remaining");
    assert(remaining_id == 6, "Remaining card should have id=6");
}

#[test(should_fail_with = "Could not find all 5 cards")]
unconstrained fn commit_five_nfts_fails_with_only_four() {
    let (mut env, contract_address, minter, player) = utils::setup();

    // First set up the player's note_nonce by claiming starter set
    mint_starter_cards(&mut env, contract_address, minter, player);

    // Commit the 5 starter cards to clear them
    let _: [Field; 3] = env.call_private(
        player,
        TripleTriadNFT::at(contract_address).commit_five_nfts_create(player, [1, 2, 3, 4, 5]),
    );

    // Mint only 4 notes with NEW unique IDs: [11, 12, 13, 14]
    let ids: [Field; 4] = [11, 12, 13, 14];
    for i in 0..4 {
        env.call_private(
            minter,
            TripleTriadNFT::at(contract_address).mint_to_private(player, ids[i], 0),
        );
    }

    assert(count_private_cards(env, contract_address, player) == 4, "Expected 4 cards after minting");

    // This should fail -- requesting 5 but only 4 exist
    let _: [Field; 2] = env.call_private(
        player,
        TripleTriadNFT::at(contract_address).commit_five_nfts_join(player, [11, 12, 13, 14, 15], 99),
    );
}
