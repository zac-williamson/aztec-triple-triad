import {
  createGame,
  placeCard,
  getCardsByIds,
  type GameState,
  type Card,
  type PlaceCardResult,
  type Player,
} from '@axolotl-arena/game-logic';
import type { GameStore, StoredGameRoom, QueueEntryData } from './store/GameStore.js';
import type { GameListEntry, OnChainGameStatus, TxStatus } from './types.js';
import { generateGameId } from './gameId.js';

const GAME_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const QUEUE_STALE_MS = 30 * 1000; // 30 seconds without ping
const LOCK_TTL_MS = 5000; // 5-second deadlock guard

/**
 * No-move inactivity threshold after which an in-progress game is reported as
 * idle (present-but-idle abandonment). Matches the contract's ~60s/5-block
 * dispute window and the 60s disconnect window.
 */
export const MOVE_INACTIVITY_MS = 60 * 1000; // 60 seconds

/** A game whose player-whose-turn-it-is has not moved for >= the threshold. */
export interface IdleGame {
  gameId: string;
  /** The player whose turn it is — i.e. the one failing to move. */
  idlePlayer: Player;
  player1Id: string;
  player2Id: string;
  /** Whole seconds since the last move. */
  secondsIdle: number;
}

export class GameManager {
  constructor(private store: GameStore) {}

  private validateCardIds(cardIds: number[]): void {
    if (cardIds.length !== 5) {
      throw new Error('Must provide exactly 5 card IDs');
    }
    const uniqueIds = new Set(cardIds);
    if (uniqueIds.size !== cardIds.length) {
      throw new Error('Duplicate card IDs not allowed');
    }
    getCardsByIds(cardIds);
  }

  /**
   * Returns the player's active game if it exists.
   * If the player→game mapping points to a nonexistent game, the stale
   * mapping is cleaned up and null is returned. This prevents "phantom"
   * game state from blocking new game creation after a crash/restart.
   */
  async getValidPlayerGame(playerId: string): Promise<StoredGameRoom | null> {
    const gameId = await this.store.getPlayerGame(playerId);
    if (!gameId) return null;
    const game = await this.store.getGame(gameId);
    if (!game) {
      // Stale mapping — clean it up
      await this.store.deletePlayerGame(playerId);
      return null;
    }
    return game;
  }

  async createGame(playerId: string, cardIds: number[]): Promise<StoredGameRoom> {
    this.validateCardIds(cardIds);

    if (await this.getValidPlayerGame(playerId)) {
      throw new Error('You are already in an active game. Leave it first.');
    }

    const gameId = generateGameId();
    const room: StoredGameRoom = {
      id: gameId,
      state: null as unknown as GameState,
      player1Id: playerId,
      player2Id: null,
      player1CardIds: cardIds,
      player2CardIds: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      lastMoveTimestamp: Date.now(),
      expectedMoveNumber: 0,
      onChainStatus: { player1Tx: 'idle', player2Tx: 'idle', canSettle: false },
    };

    await this.store.setGame(gameId, room);
    await this.store.setPlayerGame(playerId, gameId);
    return room;
  }

  async joinGame(gameId: string, playerId: string, cardIds: number[]): Promise<StoredGameRoom> {
    const room = await this.store.getGame(gameId);
    if (!room) {
      throw new Error('Game not found');
    }
    if (room.player2Id !== null) {
      throw new Error('Game is full');
    }
    if (room.player1Id === playerId) {
      throw new Error('Cannot join your own game');
    }
    if (await this.getValidPlayerGame(playerId)) {
      throw new Error('You are already in an active game. Leave it first.');
    }

    this.validateCardIds(cardIds);

    room.player2Id = playerId;
    room.player2CardIds = cardIds;

    const player1Hand = getCardsByIds(room.player1CardIds);
    const player2Hand = getCardsByIds(cardIds);
    room.state = createGame(player1Hand, player2Hand);
    room.lastActivity = Date.now();
    // The game is now 'playing': start the first move's inactivity clock.
    room.lastMoveTimestamp = Date.now();

    await this.store.setGame(gameId, room);
    await this.store.setPlayerGame(playerId, gameId);
    return room;
  }

