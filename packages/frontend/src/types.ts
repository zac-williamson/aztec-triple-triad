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
}

export interface MoveProofData extends SerializedProof {
  cardCommit1: string;
  cardCommit2: string;
  startStateHash: string;
  endStateHash: string;
  gameEnded: boolean;
  winnerId: number;
}

// On-chain transaction status tracking
export type TxStatus = 'idle' | 'sending' | 'mining' | 'confirmed' | 'failed';

export interface OnChainGameStatus {
  player1Tx: TxStatus;
  player2Tx: TxStatus;
  canSettle: boolean;
}

// Client -> Server messages
export type ClientMessage =
  | { type: 'CREATE_GAME'; cardIds: number[] }
  | { type: 'JOIN_GAME'; gameId: string; cardIds: number[] }
  | { type: 'PLACE_CARD'; gameId: string; handIndex: number; row: number; col: number; moveNumber: number }
  | { type: 'LIST_GAMES' }
  | { type: 'GET_GAME'; gameId: string }
  | { type: 'SUBMIT_HAND_PROOF'; gameId: string; handProof: HandProofData }
  | { type: 'SUBMIT_MOVE_PROOF'; gameId: string; handIndex: number; row: number; col: number; moveNumber: number; moveProof: MoveProofData }
  // On-chain lifecycle messages
  | { type: 'TX_CONFIRMED'; gameId: string; txType: 'create_game' | 'join_game'; txHash: string }
  | { type: 'TX_FAILED'; gameId: string; txType: 'create_game' | 'join_game'; error: string }
  | { type: 'CANCEL_GAME'; gameId: string };

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
  | { type: 'MOVE_PROVEN'; gameId: string; gameState: GameState; captures: { row: number; col: number }[]; moveProof: MoveProofData; handIndex: number; row: number; col: number }
  // On-chain lifecycle messages
  | { type: 'ON_CHAIN_STATUS'; gameId: string; status: OnChainGameStatus }
  | { type: 'GAME_CANCELLED'; gameId: string; reason: string };

export interface GameListEntry {
  id: string;
  status: 'waiting' | 'playing' | 'finished';
  player1Connected: boolean;
  player2Connected: boolean;
  currentTurn?: Player;
  winner?: Player | 'draw' | null;
}

export type Screen = 'lobby' | 'game' | 'result';
