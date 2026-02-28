/**
 * Shared helpers for E2E Aztec contract tests.
 *
 * Extracted from scripts/e2e-contract-test.ts to avoid duplication.
 * These utilities handle proof generation, VK hashing, state hashing,
 * and contract artifact loading for integration with Aztec smart contracts.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import type { Barretenberg, UltraHonkBackend as UltraHonkBackendType } from '@aztec/bb.js';
import type { Noir as NoirType } from '@noir-lang/noir_js';
import {
  createGame,
  placeCard,
  getCardsByIds,
  CARD_DATABASE,
} from '@aztec-triple-triad/game-logic';
import type { GameState, Card, Player } from '@aztec-triple-triad/game-logic';

// Re-export game-logic types for convenience
export type { GameState, Card, Player };

// ============================================================================
// Types
// ============================================================================

export interface GeneratedProof {
  proofFields: string[];   // 508 Field elements (hex strings)
  publicInputs: string[];
}

export interface GameProofs {
  handProof1: GeneratedProof;
  handProof2: GeneratedProof;
  moveProofs: GeneratedProof[];   // 9 move proofs
  moveInputs: string[][];         // 9 × 6 public inputs
  winner: Player | 'draw' | null;
  finalState: GameState;
}

// ============================================================================
// Artifact Loaders
// ============================================================================

/** Root dir: assumes running from packages/integration or monorepo root. */
function findRootDir(): string {
  // Try common locations
  const candidates = [
    resolve(process.cwd(), '../..'),          // from packages/integration
    resolve(process.cwd()),                   // from monorepo root
    resolve(import.meta.url.replace('file://', ''), '../../../../'), // relative to this file
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(resolve(candidate, 'package.json'), 'utf-8');
      // Check it's the monorepo root (has packages dir)
      readFileSync(resolve(candidate, 'packages/integration/package.json'), 'utf-8');
      return candidate;
    } catch {
      continue;
    }
  }
  // Fallback: assume 2 levels up from cwd
  return resolve(process.cwd(), '../..');
}

let _rootDir: string | null = null;
function getRootDir(): string {
  if (!_rootDir) _rootDir = findRootDir();
  return _rootDir;
}

