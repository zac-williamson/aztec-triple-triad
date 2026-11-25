import { describe, it, expect } from 'vitest';
import { VALID_TRANSITIONS, type OnChainPhase } from '../useGame';

const ALL_PHASES: OnChainPhase[] = [
  'idle', 'creating', 'awaiting_join',
  'awaiting_create', 'joining', 'active', 'settling', 'awaiting_settlement',
];

function isValidPath(path: OnChainPhase[]): boolean {
  for (let i = 0; i < path.length - 1; i++) {
    if (!VALID_TRANSITIONS[path[i]].includes(path[i + 1])) return false;
  }
  return true;
}

describe('VALID_TRANSITIONS table', () => {
  it('covers all 8 phases as source states', () => {
    expect(Object.keys(VALID_TRANSITIONS).sort()).toEqual([...ALL_PHASES].sort());
  });

  it('every target phase exists as a source phase', () => {
    for (const targets of Object.values(VALID_TRANSITIONS)) {
      for (const target of targets) expect(ALL_PHASES).toContain(target);
    }
  });

  it('no phase lists itself as a valid target', () => {
    for (const [source, targets] of Object.entries(VALID_TRANSITIONS)) {
      expect(targets).not.toContain(source);
    }
  });

  it('idle starts a creator (creating) or a joiner who has the creator\'s record (awaiting_create)', () => {
    expect([...VALID_TRANSITIONS.idle].sort()).toEqual(['awaiting_create', 'creating']);
  });

  describe('invalid transitions', () => {
    const invalidPairs: [OnChainPhase, OnChainPhase][] = [
      ['idle', 'active'],
      ['idle', 'settling'],
      ['idle', 'joining'],
      ['idle', 'awaiting_join'],
      ['awaiting_join', 'settling'],
      ['awaiting_create', 'active'],
      ['settling', 'creating'],
      ['settling', 'awaiting_settlement'],
      ['awaiting_settlement', 'settling'],
      ['awaiting_settlement', 'active'],
      ['creating', 'active'],
      ['creating', 'joining'],
      ['active', 'creating'],
    ];

    it.each(invalidPairs)('%s → %s is not allowed', (from, to) => {
      expect(VALID_TRANSITIONS[from]).not.toContain(to);
    });
  });

  describe('lifecycle paths', () => {
    it('creator: idle → creating → awaiting_join → active → settling → idle', () => {
      expect(isValidPath(['idle', 'creating', 'awaiting_join', 'active', 'settling', 'idle'])).toBe(true);
    });

    it('joiner: idle → awaiting_create → joining → active → settling → idle', () => {
      expect(isValidPath(['idle', 'awaiting_create', 'joining', 'active', 'settling', 'idle'])).toBe(true);
    });

    it('the player who does not settle: active → awaiting_settlement → idle', () => {
      expect(isValidPath(['active', 'awaiting_settlement', 'idle'])).toBe(true);
    });

    it('a claim that stood down (the opponent came back) returns the game to play', () => {
      expect(isValidPath(['active', 'settling', 'active'])).toBe(true);
    });

    it('joiner retry: joining → awaiting_create', () => {
      expect(isValidPath(['joining', 'awaiting_create'])).toBe(true);
    });

    it('settlement must go through active: awaiting_join → active → settling → idle', () => {
      expect(isValidPath(['awaiting_join', 'active', 'settling', 'idle'])).toBe(true);
    });

    it('every non-idle phase can reach idle directly (error recovery)', () => {
      for (const phase of ALL_PHASES) {
        if (phase === 'idle') continue;
        expect(VALID_TRANSITIONS[phase]).toContain('idle');
      }
    });
  });
});
