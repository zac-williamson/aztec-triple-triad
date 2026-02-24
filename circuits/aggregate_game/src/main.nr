/// Aggregate Game circuit.
/// Verifies all 11 proofs (2 hand proofs + 9 move proofs) for a complete Triple Triad game.
/// Validates proof chaining, card_commit consistency, and game completion.
///
/// Public outputs (15 fields):
///   [0]  card_commit_1 - player 1's card commitment
///   [1]  card_commit_2 - player 2's card commitment
///   [2]  player1_address - player 1's address
///   [3]  player2_address - player 2's address
///   [4]  game_id - unique game identifier
///   [5]  initial_state_hash - hash of the initial (empty) board state
///   [6]  final_state_hash - hash of the final board state
///   [7]  game_ended - must be 1
///   [8]  winner_id - 1 (player1 wins), 2 (player2 wins), or 3 (draw)
///   [9]  hand_vk_hash - verification key hash for hand proofs
///   [10] move_vk_hash - verification key hash for move proofs
///   [11] player1_grumpkin_pubkey_x - player 1's Grumpkin public key X
///   [12] player1_grumpkin_pubkey_y - player 1's Grumpkin public key Y
///   [13] player2_grumpkin_pubkey_x - player 2's Grumpkin public key X
///   [14] player2_grumpkin_pubkey_y - player 2's Grumpkin public key Y

use bb_proof_verification::{UltraHonkVerificationKey, UltraHonkZKProof, verify_honk_proof};

/// Compute the canonical hash of an empty board.
/// Must match game_move's hash_board_state format:
///   pedersen_hash([board[18], scores[2], current_turn])
/// Empty board: all zeros, scores = [5, 5], current_turn = 1 (player1 goes first)
fn compute_initial_state_hash() -> Field {
    let mut inputs: [Field; 21] = [0; 21];
    // board[0..18] = all zeros (empty board)
    inputs[18] = 5;  // player1_score = 5 (5 cards in hand)
    inputs[19] = 5;  // player2_score = 5 (5 cards in hand)
    inputs[20] = 1;  // player1 goes first
    std::hash::pedersen_hash(inputs)
}

