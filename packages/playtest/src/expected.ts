/**
 * Rules mirror — the harness's own copy of the game, advanced move-by-move
 * with @axolotl-arena/game-logic. After every placement the UI board (both
 * browsers) is compared against this, so a rules divergence between frontend,
 * TS engine, and (at settlement) the circuits is pinned to the exact move.
 */
import {
  createGame, placeCard, getCardsByIds,
  type GameState, type Player,
} from '@axolotl-arena/game-logic';

export interface BoardCellExpectation {
  cardId: number | null;
  owner: Player | null;
}

export class ExpectedGame {
  state: GameState;

  constructor(p1CardIds: number[], p2CardIds: number[]) {
    const p1Cards = getCardsByIds(p1CardIds);
    const p2Cards = getCardsByIds(p2CardIds);
    if (p1Cards.length !== 5 || p2Cards.length !== 5) {
      throw new Error('ExpectedGame: both hands must resolve to 5 known cards');
    }
    this.state = createGame(p1Cards, p2Cards);
  }

  apply(player: Player, handIndex: number, row: number, col: number): void {
    this.state = placeCard(this.state, player, handIndex, row, col).newState;
  }

  get board(): BoardCellExpectation[][] {
    return this.state.board.map(row => row.map(cell => ({
      cardId: cell.card?.id ?? null,
      owner: cell.owner,
    })));
  }

  get occupiedCount(): number {
    return this.state.board.flat().filter(c => c.card !== null).length;
  }

  /** Deterministic Phase-1 policy: hand slot 0 into the first empty cell, row-major. */
  nextMove(): { handIndex: number; row: number; col: number } {
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        if (!this.state.board[row][col].card) return { handIndex: 0, row, col };
      }
    }
    throw new Error('ExpectedGame: board is full');
  }
}
