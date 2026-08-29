import { SESSION_TTL_MS } from './GameStore.js';
import type { GameStore, StoredGameRoom, SessionData, QueueEntryData } from './GameStore.js';

/**
 * In-memory GameStore backed by Maps and Arrays.
 * Used in tests and local development (no Redis dependency).
 */
export class MemoryGameStore implements GameStore {
  private games = new Map<string, StoredGameRoom>();
  private playerToGame = new Map<string, string>();
  private sessions = new Map<string, SessionData>();
  private playerToSession = new Map<string, string>();
  private inboxes = new Map<string, unknown[]>();
  private queue: QueueEntryData[] = [];
  private locks = new Set<string>();
  private readonly sessionTtlMs: number;

  constructor(options: { sessionTtlMs?: number } = {}) {
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
  }

  // --- Game rooms ---

  async getGame(gameId: string): Promise<StoredGameRoom | null> {
    return this.games.get(gameId) ?? null;
  }

  async setGame(gameId: string, room: StoredGameRoom): Promise<void> {
    this.games.set(gameId, room);
  }

  async deleteGame(gameId: string): Promise<void> {
    this.games.delete(gameId);
  }

  async listGames(): Promise<StoredGameRoom[]> {
    return Array.from(this.games.values());
  }

  async getGameCount(): Promise<number> {
    return this.games.size;
  }

  async acquireGameLock(gameId: string, _ttlMs: number): Promise<boolean> {
    if (this.locks.has(gameId)) return false;
    this.locks.add(gameId);
    return true;
  }

  async releaseGameLock(gameId: string): Promise<void> {
    this.locks.delete(gameId);
  }

  // --- Player → game mapping ---

  async getPlayerGame(playerId: string): Promise<string | null> {
    return this.playerToGame.get(playerId) ?? null;
  }

  async setPlayerGame(playerId: string, gameId: string): Promise<void> {
    this.playerToGame.set(playerId, gameId);
  }

  async deletePlayerGame(playerId: string): Promise<void> {
    this.playerToGame.delete(playerId);
  }

  // --- Sessions ---

  async getSession(token: string): Promise<SessionData | null> {
    const data = this.sessions.get(token);
    if (!data) return null;
    // Lazy expiry, mirroring Redis TTL semantics (every setSession writes a
    // fresh lastSeen, so "expired since last write" == "lastSeen older than TTL").
    if (Date.now() - data.lastSeen > this.sessionTtlMs) {
      this.deleteSessionAndMapping(token, data);
      return null;
    }
    return data;
  }

  async setSession(token: string, data: SessionData): Promise<void> {
    this.sessions.set(token, data);
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  async getSessionTokenByPlayer(playerId: string): Promise<string | null> {
    return this.playerToSession.get(playerId) ?? null;
  }

  async setSessionTokenByPlayer(playerId: string, token: string): Promise<void> {
    this.playerToSession.set(playerId, token);
  }

  async deleteSessionTokenByPlayer(playerId: string): Promise<void> {
    this.playerToSession.delete(playerId);
  }

  /** Remove a session and, if it still points at this token, its reverse mapping. */
  private deleteSessionAndMapping(token: string, data: SessionData): void {
    this.sessions.delete(token);
    if (this.playerToSession.get(data.playerId) === token) {
      this.playerToSession.delete(data.playerId);
    }
  }

  // --- Message inbox ---

  async pushInbox(playerId: string, msg: unknown): Promise<void> {
    let inbox = this.inboxes.get(playerId);
    if (!inbox) {
      inbox = [];
      this.inboxes.set(playerId, inbox);
    }
    inbox.push(msg);
  }

  async getInbox(playerId: string): Promise<unknown[]> {
    return this.inboxes.get(playerId) ?? [];
  }

  async clearInbox(playerId: string): Promise<void> {
    this.inboxes.delete(playerId);
  }

  // --- Matchmaking queue ---

  async pushQueue(entry: QueueEntryData): Promise<void> {
    this.queue.push(entry);
  }

  async removeFromQueue(playerId: string): Promise<boolean> {
    const idx = this.queue.findIndex(e => e.playerId === playerId);
    if (idx === -1) return false;
    this.queue.splice(idx, 1);
    return true;
  }

  async popQueuePair(): Promise<[QueueEntryData, QueueEntryData] | null> {
    if (this.queue.length < 2) return null;
    const first = this.queue.shift()!;
    const second = this.queue.shift()!;
    return [first, second];
  }

  async getQueueLength(): Promise<number> {
    return this.queue.length;
  }

  async listQueue(): Promise<QueueEntryData[]> {
    return this.queue.map(e => ({ ...e }));
  }

  async isInQueue(playerId: string): Promise<boolean> {
    return this.queue.some(e => e.playerId === playerId);
  }

  async updateQueuePing(playerId: string): Promise<boolean> {
    const entry = this.queue.find(e => e.playerId === playerId);
    if (!entry) return false;
    entry.lastPing = Date.now();
    return true;
  }

  async cleanupStaleQueue(staleMs: number): Promise<number> {
    const now = Date.now();
    const stale = this.queue.filter(e => now - e.lastPing > staleMs);
    for (const entry of stale) {
      const idx = this.queue.indexOf(entry);
      if (idx !== -1) this.queue.splice(idx, 1);
    }
    return stale.length;
  }

  async removeDisconnectedQueueEntries(livePlayerIds: Set<string>): Promise<number> {
    const before = this.queue.length;
    this.queue = this.queue.filter(e => livePlayerIds.has(e.playerId));
    return before - this.queue.length;
  }

  // --- Cleanup ---

  async cleanupStaleGames(timeoutMs: number): Promise<number> {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, room] of this.games) {
      if (now - room.lastActivity > timeoutMs) {
        this.games.delete(id);
        this.playerToGame.delete(room.player1Id);
        if (room.player2Id) this.playerToGame.delete(room.player2Id);
        this.inboxes.delete(room.player1Id);
        if (room.player2Id) this.inboxes.delete(room.player2Id);
        cleaned++;
      }
    }
    return cleaned;
  }

  async cleanupStaleSessions(staleMs: number): Promise<number> {
    const now = Date.now();
    let cleaned = 0;
    for (const [token, data] of this.sessions) {
      if (now - data.lastSeen > staleMs) {
        this.deleteSessionAndMapping(token, data);
        cleaned++;
      }
    }
    return cleaned;
  }

  // --- Lifecycle ---

  async close(): Promise<void> {
    this.games.clear();
    this.playerToGame.clear();
    this.sessions.clear();
    this.playerToSession.clear();
    this.inboxes.clear();
    this.queue.length = 0;
    this.locks.clear();
  }
}
