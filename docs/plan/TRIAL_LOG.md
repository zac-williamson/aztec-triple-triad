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

## Pending handoffs (deliver at each lane's next idle)

- **ALL lanes**: `git rebase testnet` (≥ `ade31c7`) — sane CLAUDE.md, LICENSE,
  docs/history present.
- **lane-2**: remove live SponsoredFPC from `src/aztec/contracts.ts`,
  `hooks/useCardPacks.ts` (+ test) — banned pattern; fold into A2/I. Fix the
  `useGame.ts:433` comment path (report moved to docs/history/).
- **lane-6**: F2 addition — `test-results/.last-run.json` is tracked Playwright
  debris.
- **lane-1**: confirm nightly.20260323 ↔ aztecnr-rc.2 name the same release.
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
- **playtest** (from QA): C3 requires real-proof mode — dummy VKs collapse
  `claim_abandoned_game`'s real-vs-dummy discrimination (CAMPAIGN_BACKLOG §5).

### Lane state

| Lane | Last STATUS | Current item | Notes |
|------|-------------|--------------|-------|
| lane-1-chain | restarted fresh post-interruption | A1 | prior WIP uncommitted in worktree |
| lane-2-frontend | — | B | |
| lane-3-game-ai | — | D1a | |
| lane-4-backend | done → merged bc50650 | QA-F3 (room release) | D2-hook + F3 gated |
| lane-5-qa | done → merged 826e0d0 | standby + utility annotation | acceptance duty when playtest Phase 1 lands |
| lane-6-assets-infra | — | F1 | |
| lane-7-docs | E1+E2 merged (ade31c7, b249810) | standby | wake on lane-2 B merge (frontend sections), A3 (README) |
| playtest | — | Harness Phase 1 | |
