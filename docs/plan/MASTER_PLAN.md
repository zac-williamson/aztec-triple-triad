# Axolotl Arena — Master Plan (June 2026 revival)

Status assessed 2026-06-12. This document is the source of truth for the parallel
revival effort. Each workstream ("lane") has its own brief in `docs/plan/LANE_*.md`
and its own git worktree. Read this file first, then your lane brief.

## Context

- Last commit `8ad7510` (2026-04-27). The final work arc (Apr 15–27) was deployment:
  testnet contract deploy, Vercel + Lightsail infra, tx-progress instrumentation,
  post-settle card persistence, and a started-but-unapplied card-asset compression pass.
- **The project is version-stranded.** `rpc.testnet.aztec-labs.com` now reports
  nodeVersion **4.3.1** on a new rollup deployment. The repo pins the 4.2.0
  release set (CLAUDE.md §Versions); the April testnet contracts no longer exist.
  The local sandbox at the pinned version still works — pre-upgrade work is not blocked.
- The app was feature-complete end-to-end in April: onboarding → starter cards →
  matchmaking → 3D game with per-move client-side ZK proofs → single-tx settlement
  (11 recursive proof verifications in `process_game`) → card transfer + ArenaToken
  rewards → card packs. Abandoned games handled via dummy_move proof padding and a
  5-block dispute window.

## Goals

1. **Demonstration app** for Aztec — show private-state gaming working for real.
2. **Learning resource** — clone, run, read, extend.
3. **Fun and playable** — a stranger can play within a minute of landing.

## Ground rules (apply to ALL lanes — violations have burned us before)

- Aztec version: one matched 4.2.0 release set until Lane 1 lands the 4.3.1
  upgrade — CLI/sandbox installer tag `4.2.0-nightly.20260323`, npm `@aztec/*`
  and aztec-nr Nargo tags `4.2.0-aztecnr-rc.2` (same release, different publish
  tags; see CLAUDE.md §Versions). Then **4.3.1 stable** pinned everywhere.
  Never mix versions across packages.
- Contracts compile with `aztec compile` (NOT `nargo compile` — misses AVM transpilation
  + VK generation). Standalone circuits use `nargo compile`.
- Contract tests need TXE: `TXE_PORT=8081 txe &` then
  `nargo test --oracle-resolver http://127.0.0.1:8081`.
- Wallets: ONLY `EmbeddedWallet` from `@aztec/wallets/embedded` with
  `wallet.createSchnorrAccount(...)`. `@aztec/test-wallet` / `TestWallet` is FORBIDDEN.
- **SponsoredFPC / SponsoredFeePaymentMethod is BANNED.** Fee Juice flows only.
- All PXE operations (txs, proofs, simulations) must be SERIAL per wallet —
  concurrency causes IndexedDB errors.
- Never hardcode storage slots — use `ContractName::storage_layout().field.slot`.
- `.simulate()` results stringify as DECIMAL — never `Fr.fromHexString()` them blindly;
  use the prefix-checking `toFr` helper (see `fieldUtils.ts`).
- Notes created via `create_and_push_note` are NOT auto-discovered — every such tx
  must be followed by `import_note` per note.
- `game_id` and `randomness` are derived IN-CIRCUIT — never pass them from frontend.
- `npm install --legacy-peer-deps` (React 18 + R3F v9 peer conflict).

## Work item catalog

| ID | Item | Lane | Effort | Hard deps |
|----|------|------|--------|-----------|
| S0 | Revoke leaked Vercel token (`../vercel_token.txt`) | Zac | 5 min | — |
| A1 | Noir upgrade to 4.3.1 (contracts + circuits + TXE green) | 1 | 2–5d | — |
| A2 | TS/SDK upgrade (frontend, integration, scripts) | 1+2 | 2–3d | A1 |
| A3 | Testnet redeploy, new addresses → .env.testnet/README | 1 | 0.5–1d | A1, A2, Zac funds deployer |
| B | useGame.ts decomposition (session/play/settlement hooks) | 2 | 2–3d | — |
| C | Privacy visibility panel ("you see / chain sees") | 2 | 1–3d | soft: B |
| D1 | Practice bot (D1a brain in game-logic, D1b practice UI) | 3 (UI: 2) | 1–2d | — |
| D2 | On-chain house bot (headless Node player) | 3 | 5–10d | A2, D1a |
| E1 | Repo hygiene, LICENSE, CLAUDE.md rewrite | 7 | 0.5d | — |
| E2 | ARCHITECTURE.md + Aztec concept→file:line index | 7 | 1–2d | partial: B |
| E3a | CI phase 1 (TS unit tests + tsc, sandbox-free) | 6 | 0.5d | — |
| E3b | CI phase 2 (Noir/TXE pinned to 4.3.1) | 6 | 1d | A1 |
| F1 | Run webp compression, switch Card.tsx/Card3D.tsx, delete PNGs | 6 | 0.5–1d | — |
| F1b | Git history slim (filter-repo force-push) — **end of cycle only** | 6 | 0.5d | F1, Zac decision, ALL lanes merged |
| F2 | Dead artifact purge (aggregate_game.json, *.bak, stray codegen) | 6 | 0.2d | — |
| G | Backend session-staleness fixes + 3 test assertion fixes | 4 | 0.5–1d | — |
| H+ | Autonomous playtest harness (see PLAYTEST_HARNESS.md) | 8 | 6–9d phased | fast mode needs Lane 1's dummy_hand |
| I | Funding/onboarding path (faucet spike → integration; NO SponsoredFPC) | 2 | 0.5d spike + 1–2d | A2/A3 |
| F3 | Go live (Lightsail + Vercel + domain + smoke) | 4+6 | 1–2d | A3, F1; soft: G, H+ |