export function loadContractArtifact(name: string): any {
  const { loadContractArtifact: sdkLoad } = require('@aztec/aztec.js/abi');
  const path = resolve(getRootDir(), `packages/contracts/target/${name}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  // Use SDK's loadContractArtifact to transform raw nargo output into proper ContractArtifact
  // The raw JSON has fn.abi.parameters, but the SDK expects fn.parameters at top level
  return sdkLoad(raw);
}

export function loadCircuitArtifact(name: string): any {
  const path = resolve(getRootDir(), `circuits/target/${name}.json`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

// ============================================================================
// Proof Helpers
// ============================================================================

/** Convert raw bytes to 32-byte big-endian Field element hex strings. */
export function bytesToFields(bytes: Uint8Array): string[] {
  const numFields = Math.floor(bytes.length / 32);
  const fields: string[] = [];
  for (let i = 0; i < numFields; i++) {
    const chunk = bytes.slice(i * 32, (i + 1) * 32);
    let hex = '0x';
    for (let j = 0; j < chunk.length; j++) {
      hex += chunk[j].toString(16).padStart(2, '0');
    }
    fields.push(hex);
  }
  return fields;
}

/** Convert a bigint to a 32-byte big-endian Buffer. */
function bigintToBuffer32(n: bigint): Buffer {
  const hex = n.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

/** Convert a Buffer/Uint8Array to a 0x-prefixed hex string. */
function bufferToHex(buf: Buffer | Uint8Array | any): string {
  if (Buffer.isBuffer(buf)) {
    return '0x' + buf.toString('hex').padStart(64, '0');
  }
  if (buf instanceof Uint8Array || (buf && typeof buf.length === 'number')) {
    const arr = Array.from(buf as Uint8Array);
    return '0x' + arr.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback: if it's a bigint or has toString(16)
  if (typeof buf === 'bigint') {
    return '0x' + buf.toString(16).padStart(64, '0');
  }
  return '0x' + String(buf);
}

/** Compute the VK hash matching bb_proof_verification internals. */
export async function computeVkHash(
  api: Barretenberg,
  circuitBytecode: string,
): Promise<{ hash: string; fields: string[] }> {
  const { UltraHonkBackend } = await import('@aztec/bb.js');
  const backend = new UltraHonkBackend(circuitBytecode, api);
  const vkBytes = await backend.getVerificationKey({ verifierTarget: 'noir-recursive' });
  const vkFields = bytesToFields(vkBytes);

  if (typeof (api as any).poseidon2Hash !== 'function') {
    throw new Error('Barretenberg API does not expose poseidon2Hash');
  }

  const inputBuffers = vkFields.map((f) => bigintToBuffer32(BigInt(f)));
  const result = await (api as any).poseidon2Hash({ inputs: inputBuffers });
  const hash = bufferToHex(result.hash);

  return { hash, fields: vkFields };
}

/** Convert game state to the flat 21-field hash input: [board(18), scores(2), turn(1)]. */
export function stateToHashInput(state: GameState): bigint[] {
  const fields: bigint[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cell = state.board[r][c];
      if (cell.card && cell.owner) {
        fields.push(BigInt(cell.card.id));
        fields.push(cell.owner === 'player1' ? 1n : 2n);
      } else {
        fields.push(0n);
        fields.push(0n);
      }
    }
  }
  fields.push(BigInt(state.player1Score));
  fields.push(BigInt(state.player2Score));
  fields.push(state.currentTurn === 'player1' ? 1n : 2n);
  return fields;
}

/** Compute pedersen hash of state (matching the Noir contract's computation). */
export async function computeStateHash(api: Barretenberg, state: GameState): Promise<string> {
  const input = stateToHashInput(state);
  const inputBuffers = input.map(bigintToBuffer32);
  const result = await (api as any).pedersenHash({ inputs: inputBuffers, hashIndex: 0 });
  return bufferToHex(result.hash);
}

/** Compute card commitment: poseidon2_hash([card_ids[0..5], blinding_factor]). */
export async function computeCardCommit(
  api: Barretenberg,
  cardIds: number[],
  blindingFactor: bigint,
): Promise<string> {
  if (cardIds.length !== 5) throw new Error('Expected 5 card IDs');
  const fields = [...cardIds.map(id => BigInt(id)), blindingFactor];
  const inputBuffers = fields.map(bigintToBuffer32);
  const result = await (api as any).poseidon2Hash({ inputs: inputBuffers });
  return bufferToHex(result.hash);
}

/** Pack card ranks for NFT minting: top + right*16 + bottom*256 + left*4096 */
export function packRanks(top: number, right: number, bottom: number, left: number): number {
  return top + right * 16 + bottom * 256 + left * 4096;
}

// ============================================================================
// Proof Generation Engine
// ============================================================================

/**
 * Simulate a full game between two players and generate all ZK proofs.
 *
 * This is the core proof generation engine. It:
 * 1. Creates the game state using game-logic
 * 2. Generates 2 hand proofs (one per player)
 * 3. Simulates 9 moves, generating a move proof for each
 * 4. Returns all proofs in contract-ready format
 */
export async function generateFullGameProofs(
  api: Barretenberg,
  proveHandArtifact: any,
  gameMoveArtifact: any,
  p1CardIds: number[],
  p2CardIds: number[],
  p1BlindingFactor: string,
  p2BlindingFactor: string,
  p1CardCommit: string,
  p2CardCommit: string,
): Promise<GameProofs> {
  const { UltraHonkBackend } = await import('@aztec/bb.js');
  const { Noir } = await import('@noir-lang/noir_js');

  const handBackend = new UltraHonkBackend(proveHandArtifact.bytecode, api);
  const moveBackend = new UltraHonkBackend(gameMoveArtifact.bytecode, api);
  const noirHand = new Noir(proveHandArtifact);
  const noirMove = new Noir(gameMoveArtifact);

  // --- Generate hand proofs ---
  console.log('    Generating hand proof 1...');
  const hp1Witness = await noirHand.execute({
    card_commit_hash: p1CardCommit,
    card_ids: p1CardIds.map(String),
    blinding_factor: p1BlindingFactor,
  } as any);
  const hp1Result = await handBackend.generateProof(hp1Witness.witness);
  const handProof1: GeneratedProof = {
    proofFields: bytesToFields(new Uint8Array(hp1Result.proof)),
    publicInputs: hp1Result.publicInputs.map(String),
  };

  console.log('    Generating hand proof 2...');
  const hp2Witness = await noirHand.execute({
    card_commit_hash: p2CardCommit,
    card_ids: p2CardIds.map(String),
    blinding_factor: p2BlindingFactor,
  } as any);
  const hp2Result = await handBackend.generateProof(hp2Witness.witness);
  const handProof2: GeneratedProof = {
    proofFields: bytesToFields(new Uint8Array(hp2Result.proof)),
    publicInputs: hp2Result.publicInputs.map(String),
  };

  // --- Simulate game and generate move proofs ---
  const p1Cards = getCardsByIds(p1CardIds);
  const p2Cards = getCardsByIds(p2CardIds);
  let gameState = createGame(p1Cards, p2Cards);

  // Moves: always play hand index 0, fill board row by row
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

  const moveProofs: GeneratedProof[] = [];
  const moveInputs: string[][] = [];

  let prevStateHash = await computeStateHash(api, gameState);

  for (let i = 0; i < moves.length; i++) {
    const [player, handIdx, row, col] = moves[i];
    const hand = player === 'player1' ? gameState.player1Hand : gameState.player2Hand;
    const card = hand[handIdx];

    console.log(`    Generating move proof ${i + 1}/9 (${player}: card ${card.id} -> [${row},${col}])...`);

    const stateBefore = gameState;
    const result = placeCard(stateBefore, player, handIdx, row, col);
    const stateAfter = result.newState;

    const startHash = prevStateHash;
    const endHash = await computeStateHash(api, stateAfter);
    const gameEnded = stateAfter.status === 'finished' ? '1' : '0';
    const winnerId = stateAfter.winner === 'player1' ? '1'
      : stateAfter.winner === 'player2' ? '2'
      : stateAfter.winner === 'draw' ? '3' : '0';

    const playerCardIds = player === 'player1' ? p1CardIds : p2CardIds;
    const blindingFactor = player === 'player1' ? p1BlindingFactor : p2BlindingFactor;

    // Build circuit input
    const boardBefore: string[] = [];
    const boardAfter: string[] = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const cellBefore = stateBefore.board[r][c];
        boardBefore.push(cellBefore.card ? String(cellBefore.card.id) : '0');
        boardBefore.push(cellBefore.owner === 'player1' ? '1' : cellBefore.owner === 'player2' ? '2' : '0');
        const cellAfter = stateAfter.board[r][c];
        boardAfter.push(cellAfter.card ? String(cellAfter.card.id) : '0');
        boardAfter.push(cellAfter.owner === 'player1' ? '1' : cellAfter.owner === 'player2' ? '2' : '0');
      }
    }

    const moveInput = {
      card_commit_1: p1CardCommit,
      card_commit_2: p2CardCommit,
      start_state_hash: startHash,
      end_state_hash: endHash,
      game_ended: gameEnded,
      winner_id: winnerId,
      current_player: player === 'player1' ? '1' : '2',
      card_id: String(card.id),
      row: String(row),
      col: String(col),
      board_before: boardBefore,
      board_after: boardAfter,
      scores_before: [String(stateBefore.player1Score), String(stateBefore.player2Score)],
      scores_after: [String(stateAfter.player1Score), String(stateAfter.player2Score)],
      current_turn_before: stateBefore.currentTurn === 'player1' ? '1' : '2',
      player_card_ids: playerCardIds.map(String),
      blinding_factor: blindingFactor,
    };

    const moveWitness = await noirMove.execute(moveInput as any);
    const moveResult = await moveBackend.generateProof(moveWitness.witness);

    moveProofs.push({
      proofFields: bytesToFields(new Uint8Array(moveResult.proof)),
      publicInputs: moveResult.publicInputs.map(String),
    });
    moveInputs.push([p1CardCommit, p2CardCommit, startHash, endHash, gameEnded, winnerId]);

    gameState = stateAfter;
    prevStateHash = endHash;
  }

  try { await handBackend.destroy(); } catch { /* may not be available */ }
  try { await moveBackend.destroy(); } catch { /* may not be available */ }

  return {
    handProof1,
    handProof2,
    moveProofs,
    moveInputs,
    winner: gameState.winner,
    finalState: gameState,
  };
}
