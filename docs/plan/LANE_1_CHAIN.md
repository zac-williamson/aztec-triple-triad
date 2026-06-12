# Lane 1 — Chain (Noir contracts, circuits, deploys)

Branch `lane/1-chain` · Worktree `worktrees/lane-1-chain`
Owns: `packages/contracts/`, `circuits/`, all Nargo.tomls. Critical-path lane.

## Mission
Carry the project from the 4.2.0 release set (CLI tag `4.2.0-nightly.20260323`,
npm/aztec-nr tags `4.2.0-aztecnr-rc.2` — confirm these name the same release,
see CLAUDE.md §Versions) to **4.3.1 stable**: contracts and
circuits compile, TXE tests green, contracts redeployed to testnet. Also deliver the
playtest fast-mode chain pieces (dummy_hand circuit + permissive-VK deploy flag).

## Sequence

### A1 — Noir upgrade to 4.3.1 (2–5d) — START HERE
1. Retarget tooling: `/aztec:aztec-version 4.3.1` (MCP docs/examples then match the
   target version). Install the 4.3.1 toolchain alongside the nightly.
2. Bump tags in all 5 Nargo.tomls: `aztec-nr`, `bb_proof_verification`, `poseidon`
   (currently `v0.2.6` — check compat; `std::hash::poseidon2` was private in
   beta.18, may have changed).
3. `aztec compile` in `packages/contracts/`; fix aztec-nr API churn
   (`Owned<PrivateSet>`, `MessageDelivery`, note get/pop APIs, `enqueue_self`).
4. `nargo compile` in `circuits/`.
5. TXE tests green: `TXE_PORT=8081 txe &` then
   `nargo test --oracle-resolver http://127.0.0.1:8081`.
6. `aztec codegen target/ -o target/codegen` → hand artifacts to Lane 2.

**Top risk:** UltraHonk proof/VK format change. Last upgrade the proof went
508→500 fields. Any change ripples into `process_game`'s array types
(`triple_triad_game/src/main.nr`) AND frontend `proofWorker.ts`. Detect early
(compare `UltraHonkZKProof` size in 4.3.1's `bb_proof_verification`), announce to
Lanes 2 and 8 immediately.

### A1.5 — Playtest fast-mode chain pieces (0.5d, can interleave)
- New `circuits/dummy_hand/`: constraint-free, public-input shape identical to
  `prove_hand` (2 public inputs). Mirror `circuits/dummy_move/` (13 lines).
- `scripts/deploy-contracts.ts --permissive-vks`: registers dummy-circuit VK hashes
  as `hand_vk_hash`/`move_vk_hash` on a TEST deployment. Never valid for prod deploys —
  make the flag loud.
- Unblocks Lane 8 Phase 2; deliverable even before A1 finishes (works on 4.2 too).

### A2 support (with Lane 2)
Lane 2 owns the TS changes; you own regenerated artifacts/types, the copy of
compiled JSON into `frontend/public/contracts/`, and answering proof-shape questions.

### A3 — Testnet redeploy (0.5–1d) — after A1+A2
- Zac funds a deployer account on 4.3.1 testnet (decision point — ping him).
- Run `scripts/deploy-testnet.ts` (has `--skip-account` + resume support).
- Write new addresses to `packages/frontend/.env.testnet` AND README §Testnet.
- Sanity: `node_getNodeInfo` version match, then a scripted create_game.

## Cross-lane contracts
- **Provide:** 4.3.1 artifacts + codegen (→2), proof-shape change notices (→2,8),
  dummy_hand + permissive deploy (→8), new testnet addresses (→2,4,6).
- **Consume:** acceptance runs from Lane 8 (real-proof mode) before A1/A2 merge.

## Constraints
- `aztec compile`, never `nargo compile`, for contracts (AVM transpilation + VKs).
- Never hardcode storage slots — `storage_layout().field.slot` (the `private_nfts`
  slot-9-not-5 bug cost us days once).
- game_id/randomness stay in-circuit (`derive_game_id`/`derive_game_randomness`).
- Do not refactor contract logic during A1 — mechanical migration only, diff review
  must stay readable.
