import { describe, it, expect } from 'vitest';
import { mapWinnerId } from './App';

describe('mapWinnerId', () => {
  it('maps player1 winner to 1', () => {
    expect(mapWinnerId('player1')).toBe(1);
  });

  it('maps player2 winner to 2', () => {
    expect(mapWinnerId('player2')).toBe(2);
  });

  it('maps draw to 3', () => {
    expect(mapWinnerId('draw')).toBe(3);
  });

  it('maps null (ongoing game) to 0', () => {
    expect(mapWinnerId(null)).toBe(0);
  });

  it('matches circuit winner_id semantics (0=not ended, 1=p1, 2=p2, 3=draw)', () => {
    // These values MUST match circuits/game_move/src/main.nr winner_id assertions
    const mapping: [string | null, number][] = [
      [null, 0],
      ['player1', 1],
      ['player2', 2],
      ['draw', 3],
    ];

    for (const [winner, expected] of mapping) {
      expect(mapWinnerId(winner as any)).toBe(expected);
    }
  });
});
