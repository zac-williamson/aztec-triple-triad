//! The contract's security rules, tested directly.
//!
//! These call the validators in main.nr with no TXE, no context and no proofs,
//! which is the entire point: `process_game` and `claim_abandoned_game` need
//! eleven recursive proofs that TXE cannot produce, so for the life of this
//! project nothing has ever executed the rules inside them. Mutation testing
//! measured 70 of 78 assertions in that file as untested, and all four bugs the
//! audit found were in exactly that region.
//!
//! Moving each assertion into a function that takes plain values is what makes
//! these tests possible. Every reject case below is a lie somebody could tell
//! the contract.

use crate::{
    assert_abandon_bar_passed, assert_active_for_claim, assert_active_for_settlement,
    assert_anchored_to_initial, assert_cancellable, assert_chain_linked,
    assert_claim_hand_commits, assert_claim_standing_for_contest,
    assert_claim_standing_for_recovery, assert_claim_turn, assert_claimant_is_player,
    assert_commitments_present, assert_contester_is_player, assert_dispute_window_elapsed,
    assert_dispute_window_open, assert_draw_binding, assert_end_rules, assert_game_id_unused,
    assert_hand_proof_cross_states, assert_joinable, assert_move_commits, assert_not_own_claim,
    assert_not_yet_contested, assert_not_yet_recovered, assert_proof_commits_match,
    assert_recovery_binding, assert_settlement_binding, assert_transcript,
    assert_transferable_card, assert_valid_move_count, assert_vk_configuration,
    compute_initial_state_hash,
    DISPUTE_SECONDS, MIN_ABANDON_SECONDS,
};

// Test fixtures, behind an optimization barrier.
//
// `nargo` const-folds any comparison whose operands are all compile-time
// constants, and a fold to FALSE DROPS the assertion instead of failing it. A
// should_fail test written with plain globals and literals then reports "Test
// passed when it should have failed" — the check it was written to exercise
// never ran. (Three tests in this file were silently in that state; nargo
// reports it, but only for the should_fail direction.)
//
// So every value handed to a validator comes from one of these, or from
// `chain`, or from a `black_box`'d let-binding. Never pass a bare literal or a
// `global` straight into a validator.
fn cc1() -> Field {
    std::hint::black_box(0xc1)
}
fn cc2() -> Field {
    std::hint::black_box(0xc2)
}
fn p1() -> Field {
    std::hint::black_box(0xa1)
}
fn p2() -> Field {
    std::hint::black_box(0xa2)
}
fn outsider() -> Field {
    std::hint::black_box(0xbad)
}
fn ps1() -> Field {
    std::hint::black_box(0x51)
}
fn ps2() -> Field {
    std::hint::black_box(0x52)
}

/// The same barrier, for one-off values written inline at a call site. A bare
/// `0xdead` or `2` in an argument list is a compile-time constant and folds
/// exactly like a `global` does.
fn f(x: Field) -> Field {
    std::hint::black_box(x)
}
fn b(x: bool) -> bool {
    std::hint::black_box(x)
}
fn u(x: u64) -> u64 {
    std::hint::black_box(x)
}

/// A well-formed transcript of `n` moves: bound to both hands, chained, and
/// anchored to the empty board. For n == 9 the ninth move ends the game.
fn chain(n: u32) -> [[Field; 6]; 9] {
    let mut m: [[Field; 6]; 9] = [[0; 6]; 9];
    let init = compute_initial_state_hash();
    for i in 0..9 {
        if (i as u32) < n {
            m[i][0] = cc1();
            m[i][1] = cc2();
            m[i][2] = if i == 0 { init } else { (1000 + i) as Field };
            m[i][3] = (1000 + i + 1) as Field;
            if (n == 9) & (i == 8) {
                m[i][4] = 1;
                m[i][5] = 1;
            }
        }
    }
    std::hint::black_box(m)
}

// ---------------- lifecycle ----------------

#[test]
fn game_id_may_be_used_once() {
    assert_game_id_unused(f(0));
}

#[test(should_fail)]
fn game_id_may_not_be_reused() {
    // A recycled id repeats the blinding factor derived from it, which is the
    // only thing binding a move proof to one game.
    assert_game_id_unused(f(2));
}

#[test]
fn a_created_game_accepts_a_different_player() {
    assert_joinable(f(1), p2(), p1());
}

#[test(should_fail)]
fn cannot_join_your_own_game() {
    assert_joinable(f(1), p1(), p1());
}

