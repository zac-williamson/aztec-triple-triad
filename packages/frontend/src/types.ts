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

// Client -> Server messages (docs/plan/PRIVATE_GAMES.md section 6.1).
//
// The relay is a pipe: it pairs players, holds rooms, buffers for the offline
// and times turns. It never sees a card id, a move or a result — every
// player-to-player payload is sealed with the game's channel key.
export type ClientMessage =
  // On-chain lifecycle messages. No tx hash: the relay must not be able to
  // find a game's transactions (docs/plan/PRIVATE_GAMES.md section 7).
  | { type: 'TX_CONFIRMED'; gameId: string; txType: 'create_game' | 'join_game' }
  | { type: 'TX_FAILED'; gameId: string; txType: 'create_game' | 'join_game'; error: string }
  /** "I am done with this game" — releases only the sender's binding. */
  | { type: 'LEAVE_GAME'; gameId: string }
  // The per-game key exchange (section 5.1): only public keys cross the relay.
  | { type: 'KEY_EXCHANGE'; gameId: string; publicKey: string }
  // Every player-to-player payload, sealed with the channel key. The relay
  // forwards and buffers it without being able to read it.
  | { type: 'PEER'; gameId: string; iv: string; ciphertext: string }
  /**
   * A move, sealed: `{cardId, slot, row, col, proof, publicInputs}`. The relay
   * reads only the move NUMBER — it accepts 0..8 in order, player 1 at even
   * numbers and player 2 at odd — and forwards the ciphertext.
   */
  | { type: 'MOVE'; gameId: string; moveNumber: number; iv: string; ciphertext: string }
  // Matchmaking. No card ids: the hand is nobody's business but its owner's.
  | { type: 'QUEUE_MATCHMAKING' }
  | { type: 'CANCEL_MATCHMAKING' }
  | { type: 'PING' }
  // Session resumption
  | { type: 'RESUME'; sessionToken: string };

/** Where a room stands, from the relay's side: sent after a RESUME. */
export interface RoomState {
  gameId: string;
  playerNumber: 1 | 2;
  /** How many MOVEs the relay has accepted (0..9). */
  movesMade: number;
  opponentConnected: boolean;
}

// Server -> Client messages
export type ServerMessage =
  | { type: 'OPPONENT_DISCONNECTED'; gameId: string }
  // Present-but-idle abandonment warning — broadcast to BOTH players when the
  // player whose turn it is has not moved for >=60s. Re-sent/updated as the
  // window progresses; cleared client-side when a move arrives
  // (docs/plan/ABANDONED_GAMES.md "Message contract").
  | { type: 'GAME_ABANDONMENT_WARNING'; gameId: string; idlePlayer: Player; secondsIdle: number; secondsUntilClaimable: number }
  | { type: 'ERROR'; message: string }
  // On-chain lifecycle: canSettle = both commits confirmed and 9 moves relayed.
  | { type: 'ON_CHAIN_STATUS'; gameId: string; status: OnChainGameStatus }
  // The opponent's half of the key exchange, and their sealed payloads.
  | { type: 'OPPONENT_KEY'; gameId: string; publicKey: string }
  | { type: 'PEER'; gameId: string; iv: string; ciphertext: string }
  | { type: 'MOVE'; gameId: string; moveNumber: number; iv: string; ciphertext: string }
  | ({ type: 'ROOM_STATE' } & RoomState)
  // Matchmaking
  | { type: 'MATCHMAKING_QUEUED'; position: number }
  | { type: 'MATCH_FOUND'; gameId: string; playerNumber: 1 | 2 }
  | { type: 'MATCHMAKING_CANCELLED' }
  | { type: 'PONG' }
  // Session management
  | { type: 'SESSION_ESTABLISHED'; sessionToken: string; playerId: string; resumed: boolean; gameId: string | null }
  | { type: 'OPPONENT_RECONNECTED'; gameId: string };

export type Screen = 'main-menu' | 'card-selector' | 'finding-opponent' | 'game' | 'card-packs' | 'pack-opening';
