# Lane 6 — Assets & Infrastructure (asset diet, CI, Vercel)

Branch `lane/6-assets-infra` · Worktree `worktrees/lane-6-assets-infra`
Owns: `scripts/`, `packages/frontend/public/`, `.github/`, `vercel.json`.

NOTE: this worktree is sparse — `packages/frontend/public/cards` is excluded.
Before F1, run `git sparse-checkout disable` here to materialize the real PNGs
(~2GB temporarily); re-enable after the PNG deletion lands.

## Mission
Make the app shippable and clonable: shrink 1.9GB of card art to web size, purge
dead artifacts, stand up CI, and own the Vercel half of go-live.

## Sequence

### F1 — Card asset compression (0.5–1d) — START HERE
`scripts/compress-card-assets.ts` is FINISHED and idempotent (sharp → WebP,
400×567 q80 final / 512×512 q85 board, `--dry-run`/`--force`/`--only` flags).
1. `git sparse-checkout disable` (this worktree only), then run the script.
2. Spot-check a sample of .webp in the browser.
3. Switch references: `components/Card.tsx` + `components3d/Card3D.tsx` (.png →
   .webp). These two files belong to Lane 2's area — merge this EARLY and tell
   Lane 2 to rebase (their B work is in hooks/, conflict risk is low).
4. `git rm` the source PNGs (expect ~1.9GB → ~40–80MB served).
5. Heads-up to Lane 8: testkit/campaigns must not assume .png paths.

### F2 — Dead artifact purge (0.2d)
- `git rm packages/frontend/public/circuits/aggregate_game.json` (its circuit
  source is deleted; zero references in frontend/integration src).
- Remove tracked `packages/contracts/target/*.bak` (now gitignored but still
  tracked → `git rm --cached`), stray cross-named codegen JSONs in target/,
  committed `coverage/` output in game-logic if tracked.

### E3a — CI phase 1 (0.5d) — parallel anytime
`.github/workflows/ci.yml`: on PR + push to testnet —
game-logic vitest (71 tests), backend vitest (Redis via service container),
frontend vitest + `tsc --noEmit`. All sandbox-free today. Cache node_modules
(`--legacy-peer-deps`!).

### E3b — CI phase 2 (1d) — after Lane 1's A1
Install Aztec toolchain pinned to 4.3.1 in CI, `aztec compile` contracts, run TXE
tests (`TXE_PORT=8081 txe &` + `--oracle-resolver`), `nargo` circuit tests.
Cache the toolchain — install is slow.
Later (with Lane 8's Phase 3): fast-mode campaign per-merge, real-proof nightly
(Chromium SwiftShader flags for WebGL).

### F3 (Vercel half) — go-live (0.5–1d) — after A3 + F1
NEW Vercel token first (S0 revoked the leaked one — never store it in a tracked or
plaintext file again). `scripts/sync-vercel-env.ts` for the 6 env vars (new A3
contract addresses), domain `play.<domain>` (Zac), verify COOP/COEP headers from
`vercel.json` actually arrive (WASM proving needs them), confirm deploy size is
sane post-F1.

### F1b — Git history slim — END OF CYCLE ONLY (0.5d + Zac decision)
`.git` is 2.5GB because PNG history is in it. `git filter-repo` to strip
`public/cards` PNG blobs → force-push → every clone/worktree must be recreated.
**Absolutely do not run while the 8 worktrees are active.** Schedule: after all
lanes merge, coordinated with Zac. Alternative if force-push is unacceptable:
fresh-start repo or keep originals in a GitHub Release.

## ASSUMPTIONS (discovered during execution)

- **F1 touches seven frontend files, not two.** The brief names `Card.tsx` +
  `Card3D.tsx`, but `/cards/*.png` references also live in `CardSelector.tsx`,
  `PackOpening.tsx`, `tutorial/tutorialCards.ts`, `assets/modelManifest.ts`
  (the `cardBack` texture path). Switching only the named two would 404 the
  rest once PNGs are deleted, so the same mechanical switch was applied to all
  — read as the intent of the cross-lane exception in MASTER_PLAN. Lane 2's
  rebase surface grows by file count, not by kind.
- **`card_back.png` was outside the compression script's coverage** (lives at
  `cards/` root, script handled only `final/` + `board/`). Added a third
  variant to the script (400×567 q80, same aspect) rather than a one-off
  conversion, so the pipeline stays reproducible.
- **`SwampScene.tsx` lines 82–83 were dead code**: `myCardImg`/`oppCardImg`
  referenced raw root-level `/cards/card-1.png`/`card-2.png` but were never
  read. Removed the two lines instead of switching them. (`myName`/`oppName`
  right below are also dead but reference no assets — left for Lane 2.)
- **Raw root `cards/card-N.png` originals (256 files, 453MB) deleted too.**
  Only referenced by the dead SwampScene lines; the brief's 40–80MB target is
  unreachable keeping them. Full-res originals survive in git history until
  F1b decides their fate (GitHub Release option noted there).
- **Kept**: the 50 `card-*.prompt.txt` generation-provenance files (tiny, no
  code refs) and `/ui-elements/card-pack.png` (UI element, not card art).
- **`generate-card-art.ts` still emits PNG by design** — regeneration flow is
  generate PNG → run `compress-card-assets.ts` → commit only the webp.
  `.gitignore` now blocks accidental PNG commits under `public/cards/`.
- **F2: `circuits/target/aggregate_game.json` is also tracked and equally dead**
  (the `aggregate_game` crate is gone from `circuits/Nargo.toml`), but
  `circuits/` is Lane 1's tree — flagged for them, not touched here. Both
  copy-circuits scripts no longer reference it, so it can't repollute
  `public/circuits/`.
- **F2: no cross-named codegen JSONs are tracked.** The cross-named files
  (`triple_triad_game-ArenaToken.json` etc.) are untracked symlinks that
  `scripts/test-all.sh` creates for TXE runs. The real risk was the frontend
  `copy-circuits`/`copy-contracts` `*.json` wildcards, which would sweep
  symlinks and strays into `public/` — made both explicit (matching the root
  scripts), which required one-line edits to root + frontend `package.json`
  (shared files, minimal diff).

## Cross-lane contracts
- **Provide:** .webp switch commit (→2 rebases), CI signal (→all), Vercel deploy
  (→5 smoke).
- **Consume:** 4.3.1 toolchain pin (←1), testnet addresses (←1's A3), domain +
  Vercel account + F1b decision (←Zac).
