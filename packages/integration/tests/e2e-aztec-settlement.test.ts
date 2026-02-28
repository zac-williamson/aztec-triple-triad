// @ts-nocheck — Aztec SDK types require sandbox-specific resolution
/**
 * E2E Aztec Settlement Test — Full Game with process_game
 *
 * Validates that two players can:
 * 1. Deploy NFT + Game contracts
 * 2. Mint cards and commit them to a game
 * 3. Derive blinding factors that match on-chain card commits
 * 4. Generate all 11 ZK proofs (2 hand + 9 move)
 * 5. Successfully settle on-chain via process_game
 *
 * Prerequisites:
 *   - Aztec sandbox running: aztec start --local-network
 *   - Contracts compiled: aztec compile (from packages/contracts)
 *   - Circuits compiled: cd circuits/prove_hand && nargo compile && cd ../game_move && nargo compile
 *
 * Run:
 *   cd packages/integration
 *   npx vitest run tests/e2e-aztec-settlement.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Aztec SDK
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

// bb.js
import { Barretenberg } from '@aztec/bb.js';

// Game logic
import { CARD_DATABASE } from '@aztec-triple-triad/game-logic';

// Shared helpers
import {
  computeVkHash,
  computeCardCommit,
  packRanks,
  generateFullGameProofs,
  loadContractArtifact,
  loadCircuitArtifact,
} from './e2e-helpers.js';

// ============================================================================
// Configuration
// ============================================================================

const PXE_URL = process.env.AZTEC_PXE_URL || 'http://localhost:8080';
const SEND_TIMEOUT = 300; // seconds

// ============================================================================
// SponsoredFPC setup (same pattern as aztec-chess-app)
// ============================================================================

async function getSponsoredFPCContract() {
  const instance = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  return instance;
}

describe('E2E Aztec Settlement', () => {
  // Aztec state
  let wallet: any;
  let fee: any;
  let deployerAddr: any;
  let p1Addr: any;
  let p2Addr: any;
  let nftContract: any;
  let gameContract: any;

  // Barretenberg + circuit artifacts
  let api: Barretenberg;
  let proveHandArtifact: any;
  let gameMoveArtifact: any;
  let realHandVkFields: any[];
  let realMoveVkFields: any[];

  // Helper: send options for a given address
  const sendAs = (addr: any) => ({
    from: addr,
    fee: { paymentMethod: fee },
    wait: { timeout: SEND_TIMEOUT },
  });

  // Helper: string-to-Fr conversion
  const toFr = (s: string): any => {
    if (s.startsWith('0x') || s.startsWith('0X')) {
      return Fr.fromHexString(s);
    }
    return new Fr(BigInt(s));
  };

  const p1CardIds = [1, 2, 3, 4, 5];
  const p2CardIds = [6, 7, 8, 9, 10];

  beforeAll(async () => {
    // --- Connect to Aztec node ---
    console.log(`Connecting to Aztec node at ${PXE_URL}...`);
    const node = createAztecNodeClient(PXE_URL);

    // --- Wait for node to have blocks ---
    console.log('Waiting for Aztec node to have blocks...');
    for (let i = 0; i < 120; i++) {
      try {
        const blockNum = await node.getBlockNumber();
        if (blockNum > 0) {
          const header = await node.getBlockHeader();
          console.log(`  Node at block ${blockNum}, timestamp=${header?.globalVariables?.timestamp ?? 'unknown'}`);
          break;
        }
      } catch { /* node not ready yet */ }
      if (i === 119) throw new Error('Node never produced blocks');
      await new Promise(r => setTimeout(r, 1000));
    }

    // --- Create wallet ---
    console.log('Creating EmbeddedWallet...');
    wallet = await EmbeddedWallet.create(node, { ephemeral: true });

    // --- Wait for PXE to sync ---
    // The embedded PXE syncs in the background; wait for it to catch up
    // so the anchor block header has a valid timestamp for tx expiration
    console.log('Waiting for embedded PXE to sync...');
    await new Promise(r => setTimeout(r, 5000));

    // --- Register SponsoredFPC for fee payments ---
    console.log('Registering SponsoredFPC contract...');
    const sponsoredFPCContract = await getSponsoredFPCContract();
    await wallet.registerContract(sponsoredFPCContract, SponsoredFPCContractArtifact);
    fee = new SponsoredFeePaymentMethod(sponsoredFPCContract.address);
    console.log(`  SponsoredFPC at: ${sponsoredFPCContract.address}`);

    // --- Helper to deploy an account with retry (PXE sync race) ---
    async function deployAccount(account: any, label: string) {
      const deployMethod = await account.getDeployMethod();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await deployMethod.send({
            from: AztecAddress.ZERO,
            fee: { paymentMethod: fee },
            skipClassPublication: true,
            skipInstancePublication: true,
            wait: { timeout: SEND_TIMEOUT },
          });
          return;
        } catch (err: any) {
          const msg = err?.message || '';
          if (msg.includes('expiration timestamp') && attempt < 2) {
            console.log(`  ${label} deploy failed with expiration timestamp error, retrying in 5s...`);
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }
          throw err;
        }
      }
    }

    // --- Create & deploy accounts ---
    console.log('Creating deployer account...');
    const deployerAccount = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await deployAccount(deployerAccount, 'Deployer');
    deployerAddr = deployerAccount.address;
    await wallet.registerSender(deployerAddr, 'deployer');
    console.log(`  Deployer: ${deployerAddr}`);

    console.log('Creating player 1 account...');
    const player1Account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await deployAccount(player1Account, 'Player1');
    p1Addr = player1Account.address;
    await wallet.registerSender(p1Addr, 'player1');
    console.log(`  Player 1: ${p1Addr}`);

    console.log('Creating player 2 account...');
    const player2Account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await deployAccount(player2Account, 'Player2');
    p2Addr = player2Account.address;
    await wallet.registerSender(p2Addr, 'player2');
    console.log(`  Player 2: ${p2Addr}`);

    // --- Init Barretenberg & compute VK hashes ---
    console.log('Initializing Barretenberg...');
    api = await Barretenberg.new({ threads: 1 });
    proveHandArtifact = loadCircuitArtifact('prove_hand');
    gameMoveArtifact = loadCircuitArtifact('game_move');

    console.log('Computing VK hashes...');
    const handVk = await computeVkHash(api, proveHandArtifact.bytecode);
    const moveVk = await computeVkHash(api, gameMoveArtifact.bytecode);
    console.log(`  hand_vk_hash: ${handVk.hash}`);
    console.log(`  move_vk_hash: ${moveVk.hash}`);

    realHandVkFields = handVk.fields.map((f: string) => Fr.fromHexString(f));
    realMoveVkFields = moveVk.fields.map((f: string) => Fr.fromHexString(f));

    // --- Deploy contracts ---
    const nftArtifact = loadContractArtifact('triple_triad_nft-TripleTriadNFT');
    const gameArtifact = loadContractArtifact('triple_triad_game-TripleTriadGame');

    console.log('Deploying TripleTriadNFT...');
    // FieldCompressedString: pack ASCII bytes into a field element (big-endian, up to 31 bytes)
    function encodeCompressedString(s: string): Fr {
      let hex = '';
      for (let i = 0; i < s.length && i < 31; i++) {
        hex += s.charCodeAt(i).toString(16).padStart(2, '0');
      }
      return new Fr(BigInt('0x' + hex));
    }
    const nameField = encodeCompressedString('TestCards');
    const symbolField = encodeCompressedString('TC');
    nftContract = await Contract.deploy(wallet, nftArtifact, [
      deployerAddr,
      nameField,
      symbolField,
    ]).send(sendAs(deployerAddr));
    console.log(`  NFT deployed at: ${nftContract.address}`);

    // Register NFT contract as a sender so PXE scans its private logs
    // (notes from mint_to_private are tagged with the NFT contract address)
    await wallet.registerSender(nftContract.address, 'nft-contract');

    console.log('Deploying TripleTriadGame...');
    gameContract = await Contract.deploy(wallet, gameArtifact, [
      nftContract.address,
      Fr.fromHexString(handVk.hash),
      Fr.fromHexString(moveVk.hash),
    ]).send(sendAs(deployerAddr));
    console.log(`  Game deployed at: ${gameContract.address}`);

    // Register game contract as a sender for note discovery
    await wallet.registerSender(gameContract.address, 'game-contract');

    // --- Register game contract on NFT ---
    console.log('Registering game contract on NFT...');
    await nftContract.methods
      .set_game_contract(gameContract.address)
      .send(sendAs(deployerAddr));

    // --- Mint cards to players (private) ---
    // Use get_cards_for_new_player for player 1 (self-mint of starter cards 1-5)
    // This avoids cross-account note delivery issues with deployer → player tagging
    console.log('Minting cards to players...');
    console.log('  Player 1: calling get_cards_for_new_player (self-mint)...');
    await nftContract.methods
      .get_cards_for_new_player()
      .send(sendAs(p1Addr));
    console.log('  Player 1: starter cards minted');

    // For player 2, use mint_to_private with deployer (cards 6-10)
    for (const id of p2CardIds) {
      const card = CARD_DATABASE.find((c: any) => c.id === id)!;
      const packed = packRanks(card.ranks.top, card.ranks.right, card.ranks.bottom, card.ranks.left);
      await nftContract.methods
        .mint_to_private(p2Addr, new Fr(BigInt(id)), new Fr(BigInt(packed)))
        .send(sendAs(deployerAddr));
    }
    console.log('  Minted cards 6-10 to Player 2');

    // --- Wait for PXE to discover minted notes ---
    // After minting, the PXE must sync blocks and run sync_state() for the NFT contract.
    // Use get_private_cards (utility function using view_notes) to check note visibility.
    // This is the correct check — compute_blinding_factor doesn't access notes at all.
    console.log('Waiting for PXE to discover minted notes...');
    let p1NotesFound = false;
    let p2NotesFound = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        if (!p1NotesFound) {
          const [p1Cards] = await nftContract.methods
            .get_private_cards(p1Addr, 0)
            .simulate({ from: p1Addr });
          const p1Count = p1Cards.filter((v: any) => BigInt(v) !== 0n).length;
          if (p1Count >= 5) {
            console.log(`  Player 1: found ${p1Count} notes (attempt ${attempt + 1})`);
            p1NotesFound = true;
          } else {
            console.log(`  Player 1: found ${p1Count}/5 notes (attempt ${attempt + 1}), waiting...`);
          }
        }
        if (!p2NotesFound) {
          const [p2Cards] = await nftContract.methods
            .get_private_cards(p2Addr, 0)
            .simulate({ from: p2Addr });
          const p2Count = p2Cards.filter((v: any) => BigInt(v) !== 0n).length;
          if (p2Count >= 5) {
            console.log(`  Player 2: found ${p2Count} notes (attempt ${attempt + 1})`);
            p2NotesFound = true;
          } else {
            console.log(`  Player 2: found ${p2Count}/5 notes (attempt ${attempt + 1}), waiting...`);
          }
        }
        if (p1NotesFound && p2NotesFound) {
          console.log('  All notes discovered!');
          break;
        }
      } catch (err: any) {
        console.log(`  Note check attempt ${attempt + 1} error: ${err?.message?.slice(0, 100)}`);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    if (!p1NotesFound || !p2NotesFound) {
      throw new Error(`Note discovery timed out: P1=${p1NotesFound}, P2=${p2NotesFound}`);
    }
  }, 600_000);

  afterAll(async () => {
    if (api) {
      try { await api.destroy(); } catch { /* ignore */ }
    }
  });

  it('two players play a full game and settle on-chain via process_game', async () => {
    // ================================================================
    // 1. Create game (Player 1 commits cards 1-5)
    // ================================================================
    console.log('Player 1 creating game...');
    await gameContract.methods
      .create_game(p1CardIds.map((id: number) => new Fr(BigInt(id))))
      .send(sendAs(p1Addr));

    const gameId = new Fr(0n); // First game created

    let status = await gameContract.methods
      .get_game_status(gameId)
      .simulate({ from: deployerAddr });
    expect(BigInt(status)).toBe(1n);
    console.log('  Game created (status=1)');

    // ================================================================
    // 2. Join game (Player 2 commits cards 6-10)
    // ================================================================
    console.log('Player 2 joining game...');
    await gameContract.methods
      .join_game(gameId, p2CardIds.map((id: number) => new Fr(BigInt(id))))
      .send(sendAs(p2Addr));

    status = await gameContract.methods
      .get_game_status(gameId)
      .simulate({ from: deployerAddr });
    expect(BigInt(status)).toBe(2n);
    console.log('  Game active (status=2)');

    // ================================================================
    // 3. Read on-chain card commits
    // ================================================================
    const onChainCC1 = await gameContract.methods
      .get_game_card_commit_1(gameId)
      .simulate({ from: deployerAddr });
    const onChainCC2 = await gameContract.methods
      .get_game_card_commit_2(gameId)
      .simulate({ from: deployerAddr });
    console.log(`  On-chain card_commit_1: ${onChainCC1}`);
    console.log(`  On-chain card_commit_2: ${onChainCC2}`);
    expect(BigInt(onChainCC1)).not.toBe(0n);
    expect(BigInt(onChainCC2)).not.toBe(0n);

    // ================================================================
    // 4. Derive blinding factors via NFT contract simulate
    // ================================================================
    console.log('Deriving blinding factors via compute_blinding_factor...');
    const p1Blinding = await nftContract.methods
      .compute_blinding_factor()
      .simulate({ from: p1Addr });
    const p2Blinding = await nftContract.methods
      .compute_blinding_factor()
      .simulate({ from: p2Addr });
    console.log(`  P1 blinding factor: ${p1Blinding}`);
    console.log(`  P2 blinding factor: ${p2Blinding}`);

    // ================================================================
    // 5. Verify blinding factors match on-chain card commits
    // ================================================================
    console.log('Verifying card commitments match...');
    const computedCC1 = await computeCardCommit(api, p1CardIds, BigInt(p1Blinding));
    const computedCC2 = await computeCardCommit(api, p2CardIds, BigInt(p2Blinding));
    console.log(`  Computed card_commit_1: ${computedCC1}`);
    console.log(`  Computed card_commit_2: ${computedCC2}`);

    // Normalize both to BigInt for comparison (hex strings may differ in case/padding)
    expect(BigInt(computedCC1)).toBe(BigInt(onChainCC1));
    expect(BigInt(computedCC2)).toBe(BigInt(onChainCC2));
    console.log('  Card commitments match on-chain values!');

    // ================================================================
    // 6. Generate all 11 ZK proofs
    // ================================================================
    console.log('Generating ZK proofs (2 hand + 9 move)...');
    const proofStart = Date.now();

    const p1CommitStr = '0x' + BigInt(onChainCC1).toString(16).padStart(64, '0');
    const p2CommitStr = '0x' + BigInt(onChainCC2).toString(16).padStart(64, '0');
    const p1BlindingStr = '0x' + BigInt(p1Blinding).toString(16).padStart(64, '0');
    const p2BlindingStr = '0x' + BigInt(p2Blinding).toString(16).padStart(64, '0');

    const gameProofs = await generateFullGameProofs(
      api,
      proveHandArtifact,
      gameMoveArtifact,
      p1CardIds,
      p2CardIds,
      p1BlindingStr,
      p2BlindingStr,
      p1CommitStr,
      p2CommitStr,
    );

    const proofElapsed = ((Date.now() - proofStart) / 1000).toFixed(1);
    console.log(`  All proofs generated in ${proofElapsed}s`);
    console.log(`  Winner: ${gameProofs.winner}`);

    expect(gameProofs.moveProofs.length).toBe(9);
    // UltraHonk proofs are 500 field elements (16000 bytes / 32)
    expect(gameProofs.handProof1.proofFields.length).toBe(500);
    expect(gameProofs.handProof2.proofFields.length).toBe(500);

    // ================================================================
    // 7. Verify proof chain integrity
    // ================================================================
    console.log('Verifying proof chain...');
    for (let i = 0; i < 8; i++) {
      expect(gameProofs.moveInputs[i][3]).toBe(gameProofs.moveInputs[i + 1][2]);
    }
    console.log('  Proof chain valid (all end_state[i] == start_state[i+1])');

    // ================================================================
    // 8. Determine winner and call process_game
    // ================================================================
    const winner = gameProofs.winner;
    expect(winner).not.toBeNull();
    console.log(`  Game result: ${winner}`);

    // Determine who calls process_game (winner) and who is opponent
    const isP1Winner = winner === 'player1';
    const isDraw = winner === 'draw';
    const callerAddr = isDraw ? p1Addr : (isP1Winner ? p1Addr : p2Addr);
    const opponentAddr = isDraw ? p2Addr : (isP1Winner ? p2Addr : p1Addr);
    const callerCardIds = isDraw ? p1CardIds : (isP1Winner ? p1CardIds : p2CardIds);
    const opponentCardIds = isDraw ? p2CardIds : (isP1Winner ? p2CardIds : p1CardIds);

    // For non-draw, pick first opponent card as transfer target
    const cardToTransfer = isDraw ? 0 : opponentCardIds[0];

    // Format proofs as Fr arrays
    const hp1Proof = gameProofs.handProof1.proofFields.map(toFr);
    const hp1Inputs = gameProofs.handProof1.publicInputs.map(toFr);
    const hp2Proof = gameProofs.handProof2.proofFields.map(toFr);
    const hp2Inputs = gameProofs.handProof2.publicInputs.map(toFr);
    const mp = gameProofs.moveProofs.map((p: any) => p.proofFields.map(toFr));
    const mi = gameProofs.moveInputs.map((inputs: string[]) => inputs.map(toFr));

    console.log('Calling process_game...');
    await gameContract.methods
      .process_game(
        gameId,
        realHandVkFields,
        realMoveVkFields,
        hp1Proof,
        hp1Inputs,
        hp2Proof,
        hp2Inputs,
        mp[0], mi[0],
        mp[1], mi[1],
        mp[2], mi[2],
        mp[3], mi[3],
        mp[4], mi[4],
        mp[5], mi[5],
        mp[6], mi[6],
        mp[7], mi[7],
        mp[8], mi[8],
        opponentAddr,
        new Fr(BigInt(cardToTransfer)),
        callerCardIds.map((id: number) => new Fr(BigInt(id))),
        opponentCardIds.map((id: number) => new Fr(BigInt(id))),
      )
      .send(sendAs(callerAddr));
    console.log('  process_game transaction succeeded!');

    // ================================================================
    // 9. Verify on-chain settlement
    // ================================================================
    const finalStatus = await gameContract.methods
      .get_game_status(gameId)
      .simulate({ from: deployerAddr });
    expect(BigInt(finalStatus)).toBe(3n);
    console.log(`  Game status: ${finalStatus} (settled)`);

    const isSettled = await gameContract.methods
      .is_game_settled(gameId)
      .simulate({ from: deployerAddr });
    expect(isSettled).toBe(true);
    console.log('  Game settled: true');

    console.log('\n  === E2E Settlement Test PASSED ===');
  }, 600_000);
});
