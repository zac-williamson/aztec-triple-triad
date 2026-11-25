import type { GameStore, StoredGameRoom, QueueEntryData } from './store/GameStore.js';
import type { OnChainGameStatus, PlayerNumber, RoomInfo, RoomStatus, TxStatus } from './types.js';
import { generateGameId } from './gameId.js';

const GAME_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const QUEUE_STALE_MS = 30 * 1000; // 30 seconds without ping
const LOCK_TTL_MS = 5000; // 5-second deadlock guard
const LOCK_RETRY_MS = 5; // how often a busy room's lock is retried

/** A game is nine moves, one per board cell: move numbers 0..8. */
export const MOVES_PER_GAME = 9;

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
  idlePlayer: 'player1' | 'player2';
  player1Id: string;
  player2Id: string;
  /** Whole seconds since the turn began. */
  secondsIdle: number;
}

/** A MOVE the relay accepted, and where it goes. */
export interface RecordedMove {
  room: StoredGameRoom;
  /** The player the move is forwarded to. */
  opponentId: string;
  /** This was the ninth move: the room's moves are now complete. */
  movesComplete: boolean;
}

/** Whose move `moveNumber` is: player 1 moves at even numbers, player 2 at odd. */
export function moverOf(moveNumber: number): PlayerNumber {
  return moveNumber % 2 === 0 ? 1 : 2;
}

/** `playerId`'s seat in `room`, or null if they are not in it. */
export function playerNumberIn(room: StoredGameRoom, playerId: string): PlayerNumber | null {
  if (room.player1Id === playerId) return 1;
  if (room.player2Id === playerId) return 2;
  return null;
}

/** The other member of `room`, or null if `playerId` is not in it. */
export function opponentOf(room: StoredGameRoom, playerId: string): string | null {
  if (room.player1Id === playerId) return room.player2Id;
  if (room.player2Id === playerId) return room.player1Id;
  return null;
}

const bothCommitsConfirmed = (status: OnChainGameStatus): boolean =>
  status.player1Tx === 'confirmed' && status.player2Tx === 'confirmed';

/** Settling needs both records on-chain and the whole transcript. */
const canSettle = (room: StoredGameRoom): boolean =>
  bothCommitsConfirmed(room.onChainStatus) && room.movesMade >= MOVES_PER_GAME;

/**
 * Where a room stands, from what a pipe can see: the move count and the
 * players' own reports of their commits.
 *
 * A room is not `active` the moment it opens. Every MOVE carries a proof over
 * both players' hand commitments, so nobody can move until both commits are
 * on-chain — which takes minutes of proving and mining. Running the turn clock
 * from the match would flag player 1 idle through every game's setup.
 */
export function roomStatus(room: StoredGameRoom): RoomStatus {
  if (room.movesMade >= MOVES_PER_GAME) return 'moves-complete';
  if (room.movesMade > 0 || bothCommitsConfirmed(room.onChainStatus)) return 'active';
  return 'waiting';
}

/**
 * Rooms, matchmaking and turn order — and nothing about the game itself.
 *
 * The relay used to run the rules engine, which meant it held both hands and
 * watched every move. Now each client runs the game and checks its opponent's
 * proofs (docs/plan/PRIVATE_GAMES.md §6); this class only knows who is in which
 * room and how many sealed moves have passed through it, which is all the relay
 * needs to keep turns in order and to time them.
 */
export class GameManager {
  constructor(private store: GameStore) {}

