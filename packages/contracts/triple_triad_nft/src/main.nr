mod filters;
mod test;

use aztec::macros::aztec;

/// Card pool sizes per rarity: [common, rare, epic, legendary]
/// Must match the TypeScript CARDS_PER_POOL in axolotlCards.ts
global CARDS_PER_POOL: [u32; 4] = [180, 50, 20, 8];

/// Separator for cooldown hash
global COOLDOWN_SEPARATOR: u32 = 0xCA4D0002;

/// Compute a card_id from a seed and counter.
/// card_seed = poseidon2([seed, counter]) truncated to u32
/// rarity = (card_seed >> 16) % 100 -> 0-69 common, 70-89 rare, 90-97 epic, 98-99 legendary
/// card_index = (card_seed & 0xFFFF) % CARDS_PER_POOL[rarity]
/// global_card_id = pool_offset + card_index + 1
///
/// Returns (rarity_index, global_card_id)
pub fn generate_card(seed: Field, counter: Field) -> (u8, u32) {
    // Use pedersen_hash for card seed generation (poseidon2 not accessible outside contract scope)
    let hash = std::hash::pedersen_hash([seed, counter]);
    let card_seed = hash as u32;

    // Determine rarity
    let rarity_roll = (card_seed >> 16) % 100;
    let rarity: u8 = if rarity_roll < 70 {
        0
    } else if rarity_roll < 90 {
        1
    } else if rarity_roll < 98 {
        2
    } else {
        3
    };

    // Determine card within pool
    let pool_size = CARDS_PER_POOL[rarity as u32];
    let card_index = (card_seed & 0xFFFF) % pool_size;

    // Compute pool offset (sum of all previous pool sizes)
    let mut offset: u32 = 0;
    for i in 0..4 {
        if (i as u8) < rarity {
            offset += CARDS_PER_POOL[i];
        }
    }

    let global_card_id = offset + card_index + 1;
    (rarity, global_card_id)
}

/// Fixed starter set card IDs (common cards)
global STARTER_CARD_IDS: [Field; 5] = [1, 2, 3, 4, 5];

/// Location IDs for admin lock mechanism
global LOCATION_RIVER: Field = 1;
global LOCATION_FOREST: Field = 2;
global LOCATION_BEACH: Field = 3;
global LOCATION_CITY: Field = 4;
global LOCATION_DOCKYARD: Field = 5;

/// Cooldowns in seconds
global COOLDOWN_RIVER: u64 = 14400;    // 4 hours
global COOLDOWN_FOREST: u64 = 28800;   // 8 hours
global COOLDOWN_BEACH: u64 = 43200;    // 12 hours
global COOLDOWN_CITY: u64 = 57600;     // 16 hours
global COOLDOWN_DOCKYARD: u64 = 72000; // 20 hours

