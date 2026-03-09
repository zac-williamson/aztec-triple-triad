// @ts-nocheck — Aztec SDK types require sandbox-specific resolution
/**
 * E2E One-Player Nullifier Sync Test
 *
 * IDENTICAL to e2e-two-player-nullifier.test.ts except only ONE player.
 * Same 3-round flow: starter → nullify → mint → nullify → mint → nullify.
 * If this passes but the two-player version fails, the bug is caused by
 * having a second PXE/wallet interacting with the same contract.
 *
 * Run:
 *   cd packages/integration
 *   npx vitest run tests/e2e-one-player-nullifier.test.ts
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

/** Safe Fr conversion — handles both hex and decimal strings. */
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

/** Helper class encapsulating one player's wallet, account, and contract handle. */
class PlayerContext {
  wallet: any;
  addr: any;
  nftContract: any;
  fee: any;
  label: string;
  node: any;

  constructor(label: string) {
    this.label = label;
  }

  get sendOpts() {
    return {
      from: this.addr,
      fee: { paymentMethod: this.fee },
      wait: { timeout: SEND_TIMEOUT },
    };
  }

  /** Import notes from a TxEffect into this player's PXE via import_note. */
  async importNotes(
    txHashStr: string,
    tokenIds: number[],
    randomnessValues: Fr[],
  ) {
    const { TxHash } = await import('@aztec/stdlib/tx');
    const txHash = TxHash.fromString(txHashStr);
    const txResult = await this.node.getTxEffect(txHash);
    expect(txResult?.data).toBeTruthy();
    const txEffect = txResult.data;

    const rawNoteHashes: any[] = txEffect.noteHashes ?? [];
    const nonZeroHashes = rawNoteHashes.filter((h: any) => BigInt(h) !== 0n);
    const firstNullifier = txEffect.nullifiers?.[0];

    console.log(`  [${this.label}] TxEffect: ${nonZeroHashes.length} non-zero note hashes, block=${txResult.l2BlockNumber}`);

    const paddedHashes = new Array(64).fill(new Fr(0n));
    for (let i = 0; i < rawNoteHashes.length && i < 64; i++) {
      paddedHashes[i] = rawNoteHashes[i];
    }

    for (let i = 0; i < tokenIds.length; i++) {
      console.log(`  [${this.label}] Importing token_id=${tokenIds[i]} randomness=${randomnessValues[i].toString()}`);
      await this.nftContract.methods
        .import_note(
          this.addr,
          new Fr(BigInt(tokenIds[i])),
          randomnessValues[i],
          new Fr(BigInt(txHashStr)),
          paddedHashes,
          nonZeroHashes.length,
          firstNullifier,
          this.addr,
        )
        .simulate({ from: this.addr });
    }
    console.log(`  [${this.label}] Imported ${tokenIds.length} notes`);
  }

  /** Get private cards visible to this player. */
  async getPrivateCards(): Promise<number[]> {
    const [page] = await this.nftContract.methods
      .get_private_cards(this.addr, 0)
      .simulate({ from: this.addr });
    return page
      .map((v: any) => Number(BigInt(v)))
      .filter((id: number) => id !== 0);
  }

  /** Get current note nonce. */
  async getNoteNonce(): Promise<bigint> {
    const result = await this.nftContract.methods
      .get_note_nonce(this.addr)
      .simulate({ from: this.addr });
    return BigInt(result.toString());
  }

  /** Get game randomness via preview_game_data. */
  async getGameRandomness(nonceValue: bigint): Promise<{ gameId: Fr; randomness: Fr[] }> {
    const result = await this.nftContract.methods
      .preview_game_data(new Fr(nonceValue))
      .simulate({ from: this.addr });
    const gameId = toFr(result[0]);
    const randomness: Fr[] = [];
    for (let i = 1; i <= 6; i++) {
      randomness.push(toFr(result[i]));
    }
    return { gameId, randomness };
  }

  /** Get note randomness via compute_note_randomness. */
  async getNoteRandomness(nonceValue: bigint, count: number): Promise<Fr[]> {
    const result = await this.nftContract.methods
      .compute_note_randomness(new Fr(nonceValue), count)
      .simulate({ from: this.addr });
    const values: Fr[] = [];
    for (let i = 0; i < count; i++) {
      values.push(toFr(result[i]));
    }
    return values;
  }
}

