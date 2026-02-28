// @ts-nocheck — Aztec SDK types require sandbox-specific resolution
/**
 * E2E Full Game Flow Test — Frontend Proofs + WebSocket + Aztec Settlement
 *
 * This test exercises the ENTIRE system end-to-end with NO mocks.
 * Every code path mirrors the actual frontend orchestration:
 *
 *   - proofWorker.ts: computeCardCommitPoseidon2, generateProveHandProof,
 *     generateGameMoveProof (same functions the browser calls)
 *   - circuitLoader.ts: loadProveHandCircuit, loadGameMoveCircuit
 *     (circuit artifact loading, same path as useGameContract.settleGame)
 *   - proofBackend.ts: getBarretenberg (singleton WASM instance)
 *   - useProofGeneration.ts: encodeBoardState (board serialization)
 *   - useGameFlow.ts: card commit ordering (commit1=P1, commit2=P2),
 *     hand proof auto-generation, move proof orchestration
 *   - useGameContract.ts: settleGame VK extraction (getVerificationKey()),
 *     base64ToFields, vkToFields, process_game call format
 *   - App.tsx: handlePlaceCard (local sim → encode → proof → submit),
 *     hand proof auto-submit, opponent proof collection
 *   - useWebSocket.ts: moveNumber derivation from board state
 *   - Backend createServer: real WebSocket relay
 *   - Aztec contracts: real deployment + settlement
 *
 * Environment shim: fetch() polyfill reads circuit/contract JSON from disk
 * (same artifacts the browser would load via Vite dev server).
 *
 * Prerequisites:
 *   - Aztec sandbox running: aztec start --local-network
 *   - Contracts compiled: aztec compile (from packages/contracts)
 *   - Circuits compiled: cd circuits/prove_hand && nargo compile &&
 *                        cd ../game_move && nargo compile
 *
 * Run:
 *   cd packages/integration
 *   npx vitest run tests/e2e-full-game-flow.test.ts
 */

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import WebSocket from 'ws';

// ============================================================================
// Global fetch polyfill — lets circuitLoader.ts and useGameContract.ts read
// circuit/contract artifacts from disk (same files Vite serves in the browser)
// ============================================================================

function findRootDir(): string {
  const candidates = [
    resolve(process.cwd(), '../..'),
    resolve(process.cwd()),
    resolve(import.meta.url.replace('file://', ''), '../../../../'),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(resolve(candidate, 'package.json'), 'utf-8');
      readFileSync(resolve(candidate, 'packages/integration/package.json'), 'utf-8');
      return candidate;
    } catch {
      continue;
    }
  }
  return resolve(process.cwd(), '../..');
}

const rootDir = findRootDir();

vi.stubGlobal('fetch', async (url: string) => {
  const map: Record<string, string> = {
    // Circuit artifacts (used by circuitLoader.ts → proofWorker.ts)
    '/circuits/prove_hand.json': resolve(rootDir, 'circuits/target/prove_hand.json'),
    '/circuits/game_move.json': resolve(rootDir, 'circuits/target/game_move.json'),
    // Contract artifacts (used by useGameContract.ts settleGame)
    '/contracts/triple_triad_game-TripleTriadGame.json': resolve(rootDir, 'packages/contracts/target/triple_triad_game-TripleTriadGame.json'),
    '/contracts/triple_triad_nft-TripleTriadNFT.json': resolve(rootDir, 'packages/contracts/target/triple_triad_nft-TripleTriadNFT.json'),
  };
  const filePath = map[url];
  if (!filePath) throw new Error(`Unmocked fetch: ${url}`);
  const raw = readFileSync(filePath, 'utf-8');
  return { ok: true, status: 200, json: async () => JSON.parse(raw) };
});

// ============================================================================
// Frontend source code under test — imported directly, same functions the
// browser calls (not via React hooks, but the SAME underlying code)
// ============================================================================

// proofWorker.ts — proof generation engine
import {
  computeCardCommitPoseidon2,
  generateProveHandProof,
  generateGameMoveProof,
  destroyBackendCache,
} from '../../frontend/src/aztec/proofWorker';

// circuitLoader.ts — used by useGameContract.settleGame for VK extraction
import {
  loadProveHandCircuit,
  loadGameMoveCircuit,
} from '../../frontend/src/aztec/circuitLoader';

// proofBackend.ts — singleton Barretenberg WASM instance
import {
  getBarretenberg,
  destroyBarretenberg,
} from '../../frontend/src/aztec/proofBackend';

// useProofGeneration.ts — board state encoding
import { encodeBoardState } from '../../frontend/src/hooks/useProofGeneration';

// types
import type { HandProofData, MoveProofData } from '../../frontend/src/types';

// ============================================================================
// Backend server
// ============================================================================

import { createServer } from '@aztec-triple-triad/backend';
import type { TripleTriadServer } from '@aztec-triple-triad/backend';

