/**
 * Rules mirror — the harness's own copy of the game, advanced move-by-move
 * with @axolotl-arena/game-logic. After every placement the UI board (both
 * browsers) is compared against this, so a rules divergence between frontend,
 * TS engine, and (at settlement) the circuits is pinned to the exact move.
 *
 * TEMPORARY loading path: game-logic's dist is ESM inside a package that
 * declares no "type", so the test runner cannot load the package entry
 * (require() of typeless ESM). globalSetup bundles the package's own source
 * to a private CJS file (same single rules implementation, no duplication)
 * and this module requires that. Revert to a plain package import once
 * lane 3 lands `"type": "module"` (diff reported to the orchestrator).
 */
import { createRequire } from 'module';
import type { GameState, Player } from '@axolotl-arena/game-logic';
import { GAME_LOGIC_BUNDLE_PATH } from './env.js';

type GameLogic = typeof import('@axolotl-arena/game-logic');

// Lazy: the bundle is produced by globalSetup, which has not run yet when
// Playwright merely collects tests (--list) and imports this module.
let _logic: GameLogic | null = null;
function logic(): GameLogic {
  if (!_logic) {
    _logic = createRequire(import.meta.url)(GAME_LOGIC_BUNDLE_PATH) as GameLogic;
  }
  return _logic;
}

export interface BoardCellExpectation {
  cardId: number | null;
  owner: Player | null;
  originalOwner: Player | null;
}

/** One move as the transcript records it: the card, its slot in the mover's committed hand, the cell. */
export interface ExpectedMove {
  moveNumber: number;
  player: Player;
  cardId: number;
  slot: number;
  row: number;
  col: number;
}

/**
 * Triple Triad's "three open": hand slots 0..2 are shown to the opponent
 * (once proven), slots 3 and 4 stay face down until played
 * (docs/plan/PRIVATE_GAMES.md §6.2).
 */
export const OPEN_SLOTS = 3;

export function otherPlayer(player: Player): Player {
  return player === 'player1' ? 'player2' : 'player1';
}

export class ExpectedGame {
  state: GameState;
  /** Each side's five cards, in committed (slot) order. */
  readonly hands: Readonly<Record<Player, readonly number[]>>;
  /** Each side's slots not yet played, in slot order: what a hand index indexes. */
  private readonly unplayed: Record<Player, number[]>;
  /** The moves so far, in order. */
  readonly moves: ExpectedMove[] = [];

  constructor(p1CardIds: number[], p2CardIds: number[]) {
    const p1Cards = logic().getCardsByIds(p1CardIds);
    const p2Cards = logic().getCardsByIds(p2CardIds);
    if (p1Cards.length !== 5 || p2Cards.length !== 5) {
      throw new Error('ExpectedGame: both hands must resolve to 5 known cards');
    }
    this.state = logic().createGame(p1Cards, p2Cards);
    this.hands = { player1: [...p1CardIds], player2: [...p2CardIds] };
    this.unplayed = { player1: [0, 1, 2, 3, 4], player2: [0, 1, 2, 3, 4] };
  }

  apply(player: Player, handIndex: number, row: number, col: number): void {
    const slot = this.unplayed[player][handIndex];
    if (slot === undefined) throw new Error(`ExpectedGame: ${player} has no card at hand index ${handIndex}`);
    this.state = logic().placeCard(this.state, player, handIndex, row, col).newState;
    this.unplayed[player].splice(handIndex, 1);
    this.moves.push({ moveNumber: this.moves.length, player, cardId: this.hands[player][slot], slot, row, col });
  }

  get board(): BoardCellExpectation[][] {
    return this.state.board.map(row => row.map(cell => ({
      cardId: cell.card?.id ?? null,
      owner: cell.owner,
      originalOwner: cell.originalOwner,
    })));
  }

  get occupiedCount(): number {
    return this.state.board.flat().filter(c => c.card !== null).length;
  }

  /** `player`'s unplayed slots, in slot order. */
  unplayedSlots(player: Player): number[] {
    return [...this.unplayed[player]];
  }

  /** `player`'s unplayed cards, in slot order — their hand as they see it. */
  handOf(player: Player): number[] {
    return this.unplayed[player].map(slot => this.hands[player][slot]);
  }

  /** Scores as `player` sees them: their own, then the opponent's. */
  scoresFor(player: Player): { mine: number; theirs: number } {
    const p1 = this.state.player1Score;
    const p2 = this.state.player2Score;
    return player === 'player1' ? { mine: p1, theirs: p2 } : { mine: p2, theirs: p1 };
  }

  /** The circuit's `winner_id` for the game's result: 0 while playing, 1/2 a player, 3 a draw. */
  get winnerId(): number {
    const w = this.state.winner;
    return w === 'player1' ? 1 : w === 'player2' ? 2 : w === 'draw' ? 3 : 0;
  }

  /**
   * The card ids `player` placed (the cells they originally own), whoever
   * holds those cells now. A settlement's prize must be one the LOSER placed:
   * it is read off that move's proof (docs/plan/PRIVATE_GAMES.md section 8),
   * and the settlement dialog offers nothing else.
   */
  placedBy(player: Player): number[] {
    return this.state.board.flat()
      .filter(c => c.card !== null && c.originalOwner === player)
      .map(c => c.card!.id);
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
