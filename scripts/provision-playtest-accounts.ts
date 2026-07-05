#!/usr/bin/env npx tsx
/**
 * Provision a fixed pool of pre-funded, pre-deployed playtest accounts for the
 * Playwright harness — the LOCAL, treasury-funded replacement for the app faucet
 * that was ripped out of deployed onboarding (docs/plan/PLAYTEST_SELFFUND.md).
 *
 * For each pool index it:
 *   1. derives deterministic keys      (scripts/lib/playtestAccounts.ts)
 *   2. bridges Fee Juice from L1        (scripts/lib/feeJuiceBridge.ts, treasury key)
 *   3. deploys the account on testnet   (FeeJuicePaymentMethodWithClaim — claim paid in-tx)
 *   4. mints its 5 starter cards + 100 ARNA  (NFT get_cards_for_new_player)
 *   5. VERIFIES (no mask) the account holds cards [1..5] and 100 tokens
 *   6. records everything in a gitignored manifest the harness injects.
 *
 * The manifest (packages/playtest/.artifacts/playtest-accounts.json) carries the
 * THROWAWAY playtest-account keys (deterministic from a public seed) plus the
 * minted-note coordinates (txHash / noteHashes / firstNullifier / randomness)
 * the harness needs to re-import the cards into a fresh browser PXE. The TREASURY
 * L1 key NEVER enters the manifest — it stays Node-side via readFunderKey().
 *
 * SINGLE-USE POOL: each entry starts `used:false`; the harness flips it to true
 * on claim so every account is consumed fresh-state exactly once (keeps every
 * starter-state assert intact — no relaxed asserts anywhere).
 *
 * Usage:
 *   export AZTEC_PXE_URL=https://v5.testnet.rpc.aztec-labs.com
 *   export TESTNET_L1_RPC_URL=https://...sepolia...
 *   export TREASURY_L1_KEY=0x...            # or TREASURY_L1_KEY_FILE (chmod 600)
 *   npx tsx scripts/provision-playtest-accounts.ts --count 8
 *   npx tsx scripts/provision-playtest-accounts.ts --start 8 --count 4   # top up the pool
 *
 * Idempotent: a complete manifest entry for an index is skipped (and its `used`
 * flag preserved), so a re-run only provisions new/incomplete indices.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { NO_FROM } from '@aztec/aztec.js/account';
import { FeeJuicePaymentMethodWithClaim } from '@aztec/aztec.js/fee';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';

import {
  bridgeFeeJuice,
  serializeClaim,
  deserializeClaim,
  getStoredClaim,
  loadClaimStore,
  putStoredClaim,
  markClaimConsumed,
  claimStorePath,
  readFunderKey,
  type FeeJuiceClaim,
} from './lib/feeJuiceBridge';
import { headroomMaxFeesPerGas } from './lib/feeSettings';
import { playtestAccount } from './lib/playtestAccounts';
// Reuse the frontend's exact field + note-effect helpers so the manifest's note
// coordinates are byte-identical to what the browser produces/expects. These
// modules are import.meta-free (cardStore is type-only), so they load in Node.
import { toFr } from '../packages/frontend/src/aztec/fieldUtils';
import { fetchTxEffectData, type TxEffectData } from '../packages/frontend/src/aztec/noteImporter';
import { STARTER_CARD_IDS, STARTER_CARD_COUNT } from '../packages/frontend/src/aztec/gameConstants';
import type { StoredCard } from '../packages/frontend/src/aztec/cardStore';

const ROOT_DIR = resolve(import.meta.dirname || __dirname, '..');
const PXE_URL = process.env.AZTEC_PXE_URL || 'https://v5.testnet.rpc.aztec-labs.com';
const ENV_PATH = resolve(ROOT_DIR, 'packages/frontend/.env.testnet');
const MANIFEST_PATH = resolve(ROOT_DIR, 'packages/playtest/.artifacts/playtest-accounts.json');
const TX_TIMEOUT = 600; // seconds — testnet block inclusion + proving headroom
const PXE_SYNC_WAIT_MS = 8000; // match deploy-testnet.ts post-create sync settle

/** One pool account, as stored in the harness-injected manifest. */
interface ManifestEntry {
  index: number;
  address: string;
  /** THROWAWAY playtest-account keys (hex) — deterministic, browser-bound by design. */
  secret: string;
  salt: string;
  signingKey: string;
  /** Full StoredCard[] (superset of the plan's {cardId,randomness}) so the harness
   *  can seed the browser cardStore verbatim and re-import via import_note. */
  starterCards: StoredCard[];
  /** Single-use flag: the harness flips this to true on claim. */
  used: boolean;
}

