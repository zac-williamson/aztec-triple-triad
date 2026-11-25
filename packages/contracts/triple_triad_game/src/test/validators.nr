//! The game's rules as pure functions (see the VALIDATORS block in main.nr).
use crate::{
    all_returns, assert_abandon_bar_passed, assert_claim_number, assert_dispute_window_elapsed,
    assert_dispute_window_open, assert_side, assert_transcript, assert_vk_configuration,
    DISPUTE_SECONDS, MIN_ABANDON_SECONDS, prize_of, win_returns,
};
use crate::test::utils::transcript;

// --- transcript ---

#[test]
unconstrained fn a_well_formed_transcript_passes() {
    assert_transcript(transcript(11, 22, 1), 11, 22);
    assert_transcript(transcript(11, 22, 3), 11, 22);
}

#[test(should_fail_with = "Move proof card_commit_1 mismatch")]
unconstrained fn a_move_bound_to_another_hand_fails() {
    let mut m = transcript(11, 22, 1);
    m[4][0] = 99;
    assert_transcript(m, 11, 22);
}

#[test(should_fail_with = "Proof chaining failed: end_state != next start_state")]
unconstrained fn a_broken_chain_fails() {
    let mut m = transcript(11, 22, 1);
    m[5][2] = 1;
    assert_transcript(m, 11, 22);
}

#[test(should_fail_with = "First move start_state does not match initial state")]
unconstrained fn a_chain_not_anchored_at_the_empty_board_fails() {
    let mut m = transcript(11, 22, 1);
    m[0][2] = 5;
    assert_transcript(m, 11, 22);
}

#[test(should_fail_with = "Only the ninth move may end the game")]
unconstrained fn an_early_end_fails() {
    let mut m = transcript(11, 22, 1);
    m[6][4] = 1;
    assert_transcript(m, 11, 22);
}

#[test(should_fail_with = "The ninth move must name a valid winner")]
unconstrained fn a_ninth_move_without_a_winner_fails() {
    let mut m = transcript(11, 22, 1);
    m[8][5] = 4;
    assert_transcript(m, 11, 22);
}

// --- prize ---

#[test]
unconstrained fn the_prize_is_the_card_and_slot_the_loser_placed() {
    let m = transcript(11, 22, 1);
    // Player 1 won; move 5 is player 2's third placement: slot 2, card 8.
    let (card, slot) = prize_of(m, 1, 5);
    assert_eq(card, 8);
    assert_eq(slot, 2);
    // Player 2 won; move 4 is player 1's third placement: slot 2, card 3.
    let (card2, slot2) = prize_of(m, 2, 4);
    assert_eq(card2, 3);
    assert_eq(slot2, 2);
}

#[test(should_fail_with = "The prize must be a card the loser placed")]
unconstrained fn the_winner_cannot_name_their_own_move() {
    let _ = prize_of(transcript(11, 22, 1), 1, 4);
}

#[test(should_fail_with = "Prize move out of range")]
unconstrained fn a_tenth_move_is_out_of_range() {
    let _ = prize_of(transcript(11, 22, 1), 1, 9);
}

#[test(should_fail_with = "Prize slot out of range")]
unconstrained fn a_prize_slot_past_the_hand_is_refused() {
    let mut m = transcript(11, 22, 1);
    m[1][7] = 5;
    let _ = prize_of(m, 1, 1);
}

#[test(should_fail_with = "A draw has no prize")]
unconstrained fn a_draw_has_no_prize() {
    let _ = prize_of(transcript(11, 22, 3), 3, 1);
}

#[test]
unconstrained fn a_win_releases_the_winners_five_and_the_losers_other_four() {
    let out = win_returns([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], 2);
    assert_eq(out, [1, 2, 3, 4, 5, 6, 7, 9, 10, 0]);
    let first = win_returns([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], 0);
    assert_eq(first, [1, 2, 3, 4, 5, 7, 8, 9, 10, 0]);
    let last = win_returns([1, 2, 3, 4, 5], [6, 7, 8, 9, 10], 4);
    assert_eq(last, [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]);
}

#[test]
unconstrained fn a_draw_releases_both_hands() {
    assert_eq(all_returns([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
}

// --- abandonment rules ---

#[test]
unconstrained fn claims_one_to_three_on_either_side() {
    assert_claim_number(1);
    assert_claim_number(3);
    assert_side(1);
    assert_side(2);
}

#[test(should_fail_with = "Claim number must be 1 to 3")]
unconstrained fn a_fourth_claim_is_refused() {
    assert_claim_number(4);
}

#[test(should_fail_with = "Claim number must be 1 to 3")]
unconstrained fn claim_zero_is_refused() {
    assert_claim_number(0);
}

#[test(should_fail_with = "Side must be 1 or 2")]
unconstrained fn side_three_is_refused() {
    assert_side(3);
}

#[test]
unconstrained fn the_bar_and_the_window_are_exact() {
    assert_abandon_bar_passed(1000 + MIN_ABANDON_SECONDS, 1000);
    assert_dispute_window_open(1000 + DISPUTE_SECONDS - 1, 1000);
    assert_dispute_window_elapsed(1000 + DISPUTE_SECONDS, 1000);
}

#[test(should_fail_with = "Too soon to call this game abandoned")]
unconstrained fn one_second_short_of_the_bar_is_too_soon() {
    assert_abandon_bar_passed(1000 + MIN_ABANDON_SECONDS - 1, 1000);
}

#[test(should_fail_with = "Dispute window has closed")]
unconstrained fn a_contest_at_the_window_edge_is_late() {
    assert_dispute_window_open(1000 + DISPUTE_SECONDS, 1000);
}

#[test(should_fail_with = "Dispute window not elapsed")]
unconstrained fn finalizing_one_second_early_is_refused() {
    assert_dispute_window_elapsed(1000 + DISPUTE_SECONDS - 1, 1000);
}

// --- deployment ---

#[test]
unconstrained fn distinct_vks_are_a_sound_configuration() {
    assert_vk_configuration(2, 3, false);
    // A permissive (playtest) deployment may register the dummy VK as moves.
    assert_vk_configuration(3, 3, true);
}

#[test(should_fail_with = "move_vk_hash must not be the dummy VK")]
unconstrained fn the_dummy_vk_cannot_verify_moves_on_a_sound_deployment() {
    assert_vk_configuration(3, 3, false);
}

#[test(should_fail_with = "move_vk_hash must be set")]
unconstrained fn an_unset_move_vk_is_refused() {
    assert_vk_configuration(0, 3, false);
}
