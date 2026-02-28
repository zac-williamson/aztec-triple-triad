use crate::TripleTriadNFT;
use crate::test::utils;
use aztec::note::constants::MAX_NOTES_PER_PAGE;

unconstrained fn count_private_cards(
    env: aztec::test::helpers::test_environment::TestEnvironment,
    contract_address: aztec::protocol::address::AztecAddress,
    player: aztec::protocol::address::AztecAddress,
) -> u32 {
    let (cards, _) = env.simulate_utility(
        TripleTriadNFT::at(contract_address).get_private_cards(player, 0),
    );
    let mut count: u32 = 0;
    for i in 0..MAX_NOTES_PER_PAGE {
        if cards[i] != 0 {
            count += 1;
        }
    }
    count
}

#[test]
unconstrained fn commit_five_nfts_removes_notes() {
    let (env, contract_address, _, player) = utils::setup();

    // Player claims starter set: inserts 5 notes with token_ids [1, 2, 3, 4, 5]
    env.call_private(
        player,
        TripleTriadNFT::at(contract_address).get_cards_for_new_player(),
    );

    assert(count_private_cards(env, contract_address, player) == 5, "Expected 5 cards after minting");

    // Commit (pop) the 5 notes
    env.call_private(
        player,
        TripleTriadNFT::at(contract_address).commit_five_nfts(player, [1, 2, 3, 4, 5]),
    );

    assert(count_private_cards(env, contract_address, player) == 0, "Expected 0 cards after commit");
}

#[test]
unconstrained fn commit_five_nfts_with_duplicate_leaves_one() {
    let (env, contract_address, minter, player) = utils::setup();

    // Mint a note with id=1 via minter (registers nft_exists[1] = true)
    env.call_private(
        minter,
        TripleTriadNFT::at(contract_address).mint_to_private(player, 1, 0),
    );

    // Player claims starter set [1,2,3,4,5]. finalize_starter_set uses soft
    // `if !exists` check, so id=1 already existing is fine. Player now has 6
    // private notes: [1, 1, 2, 3, 4, 5]
    env.call_private(
        player,
        TripleTriadNFT::at(contract_address).get_cards_for_new_player(),
    );

    assert(count_private_cards(env, contract_address, player) == 6, "Expected 6 cards after minting");

    // Commit 5 notes with ids [1, 2, 3, 4, 5] -should consume one of the two id=1 notes
    env.call_private(
        player,
        TripleTriadNFT::at(contract_address).commit_five_nfts(player, [1, 2, 3, 4, 5]),
    );

    // Should have exactly 1 note remaining (the second id=1 note)
    let (cards_after, _) = env.simulate_utility(
        TripleTriadNFT::at(contract_address).get_private_cards(player, 0),
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
    assert(remaining_id == 1, "Remaining card should have id=1");
}

#[test(should_fail_with = "Could not find all 5 cards")]
unconstrained fn commit_five_nfts_fails_with_only_four() {
    let (env, contract_address, minter, player) = utils::setup();

    // Mint only 4 notes: [1, 2, 3, 4]
    let ids: [Field; 4] = [1, 2, 3, 4];
    for i in 0..4 {
        env.call_private(
            minter,
            TripleTriadNFT::at(contract_address).mint_to_private(player, ids[i], 0),
        );
    }

    assert(count_private_cards(env, contract_address, player) == 4, "Expected 4 cards after minting");

    // This should fail -requesting 5 but only 4 exist
    env.call_private(
        player,
        TripleTriadNFT::at(contract_address).commit_five_nfts(player, [1, 2, 3, 4, 5]),
    );
}