interface ProvisionOpts {
  nftAddress: string;
  tokenAddress: string;
  nftArtifact: any;
  tokenArtifact: any;
  /** --fee-juice: minimum claim amount to assert (fail loud if the bridge gives less). */
  minFeeJuice: bigint | undefined;
}

// ───────────────────────── arg + env parsing ─────────────────────────

function intArg(args: string[], flag: string, def: number): number {
  const i = args.indexOf(flag);
  if (i === -1) return def;
  const v = Number(args[i + 1]);
  if (!Number.isInteger(v) || v < 0) throw new Error(`${flag} expects a non-negative integer, got ${args[i + 1]}`);
  return v;
}

function bigintArg(args: string[], flag: string): bigint | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  try {
    const v = BigInt(args[i + 1]);
    if (v < 0n) throw new Error('negative');
    return v;
  } catch {
    throw new Error(`${flag} expects a non-negative integer amount, got ${args[i + 1]}`);
  }
}

/** Read a single VITE_ key from .env.testnet (the deployed testnet config). */
function readEnvAddress(key: string): string {
  if (!existsSync(ENV_PATH)) throw new Error(`${ENV_PATH} missing — run deploy-testnet.ts first`);
  const env = readFileSync(ENV_PATH, 'utf-8');
  const m = env.match(new RegExp(`^${key}=(.+)$`, 'm'));
  if (!m) throw new Error(`${key} missing from ${ENV_PATH}`);
  return m[1].trim();
}

// ───────────────────────── manifest persistence ─────────────────────────

function loadManifest(): ManifestEntry[] {
  if (!existsSync(MANIFEST_PATH)) return [];
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as ManifestEntry[];
}

function saveManifest(entries: ManifestEntry[]): void {
  const dir = dirname(MANIFEST_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2));
}

// ───────────────────────── helpers ─────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadArtifact(name: string): Promise<any> {
  const path = resolve(ROOT_DIR, `packages/contracts/target/${name}.json`);
  const { loadContractArtifact } = await import('@aztec/aztec.js/abi');
  return loadContractArtifact(JSON.parse(readFileSync(path, 'utf-8')));
}

/** Assert two values are deeply equal; throw with a diff (no masking). */
function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`VERIFY FAILED — ${label}\n  expected: ${e}\n  actual:   ${a}`);
}

/**
 * Get a Fee Juice claim for `address`. Reuses a persisted pending claim if one
 * exists (saves Sepolia ETH on re-runs); otherwise bridges via the shared
 * treasury bridge and persists it. Honors --fee-juice as a MINIMUM: the bridged
 * amount is the on-chain FeeAssetHandler mintAmount and cannot be raised from
 * here, so if it is below the requested minimum we fail loud rather than
 * silently under-fund.
 */
async function obtainClaim(node: any, address: string, minFeeJuice: bigint | undefined): Promise<FeeJuiceClaim> {
  const storePath = claimStorePath();
  const stored = getStoredClaim(loadClaimStore(storePath), address);
  if (stored && stored.status === 'pending') {
    console.log(`  reusing persisted pending claim (amount ${stored.claimAmount})`);
    const claim = deserializeClaim(stored, Fr);
    if (minFeeJuice !== undefined && claim.claimAmount < minFeeJuice) {
      throw new Error(`persisted claim ${claim.claimAmount} < --fee-juice ${minFeeJuice}`);
    }
    return claim;
  }

  const l1RpcUrl = process.env.TESTNET_L1_RPC_URL;
  if (!l1RpcUrl) throw new Error('TESTNET_L1_RPC_URL is required to bridge Fee Juice');

  const claim = await bridgeFeeJuice({
    node,
    l1RpcUrl,
    funderKey: readFunderKey(), // treasury key — Node-side only, never persisted
    l2Address: address,
    log: (m) => console.log(`  ${m}`),
    messageWaitSeconds: process.env.MESSAGE_WAIT_SECONDS ? Number(process.env.MESSAGE_WAIT_SECONDS) : 600,
  });
  putStoredClaim(storePath, address, serializeClaim(address, claim, new Date().toISOString()));
  if (minFeeJuice !== undefined && claim.claimAmount < minFeeJuice) {
    throw new Error(
      `Bridged claim ${claim.claimAmount} < requested --fee-juice ${minFeeJuice}. The bridged amount is ` +
        `the on-chain FeeAssetHandler mintAmount and cannot be raised from this script.`,
    );
  }
  return claim;
}

