mod test;

use aztec::macros::aztec;

/// Arena Token - private fungible token for the Aztec Arena game.
///
/// Minting authority is shared between admin, NFT contract, and game contract.
/// - NFT contract mints 100 tokens during new player onboarding
/// - NFT contract burns 100 tokens when a player purchases a card pack
/// - Game contract releases each player's prepared 20-token reward at settlement
///
/// Game rewards are not minted to an address. Each player PREPARES their own
/// reward note when they commit to a game (the NFT computes it from the
/// player's own secrets), and settlement releases the prepared hash with
/// `release_reward_notes`. Nobody but the owner ever knows who a reward note
/// belongs to; the owner imports it from the settlement tx with `import_note`.
/// See docs/plan/PRIVATE_GAMES.md section 3.6.
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

    /// Release prepared reward notes: push each non-zero hash. The hashes are
    /// `UintNote` hashes the players' own commits prepared (owner, amount and
    /// randomness all fixed then), so this needs to know nothing about whom
    /// they belong to. Only the game contract may release.
    #[external("private")]
    fn release_reward_notes(note_hashes: [Field; 2]) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can release rewards");
        for i in 0..2 {
            if note_hashes[i] != 0 {
                self.context.push_note_hash(note_hashes[i]);
            }
        }
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
}
