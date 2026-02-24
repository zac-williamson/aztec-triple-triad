use aztec::macros::aztec;

/// Triple Triad Game contract.
/// Manages on-chain game settlement by verifying a recursively aggregated proof
/// of the full game transcript (2 hand proofs + 9 move proofs).
/// The winner calls processGame with the aggregate proof to settle and transfer a card.
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

    // --- Events ---

    #[event]
    struct GameSettled {
        game_id: Field,
        winner: AztecAddress,
        loser: AztecAddress,
        transferred_card_id: Field,
    }

    // --- Storage ---

    #[storage]
    struct Storage<Context> {
        nft_contract: PublicImmutable<AztecAddress, Context>,
        hand_vk_hash: PublicImmutable<Field, Context>,
        move_vk_hash: PublicImmutable<Field, Context>,
        aggregate_vk_hash: PublicImmutable<Field, Context>,
        game_settled: Map<Field, PublicMutable<bool, Context>, Context>,
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

    // --- Process Game (Private) ---

    /// Process a completed game using an aggregated proof.
    /// The aggregate_game circuit verifies all 11 proofs (2 hand + 9 move),
    /// validates proof chaining, card_commit consistency, and game completion.
    ///
    /// The contract verifies the single aggregate proof and checks its public outputs:
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
    ///   [11] player1_grumpkin_pubkey_x
    ///   [12] player1_grumpkin_pubkey_y
    ///   [13] player2_grumpkin_pubkey_x
    ///   [14] player2_grumpkin_pubkey_y
    #[external("private")]
    fn process_game(
        aggregate_vk: UltraHonkVerificationKey,
        aggregate_proof: UltraHonkZKProof,
        aggregate_inputs: [Field; 15],
        loser: AztecAddress,
        card_to_transfer: Field,
    ) {
        // Read stored VK hashes (PublicImmutable is readable from private)
        let stored_aggregate_vk_hash = self.storage.aggregate_vk_hash.read();
        let stored_hand_vk_hash = self.storage.hand_vk_hash.read();
        let stored_move_vk_hash = self.storage.move_vk_hash.read();

        // 1. Verify the aggregate proof
        verify_honk_proof(
            aggregate_vk,
            aggregate_proof,
            aggregate_inputs,
            stored_aggregate_vk_hash,
        );

        // 2. Extract public outputs from aggregate proof
        let _card_commit_1 = aggregate_inputs[0];
        let _card_commit_2 = aggregate_inputs[1];
        let player1_address = aggregate_inputs[2];
        let player2_address = aggregate_inputs[3];
        let game_id = aggregate_inputs[4];
        let _initial_state_hash = aggregate_inputs[5];
        let _final_state_hash = aggregate_inputs[6];
        let game_ended = aggregate_inputs[7];
        let winner_id = aggregate_inputs[8];
        let proof_hand_vk_hash = aggregate_inputs[9];
        let proof_move_vk_hash = aggregate_inputs[10];
        let _p1_grumpkin_x = aggregate_inputs[11];
        let _p1_grumpkin_y = aggregate_inputs[12];
        let _p2_grumpkin_x = aggregate_inputs[13];
        let _p2_grumpkin_y = aggregate_inputs[14];

        // 3. Validate VK hashes match stored values
        // This ensures the aggregate proof used the correct verification keys
        assert(
            proof_hand_vk_hash == stored_hand_vk_hash,
            "Hand VK hash mismatch with stored value",
        );
        assert(
            proof_move_vk_hash == stored_move_vk_hash,
            "Move VK hash mismatch with stored value",
        );

        // 4. Verify game ended
        assert(game_ended == 1, "Game not ended");

        // 5. Verify caller is the winner
        let caller = self.msg_sender();
        let caller_field = caller.to_field();

        // winner_id: 1 = player1 wins, 2 = player2 wins, 3 = draw
        if winner_id == 1 {
            assert(caller_field == player1_address, "Caller is not the winner");
        } else if winner_id == 2 {
            assert(caller_field == player2_address, "Caller is not the winner");
        } else {
            // Draw - either player can settle (no card transfer in draw)
            assert(winner_id == 3, "Invalid winner ID");
            assert(
                (caller_field == player1_address) | (caller_field == player2_address),
                "Caller is not a game participant",
            );
        }

        // 6. Settle: transfer card from loser to winner via NFT contract
        // In case of draw, no card transfer (card_to_transfer should be 0)
        // TODO: V2 - verify card_to_transfer was actually in the game by adding
        // encrypted_card_id outputs to game_move, collecting them in aggregate,
        // and having winner prove which cards the loser played. Currently the
        // winner can specify any card the loser owns, not just game cards.
        if winner_id != 3 {
            assert(card_to_transfer != 0, "card_to_transfer must be nonzero for non-draw");
            self.enqueue_self.settle_game(game_id, caller, loser, card_to_transfer);
        } else {
            // Still mark game as settled even for draws
            self.enqueue_self.settle_game_draw(game_id);
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
    ) {
        // Check game not already settled
        let settled = self.storage.game_settled.at(game_id).read();
        assert(!settled, "Game already settled");
        self.storage.game_settled.at(game_id).write(true);

        // Transfer card from loser to winner via NFT contract
        let nft_address = self.storage.nft_contract.read();
        TripleTriadNFT::at(nft_address)
            .game_transfer(loser, winner, card_id)
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
    fn settle_game_draw(game_id: Field) {
        let settled = self.storage.game_settled.at(game_id).read();
        assert(!settled, "Game already settled");
        self.storage.game_settled.at(game_id).write(true);

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
}
