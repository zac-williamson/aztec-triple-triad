/// Game Move circuit.
/// Proves that a game move is valid: one card placed from correct player,
/// board state correctly updated with capture logic.
///
/// Public inputs:
///   card_commit_1, card_commit_2 - player card commitments (include ranks)
///   start_state_hash - hash of board state before this move
///   end_state_hash - hash of board state after this move
///   game_ended - 1 if game over, 0 otherwise
///   winner_id - 0=not ended, 1=player1 wins, 2=player2 wins, 3=draw
///
/// The circuit verifies:
/// 1. The placed card is in the current player's committed hand (card_commit binding)
/// 2. Capture logic: rank comparison for all adjacent opponent cells
/// 3. Non-placed, non-captured cells are unchanged between board_before/board_after
/// 4. Scores are consistent with board ownership + hand counts
/// 5. Game end detection and winner determination

/// Board cell: each cell is (card_id, owner) where owner 0=empty, 1=player1, 2=player2

// ====================== CARD DATABASE ======================
/// Hardcoded card rank database: 50 cards with ranks [top, right, bottom, left].
fn get_card_ranks(card_id: u32) -> [Field; 4] {
    assert((card_id >= 1) & (card_id <= 50), "Invalid card ID for rank lookup");

    if card_id == 1 { [1, 4, 1, 5] }         // Geezard
    else if card_id == 2 { [5, 1, 1, 3] }    // Funguar
    else if card_id == 3 { [1, 3, 3, 5] }    // Bite Bug
    else if card_id == 4 { [6, 1, 1, 2] }    // Red Bat
    else if card_id == 5 { [2, 3, 1, 5] }    // Blobra
    else if card_id == 6 { [2, 1, 4, 4] }    // Gayla
    else if card_id == 7 { [1, 5, 4, 1] }    // Gesper
    else if card_id == 8 { [3, 1, 5, 2] }    // Fastitocalon-F
    else if card_id == 9 { [2, 1, 6, 1] }    // Blood Soul
    else if card_id == 10 { [4, 3, 2, 4] }   // Caterchipillar
    else if card_id == 11 { [2, 6, 1, 6] }   // Cockatrice
    else if card_id == 12 { [7, 1, 3, 1] }   // Grat
    else if card_id == 13 { [6, 2, 2, 3] }   // Buel
    else if card_id == 14 { [5, 3, 3, 4] }   // Mesmerize
    else if card_id == 15 { [6, 1, 4, 3] }   // Glacial Eye
    else if card_id == 16 { [3, 4, 5, 3] }   // Belhelmel
    else if card_id == 17 { [5, 3, 2, 5] }   // Thrustaevis
    else if card_id == 18 { [5, 1, 3, 5] }   // Anacondaur
    else if card_id == 19 { [5, 2, 5, 2] }   // Creeps
    else if card_id == 20 { [4, 2, 4, 5] }   // Grendel
    else if card_id == 21 { [3, 7, 2, 5] }   // Jelleye
    else if card_id == 22 { [5, 2, 5, 5] }   // Grand Mantis
    else if card_id == 23 { [6, 6, 3, 3] }   // Forbidden
    else if card_id == 24 { [6, 3, 6, 3] }   // Armadodo
    else if card_id == 25 { [3, 5, 5, 5] }   // Tri-Face
    else if card_id == 26 { [7, 5, 1, 3] }   // Fastitocalon
    else if card_id == 27 { [7, 1, 5, 3] }   // Snow Lion
    else if card_id == 28 { [5, 3, 6, 3] }   // Ochu
    else if card_id == 29 { [5, 6, 2, 4] }   // SAM08G
    else if card_id == 30 { [4, 4, 7, 2] }   // Death Claw
    else if card_id == 31 { [3, 6, 4, 7] }   // Tonberry
    else if card_id == 32 { [7, 2, 3, 7] }   // Abyss Worm
    else if card_id == 33 { [2, 3, 7, 7] }   // Turtapod
    else if card_id == 34 { [6, 5, 5, 5] }   // Vysage
    else if card_id == 35 { [4, 7, 6, 2] }   // T-Rexaur
    else if card_id == 36 { [2, 3, 7, 8] }   // Bomb
    else if card_id == 37 { [1, 7, 6, 4] }   // Blitz
    else if card_id == 38 { [7, 3, 1, 6] }   // Wendigo
    else if card_id == 39 { [7, 4, 4, 4] }   // Torama
    else if card_id == 40 { [3, 7, 3, 6] }   // Imp
    else if card_id == 41 { [6, 7, 3, 7] }   // Blue Dragon
    else if card_id == 42 { [6, 5, 8, 4] }   // Abadon
    else if card_id == 43 { [6, 5, 6, 6] }   // Iron Giant
    else if card_id == 44 { [3, 6, 7, 8] }   // Behemoth
    else if card_id == 45 { [7, 6, 5, 6] }   // Chimera
    else if card_id == 46 { [3, 10, 2, 1] }  // PuPu
    else if card_id == 47 { [6, 2, 6, 7] }   // Elastoid
    else if card_id == 48 { [5, 5, 7, 6] }   // GIM47N
    else if card_id == 49 { [7, 7, 4, 2] }   // Malboro
    else { [7, 2, 7, 4] }                    // Ruby Dragon (50)
}

// ====================== HASH FUNCTIONS ======================

fn hash_board_state(board: [Field; 18], scores: [Field; 2], current_turn: Field) -> Field {
    let mut inputs: [Field; 21] = [0; 21];
    for i in 0..18 {
        inputs[i] = board[i];
    }
    inputs[18] = scores[0];
    inputs[19] = scores[1];
    inputs[20] = current_turn;
    std::hash::pedersen_hash(inputs)
}

