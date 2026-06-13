import Redis from 'ioredis';
import { SESSION_TTL_MS } from './GameStore.js';
import type { GameStore, StoredGameRoom, SessionData, QueueEntryData } from './GameStore.js';

/**
 * Redis key schema:
 *
 *   game:{gameId}              → JSON(StoredGameRoom)        TTL: GAME_TTL_S
 *   game:{gameId}:lock         → "1"                          TTL: lock ttl (param)
 *   player:{playerId}:game     → gameId string                TTL: GAME_TTL_S
 *   session:{token}            → JSON(SessionData)            TTL: SESSION_TTL_S
 *   session:player:{playerId}  → token string                 TTL: SESSION_TTL_S
 *   inbox:{playerId}           → LIST of JSON strings         TTL: GAME_TTL_S
 *   queue                      → LIST of JSON(QueueEntryData) No TTL (stale sweep)
 */

const GAME_TTL_S = 30 * 60; // 30 minutes
const SESSION_TTL_S = SESSION_TTL_MS / 1000;

// Prefixes for SCAN-based operations
const GAME_PREFIX = 'game:';
const SESSION_PREFIX = 'session:';
const SESSION_PLAYER_PREFIX = 'session:player:';

export class RedisGameStore implements GameStore {
  private redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, { lazyConnect: true });
  }

  /** Call once before using the store. Establishes the Redis connection. */
  async connect(): Promise<void> {
    if (this.redis.status === 'ready') return;
    await this.redis.connect();
  }

  // --- Game rooms ---

  async getGame(gameId: string): Promise<StoredGameRoom | null> {
    const raw = await this.redis.get(`game:${gameId}`);
    if (!raw) return null;
    return JSON.parse(raw) as StoredGameRoom;
  }

  async setGame(gameId: string, room: StoredGameRoom): Promise<void> {
    await this.redis.set(`game:${gameId}`, JSON.stringify(room), 'EX', GAME_TTL_S);
  }

  async deleteGame(gameId: string): Promise<void> {
    await this.redis.del(`game:${gameId}`);
  }

  async listGames(): Promise<StoredGameRoom[]> {
    const keys = await this.scanKeys(`${GAME_PREFIX}*`);
    // Filter out lock keys
    const gameKeys = keys.filter(k => !k.endsWith(':lock'));
    if (gameKeys.length === 0) return [];
    const values = await this.redis.mget(...gameKeys);
    return values
      .filter((v): v is string => v !== null)
      .map(v => JSON.parse(v) as StoredGameRoom);
  }

  async getGameCount(): Promise<number> {
    const keys = await this.scanKeys(`${GAME_PREFIX}*`);
    return keys.filter(k => !k.endsWith(':lock')).length;
  }

  async acquireGameLock(gameId: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(`game:${gameId}:lock`, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  async releaseGameLock(gameId: string): Promise<void> {
    await this.redis.del(`game:${gameId}:lock`);
  }

  // --- Player → game mapping ---

  async getPlayerGame(playerId: string): Promise<string | null> {
    return this.redis.get(`player:${playerId}:game`);
  }

  async setPlayerGame(playerId: string, gameId: string): Promise<void> {
    await this.redis.set(`player:${playerId}:game`, gameId, 'EX', GAME_TTL_S);
  }

  async deletePlayerGame(playerId: string): Promise<void> {
    await this.redis.del(`player:${playerId}:game`);
  }

  // --- Sessions ---

  async getSession(token: string): Promise<SessionData | null> {
    const raw = await this.redis.get(`session:${token}`);
    if (!raw) return null;
    return JSON.parse(raw) as SessionData;
  }

  async setSession(token: string, data: SessionData): Promise<void> {
    await this.redis.set(`session:${token}`, JSON.stringify(data), 'EX', SESSION_TTL_S);
  }

  async deleteSession(token: string): Promise<void> {
    await this.redis.del(`session:${token}`);
  }

  async getSessionTokenByPlayer(playerId: string): Promise<string | null> {
    return this.redis.get(`session:player:${playerId}`);
  }

  async setSessionTokenByPlayer(playerId: string, token: string): Promise<void> {
    await this.redis.set(`session:player:${playerId}`, token, 'EX', SESSION_TTL_S);
  }

  async deleteSessionTokenByPlayer(playerId: string): Promise<void> {
    await this.redis.del(`session:player:${playerId}`);
  }

  // --- Message inbox ---

  async pushInbox(playerId: string, msg: unknown): Promise<void> {
    const key = `inbox:${playerId}`;
    await this.redis.rpush(key, JSON.stringify(msg));
    await this.redis.expire(key, GAME_TTL_S);
  }

  async getInbox(playerId: string): Promise<unknown[]> {
    const raw = await this.redis.lrange(`inbox:${playerId}`, 0, -1);
    return raw.map(s => JSON.parse(s));
  }

  async clearInbox(playerId: string): Promise<void> {
    await this.redis.del(`inbox:${playerId}`);
  }

  // --- Matchmaking queue ---

  async pushQueue(entry: QueueEntryData): Promise<void> {
    await this.redis.rpush('queue', JSON.stringify(entry));
  }

  async removeFromQueue(playerId: string): Promise<boolean> {
    // Read the full queue, find the entry, remove it
    const raw = await this.redis.lrange('queue', 0, -1);
    for (const item of raw) {
      const entry = JSON.parse(item) as QueueEntryData;
      if (entry.playerId === playerId) {
        // LREM removes the first occurrence matching the exact value
        const removed = await this.redis.lrem('queue', 1, item);
        return removed > 0;
      }
    }
    return false;
  }

  async popQueuePair(): Promise<[QueueEntryData, QueueEntryData] | null> {
    const len = await this.redis.llen('queue');
    if (len < 2) return null;
    // Atomically pop two entries from the front
    const first = await this.redis.lpop('queue');
    const second = await this.redis.lpop('queue');
    if (!first || !second) {
      // Race condition: push back what we got
      if (first) await this.redis.lpush('queue', first);
      if (second) await this.redis.lpush('queue', second);
      return null;
    }
    return [JSON.parse(first), JSON.parse(second)];
  }

  async getQueueLength(): Promise<number> {
    return this.redis.llen('queue');
  }

  async isInQueue(playerId: string): Promise<boolean> {
    const raw = await this.redis.lrange('queue', 0, -1);
    return raw.some(item => {
      const entry = JSON.parse(item) as QueueEntryData;
      return entry.playerId === playerId;
    });
  }

  async updateQueuePing(playerId: string): Promise<boolean> {
    const raw = await this.redis.lrange('queue', 0, -1);
    for (let i = 0; i < raw.length; i++) {
      const entry = JSON.parse(raw[i]) as QueueEntryData;
      if (entry.playerId === playerId) {
        entry.lastPing = Date.now();
        await this.redis.lset('queue', i, JSON.stringify(entry));
        return true;
      }
    }
    return false;
  }

  async cleanupStaleQueue(staleMs: number): Promise<number> {
    const now = Date.now();
    const raw = await this.redis.lrange('queue', 0, -1);
    let cleaned = 0;
    for (const item of raw) {
      const entry = JSON.parse(item) as QueueEntryData;
      if (now - entry.lastPing > staleMs) {
        const removed = await this.redis.lrem('queue', 1, item);
        if (removed > 0) cleaned++;
      }
    }
    return cleaned;
  }

  async removeDisconnectedQueueEntries(livePlayerIds: Set<string>): Promise<number> {
    const raw = await this.redis.lrange('queue', 0, -1);
    let cleaned = 0;
    for (const item of raw) {
      const entry = JSON.parse(item) as QueueEntryData;
      if (!livePlayerIds.has(entry.playerId)) {
        const removed = await this.redis.lrem('queue', 1, item);
        if (removed > 0) cleaned++;
      }
    }
    return cleaned;
  }

  // --- Cleanup ---

  async cleanupStaleGames(timeoutMs: number): Promise<number> {
    // Redis TTLs handle most expiry, but we also do explicit cleanup
    // for games whose lastActivity exceeds the timeout (in case TTL was refreshed).
    const games = await this.listGames();
    const now = Date.now();
    let cleaned = 0;
    for (const room of games) {
      if (now - room.lastActivity > timeoutMs) {
        await this.deleteGame(room.id);
        await this.deletePlayerGame(room.player1Id);
        if (room.player2Id) await this.deletePlayerGame(room.player2Id);
        await this.clearInbox(room.player1Id);
        if (room.player2Id) await this.clearInbox(room.player2Id);
        cleaned++;
      }
    }
    return cleaned;
  }

  async cleanupStaleSessions(staleMs: number): Promise<number> {
    // Redis TTLs expire sessions on their own; this sweep is the uniform
    // GameStore-contract path (and catches lastSeen staleness if a future
    // code path ever refreshes a key's TTL without rewriting lastSeen).
    const keys = await this.scanKeys(`${SESSION_PREFIX}*`);
    const sessionKeys = keys.filter(k => !k.startsWith(SESSION_PLAYER_PREFIX));
    const now = Date.now();
    let cleaned = 0;
    for (const key of sessionKeys) {
      const raw = await this.redis.get(key);
      if (!raw) continue; // expired between SCAN and GET
      const session = JSON.parse(raw) as SessionData;
      if (now - session.lastSeen > staleMs) {
        const token = key.slice(SESSION_PREFIX.length);
        await this.redis.del(key);
        const mappedToken = await this.redis.get(`${SESSION_PLAYER_PREFIX}${session.playerId}`);
        if (mappedToken === token) {
          await this.redis.del(`${SESSION_PLAYER_PREFIX}${session.playerId}`);
        }
        cleaned++;
      }
    }
    return cleaned;
  }

  // --- Lifecycle ---

  async close(): Promise<void> {
    await this.redis.quit();
  }

  // --- Internal helpers ---

  /** SCAN-based key enumeration (non-blocking, cursor-based). */
  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }
}
