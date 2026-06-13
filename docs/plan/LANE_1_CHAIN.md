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

### QA queue follow-ups (2026-06-12, post-A1 merge)

10. **QA-F1 CONFIRMED and FIXED — starter double-claim.** `get_cards_for_new_player`
    had no on-chain guard: a second direct call re-minted 5 cards + 100 tokens
    and pushed a second nonce note (verified — wrote a should_fail test that
    *passed* against the unguarded contract). Fix: a deterministic per-account
    claim nullifier `poseidon2([DOM_SEP__STARTER_CLAIM, nhk_app_secret])`,
    enforced with the canonical pair — `assert_nullifier_did_not_exist_by` at the
    anchor block (clean simulation-time rejection, "Cannot prove nullifier
    non-inclusion" — same error aztec-nr's own history/nullifier test asserts)
    plus `push_nullifier` (protocol backstop against a malicious prover anchoring
    pre-claim). Derived from the app-siloed secret, so the nullifier is
    unlinkable from the address — an observer can't tell who has claimed. Tests:
    `starter_claim_mints_starter_tokens`, `starter_claim_rejects_second_claim`.
    NFT TXE suite 15→17. Note: the localStorage `deploymentStatus` flag (Lane 2)
    is now belt-and-suspenders, not the only protection — the C8 campaign's
    "direct second call → assert revert" extension is now executable.
11. **QA-A2 CONFIRMED — nonce delta +6 per game (open question #6).** Both
    `commit_five_nfts_create` and `commit_five_nfts_join` end with
    `push_note_nonce(owner, nonce_value + 6)`. The "where/why": the nonce is a
    monotonic *next-free randomness-slot* counter; `derive_game_randomness`
    consumes 6 slots `[nonce_value, nonce_value + 6)` (one per `gameRandomness
    [Field; 6]`), so +6 prevents any later pack/game derivation reusing a slot —
    exactly mirroring `purchase_card_pack`'s +10 for 10 cards and the starter's
    init-to-5 for 5 cards. Documented at both push sites in main.nr. Fixture-gen
    determinism (predicted pack contents after N games) can rely on +6/game.
12. **TXE runner hygiene (operational, not code).** Stale `aztec start --txe`
    processes from interrupted/killed runs accumulate and cause LMDB
    world-state contention: the next run's TXE aborts with
    `libc++abi: mdb_txn_begin: 22 - Invalid argument`, and every test then
    fails with "Failed calling external resolver. client error (Connect)" —
    looks like a mass regression but is purely environmental. Always
    `pkill -9 -f "start --txe"` before a run and use a fresh port; one TXE at a
    time. The contract suite is 9/6/17 green on a clean single instance.

### A3 funding automation (2026-06-12)

13. **One-key funding -> auto-distribute (built).** Fee Juice is non-transferable
    on L2, so distribution = one L1->L2 bridge per recipient. New pieces:
    - `scripts/lib/feeJuiceBridge.ts` — shared core. `bridgeFeeJuice` generalizes
      fundDevnet.ts to any network (L1 RPC + funder key from the caller, mint via
      FeeAssetHandler so the treasury only needs Sepolia ETH). Plus pure helpers:
      `parseL2Addresses`, `serializeClaim`/`deserializeClaim`, `readFunderKey`,
      and a claim store (`claimStorePath`/`loadClaimStore`/`putStoredClaim`/
      `getStoredClaim`/`markClaimConsumed`).
    - `scripts/fund-testnet.ts` — bridge + persist a claim to each L2 address arg;
      idempotent (skips addresses with an unconsumed claim unless `--force`).
    - `scripts/deploy-testnet.ts` GAP FIX — the deployer account was deployed with
      `send({from:NO_FROM})` and NO fee (can't pay for itself on testnet, no
      SponsoredFPC). Now obtains a claim (persisted, or bridged inline if treasury
      creds are in env) and deploys via `FeeJuicePaymentMethodWithClaim` — the
      canonical fresh-account-init flow (matches aztec-nr's account_init e2e and
      the devnet smoke test). Claim marked consumed on success.
14. **Decisions made (no orchestrator input needed):**
    - **Sepolia RPC:** required via `TESTNET_L1_RPC_URL` (never hardcoded). The
      chain is auto-detected from the RPC's `eth_chainId` (no chain arg, same as
      fundDevnet). A public Sepolia RPC or the operator's own endpoint both work.
    - **Claim persistence:** JSON map (L2 addr -> serialized claim + status +
      bridgedAt) at `~/.aztec-triad-private/fee-juice-claims.json` (0600, mkdir
      0700), i.e. OUTSIDE the repo alongside the treasury key so secrets can't be
      committed. Override via `FEE_JUICE_CLAIMS_FILE`. Treasury key read from
      `TREASURY_L1_KEY` or `TREASURY_L1_KEY_FILE` (default the 600 file the
      orchestrator named), validated as 0x-32-byte, never logged.
15. **DEDUP — flagged, not done (needs a Lane 2 edit + a shared-package call):**
    fundDevnet.ts (`packages/frontend/src/aztec/`, Lane 2) still holds a local-only
    copy of the bridge core. Proposal: the canonical home for `bridgeFeeJuice` is a
    new shared workspace package **`packages/aztec-fee/`** so the frontend funding
    path (item I) and the headless bot (D2) can depend on it without reaching into
    `scripts/` or each other's `src/`. fundDevnet.ts should then re-export/import
    from there. I did NOT edit fundDevnet.ts (Lane 2 owns it); for now the two
    scripts share `scripts/lib/feeJuiceBridge.ts` so they are deduplicated today.
16. **Cross-lane + pre-existing flags (for the merge gate / A3 live run):**
    - `scripts/` is Lane 6's; this is orchestrator-directed work (as deploy-
      contracts.ts was in A1.5). Did not touch `.gitignore` — the default claim
      store is outside the repo, so no commit risk.
    - Pre-existing in deploy-testnet.ts (NOT changed, scope discipline): hardcoded
      default deployer keys (lines ~121-3, must be overridden via env for a real
      deploy); the contract-deploy `sendAs` omits an explicit fee and relies on the
      deployer's native Fee Juice balance after the claim — works once funded, but
      a single bridged claim must cover the account deploy + 3 contract deploys + 4
      wiring txs (8 total). The live A3 run will confirm the FeeAssetHandler mint is
      large enough; if not, fund the deployer twice or top up.
    - RESUME guidance: re-run a partial deploy with `--skip-account` (skips the
      claim path entirely); plain re-run without it re-bridges (claim not lost — it
      lands on the deployer, claimable later — but spends Sepolia gas).
    - Tests live in `scripts/lib/feeJuiceBridge.test.ts` (`node:test` via
      `npx tsx --test`), self-contained in scripts/ rather than a workspace package.
      Live bridging gated behind `TESTNET_L1_RPC_URL`+`TREASURY_L1_KEY`.