/// Compute card commitment hash (must match prove_hand format).
/// Format: hash(player_secret, player_address, game_id,
///              card_ids[5], card_ranks[5*4], nullifier_secrets[5])
fn compute_card_commit(
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

// ====================== MAIN CIRCUIT ======================

fn main(
    // Public inputs
    card_commit_1: pub Field,
    card_commit_2: pub Field,
    start_state_hash: pub Field,
    end_state_hash: pub Field,
    game_ended: pub Field,
    winner_id: pub Field,
    // Private inputs - move data
    current_player: Field,       // 1 or 2
    card_id: Field,              // ID of card being placed
    row: Field,                  // 0-2
    col: Field,                  // 0-2
    // Private inputs - board state
    board_before: [Field; 18],   // 9 cells x 2 fields (card_id, owner)
    board_after: [Field; 18],
    scores_before: [Field; 2],
    scores_after: [Field; 2],
    current_turn_before: Field,
    player1_hand_count_after: Field,
    player2_hand_count_after: Field,
    // Private inputs - current player's hand commitment data
    player_secret: Field,
    player_address: Field,
    game_id: Field,
    player_card_ids: [Field; 5],
    player_card_ranks: [[Field; 4]; 5],
    player_nullifier_secrets: [Field; 5],
) {
    // ===== 1. Validate current player =====
    assert(
        (current_player == 1) | (current_player == 2),
        "Invalid player",
    );
    assert(current_player == current_turn_before, "Not this player's turn");

    // ===== 2. Validate position =====
    let r = row as u32;
    let c = col as u32;
    assert(r < 3, "Row out of bounds");
    assert(c < 3, "Col out of bounds");

    // ===== 3. Verify card_commit binding (FIX-1) =====
    // Recompute the current player's card_commit from their hand data
    let recomputed_commit = compute_card_commit(
        player_secret,
        player_address,
        game_id,
        player_card_ids,
        player_card_ranks,
        player_nullifier_secrets,
    );

    // Verify it matches the correct card_commit (1 or 2 based on current_player)
    if current_player == 1 {
        assert(recomputed_commit == card_commit_1, "Player 1 card commit mismatch");
    } else {
        assert(recomputed_commit == card_commit_2, "Player 2 card commit mismatch");
    }

    // ===== 4. Verify placed card is in committed hand =====
    let mut card_found: bool = false;
    let mut placed_card_ranks: [Field; 4] = [0; 4];
    for i in 0..5 {
        if player_card_ids[i] == card_id {
            card_found = true;
            placed_card_ranks = player_card_ranks[i];
        }
    }
    assert(card_found, "Placed card not in committed hand");

    // Verify the committed ranks match the hardcoded card database
    let db_ranks = get_card_ranks(card_id as u32);
    for i in 0..4 {
        assert(
            placed_card_ranks[i] == db_ranks[i],
            "Placed card ranks do not match database",
        );
    }

    // ===== 5. Verify the cell was empty before the move =====
    let cell_idx = r * 3 + c;
    assert(board_before[cell_idx * 2] == 0, "Cell not empty");
    assert(board_before[cell_idx * 2 + 1] == 0, "Cell not empty (owner)");

    // ===== 6. Verify the card was placed in board_after =====
    assert(board_after[cell_idx * 2] == card_id, "Card not placed correctly");
    assert(
        board_after[cell_idx * 2 + 1] == current_player,
        "Owner not set correctly",
    );

    // ===== 7. Capture logic (FIX-2) =====
    // Determine the opponent
    let opponent: Field = if current_player == 1 { 2 } else { 1 };

    // Track which cells are captured (1 = captured, 0 = not)
    let mut captured: [bool; 9] = [false; 9];

    // Check all 4 adjacent directions:
    // Direction 0: Top    (row-1, col)   - placed card's top vs adjacent card's bottom
    // Direction 1: Right  (row, col+1)   - placed card's right vs adjacent card's left
    // Direction 2: Bottom (row+1, col)   - placed card's bottom vs adjacent card's top
    // Direction 3: Left   (row, col-1)   - placed card's left vs adjacent card's right

    // placed_card_ranks: [top, right, bottom, left]
    // adjacent ranks:    [top=0, right=1, bottom=2, left=3]
    // Facing rank pairs: placed_top vs adj_bottom, placed_right vs adj_left,
    //                    placed_bottom vs adj_top, placed_left vs adj_right

    // Direction 0: Top (row-1, col)
    if r > 0 {
        let adj_idx = (r - 1) * 3 + c;
        let adj_card_id = board_before[adj_idx * 2];
        let adj_owner = board_before[adj_idx * 2 + 1];
        if (adj_card_id != 0) & (adj_owner == opponent) {
            let adj_ranks = get_card_ranks(adj_card_id as u32);
            // Placed card's top vs adjacent card's bottom
            let placed_rank = placed_card_ranks[0] as u32;
            let adj_rank = adj_ranks[2] as u32;
            if placed_rank > adj_rank {
                captured[adj_idx] = true;
            }
        }
    }

    // Direction 1: Right (row, col+1)
    if c < 2 {
        let adj_idx = r * 3 + (c + 1);
        let adj_card_id = board_before[adj_idx * 2];
        let adj_owner = board_before[adj_idx * 2 + 1];
        if (adj_card_id != 0) & (adj_owner == opponent) {
            let adj_ranks = get_card_ranks(adj_card_id as u32);
            // Placed card's right vs adjacent card's left
            let placed_rank = placed_card_ranks[1] as u32;
            let adj_rank = adj_ranks[3] as u32;
            if placed_rank > adj_rank {
                captured[adj_idx] = true;
            }
        }
    }

    // Direction 2: Bottom (row+1, col)
    if r < 2 {
        let adj_idx = (r + 1) * 3 + c;
        let adj_card_id = board_before[adj_idx * 2];
        let adj_owner = board_before[adj_idx * 2 + 1];
        if (adj_card_id != 0) & (adj_owner == opponent) {
            let adj_ranks = get_card_ranks(adj_card_id as u32);
            // Placed card's bottom vs adjacent card's top
            let placed_rank = placed_card_ranks[2] as u32;
            let adj_rank = adj_ranks[0] as u32;
            if placed_rank > adj_rank {
                captured[adj_idx] = true;
            }
        }
    }

    // Direction 3: Left (row, col-1)
    if c > 0 {
        let adj_idx = r * 3 + (c - 1);
        let adj_card_id = board_before[adj_idx * 2];
        let adj_owner = board_before[adj_idx * 2 + 1];
        if (adj_card_id != 0) & (adj_owner == opponent) {
            let adj_ranks = get_card_ranks(adj_card_id as u32);
            // Placed card's left vs adjacent card's right
            let placed_rank = placed_card_ranks[3] as u32;
            let adj_rank = adj_ranks[1] as u32;
            if placed_rank > adj_rank {
                captured[adj_idx] = true;
            }
        }
    }

    // ===== 8. Verify board_after matches expected state =====
    // For each cell, verify:
    // - Placed cell: already verified above (card_id and owner)
    // - Captured cell: card_id unchanged, owner changed to current_player
    // - All other cells: identical to board_before
    for i in 0..9 {
        if i as u32 != cell_idx {
            let before_card = board_before[i * 2];
            let before_owner = board_before[i * 2 + 1];
            let after_card = board_after[i * 2];
            let after_owner = board_after[i * 2 + 1];

            // Card ID must never change for non-placed cells
            assert(after_card == before_card, "Non-placed cell card_id changed");

            if captured[i] {
                // Captured cell: owner must change to current_player
                assert(
                    after_owner == current_player,
                    "Captured cell owner not updated",
                );
            } else {
                // Non-captured cell: owner must stay the same
                assert(after_owner == before_owner, "Non-captured cell owner changed");
            }
        }
    }

    // ===== 9. Verify start_state_hash matches board_before =====
    let computed_start = hash_board_state(board_before, scores_before, current_turn_before);
    assert(computed_start == start_state_hash, "Start state hash mismatch");

    // ===== 10. Compute and verify end state =====
    let next_turn: Field = if current_player == 1 { 2 } else { 1 };
    let computed_end = hash_board_state(board_after, scores_after, next_turn);
    assert(computed_end == end_state_hash, "End state hash mismatch");

    // ===== 11. Verify game ended flag =====
    let mut filled: u32 = 0;
    for i in 0..9 {
        if board_after[i * 2] != 0 {
            filled += 1;
        }
    }

    if filled == 9 {
        assert(game_ended == 1, "Game should have ended");
        let p1_score = scores_after[0] as u32;
        let p2_score = scores_after[1] as u32;
        if p1_score > p2_score {
            assert(winner_id == 1, "Player 1 should be winner");
        } else if p2_score > p1_score {
            assert(winner_id == 2, "Player 2 should be winner");
        } else {
            assert(winner_id == 3, "Should be a draw");
        }
    } else {
        assert(game_ended == 0, "Game should not have ended");
        assert(winner_id == 0, "No winner yet");
    }

    // ===== 12. Verify scores are consistent =====
    let mut p1_board: u32 = 0;
    let mut p2_board: u32 = 0;
    for i in 0..9 {
        if board_after[i * 2 + 1] == 1 {
            p1_board += 1;
        } else if board_after[i * 2 + 1] == 2 {
            p2_board += 1;
        }
    }
    let expected_p1 = p1_board + player1_hand_count_after as u32;
    let expected_p2 = p2_board + player2_hand_count_after as u32;
    assert(scores_after[0] as u32 == expected_p1, "P1 score mismatch");
    assert(scores_after[1] as u32 == expected_p2, "P2 score mismatch");
}

// ====================== TEST HELPERS ======================

/// Helper: create a card_commit for test use
fn test_card_commit(
    player_secret: Field,
    player_address: Field,
    game_id: Field,
    card_ids: [Field; 5],
    card_ranks: [[Field; 4]; 5],
    nullifier_secrets: [Field; 5],
) -> Field {
    compute_card_commit(player_secret, player_address, game_id, card_ids, card_ranks, nullifier_secrets)
}

// Default hand data for Player 1 in tests: cards 1-5
// Geezard[1,4,1,5], Funguar[5,1,1,3], BiteBug[1,3,3,5], RedBat[6,1,1,2], Blobra[2,3,1,5]
global P1_SECRET: Field = 111;
global P1_ADDRESS: Field = 0xaaa;
global TEST_GAME_ID: Field = 1;

fn p1_card_ids() -> [Field; 5] { [1, 2, 3, 4, 5] }
fn p1_card_ranks() -> [[Field; 4]; 5] {
    [[1, 4, 1, 5], [5, 1, 1, 3], [1, 3, 3, 5], [6, 1, 1, 2], [2, 3, 1, 5]]
}
fn p1_nullifier_secrets() -> [Field; 5] { [100, 200, 300, 400, 500] }

// Default hand data for Player 2 in tests: cards 10-14
// Caterchipillar[4,3,2,4], Cockatrice[2,6,1,6], Grat[7,1,3,1], Buel[6,2,2,3], Mesmerize[5,3,3,4]
global P2_SECRET: Field = 222;
global P2_ADDRESS: Field = 0xbbb;

fn p2_card_ids() -> [Field; 5] { [10, 11, 12, 13, 14] }
fn p2_card_ranks() -> [[Field; 4]; 5] {
    [[4, 3, 2, 4], [2, 6, 1, 6], [7, 1, 3, 1], [6, 2, 2, 3], [5, 3, 3, 4]]
}
fn p2_nullifier_secrets() -> [Field; 5] { [600, 700, 800, 900, 1000] }

fn get_p1_commit() -> Field {
    test_card_commit(P1_SECRET, P1_ADDRESS, TEST_GAME_ID, p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets())
}

fn get_p2_commit() -> Field {
    test_card_commit(P2_SECRET, P2_ADDRESS, TEST_GAME_ID, p2_card_ids(), p2_card_ranks(), p2_nullifier_secrets())
}

// ====================== TESTS ======================

#[test]
fn test_first_move_no_capture() {
    // Player 1 places card 1 (Geezard) at (0,0) on empty board - no captures possible
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let board_before: [Field; 18] = [0; 18];
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1; // card_id = 1 (Geezard)
    board_after[1] = 1; // owner = player1
    let scores_after: [Field; 2] = [5, 5]; // 1 on board + 4 in hand = 5

    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,       // game not ended
        1,          // current_player
        1,          // card_id (Geezard)
        0, 0,       // row, col
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        4, 5,       // hand counts after
        // Player 1 hand data
        P1_SECRET, P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}

#[test]
fn test_second_move_no_capture() {
    // Player 2 places card 10 (Caterchipillar) at (1,1)
    // Player 1 has card 1 at (0,0). No adjacency to (1,1) diagonals don't count.
    // Actually (0,0) and (1,1) are diagonal, not adjacent. So no capture possible.
    // Wait - (0,0) is adjacent to (0,1) and (1,0), NOT to (1,1).
    // (1,1) is adjacent to (0,1), (1,0), (1,2), (2,1) - not (0,0).
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[0] = 1; // card at (0,0): card_id=1, owner=player1
    board_before[1] = 1;
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 2;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1;
    board_after[1] = 1;
    board_after[8] = 10; // card at (1,1): card_id=10, owner=player2
    board_after[9] = 2;
    let scores_after: [Field; 2] = [5, 5]; // p1: 1+4=5, p2: 1+4=5

    let end_hash = hash_board_state(board_after, scores_after, 1);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        2,          // current_player = player2
        10,         // card_id = Caterchipillar
        1, 1,       // row=1, col=1
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        4, 4,       // hand counts after
        // Player 2 hand data
        P2_SECRET, P2_ADDRESS, TEST_GAME_ID,
        p2_card_ids(), p2_card_ranks(), p2_nullifier_secrets(),
    );
}

