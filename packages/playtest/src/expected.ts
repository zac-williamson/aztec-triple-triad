/**
 * Rules mirror — the harness's own copy of the game, advanced move-by-move
 * with @axolotl-arena/game-logic. After every placement the UI board (both
 * browsers) is compared against this, so a rules divergence between frontend,
 * TS engine, and (at settlement) the circuits is pinned to the exact move.
 *
 * game-logic is loaded via dynamic import(): its dist is ESM but its
 * package.json declares no "type", so a static import from Playwright's
 * CJS-transformed test files fails (`require()` of typeless ESM). Dynamic
 * import goes through Node's ESM loader, which detects the syntax. The real
 * fix is `"type": "module"` in game-logic's package.json — lane 3's file;
 * flagged in the lane brief's coordination notes.
 */
import type { GameState, Player } from '@axolotl-arena/game-logic';

type GameLogic = typeof import('@axolotl-arena/game-logic');

export interface BoardCellExpectation {
  cardId: number | null;
  owner: Player | null;
}

export class ExpectedGame {
  private constructor(private readonly logic: GameLogic, public state: GameState) {}

  static async create(p1CardIds: number[], p2CardIds: number[]): Promise<ExpectedGame> {
    const logic = await import('@axolotl-arena/game-logic');
    const p1Cards = logic.getCardsByIds(p1CardIds);
    const p2Cards = logic.getCardsByIds(p2CardIds);
    if (p1Cards.length !== 5 || p2Cards.length !== 5) {
      throw new Error('ExpectedGame: both hands must resolve to 5 known cards');
    }
    return new ExpectedGame(logic, logic.createGame(p1Cards, p2Cards));
  }

  apply(player: Player, handIndex: number, row: number, col: number): void {
    this.state = this.logic.placeCard(this.state, player, handIndex, row, col).newState;
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
