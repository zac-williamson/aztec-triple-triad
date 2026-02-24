/**
 * Proof generation worker module.
 *
 * This module handles the actual Noir circuit proof generation using Barretenberg (bb.js).
 * It loads compiled circuit artifacts and generates proofs for:
 * - prove_hand: Proves ownership of 5 cards without revealing which ones,
 *               and derives a Grumpkin ECDH public key for encrypted communication
 * - game_move: Proves a valid game move with capture logic,
 *              and encrypts the placed card's nullifier via ECDH shared secret
 *
 * In production, this would run in a Web Worker to avoid blocking the UI thread.
 * Currently uses the main thread with async patterns.
 */

import type { HandProofData, MoveProofData } from '../types';

/**
 * Generate a prove_hand proof.
 *
 * This loads the compiled prove_hand circuit artifact and generates a ZK proof
 * that the player owns 5 specific cards without revealing which ones.
 * Also derives a Grumpkin ECDH public key from the player's private key.
 *
 * @throws If circuit artifacts are unavailable or proof generation fails
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
  // Load the compiled circuit artifact
  // In production: const artifact = await fetch('/circuits/prove_hand.json').then(r => r.json());
  // Then use @aztec/bb.js to generate the proof

  try {
    const bbJs = await import('@aztec/bb.js');

    // Set up witnesses matching the circuit's main() signature:
    // card_commit: pub, player_address: pub, game_id: pub,
    // grumpkin_public_key_x: pub, grumpkin_public_key_y: pub,
    // player_secret, card_ids, card_ranks, card_nullifier_secrets, grumpkin_private_key
    const _witnesses = {
      card_commit: '', // computed from inputs
      player_address: playerAddress,
      game_id: gameId,
      grumpkin_public_key_x: '', // derived from grumpkin_private_key
      grumpkin_public_key_y: '', // derived from grumpkin_private_key
      player_secret: playerSecret,
      card_ids: cardIds,
      card_ranks: cardRanks.map((r) => [r.top, r.right, r.bottom, r.left]),
      card_nullifier_secrets: nullifierSecrets,
      grumpkin_private_key: grumpkinPrivateKey || '0',
    };

    // In full implementation:
    // 1. Create a Barretenberg instance
    // 2. Load the circuit bytecode
    // 3. Set witness values
    // 4. Generate the proof
    // 5. Extract public inputs (card_commit, player_address, game_id, grumpkin_pubkey_x, grumpkin_pubkey_y)

    void bbJs; // acknowledge import
    throw new Error('Circuit artifacts not yet available for browser proof generation');
  } catch (err) {
    // If bb.js import fails (e.g., WASM not supported), throw to trigger fallback
    throw new Error(
      `Proof generation not available: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}

/**
 * Generate a game_move proof.
 *
 * Proves that a game move is valid: correct card placement, capture logic, board state transition.
 * Also encrypts the placed card's nullifier using ECDH shared secret with the opponent's public key.
 *
 * @throws If circuit artifacts are unavailable or proof generation fails
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
  grumpkinPrivateKey?: string,
  opponentPubkeyX?: string,
  opponentPubkeyY?: string,
): Promise<MoveProofData> {
  try {
    const bbJs = await import('@aztec/bb.js');

    // Set up witnesses matching the circuit's main() signature:
    // card_commit_1: pub, card_commit_2: pub, start_state_hash: pub,
    // end_state_hash: pub, game_ended: pub, winner_id: pub, encrypted_card_nullifier: pub,
    // current_player, card_id, row, col,
    // board_before, board_after, scores_before, scores_after, current_turn_before,
    // player1_hand_count_after, player2_hand_count_after,
    // player_secret, player_address, game_id,
    // player_card_ids, player_card_ranks, player_nullifier_secrets,
    // grumpkin_private_key, opponent_pubkey_x, opponent_pubkey_y
    const _witnesses = {
      card_commit_1: cardCommit1,
      card_commit_2: cardCommit2,
      start_state_hash: '', // computed from board state
      end_state_hash: '', // computed from board state
      game_ended: gameEnded ? 1 : 0,
      winner_id: winnerId,
      encrypted_card_nullifier: '', // computed from ECDH shared secret
      current_player: currentPlayer,
      card_id: cardId,
      row,
      col,
      board_before: boardBefore,
      board_after: boardAfter,
      scores_before: scoresBefore,
      scores_after: scoresAfter,
      grumpkin_private_key: grumpkinPrivateKey || '0',
      opponent_pubkey_x: opponentPubkeyX || '0',
      opponent_pubkey_y: opponentPubkeyY || '0',
    };

    void bbJs;
    throw new Error('Circuit artifacts not yet available for browser proof generation');
  } catch (err) {
    throw new Error(
      `Move proof generation not available: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}