fn main(
    // === Public outputs (verified by the contract) ===
    card_commit_1: pub Field,
    card_commit_2: pub Field,
    player1_address: pub Field,
    player2_address: pub Field,
    game_id: pub Field,
    initial_state_hash: pub Field,
    final_state_hash: pub Field,
    game_ended: pub Field,
    winner_id: pub Field,
    hand_vk_hash: pub Field,
    move_vk_hash: pub Field,
    // NEW public outputs: Grumpkin public keys from hand proofs (BUG-1 fix)
    player1_grumpkin_pubkey_x: pub Field,
    player1_grumpkin_pubkey_y: pub Field,
    player2_grumpkin_pubkey_x: pub Field,
    player2_grumpkin_pubkey_y: pub Field,

    // === Private inputs: Hand proofs ===
    hand_vk: UltraHonkVerificationKey,
    hand_proof_1: UltraHonkZKProof,
    hand_proof_1_inputs: [Field; 5],  // [card_commit, player_address, game_id, grumpkin_x, grumpkin_y]
    hand_proof_2: UltraHonkZKProof,
    hand_proof_2_inputs: [Field; 5],

    // === Private inputs: Move proofs (9 moves) ===
    move_vk: UltraHonkVerificationKey,
    // Move 1
    move_proof_1: UltraHonkZKProof,
    move_inputs_1: [Field; 7],  // [card_commit_1, card_commit_2, start_state, end_state, game_ended, winner_id, encrypted_card_nullifier]
    // Move 2
    move_proof_2: UltraHonkZKProof,
    move_inputs_2: [Field; 7],
    // Move 3
    move_proof_3: UltraHonkZKProof,
    move_inputs_3: [Field; 7],
    // Move 4
    move_proof_4: UltraHonkZKProof,
    move_inputs_4: [Field; 7],
    // Move 5
    move_proof_5: UltraHonkZKProof,
    move_inputs_5: [Field; 7],
    // Move 6
    move_proof_6: UltraHonkZKProof,
    move_inputs_6: [Field; 7],
    // Move 7
    move_proof_7: UltraHonkZKProof,
    move_inputs_7: [Field; 7],
    // Move 8
    move_proof_8: UltraHonkZKProof,
    move_inputs_8: [Field; 7],
    // Move 9
    move_proof_9: UltraHonkZKProof,
    move_inputs_9: [Field; 7],
) {
    // ===== 1. Verify hand proofs =====
    verify_honk_proof(hand_vk, hand_proof_1, hand_proof_1_inputs, hand_vk_hash);
    verify_honk_proof(hand_vk, hand_proof_2, hand_proof_2_inputs, hand_vk_hash);

    // ===== 2. Extract and validate hand proof data =====
    // hand_proof_inputs layout: [card_commit, player_address, game_id, grumpkin_x, grumpkin_y]
    let hp1_card_commit = hand_proof_1_inputs[0];
    let hp1_player_addr = hand_proof_1_inputs[1];
    let hp1_game_id = hand_proof_1_inputs[2];
    let hp1_grumpkin_x = hand_proof_1_inputs[3];
    let hp1_grumpkin_y = hand_proof_1_inputs[4];

    let hp2_card_commit = hand_proof_2_inputs[0];
    let hp2_player_addr = hand_proof_2_inputs[1];
    let hp2_game_id = hand_proof_2_inputs[2];
    let hp2_grumpkin_x = hand_proof_2_inputs[3];
    let hp2_grumpkin_y = hand_proof_2_inputs[4];

    // Card commits from hand proofs must match public outputs
    assert(hp1_card_commit == card_commit_1, "Hand proof 1 card_commit mismatch");
    assert(hp2_card_commit == card_commit_2, "Hand proof 2 card_commit mismatch");

    // Player addresses must match public outputs
    assert(hp1_player_addr == player1_address, "Hand proof 1 player address mismatch");
    assert(hp2_player_addr == player2_address, "Hand proof 2 player address mismatch");

    // Game IDs must match
    assert(hp1_game_id == game_id, "Hand proof 1 game_id mismatch");
    assert(hp2_game_id == game_id, "Hand proof 2 game_id mismatch");

    // Prevent self-play: players must be different addresses
    assert(player1_address != player2_address, "Players must have different addresses");

    // Grumpkin public keys from hand proofs must match public outputs (BUG-1 fix)
    assert(hp1_grumpkin_x == player1_grumpkin_pubkey_x, "P1 Grumpkin X mismatch");
    assert(hp1_grumpkin_y == player1_grumpkin_pubkey_y, "P1 Grumpkin Y mismatch");
    assert(hp2_grumpkin_x == player2_grumpkin_pubkey_x, "P2 Grumpkin X mismatch");
    assert(hp2_grumpkin_y == player2_grumpkin_pubkey_y, "P2 Grumpkin Y mismatch");

    // ===== 3. Collect move inputs into arrays for easier processing =====
    // move_inputs layout: [cc1, cc2, start_state, end_state, game_ended, winner_id, encrypted_card_nullifier]
    //                      [0]  [1]  [2]          [3]        [4]         [5]        [6]
    let move_inputs: [[Field; 7]; 9] = [
        move_inputs_1, move_inputs_2, move_inputs_3,
        move_inputs_4, move_inputs_5, move_inputs_6,
        move_inputs_7, move_inputs_8, move_inputs_9,
    ];

    // ===== 4. Verify all 9 move proofs =====
    verify_honk_proof(move_vk, move_proof_1, move_inputs_1, move_vk_hash);
    verify_honk_proof(move_vk, move_proof_2, move_inputs_2, move_vk_hash);
    verify_honk_proof(move_vk, move_proof_3, move_inputs_3, move_vk_hash);
    verify_honk_proof(move_vk, move_proof_4, move_inputs_4, move_vk_hash);
    verify_honk_proof(move_vk, move_proof_5, move_inputs_5, move_vk_hash);
    verify_honk_proof(move_vk, move_proof_6, move_inputs_6, move_vk_hash);
    verify_honk_proof(move_vk, move_proof_7, move_inputs_7, move_vk_hash);
    verify_honk_proof(move_vk, move_proof_8, move_inputs_8, move_vk_hash);
    verify_honk_proof(move_vk, move_proof_9, move_inputs_9, move_vk_hash);

    // ===== 5. Validate card_commit consistency across all move proofs =====
    for i in 0..9 {
        assert(
            move_inputs[i][0] == card_commit_1,
            "Move proof card_commit_1 mismatch",
        );
        assert(
            move_inputs[i][1] == card_commit_2,
            "Move proof card_commit_2 mismatch",
        );
    }

    // ===== 6. Validate proof chaining =====
    // proof[i].end_state_hash == proof[i+1].start_state_hash
    for i in 0..8 {
        assert(
            move_inputs[i][3] == move_inputs[i + 1][2],
            "Proof chaining failed: end_state != next start_state",
        );
    }

    // ===== 7. Validate initial and final states =====
    // Verify initial_state_hash is the canonical empty board hash (BUG-3 fix)
    let canonical_initial = compute_initial_state_hash();
    assert(initial_state_hash == canonical_initial, "Initial state must be empty board");

    // First move's start_state must match the canonical initial_state_hash
    assert(
        move_inputs[0][2] == canonical_initial,
        "First move start_state does not match initial state",
    );

    // Last move's end_state must match the public final_state_hash
    assert(
        move_inputs[8][3] == final_state_hash,
        "Last move end_state does not match final state",
    );

    // ===== 8. Validate intermediate game_ended flags =====
    // Moves 1-8 should NOT have game_ended = 1
    for i in 0..8 {
        assert(
            move_inputs[i][4] == 0,
            "Intermediate move should not end the game",
        );
        assert(
            move_inputs[i][5] == 0,
            "Intermediate move should not have a winner",
        );
    }

    // ===== 9. Validate game completion =====
    assert(move_inputs[8][4] == game_ended, "Final move game_ended mismatch");
    assert(game_ended == 1, "Game must have ended");
    assert(move_inputs[8][5] == winner_id, "Final move winner_id mismatch");
    assert(
        (winner_id == 1) | (winner_id == 2) | (winner_id == 3),
        "Invalid winner_id",
    );
}

