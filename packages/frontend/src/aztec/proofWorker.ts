/**
 * Proof generation module.
 *
 * Generates real Noir circuit proofs using Barretenberg (bb.js) and noir_js.
 * Loads compiled circuit artifacts and generates UltraHonk proofs for:
 * - prove_hand: Proves ownership of 5 cards, derives Grumpkin ECDH public key
 * - game_move: Proves a valid game move with capture logic, encrypts nullifier via ECDH
 */

import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend, GRUMPKIN_G1_GENERATOR } from '@aztec/bb.js';
import type { HandProofData, MoveProofData } from '../types';
import { loadProveHandCircuit, loadGameMoveCircuit } from './circuitLoader';
import { getBarretenberg } from './proofBackend';

// ====================== Utility Functions ======================

/**
 * Convert a number or hex string to a 0x-prefixed hex field string.
 */
function toFieldHex(value: number | string | bigint): string {
  if (typeof value === 'string') {
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
function bufToHex(buf: Uint8Array): string {
  return '0x' + Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert a number to a 32-byte big-endian Uint8Array field element.
 */
function numToField(n: number | bigint): Uint8Array {
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
function hexToField(hex: string): Uint8Array {
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

// ====================== Cryptographic Helpers (bb.js) ======================

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
 * Derive Grumpkin public key from private key: pubkey = privateKey * G.
 */
async function deriveGrumpkinPublicKey(
  privateKey: Uint8Array,
): Promise<{ x: Uint8Array; y: Uint8Array }> {
  const api = await getBarretenberg();
  const result = await api.grumpkinMul({
    point: GRUMPKIN_G1_GENERATOR,
    scalar: privateKey,
  });
  return result.point;
}

/**
 * Compute ECDH shared secret: shared_point = my_private_key * opponent_pubkey.
 * Returns the x-coordinate of the shared point.
 */
async function computeECDHSharedSecret(
  myPrivateKey: Uint8Array,
  opponentPubkeyX: Uint8Array,
  opponentPubkeyY: Uint8Array,
): Promise<Uint8Array> {
  const api = await getBarretenberg();
  const result = await api.grumpkinMul({
    point: { x: opponentPubkeyX, y: opponentPubkeyY },
    scalar: myPrivateKey,
  });
  return result.point.x;
}

/**
 * Symmetric encrypt a field: encrypted = plaintext + expand_secret(shared_secret).
 * expand_secret = pedersen_hash([shared_secret, 0])
 * Matches the circuit's symmetric_encrypt_field().
 */
async function symmetricEncryptField(
  plaintext: Uint8Array,
  sharedSecret: Uint8Array,
): Promise<Uint8Array> {
  const expandedKey = await pedersenHash([sharedSecret, numToField(0)]);
  const ptBig = BigInt(bufToHex(plaintext));
  const keyBig = BigInt(bufToHex(expandedKey));
  // BN254 scalar field modulus (= Grumpkin base field)
  const p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const result = (ptBig + keyBig) % p;
  return numToField(result);
}

/**
 * Compute the card commitment hash matching the circuit's compute_card_commit.
 * Hash 33 fields: [player_secret, player_address, game_id,
 *                   card_ids[5], card_ranks[5*4], nullifier_secrets[5]]
 */
async function computeCardCommit(
  playerSecret: string,
  playerAddress: string,
  gameId: string,
  cardIds: number[],
  cardRanks: Array<{ top: number; right: number; bottom: number; left: number }>,
  nullifierSecrets: string[],
): Promise<Uint8Array> {
  const inputs: Uint8Array[] = [];
  inputs.push(hexToField(playerSecret));
  inputs.push(hexToField(playerAddress));
  inputs.push(hexToField(gameId));
  for (const id of cardIds) {
    inputs.push(numToField(id));
  }
  for (const ranks of cardRanks) {
    inputs.push(numToField(ranks.top));
    inputs.push(numToField(ranks.right));
    inputs.push(numToField(ranks.bottom));
    inputs.push(numToField(ranks.left));
  }
  for (const secret of nullifierSecrets) {
    inputs.push(hexToField(secret));
  }
  return pedersenHash(inputs);
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
 * Loads the compiled prove_hand circuit artifact and generates a real ZK proof
 * that the player owns 5 specific cards without revealing which ones.
 * Also derives a Grumpkin ECDH public key from the player's private key.
 */
export async function generateProveHandProof(
  cardIds: number[],
  cardRanks: Array<{ top: number; right: number; bottom: number; left: number }>,
  playerAddress: string,
  gameId: string,
  playerSecret: string,
  nullifierSecrets: string[],
  grumpkinPrivateKey?: string,
): Promise<HandProofData> {
  console.log('[proofWorker] Generating prove_hand proof...');
  const startTime = performance.now();

  const api = await getBarretenberg();
  const artifact = await loadProveHandCircuit();

  // Ensure we have a grumpkin private key
  const privKey = grumpkinPrivateKey || '0x01';
  const privKeyBuf = hexToField(privKey);

  // Compute public inputs using bb.js (must match circuit's computation)
  const cardCommitBuf = await computeCardCommit(
    playerSecret, playerAddress, gameId, cardIds, cardRanks, nullifierSecrets,
  );
  const grumpkinPubkey = await deriveGrumpkinPublicKey(privKeyBuf);

  const cardCommitHex = bufToHex(cardCommitBuf);
  const pubkeyXHex = bufToHex(grumpkinPubkey.x);
  const pubkeyYHex = bufToHex(grumpkinPubkey.y);

  // Build witness inputs matching exact circuit parameter names
  const inputs: Record<string, unknown> = {
    card_commit: cardCommitHex,
    player_address: toFieldHex(playerAddress),
    game_id: toFieldHex(gameId),
    grumpkin_public_key_x: pubkeyXHex,
    grumpkin_public_key_y: pubkeyYHex,
    player_secret: toFieldHex(playerSecret),
    card_ids: cardIds.map((id) => toFieldHex(id)),
    card_ranks: cardRanks.map((r) => [
      toFieldHex(r.top), toFieldHex(r.right),
      toFieldHex(r.bottom), toFieldHex(r.left),
    ]),
    card_nullifier_secrets: nullifierSecrets.map((s) => toFieldHex(s)),
    grumpkin_private_key: toFieldHex(privKey),
  };

  const noir = new Noir(artifact as never);
  const { witness } = await noir.execute(inputs as never);
  console.log('[proofWorker] Witness generated, creating proof...');

  const backend = new UltraHonkBackend(artifact.bytecode, api);
  const proofData = await backend.generateProof(witness, {
    verifierTarget: 'noir-recursive',
  });

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log(`[proofWorker] prove_hand proof generated in ${elapsed}s`);
  console.log(`[proofWorker]   publicInputs: ${proofData.publicInputs.length} fields`);
  console.log(`[proofWorker]   proof size: ${proofData.proof.length} bytes`);

  // Public inputs: [0] card_commit, [1] player_address, [2] game_id,
  // [3] grumpkin_public_key_x, [4] grumpkin_public_key_y
  return {
    proof: proofToBase64(proofData.proof),
    publicInputs: proofData.publicInputs,
    cardCommit: proofData.publicInputs[0],
    playerAddress: proofData.publicInputs[1],
    gameId: proofData.publicInputs[2],
    grumpkinPublicKeyX: proofData.publicInputs[3],
    grumpkinPublicKeyY: proofData.publicInputs[4],
  };
}

// ====================== game_move Proof ======================

/**
 * Hand commitment data needed by the game_move circuit to verify
 * the current player's card_commit binding.
 */
export interface PlayerHandData {
  playerSecret: string;
  playerAddress: string;
  gameId: string;
  cardIds: number[];
  cardRanks: Array<{ top: number; right: number; bottom: number; left: number }>;
  nullifierSecrets: string[];
}

/**
 * Generate a game_move proof.
 *
 * Proves that a game move is valid: correct card placement, capture logic,
 * board state transition. Encrypts the placed card's nullifier using ECDH
 * shared secret with the opponent's public key.
 *
 * Circuit ABI parameters (from game_move/src/main.nr):
 *   Public:  card_commit_1, card_commit_2, start_state_hash, end_state_hash,
 *            game_ended, winner_id, encrypted_card_nullifier
 *   Private: current_player, card_id, row, col, board_before[18], board_after[18],
 *            scores_before[2], scores_after[2], current_turn_before,
 *            player_secret, player_address, game_id,
 *            player_card_ids[5], player_card_ranks[[4];5], player_nullifier_secrets[5],
 *            grumpkin_private_key, opponent_pubkey_x, opponent_pubkey_y
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
  grumpkinPrivateKey: string,
  opponentPubkeyX: string,
  opponentPubkeyY: string,
): Promise<MoveProofData> {
  console.log(`[proofWorker] Generating game_move proof (card ${cardId} at [${row},${col}])...`);
  const startTime = performance.now();

  const api = await getBarretenberg();
  const artifact = await loadGameMoveCircuit();

  // === Compute public inputs ===

  // 1. State hashes using Pedersen (matching circuit's hash_board_state)
  const currentTurnBefore = currentPlayer;
  const nextTurn = currentPlayer === 1 ? 2 : 1;
  const startStateHash = await computeBoardStateHash(boardBefore, scoresBefore, currentTurnBefore);
  const endStateHash = await computeBoardStateHash(boardAfter, scoresAfter, nextTurn);

  // 2. ECDH encrypted card nullifier
  // Find the nullifier secret for the placed card in the player's hand
  const handCardIndex = playerHandData.cardIds.indexOf(cardId);
  if (handCardIndex === -1) {
    throw new Error(`Card ${cardId} not found in player hand data`);
  }
  const placedCardNullifierSecret = playerHandData.nullifierSecrets[handCardIndex];

  const privKeyBuf = hexToField(grumpkinPrivateKey);
  const oppPubXBuf = hexToField(opponentPubkeyX);
  const oppPubYBuf = hexToField(opponentPubkeyY);
  const nullifierBuf = hexToField(placedCardNullifierSecret);

  const sharedSecret = await computeECDHSharedSecret(privKeyBuf, oppPubXBuf, oppPubYBuf);
  const encryptedNullifierBuf = await symmetricEncryptField(nullifierBuf, sharedSecret);
  const encryptedNullifierHex = bufToHex(encryptedNullifierBuf);

  // === Build witness inputs matching exact circuit ABI parameter names ===
  const inputs: Record<string, unknown> = {
    // Public inputs
    card_commit_1: toFieldHex(cardCommit1),
    card_commit_2: toFieldHex(cardCommit2),
    start_state_hash: startStateHash,
    end_state_hash: endStateHash,
    game_ended: gameEnded ? '0x1' : '0x0',
    winner_id: toFieldHex(winnerId),
    encrypted_card_nullifier: encryptedNullifierHex,
    // Private inputs - move data
    current_player: toFieldHex(currentPlayer),
    card_id: toFieldHex(cardId),
    row: toFieldHex(row),
    col: toFieldHex(col),
    // Private inputs - board state
    board_before: boardBefore.map((v) => toFieldHex(Number(v))),
    board_after: boardAfter.map((v) => toFieldHex(Number(v))),
    scores_before: scoresBefore.map((v) => toFieldHex(v)),
    scores_after: scoresAfter.map((v) => toFieldHex(v)),
    current_turn_before: toFieldHex(currentTurnBefore),
    // Private inputs - player's hand commitment data
    player_secret: toFieldHex(playerHandData.playerSecret),
    player_address: toFieldHex(playerHandData.playerAddress),
    game_id: toFieldHex(playerHandData.gameId),
    player_card_ids: playerHandData.cardIds.map((id) => toFieldHex(id)),
    player_card_ranks: playerHandData.cardRanks.map((r) => [
      toFieldHex(r.top), toFieldHex(r.right),
      toFieldHex(r.bottom), toFieldHex(r.left),
    ]),
    player_nullifier_secrets: playerHandData.nullifierSecrets.map((s) => toFieldHex(s)),
    // Private inputs - ECDH encryption
    grumpkin_private_key: toFieldHex(grumpkinPrivateKey),
    opponent_pubkey_x: toFieldHex(opponentPubkeyX),
    opponent_pubkey_y: toFieldHex(opponentPubkeyY),
  };

  const noir = new Noir(artifact as never);
  const { witness } = await noir.execute(inputs as never);
  console.log('[proofWorker] game_move witness generated, creating proof...');

  const backend = new UltraHonkBackend(artifact.bytecode, api);
  const proofData = await backend.generateProof(witness, {
    verifierTarget: 'noir-recursive',
  });

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log(`[proofWorker] game_move proof generated in ${elapsed}s`);
  console.log(`[proofWorker]   publicInputs: ${proofData.publicInputs.length} fields`);
  console.log(`[proofWorker]   proof size: ${proofData.proof.length} bytes`);

  // Public inputs: [0] card_commit_1, [1] card_commit_2,
  // [2] start_state_hash, [3] end_state_hash,
  // [4] game_ended, [5] winner_id, [6] encrypted_card_nullifier
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
    encryptedCardNullifier: proofData.publicInputs[6],
  };
}
