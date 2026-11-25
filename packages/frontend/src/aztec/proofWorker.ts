/**
 * Proof generation and verification module (bb.js + noir_js).
 *
 * - game_move: proves a valid move with chain capture logic, bound to both
 *   players' hand commitments, and publishes the placed card and its slot in
 *   the mover's committed hand (docs/plan/PRIVATE_GAMES.md section 4).
 * - prove_hand, the OPEN-CARDS proof (section 6): the hand's first three
 *   committed slots, against the record's hand commitment.
 * - Verification of both, for the opponent's moves and open cards (section
 *   6.3), against verification keys computed once from the artifacts.
 *
 * Heavy: import it dynamically. Callers serialise their use of the shared
 * Barretenberg instance through `onProver` (proverQueue.ts).
 */

import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend, UltraHonkVerifierBackend } from '@aztec-foundation/bb.js';
import type { MoveProofData } from '../types';
import { loadGameMoveCircuit, loadProveHandCircuit, type CircuitArtifact } from './circuitLoader';
import { getBarretenberg } from './proofBackend';
import {
  moveProofFromOutput,
  OPEN_CARD_COUNT,
  OPEN_CARDS_PUBLIC_INPUTS,
  type OpenCardsPayload,
} from './localGame';

export { moveProofFromOutput };

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

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
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

// ====================== Verification keys ======================

export type VerifiedCircuit = 'game_move' | 'prove_hand';

const LOADERS: Record<VerifiedCircuit, () => Promise<CircuitArtifact>> = {
  game_move: loadGameMoveCircuit,
  prove_hand: loadProveHandCircuit,
};

const vkCache = new Map<VerifiedCircuit, Promise<Uint8Array>>();

/**
 * A circuit's verification key, computed from its artifact (the artifacts
 * carry none) with the same default settings the proofs are made with.
 * Computed once per page: settlement and every move check share it.
 */
export function circuitVerificationKey(name: VerifiedCircuit): Promise<Uint8Array> {
  let vk = vkCache.get(name);
  if (!vk) {
    vk = (async () => {
      const artifact = await LOADERS[name]();
      const backend = await getOrCreateBackend(name, artifact.bytecode);
      return backend.getVerificationKey();
    })();
    vkCache.set(name, vk);
    // A failed computation must not stick: the next caller tries again.
    vk.catch(() => { if (vkCache.get(name) === vk) vkCache.delete(name); });
  }
  return vk;
}

/** Test seam. */
export function clearVerificationKeyCache(): void {
  vkCache.clear();
}

async function verifyHonkProof(name: VerifiedCircuit, proof: string, publicInputs: string[]): Promise<boolean> {
  const verificationKey = await circuitVerificationKey(name);
  const verifier = new UltraHonkVerifierBackend(await getBarretenberg());
  return verifier.verifyProof({ proof: base64ToBytes(proof), publicInputs, verificationKey });
}

/** Verify a game_move proof (base64) against its 8 public inputs. */
export function verifyGameMoveProof(proof: string, publicInputs: string[]): Promise<boolean> {
  return verifyHonkProof('game_move', proof, publicInputs);
}

/** Verify an open-cards proof (base64) against `[hand_commit, open_0, open_1, open_2]`. */
export function verifyOpenCardsProof(proof: string, publicInputs: string[]): Promise<boolean> {
  return verifyHonkProof('prove_hand', proof, publicInputs);
}

// ====================== Open-cards proof ======================

/**
 * Prove our three open cards: the committed hand's slots 0..2, against our
 * record's hand commitment. The opponent checks it (section 6); nothing
 * on-chain does.
 */
export async function generateOpenCardsProof(
  hand: number[],
  blindingFactor: string,
  handCommit: string,
): Promise<OpenCardsPayload> {
  if (hand.length !== 5) throw new Error(`open cards: a hand is 5 cards, got ${hand.length}`);
  const cards = hand.slice(0, OPEN_CARD_COUNT);
  const startTime = performance.now();
  const artifact = await loadProveHandCircuit();
  const noir = new Noir(artifact as never);
  const { witness } = await noir.execute({
    card_commit_hash: toFieldHex(handCommit),
    open_cards: cards.map(id => toFieldHex(id)),
    card_ids: hand.map(id => toFieldHex(id)),
    blinding_factor: toFieldHex(blindingFactor),
  } as never);
  const backend = await getOrCreateBackend('prove_hand', artifact.bytecode);
  const proofData = await backend.generateProof(witness);
  if (proofData.publicInputs.length !== OPEN_CARDS_PUBLIC_INPUTS) {
    throw new Error(`prove_hand: expected ${OPEN_CARDS_PUBLIC_INPUTS} public inputs, got ${proofData.publicInputs.length}`);
  }
  console.log(`[proofWorker] open-cards proof generated in ${((performance.now() - startTime) / 1000).toFixed(1)}s`);
  return { cards, proof: proofToBase64(proofData.proof), publicInputs: proofData.publicInputs };
}