// ====================== TESTABLE HELPER FUNCTIONS ======================

/// Validate hand proof data matches expected public outputs.
/// Verifies card_commit, player_address, game_id, and Grumpkin pubkey fields.
fn validate_hand_proof_data(
    inputs: [Field; 5],
    expected_card_commit: Field,
    expected_player_addr: Field,
    expected_game_id: Field,
    expected_grumpkin_x: Field,
    expected_grumpkin_y: Field,
) {
    assert(inputs[0] == expected_card_commit, "Hand proof card_commit mismatch");
    assert(inputs[1] == expected_player_addr, "Hand proof player address mismatch");
    assert(inputs[2] == expected_game_id, "Hand proof game_id mismatch");
    assert(inputs[3] == expected_grumpkin_x, "Hand proof Grumpkin X mismatch");
    assert(inputs[4] == expected_grumpkin_y, "Hand proof Grumpkin Y mismatch");
}

/// Validate that move proofs form a valid chain:
/// - All moves share the same card_commits
/// - end_state of move i == start_state of move i+1
/// - Intermediate moves have game_ended=0, winner_id=0
/// - Final move has game_ended=1 and valid winner_id
fn validate_move_chain(
    move_inputs: [[Field; 7]; 9],
    card_commit_1: Field,
    card_commit_2: Field,
    initial_state_hash: Field,
    final_state_hash: Field,
    game_ended: Field,
    winner_id: Field,
) {
    // Card commit consistency
    for i in 0..9 {
        assert(move_inputs[i][0] == card_commit_1, "Move proof card_commit_1 mismatch");
        assert(move_inputs[i][1] == card_commit_2, "Move proof card_commit_2 mismatch");
    }

    // Proof chaining: end_state[i] == start_state[i+1]
    for i in 0..8 {
        assert(
            move_inputs[i][3] == move_inputs[i + 1][2],
            "Proof chaining failed: end_state != next start_state",
        );
    }

    // Initial state verification
    let canonical_initial = compute_initial_state_hash();
    assert(initial_state_hash == canonical_initial, "Initial state must be empty board");
    assert(move_inputs[0][2] == canonical_initial, "First move start_state does not match initial state");

    // Final state verification
    assert(move_inputs[8][3] == final_state_hash, "Last move end_state does not match final state");

    // Intermediate moves should NOT end the game
    for i in 0..8 {
        assert(move_inputs[i][4] == 0, "Intermediate move should not end the game");
        assert(move_inputs[i][5] == 0, "Intermediate move should not have a winner");
    }

    // Game completion
    assert(move_inputs[8][4] == game_ended, "Final move game_ended mismatch");
    assert(game_ended == 1, "Game must have ended");
    assert(move_inputs[8][5] == winner_id, "Final move winner_id mismatch");
    assert(
        (winner_id == 1) | (winner_id == 2) | (winner_id == 3),
        "Invalid winner_id",
    );
}

