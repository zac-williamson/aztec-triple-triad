# Lane 7 — Docs & Learning Resource

Branch `lane/7-docs` · Worktree `worktrees/lane-7-docs`
Owns: repo-root *.md files, `docs/` (except `docs/plan/CAMPAIGN_BACKLOG.md` — Lane 5's).

## Mission
Turn a workbench into a reference. The contracts already teach Aztec better than
most official examples — the repo around them has to stop hiding that.

## Sequence

### E1 — Repo hygiene + LICENSE + CLAUDE.md rewrite (0.5d) — START HERE
- Move to `docs/history/` (they're useful archaeology, not front-door material):
  `AZTEC_IDB_BUG_REPORT.md`, `IDB_TRANSACTION_ERROR_REPORT.md` + `_V2`,
  `IDB_INVESTIGATION_STATUS.md`, `NOTE_DISCOVERY_BUG_REPORT.md`,
  `IMPORT_NOTE_DEBUGGING_REPORT.md`, `MCP_PLUGIN_IMPROVEMENT_REPORT.md`,
  `FIX_SPEC.md`, `FIX_SPEC_V5.md`, `PROGRESS*.json` (all 7), `BLOCKERS.md`,
  `test-batch-deploy-mint.mjs`.
- Commit `architecture_report.md.m` → `docs/history/architecture_report_2026-04.md`
  and `test_report.md.m` similarly (currently untracked).
- Add `LICENSE` (MIT — README already declares it).
- Rewrite `CLAUDE.md`: it is currently the original AI build brief (genesis prompt).
  Replace with a lean contributor guide: project map, build/test commands, the
  Ground Rules from MASTER_PLAN.md, link to ARCHITECTURE.md. Drop the obsolete
  PROGRESS.json/orchestrator workflow and the stale SponsoredFPC examples (it's
  banned). KEEP the wallet-pattern and version-pin sections (updated to 4.3.1 once
  Lane 1 lands).

### E2 — ARCHITECTURE.md + concept index (1–2d)
`docs/ARCHITECTURE.md`:
- The lifecycle diagram: 3 on-chain txs (create/join/settle) + off-chain proof
  exchange; the 11-proof settlement (2 hand + 9 move, recursively verified in
  `process_game`).
- Note lifecycle: commit (pop 5 notes) → play → settle (re-mint with tagging) →
  frontend `import_note`. Include the abandoned-game path (dummy-proof padding,
  5-block dispute window).
- **Aztec concept → code index** (the highest-value table for learners):
  enqueued public calls → `triple_triad_game/src/main.nr` (`enqueue_self`);
  recursive proof verification → `process_game`; `Owned<PrivateSet>` storage →
  NFT contract storage block; custom note tagging + discovery → NFT
  `create_and_push_note` / `import_note` (~lines 1004–1070); in-circuit KDF
  randomness → `commit_five_nfts_create/join` + `derive_game_id`; dummy-proof
  padding → `claim_abandoned_game`; private↔public transfer →
  `transfer_private_to_public` / `mint_to_public_batch_*`.
- "Extend it" guide: add a card, change a rule (TS engine + circuit + tests must
  move together), fork the engine for another hidden-information game.
- Write contract/protocol sections NOW (stable). Frontend sections AFTER Lane 2's
  B merges (file:line refs would drift) — coordinate.

### E2.5 — README refresh (0.5d) — after A3
Update version pins to 4.3.1, new testnet addresses, link ARCHITECTURE.md, add the
live URL once F3 ships, add a "play in 60 seconds" section (practice mode needs no
funding).

## Cross-lane contracts
- **Provide:** the learning-resource layer (goal #2) — everyone reviews E2 for
  accuracy in their area.
- **Consume:** post-B hook structure (←2), 4.3.1 facts + addresses (←1), live URL
  (←6).

## Constraints
- Don't delete history, relocate it — git archaeology stays intact either way, but
  the front page must read like a reference implementation.
- Every claim in ARCHITECTURE.md gets a file:line anchor. No drift: doc PRs that
  reference moved code get blocked by the owning lane's review.
