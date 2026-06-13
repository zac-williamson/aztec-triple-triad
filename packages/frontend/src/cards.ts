/**
 * Card data comes from the game-logic package — the single generated source
 * (scripts/card-database-256.json → game-logic CARD_DATABASE, mirrored into
 * circuits/card_data for what proofs enforce). This module re-exports the
 * data and adds frontend-only presentation helpers.
 */
import { getCardById } from '@axolotl-arena/game-logic';
import type { Rarity } from '@axolotl-arena/game-logic';

export { CARD_DATABASE, getCardById } from '@axolotl-arena/game-logic';
export type { Rarity } from '@axolotl-arena/game-logic';

/** Rarity for a card id, read from the card data ('common' for unknown ids). */
export function getCardRarity(cardId: number): Rarity {
  return getCardById(cardId)?.rarity ?? 'common';
}

/** Display form of an edge rank: 10 renders as 'A'. */
export function formatRank(rank: number): string {
  return rank === 10 ? 'A' : String(rank);
}
