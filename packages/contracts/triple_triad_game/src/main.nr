use aztec::macros::aztec;

/*
 * Triple Triad game contract -- private games (docs/plan/PRIVATE_GAMES.md).
 *
 * A game leaves no public trace. There is no public storage beyond the
 * constructor's immutables, no public call and no event: a game's state is a
 * set of nullifiers derived from `game_key`, a secret only its two players
 * hold. Create, join and settle are therefore unlinkable to each other and to
 * this contract by anyone else.
 *
 * Each player PREPARES their own payouts in the tx that commits their cards:
 * five return notes, a partial note for a possible prize card and a reward
 * note, all built from secrets only they hold. Only hashes leave that tx, in
 * the player's RECORD. Settlement verifies the nine move proofs and RELEASES
 * prepared notes, so it needs no address, randomness, blinding factor or
 * unplayed card -- anyone holding the two records and the transcript can
 * settle, and each player imports their own notes from the settlement tx.
 */

/// Seconds a game must have been active (or have been active again, after a
/// contest) before an abandonment claim is honest. A claim earlier than this
/// could be raced against a winner's settlement. Seconds, not blocks: block
/// time on this testnet ranges from under half a minute to over a minute.
pub global MIN_ABANDON_SECONDS: u64 = 480;

/// Seconds a claim stands before it can be finalized, during which the other
/// player may contest it ("I am still here").
pub global DISPUTE_SECONDS: u64 = 600;

/// Arena Tokens each player earns from a settled game.
pub global REWARD_PER_GAME: u128 = 20;

/// A player's record: `[seat, hand_commit, ret_0..ret_4, prize_partial,
/// reward_note_hash]` (docs/plan/PRIVATE_GAMES.md section 3.3).
pub global RECORD_LEN: u32 = 9;
pub global RECORD_SEAT: u32 = 0;
pub global RECORD_HAND: u32 = 1;
pub global RECORD_RETURNS: u32 = 2;
pub global RECORD_PRIZE: u32 = 7;
pub global RECORD_REWARD: u32 = 8;

/// A move proof's public inputs: `[card_commit_1, card_commit_2,
/// start_state_hash, end_state_hash, game_ended, winner_id, placed_card_id,
/// placed_slot]`.
pub global MOVE_INPUTS: u32 = 8;

/// Abandonment claims a game can see. Each side may contest once, so after two
/// contests a third claim stands.
pub global MAX_CLAIMS: u32 = 3;

/// Number of siloed nullifiers `game_nullifiers` reports.
pub global GAME_NULLIFIER_COUNT: u32 = 21;

// App-level domain separators: the ASCII of each name, big-endian.
global DOM_SEP__PLAYER: Field = 0x41415f504c41594552; // "AA_PLAYER"
global DOM_SEP__SEAT: Field = 0x41415f53454154; // "AA_SEAT"
global DOM_SEP__RECORD: Field = 0x41415f5245434f5244; // "AA_RECORD"
global DOM_SEP__GAME_ID: Field = 0x41415f47414d455f4944; // "AA_GAME_ID"
global DOM_SEP__N_CREATED: Field = 0x41415f4e5f43524541544544; // "AA_N_CREATED"
global DOM_SEP__N_SEAT2: Field = 0x41415f4e5f5345415432; // "AA_N_SEAT2"
global DOM_SEP__N_JOINED: Field = 0x41415f4e5f4a4f494e4544; // "AA_N_JOINED"
global DOM_SEP__N_DONE: Field = 0x41415f4e5f444f4e45; // "AA_N_DONE"
global DOM_SEP__N_CLAIM_SLOT: Field = 0x41415f4e5f434c41494d5f534c4f54; // "AA_N_CLAIM_SLOT"
global DOM_SEP__N_CLAIM: Field = 0x41415f4e5f434c41494d; // "AA_N_CLAIM"
global DOM_SEP__N_CONTESTED_BY: Field = 0x41415f4e5f434f4e5445535445445f4259; // "AA_N_CONTESTED_BY"
global DOM_SEP__N_CONTEST: Field = 0x41415f4e5f434f4e54455354; // "AA_N_CONTEST"
global DOM_SEP__N_RESOLVED: Field = 0x41415f4e5f5245534f4c564544; // "AA_N_RESOLVED"

