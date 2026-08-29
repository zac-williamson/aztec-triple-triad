#!/usr/bin/env npx tsx
/**
 * Provision an arena-bot identity: deploy its account and mint it a card
 * collection.
 *
 * NO CONTRACT CHANGE IS NEEDED for this, contrary to the original plan. The NFT
 * contract's `mint_to_private(to, token_id, packed_ranks)` is gated on `minter`
 * (a PublicImmutable set at construction to the deployer, whose key we hold) and
 * delivers `onchain_constrained()`, so the recipient's PXE discovers the notes
 * normally — no import_note dance, unlike `get_cards_for_new_player`. Reading a
 * big collection is already paginated via `get_nfts_for_user(owner, page_index)`.
 * See docs/plan/BACKEND_OPPONENT.md §2a.
 *
 * Cost is one tx per card, which is a ONE-TIME setup, not a per-game cost.
 *
 * The collection is the bot's LOSS BUDGET, not just a concurrency budget:
 * settlement transfers a card from loser to winner, so every player who beats
 * the bot permanently takes one. Size it accordingly and watch the
 * botCardNetFlow metric. This script deliberately does NOT re-mint on demand —
 * an auto-refilling bot is an unbounded card faucet and that is hard to walk
 * back once players have farmed it.
 *
 * Usage:
 *   export AZTEC_PXE_URL=http://localhost:8080          # sandbox, or testnet RPC
 *   export TESTNET_L1_RPC_URL=https://...sepolia...     # only if bridging
 *   export TREASURY_L1_KEY_FILE=~/.aztec-triad-private/treasury-l1-key.txt
 *   export DEPLOYER_SECRET=0x... DEPLOYER_SALT=0x... DEPLOYER_SIGNING_KEY=0x...
 *   npx tsx scripts/provision-arena-bot.ts --cards 40
 *   npx tsx scripts/provision-arena-bot.ts --index 1 --cards 40   # pool member 1
 *   npx tsx scripts/provision-arena-bot.ts --dry-run              # derive + report only
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
  bridgeFeeJuice, serializeClaim, deserializeClaim, getStoredClaim, loadClaimStore,
  putStoredClaim, markClaimConsumed, claimStorePath, readFunderKey, type FeeJuiceClaim,
} from './lib/feeJuiceBridge';
import { headroomMaxFeesPerGas } from './lib/feeSettings';
import { arenaBotAccount, ARENA_BOT_SEED as ARENA_BOT_SEED_LABEL } from './lib/arenaBotAccount';
import { CARD_DATABASE, packRanks } from '../packages/game-logic/src/cards';

const ROOT_DIR = resolve(import.meta.dirname || __dirname, '..');
const PXE_URL = process.env.AZTEC_PXE_URL || 'http://localhost:8080';
const ENV_PATH = resolve(ROOT_DIR, 'packages/frontend/.env');
const MANIFEST_PATH = resolve(ROOT_DIR, 'packages/bot/.artifacts/arena-bot.json');
const TX_TIMEOUT = 600;

interface BotManifest {
  index: number;
  address: string;
  secret: string;
  salt: string;
  signingKey: string;
  /** Card ids minted to this identity, in mint order. */
  cardIds: number[];
  /** Chain this identity exists on — a re-genesis orphans it, exactly as it
   *  does the playtest pool, so the stamp is what makes staleness detectable. */
  rollupVersion: number;
  provisionedAt: string;
}