#[test(should_fail)]
fn cannot_join_a_game_that_is_not_created() {
    assert_joinable(f(2), p2(), p1());
}

#[test]
fn the_creator_may_cancel_before_anyone_joins() {
    assert_cancellable(f(1), p1(), p1());
}

#[test(should_fail)]
fn a_stranger_may_not_cancel_your_game() {
    // Cancel re-mints the creator's five committed cards.
    assert_cancellable(f(1), outsider(), p1());
}

#[test(should_fail)]
fn a_joined_game_may_not_be_cancelled() {
    // It would return one hand while the other stayed committed.
    assert_cancellable(f(2), p1(), p1());
}

#[test]
fn an_active_unsettled_game_may_settle() {
    assert_active_for_settlement(f(2), b(false));
}

#[test(should_fail)]
fn a_claimed_game_may_not_also_settle() {
    // status 5 with settled=false is exactly the double-mint that the
    // `settled` flag alone did not catch.
    assert_active_for_settlement(f(5), b(false));
}

#[test(should_fail)]
fn a_settled_game_may_not_settle_again() {
    assert_active_for_settlement(f(2), b(true));
}

#[test(should_fail)]
fn only_an_active_game_may_be_claimed() {
    assert_active_for_claim(f(5));
}

#[test(should_fail)]
fn nothing_to_contest_without_a_standing_claim() {
    assert_claim_standing_for_contest(f(2));
}

#[test(should_fail)]
fn nothing_to_recover_without_a_standing_claim() {
    assert_claim_standing_for_recovery(f(2));
}

// ---------------- participants ----------------

#[test]
fn either_player_may_claim() {
    assert_claimant_is_player(p1(), p1(), p2());
    assert_claimant_is_player(p2(), p1(), p2());
}

#[test(should_fail)]
fn an_outsider_may_not_claim() {
    assert_claimant_is_player(outsider(), p1(), p2());
}

#[test(should_fail)]
fn an_outsider_may_not_contest() {
    assert_contester_is_player(outsider(), p1(), p2());
}

#[test(should_fail)]
fn a_claimant_may_not_contest_their_own_claim() {
    assert_not_own_claim(p1(), p1());
}

#[test]
fn the_other_player_may_contest() {
    assert_not_own_claim(p2(), p1());
}

#[test(should_fail)]
fn a_player_may_only_contest_once() {
    assert_not_yet_contested(b(true));
}

#[test(should_fail)]
fn a_player_may_only_recover_once() {
    assert_not_yet_recovered(b(true));
}

// ---------------- time ----------------

#[test]
fn a_stale_game_may_be_claimed() {
    assert_abandon_bar_passed(MIN_ABANDON_SECONDS + u(1), u(0));
}

#[test(should_fail)]
fn a_fresh_game_may_not_be_claimed() {
    // Without the bar, a claim races the opponent's settlement: file first and
    // the winner loses the card they won.
    assert_abandon_bar_passed(MIN_ABANDON_SECONDS - u(1), u(0));
}

#[test]
fn the_bar_is_inclusive_at_the_boundary() {
    assert_abandon_bar_passed(MIN_ABANDON_SECONDS, u(0));
}

#[test]
fn a_fresh_claim_may_be_contested() {
    assert_dispute_window_open(DISPUTE_SECONDS - u(1), u(0));
}

#[test(should_fail)]
fn an_elapsed_claim_may_not_be_contested() {
    // Reopening a claim that may already have settled would mint twice.
    assert_dispute_window_open(DISPUTE_SECONDS, u(0));
}

#[test]
fn recovery_waits_the_window_out() {
    assert_dispute_window_elapsed(DISPUTE_SECONDS, u(0));
}

#[test(should_fail)]
fn recovery_may_not_jump_the_window() {
    assert_dispute_window_elapsed(DISPUTE_SECONDS - u(1), u(0));
}

// ---------------- claim shape ----------------

#[test]
fn zero_through_nine_moves_are_all_valid_counts() {
    let n0: u32 = std::hint::black_box(0);
    let n8: u32 = std::hint::black_box(8);
    let n9: u32 = std::hint::black_box(9);
    assert_valid_move_count(n0);
    assert_valid_move_count(n8);
    assert_valid_move_count(n9);
}

