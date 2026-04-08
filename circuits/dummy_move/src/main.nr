/// Dummy move circuit for abandoned game padding.
///
/// Same public input signature as game_move, but with zero constraints.
/// Any inputs produce a valid proof. The distinct VK hash allows the
/// game contract to distinguish real move proofs from padding proofs.
fn main(
    card_commit_1: pub Field,
    card_commit_2: pub Field,
    start_state_hash: pub Field,
    end_state_hash: pub Field,
    game_ended: pub Field,
    winner_id: pub Field,
) {}