#[test]
fn test_capture_one_card() {
    // Player 1 has card 1 (Geezard [1,4,1,5]) at (0,0)
    // Player 2 has card 10 (Caterchipillar [4,3,2,4]) at (0,1)
    // Player 1 places card 4 (Red Bat [6,1,1,2]) at (1,1)
    // (1,1) is adjacent to (0,1) - placed card's top=6 vs Caterchipillar's bottom=2 -> 6>2 CAPTURE!
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[0] = 1; board_before[1] = 1;   // (0,0) card 1, player 1
    board_before[2] = 10; board_before[3] = 2;  // (0,1) card 10, player 2
    let scores_before: [Field; 2] = [5, 5]; // p1: 1+4=5, p2: 1+4=5
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1; board_after[1] = 1;     // (0,0) unchanged
    board_after[2] = 10; board_after[3] = 1;    // (0,1) CAPTURED - owner changed to player 1
    board_after[8] = 4; board_after[9] = 1;     // (1,1) placed card 4, player 1
    // p1: 3 on board + 3 in hand = 6, p2: 0 on board + 4 in hand = 4
    let scores_after: [Field; 2] = [6, 4];

    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1,          // current_player
        4,          // card_id = Red Bat
        1, 1,       // row=1, col=1
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        3, 4,       // p1 hand: 3, p2 hand: 4
        P1_SECRET, P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}