#[test(should_fail)]
fn more_moves_than_a_board_holds_is_rejected() {
    // The binding is load-bearing. Passing a bare literal here — 
    // `assert_valid_move_count(10)` — const-folds to a no-op and the test
    // reports "passed when it should have failed": nargo catches that, but
    // only because this is a should_fail test. Bind first, the way the
    // contract does (`num_valid_moves as u32`), so the runtime path is what
    // gets exercised.
    let n: u32 = std::hint::black_box(10);
    assert_valid_move_count(n);
}

#[test]
fn player1_claims_on_an_odd_count() {
    let n1: u32 = std::hint::black_box(1);
    let n7: u32 = std::hint::black_box(7);
    // After an odd number of 0-indexed moves it is player 2 to move, so player
    // 1 is not the one who walked away.
    assert_claim_turn(n1, b(true));
    assert_claim_turn(n7, b(true));
}

#[test(should_fail)]
fn player1_may_not_claim_when_it_is_their_own_turn() {
    let n4: u32 = std::hint::black_box(4);
    assert_claim_turn(n4, b(true));
}

#[test]
fn player2_claims_on_an_even_count() {
    let n0: u32 = std::hint::black_box(0);
    let n8: u32 = std::hint::black_box(8);
    assert_claim_turn(n0, b(false));
    assert_claim_turn(n8, b(false));
}

#[test(should_fail)]
fn player2_may_not_claim_when_it_is_their_own_turn() {
    let n3: u32 = std::hint::black_box(3);
    assert_claim_turn(n3, b(false));
}

#[test]
fn a_finished_game_owes_nobody_a_move_so_either_side_may_claim() {
    let n9: u32 = std::hint::black_box(9);
    assert_claim_turn(n9, b(true));
    assert_claim_turn(n9, b(false));
}

// ---------------- transcript ----------------

#[test]
fn a_well_formed_transcript_is_accepted() {
    let n0: u32 = std::hint::black_box(0);
    let n4: u32 = std::hint::black_box(4);
    let n9: u32 = std::hint::black_box(9);
    assert_transcript(chain(4), cc1(), cc2(), n4);
    assert_transcript(chain(9), cc1(), cc2(), n9);
    assert_transcript(chain(0), cc1(), cc2(), n0);
}

#[test(should_fail)]
fn a_move_bound_to_another_hand_is_rejected() {
    let n4: u32 = std::hint::black_box(4);
    let mut m = chain(4);
    m[2][0] = 0xdead;
    assert_move_commits(m, cc1(), cc2(), n4);
}

#[test(should_fail)]
fn a_move_bound_to_another_opponent_hand_is_rejected() {
    let n4: u32 = std::hint::black_box(4);
    let mut m = chain(4);
    m[2][1] = 0xdead;
    assert_move_commits(m, cc1(), cc2(), n4);
}

#[test(should_fail)]
fn a_broken_chain_is_rejected() {
    let n4: u32 = std::hint::black_box(4);
    // Reordering or splicing a transcript breaks exactly this link.
    let mut m = chain(4);
    m[1][2] = 0xdead;
    assert_chain_linked(m, n4);
}

#[test(should_fail)]
fn a_transcript_not_starting_from_an_empty_board_is_rejected() {
    let n4: u32 = std::hint::black_box(4);
    // Without the anchor any position can be presented as a starting point.
    let mut m = chain(4);
    m[0][2] = 0xdead;
    assert_anchored_to_initial(m, n4);
}

#[test]
fn a_zero_move_claim_has_nothing_to_anchor() {
    let n0: u32 = std::hint::black_box(0);
    assert_anchored_to_initial(chain(0), n0);
}

#[test(should_fail)]
fn an_intermediate_move_may_not_end_the_game() {
    let n4: u32 = std::hint::black_box(4);
    let mut m = chain(4);
    m[1][4] = 1;
    assert_end_rules(m, n4);
}

#[test(should_fail)]
fn an_intermediate_move_may_not_name_a_winner() {
    let n4: u32 = std::hint::black_box(4);
    let mut m = chain(4);
    m[1][5] = 1;
    assert_end_rules(m, n4);
}

#[test(should_fail)]
fn a_complete_transcript_must_actually_end_the_game() {
    // Otherwise a partial transcript is passed off as a complete one.
    //
    // `n` is bound rather than passed as a literal: see
    // more_moves_than_a_board_holds_is_rejected. A literal here const-folds the
    // check away and this test silently stops testing anything.
    let n: u32 = std::hint::black_box(9);
    let mut m = chain(9);
    m[8][4] = 0;
    assert_end_rules(m, n);
}