## Dependency graph

```
WAVE 0 (start now, parallel)        WAVE 1            WAVE 2                  WAVE 3
════════════════════════════        ═════════         ══════════════          ═══════════
A1 Noir upgrade ──────────────────► A2 TS/SDK ───────► A3 redeploy ──────────► F3 GO LIVE
   │                                  ▲    │             │      ▲                ▲ ▲ ▲
   └────────────────► E3b CI-noir     │    │             ▼      │                │ │ │
B useGame split ──────────────────────┘    ├──────────► I faucet path ──────────┘ │ │
D1a bot brain ────────────────────────────►├──────────► C privacy panel           │ │
                                           ├──────────► D1b practice UI           │ │
G backend fixes ──────────────────────────►└──────────► D2 house bot ──► (post-launch OK)
H+ harness Ph1 on 4.2 sandbox ────────────► H+ rerun = A1/A2 acceptance ──────────┘ │
F1 webp ───────────────────────────────────────────────────────────► (gates F3 size) │
E1 · E2-core · E3a · F2  (free-floating, land anytime)                               │
F1b history slim ─── LAST, after all lanes merged, force-push ───────────────────────┘
```

**Critical path: A1 → A2 → A3 → F3 (≈ 6–11 ideal days).** D2 is the long pole and is
launch-optional (D1 already solves the empty-room problem).

## Lanes, worktrees, file ownership

Mainline branch: `testnet`. Lanes branch from it and merge back via PR/review.

| Lane | Worktree | Branch | Owns (exclusive write access) |
|------|----------|--------|-------------------------------|
| 1 Chain | `worktrees/lane-1-chain` | `lane/1-chain` | `packages/contracts/`, `circuits/`, Nargo.tomls |
| 2 Frontend | `worktrees/lane-2-frontend` | `lane/2-frontend` | `packages/frontend/src/` (hooks, aztec, components, App.tsx) |
| 3 Game/AI | `worktrees/lane-3-game-ai` | `lane/3-game-ai` | `packages/game-logic/`, `packages/bot/` (new) |
| 4 Backend | `worktrees/lane-4-backend` | `lane/4-backend` | `packages/backend/`, `deploy/` |
| 5 QA | `worktrees/lane-5-qa` | `lane/5-qa` | `docs/plan/CAMPAIGN_BACKLOG.md`, acceptance sign-offs |
| 6 Assets/Infra | `worktrees/lane-6-assets-infra` | `lane/6-assets-infra` | `scripts/`, `packages/frontend/public/`, `.github/`, `vercel.json` |
| 7 Docs | `worktrees/lane-7-docs` | `lane/7-docs` | repo root *.md, `docs/` (except docs/plan/CAMPAIGN_BACKLOG.md) |
| 8 Playtest | `worktrees/playtest` | `lane/8-playtest` | `packages/playtest/` (new), `packages/frontend/src/testkit/` (new) |

**Cross-lane exceptions (negotiated, keep them small):**
- Lane 8 owns `frontend/src/testkit/**` (new, additive) + one import line in `main.tsx`
  and data-testids on HUD components — coordinate timing with Lane 2.
- Lane 6's F1 touches `Card.tsx`/`Card3D.tsx` (.webp path switch) — merge early;
  Lane 2 rebases.
- Lane 2's A2 work bumps `@aztec/*` versions in package.jsons repo-wide — single
  atomic commit, announced.
- **Lane 2 internal order is strict: B → A2 fixes → C → D1b** (same files).

## Worktree conventions

- Asset sharing: lanes 1/3/4/6/7 are **sparse** worktrees — `packages/frontend/public/cards`
  (1.9GB) is excluded via `git sparse-checkout`. App-running worktrees (lane-2, lane-5,
  playtest) are full worktrees whose cards directory is an **APFS copy-on-write clone**
  (`cp -Rc` from the main checkout — instant, ~zero disk until modified; do NOT use
  symlinks: git reports tracked files behind a symlink as deleted). Lane 6 runs
  `git sparse-checkout disable` temporarily when doing F1 (needs real files), then
  re-enables.
- `node_modules` is NOT shared. Run `npm install --legacy-peer-deps` only in worktrees
  that need JS tooling (~1GB each); lanes 1 and 7 don't need it.
- Each worktree has an untracked `LANE.md` at its root identifying the lane.
- Rebase onto `testnet` at least daily; merge back in small reviewed increments.

## Decision points (Zac)

1. **S0 — revoke the Vercel token now** (it has sat in plaintext since April).
2. F1b history rewrite: force-push, breaks clones — schedule for END of cycle, yes/no.
3. Domain name + Lightsail/Vercel accounts for F3.
4. Fund the deployer account when A3 starts; fund a house account if D2 is greenlit.
5. Is D2 (on-chain house bot) in launch scope or post-launch?