  /**
   * Run `fn` holding the room's lock, waiting for it if another write holds it.
   *
   * Every read-modify-write of a room goes through here. The store hands out
   * copies (Redis) and Node interleaves handlers at every await, so a MOVE and a
   * late TX_CONFIRMED for the same room could otherwise each read the room,
   * then each write back their own copy, and one change is lost. Losing a move
   * count wedges the game: the relay would then refuse the next move as out of
   * order, forever.
   */
  private async withRoomLock<T>(gameId: string, fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + LOCK_TTL_MS;
    while (!(await this.store.acquireGameLock(gameId, LOCK_TTL_MS))) {
      if (Date.now() >= deadline) throw new Error('Game is busy, try again');
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
    try {
      return await fn();
    } finally {
      await this.store.releaseGameLock(gameId);
    }
  }

  /**
   * Returns the player's active game if it exists.
   * If the player→game mapping points to a nonexistent game, the stale
   * mapping is cleaned up and null is returned. This prevents "phantom"
   * game state from blocking new games after a crash/restart.
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

  /** Open a room for a matched pair and bind both players to it. */
  private async openRoom(player1Id: string, player2Id: string): Promise<StoredGameRoom> {
    const now = Date.now();
    const room: StoredGameRoom = {
      id: generateGameId(),
      player1Id,
      player2Id,
      createdAt: now,
      lastActivity: now,
      lastMoveTimestamp: now,
      movesMade: 0,
      onChainStatus: { player1Tx: 'idle', player2Tx: 'idle', canSettle: false },
    };
    await this.store.setGame(room.id, room);
    await this.store.setPlayerGame(player1Id, room.id);
    await this.store.setPlayerGame(player2Id, room.id);
    return room;
  }

  /**
   * Accept MOVE `moveNumber` from `playerId`, or throw saying why not.
   *
   * The relay checks exactly what it can see: the sender is in the room, the
   * moves are not already complete, the number is the next one (strictly in
   * order, 0..8), and it is the sender's turn (player 1 at even numbers, player
   * 2 at odd). Whether the move itself is legal is the opponent's to check,
   * against its proof. The ninth move completes the room's moves and releases
   * both players' bindings, as the end of a game always has, so either can
   * queue again at once.
   *
   * `sealed` is the MOVE's body as forwarded (iv, ciphertext — unread): kept
   * in the room's log, so a player whose copy was lost in flight is replayed
   * it on RESUME (StoredGameRoom.moves).
   */
  async recordMove(
    gameId: string, playerId: string, moveNumber: number,
    sealed?: { iv: string; ciphertext: string },
  ): Promise<RecordedMove> {
    const recorded = await this.withRoomLock(gameId, async () => {
      const room = await this.store.getGame(gameId);
      if (!room) throw new Error('Game not found');
      const player = playerNumberIn(room, playerId);
      if (player === null) throw new Error('Not in this game');
      if (room.movesMade >= MOVES_PER_GAME) throw new Error('All nine moves are already in');
      if (moveNumber !== room.movesMade) {
        throw new Error(`Invalid move number: expected ${room.movesMade}, got ${moveNumber}`);
      }
      if (moverOf(moveNumber) !== player) throw new Error('Not your turn');

      const now = Date.now();
      room.movesMade += 1;
      if (sealed) room.moves = [...(room.moves ?? []), { moveNumber, iv: sealed.iv, ciphertext: sealed.ciphertext }];
      // The next turn starts now; this is what abandonment detection watches.
      room.lastMoveTimestamp = now;
      room.lastActivity = now;
      room.onChainStatus.canSettle = canSettle(room);
      await this.store.setGame(gameId, room);
      return {
        room,
        opponentId: player === 1 ? room.player2Id : room.player1Id,
        movesComplete: room.movesMade === MOVES_PER_GAME,
      };
    });
    if (recorded.movesComplete) await this.releasePlayersFromGame(gameId);
    return recorded;
  }

  async getGame(gameId: string): Promise<StoredGameRoom | null> {
    return this.store.getGame(gameId);
  }

  async getPlayerGame(playerId: string): Promise<string | null> {
    return this.store.getPlayerGame(playerId);
  }

  /** What the relay will tell anyone about a room: nothing a pipe cannot see. */
  async roomInfo(gameId: string, isConnected: (playerId: string) => boolean): Promise<RoomInfo | null> {
    const room = await this.store.getGame(gameId);
    if (!room) return null;
    return {
      id: room.id,
      status: roomStatus(room),
      movesMade: room.movesMade,
      player1Connected: isConnected(room.player1Id),
      player2Connected: isConnected(room.player2Id),
    };
  }

  /**
   * Release ONE player's binding to whatever game they are in.
   *
   * A game that is abandoned never completes its moves, so its bindings survive
   * until the stale-game sweep gets to them. A bot that walked away from an
   * abandoned game then had every queue attempt rejected with "You are already
   * in an active game": 578 of them across 22 minutes, during which the arena
   * had no opponent at all.
   *
   * The room itself is left alone: the other player may still be talking
   * through it.
   */
  async releasePlayer(playerId: string): Promise<void> {
    await this.store.deletePlayerGame(playerId);
  }

  /**
   * Release both players' bindings to `gameId` — each only if it still points
   * there: one who left this room may already be matched into another.
   */
  async releasePlayersFromGame(gameId: string): Promise<void> {
    const room = await this.store.getGame(gameId);
    if (!room) return;
    for (const playerId of [room.player1Id, room.player2Id]) {
      if ((await this.store.getPlayerGame(playerId)) === gameId) {
        await this.store.deletePlayerGame(playerId);
      }
    }
  }

  async cleanupStaleGames(): Promise<number> {
    return this.store.cleanupStaleGames(GAME_TIMEOUT_MS);
  }

  /**
   * Return every game being played whose current player has not moved for at
   * least `thresholdMs` (default 60s). Used by the abandonment detector to warn
   * both players. Only `active` rooms qualify: a room still going on-chain has
   * no turn running yet, and one whose moves are complete has none left.
   * `idlePlayer` is whoever owes move number `movesMade`.
   */
  async findIdleGames(
    thresholdMs: number = MOVE_INACTIVITY_MS,
    now: number = Date.now(),
  ): Promise<IdleGame[]> {
    const rooms = await this.store.listGames();
    const idle: IdleGame[] = [];
    for (const room of rooms) {
      if (roomStatus(room) !== 'active') continue;
      const idleMs = now - room.lastMoveTimestamp;
      if (idleMs < thresholdMs) continue;
      idle.push({
        gameId: room.id,
        idlePlayer: moverOf(room.movesMade) === 1 ? 'player1' : 'player2',
        player1Id: room.player1Id,
        player2Id: room.player2Id,
        secondsIdle: Math.floor(idleMs / 1000),
      });
    }
    return idle;
  }

  /**
   * Record a player's own report of their commit transaction.
   *
   * The second confirmation puts the game on-chain, and only then can anyone
   * move; if nobody has, that is when the first turn starts.
   */
  async updateTxStatus(
    gameId: string,
    playerId: string,
    txStatus: TxStatus,
  ): Promise<OnChainGameStatus | null> {
    return this.withRoomLock(gameId, async () => {
      const room = await this.store.getGame(gameId);
      if (!room) return null;
      const player = playerNumberIn(room, playerId);
      if (player === null) return null;

      const wasOnChain = bothCommitsConfirmed(room.onChainStatus);
      if (player === 1) room.onChainStatus.player1Tx = txStatus;
      else room.onChainStatus.player2Tx = txStatus;

      const now = Date.now();
      if (!wasOnChain && bothCommitsConfirmed(room.onChainStatus) && room.movesMade === 0) {
        room.lastMoveTimestamp = now;
      }
      room.onChainStatus.canSettle = canSettle(room);
      room.lastActivity = now;
      await this.store.setGame(gameId, room);
      return room.onChainStatus;
    });
  }

  async getOnChainStatus(gameId: string): Promise<OnChainGameStatus | null> {
    const room = await this.store.getGame(gameId);
    return room?.onChainStatus ?? null;
  }

  // --- Matchmaking Queue ---

  /** Queue a player. Nothing about their hand is asked for or kept. */
  async queuePlayer(playerId: string): Promise<number> {
    if (await this.getValidPlayerGame(playerId)) {
      throw new Error('You are already in an active game');
    }
    if (await this.store.isInQueue(playerId)) {
      throw new Error('You are already in the matchmaking queue');
    }

    const now = Date.now();
    await this.store.pushQueue({ playerId, queuedAt: now, lastPing: now });
    return await this.store.getQueueLength();
  }

  async dequeuePlayer(playerId: string): Promise<boolean> {
    return this.store.removeFromQueue(playerId);
  }

  /**
   * Pair two waiting players and open a room for them.
   *
   * `livePlayerIds` is the set of currently-connected playerIds. Stale
   * entries (queued by players who have since disconnected or whose
   * sessions were lost across a server restart) are removed before
   * pairing. This prevents the bug where a live player is paired with a
   * ghost entry, orphaning the game and leaving the other live player
   * stuck in the queue.
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

    const room = await this.openRoom(creator.playerId, joiner.playerId);
    // entry1/entry2 are reported as CREATOR/JOINER, which is what the caller
    // uses to assign player numbers.
    return { entry1: creator, entry2: joiner, room };
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