### A3 funder — gate-review fixes (2026-06-12)

17. **Tests run green under vitest + no longer orphaned.** The unit test used
    `node:test`, which vitest could not collect ("No test suite found in file" —
    a spurious failed-suite even though the 8 tests passed). Rewrote it as
    vitest-native (`describe`/`it`/`expect`, the repo convention). Added a root
    `npm run test:scripts` (`vitest run scripts`) so the script tests aren't
    orphaned by `npm test` (workspaces-only) — Lane 6 to wire it into CI (E3a).
    Green: `npx vitest run scripts/lib/feeJuiceBridge.test.ts` and
    `npm run test:scripts` both report 8 passed / 1 skipped (live, env-gated).
18. **deploy-testnet hardcoded default keys REMOVED (loud-fail).** Deleted the
    three committed default deployer keys (the old `account_details_do_not_commit`
    fallback — two operators relying on it would deploy to one shared account).
    Now: a real deploy REQUIRES DEPLOYER_SECRET/SALT/SIGNING_KEY and throws FAST
    (before the compile) if any is missing; `--create-account` mints a fresh
    RANDOM account and prints its keys (+ a `fund-testnet.ts` pointer). The real-
    deploy path no longer echoes secret material to logs. Verified the throw fires
    before any compile output.
19. **Re-typechecked against 4.3.1 (caveat resolved).** A2's npm bump is in;
    reinstalled (`@aztec/aztec.js` now 4.3.1 in node_modules). All three scripts
    `tsc` clean against 4.3.1, and `FeeJuicePaymentMethodWithClaim`'s ctor is
    unchanged from 4.2 (`(sender, Pick<L2AmountClaim,
    'claimAmount'|'claimSecret'|'messageLeafIndex'>)`) — no funder API drift.
