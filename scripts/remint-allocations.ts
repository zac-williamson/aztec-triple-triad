#!/usr/bin/env npx tsx
/**
 * Mint an explicit allocation of cards on a freshly deployed NFT contract.
 *
 * WHY THIS TAKES A FILE RATHER THAN COMPUTING ONE.
 *
 * A contract redeploy abandons the old NFT and every note in it. The obvious
 * response — snapshot who holds what, re-mint it — is not possible here, and it
 * is worth being precise about why rather than discovering it halfway through a
 * migration:
 *
 *   - `finalize_mint` / `mint_to_public` emit `CardMinted { token_id, to }`, so
 *     the public log records the ORIGINAL recipient of each minted id.
 *   - Cards then move at settlement via `mint_for_game_winner` /
 *     `mint_for_game_draw_offchain`, which create PRIVATE notes and emit only an
 *     encrypted `CardCreated`. Starter cards and pack cards take the same path.
 *   - So after a single game the public log is already wrong about who holds
 *     what, and ownership thereafter is private — which is the entire point of
 *     the application.
 *   - The node API available to us (`getPublicLogsByTags`) is tag-addressed
 *     anyway; there is no block-range scan to enumerate holders with.
 *
 * A faithful automatic snapshot is therefore impossible. The honest policies are
 * a RESET (announced), or a CLAIM-based migration where each player's own client
 * — the only party that can see their notes — proves what it holds. This script
 * executes whichever allocation you decide on, and makes no decision itself.
 *
 * Allocation file: [{ "address": "0x…", "cardIds": [1, 2, 3] }, …]
 *
 * Usage:
 *   AZTEC_PXE_URL=… VITE_NFT_CONTRACT_ADDRESS=0x… \
 *   DEPLOYER_SECRET=… DEPLOYER_SALT=… DEPLOYER_SIGNING_KEY=… \
 *     npx tsx scripts/remint-allocations.ts allocations.json [--dry-run]
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { loadContractArtifact } from '@aztec/aztec.js/abi';
import { Contract } from '@aztec/aztec.js/contracts';
import { CARD_DATABASE, packRanks } from '../packages/game-logic/src/cards';
import { headroomMaxFeesPerGas } from './lib/feeSettings';

interface Allocation { address: string; cardIds: number[] }

const ROOT_DIR = resolve(import.meta.dirname || __dirname, '..');
const PXE_URL = process.env.AZTEC_PXE_URL ?? 'http://localhost:8080';
const TX_TIMEOUT = 600;

function ranksFor(cardId: number): string {
  const card = CARD_DATABASE.find(c => c.id === cardId);
  if (!card) throw new Error(`Card id ${cardId} is not in the database`);
  return packRanks(card.ranks.top, card.ranks.right, card.ranks.bottom, card.ranks.left).toString();
}

async function main(): Promise<number> {
  const file = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!file) {
    console.error('Usage: remint-allocations.ts <allocations.json> [--dry-run]');
    return 1;
  }

  const allocations = JSON.parse(readFileSync(resolve(file), 'utf-8')) as Allocation[];
  const total = allocations.reduce((n, a) => n + a.cardIds.length, 0);
  const duplicates = allocations.flatMap(a => a.cardIds)
    .filter((id, i, all) => all.indexOf(id) !== i);

  console.log('=== Re-mint allocations ===');
  console.log(`  file:       ${file}`);
  console.log(`  recipients: ${allocations.length}`);
  console.log(`  cards:      ${total}`);

  // token_ids are globally unique for PLAYERS (finalize_mint asserts
  // !nft_exists), so a repeated id anywhere in the file will fail partway
  // through and leave the migration half-applied. Catch it before spending gas.
  if (duplicates.length > 0) {
    console.error(
      `\n  REFUSING: card id(s) ${[...new Set(duplicates)].join(', ')} appear more than once. ` +
      'Player NFTs are one-per-id, so this allocation cannot be minted in full.',
    );
    return 1;
  }
  for (const a of allocations) a.cardIds.forEach(ranksFor); // fail early on unknown ids

  if (dryRun) {
    console.log('\n--dry-run: allocation is valid. Nothing minted.');
    for (const a of allocations.slice(0, 10)) {
      console.log(`    ${a.address}  ${a.cardIds.length} card(s)`);
    }
    if (allocations.length > 10) console.log(`    … and ${allocations.length - 10} more`);
    return 0;
  }

  const nftAddress = process.env.VITE_NFT_CONTRACT_ADDRESS;
  const { DEPLOYER_SECRET, DEPLOYER_SALT, DEPLOYER_SIGNING_KEY } = process.env;
  if (!nftAddress) throw new Error('VITE_NFT_CONTRACT_ADDRESS is required');
  if (!DEPLOYER_SECRET || !DEPLOYER_SALT || !DEPLOYER_SIGNING_KEY) {
    throw new Error('DEPLOYER_SECRET/SALT/SIGNING_KEY are required — only the minter can mint');
  }

  const node = createAztecNodeClient(PXE_URL);
  const wallet = await EmbeddedWallet.create(node, { ephemeral: false, pxeConfig: { proverEnabled: true } });
  const deployer = await wallet.createSchnorrAccount(
    Fr.fromHexString(DEPLOYER_SECRET), Fr.fromHexString(DEPLOYER_SALT),
    GrumpkinScalar.fromHexString(DEPLOYER_SIGNING_KEY),
  );

  const artifact = loadContractArtifact(JSON.parse(readFileSync(
    resolve(ROOT_DIR, 'packages/contracts/target/triple_triad_nft-TripleTriadNFT.json'), 'utf-8')));
  const addr = AztecAddress.fromStringUnsafe(nftAddress);
  const instance = await node.getContract(addr);
  if (!instance) throw new Error(`NFT contract ${nftAddress} not found on this chain`);
  await wallet.registerContract(instance, artifact);
  const nft = await Contract.at(addr, artifact, wallet as never);

  let done = 0;
  for (const a of allocations) {
    const to = AztecAddress.fromStringUnsafe(a.address);
    for (const cardId of a.cardIds) {
      try {
        await nft.methods
          .mint_to_private(to, new Fr(BigInt(cardId)), new Fr(BigInt(ranksFor(cardId))))
          .send({
            from: deployer.address,
            fee: { gasSettings: { maxFeesPerGas: await headroomMaxFeesPerGas(node) } },
            wait: { timeout: TX_TIMEOUT },
          });
        done += 1;
        console.log(`  minted ${cardId} -> ${a.address.slice(0, 20)}… (${done}/${total})`);
      } catch (err: unknown) {
        // Stop rather than continue: a half-applied migration that reports
        // success is far worse to unpick than one that stops and says where.
        throw new Error(
          `mint of card ${cardId} to ${a.address} failed after ${done} of ${total}: ` +
          `${String((err as Error)?.message ?? err)}`,
        );
      }
    }
  }
  console.log(`\n=== Done. ${done} card(s) minted. ===`);
  return 0;
}

main().then(c => process.exit(c)).catch(err => {
  console.error(err?.stack ?? err?.message ?? err);
  process.exit(1);
});