/*
 * ============================ VALIDATORS ============================
 *
 * The contract's rules as pure functions that OWN their assertions, so that
 * `nargo test` can call every one directly (see test/validators.nr). An
 * assertion left at a call site inside a proof-verifying function is out of
 * reach of every test; that is where the bugs of the previous design lived.
 */

/// What a deployment may register as its verification keys. `permissive`
/// deployments register the dummy circuit's VK as the move VK so a playtest
/// can skip real proving -- an unsound configuration that is at least explicit
/// and recorded on-chain (`has_permissive_vks`).
pub fn assert_vk_configuration(move_vk_hash: Field, dummy_vk_hash: Field, permissive: bool) {
    assert(move_vk_hash != 0, "move_vk_hash must be set");
    assert(dummy_vk_hash != 0, "dummy_vk_hash must be set");
    if !permissive {
        assert(move_vk_hash != dummy_vk_hash, "move_vk_hash must not be the dummy VK");
    }
}

/// Canonical hash of the empty board. Must match game_move's
/// `hash_board_state` for an empty board byte-for-byte: 18 board cells (0),
/// scores [5, 5], current_turn 1, then 9 original owners (0).
pub fn compute_initial_state_hash() -> Field {
    let mut initial_inputs: [Field; 30] = [0; 30];
    initial_inputs[18] = 5;
    initial_inputs[19] = 5;
    initial_inputs[20] = 1;
    std::hash::pedersen_hash(initial_inputs)
}

/// The whole transcript of a finished game: every move bound to the two hands
/// committed to THIS game, each move's end state the next one's start, the
/// chain anchored at the empty board, and only the ninth move ending the game
/// with a valid winner.
pub fn assert_transcript(
    move_inputs: [[Field; MOVE_INPUTS]; 9],
    hand_commit_1: Field,
    hand_commit_2: Field,
) {
    for i in 0..9 {
        assert(move_inputs[i][0] == hand_commit_1, "Move proof card_commit_1 mismatch");
        assert(move_inputs[i][1] == hand_commit_2, "Move proof card_commit_2 mismatch");
    }
    for i in 0..8 {
        assert(
            move_inputs[i][3] == move_inputs[i + 1][2],
            "Proof chaining failed: end_state != next start_state",
        );
    }
    assert(
        move_inputs[0][2] == compute_initial_state_hash(),
        "First move start_state does not match initial state",
    );
    for i in 0..8 {
        assert(move_inputs[i][4] == 0, "Only the ninth move may end the game");
        assert(move_inputs[i][5] == 0, "Only the ninth move may have a winner");
    }
    assert(move_inputs[8][4] == 1, "The ninth move must end the game");
    let w = move_inputs[8][5];
    assert((w == 1) | (w == 2) | (w == 3), "The ninth move must name a valid winner");
}

/// The prize of a decisive game: a card the LOSER placed, named by the index
/// of the move that placed it. Player 1 moves at even indices and player 2 at
/// odd ones, so the move's parity says whose card it was; its proof says which
/// card and which of the loser's hand slots it came from. Returns
/// `(prize_card, prize_slot)`.
///
/// Limiting the prize to placed cards is what keeps player 2's unplayed card
/// secret from everyone (docs/plan/PRIVATE_GAMES.md section 8).
pub fn prize_of(
    move_inputs: [[Field; MOVE_INPUTS]; 9],
    winner_id: Field,
    prize_move: Field,
) -> (Field, u32) {
    assert((winner_id == 1) | (winner_id == 2), "A draw has no prize");
    let m = prize_move as u32;
    assert(((m as Field) == prize_move) & (m < 9), "Prize move out of range");
    // The loser is player 2 when player 1 won: player 2's moves are odd.
    let loser_moves_on_odd = winner_id == 1;
    assert((m % 2 == 1) == loser_moves_on_odd, "The prize must be a card the loser placed");
    let card = move_inputs[m][6];
    let slot_field = move_inputs[m][7];
    let slot = slot_field as u32;
    assert(((slot as Field) == slot_field) & (slot < 5), "Prize slot out of range");
    assert(card != 0, "Prize card must be a real card");
    (card, slot)
}

