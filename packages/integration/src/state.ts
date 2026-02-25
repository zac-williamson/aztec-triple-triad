import type { GameState, Board, Player, Card } from '@aztec-triple-triad/game-logic';
import type { CircuitBoard, GameMoveInput } from './types.js';

/**
 * Convert a Player to circuit field value.
 * player1 = "1", player2 = "2"
 */
export function playerToField(player: Player): string {
  return player === 'player1' ? '1' : '2';
}

/**
 * Convert a circuit field value back to Player.
 */
export function fieldToPlayer(field: string): Player {
  return field === '1' ? 'player1' : 'player2';
}

/**
 * Convert winner to circuit winner_id.
 * 0=not ended, 1=player1, 2=player2, 3=draw
 */
export function winnerToField(winner: Player | 'draw' | null): string {
  if (winner === null) return '0';
  if (winner === 'player1') return '1';
  if (winner === 'player2') return '2';
  return '3'; // draw
}

/**
 * Serialize a game board to the flat circuit format.
 * Returns 18-element array: for each of the 9 cells (row-major order),
 * [card_id, owner] where 0 = empty/none.
 */
export function boardToCircuitFormat(board: Board): string[] {
  const result: string[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cell = board[r][c];
      if (cell.card && cell.owner) {
        result.push(String(cell.card.id));
        result.push(playerToField(cell.owner));
      } else {
        result.push('0');
        result.push('0');
      }
    }
  }
  return result;
}

/**
 * Serialize scores to circuit format: [player1_score, player2_score].
 */
export function scoresToCircuitFormat(state: GameState): string[] {
  return [String(state.player1Score), String(state.player2Score)];
}

/**
 * Compute the full board state representation for hashing.
 * Returns [board(18), scores(2), current_turn(1)] = 21 fields.
 */
export function gameStateToHashInput(state: GameState): string[] {
  const board = boardToCircuitFormat(state.board);
  const scores = scoresToCircuitFormat(state);
  const turn = playerToField(state.currentTurn);
  return [...board, ...scores, turn];
}

/**
 * Build a GameMoveInput from before/after game states and the move details.
 * This is the input needed for the game_move circuit.
 */
export function buildGameMoveInput(
  stateBefore: GameState,
  stateAfter: GameState,
  player: Player,
  card: Card,
  row: number,
  col: number,
  cardCommit1: string,
  cardCommit2: string,
  startStateHash: string,
  endStateHash: string,
): GameMoveInput {
  const gameEnded = stateAfter.status === 'finished' ? '1' : '0';
  const winnerId = winnerToField(stateAfter.winner);

  return {
    // Public inputs
    card_commit_1: cardCommit1,
    card_commit_2: cardCommit2,
    start_state_hash: startStateHash,
    end_state_hash: endStateHash,
    game_ended: gameEnded,
    winner_id: winnerId,
    // Private inputs
    current_player: playerToField(player),
    card_id: String(card.id),
    card_ranks: [
      String(card.ranks.top),
      String(card.ranks.right),
      String(card.ranks.bottom),
      String(card.ranks.left),
    ],
    row: String(row),
    col: String(col),
    board_before: boardToCircuitFormat(stateBefore.board),
    board_after: boardToCircuitFormat(stateAfter.board),
    scores_before: scoresToCircuitFormat(stateBefore),
    scores_after: scoresToCircuitFormat(stateAfter),
    current_turn_before: playerToField(stateBefore.currentTurn),
    player1_hand_count_after: String(stateAfter.player1Hand.length),
    player2_hand_count_after: String(stateAfter.player2Hand.length),
  };
}

/**
 * Build prove_hand input fields.
 */
export function buildProveHandInput(
  playerSecret: string,
  playerAddress: string,
  gameId: string,
  cardIds: number[],
  cardNullifierSecrets: string[],
  cardCommit: string,
) {
  return {
    card_commit: cardCommit,
    player_address: playerAddress,
    game_id: gameId,
    player_secret: playerSecret,
    card_ids: cardIds.map(String),
    card_nullifier_secrets: cardNullifierSecrets,
  };
}