// ====================== TESTS ======================

#[test]
fn test_initial_state_hash() {
    let hash = compute_initial_state_hash();
    // Independently compute using the same pedersen_hash with the same layout
    let mut inputs: [Field; 21] = [0; 21];
    inputs[18] = 5;
    inputs[19] = 5;
    inputs[20] = 1;
    let expected = std::hash::pedersen_hash(inputs);
    assert(hash == expected, "Initial state hash mismatch");
    // Verify it's not zero (sanity check)
    assert(hash != 0, "Initial state hash should not be zero");
}

#[test]
fn test_validate_hand_proof_data_valid() {
    let inputs: [Field; 5] = [100, 200, 300, 400, 500];
    validate_hand_proof_data(inputs, 100, 200, 300, 400, 500);
}

#[test(should_fail_with = "Hand proof card_commit mismatch")]
fn test_validate_hand_proof_data_wrong_commit() {
    let inputs: [Field; 5] = [100, 200, 300, 400, 500];
    validate_hand_proof_data(inputs, 999, 200, 300, 400, 500);
}

#[test(should_fail_with = "Hand proof player address mismatch")]
fn test_validate_hand_proof_data_wrong_addr() {
    let inputs: [Field; 5] = [100, 200, 300, 400, 500];
    validate_hand_proof_data(inputs, 100, 999, 300, 400, 500);
}

#[test(should_fail_with = "Hand proof game_id mismatch")]
fn test_validate_hand_proof_data_wrong_game_id() {
    let inputs: [Field; 5] = [100, 200, 300, 400, 500];
    validate_hand_proof_data(inputs, 100, 200, 999, 400, 500);
}

#[test(should_fail_with = "Hand proof Grumpkin X mismatch")]
fn test_validate_hand_proof_data_wrong_grumpkin_x() {
    let inputs: [Field; 5] = [100, 200, 300, 400, 500];
    validate_hand_proof_data(inputs, 100, 200, 300, 999, 500);
}

#[test]
fn test_validate_move_chain_valid() {
    let initial = compute_initial_state_hash();
    // Build 9 move inputs with proper chaining
    let mut moves: [[Field; 7]; 9] = [[0; 7]; 9];
    let cc1: Field = 111;
    let cc2: Field = 222;

    // State hashes: initial -> s1 -> s2 -> ... -> s8 -> final
    let state_hashes: [Field; 10] = [initial, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 9999];

    for i in 0..9 {
        moves[i][0] = cc1;
        moves[i][1] = cc2;
        moves[i][2] = state_hashes[i];       // start_state
        moves[i][3] = state_hashes[i + 1];   // end_state
        moves[i][4] = 0;                     // game_ended
        moves[i][5] = 0;                     // winner_id
        moves[i][6] = 0;                     // encrypted_card_nullifier
    }
    // Final move ends the game with P1 winning
    moves[8][4] = 1;
    moves[8][5] = 1;

    validate_move_chain(moves, cc1, cc2, initial, 9999, 1, 1);
}

#[test(should_fail_with = "Proof chaining failed")]
fn test_validate_move_chain_broken_chain() {
    let initial = compute_initial_state_hash();
    let mut moves: [[Field; 7]; 9] = [[0; 7]; 9];
    let cc1: Field = 111;
    let cc2: Field = 222;

    let state_hashes: [Field; 10] = [initial, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 9999];

    for i in 0..9 {
        moves[i][0] = cc1;
        moves[i][1] = cc2;
        moves[i][2] = state_hashes[i];
        moves[i][3] = state_hashes[i + 1];
        moves[i][4] = 0;
        moves[i][5] = 0;
        moves[i][6] = 0;
    }
    moves[8][4] = 1;
    moves[8][5] = 1;

    // Break the chain at move 3->4
    moves[3][3] = 0xbadbadbad;

    validate_move_chain(moves, cc1, cc2, initial, 9999, 1, 1);
}

