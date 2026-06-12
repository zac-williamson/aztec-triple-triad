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

## Cross-lane contracts
- **Provide:** .webp switch commit (→2 rebases), CI signal (→all), Vercel deploy
  (→5 smoke).
- **Consume:** 4.3.1 toolchain pin (←1), testnet addresses (←1's A3), domain +
  Vercel account + F1b decision (←Zac).
