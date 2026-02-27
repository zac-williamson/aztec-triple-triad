use aztec::macros::aztec;

/// Triple Triad Game contract.
/// Manages on-chain game lifecycle: creation, joining, proof verification, and settlement.
///
/// Game Lifecycle (new flow using commit_five_nfts):
/// 1. Player 1 calls create_game(card_ids) - commits cards via NFT.commit_five_nfts
/// 2. Player 2 calls join_game(game_id, card_ids) - commits cards via NFT.commit_five_nfts
/// 3. Game plays out off-chain with ZK proofs exchanged via WebSocket
/// 4. Winner calls process_game with aggregate proof - re-mints cards to both players
///
/// Card commitment: poseidon2_hash([card_ids[0..5], blinding_factor])
/// where blinding_factor = poseidon2_hash([nhk_app_secret, contract_address])
#[aztec]
pub contract TripleTriadGame {
    use aztec::{
        macros::{
            events::event,
            functions::{external, initializer, only_self, view},
            storage::storage,
        },
        protocol::address::AztecAddress,
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
        aggregate_vk_hash: PublicImmutable<Field, Context>,
        game_settled: Map<Field, PublicMutable<bool, Context>, Context>,
        game_id_counter: PublicMutable<Field, Context>,
        game_status: Map<Field, PublicMutable<Field, Context>, Context>,
        game_player1: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        game_player2: Map<Field, PublicMutable<AztecAddress, Context>, Context>,
        game_card_commit_1: Map<Field, PublicMutable<Field, Context>, Context>,
        game_card_commit_2: Map<Field, PublicMutable<Field, Context>, Context>,
    }

    // --- Constructor ---

    #[external("public")]
    #[initializer]
    fn constructor(
        nft_address: AztecAddress,
        hand_vk_hash: Field,
        move_vk_hash: Field,
        aggregate_vk_hash: Field,
    ) {
        self.storage.nft_contract.initialize(nft_address);
        self.storage.hand_vk_hash.initialize(hand_vk_hash);
        self.storage.move_vk_hash.initialize(move_vk_hash);
        self.storage.aggregate_vk_hash.initialize(aggregate_vk_hash);
    }

    // --- Create Game ---

    /// Player 1 creates a new game by committing 5 cards via NFT.commit_five_nfts.
    /// Cards are nullified (popped from private set) and a poseidon2 commitment is stored.
    #[external("private")]
    fn create_game(card_ids: [Field; 5]) {
        let player = self.msg_sender();
        let nft_address = self.storage.nft_contract.read();
        let card_commit_hash = TripleTriadNFT::at(nft_address)
            .commit_five_nfts(card_ids)
            .call(self.context);

        self.enqueue_self.create_game_public(player, card_commit_hash);
    }

    #[external("public")]
    #[only_self]
    fn create_game_public(player1: AztecAddress, card_commit_hash: Field) {
        let game_id = self.storage.game_id_counter.read();
        self.storage.game_id_counter.write(game_id + 1);

        self.storage.game_status.at(game_id).write(1); // created
        self.storage.game_player1.at(game_id).write(player1);
        self.storage.game_card_commit_1.at(game_id).write(card_commit_hash);

        self.emit(GameCreated { game_id, player1, card_commit_hash });
    }

    // --- Join Game ---

    /// Player 2 joins an existing game by committing 5 cards via NFT.commit_five_nfts.
    #[external("private")]
    fn join_game(game_id: Field, card_ids: [Field; 5]) {
        let player = self.msg_sender();
        let nft_address = self.storage.nft_contract.read();
        let card_commit_hash = TripleTriadNFT::at(nft_address)
            .commit_five_nfts(card_ids)
            .call(self.context);

        self.enqueue_self.join_game_public(game_id, player, card_commit_hash);
    }

    #[external("public")]
    #[only_self]
    fn join_game_public(game_id: Field, player2: AztecAddress, card_commit_hash: Field) {
        let status = self.storage.game_status.at(game_id).read();
        assert(status == 1, "Game not in created state");

        let player1 = self.storage.game_player1.at(game_id).read();
        assert(player2 != player1, "Cannot join your own game");

        self.storage.game_player2.at(game_id).write(player2);
        self.storage.game_card_commit_2.at(game_id).write(card_commit_hash);
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

    /// Process a completed game using an aggregated proof.
    /// Verifies the proof, then re-mints cards to winner and loser (or both on draw).
    ///
    /// Aggregate proof public inputs (8 fields):
    ///   [0] card_commit_1
    ///   [1] card_commit_2
    ///   [2] initial_state_hash
    ///   [3] final_state_hash
    ///   [4] game_ended (must be 1)
    ///   [5] winner_id (1, 2, or 3=draw)
    ///   [6] hand_vk_hash
    ///   [7] move_vk_hash
    ///
    /// NOTE: Card IDs passed for re-minting are not verified against the commitment
    /// (the blinding factor is private). Both players must provide honest card IDs.
    /// The aggregate proof guarantees card_commits are valid; dishonest card IDs
    /// only harm the dishonest party (their real cards are already nullified).
    #[external("private")]
    fn process_game(
        game_id: Field,
        aggregate_vk: UltraHonkVerificationKey,
        aggregate_proof: UltraHonkZKProof,
        aggregate_inputs: [Field; 8],
        opponent: AztecAddress,
        card_to_transfer: Field,
        caller_card_ids: [Field; 5],
        opponent_card_ids: [Field; 5],
    ) {
        // Verify aggregate proof
        let stored_aggregate_vk_hash = self.storage.aggregate_vk_hash.read();
        let stored_hand_vk_hash = self.storage.hand_vk_hash.read();
        let stored_move_vk_hash = self.storage.move_vk_hash.read();

        verify_honk_proof(
            aggregate_vk,
            aggregate_proof,
            aggregate_inputs,
            stored_aggregate_vk_hash,
        );

        // Extract proof public inputs
        let proof_card_commit_1 = aggregate_inputs[0];
        let proof_card_commit_2 = aggregate_inputs[1];
        let game_ended = aggregate_inputs[4];
        let winner_id = aggregate_inputs[5];
        let proof_hand_vk_hash = aggregate_inputs[6];
        let proof_move_vk_hash = aggregate_inputs[7];

        // Verify VK hashes match stored values
        assert(proof_hand_vk_hash == stored_hand_vk_hash, "Hand VK hash mismatch");
        assert(proof_move_vk_hash == stored_move_vk_hash, "Move VK hash mismatch");
        assert(game_ended == 1, "Game not ended");

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
                .mint_for_game_winner(winner_tokens, caller)
                .call(self.context);

            // Loser gets their 5 cards minus the transferred one
            let mut loser_tokens: [Field; 4] = [0; 4];
            let mut idx: u32 = 0;
            for i in 0..5 {
                if opponent_card_ids[i] != card_to_transfer {
                    loser_tokens[idx] = opponent_card_ids[i];
                    idx += 1;
                }
            }

            TripleTriadNFT::at(nft_address)
                .mint_for_game_loser(loser_tokens, opponent)
                .call(self.context);

            self.enqueue_self.settle_game(
                game_id, caller, opponent, card_to_transfer,
                proof_card_commit_1, proof_card_commit_2, winner_id,
            );
        } else {
            // Draw
            assert(winner_id == 3, "Invalid winner ID");

            // Both players get their cards back
            TripleTriadNFT::at(nft_address)
                .mint_for_game_draw(caller_card_ids, caller)
                .call(self.context);

            TripleTriadNFT::at(nft_address)
                .mint_for_game_draw(opponent_card_ids, opponent)
                .call(self.context);

            self.enqueue_self.settle_game_draw(
                game_id, proof_card_commit_1, proof_card_commit_2,
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

        // Verify winner/loser match stored player addresses
        let player1 = self.storage.game_player1.at(game_id).read();
        let player2 = self.storage.game_player2.at(game_id).read();

        if winner_id == 1 {
            assert(winner == player1, "Winner must be player 1");
            assert(loser == player2, "Loser must be player 2");
        } else {
            assert(winner_id == 2, "Invalid winner ID for non-draw");
            assert(winner == player2, "Winner must be player 2");
            assert(loser == player1, "Loser must be player 1");
        }

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
    ) {
        let settled = self.storage.game_settled.at(game_id).read();
        assert(!settled, "Game already settled");

        let stored_cc1 = self.storage.game_card_commit_1.at(game_id).read();
        let stored_cc2 = self.storage.game_card_commit_2.at(game_id).read();
        assert(stored_cc1 != 0, "Game card_commit_1 not set");
        assert(stored_cc2 != 0, "Game card_commit_2 not set");
        assert(proof_card_commit_1 == stored_cc1, "card_commit_1 mismatch");
        assert(proof_card_commit_2 == stored_cc2, "card_commit_2 mismatch");

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
    fn get_game_id_counter() -> Field {
        self.storage.game_id_counter.read()
    }
}