/// Triple Triad NFT contract.
/// Each card is an NFT with a unique token_id corresponding to the card's ID.
/// Supports private ownership for hidden hand information and public ownership for trading.
#[aztec]
pub contract TripleTriadNFT {
    use field_note::FieldNote;
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
            hash::{poseidon2_hash, poseidon2_hash_with_separator},
            traits::{Hash, Packable, Serialize, ToField},
        },
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable},
        utils::comparison::Comparator,
    };
    use compressed_string::FieldCompressedString;
    use super::filters::filter_by_token_ids;
    use super::{
        generate_card,
        STARTER_CARD_IDS, COOLDOWN_SEPARATOR,
        LOCATION_RIVER, LOCATION_FOREST, LOCATION_BEACH, LOCATION_CITY, LOCATION_DOCKYARD,
        COOLDOWN_RIVER, COOLDOWN_FOREST, COOLDOWN_BEACH, COOLDOWN_CITY, COOLDOWN_DOCKYARD,
    };

    // --- Note ---

    // #[derive(Eq, Serialize, Packable)]
    // #[custom_note]
    // pub struct FieldNote {
    //     pub token_id: Field,
    // }

    // impl NoteHash for FieldNote {
    //     fn compute_note_hash(
    //         self,
    //         owner: AztecAddress,
    //         storage_slot: Field,
    //         randomness: Field,
    //     ) -> Field {
    //         poseidon2_hash_with_separator(
    //             [storage_slot, self.token_id, owner.to_field(), randomness],
    //             DOM_SEP__NOTE_HASH,
    //         )
    //     }

    //     fn compute_nullifier(
    //         self,
    //         context: &mut aztec::context::PrivateContext,
    //         owner: AztecAddress,
    //         note_hash_for_nullification: Field,
    //     ) -> Field {
    //         let owner_npk_m = get_public_keys(owner).npk_m;
    //         let owner_npk_m_hash = owner_npk_m.hash();
    //         let secret = context.request_nhk_app(owner_npk_m_hash);
    //         poseidon2_hash_with_separator(
    //             [note_hash_for_nullification, secret],
    //             DOM_SEP__NOTE_NULLIFIER,
    //         )
    //     }

    //     unconstrained fn compute_nullifier_unconstrained(
    //         self,
    //         owner: AztecAddress,
    //         note_hash_for_nullification: Field,
    //     ) -> Option<Field> {
    //         try_get_public_keys(owner).map(|public_keys| {
    //             let owner_npk_m = public_keys.npk_m;
    //             let owner_npk_m_hash = owner_npk_m.hash();
    //             let secret = get_nhk_app(owner_npk_m_hash);
    //             poseidon2_hash_with_separator(
    //                 [note_hash_for_nullification, secret],
    //                 DOM_SEP__NOTE_NULLIFIER,
    //             )
    //         })
    //     }
    // }

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

    #[event]
    struct LocationUnlocked {
        location_id: Field,
    }

    // --- Storage ---

    #[storage]
    struct Storage<Context> {
        name: PublicImmutable<FieldCompressedString, Context>,
        symbol: PublicImmutable<FieldCompressedString, Context>,
        minter: PublicImmutable<AztecAddress, Context>,
        game_contract: PublicImmutable<AztecAddress, Context>,
        private_nfts: Owned<PrivateSet<FieldNote, Context>, Context>,
        nft_exists: Map<Field, PublicMutable<bool, Context>, Context>,
        public_owners: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        card_ranks: Map<Field, PublicImmutable<Field, Context>, Context>,
        card_game_lock: Map<Field, PublicMutable<Field, Context>, Context>,
        // Card generation tracking (public state)
        starter_claimed: Map<Field, PublicMutable<bool, Context>, Context>,
        player_counter: Map<Field, PublicMutable<Field, Context>, Context>,
        player_cooldown: Map<Field, PublicMutable<u64, Context>, Context>,
        location_unlocked: Map<Field, PublicMutable<bool, Context>, Context>,
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
        // River is always unlocked
        self.storage.location_unlocked.at(LOCATION_RIVER).write(true);
    }

    // --- Admin ---

    #[external("public")]
    fn set_game_contract(game_address: AztecAddress) {
        let minter = self.storage.minter.read();
        assert(self.msg_sender() == minter, "Only minter can set game contract");
        self.storage.game_contract.initialize(game_address);
    }

    /// Admin unlocks a card generation location.
    #[external("public")]
    fn unlock_location(location_id: Field) {
        let minter = self.storage.minter.read();
        assert(self.msg_sender() == minter, "Only admin can unlock locations");
        assert(
            (location_id == LOCATION_FOREST)
                | (location_id == LOCATION_BEACH)
                | (location_id == LOCATION_CITY)
                | (location_id == LOCATION_DOCKYARD),
            "Invalid location ID",
        );
        self.storage.location_unlocked.at(location_id).write(true);
        self.emit(LocationUnlocked { location_id });
    }

    // --- Card Generation ---

    /// Give a new player their starter set of 5 common cards.
    /// Can only be called once per player.
    #[external("private")]
    fn get_cards_for_new_player() {
        let owner = self.msg_sender();

        for i in 0..5 {
            let note = FieldNote { value: STARTER_CARD_IDS[i] };
            self.storage.private_nfts.at(owner).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
        }

        self.enqueue_self.finalize_starter_set(owner);
    }

    /// Generate 10 cards from the River (4-hour cooldown, always available).
    #[external("private")]
    fn get_cards_from_river(counter: Field) {
        let owner = self.msg_sender();
        let owner_npk_m = get_public_keys(owner).npk_m;
        let owner_npk_m_hash = owner_npk_m.hash();
        let seed = self.context.request_nhk_app(owner_npk_m_hash);

        for i in 0..10 {
            let (_, card_id) = generate_card(seed, counter + i as Field);
            let note = FieldNote { value: card_id as Field };
            self.storage.private_nfts.at(owner).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
        }

        self.enqueue_self.finalize_card_generation(
            owner, counter, 10, LOCATION_RIVER, COOLDOWN_RIVER,
        );
    }

    /// Generate 10 cards from the Forest (8-hour cooldown, admin lock).
    #[external("private")]
    fn get_cards_from_forest(counter: Field) {
        let owner = self.msg_sender();
        let owner_npk_m = get_public_keys(owner).npk_m;
        let owner_npk_m_hash = owner_npk_m.hash();
        let seed = self.context.request_nhk_app(owner_npk_m_hash);

        for i in 0..10 {
            let (_, card_id) = generate_card(seed, counter + i as Field);
            let note = FieldNote { value: card_id as Field };
            self.storage.private_nfts.at(owner).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
        }

        self.enqueue_self.finalize_card_generation(
            owner, counter, 10, LOCATION_FOREST, COOLDOWN_FOREST,
        );
    }

    /// Generate 10 cards from the Beach (12-hour cooldown, admin lock).
    #[external("private")]
    fn get_cards_from_beach(counter: Field) {
        let owner = self.msg_sender();
        let owner_npk_m = get_public_keys(owner).npk_m;
        let owner_npk_m_hash = owner_npk_m.hash();
        let seed = self.context.request_nhk_app(owner_npk_m_hash);

        for i in 0..10 {
            let (_, card_id) = generate_card(seed, counter + i as Field);
            let note = FieldNote { value: card_id as Field };
            self.storage.private_nfts.at(owner).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
        }

        self.enqueue_self.finalize_card_generation(
            owner, counter, 10, LOCATION_BEACH, COOLDOWN_BEACH,
        );
    }

    /// Generate 10 cards from the City (16-hour cooldown, admin lock).
    #[external("private")]
    fn get_cards_from_city(counter: Field) {
        let owner = self.msg_sender();
        let owner_npk_m = get_public_keys(owner).npk_m;
        let owner_npk_m_hash = owner_npk_m.hash();
        let seed = self.context.request_nhk_app(owner_npk_m_hash);

        for i in 0..10 {
            let (_, card_id) = generate_card(seed, counter + i as Field);
            let note = FieldNote { value: card_id as Field };
            self.storage.private_nfts.at(owner).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
        }

        self.enqueue_self.finalize_card_generation(
            owner, counter, 10, LOCATION_CITY, COOLDOWN_CITY,
        );
    }

    /// Generate 10 cards from the Dockyard (20-hour cooldown, admin lock).
    #[external("private")]
    fn get_cards_from_dockyard(counter: Field) {
        let owner = self.msg_sender();
        let owner_npk_m = get_public_keys(owner).npk_m;
        let owner_npk_m_hash = owner_npk_m.hash();
        let seed = self.context.request_nhk_app(owner_npk_m_hash);

        for i in 0..10 {
            let (_, card_id) = generate_card(seed, counter + i as Field);
            let note = FieldNote { value: card_id as Field };
            self.storage.private_nfts.at(owner).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
        }

        self.enqueue_self.finalize_card_generation(
            owner, counter, 10, LOCATION_DOCKYARD, COOLDOWN_DOCKYARD,
        );
    }

    // --- Minting ---

    #[external("private")]
    fn mint_to_private(to: AztecAddress, token_id: Field, packed_ranks: Field) {
        let minter = self.storage.minter.read();
        assert(self.msg_sender() == minter, "Only minter can mint");

        let note = FieldNote { value: token_id };
        self.storage.private_nfts.at(to).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        self.enqueue_self.finalize_mint(to, token_id, packed_ranks);
    }

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

    #[external("private")]
    fn commit_five_nfts(token_ids: [Field; 5]) -> Field {
        let owner = self.msg_sender();

        // FieldNote has Packable::N = 1 (single Field), so the second type param is 1.
        // Use a filter to match notes whose `value` is in our token_ids array.
        let options = NoteGetterOptions::with_filter(
            filter_by_token_ids,
            token_ids,
        );

        let notes = self.storage.private_nfts.at(owner).pop_notes(options);
        assert(notes.len() == 5, "Could not find all 5 cards");

        let mut to_hash: [Field; 6] = [0; 6];
        for i in 0.. 5 {
            to_hash[i] = notes.get(i).value;
        }

        let owner_npk_m = get_public_keys(owner).npk_m;
        let owner_npk_m_hash = owner_npk_m.hash();
        let seed = self.context.request_nhk_app(owner_npk_m_hash);
        to_hash[5] = poseidon2_hash([seed, self.address.to_field()]);
        poseidon2_hash(to_hash)
    }


    #[external("private")]
    fn mint_for_game_winner(token_ids: [Field; 6], to: AztecAddress) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");

        for i in 0..6 {
            let note = FieldNote { value: token_ids[i] };
            self.storage.private_nfts.at(to).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
        }
    }

    #[external("private")]
    fn mint_for_game_loser(token_ids: [Field; 4], to: AztecAddress) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");

        for i in 0..4 {
            let note = FieldNote { value: token_ids[i] };
            self.storage.private_nfts.at(to).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
        }
    }

    #[external("private")]
    fn mint_for_game_draw(token_ids: [Field; 5], to: AztecAddress) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");

        for i in 0..5 {
            let note = FieldNote { value: token_ids[i] };
            self.storage.private_nfts.at(to).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
        }
    }

    #[external("private")]
    fn transfer_private(from: AztecAddress, to: AztecAddress, token_id: Field) {
        assert(self.msg_sender() == from, "Sender must be owner");

        let options: NoteGetterOptions<FieldNote, 1, Field, Field> = NoteGetterOptions::new()
            .select(FieldNote::properties().value, Comparator.EQ, token_id)
            .set_limit(1);
        let notes = self.storage.private_nfts.at(from).pop_notes(options);
        assert(notes.len() == 1, "Card not found in sender's set");

        let note = FieldNote { value: token_id };
        self.storage.private_nfts.at(to).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    #[external("public")]
    fn transfer_public(from: AztecAddress, to: AztecAddress, token_id: Field) {
        let owner = self.storage.public_owners.at(token_id).read();
        assert(owner == from, "Not the owner");
        assert(self.msg_sender() == from, "Sender must be owner");

        self.storage.public_owners.at(token_id).write(to);
        self.emit(CardTransferred { token_id, from, to });
    }

    #[external("public")]
    fn game_transfer(from: AztecAddress, to: AztecAddress, token_id: Field) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");

        let owner = self.storage.public_owners.at(token_id).read();
        assert(owner == from, "Not the owner");

        self.storage.public_owners.at(token_id).write(to);
        self.storage.card_game_lock.at(token_id).write(0);
        self.emit(CardTransferred { token_id, from, to });
    }

    #[external("public")]
    fn unlock_cards(token_ids: [Field; 5], game_id: Field) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");

        for i in 0..5 {
            if token_ids[i] != 0 {
                let lock = self.storage.card_game_lock.at(token_ids[i]).read();
                if lock == game_id {
                    self.storage.card_game_lock.at(token_ids[i]).write(0);
                }
            }
        }
    }

    // --- Private to Public ---

    #[external("private")]
    fn transfer_private_to_public(from: AztecAddress, token_id: Field) {
        assert(self.msg_sender() == from, "Sender must be owner");

        let options = NoteGetterOptions::new()
            .select(FieldNote::properties().value, Comparator.EQ, token_id)
            .set_limit(1);
        let notes = self.storage.private_nfts.at(from).pop_notes(options);
        assert(notes.len() == 1, "Card not found");

        self.enqueue_self.set_public_owner(from, token_id);
    }

    // --- Public Escrow ---

    #[external("private")]
    fn prepare_for_game(card_ids: [Field; 5], game_id: Field) {
        let owner = self.msg_sender();
        assert(game_id != 0, "game_id must be nonzero");

        for i in 0..5 {
            let options = NoteGetterOptions::new()
                .select(FieldNote::properties().value, Comparator.EQ, card_ids[i])
                .set_limit(1);
            let notes = self.storage.private_nfts.at(owner).pop_notes(options);
            assert(notes.len() == 1, "Card not found in private set");
        }

        for i in 0..5 {
            self.enqueue_self.set_public_owner_and_lock(owner, card_ids[i], game_id);
        }
    }

    #[external("private")]
    fn reclaim_card(token_id: Field) {
        let owner = self.msg_sender();

        let note = FieldNote { value: token_id };
        self.storage.private_nfts.at(owner).insert(note).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        self.enqueue_self.finalize_reclaim(owner, token_id);
    }

    // --- Public functions called via enqueue_self ---

    #[external("public")]
    #[only_self]
    fn finalize_mint(to: AztecAddress, token_id: Field, packed_ranks: Field) {
        let exists = self.storage.nft_exists.at(token_id).read();
        assert(!exists, "Token already exists");
        self.storage.nft_exists.at(token_id).write(true);
        self.storage.card_ranks.at(token_id).initialize(packed_ranks);
        self.emit(CardMinted { token_id, to });
    }

    #[external("public")]
    #[only_self]
    fn set_public_owner(owner: AztecAddress, token_id: Field) {
        self.storage.public_owners.at(token_id).write(owner);
    }

    #[external("public")]
    #[only_self]
    fn set_public_owner_and_lock(owner: AztecAddress, token_id: Field, game_id: Field) {
        self.storage.public_owners.at(token_id).write(owner);
        self.storage.card_game_lock.at(token_id).write(game_id);
    }

    #[external("public")]
    #[only_self]
    fn finalize_reclaim(owner: AztecAddress, token_id: Field) {
        let current_owner = self.storage.public_owners.at(token_id).read();
        assert(current_owner == owner, "Not the public owner");

        let game_lock = self.storage.card_game_lock.at(token_id).read();
        assert(game_lock == 0, "Card is locked to an active game");

        self.storage.public_owners.at(token_id).write(AztecAddress::zero());
    }

    /// Finalize starter set: verify not already claimed, register cards.
    #[external("public")]
    #[only_self]
    fn finalize_starter_set(owner: AztecAddress) {
        let owner_key = owner.to_field();
        let claimed = self.storage.starter_claimed.at(owner_key).read();
        assert(!claimed, "Starter set already claimed");
        self.storage.starter_claimed.at(owner_key).write(true);

        // Register starter cards as existing
        for i in 0..5 {
            let exists = self.storage.nft_exists.at(STARTER_CARD_IDS[i]).read();
            if !exists {
                self.storage.nft_exists.at(STARTER_CARD_IDS[i]).write(true);
            }
        }

        self.emit(CardMinted { token_id: STARTER_CARD_IDS[0], to: owner });
    }

    /// Finalize card generation from a location.
    /// Checks: location unlocked, cooldown elapsed, counter matches.
    #[external("public")]
    #[only_self]
    fn finalize_card_generation(
        owner: AztecAddress,
        expected_counter: Field,
        num_cards: Field,
        location_id: Field,
        cooldown_seconds: u64,
    ) {
        let unlocked = self.storage.location_unlocked.at(location_id).read();
        assert(unlocked, "Location is locked");

        let owner_field = owner.to_field();

        let current_counter = self.storage.player_counter.at(owner_field).read();
        assert(current_counter == expected_counter, "Counter mismatch");
        self.storage.player_counter.at(owner_field).write(current_counter + num_cards);

        let cooldown_key = poseidon2_hash_with_separator(
            [owner_field, location_id],
            COOLDOWN_SEPARATOR,
        );
        let last_call = self.storage.player_cooldown.at(cooldown_key).read();
        let current_time = self.context.timestamp() as u64;

        if last_call != 0 {
            assert(
                current_time >= last_call + cooldown_seconds,
                "Cooldown has not elapsed",
            );
        }
        self.storage.player_cooldown.at(cooldown_key).write(current_time);
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

    #[external("public")]
    #[view]
    fn is_location_unlocked(location_id: Field) -> bool {
        self.storage.location_unlocked.at(location_id).read()
    }

    #[external("public")]
    #[view]
    fn get_player_counter(owner: AztecAddress) -> Field {
        self.storage.player_counter.at(owner.to_field()).read()
    }

    #[external("public")]
    #[view]
    fn has_claimed_starter(owner: AztecAddress) -> bool {
        self.storage.starter_claimed.at(owner.to_field()).read()
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
                page[i] = notes.get(i).value;
            }
        }
        (page, has_more)
    }
}
