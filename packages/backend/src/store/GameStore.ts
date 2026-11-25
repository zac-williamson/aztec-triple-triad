import type { OnChainGameStatus } from '../types.js';

/**
 * How long a session may sit idle (no create/RESUME/PING refresh) before it
 * expires. Single source of truth for both stores: Redis enforces it as a key
 * TTL, MemoryGameStore enforces it lazily on read plus via the periodic
 * cleanupStaleSessions sweep.
 */
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * A room, as the relay keeps it: who is in it, how many moves have gone
 * through, and when. No hand, board, score or result — the relay never sees
 * one (docs/plan/PRIVATE_GAMES.md §6).
 */
export interface StoredGameRoom {
  id: string;
  /** Matchmaking opens a room with both players in it; nobody joins later. */
  player1Id: string;
  player2Id: string;
  createdAt: number;
  lastActivity: number;
  /**
   * When the current turn began, used solely for present-but-idle abandonment
   * detection: the last relayed MOVE, or — before the first — the moment the
   * game went on-chain (both commits confirmed). Distinct from `lastActivity`,
   * which tx status reports also refresh: those keep the room alive but do not
   * restart a turn.
   */
  lastMoveTimestamp: number;
  /**
   * MOVEs relayed so far, 0..9. The next MOVE accepted is number `movesMade`,
   * and at nine the room's moves are complete.
   */
  movesMade: number;
  onChainStatus: OnChainGameStatus;
}

export interface SessionData {
  playerId: string;
  createdAt: number;
  lastSeen: number;
}

/** A waiting player. Deliberately nothing about their hand. */
export interface QueueEntryData {
  playerId: string;
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
  /**
   * Snapshot of the queue in position order. Read-only introspection for the
   * /queue endpoint and the arena bot, which needs each entry's `queuedAt` to
   * decide whether anyone has waited past the bot's join threshold.
   */
  listQueue(): Promise<QueueEntryData[]>;
  isInQueue(playerId: string): Promise<boolean>;
  updateQueuePing(playerId: string): Promise<boolean>;
  cleanupStaleQueue(staleMs: number): Promise<number>;
  /**
   * Remove queue entries whose playerId is NOT in the live set.
   * Returns the number of entries removed. Used before tryMatch to
   * prevent pairing live players with stale/disconnected entries.
   */
  removeDisconnectedQueueEntries(livePlayerIds: Set<string>): Promise<number>;

  // --- Cleanup ---
  cleanupStaleGames(timeoutMs: number): Promise<number>;
  /**
   * Remove sessions whose lastSeen is older than staleMs, along with each
   * removed session's player→token reverse mapping (only when that mapping
   * still points at the removed token). Returns the number of sessions removed.
   */
  cleanupStaleSessions(staleMs: number): Promise<number>;

  // --- Lifecycle ---
  close(): Promise<void>;
}