/** compute_note_randomness(nonce=0, count=5) → 5 hex randomness strings (decimal-safe). */
async function computeStarterRandomness(nft: any, address: any): Promise<string[]> {
  const { result }: any = await nft.methods.compute_note_randomness(new Fr(0n), STARTER_CARD_COUNT).simulate({ from: address });
  return Array.from({ length: STARTER_CARD_COUNT }, (_, i) => toFr(Fr, result[i]).toString());
}

/** Inject the minted card notes into this PXE via import_note (mirrors pxe.ts importCardNotes). */
async function importStarterCards(nft: any, address: any, cards: StoredCard[], txEffect: TxEffectData): Promise<void> {
  const padded = new Array(64).fill(new Fr(0n));
  for (let i = 0; i < txEffect.noteHashes.length && i < 64; i++) padded[i] = toFr(Fr, txEffect.noteHashes[i]);
  const txHashFr = toFr(Fr, cards[0].txHash);
  const firstNullFr = toFr(Fr, txEffect.firstNullifier);
  for (const c of cards) {
    await nft.methods
      .import_note(address, new Fr(BigInt(c.cardId)), toFr(Fr, c.randomness), txHashFr, padded, txEffect.noteHashes.length, firstNullFr, address)
      .simulate({ from: address });
  }
}

/** All non-zero card ids this PXE holds for `address` (paged get_nfts_for_user). */
async function readPrivateCards(nft: any, address: any): Promise<number[]> {
  const ids: number[] = [];
  let page = 0;
  let more = true;
  while (more) {
    const { result }: any = await nft.methods.get_nfts_for_user(address, page).simulate({ from: address });
    const arr = result[0] ?? [];
    more = result[1] === true;
    for (const v of arr) {
      const id = Number(BigInt(v));
      if (id !== 0) ids.push(id);
    }
    page++;
  }
  return ids.sort((a, b) => a - b);
}

async function readTokenBalance(token: any, address: any): Promise<bigint> {
  const { result }: any = await token.methods.get_balance(address).simulate({ from: address });
  return BigInt(result.toString());
}

// ───────────────────────── per-account provisioning ─────────────────────────

