import { describe, it, expect } from 'vitest';
import {
  playerToField,
  fieldToPlayer,
  winnerToField,
  boardToCircuitFormat,
  scoresToCircuitFormat,
  gameStateToHashInput,
  buildGameMoveInput,
  buildProveHandInput,
} from '../src/state.js';
import { createGame, placeCard, getCardsByIds } from '@aztec-triple-triad/game-logic';
import type { Board, BoardCell, GameState, Card } from '@aztec-triple-triad/game-logic';

describe('playerToField', () => {
  it('converts player1 to "1"', () => {
    expect(playerToField('player1')).toBe('1');
  });

  it('converts player2 to "2"', () => {
    expect(playerToField('player2')).toBe('2');
  });
});

describe('fieldToPlayer', () => {
  it('converts "1" to player1', () => {
    expect(fieldToPlayer('1')).toBe('player1');
  });

  it('converts "2" to player2', () => {
    expect(fieldToPlayer('2')).toBe('player2');
  });
});

describe('winnerToField', () => {
  it('converts null (no winner) to "0"', () => {
    expect(winnerToField(null)).toBe('0');
  });

  it('converts player1 to "1"', () => {
    expect(winnerToField('player1')).toBe('1');
  });

  it('converts player2 to "2"', () => {
    expect(winnerToField('player2')).toBe('2');
  });

  it('converts draw to "3"', () => {
    expect(winnerToField('draw')).toBe('3');
  });
});

describe('boardToCircuitFormat', () => {
  it('converts an empty board to all zeros', () => {
    const board: Board = Array.from({ length: 3 }, () =>
      Array.from({ length: 3 }, (): BoardCell => ({ card: null, owner: null }))
    );

    const result = boardToCircuitFormat(board);
    expect(result).toHaveLength(18);
    expect(result.every(v => v === '0')).toBe(true);
  });

  it('converts a board with cards placed', () => {
    const card1: Card = {
      id: 5,
      name: 'Test',
      ranks: { top: 3, right: 4, bottom: 5, left: 6 },
    };
    const card2: Card = {
      id: 10,
      name: 'Test2',
      ranks: { top: 7, right: 8, bottom: 9, left: 10 },
    };

    const board: Board = Array.from({ length: 3 }, () =>
      Array.from({ length: 3 }, (): BoardCell => ({ card: null, owner: null }))
    );
    board[0][0] = { card: card1, owner: 'player1' };
    board[1][2] = { card: card2, owner: 'player2' };

    const result = boardToCircuitFormat(board);
    expect(result).toHaveLength(18);

    // Cell (0,0) = index 0: card_id=5, owner=1
    expect(result[0]).toBe('5');
    expect(result[1]).toBe('1');

    // Cell (0,1) = index 1: empty
    expect(result[2]).toBe('0');
    expect(result[3]).toBe('0');

    // Cell (1,2) = index 5: card_id=10, owner=2
    expect(result[10]).toBe('10');
    expect(result[11]).toBe('2');
  });

  it('follows row-major ordering', () => {
    // Cards at (0,0), (0,1), (0,2), (1,0), (1,1), (1,2), (2,0), (2,1), (2,2)
    const makeCard = (id: number): Card => ({
      id,
      name: `Card${id}`,
      ranks: { top: 1, right: 1, bottom: 1, left: 1 },
    });

    const board: Board = Array.from({ length: 3 }, (_, r) =>
      Array.from({ length: 3 }, (_, c): BoardCell => ({
        card: makeCard(r * 3 + c + 1),
        owner: (r * 3 + c) % 2 === 0 ? 'player1' : 'player2',
      }))
    );

    const result = boardToCircuitFormat(board);
    // Row 0: cards 1,2,3
    expect(result[0]).toBe('1');  // (0,0) card_id
    expect(result[2]).toBe('2');  // (0,1) card_id
    expect(result[4]).toBe('3');  // (0,2) card_id
    // Row 1: cards 4,5,6
    expect(result[6]).toBe('4');  // (1,0) card_id
    expect(result[8]).toBe('5');  // (1,1) card_id
    expect(result[10]).toBe('6'); // (1,2) card_id
    // Row 2: cards 7,8,9
    expect(result[12]).toBe('7'); // (2,0) card_id
    expect(result[14]).toBe('8'); // (2,1) card_id
    expect(result[16]).toBe('9'); // (2,2) card_id
  });
});

