import { describe, it, expect } from 'vitest';
import { chooseBotMove, createSeededRng } from '../src/bot.js';
import type { BotDifficulty, Move } from '../src/bot.js';
import { createGame, placeCard, calculateScores } from '../src/game.js';
import { getCardsByIds } from '../src/cards.js';
import type { Board, Card, GameState, Player } from '../src/types.js';

function makeCard(id: number, top: number, right: number, bottom: number, left: number): Card {
  return { id, name: `Card${id}`, ranks: { top, right, bottom, left } };
}

/**
 * Build a mid-game position directly. The bot only reads board/hands/turn/status
 * (scores are recomputed by placeCard during simulation), but we set scores
 * consistently anyway so the state is a valid GameState.
 */
function craftState(opts: {
  placed: { row: number; col: number; card: Card; owner: Player }[];
  p1Hand: Card[];
  p2Hand: Card[];
  turn: Player;
  status?: GameState['status'];
}): GameState {
  const board: Board = Array.from({ length: 3 }, () =>
    Array.from({ length: 3 }, () => ({ card: null, owner: null, originalOwner: null }))
  );
  for (const p of opts.placed) {
    board[p.row][p.col] = { card: p.card, owner: p.owner, originalOwner: p.owner };
  }
  const state: GameState = {
    board,
    player1Hand: opts.p1Hand,
    player2Hand: opts.p2Hand,
    currentTurn: opts.turn,
    player1Score: 0,
    player2Score: 0,
    status: opts.status ?? 'playing',
    winner: null,
  };
  const scores = calculateScores(state);
  state.player1Score = scores.player1;
  state.player2Score = scores.player2;
  return state;
}

function freshGame(): GameState {
  return createGame(getCardsByIds([1, 2, 3, 4, 5]), getCardsByIds([6, 7, 8, 9, 10]));
}

/** Self-play a full game; throws (failing the test) if the bot ever returns an illegal move. */
function playFullGame(d1: BotDifficulty, d2: BotDifficulty, seed: number): { state: GameState; transcript: Move[] } {
  let state = freshGame();
  const transcript: Move[] = [];
  let turn = 0;
  while (state.status === 'playing') {
    const difficulty = state.currentTurn === 'player1' ? d1 : d2;
    const move = chooseBotMove(state, { difficulty, seed: seed * 100 + turn });
    transcript.push(move);
    state = placeCard(state, state.currentTurn, move.handIndex, move.row, move.col).newState;
    turn++;
  }
  return { state, transcript };
}

const ALL_DIFFICULTIES: BotDifficulty[] = ['random', 'greedy', 'lookahead'];

