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
 *   - App.tsx: handlePlaceCard (local sim -> encode -> proof -> submit),
 *     hand proof auto-submit, opponent proof collection
 *   - useWebSocket.ts: moveNumber derivation from board state
 *   - Backend createServer: real WebSocket relay
 *   - Aztec contracts: real deployment + settlement
 *
 * Note sync: Uses the same import_note pattern as the frontend.
 * Game ID / randomness: Derived IN-CIRCUIT, previewed via simulate().
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

const originalFetch = globalThis.fetch;

vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
  const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
  const artifactMap: Record<string, string> = {
    '/circuits/prove_hand.json': resolve(rootDir, 'circuits/target/prove_hand.json'),
    '/circuits/game_move.json': resolve(rootDir, 'circuits/target/game_move.json'),
    '/contracts/triple_triad_game-TripleTriadGame.json': resolve(rootDir, 'packages/contracts/target/triple_triad_game-TripleTriadGame.json'),
    '/contracts/triple_triad_nft-TripleTriadNFT.json': resolve(rootDir, 'packages/contracts/target/triple_triad_nft-TripleTriadNFT.json'),
  };
  const filePath = artifactMap[urlStr];
  if (filePath) {
    const raw = readFileSync(filePath, 'utf-8');
    return { ok: true, status: 200, json: async () => JSON.parse(raw) } as Response;
  }
  return originalFetch(url, init);
});

// ============================================================================
// Frontend source code under test
// ============================================================================

import {
  computeCardCommitPoseidon2,
  computePlayerStateHash,
  generateProveHandProof,
  generateGameMoveProof,
  destroyBackendCache,
} from '../../frontend/src/aztec/proofWorker';

import {
  loadProveHandCircuit,
  loadGameMoveCircuit,
} from '../../frontend/src/aztec/circuitLoader';

import {
  getBarretenberg,
  destroyBarretenberg,
} from '../../frontend/src/aztec/proofBackend';

import { encodeBoardState } from '../../frontend/src/hooks/useProofGeneration';

import type { HandProofData, MoveProofData } from '../../frontend/src/types';

// ============================================================================
// Backend server
// ============================================================================

import { createServer } from '@aztec-triple-triad/backend';
import type { TripleTriadServer } from '@aztec-triple-triad/backend';

// ============================================================================
// Game logic
// ============================================================================

import {
  createGame,
  placeCard,
  getCardsByIds,
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

import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';

// ============================================================================
// E2E helpers (only for contract deployment VK hashes)
// ============================================================================

import {
  loadContractArtifact,
  computeVkHash,
} from './e2e-helpers.js';

// ============================================================================
// Configuration
// ============================================================================

const PXE_URL = process.env.AZTEC_PXE_URL || 'http://localhost:8080';
const SEND_TIMEOUT = 300;

// ============================================================================
// Helpers
// ============================================================================

/** Safe string-to-Fr conversion: handles both hex and decimal strings */
function toFr(s: string | any): any {
  if (s instanceof Fr) return s;
  const str = s.toString();
  if (str.startsWith('0x') || str.startsWith('0X')) return Fr.fromHexString(str);
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
 * Required because create_and_push_note skips on-chain tagging.
 */
async function importNotes(
  nftContract: any,
  node: any,
  txHash: any,
  owner: any,
  cardIds: number[],
  randomnessFrs: any[],
) {
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
        .import_note(owner, new Fr(BigInt(cardIds[i])), randomnessFrs[i], txHashFr, paddedHashes, uniqueNoteHashes.length, firstNullFr, owner)
        .simulate({ from: owner });
      console.log(`  Imported note for card ${cardIds[i]}`);
    } catch (err: any) {
      console.warn(`  Failed to import note for card ${cardIds[i]}:`, err?.message?.slice(0, 120));
    }
  }
}

/** Convert base64-encoded proof to field element hex strings. */
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

