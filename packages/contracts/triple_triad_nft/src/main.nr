mod filters;
mod test;

use aztec::macros::aztec;

/// Card pool sizes per rarity: [common, uncommon, rare, epic, legendary]
/// Common: 1-10, Uncommon: 11-176, Rare: 177-226, Epic: 227-246, Legendary: 247-256
global CARDS_PER_POOL: [u32; 5] = [10, 166, 50, 20, 10];

/// Compute a card_id from a seed and counter.
/// card_seed = pedersen_hash([seed, counter]) truncated to u32
/// rarity = (card_seed >> 16) % 100 -> 0-34 common, 35-74 uncommon, 75-89 rare, 90-97 epic, 98-99 legendary
/// card_index = (card_seed & 0xFFFF) % CARDS_PER_POOL[rarity]
/// global_card_id = pool_offset + card_index + 1
///
/// Returns (rarity_index, global_card_id)
pub fn generate_card(seed: Field, counter: Field) -> (u8, u32) {
    let hash = std::hash::pedersen_hash([seed, counter]);
    let card_seed = hash as u32;

    // Determine rarity (5 tiers)
    let rarity_roll = (card_seed >> 16) % 100;
    let rarity: u8 = if rarity_roll < 35 {
        0 // common
    } else if rarity_roll < 75 {
        1 // uncommon
    } else if rarity_roll < 90 {
        2 // rare
    } else if rarity_roll < 98 {
        3 // epic
    } else {
        4 // legendary
    };

    // Determine card within pool
    let pool_size = CARDS_PER_POOL[rarity as u32];
    let card_index = (card_seed & 0xFFFF) % pool_size;

    // Compute pool offset (sum of all previous pool sizes)
    let mut offset: u32 = 0;
    for i in 0..5 {
        if (i as u8) < rarity {
            offset += CARDS_PER_POOL[i];
        }
    }

    let global_card_id = offset + card_index + 1;
    (rarity, global_card_id)
}

/// Fixed starter set card IDs (common cards)
global STARTER_CARD_IDS: [Field; 5] = [1, 2, 3, 4, 5];

/// Domain separator for the one-per-account starter-claim nullifier:
/// "STARTER_CLAIM" packed as big-endian ASCII. App-level separator, distinct
/// from the protocol's DOM_SEP__NOTE_NULLIFIER space.
global DOM_SEP__STARTER_CLAIM: Field = 0x535441525445525f434c41494d;

/// Cost of a card pack in Arena Tokens
global CARD_PACK_COST: u128 = 100;

/// IV field constants for note tagging scheme.
/// Distinct domain separators hashed with poseidon2 to derive IVs.
/// Kept under 128 bits to avoid Noir integer literal limits.
/// "NoteTag" = 0x4e6f7465546167, "SecretIV" = 0x5365637265744956, "PayloadIV" = 0x5061796c6f61644956
global AXOLOTL_NOTE_TAG_FIELD: Field = 0x4e6f7465546167;
global AXOLOTL_NOTE_SECRET_IV_FIELD: Field = 0x5365637265744956;
global AXOLOTL_PAYLOAD_IV_FIELD: Field = 0x5061796c6f61644956;

/// IV for deterministic game_id derivation: "GameId" = 0x47616d654964
global GAME_ID_IV_FIELD: Field = 0x47616d654964;
/// IV for deterministic game randomness derivation: "GameRand" = 0x47616d6552616e64

/// Storage slot for private_nfts: use TripleTriadNFT::storage_layout().private_nfts.slot
/// The #[storage] macro assigns slots including hidden internal fields, so never hardcode.

