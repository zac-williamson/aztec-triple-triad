import { describe, it, expect } from 'vitest';
import { CARD_DATABASE, getCardById, getCardsByIds } from '../src/cards.js';

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