describe('E2E One-Player Nullifier Sync', () => {
  const p1 = new PlayerContext('P1');

  beforeAll(async () => {
    const node = createAztecNodeClient(PXE_URL);

    // Create ONE EmbeddedWallet (one PXE)
    console.log('Creating one EmbeddedWallet (one PXE)...');
    const wallet1 = await EmbeddedWallet.create(node, { ephemeral: true });

    // Register SponsoredFPC
    const fpcInstance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContractArtifact, { salt: new Fr(SPONSORED_FPC_SALT) },
    );
    await wallet1.registerContract(fpcInstance, SponsoredFPCContractArtifact);
    const fee1 = new SponsoredFeePaymentMethod(fpcInstance.address);

    // Deploy Player 1 account on wallet1
    console.log('Deploying Player 1 account...');
    const account1 = await wallet1.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await (await account1.getDeployMethod()).send({
      from: AztecAddress.ZERO,
      fee: { paymentMethod: fee1 },
      skipClassPublication: true,
      skipInstancePublication: true,
      wait: { timeout: SEND_TIMEOUT },
    });
    await wallet1.registerSender(account1.address, 'player1');
    console.log(`  P1: ${account1.address}`);

    // Deploy NFT contract from wallet1
    const nftArtifact = loadContractArtifact('triple_triad_nft-TripleTriadNFT');
    console.log('Deploying TripleTriadNFT...');
    const nftContract = await Contract.deploy(wallet1, nftArtifact, [
      account1.address,
      encodeCompressedString('Test'),
      encodeCompressedString('T'),
    ]).send({
      from: account1.address,
      fee: { paymentMethod: fee1 },
      wait: { timeout: SEND_TIMEOUT },
    });
    const nftAddr = nftContract.address;
    console.log(`  NFT at: ${nftAddr}`);

    // Register the NFT contract
    await wallet1.registerSender(nftAddr, 'nft');

    // Populate player context
    p1.wallet = wallet1;
    p1.addr = account1.address;
    p1.nftContract = nftContract;
    p1.fee = fee1;
    p1.node = node;
  }, 300_000);

  it('should handle 3 rounds of create→nullify→mint→nullify without Existing nullifier', async () => {
    const { TxHash } = await import('@aztec/stdlib/tx');

    // ================================================================
    // ROUND 1: P1 gets starter cards, then nullifies them
    // ================================================================
    console.log('\n========== ROUND 1: Starter cards ==========');

    // P1: get_cards_for_new_player (real function, with ONCHAIN_CONSTRAINED nonce note)
    console.log('\n--- P1: get_cards_for_new_player ---');
    const p1StarterReceipt = await p1.nftContract.methods
      .get_cards_for_new_player()
      .send(p1.sendOpts);
    const p1StarterTxHash = p1StarterReceipt.txHash?.toString();
    console.log(`  P1 starter tx: ${p1StarterTxHash}`);

    await new Promise(r => setTimeout(r, 2000));

    // Import starter notes
    const p1StarterRandomness = await p1.getNoteRandomness(0n, 5);
    await p1.importNotes(p1StarterTxHash, [1, 2, 3, 4, 5], p1StarterRandomness);

    // Verify cards visible
    let p1Cards = await p1.getPrivateCards();
    console.log(`  P1 cards: [${p1Cards}]`);
    expect(p1Cards.length).toBeGreaterThanOrEqual(5);

    // Nullify starter cards
    console.log('\n--- P1: nullify starter cards ---');
    const p1Nullify1Receipt = await p1.nftContract.methods
      .test_nullify_cards(p1.addr, [1, 2, 3, 4, 5].map(n => new Fr(BigInt(n))))
      .send(p1.sendOpts);
    console.log(`  P1 nullify-1 tx: ${p1Nullify1Receipt.txHash?.toString()}`);

    // Log P1 nullifiers from TxEffect
    const p1Nullify1TxEffect = await p1.node.getTxEffect(TxHash.fromString(p1Nullify1Receipt.txHash?.toString()));
    const p1Nullifiers1 = p1Nullify1TxEffect.data.nullifiers.filter((n: any) => BigInt(n) !== 0n);
    console.log(`  P1 nullify-1: ${p1Nullifiers1.length} nullifiers, block=${p1Nullify1TxEffect.l2BlockNumber}`);
    for (let i = 0; i < p1Nullifiers1.length; i++) {
      console.log(`    nullifier[${i}]: ${p1Nullifiers1[i].toString()}`);
    }

    await new Promise(r => setTimeout(r, 3000));

    // ================================================================
    // ROUND 2: P1 gets winner cards, then nullifies them
    // ================================================================
    console.log('\n========== ROUND 2: Winner cards (round 1 settlement) ==========');

    // P1: mint winner cards
    const p1Nonce1 = await p1.getNoteNonce();
    console.log(`  P1 nonce: ${p1Nonce1}`);
    const { randomness: p1GameRand1 } = await p1.getGameRandomness(p1Nonce1);
    console.log(`\n--- P1: test_mint_winner_cards ---`);
    for (let i = 0; i < 6; i++) {
      console.log(`  P1 randomness[${i}]: ${p1GameRand1[i].toString()}`);
    }

    const p1MintReceipt1 = await p1.nftContract.methods
      .test_mint_winner_cards(
        [1, 2, 3, 4, 5, 6].map(n => new Fr(BigInt(n))),
        p1.addr,
        p1GameRand1,
      )
      .send(p1.sendOpts);
    const p1MintTxHash1 = p1MintReceipt1.txHash?.toString();
    console.log(`  P1 mint-1 tx: ${p1MintTxHash1}`);

    await new Promise(r => setTimeout(r, 2000));

    // Import winner notes
    await p1.importNotes(p1MintTxHash1, [1, 2, 3, 4, 5, 6], p1GameRand1);

    p1Cards = await p1.getPrivateCards();
    console.log(`  P1 cards after mint-1: [${p1Cards}]`);
    expect(p1Cards.length).toBeGreaterThanOrEqual(5);

    // Nullify winner cards
    console.log('\n--- P1: nullify round-2 cards ---');
    try {
      const p1Nullify2Receipt = await p1.nftContract.methods
        .test_nullify_cards(p1.addr, [1, 2, 3, 4, 5].map(n => new Fr(BigInt(n))))
        .send(p1.sendOpts);
      console.log(`  P1 nullify-2 tx: ${p1Nullify2Receipt.txHash?.toString()}`);

      const p1Nullify2TxEffect = await p1.node.getTxEffect(TxHash.fromString(p1Nullify2Receipt.txHash?.toString()));
      const p1Nullifiers2 = p1Nullify2TxEffect.data.nullifiers.filter((n: any) => BigInt(n) !== 0n);
      console.log(`  P1 nullify-2: ${p1Nullifiers2.length} nullifiers, block=${p1Nullify2TxEffect.l2BlockNumber}`);

      // Check overlap with round-1 nullifiers
      const p1Set1 = new Set(p1Nullifiers1.map((n: any) => n.toString()));
      const p1Overlap = p1Nullifiers2.filter((n: any) => p1Set1.has(n.toString()));
      if (p1Overlap.length > 0) {
        console.log(`  WARNING: P1 has ${p1Overlap.length} overlapping nullifiers between rounds!`);
        for (const n of p1Overlap) console.log(`    OVERLAP: ${n.toString()}`);
      } else {
        console.log('  P1: No nullifier overlap between rounds ✓');
      }
    } catch (err: any) {
      console.log(`  P1 nullify-2 FAILED: ${err?.message || err}`);
      throw err;
    }

    await new Promise(r => setTimeout(r, 3000));

    // ================================================================
    // ROUND 3: P1 gets winner cards again, then nullifies again
    //          This is the round that triggers "Existing nullifier" in the two-player test
    // ================================================================
    console.log('\n========== ROUND 3: Winner cards (round 2 settlement) ==========');
    console.log('  This mirrors Game 3 in the real app — the failure case.');

    // P1: mint winner cards (round 3)
    const p1Nonce2 = await p1.getNoteNonce();
    console.log(`  P1 nonce: ${p1Nonce2}`);
    const { randomness: p1GameRand2 } = await p1.getGameRandomness(p1Nonce2);
    console.log(`\n--- P1: test_mint_winner_cards (round 3) ---`);
    for (let i = 0; i < 6; i++) {
      console.log(`  P1 randomness[${i}]: ${p1GameRand2[i].toString()}`);
    }

    const p1MintReceipt2 = await p1.nftContract.methods
      .test_mint_winner_cards(
        [1, 2, 3, 4, 5, 6].map(n => new Fr(BigInt(n))),
        p1.addr,
        p1GameRand2,
      )
      .send(p1.sendOpts);
    const p1MintTxHash2 = p1MintReceipt2.txHash?.toString();
    console.log(`  P1 mint-2 tx: ${p1MintTxHash2}`);

    await new Promise(r => setTimeout(r, 2000));

    // Import winner notes (round 3)
    await p1.importNotes(p1MintTxHash2, [1, 2, 3, 4, 5, 6], p1GameRand2);

    p1Cards = await p1.getPrivateCards();
    console.log(`  P1 cards after mint-2: [${p1Cards}]`);
    expect(p1Cards.length).toBeGreaterThanOrEqual(5);

    // Nullify winner cards (round 3) — THIS IS THE FAILURE POINT IN THE TWO-PLAYER TEST
    console.log('\n--- P1: nullify round-3 cards (THE CRITICAL TEST) ---');
    try {
      const p1Nullify3Receipt = await p1.nftContract.methods
        .test_nullify_cards(p1.addr, [1, 2, 3, 4, 5].map(n => new Fr(BigInt(n))))
        .send(p1.sendOpts);
      console.log(`  P1 nullify-3 tx: ${p1Nullify3Receipt.txHash?.toString()}`);
      console.log('  P1 ROUND 3 PASSED ✓');
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.log(`\n  P1 ROUND 3 FAILED: ${msg}`);
      if (msg.includes('Existing nullifier')) {
        console.log('  *** BUG REPRODUCED for P1: Existing nullifier in round 3 ***');
      }
      throw err;
    }

    console.log('\n========== ALL 3 ROUNDS PASSED ✓ ==========');
  }, 900_000);
});
