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
/**
 * One manifest PER IDENTITY. A single shared file would let provisioning index 1
 * silently overwrite index 0's keys and card list, which is precisely the pool
 * the plan calls for (docs/plan/BACKEND_OPPONENT.md §2b) failing silently.
 */
const manifestPath = (index: number) =>
  resolve(ROOT_DIR, `packages/bot/.artifacts/arena-bot-${index}.json`);
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

const arg = (name: string, dflt: number, allowZero = false): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const n = Number(process.argv[i + 1]);
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`--${name} needs an integer >= ${min}`);
  }
  return n;
};

function readEnvAddress(key: string): string {
  if (!existsSync(ENV_PATH)) throw new Error(`${ENV_PATH} missing — deploy the contracts first`);
  const m = readFileSync(ENV_PATH, 'utf-8').match(new RegExp(`^${key}=(.+)$`, 'm'));
  if (!m) throw new Error(`${key} missing from ${ENV_PATH}`);
  return m[1].trim();
}

/**
 * Cards for one identity, taken from a DISJOINT slice of the database.
 *
 * token_ids are GLOBALLY unique: mint_to_private enqueues finalize_mint, which
 * asserts against a contract-wide `nft_exists` map. So two identities cannot
 * hold the same id, duplicates are impossible (not merely untested), and the
 * whole pool shares one 257-card budget. `offset` keeps each identity's slice
 * clear of the others.
 */
function collectionFor(count: number, offset = 0): { id: number; packed: string }[] {
  if (offset + count > CARD_DATABASE.length) {
    throw new Error(
      `offset ${offset} + --cards ${count} exceeds the ${CARD_DATABASE.length}-card database. ` +
      `token_ids are globally unique (finalize_mint asserts !nft_exists), so every identity in the ` +
      `pool draws from the SAME budget — there is no way to mint past it.`,
    );
  }
  // packRanks takes the four ranks POSITIONALLY, not the ranks object — passing
  // the object produced "[object Object]NaNNaNNaN" and a BigInt conversion error
  // at mint time rather than a type error, because the packing is arithmetic.
  return CARD_DATABASE.slice(offset, offset + count).map(c => ({
    id: c.id,
    packed: packRanks(c.ranks.top, c.ranks.right, c.ranks.bottom, c.ranks.left).toString(),
  }));
}

/**
 * Read an owner's full private card collection through `get_nfts_for_user`,
 * page by page. Simulate returns `{ result: [page, hasMore] }` — the tuple is
 * nested under `result`, not the top-level value.
 */
async function readCollection(nft: any, owner: any): Promise<number[]> {
  const ids: number[] = [];
  for (let page = 0; ; page++) {
    const { result } = await nft.methods.get_nfts_for_user(owner, page).simulate({ from: owner });
    for (const val of (result[0] ?? [])) {
      const id = Number(BigInt(val));
      if (id !== 0) ids.push(id);
    }
    if (result[1] !== true) break;
    if (page > 500) throw new Error('get_nfts_for_user pagination did not terminate');
  }
  return ids;
}

