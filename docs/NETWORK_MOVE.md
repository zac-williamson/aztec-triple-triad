# Moving to a new Aztec network version

The testnet re-genesises on protocol upgrades: every deployed contract is
orphaned and, from v6 on, the old RPC host can disappear with it. This is the
procedure that brought the app from 5.2 to 6.0.0 on 20 November 2026, in the
order it has to happen. Each step names the check that proves it worked; a green
build is not one of them. Most steps here broke at least once.

Expect a few hours if nothing surprising happens. Don't start the cutover
(step 7) while a game or a test run is in flight: a redeploy kills in-flight
settlements.

## 0. Confirm the move

- The uptime workflow fails, or `npx tsx scripts/check-testnet-state.ts` exits
  non-zero.
- Read the live node, not npm: `node_getNodeInfo` against the endpoint on
  <https://docs.aztec.network/networks> gives `nodeVersion` and
  `rollupVersion`. **Pin to `nodeVersion`**, never to npm `latest`.
- Read the migration notes for every version in between
  (<https://docs.aztec.network/developers/migration_notes>). Package scopes and
  repositories move too (v6: `@aztec/*` became `@aztec-labs/*` and
  `@aztec-foundation/*`; aztec-nr moved to `aztec-labs-eng/aztec-nr`).

## 1. Toolchain

Follow CLAUDE.md "Versions": download the version's installer, patch the
`mv "$temp_…"` lines to `cp -L` (check the count it prints), install, then
`aztec-up use <version>`. **`use` is required**: the local network deploys its L1
contracts through `~/.aztec/current`. Check `test -x` on every binary in
`~/.aztec/versions/<v>/internal-bin/`, and that the version's Node minimum is
met (v6: 24.15).

## 2. Bump the matched set

- npm deps in `package.json`, `packages/frontend/package.json`,
  `packages/integration/package.json`; the `@noir-lang/noir_js` version must
  equal the toolchain's nargo.
- Every import specifier if a scope moved (mechanical rewrite across the
  repo; leave `docs/history` alone).
- aztec-nr tags in the three `packages/contracts/*/Nargo.toml`.
- `.aztecrc`, the CI Node version, and the RPC defaults (grep for the old host).
- `npm install --legacy-peer-deps`.

## 3. Build and unit-test everything

```bash
cd packages/contracts && aztec compile && aztec test && aztec codegen target/ -o target/codegen
cd circuits && aztec-nargo compile && aztec-nargo test
npm run copy-contracts && npm run copy-circuits
# typecheck: frontend, bot, playtest, integration; then every unit suite
npm test -w packages/game-logic -w packages/backend -w packages/frontend -w packages/bot
npm run test:scripts
cd packages/frontend && npm run build
```

Then diff `packages/frontend/src/aztec/instrumentedWallet.ts`'s `sendTx`
against the SDK's `EmbeddedWallet.sendTx`/`BaseWallet.sendTx`. It has drifted
on three bumps out of four.

## 4. Local gate — the one that catches runtime breaks

Typecheck cannot see SDK calls made through `any`, ts-nocheck tests or the Vite
dev server. Three of v6's breaks surfaced only here.

```bash
npx playwright install chromium     # once per Playwright version
cd packages/playtest && PLAYTEST_PROOF_THREADS=2 npx playwright test full-game.spec.ts
npm run test:e2e -w packages/integration -- tests/e2e-aztec-settlement.test.ts   # needs aztec start --local-network
```

## 5. Deploy to the testnet

```bash
export $(grep -E '^DEPLOYER_(SECRET|SALT|SIGNING_KEY)=' ~/.aztec-triad-private/deployer-testnet-key.txt | xargs)
export AZTEC_PXE_URL=<node url> TESTNET_L1_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
       TREASURY_L1_KEY_FILE=~/.aztec-triad-private/treasury-l1-key.txt
npx tsx scripts/deploy-testnet.ts
AZTEC_PXE_URL=<node url> npx tsx scripts/check-testnet-state.ts
```

The deployer's address changes whenever address derivation does (v5, v6) and
the script bridges its Fee Juice from the treasury. Commit
`packages/frontend/.env.testnet` and `packages/frontend/public/contracts/`: the
site serves what is committed.

## 6. Testnet gate

```bash
cd packages/playtest && PLAYTEST_TESTNET=1 PLAYTEST_LOCAL_BACKEND=1 \
  PLAYTEST_PXE_URL=<node url> PLAYTEST_PROOF_THREADS=2 npx playwright test multi-game.spec.ts
```

The harness provisions its own players from the treasury when the pool has
none for the new NFT. Healthy: every game `settle OK`, sends at anchor lag 0,
no 429s. Reboot first if swap is nearly full — a SIGKILL mid-run looks exactly
like someone pressing stop.

## 7. Cutover

**Frontend (Vercel).** `npx tsx scripts/sync-vercel-env.ts --sync-only`, then
fast-forward `testnet` and push. Confirm a production deployment exists for the
pushed SHA. One push in November never triggered one; if so, run
`scripts/sync-vercel-env.ts` without `--sync-only` to build from the `testnet`
ref. Then confirm the served bundle contains the new addresses and RPC and none
of the old ones, and load the site in a real browser.

**Backend box** (`ssh -i ~/.ssh/aztec_deploy ubuntu@13.42.161.225`). Check
`node --version` against the SDK's minimum (NodeSource repo in
`/etc/apt/sources.list.d/nodesource.sources`). Then in `~/axolotl-arena-server`:
`git checkout -- package-lock.json && git pull --ff-only && npm install --legacy-peer-deps`,
build `@axolotl-arena/game-logic` and `@axolotl-arena/backend`, then
`sudo systemctl restart triad-backend` and check `curl localhost:5174/health`.