#[test]
fn test_capture_multiple_cards() {
    // Set up: Player 2 has cards at (0,1), (1,0), and (1,2).
    // Player 1 places a strong card at (1,1) that captures multiple adjacent opponent cards.
    //
    // Player 1 places card 4 (Red Bat [top=6, right=1, bottom=1, left=2]) at (1,1)
    // Adjacent: (0,1) top, (1,2) right, (2,1) bottom, (1,0) left
    //
    // For multiple captures, we need placed card's facing ranks > adjacent's facing ranks.
    // placed top=6 vs (0,1) bottom, placed right=1 vs (1,2) left, etc.
    //
    // Actually let's use card 2 (Funguar [5,1,1,3]) for player 1 placed at (1,1):
    // - Top (0,1): Caterchipillar bottom=2 vs placed top=5 -> 5>2 CAPTURE
    // - Left (1,0): Cockatrice right=6 vs placed left=3 -> 3<6 NO CAPTURE
    // - Right (1,2): Grat left=1 vs placed right=1 -> 1=1 NO CAPTURE (must be strictly greater)
    //
    // Let's use card 5 (Blobra [2,3,1,5]) at (1,1):
    // Actually let me pick better. Use card 4 (Red Bat [6,1,1,2]) at (0,1):
    // - Right (0,2): opponent card, placed right=1
    // - Bottom (1,1): opponent card, placed bottom=1
    // - Left (0,0): opponent card, placed left=2
    // Hmm, Red Bat has weak right/bottom/left.
    //
    // Let me engineer the scenario differently.
    // Player 1 places card 3 (Bite Bug [1,3,3,5]) at (1,1)
    // Adjacent opponents:
    // (0,1): card 10 (Caterchipillar [4,3,2,4]) - placed top=1 vs adj bottom=2 -> NO
    // (1,0): card 13 (Buel [6,2,2,3]) - placed left=5 vs adj right=2 -> 5>2 CAPTURE!
    // (1,2): card 14 (Mesmerize [5,3,3,4]) - placed right=3 vs adj left=4 -> NO
    //
    // Only 1 capture. Let me try harder for multiple.
    //
    // Player 1 places card 4 (Red Bat [6,1,1,2]) at (1,0)
    // Adjacent:
    // (0,0): card 10 (Caterchipillar [4,3,2,4]) owned by P2 - placed top=6 vs adj bottom=2 -> 6>2 CAPTURE!
    // (1,1): card 13 (Buel [6,2,2,3]) owned by P2 - placed right=1 vs adj left=3 -> NO
    // (2,0): card 14 (Mesmerize [5,3,3,4]) owned by P2 - placed bottom=1 vs adj top=5 -> NO
    //
    // Still only 1. Let me use stronger cards.
    //
    // Player 1 hand: cards 1-5 with ranks:
    // 1: [1,4,1,5], 2: [5,1,1,3], 3: [1,3,3,5], 4: [6,1,1,2], 5: [2,3,1,5]
    //
    // These are weak cards. For multiple captures we need higher ranks.
    // But our test hands are fixed. Let me pick the best card.
    // Card 4 Red Bat has top=6, card 2 Funguar has top=5.
    //
    // Let me engineer it so that opponent's cards have low facing ranks.
    // Opponent cards 10-14:
    // 10: [4,3,2,4], 11: [2,6,1,6], 12: [7,1,3,1], 13: [6,2,2,3], 14: [5,3,3,4]
    //
    // I need opponent cards where the facing rank (toward placed card) is low.
    //
    // Place card 2 (Funguar [5,1,1,3]) at (1,1)
    // (0,1) has card 12 (Grat [7,1,3,1]) owned by P2: placed top=5 vs adj bottom=3 -> 5>3 CAPTURE!
    // (1,0) has card 11 (Cockatrice [2,6,1,6]) owned by P2: placed left=3 vs adj right=6 -> NO
    // (1,2) has card 13 (Buel [6,2,2,3]) owned by P2: placed right=1 vs adj left=3 -> NO
    // (2,1) has card 14 (Mesmerize [5,3,3,4]) owned by P2: placed bottom=1 vs adj top=5 -> NO
    //
    // Only 1 again. Let me try placing in a different position.
    //
    // Card 1 Geezard [1,4,1,5]. Left=5 is the strongest.
    // Place at (1,1). Adjacent (1,0) with opponent card whose right rank < 5.
    // Card 12 Grat right=1. 5>1 CAPTURE!
    // Also (0,1): placed top=1 vs adj bottom. Card 10 bottom=2. 1<2 NO.
    //
    // Let me try: Card 4 Red Bat [6,1,1,2] at center (1,1)
    // (0,1): Card 11 Cockatrice [2,6,1,6] - placed top=6 vs adj bottom=1 -> 6>1 CAPTURE!
    // (1,2): Card 12 Grat [7,1,3,1] - placed right=1 vs adj left=1 -> NO (equal)
    // (2,1): Card 13 Buel [6,2,2,3] - placed bottom=1 vs adj top=6 -> NO
    // (1,0): Card 10 Caterchipillar [4,3,2,4] - placed left=2 vs adj right=3 -> NO
    //
    // 1 capture. This is hard with weak hands. Let me rearrange to get 2 captures.
    //
    // I need to find a position and card where two facing ranks beat the opponents.
    //
    // Card 1 Geezard [1,4,1,5]:
    // right=4, left=5 are decent.
    // Place at (0,1).
    // (0,0): own card or empty
    // (0,2): card 12 Grat [7,1,3,1] P2 - placed right=4 vs adj left=1 -> 4>1 CAPTURE!
    // (1,1): card 10 Caterchipillar [4,3,2,4] P2 - placed bottom=1 vs adj top=4 -> NO
    //
    // Still hard. Let me use a scenario with already-placed P1 cards and strategically placed P2 cards.
    //
    // Actually, I can use the same player hand data but set up the board state so P2 cards have weak facing ranks.
    // The card database is fixed, so I pick P2 cards with weak ranks facing the placed card.
    //
    // Card 11 Cockatrice [2,6,1,6]: bottom=1 (weak)
    // Card 12 Grat [7,1,3,1]: left=1 (weak), right=1 (weak)
    //
    // Place P1 card 1 Geezard [1,4,1,5] at (1,1):
    // Top (0,1): Card 11 Cockatrice bottom=1 vs placed top=1 -> NO (equal)
    // Right (1,2): Card 12 Grat left=1 vs placed right=4 -> 4>1 CAPTURE!
    // Bottom (2,1): Card 13 Buel [6,2,2,3] top=6 vs placed bottom=1 -> NO
    // Left (1,0): Card 10 Caterchipillar right=3 vs placed left=5 -> 5>3 CAPTURE!
    //
    // TWO captures! (1,2) card 12 and (1,0) card 10.
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    // (0,1) = index 1: card 11, player 2
    board_before[2] = 11; board_before[3] = 2;
    // (1,0) = index 3: card 10, player 2
    board_before[6] = 10; board_before[7] = 2;
    // (1,2) = index 5: card 12, player 2
    board_before[10] = 12; board_before[11] = 2;
    // (2,1) = index 7: card 13, player 2
    board_before[14] = 13; board_before[15] = 2;
    // p1: 0 on board + 5 in hand = 5; p2: 4 on board + 1 in hand = 5
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    // (0,1) unchanged - no capture (equal ranks)
    board_after[2] = 11; board_after[3] = 2;
    // (1,0) CAPTURED by player 1
    board_after[6] = 10; board_after[7] = 1;
    // (1,1) placed card 1, player 1
    board_after[8] = 1; board_after[9] = 1;
    // (1,2) CAPTURED by player 1
    board_after[10] = 12; board_after[11] = 1;
    // (2,1) unchanged - no capture
    board_after[14] = 13; board_after[15] = 2;
    // p1: 3 on board + 4 in hand = 7; p2: 2 on board + 1 in hand = 3
    let scores_after: [Field; 2] = [7, 3];

    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1,          // current_player
        1,          // card_id = Geezard
        1, 1,       // row=1, col=1
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        4, 1,       // p1 hand: 4, p2 hand: 1
        P1_SECRET, P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}

