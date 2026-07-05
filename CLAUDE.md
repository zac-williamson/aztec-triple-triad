# Axolotl Arena — contributor guide

Axolotl Arena (repo: `aztec-triple-triad`) is a Triple Triad card game on the
[Aztec Network](https://aztec.network). Cards are private NFTs; matches play out
off-chain with a client-side ZK proof per move, exchanged peer-to-peer over a
WebSocket relay. Only three transactions touch the chain per game — create,
join, settle — and settlement recursively verifies the full proof transcript
(2 hand proofs + 9 move proofs) inside one private function before transferring
the wagered card. See `README.md` for setup as a user; this file is for people
(and agents) changing the code.

## Current state (July 2026)

The app runs on the **Aztec v5 testnet** (5.0.0-rc.2). Beware: the rc-series
testnet **re-genesises on protocol upgrades** (it did on 2026-06-17 for v5 and
again on 2026-06-30 for rc.2), silently orphaning deployed contracts — run
`npx tsx scripts/check-testnet-state.ts` when anything on-chain looks dead,
and expect one more redeploy when stable v5 ships. The June-2026 lane-based
revival (docs/plan/MASTER_PLAN.md) is finished; those docs are history, not
current process. `docs/history/V5_MIGRATION_REPORT.md` records the v4→v5
migration and its lessons (rate-limiter detour, idle-joiner anchor wedge).

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

| What | Pin |
|------|-----|
| Aztec CLI / sandbox install | `5.0.0-rc.2` (worktree `.aztecrc` pins it) |
| npm `@aztec/*` packages | `5.0.0-rc.2` |
| aztec-nr git tags in `Nargo.toml` (contracts) | `v5.0.0-rc.2` |
| nargo / `@noir-lang/noir_js` | `1.0.0-beta.22` |
| poseidon git tag (circuits) | `v0.3.0` |
| Node.js | >= 22 |

One uniform set on **5.0.0-rc.2** (July 2026; the testnet re-genesis'd onto it
2026-06-30). Treat it as one set — never bump one without the others, never mix
versions across packages. The standalone circuits carry no aztec-nr deps (only
poseidon); the three contracts carry the aztec-nr tags.

```bash
aztec-up install 5.0.0-rc.2   # then switch the active toolchain:
aztec-up use 5.0.0-rc.2
```

The committed `.aztecrc` pins the toolchain for this checkout, but run
contract/circuit commands with `~/.aztec/current` actually on 5.0.0-rc.2
(`aztec --version` to confirm). Install footgun: `aztec-up install` aborts
mid-way if anything (like a leftover sandbox `anvil`) blocks its bundled
foundryup — a "completed" install with an empty `versions/<v>/bin/` is a
broken one; re-run it.

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

# contract tests need a running TXE (the bare `txe` binary is gone since 4.3.1)
aztec start --txe --port 8081 &
cd packages/contracts && nargo test --oracle-resolver http://127.0.0.1:8081
# in TXE tests, cross-package deploys must use env.deploy("@package/Name") —
# bare names crash the TXE process (4.3.1-era upstream bug, see LANE_1_CHAIN.md)

npm test                              # CAUTION: runs EVERY workspace's `test`,
                                      # including playtest = full Playwright E2E
                                      # (boots a sandbox, ~45 min). For units:
npm test -w packages/game-logic -w packages/backend -w packages/frontend
npm run test:scripts
npm run test:all                      # full suite: Redis + TXE + every package

npx tsx scripts/check-testnet-state.ts   # is the testnet deploy still alive?
                                         # (detects the rc testnet's re-genesis)

cd packages/frontend && npm run dev:devnet    # or dev:testnet
```

## Ground rules (binding — violations have burned us before)

From `docs/plan/MASTER_PLAN.md`; repeated here because every one of these was
learned the hard way.

1. **Versions**: the pin set above, everywhere (uniform 5.0.0-rc.2). Never mix
   Aztec versions across packages.
2. **Contracts compile with `aztec compile`**, not `nargo compile` (misses AVM
   transpilation + VK generation). Standalone circuits use `nargo compile`.
3. **Contract tests run against TXE** (see command above).
4. **Wallets**: ONLY `EmbeddedWallet` from `@aztec/wallets/embedded` with
   `wallet.createSchnorrAccount(...)`. `@aztec/test-wallet` / `TestWallet` is
   **FORBIDDEN**.
5. **SponsoredFPC / `SponsoredFeePaymentMethod` is BANNED.** Fee Juice flows
   only: bridge + claim at account deployment, then senders pay natively
   (omit the `fee` option). The legacy usages were removed in A2.
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
12. **The browser PXE has NO background sync** — its proof anchor advances only
    inside an explicit `pxe.sync()`. Every wallet send must sync FIRST
    (`instrumentedWallet.sendTx` does; keep that parity with stock
    `EmbeddedWallet`), and idle windows are covered by
    `pxeKeepSynced.ts`. A send proving against a stale anchor gets pruned
    off the rc testnet ("Block hash … not found"), and once pruned the
    PXE's sync wedges permanently ("[PXE_WEDGED]" → Repair Chain Sync).

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