async function obtainClaim(node: any, address: string, l1ChainId: number): Promise<FeeJuiceClaim> {
  // Local sandbox funds from the well-known anvil account, not the Sepolia
  // treasury, and needs the mineBlock nudge (v5's automine sequencer builds a
  // block only on tx activity, so a freshly-bridged L1->L2 message would have
  // no block to land in). fundDevnet.ts already encapsulates both.
  if (l1ChainId === 31337) {
    console.log('  local sandbox — bridging Fee Juice from the anvil funder...');
    const { fundAccountOnDevnet } = await import('../packages/frontend/src/aztec/fundDevnet');
    return await fundAccountOnDevnet(node, address, (m: string) => console.log(`    ${m}`)) as FeeJuiceClaim;
  }

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
  const index = arg('index', 0, true);   // 0 is the default identity
  const cardCount = arg('cards', 40);
  const dryRun = process.argv.includes('--dry-run');

  const keys = arenaBotAccount(index);
  // Default assumes a UNIFORM --cards across the pool. Pass --offset explicitly
  // when identities have different sizes, or slices will overlap and the second
  // mint will fail "Token already exists" (token_ids are globally unique).
  const offset = arg('offset', index * cardCount, true);
  const collection = collectionFor(cardCount, offset);

  console.log('=== Arena bot provisioning ===');
  console.log(`  PXE:    ${PXE_URL}`);
  console.log(`  Index:  ${index}`);
  console.log(`  Cards:  ${cardCount} (ids ${collection[0].id}..${collection[collection.length - 1].id}, offset ${offset})`);

  // --dry-run must not need a chain: it exists to check the derivation and the
  // collection plan before anyone spends gas.
  if (dryRun) {
    console.log(`  Keys:   secret/salt/signing derived from '${ARENA_BOT_SEED_LABEL}' index ${index}`);
    console.log('\n--dry-run: derived only. No node contacted, nothing deployed or minted.');
    return 0;
  }

  const node = createAztecNodeClient(PXE_URL);
  const { rollupVersion, l1ChainId } = await node.getNodeInfo();
  console.log(`  Chain:  rollupVersion ${Number(rollupVersion)} l1ChainId ${Number(l1ChainId)}`);

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
  const claim = await obtainClaim(node, botAddress, Number(l1ChainId));
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
    if (Number(l1ChainId) !== 31337) markClaimConsumed(claimStorePath(), botAddress);
    console.log('  account deployed; claim consumed');
  } catch (err: any) {
    const msg = String(err?.cause?.message ?? err?.message ?? err);
    if (/Existing nullifier|Nullifier conflict/i.test(msg)) {
      console.log('  account already deployed — continuing to mint');
    } else {
      throw err;
    }
  }

  // 2. Resolve the minter (the deployer) and the NFT contract. Only the minter
  //    can mint; the bot pays for its own starter claim.
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
  // Contract.at alone does NOT register the class with the wallet — sends then
  // fail "No artifact registered for contract class". Fetch the on-chain
  // instance and register it first, exactly as provision-playtest-accounts does.
  const nftAddr = AztecAddress.fromStringUnsafe(nftAddress);
  const nftInstance = await node.getContract(nftAddr);
  if (!nftInstance) throw new Error(`NFT contract ${nftAddress} not found on this chain`);
  await wallet.registerContract(nftInstance, nftArtifact);
  await wallet.registerSender(nftAddr, 'nft');
  const nft = await Contract.at(nftAddr, nftArtifact, wallet as never);

  // 3. Claim starter cards AS THE BOT — this is what initialises its
  //    `note_nonce`. Without it every create_game/join_game fails
  //    "Note nonce not found": the nonce is pushed by get_cards_for_new_player
  //    (main.nr:437), the real onboarding path, and mint_to_private does not
  //    touch it. Claiming is one-per-account (nullifier-gated), so a re-run is
  //    a no-op rather than an abuse.
  //
  //    Its 5 starter cards arrive via create_and_push_note and are NOT
  //    auto-discovered, so they stay invisible to the bot's PXE unless imported.
  //    That is fine and self-consistent: the bot's SPENDABLE collection is the
  //    explicitly minted set, and selectHand() reads what the PXE can actually
  //    see. Those ids also cost nothing from the global budget, since
  //    create_and_push_note never touches nft_exists.
  try {
    await nft.methods.get_cards_for_new_player().send({
      from: botAccount.address,
      fee: { gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) } },
      wait: { timeout: TX_TIMEOUT },
    });
    console.log('  starter claim done — note_nonce initialised');
  } catch (err: any) {
    const msg = String(err?.cause?.message ?? err?.message ?? err);
    if (/nullifier|already|claimed/i.test(msg)) {
      console.log('  starter already claimed — note_nonce present');
    } else {
      throw err;
    }
  }


  // Read what the bot ALREADY holds so a re-run tops up instead of double-minting.
  // mint_to_private does not check nft_exists, so a naive re-run would silently
  // give the bot duplicate token_ids — whose behaviour under commit_five_nfts is
  // untested (docs/plan/BACKEND_OPPONENT.md §2a).
  const alreadyHeld = new Set(await readCollection(nft, botAccount.address));
  if (alreadyHeld.size > 0) {
    console.log(`  bot already holds ${alreadyHeld.size} card(s) — minting only what is missing`);
  }

  // 4. Mint the collection.
  const minted: number[] = [...alreadyHeld];
  for (const card of collection) {
    if (alreadyHeld.has(card.id)) continue;
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

  // 5. VERIFY through the same paginated reader the app itself uses.
  const held = (await readCollection(nft, botAccount.address)).sort((a, b) => a - b);
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
  const outPath = manifestPath(index);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`\n=== Done. Manifest: ${outPath} ===`);
  return 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error(err.stack || err.message || err);
  process.exit(1);
});
