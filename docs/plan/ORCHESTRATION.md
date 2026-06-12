# Orchestration Runbook — 8-Lane Agent Trial

The orchestrator (Claude session in the main checkout `repo/`) drives 8 interactive
Claude Code agents, one per worktree, via tmux. Zac can attach to any window and
type directly at any time — human input always wins. Decided 2026-06-12:
agents run with `--dangerously-skip-permissions` (full bypass); launch deferred.

## Pre-launch checklist

1. **S0 first** (non-negotiable given bypass mode): revoke the leaked Vercel token
   (`../vercel_token.txt`) and move `../account_details_do_not_commit.md` out of the
   workspace — bypassed agents can read and execute anything on disk.
2. tmux installed (`brew install tmux`).
3. All 8 worktrees clean and fast-forwarded to `testnet` HEAD.

## Launch procedure

```bash
# one session per lane, claude started in bypass mode inside the worktree
for lane in lane-1-chain lane-2-frontend lane-3-game-ai lane-4-backend \
            lane-5-qa lane-6-assets-infra lane-7-docs playtest; do
  tmux new-session -d -s "tt-$lane" -c "/Users/zac/aztec-triple-triad-ui/worktrees/$lane" \
    'claude --dangerously-skip-permissions'
done

# open 8 Terminal windows for Zac, one attached to each
for lane in lane-1-chain lane-2-frontend lane-3-game-ai lane-4-backend \
            lane-5-qa lane-6-assets-infra lane-7-docs playtest; do
  osascript -e "tell app \"Terminal\" to do script \"tmux attach -t tt-$lane\""
done
```

Then send each agent its kickoff prompt (below) via
`tmux send-keys -t tt-<lane> '<prompt>' Enter`.

## Kickoff prompt template

Every prompt uses this skeleton (lane-specific parts in the table):

> You are the **{LANE}** agent in a multi-agent revival of this project. Read
> `LANE.md` in this directory, then `docs/plan/MASTER_PLAN.md` (its Ground Rules
> are binding), then your lane brief. IMPORTANT: this repo's `CLAUDE.md` is a stale
> genesis document — ignore its workflow sections (PROGRESS.json updates,
> orchestrator files, SponsoredFPC examples); MASTER_PLAN.md overrides it.
> Work ONLY within your lane's file ownership (see MASTER_PLAN §Lanes). Commit to
> your lane branch in small conventional-message increments. NEVER push. NEVER
> merge to testnet — the orchestrator does that.
> **Quality bar (binding — every item is checked at the merge gate):**
> (1) NO fallbacks, retries, or defensive recovery around flaky or unexplained
> behavior — root-cause the flake and fix it, or stop with `STATUS: blocked` plus
> your diagnosis. Masking a flake is a merge-blocker. (2) No leaky abstractions:
> callers must never need to know your module's internals; if your interface forces
> that, redesign the interface. (3) Every behavior change ships with a test that
> fails without it. (4) Update every document your change invalidates in the same
> commit. (5) Search for an existing helper before writing a new one — duplication
> is a merge-blocker. (6) Write down every assumption or hidden requirement you
> discover (add an ASSUMPTIONS section to your lane brief) — implicit knowledge is
> a defect. Begin with **{FIRST_ITEM}**.
> Done means: **{DONE}**. Protocol: end EVERY response with exactly one line
> `STATUS: working|done|blocked|question — <one short sentence>`. When done,
> blocked, or asking, stop and wait — the orchestrator sweeps periodically.

| Lane | FIRST_ITEM | DONE |
|------|-----------|------|
| lane-1-chain | A1 — Noir 4.3.1 upgrade (start `/aztec:aztec-version 4.3.1`); A1.5 (dummy_hand + `--permissive-vks`) may interleave | `aztec compile` clean + TXE tests green on 4.3.1; circuits compile; proof-shape changes announced in STATUS |
| lane-2-frontend | B — useGame decomposition | 3 hooks + facade; all 9 existing test files pass; `tsc --noEmit` clean |
| lane-3-game-ai | D1a — `chooseBotMove` in game-logic | seeded-deterministic, 3 difficulty tiers, unit tests added, coverage ≥ existing 99% |
| lane-4-backend | G — FUTURE_IMPROVEMENTS.md 4-point session fix + 3 sanitization-test fixes | backend suite green incl. previously-failing tests; skipped tests triaged in STATUS |
| lane-5-qa | CAMPAIGN_BACKLOG.md — the 10 specs in the lane brief | backlog committed; each campaign has setup/steps/3-layer assertions |
| lane-6-assets-infra | F1 — run compression (needs `git sparse-checkout disable` here first), then F2; E3a next | .webp generated + spot-checked; Card.tsx/Card3D.tsx switched; PNGs removed; F2 purged |
| lane-7-docs | E1 — hygiene + LICENSE + CLAUDE.md rewrite (PRIORITY: everyone benefits once merged) | root debris in docs/history/; LICENSE added; CLAUDE.md is a lean contributor guide |
| playtest | Harness Phase 1 per PLAYTEST_HARNESS.md, against the 4.2 local sandbox | one full click-driven game, two contexts, three-layer settlement assertions passing |

