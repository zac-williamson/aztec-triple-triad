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

### A3 — testnet deploy EXECUTED (2026-06-13)

20. **Deployed to the live 4.3.1 testnet (Sepolia L1).** One-key funding + the
    claim-gap fix worked end to end. Addresses (also in
    packages/frontend/.env.testnet + README §Testnet):
    - Deployer: `0x2ddf3c4fdbb8a954343f3bc3c8cd455b2b66256eedbd1a8164c2033a1ac5026e`
    - NFT:   `0x0e42ec512f2a63e47d43ed2824628dff4fc5a38873d87afa261768e2c1278f7c`
    - Game:  `0x2325ef2879aed75990c6190b6db3ac455f8737cc18ab2133cd7acdfd8c3af4ec`
    - Token: `0x1851bd7c15d78bf29e159f3db3ab871dad80e8891922357d529bb0d8ebb22de8`
    Verified: node_getNodeInfo nodeVersion=4.3.1, l1ChainId=11155111; Game
    instance published on-chain; `get_game_status(123456)` returns cleanly
    (live + queryable). Deployer keys at ~/.aztec-triad-private/
    deployer-testnet-key.txt (600, uncommitted); claim store likewise outside
    the repo. NOTE: deploy-testnet.ts writes the gitignored `.env`; the tracked
    config is `.env.testnet`, updated by hand here.
