// @ts-nocheck — Aztec SDK types require sandbox-specific resolution
/**
 * E2E Nullifier Sync Test — Reproduces the "Existing nullifier" bug
 *
 * Tests whether syncNoteNullifiers correctly detects nullified notes for:
 * 1. Notes created via get_cards_for_new_player (uses derive_note_randomness)
 * 2. Notes created via test_mint_winner_cards (uses create_and_push_note with explicit randomness)
 *
 * Flow:
 * - Create starter cards (get_cards_for_new_player) → import notes
 * - Nullify starter cards (test_nullify_cards) → verify nullifiers detected
 * - Create "winner" cards (test_mint_winner_cards) → import notes
 * - Nullify winner cards (test_nullify_cards) → verify nullifiers detected
 *
 * If the second nullify attempt fails with "Existing nullifier",
 * that confirms the syncNoteNullifiers bug.
 *
 * Run:
 *   cd packages/integration
 *   npx vitest run tests/e2e-nullifier-sync.test.ts
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

describe('E2E Nullifier Sync: starter vs winner cards', () => {
  let wallet: any;
  let node: any;
  let fee: any;
  let playerAddr: any;
  let nftContract: any;

  const sendAs = (addr: any) => ({
    from: addr,
    fee: { paymentMethod: fee },
    wait: { timeout: SEND_TIMEOUT },
  });

  /** Import notes from a TxEffect into the PXE via import_note. */
  async function importNotes(
    txHashStr: string,
    tokenIds: number[],
    randomnessValues: Fr[],
  ) {
    const { TxHash } = await import('@aztec/stdlib/tx');
    const txHash = TxHash.fromString(txHashStr);
    const txResult = await node.getTxEffect(txHash);
    expect(txResult?.data).toBeTruthy();
    const txEffect = txResult.data;

    const rawNoteHashes: any[] = txEffect.noteHashes ?? [];
    const nonZeroHashes = rawNoteHashes.filter((h: any) => BigInt(h) !== 0n);
    const firstNullifier = txEffect.nullifiers?.[0];

    console.log(`    TxEffect: ${nonZeroHashes.length} non-zero note hashes, block=${txResult.l2BlockNumber}`);
    for (let i = 0; i < nonZeroHashes.length; i++) {
      console.log(`    noteHash[${i}]: ${nonZeroHashes[i].toString()}`);
    }

    const paddedHashes = new Array(64).fill(new Fr(0n));
    for (let i = 0; i < rawNoteHashes.length && i < 64; i++) {
      paddedHashes[i] = rawNoteHashes[i];
    }

    for (let i = 0; i < tokenIds.length; i++) {
      console.log(`    Importing token_id=${tokenIds[i]} randomness=${randomnessValues[i].toString()}`);
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
    console.log(`    Imported ${tokenIds.length} notes`);
  }

  /** Get private cards from PXE. */
  async function getPrivateCards(): Promise<number[]> {
    const [page] = await nftContract.methods
      .get_private_cards(playerAddr, 0)
      .simulate({ from: playerAddr });
    return page
      .map((v: any) => Number(BigInt(v)))
      .filter((id: number) => id !== 0);
  }

  /** Get note nonce from PXE. */
  async function getNoteNonce(): Promise<bigint> {
    const result = await nftContract.methods
      .get_note_nonce(playerAddr)
      .simulate({ from: playerAddr });
    return BigInt(result.toString());
  }

  /** Get game randomness values via preview_game_data. */
  async function getGameRandomness(nonceValue: bigint): Promise<{ gameId: Fr; randomness: Fr[] }> {
    const result = await nftContract.methods
      .preview_game_data(new Fr(nonceValue))
      .simulate({ from: playerAddr });
    const gameId = toFr(result[0]);
    const randomness: Fr[] = [];
    for (let i = 1; i <= 6; i++) {
      randomness.push(toFr(result[i]));
    }
    return { gameId, randomness };
  }

  /** Get note randomness values via compute_note_randomness. */
  async function getNoteRandomness(nonceValue: bigint, count: number): Promise<Fr[]> {
    const result = await nftContract.methods
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

    // SponsoredFPC
    const fpcInstance = await getContractInstanceFromInstantiationParams(
      SponsoredFPCContractArtifact, { salt: new Fr(SPONSORED_FPC_SALT) },
    );
    await wallet.registerContract(fpcInstance, SponsoredFPCContractArtifact);
    fee = new SponsoredFeePaymentMethod(fpcInstance.address);

    // Deploy player account
    console.log('Deploying player account...');
    const playerAccount = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await (await playerAccount.getDeployMethod()).send({
      from: AztecAddress.ZERO,
      fee: { paymentMethod: fee },
      skipClassPublication: true,
      skipInstancePublication: true,
      wait: { timeout: SEND_TIMEOUT },
    });
    playerAddr = playerAccount.address;
    await wallet.registerSender(playerAddr, 'player');
    console.log(`  Player: ${playerAddr}`);

    // Deploy NFT contract
    const nftArtifact = loadContractArtifact('triple_triad_nft-TripleTriadNFT');
    console.log('Deploying TripleTriadNFT...');
    nftContract = await Contract.deploy(wallet, nftArtifact, [
      playerAddr,
      encodeCompressedString('Test'),
      encodeCompressedString('T'),
    ]).send(sendAs(playerAddr));
    console.log(`  NFT at: ${nftContract.address}`);
    await wallet.registerSender(nftContract.address, 'nft');
  }, 300_000);

  it('should detect nullifiers for both starter and winner-minted cards', async () => {
    // ================================================================
    // STEP 0: Initialize note nonce
    // ================================================================
    console.log('\n=== STEP 0: Initialize note nonce ===');
    const initNonceReceipt = await nftContract.methods
      .test_init_nonce(new Fr(0n))
      .send(sendAs(playerAddr));
    console.log(`  init_nonce tx: ${initNonceReceipt.txHash?.toString()}`);

    // ================================================================
    // STEP 1: Create starter cards via get_cards_for_new_player_test
    // ================================================================
    console.log('\n=== STEP 1: get_cards_for_new_player_test(0) ===');
    const starterReceipt = await nftContract.methods
      .get_cards_for_new_player_test(new Fr(0n))
      .send(sendAs(playerAddr));
    const starterTxHash = starterReceipt.txHash?.toString();
    console.log(`  Starter tx mined: ${starterTxHash}`);

    await new Promise(r => setTimeout(r, 2000));

    // Import the 5 starter card notes (nonce_value=0, indices 0..4)
    const starterRandomness = await getNoteRandomness(0n, 5);
    console.log('  Starter card randomness values:');
    for (let i = 0; i < 5; i++) {
      console.log(`    [${i}]: ${starterRandomness[i].toString()}`);
    }
    await importNotes(starterTxHash, [1, 2, 3, 4, 5], starterRandomness);

    // Verify cards are visible
    let cards = await getPrivateCards();
    console.log(`  Cards after starter import: [${cards}]`);
    expect(cards.length).toBeGreaterThanOrEqual(5);

    // Check nonce
    let nonce = await getNoteNonce();
    console.log(`  Note nonce after starter: ${nonce}`);
    expect(nonce).toBe(5n);

    // ================================================================
    // STEP 2: Nullify starter cards via test_nullify_cards
    // ================================================================
    console.log('\n=== STEP 2: Nullify starter cards ===');
    const nullify1Receipt = await nftContract.methods
      .test_nullify_cards(playerAddr, [1, 2, 3, 4, 5].map(n => new Fr(BigInt(n))))
      .send(sendAs(playerAddr));
    const nullify1TxHash = nullify1Receipt.txHash?.toString();
    console.log(`  Nullify-1 tx mined: ${nullify1TxHash}`);

    // Log the TxEffect nullifiers for comparison
    const { TxHash } = await import('@aztec/stdlib/tx');
    const txHash1 = TxHash.fromString(nullify1TxHash);
    const txEffect1 = await node.getTxEffect(txHash1);
    const nullifiers1 = txEffect1.data.nullifiers.filter((n: any) => BigInt(n) !== 0n);
    console.log(`  Nullify-1 TxEffect: ${nullifiers1.length} nullifiers, block=${txEffect1.l2BlockNumber}`);
    for (let i = 0; i < nullifiers1.length; i++) {
      console.log(`    nullifier[${i}]: ${nullifiers1[i].toString()}`);
    }

    // Wait for PXE to sync and detect the nullifiers
    await new Promise(r => setTimeout(r, 3000));

    // Verify cards are gone
    cards = await getPrivateCards();
    console.log(`  Cards after nullify-1: [${cards}]`);
    // Some cards might remain if tag-path discovered duplicates exist

    // ================================================================
    // STEP 3: Create "winner" cards via test_mint_winner_cards
    //         This mimics what mint_for_game_winner does with
    //         create_and_push_note + explicit randomness
    // ================================================================
    console.log('\n=== STEP 3: test_mint_winner_cards ===');

    // Get current nonce for game randomness derivation
    // After get_cards_for_new_player, nonce=5. After nullify (which doesn't change nonce), still 5.
    nonce = await getNoteNonce();
    console.log(`  Note nonce before winner mint: ${nonce}`);

    // Get game randomness (derives from nonce=5 via derive_game_randomness)
    const { gameId, randomness: gameRandomness } = await getGameRandomness(nonce);
    console.log(`  Game ID: ${gameId.toString()}`);
    console.log('  Game randomness values:');
    for (let i = 0; i < 6; i++) {
      console.log(`    [${i}]: ${gameRandomness[i].toString()}`);
    }

    // Mint 6 winner cards (5 returned + 1 won) with game randomness
    const winnerTokenIds = [1, 2, 3, 4, 5, 6].map(n => new Fr(BigInt(n)));
    const winnerReceipt = await nftContract.methods
      .test_mint_winner_cards(winnerTokenIds, playerAddr, gameRandomness)
      .send(sendAs(playerAddr));
    const winnerTxHash = winnerReceipt.txHash?.toString();
    console.log(`  Winner mint tx mined: ${winnerTxHash}`);

    await new Promise(r => setTimeout(r, 2000));

    // Import the 6 winner card notes
    await importNotes(
      winnerTxHash,
      [1, 2, 3, 4, 5, 6],
      gameRandomness,
    );

    // Verify cards are visible
    cards = await getPrivateCards();
    console.log(`  Cards after winner import: [${cards}]`);
    expect(cards.length).toBeGreaterThanOrEqual(5);

    // ================================================================
    // STEP 4: Nullify 5 of the winner cards via test_nullify_cards
    //         If syncNoteNullifiers has the bug, this step will fail
    //         because the PXE still sees the old starter card notes
    //         as active (their nullifiers weren't detected).
    // ================================================================
    console.log('\n=== STEP 4: Nullify winner cards ===');
    console.log('  This is the step that triggers "Existing nullifier" in the bug scenario.');
    console.log('  If the PXE still has stale starter cards, pop_notes may return them');
    console.log('  instead of the new winner cards, causing a duplicate nullifier.');

    try {
      const nullify2Receipt = await nftContract.methods
        .test_nullify_cards(playerAddr, [1, 2, 3, 4, 5].map(n => new Fr(BigInt(n))))
        .send(sendAs(playerAddr));
      const nullify2TxHash = nullify2Receipt.txHash?.toString();
      console.log(`  Nullify-2 tx mined: ${nullify2TxHash}`);

      // Log TxEffect nullifiers
      const txHash2 = TxHash.fromString(nullify2TxHash);
      const txEffect2 = await node.getTxEffect(txHash2);
      const nullifiers2 = txEffect2.data.nullifiers.filter((n: any) => BigInt(n) !== 0n);
      console.log(`  Nullify-2 TxEffect: ${nullifiers2.length} nullifiers, block=${txEffect2.l2BlockNumber}`);
      for (let i = 0; i < nullifiers2.length; i++) {
        console.log(`    nullifier[${i}]: ${nullifiers2[i].toString()}`);
      }

      // Cross-reference: check for overlap with nullify-1 nullifiers
      const set1 = new Set(nullifiers1.map((n: any) => n.toString()));
      const overlapping = nullifiers2.filter((n: any) => set1.has(n.toString()));
      if (overlapping.length > 0) {
        console.log(`  WARNING: ${overlapping.length} nullifiers overlap between nullify-1 and nullify-2!`);
        for (const n of overlapping) {
          console.log(`    OVERLAP: ${n.toString()}`);
        }
      } else {
        console.log('  No nullifier overlap between nullify-1 and nullify-2 ✓');
      }

      console.log('\n  PASS: Second nullification succeeded — syncNoteNullifiers correctly detected starter card nullifiers ✓');

      // Verify only 1 card remains (we minted 6, nullified 5)
      await new Promise(r => setTimeout(r, 3000));
      const finalCards = await getPrivateCards();
      console.log(`  Cards remaining after nullify-2: [${finalCards}]`);
      expect(finalCards.length).toBe(1);
      console.log('  Correct: 1 card remaining (minted 6, nullified 5) ✓');
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.log(`\n  FAIL: Second nullification failed: ${msg}`);

      if (msg.includes('Existing nullifier')) {
        console.log('\n  *** BUG CONFIRMED: syncNoteNullifiers did NOT detect the starter card nullifiers ***');
        console.log('  The PXE returned stale (already-consumed) notes from the first nullification.');
        console.log('  The contract tried to emit their nullifiers again, hitting "Existing nullifier".');
      } else if (msg.includes('Could not find all 5 cards')) {
        console.log('\n  *** DIFFERENT BUG: pop_notes could not find 5 matching cards ***');
        console.log('  This might mean the winner card import failed or notes are at wrong slots.');
      }

      // Re-throw so the test fails visibly
      throw err;
    }
  }, 600_000);
});
