import type { GameState, Card, Player, Board, BoardCell } from '@aztec-triple-triad/game-logic';

/**
 * A Noir field element represented as a bigint string (hex or decimal).
 * In the circuit, all values are field elements.
 */
export type FieldValue = string;

/**
 * Board state representation matching the circuit format.
 * 9 cells x 2 fields each = 18 fields.
 * Each cell: [card_id, owner] where card_id=0 means empty, owner: 0=none, 1=player1, 2=player2.
 */
export type CircuitBoard = string[];

/**
 * Input for the prove_hand circuit.
 * Public: card_commit_hash (1 field)
 * Private: card_ids (5), blinding_factor (1)
 */
export interface ProveHandInput {
  // Public inputs (1)
  card_commit_hash: string;
  // Private inputs
  card_ids: string[];
  blinding_factor: string;
}

/**
 * Input for the game_move circuit.
 * Public: 6 fields
 * Private: current_player, card_id, row, col, board states, scores, turn, player_card_ids, blinding
 */
export interface GameMoveInput {
  // Public inputs (6)
  card_commit_1: string;
  card_commit_2: string;
  start_state_hash: string;
  end_state_hash: string;
  game_ended: string;
  winner_id: string;
  // Private inputs
  current_player: string;
  card_id: string;
  row: string;
  col: string;
  board_before: string[];
  board_after: string[];
  scores_before: string[];
  scores_after: string[];
  current_turn_before: string;
  player_card_ids: string[];
  blinding_factor: string;
}

/**
 * A generated proof with its public inputs.
 */
export interface Proof {
  proof: Uint8Array;
  publicInputs: string[];
}

/**
 * Serialized proof for WebSocket transport.
 */
export interface SerializedProof {
  proof: string;       // base64-encoded
  publicInputs: string[];
}

/**
 * Hand proof: proves a player owns 5 specific cards.
 * Public inputs: [card_commit_hash]
 */
export interface HandProof extends SerializedProof {
  type: 'hand';
  cardCommit: string;
}

/**
 * Move proof: proves a valid game state transition.
 * Public inputs: [card_commit_1, card_commit_2, start_state_hash, end_state_hash, game_ended, winner_id]
 */
export interface MoveProof extends SerializedProof {
  type: 'move';
  cardCommit1: string;
  cardCommit2: string;
  startStateHash: string;
  endStateHash: string;
  gameEnded: boolean;
  winnerId: number; // 0=none, 1=p1, 2=p2, 3=draw
}

/**
 * All proofs collected during a game, needed for on-chain settlement.
 */
export interface GameProofBundle {
  gameId: string;
  handProof1: HandProof;
  handProof2: HandProof;
  moveProofs: MoveProof[];
  winner: Player | 'draw';
  selectedCardId: number; // card the winner takes from the loser
}

/**
 * Player's secret game session data (never shared).
 */
export interface PlayerSession {
  cardIds: number[];
  blindingFactor: string;
  cardCommit: string;
}

export { GameState, Card, Player, Board, BoardCell };
