# docs/history — build-era archaeology

Reports and logs from the original build (February–April 2026), relocated from
the repo root. Nothing here is current documentation — see the root
[README.md](../../README.md) and [docs/plan/](../plan/) for that. The bug
reports are kept because they document real Aztec SDK issues and the
workarounds that still shape the code.

## Bug investigations

| File | What it is |
|------|------------|
| [AZTEC_IDB_BUG_REPORT.md](AZTEC_IDB_BUG_REPORT.md) | Upstream bug report: `TransactionInactiveError` in PXE `commitJob` after complex private simulations |
| [IDB_TRANSACTION_ERROR_REPORT.md](IDB_TRANSACTION_ERROR_REPORT.md) | First investigation of the same IndexedDB error |
| [IDB_TRANSACTION_ERROR_REPORT_V2.md](IDB_TRANSACTION_ERROR_REPORT_V2.md) | Second pass with narrowed repro |
| [IDB_INVESTIGATION_STATUS.md](IDB_INVESTIGATION_STATUS.md) | Final status: what was proven, what was ruled out. Outcome: all PXE operations are serialized per wallet (a standing ground rule) |
| [NOTE_DISCOVERY_BUG_REPORT.md](NOTE_DISCOVERY_BUG_REPORT.md) | Why notes created via `create_and_push_note` are not auto-discovered |
| [IMPORT_NOTE_DEBUGGING_REPORT.md](IMPORT_NOTE_DEBUGGING_REPORT.md) | Debugging trail that led to the `import_note`-after-every-minting-tx rule |
| [MCP_PLUGIN_IMPROVEMENT_REPORT.md](MCP_PLUGIN_IMPROVEMENT_REPORT.md) | Feedback report on the Aztec MCP plugin from this project's usage |

## Build specs and progress logs

| File | What it is |
|------|------------|
| [FIX_SPEC.md](FIX_SPEC.md) | Gap analysis between an early implementation and the original build brief |
| [FIX_SPEC_V5.md](FIX_SPEC_V5.md) | Spec for the in-browser proof generation + on-chain settlement arc |
| [GAME_LIFECYCLE_SPEC.md](GAME_LIFECYCLE_SPEC.md) | Design-era lifecycle spec (escrow/`prepare_for_game` flow, caller-supplied `game_id`). The implementation diverged: see [docs/ARCHITECTURE.md](../ARCHITECTURE.md) for what was actually built |
| [PROGRESS.json](PROGRESS.json) … [PROGRESS_V7.json](PROGRESS_V7.json) | Milestone trackers from the original agent-orchestrated build (7 generations) |
| [BLOCKERS.md](BLOCKERS.md) | Running blocker log from the same era |

## April 2026 state-of-the-repo reviews

| File | What it is |
|------|------------|
| [architecture_report_2026-04.md](architecture_report_2026-04.md) | Full architectural review: system diagrams, package breakdown, protocol flow |
| [test_report_2026-04.md](test_report_2026-04.md) | Test-suite inventory and quality assessment (~380 cases across ~46 files) |
| [test-batch-deploy-mint.mjs](test-batch-deploy-mint.mjs) | Standalone e2e script: account deploy + Fee Juice claim + starter-card mint in one tx |