// ============================================================================
// Game logic — same package used by App.tsx handlePlaceCard for local sim
// ============================================================================

import {
  createGame,
  placeCard,
  getCardsByIds,
  CARD_DATABASE,
} from '@aztec-triple-triad/game-logic';
import type { GameState, Player } from '@aztec-triple-triad/game-logic';

// ============================================================================
// Aztec SDK
// ============================================================================

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

// bb.js — UltraHonkBackend used by useGameContract.settleGame for VK extraction
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';

// ============================================================================
// E2E helpers (only for contract deployment VK hashes — NOT for settlement)
// ============================================================================

import {
  loadContractArtifact,
  computeVkHash,
  packRanks,
} from './e2e-helpers.js';

// ============================================================================
// Configuration
// ============================================================================

const PXE_URL = process.env.AZTEC_PXE_URL || 'http://localhost:8080';
const SEND_TIMEOUT = 300; // seconds

// ============================================================================
// Frontend-identical conversion functions
// (copied verbatim from useGameContract.ts lines 141-166)
// These are the EXACT functions the browser uses for settlement.
// ============================================================================

/**
 * Convert base64-encoded proof to field element hex strings.
 * Mirrors useGameContract.ts settleGame inline base64ToFields.
 */
function frontendBase64ToFields(b64: string): string[] {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const fields: string[] = [];
  for (let i = 0; i < bytes.length; i += 32) {
    const chunk = bytes.slice(i, i + 32);
    const hex = '0x' + Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join('');
    fields.push(hex);
  }
  return fields;
}

/**
 * Convert VK Uint8Array to field element hex strings.
 * Mirrors useGameContract.ts settleGame inline vkToFields.
 */
function vkToFields(vk: Uint8Array): string[] {
  const fields: string[] = [];
  for (let i = 0; i < vk.length; i += 32) {
    const chunk = vk.slice(i, i + 32);
    const hex = '0x' + Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join('');
    fields.push(hex);
  }
  return fields;
}

/**
 * Map game winner to circuit winner_id value.
 * Mirrors App.tsx mapWinnerId (lines 17-22).
 */
function mapWinnerId(winner: 'player1' | 'player2' | 'draw' | null): number {
  if (winner === null) return 0;
  if (winner === 'player1') return 1;
  if (winner === 'player2') return 2;
  return 3; // draw
}

/**
 * Count occupied board cells to derive moveNumber.
 * Mirrors useWebSocket.ts placeCard (lines 168-175) and
 * submitMoveProof (lines 193-200).
 */
function deriveMoveNumber(gameState: GameState): number {
  let count = 0;
  for (const row of gameState.board) {
    for (const cell of row) {
      if (cell.card !== null) count++;
    }
  }
  return count;
}

// ============================================================================
// TestWSClient — buffered WebSocket client for deterministic message assertion
// ============================================================================

type ServerMsg = Record<string, any> & { type: string };

class TestWSClient {
  private buffer: ServerMsg[] = [];
  private waiters: Array<{
    filter: (msg: ServerMsg) => boolean;
    resolve: (msg: ServerMsg) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(private ws: WebSocket) {
    ws.on('message', (data: WebSocket.Data) => {
      const msg: ServerMsg = JSON.parse(data.toString());
      for (let i = 0; i < this.waiters.length; i++) {
        if (this.waiters[i].filter(msg)) {
          clearTimeout(this.waiters[i].timeout);
          this.waiters.splice(i, 1)[0].resolve(msg);
          return;
        }
      }
      this.buffer.push(msg);
    });
  }

  send(msg: Record<string, any>): void {
    this.ws.send(JSON.stringify(msg));
  }

  async waitFor(type: string, timeoutMs = 30_000): Promise<ServerMsg> {
    const filter = (m: ServerMsg) => m.type === type;
    const idx = this.buffer.findIndex(filter);
    if (idx !== -1) {
      return this.buffer.splice(idx, 1)[0];
    }
    return new Promise<ServerMsg>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for message type "${type}" after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ filter, resolve, timeout });
    });
  }

  close(): void {
    for (const w of this.waiters) clearTimeout(w.timeout);
    this.waiters = [];
    this.ws.close();
  }
}

async function connectClient(wsUrl: string): Promise<TestWSClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', () => resolve(new TestWSClient(ws)));
    ws.on('error', reject);
  });
}

// ============================================================================
// SponsoredFPC setup
// ============================================================================

async function getSponsoredFPCContract() {
  const instance = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  return instance;
}

// ============================================================================
// Test
// ============================================================================

