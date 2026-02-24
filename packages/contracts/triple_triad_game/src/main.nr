use aztec::macros::aztec;

/// Triple Triad Game contract.
/// Manages on-chain game settlement by verifying recursive proofs of the full game transcript.
/// The winner calls processGame with all move proofs to settle the game and transfer a card.
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
        game_settled: Map<Field, PublicMutable<bool, Context>, Context>,
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

    // --- Process Game (Private) ---

    /// Process a completed game. The winner submits:
    /// - hand proofs: proofs that each player owns 5 cards
    /// - final move proof: proof of the last game move (board state at end)
    /// - card_to_transfer: the card ID the winner wants to take
    ///
    /// Verification:
    /// 1. Verify hand proofs share same card_commit values as move proof
    /// 2. Verify all proofs are valid
    /// 3. Verify final state declares the caller as winner
    /// 4. Transfer the selected card via NFT contract
    #[external("private")]
    fn process_game(
        // Hand proofs
        hand_vk: UltraHonkVerificationKey,
        hand_proof_1: UltraHonkZKProof,
        hand_proof_1_inputs: [Field; 3],  // [card_commit, player_address, game_id]
        hand_proof_2: UltraHonkZKProof,
        hand_proof_2_inputs: [Field; 3],
        // Move proof (final state proof)
        move_vk: UltraHonkVerificationKey,
        final_move_proof: UltraHonkZKProof,
        final_move_inputs: [Field; 6],  // [card_commit_1, card_commit_2, start_state, end_state, game_ended, winner_id]
        // Game result
        loser: AztecAddress,
        card_to_transfer: Field,
    ) {
        // Read stored VK hashes (PublicImmutable is readable from private)
        let hand_vk_hash = self.storage.hand_vk_hash.read();
        let move_vk_hash = self.storage.move_vk_hash.read();

        // 1. Verify hand ownership proofs
        verify_honk_proof(hand_vk, hand_proof_1, hand_proof_1_inputs, hand_vk_hash);
        verify_honk_proof(hand_vk, hand_proof_2, hand_proof_2_inputs, hand_vk_hash);

        // 2. Card commits must match between hand proofs and move proofs
        let card_commit_1 = hand_proof_1_inputs[0];
        let card_commit_2 = hand_proof_2_inputs[0];
        assert(card_commit_1 == final_move_inputs[0], "Card commit 1 mismatch");
        assert(card_commit_2 == final_move_inputs[1], "Card commit 2 mismatch");

        // 3. Game IDs must match between hand proofs
        let game_id = hand_proof_1_inputs[2];
        assert(game_id == hand_proof_2_inputs[2], "Game ID mismatch");

        // 4. Verify the final move proof
        verify_honk_proof(move_vk, final_move_proof, final_move_inputs, move_vk_hash);

        // 5. Verify game ended and caller is winner
        assert(final_move_inputs[4] == 1, "Game not ended");
        let winner_id = final_move_inputs[5];
        let caller = self.msg_sender();

        let player1_addr = hand_proof_1_inputs[1];
        let player2_addr = hand_proof_2_inputs[1];
        let caller_field = caller.to_field();

        // Winner_id 1 = player1 wins, 2 = player2 wins
        if winner_id == 1 {
            assert(caller_field == player1_addr, "Caller is not the winner");
        } else {
            assert(winner_id == 2, "Invalid winner ID");
            assert(caller_field == player2_addr, "Caller is not the winner");
        }

        // 6. Settle: transfer card from loser to winner via NFT contract
        self.enqueue_self.settle_game(game_id, caller, loser, card_to_transfer);
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

    // --- View Functions ---

    #[external("public")]
    #[view]
    fn is_game_settled(game_id: Field) -> bool {
        self.storage.game_settled.at(game_id).read()
    }
}
