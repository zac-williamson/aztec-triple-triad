/// Game Move circuit.
/// Proves that a game move is valid: one card placed from correct player,
/// board state correctly updated with capture logic.
///
/// Public inputs:
///   card_commit_1, card_commit_2 - player card commitments (poseidon2 hash)
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

use poseidon::poseidon2::Poseidon2;

// ====================== CARD DATABASE ======================
/// Hardcoded card rank database: 50 cards with ranks [top, right, bottom, left].
fn get_card_ranks(card_id: u32) -> [Field; 4] {
    assert((card_id >= 1) & (card_id <= 50), "Invalid card ID for rank lookup");

    // Level 1 - Common (IDs 1-10)
    if card_id == 1 { [1, 4, 1, 5] }         // Mudwalker
    else if card_id == 2 { [5, 1, 1, 3] }    // Blushy
    else if card_id == 3 { [1, 3, 3, 5] }    // Snowdrop
    else if card_id == 4 { [6, 1, 1, 2] }    // Sunny
    else if card_id == 5 { [2, 3, 1, 5] }    // Inkwell
    else if card_id == 6 { [2, 1, 4, 4] }    // Stripes
    else if card_id == 7 { [1, 5, 4, 1] }    // Barkeeper
    else if card_id == 8 { [3, 1, 5, 2] }    // Dotty
    else if card_id == 9 { [2, 1, 6, 1] }    // Penny
    else if card_id == 10 { [4, 3, 2, 4] }   // Peaches
    // Level 2 - Uncommon (IDs 11-20)
    else if card_id == 11 { [2, 6, 1, 6] }   // Freckles
    else if card_id == 12 { [7, 1, 3, 1] }   // Camo
    else if card_id == 13 { [6, 2, 2, 3] }   // Neon
    else if card_id == 14 { [5, 3, 3, 4] }   // Glow Bug
    else if card_id == 15 { [6, 1, 4, 3] }   // Limelight
    else if card_id == 16 { [3, 4, 5, 3] }   // Marble
    else if card_id == 17 { [5, 3, 2, 5] }   // Sapphire
    else if card_id == 18 { [5, 1, 3, 5] }   // Jefferson
    else if card_id == 19 { [5, 2, 5, 2] }   // Longfoot
    else if card_id == 20 { [4, 2, 4, 5] }   // Featherfin
    // Level 3 - Rare (IDs 21-30)
    else if card_id == 21 { [3, 7, 2, 5] }   // Lilac
    else if card_id == 22 { [5, 2, 5, 5] }   // Patches
    else if card_id == 23 { [6, 6, 3, 3] }   // Faded
    else if card_id == 24 { [6, 3, 6, 3] }   // Gold Dust
    else if card_id == 25 { [3, 5, 5, 5] }   // Phantom
    else if card_id == 26 { [7, 5, 1, 3] }   // Ash
    else if card_id == 27 { [7, 1, 5, 3] }   // Cocoa
    else if card_id == 28 { [5, 3, 6, 3] }   // Ringmaster
    else if card_id == 29 { [5, 6, 2, 4] }   // Goldrush
    else if card_id == 30 { [4, 4, 7, 2] }   // Swampling
    // Level 4 - Epic (IDs 31-40)
    else if card_id == 31 { [3, 6, 4, 7] }   // Glitter
    else if card_id == 32 { [7, 2, 3, 7] }   // Starfield
    else if card_id == 33 { [2, 3, 7, 7] }   // Specter
    else if card_id == 34 { [6, 5, 5, 5] }   // Saffron
    else if card_id == 35 { [4, 7, 6, 2] }   // Stardust
    else if card_id == 36 { [2, 3, 7, 8] }   // Achoque
    else if card_id == 37 { [1, 7, 6, 4] }   // Zacapu
    else if card_id == 38 { [7, 3, 1, 6] }   // Laguna
    else if card_id == 39 { [7, 4, 4, 4] }   // Streamwalker
    else if card_id == 40 { [3, 7, 3, 6] }   // Digger
    // Level 5 - Legendary (IDs 41-50)
    else if card_id == 41 { [6, 7, 3, 7] }   // Eclipse
    else if card_id == 42 { [6, 5, 8, 4] }   // Kaleidoscope
    else if card_id == 43 { [6, 5, 6, 6] }   // Twinned
    else if card_id == 44 { [3, 6, 7, 8] }   // Sparkletail
    else if card_id == 45 { [7, 6, 5, 6] }   // Riddler
    else if card_id == 46 { [3, 10, 2, 1] }  // Rosita
    else if card_id == 47 { [6, 2, 6, 7] }   // Brooklet
    else if card_id == 48 { [5, 5, 7, 6] }   // Whisper
    else if card_id == 49 { [7, 7, 4, 2] }   // Misty
    else { [7, 2, 7, 4] }                    // Lerma (50)
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
    // Private inputs - current player's hand commitment data
    player_card_ids: [Field; 5],
    blinding_factor: Field,
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

    // ===== 3. Verify card_commit binding =====
    // Recompute the current player's card_commit from their hand data
    let mut to_hash: [Field; 6] = [0; 6];
    for i in 0..5 {
        to_hash[i] = player_card_ids[i];
    }
    to_hash[5] = blinding_factor;
    let recomputed_commit = Poseidon2::hash(to_hash, 6);

    // Verify it matches the correct card_commit (1 or 2 based on current_player)
    if current_player == 1 {
        assert(recomputed_commit == card_commit_1, "Player 1 card commit mismatch");
    } else {
        assert(recomputed_commit == card_commit_2, "Player 2 card commit mismatch");
    }

    // ===== 4. Verify placed card is in committed hand =====
    let mut card_found: bool = false;
    for i in 0..5 {
        if player_card_ids[i] == card_id {
            card_found = true;
        }
    }
    assert(card_found, "Placed card not in committed hand");

    // ===== NEW: Verify card has not already been placed (C2 fix) =====
    for i in 0..9 {
        if board_before[i * 2 + 1] != 0 {
            // Cell is occupied -- verify it's not the same card
            assert(board_before[i * 2] != card_id, "Card already placed on board");
        }
    }

    // Look up placed card ranks from database
    let placed_card_ranks = get_card_ranks(card_id as u32);

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

    // ===== 7. Capture logic =====
    // Determine the opponent
    let opponent: Field = if current_player == 1 { 2 } else { 1 };

    // Track which cells are captured (1 = captured, 0 = not)
    let mut captured: [bool; 9] = [false; 9];

    // Check all 4 adjacent directions:
    // placed_card_ranks: [top, right, bottom, left]

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

    // ===== 12. Verify scores are exactly correct (C1 fix) =====
    let mut p1_board: u32 = 0;
    let mut p2_board: u32 = 0;
    for i in 0..9 {
        let owner = board_after[i * 2 + 1];
        if owner == 1 {
            p1_board += 1;
        } else if owner == 2 {
            p2_board += 1;
        }
    }
    // Player 1 goes first, so P1 has placed ceil(filled/2) cards, P2 has placed floor(filled/2)
    let p1_played = (filled + 1) / 2;
    let p2_played = filled / 2;
    let p1_hand = 5 - p1_played;
    let p2_hand = 5 - p2_played;
    let expected_p1_score = p1_board + p1_hand;
    let expected_p2_score = p2_board + p2_hand;
    assert(scores_after[0] == expected_p1_score as Field, "P1 score mismatch");
    assert(scores_after[1] == expected_p2_score as Field, "P2 score mismatch");
}

