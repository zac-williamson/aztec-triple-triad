/**
 * RedisGameStore test suite.
 *
 * Mirrors the MemoryGameStore tests but runs against a real Redis instance.
 * Skipped if REDIS_URL is not set (e.g., in CI without Redis).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { RedisGameStore } from '../../src/store/RedisGameStore.js';
import type { StoredGameRoom, SessionData, QueueEntryData } from '../../src/store/GameStore.js';

const REDIS_URL = process.env.REDIS_URL;

function makeRoom(overrides: Partial<StoredGameRoom> = {}): StoredGameRoom {
  return {
    id: '0x' + 'ab'.repeat(31),
    state: null as any,
    player1Id: 'p1',
    player2Id: null,
    player1CardIds: [1, 2, 3, 4, 5],
    player2CardIds: [],
    createdAt: Date.now(),
    lastActivity: Date.now(),
    expectedMoveNumber: 0,
    onChainStatus: { player1Tx: 'idle', player2Tx: 'idle', canSettle: false },
    ...overrides,
  };
}

describe.skipIf(!REDIS_URL)('RedisGameStore', () => {
  let store: RedisGameStore;

  beforeEach(async () => {
    store = new RedisGameStore(REDIS_URL!);
    await store.connect();
    // Flush all test keys between tests
    const redis = (store as any).redis;
    const patterns = ['game:*', 'session:*', 'player:*', 'inbox:*', 'queue*'];
    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
  });

  afterEach(async () => {
    if (store) await store.close();
  });

  // --- Game rooms ---

  describe('game rooms', () => {
    it('returns null for missing game', async () => {
      expect(await store.getGame('missing')).toBeNull();
    });

    it('stores and retrieves a game', async () => {
      const room = makeRoom();
      await store.setGame(room.id, room);
      expect(await store.getGame(room.id)).toEqual(room);
    });

    it('overwrites an existing game', async () => {
      const room = makeRoom();
      await store.setGame(room.id, room);
      const updated = { ...room, expectedMoveNumber: 3 };
      await store.setGame(room.id, updated);
      expect((await store.getGame(room.id))!.expectedMoveNumber).toBe(3);
    });

    it('deletes a game', async () => {
      const room = makeRoom();
      await store.setGame(room.id, room);
      await store.deleteGame(room.id);
      expect(await store.getGame(room.id)).toBeNull();
    });

    it('lists all games', async () => {
      const r1 = makeRoom({ id: 'g1' });
      const r2 = makeRoom({ id: 'g2' });
      await store.setGame('g1', r1);
      await store.setGame('g2', r2);
      const list = await store.listGames();
      expect(list).toHaveLength(2);
      expect(list.map(r => r.id).sort()).toEqual(['g1', 'g2']);
    });

    it('counts games', async () => {
      expect(await store.getGameCount()).toBe(0);
      await store.setGame('g1', makeRoom({ id: 'g1' }));
      expect(await store.getGameCount()).toBe(1);
    });
  });

  // --- Game locks ---

  describe('game locks', () => {
    it('acquires and releases a lock', async () => {
      expect(await store.acquireGameLock('g1', 5000)).toBe(true);
      await store.releaseGameLock('g1');
    });

    it('rejects a second acquire on the same game', async () => {
      expect(await store.acquireGameLock('g1', 5000)).toBe(true);
      expect(await store.acquireGameLock('g1', 5000)).toBe(false);
    });

    it('allows acquire after release', async () => {
      await store.acquireGameLock('g1', 5000);
      await store.releaseGameLock('g1');
      expect(await store.acquireGameLock('g1', 5000)).toBe(true);
    });

    it('locks are per-game', async () => {
      expect(await store.acquireGameLock('g1', 5000)).toBe(true);
      expect(await store.acquireGameLock('g2', 5000)).toBe(true);
    });
  });

  // --- Player → game mapping ---

  describe('player-game mapping', () => {
    it('returns null for unmapped player', async () => {
      expect(await store.getPlayerGame('p1')).toBeNull();
    });

    it('stores and retrieves', async () => {
      await store.setPlayerGame('p1', 'g1');
      expect(await store.getPlayerGame('p1')).toBe('g1');
    });

    it('deletes mapping', async () => {
      await store.setPlayerGame('p1', 'g1');
      await store.deletePlayerGame('p1');
      expect(await store.getPlayerGame('p1')).toBeNull();
    });
  });

  // --- Sessions ---

  describe('sessions', () => {
    const session: SessionData = {
      playerId: 'p1',
      createdAt: Date.now(),
      lastSeen: Date.now(),
    };

    it('returns null for missing session', async () => {
      expect(await store.getSession('tok')).toBeNull();
    });

    it('stores and retrieves a session', async () => {
      await store.setSession('tok', session);
      expect(await store.getSession('tok')).toEqual(session);
    });

    it('deletes a session', async () => {
      await store.setSession('tok', session);
      await store.deleteSession('tok');
      expect(await store.getSession('tok')).toBeNull();
    });

    it('reverse lookup by player', async () => {
      expect(await store.getSessionTokenByPlayer('p1')).toBeNull();
      await store.setSessionTokenByPlayer('p1', 'tok');
      expect(await store.getSessionTokenByPlayer('p1')).toBe('tok');
    });

    it('deletes reverse lookup', async () => {
      await store.setSessionTokenByPlayer('p1', 'tok');
      await store.deleteSessionTokenByPlayer('p1');
      expect(await store.getSessionTokenByPlayer('p1')).toBeNull();
    });
  });

  // --- Message inbox ---

  describe('message inbox', () => {
    it('returns empty array for empty inbox', async () => {
      expect(await store.getInbox('p1')).toEqual([]);
    });

    it('pushes and retrieves messages in FIFO order', async () => {
      await store.pushInbox('p1', { type: 'A' });
      await store.pushInbox('p1', { type: 'B' });
      await store.pushInbox('p1', { type: 'C' });
      const msgs = await store.getInbox('p1');
      expect(msgs).toEqual([{ type: 'A' }, { type: 'B' }, { type: 'C' }]);
    });

    it('clears inbox', async () => {
      await store.pushInbox('p1', { type: 'A' });
      await store.clearInbox('p1');
      expect(await store.getInbox('p1')).toEqual([]);
    });

    it('inboxes are per-player', async () => {
      await store.pushInbox('p1', { type: 'A' });
      await store.pushInbox('p2', { type: 'B' });
      expect(await store.getInbox('p1')).toEqual([{ type: 'A' }]);
      expect(await store.getInbox('p2')).toEqual([{ type: 'B' }]);
    });
  });

  // --- Matchmaking queue ---

  describe('matchmaking queue', () => {
    const entry1: QueueEntryData = { playerId: 'p1', cardIds: [1, 2, 3, 4, 5], queuedAt: Date.now(), lastPing: Date.now() };
    const entry2: QueueEntryData = { playerId: 'p2', cardIds: [6, 7, 8, 9, 10], queuedAt: Date.now(), lastPing: Date.now() };

    it('starts empty', async () => {
      expect(await store.getQueueLength()).toBe(0);
    });

    it('pushes entries', async () => {
      await store.pushQueue(entry1);
      expect(await store.getQueueLength()).toBe(1);
      expect(await store.isInQueue('p1')).toBe(true);
      expect(await store.isInQueue('p2')).toBe(false);
    });

    it('removes entries', async () => {
      await store.pushQueue(entry1);
      expect(await store.removeFromQueue('p1')).toBe(true);
      expect(await store.getQueueLength()).toBe(0);
      expect(await store.removeFromQueue('p1')).toBe(false);
    });

    it('pops a pair', async () => {
      await store.pushQueue(entry1);
      await store.pushQueue(entry2);
      const pair = await store.popQueuePair();
      expect(pair).not.toBeNull();
      expect(pair![0].playerId).toBe('p1');
      expect(pair![1].playerId).toBe('p2');
      expect(await store.getQueueLength()).toBe(0);
    });

    it('returns null if fewer than two', async () => {
      await store.pushQueue(entry1);
      expect(await store.popQueuePair()).toBeNull();
      expect(await store.getQueueLength()).toBe(1);
    });

    it('updates ping', async () => {
      await store.pushQueue({ ...entry1, lastPing: 1000 });
      expect(await store.updateQueuePing('p1')).toBe(true);
      expect(await store.updateQueuePing('missing')).toBe(false);
    });

    it('cleans up stale entries', async () => {
      const old = { ...entry1, lastPing: Date.now() - 60_000 };
      const fresh = { ...entry2, lastPing: Date.now() };
      await store.pushQueue(old);
      await store.pushQueue(fresh);
      expect(await store.cleanupStaleQueue(30_000)).toBe(1);
      expect(await store.getQueueLength()).toBe(1);
      expect(await store.isInQueue('p2')).toBe(true);
    });
  });

  // --- Stale game cleanup ---

  describe('cleanupStaleGames', () => {
    it('removes games older than timeout', async () => {
      const stale = makeRoom({ id: 'old', player1Id: 'p-old', lastActivity: Date.now() - 60_000 });
      const fresh = makeRoom({ id: 'new', player1Id: 'p-new', lastActivity: Date.now() });
      await store.setGame('old', stale);
      await store.setGame('new', fresh);
      await store.setPlayerGame('p-old', 'old');
      await store.setPlayerGame('p-new', 'new');
      await store.pushInbox('p-old', { type: 'X' });

      expect(await store.cleanupStaleGames(30_000)).toBe(1);
      expect(await store.getGame('old')).toBeNull();
      expect(await store.getGame('new')).not.toBeNull();
      expect(await store.getPlayerGame('p-old')).toBeNull();
      expect(await store.getPlayerGame('p-new')).toBe('new');
      expect(await store.getInbox('p-old')).toEqual([]);
    });
  });
});
