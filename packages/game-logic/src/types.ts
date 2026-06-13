export interface CardRanks {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Pack-pool tier. Bands are positional: ids 1-10 common, 11-176 uncommon,
 * 177-226 rare, 227-246 epic, 247-256 legendary (CARDS_PER_POOL in
 * triple_triad_nft/src/main.nr). */
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export interface Card {
  id: number;
  name: string;
  ranks: CardRanks;
  rarity?: Rarity;
  element?: string;
  imageUrl?: string;
}

export type Player = 'player1' | 'player2';

export interface BoardCell {
  card: Card | null;
  /** Who currently controls this card (changes on capture) */
  owner: Player | null;
  /** Who originally placed this card (never changes) */
  originalOwner: Player | null;
}

export type Board = BoardCell[][];

export interface GameState {
  board: Board;
  player1Hand: Card[];
  player2Hand: Card[];
  currentTurn: Player;
  player1Score: number;
  player2Score: number;
  status: 'waiting' | 'playing' | 'finished';
  winner: Player | 'draw' | null;
}

export interface PlaceCardResult {
  newState: GameState;
  captures: { row: number; col: number }[];
}
