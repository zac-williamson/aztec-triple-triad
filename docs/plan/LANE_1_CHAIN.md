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

## ASSUMPTIONS (discovered during A1, 2026-06-12)

1. **Version-set confirmed.** The 4.2 CLI installed from tag
   `4.2.0-nightly.20260323` self-reports `4.2.0-aztecnr-rc.2` — the two strings
   name one release, as CLAUDE.md §Versions states. The 4.3.1 set is uniform:
   installer/CLI `4.3.1`, aztec-nr git tag `v4.3.1`, nargo `1.0.0-beta.21`
   (noir commit 1d9727a6), npm tag presumed `4.3.1` (Lane 2 to confirm on A2).
2. **No proof-shape change 4.2 → 4.3.1.** `bb_proof_verification` is
   byte-identical across the tags: UltraHonkZKProof stays 500 fields, VK 115
   fields. `process_game` and `proofWorker.ts` need no size changes. VK
   *hashes* still change with the recompile — A3 registers fresh ones.
3. **Toolchain switching has two footguns** (worked around with absolute
   paths; .aztecrc committed for post-merge use):
   - The 4.2 CLI wrapper honors `.aztecrc` only in `$PWD`, not ancestors —
     `aztec test` from `packages/contracts/` under a 4.2 `current` silently
     runs 4.2 (observed: 1334-error macro explosion).
   - `aztec-up env` omits `internal-bin`, where 4.3.1 keeps bare `nargo` —
     after eval, `nargo` falls through to 4.2's beta.18 (observed: poseidon /
     EmbeddedCurvePoint stdlib mismatches). Once `current` itself is 4.3.1
     (post-merge `aztec-up use 4.3.1` or install), both footguns vanish.
4. **The 4.3.1 binary names changed**: bare `nargo`/`txe` became
   `internal-bin/nargo` (wrapper-injected) and `aztec start --txe --port N`.
   CLAUDE.md §Build/test command snippets need updating when A1 merges
   (Lane 7 owns CLAUDE.md — handoff noted in TRIAL coordination).
5. **TXE deploy resolution changed in 4.3.1**: `env.deploy("Name")` resolves
   to `target/{current-package}-Name.json`; cross-package deploys must use
   `env.deploy("@package/Name")`. Bare-name cross-package deploys crash the
   TXE process (ENOENT, unhandled stream error — upstream bug, worth reporting).
6. **noirc beta.21 type-checker limit**: a 256-arm nested if/else in card_data
   hit `TYPE_RECURSION_LIMIT` (panic) when poseidon shared the compilation
   unit; rewritten as a flat table (identical data, same API). Any future
   large decision chain in circuits should be a table.
7. **test_card_replay_rejected was red before the upgrade** (verified on
   April code + beta.18): the C2 constraint it specifies was never in
   game_move. Constraint added during A1 — circuit semantics now match the
   TS engine's "each card playable once". Not an upgrade regression.
8. **Cross-lane file touches** (negotiated via lane brief A1.5, announced):
   `scripts/deploy-contracts.ts` (--permissive-vks; scripts/ is Lane 6's) and
   this brief (docs/plan is Lane 7's; ASSUMPTIONS section was orchestrator-
   mandated). deploy-contracts.ts still uses SponsoredFPC (banned) — legacy
   from April, flagged for the owning lane; not expanded by the flag change.
9. **Tracked target/*.json.bak files** get rewritten by every compile and are
   committed alongside artifacts (April convention). Lane 6's F2 purge should
   drop them from git; until then they bloat artifact diffs.
