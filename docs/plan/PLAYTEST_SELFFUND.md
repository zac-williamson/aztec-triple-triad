# Playtest self-funding — local treasury provisioning + injected pre-deployed accounts

**Goal (Zac, approved):** the app faucet is RIPPED from deployed code (prod onboarding
self-funds via the official Aztec faucet). The harness must NOT use any app faucet. Instead a
**local script** (treasury L1 key, Node-only) **pre-funds + pre-deploys a fixed pool** of
accounts; the harness **injects** those keys so onboarding restores `alreadyDeployed` with
**no funding step**, then plays on aztec-arena.com.

## Approved decisions
- **Single-use pool** (each account fresh-state on first use → keeps every starter-state assert
  intact). **NO relaxed asserts** (that would be a mask — forbidden).
- **N=8 to start; pool size AND Fee-Juice amount are SCRIPT PARAMS** (top-up = one command).
- **Fund generously** — overshoot to cover full-game + multi-game + 2 pack buys + margin (free
  test Fee Juice; never risk mid-run starvation = flaky failure).
- Treasury L1 key stays Node-side; only throwaway playtest-account keys reach the browser.

## DONE
- Merged `origin/testnet` (post-rip frontend) into `lane/8-playtest` (`3689fb5`); accepted the
  deletion of `requestFeeJuiceClaim.ts`/`.test.ts` (my fix moot post-rip).
- Removed `VITE_FAUCET_URL` from `stack.ts` testnet `viteEnv`.

## Verified post-rip facts (injection point is INTACT)
- `frontend/src/aztec/connectToAztec.ts`:
  - `:64-118` `prepareConnection` reads `accountSecret/accountSalt/signingKey` from `localStorage`
    (else `Fr.random()`/`GrumpkinScalar.random()`); `createSchnorrAccount(secretFr, saltFr, signingKey)`.
  - `:118` `alreadyDeployed = useStorage && localStorage.getItem(storageKeys.deploymentStatus) === 'deployed'`.
  - `:16` `import { addCards, loadCards, saveCards, StoredCard } from './cardStore'`; `:17`
    `STARTER_CARD_IDS, STARTER_CARD_COUNT` from `./gameConstants`.
  - mint (`:209-264`): `StoredCard[] = STARTER_CARD_IDS.map((id,i)=>({cardId, randomness, ...}))`;
    `randomness = ops.computeNoteRandomness(accountAddress, '0', STARTER_CARD_COUNT)` (deterministic);
    `addCards(accountAddress, storedCards)`; `ops.importCardNotes(accountAddress, txHash, notes, ...)`.
- `frontend/src/hooks/useAztec.ts:86` `if (prepared.alreadyDeployed) { ... restore, no funding needed }`.
  Fresh testnet account → `:99-102` manual FundingPrompt → official faucet (the prod path; harness avoids it).
- `frontend/src/aztec/config.ts:15-21` storageKeys are scoped by game contract addr:
  `aztec_tt_account_secret_${VITE_GAME_CONTRACT_ADDRESS}` etc.; `deploymentStatus = aztec_tt_deployed_${addr}`;
  `cardsMintedPrefix = 'aztec_tt_cards_minted_'`.

## Bridge/treasury primitives to REUSE (already exist)
`scripts/lib/feeJuiceBridge.ts`: `readFunderKey(env)` (TREASURY_L1_KEY / _FILE), `bridgeFeeJuice({node,
l1RpcUrl, funderKey, l2Address, log, messageWaitSeconds})→FeeJuiceClaim`, `serializeClaim`,
`claimStorePath`, `putStoredClaim`. Template: `scripts/fund-testnet.ts` (treasury key + bridge loop).
Node deploy patterns: `scripts/deploy-contracts.ts` / `scripts/deploy-testnet.ts`
(EmbeddedWallet + `FeeJuicePaymentMethodWithClaim`).

## REMAINING WORK
1. **`scripts/lib/playtestAccounts.ts`** — `playtestAccount(index) → { secret:Fr, salt:Fr,
   signingKey:GrumpkinScalar }` from a CONSTANT seed + index (`sha256(seed‖index)` →
   `Fr.fromBufferReduce` / `GrumpkinScalar.fromBufferReduce` — verify the exact reduce API). Never
   `Fr.random()`. Imported by BOTH the script and the harness.
2. **`scripts/provision-playtest-accounts.ts`** (params: `--start`, `--count` [def 8],
   `--fee-juice <amount>` generous). Reads `.env.testnet` addrs + `readFunderKey` +
   `TESTNET_L1_RPC_URL` + `AZTEC_PXE_URL`. Per index: `bridgeFeeJuice` → claim; Node
   `EmbeddedWallet.createSchnorrAccount(playtestAccount(index))` → deploy
   (`FeeJuicePaymentMethodWithClaim`) + **mint starter cards** (find the real game/NFT contract
   method that `ops.buildMintStarterCardsRequest` wraps — grep the frontend `ops`/aztecOps impl;
   replicate the call + the deterministic `computeNoteRandomness`); compute `StoredCard[]`. Write
   **`packages/playtest/.artifacts/playtest-accounts.json`** (gitignored):
   `[{index,address,secret,salt,signingKey,starterCards:[{cardId,randomness}],used:false}]`. Idempotent
   (skip already-deployed; top-up Fee Juice).
3. **Harness inject** — `env.ts`: `PLAYTEST_ACCOUNTS_PATH = .artifacts/playtest-accounts.json`.
   `PlayerDriver.launch` (player.ts): claim the next `used:false` account (mark `used:true` in the
   manifest — serial single-worker, safe), then BEFORE `goto` do `page.addInitScript` seeding
   `localStorage` (scoped by the run's game contract addr from `.env.testnet`): `accountSecret`,
   `accountSalt`, `signingKey` (hex), `deploymentStatus='deployed'`, `cardsMinted` key, and the
   **cardStore** cache (read `frontend/src/aztec/cardStore.ts` for the exact localStorage key + JSON
   shape; seed `starterCards`). Then the app restores `alreadyDeployed` → connected, no funding.
   `waitConnected` unchanged. Keep ALL starter-state asserts.

## Verify
- Provision a small pool (`--count 2`) → run `full-game.spec` on testnet OFF-VPN (NordVPN ~60s
  idle-drop still applies to the deploy/settle L2 txs' node connection; run on `en0`). Expect
  onboarding to skip funding (restore), game create→9 moves→settle GREEN. Then multi-game.
- See [[testnet-playtest-harness-gotchas]] memory (off-VPN; PLAYTEST_TESTNET).
