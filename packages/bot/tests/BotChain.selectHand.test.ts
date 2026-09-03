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
    // Five types so a legal hand exists; the point is the count per type.
    const stock = [1, 1, 1, 2, 2, 2, 3, 4, 5];
    const hand = await chainHolding(stock).selectHand(5);
    expect(hand).toHaveLength(5);
    for (const id of new Set(hand)) {
      expect(hand.filter(h => h === id).length).toBeLessThanOrEqual(stock.filter(s => s === id).length);
    }
  });

  /**
   * This used to assert the opposite — that a hand of fewer than five types
   * "falls back to duplicates" — and the implementation comment called such a
   * hand playable. Both were wrong, and the test pinned the bug in place.
   *
   * prove_hand asserts card_ids[i] != card_ids[j], so a duplicated hand cannot
   * be proved; and join_game commits BEFORE the bot proves its own hand. The
   * fallback therefore committed five cards and then could not prove them,
   * which the sweep classifies "missing a hand proof — unrecoverable". It also
   * fires exactly when types are scarce, burning five more each time.
   */
  it('refuses to field a hand that repeats a card, rather than stranding it', async () => {
    const stock = [7, 7, 7, 8, 8, 8];
    await expect(chainHolding(stock).selectHand(5)).rejects.toThrow(/distinct type/i);
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

/**
 * A hand that repeats a card cannot be proved, and the cards are gone by then.
 *
 * The round-robin takes a second copy of a type once it runs out of types, so a
 * stock of fewer than five distinct types produces something like [A,B,A,B,A].
 * `prove_hand` asserts card_ids[i] != card_ids[j] and rejects it — while
 * join_game has already committed the cards, because the commit precedes the
 * bot's own hand proof (confirmed against a production log: "committing" at
 * 06:23:25, "Generating prove_hand proof" at 06:24:08). With no hand proof the
 * sweep calls the game "missing a hand proof — unrecoverable". Five cards, for
 * good, every time it happens.
 */
describe('selectHand refuses a hand it could not prove', () => {
  const chainWith = (held: number[]) => {
    const c = Object.create(BotChain.prototype) as any;
    c.readCards = async () => held;
    return c as { selectHand: (n?: number) => Promise<number[]> };
  };

  it('throws rather than returning a duplicated hand', async () => {
    // Plenty of cards, only two types — the exact shape of the spiral.
    const held = [...Array(10).fill(7), ...Array(10).fill(8)];
    await expect(chainWith(held).selectHand(5)).rejects.toThrow(/distinct type/i);
  });

  it('names the real cause, so the operator knows to add TYPES not cards', async () => {
    const held = [...Array(40).fill(7)];
    await expect(chainWith(held).selectHand(5)).rejects.toThrow(/prove_hand rejects duplicate/i);
  });

  it('still returns a hand whenever five distinct types exist', async () => {
    const held = [1, 1, 1, 2, 2, 3, 4, 5, 5, 5];
    const hand = await chainWith(held).selectHand(5);
    expect(hand).toHaveLength(5);
    expect(new Set(hand).size, 'five distinct types were available').toBe(5);
  });
});
