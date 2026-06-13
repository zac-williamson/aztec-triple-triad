/**
 * The frontend card module must serve the generated game-logic database
 * (not a hand-maintained copy) — every card carries its generated rarity,
 * and the presentation helpers read from that single source.
 */
import { describe, it, expect } from 'vitest';
import { CARD_DATABASE, getCardById, getCardRarity, formatRank } from './cards';

describe('frontend card module', () => {
  it('serves the full generated 256-card database', () => {
    expect(CARD_DATABASE).toHaveLength(256);
    const ids = new Set(CARD_DATABASE.map(c => c.id));
    expect(ids.size).toBe(256);
    expect(Math.min(...ids)).toBe(1);
    expect(Math.max(...ids)).toBe(256);
  });

  it('every card carries its generated rarity, and getCardRarity reads it', () => {
    for (const card of CARD_DATABASE) {
      expect(card.rarity, `card ${card.id} has no rarity — hand-maintained copy?`).toBeDefined();
      expect(getCardRarity(card.id)).toBe(card.rarity);
    }
  });

  it('getCardRarity falls back to common for unknown ids', () => {
    expect(getCardRarity(9999)).toBe('common');
  });

  it('getCardById round-trips', () => {
    expect(getCardById(1)?.name).toBe('Mudwalker');
    expect(getCardById(9999)).toBeUndefined();
  });

  it('formatRank renders 10 as A', () => {
    expect(formatRank(10)).toBe('A');
    expect(formatRank(7)).toBe('7');
  });
});
