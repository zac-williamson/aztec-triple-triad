/**
 * Proof generation module.
 *
 * Generates real Noir circuit proofs using Barretenberg (bb.js) and noir_js:
 * - game_move: proves a valid move with chain capture logic, bound to both
 *   players' hand commitments, and publishes the placed card and its slot in
 *   the mover's committed hand (docs/plan/PRIVATE_GAMES.md section 4).
 *
 * There are no hand proofs in the protocol any more: `commit_hand` checks a
 * hand on-chain and the move proofs bind both commitments.
 */

import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec-foundation/bb.js';
import type { MoveProofData } from '../types';
import { loadGameMoveCircuit } from './circuitLoader';
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
    try { (backend as any).destroy?.(); } catch { /* ignore */ }
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
 * Convert a value (hex string, decimal string, or bigint) to a 32-byte big-endian Uint8Array.
 * Unlike hexToField, this safely handles decimal strings from simulate() results.
 */
export function safeToField(value: string | number | bigint): Uint8Array {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return numToField(value);
  }
  // If it has 0x prefix, treat as hex
  if (value.startsWith('0x') || value.startsWith('0X')) {
    return hexToField(value);
  }
  // Otherwise treat as decimal string → convert via BigInt → numToField
  return numToField(BigInt(value));
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
    safeToField(blindingFactor),
  ];
  const hash = await poseidon2Hash(inputs);
  return bufToHex(hash);
}

/**
 * Compute board state hash matching the circuit's hash_board_state.
 * Hash 30 fields: [board[18], scores[2], current_turn, original_owners[9]]
 * (`circuits/game_move/src/main.nr` hash_board_state). original_owners[i] is the
 * player who FIRST placed the card on cell i (0 if empty), set at placement and
 * never changed by capture. Unlike the abandoned per-player placed-slot masks
 * (C2 round 1), it is publicly agreed — both peers derive it identically from
 * the shared move sequence — so the chained state hash agrees across async peers
 * (the round-2 fix). An empty/initial board hashes with original_owners all 0.
 */
export async function computeBoardStateHash(
  board: string[],
  scores: [number, number],
  currentTurn: number,
  originalOwners: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0],
): Promise<string> {
  const inputs: Uint8Array[] = [
    ...board.map((v) => numToField(Number(v))),
    numToField(scores[0]),
    numToField(scores[1]),
    numToField(currentTurn),
    ...originalOwners.map((o) => numToField(o)),
  ];
  const hash = await pedersenHash(inputs);
  return bufToHex(hash);
}

// ====================== game_move Proof ======================

/**
 * Player's hand data needed by the game_move circuit.
 */
export interface PlayerHandData {
  /** The mover's five card ids, in the order they were COMMITTED. */
  cardIds: number[];
  blindingFactor: string;
}

/**
 * The hand slot a card was committed in — the circuit's `placed_slot`. A
 * committed hand never repeats an id (`commit_hand` checks), so the id names
 * exactly one slot.
 */
export function slotOfCard(committedHand: number[], cardId: number): number {
  const slot = committedHand.indexOf(cardId);
  if (slot < 0) throw new Error(`card ${cardId} is not in the committed hand [${committedHand.join(', ')}]`);
  return slot;
}

/**
 * Generate a game_move proof.
 *
 * Proves a valid game move: card placement, chain capture logic,
 * board state transition, score verification.
 *
 * Circuit public inputs (8): card_commit_1, card_commit_2,
 *   start_state_hash, end_state_hash, game_ended, winner_id,
 *   placed_card_id, placed_slot
 * (`placed_slot` = the placed card's index in the mover's committed hand,
 * which the circuit checks against `player_card_ids`).
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
  originalOwnersBefore: number[],
  originalOwnersAfter: number[],
): Promise<MoveProofData> {
  const placedSlot = slotOfCard(playerHandData.cardIds, cardId);
  console.log(`[proofWorker] Generating game_move proof (card ${cardId} from slot ${placedSlot} at [${row},${col}])...`);
  const startTime = performance.now();

  const artifact = await loadGameMoveCircuit();

  // State hashes bind the per-cell original owners (the C2 round-2 replay guard).
  // Both arrays come straight from the shared board state — no private/chained
  // data — so consecutive moves' hashes agree across peers (the round-1 masks
  // could not). The circuit's frame rule asserts the placed cell's original
  // owner became the mover and every other cell's is unchanged.
  const currentTurnBefore = currentPlayer;
  const nextTurn = currentPlayer === 1 ? 2 : 1;
  const startStateHash = await computeBoardStateHash(boardBefore, scoresBefore, currentTurnBefore, originalOwnersBefore);
  const endStateHash = await computeBoardStateHash(boardAfter, scoresAfter, nextTurn, originalOwnersAfter);

  // Build witness inputs matching circuit parameter names
  const inputs: Record<string, unknown> = {
    // Public inputs
    card_commit_1: toFieldHex(cardCommit1),
    card_commit_2: toFieldHex(cardCommit2),
    start_state_hash: startStateHash,
    end_state_hash: endStateHash,
    game_ended: gameEnded ? '0x1' : '0x0',
    winner_id: toFieldHex(winnerId),
    placed_card_id: toFieldHex(cardId),
    placed_slot: toFieldHex(placedSlot),
    // Private inputs
    current_player: toFieldHex(currentPlayer),
    row: toFieldHex(row),
    col: toFieldHex(col),
    board_before: boardBefore.map((v) => toFieldHex(Number(v))),
    board_after: boardAfter.map((v) => toFieldHex(Number(v))),
    scores_before: scoresBefore.map((v) => toFieldHex(v)),
    scores_after: scoresAfter.map((v) => toFieldHex(v)),
    current_turn_before: toFieldHex(currentTurnBefore),
    original_owners_before: originalOwnersBefore.map((o) => toFieldHex(o)),
    original_owners_after: originalOwnersAfter.map((o) => toFieldHex(o)),
    player_card_ids: playerHandData.cardIds.map((id) => toFieldHex(id)),
    blinding_factor: toFieldHex(playerHandData.blindingFactor),
  };

  const noir = new Noir(artifact as never);
  const { witness } = await noir.execute(inputs as never);
  console.log('[proofWorker] game_move witness generated, creating proof...');

  const backend = await getOrCreateBackend('game_move', artifact.bytecode);
  const proofData = await backend.generateProof(witness);

  const durationMs = performance.now() - startTime;
  console.log(`[proofWorker] game_move proof generated in ${(durationMs / 1000).toFixed(1)}s`);

  return moveProofFromOutput(proofToBase64(proofData.proof), proofData.publicInputs, durationMs);
}

/**
 * Read a game_move proof's 8 public inputs: `[card_commit_1, card_commit_2,
 * start_state_hash, end_state_hash, game_ended, winner_id, placed_card_id,
 * placed_slot]`.
 */
export function moveProofFromOutput(proof: string, publicInputs: string[], durationMs?: number): MoveProofData {
  if (publicInputs.length !== 8) {
    throw new Error(`game_move: expected 8 public inputs, got ${publicInputs.length}`);
  }
  return {
    proof,
    publicInputs,
    cardCommit1: publicInputs[0],
    cardCommit2: publicInputs[1],
    startStateHash: publicInputs[2],
    endStateHash: publicInputs[3],
    gameEnded: BigInt(publicInputs[4]) !== 0n,
    winnerId: Number(BigInt(publicInputs[5])),
    placedCardId: Number(BigInt(publicInputs[6])),
    placedSlot: Number(BigInt(publicInputs[7])),
    durationMs,
  };
}
