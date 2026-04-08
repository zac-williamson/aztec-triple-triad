import type { GameState, Player } from '@axolotl-arena/game-logic';
import type { OnChainGameStatus, TxStatus } from '../types.js';

/**
 * Serializable game room — everything except the transient `processing` lock.
 */
export interface StoredGameRoom {
  id: string;
  state: GameState;
  player1Id: string;
  player2Id: string | null;
  player1CardIds: number[];
  player2CardIds: number[];
  createdAt: number;
  lastActivity: number;
  expectedMoveNumber: number;
  onChainStatus: OnChainGameStatus;
}

export interface SessionData {
  playerId: string;
  createdAt: number;
  lastSeen: number;
}

export interface QueueEntryData {
  playerId: string;
  cardIds: number[];
  queuedAt: number;
  lastPing: number;
}

/**
 * Persistence interface for game state, sessions, message inboxes, and matchmaking.
 *
 * Two implementations:
 *  - MemoryGameStore: in-process Maps/Arrays, used in tests and local dev
 *  - RedisGameStore:  ioredis-backed, used in production
 */
export interface GameStore {
  // --- Game rooms ---
  getGame(gameId: string): Promise<StoredGameRoom | null>;
  setGame(gameId: string, room: StoredGameRoom): Promise<void>;
  deleteGame(gameId: string): Promise<void>;
  listGames(): Promise<StoredGameRoom[]>;
  getGameCount(): Promise<number>;

  /**
   * Acquire a per-game mutex.  Returns true if the lock was acquired,
   * false if it is already held.  The lock auto-expires after `ttlMs`
   * to prevent deadlocks on crash.
   */
  acquireGameLock(gameId: string, ttlMs: number): Promise<boolean>;
  releaseGameLock(gameId: string): Promise<void>;

  // --- Player → game mapping ---
  getPlayerGame(playerId: string): Promise<string | null>;
  setPlayerGame(playerId: string, gameId: string): Promise<void>;
  deletePlayerGame(playerId: string): Promise<void>;

  // --- Sessions ---
  getSession(token: string): Promise<SessionData | null>;
  setSession(token: string, data: SessionData): Promise<void>;
  deleteSession(token: string): Promise<void>;
  /** Reverse lookup: find the session token for a given playerId. */
  getSessionTokenByPlayer(playerId: string): Promise<string | null>;
  setSessionTokenByPlayer(playerId: string, token: string): Promise<void>;
  deleteSessionTokenByPlayer(playerId: string): Promise<void>;

  // --- Message inbox (FIFO) ---
  pushInbox(playerId: string, msg: unknown): Promise<void>;
  getInbox(playerId: string): Promise<unknown[]>;
  clearInbox(playerId: string): Promise<void>;

  // --- Matchmaking queue ---
  pushQueue(entry: QueueEntryData): Promise<void>;
  removeFromQueue(playerId: string): Promise<boolean>;
  /** Remove and return the first two entries, or null if fewer than two. */
  popQueuePair(): Promise<[QueueEntryData, QueueEntryData] | null>;
  getQueueLength(): Promise<number>;
  isInQueue(playerId: string): Promise<boolean>;
  updateQueuePing(playerId: string): Promise<boolean>;
  cleanupStaleQueue(staleMs: number): Promise<number>;

  // --- Cleanup ---
  cleanupStaleGames(timeoutMs: number): Promise<number>;

  // --- Lifecycle ---
  close(): Promise<void>;
}
