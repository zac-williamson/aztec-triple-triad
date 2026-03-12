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

// Shared helpers
import {
  computeVkHash,
  computeCardCommit,
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
// Helpers
// ============================================================================

/** Safe string-to-Fr conversion: handles both hex and decimal strings */
function toFr(s: string | any): any {
  if (s instanceof Fr) return s;
  const str = s.toString();
  if (str.startsWith('0x') || str.startsWith('0X')) {
    return Fr.fromHexString(str);
  }
  return new Fr(BigInt(str));
}

/** Normalize a value to 0x-prefixed hex string */
function toHex(v: any): string {
  const s = v.toString();
  if (s.startsWith('0x') || s.startsWith('0X')) return s;
  return '0x' + BigInt(s).toString(16);
}

/**
 * Import notes created by create_and_push_note into PXE.
 * This is required because create_and_push_note skips on-chain tagging.
 */
async function importNotes(
  nftContract: any,
  node: any,
  txHash: any,
  owner: any,
  cardIds: number[],
  randomnessFrs: any[],
) {
  // Fetch TxEffect
  let txEffect: any = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const txResult = await node.getTxEffect(txHash);
      if (txResult?.data) { txEffect = txResult.data; break; }
    } catch { /* not indexed yet */ }
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!txEffect) {
    console.warn('  Could not fetch TxEffect for note import');
    return;
  }

  const rawNoteHashes: any[] = txEffect.noteHashes ?? [];
  const uniqueNoteHashes: string[] = rawNoteHashes
    .map((h: any) => h.toString())
    .filter((h: string) => h !== '0' && h !== '0x0' && !/^0x0+$/.test(h));
  const firstNullifier: string = txEffect.nullifiers?.[0]?.toString() ?? '0';

  const paddedHashes = new Array(64).fill(new Fr(0n));
  for (let i = 0; i < uniqueNoteHashes.length && i < 64; i++) {
    paddedHashes[i] = toFr(uniqueNoteHashes[i]);
  }

  const txHashFr = toFr(txHash.toString());
  const firstNullFr = toFr(firstNullifier);

  for (let i = 0; i < cardIds.length; i++) {
    try {
      await nftContract.methods
        .import_note(
          owner,
          new Fr(BigInt(cardIds[i])),
          randomnessFrs[i],
          txHashFr,
          paddedHashes,
          uniqueNoteHashes.length,
          firstNullFr,
          owner,
        )
        .simulate({ from: owner });
      console.log(`  Imported note for card ${cardIds[i]}`);
    } catch (err: any) {
      console.warn(`  Failed to import note for card ${cardIds[i]}:`, err?.message?.slice(0, 120));
    }
  }
}

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
  let node: any;
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

  const p1CardIds = [1, 2, 3, 4, 5];
  const p2CardIds = [1, 2, 3, 4, 5]; // Both players use starter cards

  beforeAll(async () => {
    // --- Connect to Aztec node ---
    console.log(`Connecting to Aztec node at ${PXE_URL}...`);
    node = createAztecNodeClient(PXE_URL);

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
    function encodeCompressedString(s: string): Fr {
      let hex = '';
      for (let i = 0; i < s.length && i < 31; i++) {
        hex += s.charCodeAt(i).toString(16).padStart(2, '0');
      }
      return new Fr(BigInt('0x' + hex));
    }
    const nameField = encodeCompressedString('TestCards');
    const symbolField = encodeCompressedString('TC');
    nftContract = (await Contract.deploy(wallet, nftArtifact, [
      deployerAddr,
      nameField,
      symbolField,
    ]).send(sendAs(deployerAddr))).contract;
    console.log(`  NFT deployed at: ${nftContract.address}`);

    await wallet.registerSender(nftContract.address, 'nft-contract');

    console.log('Deploying TripleTriadGame...');
    gameContract = (await Contract.deploy(wallet, gameArtifact, [
      nftContract.address,
      Fr.fromHexString(handVk.hash),
      Fr.fromHexString(moveVk.hash),
    ]).send(sendAs(deployerAddr))).contract;
    console.log(`  Game deployed at: ${gameContract.address}`);

    await wallet.registerSender(gameContract.address, 'game-contract');

    // --- Register game contract on NFT ---
    console.log('Registering game contract on NFT...');
    await nftContract.methods
      .set_game_contract(gameContract.address)
      .send(sendAs(deployerAddr));

    // --- Mint cards to players ---
    // Player 1: self-mint starter cards via get_cards_for_new_player
    // These use create_and_push_note (no tagging) so we MUST import notes after
    console.log('Minting cards to players...');
    console.log('  Player 1: calling get_cards_for_new_player (self-mint)...');
    const { receipt: p1MintReceipt } = await nftContract.methods
      .get_cards_for_new_player()
      .send(sendAs(p1Addr));
    console.log('  Player 1: starter cards minted, importing notes...');

    // Import Player 1's starter card notes (create_and_push_note skips tagging)
    {
      const { result: randomnessResult } = await nftContract.methods
        .compute_note_randomness(0, 5)
        .simulate({ from: p1Addr });
      const randomnessFrs = [];
      for (let i = 0; i < 5; i++) {
        randomnessFrs.push(toFr(randomnessResult[i]));
      }
      await importNotes(nftContract, node, p1MintReceipt.txHash, p1Addr, p1CardIds, randomnessFrs);
    }

    // Verify Player 1 notes are visible
    const { result: [p1Cards] } = await nftContract.methods
      .get_private_cards(p1Addr, 0)
      .simulate({ from: p1Addr });
    const p1Count = p1Cards.filter((v: any) => BigInt(v) !== 0n).length;
    console.log(`  Player 1: ${p1Count} notes visible after import`);
    if (p1Count < 5) {
      throw new Error(`Player 1 note import failed: only ${p1Count}/5 notes visible`);
    }

    // Player 2: also use get_cards_for_new_player (same flow as P1)
    // This mints starter cards [1,2,3,4,5] AND creates the note_nonce
    console.log('  Player 2: calling get_cards_for_new_player...');
    const { receipt: p2MintReceipt } = await nftContract.methods
      .get_cards_for_new_player()
      .send(sendAs(p2Addr));

    // Import P2's starter card notes (create_and_push_note skips tagging)
    {
      const { result: randomnessResult } = await nftContract.methods
        .compute_note_randomness(0, 5)
        .simulate({ from: p2Addr });
      const randomnessFrs = [];
      for (let i = 0; i < 5; i++) {
        randomnessFrs.push(toFr(randomnessResult[i]));
      }
      await importNotes(nftContract, node, p2MintReceipt.txHash, p2Addr, p2CardIds, randomnessFrs);
    }

    // Verify P2 notes
    const { result: [p2Cards] } = await nftContract.methods
      .get_private_cards(p2Addr, 0)
      .simulate({ from: p2Addr });
    const p2Count = p2Cards.filter((v: any) => BigInt(v) !== 0n).length;
    console.log(`  Player 2: ${p2Count} notes visible after import`);
    if (p2Count < 5) {
      throw new Error(`Player 2 note import failed: only ${p2Count}/5 notes visible`);
    }

    console.log('  All notes ready!');
  }, 600_000);

  afterAll(async () => {
    if (api) {
      try { await api.destroy(); } catch { /* ignore */ }
    }
  });

  it('two players play a full game and settle on-chain via process_game', async () => {
    // ================================================================
    // 1. Preview game data for Player 1 (game_id + randomness derived in-circuit)
    // ================================================================
    console.log('Player 1: previewing game data...');
    const { result: p1Nonce } = await nftContract.methods
      .get_note_nonce(p1Addr)
      .simulate({ from: p1Addr });
    console.log(`  P1 nonce: ${p1Nonce}`);

    const { result: p1Preview } = await nftContract.methods
      .preview_game_data(toFr(p1Nonce))
      .simulate({ from: p1Addr });
    const gameIdHex = toHex(p1Preview[0]);
    const p1Randomness = Array.from({ length: 6 }, (_, i) => toHex(p1Preview[i + 1]));
    console.log(`  Derived game_id: ${gameIdHex}`);
    console.log(`  P1 randomness: ${p1Randomness.map(r => r.slice(0, 18) + '...')}`);

    // ================================================================
    // 2. Create game (Player 1 commits cards 1-5)
    //    game_id and randomness derived IN-CIRCUIT
    // ================================================================
    console.log('Player 1 creating game...');
    await gameContract.methods
      .create_game(p1CardIds.map((id: number) => new Fr(BigInt(id))))
      .send(sendAs(p1Addr));

    const gameIdFr = toFr(gameIdHex);

    let status: any;
    ({ result: status } = await gameContract.methods
      .get_game_status(gameIdFr)
      .simulate({ from: deployerAddr }));
    expect(BigInt(status)).toBe(1n);
    console.log('  Game created (status=1)');

    // ================================================================
    // 3. Preview game data for Player 2 (randomness derived in-circuit)
    // ================================================================
    console.log('Player 2: previewing game data...');
    const { result: p2Nonce } = await nftContract.methods
      .get_note_nonce(p2Addr)
      .simulate({ from: p2Addr });
    console.log(`  P2 nonce: ${p2Nonce}`);

    const { result: p2Preview } = await nftContract.methods
      .preview_game_data(toFr(p2Nonce))
      .simulate({ from: p2Addr });
    const p2Randomness = Array.from({ length: 6 }, (_, i) => toHex(p2Preview[i + 1]));
    console.log(`  P2 randomness: ${p2Randomness.map(r => r.slice(0, 18) + '...')}`);

    // ================================================================
    // 4. Join game (Player 2 commits cards [1,2,3,4,5])
    //    randomness derived IN-CIRCUIT
    // ================================================================
    console.log('Player 2 joining game...');
    await gameContract.methods
      .join_game(gameIdFr, p2CardIds.map((id: number) => new Fr(BigInt(id))))
      .send(sendAs(p2Addr));

    ({ result: status } = await gameContract.methods
      .get_game_status(gameIdFr)
      .simulate({ from: deployerAddr }));
    expect(BigInt(status)).toBe(2n);
    console.log('  Game active (status=2)');

    // ================================================================
    // 5. Read on-chain card commits
    // ================================================================
    const { result: onChainCC1 } = await gameContract.methods
      .get_game_card_commit_1(gameIdFr)
      .simulate({ from: deployerAddr });
    const { result: onChainCC2 } = await gameContract.methods
      .get_game_card_commit_2(gameIdFr)
      .simulate({ from: deployerAddr });
    console.log(`  On-chain card_commit_1: ${onChainCC1}`);
    console.log(`  On-chain card_commit_2: ${onChainCC2}`);
    expect(BigInt(onChainCC1)).not.toBe(0n);
    expect(BigInt(onChainCC2)).not.toBe(0n);

    // ================================================================
    // 6. Derive blinding factors via NFT contract simulate
    // ================================================================
    console.log('Deriving blinding factors via compute_blinding_factor...');
    const { result: p1Blinding } = await nftContract.methods
      .compute_blinding_factor(gameIdFr)
      .simulate({ from: p1Addr });
    const { result: p2Blinding } = await nftContract.methods
      .compute_blinding_factor(gameIdFr)
      .simulate({ from: p2Addr });
    console.log(`  P1 blinding factor: ${p1Blinding}`);
    console.log(`  P2 blinding factor: ${p2Blinding}`);

    // ================================================================
    // 7. Verify blinding factors match on-chain card commits
    // ================================================================
    console.log('Verifying card commitments match...');
    const computedCC1 = await computeCardCommit(api, p1CardIds, BigInt(p1Blinding));
    const computedCC2 = await computeCardCommit(api, p2CardIds, BigInt(p2Blinding));
    console.log(`  Computed card_commit_1: ${computedCC1}`);
    console.log(`  Computed card_commit_2: ${computedCC2}`);

    expect(BigInt(computedCC1)).toBe(BigInt(onChainCC1));
    expect(BigInt(computedCC2)).toBe(BigInt(onChainCC2));
    console.log('  Card commitments match on-chain values!');

    // ================================================================
    // 8. Generate all 11 ZK proofs
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
      p1Randomness,
      p2Randomness,
    );

    const proofElapsed = ((Date.now() - proofStart) / 1000).toFixed(1);
    console.log(`  All proofs generated in ${proofElapsed}s`);
    console.log(`  Winner: ${gameProofs.winner}`);

    expect(gameProofs.moveProofs.length).toBe(9);
    expect(gameProofs.handProof1.proofFields.length).toBe(500);
    expect(gameProofs.handProof2.proofFields.length).toBe(500);

    // ================================================================
    // 9. Verify proof chain integrity
    // ================================================================
    console.log('Verifying proof chain...');
    for (let i = 0; i < 8; i++) {
      expect(gameProofs.moveInputs[i][3]).toBe(gameProofs.moveInputs[i + 1][2]);
    }
    console.log('  Proof chain valid (all end_state[i] == start_state[i+1])');

    // ================================================================
    // 10. Determine winner and call process_game
    // ================================================================
    const winner = gameProofs.winner;
    expect(winner).not.toBeNull();
    console.log(`  Game result: ${winner}`);

    const isP1Winner = winner === 'player1';
    const isDraw = winner === 'draw';
    const callerAddr = isDraw ? p1Addr : (isP1Winner ? p1Addr : p2Addr);
    const opponentAddr = isDraw ? p2Addr : (isP1Winner ? p2Addr : p1Addr);
    const callerCardIds = isDraw ? p1CardIds : (isP1Winner ? p1CardIds : p2CardIds);
    const opponentCardIds = isDraw ? p2CardIds : (isP1Winner ? p2CardIds : p1CardIds);

    const cardToTransfer = isDraw ? 0 : opponentCardIds[2];

    // Format proofs as Fr arrays
    const hp1Proof = gameProofs.handProof1.proofFields.map(toFr);
    const hp1Inputs = gameProofs.handProof1.publicInputs.map(toFr);
    const hp2Proof = gameProofs.handProof2.proofFields.map(toFr);
    const hp2Inputs = gameProofs.handProof2.publicInputs.map(toFr);
    const mp = gameProofs.moveProofs.map((p: any) => p.proofFields.map(toFr));
    const mi = gameProofs.moveInputs.map((inputs: string[]) => inputs.map(toFr));

    // Use the in-circuit derived randomness for settlement
    // The randomness was previewed earlier and committed on-chain via player_state_hash
    const callerRandomnessHex = isP1Winner || isDraw ? p1Randomness : p2Randomness;
    const opponentRandomnessHex = isP1Winner || isDraw ? p2Randomness : p1Randomness;
    const callerRandomness = callerRandomnessHex.map(toFr);
    const opponentRandomness = opponentRandomnessHex.map(toFr);

    console.log('Calling process_game...');

    const { receipt: result } = await gameContract.methods
      .process_game(
        gameIdFr,
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
        callerRandomness,
        opponentRandomness,
      )
      .send(sendAs(callerAddr));
    console.log('  process_game transaction succeeded!');

    // ================================================================
    // 11. Verify on-chain settlement
    // ================================================================
    const { result: finalStatus } = await gameContract.methods
      .get_game_status(gameIdFr)
      .simulate({ from: deployerAddr });
    expect(BigInt(finalStatus)).toBe(3n);
    console.log(`  Game status: ${finalStatus} (settled)`);

    const { result: isSettled } = await gameContract.methods
      .is_game_settled(gameIdFr)
      .simulate({ from: deployerAddr });
    expect(isSettled).toBe(true);
    console.log('  Game settled: true');

    // ================================================================
    // 12. Import settlement notes and verify card ownership
    //     Settlement uses create_and_push_note -- must import notes
    // ================================================================
    console.log('Importing settlement notes...');

    const winnerAddr = callerAddr;
    const loserAddr = opponentAddr;

    // Import winner notes (6 cards: 5 original + 1 transferred)
    {
      const winnerTokenIds = [...callerCardIds, cardToTransfer].filter(id => id !== 0);
      const winnerRand = callerRandomness.slice(0, winnerTokenIds.length);
      await importNotes(nftContract, node, result.txHash, winnerAddr, winnerTokenIds, winnerRand);
    }

    // Import loser notes (4 cards: 5 original - 1 transferred)
    if (!isDraw) {
      const loserTokenIds: number[] = [];
      const loserRand: any[] = [];
      let removed = false;
      for (let i = 0; i < opponentCardIds.length; i++) {
        if (opponentCardIds[i] === cardToTransfer && !removed) {
          removed = true;
        } else {
          loserTokenIds.push(opponentCardIds[i]);
          loserRand.push(opponentRandomness[i]);
        }
      }
      await importNotes(nftContract, node, result.txHash, loserAddr, loserTokenIds, loserRand);
    }

    // Verify card counts
    const { result: [winnerCards] } = await nftContract.methods
      .get_private_cards(winnerAddr, 0)
      .simulate({ from: winnerAddr });
    const winnerCardCount = winnerCards.filter((v: any) => BigInt(v) !== 0n).length;

    const { result: [loserCards] } = await nftContract.methods
      .get_private_cards(loserAddr, 0)
      .simulate({ from: loserAddr });
    const loserCardCount = loserCards.filter((v: any) => BigInt(v) !== 0n).length;

    console.log(`  Winner has ${winnerCardCount} cards (expected 6)`);
    console.log(`  Loser has ${loserCardCount} cards (expected 4)`);

    expect(winnerCardCount).toBe(6);
    expect(loserCardCount).toBe(4);

    console.log('\n  === E2E Settlement Test PASSED ===');
  }, 600_000);
});