async function provisionOne(index: number, opts: ProvisionOpts): Promise<ManifestEntry> {
  console.log(`\n=== Provisioning account #${index} ===`);
  const keys = await playtestAccount(index); // hex strings

  // Fresh ephemeral PXE per account — mirrors the browser's one-PXE-per-account
  // model so the card-import + balance verification below is unambiguous.
  const node = createAztecNodeClient(PXE_URL);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: true } });
  await sleep(PXE_SYNC_WAIT_MS);

  // Rebuild the field elements with THIS script's own Fr/GrumpkinScalar (the
  // deploy-testnet.ts pattern) so they match the SDK's internal field class.
  const account = await wallet.createSchnorrAccount(
    Fr.fromHexString(keys.secret),
    Fr.fromHexString(keys.salt),
    GrumpkinScalar.fromHexString(keys.signingKey),
  );
  const address = account.address;
  const addressStr = address.toString();
  console.log(`  address: ${addressStr}`);

  await wallet.registerSender(address, 'player');
  const { Contract } = await import('@aztec/aztec.js/contracts');
  const nftAddr = AztecAddress.fromString(opts.nftAddress);
  const tokenAddr = AztecAddress.fromString(opts.tokenAddress);
  // Register the pre-deployed NFT + Token INSTANCES in this fresh PXE so their
  // methods can be simulated/sent. Contract.at alone does not register the
  // on-chain instance — connectToAztec.ts does this node.getContract →
  // registerContract step too (without it: "No contract instance found").
  const nftInstance = await node.getContract(nftAddr);
  const tokenInstance = await node.getContract(tokenAddr);
  if (!nftInstance) throw new Error(`NFT contract ${opts.nftAddress} not found on node`);
  if (!tokenInstance) throw new Error(`Token contract ${opts.tokenAddress} not found on node`);
  await wallet.registerContract(nftInstance, opts.nftArtifact);
  await wallet.registerContract(tokenInstance, opts.tokenArtifact);
  await wallet.registerSender(nftAddr, 'nft');
  await wallet.registerSender(tokenAddr, 'token');
  const nft = await Contract.at(nftAddr, opts.nftArtifact, wallet as never);
  const token = await Contract.at(tokenAddr, opts.tokenArtifact, wallet as never);

  // 1. Deploy the account, paying with the bridged claim in-tx. If a prior run
  //    already deployed it, the deploy reverts "Existing nullifier" — catch it
  //    and proceed to mint (the deploy-testnet.ts pattern). node.getContract is
  //    NOT a reliable deployment check for claim-deployed account contracts
  //    (it returns falsy even when the account is on-chain), so we detect via
  //    the deploy itself. The bridged claim stays for reuse on the next run.
  const claim = await obtainClaim(node, addressStr, opts.minFeeJuice);
  console.log('  deploying account (claim paid in-tx)...');
  let freshlyDeployed = false;
  // Testnet prunes block history fast: after a long obtainClaim (the L1->L2 bridge
  // message wait) the PXE's anchor block can be pruned by deploy time, so the tx is
  // rejected "Invalid tx: Block header not found". Retry — a fresh build re-anchors
  // to a current block (the PXE keeps syncing forward between attempts). This is
  // transient-infra resilience, not masking: a real revert (Existing nullifier) is
  // handled separately and anything else after the retries still throws.
  for (let attempt = 1; ; attempt++) {
    try {
      const deployMethod = await account.getDeployMethod();
      await deployMethod.send({
        from: NO_FROM,
        fee: {
          paymentMethod: new FeeJuicePaymentMethodWithClaim(address, claim),
          gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) },
        },
        wait: { timeout: TX_TIMEOUT },
      });
      markClaimConsumed(claimStorePath(), addressStr);
      freshlyDeployed = true;
      console.log('  account deployed; claim consumed');
      break;
    } catch (err: any) {
      const msg = String(err?.cause?.message ?? err?.message ?? err);
      // "Existing nullifier" (resent before the original mined) OR "Nullifier
      // conflict with existing tx" (the original deploy landed LATE — after our
      // wait timed out and we resent) both mean the account is already on-chain
      // and the claim is spent. Skip the deploy and go mint.
      if (/Existing nullifier|Nullifier conflict/i.test(msg)) {
        console.log('  account already deployed (nullifier already on-chain) — proceeding to mint');
        break;
      }
      // Block header not found / Invalid tx: the anchor block was pruned during the
      // long L1->L2 bridge wait — a fresh build re-anchors to a current block.
      // Timeout awaiting isMined / dropped: the v5 testnet was slow to mine or
      // reorged the deploy out of the mempool — resend. All transient; if a slow
      // original lands late, the resend hits "Existing nullifier" (handled above),
      // so a retry can never double-deploy.
      if (/Block header not found|Invalid tx|Timeout awaiting isMined|dropped/i.test(msg) && attempt < 6) {
        console.log(`  deploy attempt ${attempt} failed (${msg.slice(0, 70)}); re-syncing PXE + retrying...`);
        await sleep(PXE_SYNC_WAIT_MS);
        continue;
      }
      throw err;
    }
  }

  // 2. Mint starter cards + 100 ARNA (account pays natively from claimed balance).
  console.log('  minting starter cards + 100 ARNA...');
  let mintTxHash: string;
  try {
    const { receipt } = await nft.methods.get_cards_for_new_player().send({
      from: address,
      fee: { gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) } },
      wait: { timeout: TX_TIMEOUT },
    });
    mintTxHash = receipt?.txHash?.toString() ?? '';
  } catch (err: any) {
    const msg = String(err?.cause?.message ?? err?.message ?? err);
    if (!freshlyDeployed && /nullifier|already|claimed/i.test(msg)) {
      throw new Error(
        `Account #${index} (${addressStr}) is already deployed AND minted, but has no manifest entry — ` +
          `its note coordinates are unrecoverable. Bump PLAYTEST_SEED for a fresh disjoint pool.`,
      );
    }
    throw err;
  }
  if (!mintTxHash) throw new Error(`mint returned no txHash for #${index}`);
  console.log(`  mint tx: ${mintTxHash}`);

  // 3. Capture the note coordinates the harness needs to re-import the cards.
  const txEffect = await fetchTxEffectData(node, mintTxHash);
  if (!txEffect) throw new Error(`no TxEffect for mint ${mintTxHash} (#${index})`);
  const randomness = await computeStarterRandomness(nft, address);
  const starterCards: StoredCard[] = STARTER_CARD_IDS.map((id, i) => ({
    cardId: id,
    randomness: randomness[i],
    txHash: mintTxHash,
    noteHashes: txEffect.noteHashes,
    firstNullifier: txEffect.firstNullifier,
  }));

  // 4. VERIFY (no mask): this PXE must hold exactly cards [1..5] and 100 tokens.
  //    Cards need explicit import (create_and_push_note is not auto-discovered);
  //    the 100-token note was auto-discovered by this minting/proving PXE.
  await importStarterCards(nft, address, starterCards, txEffect);
  const cards = await readPrivateCards(nft, address);
  assertEqual(cards, [...STARTER_CARD_IDS].sort((a, b) => a - b), `account #${index} starter cards`);
  const balance = await readTokenBalance(token, address);
  assertEqual(balance.toString(), '100', `account #${index} starter token balance`);
  console.log(`  ✓ verified: cards ${JSON.stringify(cards)}, balance ${balance}`);

  return {
    index,
    address: addressStr,
    secret: keys.secret,
    salt: keys.salt,
    signingKey: keys.signingKey,
    starterCards,
    used: false,
  };
}

