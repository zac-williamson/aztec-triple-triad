//! Card packs: buy, then open.
//!
//! The split exists because the old one-shot `purchase_card_pack` seeded its
//! cards from `nhk_app_secret` — key material the player chooses — and
//! `preview_card_ids` answered "what would this account get?" for free,
//! offline, before any money moved. Generating accounts until one previewed a
//! pack of legendaries cost nothing. These tests pin the properties that fix:
//! the roll is fixed after the buyer has committed, it is fixed once, and it
//! cannot be re-rolled or replayed.

use crate::{derive_pack_key, TripleTriadNFT};
use crate::test::utils;
use arena_token::ArenaToken;
use aztec::protocol::traits::ToField;

/// Barrier against nargo's constant folding. A comparison whose operands are
/// all compile-time constants is folded, and one that folds to FALSE has its
/// assertion DROPPED rather than failed — which turns a should_fail test into
/// one that silently checks nothing. Every literal below goes through this.
fn f(x: Field) -> Field {
    std::hint::black_box(x)
}

// ---------------- the derivations, directly ----------------

#[test]
fn a_packs_key_is_specific_to_its_buyer() {
    // Two buyers at the same nonce must not share a pack slot: one player's
    // purchase would otherwise reserve — or consume — the other's.
    assert(derive_pack_key(f(0xa1), f(5)) != derive_pack_key(f(0xa2), f(5)));
}

#[test]
fn a_packs_key_is_specific_to_its_nonce() {
    assert(derive_pack_key(f(0xa1), f(5)) != derive_pack_key(f(0xa1), f(15)));
}

#[test]
fn every_input_moves_the_entropy() {
    // Each of these is a thing the buyer does not control, and each must
    // actually reach the output — an ignored input is an input an attacker can
    // stop worrying about.
    let base = crate::derive_pack_entropy(f(0), f(100), f(1000));
    assert(base != crate::derive_pack_entropy(f(1), f(100), f(1000)), "accumulator ignored");
    assert(base != crate::derive_pack_entropy(f(0), f(101), f(1000)), "block number ignored");
    assert(base != crate::derive_pack_entropy(f(0), f(100), f(1001)), "timestamp ignored");
}

// ---------------- buying ----------------

/// A new player: 5 starter cards, note nonce 5, 100 Arena Tokens.
unconstrained fn new_player_with_tokens() -> (
    aztec::test::helpers::test_environment::TestEnvironment,
    aztec::protocol::address::AztecAddress,
    aztec::protocol::address::AztecAddress,
    aztec::protocol::address::AztecAddress,
    aztec::protocol::address::AztecAddress,
) {
    let (mut env, nft, token, minter, player) = utils::setup_full();
    env.call_private(player, TripleTriadNFT::at(nft).get_cards_for_new_player());
    (env, nft, token, minter, player)
}

#[test]
unconstrained fn buying_a_pack_costs_tokens_and_reserves_a_roll() {
    let (mut env, nft, token, _minter, player) = new_player_with_tokens();

    let key = derive_pack_key(player.to_field(), 5);
    let before = env.view_public(TripleTriadNFT::at(nft).get_pack_entropy(key));
    assert(before == 0, "Nothing should be reserved before the purchase");

    env.call_private(player, TripleTriadNFT::at(nft).purchase_card_pack());

    let balance: u128 = env.execute_utility(ArenaToken::at(token).get_balance(player));
    assert(balance == 0, "The pack should have cost 100 tokens");

    let entropy = env.view_public(TripleTriadNFT::at(nft).get_pack_entropy(key));
    assert(entropy != 0, "Buying must reserve a roll");
    assert(entropy != 1, "A fresh pack must not read as already opened");
}

#[test]
unconstrained fn two_packs_do_not_roll_the_same_entropy() {
    // The accumulator chains each pack into the next. Without it every pack
    // bought in one block would roll identically, and a buyer who liked one
    // roll could buy the same cards repeatedly.
    let (mut env, nft, token, minter, player) = new_player_with_tokens();
    env.call_private(minter, ArenaToken::at(token).mint_private(player, 100));

    env.call_private(player, TripleTriadNFT::at(nft).purchase_card_pack());
    let first = env.view_public(
        TripleTriadNFT::at(nft).get_pack_entropy(derive_pack_key(player.to_field(), 5)),
    );

    env.call_private(player, TripleTriadNFT::at(nft).purchase_card_pack());
    let second = env.view_public(
        TripleTriadNFT::at(nft).get_pack_entropy(derive_pack_key(player.to_field(), 15)),
    );

    assert(first != second, "Two packs must not roll the same entropy");
}

// ---------------- opening ----------------

