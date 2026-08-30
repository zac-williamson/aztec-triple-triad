use crate::TripleTriadNFT;
use crate::test::utils;

/// The arena bot is the ONE account allowed to hold duplicate cards. Everything
/// here is about the fence around that exemption: who may mint, who may
/// receive, and whether a slot can be repointed after the fact. If any of those
/// gives, the exemption becomes an unlimited card faucet for whoever holds it.

/// NOTE COUNTS ARE NOT AVAILABLE HERE. mint_bot_cards creates UNTAGGED notes
/// (create_and_push_note), which the PXE cannot discover without an explicit
/// import — that is deliberate, because the tagged path caps at ~84 notes per
/// finalisation window. So these tests assert on the ACCESS CONTROL and on the
/// public state the mint registers, which is what actually needs guarding.
unconstrained fn ranks_of(
    env: aztec::test::helpers::test_environment::TestEnvironment,
    contract_address: aztec::protocol::address::AztecAddress,
    token_id: Field,
) -> Field {
    // get_card_ranks is a #[view], so it is a public STATIC call.
    env.view_public(TripleTriadNFT::at(contract_address).get_card_ranks(token_id))
}

#[test]
unconstrained fn bot_may_hold_duplicates_of_one_card() {
    let (mut env, contract_address, minter, bot) = utils::setup();
    env.call_public(minter, TripleTriadNFT::at(contract_address).set_arena_bot(0 as Field, bot));

    // Three copies of the SAME token_id in one call, then three more in a second
    // call. Every other mint path asserts !nft_exists and would revert with
    // "Token already exists" on the second copy — this is the exemption, and it
    // is the whole reason the bot can hold a deep stock.
    let token_ids: [Field; 10] = [7, 7, 7, 0, 0, 0, 0, 0, 0, 0];
    let packed_ranks: [Field; 10] = [555; 10];
    let randomness: [Field; 10] = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    env.call_private(
        minter,
        TripleTriadNFT::at(contract_address).mint_bot_cards(0 as Field, token_ids, packed_ranks, randomness, 3 as u32),
    );

    let randomness2: [Field; 10] = [201, 202, 203, 204, 205, 206, 207, 208, 209, 210];
    env.call_private(
        minter,
        TripleTriadNFT::at(contract_address).mint_bot_cards(0 as Field, token_ids, packed_ranks, randomness2, 3 as u32),
    );

    // Ranks are registered once and left alone on the repeats.
    assert(ranks_of(env, contract_address, 7) == 555, "Ranks should be registered for card 7");
}

#[test(should_fail_with = "Only minter can mint")]
unconstrained fn bot_mint_rejects_non_minter() {
    let (mut env, contract_address, minter, bot) = utils::setup();
    env.call_public(minter, TripleTriadNFT::at(contract_address).set_arena_bot(0 as Field, bot));

    // The exemption is minter-gated. Without this, anyone could mint themselves
    // unlimited duplicates by naming the bot's slot.
    let token_ids: [Field; 10] = [7, 7, 7, 0, 0, 0, 0, 0, 0, 0];
    let packed_ranks: [Field; 10] = [0; 10];
    // Distinct randomness per note: it is what makes two notes of the SAME
    // token_id different, and therefore what makes their nullifiers differ.
    let randomness: [Field; 10] = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    env.call_private(
        bot,
        TripleTriadNFT::at(contract_address).mint_bot_cards(0 as Field, token_ids, packed_ranks, randomness, 3 as u32),
    );
}

#[test(should_fail_with = "Trying to read from uninitialized PublicImmutable")]
unconstrained fn bot_mint_rejects_an_unregistered_slot() {
    let (mut env, contract_address, minter, bot) = utils::setup();
    env.call_public(minter, TripleTriadNFT::at(contract_address).set_arena_bot(0 as Field, bot));

    // Slot 3 was never registered. The read itself reverts before the
    // contract's own "not registered" guard can run — that guard is therefore
    // unreachable, but the SAFETY holds: an unregistered slot cannot mint.
    // Asserting the message we actually get rather than the one we hoped for.
    let token_ids: [Field; 10] = [7, 7, 7, 0, 0, 0, 0, 0, 0, 0];
    let packed_ranks: [Field; 10] = [0; 10];
    // Distinct randomness per note: it is what makes two notes of the SAME
    // token_id different, and therefore what makes their nullifiers differ.
    let randomness: [Field; 10] = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    env.call_private(
        minter,
        TripleTriadNFT::at(contract_address).mint_bot_cards(3 as Field, token_ids, packed_ranks, randomness, 3 as u32),
    );
}

#[test(should_fail_with = "Only minter can set arena bot")]
unconstrained fn set_arena_bot_rejects_non_minter() {
    let (mut env, contract_address, _minter, bot) = utils::setup();
    env.call_public(bot, TripleTriadNFT::at(contract_address).set_arena_bot(0 as Field, bot));
}

#[test(should_fail)]
unconstrained fn an_arena_bot_slot_cannot_be_repointed() {
    let (mut env, contract_address, minter, bot) = utils::setup();
    env.call_public(minter, TripleTriadNFT::at(contract_address).set_arena_bot(0 as Field, bot));

    // Write-once is the safety property: if a slot could be repointed at a
    // player, that player would inherit the right to hold unlimited duplicates.
    let attacker = env.create_light_account();
    env.call_public(minter, TripleTriadNFT::at(contract_address).set_arena_bot(0 as Field, attacker));
}

#[test]
unconstrained fn bot_mint_registers_only_the_cards_within_count() {
    let (mut env, contract_address, minter, bot) = utils::setup();
    env.call_public(minter, TripleTriadNFT::at(contract_address).set_arena_bot(0 as Field, bot));

    // Three ids present, count of 2: the third must be ignored entirely, not
    // minted and not registered. Padding slots are how a ten-wide array carries
    // a batch of eight.
    let token_ids: [Field; 10] = [11, 12, 13, 0, 0, 0, 0, 0, 0, 0];
    let packed_ranks: [Field; 10] = [777; 10];
    let randomness: [Field; 10] = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    env.call_private(
        minter,
        TripleTriadNFT::at(contract_address).mint_bot_cards(0 as Field, token_ids, packed_ranks, randomness, 2 as u32),
    );

    assert(ranks_of(env, contract_address, 11) == 777, "Card 11 should be registered");
    assert(ranks_of(env, contract_address, 12) == 777, "Card 12 should be registered");

    // Card 13 was past the count, so nothing was registered for it. Proven by
    // registering it now with DIFFERENT ranks: finalize_bot_mint skips ids it
    // has already seen, so reading 888 back means the first call never touched
    // it. (Reading it directly would revert — card_ranks is a PublicImmutable.)
    let later_ids: [Field; 10] = [13, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    let later_ranks: [Field; 10] = [888; 10];
    let randomness2: [Field; 10] = [301, 302, 303, 304, 305, 306, 307, 308, 309, 310];
    env.call_private(
        minter,
        TripleTriadNFT::at(contract_address).mint_bot_cards(0 as Field, later_ids, later_ranks, randomness2, 1 as u32),
    );
    assert(ranks_of(env, contract_address, 13) == 888, "Card 13 must have been untouched by the first call");
}
