/// Abandoned game test cases.
///
/// Full claim_abandoned_game tests require real ZK proofs (hand + move proofs)
/// which can only be generated outside the TXE environment.
/// These tests are implemented as E2E tests in the test-abandoned-game.mjs script.
///
/// Test cases to verify:
///
/// claim_abandoned_game:
///   - Claim with 1, 4, 8 valid moves (success)
///   - Reject num_valid_moves = 0 (bounds check)
///   - Reject num_valid_moves = 9 (use process_game instead)
///   - Reject claim on non-active game (status != 2)
///   - Reject claim by non-player
///   - Reject claim when it's the caller's turn (they abandoned)
///   - Reject invalid proof chain
///
/// claim_abandoned_game_public:
///   - Writes game_claim_player, game_claim_block correctly
///   - Sets game_status to 5 (abandoned_claimed)
///   - Emits GameAbandoned event
///
/// settle_abandoned_game:
///   - Settle with claimed_card_id from opponent hand (success)
///   - Settle with claimed_card_id = 0 (no claim, draw-like)
///   - Caller gets 5 private cards + 1 claimed card
///   - Opponent gets 4 or 5 cards to public ownership
///   - Only caller gets 20 Arena Tokens (not opponent)
///
/// settle_abandoned_game_public:
///   - Reject settle before 5 blocks elapsed
///   - Reject settle by non-claimant
///   - Reject double settle (game already settled)
///   - Sets game_settled = true, game_status = 3
///   - Verifies caller_state_hash matches stored player state
///   - Emits AbandonedGameSettled event
