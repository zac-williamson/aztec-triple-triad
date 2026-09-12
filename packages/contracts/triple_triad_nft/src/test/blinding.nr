//! The blinding factor: the one thing binding a hand commitment to one game.
//!
//! Was `card_packs.nr`. The card-pack tests it also held went with the two-phase
//! pack flow when that was reverted; these never depended on it.

use crate::derive_blinding_factor;

/// Barrier against nargo's constant folding. A comparison whose operands are all
/// compile-time constants is folded, and one that folds to FALSE has its
/// assertion DROPPED rather than failed — which turns a should_fail test into one
/// that silently checks nothing.
fn f(x: Field) -> Field {
    std::hint::black_box(x)
}

// ---------------- the blinding factor ----------------
//
// Not a card-pack property, but the same class of finding: a derivation that
// several call sites depend on and nothing pinned.


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