describe('scoresToCircuitFormat', () => {
  it('converts scores correctly', () => {
    const cards = getCardsByIds([1, 2, 3, 4, 5]);
    const state = createGame(cards, getCardsByIds([6, 7, 8, 9, 10]));
    const result = scoresToCircuitFormat(state);
    expect(result).toEqual(['5', '5']);
  });
});

describe('gameStateToHashInput', () => {
  it('returns 21 fields for empty board', () => {
    const cards1 = getCardsByIds([1, 2, 3, 4, 5]);
    const cards2 = getCardsByIds([6, 7, 8, 9, 10]);
    const state = createGame(cards1, cards2);

    const result = gameStateToHashInput(state);
    expect(result).toHaveLength(21);

    // First 18 should be zeros (empty board)
    for (let i = 0; i < 18; i++) {
      expect(result[i]).toBe('0');
    }
    // Scores
    expect(result[18]).toBe('5'); // player1 score
    expect(result[19]).toBe('5'); // player2 score
    // Current turn
    expect(result[20]).toBe('1'); // player1's turn
  });

  it('returns correct fields after a move', () => {
    const cards1 = getCardsByIds([1, 2, 3, 4, 5]);
    const cards2 = getCardsByIds([6, 7, 8, 9, 10]);
    const state = createGame(cards1, cards2);
    const { newState } = placeCard(state, 'player1', 0, 0, 0);

    const result = gameStateToHashInput(newState);
    expect(result).toHaveLength(21);

    // Cell (0,0) should have card 1, owner 1
    expect(result[0]).toBe('1'); // card_id
    expect(result[1]).toBe('1'); // owner (player1)
    // Current turn should be player2
    expect(result[20]).toBe('2');
  });
});

describe('buildGameMoveInput', () => {
  it('builds correct circuit input for a move', () => {
    const cards1 = getCardsByIds([1, 2, 3, 4, 5]);
    const cards2 = getCardsByIds([6, 7, 8, 9, 10]);
    const stateBefore = createGame(cards1, cards2);
    const card = cards1[0]; // first card in hand
    const { newState: stateAfter } = placeCard(stateBefore, 'player1', 0, 0, 0);

    const input = buildGameMoveInput(
      stateBefore,
      stateAfter,
      'player1',
      card,
      0,
      0,
      '0xabc',
      '0xdef',
      '0x111',
      '0x222',
    );

    // Check public inputs
    expect(input.card_commit_1).toBe('0xabc');
    expect(input.card_commit_2).toBe('0xdef');
    expect(input.start_state_hash).toBe('0x111');
    expect(input.end_state_hash).toBe('0x222');
    expect(input.game_ended).toBe('0');
    expect(input.winner_id).toBe('0');

    // Check private inputs
    expect(input.current_player).toBe('1');
    expect(input.card_id).toBe(String(card.id));
    expect(input.card_ranks).toEqual([
      String(card.ranks.top),
      String(card.ranks.right),
      String(card.ranks.bottom),
      String(card.ranks.left),
    ]);
    expect(input.row).toBe('0');
    expect(input.col).toBe('0');
    expect(input.board_before).toHaveLength(18);
    expect(input.board_after).toHaveLength(18);
    expect(input.scores_before).toEqual(['5', '5']);
    expect(input.current_turn_before).toBe('1');
    expect(input.player1_hand_count_after).toBe('4');
    expect(input.player2_hand_count_after).toBe('5');
  });
});

describe('buildProveHandInput', () => {
  it('builds correct circuit input', () => {
    const input = buildProveHandInput(
      '12345',
      '0xabcdef',
      '1',
      [1, 2, 3, 4, 5],
      ['100', '200', '300', '400', '500'],
      '0xcommit',
    );

    expect(input.card_commit).toBe('0xcommit');
    expect(input.player_address).toBe('0xabcdef');
    expect(input.game_id).toBe('1');
    expect(input.player_secret).toBe('12345');
    expect(input.card_ids).toEqual(['1', '2', '3', '4', '5']);
    expect(input.card_nullifier_secrets).toEqual(['100', '200', '300', '400', '500']);
  });
});