// ====================== TEST HELPERS ======================

/// Helper: create a card_commit for test use (poseidon2)
fn test_card_commit(card_ids: [Field; 5], blinding_factor: Field) -> Field {
    let mut to_hash: [Field; 6] = [0; 6];
    for i in 0..5 {
        to_hash[i] = card_ids[i];
    }
    to_hash[5] = blinding_factor;
    Poseidon2::hash(to_hash, 6)
}

// Default hand data for Player 1 in tests: cards 1-5
// Mudwalker[1,4,1,5], Blushy[5,1,1,3], Snowdrop[1,3,3,5], Sunny[6,1,1,2], Inkwell[2,3,1,5]
global P1_BLINDING: Field = 111;

fn p1_card_ids() -> [Field; 5] { [1, 2, 3, 4, 5] }

// Default hand data for Player 2 in tests: cards 10-14
// Peaches[4,3,2,4], Freckles[2,6,1,6], Camo[7,1,3,1], Neon[6,2,2,3], Glow Bug[5,3,3,4]
global P2_BLINDING: Field = 222;

fn p2_card_ids() -> [Field; 5] { [10, 11, 12, 13, 14] }

fn get_p1_commit() -> Field {
    test_card_commit(p1_card_ids(), P1_BLINDING)
}

fn get_p2_commit() -> Field {
    test_card_commit(p2_card_ids(), P2_BLINDING)
}

