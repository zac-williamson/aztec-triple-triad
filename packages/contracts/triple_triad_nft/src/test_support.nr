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
    test::helpers::test_environment::TestEnvironment,
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
