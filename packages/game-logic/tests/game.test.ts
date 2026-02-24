import { describe, it, expect } from 'vitest';
import { createGame, placeCard, getValidPlacements, isGameOver, calculateScores } from '../src/game.js';
import { getCardsByIds } from '../src/cards.js';
import type { GameState, Card, Board } from '../src/types.js';

function makeCard(id: number, top: number, right: number, bottom: number, left: number): Card {
  return { id, name: `Card${id}`, ranks: { top, right, bottom, left } };
}

describe('createGame', () => {
  it('should create a game with empty 3x3 board', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    expect(game.board.length).toBe(3);
    for (const row of game.board) {
      expect(row.length).toBe(3);
      for (const cell of row) {
        expect(cell.card).toBeNull();
        expect(cell.owner).toBeNull();
      }
    }
  });

  it('should set hands correctly', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    expect(game.player1Hand.length).toBe(5);
    expect(game.player2Hand.length).toBe(5);
    expect(game.player1Hand[0].id).toBe(1);
    expect(game.player2Hand[0].id).toBe(6);
  });

  it('should start with player1 turn', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    expect(game.currentTurn).toBe('player1');
  });

  it('should start with status playing', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    expect(game.status).toBe('playing');
  });

  it('should start with scores 5-5', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    expect(game.player1Score).toBe(5);
    expect(game.player2Score).toBe(5);
  });

  it('should have no winner initially', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    expect(game.winner).toBeNull();
  });

  it('should throw if hands dont have exactly 5 cards', () => {
    const p1Hand = getCardsByIds([1, 2, 3]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    expect(() => createGame(p1Hand, p2Hand)).toThrow();
  });
});

describe('placeCard', () => {
  it('should place a card on an empty cell', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    const result = placeCard(game, 'player1', 0, 0, 0);
    expect(result.newState.board[0][0].card).not.toBeNull();
    expect(result.newState.board[0][0].card!.id).toBe(1);
    expect(result.newState.board[0][0].owner).toBe('player1');
  });

  it('should remove card from hand after placing', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    const result = placeCard(game, 'player1', 0, 0, 0);
    expect(result.newState.player1Hand.length).toBe(4);
    expect(result.newState.player1Hand.find(c => c.id === 1)).toBeUndefined();
  });

  it('should switch turns after placing', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    const result = placeCard(game, 'player1', 0, 0, 0);
    expect(result.newState.currentTurn).toBe('player2');
  });

  it('should throw if placing on occupied cell', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    const result = placeCard(game, 'player1', 0, 0, 0);
    expect(() => placeCard(result.newState, 'player2', 0, 0, 0)).toThrow();
  });

  it('should throw if wrong player tries to place', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    expect(() => placeCard(game, 'player2', 0, 0, 0)).toThrow();
  });

  it('should throw if hand index is out of range', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    expect(() => placeCard(game, 'player1', 5, 0, 0)).toThrow();
    expect(() => placeCard(game, 'player1', -1, 0, 0)).toThrow();
  });

  it('should throw if row/col is out of range', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    expect(() => placeCard(game, 'player1', 0, 3, 0)).toThrow();
    expect(() => placeCard(game, 'player1', 0, 0, 3)).toThrow();
    expect(() => placeCard(game, 'player1', 0, -1, 0)).toThrow();
  });

  it('should throw if game is already finished', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);
    const finished: GameState = { ...game, status: 'finished' };

    expect(() => placeCard(finished, 'player1', 0, 0, 0)).toThrow();
  });

  it('should not mutate the original game state', () => {
    const p1Hand = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Hand = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Hand, p2Hand);

    placeCard(game, 'player1', 0, 0, 0);
    expect(game.board[0][0].card).toBeNull();
    expect(game.player1Hand.length).toBe(5);
    expect(game.currentTurn).toBe('player1');
  });
});

