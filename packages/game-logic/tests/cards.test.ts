import { describe, it, expect } from 'vitest';
import { CARD_DATABASE, getCardById, getCardsByIds, packRanks, unpackRanks, verifyCardRankConsistency } from '../src/cards.js';

describe('Card Database', () => {
  it('should have at least 30 cards', () => {
    expect(CARD_DATABASE.length).toBeGreaterThanOrEqual(30);
  });

  it('should have unique ids', () => {
    const ids = CARD_DATABASE.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should have unique names', () => {
    const names = CARD_DATABASE.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('should have ranks between 1 and 10', () => {
    for (const card of CARD_DATABASE) {
      const { top, right, bottom, left } = card.ranks;
      for (const rank of [top, right, bottom, left]) {
        expect(rank).toBeGreaterThanOrEqual(1);
        expect(rank).toBeLessThanOrEqual(10);
      }
    }
  });

  it('getCardById should return the correct card', () => {
    const card = getCardById(1);
    expect(card).toBeDefined();
    expect(card!.name).toBe('Mudwalker');
  });

  it('getCardById should return undefined for invalid id', () => {
    expect(getCardById(999)).toBeUndefined();
  });

  it('getCardsByIds should return cards in order', () => {
    const cards = getCardsByIds([3, 1, 5]);
    expect(cards.map((c) => c.id)).toEqual([3, 1, 5]);
  });

  it('getCardsByIds should throw for invalid id', () => {
    expect(() => getCardsByIds([1, 999])).toThrow('Card with id 999 not found');
  });

  it('getCardsByIds should return copies, not references', () => {
    const cards = getCardsByIds([1]);
    cards[0].name = 'Modified';
    expect(getCardById(1)!.name).toBe('Mudwalker');
  });
});

describe('packRanks / unpackRanks (V7 Fix 5.2)', () => {
  it('should pack ranks into a single number', () => {
    // Mudwalker: top=1, right=4, bottom=1, left=5
    const packed = packRanks(1, 4, 1, 5);
    expect(packed).toBe(1 + 4 * 16 + 1 * 256 + 5 * 4096);
  });

  it('should unpack a packed number into individual ranks', () => {
    const packed = packRanks(1, 4, 1, 5);
    const { top, right, bottom, left } = unpackRanks(packed);
    expect(top).toBe(1);
    expect(right).toBe(4);
    expect(bottom).toBe(1);
    expect(left).toBe(5);
  });

  it('should round-trip all cards in the database', () => {
    for (const card of CARD_DATABASE) {
      const { top, right, bottom, left } = card.ranks;
      const packed = packRanks(top, right, bottom, left);
      const unpacked = unpackRanks(packed);
      expect(unpacked).toEqual({ top, right, bottom, left });
    }
  });

  it('should handle max rank value (10)', () => {
    const packed = packRanks(10, 10, 10, 10);
    const unpacked = unpackRanks(packed);
    expect(unpacked).toEqual({ top: 10, right: 10, bottom: 10, left: 10 });
  });

  it('should handle min rank value (1)', () => {
    const packed = packRanks(1, 1, 1, 1);
    const unpacked = unpackRanks(packed);
    expect(unpacked).toEqual({ top: 1, right: 1, bottom: 1, left: 1 });
  });
});

describe('verifyCardRankConsistency (V7 Fix 5.2)', () => {
  it('should return no errors for the current card database', () => {
    const errors = verifyCardRankConsistency();
    expect(errors).toEqual([]);
  });

  it('should verify all 50 cards have valid ranks', () => {
    expect(CARD_DATABASE.length).toBe(50);
    for (const card of CARD_DATABASE) {
      const { top, right, bottom, left } = card.ranks;
      expect(top).toBeGreaterThanOrEqual(1);
      expect(top).toBeLessThanOrEqual(10);
      expect(right).toBeGreaterThanOrEqual(1);
      expect(right).toBeLessThanOrEqual(10);
      expect(bottom).toBeGreaterThanOrEqual(1);
      expect(bottom).toBeLessThanOrEqual(10);
      expect(left).toBeGreaterThanOrEqual(1);
      expect(left).toBeLessThanOrEqual(10);
    }
  });

  it('should verify card ranks match circuit-expected values for sample cards', () => {
    // Verify specific cards match what the circuit expects (from get_card_ranks in prove_hand)
    // Card 1: Mudwalker [1, 4, 1, 5]
    const card1 = getCardById(1)!;
    expect(card1.ranks).toEqual({ top: 1, right: 4, bottom: 1, left: 5 });

    // Card 10: Peaches [4, 3, 2, 4]
    const card10 = getCardById(10)!;
    expect(card10.ranks).toEqual({ top: 4, right: 3, bottom: 2, left: 4 });

    // Card 46: Rosita [3, 10, 2, 1] - has the max rank (10)
    const card46 = getCardById(46)!;
    expect(card46.ranks).toEqual({ top: 3, right: 10, bottom: 2, left: 1 });

    // Card 50: Lerma [7, 2, 7, 4]
    const card50 = getCardById(50)!;
    expect(card50.ranks).toEqual({ top: 7, right: 2, bottom: 7, left: 4 });
  });
});
