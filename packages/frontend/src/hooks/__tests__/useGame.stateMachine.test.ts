import { describe, it, expect } from 'vitest';
import { VALID_TRANSITIONS, type OnChainPhase } from '../useGame';

const ALL_PHASES: OnChainPhase[] = [
  'idle', 'creating', 'awaiting_join', 'preparing',
  'awaiting_create', 'joining', 'active', 'settling', 'awaiting_settlement',
];

describe('VALID_TRANSITIONS table', () => {
  it('covers all 9 phases as source states', () => {
    expect(Object.keys(VALID_TRANSITIONS).sort()).toEqual([...ALL_PHASES].sort());
  });

  it('every target phase exists as a source phase', () => {
    for (const [source, targets] of Object.entries(VALID_TRANSITIONS)) {
      for (const target of targets) {
        expect(ALL_PHASES).toContain(target);
      }
    }
  });

  it('no phase lists itself as a valid target', () => {
    for (const [source, targets] of Object.entries(VALID_TRANSITIONS)) {
      expect(targets).not.toContain(source);
    }
  });

  // --- Valid transitions ---

  describe('valid transitions from idle', () => {
    it('can transition to creating (P1 starts game)', () => {
      expect(VALID_TRANSITIONS.idle).toContain('creating');
    });
    it('can transition to preparing (P2 starts join flow)', () => {
      expect(VALID_TRANSITIONS.idle).toContain('preparing');
    });
    it('has exactly 2 valid targets', () => {
      expect(VALID_TRANSITIONS.idle).toHaveLength(2);
    });
  });

  describe('valid transitions from creating', () => {
    it('can transition to awaiting_join (tx mined)', () => {
      expect(VALID_TRANSITIONS.creating).toContain('awaiting_join');
    });
    it('can transition to idle (error/cancel)', () => {
      expect(VALID_TRANSITIONS.creating).toContain('idle');
    });
  });

  describe('valid transitions from awaiting_join', () => {
    it('can transition to active (P2 joined)', () => {
      expect(VALID_TRANSITIONS.awaiting_join).toContain('active');
    });
    it('cannot transition directly to settling (must go through active)', () => {
      expect(VALID_TRANSITIONS.awaiting_join).not.toContain('settling');
    });
    it('can transition to idle (cancel/error)', () => {
      expect(VALID_TRANSITIONS.awaiting_join).toContain('idle');
    });
  });

  describe('valid transitions from preparing', () => {
    it('can transition to awaiting_create (preview data sent)', () => {
      expect(VALID_TRANSITIONS.preparing).toContain('awaiting_create');
    });
    it('can transition to idle (error)', () => {
      expect(VALID_TRANSITIONS.preparing).toContain('idle');
    });
  });

  describe('valid transitions from awaiting_create', () => {
    it('can transition to joining (P1 create confirmed)', () => {
      expect(VALID_TRANSITIONS.awaiting_create).toContain('joining');
    });
    it('can transition to idle (error)', () => {
      expect(VALID_TRANSITIONS.awaiting_create).toContain('idle');
    });
  });

  describe('valid transitions from joining', () => {
    it('can transition to active (join tx mined)', () => {
      expect(VALID_TRANSITIONS.joining).toContain('active');
    });
    it('can transition to awaiting_create (retry)', () => {
      expect(VALID_TRANSITIONS.joining).toContain('awaiting_create');
    });
    it('can transition to idle (error)', () => {
      expect(VALID_TRANSITIONS.joining).toContain('idle');
    });
  });

  describe('valid transitions from active', () => {
    it('can transition to settling (winner settles)', () => {
      expect(VALID_TRANSITIONS.active).toContain('settling');
    });
    it('can transition to awaiting_settlement (loser waits)', () => {
      expect(VALID_TRANSITIONS.active).toContain('awaiting_settlement');
    });
    it('can transition to idle (error/abandon)', () => {
      expect(VALID_TRANSITIONS.active).toContain('idle');
    });
  });

  describe('valid transitions from settling', () => {
    it('can only transition to idle', () => {
      expect(VALID_TRANSITIONS.settling).toEqual(['idle']);
    });
  });

  describe('valid transitions from awaiting_settlement', () => {
    it('can only transition to idle', () => {
      expect(VALID_TRANSITIONS.awaiting_settlement).toEqual(['idle']);
    });
  });

  // --- Invalid transitions ---

  describe('invalid transitions', () => {
    const invalidPairs: [OnChainPhase, OnChainPhase][] = [
      ['idle', 'active'],
      ['idle', 'settling'],
      ['idle', 'joining'],
      ['idle', 'awaiting_join'],
      ['settling', 'creating'],
      ['settling', 'active'],
      ['settling', 'awaiting_settlement'],
      ['awaiting_settlement', 'settling'],
      ['awaiting_settlement', 'active'],
      ['creating', 'active'],
      ['creating', 'joining'],
      ['active', 'creating'],
      ['active', 'preparing'],
    ];

    it.each(invalidPairs)(
      '%s → %s is not allowed',
      (from, to) => {
        expect(VALID_TRANSITIONS[from]).not.toContain(to);
      },
    );
  });

  // --- Lifecycle paths ---

  describe('lifecycle paths', () => {
    function isValidPath(path: OnChainPhase[]): boolean {
      for (let i = 0; i < path.length - 1; i++) {
        if (!VALID_TRANSITIONS[path[i]].includes(path[i + 1])) return false;
      }
      return true;
    }

    it('P1 full lifecycle: idle → creating → awaiting_join → active → settling → idle', () => {
      expect(isValidPath(['idle', 'creating', 'awaiting_join', 'active', 'settling', 'idle'])).toBe(true);
    });

    it('P2 full lifecycle: idle → preparing → awaiting_create → joining → active → settling → idle', () => {
      expect(isValidPath(['idle', 'preparing', 'awaiting_create', 'joining', 'active', 'settling', 'idle'])).toBe(true);
    });

    it('loser lifecycle: active → awaiting_settlement → idle', () => {
      expect(isValidPath(['active', 'awaiting_settlement', 'idle'])).toBe(true);
    });

    it('P1 error recovery: creating → idle', () => {
      expect(isValidPath(['creating', 'idle'])).toBe(true);
    });

    it('P2 error recovery: joining → awaiting_create (retry after failure)', () => {
      expect(isValidPath(['joining', 'awaiting_create'])).toBe(true);
    });

    it('P1 cancel in awaiting_join: awaiting_join → idle', () => {
      expect(isValidPath(['awaiting_join', 'idle'])).toBe(true);
    });

    it('P1 settlement must go through active: awaiting_join → active → settling → idle', () => {
      expect(isValidPath(['awaiting_join', 'active', 'settling', 'idle'])).toBe(true);
    });

    it('every terminal path ends at idle', () => {
      // settling and awaiting_settlement can only go to idle
      expect(VALID_TRANSITIONS.settling).toEqual(['idle']);
      expect(VALID_TRANSITIONS.awaiting_settlement).toEqual(['idle']);
    });

    it('every non-idle phase has idle as a reachable target (error recovery)', () => {
      for (const phase of ALL_PHASES) {
        if (phase === 'idle') continue;
        // Check that idle is directly reachable
        expect(VALID_TRANSITIONS[phase]).toContain('idle');
      }
    });
  });
});
