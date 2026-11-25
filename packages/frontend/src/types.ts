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
  originalOwner: Player | null
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
  /** Prover-local generation time in ms. Travels with relayed proofs, so an
   *  opponent's proof carries the opponent's timing. Display-only. */
  durationMs?: number;
}

/**
 * A game_move proof. Its 8 public inputs are
 * `[card_commit_1, card_commit_2, start_state_hash, end_state_hash,
 *   game_ended, winner_id, placed_card_id, placed_slot]`.
 * `placedSlot` is the index of the placed card in its mover's committed hand —
 * what settlement uses to hold back the loser's return note for the prize.
 */
export interface MoveProofData extends SerializedProof {
  cardCommit1: string;
  cardCommit2: string;
  startStateHash: string;
  endStateHash: string;
  gameEnded: boolean;
  winnerId: number;
  /** Optional only because a relayed proof may predate the field; read it
   *  through `placedOf` (privateGame.ts), which falls back to the inputs. */
  placedCardId?: number;
  placedSlot?: number;
}

/** A player-to-player payload, sealed with the game's channel key. */
export interface SealedPeerMessage {
  iv: string;
  ciphertext: string;
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
  | { type: 'SUBMIT_MOVE_PROOF'; gameId: string; handIndex: number; row: number; col: number; moveNumber: number; moveProof: MoveProofData }
  // On-chain lifecycle messages. No tx hash: the relay must not be able to
  // find a game's transactions (docs/plan/PRIVATE_GAMES.md section 7).
  | { type: 'TX_CONFIRMED'; gameId: string; txType: 'create_game' | 'join_game' }
  | { type: 'TX_FAILED'; gameId: string; txType: 'create_game' | 'join_game'; error: string }
  | { type: 'CANCEL_GAME'; gameId: string }
  /** "I am done with this game" — releases only the sender's binding. */
  | { type: 'LEAVE_GAME'; gameId: string }
  // The per-game key exchange (section 5.1): only public keys cross the relay.
  | { type: 'KEY_EXCHANGE'; gameId: string; publicKey: string }
  // Every player-to-player payload, sealed with the channel key. The relay
  // forwards and buffers it without being able to read it.
  | { type: 'PEER'; gameId: string; iv: string; ciphertext: string }
  // An abandoned game was unwound on-chain — the server releases both players'
  // room bindings on receipt (QA-F3, docs/plan/LANE_4_BACKEND.md)
  | { type: 'ABANDONED_GAME_SETTLED'; gameId: string }
  // Matchmaking
  | { type: 'QUEUE_MATCHMAKING'; cardIds: number[] }
  | { type: 'CANCEL_MATCHMAKING' }
  | { type: 'PING' }
  // Session resumption
  | { type: 'RESUME'; sessionToken: string };

// Server -> Client messages
export type ServerMessage =
  | { type: 'GAME_CREATED'; gameId: string; playerNumber: 1 }
  | { type: 'GAME_JOINED'; gameId: string; playerNumber: 2; gameState: GameState }
  | { type: 'GAME_START'; gameId: string; gameState: GameState }
  | { type: 'GAME_STATE'; gameId: string; gameState: GameState; captures: { row: number; col: number }[] }
  // No card ids: a game's hands are nobody's business but its players'.
  | { type: 'GAME_OVER'; gameId: string; gameState: GameState; winner: Player | 'draw' }
  | { type: 'GAME_LIST'; games: GameListEntry[] }
  | { type: 'GAME_INFO'; game: GameListEntry | null }
  | { type: 'OPPONENT_DISCONNECTED'; gameId: string }
  // Present-but-idle abandonment warning — broadcast to BOTH players when the
  // player whose turn it is has not moved for >=60s. Re-sent/updated as the
  // window progresses; cleared client-side when a move/GAME_STATE arrives or
  // the game ends (docs/plan/ABANDONED_GAMES.md "Message contract").
  | { type: 'GAME_ABANDONMENT_WARNING'; gameId: string; idlePlayer: Player; secondsIdle: number; secondsUntilClaimable: number }
  | { type: 'ERROR'; message: string }
  | { type: 'MOVE_PROVEN'; gameId: string; gameState: GameState; captures: { row: number; col: number }[]; moveProof: MoveProofData; handIndex: number; row: number; col: number }
  // On-chain lifecycle messages
  | { type: 'ON_CHAIN_STATUS'; gameId: string; status: OnChainGameStatus }
  | { type: 'GAME_CANCELLED'; gameId: string; reason: string }
  // The opponent's half of the key exchange, and their sealed payloads.
  | { type: 'OPPONENT_KEY'; gameId: string; publicKey: string }
  | { type: 'PEER'; gameId: string; iv: string; ciphertext: string }
  // Matchmaking
  | { type: 'MATCHMAKING_QUEUED'; position: number }
  | { type: 'MATCH_FOUND'; gameId: string; playerNumber: 1 | 2; gameState: GameState }
  | { type: 'MATCHMAKING_CANCELLED' }
  | { type: 'PONG' }
  // Session management
  | { type: 'SESSION_ESTABLISHED'; sessionToken: string; playerId: string; resumed: boolean; gameId: string | null }
  | { type: 'OPPONENT_RECONNECTED'; gameId: string };

export interface GameListEntry {
  id: string;
  status: 'waiting' | 'playing' | 'finished';
  player1Connected: boolean;
  player2Connected: boolean;
  currentTurn?: Player;
  winner?: Player | 'draw' | null;
}

export type Screen = 'main-menu' | 'card-selector' | 'finding-opponent' | 'game' | 'card-packs' | 'pack-opening';

// Matchmaking message types
export type MatchmakingClientMessage =
  | { type: 'QUEUE_MATCHMAKING'; cardIds: number[] }
  | { type: 'CANCEL_MATCHMAKING' }
  | { type: 'PING' };

export type MatchmakingServerMessage =
  | { type: 'MATCHMAKING_QUEUED'; position: number }
  | { type: 'MATCH_FOUND'; gameId: string; playerNumber: 1 | 2; gameState: GameState }
  | { type: 'MATCHMAKING_CANCELLED' }
  | { type: 'PONG' };