#[test]
fn test_no_capture_higher_adjacent() {
    // P1 places card 5 (Blobra [2,3,1,5]) at (0,1).
    // Adjacent (0,0) has P2 card 12 (Grat [7,1,3,1]).
    // Placed left=5 vs Grat right=1 -> 5>1 would capture BUT wait...
    // Actually let's set it up so NO captures happen.
    //
    // P1 places card 1 (Geezard [1,4,1,5]) at (0,0)
    // (0,1) has P2 card 12 (Grat [7,1,3,1]). Placed right=4 vs adj left=1 -> 4>1 CAPTURE
    // That captures. Let me find a scenario with no captures.
    //
    // P1 places card 3 (Bite Bug [1,3,3,5]) at (2,2)
    // (2,1) has P2 card 12 (Grat [7,1,3,1]). Placed left=5 vs adj right=1 -> CAPTURE
    // (1,2) has P2 card 10 (Caterchipillar [4,3,2,4]). Placed top=1 vs adj bottom=2 -> NO
    //
    // Still captures. Let me use a weak card against strong opponents.
    //
    // P1 places card 9... wait, P1 only has cards 1-5.
    //
    // P1 card 5 Blobra [2,3,1,5] at (1,1)
    // (0,1): P2 card 14 Mesmerize [5,3,3,4]. Placed top=2 vs adj bottom=3 -> NO
    // (1,0): P2 card 13 Buel [6,2,2,3]. Placed left=5 vs adj right=2 -> CAPTURE!
    //
    // It keeps capturing. Let me just set up one adjacent opponent with high facing rank.
    //
    // P1 card 1 Geezard [1,4,1,5] at (0,0)
    // (0,1): P2 card 12 Grat [7,1,3,1]. Placed right=4 vs adj left=1 -> CAPTURE. No good.
    //
    // Fine, let me use opponents with high facing ranks.
    // P2 card 14 Mesmerize [5,3,3,4]. If I place to the left of it, placed right vs adj left=4.
    //
    // P1 card 3 Bite Bug [1,3,3,5] at (0,0). One adjacent at (0,1): P2 card 14.
    // Placed right=3 vs adj left=4. 3<4 -> NO capture.
    // (1,0): empty. Good.
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[2] = 14; board_before[3] = 2;   // (0,1) card 14 Mesmerize, P2
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 3; board_after[1] = 1;       // (0,0) card 3 placed by P1
    board_after[2] = 14; board_after[3] = 2;      // (0,1) unchanged
    let scores_after: [Field; 2] = [5, 5]; // p1: 1+4=5, p2: 1+4=5

    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1,
        3,          // card_id = Bite Bug
        0, 0,       // row=0, col=0
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        4, 4,
        P1_SECRET, P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}