describe('E2E Full Game Flow — Frontend Proofs + WebSocket + Aztec Settlement', () => {
  // WebSocket server & clients
  let server: TripleTriadServer;
  let wsUrl: string;
  let client1: TestWSClient;
  let client2: TestWSClient;

  // Aztec state
  let wallet: any;
  let fee: any;
  let deployerAddr: any;
  let p1Addr: any;
  let p2Addr: any;
  let nftContract: any;
  let gameContract: any;

  // Barretenberg for contract deployment VK hashes only
  let deployApi: Barretenberg;
  // On-chain VK hashes (for verifying frontend VK extraction compatibility)
  let deployedHandVkHash: string;
  let deployedMoveVkHash: string;

  // Card & commit data
  const p1CardIds = [1, 2, 3, 4, 5];
  const p2CardIds = [6, 7, 8, 9, 10];
  let p1BlindingHex: string;
  let p2BlindingHex: string;
  let p1CardCommit: string;
  let p2CardCommit: string;

  // WebSocket game ID
  let wsGameId: string;

  // Helper: send options for a given address
  const sendAs = (addr: any) => ({
    from: addr,
    fee: { paymentMethod: fee },
    wait: { timeout: SEND_TIMEOUT },
  });

  beforeAll(async () => {
    // ================================================================
    // Step 1: Start WebSocket server on ephemeral port
    // ================================================================
    console.log('Starting WebSocket server...');
    server = createServer({ port: 0 });
    await new Promise<void>((resolve) => {
      server.httpServer.listen(0, () => resolve());
    });
    const addr = server.httpServer.address() as { port: number };
    wsUrl = `ws://localhost:${addr.port}`;
    console.log(`  WebSocket server running at ${wsUrl}`);

    // ================================================================
    // Step 2: Connect to Aztec, create wallet, deploy 3 accounts
    // (mirrors useAztec.ts connect flow)
    // ================================================================
    console.log(`Connecting to Aztec node at ${PXE_URL}...`);
    const node = createAztecNodeClient(PXE_URL);

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
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Mirrors useAztec.ts: EmbeddedWallet.create(node, { ephemeral: true })
    console.log('Creating EmbeddedWallet...');
    wallet = await EmbeddedWallet.create(node, { ephemeral: true });

    console.log('Waiting for embedded PXE to sync...');
    await new Promise((r) => setTimeout(r, 5000));

    // Mirrors useAztec.ts: register SponsoredFPC
    console.log('Registering SponsoredFPC contract...');
    const sponsoredFPCContract = await getSponsoredFPCContract();
    await wallet.registerContract(sponsoredFPCContract, SponsoredFPCContractArtifact);
    fee = new SponsoredFeePaymentMethod(sponsoredFPCContract.address);
    console.log(`  SponsoredFPC at: ${sponsoredFPCContract.address}`);

    // Mirrors useAztec.ts: deployAccount with retry
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
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          throw err;
        }
      }
    }

    // Mirrors useAztec.ts: createSchnorrAccount + deploy + registerSender
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

    // ================================================================
    // Step 3: Compute VK hashes for contract deployment
    // (uses e2e-helpers computeVkHash — this is the DEPLOYMENT path,
    // NOT the settlement path. The settlement will use the frontend's
    // VK extraction to verify compatibility.)
    // ================================================================
    console.log('Initializing Barretenberg for deployment VK hashes...');
    deployApi = await Barretenberg.new({ threads: 1 });

    const proveHandArtifact = JSON.parse(
      readFileSync(resolve(rootDir, 'circuits/target/prove_hand.json'), 'utf-8'),
    );
    const gameMoveArtifact = JSON.parse(
      readFileSync(resolve(rootDir, 'circuits/target/game_move.json'), 'utf-8'),
    );

    console.log('Computing VK hashes for contract deployment...');
    const handVk = await computeVkHash(deployApi, proveHandArtifact.bytecode);
    const moveVk = await computeVkHash(deployApi, gameMoveArtifact.bytecode);
    deployedHandVkHash = handVk.hash;
    deployedMoveVkHash = moveVk.hash;
    console.log(`  hand_vk_hash: ${deployedHandVkHash}`);
    console.log(`  move_vk_hash: ${deployedMoveVkHash}`);

    // ================================================================
    // Step 4: Deploy contracts, mint cards
    // ================================================================
    const nftArtifact = loadContractArtifact('triple_triad_nft-TripleTriadNFT');
    const gameArtifact = loadContractArtifact('triple_triad_game-TripleTriadGame');

    function encodeCompressedString(s: string): Fr {
      let hex = '';
      for (let i = 0; i < s.length && i < 31; i++) {
        hex += s.charCodeAt(i).toString(16).padStart(2, '0');
      }
      return new Fr(BigInt('0x' + hex));
    }

    console.log('Deploying TripleTriadNFT...');
    nftContract = await Contract.deploy(wallet, nftArtifact, [
      deployerAddr,
      encodeCompressedString('TestCards'),
      encodeCompressedString('TC'),
    ]).send(sendAs(deployerAddr));
    console.log(`  NFT deployed at: ${nftContract.address}`);

    await wallet.registerSender(nftContract.address, 'nft-contract');

    console.log('Deploying TripleTriadGame...');
    gameContract = await Contract.deploy(wallet, gameArtifact, [
      nftContract.address,
      Fr.fromHexString(deployedHandVkHash),
      Fr.fromHexString(deployedMoveVkHash),
    ]).send(sendAs(deployerAddr));
    console.log(`  Game deployed at: ${gameContract.address}`);

    await wallet.registerSender(gameContract.address, 'game-contract');

    console.log('Registering game contract on NFT...');
    await nftContract.methods
      .set_game_contract(gameContract.address)
      .send(sendAs(deployerAddr));

    // Mint cards
    console.log('Minting cards to players...');
    console.log('  Player 1: calling get_cards_for_new_player (self-mint)...');
    await nftContract.methods
      .get_cards_for_new_player()
      .send(sendAs(p1Addr));
    console.log('  Player 1: starter cards minted');

    for (const id of p2CardIds) {
      const card = CARD_DATABASE.find((c: any) => c.id === id)!;
      const packed = packRanks(card.ranks.top, card.ranks.right, card.ranks.bottom, card.ranks.left);
      await nftContract.methods
        .mint_to_private(p2Addr, new Fr(BigInt(id)), new Fr(BigInt(packed)))
        .send(sendAs(deployerAddr));
    }
    console.log('  Minted cards 6-10 to Player 2');

    // Wait for PXE to discover minted notes
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
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!p1NotesFound || !p2NotesFound) {
      throw new Error(`Note discovery timed out: P1=${p1NotesFound}, P2=${p2NotesFound}`);
    }

    // ================================================================
    // Step 5: Create on-chain game + derive blinding factors
    // ================================================================
    console.log('Player 1 creating game on-chain...');
    await gameContract.methods
      .create_game(p1CardIds.map((id: number) => new Fr(BigInt(id))))
      .send(sendAs(p1Addr));

    const gameId = new Fr(0n);

    let status = await gameContract.methods
      .get_game_status(gameId)
      .simulate({ from: deployerAddr });
    expect(BigInt(status)).toBe(1n);
    console.log('  Game created (status=1)');

    console.log('Player 2 joining game on-chain...');
    await gameContract.methods
      .join_game(gameId, p2CardIds.map((id: number) => new Fr(BigInt(id))))
      .send(sendAs(p2Addr));

    status = await gameContract.methods
      .get_game_status(gameId)
      .simulate({ from: deployerAddr });
    expect(BigInt(status)).toBe(2n);
    console.log('  Game active (status=2)');

    // Read on-chain card commits
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

    // Derive blinding factors
    // (mirrors deriveBlindingFactor.ts: calls compute_blinding_factor().simulate())
    console.log('Deriving blinding factors via compute_blinding_factor...');
    const p1Blinding = await nftContract.methods
      .compute_blinding_factor()
      .simulate({ from: p1Addr });
    const p2Blinding = await nftContract.methods
      .compute_blinding_factor()
      .simulate({ from: p2Addr });
    p1BlindingHex = '0x' + BigInt(p1Blinding).toString(16).padStart(64, '0');
    p2BlindingHex = '0x' + BigInt(p2Blinding).toString(16).padStart(64, '0');
    console.log(`  P1 blinding factor: ${p1BlindingHex}`);
    console.log(`  P2 blinding factor: ${p2BlindingHex}`);

    // Compute card commits using FRONTEND proofWorker
    // (mirrors useGameFlow.ts line 114: computeCardCommitPoseidon2(cardIds, blindingFactor))
    console.log('Computing card commitments using frontend proofWorker...');
    p1CardCommit = await computeCardCommitPoseidon2(p1CardIds, p1BlindingHex);
    p2CardCommit = await computeCardCommitPoseidon2(p2CardIds, p2BlindingHex);
    console.log(`  Frontend card_commit_1: ${p1CardCommit}`);
    console.log(`  Frontend card_commit_2: ${p2CardCommit}`);

    // Verify frontend commits match on-chain values
    expect(BigInt(p1CardCommit)).toBe(BigInt(onChainCC1));
    expect(BigInt(p2CardCommit)).toBe(BigInt(onChainCC2));
    console.log('  Frontend card commitments match on-chain values!');
  }, 600_000);

  afterAll(async () => {
    client1?.close();
    client2?.close();
    if (server) {
      try { await server.close(); } catch { /* ignore */ }
    }
    destroyBackendCache();
    try { await destroyBarretenberg(); } catch { /* ignore */ }
    if (deployApi) {
      try { await deployApi.destroy(); } catch { /* ignore */ }
    }
  });

  it('full game via WebSocket with frontend proofs and on-chain settlement', async () => {
    // ================================================================
    // Phase 1: WebSocket game creation
    // (mirrors useWebSocket.ts: createGame → GAME_CREATED,
    //  joinGame → GAME_JOINED + GAME_START)
    // ================================================================
    console.log('\n=== Phase 1: WebSocket game creation ===');

    client1 = await connectClient(wsUrl);
    client2 = await connectClient(wsUrl);

    // Mirrors useWebSocket.ts createGame (line 148)
    client1.send({ type: 'CREATE_GAME', cardIds: p1CardIds });
    const created = await client1.waitFor('GAME_CREATED');
    wsGameId = created.gameId;
    console.log(`  Game created on WebSocket: ${wsGameId}`);

    // Mirrors useWebSocket.ts joinGame (line 155)
    client2.send({ type: 'JOIN_GAME', gameId: wsGameId, cardIds: p2CardIds });
    const joined = await client2.waitFor('GAME_JOINED');
    const gameStart = await client1.waitFor('GAME_START');
    expect(joined.playerNumber).toBe(2);
    expect(joined.gameState.status).toBe('playing');
    expect(gameStart.gameState.status).toBe('playing');
    console.log('  Both players connected, game started');

    // ================================================================
    // Phase 2: Hand proof generation & exchange via WebSocket
    // (mirrors useGameFlow.ts lines 104-119: auto-generate hand proof
    //  when gameState.status === 'playing' && blindingFactor ready,
    //  then App.tsx lines 54-59: auto-submit via ws.submitHandProof,
    //  then App.tsx lines 62-65: receive opponent hand proof)
    // ================================================================
    console.log('\n=== Phase 2: Hand proof generation (frontend proofWorker) ===');

    // Mirrors useGameFlow.ts line 114-115:
    //   cardCommitHash = await computeCardCommitPoseidon2(cardIds, blindingFactor)
    //   proof = await proofs.generateHandProof(cardIds, blindingFactor, cardCommitHash)
    console.log('  Generating hand proof 1 (frontend proofWorker)...');
    const proofStart = Date.now();
    const handProof1 = await generateProveHandProof(p1CardIds, p1BlindingHex, p1CardCommit);
    console.log(`  Hand proof 1 generated in ${((Date.now() - proofStart) / 1000).toFixed(1)}s`);
    expect(handProof1.proof).toBeTruthy();
    expect(handProof1.publicInputs.length).toBeGreaterThanOrEqual(1);
    expect(handProof1.cardCommit).toBeTruthy();

    console.log('  Generating hand proof 2 (frontend proofWorker)...');
    const proofStart2 = Date.now();
    const handProof2 = await generateProveHandProof(p2CardIds, p2BlindingHex, p2CardCommit);
    console.log(`  Hand proof 2 generated in ${((Date.now() - proofStart2) / 1000).toFixed(1)}s`);
    expect(handProof2.proof).toBeTruthy();

    // Mirrors App.tsx line 58: ws.submitHandProof(ws.gameId, gameFlow.myHandProof)
    console.log('  Exchanging hand proofs via WebSocket...');
    client1.send({ type: 'SUBMIT_HAND_PROOF', gameId: wsGameId, handProof: handProof1 });
    const p2ReceivedProof = await client2.waitFor('HAND_PROOF');
    expect(p2ReceivedProof.fromPlayer).toBe(1);
    expect(p2ReceivedProof.handProof.proof).toBe(handProof1.proof);

    client2.send({ type: 'SUBMIT_HAND_PROOF', gameId: wsGameId, handProof: handProof2 });
    const p1ReceivedProof = await client1.waitFor('HAND_PROOF');
    expect(p1ReceivedProof.fromPlayer).toBe(2);
    expect(p1ReceivedProof.handProof.proof).toBe(handProof2.proof);
    console.log('  Hand proofs exchanged successfully');

    // ================================================================
    // Phase 3: Play 9 moves with real proof generation via WebSocket
    //
    // Each move mirrors the EXACT App.tsx handlePlaceCard flow (lines 99-137):
    //   1. Capture boardBefore from prevGameStateRef (before server responds)
    //   2. ws.placeCard(handIndex, row, col) — sends to server immediately
    //   3. Local sim: placeCard(gameState, player, handIndex, row, col)
    //   4. Encode boardBefore & boardAfter via encodeBoardState()
    //   5. Generate move proof via generateGameMoveProof()
    //   6. ws.submitMoveProof(gameId, handIndex, row, col, moveProof)
    //
    // Card commit ordering mirrors useGameFlow.ts lines 179-181:
    //   commit1 = playerNumber === 1 ? myCardCommit : opponentCardCommit
    //   commit2 = playerNumber === 2 ? myCardCommit : opponentCardCommit
    //   (commit1 is ALWAYS P1's, commit2 is ALWAYS P2's)
    // ================================================================
    console.log('\n=== Phase 3: Play 9 moves (frontend proof generation) ===');

    const moves: [Player, number, number, number][] = [
      ['player1', 0, 0, 0],
      ['player2', 0, 0, 1],
      ['player1', 0, 0, 2],
      ['player2', 0, 1, 0],
      ['player1', 0, 1, 1],
      ['player2', 0, 1, 2],
      ['player1', 0, 2, 0],
      ['player2', 0, 2, 1],
      ['player1', 0, 2, 2],
    ];

    let localState = createGame(getCardsByIds(p1CardIds), getCardsByIds(p2CardIds));
    const allMoveProofs: MoveProofData[] = [];

    for (let i = 0; i < moves.length; i++) {
      const [player, handIdx, row, col] = moves[i];
      const isP1 = player === 'player1';
      const currentPlayer: 1 | 2 = isP1 ? 1 : 2;
      const activeClient = isP1 ? client1 : client2;
      const passiveClient = isP1 ? client2 : client1;

      const hand = isP1 ? localState.player1Hand : localState.player2Hand;
      const card = hand[handIdx];

      console.log(`  Move ${i + 1}/9: ${player} plays card ${card.id} (${card.name}) at [${row},${col}]`);

      // Step 1: Capture boardBefore (mirrors prevGameStateRef.current in App.tsx)
      const boardBefore = encodeBoardState(localState.board);

      // Step 2: Derive moveNumber from board state
      // (mirrors useWebSocket.ts placeCard lines 168-175)
      const moveNumber = deriveMoveNumber(localState);

      // Step 3: Local simulation (mirrors App.tsx handlePlaceCard lines 115-116)
      const result = placeCard(localState, player, handIdx, row, col);
      const newState = result.newState;

      // Step 4: Encode boardAfter
      const boardAfter = encodeBoardState(newState.board);

      // Step 5: Determine game-end fields (mirrors App.tsx mapWinnerId)
      const gameEnded = newState.status === 'finished';
      const winnerId = mapWinnerId(newState.winner);

      // Step 6: Generate move proof (mirrors useGameFlow.generateMoveProofForPlacement)
      // Card commit ordering: commit1=P1's, commit2=P2's (useGameFlow.ts lines 179-181)
      const moveStart = Date.now();
      const moveProof = await generateGameMoveProof(
        card.id, row, col, currentPlayer,
        boardBefore, boardAfter,
        [localState.player1Score, localState.player2Score],
        [newState.player1Score, newState.player2Score],
        p1CardCommit,  // commit1 is ALWAYS P1's (matches useGameFlow.ts)
        p2CardCommit,  // commit2 is ALWAYS P2's (matches useGameFlow.ts)
        gameEnded, winnerId,
        { cardIds: isP1 ? p1CardIds : p2CardIds, blindingFactor: isP1 ? p1BlindingHex : p2BlindingHex },
      );
      const moveElapsed = ((Date.now() - moveStart) / 1000).toFixed(1);
      console.log(`    Proof generated in ${moveElapsed}s (startHash=${moveProof.startStateHash.slice(0, 18)}..., endHash=${moveProof.endStateHash.slice(0, 18)}...)`);

      allMoveProofs.push(moveProof);

      // Step 7: Submit via WebSocket with moveNumber derived from board state
      // (mirrors useWebSocket.ts submitMoveProof lines 188-202)
      activeClient.send({
        type: 'SUBMIT_MOVE_PROOF',
        gameId: wsGameId,
        handIndex: handIdx,
        row,
        col,
        moveNumber,
        moveProof,
      });

      // Active player gets GAME_STATE, passive player gets MOVE_PROVEN
      // (mirrors useWebSocket.ts onmessage handler lines 100-126)
      await activeClient.waitFor('GAME_STATE');
      await passiveClient.waitFor('MOVE_PROVEN');

      // On last move, both get GAME_OVER
      if (i === 8) {
        const gameOver1 = await activeClient.waitFor('GAME_OVER');
        const gameOver2 = await passiveClient.waitFor('GAME_OVER');
        console.log(`  Game over! Winner: ${gameOver1.winner}`);
        expect(gameOver1.winner).toBeDefined();
        expect(gameOver2.winner).toBe(gameOver1.winner);
      }

      localState = newState;
    }

    expect(allMoveProofs.length).toBe(9);
    console.log('  All 9 moves played with real proofs via WebSocket');

    // ================================================================
    // Phase 4: Verify proof chain integrity
    // ================================================================
    console.log('\n=== Phase 4: Verify proof chain integrity ===');

    for (let i = 0; i < 8; i++) {
      expect(allMoveProofs[i].endStateHash).toBe(allMoveProofs[i + 1].startStateHash);
    }
    console.log('  Proof chain valid (all endStateHash[i] == startStateHash[i+1])');

    // ================================================================
    // Phase 5: On-chain settlement using FRONTEND's exact code path
    //
    // This mirrors useGameContract.ts settleGame (lines 87-241):
    //   1. Load circuit artifacts via circuitLoader (loadProveHandCircuit/loadGameMoveCircuit)
    //   2. Create UltraHonkBackend instances via getBarretenberg() singleton
    //   3. Extract VKs via getVerificationKey() — NO verifierTarget arg
    //      (this is the CRITICAL test: if the frontend's VK extraction
    //       doesn't match the deployed VK hash, settlement WILL fail,
    //       proving there's a real frontend bug)
    //   4. Convert VKs to fields via vkToFields (inline, copied verbatim)
    //   5. Convert proofs via base64ToFields (inline, copied verbatim)
    //   6. Call process_game with the same argument format
    // ================================================================
    console.log('\n=== Phase 5: Settlement via frontend code path ===');

    // 5a. Load circuit artifacts via frontend circuitLoader
    // (mirrors useGameContract.ts lines 122-129)
    console.log('  Loading circuit artifacts via frontend circuitLoader...');
    const [handCircuit, moveCircuit] = await Promise.all([
      loadProveHandCircuit(),
      loadGameMoveCircuit(),
    ]);

    // 5b. Create UltraHonkBackend using frontend's barretenberg singleton
    // (mirrors useGameContract.ts lines 131-133)
    console.log('  Creating UltraHonkBackend via frontend getBarretenberg()...');
    const frontendApi = await getBarretenberg();
    const handBackend = new UltraHonkBackend(handCircuit.bytecode, frontendApi);
    const moveBackend = new UltraHonkBackend(moveCircuit.bytecode, frontendApi);

    // 5c. Extract VKs exactly as the frontend does
    // (mirrors useGameContract.ts lines 135-138)
    // CRITICAL: Frontend calls getVerificationKey() WITHOUT { verifierTarget: 'noir-recursive' }
    // The deployment used computeVkHash which calls getVerificationKey({ verifierTarget: 'noir-recursive' })
    // If these produce different VKs, this test catches the bug.
    console.log('  Extracting VKs via frontend getVerificationKey()...');
    const [frontendHandVk, frontendMoveVk] = await Promise.all([
      handBackend.getVerificationKey(),
      moveBackend.getVerificationKey(),
    ]);

    // 5d. Convert VKs to field arrays
    // (mirrors useGameContract.ts lines 158-166, inline vkToFields)
    const frontendHandVkFields = vkToFields(frontendHandVk);
    const frontendMoveVkFields = vkToFields(frontendMoveVk);
    console.log(`  Frontend hand VK: ${frontendHandVkFields.length} fields`);
    console.log(`  Frontend move VK: ${frontendMoveVkFields.length} fields`);

    // 5e. VERIFY: Frontend VK fields hash to the same VK hash stored on-chain
    // This is the key compatibility check between deployment and settlement
    console.log('  Verifying frontend VK compatibility with deployed VK hash...');

    // Compute poseidon2 hash of frontend-extracted VK fields (same as computeVkHash internals)
    function bigintToBuffer32(n: bigint): Buffer {
      const hex = n.toString(16).padStart(64, '0');
      return Buffer.from(hex, 'hex');
    }
    function bufferToHex(buf: any): string {
      if (Buffer.isBuffer(buf)) return '0x' + buf.toString('hex').padStart(64, '0');
      if (buf instanceof Uint8Array) return '0x' + Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
      return '0x' + String(buf);
    }

    const handVkInputBuffers = frontendHandVkFields.map((f: string) => bigintToBuffer32(BigInt(f)));
    const handVkHashResult = await (deployApi as any).poseidon2Hash({ inputs: handVkInputBuffers });
    const frontendHandVkHash = bufferToHex(handVkHashResult.hash);
    console.log(`  Frontend hand VK hash: ${frontendHandVkHash}`);
    console.log(`  Deployed hand VK hash: ${deployedHandVkHash}`);
    expect(BigInt(frontendHandVkHash)).toBe(BigInt(deployedHandVkHash));
    console.log('  Hand VK hashes MATCH!');

    const moveVkInputBuffers = frontendMoveVkFields.map((f: string) => bigintToBuffer32(BigInt(f)));
    const moveVkHashResult = await (deployApi as any).poseidon2Hash({ inputs: moveVkInputBuffers });
    const frontendMoveVkHash = bufferToHex(moveVkHashResult.hash);
    console.log(`  Frontend move VK hash: ${frontendMoveVkHash}`);
    console.log(`  Deployed move VK hash: ${deployedMoveVkHash}`);
    expect(BigInt(frontendMoveVkHash)).toBe(BigInt(deployedMoveVkHash));
    console.log('  Move VK hashes MATCH!');

    // 5f. Convert proofs from base64 to field arrays
    // (mirrors useGameContract.ts lines 141-155, inline base64ToFields)
    const hp1ProofFields = frontendBase64ToFields(handProof1.proof);
    const hp2ProofFields = frontendBase64ToFields(handProof2.proof);
    const moveProofFieldArrays = allMoveProofs.map(mp => frontendBase64ToFields(mp.proof));

    console.log(`  Hand proof 1: ${hp1ProofFields.length} proof fields`);
    console.log(`  Hand proof 2: ${hp2ProofFields.length} proof fields`);
    expect(hp1ProofFields.length).toBe(500);
    expect(hp2ProofFields.length).toBe(500);

    // 5g. Determine caller/opponent (mirrors App.tsx handleSettle lines 139-158)
    const winner = localState.winner;
    expect(winner).not.toBeNull();
    console.log(`  Game result: ${winner}`);

    const isP1Winner = winner === 'player1';
    const isDraw = winner === 'draw';
    const callerAddr = isDraw ? p1Addr : (isP1Winner ? p1Addr : p2Addr);
    const opponentAddr = isDraw ? p2Addr : (isP1Winner ? p2Addr : p1Addr);
    const callerCardIds = isDraw ? p1CardIds : (isP1Winner ? p1CardIds : p2CardIds);
    const opponentCardIds = isDraw ? p2CardIds : (isP1Winner ? p2CardIds : p1CardIds);
    const cardToTransfer = isDraw ? 0 : opponentCardIds[0];

    // Hand proof ordering: handProof1 is ALWAYS P1's, handProof2 is ALWAYS P2's
    // (mirrors App.tsx handleSettle lines 142-143)
    // In the frontend: handProof1 = playerNumber===1 ? myHandProof : opponentHandProof

    // 5h. Call process_game using the FRONTEND's argument format
    // (mirrors useGameContract.ts lines 203-220)
    //
    // The frontend uses:
    //   - frontendHandVkFields/frontendMoveVkFields (string[], NOT Fr[])
    //   - hp1ProofFields/hp2ProofFields (string[] from base64ToFields)
    //   - handProof.publicInputs (string[] from noir_js, NOT Fr[])
    //   - ...moveProofs.flatMap((mp, i) => [moveProofFields[i], mp.publicInputs])
    //
    // We pass these as string[] — the Aztec SDK converts to Fr internally.
    console.log('  Calling process_game with frontend-derived VKs and proofs...');
    const gameId = new Fr(0n);
    await gameContract.methods
      .process_game(
        gameId,
        frontendHandVkFields,       // Frontend-extracted VK (string[])
        frontendMoveVkFields,       // Frontend-extracted VK (string[])
        hp1ProofFields,             // Frontend base64ToFields (string[])
        handProof1.publicInputs,    // Raw noir_js output (string[])
        hp2ProofFields,
        handProof2.publicInputs,
        // 9 move proofs + inputs, spread via flatMap
        // (mirrors useGameContract.ts lines 210-213)
        ...allMoveProofs.flatMap((mp, idx) => [
          moveProofFieldArrays[idx],  // proof fields (string[])
          mp.publicInputs,            // public inputs (string[])
        ]),
        opponentAddr,
        new Fr(BigInt(cardToTransfer)),
        callerCardIds.map((id: number) => new Fr(BigInt(id))),
        opponentCardIds.map((id: number) => new Fr(BigInt(id))),
      )
      .send(sendAs(callerAddr));
    console.log('  process_game transaction succeeded!');

    // Clean up settlement backends (mirrors useGameContract.ts lines 228-229)
    try { handBackend.destroy(); } catch { /* ignore */ }
    try { moveBackend.destroy(); } catch { /* ignore */ }

    // ================================================================
    // Phase 6: Verify on-chain settlement
    // ================================================================
    console.log('\n=== Phase 6: Verify on-chain settlement ===');

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

    console.log('\n  === E2E Full Game Flow Test PASSED ===');
    console.log('  What was proven:');
    console.log('    1. Frontend proofWorker produces valid ZK proofs');
    console.log('    2. Frontend card commitments match on-chain values');
    console.log('    3. WebSocket protocol works (CREATE/JOIN/HAND_PROOF/MOVE_PROOF)');
    console.log('    4. Hand proof relay carries real proof data between clients');
    console.log('    5. Move proof relay + server-side move application works');
    console.log('    6. Proof chain integrity holds (endStateHash[i] == startStateHash[i+1])');
    console.log('    7. Frontend circuitLoader loads artifacts correctly');
    console.log('    8. Frontend getVerificationKey() VKs match deployed VK hashes');
    console.log('    9. Frontend base64ToFields/vkToFields produce correct field arrays');
    console.log('   10. Frontend flatMap proof spread matches process_game ABI');
    console.log('   11. All 11 proofs pass recursive verification in process_game');
    console.log('   12. Game lifecycle: status 1 → 2 → 3 (created → active → settled)');
  }, 600_000);
});