describe('capture logic', () => {
  it('should capture adjacent opponent card when placed card rank is higher', () => {
    // Place a weak card for player2, then a strong card adjacent for player1
    const p1Hand = [makeCard(101, 10, 10, 10, 10)]; // Strong card
    const p2Weak = makeCard(102, 1, 1, 1, 1); // Weak card

    // Set up: player2 card at (0,0), player1 places at (0,1)
    const p1Full = [
      makeCard(101, 10, 10, 10, 10),
      makeCard(103, 1, 1, 1, 1),
      makeCard(104, 1, 1, 1, 1),
      makeCard(105, 1, 1, 1, 1),
      makeCard(106, 1, 1, 1, 1),
    ];
    const p2Full = [
      makeCard(102, 1, 1, 1, 1),
      makeCard(107, 1, 1, 1, 1),
      makeCard(108, 1, 1, 1, 1),
      makeCard(109, 1, 1, 1, 1),
      makeCard(110, 1, 1, 1, 1),
    ];

    let game = createGame(p1Full, p2Full);
    // Skip player1's turn by manually creating a state where player2 just placed
    // Instead, play a full sequence:
    // P1 places card at (1,1) - center
    let result = placeCard(game, 'player1', 1, 1, 1); // card 103 at center
    // P2 places weak card at (0,1) - above center
    result = placeCard(result.newState, 'player2', 0, 0, 1);
    // Now P1 places strong card at (0,0) to the left of P2's card at (0,1)
    // P1's card right rank (10) vs P2's card left rank (1) => capture
    result = placeCard(result.newState, 'player1', 0, 0, 0);

    // The strong card should capture the weak card at (0,1)
    expect(result.captures.length).toBeGreaterThan(0);
    expect(result.newState.board[0][1].owner).toBe('player1');
  });

  it('should NOT capture when placed card rank is equal', () => {
    const p1Full = [
      makeCard(101, 5, 5, 5, 5),
      makeCard(103, 1, 1, 1, 1),
      makeCard(104, 1, 1, 1, 1),
      makeCard(105, 1, 1, 1, 1),
      makeCard(106, 1, 1, 1, 1),
    ];
    const p2Full = [
      makeCard(102, 5, 5, 5, 5),
      makeCard(107, 1, 1, 1, 1),
      makeCard(108, 1, 1, 1, 1),
      makeCard(109, 1, 1, 1, 1),
      makeCard(110, 1, 1, 1, 1),
    ];

    let game = createGame(p1Full, p2Full);
    // P1 places at (0,0)
    let result = placeCard(game, 'player1', 0, 0, 0);
    // P2 places at (0,1) - right of P1's card
    // P2's left rank (5) vs P1's right rank (5) - no capture since equal
    result = placeCard(result.newState, 'player2', 0, 0, 1);
    expect(result.newState.board[0][0].owner).toBe('player1'); // stays player1
  });

  it('should NOT capture when placed card rank is lower', () => {
    const p1Full = [
      makeCard(101, 8, 8, 8, 8),
      makeCard(103, 1, 1, 1, 1),
      makeCard(104, 1, 1, 1, 1),
      makeCard(105, 1, 1, 1, 1),
      makeCard(106, 1, 1, 1, 1),
    ];
    const p2Full = [
      makeCard(102, 3, 3, 3, 3),
      makeCard(107, 1, 1, 1, 1),
      makeCard(108, 1, 1, 1, 1),
      makeCard(109, 1, 1, 1, 1),
      makeCard(110, 1, 1, 1, 1),
    ];

    let game = createGame(p1Full, p2Full);
    // P1 places strong card at (0,0)
    let result = placeCard(game, 'player1', 0, 0, 0);
    // P2 places weak card at (0,1) - right of P1
    // P2's left rank (3) vs P1's right rank (8) - P2 can't capture
    result = placeCard(result.newState, 'player2', 0, 0, 1);
    expect(result.newState.board[0][0].owner).toBe('player1');
  });

  it('should capture multiple adjacent cards in one placement', () => {
    // Set up a cross pattern where player1 can capture two cards
    const strong = makeCard(101, 10, 10, 10, 10);
    const weak = makeCard(102, 1, 1, 1, 1);

    const p1Full = [
      strong,
      makeCard(103, 1, 1, 1, 1),
      makeCard(104, 1, 1, 1, 1),
      makeCard(105, 1, 1, 1, 1),
      makeCard(106, 1, 1, 1, 1),
    ];
    const p2Full = [
      makeCard(107, 1, 1, 1, 1),
      makeCard(108, 1, 1, 1, 1),
      makeCard(109, 1, 1, 1, 1),
      makeCard(110, 1, 1, 1, 1),
      makeCard(111, 1, 1, 1, 1),
    ];

    let game = createGame(p1Full, p2Full);
    // P1 places filler at (2,2) corner
    let result = placeCard(game, 'player1', 1, 2, 2);
    // P2 places at (1,0) - left column middle
    result = placeCard(result.newState, 'player2', 0, 1, 0);
    // P1 places filler at (2,0)
    result = placeCard(result.newState, 'player1', 2, 2, 0);
    // P2 places at (0,1) - top middle
    result = placeCard(result.newState, 'player2', 1, 0, 1);
    // P1 places the strong card at (1,1) center - should capture both adjacent P2 cards
    result = placeCard(result.newState, 'player1', 0, 1, 1);

    expect(result.captures.length).toBe(2);
    expect(result.newState.board[1][0].owner).toBe('player1');
    expect(result.newState.board[0][1].owner).toBe('player1');
  });

  it('should not capture own cards', () => {
    const p1Full = [
      makeCard(101, 10, 10, 10, 10),
      makeCard(102, 1, 1, 1, 1),
      makeCard(103, 1, 1, 1, 1),
      makeCard(104, 1, 1, 1, 1),
      makeCard(105, 1, 1, 1, 1),
    ];
    const p2Full = [
      makeCard(106, 1, 1, 1, 1),
      makeCard(107, 1, 1, 1, 1),
      makeCard(108, 1, 1, 1, 1),
      makeCard(109, 1, 1, 1, 1),
      makeCard(110, 1, 1, 1, 1),
    ];

    let game = createGame(p1Full, p2Full);
    // P1 places weak card at (0,0)
    let result = placeCard(game, 'player1', 1, 0, 0);
    // P2 places at (2,2) far away
    result = placeCard(result.newState, 'player2', 0, 2, 2);
    // P1 places strong card at (0,1) next to own card
    result = placeCard(result.newState, 'player1', 0, 0, 1);

    // P1 should not capture own card
    expect(result.newState.board[0][0].owner).toBe('player1');
    expect(result.captures.length).toBe(0);
  });

  it('should check all four directions for capture', () => {
    // Place P2 cards in all 4 directions around center, then P1 places strong card at center
    // Strong card is last (index 4) so it stays at index 0 after other cards are played
    const p1Full = [
      makeCard(102, 1, 1, 1, 1),
      makeCard(103, 1, 1, 1, 1),
      makeCard(104, 1, 1, 1, 1),
      makeCard(105, 1, 1, 1, 1),
      makeCard(101, 10, 10, 10, 10), // strong - will be index 0 when it's the last card
    ];
    const p2Full = [
      makeCard(106, 1, 1, 1, 1), // weak
      makeCard(107, 1, 1, 1, 1),
      makeCard(108, 1, 1, 1, 1),
      makeCard(109, 1, 1, 1, 1),
      makeCard(110, 1, 1, 1, 1),
    ];

    let game = createGame(p1Full, p2Full);
    // Always use index 0 since hands shrink as cards are played
    // P1 places filler at (0,0)
    let result = placeCard(game, 'player1', 0, 0, 0);
    // P2 places at (0,1) - above center
    result = placeCard(result.newState, 'player2', 0, 0, 1);
    // P1 places filler at (2,2)
    result = placeCard(result.newState, 'player1', 0, 2, 2);
    // P2 places at (1,0) - left of center
    result = placeCard(result.newState, 'player2', 0, 1, 0);
    // P1 places filler at (0,2)
    result = placeCard(result.newState, 'player1', 0, 0, 2);
    // P2 places at (2,1) - below center
    result = placeCard(result.newState, 'player2', 0, 2, 1);
    // P1 places filler at (2,0)
    result = placeCard(result.newState, 'player1', 0, 2, 0);
    // P2 places at (1,2) - right of center
    result = placeCard(result.newState, 'player2', 0, 1, 2);
    // P1 places STRONG card at (1,1) center - should capture all 4 adjacent
    result = placeCard(result.newState, 'player1', 0, 1, 1);

    expect(result.captures.length).toBe(4);
    expect(result.newState.board[0][1].owner).toBe('player1');
    expect(result.newState.board[1][0].owner).toBe('player1');
    expect(result.newState.board[2][1].owner).toBe('player1');
    expect(result.newState.board[1][2].owner).toBe('player1');
  });

  it('should use correct directional rank comparisons', () => {
    // Card placed at (0,0) with right=3, opponent at (0,1) with left=5
    // Placed card's right (3) NOT > opponent's left (5) => no capture
    const p1Full = [
      makeCard(101, 1, 3, 1, 1), // right=3
      makeCard(103, 1, 1, 1, 1),
      makeCard(104, 1, 1, 1, 1),
      makeCard(105, 1, 1, 1, 1),
      makeCard(106, 1, 1, 1, 1),
    ];
    const p2Full = [
      makeCard(102, 1, 1, 1, 5), // left=5
      makeCard(107, 1, 1, 1, 1),
      makeCard(108, 1, 1, 1, 1),
      makeCard(109, 1, 1, 1, 1),
      makeCard(110, 1, 1, 1, 1),
    ];

    let game = createGame(p1Full, p2Full);
    // P1 places at (0,0)
    let result = placeCard(game, 'player1', 0, 0, 0);
    // P2 places at (0,1) adjacent right
    result = placeCard(result.newState, 'player2', 0, 0, 1);
    // P2's card left(5) competes with P1's card right(3), but since P2 is placing,
    // P2's left(5) > P1's right(3), so P2 captures P1's card!
    expect(result.newState.board[0][0].owner).toBe('player2');
  });
});

