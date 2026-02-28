/**
 * Proof generation module.
 *
 * Generates real Noir circuit proofs using Barretenberg (bb.js) and noir_js.
 * Loads compiled circuit artifacts and generates UltraHonk proofs for:
 * - prove_hand: Proves ownership of 5 cards (poseidon2 commitment)
 * - game_move: Proves a valid game move with chain capture logic
 */

import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';
import type { HandProofData, MoveProofData } from '../types';
import { loadProveHandCircuit, loadGameMoveCircuit } from './circuitLoader';
import { getBarretenberg } from './proofBackend';

// ====================== UltraHonkBackend Cache ======================

const backendCache = new Map<string, UltraHonkBackend>();

async function getOrCreateBackend(circuitName: string, bytecode: string): Promise<UltraHonkBackend> {
  const existing = backendCache.get(circuitName);
  if (existing) return existing;
  const api = await getBarretenberg();
  const backend = new UltraHonkBackend(bytecode, api);
  backendCache.set(circuitName, backend);
  return backend;
}

/**
 * Destroy all cached backends and free WASM memory.
 */
export function destroyBackendCache(): void {
  for (const [, backend] of backendCache) {
    try { backend.destroy(); } catch { /* ignore */ }
  }
  backendCache.clear();
}

// ====================== Utility Functions ======================

/**
 * Convert a number or hex string to a 0x-prefixed hex field string.
 */
export function toFieldHex(value: number | string | bigint): string {
  if (typeof value === 'string') {
    if (value === '') {
      throw new Error('toFieldHex: empty string is not a valid field value');
    }
    if (value.startsWith('0x') || value.startsWith('0X')) {
      return value;
    }
    return '0x' + BigInt(value).toString(16);
  }
  if (typeof value === 'bigint') {
    return '0x' + value.toString(16);
  }
  return '0x' + BigInt(value).toString(16);
}

/**
 * Convert a Uint8Array (32 bytes big-endian) to a 0x-prefixed hex string.
 */
