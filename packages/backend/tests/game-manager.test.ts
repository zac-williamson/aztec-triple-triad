import { describe, it, expect, beforeEach } from 'vitest';
import { GameManager, MOVE_INACTIVITY_MS, MOVES_PER_GAME, moverOf } from '../src/GameManager.js';
import { MemoryGameStore } from '../src/store/MemoryGameStore.js';
import type { StoredGameRoom } from '../src/store/GameStore.js';

/** Who makes move `n` in a room opened by `openRoom`. */
const moverId = (n: number): string => (moverOf(n) === 1 ? 'player-1' : 'player-2');

describe('GameManager', () => {
  let store: MemoryGameStore;
  let manager: GameManager;

  beforeEach(() => {
    store = new MemoryGameStore();
    manager = new GameManager(store);
  });

  /** Queue two players and match them; the first is player 1. Returns the room id. */
  async function openRoom(p1 = 'player-1', p2 = 'player-2'): Promise<string> {
    await manager.queuePlayer(p1);
    await manager.queuePlayer(p2);
    const match = await manager.tryMatch(new Set([p1, p2]));
    return match!.room.id;
  }

  /** Record moves `from` up to (not including) `to`, each from its rightful player. */
  async function play(gameId: string, from: number, to: number): Promise<void> {
    for (let n = from; n < to; n++) await manager.recordMove(gameId, moverId(n), n);
  }

  async function confirmBoth(gameId: string): Promise<void> {
    await manager.updateTxStatus(gameId, 'player-1', 'confirmed');
    await manager.updateTxStatus(gameId, 'player-2', 'confirmed');
  }

  async function room(gameId: string): Promise<StoredGameRoom> {
    return (await manager.getGame(gameId))!;
  }

  /** Back-date the room's turn clock by `ms` so it appears idle. */
  async function backdateLastMove(gameId: string, ms: number): Promise<void> {
    const r = await room(gameId);
    r.lastMoveTimestamp = Date.now() - ms;
    await store.setGame(gameId, r);
  }

  describe('rooms', () => {
    it('opens a room for a matched pair holding nothing about their game', async () => {
      const id = await openRoom();
      const r = await room(id);
      // No hand, board, score or winner: the relay never sees one.
      expect(Object.keys(r).sort()).toEqual([
        'createdAt', 'id', 'lastActivity', 'lastMoveTimestamp', 'movesMade', 'onChainStatus', 'player1Id', 'player2Id',
      ]);
      expect(r).toMatchObject({
        id,
        player1Id: 'player-1',
        player2Id: 'player-2',
        movesMade: 0,
        onChainStatus: { player1Tx: 'idle', player2Tx: 'idle', canSettle: false },
      });
    });

    it('binds both players to it', async () => {
      const id = await openRoom();
      expect(await manager.getPlayerGame('player-1')).toBe(id);
      expect(await manager.getPlayerGame('player-2')).toBe(id);
    });

    it('counts rooms', async () => {
      expect(await manager.getGameCount()).toBe(0);
      await openRoom();
      await openRoom('player-3', 'player-4');
      expect(await manager.getGameCount()).toBe(2);
    });
  });

  describe('recordMove', () => {
    it('accepts the nine moves in order, player 1 at even numbers and player 2 at odd', async () => {
      const id = await openRoom();
      for (let n = 0; n < MOVES_PER_GAME; n++) {
        const recorded = await manager.recordMove(id, moverId(n), n);
        expect(recorded.opponentId).toBe(n % 2 === 0 ? 'player-2' : 'player-1');
        expect(recorded.room.movesMade).toBe(n + 1);
        expect(recorded.movesComplete).toBe(n === MOVES_PER_GAME - 1);
      }
      expect((await room(id)).movesMade).toBe(9);
    });

    it('refuses move numbers out of order: no skipping ahead, no replays', async () => {
      const id = await openRoom();
      await expect(manager.recordMove(id, 'player-1', 1)).rejects.toThrow('Invalid move number: expected 0, got 1');
      await manager.recordMove(id, 'player-1', 0);
      await expect(manager.recordMove(id, 'player-2', 0)).rejects.toThrow('Invalid move number: expected 1, got 0');
      await expect(manager.recordMove(id, 'player-2', 2)).rejects.toThrow('Invalid move number: expected 1, got 2');
      await manager.recordMove(id, 'player-2', 1);
      expect((await room(id)).movesMade).toBe(2);
    });

    it('refuses a move from the player whose turn it is not', async () => {
      const id = await openRoom();
      await expect(manager.recordMove(id, 'player-2', 0)).rejects.toThrow('Not your turn');
      await manager.recordMove(id, 'player-1', 0);
      await expect(manager.recordMove(id, 'player-1', 1)).rejects.toThrow('Not your turn');
    });

    it('refuses players not in the room, and rooms that do not exist', async () => {
      const id = await openRoom();
      await expect(manager.recordMove(id, 'player-3', 0)).rejects.toThrow('Not in this game');
      await expect(manager.recordMove('no-such-room', 'player-1', 0)).rejects.toThrow('Game not found');
    });

    it('takes nothing after the ninth move', async () => {
      const id = await openRoom();
      await play(id, 0, 9);
      await expect(manager.recordMove(id, 'player-1', 8)).rejects.toThrow('All nine moves are already in');
      await expect(manager.recordMove(id, 'player-2', 9)).rejects.toThrow('All nine moves are already in');
      expect((await room(id)).movesMade).toBe(9);
    });

    it('changes nothing when it refuses a move', async () => {
      const id = await openRoom();
      await backdateLastMove(id, 5000);
      const before = structuredClone(await room(id));
      await expect(manager.recordMove(id, 'player-2', 0)).rejects.toThrow();
      await expect(manager.recordMove(id, 'player-1', 3)).rejects.toThrow();
      expect(await room(id)).toEqual(before);
    });

    it('restarts the turn clock with each move', async () => {
      const id = await openRoom();
      await backdateLastMove(id, 50_000);
      const before = Date.now();
      await manager.recordMove(id, 'player-1', 0);
      expect((await room(id)).lastMoveTimestamp).toBeGreaterThanOrEqual(before);
    });

    it('releases both players once the moves are complete, so either can queue again', async () => {
      const id = await openRoom();
      await play(id, 0, 8);
      expect(await manager.getPlayerGame('player-1')).toBe(id);
      await manager.recordMove(id, 'player-1', 8);
      expect(await manager.getPlayerGame('player-1')).toBeNull();
      expect(await manager.getPlayerGame('player-2')).toBeNull();
      // The room itself stays: the settlement notices still travel through it.
      expect(await manager.getGame(id)).not.toBeNull();
      await manager.queuePlayer('player-1');
    });

    it('does not release a player who has already moved on to another room', async () => {
      const first = await openRoom();
      await play(first, 0, 8);
      // Player 2 has made its last move, leaves, and is matched again.
      await manager.releasePlayer('player-2');
      const second = await openRoom('player-2', 'player-3');

      await manager.recordMove(first, 'player-1', 8);
      expect(await manager.getPlayerGame('player-2')).toBe(second);
    });

    it('never loses a move count to a concurrent tx report', async () => {
      // Like Redis, this store hands out copies. Two handlers that each read
      // the room and write their copy back would lose one of the changes —
      // and a lost move count wedges the game, since the relay would then
      // refuse the next move as out of order.
      class CopyingStore extends MemoryGameStore {
        override async getGame(gameId: string): Promise<StoredGameRoom | null> {
          const found = await super.getGame(gameId);
          return found && structuredClone(found);
        }
        override async setGame(gameId: string, r: StoredGameRoom): Promise<void> {
          await super.setGame(gameId, structuredClone(r));
        }
      }
      store = new CopyingStore();
      manager = new GameManager(store);
      const id = await openRoom();

      await Promise.all([
        manager.recordMove(id, 'player-1', 0),
        manager.updateTxStatus(id, 'player-2', 'confirmed'),
      ]);
      await Promise.all([
        manager.updateTxStatus(id, 'player-1', 'confirmed'),
        manager.recordMove(id, 'player-2', 1),
      ]);

      const r = await room(id);
      expect(r.movesMade).toBe(2);
      expect(r.onChainStatus).toMatchObject({ player1Tx: 'confirmed', player2Tx: 'confirmed' });
    });
  });

  describe('updateTxStatus', () => {
    it('says canSettle only with both commits confirmed AND all nine moves in', async () => {
      const id = await openRoom();
      expect(await manager.updateTxStatus(id, 'player-1', 'confirmed'))
        .toEqual({ player1Tx: 'confirmed', player2Tx: 'idle', canSettle: false });
      expect(await manager.updateTxStatus(id, 'player-2', 'confirmed'))
        .toEqual({ player1Tx: 'confirmed', player2Tx: 'confirmed', canSettle: false });
      await play(id, 0, 8);
      expect((await room(id)).onChainStatus.canSettle).toBe(false);
      const last = await manager.recordMove(id, 'player-1', 8);
      expect(last.room.onChainStatus.canSettle).toBe(true);
    });

    it('also gets to canSettle when the moves finish before the last commit is reported', async () => {
      const id = await openRoom();
      await play(id, 0, 9);
      expect((await manager.updateTxStatus(id, 'player-2', 'confirmed'))!.canSettle).toBe(false);
      expect((await manager.updateTxStatus(id, 'player-1', 'confirmed'))!.canSettle).toBe(true);
    });

    it('records a failure', async () => {
      const id = await openRoom();
      expect(await manager.updateTxStatus(id, 'player-2', 'failed'))
        .toEqual({ player1Tx: 'idle', player2Tx: 'failed', canSettle: false });
    });

    it('returns null for a player not in the room, or a room that does not exist', async () => {
      const id = await openRoom();
      expect(await manager.updateTxStatus(id, 'player-3', 'confirmed')).toBeNull();
      expect(await manager.updateTxStatus('no-such-room', 'player-1', 'confirmed')).toBeNull();
    });

    it('starts the first turn when the second commit lands', async () => {
      const id = await openRoom();
      await backdateLastMove(id, 10 * 60_000);
      const stale = (await room(id)).lastMoveTimestamp;

      await manager.updateTxStatus(id, 'player-1', 'confirmed');
      expect((await room(id)).lastMoveTimestamp).toBe(stale);

      const before = Date.now();
      await manager.updateTxStatus(id, 'player-2', 'confirmed');
      expect((await room(id)).lastMoveTimestamp).toBeGreaterThanOrEqual(before);
    });

    it('does not restart a turn that is already running', async () => {
      const id = await openRoom();
      await manager.recordMove(id, 'player-1', 0);
      await backdateLastMove(id, 40_000);
      const turnStart = (await room(id)).lastMoveTimestamp;

      await confirmBoth(id);
      await manager.updateTxStatus(id, 'player-1', 'confirmed');
      expect((await room(id)).lastMoveTimestamp).toBe(turnStart);
    });
  });

  describe('roomInfo', () => {
    it('says only what a pipe knows: status, move count, who is connected', async () => {
      const id = await openRoom();
      const info = await manager.roomInfo(id, playerId => playerId === 'player-1');
      expect(info).toEqual({ id, status: 'waiting', movesMade: 0, player1Connected: true, player2Connected: false });
    });

    it('goes waiting → active → moves-complete', async () => {
      const id = await openRoom();
      const status = async () => (await manager.roomInfo(id, () => true))!.status;
      expect(await status()).toBe('waiting');
      await manager.updateTxStatus(id, 'player-1', 'confirmed');
      expect(await status()).toBe('waiting');
      await manager.updateTxStatus(id, 'player-2', 'confirmed');
      expect(await status()).toBe('active');
      await play(id, 0, 8);
      expect(await status()).toBe('active');
      await play(id, 8, 9);
      expect(await status()).toBe('moves-complete');
    });

    it('is active from the first move even if no commit was reported', async () => {
      const id = await openRoom();
      await play(id, 0, 1);
      expect(await manager.roomInfo(id, () => true)).toMatchObject({ status: 'active', movesMade: 1 });
    });

    it('returns null for a room that does not exist', async () => {
      expect(await manager.roomInfo('no-such-room', () => true)).toBeNull();
    });
  });

  describe('queuePlayer', () => {
    it('queues a player and nothing about their hand', async () => {
      expect(await manager.queuePlayer('player-1')).toBe(1);
      const entries = await store.listQueue();
      expect(entries).toHaveLength(1);
      expect(Object.keys(entries[0]).sort()).toEqual(['lastPing', 'playerId', 'queuedAt']);
    });

    it('refuses a player still bound to a room', async () => {
      await openRoom();
      await expect(manager.queuePlayer('player-1')).rejects.toThrow('You are already in an active game');
    });

    it('refuses a player already queued', async () => {
      await manager.queuePlayer('player-1');
      await expect(manager.queuePlayer('player-1')).rejects.toThrow('already in the matchmaking queue');
    });

    it('lets a player whose binding points at a vanished room queue, cleaning the binding up', async () => {
      await store.setPlayerGame('player-1', 'no-such-room');
      await manager.queuePlayer('player-1');
      expect(await manager.getPlayerGame('player-1')).toBeNull();
    });
  });

  describe('releasePlayer', () => {
    it('releases one binding and leaves the room alone', async () => {
      const id = await openRoom();
      await manager.releasePlayer('player-2');
      expect(await manager.getPlayerGame('player-2')).toBeNull();
      expect(await manager.getPlayerGame('player-1')).toBe(id);
      expect(await manager.getGame(id)).not.toBeNull();
    });
  });

  describe('cleanupStaleGames', () => {
    it('should remove games past timeout', async () => {
      const id = await openRoom();
      const r = await room(id);
      r.lastActivity = Date.now() - 31 * 60 * 1000;
      await store.setGame(id, r);
      expect(await manager.cleanupStaleGames()).toBe(1);
      expect(await manager.getGameCount()).toBe(0);
      expect(await manager.getPlayerGame('player-1')).toBeNull();
    });

    it('should not remove active games', async () => {
      await openRoom();
      expect(await manager.cleanupStaleGames()).toBe(0);
      expect(await manager.getGameCount()).toBe(1);
    });
  });

  describe('findIdleGames (present-but-idle abandonment detection)', () => {
    let gameId: string;

    beforeEach(async () => {
      gameId = await openRoom();
      // Both records on-chain: the game has started and the turn clock runs.
      await confirmBoth(gameId);
    });

    it('does NOT report a game whose turn just started', async () => {
      expect(await manager.findIdleGames()).toEqual([]);
    });

    it('does NOT report at 59s but DOES report at exactly 60s of no-move', async () => {
      await backdateLastMove(gameId, MOVE_INACTIVITY_MS - 1000); // 59s
      expect(await manager.findIdleGames()).toEqual([]);

      await backdateLastMove(gameId, MOVE_INACTIVITY_MS); // exactly 60s
      const idle = await manager.findIdleGames();
      expect(idle).toHaveLength(1);
      expect(idle[0].gameId).toBe(gameId);
    });

    it('reports the idle game past the threshold', async () => {
      await backdateLastMove(gameId, MOVE_INACTIVITY_MS + 5000); // 65s
      const idle = await manager.findIdleGames();
      expect(idle).toHaveLength(1);
      expect(idle[0].gameId).toBe(gameId);
      expect(idle[0].secondsIdle).toBeGreaterThanOrEqual(60);
      expect(idle[0].player1Id).toBe('player-1');
      expect(idle[0].player2Id).toBe('player-2');
    });

    it('idlePlayer is whoever owes the next move: player1 before any move', async () => {
      await backdateLastMove(gameId, MOVE_INACTIVITY_MS + 1000);
      const idle = await manager.findIdleGames();
      expect(idle[0].idlePlayer).toBe('player1');
    });

    it('idlePlayer follows the move count: after move 0, player2 is the idle one', async () => {
      await manager.recordMove(gameId, 'player-1', 0);
      await backdateLastMove(gameId, MOVE_INACTIVITY_MS + 1000);
      expect((await manager.findIdleGames())[0].idlePlayer).toBe('player2');

      await manager.recordMove(gameId, 'player-2', 1);
      await backdateLastMove(gameId, MOVE_INACTIVITY_MS + 1000);
      expect((await manager.findIdleGames())[0].idlePlayer).toBe('player1');
    });

    it("names no cards: recovering an abandoned game needs nobody's hand", async () => {
      await backdateLastMove(gameId, MOVE_INACTIVITY_MS + 1000);
      const [idle] = await manager.findIdleGames();
      expect(Object.keys(idle).sort()).toEqual(['gameId', 'idlePlayer', 'player1Id', 'player2Id', 'secondsIdle']);
    });

    it('clears once a move arrives (the idle clock resets)', async () => {
      await backdateLastMove(gameId, MOVE_INACTIVITY_MS + 1000);
      expect(await manager.findIdleGames()).toHaveLength(1);

      await manager.recordMove(gameId, 'player-1', 0);
      expect(await manager.findIdleGames()).toEqual([]);
    });

    it('does NOT report a room whose game is not on-chain yet: no turn has started', async () => {
      // Nobody can move before both commits are on-chain, since every move
      // carries a proof over both hand commitments.
      const waiting = await openRoom('player-3', 'player-4');
      await manager.updateTxStatus(waiting, 'player-3', 'confirmed');
      await backdateLastMove(waiting, MOVE_INACTIVITY_MS + 10_000);
      const idle = await manager.findIdleGames();
      expect(idle.some(g => g.gameId === waiting)).toBe(false);
    });

    it('reports a room whose moves have started even if no commit was reported', async () => {
      const unreported = await openRoom('player-3', 'player-4');
      await manager.recordMove(unreported, 'player-3', 0);
      await backdateLastMove(unreported, MOVE_INACTIVITY_MS + 1000);
      const idle = (await manager.findIdleGames()).find(g => g.gameId === unreported);
      expect(idle?.idlePlayer).toBe('player2');
    });

    it('does NOT report a room whose nine moves are all in', async () => {
      await play(gameId, 0, 9);
      await backdateLastMove(gameId, MOVE_INACTIVITY_MS + 10_000);
      expect(await manager.findIdleGames()).toEqual([]);
    });

    it('honors a custom threshold and a custom now', async () => {
      const base = (await room(gameId)).lastMoveTimestamp;
      // 30s threshold, evaluated 40s after the last move → idle.
      expect(await manager.findIdleGames(30_000, base + 40_000)).toHaveLength(1);
      // Same instant, 60s threshold → not yet idle.
      expect(await manager.findIdleGames(60_000, base + 40_000)).toEqual([]);
    });
  });
});
