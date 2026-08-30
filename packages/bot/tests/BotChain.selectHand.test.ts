/**
 * selectHand against a DUPLICATED stock.
 *
 * The bot's collection is deliberately many copies of a few weak types, so the
 * old "sort and take the lowest five" would have handed it five copies of one
 * card every game — legal, but a fixed and trivially readable hand. It must also
 * never name more copies than it holds: that fails on-chain as "Could not find
 * all 5 cards".
 */
import { describe, it, expect } from 'vitest';
import { BotChain } from '../src/BotChain.js';

function chainHolding(cards: number[]): BotChain {
  const chain = Object.create(BotChain.prototype) as BotChain;
  (chain as unknown as { readCards: () => Promise<number[]> }).readCards = async () => cards;
  return chain;
}

describe('BotChain.selectHand with duplicates', () => {
  it('prefers five DISTINCT types over five copies of one', async () => {
    const stock = [...Array(40).fill(1), ...Array(40).fill(2), ...Array(40).fill(3),
                   ...Array(40).fill(4), ...Array(40).fill(5)];
    const hand = await chainHolding(stock).selectHand(5);
    expect(new Set(hand).size).toBe(5);
  });

  it('never names more copies of a card than it holds', async () => {
    // Two types, three cards total beyond the hand: the hand must be drawable.
    const stock = [1, 1, 1, 2, 2, 2, 3];
    const hand = await chainHolding(stock).selectHand(5);
    expect(hand).toHaveLength(5);
    for (const id of new Set(hand)) {
      expect(hand.filter(h => h === id).length).toBeLessThanOrEqual(stock.filter(s => s === id).length);
    }
  });

  it('falls back to duplicates when it holds fewer than five types', async () => {
    const stock = [7, 7, 7, 8, 8, 8];
    const hand = await chainHolding(stock).selectHand(5);
    expect(hand).toHaveLength(5);
    expect(new Set(hand).size).toBe(2);
  });

  it('still refuses to field a short hand', async () => {
    await expect(chainHolding([1, 2, 3]).selectHand(5)).rejects.toThrow(/holds only 3/);
  });
});

/**
 * Rate-limit handling. The public testnet RPC answers 429 under ordinary load —
 * enough to kill a create_game and lose the match — so a 429 must be "ask
 * again", not a failure. A genuine revert must still fail at once.
 */
describe('BotChain rate-limit retries', () => {
  it('retries a rate-limited call and returns its eventual result', async () => {
    const { withRetryForTests } = await import('../src/BotChain.js') as any;
    let calls = 0;
    const out = await withRetryForTests(async () => {
      calls += 1;
      if (calls < 3) throw new Error('Error 429 from server: {"message":"API rate limit exceeded"}');
      return 'ok';
    }, () => {}, 5, 0);
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('fails a genuine error immediately, without burning retries', async () => {
    const { withRetryForTests } = await import('../src/BotChain.js') as any;
    let calls = 0;
    await expect(withRetryForTests(async () => {
      calls += 1;
      throw new Error('Assertion failed: Could not find all 5 cards');
    }, () => {}, 5, 0)).rejects.toThrow(/Could not find all 5 cards/);
    // Retrying a revert only delays the report.
    expect(calls).toBe(1);
  });

  it('gives up after the attempt budget', async () => {
    const { withRetryForTests } = await import('../src/BotChain.js') as any;
    let calls = 0;
    await expect(withRetryForTests(async () => {
      calls += 1;
      throw new Error('fetch failed');
    }, () => {}, 3, 0)).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(3);
  });
});