// ====================== TESTS ======================

#[test]
fn test_first_move_no_capture() {
    // Player 1 places card 1 (Mudwalker) at (0,0) on empty board - no captures possible
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let board_before: [Field; 18] = [0; 18];
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1; // card_id = 1 (Mudwalker)
    board_after[1] = 1; // owner = player1
    let scores_after: [Field; 2] = [5, 5]; // 1 on board + 4 in hand = 5

    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,       // game not ended
        1,          // current_player
        1,          // card_id (Mudwalker)
        0, 0,       // row, col
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        p1_card_ids(), P1_BLINDING,
    );
}

#[test]
fn test_second_move_no_capture() {
    // Player 2 places card 10 (Peaches) at (1,1)
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
        10,         // card_id = Peaches
        1, 1,       // row=1, col=1
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        p2_card_ids(), P2_BLINDING,
    );
}

#[test]
fn test_capture_one_card() {
    // Player 1 has card 1 (Mudwalker [1,4,1,5]) at (0,0)
    // Player 2 has card 10 (Peaches [4,3,2,4]) at (0,1)
    // Player 1 places card 4 (Sunny [6,1,1,2]) at (1,1)
    // (1,1) is adjacent to (0,1) - placed card's top=6 vs Peaches's bottom=2 -> 6>2 CAPTURE!
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[0] = 1; board_before[1] = 1;   // (0,0) card 1, player 1
    board_before[2] = 10; board_before[3] = 2;  // (0,1) card 10, player 2
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1; board_after[1] = 1;     // (0,0) unchanged
    board_after[2] = 10; board_after[3] = 1;    // (0,1) CAPTURED - owner changed to player 1
    board_after[8] = 4; board_after[9] = 1;     // (1,1) placed card 4, player 1
    let scores_after: [Field; 2] = [6, 4];

    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1,          // current_player
        4,          // card_id = Sunny
        1, 1,       // row=1, col=1
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        p1_card_ids(), P1_BLINDING,
    );
}

#[test]
fn test_capture_multiple_cards() {
    // P1 places card 1 Mudwalker [1,4,1,5] at (1,1):
    // Right (1,2): Card 12 Camo left=1 vs placed right=4 -> 4>1 CAPTURE!
    // Left (1,0): Card 10 Peaches right=3 vs placed left=5 -> 5>3 CAPTURE!
    // Top (0,1): Card 11 Freckles bottom=1 vs placed top=1 -> NO (equal)
    // Bottom (2,1): Card 13 Neon top=6 vs placed bottom=1 -> NO
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[2] = 11; board_before[3] = 2;   // (0,1) Freckles
    board_before[6] = 10; board_before[7] = 2;   // (1,0) Peaches
    board_before[10] = 12; board_before[11] = 2; // (1,2) Camo
    board_before[14] = 13; board_before[15] = 2; // (2,1) Neon
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[2] = 11; board_after[3] = 2;     // (0,1) unchanged
    board_after[6] = 10; board_after[7] = 1;     // (1,0) CAPTURED
    board_after[8] = 1; board_after[9] = 1;      // (1,1) placed
    board_after[10] = 12; board_after[11] = 1;   // (1,2) CAPTURED
    board_after[14] = 13; board_after[15] = 2;   // (2,1) unchanged
    // filled=5, p1_board=3, p2_board=2, p1_played=3, p2_played=2
    // p1_score = 3 + (5-3) = 5, p2_score = 2 + (5-2) = 5
    let scores_after: [Field; 2] = [5, 5];

    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1,
        1,          // card_id = Mudwalker
        1, 1,
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        p1_card_ids(), P1_BLINDING,
    );
}