#[test(should_fail)]
fn a_complete_transcript_must_name_a_valid_winner() {
    let n9: u32 = std::hint::black_box(9);
    let mut m = chain(9);
    m[8][5] = 7;
    assert_end_rules(m, n9);
}

#[test]
fn a_draw_is_a_valid_verdict() {
    let n9: u32 = std::hint::black_box(9);
    let mut m = chain(9);
    m[8][5] = 3;
    assert_end_rules(m, n9);
}

// ---------------- settlement binding ----------------

#[test]
fn a_player1_win_pays_player1() {
    assert_settlement_binding(f(1), p1(), p2(), p1(), p2(), cc1(), cc2(), cc1(), cc2(), ps1(), ps2(), ps1(), ps2());
}

#[test]
fn a_player2_win_pays_player2() {
    assert_settlement_binding(f(2), p2(), p1(), p1(), p2(), cc2(), cc1(), cc1(), cc2(), ps2(), ps1(), ps1(), ps2());
}

#[test(should_fail)]
fn a_win_may_not_pay_a_stranger() {
    assert_settlement_binding(f(1), outsider(), p2(), p1(), p2(), cc1(), cc2(), cc1(), cc2(), ps1(), ps2(), ps1(), ps2());
}

#[test(should_fail)]
fn the_loser_named_must_be_the_other_player() {
    assert_settlement_binding(f(1), p1(), outsider(), p1(), p2(), cc1(), cc2(), cc1(), cc2(), ps1(), ps2(), ps1(), ps2());
}

#[test(should_fail)]
fn a_winner_may_not_name_cards_they_did_not_commit() {
    // The historical worst bug in this project was the absence of this link.
    assert_settlement_binding(f(1), p1(), p2(), p1(), p2(), f(0xdead), cc2(), cc1(), cc2(), ps1(), ps2(), ps1(), ps2());
}

#[test(should_fail)]
fn the_losers_cards_must_be_the_ones_they_committed() {
    assert_settlement_binding(f(1), p1(), p2(), p1(), p2(), cc1(), f(0xdead), cc1(), cc2(), ps1(), ps2(), ps1(), ps2());
}

#[test(should_fail)]
fn a_winner_may_not_claim_the_other_sides_commitment() {
    // Swapping the sides is the attack an either-order check would allow.
    assert_settlement_binding(f(1), p1(), p2(), p1(), p2(), cc2(), cc1(), cc1(), cc2(), ps1(), ps2(), ps1(), ps2());
}

#[test(should_fail)]
fn an_invalid_winner_id_is_rejected() {
    assert_settlement_binding(f(3), p1(), p2(), p1(), p2(), cc1(), cc2(), cc1(), cc2(), ps1(), ps2(), ps1(), ps2());
}

#[test(should_fail)]
fn randomness_must_match_what_was_committed() {
    assert_settlement_binding(f(1), p1(), p2(), p1(), p2(), cc1(), cc2(), cc1(), cc2(), f(0xdead), ps2(), ps1(), ps2());
}

// ---------------- draw binding ----------------

#[test]
fn a_draw_pays_both_players_either_way_round() {
    assert_draw_binding(p1(), p2(), p1(), p2(), cc1(), cc2(), cc1(), cc2(), ps1(), ps2(), ps1(), ps2());
    assert_draw_binding(p2(), p1(), p1(), p2(), cc2(), cc1(), cc1(), cc2(), ps2(), ps1(), ps1(), ps2());
}

#[test(should_fail)]
fn a_draw_may_not_pay_an_address_the_settler_chose() {
    // This was live on the deployed contract: the settler passed an address it
    // controlled and the opponent's five committed cards were minted to it.
    assert_draw_binding(p1(), outsider(), p1(), p2(), cc1(), cc2(), cc1(), cc2(), ps1(), ps2(), ps1(), ps2());
}

#[test(should_fail)]
fn a_draw_may_not_pay_the_settler_twice() {
    assert_draw_binding(p1(), p1(), p1(), p2(), cc1(), cc2(), cc1(), cc2(), ps1(), ps2(), ps1(), ps2());
}

#[test(should_fail)]
fn a_draw_may_not_swap_whose_cards_go_where() {
    assert_draw_binding(p1(), p2(), p1(), p2(), cc2(), cc1(), cc1(), cc2(), ps1(), ps2(), ps1(), ps2());
}

// ---------------- recovery binding ----------------

