import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the config module before importing cardStore
vi.mock('../config', () => ({
  AZTEC_CONFIG: { gameContractAddress: '0xTEST_CONTRACT' },
}));

import { loadCards, saveCards, addCards, removeCards, type StoredCard } from '../cardStore';

const ACCOUNT = '0xACCOUNT1';

function makeCard(cardId: number): StoredCard {
  return {
    cardId,
    randomness: '0x' + cardId.toString(16),
    txHash: '0xtx' + cardId,
    noteHashes: ['0xnh' + cardId],
    firstNullifier: '0xnull' + cardId,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('loadCards', () => {
  it('returns empty array for missing key', () => {
    expect(loadCards(ACCOUNT)).toEqual([]);
  });

  it('returns parsed cards from localStorage', () => {
    const cards = [makeCard(1), makeCard(2)];
    saveCards(ACCOUNT, cards);
    expect(loadCards(ACCOUNT)).toEqual(cards);
  });

  it('returns empty array on parse error', () => {
    // Write invalid JSON directly
    const key = 'aztec_tt_card_inventory_' + ACCOUNT + '_0xTEST_CONTRACT';
    localStorage.setItem(key, '{not valid json');
    expect(loadCards(ACCOUNT)).toEqual([]);
  });
});

describe('saveCards', () => {
  it('writes JSON to localStorage', () => {
    const cards = [makeCard(10)];
    saveCards(ACCOUNT, cards);
    const key = 'aztec_tt_card_inventory_' + ACCOUNT + '_0xTEST_CONTRACT';
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(cards);
  });

  it('overwrites existing cards', () => {
    saveCards(ACCOUNT, [makeCard(1)]);
    saveCards(ACCOUNT, [makeCard(2)]);
    expect(loadCards(ACCOUNT)).toEqual([makeCard(2)]);
  });
});

describe('addCards', () => {
  it('appends new cards to empty inventory', () => {
    addCards(ACCOUNT, [makeCard(1), makeCard(2)]);
    expect(loadCards(ACCOUNT)).toEqual([makeCard(1), makeCard(2)]);
  });

  it('appends without duplicates', () => {
    saveCards(ACCOUNT, [makeCard(1), makeCard(2)]);
    addCards(ACCOUNT, [makeCard(2), makeCard(3)]);
    expect(loadCards(ACCOUNT)).toEqual([makeCard(1), makeCard(2), makeCard(3)]);
  });

  it('does not add any cards if all are duplicates', () => {
    saveCards(ACCOUNT, [makeCard(5)]);
    addCards(ACCOUNT, [makeCard(5)]);
    expect(loadCards(ACCOUNT)).toEqual([makeCard(5)]);
  });
});

describe('removeCards', () => {
  it('removes cards by cardId', () => {
    saveCards(ACCOUNT, [makeCard(1), makeCard(2), makeCard(3)]);
    removeCards(ACCOUNT, [2]);
    expect(loadCards(ACCOUNT)).toEqual([makeCard(1), makeCard(3)]);
  });

  it('handles removing IDs that do not exist', () => {
    saveCards(ACCOUNT, [makeCard(1)]);
    removeCards(ACCOUNT, [99]);
    expect(loadCards(ACCOUNT)).toEqual([makeCard(1)]);
  });

  it('removes multiple cards at once', () => {
    saveCards(ACCOUNT, [makeCard(1), makeCard(2), makeCard(3)]);
    removeCards(ACCOUNT, [1, 3]);
    expect(loadCards(ACCOUNT)).toEqual([makeCard(2)]);
  });

  it('handles empty inventory gracefully', () => {
    removeCards(ACCOUNT, [1]);
    expect(loadCards(ACCOUNT)).toEqual([]);
  });
});