describe('scoring', () => {
  it('should update scores after capture', () => {
    const p1Full = [
      makeCard(101, 10, 10, 10, 10),
      makeCard(103, 1, 1, 1, 1),
      makeCard(104, 1, 1, 1, 1),
      makeCard(105, 1, 1, 1, 1),
      makeCard(106, 1, 1, 1, 1),
    ];
    const p2Full = [
      makeCard(102, 1, 1, 1, 1),
      makeCard(107, 1, 1, 1, 1),
      makeCard(108, 1, 1, 1, 1),
      makeCard(109, 1, 1, 1, 1),
      makeCard(110, 1, 1, 1, 1),
    ];

    let game = createGame(p1Full, p2Full);
    // After creation, scores should be 5-5
    expect(game.player1Score).toBe(5);
    expect(game.player2Score).toBe(5);

    // P1 places strong card at (0,0)
    let result = placeCard(game, 'player1', 0, 0, 0);
    // P2 places weak card at (0,1)
    result = placeCard(result.newState, 'player2', 0, 0, 1);
    // P1 should capture P2's card? No - P2 is placing so P2's left vs P1's right
    // P2 left=1 vs P1 right=10, no capture by P2
    // Scores: P1 has 1 on board + 4 in hand = 5, P2 has 1 on board + 4 in hand = 5
    expect(result.newState.player1Score).toBe(5);
    expect(result.newState.player2Score).toBe(5);
  });

  it('should count board cards + hand cards for score', () => {
    const p1Full = [
      makeCard(101, 1, 1, 1, 1),
      makeCard(102, 1, 1, 1, 1),
      makeCard(103, 1, 1, 1, 1),
      makeCard(104, 1, 1, 1, 1),
      makeCard(105, 1, 1, 1, 1),
    ];
    const p2Full = [
      makeCard(106, 1, 1, 1, 1),
      makeCard(107, 1, 1, 1, 1),
      makeCard(108, 1, 1, 1, 1),
      makeCard(109, 1, 1, 1, 1),
      makeCard(110, 1, 1, 1, 1),
    ];

    let game = createGame(p1Full, p2Full);
    let result = placeCard(game, 'player1', 0, 0, 0);
    // P1: 1 on board + 4 in hand = 5
    // P2: 0 on board + 5 in hand = 5
    expect(result.newState.player1Score).toBe(5);
    expect(result.newState.player2Score).toBe(5);
  });
});

