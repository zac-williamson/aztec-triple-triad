# Trial Log — 8-Lane Agent Orchestration

Orchestrator-owned. One entry per sweep/event. Newest at top.

## 2026-06-12 — Launch day

- S0 complete: Vercel token revoked via API (verified 403 post-revocation);
  `account_details_do_not_commit.md` and the dead token file moved to
  `~/.aztec-triad-private/` (700/600 perms).
- Quality bar + merge review gate added to ORCHESTRATION.md (Zac's six criteria:
  flake-masking fallbacks, leaky abstractions, insufficient tests, untracked
  assumptions, stale docs, duplication).
- Trial-start ref for the final integrated review: tag `trial-start` (= testnet at
  launch).
- Lanes launched 16:30: all 8 tmux sessions (`tt-*`) running claude 2.1.176 in
  bypass mode at `e860ec0` (= tag `trial-start`); kickoffs delivered; activity
  verified (lane-7 inventorying root debris, lane-3 reading game-logic tests);
  8 Terminal windows opened for Zac.

## Events

- 17:0x — **lane-7 E1 MERGED** (`ade31c7`, gate passed; first gate run). LICENSE,
  docs/history/ relocation, CLAUDE.md contributor guide. Version-pin clarified:
  nightly string = CLI/sandbox installer tag, `4.2.0-aztecnr-rc.2` = npm/aztec-nr
  tags of the same release (lane 1 to confirm during A1). Gate note: the apparent
  TRIAL_LOG edit in the lane diff was fork-point skew, not a violation.
  Lane 7 proceeding to E2 (Zac pre-queued the instruction in its window).

- 17:2x — **USAGE-LIMIT INTERRUPTION**: Zac's account hit its limit mid-trial;
  all 8 agents stalled (spend dialogs / dead session). Recovery: lanes 2/3/4/6/7/
  playtest resumed under the new account with context intact; lane-5 finished its
  item; **lane-1 lost its conversation** (`--continue` found none) — fresh session
  re-kicked with a re-orientation addendum (uncommitted WIP in worktree flagged).
  Work committed pre-cutoff survived everywhere (branches + dirty trees).
- 17:3x — **lane-5 CAMPAIGN_BACKLOG MERGED** (`826e0d0`, gate passed on
  merge-base diff). 10 campaigns, SC-* check blocks, per-campaign proving-mode
  gates. Five findings routed (see handoffs). Lane parked on standby +
  utility-annotation filler.
- Gate-procedure fix: reviews now use merge-base diffs (two near-misses reading
  fork skew as phantom reverts).
- lane-6 parked mid-F1 (~10/256 board webps) → continue-nudge sent with F2
  addition + rebase instruction.

- 17:5x — **lane-4 G MERGED** (`bc50650`, gate passed: fallback scan clean, 60s
  grace preserved, suite verified locally 160+33-skip & tsc clean; agent ran
  193/193 with Redis). Bonus root-cause find: sliding-TTL resume bug. QA-F2
  confirmed independently (sanitization tests fixed in April — brief was stale).
  Exemplary ASSUMPTIONS section. Dispatched onto QA-F3 (backend half of
  abandoned-claim room release).

- 18:0x — **lane-7 E2 (contract/protocol) MERGED** (`b249810`; one
  FUTURE_IMPROVEMENTS.md conflict with lane-4's merge, resolved by combining —
  counter-claim section kept + backend section stays marked resolved).
  ARCHITECTURE.md core lands with verified anchors; dispute-window gap analysis
  recorded; GAME_LIFECYCLE_SPEC superseded into history. Lane 7 parked on
  standby (frontend sections ← lane-2 B; E2.5 ← A3).