#[test]
fn test_final_move_game_ends_p1_wins() {
    // Board with 8 cards placed; player 1 places the 9th card to complete the game.
    // We need all cards on board to be from hands 1-5 and 10-14.
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    // P1 cards: 1,2,3,4 placed. P2 cards: 10,11,12,13 placed.
    board_before[0] = 1; board_before[1] = 1;    // (0,0) P1
    board_before[2] = 10; board_before[3] = 2;   // (0,1) P2
    board_before[4] = 2; board_before[5] = 1;    // (0,2) P1
    board_before[6] = 11; board_before[7] = 2;   // (1,0) P2
    board_before[8] = 3; board_before[9] = 1;    // (1,1) P1
    board_before[10] = 12; board_before[11] = 1; // (1,2) P2 card 12 captured by P1
    board_before[12] = 4; board_before[13] = 1;  // (2,0) P1
    board_before[14] = 13; board_before[15] = 2; // (2,1) P2
    // (2,2) empty - P1 will place card 5 here

    // p1: 5 on board + 1 in hand = 6; p2: 2 on board + 1 in hand = 3
    // Wait, scores should add up to 10. 6+3=9? No. Each player starts with 5 cards.
    // 8 cards on board + 1 in P1 hand + 1 in P2 hand = 10. Good.
    // P1 on board: 5 (cards 1,2,3,12,4). P2 on board: 3 (cards 10,11,13). Total: 8.
    // Wait that's only 8 cards. P1 has 1 in hand (card 5). P2 has 1 in hand (card 14).
    // P1 score = 5 + 1 = 6. P2 score = 3 + 1 = 4.
    let scores_before: [Field; 2] = [6, 4];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    for i in 0..16 {
        board_after[i] = board_before[i];
    }
    // Place card 5 (Blobra [2,3,1,5]) at (2,2)
    board_after[16] = 5;
    board_after[17] = 1;

    // Check captures: (2,2) adjacent to (2,1) and (1,2)
    // (2,1) card 13 Buel [6,2,2,3], P2. Placed left=5 vs adj right=2 -> 5>2 CAPTURE!
    // (1,2) card 12, already P1. No capture (own card).
    // So (2,1) gets captured.
    board_after[15] = 1; // (2,1) now owned by P1

    // P1: 7 on board + 0 in hand = 7. P2: 1 on board + 1 in hand = 2.
    // Wait, P2 has card 14 in hand still, and cards 10, 11 on board (2 cards).
    // Actually after capture: P1 has 1,2,3,12,4,5,13 on board = 7. P2 has 10,11 on board = 2.
    // P1 hand: 0. P2 hand: 1 (card 14).
    // P1 score: 7. P2 score: 3.
    let scores_after: [Field; 2] = [7, 3];

    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        1, 1,       // game ended, player 1 wins
        1,          // current_player
        5,          // card_id = Blobra
        2, 2,       // row=2, col=2
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        0, 1,       // P1 hand: 0, P2 hand: 1
        P1_SECRET, P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}