  async placeCard(
    gameId: string,
    playerId: string,
    handIndex: number,
    row: number,
    col: number,
    moveNumber?: number,
  ): Promise<PlaceCardResult> {
    const acquired = await this.store.acquireGameLock(gameId, LOCK_TTL_MS);
    if (!acquired) {
      throw new Error('Game is currently processing another move');
    }

    try {
      const room = await this.store.getGame(gameId);
      if (!room) {
        throw new Error('Game not found');
      }
      if (!room.state) {
        throw new Error('Game has not started');
      }

      const player = await this.getPlayerRole(gameId, playerId);
      if (!player) {
        throw new Error('Player not in this game');
      }
      if (room.state.currentTurn !== player) {
        throw new Error('Not your turn');
      }

      if (moveNumber !== undefined) {
        if (moveNumber !== room.expectedMoveNumber) {
          throw new Error(`Invalid move number: expected ${room.expectedMoveNumber}, got ${moveNumber}`);
        }
      }

      const result = placeCard(room.state, player, handIndex, row, col);
      room.state = result.newState;
      room.lastActivity = Date.now();
      // Reset the per-move inactivity clock; this is what abandonment
      // detection watches (separate from lastActivity, which other messages
      // also refresh).
      room.lastMoveTimestamp = Date.now();
      room.expectedMoveNumber++;

      await this.store.setGame(gameId, room);
      return result;
    } finally {
      await this.store.releaseGameLock(gameId);
    }
  }

  async getGame(gameId: string): Promise<StoredGameRoom | null> {
    return this.store.getGame(gameId);
  }

  async getPlayerRole(gameId: string, playerId: string): Promise<Player | null> {
    const room = await this.store.getGame(gameId);
    if (!room) return null;
    if (room.player1Id === playerId) return 'player1';
    if (room.player2Id === playerId) return 'player2';
    return null;
  }

  async getPlayerGame(playerId: string): Promise<string | null> {
    return this.store.getPlayerGame(playerId);
  }

  async listGames(): Promise<GameListEntry[]> {
    const rooms = await this.store.listGames();
    return rooms.map(room => ({
      id: room.id,
      status: (room.state?.status ?? 'waiting') as 'waiting' | 'playing' | 'finished',
      player1Connected: true,
      player2Connected: room.player2Id !== null,
      currentTurn: room.state?.currentTurn,
      winner: room.state?.winner,
    }));
  }

  async removePlayer(playerId: string): Promise<{ gameId: string; room: StoredGameRoom } | null> {
    const gameId = await this.store.getPlayerGame(playerId);
    if (!gameId) return null;

    const room = await this.store.getGame(gameId);
    if (!room) {
      await this.store.deletePlayerGame(playerId);
      return null;
    }

    await this.store.deletePlayerGame(playerId);

    // If game hasn't started and the creator leaves, remove the game
    if (room.player2Id === null) {
      await this.store.deleteGame(gameId);
      return null;
    }

    return { gameId, room };
  }

  async releasePlayersFromGame(gameId: string): Promise<void> {
    const room = await this.store.getGame(gameId);
    if (room) {
      await this.store.deletePlayerGame(room.player1Id);
      if (room.player2Id) {
        await this.store.deletePlayerGame(room.player2Id);
      }
    }
  }

  async removeGame(gameId: string): Promise<void> {
    const room = await this.store.getGame(gameId);
    if (room) {
      await this.store.deletePlayerGame(room.player1Id);
      if (room.player2Id) {
        await this.store.deletePlayerGame(room.player2Id);
      }
      await this.store.deleteGame(gameId);
    }
  }

  /**
   * Mark a started game finished because `playerId` settled it on-chain as
   * abandoned, then release both players' game bindings so they can start
   * new games immediately (QA-F3). Trusts the reporting client like
   * TX_CONFIRMED does — the backend is Aztec-free, so the chain remains the
   * source of truth for cards and rewards. Idempotent: re-reports return the
   * stored outcome unchanged (the first reporter stays the winner) and
   * re-release the bindings.
   */
  async settleAbandonedGame(gameId: string, playerId: string): Promise<StoredGameRoom> {
    const acquired = await this.store.acquireGameLock(gameId, LOCK_TTL_MS);
    if (!acquired) {
      throw new Error('Game is currently processing another move');
    }

    try {
      const room = await this.store.getGame(gameId);
      if (!room) {
        throw new Error('Game not found');
      }
      const player: Player | null =
        room.player1Id === playerId ? 'player1' : room.player2Id === playerId ? 'player2' : null;
      if (!player) {
        throw new Error('Player not in this game');
      }
      if (!room.state) {
        throw new Error('Game has not started');
      }

      if (room.state.status !== 'finished') {
        room.state = { ...room.state, status: 'finished', winner: player };
        room.lastActivity = Date.now();
        await this.store.setGame(gameId, room);
      }

      await this.releasePlayersFromGame(gameId);
      return room;
    } finally {
      await this.store.releaseGameLock(gameId);
    }
  }

  async cleanupStaleGames(): Promise<number> {
    return this.store.cleanupStaleGames(GAME_TIMEOUT_MS);
  }