#[test]
fn each_side_recovers_its_own_stake() {
    assert_recovery_binding(p1(), p1(), p2(), ps1(), cc1(), ps1(), ps2(), cc1(), cc2());
    assert_recovery_binding(p2(), p1(), p2(), ps2(), cc2(), ps1(), ps2(), cc1(), cc2());
}

#[test(should_fail)]
fn an_outsider_may_not_recover() {
    assert_recovery_binding(outsider(), p1(), p2(), ps1(), cc1(), ps1(), ps2(), cc1(), cc2());
}

#[test(should_fail)]
fn a_player_may_not_recover_the_other_sides_cards() {
    assert_recovery_binding(p1(), p1(), p2(), ps1(), cc2(), ps1(), ps2(), cc1(), cc2());
}

// ---------------- transferred card ----------------

#[test]
fn a_wagered_card_from_the_losers_hand_is_transferable() {
    assert_transferable_card(f(7), [f(5), f(6), f(7), f(8), f(9)]);
}

#[test(should_fail)]
fn a_card_the_loser_never_committed_is_not_transferable() {
    assert_transferable_card(f(42), [f(5), f(6), f(7), f(8), f(9)]);
}

#[test(should_fail)]
fn a_non_draw_must_move_a_real_card() {
    assert_transferable_card(f(0), [f(5), f(6), f(7), f(8), f(9)]);
}

// ---------------- stored commitments ----------------

#[test(should_fail)]
fn an_unset_commitment_makes_every_later_check_vacuous_p1() {
    assert_commitments_present(f(0), cc2());
}

#[test(should_fail)]
fn an_unset_commitment_makes_every_later_check_vacuous_p2() {
    assert_commitments_present(cc1(), f(0));
}

#[test(should_fail)]
fn a_proof_commitment_must_match_the_stored_one() {
    assert_proof_commits_match(f(0xdead), cc2(), cc1(), cc2());
}

#[test(should_fail)]
fn a_claims_hand_proof_must_be_bound_to_this_game() {
    assert_claim_hand_commits(f(0xdead), cc2(), cc1(), cc2());
}

#[test]
fn hand_proofs_prove_knowledge_of_the_other_sides_state() {
    assert_hand_proof_cross_states(ps2(), ps1(), ps1(), ps2());
}

#[test(should_fail)]
fn a_hand_proof_naming_its_own_state_is_rejected() {
    assert_hand_proof_cross_states(ps1(), ps1(), ps1(), ps2());
}



// ---------------- deployment: verification keys ----------------

#[test]
fn a_sound_deployment_registers_three_distinct_keys() {
    assert_vk_configuration(f(0x11), f(0x22), f(0x33), b(false));
}

#[test(should_fail)]
fn a_deployment_may_not_accept_dummy_proofs_as_moves() {
    // THE finding. With move_vk_hash == dummy_vk_hash the constraint-free dummy
    // proof verifies as a real move: every game winnable by anyone, and nothing
    // on-chain to distinguish the deployment from a sound one.
    assert_vk_configuration(f(0x11), f(0x33), f(0x33), b(false));
}

#[test(should_fail)]
fn a_deployment_may_not_accept_dummy_proofs_as_hands() {
    assert_vk_configuration(f(0x33), f(0x22), f(0x33), b(false));
}

#[test]
fn a_playtest_deployment_may_opt_into_dummy_proofs() {
    // --permissive-vks needs exactly the configuration rejected above. Allowed,
    // but only as a deliberate constructor argument that is then readable
    // on-chain via has_permissive_vks() — not as an absence of checks.
    assert_vk_configuration(f(0x11), f(0x33), f(0x33), b(true));
}

#[test(should_fail)]
fn even_a_playtest_deployment_may_not_confuse_hand_and_move_keys() {
    // Different circuits, different public-input shapes. A misconfiguration
    // under any setting.
    assert_vk_configuration(f(0x22), f(0x22), f(0x33), b(true));
}

#[test(should_fail)]
fn an_unset_hand_key_is_rejected() {
    // Zero is what a missing or mis-encoded deploy argument looks like.
    assert_vk_configuration(f(0), f(0x22), f(0x33), b(false));
}

#[test(should_fail)]
fn an_unset_move_key_is_rejected() {
    assert_vk_configuration(f(0x11), f(0), f(0x33), b(false));
}

#[test(should_fail)]
fn an_unset_dummy_key_is_rejected() {
    // Without it, `if n > 0 { move_vk } else { dummy_vk }` pads a short claim
    // transcript with a key that verifies nothing.
    assert_vk_configuration(f(0x11), f(0x22), f(0), b(false));
}
