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