  /**
   * Return every in-progress game whose current player has not moved for at
   * least `thresholdMs` (default 60s). Used by the abandonment detector to
   * warn both players. Only games that are actually `'playing'` and have two
   * players bound qualify — waiting, finished, and not-yet-joined games never
   * appear. `idlePlayer` is `state.currentTurn`: the player who owes a move.
   */
  async findIdleGames(
    thresholdMs: number = MOVE_INACTIVITY_MS,
    now: number = Date.now(),
  ): Promise<IdleGame[]> {
    const rooms = await this.store.listGames();
    const idle: IdleGame[] = [];
    for (const room of rooms) {
      if (!room.state || room.state.status !== 'playing') continue;
      if (room.player2Id === null) continue;
      const idleMs = now - room.lastMoveTimestamp;
      if (idleMs < thresholdMs) continue;
      idle.push({
        gameId: room.id,
        idlePlayer: room.state.currentTurn,
        player1Id: room.player1Id,
        player2Id: room.player2Id,
        secondsIdle: Math.floor(idleMs / 1000),
      });
    }
    return idle;
  }

  async updateTxStatus(
    gameId: string,
    playerId: string,
    txStatus: TxStatus,
  ): Promise<OnChainGameStatus | null> {
    const room = await this.store.getGame(gameId);
    if (!room) return null;

    if (room.player1Id === playerId) {
      room.onChainStatus.player1Tx = txStatus;
    } else if (room.player2Id === playerId) {
      room.onChainStatus.player2Tx = txStatus;
    } else {
      return null;
    }

    room.onChainStatus.canSettle =
      room.onChainStatus.player1Tx === 'confirmed' &&
      room.onChainStatus.player2Tx === 'confirmed';

    room.lastActivity = Date.now();
    await this.store.setGame(gameId, room);
    return room.onChainStatus;
  }

  async cancelGame(gameId: string, playerId: string): Promise<void> {
    const room = await this.store.getGame(gameId);
    if (!room) throw new Error('Game not found');
    if (room.player1Id !== playerId) throw new Error('Only the game creator can cancel');
    if (room.player2Id !== null) throw new Error('Cannot cancel a game that has started');

    await this.removeGame(gameId);
  }

  async getOnChainStatus(gameId: string): Promise<OnChainGameStatus | null> {
    const room = await this.store.getGame(gameId);
    return room?.onChainStatus ?? null;
  }

  // --- Matchmaking Queue ---

  async queuePlayer(playerId: string, cardIds: number[]): Promise<number> {
    this.validateCardIds(cardIds);

    if (await this.getValidPlayerGame(playerId)) {
      throw new Error('You are already in an active game');
    }
    if (await this.store.isInQueue(playerId)) {
      throw new Error('You are already in the matchmaking queue');
    }

    const now = Date.now();
    await this.store.pushQueue({ playerId, cardIds, queuedAt: now, lastPing: now });
    return await this.store.getQueueLength();
  }

  async dequeuePlayer(playerId: string): Promise<boolean> {
    return this.store.removeFromQueue(playerId);
  }

  /**
   * Attempt to form a match from the queue.
   *
   * `livePlayerIds` is the set of currently-connected playerIds. Stale
   * entries (queued by players who have since disconnected or whose
   * sessions were lost across a server restart) are removed before
   * popping the pair. This prevents the bug where a live player is
   * paired with a ghost entry, orphaning the game and leaving the other
   * live player stuck in the queue.
   */
  async tryMatch(livePlayerIds: Set<string>): Promise<{ entry1: QueueEntryData; entry2: QueueEntryData; room: StoredGameRoom } | null> {
    // Strip any stale entries before matching
    await this.store.removeDisconnectedQueueEntries(livePlayerIds);

    const pair = await this.store.popQueuePair();
    if (!pair) return null;

    const [entry1, entry2] = pair;

    // Defensive: verify both entries are still live (race with cleanup).
    // If either is not, re-queue the live one(s) at the back of the queue
    // so they can match with the next player who joins.
    if (!livePlayerIds.has(entry1.playerId) || !livePlayerIds.has(entry2.playerId)) {
      if (livePlayerIds.has(entry1.playerId)) {
        await this.store.pushQueue(entry1);
      }
      if (livePlayerIds.has(entry2.playerId)) {
        await this.store.pushQueue(entry2);
      }
      return null;
    }

    const room = await this.createGame(entry1.playerId, entry1.cardIds);
    await this.joinGame(room.id, entry2.playerId, entry2.cardIds);

    const updatedRoom = await this.store.getGame(room.id);
    return { entry1, entry2, room: updatedRoom! };
  }

  async updatePing(playerId: string): Promise<boolean> {
    return this.store.updateQueuePing(playerId);
  }

  async cleanupStaleQueue(): Promise<number> {
    return this.store.cleanupStaleQueue(QUEUE_STALE_MS);
  }

  async getGameCount(): Promise<number> {
    return this.store.getGameCount();
  }
}
