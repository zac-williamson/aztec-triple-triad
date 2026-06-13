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

## ASSUMPTIONS (recorded during E1, 2026-06-12)
- **Version pin reality** — *CONFIRMED by Lane 1 during A1 (their ASSUMPTIONS
  item 1: the 4.2 CLI self-reports `4.2.0-aztecnr-rc.2`)*: MASTER_PLAN says the
  repo pins `v4.2.0-nightly.20260323` everywhere. Actual manifests pinned
  `4.2.0-aztecnr-rc.2` (all npm `@aztec/*` deps AND the aztec-nr git tags); the
  nightly string was only the CLI installer tag. Documented in CLAUDE.md as one
  matched set; superseded by the per-layer table after A1.
- **ARCHITECTURE.md link deferred**: the E1 brief says CLAUDE.md links
  ARCHITECTURE.md, which doesn't exist until E2. A dead link is worse; the link gets
  added in the E2 commit (same lane, same branch).
- **Untracked originals not deleted**: `architecture_report.md.m`, `test_report.md.m`,
  `test-batch-deploy-mint.mjs` were committed into `docs/history/` byte-identical
  (cmp-verified) from the main checkout; the untracked originals still sit at the
  main-checkout root — another worktree's working dir, not Lane 7's to clean. Safe
  to delete after this branch merges.
- **Kept at root deliberately** (not in the E1 move list, read as current material):
  `GAME_LIFECYCLE_SPEC.md`, `TUTORIAL_SCRIPT.md`, `FUTURE_IMPROVEMENTS.md`.

## ASSUMPTIONS (recorded during E2 part 1, 2026-06-12)
- **GAME_LIFECYCLE_SPEC.md archived beyond the E1 list**: it described the
  abandoned design — caller-supplied `game_id` (what ground rule #10 bans) and a
  `prepare_for_game` escrow flow the game contract never calls (verified:
  `triple_triad_game/src/main.nr` references none of
  `prepare_for_game`/`reclaim_card`/`unlock_cards`/`game_transfer`). A root spec
  contradicting ARCHITECTURE.md would be worse than a relocation outside the
  brief's letter. Archived with a superseded marker in docs/history/README.md.
- **ARCHITECTURE.md anchor convention**: full `path:line` on first mention,
  bare `:line` within a paragraph whose file is unambiguous. Anchors were
  machine bounds-checked and 21 load-bearing lines content-verified at commit
  time; they will drift only if contracts/circuits change (owning lanes review
  doc PRs per the constraint above — same applies in reverse).
- **Dispute-window semantics documented from code, not spec**: the window only
  remedies false claims against finished games; mid-game counter-claims are
  structurally impossible today (status no longer `active` after the first
  claim). Recorded in FUTURE_IMPROVEMENTS.md as a contract-change candidate.

## ASSUMPTIONS (recorded during E2 part 2, 2026-06-12)
- **§12 anchors target the post-B layout** as instructed; they drift if Lane 2
  refactors again — the same owning-lane review contract applies.
- **`proofWorker.ts` runs on the main thread** (no `Worker` anywhere in
  frontend src). §12.3 states this explicitly rather than letting the filename
  imply otherwise; whether to rename the module is Lane 2's call.
- **Fee-path divergence documented, not hidden**: §12.7 carries a "known
  divergence" banner — game txs still pay via SponsoredFPC
  (`aztec/contracts.ts:9-26`) pending work item I. The doc describes what IS,
  with the ban and the migration path stated.
- **Lane 3's §11 edit reviewed**: the four-copy must-agree list and
  `npm run generate:cards` match their consolidation commit (f2f716a).
  Cross-lane review contract satisfied in both directions.

## Handoff notes for other lanes (from E2)
- **Lane 3 (game-logic owner)** — *ACTIONED in f2f716a (consolidation +
  generator + pinning tests)*: `packages/game-logic` exports TWO stale card
  databases from `index.ts` — `cards.ts` (legacy 50-card set: ids 1–50,
  "Lerma" at id 50 vs canonical id 256) and `axolotlCards.ts` (256 different
  cards, 4-tier rarity scheme; canonical is 5-tier per `generate_card`,
  `triple_triad_nft/src/main.nr:17-49`). The canonical chain is
  `scripts/card-database-256.json` → `circuits/card_data/src/lib.nr` →
  `packages/frontend/src/cards.ts` (verified matching at ids 1 and 256).
  Anything importing game-logic's databases gets wrong data — duplication +
  divergence hazard, fits the D1a brain work.
- **Lane 1 / Lane 5**: mid-game abandoned-claim counter-claim gap (above) is a
  contract improvement candidate for the post-4.3.1 backlog.

## Handoff notes for other lanes (from the A1 doc pass, 2026-06-12)
- **Lane 6**: `scripts/test-all.sh:75` still launches TXE via the 4.2-era
  binary path (`~/.aztec/current/node_modules/.bin/txe`). Under 4.3.1 that
  binary is gone and the script's existence guard makes it **silently skip
  contract tests** instead of failing. Needs `aztec start --txe --port 8082`
  (see CLAUDE.md §Build, Lane 1's ASSUMPTIONS item 4).

## Handoff notes for other lanes (from E1)
- **Lane 2**: `packages/frontend/src/hooks/useGame.ts:433` comment references
  `IDB_TRANSACTION_ERROR_REPORT.md`, now at `docs/history/` — fix the path during B.
  SponsoredFPC is still used in `src/aztec/contracts.ts` and `hooks/useCardPacks.ts`
  (+ its test) despite the ban — CLAUDE.md flags them do-not-copy; removal lands
  with A2/I.
- **Lane 6 (F2)**: `test-results/.last-run.json` is tracked Playwright debris.
- **E2.5 self-note**: README's "copy arena_token artifact" step is redundant —
  `npm run copy-contracts` already includes all three artifacts.
