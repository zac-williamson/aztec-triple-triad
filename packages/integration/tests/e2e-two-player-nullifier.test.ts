// @ts-nocheck — Aztec SDK types require sandbox-specific resolution
/**
 * E2E Two-Player Nullifier Sync Test
 *
 * Models the real app more closely: TWO PXEs (EmbeddedWallets) and TWO accounts,
 * both doing concurrent note creation, import, and nullification against the
 * same blockchain.
 *
 * Flow (mirrors real 2-game app flow):
 *   Round 1:
 *     - Both players: get_cards_for_new_player → import → nullify (test_nullify_cards)
 *   Round 2:
 *     - Both players: test_mint_winner_cards → import → nullify (test_nullify_cards)
 *   Round 3:
 *     - Both players: test_mint_winner_cards → import → nullify (test_nullify_cards)
 *
 * If any nullify in Round 3 fails with "Existing nullifier", the bug is reproduced.
 *
 * Run:
 *   cd packages/integration
 *   npx vitest run tests/e2e-two-player-nullifier.test.ts
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
    const { result } = await this.nftContract.methods
      .get_private_cards(this.addr, 0)
      .simulate({ from: this.addr });
    const page = result[0];
    return page
      .map((v: any) => Number(BigInt(v)))
      .filter((id: number) => id !== 0);
  }

  /** Get current note nonce. */
  async getNoteNonce(): Promise<bigint> {
    const { result } = await this.nftContract.methods
      .get_note_nonce(this.addr)
      .simulate({ from: this.addr });
    return BigInt(result.toString());
  }

  /** Get game randomness via preview_game_data. */
  async getGameRandomness(nonceValue: bigint): Promise<{ gameId: Fr; randomness: Fr[] }> {
    const { result } = await this.nftContract.methods
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
    const { result } = await this.nftContract.methods
      .compute_note_randomness(new Fr(nonceValue), count)
      .simulate({ from: this.addr });
    const values: Fr[] = [];
    for (let i = 0; i < count; i++) {
      values.push(toFr(result[i]));
    }
    return values;
  }
}

