import crypto from 'crypto';
import {
  createGame,
  placeCard,
  getCardsByIds,
  type GameState,
  type Card,
  type PlaceCardResult,
  type Player,
} from '@aztec-triple-triad/game-logic';
import type { GameRoom, GameListEntry, OnChainGameStatus, TxStatus } from './types.js';

/**
 * Generate a game ID that is a valid BN254 field element.
 * Uses 31 random bytes (248 bits of entropy) which is always < BN254 modulus (~254 bits).
 * Returns a 0x-prefixed hex string.
 */
export function generateGameId(): string {
  return '0x' + crypto.randomBytes(31).toString('hex');
}

const GAME_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class GameManager {
  private games = new Map<string, GameRoom>();
  private playerToGame = new Map<string, string>();

  private validateCardIds(cardIds: number[]): void {
    if (cardIds.length !== 5) {
      throw new Error('Must provide exactly 5 card IDs');
    }
    const uniqueIds = new Set(cardIds);
    if (uniqueIds.size !== cardIds.length) {
      throw new Error('Duplicate card IDs not allowed');
    }
    // Validate card IDs exist in database
    getCardsByIds(cardIds);
  }

  createGame(playerId: string, cardIds: number[]): GameRoom {
    this.validateCardIds(cardIds);

    // Fix 4.2: Prevent game overwrite - reject if player already in active game
    if (this.playerToGame.has(playerId)) {
      throw new Error('You are already in an active game. Leave it first.');
    }

    const gameId = generateGameId();
    const room: GameRoom = {
      id: gameId,
      state: null as unknown as GameState, // Will be initialized when player 2 joins
      player1Id: playerId,
      player2Id: null,
      player1CardIds: cardIds,
      player2CardIds: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      expectedMoveNumber: 0,
      processing: false,
      onChainStatus: { player1Tx: 'pending', player2Tx: 'pending', canSettle: false },
    };

    this.games.set(gameId, room);
    this.playerToGame.set(playerId, gameId);
    return room;
  }

  joinGame(gameId: string, playerId: string, cardIds: number[]): GameRoom {
    const room = this.games.get(gameId);
    if (!room) {
      throw new Error('Game not found');
    }
    if (room.player2Id !== null) {
      throw new Error('Game is full');
    }
    if (room.player1Id === playerId) {
      throw new Error('Cannot join your own game');
    }

    // Fix 4.2: Prevent game overwrite - reject if player already in active game
    if (this.playerToGame.has(playerId)) {
      throw new Error('You are already in an active game. Leave it first.');
    }

    this.validateCardIds(cardIds);

    room.player2Id = playerId;
    room.player2CardIds = cardIds;

    // Initialize game state
    const player1Hand = getCardsByIds(room.player1CardIds);
    const player2Hand = getCardsByIds(cardIds);
    room.state = createGame(player1Hand, player2Hand);
    room.lastActivity = Date.now();

    this.playerToGame.set(playerId, gameId);
    return room;
  }

  placeCard(
    gameId: string,
    playerId: string,
    handIndex: number,
    row: number,
    col: number,
    moveNumber?: number,
  ): PlaceCardResult {
    const room = this.games.get(gameId);
    if (!room) {
      throw new Error('Game not found');
    }
    if (!room.state) {
      throw new Error('Game has not started');
    }

    // Fix 4.2: Atomic turn checking - reject concurrent processing
    if (room.processing) {
      throw new Error('Game is currently processing another move');
    }

    const player = this.getPlayerRole(gameId, playerId);
    if (!player) {
      throw new Error('Player not in this game');
    }
    if (room.state.currentTurn !== player) {
      throw new Error('Not your turn');
    }

    // Fix 4.1: Move nonce validation for replay prevention
    if (moveNumber !== undefined) {
      if (moveNumber !== room.expectedMoveNumber) {
        throw new Error(`Invalid move number: expected ${room.expectedMoveNumber}, got ${moveNumber}`);
      }
    }

    room.processing = true;
    try {
      const result = placeCard(room.state, player, handIndex, row, col);
      room.state = result.newState;
      room.lastActivity = Date.now();
      room.expectedMoveNumber++;
      return result;
    } finally {
      room.processing = false;
    }
  }

  getGame(gameId: string): GameRoom | undefined {
    return this.games.get(gameId);
  }

  getPlayerRole(gameId: string, playerId: string): Player | null {
    const room = this.games.get(gameId);
    if (!room) return null;
    if (room.player1Id === playerId) return 'player1';
    if (room.player2Id === playerId) return 'player2';
    return null;
  }

  getPlayerGame(playerId: string): string | undefined {
    return this.playerToGame.get(playerId);
  }

  listGames(): GameListEntry[] {
    const entries: GameListEntry[] = [];
    for (const [id, room] of this.games) {
      entries.push({
        id,
        status: room.state?.status ?? 'waiting',
        player1Connected: true, // Connection tracking is done by the server
        player2Connected: room.player2Id !== null,
        currentTurn: room.state?.currentTurn,
        winner: room.state?.winner,
      });
    }
    return entries;
  }

  removePlayer(playerId: string): { gameId: string; room: GameRoom } | null {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return null;

    const room = this.games.get(gameId);
    if (!room) {
      this.playerToGame.delete(playerId);
      return null;
    }

    this.playerToGame.delete(playerId);

    // If game hasn't started and the creator leaves, remove the game
    if (room.player2Id === null) {
      this.games.delete(gameId);
      return null;
    }

    return { gameId, room };
  }

  removeGame(gameId: string): void {
    const room = this.games.get(gameId);
    if (room) {
      this.playerToGame.delete(room.player1Id);
      if (room.player2Id) {
        this.playerToGame.delete(room.player2Id);
      }
      this.games.delete(gameId);
    }
  }

  cleanupStaleGames(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, room] of this.games) {
      if (now - room.lastActivity > GAME_TIMEOUT_MS) {
        this.removeGame(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * Update the on-chain transaction status for a player in a game.
   * Returns the updated OnChainGameStatus, or null if the game is not found.
   */
  updateTxStatus(
    gameId: string,
    playerId: string,
    txStatus: TxStatus,
  ): OnChainGameStatus | null {
    const room = this.games.get(gameId);
    if (!room) return null;

    if (room.player1Id === playerId) {
      room.onChainStatus.player1Tx = txStatus;
    } else if (room.player2Id === playerId) {
      room.onChainStatus.player2Tx = txStatus;
    } else {
      return null; // Player not in this game
    }

    room.onChainStatus.canSettle =
      room.onChainStatus.player1Tx === 'confirmed' &&
      room.onChainStatus.player2Tx === 'confirmed';

    room.lastActivity = Date.now();
    return room.onChainStatus;
  }

  /**
   * Cancel a game that hasn't started yet. Only the creator can cancel.
   * Returns true if cancelled, throws if invalid.
   */
  cancelGame(gameId: string, playerId: string): void {
    const room = this.games.get(gameId);
    if (!room) throw new Error('Game not found');
    if (room.player1Id !== playerId) throw new Error('Only the game creator can cancel');
    if (room.player2Id !== null) throw new Error('Cannot cancel a game that has started');

    this.removeGame(gameId);
  }

  /**
   * Get the on-chain status for a game.
   */
  getOnChainStatus(gameId: string): OnChainGameStatus | null {
    const room = this.games.get(gameId);
    return room?.onChainStatus ?? null;
  }

  get gameCount(): number {
    return this.games.size;
  }
}
