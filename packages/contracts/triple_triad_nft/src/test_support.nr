//! Test-environment helpers that other crates' tests need too (the game's).
//!
//! Plain functions, so nothing here is a contract entry point. Tests used to set
//! state up through `test_*` entry points on the contract itself, and those were
//! deployed with it: anyone could call them, and two minted any card to anyone.
use crate::TripleTriadNFT;
use aztec::{
    context::PrivateContext,
    protocol::address::AztecAddress,
    state_vars::{OwnedStateVariable, PrivateSet},
    test::helpers::{test_environment::TestEnvironment, txe_oracles},
};
use field_note::FieldNote;

/// Give `owner` a note nonce of `value`, as `get_cards_for_new_player` does on a
/// first claim. `commit_five_nfts_*` consume it.
pub unconstrained fn init_note_nonce(
    env: TestEnvironment,
    nft: AztecAddress,
    owner: AztecAddress,
    value: Field,
) {
    let message = env.private_context_at(nft, |context| {
        let nonce: PrivateSet<FieldNote, &mut PrivateContext> =
            PrivateSet::new(context, TripleTriadNFT::storage_layout().note_nonce.slot, owner);
        nonce.insert(FieldNote { value })
    });
    env.discover_note_at(nft, message);
}

/// Every card `owner` holds, read through `get_nfts_for_user`'s pages.
pub unconstrained fn cards_of(
    env: TestEnvironment,
    nft: AztecAddress,
    owner: AztecAddress,
) -> BoundedVec<Field, 40> {
    let mut cards: BoundedVec<Field, 40> = BoundedVec::new();
    let mut more = true;
    for page_index in 0..4 {
        if more {
            let (page, has_more) =
                env.execute_utility(TripleTriadNFT::at(nft).get_nfts_for_user(owner, page_index));
            for i in 0..aztec::note::constants::MAX_NOTES_PER_PAGE {
                if page[i] != 0 {
                    cards.push(page[i]);
                }
            }
            more = has_more;
        }
    }
    cards
}

/// The last transaction's effects, shaped the way `import_note` takes them:
/// `(tx_hash, unique_note_hashes, count, first_nullifier)`. Read it straight
/// after the transaction of interest -- any later one replaces it.
pub unconstrained fn last_tx_for_import() -> (Field, [Field; 64], u32, Field) {
    let effects = txe_oracles::get_last_tx_effects();
    let mut hashes: [Field; 64] = [0; 64];
    for i in 0..effects.note_hashes.len() {
        hashes[i] = effects.note_hashes.get(i);
    }
    (effects.tx_hash, hashes, effects.note_hashes.len(), effects.nullifiers.get(0))
}

/// Import one card a transaction released to `owner`, the way a client does:
/// from the owner's own data (card id, randomness) and the tx's effects.
pub unconstrained fn import_card(
    env: TestEnvironment,
    nft: AztecAddress,
    owner: AztecAddress,
    card_id: Field,
    randomness: Field,
    tx: (Field, [Field; 64], u32, Field),
) {
    let (tx_hash, hashes, count, first_nullifier) = tx;
    env.execute_utility(
        TripleTriadNFT::at(nft).import_note(
            owner,
            card_id,
            randomness,
            tx_hash,
            hashes,
            count,
            first_nullifier,
            owner,
        ),
    );
}
