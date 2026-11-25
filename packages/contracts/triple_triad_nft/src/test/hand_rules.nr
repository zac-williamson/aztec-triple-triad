//! What counts as a committable hand (`validate_hand`): five distinct, real
//! card ids. The hand proof used to check this; the commit does now.
use crate::validate_hand;

#[test]
fn five_distinct_ids_in_range_are_a_hand() {
    validate_hand([1, 2, 3, 4, 5]);
    validate_hand([256, 1, 128, 77, 200]);
}

#[test(should_fail_with = "Duplicate card IDs not allowed")]
fn a_repeated_id_is_not_a_hand() {
    validate_hand([7, 2, 3, 7, 5]);
}

#[test(should_fail_with = "Card ID out of range")]
fn id_zero_is_not_a_card() {
    validate_hand([0, 2, 3, 4, 5]);
}

#[test(should_fail_with = "Card ID out of range")]
fn id_past_the_table_is_not_a_card() {
    validate_hand([1, 2, 3, 4, 257]);
}

#[test(should_fail_with = "Card ID out of range")]
fn an_id_that_truncates_into_range_is_not_a_card() {
    // 2^32 + 1 truncates to 1 under `as u32`; the round trip catches it.
    validate_hand([4294967297, 2, 3, 4, 5]);
}
