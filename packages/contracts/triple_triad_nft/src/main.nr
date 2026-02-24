use aztec::macros::aztec;

/// Triple Triad NFT contract.
/// Each card is an NFT with a unique token_id corresponding to the card's ID.
/// Supports private ownership for hidden hand information and public ownership for trading.
#[aztec]
pub contract TripleTriadNFT {
    use aztec::{
        macros::{
            events::event,
            functions::{external, initializer, only_self, view},
            notes::custom_note,
            storage::storage,
        },
        keys::getters::{get_nhk_app, get_public_keys, try_get_public_keys},
        messages::message_delivery::MessageDelivery,
        note::{
            constants::MAX_NOTES_PER_PAGE,
            note_getter_options::NoteGetterOptions,
            note_interface::{NoteHash, NoteProperties},
            note_viewer_options::NoteViewerOptions,
        },
        protocol::{
            address::AztecAddress,
            constants::{DOM_SEP__NOTE_HASH, DOM_SEP__NOTE_NULLIFIER},
            hash::poseidon2_hash_with_separator,
            traits::{Hash, Packable, Serialize, ToField},
        },
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable},
        utils::comparison::Comparator,
    };
    use compressed_string::FieldCompressedString;

    // --- Note ---

    #[derive(Eq, Serialize, Packable)]
    #[custom_note]
    pub struct CardNote {
        pub token_id: Field,
    }

    impl NoteHash for CardNote {
        fn compute_note_hash(
            self,
            owner: AztecAddress,
            storage_slot: Field,
            randomness: Field,
        ) -> Field {
            poseidon2_hash_with_separator(
                [storage_slot, self.token_id, owner.to_field(), randomness],
                DOM_SEP__NOTE_HASH,
            )
        }

        fn compute_nullifier(
            self,
            context: &mut aztec::context::PrivateContext,
            owner: AztecAddress,
            note_hash_for_nullification: Field,
        ) -> Field {
            let owner_npk_m = get_public_keys(owner).npk_m;
            let owner_npk_m_hash = owner_npk_m.hash();
            let secret = context.request_nhk_app(owner_npk_m_hash);
            poseidon2_hash_with_separator(
                [note_hash_for_nullification, secret],
                DOM_SEP__NOTE_NULLIFIER,
            )
        }

        unconstrained fn compute_nullifier_unconstrained(
            self,
            owner: AztecAddress,
            note_hash_for_nullification: Field,
        ) -> Option<Field> {
            try_get_public_keys(owner).map(|public_keys| {
                let owner_npk_m = public_keys.npk_m;
                let owner_npk_m_hash = owner_npk_m.hash();
                let secret = get_nhk_app(owner_npk_m_hash);
                poseidon2_hash_with_separator(
                    [note_hash_for_nullification, secret],
                    DOM_SEP__NOTE_NULLIFIER,
                )
            })
        }
    }

    // --- Events ---

    #[event]
    struct CardMinted {
        token_id: Field,
        to: AztecAddress,
    }

    #[event]
    struct CardTransferred {
        token_id: Field,
        from: AztecAddress,
        to: AztecAddress,
    }

    // --- Storage ---

    #[storage]
    struct Storage<Context> {
        name: PublicImmutable<FieldCompressedString, Context>,
        symbol: PublicImmutable<FieldCompressedString, Context>,
        minter: PublicImmutable<AztecAddress, Context>,
        game_contract: PublicImmutable<AztecAddress, Context>,
        private_nfts: Owned<PrivateSet<CardNote, Context>, Context>,
        nft_exists: Map<Field, PublicMutable<bool, Context>, Context>,
        public_owners: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        card_ranks: Map<Field, PublicImmutable<Field, Context>, Context>,
    }

    // --- Constructor ---

    #[external("public")]
    #[initializer]
    fn constructor(
        minter: AztecAddress,
        name: FieldCompressedString,
        symbol: FieldCompressedString,
    ) {
        self.storage.name.initialize(name);
        self.storage.symbol.initialize(symbol);
        self.storage.minter.initialize(minter);
    }

    // --- Admin ---

    #[external("public")]
    fn set_game_contract(game_address: AztecAddress) {
        let minter = self.storage.minter.read();
        assert(self.msg_sender() == minter, "Only minter can set game contract");
        self.storage.game_contract.initialize(game_address);
    }

    // --- Minting ---

    /// Mint a card to a player's private set.
    /// packed_ranks encodes [top, right, bottom, left] as: top + right*16 + bottom*256 + left*4096
    #[external("private")]
    fn mint_to_private(to: AztecAddress, token_id: Field, packed_ranks: Field) {
        let minter = self.storage.minter.read();
        assert(self.msg_sender() == minter, "Only minter can mint");

        let note = CardNote { token_id };
        self.storage.private_nfts.at(to).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        self.enqueue_self.finalize_mint(token_id, packed_ranks);
    }

    /// Mint a card to public ownership.
    #[external("public")]
    fn mint_to_public(to: AztecAddress, token_id: Field, packed_ranks: Field) {
        let minter = self.storage.minter.read();
        assert(self.msg_sender() == minter, "Only minter can mint");

        let exists = self.storage.nft_exists.at(token_id).read();
        assert(!exists, "Token already exists");

        self.storage.nft_exists.at(token_id).write(true);
        self.storage.public_owners.at(token_id).write(to);
        self.storage.card_ranks.at(token_id).initialize(packed_ranks);

        self.emit(CardMinted { token_id, to });
    }

    // --- Transfers ---

    /// Transfer a card from one private owner to another.
    #[external("private")]
    fn transfer_private(from: AztecAddress, to: AztecAddress, token_id: Field) {
        assert(self.msg_sender() == from, "Sender must be owner");

        let options = NoteGetterOptions::new()
            .select(CardNote::properties().token_id, Comparator.EQ, token_id)
            .set_limit(1);
        let notes = self.storage.private_nfts.at(from).pop_notes(options);
        assert(notes.len() == 1, "Card not found in sender's set");

        let note = CardNote { token_id };
        self.storage.private_nfts.at(to).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    /// Transfer public ownership of a card.
    #[external("public")]
    fn transfer_public(from: AztecAddress, to: AztecAddress, token_id: Field) {
        let owner = self.storage.public_owners.at(token_id).read();
        assert(owner == from, "Not the owner");
        assert(self.msg_sender() == from, "Sender must be owner");

        self.storage.public_owners.at(token_id).write(to);
        self.emit(CardTransferred { token_id, from, to });
    }

    /// Game contract can transfer a card after game ends (winner takes loser's card).
    #[external("public")]
    fn game_transfer(from: AztecAddress, to: AztecAddress, token_id: Field) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");

        let owner = self.storage.public_owners.at(token_id).read();
        assert(owner == from, "Not the owner");

        self.storage.public_owners.at(token_id).write(to);
        self.emit(CardTransferred { token_id, from, to });
    }

    // --- Private to Public ---

    /// Reveal a card from private to public ownership.
    #[external("private")]
    fn transfer_private_to_public(from: AztecAddress, token_id: Field) {
        assert(self.msg_sender() == from, "Sender must be owner");

        let options = NoteGetterOptions::new()
            .select(CardNote::properties().token_id, Comparator.EQ, token_id)
            .set_limit(1);
        let notes = self.storage.private_nfts.at(from).pop_notes(options);
        assert(notes.len() == 1, "Card not found");

        self.enqueue_self.set_public_owner(from, token_id);
    }

    // --- Public functions called via enqueue_self ---

    #[external("public")]
    #[only_self]
    fn finalize_mint(token_id: Field, packed_ranks: Field) {
        let exists = self.storage.nft_exists.at(token_id).read();
        assert(!exists, "Token already exists");
        self.storage.nft_exists.at(token_id).write(true);
        self.storage.card_ranks.at(token_id).initialize(packed_ranks);
    }

    #[external("public")]
    #[only_self]
    fn set_public_owner(owner: AztecAddress, token_id: Field) {
        self.storage.public_owners.at(token_id).write(owner);
    }

    // --- View Functions ---

    #[external("public")]
    #[view]
    fn public_get_name() -> FieldCompressedString {
        self.storage.name.read()
    }

    #[external("public")]
    #[view]
    fn public_get_symbol() -> FieldCompressedString {
        self.storage.symbol.read()
    }

    #[external("public")]
    #[view]
    fn public_owner_of(token_id: Field) -> AztecAddress {
        self.storage.public_owners.at(token_id).read()
    }

    #[external("public")]
    #[view]
    fn get_card_ranks(token_id: Field) -> Field {
        self.storage.card_ranks.at(token_id).read()
    }

    // --- Utility Functions ---

    #[external("utility")]
    unconstrained fn get_private_cards(
        owner: AztecAddress,
        page_index: u32,
    ) -> ([Field; MAX_NOTES_PER_PAGE], bool) {
        let offset = page_index * MAX_NOTES_PER_PAGE as u32;
        let mut page = [0 as Field; MAX_NOTES_PER_PAGE];
        let notes = self.storage.private_nfts.at(owner).view_notes(
            NoteViewerOptions::new().set_offset(offset),
        );
        let has_more = notes.len() == MAX_NOTES_PER_PAGE;
        for i in 0..MAX_NOTES_PER_PAGE {
            if i < notes.len() {
                page[i] = notes.get(i).token_id;
            }
        }
        (page, has_more)
    }
}
