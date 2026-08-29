/**
 * Guards the card-collection construction used by provision-arena-bot.ts.
 *
 * Regression: packRanks takes the four ranks POSITIONALLY. Passing the ranks
 * object type-checked (it is `any` through the arithmetic) and produced
 * "[object Object]NaNNaNNaN", which only surfaced as a BigInt conversion error
 * at mint time — after the bot account had already been deployed and gas spent.
 */
import { describe, it, expect } from 'vitest';
import { CARD_DATABASE, packRanks, unpackRanks } from '../packages/game-logic/src/cards';

/** Mirrors collectionFor() in provision-arena-bot.ts. */
function collectionFor(count: number) {
  if (count > CARD_DATABASE.length) throw new Error(`exceeds the ${CARD_DATABASE.length}-card database`);
  return CARD_DATABASE.slice(0, count).map(c => ({
    id: c.id,
    packed: packRanks(c.ranks.top, c.ranks.right, c.ranks.bottom, c.ranks.left).toString(),
  }));
}

describe('arena bot collection', () => {
  it('packs ranks into values that survive BigInt conversion', () => {
    for (const entry of collectionFor(40)) {
      expect(entry.packed).toMatch(/^\d+$/);
      expect(() => BigInt(entry.packed)).not.toThrow();
      expect(BigInt(entry.packed)).toBeGreaterThan(0n);
    }
  });

  it('round-trips every packed value back to the card\'s own ranks', () => {
    for (const entry of collectionFor(60)) {
      const card = CARD_DATABASE.find(c => c.id === entry.id)!;
      expect(unpackRanks(Number(entry.packed))).toEqual(card.ranks);
    }
  });

  it('yields distinct token ids — duplicates are untested against commit_five_nfts', () => {
    const ids = collectionFor(100).map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses a collection larger than the card database', () => {
    expect(() => collectionFor(CARD_DATABASE.length + 1)).toThrow(/exceeds/);
  });
});
