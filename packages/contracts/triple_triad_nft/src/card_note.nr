//! The card note.
//!
//! A card is a note holding only its id. Its hash is built in two steps, the
//! way aztec-nr's `UintNote` builds its hash:
//!
//! ```text
//! partial   = poseidon2_sep([owner, randomness], DOM_SEP__PARTIAL_NOTE_COMMITMENT)
//! note_hash = compute_note_hash(storage_slot, [partial, card_id])
//! ```
//!
//! Splitting it means a card can be created in one of two ways and come out
//! identical:
//!
//! - the ordinary way, by someone who knows the owner and the randomness;
//! - by completing a `partial` that the owner prepared earlier, without the
//!   completer ever learning who the owner is.
//!
//! A settlement awards the prize card the second way: the winner committed a
//! partial when they joined, and settlement completes it with whichever card
//! they won. See docs/plan/PRIVATE_GAMES.md, section 3.1.
//!
//! Unlike aztec-nr's partial notes we emit no completion log. The owner always
//! knows the value already (their own card, or the prize they saw played), so
//! publishing it would only leak a card id.
use aztec::{
    context::PrivateContext,
    keys::getters::{get_nhk_app, get_public_keys, try_get_public_keys},
    macros::notes::custom_note,
    note::{
        note_interface::NoteHash,
        partial_note::DOM_SEP__PARTIAL_NOTE_COMMITMENT,
        utils::{compute_note_hash, compute_note_nullifier},
    },
    protocol::{
        address::AztecAddress,
        hash::poseidon2_hash_with_separator,
        traits::{Deserialize, Packable, Serialize, ToField},
    },
};

#[derive(Deserialize, Eq, Serialize, Packable)]
#[custom_note]
pub struct CardNote {
    pub card_id: Field,
}

impl NoteHash for CardNote {
    fn compute_note_hash(self, owner: AztecAddress, storage_slot: Field, randomness: Field) -> Field {
        complete_card_note_hash(card_partial_commitment(owner, randomness), storage_slot, self.card_id)
    }

    fn compute_nullifier(
        self,
        context: &mut PrivateContext,
        owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Field {
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let secret = context.request_nhk_app(owner_npk_m_hash);
        compute_note_nullifier(note_hash_for_nullification, [secret])
    }

    unconstrained fn compute_nullifier_unconstrained(
        self,
        owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Option<Field> {
        try_get_public_keys(owner).map(|public_keys| {
            let secret = get_nhk_app(public_keys.npk_m_hash);
            compute_note_nullifier(note_hash_for_nullification, [secret])
        })
    }
}

/// The owner-hiding half of a card note's hash.
pub fn card_partial_commitment(owner: AztecAddress, randomness: Field) -> Field {
    poseidon2_hash_with_separator([owner.to_field(), randomness], DOM_SEP__PARTIAL_NOTE_COMMITMENT)
}

/// A card note's hash, from its partial commitment.
pub fn complete_card_note_hash(partial: Field, storage_slot: Field, card_id: Field) -> Field {
    compute_note_hash(storage_slot, [partial, card_id])
}