/// Which prepared return notes a decisive game releases: all five of the
/// winner's, then the loser's four that were not the prize, in order. The last
/// entry is unused (the prize note is completed separately).
pub fn win_returns(winner_returns: [Field; 5], loser_returns: [Field; 5], prize_slot: u32) -> [Field; 10] {
    let mut out: [Field; 10] = [0; 10];
    for i in 0..5 {
        out[i] = winner_returns[i];
    }
    let mut next: u32 = 5;
    for i in 0..5 {
        if i != prize_slot {
            out[next] = loser_returns[i];
            next += 1;
        }
    }
    out
}

/// Both players' returns, for a draw or an unwound game.
pub fn all_returns(returns_1: [Field; 5], returns_2: [Field; 5]) -> [Field; 10] {
    let mut out: [Field; 10] = [0; 10];
    for i in 0..5 {
        out[i] = returns_1[i];
        out[5 + i] = returns_2[i];
    }
    out
}

/// A record's five prepared return notes.
pub fn returns_of(record: [Field; RECORD_LEN]) -> [Field; 5] {
    let mut out: [Field; 5] = [0; 5];
    for i in 0..5 {
        out[i] = record[RECORD_RETURNS + i];
    }
    out
}

/// The seat of player `side` (1 or 2).
pub fn seat_for(side: Field, record_1: [Field; RECORD_LEN], record_2: [Field; RECORD_LEN]) -> Field {
    if side == 1 {
        record_1[RECORD_SEAT]
    } else {
        record_2[RECORD_SEAT]
    }
}

pub fn assert_side(side: Field) {
    assert((side == 1) | (side == 2), "Side must be 1 or 2");
}

pub fn assert_claim_number(claim_no: Field) {
    let c = claim_no as u32;
    assert(((c as Field) == claim_no) & (c >= 1) & (c <= MAX_CLAIMS), "Claim number must be 1 to 3");
}

/// A claim is honest only once the game has had time to finish since its
/// clock started (the join, or the last contest). Without this a loser could
/// race a winner's settlement.
pub fn assert_abandon_bar_passed(now: u64, clock_start: u64) {
    assert(now >= clock_start + MIN_ABANDON_SECONDS, "Too soon to call this game abandoned");
}

/// A contest is inside the window if it is anchored before
/// `before_claim + DISPUTE_SECONDS`, where `before_claim` is the time of a
/// block in which the claim did NOT yet exist -- so no later than the claim.
pub fn assert_dispute_window_open(now: u64, before_claim: u64) {
    assert(now < before_claim + DISPUTE_SECONDS, "Dispute window has closed");
}

/// Finalizing waits the whole window out, measured from a block in which the
/// claim already existed -- so no earlier than the claim.
pub fn assert_dispute_window_elapsed(now: u64, claim_seen_at: u64) {
    assert(now >= claim_seen_at + DISPUTE_SECONDS, "Dispute window not elapsed");
}