#[test]
unconstrained fn a_bought_pack_opens_once() {
    let (mut env, nft, _token, _minter, player) = new_player_with_tokens();
    let key = derive_pack_key(player.to_field(), 5);

    env.call_private(player, TripleTriadNFT::at(nft).purchase_card_pack());
    let entropy = env.view_public(TripleTriadNFT::at(nft).get_pack_entropy(key));

    // The ten card notes are relay-delivered (create_and_push_note, no tagging)
    // so they are invisible to note discovery here by design, exactly as the
    // starter cards are. The pack's retirement is the on-chain observable.
    env.call_private(player, TripleTriadNFT::at(nft).open_card_pack(5, entropy));

    assert(
        env.view_public(TripleTriadNFT::at(nft).get_pack_entropy(key)) == 1,
        "An opened pack must be retired",
    );
}

#[test(should_fail_with = "Pack already opened")]
unconstrained fn a_pack_cannot_be_opened_twice() {
    // Ten cards for one payment, repeatable without limit.
    let (mut env, nft, _token, _minter, player) = new_player_with_tokens();
    let key = derive_pack_key(player.to_field(), 5);

    env.call_private(player, TripleTriadNFT::at(nft).purchase_card_pack());
    let entropy = env.view_public(TripleTriadNFT::at(nft).get_pack_entropy(key));

    env.call_private(player, TripleTriadNFT::at(nft).open_card_pack(5, entropy));
    env.call_private(player, TripleTriadNFT::at(nft).open_card_pack(5, entropy));
}

#[test(should_fail_with = "Pack entropy mismatch")]
unconstrained fn a_buyer_may_not_choose_their_own_roll() {
    // THE finding. Naming your own entropy is the grind, moved from choosing an
    // account to choosing an argument. The private half will happily mint cards
    // from it; the public half is what rejects the transaction, and a public
    // revert discards those notes with it.
    let (mut env, nft, _token, _minter, player) = new_player_with_tokens();

    env.call_private(player, TripleTriadNFT::at(nft).purchase_card_pack());
    env.call_private(player, TripleTriadNFT::at(nft).open_card_pack(5, 0xdecafbad));
}

#[test(should_fail_with = "No pack bought at this key")]
unconstrained fn a_pack_that_was_never_bought_cannot_be_opened() {
    let (mut env, nft, _token, _minter, player) = new_player_with_tokens();
    env.call_private(player, TripleTriadNFT::at(nft).open_card_pack(5, 0xdecafbad));
}

// ---------------- the blinding factor ----------------
//
// Not a card-pack property, but the same class of finding: a derivation that
// several call sites depend on and nothing pinned.

use crate::derive_blinding_factor;

#[test]
fn a_hand_commitment_is_bound_to_one_game() {
    // THE property. `card_commit = poseidon2([card_ids[0..5], blinding])`, so if
    // `game_id` did not reach the blinding factor the same five cards would
    // commit to the same value in every game — and a move proof built for one
    // game would verify against another's transcript. The register's T4 rests
    // on this single line.
    assert(
        derive_blinding_factor(f(0x5ec), f(0xc0117421), f(1))
            != derive_blinding_factor(f(0x5ec), f(0xc0117421), f(2)),
        "game_id does not reach the blinding factor",
    );
}

#[test]
fn a_hand_commitment_is_bound_to_one_deployment() {
    // Without the contract address a commitment made against one deployment is
    // replayable against another. Two live at once whenever a redeploy is in
    // flight.
    assert(
        derive_blinding_factor(f(0x5ec), f(0xc0117421), f(1))
            != derive_blinding_factor(f(0x5ec), f(0xdeb10bed), f(1)),
        "contract address does not reach the blinding factor",
    );
}

#[test]
fn a_hand_commitment_is_bound_to_its_owner() {
    // The secret is what makes the commitment hiding at all: without it anyone
    // could recompute a player's blinding factor and open their hand.
    assert(
        derive_blinding_factor(f(0x5ec), f(0xc0117421), f(1))
            != derive_blinding_factor(f(0x5ecb), f(0xc0117421), f(1)),
        "nhk_app_secret does not reach the blinding factor",
    );
}

#[test]
fn the_extracted_derivation_is_the_one_the_contract_used_before() {
    // This extraction must not have CHANGED the blinding factor, only moved it.
    // `aztec::protocol::hash::poseidon2_hash(x)` is defined as
    // `poseidon::poseidon2::Poseidon2::hash(x, N)` (protocol-circuits
    // types/src/hash.nr:211) and the contract pins the same poseidon tag
    // aztec-nr does, so the two are the same function — asserted here rather
    // than assumed, because a silent change would invalidate every hand
    // commitment made against the old derivation.
    let by_hand = aztec::protocol::hash::poseidon2_hash([0x5ec, 0xc0117421, 7]);
    assert(derive_blinding_factor(0x5ec, 0xc0117421, 7) == by_hand);
}
