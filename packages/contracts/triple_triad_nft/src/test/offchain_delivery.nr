//! Card notes delivered as v6 offchain messages (docs/plan/OFFCHAIN_DELIVERY.md).
//!
//! Notes made with our own randomness are untagged, so note discovery never
//! finds them. These tests show that the standard note message, delivered
//! offchain and handed to the macro-injected `offchain_receive`, makes them
//! visible with no `import_note` at all — and that the one mint which must NOT
//! send messages, the bot's stock, sends none.
use crate::TripleTriadNFT;
use crate::test::utils;
use aztec::{
    messages::processing::offchain::{MAX_OFFCHAIN_MESSAGES_PER_RECEIVE_CALL, OffchainMessage},
    note::constants::MAX_NOTES_PER_PAGE,
    protocol::address::AztecAddress,
    test::helpers::test_environment::TestEnvironment,
};

/// Enough pages for every test here (a pack takes a player past one page).
global MAX_PAGES: u32 = 4;
global MAX_CARDS: u32 = 40;

/// Every card the player holds. `get_nfts_for_user` pages at
/// MAX_NOTES_PER_PAGE (10), so read on while it reports more.
unconstrained fn cards_of(
    env: TestEnvironment,
    nft: AztecAddress,
    player: AztecAddress,
) -> BoundedVec<Field, MAX_CARDS> {
    let mut cards: BoundedVec<Field, MAX_CARDS> = BoundedVec::new();
    let mut more = true;
    for page_index in 0..MAX_PAGES {
        if more {
            let (page, has_more) = env.execute_utility(
                TripleTriadNFT::at(nft).get_nfts_for_user(player, page_index),
            );
            for i in 0..MAX_NOTES_PER_PAGE {
                if page[i] != 0 {
                    cards.push(page[i]);
                }
            }
            more = has_more;
        }
    }
    cards
}

/// The last top-level call's offchain messages, as one `offchain_receive` batch.
///
/// Read this straight after the call: any later top-level call, a utility
/// included, replaces what TXE reports as "the last call".
unconstrained fn last_call_messages(
    env: TestEnvironment,
) -> BoundedVec<OffchainMessage, MAX_OFFCHAIN_MESSAGES_PER_RECEIVE_CALL> {
    let messages = env.offchain_messages();
    let mut batch: BoundedVec<OffchainMessage, MAX_OFFCHAIN_MESSAGES_PER_RECEIVE_CALL> =
        BoundedVec::new();
    for i in 0..messages.len() {
        batch.push(messages.get(i));
    }
    batch
}

unconstrained fn count_of(cards: BoundedVec<Field, MAX_CARDS>, id: Field) -> u32 {
    let mut n: u32 = 0;
    for i in 0..cards.len() {
        if cards.get(i) == id {
            n += 1;
        }
    }
    n
}

#[test]
unconstrained fn starter_cards_arrive_through_offchain_receive() {
    let (env, nft, _token, _minter, player) = utils::setup_full();

    env.call_private(player, TripleTriadNFT::at(nft).get_cards_for_new_player());
    let messages = last_call_messages(env);

    // One note message per card, all for the player, all tied to the claim tx.
    assert_eq(messages.len(), 5, "expected one offchain message per starter card");
    for i in 0..messages.len() {
        assert_eq(messages.get(i).recipient, player);
        assert(messages.get(i).tx_hash.is_some(), "message must name its tx");
    }

    // Untagged notes: invisible until the messages are received.
    assert_eq(cards_of(env, nft, player).len(), 0, "notes visible before receive");

    env.execute_utility(TripleTriadNFT::at(nft).offchain_receive(messages));

    let cards = cards_of(env, nft, player);
    assert_eq(cards.len(), 5, "expected the 5 starter cards after receive");
    for id in 1..6 {
        assert_eq(count_of(cards, id as Field), 1, "starter id missing or duplicated");
    }
}

#[test]
unconstrained fn pack_cards_arrive_through_offchain_receive() {
    let (env, nft, _token, _minter, player) = utils::setup_full();

    env.call_private(player, TripleTriadNFT::at(nft).get_cards_for_new_player());
    let starter = last_call_messages(env);
    env.execute_utility(TripleTriadNFT::at(nft).offchain_receive(starter));

    env.call_private(player, TripleTriadNFT::at(nft).purchase_card_pack());
    let pack = last_call_messages(env);
    assert_eq(pack.len(), 10, "expected one offchain message per pack card");

    assert_eq(cards_of(env, nft, player).len(), 5, "pack cards visible before receive");

    env.execute_utility(TripleTriadNFT::at(nft).offchain_receive(pack));

    assert_eq(cards_of(env, nft, player).len(), 15, "expected 5 starter + 10 pack cards");
}

#[test]
unconstrained fn settlement_cards_arrive_for_their_owner_not_the_sender() {
    // `game` stands in for the game contract, sending the settlement's mint.
    let (mut env, nft, _minter, _player, game) = utils::setup_with_game();
    let owner = env.create_light_account();
    let ids: [Field; 6] = [1, 2, 3, 4, 5, 6];
    let randomness: [Field; 6] = [11, 12, 13, 14, 15, 16];

    // Settlement mints to both players from one player's tx. The messages must
    // be addressed to each card's OWNER, not to whoever sent the tx: the sender
    // can only forward the other player's.
    env.call_private(
        game,
        TripleTriadNFT::at(nft).mint_for_game_winner(ids, owner, randomness),
    );
    let messages = last_call_messages(env);
    assert_eq(messages.len(), 6, "expected one offchain message per minted card");
    for i in 0..messages.len() {
        assert_eq(messages.get(i).recipient, owner, "message not addressed to the card's owner");
    }

    assert_eq(cards_of(env, nft, owner).len(), 0, "notes visible before receive");

    env.execute_utility(TripleTriadNFT::at(nft).offchain_receive(messages));

    assert_eq(cards_of(env, nft, owner).len(), 6, "expected all six cards after receive");
    assert_eq(cards_of(env, nft, game).len(), 0, "the sender must not gain the owner's cards");
}

#[test]
unconstrained fn bot_stock_mint_sends_no_messages() {
    let (env, nft, minter, bot) = utils::setup();
    env.call_public(minter, TripleTriadNFT::at(nft).set_arena_bot(0 as Field, bot));

    let token_ids: [Field; 10] = [7, 8, 9, 0, 0, 0, 0, 0, 0, 0];
    let packed_ranks: [Field; 10] = [555; 10];
    let randomness: [Field; 10] = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
    env.call_private(
        minter,
        TripleTriadNFT::at(nft).mint_bot_cards(0 as Field, token_ids, packed_ranks, randomness, 3 as u32),
    );

    // The bot imports its stock from the provisioner's manifest. A received
    // message stays in the inbox until its block finalizes and its tx receipt
    // is re-fetched on every contract sync — a hundred reads per sync for a
    // thousand-card stock. See mint_bot_cards.
    assert_eq(env.offchain_messages().len(), 0, "the bot's stock must not send offchain messages");
}

#[test]
unconstrained fn receiving_twice_does_not_duplicate_cards() {
    let (env, nft, _token, _minter, player) = utils::setup_full();

    env.call_private(player, TripleTriadNFT::at(nft).get_cards_for_new_player());
    let messages = last_call_messages(env);

    // A retried delivery, e.g. after a reload, must be harmless.
    env.execute_utility(TripleTriadNFT::at(nft).offchain_receive(messages));
    env.execute_utility(TripleTriadNFT::at(nft).offchain_receive(messages));

    assert_eq(cards_of(env, nft, player).len(), 5, "duplicate delivery duplicated cards");
}