21. **Two SDK-integration bugs found via the live deploy (fixed in
    feeJuiceBridge.ts):**
    - `createExtendedL1Client` does NOT auto-detect the chain (my earlier
      ASSUMPTION #14 was WRONG): with no chain it defaults to Anvil's 31337, so
      Sepolia rejects the signed tx ("invalid chain id for signer: have 31337
      want 11155111"). Fixed by reading the L1 chain id from the RPC
      (eth_chainId) and passing an explicit `defineChain`. Reads don't sign, so
      the mint-amount probe had worked — only the bridge write failed.
    - The SDK's `tokenManager.mint()` submits its tx but does NOT await the
      receipt (unlike approve/deposit), so `bridgeTokensPublic(..., mint=true)`
      fires the approve before the mint mines → nonce collision → "replacement
      transaction underpriced" on the load-balanced publicnode RPC (the approve's
      nonce came from a backend that hadn't seen the pending mint). Fixed by
      NOT using mint=true: ensure the funder holds the Fee Juice ERC20 (mint +
      poll-until-balance-lands only if needed), then bridge with mint=false,
      where approve() awaits its receipt before the deposit — race-free on any
      RPC. publicnode.com was fine once the un-awaited mint was removed, so no
      RPC change was needed.
22. **Serialized deploy-testnet's concurrent PXE ops** (ground rule: SERIAL per
    wallet). NFT+Token deploy, registerSender batch, and the 4 wiring txs were
    `Promise.all` — now sequential awaits. The VK-hash `Promise.all` is bb.js
    (not a wallet op) and left parallel. With real proofs each tx took ~1-2 min;
    all 8 txs (account + 3 deploys + 4 wiring) landed with revertCode 0.
23. **Cross-lane touches (A3, orchestrator-directed):** README.md (Lane 7) and
    packages/frontend/.env.testnet (frontend) — both explicitly in the A3
    instructions; flagged for those lanes at the merge gate.

### Fee-headroom fix in deploy/fund scripts (2026-06-13, paired with lane-2)

24. **L2 maxFeesPerGas now has headroom over the rising base fee.** Root cause
    (traced in the SDK): the stock wallet's completeFeeOptions sets
    `maxFeesPerGas = gasSettings?.maxFeesPerGas ?? getCurrentMinFees().mul(1 +
    minFeePadding)`, and `minFeePadding` defaults to 0.5 — i.e. only 1.5x the
    current L2 min fee. If the base fee rises more than that between estimation
    and inclusion, the tx is rejected. Crucially the `??` means a caller-supplied
    maxFeesPerGas IS respected, so the stock wallet CAN take headroom — no
    instrumented wallet needed in the scripts. New scripts/lib/feeSettings.ts:
    `headroomMaxFeesPerGas(node) = (await node.getCurrentMinFees()).mul(
    FEE_HEADROOM_MULTIPLIER)`, computed fresh per tx. deploy-testnet passes it as
    `fee.gasSettings.maxFeesPerGas` on every send (account deploy + 3 deploys + 4
    wiring). Unit test in feeSettings.test.ts.
25. **MULTIPLIER COORDINATION (needs orchestrator/lane-2 confirmation).** lane-2's
    `src/aztec/feeSettings.ts` is the named source of truth but does not exist yet,
    so I DEFINED the canonical computation for them to mirror exactly:
    **base = `node.getCurrentMinFees()`, multiplier = `FEE_HEADROOM_MULTIPLIER = 3`**
    (3x = double the stock 1.5x). maxFeesPerGas is only a CEILING — the tx still
    pays the actual base fee — so a generous multiple costs nothing but needs Fee
    Juice to cover the (maxFeesPerGas * gasLimit) reservation (abundant: deployer
    holds ~1e21). lane-2 MUST adopt the same base + multiplier; flagged for the
    merge gate. Did not re-deploy to exercise it live (that would churn the live
    A3 addresses) — verified by SDK source trace + typecheck + unit test; the next
    redeploy / the frontend exercises it for real.
26. **fund-testnet is L1-only — headroom N/A.** It sends NO L2 txs (L1 bridge +
    L1->L2 reads only; L1 gas is viem's), so the L2 maxFeesPerGas headroom does
    not apply there. Documented in its header; the shared helper is ready if it
    ever grows an L2 tx.

### ArenaToken loser-token fix + redeploy infeasibility (2026-06-13)

27. **Loser +20 reward made discoverable (playtest-gate bug).** process_game
    rewarded both players via ArenaToken::mint_private (ONCHAIN_CONSTRAINED) —
    only the settle submitter (winner) discovers their note; the loser can't.
    Mirrored the NFT card pattern on ArenaToken's UintNote/BalanceSet model:
    `mint_reward(to, amount, player_randomness)` creates a DISCOVERABLE balance
    note (manual UintNote hash via its own compute_note_hash + notify_created_note
    + push_note_hash; randomness derived from the recipient's PRIVATE per-game
    randomness, so it's recipient-derivable but not public), `import_note(...)`
    mirrors the NFT's, and `compute_reward_randomness(...)` is the relay/derive
    getter. process_game mints the opponent's reward via mint_reward in win/loss
    AND draw paths; the submitter keeps mint_private. The reward stays a real
    balance note (spendable via burn_from). TXE test proves balance 0 -> 20 across
    import. Game contract changed too (it calls mint_reward).
28. **TXE flake root-caused (refines ASSUMPTIONS #12).** `mdb_txn_begin: 22 -
    Invalid argument` is NOT only stale processes: even one clean TXE flakes
    intermittently because `nargo test` runs multi-threaded by default and the
    single TXE's LMDB world-state can't take concurrent write txns. Fix:
    `nargo test --test-threads 1` — deterministically green (arena 11, game 6,
    nft 17). Flag for Lane 6 CI (E3b): TXE tests MUST run single-threaded.
29. **Address-preserving testnet redeploy is INFEASIBLE for the live instances
    (STOP — reported to Zac via STATUS: question).** The fix changes BOTH
    ArenaToken and Game (Game calls mint_reward), so both have new contract class
    ids. A contract address derives from `originalContractClassId`; only an
    UPDATABLE instance can change its `currentContractClassId` while keeping the
    address. The A3 instances are NOT updatable: confirmed on-chain that all three
    have original==current class id, the contracts contain no self-update code
    (no set_update_delay / ContractInstanceRegistry calls), and the A3 deploy used
    plain Contract.deploy with no update delay. You cannot redeploy over an
    existing address (deployment nullifier), and you cannot update a
    non-updatable instance. So NFT (unchanged) keeps its address for free, but
    ArenaToken+Game addresses cannot be preserved while shipping the fix. Did NOT
    churn. Options put to Zac: (A) don't redeploy now — fix lands on testnet only
    at the next full (churning) redeploy; (B) churn ArenaToken+Game now, keep NFT;
    (C) redeploy all three as UPDATABLE now (one last forced churn) so future
    fixes are address-preserving.

### Updatable redeploy (Option C — 2026-06-13)

30. **All 3 contracts made updatable, then full testnet redeploy (the LAST forced
    churn).** Zac authorized one churn to move to updatable instances. Each
    contract got admin-only `update_to(new_class_id)` + `set_update_delay(delay)`
    that enqueue the ContractInstanceRegistry (canonical pattern; admin =
    ArenaToken.admin / NFT.minter / new Game.admin). Future code fixes are now
    address-preserving class updates — no more churn. Deploy activates it with
    `set_update_delay(600)` (= MINIMUM_UPDATE_DELAY) per instance.
    NEW testnet addresses (in .env.testnet + README; deployer reused from A3):
    - Deployer: `0x2ddf3c4fdbb8a954343f3bc3c8cd455b2b66256eedbd1a8164c2033a1ac5026e`
    - NFT:   `0x03c4a439df5a6b44a645037050b9de4af201f4327240c09b2c0a77fba5d59a9c`
    - Game:  `0x2d8675fc746e38ff6606cae2836c0cd0fa1693b12edb56396f83a530109b75f4`
    - Token: `0x0ed08cbbb2eac1213186c99787736e0ee768dfa9ffa9dfc1a4b9c1d741e870fb`
    Verified: node 4.3.1, all 3 instances published, Game `get_game_status` reads
    live, deployed Game class has `update_to` (updatable). The OLD A3 addresses
    are abandoned; lanes 2/4/6 must repoint to the new ones.
31. **Transient P2P drop on the first redeploy attempt** ("Tx dropped by P2P
    node" on the NFT deploy; simulation had passed). Diagnosed as transient, NOT
    fee/balance: the L2 base fee was 4.2e12/gas and my fee-headroom set
    maxFeesPerGas to 3x that — higher than A3's successful 1.5x default — with
    ~1e21 balance (>> ~4.6e18/tx). First deploy dropped => clean state, so a
    single diagnosis-driven retry succeeded with no changes. Confirms public-
    testnet txs occasionally drop at the mempool; the deploy script's env-var
    resume (NFT_ADDRESS/TOKEN_ADDRESS/GAME_ADDRESS + --skip-account) covers a
    mid-deploy drop.