describe('createSeededRng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = createSeededRng(12345);
    const b = createSeededRng(12345);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = createSeededRng(1);
    const b = createSeededRng(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('outputs values in [0, 1)', () => {
    const rng = createSeededRng(999);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('chooseBotMove validation', () => {
  it('throws when the game is finished', () => {
    const state: GameState = { ...freshGame(), status: 'finished' };
    expect(() => chooseBotMove(state, { difficulty: 'random', seed: 1 })).toThrow(/finished/);
  });

  it('throws when the game has not started', () => {
    const state: GameState = { ...freshGame(), status: 'waiting' };
    expect(() => chooseBotMove(state, { difficulty: 'random', seed: 1 })).toThrow(/waiting/);
  });

  it('throws when the current player has no cards', () => {
    const state = craftState({
      placed: [],
      p1Hand: [],
      p2Hand: [makeCard(1, 1, 1, 1, 1)],
      turn: 'player1',
    });
    expect(() => chooseBotMove(state, { difficulty: 'random', seed: 1 })).toThrow(/no valid moves/);
  });

  it('throws when the board is full', () => {
    const placed = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        placed.push({ row: r, col: c, card: makeCard(r * 3 + c, 5, 5, 5, 5), owner: 'player1' as Player });
      }
    }
    const state = craftState({
      placed,
      p1Hand: [makeCard(100, 1, 1, 1, 1)],
      p2Hand: [makeCard(101, 1, 1, 1, 1)],
      turn: 'player1',
    });
    expect(() => chooseBotMove(state, { difficulty: 'greedy', seed: 1 })).toThrow(/no valid moves/);
  });
});

describe('chooseBotMove determinism', () => {
  it.each(ALL_DIFFICULTIES)('%s: same state + same seed gives the same move', difficulty => {
    const state = freshGame();
    const a = chooseBotMove(state, { difficulty, seed: 42 });
    const b = chooseBotMove(state, { difficulty, seed: 42 });
    expect(a).toEqual(b);
  });

  it('seed 0 is a valid deterministic seed', () => {
    const state = freshGame();
    const a = chooseBotMove(state, { difficulty: 'random', seed: 0 });
    const b = chooseBotMove(state, { difficulty: 'random', seed: 0 });
    expect(a).toEqual(b);
  });

  it.each(ALL_DIFFICULTIES)('%s: full self-play games with the same seeds are identical', difficulty => {
    const first = playFullGame(difficulty, difficulty, 7);
    const second = playFullGame(difficulty, difficulty, 7);
    expect(first.transcript).toEqual(second.transcript);
    expect(first.state).toEqual(second.state);
  });

  it('random: different seeds produce different moves on the opening board', () => {
    const state = freshGame();
    const moves = new Set<string>();
    for (let seed = 1; seed <= 50; seed++) {
      const m = chooseBotMove(state, { difficulty: 'random', seed });
      moves.add(`${m.handIndex},${m.row},${m.col}`);
    }
    expect(moves.size).toBeGreaterThan(1);
  });

  it('works unseeded (falls back to Math.random)', () => {
    const state = freshGame();
    const move = chooseBotMove(state, { difficulty: 'random' });
    expect(move.handIndex).toBeGreaterThanOrEqual(0);
    expect(move.handIndex).toBeLessThan(5);
    expect(state.board[move.row][move.col].card).toBeNull();
  });
});

describe('chooseBotMove purity', () => {
  it.each(ALL_DIFFICULTIES)('%s: does not mutate the input state', difficulty => {
    const state = freshGame();
    const snapshot = JSON.stringify(state);
    chooseBotMove(state, { difficulty, seed: 3 });
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe('random difficulty', () => {
  it('always returns a legal move across many seeds', () => {
    const state = freshGame();
    for (let seed = 1; seed <= 30; seed++) {
      const m = chooseBotMove(state, { difficulty: 'random', seed });
      expect(m.handIndex).toBeGreaterThanOrEqual(0);
      expect(m.handIndex).toBeLessThan(state.player1Hand.length);
      expect(state.board[m.row][m.col].card).toBeNull();
    }
  });
});

// Position: lone P2 card at (0,0) with right=1. The bot's only capturing
// option is its left=10 card placed at (0,1) — every other card/cell combination
// captures nothing.
function captureForcedState(): GameState {
  return craftState({
    placed: [
      { row: 0, col: 0, card: makeCard(201, 1, 1, 1, 1), owner: 'player2' },
      { row: 2, col: 2, card: makeCard(102, 1, 1, 1, 1), owner: 'player1' },
    ],
    p1Hand: [
      makeCard(101, 1, 1, 1, 10), // left=10: captures from (0,1)
      makeCard(103, 1, 1, 1, 1),
      makeCard(104, 1, 1, 1, 1),
      makeCard(105, 1, 1, 1, 1),
    ],
    p2Hand: [
      makeCard(202, 1, 1, 1, 1),
      makeCard(203, 1, 1, 1, 1),
      makeCard(204, 1, 1, 1, 1),
      makeCard(205, 1, 1, 1, 1),
    ],
    turn: 'player1',
  });
}

describe('greedy difficulty', () => {
  it('takes the only available capture', () => {
    const move = chooseBotMove(captureForcedState(), { difficulty: 'greedy', seed: 5 });
    expect(move).toEqual({ handIndex: 0, row: 0, col: 1 });
  });

  it('prefers a chain capture (2 flips) over a single capture', () => {
    // Strong card [1,1,1,10] at (0,2) captures H=(0,1) directly, and H
    // (left=5) chain-captures G=(0,0). The same card at (1,1) captures only
    // L=(1,0). Everything else captures nothing.
    const state = craftState({
      placed: [
        { row: 0, col: 0, card: makeCard(201, 1, 1, 1, 1), owner: 'player2' }, // G
        { row: 0, col: 1, card: makeCard(202, 1, 1, 1, 5), owner: 'player2' }, // H: right=1, left=5
        { row: 1, col: 0, card: makeCard(203, 1, 1, 1, 1), owner: 'player2' }, // L
        { row: 2, col: 0, card: makeCard(204, 5, 5, 5, 5), owner: 'player2' }, // P
        { row: 2, col: 1, card: makeCard(103, 5, 5, 5, 5), owner: 'player1' }, // M
        { row: 2, col: 2, card: makeCard(104, 5, 5, 5, 5), owner: 'player1' }, // N
      ],
      p1Hand: [
        makeCard(101, 1, 1, 1, 10), // left=10
        makeCard(102, 1, 1, 1, 1),
      ],
      p2Hand: [
        makeCard(205, 1, 1, 1, 1),
        makeCard(206, 1, 1, 1, 1),
      ],
      turn: 'player1',
    });

    // Sanity-check the position itself: the chain move flips 2, the alternative flips 1.
    expect(placeCard(state, 'player1', 0, 0, 2).captures.length).toBe(2);
    expect(placeCard(state, 'player1', 0, 1, 1).captures.length).toBe(1);

    const move = chooseBotMove(state, { difficulty: 'greedy', seed: 5 });
    expect(move).toEqual({ handIndex: 0, row: 0, col: 2 });
  });

  it('tiebreaks equal captures by hiding weak edges (minimal exposure)', () => {
    // Opening board: no captures anywhere. Hand cards are [10,10,1,1]
    // (strong top/right, weak bottom/left). Corner (2,0) hides both weak
    // edges against the walls and exposes only the two 10s — uniquely minimal.
    const card = (id: number) => makeCard(id, 10, 10, 1, 1);
    const state = createGame(
      [card(1), card(2), card(3), card(4), card(5)],
      getCardsByIds([6, 7, 8, 9, 10])
    );
    const move = chooseBotMove(state, { difficulty: 'greedy', seed: 11 });
    expect({ row: move.row, col: move.col }).toEqual({ row: 2, col: 0 });
  });

  it('plays as player2 when it is player2\'s turn', () => {
    // Mirror of the forced capture: P1 card at (0,0) with right=1, P2 holds left=10.
    const state = craftState({
      placed: [
        { row: 0, col: 0, card: makeCard(101, 1, 1, 1, 1), owner: 'player1' },
      ],
      p1Hand: [
        makeCard(102, 1, 1, 1, 1),
        makeCard(103, 1, 1, 1, 1),
        makeCard(104, 1, 1, 1, 1),
        makeCard(105, 1, 1, 1, 1),
      ],
      p2Hand: [
        makeCard(201, 1, 1, 1, 10),
        makeCard(202, 1, 1, 1, 1),
        makeCard(203, 1, 1, 1, 1),
        makeCard(204, 1, 1, 1, 1),
        makeCard(205, 1, 1, 1, 1),
      ],
      turn: 'player2',
    });
    const move = chooseBotMove(state, { difficulty: 'greedy', seed: 5 });
    expect(move).toEqual({ handIndex: 0, row: 0, col: 1 });
  });
});

// Deny-capture position. P1 (bot) to move; empty cells (0,1), (0,2), (2,2).
//
//   (0,0) P1 X [1,1,1,1]   (0,1) EMPTY            (0,2) EMPTY
//   (1,0) P2 B [5,5,5,5]   (1,1) P1 C [5,5,5,5]   (1,2) P2 D [9,5,9,5]
//   (2,0) P2 E [5,5,5,5]   (2,1) P2 F [5,9,5,5]   (2,2) EMPTY
//
// P2 holds O1 [1,1,1,9]: placing it at (0,1) captures X (left 9 > right 1) —
// P2's only capture threat. The bot captures nothing anywhere (D/F/O-facing
// ranks are all >= its 2s).
//
// Greedy: all moves capture 0, so it minimizes exposure → (2,2) (fully
// walled/buttressed, exposure 0) and leaves (0,1) open. Lookahead sees the
// reply O1@(0,1) costs a 2-point swing and instead occupies (0,1) itself;
// its right=9 edge cannot be flipped from (0,2) (9 > 9 is not a capture).
function denyCaptureState(): GameState {
  const botCard = (id: number) => makeCard(id, 2, 9, 2, 2);
  return craftState({
    placed: [
      { row: 0, col: 0, card: makeCard(101, 1, 1, 1, 1), owner: 'player1' }, // X — vulnerable
      { row: 1, col: 0, card: makeCard(201, 5, 5, 5, 5), owner: 'player2' }, // B
      { row: 1, col: 1, card: makeCard(102, 5, 5, 5, 5), owner: 'player1' }, // C
      { row: 1, col: 2, card: makeCard(202, 9, 5, 9, 5), owner: 'player2' }, // D
      { row: 2, col: 0, card: makeCard(203, 5, 5, 5, 5), owner: 'player2' }, // E
      { row: 2, col: 1, card: makeCard(204, 5, 9, 5, 5), owner: 'player2' }, // F
    ],
    p1Hand: [botCard(103), botCard(104)],
    p2Hand: [
      makeCard(205, 1, 1, 1, 9), // O1 — the threat
      makeCard(206, 1, 1, 1, 1), // O2
    ],
    turn: 'player1',
  });
}

describe('lookahead difficulty', () => {
  it('takes the only available capture', () => {
    const move = chooseBotMove(captureForcedState(), { difficulty: 'lookahead', seed: 5 });
    expect(move).toEqual({ handIndex: 0, row: 0, col: 1 });
  });

  it('denies the opponent\'s capture square where greedy does not', () => {
    const state = denyCaptureState();

    // Sanity-check the threat: if the bot plays greedy's corner, O1@(0,1) flips X.
    const afterGreedyChoice = placeCard(state, 'player1', 0, 2, 2).newState;
    const oppCapture = placeCard(afterGreedyChoice, 'player2', 0, 0, 1);
    expect(oppCapture.captures).toEqual([{ row: 0, col: 0 }]);

    const greedyMove = chooseBotMove(state, { difficulty: 'greedy', seed: 9 });
    expect({ row: greedyMove.row, col: greedyMove.col }).toEqual({ row: 2, col: 2 });

    const lookaheadMove = chooseBotMove(state, { difficulty: 'lookahead', seed: 9 });
    expect({ row: lookaheadMove.row, col: lookaheadMove.col }).toEqual({ row: 0, col: 1 });

    // After the denial, the opponent has no capture anywhere.
    const afterDeny = placeCard(state, 'player1', lookaheadMove.handIndex, 0, 1).newState;
    for (const cell of [{ row: 0, col: 2 }, { row: 2, col: 2 }]) {
      for (let h = 0; h < 2; h++) {
        expect(placeCard(afterDeny, 'player2', h, cell.row, cell.col).captures).toEqual([]);
      }
    }
  });

  it('handles an empty opponent hand by falling back to static evaluation', () => {
    // A belief-state the house bot may construct when the opponent's hand is
    // unknown: with no replies to search, lookahead degrades to greedy-on-score
    // and still takes the capture.
    const state = captureForcedState();
    state.player2Hand = [];
    const move = chooseBotMove(state, { difficulty: 'lookahead', seed: 5 });
    expect(move).toEqual({ handIndex: 0, row: 0, col: 1 });
  });
});

describe('self-play', () => {
  it.each(ALL_DIFFICULTIES)('%s: completes full games with only legal moves', difficulty => {
    for (let seed = 1; seed <= 5; seed++) {
      const { state, transcript } = playFullGame(difficulty, difficulty, seed);
      expect(state.status).toBe('finished');
      expect(state.winner).not.toBeNull();
      expect(transcript.length).toBe(9);
    }
  });

  it('mixed difficulties complete full games', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const { state } = playFullGame('lookahead', 'random', seed);
      expect(state.status).toBe('finished');
    }
  });

  it('lookahead beats random over a mirrored set of seeded games', () => {
    let lookaheadWins = 0;
    let randomWins = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const asP1 = playFullGame('lookahead', 'random', seed).state;
      if (asP1.winner === 'player1') lookaheadWins++;
      else if (asP1.winner === 'player2') randomWins++;

      const asP2 = playFullGame('random', 'lookahead', seed).state;
      if (asP2.winner === 'player2') lookaheadWins++;
      else if (asP2.winner === 'player1') randomWins++;
    }
    expect(lookaheadWins).toBeGreaterThan(randomWins);
  });
});