#[test]
fn test_game_ends_draw() {
    // For a draw: P1 score == P2 score after all 9 cards placed.
    // P1 places 5 cards, P2 places 4. P2 has 1 card left in hand.
    // For draw: P1 on board + 0 == P2 on board + 1
    // So P1 on board = P2 on board + 1.
    // With 9 on board: P1_board + P2_board = 9. P1_board = P2_board + 1.
    // 2*P2_board + 1 = 9, P2_board = 4, P1_board = 5.
    // P1 score = 5, P2 score = 4 + 1 = 5 -> DRAW!
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[0] = 1; board_before[1] = 1;    // (0,0) P1
    board_before[2] = 10; board_before[3] = 2;   // (0,1) P2
    board_before[4] = 2; board_before[5] = 1;    // (0,2) P1
    board_before[6] = 11; board_before[7] = 2;   // (1,0) P2
    board_before[8] = 3; board_before[9] = 1;    // (1,1) P1
    board_before[10] = 12; board_before[11] = 2; // (1,2) P2
    board_before[12] = 4; board_before[13] = 1;  // (2,0) P1
    board_before[14] = 13; board_before[15] = 2; // (2,1) P2
    // (2,2) empty
    // P1: 4 on board + 1 in hand = 5. P2: 4 on board + 1 in hand = 5.
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let _start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    for i in 0..16 {
        board_after[i] = board_before[i];
    }
    // Place card 5 (Blobra [2,3,1,5]) at (2,2)
    board_after[16] = 5;
    board_after[17] = 1;
    // Check captures: (2,2) adjacent to (2,1) and (1,2)
    // (2,1) card 13 Buel [6,2,2,3], P2. Placed left=5 vs adj right=2 -> 5>2 CAPTURE!
    // (1,2) card 12 Grat [7,1,3,1], P2. Placed top... wait (2,2) top is (1,2).
    // Actually no: for cell (2,2), the adjacent cells are:
    // Top: (1,2), Right: out of bounds, Bottom: out of bounds, Left: (2,1)
    // (1,2) card 12 Grat. Placed top=2 vs adj bottom=3 -> 2<3 NO capture.
    // (2,1) card 13 Buel. Placed left=5 vs adj right=2 -> 5>2 CAPTURE!
    // So 1 capture at (2,1).
    board_after[15] = 1; // (2,1) captured

    // P1: 5+1=6 on board. P2: 3 on board. P1 hand: 0. P2 hand: 1.
    // P1 score: 6. P2 score: 4. NOT a draw.
    // To get a draw, I need no captures on the final move.
    // Let me rearrange so no adjacent P2 cards have weak facing ranks.

    // Actually let me just put P1 card in a corner where adjacent P2 cards have strong facing ranks.
    // Place card 5 (Blobra [2,3,1,5]) at (2,2). Adjacent: (1,2) top, (2,1) left.
    // Need adj bottom > 2 for (1,2) and adj right > 5 for (2,1).
    // Card 12 Grat bottom=3 > 2: OK no capture.
    // For (2,1) I need card with right > 5. Card 11 Cockatrice right=6 > 5: no capture!

    // Redo with different board layout:
    let mut board_before2: [Field; 18] = [0; 18];
    board_before2[0] = 1; board_before2[1] = 1;    // (0,0) P1
    board_before2[2] = 10; board_before2[3] = 2;   // (0,1) P2
    board_before2[4] = 2; board_before2[5] = 1;    // (0,2) P1
    board_before2[6] = 13; board_before2[7] = 2;   // (1,0) P2
    board_before2[8] = 3; board_before2[9] = 1;    // (1,1) P1
    board_before2[10] = 12; board_before2[11] = 2; // (1,2) P2
    board_before2[12] = 4; board_before2[13] = 1;  // (2,0) P1
    board_before2[14] = 11; board_before2[15] = 2; // (2,1) P2 - Cockatrice [2,6,1,6]
    // P1: 4 on board + 1 in hand = 5. P2: 4 on board + 1 in hand = 5.
    let scores_before2: [Field; 2] = [5, 5];
    let current_turn_before2: Field = 1;
    let start_hash2 = hash_board_state(board_before2, scores_before2, current_turn_before2);

    let mut board_after2: [Field; 18] = [0; 18];
    for i in 0..16 {
        board_after2[i] = board_before2[i];
    }
    board_after2[16] = 5;  // Blobra at (2,2)
    board_after2[17] = 1;
    // (1,2) card 12 Grat: placed top=2 vs adj bottom=3 -> NO
    // (2,1) card 11 Cockatrice: placed left=5 vs adj right=6 -> NO
    // No captures! P1: 5 on board + 0 hand = 5. P2: 4 on board + 1 hand = 5 -> DRAW!
    let scores_after2: [Field; 2] = [5, 5];
    let end_hash2 = hash_board_state(board_after2, scores_after2, 2);

    main(
        cc1, cc2,
        start_hash2, end_hash2,
        1, 3,       // game ended, draw
        1,
        5,          // Blobra
        2, 2,
        board_before2, board_after2,
        scores_before2, scores_after2,
        current_turn_before2,
        0, 1,       // P1 hand: 0, P2 hand: 1
        P1_SECRET, P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}

// ====================== FAILURE TESTS ======================

#[test(should_fail_with = "Cell not empty")]
fn test_fail_place_on_occupied_cell() {
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[0] = 10; // card at (0,0)
    board_before[1] = 2;  // owned by player2
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1;
    board_after[1] = 1;
    let scores_after: [Field; 2] = [5, 5];
    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1, 1,       // card_id = 1
        0, 0,       // (0,0) is occupied
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        4, 5,
        P1_SECRET, P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}

#[test(should_fail_with = "Not this player's turn")]
fn test_fail_wrong_player_turn() {
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let board_before: [Field; 18] = [0; 18];
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1; // P1's turn

    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 10;
    board_after[1] = 2;
    let scores_after: [Field; 2] = [5, 5];
    let end_hash = hash_board_state(board_after, scores_after, 1);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        2,          // P2 trying to play on P1's turn
        10,
        0, 0,
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        5, 4,
        P2_SECRET, P2_ADDRESS, TEST_GAME_ID,
        p2_card_ids(), p2_card_ranks(), p2_nullifier_secrets(),
    );
}

