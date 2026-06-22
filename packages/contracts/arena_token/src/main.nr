mod test;

use aztec::macros::aztec;

/// Domain separator for the deterministic, recipient-derivable randomness of a
/// reward balance note. "ArenaReward" as big-endian ASCII. Keeps the reward
/// note's randomness distinct from any card-note randomness.
global REWARD_NOTE_IV: Field = 0x4172656e61526577617264;

/// Arena Token - private fungible token for the Aztec Arena game.
///
/// Minting authority is shared between admin, NFT contract, and game contract.
/// - NFT contract mints 100 tokens during new player onboarding
/// - Game contract mints 20 tokens to each player after settlement
/// - NFT contract burns 100 tokens when a player purchases a card pack
///
/// The game submitter (winner) discovers their own +20 reward via the normal
/// ONCHAIN_CONSTRAINED delivery (their PXE proved the settle tx). The OTHER
/// player (loser / draw opponent) never proved the tx and so cannot discover an
/// ONCHAIN_CONSTRAINED note. For them the game uses `mint_reward`, which creates
/// a DISCOVERABLE balance note with deterministic, recipient-derivable
/// randomness (mirroring the NFT card flow): the note hash lands in the tx
/// effects, the winner relays `(amount, randomness)`, and the recipient injects
/// it into their PXE via `import_note`. The reward stays a real balance note, so
/// it is spendable via `burn_from`.
#[aztec]
pub contract ArenaToken {
    use aztec::{
        context::PrivateContext,
        macros::{
            functions::{external, initializer},
            storage::storage,
        },
        messages::{
            discovery::private_notes::process_private_note_msg,
            encoding::{decode_message, MESSAGE_PLAINTEXT_LEN},
            logs::note::encode_private_note_message,
            delivery::MessageDelivery,
            processing::validate_and_store_enqueued_notes_and_events,
        },
        note::note_interface::{NoteHash, NoteType},
        oracle::notes::notify_created_note,
        protocol::{
            address::AztecAddress,
            constants::MAX_NOTE_HASHES_PER_TX,
            hash::poseidon2_hash,
            traits::{Packable, ToField},
        },
        state_vars::{Owned, PublicImmutable},
    };

    use balance_set::BalanceSet;
    use uint_note::UintNote;

    use super::REWARD_NOTE_IV;

    #[storage]
    struct Storage<Context> {
        admin: PublicImmutable<AztecAddress, Context>,
        nft_contract: PublicImmutable<AztecAddress, Context>,
        game_contract: PublicImmutable<AztecAddress, Context>,
        balances: Owned<BalanceSet<Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(admin: AztecAddress) {
        self.storage.admin.initialize(admin);
    }

    /// Set the NFT contract address. Admin only. Can only be called once.
    #[external("public")]
    fn set_nft_contract(addr: AztecAddress) {
        assert(self.msg_sender() == self.storage.admin.read(), "Only admin");
        self.storage.nft_contract.initialize(addr);
    }

    /// Set the game contract address. Admin only. Can only be called once.
    #[external("public")]
    fn set_game_contract(addr: AztecAddress) {
        assert(self.msg_sender() == self.storage.admin.read(), "Only admin");
        self.storage.game_contract.initialize(addr);
    }

    /// Mint tokens to a recipient's private balance.
    /// Only callable by admin, NFT contract, or game contract.
    ///
    /// Delivered ONCHAIN_CONSTRAINED, so the recipient discovers it only if they
    /// proved this tx (onboarding: the player; settlement: the winner). For a
    /// recipient who did NOT prove the tx, use `mint_reward` instead.
    #[external("private")]
    fn mint_private(to: AztecAddress, amount: u128) {
        let caller = self.msg_sender();
        let admin = self.storage.admin.read();
        let nft = self.storage.nft_contract.read();
        let game = self.storage.game_contract.read();
        assert(
            (caller == admin) | (caller == nft) | (caller == game),
            "Unauthorized: only admin, NFT, or game contract can mint",
        );

        self.storage.balances.at(to).add(amount).deliver(MessageDelivery::onchain_constrained());
    }

    /// Mint a reward to a recipient who is NOT the tx submitter (the game loser,
    /// or either player on a draw besides the submitter), as a DISCOVERABLE
    /// balance note. Only callable by admin or the game contract.
    ///
    /// The note randomness is derived deterministically from the recipient's
    /// PRIVATE per-game randomness (`player_randomness`, the [Field; 6] committed
    /// via their player_state_hash) -- known to both the winner (a settle input)
    /// and the loser (their own state), but not publicly computable. The
    /// recipient imports the note via `import_note`.
    #[external("private")]
    fn mint_reward(to: AztecAddress, amount: u128, player_randomness: [Field; 6]) {
        let caller = self.msg_sender();
        let admin = self.storage.admin.read();
        let game = self.storage.game_contract.read();
        assert(
            (caller == admin) | (caller == game),
            "Unauthorized: only admin or game contract can mint rewards",
        );
        let randomness = derive_reward_randomness(player_randomness);
        let _ = create_and_push_reward_note(self.context, to, amount, randomness);
    }

    /// Burn tokens from a player's private balance.
    /// Only callable by the NFT contract (for card pack purchases).
    /// The `from` address is the player whose tokens are burned.
    #[external("private")]
    fn burn_from(from: AztecAddress, amount: u128) {
        let caller = self.msg_sender();
        let nft = self.storage.nft_contract.read();
        assert(caller == nft, "Only NFT contract can burn");

        self.storage.balances.at(from).sub(amount).deliver(MessageDelivery::onchain_constrained());
    }

    /// Query a player's private token balance (unconstrained, runs client-side).
    #[external("utility")]
    unconstrained fn get_balance(owner: AztecAddress) -> u128 {
        self.storage.balances.at(owner).balance_of()
    }

    // Updates are applied by FRESH REDEPLOY (new addresses), not the Aztec
    // contract-class upgrade pattern. See docs/plan/UPDATE_MODEL.md.

    /// Frontend getter: compute a reward note's randomness from the recipient's
    /// per-game randomness, so the winner can relay it (or the loser derive it).
    /// NFT analog: `compute_blinding_factor`. Call via `.simulate()`.
    #[external("utility")]
    unconstrained fn compute_reward_randomness(player_randomness: [Field; 6]) -> Field {
        derive_reward_randomness(player_randomness)
    }

    /// Import a reward balance note created by a settlement tx into the
    /// recipient's PXE. Called via `.simulate()` -- NO on-chain tx. Mirrors the
    /// NFT's `import_note`: encode the note as a standard private-note message,
    /// run discovery, and validate it against the on-chain tree.
    #[external("utility")]
    unconstrained fn import_note(
        owner: AztecAddress,
        value: u128,
        randomness: Field,
        tx_hash: Field,
        unique_note_hashes: [Field; 64],
        num_note_hashes: u32,
        first_nullifier: Field,
        recipient: AztecAddress,
    ) {
        let address = aztec::context::UtilityContext::new().this_address();
        // BalanceSet wraps a PrivateSet at the BASE slot (owner distinguishes
        // notes), like the NFT's Owned<PrivateSet>. Use the generated layout.
        let storage_slot = ArenaToken::storage_layout().balances.slot;

        let note = UintNote { value };

        let mut unique_hashes_vec: BoundedVec<Field, MAX_NOTE_HASHES_PER_TX> = BoundedVec::new();
        for i in 0..64 {
            if (i as u32) < num_note_hashes {
                unique_hashes_vec.push(unique_note_hashes[i]);
            }
        }

        let message: BoundedVec<Field, MESSAGE_PLAINTEXT_LEN> = BoundedVec::from_array(
            encode_private_note_message(note, owner, storage_slot, randomness),
        );
        let (_msg_type_id, msg_metadata, msg_content) = decode_message(message).unwrap();
        process_private_note_msg(
            address,
            tx_hash,
            unique_hashes_vec,
            first_nullifier,
            _compute_note_hash,
            _compute_note_nullifier,
            msg_metadata,
            msg_content,
        );

        validate_and_store_enqueued_notes_and_events(recipient);
    }

    /// Derive the deterministic, recipient-derivable randomness for a reward note
    /// from the recipient's private per-game randomness. The inputs are private
    /// (only the committed hash is public), so the result is not publicly
    /// computable, preserving the note's unlinkability.
    #[contract_library_method]
    fn derive_reward_randomness(player_randomness: [Field; 6]) -> Field {
        poseidon2_hash([
            player_randomness[0],
            player_randomness[1],
            player_randomness[2],
            player_randomness[3],
            player_randomness[4],
            player_randomness[5],
            REWARD_NOTE_IV,
        ])
    }

    /// Create a discoverable `UintNote` in `owner`'s balance set with explicit,
    /// recipient-derivable randomness and push its hash into the tx. Does NOT
    /// deliver/tag (the caller relays randomness; the recipient imports). The
    /// note is a real balance note, summed by `balance_of` and spendable by
    /// `burn_from` once imported. Mirrors the NFT's `create_and_push_note`.
    #[contract_library_method]
    fn create_and_push_reward_note(
        context: &mut PrivateContext,
        owner: AztecAddress,
        value: u128,
        randomness: Field,
    ) -> Field {
        let note = UintNote { value };
        let note_hash_counter = context.side_effect_counter;
        let storage_slot = ArenaToken::storage_layout().balances.slot;
        // UintNote is a partial note; its hash uses a commitment scheme, so we
        // call its own compute_note_hash rather than re-deriving by hand.
        let note_hash = note.compute_note_hash(owner, storage_slot, randomness);

        notify_created_note(
            owner,
            storage_slot,
            randomness,
            UintNote::get_id(),
            note.pack(),
            note_hash,
            note_hash_counter,
        );
        context.push_note_hash(note_hash);
        note_hash
    }
}
