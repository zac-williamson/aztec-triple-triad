mod test;
pub mod test_support;
pub mod card_note;

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

/// A hand a player may commit: five DISTINCT card ids, each a real card.
///
/// Distinct because a move proof places a card by naming its hand slot and
/// rejects replaying an id this player already placed (game_move section 4b),
/// so a hand holding one id twice could never place its fifth card. In range
/// because the move circuit looks every id up in the card table, and settlement
/// awards the prize card by id. This used to be the hand proof's job; doing it
/// here, on-chain, at the moment the cards are taken, is what lets settlement
/// drop the two hand proofs (docs/plan/PRIVATE_GAMES.md section 4).
///
/// At module scope so `nargo test` can reach it.
pub fn validate_hand(card_ids: [Field; 5]) {
    for i in 0..5 {
        let id = card_ids[i];
        assert((id as u32) as Field == id, "Card ID out of range");
        assert(((id as u32) >= 1) & ((id as u32) <= 256), "Card ID out of range");
        for j in (i + 1)..5 {
            assert(card_ids[i] != card_ids[j], "Duplicate card IDs not allowed");
        }
    }
}

/// Per-game secrets a committing player derives, by `derive_note_randomness`
/// index (docs/plan/PRIVATE_GAMES.md section 3.2). The nonce advances past all
/// of them.
pub global GAME_SECRET_COUNT: u32 = 8;
/// Slot of the prize partial note's randomness among the game secrets.
pub global PRIZE_SECRET_INDEX: u32 = 5;
/// Slot of the reward note's randomness.
pub global REWARD_SECRET_INDEX: u32 = 6;
/// Slot of the hand blinding factor.
pub global BLINDING_SECRET_INDEX: u32 = 7;

/// Fixed starter set card IDs (common cards)
global STARTER_CARD_IDS: [Field; 5] = [1, 2, 3, 4, 5];

/// Domain separator for the one-per-account starter-claim nullifier:
/// "STARTER_CLAIM" packed as big-endian ASCII. App-level separator, distinct
/// from the protocol's DOM_SEP__NOTE_NULLIFIER space.
global DOM_SEP__STARTER_CLAIM: Field = 0x535441525445525f434c41494d;

/// Cost of a card pack in Arena Tokens
global CARD_PACK_COST: u128 = 100;

/// Domain separator for deterministic note randomness, hashed with poseidon2 to
/// derive its IV. Kept under 128 bits to avoid Noir integer literal limits.
/// "SecretIV" = 0x5365637265744956
global AXOLOTL_NOTE_SECRET_IV_FIELD: Field = 0x5365637265744956;


/// Storage slot for private_nfts: use TripleTriadNFT::storage_layout().private_nfts.slot
/// The #[storage] macro assigns slots including hidden internal fields, so never hardcode.