#[test(should_fail_with = "Row out of bounds")]
fn test_fail_row_out_of_bounds() {
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let board_before: [Field; 18] = [0; 18];
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);
    let end_hash = start_hash;

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1, 1,
        3, 0,       // row=3 out of bounds
        board_before, board_before,
        scores_before, scores_before,
        current_turn_before,
        4, 5,
        P1_SECRET, P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}

#[test(should_fail_with = "Placed card not in committed hand")]
fn test_fail_card_not_in_hand() {
    // Try to place card 20 which is not in P1's hand (cards 1-5)
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let board_before: [Field; 18] = [0; 18];
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 20;
    board_after[1] = 1;
    let scores_after: [Field; 2] = [5, 5];
    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1, 20,      // card 20 not in P1's hand
        0, 0,
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        4, 5,
        P1_SECRET, P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}

#[test(should_fail_with = "Player 1 card commit mismatch")]
fn test_fail_wrong_player_secret() {
    // Use wrong secret to generate commitment
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let board_before: [Field; 18] = [0; 18];
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1;
    board_after[1] = 1;
    let scores_after: [Field; 2] = [5, 5];
    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1, 1,
        0, 0,
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        4, 5,
        999,        // WRONG player secret
        P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}

#[test(should_fail_with = "Non-captured cell owner changed")]
fn test_fail_false_capture() {
    // Set up: P1 places card 3 (Bite Bug [1,3,3,5]) at (0,0)
    // (0,1) has P2 card 14 (Mesmerize [5,3,3,4]).
    // Placed right=3 vs adj left=4. 3<4 -> NO capture.
    // But board_after claims capture happened (invalid).
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[2] = 14; board_before[3] = 2;   // (0,1) Mesmerize, P2
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 3; board_after[1] = 1;       // (0,0) placed
    board_after[2] = 14; board_after[3] = 1;      // (0,1) FALSE CAPTURE
    let scores_after: [Field; 2] = [6, 4];
    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1, 3,
        0, 0,
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        4, 4,
        P1_SECRET, P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}

#[test(should_fail_with = "Captured cell owner not updated")]
fn test_fail_missing_capture() {
    // P1 places card 4 (Red Bat [6,1,1,2]) at (1,1)
    // (0,1) has P2 card 11 (Cockatrice [2,6,1,6]).
    // Placed top=6 vs adj bottom=1 -> 6>1 SHOULD CAPTURE.
    // But board_after does NOT capture (invalid).
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[2] = 11; board_before[3] = 2;   // (0,1) Cockatrice, P2
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[2] = 11; board_after[3] = 2;      // (0,1) NOT captured (WRONG!)
    board_after[8] = 4; board_after[9] = 1;       // (1,1) placed
    let scores_after: [Field; 2] = [5, 5];
    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1, 4,
        1, 1,
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        4, 4,
        P1_SECRET, P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}

#[test(should_fail_with = "Non-placed cell card_id changed")]
fn test_fail_card_id_changed() {
    // P1 places card 1 at (0,0). But board_after changes card_id at (0,1) too.
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[2] = 14; board_before[3] = 2;   // (0,1) Mesmerize, P2
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1; board_after[1] = 1;       // (0,0) placed
    board_after[2] = 99; board_after[3] = 2;      // (0,1) card_id CHANGED (invalid!)
    let scores_after: [Field; 2] = [5, 5];
    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1, 1,
        0, 0,
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        4, 4,
        P1_SECRET, P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}

#[test]
fn test_player2_move_with_capture() {
    // P2 places card 12 (Grat [7,1,3,1]) at (1,0)
    // (0,0) has P1 card 1 (Geezard [1,4,1,5]).
    // Placed top=7 vs adj bottom=1 -> 7>1 CAPTURE!
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[0] = 1; board_before[1] = 1;    // (0,0) Geezard, P1
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 2;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1; board_after[1] = 2;      // (0,0) CAPTURED by P2
    board_after[6] = 12; board_after[7] = 2;     // (1,0) placed by P2
    // P1: 0 on board + 4 in hand = 4. P2: 2 on board + 4 in hand = 6.
    let scores_after: [Field; 2] = [4, 6];

    let end_hash = hash_board_state(board_after, scores_after, 1);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        2,          // P2's turn
        12,         // Grat
        1, 0,       // (1,0)
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        4, 4,
        P2_SECRET, P2_ADDRESS, TEST_GAME_ID,
        p2_card_ids(), p2_card_ranks(), p2_nullifier_secrets(),
    );
}

#[test]
fn test_equal_ranks_no_capture() {
    // Equal ranks should NOT cause capture (must be strictly greater).
    // P1 places card 2 (Funguar [5,1,1,3]) at (0,0).
    // (0,1) has P2 card 14 (Mesmerize [5,3,3,4]).
    // Placed right=1 vs adj left=4. 1<4 -> NO capture (also not equal).
    //
    // For an equal test: P1 card 1 (Geezard right=4) at (0,0), (0,1) has P2 card 10 (Caterchipillar left=4).
    // 4 == 4 -> NO capture.
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[2] = 10; board_before[3] = 2;   // (0,1) Caterchipillar [4,3,2,4], P2
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1; board_after[1] = 1;       // (0,0) Geezard placed
    board_after[2] = 10; board_after[3] = 2;      // (0,1) NOT captured (equal ranks)
    // P1: 1 + 4 = 5. P2: 1 + 4 = 5.
    let scores_after: [Field; 2] = [5, 5];

    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1, 1,       // Geezard
        0, 0,       // (0,0)
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        4, 4,
        P1_SECRET, P1_ADDRESS, TEST_GAME_ID,
        p1_card_ids(), p1_card_ranks(), p1_nullifier_secrets(),
    );
}