const arg = (name: string, dflt: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} needs a positive integer`);
  return n;
};

function readEnvAddress(key: string): string {
  if (!existsSync(ENV_PATH)) throw new Error(`${ENV_PATH} missing — deploy the contracts first`);
  const m = readFileSync(ENV_PATH, 'utf-8').match(new RegExp(`^${key}=(.+)$`, 'm'));
  if (!m) throw new Error(`${key} missing from ${ENV_PATH}`);
  return m[1].trim();
}

/** Cards the bot gets: the first N of the database, so its hands are legible. */
function collectionFor(count: number): { id: number; packed: string }[] {
  if (count > CARD_DATABASE.length) {
    throw new Error(
      `--cards ${count} exceeds the ${CARD_DATABASE.length}-card database. Duplicate token_ids ` +
      `are possible via mint_to_private (it does not check nft_exists) but are UNTESTED against ` +
      `commit_five_nfts — do not rely on them without a TXE test first.`,
    );
  }
  return CARD_DATABASE.slice(0, count).map(c => ({
    id: c.id,
    packed: packRanks(c.ranks).toString(),
  }));
}

async function obtainClaim(node: any, address: string): Promise<FeeJuiceClaim> {
  const storePath = claimStorePath();
  const stored = getStoredClaim(loadClaimStore(storePath), address);
  if (stored && stored.status === 'pending') {
    console.log(`  reusing persisted pending claim (${stored.claimAmount})`);
    return deserializeClaim(stored, Fr);
  }
  const l1RpcUrl = process.env.TESTNET_L1_RPC_URL;
  if (!l1RpcUrl || !(process.env.TREASURY_L1_KEY || process.env.TREASURY_L1_KEY_FILE)) {
    throw new Error(
      `No Fee Juice claim for the bot (${address}) and no treasury creds to bridge one.\n` +
      `  Set TESTNET_L1_RPC_URL + TREASURY_L1_KEY (or _FILE).`,
    );
  }
  console.log('  bridging Fee Juice for the bot...');
  const claim = await bridgeFeeJuice({
    node, l1RpcUrl, funderKey: readFunderKey(), l2Address: address,
    log: (m: string) => console.log(`    ${m}`),
    messageWaitSeconds: process.env.MESSAGE_WAIT_SECONDS ? Number(process.env.MESSAGE_WAIT_SECONDS) : 600,
  });
  putStoredClaim(storePath, address, serializeClaim(address, claim, new Date().toISOString()));
  return claim;
}

async function main(): Promise<number> {
  const index = arg('index', 0);
  const cardCount = arg('cards', 40);
  const dryRun = process.argv.includes('--dry-run');

  const keys = arenaBotAccount(index);
  const collection = collectionFor(cardCount);

  console.log('=== Arena bot provisioning ===');
  console.log(`  PXE:    ${PXE_URL}`);
  console.log(`  Index:  ${index}`);
  console.log(`  Cards:  ${cardCount} (ids ${collection[0].id}..${collection[collection.length - 1].id})`);

  // --dry-run must not need a chain: it exists to check the derivation and the
  // collection plan before anyone spends gas.
  if (dryRun) {
    console.log(`  Keys:   secret/salt/signing derived from '${ARENA_BOT_SEED_LABEL}' index ${index}`);
    console.log('\n--dry-run: derived only. No node contacted, nothing deployed or minted.');
    return 0;
  }

  const node = createAztecNodeClient(PXE_URL);
  const { rollupVersion } = await node.getNodeInfo();
  console.log(`  Chain:  rollupVersion ${Number(rollupVersion)}`);

  const wallet = await EmbeddedWallet.create(node, { ephemeral: false, pxeConfig: { proverEnabled: true } });
  const botAccount = await wallet.createSchnorrAccount(
    Fr.fromHexString(keys.secret),
    Fr.fromHexString(keys.salt),
    GrumpkinScalar.fromHexString(keys.signingKey),
  );
  const botAddress = botAccount.address.toString();
  console.log(`  Bot:    ${botAddress}`);

  const nftAddress = readEnvAddress('VITE_NFT_CONTRACT_ADDRESS');

  // 1. Deploy the bot account, paying with its bridged claim in-tx.
  const claim = await obtainClaim(node, botAddress);
  console.log('  deploying bot account (claim paid in-tx)...');
  try {
    const deployMethod = await botAccount.getDeployMethod();
    await deployMethod.send({
      from: NO_FROM,
      fee: {
        paymentMethod: new FeeJuicePaymentMethodWithClaim(botAccount.address, claim),
        gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) },
      },
      wait: { timeout: TX_TIMEOUT },
    });
    markClaimConsumed(claimStorePath(), botAddress);
    console.log('  account deployed; claim consumed');
  } catch (err: any) {
    const msg = String(err?.cause?.message ?? err?.message ?? err);
    if (/Existing nullifier|Nullifier conflict/i.test(msg)) {
      console.log('  account already deployed — continuing to mint');
    } else {
      throw err;
    }
  }

  // 2. Mint the collection AS THE MINTER (the deployer), not as the bot.
  //    Serial: all PXE operations are serial per wallet (CLAUDE.md ground rule 6).
  const deployerSecret = process.env.DEPLOYER_SECRET;
  const deployerSalt = process.env.DEPLOYER_SALT;
  const deployerSigning = process.env.DEPLOYER_SIGNING_KEY;
  if (!deployerSecret || !deployerSalt || !deployerSigning) {
    throw new Error('DEPLOYER_SECRET/SALT/SIGNING_KEY are required — only the minter can mint');
  }
  const deployer = await wallet.createSchnorrAccount(
    Fr.fromHexString(deployerSecret),
    Fr.fromHexString(deployerSalt),
    GrumpkinScalar.fromHexString(deployerSigning),
  );

  const { loadContractArtifact } = await import('@aztec/aztec.js/abi');
  const { Contract } = await import('@aztec/aztec.js/contracts');
  const nftArtifact = loadContractArtifact(
    JSON.parse(readFileSync(resolve(ROOT_DIR, 'packages/contracts/target/triple_triad_nft-TripleTriadNFT.json'), 'utf-8')),
  );
  const nft = await Contract.at(AztecAddress.fromStringUnsafe(nftAddress), nftArtifact, wallet as never);

  const minted: number[] = [];
  for (const card of collection) {
    try {
      await nft.methods.mint_to_private(botAccount.address, new Fr(BigInt(card.id)), new Fr(BigInt(card.packed))).send({
        from: deployer.address,
        fee: { gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) } },
        wait: { timeout: TX_TIMEOUT },
      });
      minted.push(card.id);
      console.log(`  minted card ${card.id} (${minted.length}/${collection.length})`);
    } catch (err: any) {
      // Do not silently continue: a partial collection that reports success is
      // worse than a loud stop, because the bot would then commit hands it
      // cannot back.
      throw new Error(`mint of card ${card.id} failed after ${minted.length} cards: ${String(err?.message ?? err)}`);
    }
  }

  // 3. VERIFY through the paginated reader the app itself uses.
  const held: number[] = [];
  for (let page = 0; ; page++) {
    const [ids, hasMore] = await nft.methods.get_nfts_for_user(botAccount.address, page).simulate({ from: botAccount.address }) as [bigint[], boolean];
    for (const id of ids) if (Number(id) !== 0) held.push(Number(id));
    if (!hasMore) break;
    if (page > 200) throw new Error('pagination did not terminate');
  }
  held.sort((a, b) => a - b);
  const expected = [...minted].sort((a, b) => a - b);
  if (held.length !== expected.length || held.some((v, i) => v !== expected[i])) {
    throw new Error(`verification failed: bot holds ${held.length} cards, expected ${expected.length}`);
  }
  console.log(`  ✓ verified: bot holds ${held.length} cards`);

  const manifest: BotManifest = {
    index, address: botAddress, ...keys,
    cardIds: minted, rollupVersion: Number(rollupVersion),
    provisionedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\n=== Done. Manifest: ${MANIFEST_PATH} ===`);
  return 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
