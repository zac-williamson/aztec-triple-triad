export type { Card, CardRanks, Board, BoardCell, GameState, Player, PlaceCardResult } from './types.js';
export { CARD_DATABASE, getCardById, getCardsByIds, packRanks, unpackRanks, verifyCardRankConsistency } from './cards.js';
export { createGame, placeCard, getValidPlacements, isGameOver, calculateScores } from './game.js';
export type { AxolotlCard, Rarity } from './axolotlCards.js';
export {
  AXOLOTL_CARDS, RARITY_TIERS, CARDS_PER_POOL,
  getAxolotlCardById, getAxolotlCardsByRarity,
  determineRarity, selectCardFromPool,
} from './axolotlCards.js';