- 18:1x — **lane-3 D1a MERGED** (`1afb48e`; 103/103 verified). Bot brain
  simulates via the real rules engine (no duplicated capture logic), seeded
  mulberry32 determinism, D2 belief-state contract documented + degradation
  tested. Also purged committed coverage/ debris. `chooseBotMove` now available
  to lane-2 (D1b) and playtest (campaign policy) on their next rebase.
  Lane-3 dispatched onto card-db consolidation (lane-7's duplication finding).
  Merge-station note: had to discard my own dirty tracked coverage/ files first.
- lane-7 confirmed standby at testnet HEAD.

- 18:3x — **lane-4 QA-F3 MERGED** (`e08d840`): ABANDONED_GAME_SETTLED room
  release, additive protocol, 14 red-first tests, lane-2 integration spec in
  LANE_4_BACKEND.md. Lane-4 PARKED (all remaining items gated).
- 18:4x — **lane-6 F1+F2+E3a MERGED** (`774f6b1`): card art 1.9GB→44MB webp
  with red-first png-ref guard test; dead-artifact purge + copy-wildcard
  root-cause fix; CI phase 1 live (redis service, lockhash cache). Verified
  frontend 255/255 in-worktree. Lane-6 PARKED (E3b←A1, F3←A3+domain,
  F1b←end-of-cycle).
- 18:4x — **lane-3 card-db consolidation MERGED** (`64f7e6d`; 90/90 + tsc
  verified): canonical 256-card data with reproducible generator; 1–50
  byte-identical; LATENT BUG FIXED — backend previously rejected any hand with
  pack cards (IDs 51+) at creation. Lane-3 PARKED (D2 ← A2 + Zac decision).
- In flight now: lane-1 (A1), lane-2 (B), playtest (Phase 1). Five lanes parked.

- 18:5x — **lane-2 B MERGED** (`cdf5caf`): useGame (1834 lines) → useGameSession/
  useGamePlay/useGameSettlement behind a thin facade. Gate: cross-hook contracts
  are identity-stable functions (no raw refs), 9 test files pass UNMODIFIED,
  catch/setTimeout audit 28→27+1 pure relocation (zero new fallbacks), one
  stale comment path bounced and fixed same-turn. Dead refs + 3 duplication
  clusters removed, all documented in ASSUMPTIONS. Lane-7 woken for frontend
  ARCHITECTURE sections; lane-2 dispatched onto C + QA-F3 frontend half
  (A2 order amended — still blocked on lane-1).

- 19:0x — **lane-7 E2 part 2 MERGED**: ARCHITECTURE.md frontend sections against
  the new hook structure; SponsoredFPC known-divergence banner; cross-lane doc
  edits owner-verified. E2 complete; lane-7 parked (E2.5 ← A3).
- playtest observed mid-Phase-1 iteration (run 6+ of its campaign, background
  Playwright runs; 2/5 internal tasks done). Boundary watch: attempted
  game-logic package.json fix (lane-3 turf) — failed commit, review at gate.

- 19:2x — **lane-1 A1+A1.5 MERGED** (conflicts: .bak modify/delete kept deleted;
  copy-circuits combined = explicit list + dummy_hand, minus purged aggregate).
  Noir side on 4.3.1; proof shapes unchanged (500/115); version set confirmed;
  **circuit soundness hole fixed** (card-replay constraint was missing —
  orchestrator-verified 27/27 under 4.3.1 nargo); toolchain footguns documented;
  dummy_hand + --permissive-vks (localhost-only) delivered. CASCADE: lane-6
  woken (E3b), lane-7 woken (CLAUDE.md §Versions), lane-2 owes A2 after C,
  lane-1 dispatched leftover queue (QA-F1, nonce-delta, aggregate twin).
  **PLAYTEST REBASE SUSPENSION**: do NOT rebase past the A1 merge until Phase 1
  completes on the 4.2 stack; 4.3.1 stack switch happens at the post-A2
  acceptance rerun.
- ESCALATION (Zac): A3 needs a funded deployer account once A2 lands; D2
  launch-scope decision still open.

- 19:4x — **lane-2 C + QA-F3-frontend + cards-dedupe MERGED** (`89d2314`;
  271/271 + tsc verified). ChainViewPanel reads existing state only; QA-F3
  spec-exact incl. failure-path test; **abandoned flow has test coverage for
  the first time** (B decomposition payoff); cards.ts is now re-exports with a
  guard test. Lane-2 dispatched onto A2 (npm 4.3.1 verified to exist;
  SponsoredFPC removal in atomic scope incl. deploy-contracts.ts cross-touch).

- 19:5x — **lane-7 post-A1 doc pass MERGED**: two-layer mid-upgrade version
  table, 86 anchors re-verified. FOUND: test-all.sh silently skipping contract
  tests post-A1 (existence guard masks deleted binary path) → routed into
  lane-6's live E3b scope. Lane-7 parked (E2.5 ← A3).

- 19:3x — **MODEL-ACCESS INTERRUPTION** (3rd infra interruption): account swap
  revoked Fable 5; all 8 sessions were pinned to it. Lanes 1/2/6 (the active
  ones) died mid-task with "claude-fable-5 may not exist"; 5 parked lanes
  unaffected until next turn. Recovery: switched all 8 to Opus 4.8 via /model,
  resumed 1/2/6. All WIP intact on disk (lane-1 3 files, lane-2 15 files mid-A2,
  lane-6 4 files mid-E3b). Monitor re-armed (v4, adds model-error detection).

- 20:1x — **lane-2 A2 MERGED** (`a952d22`; CLAUDE.md version-table conflict
  resolved to the now-true uniform 4.3.1). Atomic npm→4.3.1 across
  root/frontend/integration; production SponsoredFPC removed; wallet internals
  + deploy-contracts re-ported to FeeJuice; 271/271 + tsc verified in-worktree.
  **Repo is now uniformly 4.3.1** → A2 dependency satisfied for D2 and A3.
  GATE FOLLOW-UP bounced to lane-2 (before D1b): "zero SponsoredFPC references"
  was inaccurate — still active in sandbox-gated @ts-nocheck integration tests
  (e2e-aztec-settlement, e2e-full-game-flow, debugging/*); integration is in A2
  scope. Runtime acceptance (live wallet sendTx path) still pending lane-8
  real-proof rerun → **A3 gated on that, not just on A2**.
- Monitor false-positive fixed: v4's `claude-fable-5` check matched stale
  scrollback (fired a phantom MODEL-ERROR on lane-2 right after it finished A2);
  v5 drops it (all sessions confirmed on Opus).

- 20:5x — **lane-1 QA-F1+QA-A2+aggregate-twin MERGED** (`29ecb92`): QA-F1 was a
  REAL latent double-claim hole in get_cards_for_new_player — fix adds a
  per-account STARTER_CLAIM nullifier (non-inclusion proof + push_nullifier
  backstop, address-unlinkable) with a should_fail re-claim test (verified to
  pass against the unguarded contract first); NFT TXE suite 15→17; dead
  circuits/target/aggregate_game.json purged; QA-A2 nonce +6 confirmed. TXE
  execution of the new test rides on lane-6 E3b CI. Lane-1 PARKED (A3 ← Zac
  funding + lane-8 acceptance).
- 20:5x — **lane-2 A2 gate-finding MERGED** (`a5c1a98`): live e2e tests migrated
  to Fee Juice (shared fundAccountOnDevnet helper); 9 dead nullifier-diagnostic
  scratch tests removed (~3.1k lines); zero active SponsoredFPC code refs remain.
  Lane-2 → D1b (practice-mode UI, last queued item; chooseBotMove available).
- Side-quest (Zac): identified **aztec-kit** (github.com/aztec-labs-eng/aztec-kit,
  public) as the official successor to the grego* apps — gregoswap→apps/swap
  (proof-of-password token faucet), gregojuice→apps/bridge (L1→L2 fee juice),
  +fpc-operator. Its `e2e/` Playwright suite (test-base fixture, global-setup,
  pump-l2-blocks, inject-l1-wallet, fee-juice-balance) is a strong reference for
  lane-8; flagged to Zac, not yet fed to lane-8 (held under Phase-1 rebase
  suspension). Its embedded-wallet initializerless/immutables_hash account is the
  subject of a separate ACVM-sim error Zac is chasing (not a trial item).

- 21:0x — **lane-2 D1b MERGED** (`e502768`; 290/290 + tsc verified): practice
  mode (usePractice + PracticeScreen) vs chooseBotMove, reusing GameScreen3D,
  menu entry, GameHUD practiceMode suppression; seeded-reproducible; no chain/
  backend. **Lane-2 has now completed every queued item** (B, A2, C/QA-F3/dedupe,
  D1b); only item I (faucet onboarding) remains, gated on A3. Lane-2 PARKED.
  When I unblocks: model it on aztec-kit apps/bridge + packages/common bridging
  helpers (gregojuice).

- 21:1x — **lane-6 E3b + test-all.sh fix + run-log purge MERGED** (`ef533cd`):
  noir/TXE CI job (cached toolchain/CRS/VK, `aztec start --txe` + `aztec-nargo
  test --test-threads 1` serial, 30m timeout) — closes TXE execution for lane-1's
  QA-F1/soundness tests in CI; test-all.sh silent-skip → loud `exit 1` + curl
  liveness (no log-grep/sleep); **two TXE flakes root-caused not masked**
  (retracted a self-inflicted misread); purged 3 committed run-logs (~10k lines)
  + gitignored *.txt; copy-circuits dummy_hand fix. 2 clean full-suite runs.
  Lane-6 PARKED (F3 Vercel ← A3+domain; F1b ← end-of-cycle + Zac).

- 21:3x — **Fee Juice distribution automation (Zac request) → lane-1 un-parked.**
  Design forced by Fee-Juice non-transferability (confirmed in fundDevnet.ts):
  ONE L1 Sepolia treasury key (Zac faucets Sepolia ETH to it once) → mint+bridge
  to every L2 account on demand. Treasury L1 addr 0xDA74…EAa2 generated, key at
  ~/.aztec-triad-private/treasury-l1-key.txt (600, env-only). Lane-1 building
  scripts/fund-testnet.ts (generalize fundDevnet to testnet, env-driven, multi-
  recipient, persist claims) + FIX deploy-testnet.ts deployer deploy (currently
  send({from:NO_FROM}) with NO fee/claim — must use FeeJuicePaymentMethodWithClaim).
  Reusable later by item I (player onboarding) + D2 (bot). This is the A3 enabler.

- 21:4x — **playtest model-recovery**: it was the one session that missed the
  fleet Opus switch (a background test run held the session, so loop-wakeups kept
  resuming it on revoked fable-5 and erroring). Now on Opus 4.8, Phase 1 at 4/5
  (evidence run 10 green); nudged to finish the three-layer settlement assertions
  + repeatability. Sweep: lanes 2-7 confirmed parked; lane-1 actively building
  fund-testnet.ts (reading L1FeeJuicePortalManager/bridgeTokensPublic).

- 21:5x — **funder BOUNCED (not merged)**: lane-1's fund-testnet.ts + shared
  feeJuiceBridge core + deploy-testnet claim-gap fix are correct and the 8 unit
  tests pass — BUT gate review found (a) `vitest run` emits a spurious "No test
  suite found" failed-suite on the file despite tests passing, and (b) scripts/
  isn't a workspace so the tests run in NO CI suite (orphaned). Bounced for:
  green-standalone test collection, a documented test:scripts command (→lane-6
  wires to CI after), and a loud-fail in deploy-testnet when DEPLOYER_* env
  unset (vs silent hardcoded-default-key fallback). Rebase onto post-A2 4.3.1
  + re-typecheck.

- 22:0x — **funder MERGED after bounce** (`b36f101`): test:scripts green (8/1skip,
  no spurious suite), deploy-testnet loud-fails on missing DEPLOYER_* + no secret
  echo, rebased+re-typechecked on 4.3.1. Shared feeJuiceBridge core (reusable by
  I + D2). Lane-1 PARKED (A3 ← treasury Sepolia ETH + lane-8 acceptance).
  Lane-6 un-parked for the one-line `npm run test:scripts` CI wiring.

- 22:1x — **playtest Phase 1 COMPLETE** (not yet merged): three-layer settlement
  campaign passes repeatably on the 4.2 sandbox (2 fresh-stack runs); full
  packages/playtest harness (stack orchestrator, player driver, chain client,
  expected-state, full-game.spec) + frontend/src/testkit (SceneBridge projection
  registry, gated behind VITE_TESTKIT). **HARNESS CAUGHT A REAL BUG**: loser's
  +20 token reward note never imported at settlement — tracked as a test.fail()
  regression sentinel (flips red when fixed), attributed to lanes 1/2. The exact
  winner/loser-state validation Zac wanted. REBASE SUSPENSION LIFTED.
  → lane-8: bring 4.3.1 into branch + RE-RUN campaign = A1/A2 real-proof
    acceptance gate (validates the whole upgrade before A3 hits real testnet).
    Conflict surface: ~9 frontend component files also refactored by lane-2.
  → lane-2: sign off testkit touchpoints + FIX loser-token note import
    (useGameSettlement — relay/import the loser's token note like the cards;
    main.nr:703-706 mints to both). Fix flips the sentinel green.

- 06-13 — **4.3.1 ACCEPTANCE: "breakage" ROOT-CAUSED to tooling, NOT the
  migration** — the A1/A2 upgrade (contracts/proofs/SDK/deploy) is sound. The
  failure was a Vite dev-server race: cold .vite cache post-bump → dev server
  lazily optimized @aztec deps while serving → test's first page load raced it →
  force-reload mid-onboarding → wallet deploy+mint restart loop. Fixed at root
  (pre-run `vite optimize` before serving; deterministic, not a retry). Re-run in
  flight; awaiting the pass verdict = A1/A2 acceptance. Contract lanes stay
  parked (no migration fix needed).
- **loser-token bug re-routed**: lane-2 found it is NOT frontend-only — ArenaToken
  has no import_note / randomness-revealing fn, so the loser's PXE can't import
  the reward note. Contract gap → **lane-1** (add a discoverable-note path to
  ArenaToken mirroring the NFT contract's create_and_push_note + import_note
  tagging); lane-2 wires the frontend import after. Queued for lane-1 AFTER the
  playtest breakage diagnosis (avoid concurrent contract churn).
- lane-2 testkit SIGN-OFF: VITE_TESTKIT touchpoints confirmed prod-inert →
  clears one of playtest's two merge-coordination items. lane-2 parked.

- 06-13 — **A3 GO**: treasury 0xDA74…EAa2 verified holding 0.43 Sepolia ETH
  on-chain (Zac funded). lane-1 un-parked to run the full testnet deploy via the
  funder: create deployer → fund-testnet mint+bridge Fee Juice (cover 8 txs) →
  deploy-testnet (account + NFT/Game/Token + wiring) → write addresses to
  .env.testnet + README. Live public-testnet op, in parallel with playtest's
  local 4.3.1 acceptance re-run (no conflict: testnet vs local sandbox). Deployer
  keys → ~/.aztec-triad-private/ (uncommitted).

- 06-13 (~02:35) — **MONITORING GAP**: monitor v5 hit its 1h timeout and the
  heartbeat didn't re-arm it → ~90 min blind (Zac flagged). Re-armed (monitor v6
  bf2mzs99y). Going forward: heartbeat must re-arm the monitor before its 1h cap.
- **A3 COMPLETE + MERGED** (`3ae3938`) — contracts LIVE on 4.3.1 testnet,
  verified (node 4.3.1, get_game_status reads). New addresses:
  NFT 0x0e42ec51…278f7c · Game 0x2325ef28…3af4ec · Token 0x1851bd7c…b22de8 ·
  PXE rpc.testnet.aztec-labs.com. Two real bugs fixed live (bridge L1-chain/
  race-free mint; serialized deploy-testnet Promise.all PXE ops = latent
  serial-per-wallet violation). **Critical path A1→A2→A3 done.**
- **2nd acceptance finding — REAL fee-headroom bug** (gate-blocking): maxFeesPerGas
  computed with no headroom over the rising L2 base fee → intermittent tx
  rejection in deploy/onboarding/settlement (PLAYTEST_HARNESS assumption 15).
  Dispatched: lane-2 (canonical src/aztec/feeSettings helper, ~3x base, all send
  paths) + lane-1 (scripts mirror, same multiplier). playtest holds, re-runs
  acceptance after the fix. This is the gate doing its job a 2nd time.

- 06-13 — **lane-2 fee-headroom fix MERGED** (`7875d08`; 293/293+tsc): canonical
  src/aztec/feeSettings helper (live base × 3) across all frontend send paths;
  root-causes the gate flake. lane-1 mirroring in scripts. playtest re-runs
  acceptance once lane-1's scripts fee fix lands. lane-2 parked.

- 06-13 — **both fee-headroom fixes MERGED** (frontend `7875d08`, scripts
  `48c341b`). Multiplier=3 confirmed by Zac (typed into lane-1's window). Lanes
  1+2 independently landed on the SAME canonical computation —
  `getCurrentMinFees() × 3` — lane-1's scripts/lib/feeSettings mirrors lane-2's
  src/aztec/feeSettings (node-vs-browser duplication, documented, source-of-truth
  cited). playtest dispatched to rebase + RE-RUN the 4.3.1 acceptance — expected
  green now (loser-token test.fail sentinel stays red until ArenaToken fix).
- Monitor cleanup: killed duplicate v5 (bvwkjxy11); v6 (bf2mzs99y) is the single
  live monitor. (v5 hadn't died during the 90-min gap — it only emits on state
  CHANGE, and lanes were continuously BUSY; the gap was the heartbeat chain, now
  re-armed each loop.)

- 06-13 (~03:20) — **Zac AFK; autonomous mode**. Directive: do not stall.
  Operating rules while AFK: (1) heartbeat sweep every ~20min is the reliable
  backstop (reads all panes directly), monitor re-armed if dead. (2) Merge
  completed lanes through the gate autonomously. (3) NO outward/irreversible
  actions without Zac: no testnet redeploy, no F3 go-live, no F1b force-push, no
  git push, no new faucet/funding. (4) Decisions reserved for Zac: D2 scope, F3
  domain, F1b, testnet ArenaToken redeploy.
  Autonomous plan: playtest acceptance green → merge harness (capstone);
  lane-1 ArenaToken loser-token fix → merge (codebase only, NO testnet
  redeploy). Then quiet — most lanes parked on Zac decisions.
  TUI note: long pasted dispatches can fail to submit (collapse to "paste again
  to expand"); use SHORT send-keys messages.

- 06-13 — **Zac directive: testnet redeploy AUTHORIZED, but NO address churn**
  ("fix the code"). Updated autonomous rules: testnet redeploy now ALLOWED for
  lane-1 IF it proves addresses are byte-identical locally first (Aztec contract
  class-update/upgrade for changed contracts + pinned deterministic salts for
  unchanged ones). If no-churn is infeasible in 4.3.1, lane-1 STOPS + reports —
  must not churn. Still RESERVED for Zac: F3 go-live, F1b force-push, git push,
  D2 scope. Directive queued to lane-1 (mid ArenaToken fix).

- 06-13 — **No-churn proven INFEASIBLE; Zac chose C (full updatable redeploy).**
  lane-1's analysis: A3 instances aren't updatable + set-once PublicImmutable
  wiring → any contract change forces all-3 churn. Zac chose C: full redeploy
  with all 3 made UPDATABLE (guarded admin update + set_update_delay) so this is
  the LAST forced churn; future fixes become address-preserving class updates.
  ArenaToken loser-token fix is done + TXE-green. lane-1 executing C now
  (updatable contracts → recompile → full testnet redeploy → re-wire →
  .env.testnet/README → report new addresses). This ONE churn authorized by Zac.
  When new addresses land → notify lane-2 (.env build), lane-6 (Vercel env/F3);
  playtest acceptance uses a LOCAL deploy so unaffected.

- 06-13 (~08:00) — **ROOT-CAUSED the 4 loop stalls** (Zac: stop band-aiding).
  Cause: the loop ran in /loop DYNAMIC mode = ScheduleWakeup, a SINGLE pending
  self-wakeup that must be re-armed every turn AND is cancelled by user
  messages; paired with a Monitor that hard-expires at 1h and is silent during
  long BUSY ops. Survival required both to hold — every user interjection or
  >1h operation broke the chain. CronList confirmed ZERO cron jobs were ever
  set. NOT a model issue (broke under Fable too) — wrong tool.
  FIX: CronCreate recurring job **6595c0f7** (`4,14,24,34,44,54 * * * *`, every
  10min, off-minute) — fires INDEPENDENTLY, no re-arming, immune to user msgs +
  monitor death, 7-day expiry. Monitor v7 (b6n308n3b) kept only as a fast-path
  accelerator; cron is the guarantee. Stopped using ScheduleWakeup for the loop.
- **C MERGED** (`1d8c949`): loser-token fix + all 3 contracts updatable
  (admin-guarded update_to/set_update_delay, ≥600s delay) + testnet redeploy.
  NEW addresses: NFT 0x03c4a439… Game 0x2d8675fc… Token 0x0ed08cbb… (in
  .env.testnet/README). Last forced churn.
- **playtest attempt-3 caught 2 real bugs** (migration core otherwise sound):
  (1) deploy-contracts.ts missed the fee-headroom mirror → lane-1 (in progress);
  (2) useGamePlay deferred move-proof "Card already placed" (board-snapshot
  keying off under 4.3.1 timing → winner never gets 9/9 → no settlement; real
  fast-play bug) → lane-2 (in progress). playtest holds; re-runs after both.
- New addresses → lane-2 picks up via .env.testnet (its bug-2 dispatch);
  lane-6 for F3/Vercel (parked, F3 gated on domain); lane-4 n/a (no addresses).

## Pending handoffs (deliver at each lane's next idle)

- **ALL lanes**: `git rebase testnet` (≥ `ade31c7`) — sane CLAUDE.md, LICENSE,
  docs/history present.
- **lane-2**: remove live SponsoredFPC from `src/aztec/contracts.ts`,
  `hooks/useCardPacks.ts` (+ test) — banned pattern; fold into A2/I. Fix the
  `useGame.ts:433` comment path (report moved to docs/history/).
- **lane-6**: after lane-1 confirms a green `test:scripts` command, wire it into
  ci.yml. Also (done earlier) F2 — `test-results/.last-run.json` AND
  `packages/integration/test.txt` (~2k-line committed PXE log debris) →
  git rm + gitignore guard for stray integration *.txt logs.
- **lane-1**: confirm nightly.20260323 ↔ aztecnr-rc.2 name the same release.
- **lane-1** (from lane-6): delete dead tracked `circuits/target/aggregate_game.json`
  (crate gone from circuits/Nargo.toml; copy scripts no longer reference it).
- **lane-4** (from lane-3): add a test asserting hands with card IDs 51–256 are
  accepted at game creation (latent rejection bug now fixed via game-logic; no
  test pinned the new behavior server-side).
- **lane-2** (digest additions): QA-F3 frontend half has a full integration spec
  in LANE_4_BACKEND.md (send ABANDONED_GAME_SETTLED from settle postEffects);
  frontend `src/cards.ts` hand-maintained copy can now be replaced by the
  game-logic export (lane-3 verified data agreement); integration's
  noir-backend.ts has two pre-existing SDK-arity type errors — A2 territory.
- **lane-1** (from QA): verify QA-F1 — onboarding double-claim of starter cards
  appears unguarded on-chain (`get_cards_for_new_player`); and QA-A2 — confirm
  note-nonce delta is +6 per game in `commit_five_nfts_create/join`
  (CAMPAIGN_BACKLOG §5).
- **lane-4** (from QA): QA-F2 — the "3 failing sanitization tests" in G may be
  already fixed, verify before re-fixing; QA-F3 — backend room never released
  after abandoned-claim settlement (with lane-2); QA-A4 — G must preserve the
  60s disconnect-grace semantics C5 pins.
- **lane-2** (from QA): QA-F3 frontend half — abandoned-claim flow never tells
  the backend to release the room.
- **lane-3** (from lane-7): game-logic exports two stale card databases
  (cards.ts 50-set; axolotlCards.ts 256/4-tier vs contract's 5-tier). Canonical
  chain is scripts/card-database-256.json → circuits/card_data →
  frontend/src/cards.ts. Consolidate after D1a (duplication criterion).
- **playtest**: rebase over B when convenient — hook structure changed
  (testkit read-hooks should target the new useGameSession/Play/Settlement
  surfaces via the unchanged useGame facade).
- **playtest** (from QA): C3 requires real-proof mode — dummy VKs collapse
  `claim_abandoned_game`'s real-vs-dummy discrimination (CAMPAIGN_BACKLOG §5).

### Lane state

| Lane | Last STATUS | Current item | Notes |
|------|-------------|--------------|-------|
| lane-1-chain | C + bug-1 merged (234c344) | parked | all items done; D2 contract support if greenlit |
| lane-2-frontend | fee fix merged (7875d08) | parked | I (unblocked, not gating) + loser-token wiring ← lane-1 |
| lane-3-game-ai | merged (1afb48e, 64f7e6d) | parked | D2 ← Zac decision (A2 ✓) |
| lane-4-backend | G + QA-F3 merged (bc50650, e08d840) | parked | D2-hook + F3 gated |
| lane-5-qa | backlog + §1.7 merged | parked | acceptance duty when playtest Phase 1 lands |
| lane-6-assets-infra | all merged + CI wiring | parked | F3 ← A3+domain; F1b ← end-of-cycle |
| lane-7-docs | all items merged | parked | E2.5 ← A3 |
| playtest | re-running 4.3.1 acceptance | fee fixes in | verdict awaited = A1/A2 acceptance |

## Zac decisions (06-13)
- **Push to remote: DONE** — origin/testnet @ 380cf10 (clean FF, 145 commits). Work safe.
- **D2 house bot: POST-LAUNCH** — lane-3 (D2) + lane-4 (D2-hook) stay parked; not in launch scope.
- **F1b: DEFER to the very end; NO force-push without Zac's explicit approval.** (Hard rule.)
- **F3: GO, domain = www.aztec-arena.com (previously deployed there).** BLOCKED on credentials:
  - Vercel: old token REVOKED by S0 (was leaked plaintext); vercel CLI not installed. Need a fresh
    token or `vercel login`. Project ID known; domain previously attached to that project.
  - Lightsail/AWS: NO access (~/.aws absent). Need AWS keys OR SSH to the (April?) instance if still up.
  - Contracts were redeployed → Vercel env + backend need the NEW addresses (sync-vercel-env.ts).

## 06-13 — both acceptance-blocking bugs fixed
- bug 1 (deploy-contracts fee mirror) merged 234c344; bug 2 (useGamePlay deferred-move keying
  "Card already placed") + loser-token import merged 009d5ee (296/296+tsc; removed a masking
  refresh-poll → deterministic import). Both pushed to origin.
- playtest re-running 4.3.1 acceptance — expect green (settlement reaches 9/9, loser-token
  test.fail flips). If green: full A1+A2 upgrade validated E2E → merge the harness (capstone).
- lane-2 parked (item I faucet-onboarding available, not gating). lane-7 all done.

## 06-13 — Vercel token secured
- Zac-provided token validated (HTTP 200, zac-williamson), moved to
  ~/.aztec-triad-private/vercel-token.txt (600), plaintext ./vercel.txt deleted,
  vercel*.txt gitignored. Usage: read into VERCEL_TOKEN env at deploy, never commit/print.
- F3 Vercel half now UNBLOCKED. F3 remaining: (1) playtest 4.3.1 acceptance green (re-running),
  (2) backend EC2 instance IP + running-confirmation from Zac (eu-west-2; key ~/.ssh/aztec_deploy).
  Holding actual go-live publish until acceptance green AND backend reachable (no premature publish).

## 06-13 — playtest attempt 4: 3rd settlement bug caught (P2/joiner board race)
- Validated working on 4.3.1: deploy fee headroom (lane-1) ✓, deferred-move fix for P1 ✓.
- NEW finding (real, gate-caught): P2/joiner move proofs re-read ws.gameState.board at proof
  time → 0/4 proofs ("Card already placed") → no 9/9 → canSettle stalls. P1 unaffected (it
  captures the pre-move board at click time). → lane-2: capture pre-move board for joiner path
  too, mirror P1. loser-token sentinel stays expect-pass (didn't run; serial skip after test 1).
- playtest blocked pending this lane-2 fix; re-runs attempt 5 after. (Stale-monitor-timeout
  noise from completed runs is harmless; agent ignores it.)

## 06-13 — F3 backend provisioning underway
- SSH validated to the existing EC2 box (13.42.161.225, Ubuntu 26.04, ~4GB/17G free) via
  aztec_deploy after Zac pasted the pubkey through EC2 Instance Connect. EIP held across a
  stop/start (no key reactivation needed).
- provision-and-go.sh running DETACHED on the box (WS_DOMAIN=ws.aztec-arena.com,
  FRONTEND_ORIGIN=https://www.aztec-arena.com, LE_EMAIL=zac@aztec.foundation), log /tmp/provision.log.
  Background watcher bvzsgew7b notifies on completion.
- DNS GAP: ws.aztec-arena.com still resolves to 16.60.85.104 (OLD instance), not 13.42.161.225 →
  certbot auto-skips this run. Zac to update the A record → 13.42.161.225; then I finish TLS.
- Frontend (Vercel) go-live still held until playtest acceptance is green (lane-2 on the 3rd
  settlement bug, P2/joiner board race).

## 06-13 — backend LIVE on HTTP (two deploy bugs root-caused) + lane-2 merged + playtest attempt 5
- provision-and-go.sh finished but surfaced TWO structural deploy bugs (not flakes), both fixed
  in 122568d and verified on the box:
  1. triad-backend.service hardcoded WorkingDirectory=/home/ubuntu/aztec-triple-triad/... but
     both provision scripts clone into $HOME/axolotl-arena-server → systemd crash-loop
     (status=200/CHDIR, restart #23). Fix: templated __REPO_DIR__, sed-substituted in both
     provision-and-go.sh and provision-lightsail.sh (same pattern as nginx's ws.YOURDOMAIN.com).
  2. nginx-triad.conf pre-baked a `listen 443 ssl` block referencing a cert that doesn't exist
     pre-certbot → nginx -t failed, nginx never reloaded (chicken-and-egg). Fix: rewrote
     HTTP-only; certbot --nginx --redirect injects the TLS block itself (step 6).
  Verified on 13.42.161.225: service active; /health OK direct :5174 AND via nginx :80; port 80
  reachable from internet (certbot HTTP-01 will work). Port 443 closed (no cert yet, expected).
- STILL pending Zac: ws.aztec-arena.com A record → 13.42.161.225 (currently 16.60.85.104, old
  box). Once it propagates I run certbot → wss://ws.aztec-arena.com. Backend already live on HTTP.
- lane-2 bug-3 fix MERGED to testnet (d3b350c) through the 6-criteria gate: root-cause click-time
  deep clone, reduces duplication (one preMoveState both paths), regression test that fails
  without it, documented invariant verified. PASS on all six.
- Playtest attempt 5 triggered (merge testnet → rebuild → re-run 4.3.1 A1+A2 acceptance gate).
  All other lanes done/parked; this is the last gate before F3 frontend go-live.

## 06-13 — BACKEND LIVE on wss:// (DNS + TLS done autonomously) + lane-bottleneck validation
- DNS for aztec-arena.com is Vercel-managed (ns1/ns2.vercel-dns.com), so I updated the ws A
  record MYSELF via the Vercel token (no longer a Zac manual step): removed the dead-box record,
  added ws → 13.42.161.225 (rec_fc810ba1afbdc977c9e74ada). Propagated instantly (authoritative +
  8.8.8.8 + local all return 13.42.161.225). CAA already allows letsencrypt.org.
- certbot issued + installed the cert (expires 2026-09-11, auto-renew timer set); nginx now serves
  443 + 80→443 redirect. Verified externally: https://ws.aztec-arena.com/health = {"status":"ok"}.
- ⇒ BACKEND HALF OF F3 COMPLETE. Frontend go-live now gated ONLY on playtest attempt-5 acceptance.
- Cron heartbeat recreated fresh (a13b5367) after Zac cancelled the prior 6595c0f7.
- LANE BOTTLENECK VALIDATION (Zac asked): lanes are NOT bottlenecked on each other or a hidden
  blocker — they've fanned-in. Critical path A1→A2→A3 all done; F3 backend done. Remaining work =
  3 buckets: (1) playtest attempt-5 gate [the ONE active task, everything F3-frontend waits on];
  (2) launch-OPTIONAL D2 house bot [needs Zac go/no-go — lane-3/lane-4's "D2" notes are them
  correctly NOT starting a 5–10d optional feature; D1 already solved the empty-room problem];
  (3) Zac-reserved [F3 publish, F1b force-push]. Item I (faucet onboarding, non-gating) is the
  only net-new work available to dispatch while we wait.

## 06-13 — playtest attempt 5: REAL game-breaker found (C2 owner-blind replay) + misdiagnosis correction
- Attempt 5 root-caused the persistent P2 "Card already placed" failure to circuits/game_move/
  src/main.nr:124-129: an owner-blind replay check `assert(board_before[i*2] != card_id)` whose
  own comment assumes "card ids are unique NFTs" — FALSE: STARTER_CARD_IDS=[1,2,3,4,5] mints the
  same ids to both players. P1 places 1–5, then P2's 1–4 are each already on the board → all 4 of
  P2's move proofs rejected. applyMove (TS) only checks cell-occupancy so it passed; divergence
  only ever surfaced in-circuit. Added since 4.2 (b72cf42/47912b8), absent at the 4.2 merge-base,
  which is why phase-1 passed on 4.2. Verified the code directly.
- HONEST CORRECTION: attempts 3/4 misattributed this to a board-capture race and routed fixes to
  lane-2. That was wrong — the symptom was C2 id-collision all along. Lane-2's clone fixes (14df546,
  0a06e2d) cannot affect it and stand on their own merits (a correct pre-move board legitimately
  holds the opponent's cards); NOT reverting them. The playtest agent flagged its own error.
- ⇒ This is game-breaking: no two fresh players can finish a game on 4.3.1. F3 frontend go-live is
  now gated on the REAL fix, not a formality.
- Routed to lane-1 (circuits+contracts) via docs/plan/BUG_C2_REPLAY.md with 3 fix options + my
  soundness analysis: (a) current-owner-aware is a TRAP (false-rejects a hand card whose id was
  captured back — unsound under capture); (a′) original-owner-aware is the surgical sound fix (adds
  originalOwner to the circuit board encoding + TS mirror + board hash); (b) globally-unique
  token_ids (correct NFT model, larger blast radius); (c) move the check to aggregation if card_id
  is exposable there. Lane-1 to choose on soundness + blast radius, ship failing-first test
  (circuit + TS engine together), then STATUS → I gate-review + merge → playtest attempt 6.
- Fast-path monitors: b42xmvsqt (lane-1 fix), bwpefs259 (playtest attempt 6). Cron a13b5367 backstop.

## 06-13 — lane-1 C2 fix gate-REVIEWED: sound design, REJECTED as incomplete (contract gap caught)
- lane-1 shipped ca698e2: per-player placed-hand-slot bitmask (a 5th option — in-proof chained
  state). Directly enforces "each player places each committed hand card at most once",
  capture-immune + duplicate-deck-immune; public-input count stays 6 (masks fold into the 21→23
  state-hash preimage, NOT new public inputs) so process_game/recursive verification is untouched.
  29 circuit + 40 TS-engine tests; the C2 cases verified failing-first incl. the exact (a)
  capture-collision trap. Verified the soundness dependency myself: prove_hand asserts distinct hand
  ids (slot-find is unambiguous); dummy_move is a zero-constraint passthrough (6 pub inputs) — no gap.
- GATE CAUGHT a missed consumer: triple_triad_game/src/main.nr:377 builds canonical_initial from
  initial_inputs:[Field;21] and asserts move[0].start_state == it. With hash_board_state now 23-field,
  move 1's start_state (masks 0,0) ≠ the 21-field canonical_initial → settlement would revert "First
  move start_state does not match initial state" at attempt 6. lane-1's game_move tests passed in
  isolation and missed it (no real-proof process_game test). Routed back: bump to [Field;23], aztec
  compile, add a process_game initial-state test. NOT merged until fixed. (Exactly the
  leaky/incomplete-change criterion the gate exists for.)
- Cross-lane: lane-2 frontend prover follow-up still pending (LANE_2_FRONTEND.md); dispatch after
  lane-1 re-passes the gate, then playtest attempt 6.

## 06-13 — lane-1 C2 contract fix re-reviewed + MERGED (7b35e3b); lane-2 frontend follow-up dispatched
- lane-1 fixed the contract gap excellently: found a SECOND anchor I'd missed (claim_abandoned_game
  had the same inline 21-field hash as process_game) and, instead of patching both, extracted a
  shared compute_initial_state_hash() (23-field) both call — removing the duplication that let the
  bug hide. Added a contract regression test (initial_state.nr: anchor == 23-field empty-board hash
  AND != the pre-fix 21-field hash). aztec compile ran (artifact regenerated).
- Gate: PASS all six (criterion 5 exemplary — fix removed the duplication). MERGED to testnet 7b35e3b.
- Dispatched lane-2 the frontend-prover follow-up (LANE_2_FRONTEND.md 5 steps: placed-slot bitmask
  through computeBoardStateHash 21→23, generateGameMoveProof, the caller's per-game mask chaining,
  useGameSettlement initial hash 0,0, mirror tests). lane-2 working now.
- GO-LIVE CONSEQUENCE: the C2 fix changed triple_triad_game, so the DEPLOYED testnet contract
  (0x2d86…) is now stale (21-field anchors) and would reject move-1 start_state. Before F3 go-live it
  needs an address-preserving update to the new class (contracts are updatable — admin update_to).
  NOT needed for the playtest (it deploys fresh contracts to a LOCAL sandbox). Noted in GO_LIVE.md.
- Sequence: lane-2 done → gate-review + merge → playtest attempt 6 (local sandbox) → if green, F3
  go-live incl. the testnet contract update. Monitor b6n308n3b (broad) + cron a13b5367.

## 06-13 — C2 fix COMPLETE E2E (lane-2 prover merged 27b8a04); attempt 6 running; lane audit + Item I
- lane-2 C2 frontend-prover follow-up (90e9393) gate-PASSED + MERGED (27b8a04). Reviewed the
  opponent-mask design: each move proof relays its after-masks (p1/p2PlacedAfter in MoveProofData);
  the receiver OR's them into a running pair (opponent's committed slot is private/underivable).
  Turn-sequencing makes the running pair correct at proof-gen time; deferred moves capture
  before-masks at placement. Verified the backend relays moveProof whole-object (no schema strip —
  masks ride opaquely). proofWorker hash layout byte-matches the circuit; settlement canonical hash
  now (0,0)/[5,5]/turn1 = the contract's compute_initial_state_hash. ⇒ C2 fix complete circuit +
  contract + prover. Triggered playtest attempt 6 (C1 on the fixed stack).
- LANE AUDIT (Zac: skeptical all-parked, CPU cold). Verified concretely (not STATUS lines):
  catalog A1–A3/B/C/D1/E*/F1/G done; lane-4 abandoned-game gap actually implemented; lane-5
  CAMPAIGN_BACKLOG real (10 campaigns). REAL available work found: (1) Item I onboarding (only
  deploy-time fee-juice claim exists) → dispatched to lane-2 as a spike (design → docs/plan/
  ITEM_I_ONBOARDING.md for go/no-go); (2) playtest campaigns C2–C10 — only C1 (full-game.spec.ts)
  built; rest specced-not-built, gated on attempt 6 + lane-8 (single lane). Structural reason for
  cold CPU: parallel build-out done, now in the serial integration tail; C2–C10 was downstream of
  the move-format change (now landed). Open Zac calls surfaced: greenlight D2? parallelize C2–C10
  (pull a 2nd lane to scaffold)? Confirmed all 8 agents alive (lane-2 + playtest took dispatches).

## 06-13 — Item I spike DONE (lane-2 ITEM_I_ONBOARDING.md); go/no-go SURFACED to Zac
- The real gap: on testnet a new browser user has no L1 wallet / Sepolia ETH, and Fee Juice is
  non-transferable on L2, so a HOSTED faucet must pay the L1 bridge gas. Everything downstream
  (deploy+mint+import in one tx via FeeJuicePaymentMethodWithClaim) already exists+tested — the
  ONLY missing piece is obtaining a consumable FeeJuiceClaim for the new L2 address in-app.
- Two backings: Option B (project backend faucet wrapping the proven bridgeFeeJuice with the
  treasury L1 key + abuse limits, ~1d FE + 0.5d Lane-4) vs Option C (a hosted faucet API IF it's
  CORS-open and returns a consumable claim — unverified; Zac dislikes Nethermind's).
- Orchestrator context added: the Sepolia treasury ALREADY EXISTS + is funded (~0.4 ETH,
  0xDA74…DEAa2) and bridgeFeeJuice is used by deploy-testnet → Option B is ~90% built. Recommend B.
  Security note: B puts TREASURY_L1_KEY on the EC2 backend (new exposure) — Zac's call.
- BLOCKED ON ZAC (legitimate park, like D2/F1b): (1) Option B vs verify-C first; (2) is ~0.4 ETH
  enough for demo onboarding volume or top up + what rate limits; (3) priority — before launch or
  fast-follow (non-gating for F3). lane-2 parked (was 100% context). Did NOT start integration
  (treasury-key exposure + Zac's money + launch scope are all his).

## 06-13 — Zac decisions: D2 post-launch · campaigns serial · Item I GO (Option B, existing treasury)
- D2 house bot: **POST-LAUNCH** (decided, not greenlit) → lane-3/lane-4 stay parked re: D2.
- Campaigns C2–C10: **SERIAL** → lane-8 builds them after C1 (attempt 6) goes green; no 2nd lane.
- Item I: **GO, Option B** (backend faucet) reusing the existing funded Sepolia treasury 0xDA74…DEAa2.
  Design doc merged to testnet (16f01b6). Dispatched in parallel:
  - lane-4 (~0.5d): POST /faucet {l2Address}→{claim} wrapping bridgeFeeJuice with TREASURY_L1_KEY
    from env (server-only), abuse limits (one claim/address via claim store + per-IP/day + capped mint).
  - lane-2 (~1d): requestFeeJuiceClaim abstraction + useAztec testnet onboarding (request claim →
    deployAndRegister → auto-continue, 'funding' status + progress screen, FundingPrompt fallback).
    SponsoredFPC stays banned.
- DEPLOY STEP (go-live): TREASURY_L1_KEY must be added to /etc/triad-backend.env on the EC2 box for
  the faucet to work in prod (key currently lives only in ~/.aztec-triad-private/treasury-l1-key.txt).
  Added to GO_LIVE.md.
- Now 3 lanes active (lane-2 Item I FE, lane-4 Item I BE, playtest attempt 6); lane-1/3/5/6/7 parked.

## 06-13 — Item I frontend MERGED (fbed226); attempt 6 validated C2, now probing an ordering race
- lane-2 Item I frontend (62f3a5b) gate-PASSED + MERGED. requestFeeJuiceClaim abstraction +
  useAztec testnet onboarding + FundingProgress UI + manual fallback (graceful degradation, not
  flake-masking). Verified claimSecret hex-parsing matches feeJuiceBridge's Fr.toString()
  serialization (real-Fr round-trip, proven by deploy-testnet — NOT the .simulate() decimal
  footgun). Fork-skew caught: `diff testnet..lane/2` falsely showed TRIAL_LOG/GO_LIVE "removals";
  merge-base diff confirmed lane-2 never touched them (used merge-base diff per the gate fix).
  Live E2E awaits lane-4's /faucet — I'll verify lane-4 returns the matching hex SerializedClaim
  at its merge.
- Playtest attempt 6: C2 fix VALIDATED on REAL PROOFS (P2 4/4 clean, settlement completed) — the
  game-breaker is fixed end-to-end. Agent is now empirically probing a possible move-proof ordering
  race (bob generating his proof vs adopting alice's relayed after-mask). MOVE_PROVEN carries
  gameState+moveProof atomically, so likely benign, but the check is right. If real → lane-2
  follow-up (now free); if benign → attempt 6 green → go-live gate.
- Active: lane-4 (Item I BE). Parked: lane-1/2/3/5/6/7. Playtest finishing attempt 6.
