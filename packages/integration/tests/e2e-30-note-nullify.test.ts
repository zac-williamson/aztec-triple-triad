// @ts-nocheck — Aztec SDK types require sandbox-specific resolution
/**
 * E2E 30-Note Nullification Test
 *
 * Tests whether the PXE correctly tracks nullification when many notes exist.
 * Creates 30 card notes (3 batches of 10), nullifies all 30 (3 batches of 10),
 * then asserts get_private_cards returns 0.
 *
 * Run:
 *   cd packages/integration
 *   npx vitest run tests/e2e-30-note-nullify.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { Fr } from '@aztec/aztec.js/fields';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Contract } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { getContractInstanceFromInstantiationParams } from '@aztec/stdlib/contract';

import { loadContractArtifact } from './e2e-helpers.js';

const PXE_URL = process.env.AZTEC_PXE_URL || 'http://localhost:8080';
const SEND_TIMEOUT = 300;

function toFr(v: any): Fr {
  if (v instanceof Fr) return v;
  const s = v.toString();
  if (s.startsWith('0x') || s.startsWith('0X')) return Fr.fromHexString(s);
  return new Fr(BigInt(s));
}

function encodeCompressedString(s: string): Fr {
  let hex = '';
  for (let i = 0; i < s.length && i < 31; i++) {
    hex += s.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return new Fr(BigInt('0x' + hex));
}

describe('E2E 30-Note Create and Nullify', () => {
  let wallet: any;
  let node: any;
  let fee: any;
  let playerAddr: any;
  let nftContract: any;

  const sendOpts = () => ({
    from: playerAddr,
    fee: { paymentMethod: fee },
    wait: { timeout: SEND_TIMEOUT },
  });

  async function getNoteRandomness(nonceOffset: bigint, count: number): Promise<Fr[]> {
    const { result } = await nftContract.methods
      .compute_note_randomness(new Fr(nonceOffset), count)
      .simulate({ from: playerAddr });
    const values: Fr[] = [];
    for (let i = 0; i < count; i++) {
      values.push(toFr(result[i]));
    }
    return values;
  }

  async function importNotes(
    txHashStr: string,
    tokenIds: number[],
    randomnessValues: Fr[],
    label: string,
  ) {
    const { TxHash } = await import('@aztec/stdlib/tx');
    const txHash = TxHash.fromString(txHashStr);
    const txResult = await node.getTxEffect(txHash);
    expect(txResult?.data).toBeTruthy();
    const txEffect = txResult.data;

    const rawNoteHashes: any[] = txEffect.noteHashes ?? [];
    const nonZeroHashes = rawNoteHashes.filter((h: any) => BigInt(h) !== 0n);
    const firstNullifier = txEffect.nullifiers?.[0];

    console.log(`  [${label}] TxEffect: ${nonZeroHashes.length} non-zero note hashes, block=${txResult.l2BlockNumber}`);

    const paddedHashes = new Array(64).fill(new Fr(0n));
    for (let i = 0; i < rawNoteHashes.length && i < 64; i++) {
      paddedHashes[i] = rawNoteHashes[i];
    }

    for (let i = 0; i < tokenIds.length; i++) {
      await nftContract.methods
        .import_note(
          playerAddr,
          new Fr(BigInt(tokenIds[i])),
          randomnessValues[i],
          new Fr(BigInt(txHashStr)),
          paddedHashes,
          nonZeroHashes.length,
          firstNullifier,
          playerAddr,
        )
        .simulate({ from: playerAddr });
    }
    console.log(`  [${label}] Imported ${tokenIds.length} notes`);
  }

  async function getPrivateCards(): Promise<number[]> {
    const all: number[] = [];
    let pageIndex = 0;
    while (true) {
      const { result: [page, hasMore] } = await nftContract.methods
        .get_private_cards(playerAddr, pageIndex)
        .simulate({ from: playerAddr });
      const ids = page
        .map((v: any) => Number(BigInt(v)))
        .filter((id: number) => id !== 0);
      all.push(...ids);
      if (!hasMore) break;
      pageIndex++;
    }
    return all;
  }

  beforeAll(async () => {
    node = createAztecNodeClient(PXE_URL);
    console.log('Creating EmbeddedWallet...');
    wallet = await EmbeddedWallet.create(node, { ephemeral: true });
    await new Promise(r => setTimeout(r, 3000));

    const fpcInstance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContractArtifact, { salt: new Fr(SPONSORED_FPC_SALT) },
    );
    await wallet.registerContract(fpcInstance, SponsoredFPCContractArtifact);
    fee = new SponsoredFeePaymentMethod(fpcInstance.address);

    console.log('Deploying player account...');
    const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await (await account.getDeployMethod()).send({
      from: AztecAddress.ZERO,
      fee: { paymentMethod: fee },
      skipClassPublication: true,
      skipInstancePublication: true,
      wait: { timeout: SEND_TIMEOUT },
    });
    playerAddr = account.address;
    await wallet.registerSender(playerAddr, 'player');
    console.log(`  Player: ${playerAddr}`);

    const nftArtifact = loadContractArtifact('triple_triad_nft-TripleTriadNFT');
    console.log('Deploying TripleTriadNFT...');
    nftContract = (await Contract.deploy(wallet, nftArtifact, [
      playerAddr,
      encodeCompressedString('Test30'),
      encodeCompressedString('T30'),
    ]).send(sendOpts())).contract;
    console.log(`  NFT at: ${nftContract.address}`);
    await wallet.registerSender(nftContract.address, 'nft');
  }, 300_000);

  it('should create 30 notes, nullify all 30, and have 0 remaining', async () => {
    // Use unique token IDs per batch to avoid ambiguity:
    // Batch 0: IDs 1-10, Batch 1: IDs 11-20, Batch 2: IDs 21-30
    const batches = [
      { ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], nonceOffset: 0n },
      { ids: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], nonceOffset: 100n },
      { ids: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30], nonceOffset: 200n },
    ];

    // ================================================================
    // STEP 1: Create 30 cards (3 x 10)
    // ================================================================
    console.log('\n========== STEP 1: Create 30 cards ==========');

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const frIds = batch.ids.map(n => new Fr(BigInt(n)));
      const randomness = await getNoteRandomness(batch.nonceOffset, 10);

      console.log(`\n--- Batch ${b}: creating IDs [${batch.ids}] with nonceOffset=${batch.nonceOffset} ---`);
      const { receipt } = await nftContract.methods
        .test_create_10_cards(playerAddr, frIds, new Fr(batch.nonceOffset))
        .send(sendOpts());
      const txHash = receipt.txHash?.toString();
      console.log(`  tx: ${txHash}`);

      await new Promise(r => setTimeout(r, 2000));

      await importNotes(txHash, batch.ids, randomness, `batch-${b}`);
    }

    // Verify all 30 visible
    const cardsAfterCreate = await getPrivateCards();
    console.log(`\nCards after creating 30: [${cardsAfterCreate}] (count=${cardsAfterCreate.length})`);
    expect(cardsAfterCreate.length).toBe(30);

    // ================================================================
    // STEP 2: Nullify all 30 cards (3 x 10)
    // ================================================================
    console.log('\n========== STEP 2: Nullify all 30 cards ==========');

    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      const frIds = batch.ids.map(n => new Fr(BigInt(n)));

      console.log(`\n--- Batch ${b}: nullifying IDs [${batch.ids}] ---`);
      try {
        const { receipt } = await nftContract.methods
          .test_nullify_10_cards(playerAddr, frIds)
          .send(sendOpts());
        console.log(`  nullify tx: ${receipt.txHash?.toString()}`);
      } catch (err: any) {
        console.log(`  NULLIFY FAILED for batch ${b}: ${err?.message || err}`);
        throw err;
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    // ================================================================
    // STEP 3: Verify 0 cards remain
    // ================================================================
    console.log('\n========== STEP 3: Check remaining cards ==========');

    // Wait for PXE sync
    await new Promise(r => setTimeout(r, 5000));

    const cardsAfterNullify = await getPrivateCards();
    console.log(`Cards after nullifying 30: [${cardsAfterNullify}] (count=${cardsAfterNullify.length})`);

    if (cardsAfterNullify.length > 0) {
      console.log('*** BUG: PXE still shows cards that were nullified! ***');
      console.log(`  Stale card IDs: [${cardsAfterNullify}]`);
    }

    expect(cardsAfterNullify.length).toBe(0);
  }, 600_000);
});