#[test(should_fail_with = "Move proof card_commit_1 mismatch")]
fn test_validate_move_chain_wrong_commit() {
    let initial = compute_initial_state_hash();
    let mut moves: [[Field; 7]; 9] = [[0; 7]; 9];
    let cc1: Field = 111;
    let cc2: Field = 222;

    let state_hashes: [Field; 10] = [initial, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 9999];

    for i in 0..9 {
        moves[i][0] = cc1;
        moves[i][1] = cc2;
        moves[i][2] = state_hashes[i];
        moves[i][3] = state_hashes[i + 1];
        moves[i][4] = 0;
        moves[i][5] = 0;
        moves[i][6] = 0;
    }
    moves[8][4] = 1;
    moves[8][5] = 1;

    // Corrupt card_commit_1 in move 5
    moves[5][0] = 0xdeadbeef;

    validate_move_chain(moves, cc1, cc2, initial, 9999, 1, 1);
}

#[test(should_fail_with = "Intermediate move should not end the game")]
fn test_validate_move_chain_premature_end() {
    let initial = compute_initial_state_hash();
    let mut moves: [[Field; 7]; 9] = [[0; 7]; 9];
    let cc1: Field = 111;
    let cc2: Field = 222;

    let state_hashes: [Field; 10] = [initial, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 9999];

    for i in 0..9 {
        moves[i][0] = cc1;
        moves[i][1] = cc2;
        moves[i][2] = state_hashes[i];
        moves[i][3] = state_hashes[i + 1];
        moves[i][4] = 0;
        moves[i][5] = 0;
        moves[i][6] = 0;
    }
    moves[8][4] = 1;
    moves[8][5] = 1;

    // Set game_ended on an intermediate move
    moves[4][4] = 1;

    validate_move_chain(moves, cc1, cc2, initial, 9999, 1, 1);
}

#[test]
fn test_validate_move_chain_p2_wins() {
    let initial = compute_initial_state_hash();
    let mut moves: [[Field; 7]; 9] = [[0; 7]; 9];
    let cc1: Field = 111;
    let cc2: Field = 222;

    let state_hashes: [Field; 10] = [initial, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 9999];

    for i in 0..9 {
        moves[i][0] = cc1;
        moves[i][1] = cc2;
        moves[i][2] = state_hashes[i];
        moves[i][3] = state_hashes[i + 1];
        moves[i][4] = 0;
        moves[i][5] = 0;
        moves[i][6] = 0;
    }
    // Final move: P2 wins
    moves[8][4] = 1;
    moves[8][5] = 2;

    validate_move_chain(moves, cc1, cc2, initial, 9999, 1, 2);
}

#[test]
fn test_validate_move_chain_draw() {
    let initial = compute_initial_state_hash();
    let mut moves: [[Field; 7]; 9] = [[0; 7]; 9];
    let cc1: Field = 111;
    let cc2: Field = 222;

    let state_hashes: [Field; 10] = [initial, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 9999];

    for i in 0..9 {
        moves[i][0] = cc1;
        moves[i][1] = cc2;
        moves[i][2] = state_hashes[i];
        moves[i][3] = state_hashes[i + 1];
        moves[i][4] = 0;
        moves[i][5] = 0;
        moves[i][6] = 0;
    }
    // Final move: draw
    moves[8][4] = 1;
    moves[8][5] = 3;

    validate_move_chain(moves, cc1, cc2, initial, 9999, 1, 3);
}

#[test(should_fail_with = "Invalid winner_id")]
fn test_validate_move_chain_invalid_winner() {
    let initial = compute_initial_state_hash();
    let mut moves: [[Field; 7]; 9] = [[0; 7]; 9];
    let cc1: Field = 111;
    let cc2: Field = 222;

    let state_hashes: [Field; 10] = [initial, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 9999];

    for i in 0..9 {
        moves[i][0] = cc1;
        moves[i][1] = cc2;
        moves[i][2] = state_hashes[i];
        moves[i][3] = state_hashes[i + 1];
        moves[i][4] = 0;
        moves[i][5] = 0;
        moves[i][6] = 0;
    }
    // Final move with invalid winner_id=4
    moves[8][4] = 1;
    moves[8][5] = 4;

    validate_move_chain(moves, cc1, cc2, initial, 9999, 1, 4);
}

/// Helper to validate self-play prevention
fn validate_no_self_play(player1_address: Field, player2_address: Field) {
    assert(player1_address != player2_address, "Players must have different addresses");
}

#[test]
fn test_no_self_play_different_addresses() {
    validate_no_self_play(0x1234, 0x5678);
}

#[test(should_fail_with = "Players must have different addresses")]
fn test_no_self_play_same_address_rejected() {
    validate_no_self_play(0x1234, 0x1234);
}
