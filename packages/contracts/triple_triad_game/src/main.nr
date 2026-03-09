use aztec::macros::aztec;

/// Triple Triad Game contract.
/// Manages on-chain game lifecycle: creation, joining, proof verification, and settlement.
///
/// Game Lifecycle:
/// 1. Player 1 calls create_game(card_ids) -- game_id + randomness derived in NFT contract
/// 2. Player 2 calls join_game(game_id, card_ids) -- randomness derived in NFT contract
/// 3. Game plays out off-chain with ZK proofs exchanged via WebSocket
/// 4. Winner calls process_game with all 11 proofs (2 hand + 9 move) -- verifies and settles
///
/// Card commitment: poseidon2_hash([card_ids[0..5], blinding_factor])
/// where blinding_factor = poseidon2_hash([nhk_app_secret, contract_address, game_id])
///
/// Player state hash: poseidon2_hash([randomness[0..6]])
/// Constrains the randomness used for note re-creation during settlement.
///
/// Game ID: derived deterministically in NFT contract from nhk_app_secret + nonce_value.
/// Must be unique (checked against existing game status).
#[aztec]
pub contract TripleTriadGame {
    use aztec::{
        macros::{
            events::event,
            functions::{external, initializer, only_self, view},
            storage::storage,
        },
        protocol::{
            address::AztecAddress,
            hash::poseidon2_hash,
        },
        state_vars::{Map, PublicImmutable, PublicMutable},
    };
    use bb_proof_verification::{UltraHonkVerificationKey, UltraHonkZKProof, verify_honk_proof};
    use triple_triad_nft::TripleTriadNFT;

    // --- Events ---

    #[event]
    struct GameCreated {
        game_id: Field,
        player1: AztecAddress,
        card_commit_hash: Field,
    }

    #[event]
    struct GameJoined {
        game_id: Field,
        player2: AztecAddress,
        card_commit_hash: Field,
    }

    #[event]
    struct GameSettled {
        game_id: Field,
        winner: AztecAddress,
        loser: AztecAddress,
        transferred_card_id: Field,
    }

    #[event]
    struct GameCancelled {
        game_id: Field,
    }

    // --- Storage ---
    // Game status values: 0=none, 1=created, 2=active, 3=settled, 4=cancelled

    #[storage]
    struct Storage<Context> {
        nft_contract: PublicImmutable<AztecAddress, Context>,
        hand_vk_hash: PublicImmutable<Field, Context>,
        move_vk_hash: PublicImmutable<Field, Context>,
        game_settled: Map<Field, PublicMutable<bool, Context>, Context>,
        game_status: Map<Field, PublicMutable<Field, Context>, Context>,
        game_player1: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        game_player2: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        game_card_commit_1: Map<Field, PublicMutable<Field, Context>, Context>,
        game_card_commit_2: Map<Field, PublicMutable<Field, Context>, Context>,
        game_player_state_1: Map<Field, PublicMutable<Field, Context>, Context>,
        game_player_state_2: Map<Field, PublicMutable<Field, Context>, Context>,
    }

    // --- Constructor ---

    #[external("public")]
    #[initializer]
    fn constructor(
        nft_address: AztecAddress,
        hand_vk_hash: Field,
        move_vk_hash: Field,
    ) {
        self.storage.nft_contract.initialize(nft_address);
        self.storage.hand_vk_hash.initialize(hand_vk_hash);
        self.storage.move_vk_hash.initialize(move_vk_hash);
    }

    // --- Create Game ---

    /// Player 1 creates a new game by committing 5 cards via NFT.commit_five_nfts_create.
    /// game_id and randomness are derived IN-CIRCUIT by the NFT contract.
    /// No caller-provided game_id or randomness -- everything is deterministic from nhk_app.
    #[external("private")]
    fn create_game(card_ids: [Field; 5]) {
        let player = self.msg_sender();
        let nft_address = self.storage.nft_contract.read();
        let commit_result = TripleTriadNFT::at(nft_address)
            .commit_five_nfts_create(player, card_ids)
            .call(self.context);

        let card_commit_hash = commit_result[0];
        let player_state_hash = commit_result[1];
        let game_id = commit_result[2];

        self.enqueue_self.create_game_public(game_id, player, card_commit_hash, player_state_hash);
    }

    #[external("public")]
    #[only_self]
    fn create_game_public(game_id: Field, player1: AztecAddress, card_commit_hash: Field, player_state_hash: Field) {
        // Ensure game_id doesn't already exist (status must be 0 = none)
        let status = self.storage.game_status.at(game_id).read();
        assert(status == 0, "Game ID already exists");

        self.storage.game_status.at(game_id).write(1); // created
        self.storage.game_player1.at(game_id).write(player1);
        self.storage.game_card_commit_1.at(game_id).write(card_commit_hash);
        self.storage.game_player_state_1.at(game_id).write(player_state_hash);

        self.emit(GameCreated { game_id, player1, card_commit_hash });
    }

    // --- Join Game ---

    /// Player 2 joins an existing game by committing 5 cards via NFT.commit_five_nfts_join.
    /// Randomness is derived IN-CIRCUIT by the NFT contract. Only game_id is provided.
    #[external("private")]
    fn join_game(game_id: Field, card_ids: [Field; 5]) {
        let player = self.msg_sender();
        let nft_address = self.storage.nft_contract.read();
        let commit_result = TripleTriadNFT::at(nft_address)
            .commit_five_nfts_join(player, card_ids, game_id)
            .call(self.context);

        let card_commit_hash = commit_result[0];
        let player_state_hash = commit_result[1];

        self.enqueue_self.join_game_public(game_id, player, card_commit_hash, player_state_hash);
    }

    #[external("public")]
    #[only_self]
    fn join_game_public(game_id: Field, player2: AztecAddress, card_commit_hash: Field, player_state_hash: Field) {
        let status = self.storage.game_status.at(game_id).read();
        assert(status == 1, "Game not in created state");

        let player1 = self.storage.game_player1.at(game_id).read();
        assert(player2 != player1, "Cannot join your own game");

        self.storage.game_player2.at(game_id).write(player2);
        self.storage.game_card_commit_2.at(game_id).write(card_commit_hash);
        self.storage.game_player_state_2.at(game_id).write(player_state_hash);
        self.storage.game_status.at(game_id).write(2); // active

        self.emit(GameJoined { game_id, player2, card_commit_hash });
    }

    // --- Cancel Game ---

    /// Cancel a game that has not been joined yet. Only the creator can cancel.
    /// Re-mints the creator's cards via NFT.mint_for_game_draw.
    #[external("private")]
    fn cancel_game(game_id: Field, card_ids: [Field; 5]) {
        let player = self.msg_sender();
        let nft_address = self.storage.nft_contract.read();

        // Re-mint cards back to the creator
        TripleTriadNFT::at(nft_address)
            .mint_for_game_draw(card_ids, player)
            .call(self.context);

        self.enqueue_self.cancel_game_public(game_id, player);
    }

    #[external("public")]
    #[only_self]
    fn cancel_game_public(game_id: Field, player: AztecAddress) {
        let status = self.storage.game_status.at(game_id).read();
        assert(status == 1, "Can only cancel games in created state");

        let player1 = self.storage.game_player1.at(game_id).read();
        assert(player == player1, "Only game creator can cancel");

        self.storage.game_status.at(game_id).write(4); // cancelled

        self.emit(GameCancelled { game_id });
    }

    // --- Process Game ---

    /// Process a completed game by verifying all 11 proofs directly:
    /// 2 hand proofs (prove each player's card commitment + opponent's player_state_hash) +
    /// 9 move proofs (prove each game move is valid).
    ///
    /// Validates:
    /// - All proofs are valid against stored VK hashes
    /// - Card commits from hand proofs match all move proofs
    /// - Move proofs chain correctly (end_state[i] == start_state[i+1])
    /// - First move starts from canonical empty board
    /// - Intermediate moves have game_ended=0
    /// - Final move has game_ended=1 with valid winner_id
    /// - Randomness hashes match stored player_state_hash values
    ///
    /// Then re-mints cards to winner and loser (or both on draw).
    #[external("private")]
    fn process_game(
        game_id: Field,
        // Verification keys (supplied by caller, validated against stored hashes)
        hand_vk: UltraHonkVerificationKey,
        move_vk: UltraHonkVerificationKey,
        // Hand proofs (2): each has 2 public inputs [card_commit_hash, opponent_player_state_hash]
        hand_proof_1: UltraHonkZKProof,
        hand_proof_1_inputs: [Field; 2],
        hand_proof_2: UltraHonkZKProof,
        hand_proof_2_inputs: [Field; 2],
        // Move proofs (9): each has 6 public inputs
        // [card_commit_1, card_commit_2, start_state, end_state, game_ended, winner_id]
        move_proof_1: UltraHonkZKProof,
        move_inputs_1: [Field; 6],
        move_proof_2: UltraHonkZKProof,
        move_inputs_2: [Field; 6],
        move_proof_3: UltraHonkZKProof,
        move_inputs_3: [Field; 6],
        move_proof_4: UltraHonkZKProof,
        move_inputs_4: [Field; 6],
        move_proof_5: UltraHonkZKProof,
        move_inputs_5: [Field; 6],
        move_proof_6: UltraHonkZKProof,
        move_inputs_6: [Field; 6],
        move_proof_7: UltraHonkZKProof,
        move_inputs_7: [Field; 6],
        move_proof_8: UltraHonkZKProof,
        move_inputs_8: [Field; 6],
        move_proof_9: UltraHonkZKProof,
        move_inputs_9: [Field; 6],
        // Settlement data
        opponent: AztecAddress,
        card_to_transfer: Field,
        caller_card_ids: [Field; 5],
        opponent_card_ids: [Field; 5],
        // Randomness for note creation (no tagging)
        // These are constrained via player_state_hash stored on-chain
        caller_randomness: [Field; 6],    // 6 for winner, first 5 for draw
        opponent_randomness: [Field; 6],   // 6 values (committed via player_state_hash)
    ) {
        // Read stored VK hashes
        let stored_hand_vk_hash = self.storage.hand_vk_hash.read();
        let stored_move_vk_hash = self.storage.move_vk_hash.read();

        // ===== 1. Verify all 11 proofs =====
        verify_honk_proof(hand_vk, hand_proof_1, hand_proof_1_inputs, stored_hand_vk_hash);
        verify_honk_proof(hand_vk, hand_proof_2, hand_proof_2_inputs, stored_hand_vk_hash);

        verify_honk_proof(move_vk, move_proof_1, move_inputs_1, stored_move_vk_hash);
        verify_honk_proof(move_vk, move_proof_2, move_inputs_2, stored_move_vk_hash);
        verify_honk_proof(move_vk, move_proof_3, move_inputs_3, stored_move_vk_hash);
        verify_honk_proof(move_vk, move_proof_4, move_inputs_4, stored_move_vk_hash);
        verify_honk_proof(move_vk, move_proof_5, move_inputs_5, stored_move_vk_hash);
        verify_honk_proof(move_vk, move_proof_6, move_inputs_6, stored_move_vk_hash);
        verify_honk_proof(move_vk, move_proof_7, move_inputs_7, stored_move_vk_hash);
        verify_honk_proof(move_vk, move_proof_8, move_inputs_8, stored_move_vk_hash);
        verify_honk_proof(move_vk, move_proof_9, move_inputs_9, stored_move_vk_hash);

        // ===== 2. Extract card commits and player_state_hashes from hand proofs =====
        let card_commit_1 = hand_proof_1_inputs[0];
        let card_commit_2 = hand_proof_2_inputs[0];
        // hand_proof_1 proves player1's hand + player2's player_state_hash
        // hand_proof_2 proves player2's hand + player1's player_state_hash
        let opponent_state_from_p1_proof = hand_proof_1_inputs[1]; // p2's state hash
        let opponent_state_from_p2_proof = hand_proof_2_inputs[1]; // p1's state hash

        // ===== 3. Collect move inputs for validation =====
        let move_inputs: [[Field; 6]; 9] = [
            move_inputs_1, move_inputs_2, move_inputs_3,
            move_inputs_4, move_inputs_5, move_inputs_6,
            move_inputs_7, move_inputs_8, move_inputs_9,
        ];

        // ===== 4. Validate card_commit consistency across all move proofs =====
        for i in 0..9 {
            assert(move_inputs[i][0] == card_commit_1, "Move proof card_commit_1 mismatch");
            assert(move_inputs[i][1] == card_commit_2, "Move proof card_commit_2 mismatch");
        }

        // ===== 5. Validate proof chaining =====
        for i in 0..8 {
            assert(
                move_inputs[i][3] == move_inputs[i + 1][2],
                "Proof chaining failed: end_state != next start_state",
            );
        }

        // ===== 6. Validate initial state (canonical empty board) =====
        // Inline compute_initial_state_hash:
        // pedersen_hash([board[18]=0s, scores=[5,5], current_turn=1])
        let mut initial_inputs: [Field; 21] = [0; 21];
        initial_inputs[18] = 5;
        initial_inputs[19] = 5;
        initial_inputs[20] = 1;
        let canonical_initial = std::hash::pedersen_hash(initial_inputs);
        assert(
            move_inputs[0][2] == canonical_initial,
            "First move start_state does not match initial state",
        );

        // ===== 7. Validate intermediate moves have game_ended=0 =====
        for i in 0..8 {
            assert(move_inputs[i][4] == 0, "Intermediate move should not end the game");
            assert(move_inputs[i][5] == 0, "Intermediate move should not have a winner");
        }

        // ===== 8. Validate game completion =====
        let game_ended = move_inputs[8][4];
        let winner_id = move_inputs[8][5];
        assert(game_ended == 1, "Game must have ended");
        assert(
            (winner_id == 1) | (winner_id == 2) | (winner_id == 3),
            "Invalid winner_id",
        );

        // ===== 9. Validate randomness against stored player_state_hash =====
        // Verify that the randomness provided matches what was committed during game creation/join.
        // caller_randomness is verified against the caller's player_state_hash
        // opponent_randomness is verified against the opponent's player_state_hash
        let caller_state_hash = poseidon2_hash(caller_randomness);
        let opponent_state_hash = poseidon2_hash(opponent_randomness);

        // ===== 10. Settlement =====
        let caller = self.msg_sender();
        let nft_address = self.storage.nft_contract.read();

        if (winner_id == 1) | (winner_id == 2) {
            // Winner/loser game
            assert(card_to_transfer != 0, "card_to_transfer must be nonzero for non-draw");

            let mut card_found = false;
            for i in 0..5 {
                if opponent_card_ids[i] == card_to_transfer {
                    card_found = true;
                }
            }
            assert(card_found, "card_to_transfer not in opponent's cards");

            // Winner gets their 5 cards + 1 transferred card
            let mut winner_tokens: [Field; 6] = [0; 6];
            for i in 0..5 {
                winner_tokens[i] = caller_card_ids[i];
            }
            winner_tokens[5] = card_to_transfer;

            TripleTriadNFT::at(nft_address)
                .mint_for_game_winner(winner_tokens, caller, caller_randomness)
                .call(self.context);

            // Loser gets their 5 cards minus ONE copy of the transferred card.
            // Only skip the first match (the loser may hold duplicate card IDs).
            let mut loser_tokens: [Field; 4] = [0; 4];
            let mut loser_rand: [Field; 4] = [0; 4];
            let mut idx: u32 = 0;
            let mut removed = false;
            for i in 0..5 {
                if (opponent_card_ids[i] == card_to_transfer) & (!removed) {
                    removed = true;
                } else {
                    loser_tokens[idx] = opponent_card_ids[i];
                    loser_rand[idx] = opponent_randomness[i];
                    idx += 1;
                }
            }

            TripleTriadNFT::at(nft_address)
                .mint_for_game_loser(loser_tokens, opponent, loser_rand)
                .call(self.context);

            self.enqueue_self.settle_game(
                game_id, caller, opponent, card_to_transfer,
                card_commit_1, card_commit_2, winner_id,
                caller_state_hash, opponent_state_hash,
                opponent_state_from_p1_proof, opponent_state_from_p2_proof,
            );
        } else {
            // Draw -- use offchain mint (no tagging)
            let mut caller_rand_5: [Field; 5] = [0; 5];
            for i in 0..5 { caller_rand_5[i] = caller_randomness[i]; }

            let mut opponent_rand_5: [Field; 5] = [0; 5];
            for i in 0..5 { opponent_rand_5[i] = opponent_randomness[i]; }

            TripleTriadNFT::at(nft_address)
                .mint_for_game_draw_offchain(caller_card_ids, caller, caller_rand_5)
                .call(self.context);

            TripleTriadNFT::at(nft_address)
                .mint_for_game_draw_offchain(opponent_card_ids, opponent, opponent_rand_5)
                .call(self.context);

            self.enqueue_self.settle_game_draw(
                game_id, card_commit_1, card_commit_2,
                caller_state_hash, opponent_state_hash,
                opponent_state_from_p1_proof, opponent_state_from_p2_proof,
            );
        }
    }

    // --- Public Settlement ---

    #[external("public")]
    #[only_self]
    fn settle_game(
        game_id: Field,
        winner: AztecAddress,
        loser: AztecAddress,
        card_to_transfer: Field,
        proof_card_commit_1: Field,
        proof_card_commit_2: Field,
        winner_id: Field,
        caller_state_hash: Field,
        opponent_state_hash: Field,
        opponent_state_from_p1_proof: Field,
        opponent_state_from_p2_proof: Field,
    ) {
        let settled = self.storage.game_settled.at(game_id).read();
        assert(!settled, "Game already settled");

        // Verify card_commits match on-chain records
        let stored_cc1 = self.storage.game_card_commit_1.at(game_id).read();
        let stored_cc2 = self.storage.game_card_commit_2.at(game_id).read();
        assert(stored_cc1 != 0, "Game card_commit_1 not set");
        assert(stored_cc2 != 0, "Game card_commit_2 not set");
        assert(proof_card_commit_1 == stored_cc1, "card_commit_1 mismatch");
        assert(proof_card_commit_2 == stored_cc2, "card_commit_2 mismatch");

        // Verify player_state_hash values match on-chain records
        let stored_ps1 = self.storage.game_player_state_1.at(game_id).read();
        let stored_ps2 = self.storage.game_player_state_2.at(game_id).read();

        // Verify winner/loser match stored player addresses
        let player1 = self.storage.game_player1.at(game_id).read();
        let player2 = self.storage.game_player2.at(game_id).read();

        if winner_id == 1 {
            assert(winner == player1, "Winner must be player 1");
            assert(loser == player2, "Loser must be player 2");
            // caller is winner (player1), opponent is loser (player2)
            assert(caller_state_hash == stored_ps1, "Caller player_state_hash mismatch");
            assert(opponent_state_hash == stored_ps2, "Opponent player_state_hash mismatch");
        } else {
            assert(winner_id == 2, "Invalid winner ID for non-draw");
            assert(winner == player2, "Winner must be player 2");
            assert(loser == player1, "Loser must be player 1");
            // caller is winner (player2), opponent is loser (player1)
            assert(caller_state_hash == stored_ps2, "Caller player_state_hash mismatch");
            assert(opponent_state_hash == stored_ps1, "Opponent player_state_hash mismatch");
        }

        // Verify hand proofs contained correct opponent player_state_hashes
        // hand_proof_1 (player1) proves knowledge of player2's state hash
        // hand_proof_2 (player2) proves knowledge of player1's state hash
        assert(opponent_state_from_p1_proof == stored_ps2, "Hand proof 1 opponent_state_hash mismatch");
        assert(opponent_state_from_p2_proof == stored_ps1, "Hand proof 2 opponent_state_hash mismatch");

        self.storage.game_settled.at(game_id).write(true);
        self.storage.game_status.at(game_id).write(3); // settled

        self.emit(GameSettled {
            game_id,
            winner,
            loser,
            transferred_card_id: card_to_transfer,
        });
    }

    #[external("public")]
    #[only_self]
    fn settle_game_draw(
        game_id: Field,
        proof_card_commit_1: Field,
        proof_card_commit_2: Field,
        caller_state_hash: Field,
        opponent_state_hash: Field,
        opponent_state_from_p1_proof: Field,
        opponent_state_from_p2_proof: Field,
    ) {
        let settled = self.storage.game_settled.at(game_id).read();
        assert(!settled, "Game already settled");

        let stored_cc1 = self.storage.game_card_commit_1.at(game_id).read();
        let stored_cc2 = self.storage.game_card_commit_2.at(game_id).read();
        assert(stored_cc1 != 0, "Game card_commit_1 not set");
        assert(stored_cc2 != 0, "Game card_commit_2 not set");
        assert(proof_card_commit_1 == stored_cc1, "card_commit_1 mismatch");
        assert(proof_card_commit_2 == stored_cc2, "card_commit_2 mismatch");

        // Verify player_state_hash values match on-chain records
        let stored_ps1 = self.storage.game_player_state_1.at(game_id).read();
        let stored_ps2 = self.storage.game_player_state_2.at(game_id).read();
        // For draws, caller could be either player. Verify both state hashes match
        // (one must be stored_ps1 and the other stored_ps2)
        assert(
            ((caller_state_hash == stored_ps1) & (opponent_state_hash == stored_ps2))
            | ((caller_state_hash == stored_ps2) & (opponent_state_hash == stored_ps1)),
            "Player state hash mismatch in draw",
        );

        // Verify hand proofs contained correct opponent player_state_hashes
        assert(opponent_state_from_p1_proof == stored_ps2, "Hand proof 1 opponent_state_hash mismatch");
        assert(opponent_state_from_p2_proof == stored_ps1, "Hand proof 2 opponent_state_hash mismatch");

        self.storage.game_settled.at(game_id).write(true);
        self.storage.game_status.at(game_id).write(3); // settled

        self.emit(GameSettled {
            game_id,
            winner: AztecAddress::zero(),
            loser: AztecAddress::zero(),
            transferred_card_id: 0,
        });
    }

    // --- View Functions ---

    #[external("public")]
    #[view]
    fn is_game_settled(game_id: Field) -> bool {
        self.storage.game_settled.at(game_id).read()
    }

    #[external("public")]
    #[view]
    fn get_game_status(game_id: Field) -> Field {
        self.storage.game_status.at(game_id).read()
    }

    #[external("public")]
    #[view]
    fn get_game_player1(game_id: Field) -> AztecAddress {
        self.storage.game_player1.at(game_id).read()
    }

    #[external("public")]
    #[view]
    fn get_game_player2(game_id: Field) -> AztecAddress {
        self.storage.game_player2.at(game_id).read()
    }

    #[external("public")]
    #[view]
    fn get_game_card_commit_1(game_id: Field) -> Field {
        self.storage.game_card_commit_1.at(game_id).read()
    }

    #[external("public")]
    #[view]
    fn get_game_card_commit_2(game_id: Field) -> Field {
        self.storage.game_card_commit_2.at(game_id).read()
    }

    #[external("public")]
    #[view]
    fn get_game_player_state_1(game_id: Field) -> Field {
        self.storage.game_player_state_1.at(game_id).read()
    }

    #[external("public")]
    #[view]
    fn get_game_player_state_2(game_id: Field) -> Field {
        self.storage.game_player_state_2.at(game_id).read()
    }
}
