// Shared types - mirrored from game-logic and backend for browser use

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

// Client -> Server messages
export type ClientMessage =
  | { type: 'CREATE_GAME'; cardIds: number[] }
  | { type: 'JOIN_GAME'; gameId: string; cardIds: number[] }
  | { type: 'PLACE_CARD'; gameId: string; handIndex: number; row: number; col: number }
  | { type: 'LIST_GAMES' }
  | { type: 'GET_GAME'; gameId: string };

// Server -> Client messages
export type ServerMessage =
  | { type: 'GAME_CREATED'; gameId: string; playerNumber: 1 }
  | { type: 'GAME_JOINED'; gameId: string; playerNumber: 2; gameState: GameState }
  | { type: 'GAME_START'; gameId: string; gameState: GameState }
  | { type: 'GAME_STATE'; gameId: string; gameState: GameState; captures: { row: number; col: number }[] }
  | { type: 'GAME_OVER'; gameId: string; gameState: GameState; winner: Player | 'draw' }
  | { type: 'GAME_LIST'; games: GameListEntry[] }
  | { type: 'GAME_INFO'; game: GameListEntry | null }
  | { type: 'OPPONENT_DISCONNECTED'; gameId: string }
  | { type: 'ERROR'; message: string };

export interface GameListEntry {
  id: string;
  status: 'waiting' | 'playing' | 'finished';
  player1Connected: boolean;
  player2Connected: boolean;
  currentTurn?: Player;
  winner?: Player | 'draw' | null;
}

export type Screen = 'lobby' | 'game' | 'result';
