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

// Serialized proof types for transport
export interface SerializedProof {
  proof: string;
  publicInputs: string[];
}

export interface HandProofData extends SerializedProof {
  cardCommit: string;
  playerAddress: string;
  gameId: string;
  grumpkinPublicKeyX: string;
  grumpkinPublicKeyY: string;
}

export interface MoveProofData extends SerializedProof {
  cardCommit1: string;
  cardCommit2: string;
  startStateHash: string;
  endStateHash: string;
  gameEnded: boolean;
  winnerId: number;
  encryptedCardNullifier: string;
}

// Client -> Server messages
export type ClientMessage =
  | { type: 'CREATE_GAME'; cardIds: number[] }
  | { type: 'JOIN_GAME'; gameId: string; cardIds: number[] }
  | { type: 'PLACE_CARD'; gameId: string; handIndex: number; row: number; col: number; moveNumber: number }
  | { type: 'LIST_GAMES' }
  | { type: 'GET_GAME'; gameId: string }
  | { type: 'SUBMIT_HAND_PROOF'; gameId: string; handProof: HandProofData }
  | { type: 'SUBMIT_MOVE_PROOF'; gameId: string; handIndex: number; row: number; col: number; moveNumber: number; moveProof: MoveProofData };

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
  | { type: 'ERROR'; message: string }
  | { type: 'HAND_PROOF'; gameId: string; handProof: HandProofData; fromPlayer: 1 | 2 }
  | { type: 'MOVE_PROVEN'; gameId: string; gameState: GameState; captures: { row: number; col: number }[]; moveProof: MoveProofData; handIndex: number; row: number; col: number };

export interface GameListEntry {
  id: string;
  status: 'waiting' | 'playing' | 'finished';
  player1Connected: boolean;
  player2Connected: boolean;
  currentTurn?: Player;
  winner?: Player | 'draw' | null;
}

export type Screen = 'lobby' | 'game' | 'result';
