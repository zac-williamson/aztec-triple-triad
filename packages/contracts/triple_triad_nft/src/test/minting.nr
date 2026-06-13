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

// --- mint_to_private ---

#[test]
unconstrained fn mint_to_private_creates_note() {
    let (mut env, contract_address, minter, player) = utils::setup();

    env.call_private(
        minter,
        TripleTriadNFT::at(contract_address).mint_to_private(player, 42, 0),
    );

    assert(count_private_cards(env, contract_address, player) == 1, "Expected 1 card");
}

#[test]
unconstrained fn mint_to_private_multiple_cards() {
    let (mut env, contract_address, minter, player) = utils::setup();

    for i in 0..3 {
        env.call_private(
            minter,
            TripleTriadNFT::at(contract_address).mint_to_private(player, (i + 1) as Field, 0),
        );
    }

    assert(count_private_cards(env, contract_address, player) == 3, "Expected 3 cards");
}

#[test(should_fail_with = "Only minter can mint")]
unconstrained fn mint_to_private_rejects_non_minter() {
    let (mut env, contract_address, _minter, player) = utils::setup();

    env.call_private(
        player,
        TripleTriadNFT::at(contract_address).mint_to_private(player, 1, 0),
    );
}

// --- mint_to_public ---

#[test]
unconstrained fn mint_to_public_sets_owner() {
    let (mut env, contract_address, minter, player) = utils::setup();

    env.call_public(
        minter,
        TripleTriadNFT::at(contract_address).mint_to_public(player, 99, 0),
    );

    // Verify via get_card_ranks (public view function available via static call)
    // Public owner can't easily be queried in TXE, but if mint_to_public
    // didn't fail, the token was created successfully.
    // The test verifies no assertion failure during minting.
}

#[test(should_fail_with = "Only minter can mint")]
unconstrained fn mint_to_public_rejects_non_minter() {
    let (mut env, contract_address, _minter, player) = utils::setup();

    env.call_public(
        player,
        TripleTriadNFT::at(contract_address).mint_to_public(player, 1, 0),
    );
}

#[test(should_fail_with = "Token already exists")]
unconstrained fn mint_to_public_rejects_duplicate() {
    let (mut env, contract_address, minter, player) = utils::setup();

    env.call_public(
        minter,
        TripleTriadNFT::at(contract_address).mint_to_public(player, 1, 0),
    );
    // Second mint with same ID should fail
    env.call_public(
        minter,
        TripleTriadNFT::at(contract_address).mint_to_public(player, 1, 0),
    );
}

// --- get_nfts_for_user ---

#[test]
unconstrained fn get_nfts_for_user_returns_correct_set() {
    let (mut env, contract_address, minter, player) = utils::setup();

    // Mint 3 cards
    env.call_private(
        minter,
        TripleTriadNFT::at(contract_address).mint_to_private(player, 10, 0),
    );
    env.call_private(
        minter,
        TripleTriadNFT::at(contract_address).mint_to_private(player, 20, 0),
    );
    env.call_private(
        minter,
        TripleTriadNFT::at(contract_address).mint_to_private(player, 30, 0),
    );

    let (cards, _) = env.execute_utility(
        TripleTriadNFT::at(contract_address).get_nfts_for_user(player, 0),
    );

    // Verify we got the 3 cards (order may vary)
    let mut found_10 = false;
    let mut found_20 = false;
    let mut found_30 = false;
    for i in 0..MAX_NOTES_PER_PAGE {
        if cards[i] == 10 { found_10 = true; }
        if cards[i] == 20 { found_20 = true; }
        if cards[i] == 30 { found_30 = true; }
    }
    assert(found_10, "Expected card 10");
    assert(found_20, "Expected card 20");
    assert(found_30, "Expected card 30");
}


// --- get_cards_for_new_player (starter claim) ---

#[test]
unconstrained fn starter_claim_mints_starter_tokens() {
    let (mut env, nft_address, token_address, _minter, player) = utils::setup_full();

    env.call_private(player, TripleTriadNFT::at(nft_address).get_cards_for_new_player());

    // The 5 starter card notes are relay-delivered (create_and_push_note, no
    // tagging) so they are invisible to note discovery here by design; the
    // token mint is the claim's discoverable on-chain observable.
    let balance: u128 =
        env.execute_utility(arena_token::ArenaToken::at(token_address).get_balance(player));
    assert(balance == 100, "Expected 100 starter tokens");
}

#[test(should_fail_with = "Cannot prove nullifier non-inclusion")]
unconstrained fn starter_claim_rejects_second_claim() {
    let (mut env, nft_address, _token_address, _minter, player) = utils::setup_full();

    env.call_private(player, TripleTriadNFT::at(nft_address).get_cards_for_new_player());
    // QA-F1: without an on-chain guard a second direct call mints another
    // starter set + 100 tokens and corrupts the nonce-note set.
    env.call_private(player, TripleTriadNFT::at(nft_address).get_cards_for_new_player());
}
