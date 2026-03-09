// @ts-nocheck — Aztec SDK types require sandbox-specific resolution
/**
 * E2E Diagnostic: 3-Round Test with REAL get_cards_for_new_player (cooldown partial notes)
 *
 * Purpose: Reproduce the "Existing nullifier" bug and diagnose whether it's caused by:
 *   A) PXE sync timing (cooldown notes slow down sync_state)
 *   B) Stale notes in the oracle (syncNoteNullifiers misses old card nullifiers)
 *   C) Duplicate note entries (import_note + sync_state both discover same notes)
 *
 * Key diagnostics:
 *   - Logs active card count before every operation
 *   - Adds explicit sync waits (configurable) between rounds
 *   - Compares behavior with/without extended sync waits
 *   - Logs all nullifiers from TxEffect for cross-round comparison
 *
 * Run:
 *   cd packages/integration
 *   npx vitest run tests/e2e-real-3round-diagnostic.test.ts
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

// Extended sync wait (ms) — increase to test sync timing hypothesis
const SYNC_WAIT_MS = parseInt(process.env.SYNC_WAIT_MS || '5000', 10);

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

describe('E2E Real 3-Round Diagnostic (with cooldown partial notes)', () => {
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

  /** Import card notes from a TxEffect into the PXE. */
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

    const rawNullifiers: any[] = txEffect.nullifiers ?? [];
    const nonZeroNullifiers = rawNullifiers.filter((n: any) => BigInt(n) !== 0n);

    console.log(`  [${label}] TxEffect: ${nonZeroHashes.length} note hashes, ${nonZeroNullifiers.length} nullifiers, block=${txResult.l2BlockNumber}`);
    for (let i = 0; i < nonZeroHashes.length; i++) {
      console.log(`    noteHash[${i}]: ${nonZeroHashes[i].toString()}`);
    }
    for (let i = 0; i < nonZeroNullifiers.length; i++) {
      console.log(`    nullifier[${i}]: ${nonZeroNullifiers[i].toString()}`);
    }

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
    console.log(`  [${label}] Imported ${tokenIds.length} card notes`);
  }

  /** Get visible private cards for the player. */
  async function getPrivateCards(): Promise<number[]> {
    const [page] = await nftContract.methods
      .get_private_cards(playerAddr, 0)
      .simulate({ from: playerAddr });
    return page
      .map((v: any) => Number(BigInt(v)))
      .filter((id: number) => id !== 0);
  }

  /** Get note randomness. */
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

  /** Get current note nonce. */
  async function getNoteNonce(): Promise<bigint> {
    const result = await nftContract.methods
      .get_note_nonce(playerAddr)
      .simulate({ from: playerAddr });
    return BigInt(result.toString());
  }

  /** Get game randomness via preview_game_data. */
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

  /** Wait for PXE sync and log card state. */
  async function syncAndLog(label: string, waitMs: number = SYNC_WAIT_MS) {
    console.log(`  [${label}] Waiting ${waitMs}ms for PXE sync...`);
    await new Promise(r => setTimeout(r, waitMs));
    const cards = await getPrivateCards();
    console.log(`  [${label}] Active cards after sync: [${cards}] (count=${cards.length})`);
    return cards;
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

    // Deploy NFT contract
    const nftArtifact = loadContractArtifact('triple_triad_nft-TripleTriadNFT');
    console.log('Deploying TripleTriadNFT...');
    nftContract = await Contract.deploy(wallet, nftArtifact, [
      playerAddr,
      encodeCompressedString('Diag'),
      encodeCompressedString('D'),
    ]).send(sendOpts());
    console.log(`  NFT at: ${nftContract.address}`);
    await wallet.registerSender(nftContract.address, 'nft');
  }, 300_000);

  // Skip import_note for round 2 — let PXE discover via notify_created_note only
  const SKIP_IMPORT_R2 = process.env.SKIP_IMPORT_R2 === '1';

  it('should diagnose 3-round behavior with REAL get_cards_for_new_player', async () => {
    const { TxHash } = await import('@aztec/stdlib/tx');
    const allNullifierSets: string[][] = [];
    console.log(`  SKIP_IMPORT_R2 = ${SKIP_IMPORT_R2}`);

    // ================================================================
    // ROUND 1: get_cards_for_new_player (REAL — with cooldown partial notes)
    // ================================================================
    console.log(`\n${'='.repeat(60)}`);
    console.log('ROUND 1: REAL get_cards_for_new_player (with cooldowns)');
    console.log(`${'='.repeat(60)}`);
    console.log(`  SYNC_WAIT_MS = ${SYNC_WAIT_MS}`);

    // Check initial card state
    const initialCards = await getPrivateCards();
    console.log(`  Initial cards: [${initialCards}] (count=${initialCards.length})`);

    // Call REAL get_cards_for_new_player
    console.log('\n--- Calling get_cards_for_new_player() (REAL) ---');
    const starterReceipt = await nftContract.methods
      .get_cards_for_new_player()
      .send(sendOpts());
    const starterTxHash = starterReceipt.txHash?.toString();
    console.log(`  Starter tx: ${starterTxHash}`);

    // Import card notes
    const starterRandomness = await getNoteRandomness(0n, 5);
    console.log('  Starter randomness:');
    for (let i = 0; i < 5; i++) {
      console.log(`    [${i}]: ${starterRandomness[i].toString()}`);
    }
    await importNotes(starterTxHash, [1, 2, 3, 4, 5], starterRandomness, 'R1-import');

    // Sync and check
    const r1CardsAfterImport = await syncAndLog('R1-post-import');
    expect(r1CardsAfterImport.length).toBeGreaterThanOrEqual(5);

    // Nullify round 1 cards
    console.log('\n--- Nullifying round 1 cards ---');
    const nullify1Receipt = await nftContract.methods
      .test_nullify_cards(playerAddr, [1, 2, 3, 4, 5].map(n => new Fr(BigInt(n))))
      .send(sendOpts());
    const nullify1TxHash = nullify1Receipt.txHash?.toString();
    console.log(`  Nullify-1 tx: ${nullify1TxHash}`);

    // Log nullifiers
    const nullify1Effect = await node.getTxEffect(TxHash.fromString(nullify1TxHash));
    const nullifiers1 = nullify1Effect.data.nullifiers
      .filter((n: any) => BigInt(n) !== 0n)
      .map((n: any) => n.toString());
    console.log(`  Nullify-1: ${nullifiers1.length} nullifiers, block=${nullify1Effect.l2BlockNumber}`);
    for (let i = 0; i < nullifiers1.length; i++) {
      console.log(`    nullifier[${i}]: ${nullifiers1[i]}`);
    }
    allNullifierSets.push(nullifiers1);

    // Extended sync wait
    const r1CardsAfterNullify = await syncAndLog('R1-post-nullify');
    console.log(`  Round 1 complete. Cards remaining: ${r1CardsAfterNullify.length}`);

    // ================================================================
    // ROUND 2: Mint winner cards, nullify again
    // ================================================================
    console.log(`\n${'='.repeat(60)}`);
    console.log('ROUND 2: Mint winner cards + nullify');
    console.log(`${'='.repeat(60)}`);

    const nonce1 = await getNoteNonce();
    console.log(`  Nonce before mint: ${nonce1}`);
    const { randomness: gameRand1 } = await getGameRandomness(nonce1);

    console.log('\n--- Minting round 2 cards ---');
    const mint1Receipt = await nftContract.methods
      .test_mint_winner_cards(
        [1, 2, 3, 4, 5, 6].map(n => new Fr(BigInt(n))),
        playerAddr,
        gameRand1,
      )
      .send(sendOpts());
    const mint1TxHash = mint1Receipt.txHash?.toString();
    console.log(`  Mint-1 tx: ${mint1TxHash}`);

    if (SKIP_IMPORT_R2) {
      console.log('  SKIPPING import_note for R2 — relying on notify_created_note + PXE sync');
      // Wait longer for PXE to discover notes via notify_created_note block sync
      await new Promise(r => setTimeout(r, SYNC_WAIT_MS * 2));
    } else {
      await importNotes(mint1TxHash, [1, 2, 3, 4, 5, 6], gameRand1, 'R2-import');
    }
    const r2CardsAfterImport = await syncAndLog('R2-post-import');
    console.log(`  R2 cards after import: ${r2CardsAfterImport.length} (expect >= 5)`);
    expect(r2CardsAfterImport.length).toBeGreaterThanOrEqual(5);

    // Nullify round 2 cards
    console.log('\n--- Nullifying round 2 cards ---');
    try {
      const nullify2Receipt = await nftContract.methods
        .test_nullify_cards(playerAddr, [1, 2, 3, 4, 5].map(n => new Fr(BigInt(n))))
        .send(sendOpts());
      const nullify2TxHash = nullify2Receipt.txHash?.toString();
      console.log(`  Nullify-2 tx: ${nullify2TxHash}`);

      const nullify2Effect = await node.getTxEffect(TxHash.fromString(nullify2TxHash));
      const nullifiers2 = nullify2Effect.data.nullifiers
        .filter((n: any) => BigInt(n) !== 0n)
        .map((n: any) => n.toString());
      console.log(`  Nullify-2: ${nullifiers2.length} nullifiers, block=${nullify2Effect.l2BlockNumber}`);
      for (let i = 0; i < nullifiers2.length; i++) {
        console.log(`    nullifier[${i}]: ${nullifiers2[i]}`);
      }
      allNullifierSets.push(nullifiers2);

      // Cross-round nullifier collision check
      const set1 = new Set(allNullifierSets[0]);
      const overlap12 = nullifiers2.filter((n: string) => set1.has(n));
      if (overlap12.length > 0) {
        console.log(`  *** COLLISION: ${overlap12.length} nullifiers overlap between rounds 1 and 2! ***`);
        for (const n of overlap12) console.log(`    OVERLAP: ${n}`);
      } else {
        console.log('  No nullifier collision between rounds 1 and 2');
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.log(`\n  *** ROUND 2 NULLIFY FAILED: ${msg} ***`);
      if (msg.includes('Existing nullifier')) {
        console.log('  BUG REPRODUCED AT ROUND 2');
      }
      throw err;
    }

    const r2CardsAfterNullify = await syncAndLog('R2-post-nullify');
    console.log(`  Round 2 complete. Cards remaining: ${r2CardsAfterNullify.length}`);

    // ================================================================
    // ROUND 3: Mint winner cards again, nullify (THE FAILURE POINT)
    // ================================================================
    console.log(`\n${'='.repeat(60)}`);
    console.log('ROUND 3: Mint winner cards + nullify (THE CRITICAL ROUND)');
    console.log(`${'='.repeat(60)}`);

    const nonce2 = await getNoteNonce();
    console.log(`  Nonce before mint: ${nonce2}`);
    const { randomness: gameRand2 } = await getGameRandomness(nonce2);

    console.log('\n--- Minting round 3 cards ---');
    const mint2Receipt = await nftContract.methods
      .test_mint_winner_cards(
        [1, 2, 3, 4, 5, 6].map(n => new Fr(BigInt(n))),
        playerAddr,
        gameRand2,
      )
      .send(sendOpts());
    const mint2TxHash = mint2Receipt.txHash?.toString();
    console.log(`  Mint-2 tx: ${mint2TxHash}`);

    if (SKIP_IMPORT_R2) {
      console.log('  SKIPPING import_note for R3 — relying on notify_created_note + PXE sync');
      await new Promise(r => setTimeout(r, SYNC_WAIT_MS * 2));
    } else {
      await importNotes(mint2TxHash, [1, 2, 3, 4, 5, 6], gameRand2, 'R3-import');
    }
    const r3CardsAfterImport = await syncAndLog('R3-post-import');
    console.log(`  R3 cards after import: ${r3CardsAfterImport.length} (expect >= 5)`);
    expect(r3CardsAfterImport.length).toBeGreaterThanOrEqual(5);

    // DIAGNOSTIC: Check if we have stale cards from previous rounds
    // If cards count is > 6 (we minted 6), there might be duplicates from old rounds
    if (r3CardsAfterImport.length > 6) {
      console.log(`  *** WARNING: ${r3CardsAfterImport.length} cards visible — possible stale notes from prior rounds ***`);
      // Count duplicates
      const counts = new Map<number, number>();
      for (const id of r3CardsAfterImport) {
        counts.set(id, (counts.get(id) || 0) + 1);
      }
      for (const [id, count] of counts) {
        if (count > 1) {
          console.log(`    Card ${id} appears ${count} times — STALE NOTE DETECTED`);
        }
      }
    }

    // Nullify round 3 cards — THIS IS THE FAILURE POINT
    console.log('\n--- Nullifying round 3 cards (THE CRITICAL TEST) ---');
    try {
      const nullify3Receipt = await nftContract.methods
        .test_nullify_cards(playerAddr, [1, 2, 3, 4, 5].map(n => new Fr(BigInt(n))))
        .send(sendOpts());
      const nullify3TxHash = nullify3Receipt.txHash?.toString();
      console.log(`  Nullify-3 tx: ${nullify3TxHash}`);

      const nullify3Effect = await node.getTxEffect(TxHash.fromString(nullify3TxHash));
      const nullifiers3 = nullify3Effect.data.nullifiers
        .filter((n: any) => BigInt(n) !== 0n)
        .map((n: any) => n.toString());
      console.log(`  Nullify-3: ${nullifiers3.length} nullifiers, block=${nullify3Effect.l2BlockNumber}`);
      for (let i = 0; i < nullifiers3.length; i++) {
        console.log(`    nullifier[${i}]: ${nullifiers3[i]}`);
      }
      allNullifierSets.push(nullifiers3);

      // Cross-round collision check
      const allPrev = new Set([...allNullifierSets[0], ...allNullifierSets[1]]);
      const overlap3 = nullifiers3.filter((n: string) => allPrev.has(n));
      if (overlap3.length > 0) {
        console.log(`  *** COLLISION: ${overlap3.length} nullifiers overlap with rounds 1-2! ***`);
        for (const n of overlap3) console.log(`    OVERLAP: ${n}`);
      } else {
        console.log('  No nullifier collision between round 3 and rounds 1-2');
      }

      console.log('\n  ROUND 3 PASSED');
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.log(`\n  *** ROUND 3 NULLIFY FAILED: ${msg} ***`);
      if (msg.includes('Existing nullifier')) {
        console.log('  BUG REPRODUCED: "Existing nullifier" on round 3');
        console.log('  This confirms cooldown partial notes cause stale note syndrome.');
        console.log('');
        console.log('  Diagnostic summary:');
        console.log(`    SYNC_WAIT_MS = ${SYNC_WAIT_MS}`);
        console.log(`    Cards visible before nullify: ${r3CardsAfterImport.length}`);
        console.log(`    Round 1 nullifier count: ${allNullifierSets[0]?.length ?? '?'}`);
        console.log(`    Round 2 nullifier count: ${allNullifierSets[1]?.length ?? '?'}`);
        console.log('');
        console.log('  If increasing SYNC_WAIT_MS fixes this, the issue is sync timing.');
        console.log('  If it fails regardless of wait time, the issue is in note store state.');
      }
      throw err;
    }

    const r3CardsAfterNullify = await syncAndLog('R3-post-nullify');
    console.log(`\n${'='.repeat(60)}`);
    console.log('ALL 3 ROUNDS PASSED');
    console.log(`  Final cards remaining: ${r3CardsAfterNullify.length}`);
    console.log(`${'='.repeat(60)}`);
  }, 900_000);
});