/// Triple Triad NFT contract.
/// Each card is an NFT with a unique token_id corresponding to the card's ID.
/// Supports private ownership for hidden hand information and public ownership for trading.
#[aztec]
pub contract TripleTriadNFT {
    use super::{
        AXOLOTL_NOTE_SECRET_IV_FIELD, BLINDING_SECRET_INDEX, CARD_PACK_COST, DOM_SEP__STARTER_CLAIM,
        GAME_SECRET_COUNT, generate_card, PRIZE_SECRET_INDEX, REWARD_SECRET_INDEX,
        STARTER_CARD_IDS, validate_hand,
    };
    use super::card_note::{card_partial_commitment, CardNote, complete_card_note_hash};
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
            lifecycle::NewNote,
            NoteMessage,
            note_getter_options::NoteGetterOptions,
            note_interface::{NoteHash, NoteProperties, NoteType},
            note_viewer_options::NoteViewerOptions,
        },
        history::nullifier::assert_nullifier_did_not_exist_by,
        oracle::{logging::debug_log_format, notes::notify_created_note},
        protocol::{
            address::AztecAddress,
            constants::MAX_NOTE_HASHES_PER_TX,
            hash::{compute_siloed_nullifier, poseidon2_hash},
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

    // --- Storage ---

    #[storage]
    struct Storage<Context> {
        name: PublicImmutable<FieldCompressedString, Context>,
        symbol: PublicImmutable<FieldCompressedString, Context>,
        minter: PublicImmutable<AztecAddress, Context>,
        token_contract: PublicImmutable<AztecAddress, Context>,
        private_nfts: Owned<PrivateSet<CardNote, Context>, Context>,
        nft_exists: Map<Field, PublicMutable<bool, Context>, Context>,
        public_owners: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        card_ranks: Map<Field, PublicImmutable<Field, Context>, Context>,
        game_contract: PublicImmutable<AztecAddress, Context>,

        // Note nonce: a single FieldNote per user tracking nonce counter for deterministic randomness
        note_nonce: Owned<PrivateSet<FieldNote, Context>, Context>,
        /// Arena bot addresses by pool slot. These are the ONLY accounts that
        /// may hold duplicate cards (see mint_bot_cards). A Map because the bot
        /// runs as a POOL of independent identities — one process each, since
        /// the PXE binds one wallet per process. Each slot is PublicImmutable so
        /// a private function can read it and so a slot can never be repointed
        /// at a player once set.
        arena_bots: Map<Field, PublicImmutable<AztecAddress, Context>, Context>,
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

    /// Register the arena bot. Admin only, and settable exactly ONCE —
    /// PublicImmutable — because this address is the sole exemption from the
    /// one-NFT-per-token_id rule. If it could be changed, or pointed at a
    /// player, the exemption would become an unlimited card faucet for whoever
    /// held it.
    #[external("public")]
    fn set_arena_bot(slot: Field, bot: AztecAddress) {
        let minter = self.storage.minter.read();
        assert(self.msg_sender() == minter, "Only minter can set arena bot");
        self.storage.arena_bots.at(slot).initialize(bot);
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

    // --- IV Computation Helpers ---

    /// Compute the note_randomness_secret_iv: poseidon2([AXOLOTL_NOTE_SECRET_IV_FIELD])
    #[contract_library_method]
    fn compute_note_randomness_secret_iv() -> Field {
        poseidon2_hash([AXOLOTL_NOTE_SECRET_IV_FIELD])
    }

    /// Derive deterministic note_randomness for a given note_nonce value and index.
    /// note_randomness = poseidon2([nhk_app_secret, note_nonce + index, note_randomness_secret_iv])
    #[contract_library_method]
    fn derive_note_randomness(nhk_app_secret: Field, nonce_value: Field, index: Field) -> Field {
        let iv = compute_note_randomness_secret_iv();
        poseidon2_hash([nhk_app_secret, nonce_value + index, iv])
    }

    /// The per-game secrets of a commit (docs/plan/PRIVATE_GAMES.md section
    /// 3.2): return-note randomness for slots 0..4, then the prize and reward
    /// randomness and the hand blinding factor. All from the owner's own
    /// nhk_app and nonce, so the owner can always re-derive them and nobody
    /// else can.
    #[contract_library_method]
    fn derive_game_secrets(nhk_app_secret: Field, nonce_value: Field) -> [Field; GAME_SECRET_COUNT] {
        let mut result: [Field; GAME_SECRET_COUNT] = [0; GAME_SECRET_COUNT];
        for i in 0..GAME_SECRET_COUNT {
            result[i] = derive_note_randomness(nhk_app_secret, nonce_value, i as Field);
        }
        result
    }

    /// What a commit of `token_ids` at `nonce_value` prepares for `owner`:
    /// `[hand_commit, ret_0..ret_4, prize_partial, reward_note_hash]`. Shared by
    /// the commit itself and its preview so the two cannot drift.
    #[contract_library_method]
    fn prepared_payouts(
        owner: AztecAddress,
        nhk_app_secret: Field,
        nonce_value: Field,
        token_ids: [Field; 5],
        reward: u128,
    ) -> [Field; 8] {
        let secrets = derive_game_secrets(nhk_app_secret, nonce_value);
        let card_slot = TripleTriadNFT::storage_layout().private_nfts.slot;

        let mut out: [Field; 8] = [0; 8];
        // hand_commit = poseidon2([card_ids[0..5], blinding]) -- the formula the
        // move circuit recomputes.
        out[0] = poseidon2_hash([
            token_ids[0], token_ids[1], token_ids[2], token_ids[3], token_ids[4],
            secrets[BLINDING_SECRET_INDEX],
        ]);
        // One fully formed return note per hand slot, owned by the committer.
        for i in 0..5 {
            out[1 + i] = CardNote { card_id: token_ids[i] }.compute_note_hash(owner, card_slot, secrets[i]);
        }
        out[6] = card_partial_commitment(owner, secrets[PRIZE_SECRET_INDEX]);
        out[7] = UintNote { value: reward }.compute_note_hash(
            owner,
            ArenaToken::storage_layout().balances.slot,
            secrets[REWARD_SECRET_INDEX],
        );
        out
    }

    // --- Card Selection ---

    /// Pop exactly one note per requested token_id, selecting in the ORACLE.
    ///
    /// NOT `NoteGetterOptions::with_filter`, which is what this replaced.
    /// `with_filter` sets the read limit to MAX_NOTE_HASH_READ_REQUESTS_PER_CALL
    /// (16) and applies its predicate CLIENT-SIDE to whatever 16 notes the
    /// oracle happened to return. So an owner holding more than 16 cards could
    /// fail to commit a hand of cards they demonstrably own — "Could not find
    /// all 5 cards" — purely because those cards fell outside that window. It is
    /// silent and looks like a flake, it gets likelier the more cards you own,
    /// and it makes a large collection (the arena bot's) impossible.
    ///
    /// Selecting per card pushes the match into the oracle, so it holds for a
    /// collection of ANY size, and it issues 5 read requests instead of 16.
    /// Duplicate ids in `token_ids` are handled correctly: each pop nullifies
    /// the note it took, so the next select for the same id finds a different
    /// one.
    #[contract_library_method]
    fn pop_cards_by_id(
        storage: Storage<&mut aztec::context::PrivateContext>,
        owner: AztecAddress,
        token_ids: [Field; 5],
    ) {
        for i in 0..5 {
            let options: NoteGetterOptions<CardNote, 1, Field, Field> = NoteGetterOptions::new()
                .select(CardNote::properties().card_id, Comparator.EQ, token_ids[i])
                .set_limit(1);
            let popped = storage.private_nfts.at(owner).pop_notes(options);
            assert(popped.len() == 1, "Could not find all 5 cards");
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

        // Mint 5 starter cards with deterministic randomness; the owner receives
        // their messages with offchain_receive.
        for i in 0..5 {
            let note_randomness = derive_note_randomness(nhk_app_secret, 0, i as Field);
            create_and_push_note(self.context, owner, STARTER_CARD_IDS[i], note_randomness)
                .deliver(MessageDelivery::offchain());
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
            let (_, card_id) = generate_card(nhk_app_secret, nonce_value + i as Field);
            create_and_push_note(self.context, owner, card_id as Field, note_randomness)
                .deliver(MessageDelivery::offchain());
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

    // --- Custom Note Creation (explicit randomness) ---

    /// Create a card note in `owner`'s card set with randomness WE choose,
    /// notify the local PXE and push the note hash. Returns the note,
    /// undelivered.
    ///
    /// The randomness is never random: players' notes derive it from their own
    /// nhk_app secret (`derive_note_randomness`), the bot's stock gets it from
    /// the provisioner's manifest. So an owner can always rebuild a note and
    /// import it by hand (`import_note`) needing nothing from the sender.
    #[contract_library_method]
    fn push_card_note(
        context: &mut aztec::context::PrivateContext,
        owner: AztecAddress,
        value: Field,
        randomness: Field,
    ) -> NewNote<CardNote> {
        let note = CardNote { card_id: value };
        let note_hash_counter = context.get_side_effect_counter();
        // Owned<PrivateSet> uses the BASE storage slot (not a derived/mapped slot).
        let storage_slot = TripleTriadNFT::storage_layout().private_nfts.slot;
        let note_hash = note.compute_note_hash(owner, storage_slot, randomness);
        notify_created_note(
            owner,
            storage_slot,
            randomness,
            CardNote::get_id(),
            note.pack(),
            note_hash,
            note_hash_counter,
        );
        context.push_note_hash(note_hash);
        NewNote { note, owner, storage_slot, randomness, note_hash_counter }
    }

    /// `push_card_note`, returning the note's message for the caller to deliver.
    ///
    /// Every player-facing mint delivers it with `MessageDelivery::offchain()`:
    /// the message comes back from the send as one of its `offchainMessages`,
    /// and the owner hands it to the macro-injected `offchain_receive`, which
    /// stores the note once its tx is found on-chain (and again after a reorg).
    /// That is the normal path; `import_note` is for recovery. `create_note`
    /// would choose random randomness — building the `NewNote` ourselves is what
    /// keeps it derivable. See docs/plan/OFFCHAIN_DELIVERY.md.
    #[contract_library_method]
    fn create_and_push_note(
        context: &mut aztec::context::PrivateContext,
        owner: AztecAddress,
        value: Field,
        randomness: Field,
    ) -> NoteMessage<CardNote> {
        let new_note = push_card_note(context, owner, value, randomness);
        NoteMessage::new(new_note, context)
    }

    // --- Minting ---

    #[external("private")]
    fn mint_to_private(to: AztecAddress, token_id: Field, packed_ranks: Field) {
        let minter = self.storage.minter.read();
        assert(self.msg_sender() == minter, "Only minter can mint");

        let note = CardNote { card_id: token_id };
        self.storage.private_nfts.at(to).insert(note).deliver(MessageDelivery::onchain_constrained());

        self.enqueue_self.finalize_mint(to, token_id, packed_ranks);
    }

    /// Mint cards to the ARENA BOT, allowing DUPLICATES of a token_id.
    ///
    /// Every other mint path registers `nft_exists[token_id]` and refuses a
    /// second card with the same id, which makes a token_id a globally unique
    /// instance. That is right for players — a card someone owns should be the
    /// only one — but it caps the bot's collection at the size of the card
    /// database and forces it to compete with players for ids.
    ///
    /// The bot is not a collector: it needs a deep stock of ordinary cards to
    /// wager, and which INSTANCE it holds is meaningless. So for the bot, and
    /// only the bot, a token_id is a card TYPE and it may hold many. The notes
    /// are ordinary CardNotes, so nothing downstream changes: nullifiers come
    /// from note randomness, not from the id, and ranks are already registered
    /// per id.
    ///
    /// Restricted twice over: only the minter may call it, and the recipient is
    /// read from immutable storage rather than passed in, so it cannot be aimed
    /// at a player even by the minter.
    #[external("private")]
    fn mint_bot_cards(
        slot: Field,
        token_ids: [Field; 10],
        packed_ranks: [Field; 10],
        randomness: [Field; 10],
        count: u32,
    ) {
        let minter = self.storage.minter.read();
        assert(self.msg_sender() == minter, "Only minter can mint");
        assert(count <= 10, "count exceeds batch size");

        let bot = self.storage.arena_bots.at(slot).read();
        assert(!bot.is_zero(), "Arena bot slot not registered");

        // push_card_note, NOT a tagged `insert(...).deliver(onchain_constrained())`.
        //
        // Constrained delivery consumes one tagging index per note per
        // (sender, recipient) pair, and that window is a hard 84 that only
        // advances as blocks FINALISE. Minting a deep stock that way dies at
        // ~84 cards with "Highest used index N is at or past the window end",
        // and waiting it out took minutes per handful — so a thousand cards was
        // simply not reachable.
        //
        // Untagged notes have no such ceiling; the cost is that the recipient
        // cannot discover them passively. The randomness supplied by the
        // caller goes into the provisioner's manifest and the bot imports each
        // note from it (`import_note`).
        //
        // And NO message, unlike every player-facing mint. Received offchain
        // messages stay in the recipient's inbox until their block finalizes,
        // and every contract sync re-fetches the receipt of each one's tx. That
        // is one to three txs for a player; for a thousand-card stock minted
        // ten per tx it is a hundred receipt reads per sync, against an RPC that
        // rate-limits. The manifest import has no such cost: once a note is
        // stored, nothing revisits it.
        for i in 0..10 {
            if (i as u32) < count {
                let _ = push_card_note(self.context, bot, token_ids[i], randomness[i]);
            }
        }

        self.enqueue_self.finalize_bot_mint(token_ids, packed_ranks, count);
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

    /// Commit a hand to a game: take the five cards, and PREPARE everything the
    /// player could be paid back at settlement (docs/plan/PRIVATE_GAMES.md
    /// section 3.3). Returns
    /// `[hand_commit, ret_0..ret_4, prize_partial, reward_note_hash]`.
    ///
    /// Every payout is prepared here, inside the committing player's own tx,
    /// from secrets only they hold -- so settlement can release them without
    /// anyone learning their address, their randomness or their hand. Only
    /// the game contract may commit (a commit consumes the cards).
    #[external("private")]
    fn commit_hand(owner: AztecAddress, token_ids: [Field; 5], reward: u128) -> [Field; 8] {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");
        validate_hand(token_ids);

        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let nhk_app_secret = self.context.request_nhk_app(owner_npk_m_hash);

        let nonce_value = pop_note_nonce(self.context, self.storage, owner);
        pop_cards_by_id(self.storage, owner, token_ids);
        let prepared = prepared_payouts(owner, nhk_app_secret, nonce_value, token_ids, reward);
        // Past every secret this game derived, so no later pack or game reuses one.
        push_note_nonce(self.context, self.storage, owner, nonce_value + GAME_SECRET_COUNT as Field);
        prepared
    }

    /// What `commit_hand` would return at `nonce_value`, without taking
    /// anything. Simulate-only: the client builds its record from it before it
    /// commits.
    #[external("private")]
    #[view]
    fn preview_commit(
        owner: AztecAddress,
        token_ids: [Field; 5],
        nonce_value: Field,
        reward: u128,
    ) -> [Field; 8] {
        let caller = self.msg_sender();
        let game = self.storage.game_contract.read();
        assert((caller == game) | (caller == owner), "Only the owner or game contract can preview");
        validate_hand(token_ids);
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let nhk_app_secret = self.context.request_nhk_app(owner_npk_m_hash);
        prepared_payouts(owner, nhk_app_secret, nonce_value, token_ids, reward)
    }

    /// Release prepared card notes: the first `count` of `note_hashes`, and,
    /// when `prize_card` is non-zero, the prize card completed into
    /// `prize_partial`. Nothing is delivered -- each owner rebuilds their own
    /// notes from secrets they already hold and imports them from this tx.
    ///
    /// The game contract is the only caller, and everything it passes comes
    /// from records committed in the players' own commit txs.
    #[external("private")]
    fn release_game_cards(
        note_hashes: [Field; 10],
        count: u32,
        prize_partial: Field,
        prize_card: Field,
    ) {
        let game = self.storage.game_contract.read();
        assert(self.msg_sender() == game, "Only game contract can call");
        assert(count <= 10, "count exceeds batch size");
        for i in 0..10 {
            if i < count {
                self.context.push_note_hash(note_hashes[i]);
            }
        }
        if prize_card != 0 {
            let storage_slot = TripleTriadNFT::storage_layout().private_nfts.slot;
            self.context.push_note_hash(complete_card_note_hash(prize_partial, storage_slot, prize_card));
        }
    }

    /// Build a NoteGetterOptions that selects a single card by token_id.
    #[contract_library_method]
    fn remove_one(token_id: Field) -> NoteGetterOptions<CardNote, 1, Field, Field> {
        NoteGetterOptions::new()
            .select(CardNote::properties().card_id, Comparator.EQ, token_id)
            .set_limit(1)
    }

    #[external("private")]
    fn transfer_private(from: AztecAddress, to: AztecAddress, token_id: Field) {
        assert(self.msg_sender() == from, "Sender must be owner");

        let notes = self.storage.private_nfts.at(from).pop_notes(remove_one(token_id));
        assert(notes.len() == 1, "Card not found");

        let note = CardNote { card_id: token_id };
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

    // --- Private to Public ---

    #[external("private")]
    fn transfer_private_to_public(from: AztecAddress, token_id: Field) {
        assert(self.msg_sender() == from, "Sender must be owner");

        let options = NoteGetterOptions::new()
            .select(CardNote::properties().card_id, Comparator.EQ, token_id)
            .set_limit(1);
        let notes = self.storage.private_nfts.at(from).pop_notes(options);
        assert(notes.len() == 1, "Card not found");

        self.enqueue_self.set_public_owner(from, token_id);
    }

    // --- Public to Private ---

    /// Take a publicly owned card back into the caller's private set: the way
    /// back from `transfer_private_to_public`, and the way in for a card
    /// minted with `mint_to_public`.
    #[external("private")]
    fn reclaim_card(token_id: Field) {
        let owner = self.msg_sender();

        let note = CardNote { card_id: token_id };
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

    /// Register ranks for any id the bot's mint introduced that nobody has minted
    /// before. Unlike finalize_mint this does NOT assert uniqueness — duplicates
    /// are the entire point — and it skips ids already registered, whose ranks
    /// are by definition the same ones.
    #[external("public")]
    #[only_self]
    fn finalize_bot_mint(token_ids: [Field; 10], packed_ranks: [Field; 10], count: u32) {
        for i in 0..10 {
            if (i as u32) < count {
                let token_id = token_ids[i];
                let exists = self.storage.nft_exists.at(token_id).read();
                if !exists {
                    self.storage.nft_exists.at(token_id).write(true);
                    self.storage.card_ranks.at(token_id).initialize(packed_ranks[i]);
                }
            }
        }
    }

    #[external("public")]
    #[only_self]
    fn set_public_owner(owner: AztecAddress, token_id: Field) {
        self.storage.public_owners.at(token_id).write(owner);
    }

    #[external("public")]
    #[only_self]
    fn finalize_reclaim(owner: AztecAddress, token_id: Field) {
        let current_owner = self.storage.public_owners.at(token_id).read();
        assert(current_owner == owner, "Not the public owner");

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

    // --- Game Secrets Utility ---

    /// The caller's per-game secrets at `nonce_value`:
    /// `[blinding, r_0..r_4, prize_randomness, reward_randomness]`.
    /// Simulate-only. The client needs the blinding to prove moves and the
    /// randomness to import what settlement releases to it.
    #[external("private")]
    #[view]
    fn compute_game_secrets(nonce_value: Field) -> [Field; 8] {
        let owner = self.msg_sender();
        let owner_npk_m_hash = get_public_keys(owner).npk_m_hash;
        let nhk_app_secret = self.context.request_nhk_app(owner_npk_m_hash);
        let secrets = derive_game_secrets(nhk_app_secret, nonce_value);
        let mut out: [Field; 8] = [0; 8];
        out[0] = secrets[BLINDING_SECRET_INDEX];
        for i in 0..5 {
            out[1 + i] = secrets[i];
        }
        out[6] = secrets[PRIZE_SECRET_INDEX];
        out[7] = secrets[REWARD_SECRET_INDEX];
        out
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

        let note = CardNote { card_id: value };

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
            page[i] = notes.get(i).card_id;
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
}
