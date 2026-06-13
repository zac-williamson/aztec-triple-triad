import { describe, it, expect } from 'vitest';
import { CARD_DATABASE, getCardById, getCardsByIds, packRanks, unpackRanks, verifyCardRankConsistency } from '../src/cards.js';
import canonicalCards from '../../../scripts/card-database-256.json';

describe('canonical database agreement', () => {
  // scripts/card-database-256.json is the source of truth for card data; the
  // card_data circuit and the frontend database are generated from it. This
  // package's CARD_DATABASE must agree card-for-card or moves would simulate
  // one way and prove another. Regenerate with `npm run generate:cards`.
  it('matches scripts/card-database-256.json exactly', () => {
    expect(CARD_DATABASE.length).toBe(canonicalCards.length);
    for (let i = 0; i < canonicalCards.length; i++) {
      const canonical = canonicalCards[i];
      const card = CARD_DATABASE[i];
      expect({ id: card.id, name: card.name, ranks: card.ranks, rarity: card.rarity }).toEqual({
        id: canonical.id,
        name: canonical.name,
        ranks: canonical.ranks,
        rarity: canonical.rarity,
      });
    }
  });

  it('ids 1-256 are dense and in order', () => {
    expect(CARD_DATABASE.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      expect(CARD_DATABASE[i].id).toBe(i + 1);
    }
  });

  it('rarity bands match the NFT contract pool layout', () => {
    // CARDS_PER_POOL in triple_triad_nft/src/main.nr: [10, 166, 50, 20, 10];
    // global_card_id = pool_offset + index + 1.
    const bands: [number, number, string][] = [
      [1, 10, 'common'],
      [11, 176, 'uncommon'],
      [177, 226, 'rare'],
      [227, 246, 'epic'],
      [247, 256, 'legendary'],
    ];
    for (const [from, to, rarity] of bands) {
      for (let id = from; id <= to; id++) {
        expect(getCardById(id)!.rarity).toBe(rarity);
      }
    }
  });
});

describe('Card Database', () => {
  it('should have at least 30 cards', () => {
    expect(CARD_DATABASE.length).toBeGreaterThanOrEqual(30);
  });

  it('should have unique ids', () => {
    const ids = CARD_DATABASE.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should have unique names except the ten re-issued legendaries', () => {
    // The canonical 256-set kept the original 50 cards at ids 1-50 (now banded
    // as commons/uncommons) and re-issued the ten original legendaries into
    // the legendary band 247-256 (oldId 41-50 in the JSON), so exactly those
    // ten names appear twice — with identical ranks.
    const byName = new Map<string, number[]>();
    for (const c of CARD_DATABASE) {
      byName.set(c.name, [...(byName.get(c.name) ?? []), c.id]);
    }
    const duplicated = [...byName.entries()].filter(([, ids]) => ids.length > 1);
    expect(duplicated.length).toBe(10);
    for (const [, ids] of duplicated) {
      expect(ids.length).toBe(2);
      const [originalId, reissueId] = ids;
      expect(originalId).toBeGreaterThanOrEqual(41);
      expect(originalId).toBeLessThanOrEqual(50);
      expect(reissueId).toBe(originalId + 206);
      expect(getCardById(reissueId)!.ranks).toEqual(getCardById(originalId)!.ranks);
    }
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

  it('should verify all 256 cards have valid ranks', () => {
    expect(CARD_DATABASE.length).toBe(256);
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