#[test]
fn test_no_capture_higher_adjacent() {
    // P1 card 3 Snowdrop [1,3,3,5] at (0,0). (0,1) has P2 card 14 Glow Bug [5,3,3,4].
    // Placed right=3 vs adj left=4. 3<4 -> NO capture.
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[2] = 14; board_before[3] = 2;
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 3; board_after[1] = 1;
    board_after[2] = 14; board_after[3] = 2;
    let scores_after: [Field; 2] = [5, 5];

    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1,
        3,
        0, 0,
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        p1_card_ids(), P1_BLINDING,
    );
}

#[test]
fn test_final_move_game_ends_p1_wins() {
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[0] = 1; board_before[1] = 1;
    board_before[2] = 10; board_before[3] = 2;
    board_before[4] = 2; board_before[5] = 1;
    board_before[6] = 11; board_before[7] = 2;
    board_before[8] = 3; board_before[9] = 1;
    board_before[10] = 12; board_before[11] = 1;
    board_before[12] = 4; board_before[13] = 1;
    board_before[14] = 13; board_before[15] = 2;

    let scores_before: [Field; 2] = [6, 4];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    for i in 0..16 {
        board_after[i] = board_before[i];
    }
    board_after[16] = 5;
    board_after[17] = 1;
    // (2,1) card 13 Neon: placed left=5 vs adj right=2 -> 5>2 CAPTURE!
    board_after[15] = 1;

    let scores_after: [Field; 2] = [7, 3];

    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        1, 1,       // game ended, player 1 wins
        1,
        5,
        2, 2,
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        p1_card_ids(), P1_BLINDING,
    );
}

#[test]
fn test_game_ends_draw() {
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    // Board where no captures happen on final move -> draw
    let mut board_before2: [Field; 18] = [0; 18];
    board_before2[0] = 1; board_before2[1] = 1;
    board_before2[2] = 10; board_before2[3] = 2;
    board_before2[4] = 2; board_before2[5] = 1;
    board_before2[6] = 13; board_before2[7] = 2;
    board_before2[8] = 3; board_before2[9] = 1;
    board_before2[10] = 12; board_before2[11] = 2;
    board_before2[12] = 4; board_before2[13] = 1;
    board_before2[14] = 11; board_before2[15] = 2; // Freckles [2,6,1,6]
    let scores_before2: [Field; 2] = [5, 5];
    let current_turn_before2: Field = 1;
    let start_hash2 = hash_board_state(board_before2, scores_before2, current_turn_before2);

    let mut board_after2: [Field; 18] = [0; 18];
    for i in 0..16 {
        board_after2[i] = board_before2[i];
    }
    board_after2[16] = 5;  // Inkwell at (2,2)
    board_after2[17] = 1;
    // (1,2) card 12 Camo: placed top=2 vs adj bottom=3 -> NO
    // (2,1) card 11 Freckles: placed left=5 vs adj right=6 -> NO
    let scores_after2: [Field; 2] = [5, 5];
    let end_hash2 = hash_board_state(board_after2, scores_after2, 2);

    main(
        cc1, cc2,
        start_hash2, end_hash2,
        1, 3,       // game ended, draw
        1,
        5,
        2, 2,
        board_before2, board_after2,
        scores_before2, scores_after2,
        current_turn_before2,
        p1_card_ids(), P1_BLINDING,
    );
}

