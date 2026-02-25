use aztec::macros::aztec;

/// Compute card commitment hash (33 fields via Pedersen).
/// Must exactly match circuits/prove_hand/src/main.nr compute_card_commit.
/// Fields: [player_secret, player_address, game_id, card_ids[5], card_ranks[5*4], nullifier_secrets[5]]
pub fn compute_card_commit(
    player_secret: Field,
    player_address: Field,
    game_id: Field,
    card_ids: [Field; 5],
    card_ranks: [[Field; 4]; 5],
    nullifier_secrets: [Field; 5],
) -> Field {
    let mut hash_inputs: [Field; 33] = [0; 33];
    hash_inputs[0] = player_secret;
    hash_inputs[1] = player_address;
    hash_inputs[2] = game_id;
    for i in 0..5 {
        hash_inputs[3 + i] = card_ids[i];
    }
    for i in 0..5 {
        for j in 0..4 {
            hash_inputs[8 + i * 4 + j] = card_ranks[i][j];
        }
    }
    for i in 0..5 {
        hash_inputs[28 + i] = nullifier_secrets[i];
    }
    std::hash::pedersen_hash(hash_inputs)
}

/// Triple Triad Game contract.
/// Manages on-chain game lifecycle: creation, joining, proof verification, and settlement.
///
/// Game Lifecycle:
/// 1. Player 1 calls NFT.prepare_for_game([5 card IDs], game_id) to escrow cards
/// 2. Player 1 calls create_game(game_id, card_ids, card_ranks, secret, nullifier_secrets)
/// 3. Player 2 calls NFT.prepare_for_game([5 card IDs], game_id) to escrow cards
/// 4. Player 2 calls join_game(game_id, card_ids, card_ranks, secret, nullifier_secrets)
/// 5. Game plays out off-chain with ZK proofs exchanged via WebSocket
/// 6. Winner calls process_game with aggregate proof
/// 7. Both players call NFT.reclaim_card(token_id) for remaining cards
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
            traits::ToField,
        },
        state_vars::{Map, PublicImmutable, PublicMutable},
    };
    use bb_proof_verification::{UltraHonkVerificationKey, UltraHonkZKProof, verify_honk_proof};
    use triple_triad_nft::TripleTriadNFT;
    use super::compute_card_commit;

    // --- Events ---

    #[event]
    struct GameSettled {
        game_id: Field,
        winner: AztecAddress,
        loser: AztecAddress,
        transferred_card_id: Field,
    }

    #[event]
    struct GameCreated {
        game_id: Field,
        player1: AztecAddress,
        card_commit_1: Field,
    }

    #[event]
    struct GameJoined {
        game_id: Field,
        player2: AztecAddress,
        card_commit_2: Field,
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
        // Game lifecycle storage
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

    // --- Create Game (Private) ---

    /// Player 1 creates a new game.
    /// Before calling this, Player 1 must call NFT.prepare_for_game(card_ids, game_id).
    #[external("private")]
    fn create_game(
        game_id: Field,
        card_ids: [Field; 5],
        card_ranks: [[Field; 4]; 5],
        player_secret: Field,
        nullifier_secrets: [Field; 5],
    ) {
        let player = self.msg_sender();
        let player_field = player.to_field();

        let cc = compute_card_commit(
            player_secret,
            player_field,
            game_id,
            card_ids,
            card_ranks,
            nullifier_secrets,
        );

        self.enqueue_self.register_game(game_id, player, cc);
    }

    /// Public function enqueued by create_game to store the game record.
    #[external("public")]
    #[only_self]
    fn register_game(game_id: Field, player1: AztecAddress, card_commit_1: Field) {
        let status = self.storage.game_status.at(game_id).read();
        assert(status == 0, "Game already exists");

        self.storage.game_status.at(game_id).write(1); // created
        self.storage.game_player1.at(game_id).write(player1);
        self.storage.game_card_commit_1.at(game_id).write(card_commit_1);

        self.emit(GameCreated { game_id, player1, card_commit_1 });
    }

    // --- Join Game (Private) ---

    /// Player 2 joins an existing game.
    /// Before calling this, Player 2 must call NFT.prepare_for_game(card_ids, game_id).
    #[external("private")]
    fn join_game(
        game_id: Field,
        card_ids: [Field; 5],
        card_ranks: [[Field; 4]; 5],
        player_secret: Field,
        nullifier_secrets: [Field; 5],
    ) {
        let player = self.msg_sender();
        let player_field = player.to_field();

        let cc = compute_card_commit(
            player_secret,
            player_field,
            game_id,
            card_ids,
            card_ranks,
            nullifier_secrets,
        );

        self.enqueue_self.activate_game(game_id, player, cc);
    }

    /// Public function enqueued by join_game to activate the game.
    #[external("public")]
    #[only_self]
    fn activate_game(game_id: Field, player2: AztecAddress, card_commit_2: Field) {
        let status = self.storage.game_status.at(game_id).read();
        assert(status == 1, "Game not in created state");

        let player1 = self.storage.game_player1.at(game_id).read();
        assert(player2 != player1, "Cannot join your own game");

        self.storage.game_player2.at(game_id).write(player2);
        self.storage.game_card_commit_2.at(game_id).write(card_commit_2);
        self.storage.game_status.at(game_id).write(2); // active

        self.emit(GameJoined { game_id, player2, card_commit_2 });
    }

    // --- Cancel Game ---

    /// Cancel a game that has not been joined yet. Only the creator can cancel.
    #[external("public")]
    fn cancel_game(game_id: Field, player1_card_ids: [Field; 5]) {
        let status = self.storage.game_status.at(game_id).read();
        assert(status == 1, "Can only cancel games in created state");

        let player1 = self.storage.game_player1.at(game_id).read();
        assert(self.msg_sender() == player1, "Only game creator can cancel");

        self.storage.game_status.at(game_id).write(4); // cancelled

        let nft_address = self.storage.nft_contract.read();
        TripleTriadNFT::at(nft_address)
            .unlock_cards(player1_card_ids, game_id)
            .call(self.context);

        self.emit(GameCancelled { game_id });
    }

    // --- Process Game (Private) ---

    /// Process a completed game using an aggregated proof.
    /// Aggregate proof public inputs:
    ///   [0]  card_commit_1
    ///   [1]  card_commit_2
    ///   [2]  player1_address
    ///   [3]  player2_address
    ///   [4]  game_id
    ///   [5]  initial_state_hash
    ///   [6]  final_state_hash
    ///   [7]  game_ended (must be 1)
    ///   [8]  winner_id (1, 2, or 3)
    ///   [9]  hand_vk_hash
    ///   [10] move_vk_hash
    ///   [11..14] grumpkin pubkeys
    #[external("private")]
    fn process_game(
        aggregate_vk: UltraHonkVerificationKey,
        aggregate_proof: UltraHonkZKProof,
        aggregate_inputs: [Field; 15],
        loser: AztecAddress,
        card_to_transfer: Field,
        loser_card_ids: [Field; 5],
    ) {
        let stored_aggregate_vk_hash = self.storage.aggregate_vk_hash.read();
        let stored_hand_vk_hash = self.storage.hand_vk_hash.read();
        let stored_move_vk_hash = self.storage.move_vk_hash.read();

        verify_honk_proof(
            aggregate_vk,
            aggregate_proof,
            aggregate_inputs,
            stored_aggregate_vk_hash,
        );

        let proof_card_commit_1 = aggregate_inputs[0];
        let proof_card_commit_2 = aggregate_inputs[1];
        let player1_address = aggregate_inputs[2];
        let player2_address = aggregate_inputs[3];
        let game_id = aggregate_inputs[4];
        let _initial_state_hash = aggregate_inputs[5];
        let _final_state_hash = aggregate_inputs[6];
        let game_ended = aggregate_inputs[7];
        let winner_id = aggregate_inputs[8];
        let proof_hand_vk_hash = aggregate_inputs[9];
        let proof_move_vk_hash = aggregate_inputs[10];

        assert(
            proof_hand_vk_hash == stored_hand_vk_hash,
            "Hand VK hash mismatch with stored value",
        );
        assert(
            proof_move_vk_hash == stored_move_vk_hash,
            "Move VK hash mismatch with stored value",
        );

        assert(game_ended == 1, "Game not ended");

        let caller = self.msg_sender();
        let caller_field = caller.to_field();

        if winner_id == 1 {
            assert(caller_field == player1_address, "Caller is not the winner");
            assert(loser.to_field() == player2_address, "Loser must be player 2");
        } else if winner_id == 2 {
            assert(caller_field == player2_address, "Caller is not the winner");
            assert(loser.to_field() == player1_address, "Loser must be player 1");
        } else {
            assert(winner_id == 3, "Invalid winner ID");
            assert(
                (caller_field == player1_address) | (caller_field == player2_address),
                "Caller is not a game participant",
            );
        }

        if winner_id != 3 {
            assert(card_to_transfer != 0, "card_to_transfer must be nonzero for non-draw");

            let mut card_found = false;
            for i in 0..5 {
                if loser_card_ids[i] == card_to_transfer {
                    card_found = true;
                }
            }
            assert(card_found, "card_to_transfer not in loser's escrowed cards");

            self.enqueue_self.settle_game(
                game_id, caller, loser, card_to_transfer, loser_card_ids,
                proof_card_commit_1, proof_card_commit_2,
            );
        } else {
            self.enqueue_self.settle_game_draw(
                game_id, loser_card_ids,
                proof_card_commit_1, proof_card_commit_2,
            );
        }
    }

    // --- Public settlement ---

    #[external("public")]
    #[only_self]
    fn settle_game(
        game_id: Field,
        winner: AztecAddress,
        loser: AztecAddress,
        card_id: Field,
        loser_card_ids: [Field; 5],
        proof_card_commit_1: Field,
        proof_card_commit_2: Field,
    ) {
        let settled = self.storage.game_settled.at(game_id).read();
        assert(!settled, "Game already settled");

        // Verify card_commits match on-chain records (if game was registered)
        let stored_cc1 = self.storage.game_card_commit_1.at(game_id).read();
        let stored_cc2 = self.storage.game_card_commit_2.at(game_id).read();
        if stored_cc1 != 0 {
            assert(
                proof_card_commit_1 == stored_cc1,
                "card_commit_1 from proof does not match on-chain record",
            );
        }
        if stored_cc2 != 0 {
            assert(
                proof_card_commit_2 == stored_cc2,
                "card_commit_2 from proof does not match on-chain record",
            );
        }

        self.storage.game_settled.at(game_id).write(true);
        self.storage.game_status.at(game_id).write(3); // settled

        let nft_address = self.storage.nft_contract.read();

        TripleTriadNFT::at(nft_address)
            .game_transfer(loser, winner, card_id)
            .call(self.context);

        TripleTriadNFT::at(nft_address)
            .unlock_cards(loser_card_ids, game_id)
            .call(self.context);

        self.emit(GameSettled {
            game_id,
            winner,
            loser,
            transferred_card_id: card_id,
        });
    }

    #[external("public")]
    #[only_self]
    fn settle_game_draw(
        game_id: Field,
        card_ids: [Field; 5],
        proof_card_commit_1: Field,
        proof_card_commit_2: Field,
    ) {
        let settled = self.storage.game_settled.at(game_id).read();
        assert(!settled, "Game already settled");

        let stored_cc1 = self.storage.game_card_commit_1.at(game_id).read();
        let stored_cc2 = self.storage.game_card_commit_2.at(game_id).read();
        if stored_cc1 != 0 {
            assert(
                proof_card_commit_1 == stored_cc1,
                "card_commit_1 from proof does not match on-chain record",
            );
        }
        if stored_cc2 != 0 {
            assert(
                proof_card_commit_2 == stored_cc2,
                "card_commit_2 from proof does not match on-chain record",
            );
        }

        self.storage.game_settled.at(game_id).write(true);
        self.storage.game_status.at(game_id).write(3); // settled

        let nft_address = self.storage.nft_contract.read();
        TripleTriadNFT::at(nft_address)
            .unlock_cards(card_ids, game_id)
            .call(self.context);

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
}
