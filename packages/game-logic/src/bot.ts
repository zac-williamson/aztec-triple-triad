import type { Board, Card, GameState, Player } from './types.js';
import { DIRECTIONS, getValidPlacements, placeCard } from './game.js';

/** A move for the player whose turn it is: hand card index + target cell. */
export interface Move {
  handIndex: number;
  row: number;
  col: number;
}

export type BotDifficulty = 'random' | 'greedy' | 'lookahead';

export interface ChooseBotMoveOptions {
  difficulty: BotDifficulty;
  /**
   * Seeds move selection: same state + same options always yields the same
   * move (required by the playtest harness for reproducible campaigns).
   * Omitted: ties are broken with Math.random.
   */
  seed?: number;
}

/**
 * mulberry32 PRNG. Uses only 32-bit integer ops, so sequences are identical
 * across JS engines. Returns values in [0, 1).
 */
export function createSeededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function currentHand(state: GameState): Card[] {
  return state.currentTurn === 'player1' ? state.player1Hand : state.player2Hand;
}

/** All legal (handIndex, cell) pairs for the player to move, in a fixed order. */
function enumerateMoves(state: GameState): Move[] {
  const moves: Move[] = [];
  const handSize = currentHand(state).length;
  for (const { row, col } of getValidPlacements(state)) {
    for (let handIndex = 0; handIndex < handSize; handIndex++) {
      moves.push({ handIndex, row, col });
    }
  }
  return moves;
}

/**
 * How flippable the card at (row, col) is: sum of (10 - rank) over its edges
 * that face an empty in-board cell. Edges against walls or occupied cells can
 * never be attacked, so they don't count. Lower is safer.
 */
function exposure(board: Board, row: number, col: number): number {
  const card = board[row][col].card!;
  let total = 0;
  for (const dir of DIRECTIONS) {
    const nr = row + dir.dr;
    const nc = col + dir.dc;
    if (nr < 0 || nr > 2 || nc < 0 || nc > 2) continue;
    if (board[nr][nc].card === null) {
      total += 10 - card.ranks[dir.attackerRank];
    }
  }
  return total;
}

/** Card-count lead from `player`'s perspective (hand + board, as scored). */
function scoreDiff(state: GameState, player: Player): number {
  return player === 'player1'
    ? state.player1Score - state.player2Score
    : state.player2Score - state.player1Score;
}

/**
 * Minimax value of `state` for `player`, one reply deep: the opponent (to
 * move in `state`) picks the reply that minimizes `player`'s card lead. A
 * state with no replies (game over, or an opponent belief-state with an
 * empty hand) evaluates statically.
 */
function valueAfterBestReply(state: GameState, player: Player): number {
  if (state.status === 'finished') {
    return scoreDiff(state, player);
  }
  let worst = Infinity;
  for (const reply of enumerateMoves(state)) {
    const { newState } = placeCard(state, state.currentTurn, reply.handIndex, reply.row, reply.col);
    const value = scoreDiff(newState, player);
    if (value < worst) worst = value;
  }
  return worst === Infinity ? scoreDiff(state, player) : worst;
}

/** Lexicographic comparison: first differing component decides. */
function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** The move with the lexicographically largest key; ties broken by `rng`. */
function pickBest(scored: { move: Move; key: number[] }[], rng: () => number): Move {
  let bestKey = scored[0].key;
  let ties = [scored[0].move];
  for (let i = 1; i < scored.length; i++) {
    const cmp = compareKeys(scored[i].key, bestKey);
    if (cmp > 0) {
      bestKey = scored[i].key;
      ties = [scored[i].move];
    } else if (cmp === 0) {
      ties.push(scored[i].move);
    }
  }
  return ties[Math.floor(rng() * ties.length)];
}

/**
 * Pick a move for the player whose turn it is (`state.currentTurn`).
 *
 * - `random`: uniform over all legal (card, cell) pairs.
 * - `greedy`: maximize immediate captures (chains included), tiebreak by
 *   minimizing the placed card's exposure.
 * - `lookahead`: maximize the card-count lead after the opponent's best
 *   reply (2-ply minimax over the full state), tiebreak by the greedy
 *   criteria. Uses both hands as given — callers without perfect information
 *   (e.g. the house bot) supply their best belief of the opponent's hand.
 *
 * Throws if the game is not in progress or there is no legal move.
 */
export function chooseBotMove(state: GameState, opts: ChooseBotMoveOptions): Move {
  if (state.status !== 'playing') {
    throw new Error(`Cannot choose a move: game status is '${state.status}'`);
  }
  const moves = enumerateMoves(state);
  if (moves.length === 0) {
    throw new Error('Cannot choose a move: no valid moves available');
  }
  const rng = opts.seed !== undefined ? createSeededRng(opts.seed) : Math.random;

  if (opts.difficulty === 'random') {
    return moves[Math.floor(rng() * moves.length)];
  }

  const player = state.currentTurn;
  const scored = moves.map(move => {
    const { newState, captures } = placeCard(state, player, move.handIndex, move.row, move.col);
    const key = [captures.length, -exposure(newState.board, move.row, move.col)];
    if (opts.difficulty === 'lookahead') {
      key.unshift(valueAfterBestReply(newState, player));
    }
    return { move, key };
  });
  return pickBest(scored, rng);
}
