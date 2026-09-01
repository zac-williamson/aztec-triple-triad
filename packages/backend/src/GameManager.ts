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

/**
 * How long BEFORE the inactivity deadline to start warning both players about
 * IMPENDING abandonment. The warning fires once the current player has been idle
 * for >= (MOVE_INACTIVITY_MS - ABANDONMENT_WARN_LEAD_MS) and carries a live
 * `secondsUntilClaimable` countdown to the deadline; at the deadline (countdown
 * 0) the game becomes claimable. This gives the idle player a visible runway to
 * move before forfeiting (docs/plan/ABANDONED_GAMES.md "impending abandonment").
 */
export const ABANDONMENT_WARN_LEAD_MS = 30 * 1000; // warn during the final 30s

/** A game whose player-whose-turn-it-is has not moved for >= the threshold. */
export interface IdleGame {
  gameId: string;
  /** The player whose turn it is — i.e. the one failing to move. */
  idlePlayer: Player;
  player1Id: string;
  player2Id: string;
  /** Whole seconds since the last move. */
  secondsIdle: number;
  /**
   * The idle (abandoning) player's committed hand card ids. The OTHER player
   * needs these to claim a card on-chain: they are otherwise exchanged only at
   * GAME_OVER (see useWebSocket GAME_OVER), which an abandonment never reaches,
   * so without them the claimant falls back to a no-card recovery.
   */
  idlePlayerCardIds: number[];
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

  /**
   * Release ONE player's binding to whatever game they are in.
   *
   * `releasePlayersFromGame` runs at GAME OVER and frees both sides, but a game
   * that is abandoned never reaches game over — so the binding survived until
   * the stale-game sweep got to it. A bot that walked away from an abandoned
   * game then had every queue attempt rejected with "You are already in an
   * active game": 578 of them across 22 minutes, during which the arena had no
   * opponent at all.
   *
   * The game itself is left alone. It still holds committed cards, and the
   * abandonment claim needs it.
   */
  async releasePlayer(playerId: string): Promise<void> {
    await this.store.deletePlayerGame(playerId);
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
        idlePlayerCardIds:
          room.state.currentTurn === 'player1' ? room.player1CardIds : room.player2CardIds,
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
  /**
   * Pair two waiting players and open a game for them.
   *
   * Selection is deliberate rather than "pop the first two", because with a pool
   * of arena bots watching the queue that would pair two BOTS: both wager five
   * real cards, play a full game, and one takes a card from the other. Pure
   * waste, and it consumes the slot the waiting human was supposed to get.
   *
   * The rules, in order:
   *   1. The CREATOR is the oldest human. A bot never creates — creating wagers
   *      five cards on a game nobody may join.
   *   2. The JOINER is the next player, preferring another human over a bot, so
   *      two waiting humans always play each other rather than each taking a bot.
   *   3. If the queue holds ONLY bots, nobody is matched. A bot exists to give a
   *      human an opponent; two of them playing each other serves no one.
   */
  async tryMatch(
    livePlayerIds: Set<string>,
    isBot: (playerId: string) => boolean = () => false,
  ): Promise<{ entry1: QueueEntryData; entry2: QueueEntryData; room: StoredGameRoom } | null> {
    // Strip any stale entries before matching
    await this.store.removeDisconnectedQueueEntries(livePlayerIds);

    const queue = (await this.store.listQueue()).filter(e => livePlayerIds.has(e.playerId));
    if (queue.length < 2) return null;

    const creator = queue.find(e => !isBot(e.playerId));
    // Rule 3: an all-bot queue matches nobody.
    if (!creator) return null;

    const rest = queue.filter(e => e.playerId !== creator.playerId);
    const joiner = rest.find(e => !isBot(e.playerId)) ?? rest[0];
    if (!joiner) return null;

    // Claim both before creating anything: leaving them queued through an await
    // lets a concurrent tryMatch select the same player twice.
    const claimed = await Promise.all([
      this.store.removeFromQueue(creator.playerId),
      this.store.removeFromQueue(joiner.playerId),
    ]);
    if (!claimed[0] || !claimed[1]) {
      // Someone else took one of them. Put back whichever we actually claimed
      // rather than silently dropping a waiting player from the queue.
      if (claimed[0]) await this.store.pushQueue(creator);
      if (claimed[1]) await this.store.pushQueue(joiner);
      return null;
    }

    const room = await this.createGame(creator.playerId, creator.cardIds);
    await this.joinGame(room.id, joiner.playerId, joiner.cardIds);

    const updatedRoom = await this.store.getGame(room.id);
    // entry1/entry2 are reported as CREATOR/JOINER, which is what the caller
    // uses to assign player numbers.
    return { entry1: creator, entry2: joiner, room: updatedRoom! };
  }

  async updatePing(playerId: string): Promise<boolean> {
    return this.store.updateQueuePing(playerId);
  }

  /**
   * Read-only queue view for /queue and the arena bot.
   *
   * `oldestWaitMs` counts HUMANS only. It is the signal a bot joins on — "how
   * long has the person I would be rescuing been waiting" — and a bot already
   * sitting in the queue must never be what triggers another bot.
   *
   * `humansWaiting` / `botsQueued` exist so a POOL does not stampede: every bot
   * polls the same endpoint and would otherwise all queue for the same lone
   * player. Publishing which entries are bots costs nothing here — the bot is
   * not disclosed: the bot is a fallback opponent, not a labelled one.
   */
  async queueSnapshot(now = Date.now(), isBot: (playerId: string) => boolean = () => false): Promise<{
    length: number;
    oldestWaitMs: number;
    humansWaiting: number;
    botsQueued: number;
    entries: { playerId: string; queuedAt: number; waitMs: number; isBot: boolean }[];
  }> {
    const entries = await this.store.listQueue();
    const mapped = entries.map(e => ({
      playerId: e.playerId,
      queuedAt: e.queuedAt,
      waitMs: Math.max(0, now - e.queuedAt),
      isBot: isBot(e.playerId),
    }));
    const humans = mapped.filter(e => !e.isBot);
    return {
      length: mapped.length,
      oldestWaitMs: humans.reduce((max, e) => (e.waitMs > max ? e.waitMs : max), 0),
      humansWaiting: humans.length,
      botsQueued: mapped.length - humans.length,
      entries: mapped,
    };
  }

  async cleanupStaleQueue(): Promise<number> {
    return this.store.cleanupStaleQueue(QUEUE_STALE_MS);
  }

  async getQueueLength(): Promise<number> {
    return this.store.getQueueLength();
  }

  async getGameCount(): Promise<number> {
    return this.store.getGameCount();
  }
}