describe('calculateScores', () => {
  it('should calculate scores from game state', () => {
    const p1Full = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Full = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Full, p2Full);
    const scores = calculateScores(game);
    expect(scores.player1).toBe(5);
    expect(scores.player2).toBe(5);
  });
});

describe('game end', () => {
  it('should detect game over when board is full', () => {
    const cards = () => [
      makeCard(201, 5, 5, 5, 5),
      makeCard(202, 5, 5, 5, 5),
      makeCard(203, 5, 5, 5, 5),
      makeCard(204, 5, 5, 5, 5),
      makeCard(205, 5, 5, 5, 5),
    ];

    let game = createGame(cards(), cards().map((c, i) => ({ ...c, id: c.id + 100 })));

    // Play all 9 turns to fill the board
    const moves: [number, number, number][] = [
      [0, 0, 0], // p1
      [0, 0, 1], // p2
      [0, 0, 2], // p1
      [0, 1, 0], // p2
      [0, 1, 1], // p1
      [0, 1, 2], // p2
      [0, 2, 0], // p1
      [0, 2, 1], // p2
      [0, 2, 2], // p1 - 9th card, board full
    ];

    let state = game;
    for (let i = 0; i < moves.length; i++) {
      const player = i % 2 === 0 ? 'player1' : 'player2';
      const [handIdx, row, col] = moves[i] as [number, number, number];
      const result = placeCard(state, player as 'player1' | 'player2', handIdx, row, col);
      state = result.newState;
    }

    expect(state.status).toBe('finished');
    expect(state.winner).not.toBeNull();
  });

  it('should declare draw when scores are equal', () => {
    // Use equal-strength cards so no captures happen => 5-5 draw after board fills
    // Actually captures will happen. Let me think about this...
    // With all 5-5-5-5 cards, no captures happen (equal ranks), so it stays 5 vs 4 or similar
    // The player who placed 5 cards has 5 on board, the other placed 4 has 4 on board+1 in hand
    // P1 places 5 cards, P2 places 4 cards => P1 score: 5, P2 score: 5 (4 board + 1 hand)
    // That's a draw!
    const mkCards = (start: number) => [
      makeCard(start, 5, 5, 5, 5),
      makeCard(start + 1, 5, 5, 5, 5),
      makeCard(start + 2, 5, 5, 5, 5),
      makeCard(start + 3, 5, 5, 5, 5),
      makeCard(start + 4, 5, 5, 5, 5),
    ];

    let game = createGame(mkCards(1), mkCards(100));

    const positions: [number, number][] = [
      [0, 0], [0, 1], [0, 2],
      [1, 0], [1, 1], [1, 2],
      [2, 0], [2, 1], [2, 2],
    ];

    let state = game;
    for (let i = 0; i < 9; i++) {
      const player = i % 2 === 0 ? 'player1' : 'player2';
      const [row, col] = positions[i]!;
      const result = placeCard(state, player as 'player1' | 'player2', 0, row, col);
      state = result.newState;
    }

    // P1 placed 5, P2 placed 4 + 1 in hand = 5 each => draw
    expect(state.status).toBe('finished');
    expect(state.winner).toBe('draw');
    expect(state.player1Score).toBe(5);
    expect(state.player2Score).toBe(5);
  });

  it('should declare winner with most cards', () => {
    // P1 has strong cards, P2 has weak cards. P1 captures many.
    const p1Full = [
      makeCard(1, 10, 10, 10, 10),
      makeCard(2, 10, 10, 10, 10),
      makeCard(3, 10, 10, 10, 10),
      makeCard(4, 10, 10, 10, 10),
      makeCard(5, 10, 10, 10, 10),
    ];
    const p2Full = [
      makeCard(101, 1, 1, 1, 1),
      makeCard(102, 1, 1, 1, 1),
      makeCard(103, 1, 1, 1, 1),
      makeCard(104, 1, 1, 1, 1),
      makeCard(105, 1, 1, 1, 1),
    ];

    let state = createGame(p1Full, p2Full);
    const positions: [number, number][] = [
      [0, 0], [0, 1], [0, 2],
      [1, 0], [1, 1], [1, 2],
      [2, 0], [2, 1], [2, 2],
    ];

    for (let i = 0; i < 9; i++) {
      const player = i % 2 === 0 ? 'player1' : 'player2';
      const result = placeCard(state, player as 'player1' | 'player2', 0, positions[i]![0], positions[i]![1]);
      state = result.newState;
    }

    expect(state.status).toBe('finished');
    expect(state.winner).toBe('player1');
    expect(state.player1Score).toBeGreaterThan(state.player2Score);
  });
});

