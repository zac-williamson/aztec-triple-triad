/**
 * Proof generation worker module.
 *
 * This module handles the actual Noir circuit proof generation using Barretenberg (bb.js).
 * It loads compiled circuit artifacts and generates proofs for:
 * - prove_hand: Proves ownership of 5 cards without revealing which ones
 * - game_move: Proves a valid game move with capture logic
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
): Promise<HandProofData> {
  // Load the compiled circuit artifact
  // In production: const artifact = await fetch('/circuits/prove_hand.json').then(r => r.json());
  // Then use @aztec/bb.js to generate the proof

  // For now, attempt to load bb.js for proof generation
  try {
    const bbJs = await import('@aztec/bb.js');

    // The circuit artifact would be loaded from the compiled output
    // const circuitArtifact = await loadCircuitArtifact('prove_hand');

    // Set up witnesses
    const _witnesses = {
      card_commit: '', // computed from inputs
      player_address: playerAddress,
      game_id: gameId,
      player_secret: playerSecret,
      card_ids: cardIds,
      card_ranks: cardRanks.map((r) => [r.top, r.right, r.bottom, r.left]),
      card_nullifier_secrets: nullifierSecrets,
    };

    // In full implementation:
    // 1. Create a Barretenberg instance
    // 2. Load the circuit bytecode
    // 3. Set witness values
    // 4. Generate the proof
    // 5. Extract public inputs

    // Placeholder until circuit artifacts are available at runtime
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
): Promise<MoveProofData> {
  try {
    const bbJs = await import('@aztec/bb.js');

    // Set up witnesses for the game_move circuit
    const _witnesses = {
      card_commit_1: cardCommit1,
      card_commit_2: cardCommit2,
      start_state_hash: '', // computed from board state
      end_state_hash: '', // computed from board state
      game_ended: gameEnded ? 1 : 0,
      winner_id: winnerId,
      current_player: currentPlayer,
      card_id: cardId,
      row,
      col,
      board_before: boardBefore,
      board_after: boardAfter,
      scores_before: scoresBefore,
      scores_after: scoresAfter,
    };

    void bbJs;
    throw new Error('Circuit artifacts not yet available for browser proof generation');
  } catch (err) {
    throw new Error(
      `Move proof generation not available: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}