#[test]
fn test_final_move_game_ends_p2_wins() {
    // P2 places the 9th card and wins with a higher score
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    // Row 0: P1 card 1, P2 card 10, P1 card 2
    board_before[0] = 1; board_before[1] = 1;    // (0,0) Mudwalker P1
    board_before[2] = 10; board_before[3] = 2;   // (0,1) Peaches P2
    board_before[4] = 2; board_before[5] = 1;    // (0,2) Blushy P1
    // Row 1: P2 card 11, P2 card 12, P1 card 3
    board_before[6] = 11; board_before[7] = 2;   // (1,0) Freckles P2
    board_before[8] = 12; board_before[9] = 2;   // (1,1) Camo P2
    board_before[10] = 3; board_before[11] = 1;  // (1,2) Snowdrop P1
    // Row 2: P2 card 13, P1 card 5, empty (2,2)
    board_before[12] = 13; board_before[13] = 2; // (2,0) Neon P2
    board_before[14] = 5; board_before[15] = 1;  // (2,1) Inkwell P1

    // Scores: P1 has 4 on board + 1 in hand = 5, P2 has 4 on board + 1 in hand = 5
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 2; // P2's turn
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    for i in 0..16 {
        board_after[i] = board_before[i];
    }
    // P2 places card 14 (Glow Bug [5,3,3,4]) at (2,2)
    board_after[16] = 14; board_after[17] = 2;

    // Check captures:
    // (1,2) Snowdrop P1 [1,3,3,5]: placed top=5 vs adj bottom=3 -> 5>3 CAPTURE!
    board_after[11] = 2; // Snowdrop captured by P2
    // (2,1) Inkwell P1 [2,3,1,5]: placed left=4 vs adj right=3 -> 4>3 CAPTURE!
    board_after[15] = 2; // Inkwell captured by P2

    // filled=9, p1_board=2, p2_board=7, p1_played=5, p2_played=4
    // p1_score = 2 + (5-5) = 2, p2_score = 7 + (5-4) = 8
    let scores_after: [Field; 2] = [2, 8];

    let end_hash = hash_board_state(board_after, scores_after, 1);

    main(
        cc1, cc2,
        start_hash, end_hash,
        1, 2,       // game ended, player 2 wins
        2,          // current_player = P2
        14,         // card_id = Glow Bug
        2, 2,       // row=2, col=2
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        p2_card_ids(), P2_BLINDING,
    );
}

// ====================== FAILURE TESTS ======================

#[test(should_fail_with = "Cell not empty")]
fn test_fail_place_on_occupied_cell() {
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[0] = 10;
    board_before[1] = 2;
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
        0, 0,       // (0,0) is occupied
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        p1_card_ids(), P1_BLINDING,
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
        p2_card_ids(), P2_BLINDING,
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
        p1_card_ids(), P1_BLINDING,
    );
}

#[test(should_fail_with = "Placed card not in committed hand")]
fn test_fail_card_not_in_hand() {
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
        p1_card_ids(), P1_BLINDING,
    );
}

#[test(should_fail_with = "Player 1 card commit mismatch")]
fn test_fail_wrong_blinding_factor() {
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
        p1_card_ids(),
        999,        // WRONG blinding factor
    );
}

#[test(should_fail_with = "Non-captured cell owner changed")]
fn test_fail_false_capture() {
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[2] = 14; board_before[3] = 2;
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 3; board_after[1] = 1;
    board_after[2] = 14; board_after[3] = 1;      // FALSE CAPTURE
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
        p1_card_ids(), P1_BLINDING,
    );
}

#[test(should_fail_with = "Captured cell owner not updated")]
fn test_fail_missing_capture() {
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[2] = 11; board_before[3] = 2;
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[2] = 11; board_after[3] = 2;      // NOT captured (WRONG!)
    board_after[8] = 4; board_after[9] = 1;
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
        p1_card_ids(), P1_BLINDING,
    );
}

#[test(should_fail_with = "Non-placed cell card_id changed")]
fn test_fail_card_id_changed() {
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[2] = 14; board_before[3] = 2;
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1; board_after[1] = 1;
    board_after[2] = 99; board_after[3] = 2;      // card_id CHANGED
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
        p1_card_ids(), P1_BLINDING,
    );
}

#[test]
fn test_player2_move_with_capture() {
    // P2 places card 12 (Camo [7,1,3,1]) at (1,0)
    // (0,0) has P1 card 1 (Mudwalker [1,4,1,5]).
    // Placed top=7 vs adj bottom=1 -> 7>1 CAPTURE!
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[0] = 1; board_before[1] = 1;
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 2;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1; board_after[1] = 2;      // CAPTURED by P2
    board_after[6] = 12; board_after[7] = 2;
    let scores_after: [Field; 2] = [4, 6];

    let end_hash = hash_board_state(board_after, scores_after, 1);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        2,
        12,
        1, 0,
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        p2_card_ids(), P2_BLINDING,
    );
}

#[test]
fn test_equal_ranks_no_capture() {
    // P1 card 1 Mudwalker right=4 at (0,0), (0,1) has P2 card 10 Peaches left=4.
    // 4 == 4 -> NO capture.
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[2] = 10; board_before[3] = 2;
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1; board_after[1] = 1;
    board_after[2] = 10; board_after[3] = 2;      // NOT captured (equal ranks)
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
        p1_card_ids(), P1_BLINDING,
    );
}