// ───────────────────────── main ─────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const start = intArg(args, '--start', 0);
  const count = intArg(args, '--count', 8);
  const minFeeJuice = bigintArg(args, '--fee-juice');

  const nftAddress = readEnvAddress('VITE_NFT_CONTRACT_ADDRESS');
  const tokenAddress = readEnvAddress('VITE_TOKEN_CONTRACT_ADDRESS');

  console.log('=== Playtest account provisioning ===');
  console.log(`  PXE:    ${PXE_URL}`);
  console.log(`  NFT:    ${nftAddress}`);
  console.log(`  Token:  ${tokenAddress}`);
  console.log(`  Pool:   indices ${start}..${start + count - 1} (count ${count})`);
  console.log(`  Manifest: ${MANIFEST_PATH}`);
  if (minFeeJuice !== undefined) console.log(`  --fee-juice minimum: ${minFeeJuice}`);

  const [nftArtifact, tokenArtifact] = await Promise.all([
    loadArtifact('triple_triad_nft-TripleTriadNFT'),
    loadArtifact('arena_token-ArenaToken'),
  ]);

  const byIndex = new Map<number, ManifestEntry>(loadManifest().map((e) => [e.index, e]));
  const opts: ProvisionOpts = { nftAddress, tokenAddress, nftArtifact, tokenArtifact, minFeeJuice };

  let provisioned = 0;
  let skipped = 0;
  for (let i = start; i < start + count; i++) {
    const existing = byIndex.get(i);
    if (existing && existing.starterCards?.length === STARTER_CARD_COUNT) {
      console.log(`\nskip #${i} — already provisioned (${existing.address}, used=${existing.used})`);
      skipped++;
      continue;
    }
    const entry = await provisionOne(i, opts);
    byIndex.set(i, entry);
    // Incremental write so a mid-run failure preserves completed accounts.
    saveManifest([...byIndex.values()].sort((a, b) => a.index - b.index));
    provisioned++;
  }

  const total = [...byIndex.values()];
  const free = total.filter((e) => !e.used).length;
  console.log(`\n=== Done: provisioned ${provisioned}, skipped ${skipped} ===`);
  console.log(`Pool: ${total.length} accounts total, ${free} unused.`);
}

main().catch((err) => {
  console.error('\nProvisioning failed:', err);
  process.exit(1);
});