**Arena bot.** `npx tsx scripts/provision-arena-bot.ts --index 0 --cards 40` (deployer
keys exported). Then on the box:
- Move `/var/lib/triad-bot/arena-bot-0.json` and its `.imported.json` aside.
  Keep them: they are the only record of the old notes.
- Install the new manifest with `install -m 600 -o ubuntu`.
- Back up `/etc/triad-bot.env` and update **all four** chain values:
  `AZTEC_PXE_URL` and the NFT, GAME **and TOKEN** contract addresses. A stale
  token address still reports healthy.
- `sudo systemctl restart triad-bot`. The journal must show `imported 40 card
  note(s)`, then `chain ready … (40 spendable)`, then `registered with the
  relay`, and `https://ws.aztec-arena.com/arena-health` must say
  `botHealthy:true`.

**Uptime probe.** Update `EXPECTED=<rollupVersion>` and the node URL in
`.github/workflows/uptime.yml` on **`main`**: scheduled runs come from the
default branch. Update it on `testnet` too. If GitHub disabled the workflow for
inactivity, re-enable it by id (`gh workflow list --all`, then
`gh workflow enable <id>`). Dispatch one run and see every step pass.

## Bundle with the next redeploy

Contract changes only ship with a redeploy, so batch them into a move:

- Delete the NFT contract's four leftover public-escrow functions —
  `game_transfer`, `unlock_cards`, `prepare_for_game`, `reclaim_card`. Nothing
  calls them since hands moved to commit-and-burn (`commit_five_nfts_*`). The
  first two are callable only by the game contract, which never does; the last
  two let a player move only their own cards into and out of an escrow nothing
  else reads. Dead code, not an exploit — but still deployed entry points the
  open audit would have to cover.
- Deliver card notes with v6's offchain messages and `offchain_receive`
  instead of the hand-driven `import_note`, and drop the `CardCreated` events
  that nothing receives. Plan and the local spike to run first:
  [plan/OFFCHAIN_DELIVERY.md](plan/OFFCHAIN_DELIVERY.md).
