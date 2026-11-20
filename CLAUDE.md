# Axolotl Arena — contributor guide

Axolotl Arena (repo: `aztec-triple-triad`) is a Triple Triad card game on the
[Aztec Network](https://aztec.network). Cards are private NFTs; matches play out
off-chain with a client-side ZK proof per move, exchanged peer-to-peer over a
WebSocket relay. Only three transactions touch the chain per game — create,
join, settle — and settlement recursively verifies the full proof transcript
(2 hand proofs + 9 move proofs) inside one private function before transferring
the wagered card. See `README.md` for setup as a user; this file is for people
(and agents) changing the code.

## Current state (November 2026)

The app targets the **Aztec v6 testnet** (6.0.0 "Tierra", RPC
`https://aztec-testnet.drpc.org`, rollupVersion 679261766). Beware: the
testnet **re-genesises on protocol upgrades** — four times so far (2026-06-17
for v5, 2026-06-30 for rc.2, ~2026-08-28 onto the 5.2 line, and ~2026-10-27
onto v6, which also retired the `*.testnet.rpc.aztec-labs.com` hosts), each
time silently orphaning deployed contracts. Run
`npx tsx scripts/check-testnet-state.ts` when anything on-chain looks dead, and
expect to repeat this whenever the testnet moves. An Alpha **mainnet** also
runs 6.0.0 (`https://aztec-mainnet.drpc.org`); this app is not deployed there. The June-2026 lane-based
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
  bot/           Arena bot: backend opponent that queues, plays, proves and
                 settles like any player (docs/plan/BACKEND_OPPONENT.md)
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
| Aztec CLI / local network install | `6.0.0` (`.aztecrc` pins it) |
| npm `@aztec-labs/*` packages | `6.0.0` |
| npm `@aztec-foundation/bb.js` (and the other `@aztec-foundation/*`) | `6.0.0` — NOT npm `latest` (6.1.x) |
| aztec-nr git tag in `Nargo.toml` (contracts) | `v6.0.0` from `github.com/aztec-labs-eng/aztec-nr` |
| `bb_proof_verification` git tag (game contract) | `v6.0.0` from `AztecProtocol/aztec-packages` (`barretenberg/noir/bb_proof_verification`) |
| nargo / `@noir-lang/noir_js` | `1.0.0-rc.3` |
| poseidon git tag (circuits) | `v0.3.0` |
| Node.js | >= 24.15 |

One uniform set on **6.0.0** (November 2026), chosen to match the live testnet
node's `nodeVersion` EXACTLY — protocol compatibility is what matters, so pin
to the node, not to whatever npm calls `latest`. Treat it as one set — never
bump one without the others, never mix versions across packages. The
standalone circuits carry no aztec-nr deps (only poseidon); the three
contracts carry the aztec-nr tags.

**v6 moved things.** The npm scope `@aztec/*` stops at 5.3.0: v6 is
`@aztec-labs/*`, except the foundation packages (`bb.js`, `l1-artifacts`,
`noir-acvm_js`, `noir-noirc_abi`, `noir-types`, `noir-noir_codegen`), which are
`@aztec-foundation/*`. Subpaths are unchanged. aztec-nr lives in its own repo,
`aztec-labs-eng/aztec-nr`, with `directory = "aztec"` / `"field-note"` / … —
`AztecProtocol/aztec-packages` no longer carries it at v6 tags.

```bash
aztec-up install 6.0.0   # (patched — see below) then switch the active toolchain:
aztec-up use 6.0.0
```

**`aztec-up use` is not optional on v6.** `aztec start --local-network`
deploys its L1 contracts with `~/.aztec/current/internal-bin/forge`, whatever
binary you invoked — with `current` still on 5.2 it dies with
`unexpected argument '--disable-external-identification'`. Run contract and
circuit commands with `~/.aztec/current` actually on 6.0.0 (`aztec --version`).

**Install footgun (still there on 6.0.0).** The version installer `mv`s
noirup's `nargo` and `noir-profiler` out of a temp dir into `internal-bin`
and then `rm -rf`s that temp dir; a dangling symlink then reports ENOENT
exactly like a missing file (`spawn nargo ENOENT`). Upstream fixed the same bug
for the foundry binaries (`cp -Lp`) in 6.0.0, so there are now TWO call sites
to patch, not three:

```bash
curl -fsSL https://install.aztec-labs.com/<VERSION>/install -o /tmp/install.sh
# BSD sed wants `-i ''`; GNU sed (Linux, CI) wants `-i` or `-i.bak`.
sed -i '' -E 's|mv "\$temp_([A-Za-z_]+)/bin/([^"]+)"|cp -L "$temp_\1/bin/\2"|g' /tmp/install.sh
grep -cE 'cp -L "\$temp_[A-Za-z_]+/bin/' /tmp/install.sh    # expect 2 on 6.0.0
rm -rf ~/.aztec/versions/<VERSION>
VERSION=<VERSION> bash /tmp/install.sh
aztec-up use <VERSION>
```

Note the versioned installer writes ONLY to `versions/<VERSION>` — it never
touches `current` and never installs `aztec-up`, both of which belong to the
wrapper at install.aztec.network. Without `aztec-up` available, make the
symlink yourself: `ln -sfn ~/.aztec/versions/<VERSION> ~/.aztec/current`.

Always verify a "successful" install rather than trusting its exit code:
`~/.aztec/versions/<v>/bin/` non-empty, `node_modules/` present, and
`test -x ~/.aztec/versions/<v>/internal-bin/nargo` — `test -x` follows
symlinks, so it is what catches a dangling one.

`.github/workflows/ci.yml` does all of this; keep the two in step.

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

# contract tests: `aztec test` starts TXE on :8081 itself and runs nargo test
cd packages/contracts && aztec test
# (by hand: aztec start --txe --port 8081 & then
#  aztec-nargo test --oracle-resolver http://127.0.0.1:8081)
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

1. **Versions**: the pin set above, everywhere (uniform 6.0.0). Never mix
   Aztec versions across packages.
2. **Contracts compile with `aztec compile`**, not `nargo compile` (misses AVM
   transpilation + VK generation). Standalone circuits use `nargo compile`.
3. **Contract tests run against TXE** (see command above).
4. **Wallets**: ONLY `EmbeddedWallet` from `@aztec-labs/wallets/embedded` with
   `wallet.createSchnorrAccount(...)`. `test-wallet` / `TestWallet` (under
   either scope) is **FORBIDDEN**.
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
12. **Card packs are ONE transaction.** The audit's F6 (pack rarity is
    grindable by generating accounts) is **closed as irrelevant — do not
    reopen it.** It was once fixed by splitting buy and open into two
    transactions, which doubled the latency of a core flow on a chain where
    every tx is a client-side proof, to partially mitigate a Low finding about
    a resource with no value. It was reverted. If packs ever carry real value
    the fix is Aztec partial notes, still one transaction. See
    `docs/ARCHITECTURE.md` §7.
13. **The browser PXE has NO background sync** — its proof anchor advances only
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
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { GrumpkinScalar } from '@aztec-labs/foundation/curves/grumpkin';

const node = createAztecNodeClient(pxeUrl);
const wallet = await EmbeddedWallet.create(node, {
  ephemeral: false,                       // persist PXE state in IndexedDB
  pxeConfig: { proverEnabled: true },
});
const account = await wallet.createSchnorrAccount(secretFr, saltFr, signingKey);

// Account deployment pays fees by claiming bridged Fee Juice in the same tx:
const { FeeJuicePaymentMethodWithClaim } = await import('@aztec-labs/aztec.js/fee');
const paymentMethod = new FeeJuicePaymentMethodWithClaim(account.address, claim);
```

Contract calls take the sender explicitly:
`contract.methods.foo(...).send({ from: account.address, fee: { paymentMethod } })`.

An account's own deployment has no signer: send it with
`from: NO_FROM` (`@aztec-labs/aztec.js/account`). On v6 `AztecAddress.ZERO`
no longer means that — it fails `Account "0x00…00" does not exist on this
wallet`.

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
