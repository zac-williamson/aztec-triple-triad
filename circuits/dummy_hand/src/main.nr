/// Dummy hand circuit for playtest fast mode.
///
/// Same public input signature as prove_hand, but with zero constraints.
/// Any inputs produce a valid proof. Its VK hash is registered as
/// hand_vk_hash only by deploy-contracts.ts --permissive-vks, which is
/// for TEST deployments exclusively - a deployment accepting this VK
/// provides no hand-ownership soundness whatsoever.
fn main(card_commit_hash: pub Field, opponent_player_state_hash: pub Field) {}
