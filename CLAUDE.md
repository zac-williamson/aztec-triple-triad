# Axolotl Arena — contributor guide

Axolotl Arena (repo: `aztec-triple-triad`) is a Triple Triad card game on the
[Aztec Network](https://aztec.network). Cards are private NFTs; matches play out
off-chain with a client-side ZK proof per move, exchanged peer-to-peer over a
WebSocket relay. Only three transactions touch the chain per game — create,
join, settle — and settlement recursively verifies the full proof transcript
(2 hand proofs + 9 move proofs) inside one private function before transferring
the wagered card. See `README.md` for setup as a user; this file is for people
(and agents) changing the code.

## Current effort (June 2026)

The project is being revived for the Aztec 4.3.1 testnet by parallel
workstreams. **`docs/plan/MASTER_PLAN.md` is the source of truth** — read it
before making changes; it defines lane file-ownership (who may edit what),
the dependency graph, and the ground rules repeated below. The April testnet
contracts no longer exist (the testnet was redeployed on a new rollup);
local-sandbox work at the pinned version is unaffected.

## Repo map

```
packages/
  game-logic/    Pure TypeScript rules engine (capture, scoring, win detection)
  backend/       WebSocket relay + matchmaking (Node, ws, Redis)
  frontend/      React + React Three Fiber app; all Aztec client code in src/aztec/
  contracts/     Aztec Noir contracts: triple_triad_nft, triple_triad_game, arena_token
  integration/   End-to-end tests against a live sandbox
circuits/        Standalone Noir circuits proven client-side:
                 prove_hand, game_move, dummy_move, card_data
scripts/         deploy-contracts.ts, deploy-testnet.ts, test-all.sh, card-art generation
                 (art generation reads the OpenAI key from ~/OPEN_API_KEY.txt)
deploy/          Lightsail provisioning + systemd units for the backend
docs/plan/       Revival master plan and per-lane briefs (binding)
docs/history/    Build-era bug reports and logs (archaeology, not current docs)
```

**`docs/ARCHITECTURE.md` is the contract/protocol reference** — the game
lifecycle, the 11-proof settlement, the note lifecycle, and an Aztec
concept→`file:line` index. Read it before touching contracts or circuits.
`TUTORIAL_SCRIPT.md` is the demo walkthrough script. `FUTURE_IMPROVEMENTS.md`
is the wishlist.

## Versions — matched sets, never bumped piecemeal

**The repo is mid-upgrade (A2 in progress).** The Noir layer moved to 4.3.1
(work item A1); the TypeScript layer stays on the 4.2.0 release set until A2
lands. Each layer is a matched set — bump it atomically or not at all.

| Layer | What | Pin |
|-------|------|-----|
| Noir (4.3.1) | Aztec CLI / sandbox / TXE — pinned per-checkout by `.aztecrc` | `4.3.1` |
| | aztec-nr git tags in every `Nargo.toml` (contracts + circuits) | `v4.3.1` |
| | nargo (ships inside the CLI toolchain) | `1.0.0-beta.21` |
| | poseidon git tag (circuits) | `v0.3.0` |
| TypeScript (until A2) | npm `@aztec/*` packages | `4.2.0-aztecnr-rc.2` |
| Both | Node.js | >= 22 |

The 4.2.0 set's two strings — installer tag `4.2.0-nightly.20260323`, package
tag `4.2.0-aztecnr-rc.2` — name the same release (the CLI self-reports the rc
tag; confirmed during A1). A2 moves the npm side to 4.3.1 and collapses this
table back to one row set.

```bash
aztec-up use 4.3.1     # switch an existing install; or install fresh:
bash -i <(curl -s https://install.aztec.network) 4.3.1
```

The committed `.aztecrc` pins the toolchain for this checkout. One 4.2-era
footgun while both toolchains coexist: the old CLI wrapper reads `.aztecrc`
only from `$PWD`, not ancestor directories — run contract/circuit commands
with `current` actually on 4.3.1 (details in `docs/plan/LANE_1_CHAIN.md`
ASSUMPTIONS).

## Build, run, test

```bash
npm install --legacy-peer-deps        # React 18 + R3F v9 peer conflict — always this flag

./start-sandbox.sh                    # sandbox with SEQ_MIN_TX_PER_BLOCK=0
                                      # (empty blocks needed for L1→L2 Fee Juice bridging)
npx tsx scripts/deploy-contracts.ts   # deploy NFT+Game+Token, writes frontend/.env
npm run copy-contracts                # contract artifacts → frontend/public/contracts/
npm run copy-circuits                 # circuit artifacts → frontend/public/circuits/

# contracts — aztec compile, NOT nargo compile (nargo misses AVM transpilation + VKs)
cd packages/contracts && aztec compile && aztec codegen target/ -o target/codegen

# standalone circuits — these DO use nargo
cd circuits && nargo compile

# contract tests need a running TXE (4.3.1 invocation — the bare `txe` binary is gone)
aztec start --txe --port 8081 &
cd packages/contracts && nargo test --oracle-resolver http://127.0.0.1:8081
# in TXE tests, cross-package deploys must use env.deploy("@package/Name") —
# bare names crash the TXE process (4.3.1 upstream bug, see LANE_1_CHAIN.md)

npm test                              # TS unit tests, all workspaces
npm run test:all                      # full suite: Redis + TXE + every package

cd packages/frontend && npm run dev:devnet    # or dev:testnet
```

## Ground rules (binding — violations have burned us before)

From `docs/plan/MASTER_PLAN.md`; repeated here because every one of these was
learned the hard way.

1. **Versions**: the layer sets above. Noir layer is on 4.3.1; the npm side
   stays on the 4.2.0 set until A2 lands. Never mix versions within a layer,
   never bump a layer piecemeal.
2. **Contracts compile with `aztec compile`**, not `nargo compile` (misses AVM
   transpilation + VK generation). Standalone circuits use `nargo compile`.
3. **Contract tests run against TXE** (see command above).
4. **Wallets**: ONLY `EmbeddedWallet` from `@aztec/wallets/embedded` with
   `wallet.createSchnorrAccount(...)`. `@aztec/test-wallet` / `TestWallet` is
   **FORBIDDEN**.
5. **SponsoredFPC / `SponsoredFeePaymentMethod` is BANNED.** Fee Juice flows
   only. (Legacy usages remain in the frontend pending removal — do not copy
   them into new code.)
6. **All PXE operations are SERIAL per wallet** — concurrent txs, proofs, or
   simulations cause IndexedDB `TransactionInactiveError` (full story in
   `docs/history/IDB_INVESTIGATION_STATUS.md`).
7. **Never hardcode storage slots** — use
   `ContractName::storage_layout().field.slot`.
8. **`.simulate()` results stringify as DECIMAL** — never `Fr.fromHexString()`
   them blindly; use the prefix-checking `toFr` helper in
   `packages/frontend/src/aztec/fieldUtils.ts`.
9. **Notes created via `create_and_push_note` are NOT auto-discovered** — every
   such tx must be followed by `import_note` per note.
10. **`game_id` and `randomness` are derived IN-CIRCUIT** — never pass them in
    from the frontend.
11. **`npm install --legacy-peer-deps`**, always.

## Wallet pattern

Canonical implementation: `packages/frontend/src/aztec/connectToAztec.ts`
(two-phase: prepare → fund → deploy). The skeleton:

```typescript
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { Fr } from '@aztec/aztec.js/fields';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';

const node = createAztecNodeClient(pxeUrl);
const wallet = await EmbeddedWallet.create(node, {
  ephemeral: false,                       // persist PXE state in IndexedDB
  pxeConfig: { proverEnabled: true },
});
const account = await wallet.createSchnorrAccount(secretFr, saltFr, signingKey);

// Account deployment pays fees by claiming bridged Fee Juice in the same tx:
const { FeeJuicePaymentMethodWithClaim } = await import('@aztec/aztec.js/fee');
const paymentMethod = new FeeJuicePaymentMethodWithClaim(account.address, claim);
```

Contract calls take the sender explicitly:
`contract.methods.foo(...).send({ from: account.address, fee: { paymentMethod } })`.

## Conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, …), small increments.
- Every behavior change ships with a test that fails without it.
- A change that invalidates a doc updates that doc in the same commit.
- Search for an existing helper before writing a new one — duplication blocks
  merge. Game rules live in `packages/game-logic` and its logic is mirrored in
  `circuits/` — a rule change must move the TS engine, the circuits, and their
  tests together.
- Don't mask flaky behavior with retries or fallbacks — root-cause it or stop
  and report.
