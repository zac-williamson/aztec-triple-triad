/// Dummy open-cards circuit for playtest fast mode.
///
/// Same public input signature as prove_hand (the open-cards proof), with zero
/// constraints. A client playing a permissive (playtest) game may accept it in
/// place of a real open-cards proof; nothing on-chain ever verifies either.
fn main(card_commit_hash: pub Field, open_cards: pub [Field; 3]) {}
