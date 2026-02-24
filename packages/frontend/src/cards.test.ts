import { describe, it, expect } from 'vitest';
import { CARD_DATABASE, getCardById, getRandomHand, getRandomHandIds, formatRank } from './cards';

describe('Card Database', () => {
  it('should have 50 cards', () => {
    expect(CARD_DATABASE).toHaveLength(50);
  });

  it('should have unique IDs', () => {
    const ids = CARD_DATABASE.map(c => c.id);
    expect(new Set(ids).size).toBe(50);
  });

  it('should have ranks between 1-10', () => {
    for (const card of CARD_DATABASE) {
      expect(card.ranks.top).toBeGreaterThanOrEqual(1);
      expect(card.ranks.top).toBeLessThanOrEqual(10);
      expect(card.ranks.right).toBeGreaterThanOrEqual(1);
      expect(card.ranks.right).toBeLessThanOrEqual(10);
      expect(card.ranks.bottom).toBeGreaterThanOrEqual(1);
      expect(card.ranks.bottom).toBeLessThanOrEqual(10);
      expect(card.ranks.left).toBeGreaterThanOrEqual(1);
      expect(card.ranks.left).toBeLessThanOrEqual(10);
    }
  });

  it('should find card by ID', () => {
    const card = getCardById(1);
    expect(card).toBeDefined();
    expect(card!.name).toBe('Geezard');
  });

  it('should return undefined for unknown ID', () => {
    expect(getCardById(999)).toBeUndefined();
  });
});

describe('Random hand generation', () => {
  it('should return 5 cards by default', () => {
    const hand = getRandomHand();
    expect(hand).toHaveLength(5);
  });

  it('should return requested number of cards', () => {
    expect(getRandomHand(3)).toHaveLength(3);
  });

  it('should return card IDs', () => {
    const ids = getRandomHandIds();
    expect(ids).toHaveLength(5);
    ids.forEach(id => expect(typeof id).toBe('number'));
  });
});

describe('formatRank', () => {
  it('should format 10 as A', () => {
    expect(formatRank(10)).toBe('A');
  });

  it('should format other numbers as strings', () => {
    expect(formatRank(1)).toBe('1');
    expect(formatRank(5)).toBe('5');
    expect(formatRank(9)).toBe('9');
  });
});