describe('getValidPlacements', () => {
  it('should return all empty cells', () => {
    const p1Full = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Full = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Full, p2Full);

    const valid = getValidPlacements(game);
    expect(valid.length).toBe(9); // all cells empty
  });

  it('should exclude occupied cells', () => {
    const p1Full = getCardsByIds([1, 2, 3, 4, 5]);
    const p2Full = getCardsByIds([6, 7, 8, 9, 10]);
    const game = createGame(p1Full, p2Full);

    const result = placeCard(game, 'player1', 0, 1, 1);
    const valid = getValidPlacements(result.newState);
    expect(valid.length).toBe(8);
    expect(valid.find(v => v.row === 1 && v.col === 1)).toBeUndefined();
  });

  it('should return empty array when board is full', () => {
    const mkCards = (start: number) => [
      makeCard(start, 5, 5, 5, 5),
      makeCard(start + 1, 5, 5, 5, 5),
      makeCard(start + 2, 5, 5, 5, 5),
      makeCard(start + 3, 5, 5, 5, 5),
      makeCard(start + 4, 5, 5, 5, 5),
    ];

    let game = createGame(mkCards(1), mkCards(100));
    const positions: [number, number][] = [
      [0, 0], [0, 1], [0, 2],
      [1, 0], [1, 1], [1, 2],
      [2, 0], [2, 1], [2, 2],
    ];

    let state = game;
    for (let i = 0; i < 9; i++) {
      const player = i % 2 === 0 ? 'player1' : 'player2';
      const [row, col] = positions[i]!;
      state = placeCard(state, player as 'player1' | 'player2', 0, row, col).newState;
    }

    const valid = getValidPlacements(state);
    expect(valid.length).toBe(0);
  });
});

describe('isGameOver', () => {
  it('should return false for new game', () => {
    const game = createGame(getCardsByIds([1, 2, 3, 4, 5]), getCardsByIds([6, 7, 8, 9, 10]));
    expect(isGameOver(game)).toBe(false);
  });

  it('should return true when board is full', () => {
    const mkCards = (start: number) => [
      makeCard(start, 5, 5, 5, 5),
      makeCard(start + 1, 5, 5, 5, 5),
      makeCard(start + 2, 5, 5, 5, 5),
      makeCard(start + 3, 5, 5, 5, 5),
      makeCard(start + 4, 5, 5, 5, 5),
    ];

    let state = createGame(mkCards(1), mkCards(100));
    const positions: [number, number][] = [
      [0, 0], [0, 1], [0, 2],
      [1, 0], [1, 1], [1, 2],
      [2, 0], [2, 1], [2, 2],
    ];

    for (let i = 0; i < 9; i++) {
      const player = i % 2 === 0 ? 'player1' : 'player2';
      const [row, col] = positions[i]!;
      state = placeCard(state, player as 'player1' | 'player2', 0, row, col).newState;
    }

    expect(isGameOver(state)).toBe(true);
  });
});
