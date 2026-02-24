import { v4 as uuidv4 } from 'uuid';
import {
  createGame,
  placeCard,
  getCardsByIds,
  type GameState,
  type Card,
  type PlaceCardResult,
  type Player,
} from '@aztec-triple-triad/game-logic';
import type { GameRoom, GameListEntry } from './types.js';

const GAME_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class GameManager {
  private games = new Map<string, GameRoom>();
  private playerToGame = new Map<string, string>();

  createGame(playerId: string, cardIds: number[]): GameRoom {
    if (cardIds.length !== 5) {
      throw new Error('Must provide exactly 5 card IDs');
    }

    // Validate card IDs exist
    const cards = getCardsByIds(cardIds);

    const gameId = uuidv4();
    const room: GameRoom = {
      id: gameId,
      state: null as unknown as GameState, // Will be initialized when player 2 joins
      player1Id: playerId,
      player2Id: null,
      player1CardIds: cardIds,
      player2CardIds: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
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
    if (cardIds.length !== 5) {
      throw new Error('Must provide exactly 5 card IDs');
    }

    // Validate card IDs exist
    getCardsByIds(cardIds);

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
  ): PlaceCardResult {
    const room = this.games.get(gameId);
    if (!room) {
      throw new Error('Game not found');
    }
    if (!room.state) {
      throw new Error('Game has not started');
    }

    const player = this.getPlayerRole(gameId, playerId);
    if (!player) {
      throw new Error('Player not in this game');
    }
    if (room.state.currentTurn !== player) {
      throw new Error('Not your turn');
    }

    const result = placeCard(room.state, player, handIndex, row, col);
    room.state = result.newState;
    room.lastActivity = Date.now();
    return result;
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

  get gameCount(): number {
    return this.games.size;
  }
}
