export interface CardRanks {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Card {
  id: number;
  name: string;
  ranks: CardRanks;
  element?: string;
  imageUrl?: string;
}

export type Player = 'player1' | 'player2';

export interface BoardCell {
  card: Card | null;
  owner: Player | null;
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
