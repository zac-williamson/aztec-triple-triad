import { describe, it, expect } from 'vitest';
import {
  AXOLOTL_CARDS,
  RARITY_TIERS,
  CARDS_PER_POOL,
  getAxolotlCardById,
  getAxolotlCardsByRarity,
  determineRarity,
  selectCardFromPool,
  type AxolotlCard,
  type Rarity,
} from '../axolotlCards.js';

describe('Axolotl Card Database', () => {
  it('has at least 256 unique cards', () => {
    expect(AXOLOTL_CARDS.length).toBeGreaterThanOrEqual(256);
  });

  it('has sequential unique IDs starting from 1', () => {
    const ids = AXOLOTL_CARDS.map(c => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(AXOLOTL_CARDS.length);
    // Check they're sequential
    for (let i = 0; i < ids.length; i++) {
      expect(ids[i]).toBe(i + 1);
    }
  });

  it('has no duplicate card names', () => {
    const names = AXOLOTL_CARDS.map(c => c.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(AXOLOTL_CARDS.length);
  });

  it('every card has valid ranks (1-10)', () => {
    for (const card of AXOLOTL_CARDS) {
      for (const [side, val] of Object.entries(card.ranks)) {
        expect(val, `Card ${card.id} (${card.name}) ${side}`).toBeGreaterThanOrEqual(1);
        expect(val, `Card ${card.id} (${card.name}) ${side}`).toBeLessThanOrEqual(10);
      }
    }
  });

  it('every card has a valid rarity tier', () => {
    const validRarities: Rarity[] = ['common', 'rare', 'epic', 'legendary'];
    for (const card of AXOLOTL_CARDS) {
      expect(validRarities).toContain(card.rarity);
    }
  });

  it('has correct rarity distribution', () => {
    const counts = { common: 0, rare: 0, epic: 0, legendary: 0 };
    for (const card of AXOLOTL_CARDS) {
      counts[card.rarity]++;
    }
    // ~180 common, ~50 rare, ~20 epic, ~6-10 legendary
    expect(counts.common).toBeGreaterThanOrEqual(170);
    expect(counts.rare).toBeGreaterThanOrEqual(40);
    expect(counts.epic).toBeGreaterThanOrEqual(15);
    expect(counts.legendary).toBeGreaterThanOrEqual(6);
  });

  it('CARDS_PER_POOL matches actual counts', () => {
    const counts = { common: 0, rare: 0, epic: 0, legendary: 0 };
    for (const card of AXOLOTL_CARDS) {
      counts[card.rarity]++;
    }
    expect(CARDS_PER_POOL[0]).toBe(counts.common);
    expect(CARDS_PER_POOL[1]).toBe(counts.rare);
    expect(CARDS_PER_POOL[2]).toBe(counts.epic);
    expect(CARDS_PER_POOL[3]).toBe(counts.legendary);
  });

  it('RARITY_TIERS lists all tiers in order', () => {
    expect(RARITY_TIERS).toEqual(['common', 'rare', 'epic', 'legendary']);
  });

  it('common cards have lower average ranks than legendary', () => {
    function avgRank(cards: AxolotlCard[]): number {
      let sum = 0;
      for (const c of cards) {
        sum += c.ranks.top + c.ranks.right + c.ranks.bottom + c.ranks.left;
      }
      return sum / (cards.length * 4);
    }
    const commons = AXOLOTL_CARDS.filter(c => c.rarity === 'common');
    const legendaries = AXOLOTL_CARDS.filter(c => c.rarity === 'legendary');
    expect(avgRank(legendaries)).toBeGreaterThan(avgRank(commons));
  });

  it('getAxolotlCardById returns correct card', () => {
    const card = getAxolotlCardById(1);
    expect(card).toBeDefined();
    expect(card!.id).toBe(1);

    const missing = getAxolotlCardById(99999);
    expect(missing).toBeUndefined();
  });

  it('getAxolotlCardsByRarity filters correctly', () => {
    const commons = getAxolotlCardsByRarity('common');
    expect(commons.length).toBeGreaterThan(0);
    expect(commons.every(c => c.rarity === 'common')).toBe(true);

    const legendaries = getAxolotlCardsByRarity('legendary');
    expect(legendaries.length).toBeGreaterThanOrEqual(6);
    expect(legendaries.every(c => c.rarity === 'legendary')).toBe(true);
  });
});

describe('Rarity Pool Distribution', () => {
  it('determineRarity maps seed values correctly', () => {
    // (card_seed >> 16) % 100 determines rarity
    // 0-69 = common, 70-89 = rare, 90-97 = epic, 98-99 = legendary
    expect(determineRarity(0)).toBe('common');
    expect(determineRarity(69)).toBe('common');
    expect(determineRarity(70)).toBe('rare');
    expect(determineRarity(89)).toBe('rare');
    expect(determineRarity(90)).toBe('epic');
    expect(determineRarity(97)).toBe('epic');
    expect(determineRarity(98)).toBe('legendary');
    expect(determineRarity(99)).toBe('legendary');
  });

  it('statistical distribution over 10000 samples matches expectations', () => {
    const counts = { common: 0, rare: 0, epic: 0, legendary: 0 };
    const N = 10000;
    for (let i = 0; i < N; i++) {
      // Simulate card_seed with varying high bits
      const cardSeed = Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
      const rarityRoll = ((cardSeed >>> 16) % 100);
      const rarity = determineRarity(rarityRoll);
      counts[rarity]++;
    }
    // Allow 3% tolerance
    expect(counts.common / N).toBeGreaterThan(0.65);
    expect(counts.common / N).toBeLessThan(0.75);
    expect(counts.rare / N).toBeGreaterThan(0.16);
    expect(counts.rare / N).toBeLessThan(0.24);
    expect(counts.epic / N).toBeGreaterThan(0.05);
    expect(counts.epic / N).toBeLessThan(0.11);
    expect(counts.legendary / N).toBeGreaterThan(0.005);
    expect(counts.legendary / N).toBeLessThan(0.04);
  });

  it('selectCardFromPool returns valid card IDs', () => {
    for (let i = 0; i < 100; i++) {
      const cardSeed = Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
      const rarityRoll = ((cardSeed >>> 16) % 100);
      const rarity = determineRarity(rarityRoll);
      const card = selectCardFromPool(cardSeed, rarity);
      expect(card).toBeDefined();
      expect(card!.rarity).toBe(rarity);
      expect(card!.id).toBeGreaterThanOrEqual(1);
    }
  });

  it('selectCardFromPool covers different cards with different seeds', () => {
    const selectedIds = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const cardSeed = (i * 7919 + 42) >>> 0; // Deterministic varying seeds
      const card = selectCardFromPool(cardSeed, 'common');
      if (card) selectedIds.add(card.id);
    }
    // Should get at least 10 different common cards out of 200 draws
    expect(selectedIds.size).toBeGreaterThanOrEqual(10);
  });

  it('boundary values for rarity determination are exact', () => {
    // Test exact boundary at 69/70
    expect(determineRarity(69)).toBe('common');
    expect(determineRarity(70)).toBe('rare');

    // Test exact boundary at 89/90
    expect(determineRarity(89)).toBe('rare');
    expect(determineRarity(90)).toBe('epic');

    // Test exact boundary at 97/98
    expect(determineRarity(97)).toBe('epic');
    expect(determineRarity(98)).toBe('legendary');
  });
});
