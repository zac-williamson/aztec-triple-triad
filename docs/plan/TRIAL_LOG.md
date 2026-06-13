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

## Pending handoffs (deliver at each lane's next idle)

- **ALL lanes**: `git rebase testnet` (≥ `ade31c7`) — sane CLAUDE.md, LICENSE,
  docs/history present.
- **lane-2**: remove live SponsoredFPC from `src/aztec/contracts.ts`,
  `hooks/useCardPacks.ts` (+ test) — banned pattern; fold into A2/I. Fix the
  `useGame.ts:433` comment path (report moved to docs/history/).
- **lane-6**: F2 addition — `test-results/.last-run.json` is tracked Playwright
  debris.
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
| lane-1-chain | A1+A1.5 merged | QA-F1 + nonce + aggregate twin | then A2 support |
| lane-2-frontend | B + C bundle merged | A2 (SDK 4.3.1 + SponsoredFPC removal) | D1b after |
| lane-3-game-ai | both items merged (1afb48e, 64f7e6d) | parked | D2 ← A2 + Zac decision |
| lane-4-backend | G + QA-F3 merged (bc50650, e08d840) | parked | D2-hook + F3 gated |
| lane-5-qa | backlog + §1.7 merged | parked | acceptance duty when playtest Phase 1 lands |
| lane-6-assets-infra | F1+F2+E3a merged | E3b (woken) | F3 ← A3+domain |
| lane-7-docs | all items merged | parked | E2.5 ← A3 |
| playtest | — | Harness Phase 1 | |
