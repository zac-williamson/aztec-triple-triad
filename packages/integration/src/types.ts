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
 */
export interface ProveHandInput {
  // Public inputs
  card_commit: string;
  player_address: string;
  game_id: string;
  // Private inputs
  player_secret: string;
  card_ids: string[];
  card_nullifier_secrets: string[];
}

/**
 * Input for the game_move circuit.
 */
export interface GameMoveInput {
  // Public inputs
  card_commit_1: string;
  card_commit_2: string;
  start_state_hash: string;
  end_state_hash: string;
  game_ended: string;
  winner_id: string;
  // Private inputs
  current_player: string;
  card_id: string;
  card_ranks: string[];
  row: string;
  col: string;
  board_before: string[];
  board_after: string[];
  scores_before: string[];
  scores_after: string[];
  current_turn_before: string;
  player1_hand_count_after: string;
  player2_hand_count_after: string;
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
 */
export interface HandProof extends SerializedProof {
  type: 'hand';
  cardCommit: string;
  playerAddress: string;
  gameId: string;
}

/**
 * Move proof: proves a valid game state transition.
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
  playerSecret: string;
  playerAddress: string;
  cardIds: number[];
  cardNullifierSecrets: string[];
  cardCommit: string;
}

export { GameState, Card, Player, Board, BoardCell };