describe('E2E Two-Player Nullifier Sync', () => {
  const p1 = new PlayerContext('P1');
  const p2 = new PlayerContext('P2');

  beforeAll(async () => {
    const node = createAztecNodeClient(PXE_URL);

    // Create TWO separate EmbeddedWallets (= two PXEs)
    console.log('Creating two EmbeddedWallets (two PXEs)...');
    const wallet1 = await EmbeddedWallet.create(node, { ephemeral: true });
    const wallet2 = await EmbeddedWallet.create(node, { ephemeral: true });
    // await new Promise(r => setTimeout(r, 3000));

    // Register SponsoredFPC on both wallets
    const fpcInstance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContractArtifact, { salt: new Fr(SPONSORED_FPC_SALT) },
    );
    await wallet1.registerContract(fpcInstance, SponsoredFPCContractArtifact);
    await wallet2.registerContract(fpcInstance, SponsoredFPCContractArtifact);
    const fee1 = new SponsoredFeePaymentMethod(fpcInstance.address);
    const fee2 = new SponsoredFeePaymentMethod(fpcInstance.address);

    // Deploy Player 1 account on wallet1
    console.log('Deploying Player 1 account...');
    const account1 = await wallet1.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await (await account1.getDeployMethod()).send({
      from: NO_FROM,
      fee: { paymentMethod: fee1 },
      skipClassPublication: true,
      skipInstancePublication: true,
      wait: { timeout: SEND_TIMEOUT },
    });
    await wallet1.registerSender(account1.address, 'player1');
    console.log(`  P1: ${account1.address}`);

    // Deploy Player 2 account on wallet2
    console.log('Deploying Player 2 account...');
    const account2 = await wallet2.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await (await account2.getDeployMethod()).send({
      from: NO_FROM,
      fee: { paymentMethod: fee2 },
      skipClassPublication: true,
      skipInstancePublication: true,
      wait: { timeout: SEND_TIMEOUT },
    });
    await wallet2.registerSender(account2.address, 'player2');
    console.log(`  P2: ${account2.address}`);

    // Deploy NFT contract from wallet1
    const nftArtifact = loadContractArtifact('triple_triad_nft-TripleTriadNFT');
    console.log('Deploying TripleTriadNFT...');
    const { contract: nftContract } = await Contract.deploy(wallet1, nftArtifact, [
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

    // Register the NFT contract on both wallets
    await wallet1.registerSender(nftAddr, 'nft');
    // wallet2 needs the contract instance from wallet1's PXE to register it
    // Register the NFT contract on wallet2 using same pattern as useAztec.ts line 176
    const nftInstance = await node.getContract(nftAddr);
    if (!nftInstance) throw new Error('Could not fetch NFT contract instance from node');
    await wallet2.registerContract(nftInstance, nftArtifact);
    await wallet2.registerSender(nftAddr, 'nft2');

    // Create contract handles for each wallet
    const nft1 = nftContract; // already connected to wallet1
    const nft2 = await Contract.at(nftAddr, nftArtifact, wallet2);

    // Populate player contexts
    p1.wallet = wallet1;
    p1.addr = account1.address;
    p1.nftContract = nft1;
    p1.fee = fee1;
    p1.node = node;

    p2.wallet = wallet2;
    p2.addr = account2.address;
    p2.nftContract = nft2;
    p2.fee = fee2;
    p2.node = node;
  }, 300_000);

  it('should handle 3 rounds of create→nullify→mint→nullify without Existing nullifier', async () => {
    const { TxHash } = await import('@aztec/stdlib/tx');

    // ================================================================
    // ROUND 1: Both players get starter cards, then nullify them
    // ================================================================
    console.log('\n========== ROUND 1: Starter cards ==========');

    // P1: get_cards_for_new_player_test(0) — no cooldown partial notes
    console.log('\n--- P1: get_cards_for_new_player_test(0) ---');
    const p1StarterReceipt = await p1.nftContract.methods
      .get_cards_for_new_player_test(new Fr(0n))
      .send(p1.sendOpts);
    const p1StarterTxHash = p1StarterReceipt.txHash?.toString();
    console.log(`  P1 starter tx: ${p1StarterTxHash}`);

    // P2: get_cards_for_new_player_test(0) — no cooldown partial notes
    console.log('\n--- P2: get_cards_for_new_player_test(0) ---');
    const p2StarterReceipt = await p2.nftContract.methods
      .get_cards_for_new_player_test(new Fr(0n))
      .send(p2.sendOpts);
    const p2StarterTxHash = p2StarterReceipt.txHash?.toString();
    console.log(`  P2 starter tx: ${p2StarterTxHash}`);

    await new Promise(r => setTimeout(r, 2000));

    // Import starter notes for both
    const p1StarterRandomness = await p1.getNoteRandomness(0n, 5);
    await p1.importNotes(p1StarterTxHash, [1, 2, 3, 4, 5], p1StarterRandomness);

    const p2StarterRandomness = await p2.getNoteRandomness(0n, 5);
    await p2.importNotes(p2StarterTxHash, [1, 2, 3, 4, 5], p2StarterRandomness);

    // Verify cards visible
    let p1Cards = await p1.getPrivateCards();
    let p2Cards = await p2.getPrivateCards();
    console.log(`  P1 cards: [${p1Cards}], P2 cards: [${p2Cards}]`);
    expect(p1Cards.length).toBeGreaterThanOrEqual(5);
    expect(p2Cards.length).toBeGreaterThanOrEqual(5);

    // Nullify starter cards for both
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

    console.log('\n--- P2: nullify starter cards ---');
    const p2Nullify1Receipt = await p2.nftContract.methods
      .test_nullify_cards(p2.addr, [1, 2, 3, 4, 5].map(n => new Fr(BigInt(n))))
      .send(p2.sendOpts);
    console.log(`  P2 nullify-1 tx: ${p2Nullify1Receipt.txHash?.toString()}`);

    const p2Nullify1TxEffect = await p2.node.getTxEffect(TxHash.fromString(p2Nullify1Receipt.txHash?.toString()));
    const p2Nullifiers1 = p2Nullify1TxEffect.data.nullifiers.filter((n: any) => BigInt(n) !== 0n);
    console.log(`  P2 nullify-1: ${p2Nullifiers1.length} nullifiers, block=${p2Nullify1TxEffect.l2BlockNumber}`);
    for (let i = 0; i < p2Nullifiers1.length; i++) {
      console.log(`    nullifier[${i}]: ${p2Nullifiers1[i].toString()}`);
    }

    await new Promise(r => setTimeout(r, 3000));

    // ================================================================
    // ROUND 2: Both players get winner cards, then nullify them
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

    // P2: mint winner cards
    const p2Nonce1 = await p2.getNoteNonce();
    console.log(`  P2 nonce: ${p2Nonce1}`);
    const { randomness: p2GameRand1 } = await p2.getGameRandomness(p2Nonce1);
    console.log(`\n--- P2: test_mint_winner_cards ---`);
    for (let i = 0; i < 6; i++) {
      console.log(`  P2 randomness[${i}]: ${p2GameRand1[i].toString()}`);
    }

    const p2MintReceipt1 = await p2.nftContract.methods
      .test_mint_winner_cards(
        [1, 2, 3, 4, 5, 6].map(n => new Fr(BigInt(n))),
        p2.addr,
        p2GameRand1,
      )
      .send(p2.sendOpts);
    const p2MintTxHash1 = p2MintReceipt1.txHash?.toString();
    console.log(`  P2 mint-1 tx: ${p2MintTxHash1}`);

    await new Promise(r => setTimeout(r, 2000));

    // Import winner notes for both
    await p1.importNotes(p1MintTxHash1, [1, 2, 3, 4, 5, 6], p1GameRand1);
    await p2.importNotes(p2MintTxHash1, [1, 2, 3, 4, 5, 6], p2GameRand1);

    p1Cards = await p1.getPrivateCards();
    p2Cards = await p2.getPrivateCards();
    console.log(`  P1 cards after mint-1: [${p1Cards}], P2 cards: [${p2Cards}]`);
    expect(p1Cards.length).toBeGreaterThanOrEqual(5);
    expect(p2Cards.length).toBeGreaterThanOrEqual(5);

    // Nullify winner cards for both
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
      console.log(`  c: ${err?.message || err}`);
      throw err;
    }

    console.log('\n--- P2: nullify round-2 cards ---');
    try {
      const p2Nullify2Receipt = await p2.nftContract.methods
        .test_nullify_cards(p2.addr, [1, 2, 3, 4, 5].map(n => new Fr(BigInt(n))))
        .send(p2.sendOpts);
      console.log(`  P2 nullify-2 tx: ${p2Nullify2Receipt.txHash?.toString()}`);

      const p2Nullify2TxEffect = await p2.node.getTxEffect(TxHash.fromString(p2Nullify2Receipt.txHash?.toString()));
      const p2Nullifiers2 = p2Nullify2TxEffect.data.nullifiers.filter((n: any) => BigInt(n) !== 0n);
      console.log(`  P2 nullify-2: ${p2Nullifiers2.length} nullifiers, block=${p2Nullify2TxEffect.l2BlockNumber}`);

      const p2Set1 = new Set(p2Nullifiers1.map((n: any) => n.toString()));
      const p2Overlap = p2Nullifiers2.filter((n: any) => p2Set1.has(n.toString()));
      if (p2Overlap.length > 0) {
        console.log(`  WARNING: P2 has ${p2Overlap.length} overlapping nullifiers between rounds!`);
        for (const n of p2Overlap) console.log(`    OVERLAP: ${n.toString()}`);
      } else {
        console.log('  P2: No nullifier overlap between rounds ✓');
      }
    } catch (err: any) {
      console.log(`  P2 nullify-2 FAILED: ${err?.message || err}`);
      throw err;
    }

    await new Promise(r => setTimeout(r, 3000));

    // ================================================================
    // ROUND 3: Both players get winner cards again, then nullify again
    //          This is the round that triggers "Existing nullifier" in the app
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

    // P2: mint winner cards (round 3)
    const p2Nonce2 = await p2.getNoteNonce();
    console.log(`  P2 nonce: ${p2Nonce2}`);
    const { randomness: p2GameRand2 } = await p2.getGameRandomness(p2Nonce2);
    console.log(`\n--- P2: test_mint_winner_cards (round 3) ---`);
    for (let i = 0; i < 6; i++) {
      console.log(`  P2 randomness[${i}]: ${p2GameRand2[i].toString()}`);
    }

    const p2MintReceipt2 = await p2.nftContract.methods
      .test_mint_winner_cards(
        [1, 2, 3, 4, 5, 6].map(n => new Fr(BigInt(n))),
        p2.addr,
        p2GameRand2,
      )
      .send(p2.sendOpts);
    const p2MintTxHash2 = p2MintReceipt2.txHash?.toString();
    console.log(`  P2 mint-2 tx: ${p2MintTxHash2}`);

    await new Promise(r => setTimeout(r, 2000));

    // Import winner notes (round 3)
    await p1.importNotes(p1MintTxHash2, [1, 2, 3, 4, 5, 6], p1GameRand2);
    await p2.importNotes(p2MintTxHash2, [1, 2, 3, 4, 5, 6], p2GameRand2);

    p1Cards = await p1.getPrivateCards();
    p2Cards = await p2.getPrivateCards();
    console.log(`  P1 cards after mint-2: [${p1Cards}], P2 cards: [${p2Cards}]`);
    expect(p1Cards.length).toBeGreaterThanOrEqual(5);
    expect(p2Cards.length).toBeGreaterThanOrEqual(5);

    // Nullify winner cards (round 3) — THIS IS THE FAILURE POINT
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

    console.log('\n--- P2: nullify round-3 cards (THE CRITICAL TEST) ---');
    try {
      const p2Nullify3Receipt = await p2.nftContract.methods
        .test_nullify_cards(p2.addr, [1, 2, 3, 4, 5].map(n => new Fr(BigInt(n))))
        .send(p2.sendOpts);
      console.log(`  P2 nullify-3 tx: ${p2Nullify3Receipt.txHash?.toString()}`);
      console.log('  P2 ROUND 3 PASSED ✓');
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.log(`\n  P2 ROUND 3 FAILED: ${msg}`);
      if (msg.includes('Existing nullifier')) {
        console.log('  *** BUG REPRODUCED for P2: Existing nullifier in round 3 ***');
      }
      throw err;
    }

    console.log('\n========== ALL 3 ROUNDS PASSED ✓ ==========');
  }, 900_000);
});
