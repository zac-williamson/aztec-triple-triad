import { describe, it, expect } from 'vitest';
import { padToHand, sortProofChain } from '../settlementArgs';

class FakeFr { constructor(public v: bigint) {} }

const link = (start: string, end: string) => ({ startStateHash: start, endStateHash: end });

describe('padToHand', () => {
  it('pads a short hand to five and converts to field elements', () => {
    const out = padToHand(FakeFr as any, [3, 7]) as any[];
    expect(out).toHaveLength(5);
    expect(out.map(f => f.v)).toEqual([3n, 7n, 0n, 0n, 0n]);
  });

  it('truncates anything longer than a hand', () => {
    expect(padToHand(FakeFr as any, [1, 2, 3, 4, 5, 6, 7])).toHaveLength(5);
  });
});

describe('sortProofChain', () => {
  it('orders proofs by chaining end hash to start hash', () => {
    const shuffled = [link('b', 'c'), link('a', 'b'), link('c', 'd')];
    const sorted = sortProofChain(shuffled, 3, 'a');
    expect(sorted.map(p => p.startStateHash)).toEqual(['a', 'b', 'c']);
  });

  it('throws at the exact step where the chain breaks', () => {
    // 'b'->'c' is missing, so step 1 cannot be satisfied.
    expect(() => sortProofChain([link('a', 'b'), link('c', 'd')], 3, 'a'))
      .toThrow('Proof chain broken at step 1');
  });

  it('throws rather than returning a short chain', () => {
    expect(() => sortProofChain([link('a', 'b')], 3, 'a')).toThrow(/step 1/);
  });

  it('rejects a chain that does not start at the canonical initial hash', () => {
    expect(() => sortProofChain([link('a', 'b'), link('b', 'c')], 2, 'WRONG'))
      .toThrow('Proof chain broken at step 0');
  });

  it('returns exactly `count` proofs even when given extras', () => {
    const chain = [link('a', 'b'), link('b', 'c'), link('c', 'd'), link('d', 'e')];
    expect(sortProofChain(chain, 2, 'a')).toHaveLength(2);
  });
});
