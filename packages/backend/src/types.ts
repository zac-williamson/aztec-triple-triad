import type { GameState, Card } from '@aztec-triple-triad/game-logic';

// Serialized proof for transport
export interface SerializedProof {
  proof: string;       // base64
  publicInputs: string[];
}

// Hand proof metadata
export interface HandProofData extends SerializedProof {
  cardCommit: string;
  playerAddress: string;
  gameId: string;
  grumpkinPublicKeyX: string;
  grumpkinPublicKeyY: string;
}

// Move proof metadata
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
  | { type: 'PLACE_CARD'; gameId: string; handIndex: number; row: number; col: number }
  | { type: 'LIST_GAMES' }
  | { type: 'GET_GAME'; gameId: string }
  // Proof-based messages
  | { type: 'SUBMIT_HAND_PROOF'; gameId: string; handProof: HandProofData }
  | { type: 'SUBMIT_MOVE_PROOF'; gameId: string; handIndex: number; row: number; col: number; moveProof: MoveProofData };

// Server -> Client messages
export type ServerMessage =
  | { type: 'GAME_CREATED'; gameId: string; playerNumber: 1 }
  | { type: 'GAME_JOINED'; gameId: string; playerNumber: 2; gameState: GameState }
  | { type: 'GAME_START'; gameId: string; gameState: GameState }
  | { type: 'GAME_STATE'; gameId: string; gameState: GameState; captures: { row: number; col: number }[] }
  | { type: 'GAME_OVER'; gameId: string; gameState: GameState; winner: 'player1' | 'player2' | 'draw' }
  | { type: 'GAME_LIST'; games: GameListEntry[] }
  | { type: 'GAME_INFO'; game: GameListEntry | null }
  | { type: 'OPPONENT_DISCONNECTED'; gameId: string }
  | { type: 'ERROR'; message: string }
  // Proof-based messages
  | { type: 'HAND_PROOF'; gameId: string; handProof: HandProofData; fromPlayer: 1 | 2 }
  | { type: 'MOVE_PROVEN'; gameId: string; gameState: GameState; captures: { row: number; col: number }[]; moveProof: MoveProofData; handIndex: number; row: number; col: number };

export interface GameListEntry {
  id: string;
  status: 'waiting' | 'playing' | 'finished';
  player1Connected: boolean;
  player2Connected: boolean;
  currentTurn?: 'player1' | 'player2';
  winner?: 'player1' | 'player2' | 'draw' | null;
}

export interface GameRoom {
  id: string;
  state: GameState;
  player1Id: string;
  player2Id: string | null;
  player1CardIds: number[];
  player2CardIds: number[];
  createdAt: number;
  lastActivity: number;
}