/** Convert VK Uint8Array to field element hex strings. */
function vkToFields(vk: Uint8Array): string[] {
  const fields: string[] = [];
  for (let i = 0; i < vk.length; i += 32) {
    const chunk = vk.slice(i, i + 32);
    const hex = '0x' + Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join('');
    fields.push(hex);
  }
  return fields;
}

function mapWinnerId(winner: 'player1' | 'player2' | 'draw' | null): number {
  if (winner === null) return 0;
  if (winner === 'player1') return 1;
  if (winner === 'player2') return 2;
  return 3;
}

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
// TestWSClient
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
    if (idx !== -1) return this.buffer.splice(idx, 1)[0];
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

describe('E2E Full Game Flow -- Frontend Proofs + WebSocket + Aztec Settlement', () => {
  let server: TripleTriadServer;
  let wsUrl: string;
  let client1: TestWSClient;
  let client2: TestWSClient;

  let wallet: any;
  let node: any;
  let fee: any;
  let deployerAddr: any;
  let p1Addr: any;
  let p2Addr: any;
  let nftContract: any;
  let gameContract: any;

  let deployApi: Barretenberg;
  let deployedHandVkHash: string;
  let deployedMoveVkHash: string;

  const p1CardIds = [1, 2, 3, 4, 5];
  const p2CardIds = [1, 2, 3, 4, 5]; // Both players use starter cards
  let p1BlindingHex: string;
  let p2BlindingHex: string;
  let p1CardCommit: string;
  let p2CardCommit: string;
  let p1Randomness: string[];
  let p2Randomness: string[];
  let gameIdHex: string;

  let wsGameId: string;

  const sendAs = (addr: any) => ({
    from: addr,
    fee: { paymentMethod: fee },
    wait: { timeout: SEND_TIMEOUT },
  });

  beforeAll(async () => {
    // ================================================================
    // Step 1: Start WebSocket server
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
    // Step 2: Connect to Aztec, create wallet, deploy accounts
    // ================================================================
    console.log(`Connecting to Aztec node at ${PXE_URL}...`);
    node = createAztecNodeClient(PXE_URL);

    console.log('Creating EmbeddedWallet...');
    wallet = await EmbeddedWallet.create(node, { ephemeral: true });
    await new Promise(r => setTimeout(r, 5000));

    console.log('Registering SponsoredFPC contract...');
    const sponsoredFPCContract = await getSponsoredFPCContract();
    await wallet.registerContract(sponsoredFPCContract, SponsoredFPCContractArtifact);
    fee = new SponsoredFeePaymentMethod(sponsoredFPCContract.address);

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
            console.log(`  ${label} deploy retry in 5s...`);
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          throw err;
        }
      }
    }

    console.log('Creating accounts...');
    const deployerAccount = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await deployAccount(deployerAccount, 'Deployer');
    deployerAddr = deployerAccount.address;
    await wallet.registerSender(deployerAddr, 'deployer');

    const player1Account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await deployAccount(player1Account, 'Player1');
    p1Addr = player1Account.address;
    await wallet.registerSender(p1Addr, 'player1');

    const player2Account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
    await deployAccount(player2Account, 'Player2');
    p2Addr = player2Account.address;
    await wallet.registerSender(p2Addr, 'player2');

    console.log(`  Deployer: ${deployerAddr}`);
    console.log(`  Player 1: ${p1Addr}`);
    console.log(`  Player 2: ${p2Addr}`);

    // ================================================================
    // Step 3: Compute VK hashes for contract deployment
    // ================================================================
    console.log('Initializing Barretenberg for deployment VK hashes...');
    deployApi = await Barretenberg.new({ threads: 1 });

    const proveHandArtifact = JSON.parse(
      readFileSync(resolve(rootDir, 'circuits/target/prove_hand.json'), 'utf-8'),
    );
    const gameMoveArtifact = JSON.parse(
      readFileSync(resolve(rootDir, 'circuits/target/game_move.json'), 'utf-8'),
    );

    const handVk = await computeVkHash(deployApi, proveHandArtifact.bytecode);
    const moveVk = await computeVkHash(deployApi, gameMoveArtifact.bytecode);
    deployedHandVkHash = handVk.hash;
    deployedMoveVkHash = moveVk.hash;
    console.log(`  hand_vk_hash: ${deployedHandVkHash}`);
    console.log(`  move_vk_hash: ${deployedMoveVkHash}`);

    // ================================================================
    // Step 4: Deploy contracts
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

    // ================================================================
    // Step 5: Mint cards to players using get_cards_for_new_player
    // (same flow as frontend useAztec.ts)
    // ================================================================
    console.log('Minting cards to players...');

    // Player 1: get_cards_for_new_player (creates starter cards [1-5] + note_nonce)
    console.log('  Player 1: calling get_cards_for_new_player...');
    const p1MintReceipt = await nftContract.methods
      .get_cards_for_new_player()
      .send(sendAs(p1Addr));

    // Import P1 starter notes (create_and_push_note skips tagging)
    {
      const randomnessResult = await nftContract.methods
        .compute_note_randomness(0, 5)
        .simulate({ from: p1Addr });
      const randomnessFrs = [];
      for (let i = 0; i < 5; i++) randomnessFrs.push(toFr(randomnessResult[i]));
      await importNotes(nftContract, node, p1MintReceipt.txHash, p1Addr, p1CardIds, randomnessFrs);
    }

    // Verify P1 notes
    const [p1Cards] = await nftContract.methods
      .get_private_cards(p1Addr, 0)
      .simulate({ from: p1Addr });
    const p1Count = p1Cards.filter((v: any) => BigInt(v) !== 0n).length;
    console.log(`  Player 1: ${p1Count} notes visible`);
    if (p1Count < 5) throw new Error(`P1 note import failed: ${p1Count}/5`);

    // Player 2: also use get_cards_for_new_player (same flow as P1)
    // This mints starter cards [1,2,3,4,5] AND creates the note_nonce
    console.log('  Player 2: calling get_cards_for_new_player...');
    const p2MintReceipt = await nftContract.methods
      .get_cards_for_new_player()
      .send(sendAs(p2Addr));

    // Import P2 starter notes
    {
      const randomnessResult = await nftContract.methods
        .compute_note_randomness(0, 5)
        .simulate({ from: p2Addr });
      const randomnessFrs = [];
      for (let i = 0; i < 5; i++) randomnessFrs.push(toFr(randomnessResult[i]));
      await importNotes(nftContract, node, p2MintReceipt.txHash, p2Addr, p2CardIds, randomnessFrs);
    }

    // Verify P2 notes
    const [p2c] = await nftContract.methods
      .get_private_cards(p2Addr, 0)
      .simulate({ from: p2Addr });
    const p2Count = p2c.filter((v: any) => BigInt(v) !== 0n).length;
    console.log(`  Player 2: ${p2Count} notes visible after import`);
    if (p2Count < 5) throw new Error(`P2 note import failed: ${p2Count}/5`);

    // ================================================================
    // Step 6: Preview game data + create/join game on-chain
    // (game_id and randomness derived IN-CIRCUIT)
    // ================================================================
    console.log('Player 1: previewing game data...');
    const p1Nonce = await nftContract.methods
      .get_note_nonce(p1Addr)
      .simulate({ from: p1Addr });
    const p1Preview = await nftContract.methods
      .preview_game_data(toFr(p1Nonce))
      .simulate({ from: p1Addr });
    gameIdHex = toHex(p1Preview[0]);
    p1Randomness = Array.from({ length: 6 }, (_, i) => toHex(p1Preview[i + 1]));
    console.log(`  Derived game_id: ${gameIdHex}`);

    console.log('Player 1 creating game on-chain...');
    await gameContract.methods
      .create_game(p1CardIds.map((id: number) => new Fr(BigInt(id))))
      .send(sendAs(p1Addr));

    const gameIdFr = toFr(gameIdHex);
    let status = await gameContract.methods
      .get_game_status(gameIdFr)
      .simulate({ from: deployerAddr });
    expect(BigInt(status)).toBe(1n);
    console.log('  Game created (status=1)');

    // Preview P2 game data (for randomness)
    console.log('Player 2: previewing game data...');
    const p2Nonce = await nftContract.methods
      .get_note_nonce(p2Addr)
      .simulate({ from: p2Addr });
    const p2Preview = await nftContract.methods
      .preview_game_data(toFr(p2Nonce))
      .simulate({ from: p2Addr });
    p2Randomness = Array.from({ length: 6 }, (_, i) => toHex(p2Preview[i + 1]));

    console.log('Player 2 joining game on-chain...');
    await gameContract.methods
      .join_game(gameIdFr, p2CardIds.map((id: number) => new Fr(BigInt(id))))
      .send(sendAs(p2Addr));

    status = await gameContract.methods
      .get_game_status(gameIdFr)
      .simulate({ from: deployerAddr });
    expect(BigInt(status)).toBe(2n);
    console.log('  Game active (status=2)');

    // Read on-chain card commits
    const onChainCC1 = await gameContract.methods
      .get_game_card_commit_1(gameIdFr)
      .simulate({ from: deployerAddr });
    const onChainCC2 = await gameContract.methods
      .get_game_card_commit_2(gameIdFr)
      .simulate({ from: deployerAddr });
    console.log(`  On-chain card_commit_1: ${onChainCC1}`);
    console.log(`  On-chain card_commit_2: ${onChainCC2}`);

    // Derive blinding factors (with game_id)
    console.log('Deriving blinding factors...');
    const p1Blinding = await nftContract.methods
      .compute_blinding_factor(gameIdFr)
      .simulate({ from: p1Addr });
    const p2Blinding = await nftContract.methods
      .compute_blinding_factor(gameIdFr)
      .simulate({ from: p2Addr });
    p1BlindingHex = '0x' + BigInt(p1Blinding).toString(16).padStart(64, '0');
    p2BlindingHex = '0x' + BigInt(p2Blinding).toString(16).padStart(64, '0');

    // Compute card commits using FRONTEND proofWorker
    p1CardCommit = await computeCardCommitPoseidon2(p1CardIds, p1BlindingHex);
    p2CardCommit = await computeCardCommitPoseidon2(p2CardIds, p2BlindingHex);
    console.log(`  Frontend card_commit_1: ${p1CardCommit}`);
    console.log(`  Frontend card_commit_2: ${p2CardCommit}`);

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
    // ================================================================
    console.log('\n=== Phase 1: WebSocket game creation ===');

    client1 = await connectClient(wsUrl);
    client2 = await connectClient(wsUrl);

    client1.send({ type: 'CREATE_GAME', cardIds: p1CardIds });
    const created = await client1.waitFor('GAME_CREATED');
    wsGameId = created.gameId;
    console.log(`  Game created on WebSocket: ${wsGameId}`);

    client2.send({ type: 'JOIN_GAME', gameId: wsGameId, cardIds: p2CardIds });
    const joined = await client2.waitFor('GAME_JOINED');
    const gameStart = await client1.waitFor('GAME_START');
    expect(joined.playerNumber).toBe(2);
    expect(joined.gameState.status).toBe('playing');
    expect(gameStart.gameState.status).toBe('playing');
    console.log('  Both players connected, game started');

    // ================================================================
    // Phase 2: Hand proof generation & exchange
    // (mirrors useGameFlow.ts: generate hand proof with opponent randomness)
    // ================================================================
    console.log('\n=== Phase 2: Hand proof generation (frontend proofWorker) ===');

    // Compute opponent player_state_hashes for hand proofs
    const p2StateHash = await computePlayerStateHash(p2Randomness);
    const p1StateHash = await computePlayerStateHash(p1Randomness);

    console.log('  Generating hand proof 1 (P1 proves hand + knowledge of P2 randomness)...');
    const proofStart = Date.now();
    const handProof1 = await generateProveHandProof(
      p1CardIds, p1BlindingHex, p1CardCommit,
      p2Randomness, p2StateHash,
    );
    console.log(`  Hand proof 1 generated in ${((Date.now() - proofStart) / 1000).toFixed(1)}s`);

    console.log('  Generating hand proof 2 (P2 proves hand + knowledge of P1 randomness)...');
    const proofStart2 = Date.now();
    const handProof2 = await generateProveHandProof(
      p2CardIds, p2BlindingHex, p2CardCommit,
      p1Randomness, p1StateHash,
    );
    console.log(`  Hand proof 2 generated in ${((Date.now() - proofStart2) / 1000).toFixed(1)}s`);

    // Exchange hand proofs via WebSocket
    console.log('  Exchanging hand proofs via WebSocket...');
    client1.send({ type: 'SUBMIT_HAND_PROOF', gameId: wsGameId, handProof: handProof1 });
    const p2ReceivedProof = await client2.waitFor('HAND_PROOF');
    expect(p2ReceivedProof.fromPlayer).toBe(1);

    client2.send({ type: 'SUBMIT_HAND_PROOF', gameId: wsGameId, handProof: handProof2 });
    const p1ReceivedProof = await client1.waitFor('HAND_PROOF');
    expect(p1ReceivedProof.fromPlayer).toBe(2);
    console.log('  Hand proofs exchanged successfully');

    // ================================================================
    // Phase 3: Play 9 moves with real proof generation
    // ================================================================
    console.log('\n=== Phase 3: Play 9 moves (frontend proof generation) ===');

    const moves: [Player, number, number, number][] = [
      ['player1', 0, 0, 0],
      ['player2', 0, 0, 2],
      ['player1', 0, 0, 1],
      ['player2', 0, 1, 0],
      ['player1', 0, 1, 2],
      ['player2', 0, 1, 1],
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

      const boardBefore = encodeBoardState(localState.board);
      const moveNumber = deriveMoveNumber(localState);
      const result = placeCard(localState, player, handIdx, row, col);
      const newState = result.newState;
      const boardAfter = encodeBoardState(newState.board);
      const gameEnded = newState.status === 'finished';
      const winnerId = mapWinnerId(newState.winner);

      const moveStart = Date.now();
      const moveProof = await generateGameMoveProof(
        card.id, row, col, currentPlayer,
        boardBefore, boardAfter,
        [localState.player1Score, localState.player2Score],
        [newState.player1Score, newState.player2Score],
        p1CardCommit, p2CardCommit,
        gameEnded, winnerId,
        { cardIds: isP1 ? p1CardIds : p2CardIds, blindingFactor: isP1 ? p1BlindingHex : p2BlindingHex },
      );
      console.log(`    Proof generated in ${((Date.now() - moveStart) / 1000).toFixed(1)}s`);

      allMoveProofs.push(moveProof);

      activeClient.send({
        type: 'SUBMIT_MOVE_PROOF', gameId: wsGameId,
        handIndex: handIdx, row, col, moveNumber, moveProof,
      });

      await activeClient.waitFor('GAME_STATE');
      await passiveClient.waitFor('MOVE_PROVEN');

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
    console.log('  Proof chain valid');

    // ================================================================
    // Phase 5: On-chain settlement using FRONTEND's exact code path
    // ================================================================
    console.log('\n=== Phase 5: Settlement via frontend code path ===');

    console.log('  Loading circuit artifacts via frontend circuitLoader...');
    const [handCircuit, moveCircuit] = await Promise.all([
      loadProveHandCircuit(),
      loadGameMoveCircuit(),
    ]);

    console.log('  Creating UltraHonkBackend via frontend getBarretenberg()...');
    const frontendApi = await getBarretenberg();
    const handBackend = new UltraHonkBackend(handCircuit.bytecode, frontendApi);
    const moveBackend = new UltraHonkBackend(moveCircuit.bytecode, frontendApi);

    console.log('  Extracting VKs...');
    const [frontendHandVk, frontendMoveVk] = await Promise.all([
      handBackend.getVerificationKey({ verifierTarget: 'noir-recursive' }),
      moveBackend.getVerificationKey({ verifierTarget: 'noir-recursive' }),
    ]);

    const frontendHandVkFields = vkToFields(frontendHandVk);
    const frontendMoveVkFields = vkToFields(frontendMoveVk);

    // Convert proofs
    const hp1ProofFields = frontendBase64ToFields(handProof1.proof);
    const hp2ProofFields = frontendBase64ToFields(handProof2.proof);
    const moveProofFieldArrays = allMoveProofs.map(mp => frontendBase64ToFields(mp.proof));

    expect(hp1ProofFields.length).toBe(500);
    expect(hp2ProofFields.length).toBe(500);

    // Determine caller/opponent
    const winner = localState.winner;
    const isP1Winner = winner === 'player1';
    const isDraw = winner === 'draw';
    const callerAddr = isDraw ? p1Addr : (isP1Winner ? p1Addr : p2Addr);
    const opponentAddr = isDraw ? p2Addr : (isP1Winner ? p2Addr : p1Addr);
    const callerCardIds = isDraw ? p1CardIds : (isP1Winner ? p1CardIds : p2CardIds);
    const opponentCardIds = isDraw ? p2CardIds : (isP1Winner ? p2CardIds : p1CardIds);
    const cardToTransfer = isDraw ? 0 : opponentCardIds[0];

    // Use in-circuit derived randomness for settlement
    const callerRandomnessHex = isP1Winner || isDraw ? p1Randomness : p2Randomness;
    const opponentRandomnessHex = isP1Winner || isDraw ? p2Randomness : p1Randomness;
    const callerRandomness = callerRandomnessHex.map(toFr);
    const opponentRandomness = opponentRandomnessHex.map(toFr);

    const gameIdFr = toFr(gameIdHex);

    console.log('  Calling process_game...');
    const settlementResult = await gameContract.methods
      .process_game(
        gameIdFr,
        frontendHandVkFields,
        frontendMoveVkFields,
        hp1ProofFields,
        handProof1.publicInputs,
        hp2ProofFields,
        handProof2.publicInputs,
        ...allMoveProofs.flatMap((mp, idx) => [
          moveProofFieldArrays[idx],
          mp.publicInputs,
        ]),
        opponentAddr,
        new Fr(BigInt(cardToTransfer)),
        callerCardIds.map((id: number) => new Fr(BigInt(id))),
        opponentCardIds.map((id: number) => new Fr(BigInt(id))),
        callerRandomness,
        opponentRandomness,
      )
      .send(sendAs(callerAddr));
    console.log('  process_game transaction succeeded!');

    try { handBackend.destroy(); } catch { /* ignore */ }
    try { moveBackend.destroy(); } catch { /* ignore */ }

    // ================================================================
    // Phase 6: Import settlement notes and verify
    // ================================================================
    console.log('\n=== Phase 6: Verify on-chain settlement ===');

    const finalStatus = await gameContract.methods
      .get_game_status(gameIdFr)
      .simulate({ from: deployerAddr });
    expect(BigInt(finalStatus)).toBe(3n);
    console.log(`  Game status: ${finalStatus} (settled)`);

    const isSettled = await gameContract.methods
      .is_game_settled(gameIdFr)
      .simulate({ from: deployerAddr });
    expect(isSettled).toBe(true);
    console.log('  Game settled: true');

    // Import settlement notes
    const winnerAddr = callerAddr;
    const loserAddr = opponentAddr;

    if (!isDraw) {
      const winnerTokenIds = [...callerCardIds, cardToTransfer];
      const winnerRand = callerRandomness.slice(0, winnerTokenIds.length);
      await importNotes(nftContract, node, settlementResult.txHash, winnerAddr, winnerTokenIds, winnerRand);

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
      await importNotes(nftContract, node, settlementResult.txHash, loserAddr, loserTokenIds, loserRand);
    }

    console.log('\n  === E2E Full Game Flow Test PASSED ===');
  }, 600_000);
});