export function bufToHex(buf: Uint8Array): string {
  return '0x' + Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert a number to a 32-byte big-endian Uint8Array field element.
 */
export function numToField(n: number | bigint): Uint8Array {
  const buf = new Uint8Array(32);
  let val = BigInt(n);
  for (let i = 31; i >= 0; i--) {
    buf[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return buf;
}

/**
 * Convert a hex string to a 32-byte big-endian Uint8Array.
 */
export function hexToField(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = clean.padStart(64, '0');
  const buf = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    buf[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

/**
 * Base64-encode a Uint8Array proof for JSON serialization.
 */
function proofToBase64(proof: Uint8Array): string {
  return btoa(
    Array.from(proof)
      .map((b) => String.fromCharCode(b))
      .join(''),
  );
}

// ====================== Cryptographic Helpers ======================

/**
 * Compute Poseidon2 hash of an array of field elements using bb.js.
 * Matches the circuit's Poseidon2::hash() from the external poseidon library.
 */
async function poseidon2Hash(inputs: Uint8Array[]): Promise<Uint8Array> {
  const api = await getBarretenberg();
  const result = await api.poseidon2Hash({ inputs });
  return result.hash;
}

/**
 * Compute Pedersen hash of an array of field elements using bb.js.
 * Matches the circuit's std::hash::pedersen_hash() with default hash index 0.
 */
async function pedersenHash(inputs: Uint8Array[]): Promise<Uint8Array> {
  const api = await getBarretenberg();
  const result = await api.pedersenHash({ inputs, hashIndex: 0 });
  return result.hash;
}

/**
 * Compute card commitment using Poseidon2.
 * Matches the circuit: Poseidon2::hash([card_ids[0..5], blinding_factor], 6)
 */
export async function computeCardCommitPoseidon2(
  cardIds: number[],
  blindingFactor: string,
): Promise<string> {
  if (cardIds.length !== 5) {
    throw new Error(`computeCardCommitPoseidon2: expected 5 card IDs, got ${cardIds.length}`);
  }
  const inputs: Uint8Array[] = [
    ...cardIds.map((id) => numToField(id)),
    hexToField(blindingFactor),
  ];
  const hash = await poseidon2Hash(inputs);
  return bufToHex(hash);
}

/**
 * Compute board state hash matching the circuit's hash_board_state.
 * Hash 21 fields: [board[18], scores[2], current_turn]
 */
export async function computeBoardStateHash(
  board: string[],
  scores: [number, number],
  currentTurn: number,
): Promise<string> {
  const inputs: Uint8Array[] = [
    ...board.map((v) => numToField(Number(v))),
    numToField(scores[0]),
    numToField(scores[1]),
    numToField(currentTurn),
  ];
  const hash = await pedersenHash(inputs);
  return bufToHex(hash);
}

// ====================== prove_hand Proof ======================

/**
 * Generate a prove_hand proof.
 *
 * Proves ownership of 5 cards via poseidon2 commitment.
 * Circuit has 1 public input: card_commit_hash.
 * Private inputs: card_ids[5], blinding_factor.
 */
export async function generateProveHandProof(
  cardIds: number[],
  blindingFactor: string,
  cardCommitHash: string,
): Promise<HandProofData> {
  console.log('[proofWorker] Generating prove_hand proof...');
  const startTime = performance.now();

  const artifact = await loadProveHandCircuit();

  // Build witness inputs matching circuit parameter names
  const inputs: Record<string, unknown> = {
    card_commit_hash: toFieldHex(cardCommitHash),
    card_ids: cardIds.map((id) => toFieldHex(id)),
    blinding_factor: toFieldHex(blindingFactor),
  };

  const noir = new Noir(artifact as never);
  const { witness } = await noir.execute(inputs as never);
  console.log('[proofWorker] Witness generated, creating proof...');

  const backend = await getOrCreateBackend('prove_hand', artifact.bytecode);
  const proofData = await backend.generateProof(witness, {
    verifierTarget: 'noir-recursive',
  });

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log(`[proofWorker] prove_hand proof generated in ${elapsed}s`);

  // Public inputs: [0] card_commit_hash
  if (proofData.publicInputs.length < 1) {
    throw new Error(
      `prove_hand: expected at least 1 public input, got ${proofData.publicInputs.length}`
    );
  }

  return {
    proof: proofToBase64(proofData.proof),
    publicInputs: proofData.publicInputs,
    cardCommit: proofData.publicInputs[0],
  };
}

// ====================== game_move Proof ======================

/**
 * Player's hand data needed by the game_move circuit.
 */
export interface PlayerHandData {
  cardIds: number[];
  blindingFactor: string;
}

/**
 * Generate a game_move proof.
 *
 * Proves a valid game move: card placement, chain capture logic,
 * board state transition, score verification.
 *
 * Circuit public inputs (6): card_commit_1, card_commit_2,
 *   start_state_hash, end_state_hash, game_ended, winner_id
 */
export async function generateGameMoveProof(
  cardId: number,
  row: number,
  col: number,
  currentPlayer: 1 | 2,
  boardBefore: string[],
  boardAfter: string[],
  scoresBefore: [number, number],
  scoresAfter: [number, number],
  cardCommit1: string,
  cardCommit2: string,
  gameEnded: boolean,
  winnerId: number,
  playerHandData: PlayerHandData,
): Promise<MoveProofData> {
  console.log(`[proofWorker] Generating game_move proof (card ${cardId} at [${row},${col}])...`);
  const startTime = performance.now();

  const artifact = await loadGameMoveCircuit();

  // Compute state hashes
  const currentTurnBefore = currentPlayer;
  const nextTurn = currentPlayer === 1 ? 2 : 1;
  const startStateHash = await computeBoardStateHash(boardBefore, scoresBefore, currentTurnBefore);
  const endStateHash = await computeBoardStateHash(boardAfter, scoresAfter, nextTurn);

  // Build witness inputs matching circuit parameter names
  const inputs: Record<string, unknown> = {
    // Public inputs
    card_commit_1: toFieldHex(cardCommit1),
    card_commit_2: toFieldHex(cardCommit2),
    start_state_hash: startStateHash,
    end_state_hash: endStateHash,
    game_ended: gameEnded ? '0x1' : '0x0',
    winner_id: toFieldHex(winnerId),
    // Private inputs
    current_player: toFieldHex(currentPlayer),
    card_id: toFieldHex(cardId),
    row: toFieldHex(row),
    col: toFieldHex(col),
    board_before: boardBefore.map((v) => toFieldHex(Number(v))),
    board_after: boardAfter.map((v) => toFieldHex(Number(v))),
    scores_before: scoresBefore.map((v) => toFieldHex(v)),
    scores_after: scoresAfter.map((v) => toFieldHex(v)),
    current_turn_before: toFieldHex(currentTurnBefore),
    player_card_ids: playerHandData.cardIds.map((id) => toFieldHex(id)),
    blinding_factor: toFieldHex(playerHandData.blindingFactor),
  };

  const noir = new Noir(artifact as never);
  const { witness } = await noir.execute(inputs as never);
  console.log('[proofWorker] game_move witness generated, creating proof...');

  const backend = await getOrCreateBackend('game_move', artifact.bytecode);
  const proofData = await backend.generateProof(witness, {
    verifierTarget: 'noir-recursive',
  });

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log(`[proofWorker] game_move proof generated in ${elapsed}s`);

  // Public inputs: [0] card_commit_1, [1] card_commit_2,
  // [2] start_state_hash, [3] end_state_hash,
  // [4] game_ended, [5] winner_id
  if (proofData.publicInputs.length < 6) {
    throw new Error(
      `game_move: expected at least 6 public inputs, got ${proofData.publicInputs.length}`
    );
  }

  const ZERO_FIELD = '0x0000000000000000000000000000000000000000000000000000000000000000';
  return {
    proof: proofToBase64(proofData.proof),
    publicInputs: proofData.publicInputs,
    cardCommit1: proofData.publicInputs[0],
    cardCommit2: proofData.publicInputs[1],
    startStateHash: proofData.publicInputs[2],
    endStateHash: proofData.publicInputs[3],
    gameEnded: proofData.publicInputs[4] !== ZERO_FIELD && proofData.publicInputs[4] !== '0',
    winnerId: Number(BigInt(proofData.publicInputs[5])),
  };
}