#[aztec]
pub contract TripleTriadGame {
    use aztec::{
        context::{NullifierExistenceRequest, PrivateContext},
        history::nullifier::{assert_nullifier_did_not_exist_by, assert_nullifier_existed_by},
        keys::getters::get_public_keys,
        macros::{functions::{external, initializer, view}, storage::storage},
        protocol::{
            address::AztecAddress,
            hash::{compute_siloed_nullifier, poseidon2_hash_with_separator},
        },
        state_vars::PublicImmutable,
    };
    use bb_proof_verification::{UltraHonkVerificationKey, UltraHonkZKProof, verify_honk_proof};
    use triple_triad_nft::TripleTriadNFT;
    use arena_token::ArenaToken;
    use super::{
        all_returns, assert_abandon_bar_passed, assert_claim_number, assert_dispute_window_elapsed,
        assert_dispute_window_open, assert_side, assert_transcript, assert_vk_configuration,
        DOM_SEP__GAME_ID, DOM_SEP__N_CLAIM, DOM_SEP__N_CLAIM_SLOT, DOM_SEP__N_CONTEST,
        DOM_SEP__N_CONTESTED_BY, DOM_SEP__N_CREATED, DOM_SEP__N_DONE, DOM_SEP__N_JOINED,
        DOM_SEP__N_RESOLVED, DOM_SEP__N_SEAT2, DOM_SEP__PLAYER, DOM_SEP__RECORD, DOM_SEP__SEAT,
        GAME_NULLIFIER_COUNT, MAX_CLAIMS, MOVE_INPUTS, prize_of, RECORD_HAND, RECORD_LEN,
        RECORD_PRIZE, RECORD_REWARD, RECORD_SEAT, returns_of, REWARD_PER_GAME, seat_for,
        win_returns,
    };

    #[storage]
    struct Storage<Context> {
        admin: PublicImmutable<AztecAddress, Context>,
        nft_contract: PublicImmutable<AztecAddress, Context>,
        token_contract: PublicImmutable<AztecAddress, Context>,
        move_vk_hash: PublicImmutable<Field, Context>,
        dummy_vk_hash: PublicImmutable<Field, Context>,
        /// True when this deployment registered the dummy VK for real move
        /// proofs. Such a deployment has NO gameplay soundness; the flag
        /// exists so that fact is on-chain and readable.
        permissive_vks: PublicImmutable<bool, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(
        admin: AztecAddress,
        nft_address: AztecAddress,
        move_vk_hash: Field,
        token_address: AztecAddress,
        dummy_vk_hash: Field,
        permissive_vks: bool,
    ) {
        assert_vk_configuration(move_vk_hash, dummy_vk_hash, permissive_vks);
        self.storage.admin.initialize(admin);
        self.storage.nft_contract.initialize(nft_address);
        self.storage.token_contract.initialize(token_address);
        self.storage.move_vk_hash.initialize(move_vk_hash);
        self.storage.dummy_vk_hash.initialize(dummy_vk_hash);
        self.storage.permissive_vks.initialize(permissive_vks);
    }

    /// Whether this deployment accepts constraint-free dummy proofs as moves.
    #[external("public")]
    #[view]
    fn has_permissive_vks() -> bool {
        self.storage.permissive_vks.read()
    }

    // Updates are applied by FRESH REDEPLOY (new addresses), not the Aztec
    // contract-class upgrade pattern. See docs/plan/UPDATE_MODEL.md.

    // ======================= identity and game state =======================

    /// A player's secret for one game: their Game-siloed nullifier hiding key
    /// with the game's shared key. Only the player can compute it.
    #[contract_library_method]
    fn player_secret(context: &mut PrivateContext, owner: AztecAddress, game_key: Field) -> Field {
        let nhk_app = context.request_nhk_app(get_public_keys(owner).npk_m_hash);
        poseidon2_hash_with_separator([nhk_app, game_key], DOM_SEP__PLAYER)
    }

    /// A player's public seat in one game. Proving a seat means recomputing it,
    /// which needs the player's own key: that is how cancel, claim and contest
    /// know who is calling without any address being recorded. The same
    /// account recomputes the same seat, which is what blocks self-play.
    #[contract_library_method]
    fn seat_of(player_secret: Field) -> Field {
        poseidon2_hash_with_separator([player_secret], DOM_SEP__SEAT)
    }

    #[contract_library_method]
    fn caller_seat(context: &mut PrivateContext, caller: AztecAddress, game_key: Field) -> Field {
        seat_of(player_secret(context, caller, game_key))
    }

    #[contract_library_method]
    fn record_hash(record: [Field; RECORD_LEN]) -> Field {
        poseidon2_hash_with_separator(record, DOM_SEP__RECORD)
    }

    /// A game's id: secret, because `game_key` is. Every game nullifier hangs
    /// off it, so nobody without the key can tell a game's nullifiers apart
    /// from any others.
    #[contract_library_method]
    fn game_id_of(game_key: Field, record_1: [Field; RECORD_LEN]) -> Field {
        poseidon2_hash_with_separator([game_key, record_hash(record_1)], DOM_SEP__GAME_ID)
    }

    #[contract_library_method]
    fn assemble_record(seat: Field, prepared: [Field; 8]) -> [Field; RECORD_LEN] {
        let mut record: [Field; RECORD_LEN] = [0; RECORD_LEN];
        record[RECORD_SEAT] = seat;
        for i in 0..8 {
            record[1 + i] = prepared[i];
        }
        record
    }

    #[contract_library_method]
    fn n_created(game_id: Field) -> Field {
        poseidon2_hash_with_separator([game_id], DOM_SEP__N_CREATED)
    }

    /// Pushed by BOTH join and cancel: seat 2 closes exactly once.
    #[contract_library_method]
    fn n_seat2(game_id: Field) -> Field {
        poseidon2_hash_with_separator([game_id], DOM_SEP__N_SEAT2)
    }

    #[contract_library_method]
    fn n_joined(game_id: Field, record_2: [Field; RECORD_LEN]) -> Field {
        poseidon2_hash_with_separator([game_id, record_hash(record_2)], DOM_SEP__N_JOINED)
    }

    /// Pushed by settle, finalize and cancel: a game resolves exactly once.
    #[contract_library_method]
    fn n_done(game_id: Field) -> Field {
        poseidon2_hash_with_separator([game_id], DOM_SEP__N_DONE)
    }

    #[contract_library_method]
    fn n_claim_slot(game_id: Field, claim_no: Field) -> Field {
        poseidon2_hash_with_separator([game_id, claim_no], DOM_SEP__N_CLAIM_SLOT)
    }

    #[contract_library_method]
    fn n_claim(game_id: Field, claim_no: Field, side: Field) -> Field {
        poseidon2_hash_with_separator([game_id, claim_no, side], DOM_SEP__N_CLAIM)
    }

    #[contract_library_method]
    fn n_contested_by(game_id: Field, side: Field) -> Field {
        poseidon2_hash_with_separator([game_id, side], DOM_SEP__N_CONTESTED_BY)
    }

    #[contract_library_method]
    fn n_contest(game_id: Field, claim_no: Field) -> Field {
        poseidon2_hash_with_separator([game_id, claim_no], DOM_SEP__N_CONTEST)
    }

    /// Pushed by BOTH contest and finalize of one claim: only one of them lands.
    #[contract_library_method]
    fn n_resolved(game_id: Field, claim_no: Field) -> Field {
        poseidon2_hash_with_separator([game_id, claim_no], DOM_SEP__N_RESOLVED)
    }

    /// Fail unless `nullifier` (of this contract) is in a settled block.
    #[contract_library_method]
    fn assert_recorded(context: &mut PrivateContext, address: AztecAddress, nullifier: Field) {
        context.assert_nullifier_exists(
            NullifierExistenceRequest::for_settled(compute_siloed_nullifier(address, nullifier)),
        );
    }

    /// The game of two records, checked: `record_2` joined the game whose
    /// creator committed `record_1`. Joining verified `record_1` on-chain, so
    /// this one check authenticates both records. Returns the game id.
    #[contract_library_method]
    fn joined_game(
        context: &mut PrivateContext,
        address: AztecAddress,
        game_key: Field,
        record_1: [Field; RECORD_LEN],
        record_2: [Field; RECORD_LEN],
    ) -> Field {
        let game_id = game_id_of(game_key, record_1);
        assert_recorded(context, address, n_joined(game_id, record_2));
        game_id
    }

    // ============================ lifecycle ============================

    /// Create a game: commit five cards and record what they could pay back.
    /// Returns the creator's record, which the creator sends to the joiner.
    #[external("private")]
    fn create_game(game_key: Field, card_ids: [Field; 5]) -> [Field; RECORD_LEN] {
        let owner = self.msg_sender();
        let nft = self.storage.nft_contract.read();
        let prepared = TripleTriadNFT::at(nft).commit_hand(owner, card_ids, REWARD_PER_GAME).call(
            self.context,
        );
        let record = assemble_record(caller_seat(self.context, owner, game_key), prepared);
        self.context.push_nullifier_unsafe(n_created(game_id_of(game_key, record)));
        record
    }

    /// Join the game whose creator committed `record_1`. Only someone holding
    /// both `game_key` and the creator's record can. Returns the joiner's
    /// record.
    #[external("private")]
    fn join_game(
        game_key: Field,
        record_1: [Field; RECORD_LEN],
        card_ids: [Field; 5],
    ) -> [Field; RECORD_LEN] {
        let game_id = game_id_of(game_key, record_1);
        // Authenticates record_1: only a create_game with exactly this record
        // and key pushed this nullifier.
        assert_recorded(self.context, self.address, n_created(game_id));

        let owner = self.msg_sender();
        let nft = self.storage.nft_contract.read();
        let prepared = TripleTriadNFT::at(nft).commit_hand(owner, card_ids, REWARD_PER_GAME).call(
            self.context,
        );
        let seat = caller_seat(self.context, owner, game_key);
        assert(seat != record_1[RECORD_SEAT], "Cannot join your own game");
        let record_2 = assemble_record(seat, prepared);

        self.context.push_nullifier_unsafe(n_seat2(game_id));
        self.context.push_nullifier_unsafe(n_joined(game_id, record_2));
        record_2
    }

    /// Cancel a game nobody joined: the creator's own five prepared notes come
    /// back. Closing seat 2 makes cancel and join exclude each other.
    #[external("private")]
    fn cancel_game(game_key: Field, record_1: [Field; RECORD_LEN]) {
        let game_id = game_id_of(game_key, record_1);
        assert_recorded(self.context, self.address, n_created(game_id));
        let seat = caller_seat(self.context, self.msg_sender(), game_key);
        assert(seat == record_1[RECORD_SEAT], "Only the game creator can cancel");

        self.context.push_nullifier_unsafe(n_seat2(game_id));
        self.context.push_nullifier_unsafe(n_done(game_id));

        let mut hashes: [Field; 10] = [0; 10];
        let returns = returns_of(record_1);
        for i in 0..5 {
            hashes[i] = returns[i];
        }
        let nft = self.storage.nft_contract.read();
        TripleTriadNFT::at(nft).release_game_cards(hashes, 5, 0, 0).call(self.context);
    }

    /// Settle a finished game from its nine move proofs. Releases each
    /// player's prepared notes -- the winner's five plus the prize, the
    /// loser's four, both rewards; or both hands and both rewards on a draw.
    /// Anyone holding the records and the transcript may settle.
    #[external("private")]
    fn settle_game(
        game_key: Field,
        record_1: [Field; RECORD_LEN],
        record_2: [Field; RECORD_LEN],
        move_vk: UltraHonkVerificationKey,
        move_proof_1: UltraHonkZKProof,
        move_inputs_1: [Field; MOVE_INPUTS],
        move_proof_2: UltraHonkZKProof,
        move_inputs_2: [Field; MOVE_INPUTS],
        move_proof_3: UltraHonkZKProof,
        move_inputs_3: [Field; MOVE_INPUTS],
        move_proof_4: UltraHonkZKProof,
        move_inputs_4: [Field; MOVE_INPUTS],
        move_proof_5: UltraHonkZKProof,
        move_inputs_5: [Field; MOVE_INPUTS],
        move_proof_6: UltraHonkZKProof,
        move_inputs_6: [Field; MOVE_INPUTS],
        move_proof_7: UltraHonkZKProof,
        move_inputs_7: [Field; MOVE_INPUTS],
        move_proof_8: UltraHonkZKProof,
        move_inputs_8: [Field; MOVE_INPUTS],
        move_proof_9: UltraHonkZKProof,
        move_inputs_9: [Field; MOVE_INPUTS],
        prize_move: Field,
    ) {
        let game_id = joined_game(self.context, self.address, game_key, record_1, record_2);

        let vk_hash = self.storage.move_vk_hash.read();
        verify_honk_proof(move_vk, move_proof_1, move_inputs_1, vk_hash);
        verify_honk_proof(move_vk, move_proof_2, move_inputs_2, vk_hash);
        verify_honk_proof(move_vk, move_proof_3, move_inputs_3, vk_hash);
        verify_honk_proof(move_vk, move_proof_4, move_inputs_4, vk_hash);
        verify_honk_proof(move_vk, move_proof_5, move_inputs_5, vk_hash);
        verify_honk_proof(move_vk, move_proof_6, move_inputs_6, vk_hash);
        verify_honk_proof(move_vk, move_proof_7, move_inputs_7, vk_hash);
        verify_honk_proof(move_vk, move_proof_8, move_inputs_8, vk_hash);
        verify_honk_proof(move_vk, move_proof_9, move_inputs_9, vk_hash);

        let move_inputs: [[Field; MOVE_INPUTS]; 9] = [
            move_inputs_1, move_inputs_2, move_inputs_3, move_inputs_4, move_inputs_5,
            move_inputs_6, move_inputs_7, move_inputs_8, move_inputs_9,
        ];
        assert_transcript(move_inputs, record_1[RECORD_HAND], record_2[RECORD_HAND]);
        let winner_id = move_inputs[8][5];

        // A game resolves once: a second settlement, or a settlement after an
        // unwound abandonment, fails on this nullifier. A standing claim does
        // NOT block settlement -- a full transcript outranks it.
        self.context.push_nullifier_unsafe(n_done(game_id));

        let nft = self.storage.nft_contract.read();
        if winner_id == 3 {
            TripleTriadNFT::at(nft)
                .release_game_cards(all_returns(returns_of(record_1), returns_of(record_2)), 10, 0, 0)
                .call(self.context);
        } else {
            let (prize_card, prize_slot) = prize_of(move_inputs, winner_id, prize_move);
            let (winner, loser) = if winner_id == 1 {
                (record_1, record_2)
            } else {
                (record_2, record_1)
            };
            TripleTriadNFT::at(nft)
                .release_game_cards(
                    win_returns(returns_of(winner), returns_of(loser), prize_slot),
                    9,
                    winner[RECORD_PRIZE],
                    prize_card,
                )
                .call(self.context);
        }

        let token = self.storage.token_contract.read();
        ArenaToken::at(token)
            .release_reward_notes([record_1[RECORD_REWARD], record_2[RECORD_REWARD]])
            .call(self.context);
    }

    // =========================== abandonment ===========================

    /// Claim that the other player has abandoned the game. Needs no proofs:
    /// a finished game can still be settled during the dispute window (a full
    /// transcript outranks a claim) and an unfinished one can be contested.
    ///
    /// `clock_block` is a block in which the claim clock's nullifier already
    /// existed -- the join for the first claim, the previous contest after
    /// that -- and the claim is honest only MIN_ABANDON_SECONDS after it.
    #[external("private")]
    fn claim_abandoned_game(
        game_key: Field,
        record_1: [Field; RECORD_LEN],
        record_2: [Field; RECORD_LEN],
        side: Field,
        claim_no: Field,
        clock_block: u32,
    ) {
        assert_side(side);
        assert_claim_number(claim_no);
        let game_id = joined_game(self.context, self.address, game_key, record_1, record_2);
        let seat = caller_seat(self.context, self.msg_sender(), game_key);
        assert(seat == seat_for(side, record_1, record_2), "Claimant must be a player in this game");

        let clock_nullifier = if claim_no == 1 {
            n_joined(game_id, record_2)
        } else {
            n_contest(game_id, claim_no - 1)
        };
        let clock = self.context.get_block_header_at(clock_block);
        assert_nullifier_existed_by(clock, compute_siloed_nullifier(self.address, clock_nullifier));
        let anchor = self.context.get_anchor_block_header();
        assert_abandon_bar_passed(anchor.global_variables.timestamp, clock.global_variables.timestamp);
        assert_nullifier_did_not_exist_by(anchor, compute_siloed_nullifier(self.address, n_done(game_id)));

        self.context.push_nullifier_unsafe(n_claim_slot(game_id, claim_no));
        self.context.push_nullifier_unsafe(n_claim(game_id, claim_no, side));
    }

    /// Contest a standing claim: "I am still here". The game goes on and the
    /// abandonment clock restarts at this contest. Each side contests once.
    ///
    /// `before_claim_block` is a block in which the claim did NOT yet exist;
    /// the contest must be anchored within DISPUTE_SECONDS of it.
    #[external("private")]
    fn contest_abandonment(
        game_key: Field,
        record_1: [Field; RECORD_LEN],
        record_2: [Field; RECORD_LEN],
        side: Field,
        claim_no: Field,
        claim_side: Field,
        before_claim_block: u32,
    ) {
        assert_side(side);
        assert_side(claim_side);
        assert(side != claim_side, "A claimant cannot contest their own claim");
        assert_claim_number(claim_no);
        let game_id = joined_game(self.context, self.address, game_key, record_1, record_2);
        let seat = caller_seat(self.context, self.msg_sender(), game_key);
        assert(seat == seat_for(side, record_1, record_2), "Contester must be a player in this game");

        let claim = compute_siloed_nullifier(self.address, n_claim(game_id, claim_no, claim_side));
        self.context.assert_nullifier_exists(NullifierExistenceRequest::for_settled(claim));
        let before = self.context.get_block_header_at(before_claim_block);
        assert_nullifier_did_not_exist_by(before, claim);
        let anchor = self.context.get_anchor_block_header();
        assert_dispute_window_open(anchor.global_variables.timestamp, before.global_variables.timestamp);

        self.context.push_nullifier_unsafe(n_contested_by(game_id, side));
        self.context.push_nullifier_unsafe(n_resolved(game_id, claim_no));
        self.context.push_nullifier_unsafe(n_contest(game_id, claim_no));
    }

    /// Finalize an uncontested claim once its window has passed: both players
    /// get their own five cards back, and nobody wins anything. Anyone may
    /// finalize. `claim_block` is a block in which the claim already existed.
    #[external("private")]
    fn finalize_abandoned_game(
        game_key: Field,
        record_1: [Field; RECORD_LEN],
        record_2: [Field; RECORD_LEN],
        claim_no: Field,
        claim_side: Field,
        claim_block: u32,
    ) {
        assert_side(claim_side);
        assert_claim_number(claim_no);
        let game_id = joined_game(self.context, self.address, game_key, record_1, record_2);

        let claim = compute_siloed_nullifier(self.address, n_claim(game_id, claim_no, claim_side));
        let seen = self.context.get_block_header_at(claim_block);
        assert_nullifier_existed_by(seen, claim);
        let anchor = self.context.get_anchor_block_header();
        assert_dispute_window_elapsed(anchor.global_variables.timestamp, seen.global_variables.timestamp);

        self.context.push_nullifier_unsafe(n_resolved(game_id, claim_no));
        self.context.push_nullifier_unsafe(n_done(game_id));

        let nft = self.storage.nft_contract.read();
        TripleTriadNFT::at(nft)
            .release_game_cards(all_returns(returns_of(record_1), returns_of(record_2)), 10, 0, 0)
            .call(self.context);
    }

    // ======================== client utilities ========================

    /// The record `create_game` / `join_game` would commit for the caller at
    /// `nonce_value`. Simulate-only: the client needs its record before it
    /// sends (the creator sends it to the joiner).
    #[external("private")]
    #[view]
    fn preview_record(game_key: Field, card_ids: [Field; 5], nonce_value: Field) -> [Field; RECORD_LEN] {
        let owner = self.msg_sender();
        let nft = self.storage.nft_contract.read();
        let prepared = TripleTriadNFT::at(nft)
            .preview_commit(owner, card_ids, nonce_value, REWARD_PER_GAME)
            .view(self.context);
        assemble_record(caller_seat(self.context, owner, game_key), prepared)
    }

    /// The siloed nullifiers of one game, for a client to look up on a node:
    /// `[created, seat2, joined, done, claim_slot(1..3), claim(1,1), claim(1,2),
    /// claim(2,1), claim(2,2), claim(3,1), claim(3,2), contested_by(1),
    /// contested_by(2), contest(1..3), resolved(1..3)]`. Pass a zero
    /// `record_2` before anyone has joined (`joined` is then meaningless).
    #[external("utility")]
    unconstrained fn game_nullifiers(
        game_key: Field,
        record_1: [Field; RECORD_LEN],
        record_2: [Field; RECORD_LEN],
    ) -> [Field; GAME_NULLIFIER_COUNT] {
        let address = aztec::context::UtilityContext::new().this_address();
        let game_id = game_id_of(game_key, record_1);
        let mut inner: [Field; GAME_NULLIFIER_COUNT] = [0; GAME_NULLIFIER_COUNT];
        inner[0] = n_created(game_id);
        inner[1] = n_seat2(game_id);
        inner[2] = n_joined(game_id, record_2);
        inner[3] = n_done(game_id);
        for c in 1..(MAX_CLAIMS + 1) {
            let claim_no = c as Field;
            inner[3 + c] = n_claim_slot(game_id, claim_no);
            inner[7 + (c - 1) * 2] = n_claim(game_id, claim_no, 1);
            inner[8 + (c - 1) * 2] = n_claim(game_id, claim_no, 2);
            inner[14 + c] = n_contest(game_id, claim_no);
            inner[17 + c] = n_resolved(game_id, claim_no);
        }
        inner[13] = n_contested_by(game_id, 1);
        inner[14] = n_contested_by(game_id, 2);
        let mut siloed: [Field; GAME_NULLIFIER_COUNT] = [0; GAME_NULLIFIER_COUNT];
        for i in 0..GAME_NULLIFIER_COUNT {
            siloed[i] = compute_siloed_nullifier(address, inner[i]);
        }
        siloed
    }
}

mod test;