// ====================== C1 FIX TESTS: Exact Score Verification ======================

#[test(should_fail_with = "P1 score mismatch")]
fn test_score_fabrication_rejected() {
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let board_before: [Field; 18] = [0; 18];
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1;
    board_after[1] = 1;
    // Fabricated scores: should be [5, 5] but attacker claims [8, 2]
    let scores_after: [Field; 2] = [8, 2];
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
        p1_card_ids(), P1_BLINDING,
    );
}

#[test]
fn test_exact_scores_after_capture() {
    // P2 places card 13 (Neon [6,2,2,3]) at (0,1).
    // (0,0) has P1 card 5 (Inkwell [2,3,1,5]). Placed left=3 vs adj right=3 -> NO (equal)
    // (1,1) has P1 card 1 (Mudwalker [1,4,1,5]). Placed bottom=2 vs adj top=1 -> 2>1 CAPTURE!
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[0] = 5; board_before[1] = 1;    // (0,0) Inkwell P1
    board_before[4] = 10; board_before[5] = 2;   // (0,2) Peaches P2
    board_before[8] = 1; board_before[9] = 1;    // (1,1) Mudwalker P1
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 2;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 5; board_after[1] = 1;      // (0,0) Inkwell P1 - unchanged
    board_after[2] = 13; board_after[3] = 2;     // (0,1) Neon P2 - placed
    board_after[4] = 10; board_after[5] = 2;     // (0,2) Peaches P2 - unchanged
    board_after[8] = 1; board_after[9] = 2;      // (1,1) Mudwalker CAPTURED by P2
    // Exact scores: p1_board=1, p2_board=3, p1_hand=3, p2_hand=3
    let scores_after: [Field; 2] = [4, 6];

    let end_hash = hash_board_state(board_after, scores_after, 1);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        2,
        13,
        0, 1,
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        p2_card_ids(), P2_BLINDING,
    );
}

// ====================== C2 FIX TESTS: Card Replay Prevention ======================

#[test(should_fail_with = "Card already placed on board")]
fn test_card_replay_rejected() {
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[0] = 1; board_before[1] = 1;   // (0,0) card 1, P1
    board_before[2] = 10; board_before[3] = 2;  // (0,1) card 10, P2
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1; board_after[1] = 1;
    board_after[2] = 10; board_after[3] = 2;
    board_after[8] = 1; board_after[9] = 1;    // (1,1) card 1 REPLAYED
    let scores_after: [Field; 2] = [5, 5];
    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1, 1,          // card_id = 1 (already on board!)
        1, 1,
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        p1_card_ids(), P1_BLINDING,
    );
}

#[test]
fn test_different_card_after_same_id_on_board() {
    // P1 has card 1 on board. P1 places card 2 (different card). Should succeed.
    let cc1 = get_p1_commit();
    let cc2 = get_p2_commit();

    let mut board_before: [Field; 18] = [0; 18];
    board_before[0] = 1; board_before[1] = 1;   // (0,0) card 1, P1
    board_before[2] = 10; board_before[3] = 2;  // (0,1) card 10, P2
    let scores_before: [Field; 2] = [5, 5];
    let current_turn_before: Field = 1;
    let start_hash = hash_board_state(board_before, scores_before, current_turn_before);

    let mut board_after: [Field; 18] = [0; 18];
    board_after[0] = 1; board_after[1] = 1;
    board_after[2] = 10; board_after[3] = 1;   // (0,1) CAPTURED: Blushy top=5 > Peaches bottom=2
    board_after[8] = 2; board_after[9] = 1;    // (1,1) card 2, different card
    // filled=3, p1_board=3, p2_board=0, p1_played=2, p2_played=1
    // p1_score=3+3=6, p2_score=0+4=4
    let scores_after: [Field; 2] = [6, 4];
    let end_hash = hash_board_state(board_after, scores_after, 2);

    main(
        cc1, cc2,
        start_hash, end_hash,
        0, 0,
        1, 2,          // card_id = 2 (different, valid)
        1, 1,
        board_before, board_after,
        scores_before, scores_after,
        current_turn_before,
        p1_card_ids(), P1_BLINDING,
    );
}