/// Triple Triad NFT contract.
/// Each card is an NFT with a unique token_id corresponding to the card's ID.
/// Supports private ownership for hidden hand information and public ownership for trading.
#[aztec]
pub contract TripleTriadNFT {
    use super::{
        AXOLOTL_NOTE_SECRET_IV_FIELD, AXOLOTL_NOTE_TAG_FIELD, AXOLOTL_PAYLOAD_IV_FIELD,
        CARD_PACK_COST, DOM_SEP__STARTER_CLAIM, GAME_ID_IV_FIELD, generate_card,
        STARTER_CARD_IDS,
    };
    use super::filters::{filter_by_token_ids, filter_by_token_ids_10};
    use arena_token::ArenaToken;
    use aztec::{
        keys::getters::get_public_keys,
        macros::{
            events::event,
            functions::{external, initializer, only_self, view},
            storage::storage,
        },
        messages::{
            discovery::private_notes::process_private_note_msg,
            encoding::{decode_message, MESSAGE_PLAINTEXT_LEN},
            logs::note::encode_private_note_message,
            delivery::MessageDelivery,
            processing::validate_and_store_enqueued_notes_and_events,
        },
        note::{
            constants::MAX_NOTES_PER_PAGE,
            note_getter_options::NoteGetterOptions,
            note_interface::{NoteProperties, NoteType},
            note_viewer_options::NoteViewerOptions,
            utils::compute_confirmed_note_hash_for_nullification,
        },
        history::nullifier::assert_nullifier_did_not_exist_by,
        oracle::{logging::debug_log_format, notes::notify_created_note},
        protocol::{
            address::AztecAddress,
            constants::{
                DOM_SEP__NOTE_HASH,
                DOM_SEP__NOTE_NULLIFIER, MAX_NOTE_HASHES_PER_TX,
            },
            hash::{compute_siloed_nullifier, poseidon2_hash, poseidon2_hash_with_separator},
            traits::{Hash, Packable, ToField},
        },
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable, StateVariable},
        utils::comparison::Comparator,
    };
    use compressed_string::FieldCompressedString;
    use field_note::FieldNote;
    use uint_note::UintNote;

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

    /// Event emitted for each card created with deterministic tagging.
    /// note_tag allows recipients to identify notes belonging to them.
    /// note_payload is a symmetric encryption of [card_id, payload_iv] under note_randomness.
    #[event]
    struct CardCreated {
        note_tag: Field,
        note_payload: [Field; 2],
    }

    // --- Storage ---

    #[storage]
    struct Storage<Context> {
        name: PublicImmutable<FieldCompressedString, Context>,
        symbol: PublicImmutable<FieldCompressedString, Context>,
        minter: PublicImmutable<AztecAddress, Context>,
        token_contract: PublicImmutable<AztecAddress, Context>,
        private_nfts: Owned<PrivateSet<FieldNote, Context>, Context>,
        nft_exists: Map<Field, PublicMutable<bool, Context>, Context>,
        public_owners: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        card_ranks: Map<Field, PublicImmutable<Field, Context>, Context>,
        card_game_lock: Map<Field, PublicMutable<Field, Context>, Context>,
        game_contract: PublicImmutable<AztecAddress, Context>,

        // Note nonce: a single FieldNote per user tracking nonce counter for deterministic randomness
        note_nonce: Owned<PrivateSet<FieldNote, Context>, Context>,
        // Arena Token contract address
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

    /// Set the Arena Token contract address. Admin only.
    #[external("public")]
    fn set_token_contract(token_address: AztecAddress) {
        let minter = self.storage.minter.read();
        assert(self.msg_sender() == minter, "Only minter can set token contract");
        self.storage.token_contract.initialize(token_address);
    }

    // Updates are applied by FRESH REDEPLOY (new addresses), not the Aztec
    // contract-class upgrade pattern. See docs/plan/UPDATE_MODEL.md.

    // --- Symmetric Encryption (from mpclib::common::crypto) ---

    /// Expand a secret into N pseudorandom field elements using poseidon2.
    #[contract_library_method]
    fn expand_secret<let N: u32>(secret: Field) -> [Field; N] {
        let mut rolling_secret: [Field; 2] = [0, secret];
        let mut r: [Field; N] = [0; N];
        for i in 0..N {
            r[i] = poseidon2_hash(rolling_secret);
            rolling_secret[1] += 1;
        }
        r
    }

    /// Symmetric encryption: ciphertext[i] = plaintext[i] + expand_secret(secret)[i]
    #[contract_library_method]
    fn symmetric_encrypt<let N: u32>(plaintext: [Field; N], secret: Field) -> [Field; N] {
        let mut ciphertext: [Field; N] = [0; N];
        let secrets: [Field; N] = expand_secret(secret);
        for i in 0..N {
            ciphertext[i] = secrets[i] + plaintext[i];
        }
        ciphertext
    }

    // --- IV Computation Helpers ---

    /// Compute the note_tag_iv: poseidon2([AXOLOTL_NOTE_TAG_FIELD])
    #[contract_library_method]
    fn compute_note_tag_iv() -> Field {
        poseidon2_hash([AXOLOTL_NOTE_TAG_FIELD])
    }

    /// Compute the note_randomness_secret_iv: poseidon2([AXOLOTL_NOTE_SECRET_IV_FIELD])
    #[contract_library_method]
    fn compute_note_randomness_secret_iv() -> Field {
        poseidon2_hash([AXOLOTL_NOTE_SECRET_IV_FIELD])
    }

    /// Compute the note_payload_iv: poseidon2([AXOLOTL_PAYLOAD_IV_FIELD])
    #[contract_library_method]
    fn compute_note_payload_iv() -> Field {
        poseidon2_hash([AXOLOTL_PAYLOAD_IV_FIELD])
    }

    /// Derive deterministic note_randomness for a given note_nonce value and index.
    /// note_randomness = poseidon2([nhk_app_secret, note_nonce + index, note_randomness_secret_iv])
    #[contract_library_method]
    fn derive_note_randomness(nhk_app_secret: Field, nonce_value: Field, index: Field) -> Field {
        let iv = compute_note_randomness_secret_iv();
        poseidon2_hash([nhk_app_secret, nonce_value + index, iv])
    }

    /// Derive deterministic game_id from nhk_app_secret and nonce_value.
    #[contract_library_method]
    fn derive_game_id(nhk_app_secret: Field, nonce_value: Field) -> Field {
        let iv = poseidon2_hash([GAME_ID_IV_FIELD]);
        poseidon2_hash([nhk_app_secret, nonce_value, iv])
    }

    /// Derive deterministic game randomness (6 values) from nhk_app_secret and nonce_value.
    /// Uses derive_note_randomness internally so all note randomness uses the same IV and formula.
    #[contract_library_method]
    fn derive_game_randomness(nhk_app_secret: Field, nonce_value: Field) -> [Field; 6] {
        let mut result: [Field; 6] = [0; 6];
        for i in 0..6 {
            result[i] = derive_note_randomness(nhk_app_secret, nonce_value, i as Field);
        }
        result
    }

    /// Derive note_tag from note_randomness.
    /// note_tag = poseidon2([note_randomness, note_tag_iv])
    #[contract_library_method]
    fn derive_note_tag(note_randomness: Field) -> Field {
        let iv = compute_note_tag_iv();
        poseidon2_hash([note_randomness, iv])
    }

    /// Symmetric-encrypt card_id with note_randomness for the CardCreated event payload.
    /// note_payload = symmetric_encrypt([card_id, note_payload_iv], note_randomness)
    #[contract_library_method]
    fn encrypt_card_payload(card_id: Field, note_randomness: Field) -> [Field; 2] {
        let iv = compute_note_payload_iv();
        symmetric_encrypt([card_id, iv], note_randomness)
    }

    // --- Nullifier Debug Logging ---

    /// Peek at card notes via get_notes, compute their nullifiers, and log them.
    /// Called BEFORE pop_notes so the code path under test is unchanged.
    #[contract_library_method]
    fn log_card_nullifiers(
        storage: Storage<&mut aztec::context::PrivateContext>,
        owner: AztecAddress,
        token_ids: [Field; 5],
        nhk_app_secret: Field,
    ) {
        let options = NoteGetterOptions::with_filter(filter_by_token_ids, token_ids);
        let peeked = storage.private_nfts.at(owner).get_notes(options);
        debug_log_format(
            "[NFT] log_card_nullifiers: found {0} notes for owner={1}",
            [peeked.len() as Field, owner.to_field()],
        );
        for i in 0..5 {
            if i < peeked.len() {
                let cn = peeked.get(i);
                let note_hash_for_nul = compute_confirmed_note_hash_for_nullification(cn);
                let nullifier = poseidon2_hash_with_separator(
                    [note_hash_for_nul, nhk_app_secret],
                    DOM_SEP__NOTE_NULLIFIER as Field,
                );
                debug_log_format(
                    "[NFT] card_nullifier[{0}]: value={1} note_hash={2} nullifier={3}",
                    [i as Field, cn.note.value, note_hash_for_nul, nullifier],
                );
            }
        }
    }

    /// Peek at the nonce note via get_notes, compute its nullifier, and log it.
    /// Called BEFORE pop_note_nonce so the code path under test is unchanged.
    #[contract_library_method]
    fn log_nonce_nullifier(
        storage: Storage<&mut aztec::context::PrivateContext>,
        owner: AztecAddress,
        nhk_app_secret: Field,
    ) {
        let options: NoteGetterOptions<FieldNote, 1, Field, Field> =
            NoteGetterOptions::new().set_limit(1);
        let peeked = storage.note_nonce.at(owner).get_notes(options);
        debug_log_format(
            "[NFT] log_nonce_nullifier: found {0} nonce notes for owner={1}",
            [peeked.len() as Field, owner.to_field()],
        );
        for i in 0..1 {
            if i < peeked.len() {
                let cn = peeked.get(i);
                let note_hash_for_nul = compute_confirmed_note_hash_for_nullification(cn);
                let nullifier = poseidon2_hash_with_separator(
                    [note_hash_for_nul, nhk_app_secret],
                    DOM_SEP__NOTE_NULLIFIER as Field,
                );
                debug_log_format(
                    "[NFT] nonce_nullifier: value={0} note_hash={1} nullifier={2}",
                    [cn.note.value, note_hash_for_nul, nullifier],
                );
            }
        }
    }

    // --- Note Nonce Management ---

    /// Read and nullify the current note_nonce for the owner. Returns the nonce value.
    #[contract_library_method]
    fn pop_note_nonce(
        _context: &mut aztec::context::PrivateContext,
        storage: Storage<&mut aztec::context::PrivateContext>,
        owner: AztecAddress,
    ) -> Field {
        let options: NoteGetterOptions<FieldNote, 1, Field, Field> =
            NoteGetterOptions::new().set_limit(1);
        let notes = storage.note_nonce.at(owner).pop_notes(options);
        assert(notes.len() == 1, "Note nonce not found");
        let nonce_val = notes.get(0).value;
        debug_log_format(
            "[NFT] pop_note_nonce: owner={0} nonce_value={1}",
            [owner.to_field(), nonce_val],
        );
        nonce_val
    }

    /// Create a new note_nonce for the owner with the given value.
    #[contract_library_method]
    fn push_note_nonce(
        _context: &mut aztec::context::PrivateContext,
        storage: Storage<&mut aztec::context::PrivateContext>,
        owner: AztecAddress,
        nonce_value: Field,
    ) {
        debug_log_format(
            "[NFT] push_note_nonce: owner={0} new_nonce={1}",
            [owner.to_field(), nonce_value],
        );
        let note = FieldNote { value: nonce_value };
        storage.note_nonce.at(owner).insert(note).deliver(MessageDelivery::onchain_constrained());
    }

    // --- Card Generation ---

    /// Give a new player their starter set of 5 common cards + 100 Arena Tokens.
    /// Creates a note_nonce with initial value 5 (since 5 cards were created at indices 0..4).
    /// One claim per account, enforced on-chain (QA-F1).
    #[external("private")]
    fn get_cards_for_new_player() {
        let owner = self.msg_sender();

        // Get nhk_app_secret for deterministic randomness
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let nhk_app_secret = self.context.request_nhk_app(owner_npk_m_hash);

        // One starter claim per account (QA-F1). The nullifier is deterministic
        // for the account but unlinkable from outside: it is derived from the
        // app-siloed nullifier secret, so observers cannot precompute it from an
        // address to learn whether that account claimed. The non-inclusion proof
        // rejects re-claims with a clean error at the anchor block the wallet
        // proves against; push_nullifier is the protocol-level backstop that
        // catches a malicious prover anchoring at a pre-claim block (duplicate
        // nullifiers make the sequencer drop the tx).
        let claim_nullifier = poseidon2_hash([DOM_SEP__STARTER_CLAIM, nhk_app_secret]);
        assert_nullifier_did_not_exist_by(
            self.context.get_anchor_block_header(),
            compute_siloed_nullifier(self.address, claim_nullifier),
        );
        self.context.push_nullifier_unsafe(claim_nullifier);

        // Mint 5 starter cards with deterministic randomness and emit CardCreated events
        for i in 0..5 {
            let note_randomness = derive_note_randomness(nhk_app_secret, 0, i as Field);
            let note_tag = derive_note_tag(note_randomness);
            let note_payload = encrypt_card_payload(STARTER_CARD_IDS[i], note_randomness);

            let _: Field =
                create_and_push_note(self.context, owner, STARTER_CARD_IDS[i], note_randomness);
            self.emit(CardCreated { note_tag, note_payload }).deliver_to(
                owner,
                MessageDelivery::offchain(),
            );
        }

        // Create initial note_nonce with value 5
        push_note_nonce(self.context, self.storage, owner, 5);

        // Mint 100 Arena Tokens to the new player
        let token_addr = self.storage.token_contract.read();
        ArenaToken::at(token_addr).mint_private(owner, 100).call(self.context);
    }

    /// Purchase a card pack: burns 100 Arena Tokens and generates 10 random cards.
    #[external("private")]
    fn purchase_card_pack() {
        let owner = self.msg_sender();
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let nhk_app_secret = self.context.request_nhk_app(owner_npk_m_hash);

        // Burn 100 Arena Tokens
        let token_addr = self.storage.token_contract.read();
        ArenaToken::at(token_addr).burn_from(owner, CARD_PACK_COST).call(self.context);

        let nonce_value = pop_note_nonce(self.context, self.storage, owner);

        for i in 0..10 {
            let note_randomness = derive_note_randomness(nhk_app_secret, nonce_value, i as Field);
            let note_tag = derive_note_tag(note_randomness);
            let (_, card_id) = generate_card(nhk_app_secret, nonce_value + i as Field);
            let note_payload = encrypt_card_payload(card_id as Field, note_randomness);
            let _: Field =
                create_and_push_note(self.context, owner, card_id as Field, note_randomness);
            self.emit(CardCreated { note_tag, note_payload }).deliver_to(
                owner,
                MessageDelivery::offchain(),
            );
        }

        push_note_nonce(self.context, self.storage, owner, nonce_value + 10);
    }

    /// Preview which card IDs will be generated for a given nonce value.
    /// Call via .simulate({ from: playerAddr }) -- runs client-side, no tx.
    /// Uses the same seed derivation as the get_cards_from_* functions.
    #[external("private")]
    fn preview_card_ids(nonce_value: Field) -> [Field; 10] {
        let owner = self.msg_sender();
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let seed = self.context.request_nhk_app(owner_npk_m_hash);

        let mut result = [0 as Field; 10];
        for i in 0..10 {
            let (_, card_id) = generate_card(seed, nonce_value + i as Field);
            result[i] = card_id as Field;
        }
        result
    }

    // --- Custom Note Creation (no delivery/tagging) ---

    /// Create a FieldNote with explicit randomness.
    /// Pushes the note hash to the tx accumulator and notifies the PXE.
    /// Does NOT deliver (no tagging) --caller handles delivery via frontend relay.
    #[contract_library_method]
    fn create_and_push_note(
        context: &mut aztec::context::PrivateContext,
        owner: AztecAddress,
        value: Field,
        randomness: Field,
    ) -> Field {
        debug_log_format(
            "[NFT] create_and_push_note: owner={0} token_id={1} randomness={2}",
            [owner.to_field(), value, randomness],
        );
        let note = FieldNote { value };
        let note_hash_counter = context.get_side_effect_counter();
        // Owned<PrivateSet> uses the BASE storage slot (not a derived/mapped slot).
        // Use the auto-generated storage_layout() to get the correct slot.
        let storage_slot = TripleTriadNFT::storage_layout().private_nfts.slot;
        // FieldNote hash must match the #[note] macro's generated compute_note_hash:
        //   data = pack(self).concat([owner, randomness]) = [value, owner, randomness]
        //   compute_note_hash(storage_slot, data) = poseidon2([storage_slot, value, owner, randomness], DOM_SEP)
        let note_hash = poseidon2_hash_with_separator(
            [storage_slot, value, owner.to_field(), randomness],
            DOM_SEP__NOTE_HASH,
        );

        notify_created_note(
            owner,
            storage_slot,
            randomness,
            FieldNote::get_id(),
            note.pack(),
            note_hash,
            note_hash_counter,
        );

        debug_log_format(
            "[NFT] create_and_push_note: note_hash={0} slot={1}",
            [note_hash, storage_slot],
        );
        context.push_note_hash(note_hash);
        note_hash
    }

    // --- Minting ---

    #[external("private")]
    fn mint_to_private(to: AztecAddress, token_id: Field, packed_ranks: Field) {
        let minter = self.storage.minter.read();
        assert(self.msg_sender() == minter, "Only minter can mint");

        let note = FieldNote { value: token_id };
        self.storage.private_nfts.at(to).insert(note).deliver(MessageDelivery::onchain_constrained());

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

    /// Commit 5 NFTs for creating a new game. Returns [card_commit_hash, player_state_hash, game_id].
    /// game_id and randomness are DERIVED IN-CIRCUIT from nhk_app_secret + nonce_value.
    /// Called by TripleTriadGame.create_game.
    #[external("private")]
    fn commit_five_nfts_create(owner: AztecAddress, token_ids: [Field; 5]) -> [Field; 3] {
        let caller = self.msg_sender();
        debug_log_format("Caller = {0}", [owner.to_field()]);
        let game = self.storage.game_contract.read();
        assert((caller == game) | (caller == owner), "Only game contract or owner can commit");

        // Get nhk_app_secret first (needed for nullifier logging and derivations)
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let nhk_app_secret = self.context.request_nhk_app(owner_npk_m_hash);

        // Log nonce note nullifier before popping
        log_nonce_nullifier(self.storage, owner, nhk_app_secret);

        let nonce_value = pop_note_nonce(self.context, self.storage, owner);

        // Derive game_id and randomness deterministically in-circuit
        let game_id = derive_game_id(nhk_app_secret, nonce_value);
        let randomness = derive_game_randomness(nhk_app_secret, nonce_value);

        debug_log_format(
            "[NFT] commit_five_nfts_create: owner={0} nonce={1} game_id={2}",
            [owner.to_field(), nonce_value, game_id],
        );
        for i in 0..5 {
            debug_log_format(
                "[NFT] commit_create: requesting token_id={0}",
                [token_ids[i]],
            );
        }

        // Log card nullifiers before popping (read-only peek)
        log_card_nullifiers(self.storage, owner, token_ids, nhk_app_secret);

        // Pop the 5 card notes (unchanged code path)
        let options = NoteGetterOptions::with_filter(filter_by_token_ids, token_ids);
        let notes = self.storage.private_nfts.at(owner).pop_notes(options);
        assert(notes.len() == 5, "Could not find all 5 cards");

        // card_commit_hash = poseidon2([card_ids[0..5], blinding_factor])
        let mut to_hash: [Field; 6] = [0; 6];
        for i in 0..5 {
            to_hash[i] = token_ids[i];
        }
        to_hash[5] = poseidon2_hash([nhk_app_secret, self.address.to_field(), game_id]);
        let card_commit_hash = poseidon2_hash(to_hash);

        let player_state_hash = poseidon2_hash(randomness);

        // Advance the nonce past the 6 randomness slots this game consumed:
        // derive_game_randomness reads slots [nonce_value, nonce_value + 6) (one
        // per gameRandomness [Field; 6] element, main.nr derive_game_randomness),
        // so +6 guarantees no later pack/game derivation reuses a slot. Mirrors
        // purchase_card_pack's +10 for its 10 cards. (QA-A2: per-game delta = +6.)
        push_note_nonce(self.context, self.storage, owner, nonce_value + 6);

        debug_log_format(
            "[NFT] commit_create: card_commit={0} player_state={1}",
            [card_commit_hash, player_state_hash],
        );
        [card_commit_hash, player_state_hash, game_id]
    }

    /// Commit 5 NFTs for joining an existing game. Returns [card_commit_hash, player_state_hash].
    /// game_id is provided (from the game creator). Randomness is DERIVED IN-CIRCUIT.
    /// Called by TripleTriadGame.join_game.
    #[external("private")]
    fn commit_five_nfts_join(
        owner: AztecAddress,
        token_ids: [Field; 5],
        game_id: Field,
    ) -> [Field; 2] {
        let caller = self.msg_sender();
        let game = self.storage.game_contract.read();
        assert((caller == game) | (caller == owner), "Only game contract or owner can commit");

        // Get nhk_app_secret first (needed for nullifier logging and derivations)
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let nhk_app_secret = self.context.request_nhk_app(owner_npk_m_hash);

        // Log nonce note nullifier before popping
        log_nonce_nullifier(self.storage, owner, nhk_app_secret);

        let nonce_value = pop_note_nonce(self.context, self.storage, owner);

        // Derive randomness deterministically in-circuit
        let randomness = derive_game_randomness(nhk_app_secret, nonce_value);

        debug_log_format(
            "[NFT] commit_five_nfts_join: owner={0} nonce={1} game_id={2}",
            [owner.to_field(), nonce_value, game_id],
        );
        for i in 0..5 {
            debug_log_format("[NFT] commit_join: requesting token_id={0}", [token_ids[i]]);
        }

        // Log card nullifiers before popping (read-only peek)
        log_card_nullifiers(self.storage, owner, token_ids, nhk_app_secret);

        // Pop the 5 card notes (unchanged code path)
        let options = NoteGetterOptions::with_filter(filter_by_token_ids, token_ids);
        let notes = self.storage.private_nfts.at(owner).pop_notes(options);
        assert(notes.len() == 5, "Could not find all 5 cards");

        for i in 0..5 {
            debug_log_format(
                "[NFT] commit_join: popped note[{0}] value={1}",
                [i as Field, notes.get(i).value],
            );
        }

        // card_commit_hash = poseidon2([card_ids[0..5], blinding_factor])
        let mut to_hash: [Field; 6] = [0; 6];
        for i in 0..5 {
            to_hash[i] = token_ids[i];
        }
        to_hash[5] = poseidon2_hash([nhk_app_secret, self.address.to_field(), game_id]);
        let card_commit_hash = poseidon2_hash(to_hash);

        let player_state_hash = poseidon2_hash(randomness);

        // Advance the nonce past the 6 randomness slots this game consumed:
        // derive_game_randomness reads slots [nonce_value, nonce_value + 6) (one
        // per gameRandomness [Field; 6] element, main.nr derive_game_randomness),
        // so +6 guarantees no later pack/game derivation reuses a slot. Mirrors
        // purchase_card_pack's +10 for its 10 cards. (QA-A2: per-game delta = +6.)
        push_note_nonce(self.context, self.storage, owner, nonce_value + 6);
        debug_log_format(
            "[NFT] commit_join: card_commit={0} player_state={1}",
            [card_commit_hash, player_state_hash],
        );

        [card_commit_hash, player_state_hash]
    }

    #[external("private")]
    fn mint_for_game_winner(token_ids: [Field; 6], to: AztecAddress, randomness: [Field; 6]) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");

        debug_log_format("[NFT] mint_for_game_winner: to={0}", [to.to_field()]);
        for i in 0..6 {
            debug_log_format(
                "[NFT] winner_mint[{0}]: token_id={1} randomness={2}",
                [i as Field, token_ids[i], randomness[i]],
            );
            let _: Field = create_and_push_note(self.context, to, token_ids[i], randomness[i]);
            let note_tag = derive_note_tag(randomness[i]);
            let note_payload = encrypt_card_payload(token_ids[i], randomness[i]);
            self.emit(CardCreated { note_tag, note_payload }).deliver_to(
                to,
                MessageDelivery::offchain(),
            );
        }
    }

    #[external("private")]
    fn mint_for_game_loser(token_ids: [Field; 4], to: AztecAddress, randomness: [Field; 4]) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");

        debug_log_format("[NFT] mint_for_game_loser: to={0}", [to.to_field()]);
        for i in 0..4 {
            debug_log_format(
                "[NFT] loser_mint[{0}]: token_id={1} randomness={2}",
                [i as Field, token_ids[i], randomness[i]],
            );
            let _ = create_and_push_note(self.context, to, token_ids[i], randomness[i]);
            let note_tag = derive_note_tag(randomness[i]);
            let note_payload = encrypt_card_payload(token_ids[i], randomness[i]);
            self.emit(CardCreated { note_tag, note_payload }).deliver_to(
                to,
                MessageDelivery::offchain(),
            );
        }
    }

    /// ONCHAIN_CONSTRAINED draw mint --kept unchanged for cancel_game.
    #[external("private")]
    fn mint_for_game_draw(token_ids: [Field; 5], to: AztecAddress) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");

        for i in 0..5 {
            let note = FieldNote { value: token_ids[i] };
            self.storage.private_nfts.at(to).insert(note).deliver(
                MessageDelivery::onchain_constrained(),
            );
        }
    }

    /// OFFCHAIN draw mint for settlement --uses explicit randomness, with tagging for PXE discovery.
    #[external("private")]
    fn mint_for_game_draw_offchain(
        token_ids: [Field; 5],
        to: AztecAddress,
        randomness: [Field; 5],
    ) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");

        for i in 0..5 {
            let _ = create_and_push_note(self.context, to, token_ids[i], randomness[i]);
            let note_tag = derive_note_tag(randomness[i]);
            let note_payload = encrypt_card_payload(token_ids[i], randomness[i]);
            self.emit(CardCreated { note_tag, note_payload }).deliver_to(
                to,
                MessageDelivery::offchain(),
            );
        }
    }

    /// Mint a single card privately for abandoned game claim.
    #[external("private")]
    fn mint_single_card_private(token_id: Field, to: AztecAddress, randomness: Field) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");

        let _: Field = create_and_push_note(self.context, to, token_id, randomness);
        let note_tag = derive_note_tag(randomness);
        let note_payload = encrypt_card_payload(token_id, randomness);
        self.emit(CardCreated { note_tag, note_payload }).deliver_to(
            to,
            MessageDelivery::offchain(),
        );
    }

    /// Mint 5 cards to public ownership for abandoned game opponent recovery.
    /// No randomness needed -- cards go to public storage.
    /// Opponent can later call transfer_public_to_private.
    #[external("private")]
    fn mint_to_public_batch_5(token_ids: [Field; 5], to: AztecAddress) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");

        for i in 0..5 {
            self.enqueue_self.set_public_owner(to, token_ids[i]);
        }
    }

    /// Mint 4 cards to public ownership for abandoned game opponent recovery
    /// (when one card was claimed by the remaining player).
    #[external("private")]
    fn mint_to_public_batch_4(token_ids: [Field; 4], to: AztecAddress) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");

        for i in 0..4 {
            self.enqueue_self.set_public_owner(to, token_ids[i]);
        }
    }

    /// Build a NoteGetterOptions that selects a single card by token_id.
    #[contract_library_method]
    fn remove_one(token_id: Field) -> NoteGetterOptions<FieldNote, 1, Field, Field> {
        NoteGetterOptions::new()
            .select(FieldNote::properties().value, Comparator.EQ, token_id)
            .set_limit(1)
    }

    #[external("private")]
    fn transfer_private(from: AztecAddress, to: AztecAddress, token_id: Field) {
        assert(self.msg_sender() == from, "Sender must be owner");

        let notes = self.storage.private_nfts.at(from).pop_notes(remove_one(token_id));
        assert(notes.len() == 1, "Card not found");

        let note = FieldNote { value: token_id };
        self.storage.private_nfts.at(to).insert(note).deliver(MessageDelivery::onchain_constrained());
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
        self.storage.private_nfts.at(owner).insert(note).deliver(MessageDelivery::onchain_constrained());

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
    #[only_self]
    fn test_noop() {}

    // --- Randomness Derivation Utility ---

    /// Derive note_randomness values for cards created at a given nonce_value.
    /// Returns up to 10 randomness values (for card packs) -- use first `count` entries.
    /// For starter cards: nonce_value=0, count=5.
    /// Call via .simulate({ from: playerAddr }) -- no on-chain tx.
    #[external("private")]
    fn compute_note_randomness(nonce_value: Field, count: u32) -> [Field; 10] {
        let owner = self.msg_sender();
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let nhk_app_secret = self.context.request_nhk_app(owner_npk_m_hash);

        let mut result = [0 as Field; 10];
        for i in 0..10 {
            if (i as u32) < count {
                result[i] = derive_note_randomness(nhk_app_secret, nonce_value, i as Field);
            }
        }
        result
    }

    // --- Game Data Preview Utility ---

    /// Preview the game_id and randomness that will be derived for a given nonce_value.
    /// Call via .simulate({ from: playerAddr }) -- no on-chain tx.
    /// Frontend should call get_note_nonce() first to get current nonce_value.
    /// Returns [game_id, randomness[0], randomness[1], ..., randomness[5]] (7 values).
    /// Used before calling create_game to know the game_id to share with opponent.
    #[external("private")]
    fn preview_game_data(nonce_value: Field) -> [Field; 7] {
        let owner = self.msg_sender();
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let nhk_app_secret = self.context.request_nhk_app(owner_npk_m_hash);

        let game_id = derive_game_id(nhk_app_secret, nonce_value);
        let randomness = derive_game_randomness(nhk_app_secret, nonce_value);

        let mut result = [0 as Field; 7];
        result[0] = game_id;
        for i in 0..6 {
            result[i + 1] = randomness[i];
        }
        result
    }

    // --- Blinding Factor Utility ---

    /// Compute the blinding factor for the calling player for a specific game.
    /// This is the same value used in commit_five_nfts:
    ///   blinding_factor = poseidon2_hash([nhk_app_secret, contract_address, game_id])
    /// Call via .simulate({ from: playerAddr }) to retrieve without a transaction.
    #[external("private")]
    fn compute_blinding_factor(game_id: Field) -> Field {
        let owner = self.msg_sender();
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let seed = self.context.request_nhk_app(owner_npk_m_hash);
        poseidon2_hash([seed, self.address.to_field(), game_id])
    }

    // --- Note Import Utility ---

    /// Import a note created by the settlement tx into the recipient's PXE.
    /// Called via .simulate() -- NO on-chain tx. Validates against the on-chain tree.
    ///
    /// Encodes the note as a standard private-note message and feeds it through
    /// process_private_note_msg + validate_and_store, mirroring normal delivery.
    #[external("utility")]
    unconstrained fn import_note(
        owner: AztecAddress,
        value: Field,
        randomness: Field,
        tx_hash: Field,
        unique_note_hashes: [Field; 64],
        num_note_hashes: u32,
        first_nullifier: Field,
        recipient: AztecAddress,
    ) {
        let address = aztec::context::UtilityContext::new().this_address();
        // Owned<PrivateSet> uses the BASE storage slot (not derived via Map).
        // Use the auto-generated storage_layout() to get the correct slot.
        let storage_slot = TripleTriadNFT::storage_layout().private_nfts.slot;

        let note = FieldNote { value };

        // Build BoundedVec of unique note hashes from the tx
        let mut unique_hashes_vec: BoundedVec<Field, MAX_NOTE_HASHES_PER_TX> = BoundedVec::new();
        for i in 0..64 {
            if (i as u32) < num_note_hashes {
                unique_hashes_vec.push(unique_note_hashes[i]);
            }
        }

        // Run discovery (finds nonce, computes note hash, enqueues for validation).
        // attempt_note_discovery went private in 4.3.1; the public path is to encode
        // the note exactly as a delivered private-note message and re-split it.
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

        // Validate against on-chain tree and persist to PXE, scoped to the recipient
        validate_and_store_enqueued_notes_and_events(recipient);
    }

    // --- Utility Functions ---

    #[external("utility")]
    unconstrained fn get_nfts_for_user(
        owner: AztecAddress,
        page_index: u32,
    ) -> ([Field; MAX_NOTES_PER_PAGE], bool) {
        let mut page = [0 as Field; MAX_NOTES_PER_PAGE];
        let notes = self.storage.private_nfts.at(owner).view_notes(NoteViewerOptions::new()
            .set_offset(page_index * MAX_NOTES_PER_PAGE));
        for i in 0..notes.len() {
            page[i] = notes.get(i).value;
        }
        let has_more: bool = notes.len() == MAX_NOTES_PER_PAGE;
        (page, has_more)
    }

    /// Get the current note_nonce value for a player.
    /// Call via .simulate() -- unconstrained utility.
    #[external("utility")]
    unconstrained fn get_note_nonce(owner: AztecAddress) -> Field {
        let notes =
            self.storage.note_nonce.at(owner).view_notes(NoteViewerOptions::new().set_limit(1));
        if notes.len() == 0 {
            0
        } else {
            notes.get(0).value
        }
    }

    // --- Test-only Functions ---

    /// Same as mint_for_game_winner but without game contract authorization check.
    /// Used for testing note creation via create_and_push_note path.
    #[external("private")]
    fn test_mint_winner_cards(token_ids: [Field; 6], to: AztecAddress, randomness: [Field; 6]) {
        debug_log_format("[NFT] test_mint_winner_cards: to={0}", [to.to_field()]);
        for i in 0..6 {
            debug_log_format(
                "[NFT] test_mint[{0}]: token_id={1} randomness={2}",
                [i as Field, token_ids[i], randomness[i]],
            );
            let _: Field = create_and_push_note(self.context, to, token_ids[i], randomness[i]);
            let note_tag = derive_note_tag(randomness[i]);
            let note_payload = encrypt_card_payload(token_ids[i], randomness[i]);
            self.emit(CardCreated { note_tag, note_payload }).deliver_to(
                to,
                MessageDelivery::offchain(),
            );
        }
    }

    /// Same as get_cards_for_new_player but with a configurable nonce_value for randomness derivation.
    /// Does not mint Arena Tokens. Used for testing to avoid randomness collisions.
    #[external("private")]
    fn get_cards_for_new_player_test(nonce_value: Field) {
        let owner = self.msg_sender();

        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let nhk_app_secret = self.context.request_nhk_app(owner_npk_m_hash);

        for i in 0..5 {
            let note_randomness = derive_note_randomness(nhk_app_secret, nonce_value, i as Field);
            let note_tag = derive_note_tag(note_randomness);
            let note_payload = encrypt_card_payload(STARTER_CARD_IDS[i], note_randomness);

            let _: Field =
                create_and_push_note(self.context, owner, STARTER_CARD_IDS[i], note_randomness);
            self.emit(CardCreated { note_tag, note_payload }).deliver_to(
                owner,
                MessageDelivery::offchain(),
            );
        }

        // Push nonce directly (no pop) -- mirrors real fn's push_note_nonce(... 5)
        push_note_nonce(self.context, self.storage, owner, nonce_value + 5);

        // Enqueue a no-op public call to match the real fn's enqueue pattern
        self.enqueue_self.test_noop();
    }

    /// Initialize a note nonce for the caller without minting any cards.
    /// Used for testing when we want to mint cards first, then nullify them.
    #[external("private")]
    fn test_init_nonce(initial_value: Field) {
        let owner = self.msg_sender();
        debug_log_format(
            "[NFT] test_init_nonce: owner={0} value={1}",
            [owner.to_field(), initial_value],
        );
        push_note_nonce(self.context, self.storage, owner, initial_value);
    }

    /// Same as test_mint_winner_cards but also advances the nonce.
    /// Used for testing the full mint+nonce-update flow.
    #[external("private")]
    fn test_mint_winner_cards_with_nonce(
        token_ids: [Field; 6],
        to: AztecAddress,
        randomness: [Field; 6],
    ) {
        debug_log_format(
            "[NFT] test_mint_winner_cards_with_nonce: to={0}",
            [to.to_field()],
        );
        for i in 0..6 {
            debug_log_format(
                "[NFT] test_mint[{0}]: token_id={1} randomness={2}",
                [i as Field, token_ids[i], randomness[i]],
            );
            let _: Field = create_and_push_note(self.context, to, token_ids[i], randomness[i]);
            let note_tag = derive_note_tag(randomness[i]);
            let note_payload = encrypt_card_payload(token_ids[i], randomness[i]);
            self.emit(CardCreated { note_tag, note_payload }).deliver_to(
                to,
                MessageDelivery::offchain(),
            );
        }
        // Advance nonce by 6 (same as mint_for_game_winner)
        let nonce_value = pop_note_nonce(self.context, self.storage, to);
        push_note_nonce(self.context, self.storage, to, nonce_value + 6);
    }

    /// Nullify 5 cards by popping them from the private set.
    /// Used for testing: consumes card notes so their nullifiers appear on-chain.
    #[external("private")]
    fn test_nullify_cards(owner: AztecAddress, token_ids: [Field; 5]) {
        assert(self.msg_sender() == owner, "Only owner can nullify");

        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let nhk_app_secret = self.context.request_nhk_app(owner_npk_m_hash);

        // Log nullifiers before popping for diagnostic comparison
        log_card_nullifiers(self.storage, owner, token_ids, nhk_app_secret);

        let options = NoteGetterOptions::with_filter(filter_by_token_ids, token_ids);
        let notes = self.storage.private_nfts.at(owner).pop_notes(options);
        debug_log_format(
            "[NFT] test_nullify_cards: popped {0} notes",
            [notes.len() as Field],
        );
        assert(notes.len() == 5, "Could not find all 5 cards to nullify");

        // update nonce
        let nonce_value = pop_note_nonce(self.context, self.storage, self.msg_sender());
        push_note_nonce(
            self.context,
            self.storage,
            self.msg_sender(),
            nonce_value + 6,
        );
    }

    /// Create 10 card notes via create_and_push_note with deterministic randomness.
    /// token_ids: 10 card IDs to create.
    /// nonce_offset: used for randomness derivation (each batch should use a different offset).
    /// Does NOT touch note_nonce -- caller manages nonce separately.
    #[external("private")]
    fn test_create_10_cards(to: AztecAddress, token_ids: [Field; 10], nonce_offset: Field) {
        let owner_npk_m_hash = get_public_keys(to).npk_m_hash;
        let nhk_app_secret = self.context.request_nhk_app(owner_npk_m_hash);

        for i in 0..10 {
            let note_randomness = derive_note_randomness(nhk_app_secret, nonce_offset, i as Field);
            let _: Field = create_and_push_note(self.context, to, token_ids[i], note_randomness);
            let note_tag = derive_note_tag(note_randomness);
            let note_payload = encrypt_card_payload(token_ids[i], note_randomness);
            self.emit(CardCreated { note_tag, note_payload }).deliver_to(
                to,
                MessageDelivery::offchain(),
            );
        }
    }

    /// Nullify 10 cards by popping them from the private set.
    /// Does NOT touch note_nonce -- caller manages nonce separately.
    #[external("private")]
    fn test_nullify_10_cards(owner: AztecAddress, token_ids: [Field; 10]) {
        assert(self.msg_sender() == owner, "Only owner can nullify");

        let options = NoteGetterOptions::with_filter(filter_by_token_ids_10, token_ids);
        let notes = self.storage.private_nfts.at(owner).pop_notes(options);
        debug_log_format(
            "[NFT] test_nullify_10_cards: popped {0} notes",
            [notes.len() as Field],
        );
        assert(notes.len() == 10, "Could not find all 10 cards to nullify");
    }
}
