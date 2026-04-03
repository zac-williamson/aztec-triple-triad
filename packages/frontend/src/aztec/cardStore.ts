/**
 * localStorage-backed card inventory.
 *
 * Stores all data needed to re-import card notes into a fresh PXE
 * and verify their on-chain existence via the note hash tree.
 */

export interface StoredCard {
  cardId: number;
  randomness: string;       // Fr hex string
  txHash: string;           // minting tx hash
  noteHashes: string[];     // non-zero unique note hashes from minting TxEffect
  firstNullifier: string;   // first nullifier from minting TxEffect
}

import { AZTEC_CONFIG } from './config';

const STORAGE_PREFIX = 'aztec_tt_card_inventory_';

function key(accountAddress: string): string {
  return STORAGE_PREFIX + accountAddress + '_' + (AZTEC_CONFIG.gameContractAddress || 'default');
}

export function loadCards(accountAddress: string): StoredCard[] {
  try {
    const raw = localStorage.getItem(key(accountAddress));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveCards(accountAddress: string, cards: StoredCard[]): void {
  localStorage.setItem(key(accountAddress), JSON.stringify(cards));
}

export function addCards(accountAddress: string, newCards: StoredCard[]): void {
  const existing = loadCards(accountAddress);
  const existingIds = new Set(existing.map((c) => c.cardId));
  const toAdd = newCards.filter((c) => !existingIds.has(c.cardId));
  saveCards(accountAddress, [...existing, ...toAdd]);
}

export function removeCards(accountAddress: string, cardIds: number[]): void {
  const removeSet = new Set(cardIds);
  const remaining = loadCards(accountAddress).filter((c) => !removeSet.has(c.cardId));
  saveCards(accountAddress, remaining);
}