## Sweep protocol (orchestrator loop)

Self-paced wakeups, default every 15–20 min (tighter when a handoff is imminent):

1. `tmux capture-pane -p -t tt-<lane> -S -120` for each lane; find the last
   `STATUS:` line.
2. Classify: `working` → leave alone. `question`/`blocked` → answer via send-keys
   (or escalate, see below). `done` → run the **Merge review gate** below; only a
   clean pass merges `--no-ff` into `testnet`; then broadcast "rebase onto testnet"
   to affected lanes and send the next item.
3. Fire handoffs (table below).
4. Keep a running trial log in `docs/plan/TRIAL_LOG.md` (orchestrator-only file).

**Handoff table** (event → notify):
- E1 merged (lane 7) → ALL lanes: rebase now (sane CLAUDE.md).
- A1 green (lane 1) → lane 2 (start A2), lane 6 (E3b).
- A1.5 (dummy_hand + flag) → playtest (fast mode unblocked).
- D1a merged (lane 3) → lane 2 (D1b later), playtest (campaign policy).
- B merged (lane 2) → lane 7 (frontend doc sections), playtest (testkit timing), lane 6 (F1 component-switch rebase point).
- F1 merged (lane 6) → ALL rebase; playtest: no .png path assumptions.
- A2 done (lane 2) → lane 1 (A3), playtest (re-run acceptance), lane 3 (D2 if greenlit).
- A3 done (lane 1) → lanes 4+6 (F3), lane 2 (I), lane 7 (README refresh).

**Escalate to Zac only:** S0 confirmation, deployer-account funding (A3),
house-account funding + D2 go/no-go, domain name, F1b force-push decision,
anything outward-facing (pushes, deploys, external services).

## Merge review gate (orchestrator, before ANY lane merges to testnet)

Review `git diff testnet..lane/<x>` plus the lane's transcript against six criteria
(these are Zac's named endemic problems — treat each finding as a merge-blocker):

1. **Flake-masking fallbacks** — any new retry, fallback, backfill, defensive
   catch, or "recover if missing" path added around behavior the author cannot
   explain. Reject and demand the root cause; the fix is fixing the flake.
2. **Leaky abstractions** — interfaces that force callers to know internals
   (exposed refs, ordering requirements, "call X before Y" contracts not enforced
   by types/structure).
3. **Insufficient tests** — behavior changes without a test that fails on revert;
   tests that assert implementation rather than behavior.
4. **Untracked assumptions/requirements** — implicit env, ordering, version, or
   state requirements introduced but written down nowhere (lane brief ASSUMPTIONS,
   ARCHITECTURE, or README as appropriate).
5. **Stale documentation** — anything the diff invalidates (lane briefs,
   MASTER_PLAN, ARCHITECTURE, README, inline doc comments) not updated in the
   same change.
6. **Duplicated code** — re-implementations of existing helpers/utilities
   (check `game-logic`, `aztec/fieldUtils`, `txManager`, existing hooks first).

Also: run the lane's own test suite plus any neighbor suite its diff touches.
Findings go back to the agent via send-keys with concrete file:line references.
After ALL lanes complete, a final integrated review of the full
`git diff <trial-start>..testnet` applies the same six criteria across lane
boundaries (where leaks and duplication hide best).

## Recovery & conventions

- Orchestrator session dies → agents keep working; on resume: read TRIAL_LOG.md,
  sweep all panes, continue. tmux sessions survive closed Terminal windows
  (`tmux attach -t tt-<lane>` to reattach).
- Agent session dies → restart claude in that worktree with `--resume`, or re-send
  kickoff; work is safe on the lane branch.
- Zac takes over a window → orchestrator treats the next `STATUS:` line as
  authoritative and does not countermand human instructions; if a sweep finds
  no STATUS line after human activity, ask the agent to re-emit one.
- Merge station: ONLY the orchestrator merges to `testnet`, from the main checkout.
  Lane branches never touch each other directly.
- `docs/plan/` ownership: orchestrator-only, with two exceptions — each lane may
  edit its own `LANE_*.md` (ASSUMPTIONS and handoff notes encouraged), and
  `CAMPAIGN_BACKLOG.md` belongs to lane 5. `TRIAL_LOG.md`, `MASTER_PLAN.md`,
  `ORCHESTRATION.md`, `PLAYTEST_HARNESS.md` are never edited by lanes.
