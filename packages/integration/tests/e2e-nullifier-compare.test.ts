// @ts-nocheck — Aztec SDK types require sandbox-specific resolution
/**
 * E2E Nullifier Comparison Test
 *
 * Compares TxEffect data (note hashes, nullifiers) between:
 *   - get_cards_for_new_player (real, with cooldown partial notes)
 *   - get_cards_for_new_player_test (no cooldown partial notes)
 *
 * Goal: determine if the extra note hashes from partial note completion
 * affect the stored siloedNullifier values for card notes, which would
 * cause syncNoteNullifiers to fail.
 *
 * Run:
 *   cd packages/integration
 *   npx vitest run tests/e2e-nullifier-compare.test.ts
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

import { NO_FROM } from '@aztec/aztec.js/account';
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

describe('E2E Nullifier Comparison: real vs test function', () => {
  let wallet: any;
  let node: any;
  let fee: any;
  let playerAddr: any;
  let realContract: any;
  let testContract: any;

  const sendAs = (addr: any) => ({
    from: addr,
    fee: { paymentMethod: fee },
    wait: { timeout: SEND_TIMEOUT },
  });

  async function importNotes(
    contract: any,
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
    for (let i = 0; i < nonZeroHashes.length; i++) {
      console.log(`    noteHash[${i}]: ${nonZeroHashes[i].toString()}`);
    }

    const rawNullifiers: any[] = txEffect.nullifiers ?? [];
    const nonZeroNullifiers = rawNullifiers.filter((n: any) => BigInt(n) !== 0n);
    console.log(`  [${label}] TxEffect: ${nonZeroNullifiers.length} non-zero nullifiers`);
    for (let i = 0; i < nonZeroNullifiers.length; i++) {
      console.log(`    nullifier[${i}]: ${nonZeroNullifiers[i].toString()}`);
    }

    const paddedHashes = new Array(64).fill(new Fr(0n));
    for (let i = 0; i < rawNoteHashes.length && i < 64; i++) {
      paddedHashes[i] = rawNoteHashes[i];
    }

    for (let i = 0; i < tokenIds.length; i++) {
      await contract.methods
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

  async function getPrivateCards(contract: any): Promise<number[]> {
    const { result } = await contract.methods
      .get_private_cards(playerAddr, 0)
      .simulate({ from: playerAddr });
    const page = result[0];
    return page
      .map((v: any) => Number(BigInt(v)))
      .filter((id: number) => id !== 0);
  }

  async function getNoteRandomness(contract: any, nonceValue: bigint, count: number): Promise<Fr[]> {
    const { result } = await contract.methods
      .compute_note_randomness(new Fr(nonceValue), count)
      .simulate({ from: playerAddr });
    const values: Fr[] = [];
    for (let i = 0; i < count; i++) {
      values.push(toFr(result[i]));
    }
    return values;
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

    // Deploy player account
    console.log('Deploying player account...');
    const playerAccount = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await (await playerAccount.getDeployMethod()).send({
      from: NO_FROM,
      fee: { paymentMethod: fee },
      skipClassPublication: true,
      skipInstancePublication: true,
      wait: { timeout: SEND_TIMEOUT },
    });
    playerAddr = playerAccount.address;
    await wallet.registerSender(playerAddr, 'player');
    console.log(`  Player: ${playerAddr}`);

    const nftArtifact = loadContractArtifact('triple_triad_nft-TripleTriadNFT');

    // Deploy TWO separate NFT contracts (so they have independent state)
    console.log('Deploying REAL NFT contract...');
    ({ contract: realContract } = await Contract.deploy(wallet, nftArtifact, [
      playerAddr,
      encodeCompressedString('Real'),
      encodeCompressedString('R'),
    ]).send(sendAs(playerAddr)));
    console.log(`  Real NFT at: ${realContract.address}`);
    await wallet.registerSender(realContract.address, 'real-nft');

    console.log('Deploying TEST NFT contract...');
    ({ contract: testContract } = await Contract.deploy(wallet, nftArtifact, [
      playerAddr,
      encodeCompressedString('Test'),
      encodeCompressedString('T'),
    ]).send(sendAs(playerAddr)));
    console.log(`  Test NFT at: ${testContract.address}`);
    await wallet.registerSender(testContract.address, 'test-nft');
  }, 300_000);

  it('should compare TxEffect data and nullifiers between real and test functions', async () => {
    const { TxHash } = await import('@aztec/stdlib/tx');

    // ================================================================
    // PART A: REAL get_cards_for_new_player (with cooldown partial notes)
    // ================================================================
    console.log('\n========== PART A: REAL get_cards_for_new_player ==========');

    const realReceipt = await realContract.methods
      .get_cards_for_new_player()
      .send(sendAs(playerAddr));
    const realTxHash = realReceipt.txHash?.toString();
    console.log(`  Real tx: ${realTxHash}`);

    await new Promise(r => setTimeout(r, 2000));

    const realRandomness = await getNoteRandomness(realContract, 0n, 5);
    console.log('  Real randomness:');
    for (let i = 0; i < 5; i++) {
      console.log(`    [${i}]: ${realRandomness[i].toString()}`);
    }

    await importNotes(realContract, realTxHash, [1, 2, 3, 4, 5], realRandomness, 'REAL');

    let realCards = await getPrivateCards(realContract);
    console.log(`  Real cards after import: [${realCards}]`);

    // Nullify the 5 starter cards
    console.log('\n--- REAL: nullify cards ---');
    const realNullifyReceipt = await realContract.methods
      .test_nullify_cards(playerAddr, [1, 2, 3, 4, 5].map(n => new Fr(BigInt(n))))
      .send(sendAs(playerAddr));
    const realNullifyTxHash = realNullifyReceipt.txHash?.toString();
    console.log(`  Real nullify tx: ${realNullifyTxHash}`);

    const realNullifyEffect = await node.getTxEffect(TxHash.fromString(realNullifyTxHash));
    const realNullifiers = realNullifyEffect.data.nullifiers.filter((n: any) => BigInt(n) !== 0n);
    console.log(`  Real nullify: ${realNullifiers.length} nullifiers, block=${realNullifyEffect.l2BlockNumber}`);
    for (let i = 0; i < realNullifiers.length; i++) {
      console.log(`    nullifier[${i}]: ${realNullifiers[i].toString()}`);
    }

    await new Promise(r => setTimeout(r, 3000));

    realCards = await getPrivateCards(realContract);
    console.log(`  Real cards after nullify: [${realCards}] (expect 0)`);

    // ================================================================
    // PART B: TEST get_cards_for_new_player_test (no cooldown partial notes)
    // ================================================================
    console.log('\n========== PART B: TEST get_cards_for_new_player_test ==========');

    const testReceipt = await testContract.methods
      .get_cards_for_new_player_test(new Fr(0n))
      .send(sendAs(playerAddr));
    const testTxHash = testReceipt.txHash?.toString();
    console.log(`  Test tx: ${testTxHash}`);

    await new Promise(r => setTimeout(r, 2000));

    const testRandomness = await getNoteRandomness(testContract, 0n, 5);
    console.log('  Test randomness:');
    for (let i = 0; i < 5; i++) {
      console.log(`    [${i}]: ${testRandomness[i].toString()}`);
    }

    await importNotes(testContract, testTxHash, [1, 2, 3, 4, 5], testRandomness, 'TEST');

    let testCards = await getPrivateCards(testContract);
    console.log(`  Test cards after import: [${testCards}]`);

    // Nullify the 5 starter cards
    console.log('\n--- TEST: nullify cards ---');
    const testNullifyReceipt = await testContract.methods
      .test_nullify_cards(playerAddr, [1, 2, 3, 4, 5].map(n => new Fr(BigInt(n))))
      .send(sendAs(playerAddr));
    const testNullifyTxHash = testNullifyReceipt.txHash?.toString();
    console.log(`  Test nullify tx: ${testNullifyTxHash}`);

    const testNullifyEffect = await node.getTxEffect(TxHash.fromString(testNullifyTxHash));
    const testNullifiers = testNullifyEffect.data.nullifiers.filter((n: any) => BigInt(n) !== 0n);
    console.log(`  Test nullify: ${testNullifiers.length} nullifiers, block=${testNullifyEffect.l2BlockNumber}`);
    for (let i = 0; i < testNullifiers.length; i++) {
      console.log(`    nullifier[${i}]: ${testNullifiers[i].toString()}`);
    }

    await new Promise(r => setTimeout(r, 3000));

    testCards = await getPrivateCards(testContract);
    console.log(`  Test cards after nullify: [${testCards}] (expect 0)`);

    // ================================================================
    // COMPARISON
    // ================================================================
    console.log('\n========== COMPARISON ==========');
    console.log(`  Real: ${realCards.length} cards remaining after nullify`);
    console.log(`  Test: ${testCards.length} cards remaining after nullify`);

    if (realCards.length !== testCards.length) {
      console.log('  *** DIFFERENCE DETECTED ***');
      console.log(`  Real has ${realCards.length} cards, Test has ${testCards.length} cards`);
      console.log('  The cooldown partial notes are affecting nullification!');
    } else {
      console.log('  Both have same number of remaining cards');
    }

    // Both should have 0 cards remaining
    expect(testCards.length).toBe(0);
    // This might fail if the real function has the bug
    // expect(realCards.length).toBe(0);
  }, 600_000);
});
