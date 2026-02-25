import { describe, it, expect, beforeEach } from 'vitest';
import { GameManager } from '../src/GameManager.js';

// Valid card IDs from the card database (Level 1 cards)
const PLAYER1_CARDS = [1, 2, 3, 4, 5];
const PLAYER2_CARDS = [6, 7, 8, 9, 10];

describe('GameManager', () => {
  let manager: GameManager;

  beforeEach(() => {
    manager = new GameManager();
  });

  describe('createGame', () => {
    it('should create a game and return a room', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      expect(room.id).toBeDefined();
      expect(room.player1Id).toBe('player-1');
      expect(room.player2Id).toBeNull();
      expect(room.player1CardIds).toEqual(PLAYER1_CARDS);
      expect(room.player2CardIds).toEqual([]);
    });

    it('should increment game count', () => {
      expect(manager.gameCount).toBe(0);
      manager.createGame('player-1', PLAYER1_CARDS);
      expect(manager.gameCount).toBe(1);
      manager.createGame('player-2', PLAYER2_CARDS);
      expect(manager.gameCount).toBe(2);
    });

    it('should throw if not exactly 5 cards', () => {
      expect(() => manager.createGame('p1', [1, 2, 3])).toThrow('Must provide exactly 5 card IDs');
      expect(() => manager.createGame('p1', [1, 2, 3, 4, 5, 6])).toThrow('Must provide exactly 5 card IDs');
    });

    it('should throw if invalid card IDs', () => {
      expect(() => manager.createGame('p1', [999, 998, 997, 996, 995])).toThrow();
    });

    it('should track player to game mapping', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      expect(manager.getPlayerGame('player-1')).toBe(room.id);
    });
  });

  describe('joinGame', () => {
    it('should allow a second player to join', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      const joined = manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      expect(joined.player2Id).toBe('player-2');
      expect(joined.player2CardIds).toEqual(PLAYER2_CARDS);
      expect(joined.state).toBeDefined();
      expect(joined.state.status).toBe('playing');
    });

    it('should initialize game state with correct hands', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      const joined = manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      expect(joined.state.player1Hand).toHaveLength(5);
      expect(joined.state.player2Hand).toHaveLength(5);
      expect(joined.state.currentTurn).toBe('player1');
    });

    it('should throw if game not found', () => {
      expect(() => manager.joinGame('nonexistent', 'p2', PLAYER2_CARDS)).toThrow('Game not found');
    });

    it('should throw if game is full', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      expect(() => manager.joinGame(room.id, 'player-3', [11, 12, 13, 14, 15])).toThrow('Game is full');
    });

    it('should throw if player tries to join own game', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      expect(() => manager.joinGame(room.id, 'player-1', PLAYER2_CARDS)).toThrow('Cannot join your own game');
    });

    it('should throw if not exactly 5 cards', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      expect(() => manager.joinGame(room.id, 'player-2', [6, 7])).toThrow('Must provide exactly 5 card IDs');
    });

    it('should track player 2 to game mapping', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      expect(manager.getPlayerGame('player-2')).toBe(room.id);
    });
  });

  describe('placeCard', () => {
    let gameId: string;

    beforeEach(() => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      gameId = room.id;
      manager.joinGame(gameId, 'player-2', PLAYER2_CARDS);
    });

    it('should place a card and return result', () => {
      const result = manager.placeCard(gameId, 'player-1', 0, 0, 0);
      expect(result.newState).toBeDefined();
      expect(result.newState.board[0][0].card).not.toBeNull();
      expect(result.newState.board[0][0].owner).toBe('player1');
      expect(result.captures).toBeDefined();
    });

    it('should switch turns after placement', () => {
      const result = manager.placeCard(gameId, 'player-1', 0, 0, 0);
      expect(result.newState.currentTurn).toBe('player2');
    });

    it('should update internal game state', () => {
      manager.placeCard(gameId, 'player-1', 0, 0, 0);
      const room = manager.getGame(gameId);
      expect(room!.state.board[0][0].card).not.toBeNull();
    });

    it('should throw if wrong player tries to move', () => {
      expect(() => manager.placeCard(gameId, 'player-2', 0, 0, 0)).toThrow('Not your turn');
    });

    it('should throw if player not in game', () => {
      expect(() => manager.placeCard(gameId, 'player-3', 0, 0, 0)).toThrow('Player not in this game');
    });

    it('should throw if game not found', () => {
      expect(() => manager.placeCard('fake', 'player-1', 0, 0, 0)).toThrow('Game not found');
    });

    it('should throw if cell is occupied', () => {
      manager.placeCard(gameId, 'player-1', 0, 0, 0);
      expect(() => manager.placeCard(gameId, 'player-2', 0, 0, 0)).toThrow();
    });

    it('should handle captures correctly', () => {
      // Place cards in positions where captures can happen
      // Player 1 places at (1,1) center
      manager.placeCard(gameId, 'player-1', 0, 1, 1);
      // Player 2 places at (0,1) above center
      manager.placeCard(gameId, 'player-2', 0, 0, 1);
      // Result depends on card ranks, but the flow should work without errors
      const room = manager.getGame(gameId);
      expect(room!.state.board[1][1].card).not.toBeNull();
      expect(room!.state.board[0][1].card).not.toBeNull();
    });

    it('should play a full game to completion', () => {
      // Play all 9 turns
      const positions: [number, number][] = [
        [0, 0], [0, 1], [0, 2],
        [1, 0], [1, 1], [1, 2],
        [2, 0], [2, 1], [2, 2],
      ];

      for (let i = 0; i < 9; i++) {
        const player = i % 2 === 0 ? 'player-1' : 'player-2';
        const [row, col] = positions[i];
        const result = manager.placeCard(gameId, player, 0, row, col);
        if (i === 8) {
          expect(result.newState.status).toBe('finished');
          expect(result.newState.winner).toBeDefined();
        }
      }
    });
  });

  describe('getPlayerRole', () => {
    it('should return player1 for game creator', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      expect(manager.getPlayerRole(room.id, 'player-1')).toBe('player1');
    });

    it('should return player2 for joiner', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      expect(manager.getPlayerRole(room.id, 'player-2')).toBe('player2');
    });

    it('should return null for unknown player', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      expect(manager.getPlayerRole(room.id, 'player-3')).toBeNull();
    });

    it('should return null for unknown game', () => {
      expect(manager.getPlayerRole('fake', 'player-1')).toBeNull();
    });
  });

  describe('listGames', () => {
    it('should return empty list initially', () => {
      expect(manager.listGames()).toEqual([]);
    });

    it('should list waiting games', () => {
      manager.createGame('player-1', PLAYER1_CARDS);
      const list = manager.listGames();
      expect(list).toHaveLength(1);
      expect(list[0].status).toBe('waiting');
      expect(list[0].player1Connected).toBe(true);
      expect(list[0].player2Connected).toBe(false);
    });

    it('should list playing games', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      const list = manager.listGames();
      expect(list).toHaveLength(1);
      expect(list[0].status).toBe('playing');
      expect(list[0].player2Connected).toBe(true);
    });

    it('should list multiple games', () => {
      manager.createGame('player-1', PLAYER1_CARDS);
      manager.createGame('player-2', PLAYER2_CARDS);
      expect(manager.listGames()).toHaveLength(2);
    });
  });

  describe('removePlayer', () => {
    it('should remove game if creator leaves before game starts', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      const result = manager.removePlayer('player-1');
      expect(result).toBeNull(); // Game removed entirely
      expect(manager.gameCount).toBe(0);
    });

    it('should notify when player leaves active game', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      const result = manager.removePlayer('player-1');
      expect(result).not.toBeNull();
      expect(result!.gameId).toBe(room.id);
    });

    it('should return null for unknown player', () => {
      expect(manager.removePlayer('unknown')).toBeNull();
    });

    it('should clean up player-to-game mapping', () => {
      manager.createGame('player-1', PLAYER1_CARDS);
      manager.removePlayer('player-1');
      expect(manager.getPlayerGame('player-1')).toBeUndefined();
    });
  });

  describe('removeGame', () => {
    it('should remove game and clean up mappings', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      manager.removeGame(room.id);
      expect(manager.gameCount).toBe(0);
      expect(manager.getPlayerGame('player-1')).toBeUndefined();
      expect(manager.getPlayerGame('player-2')).toBeUndefined();
    });
  });

  describe('duplicate card ID validation (Fix 4.1)', () => {
    it('should reject duplicate card IDs in createGame', () => {
      expect(() => manager.createGame('p1', [1, 1, 3, 4, 5])).toThrow('Duplicate card IDs not allowed');
    });

    it('should reject all-same card IDs in createGame', () => {
      expect(() => manager.createGame('p1', [1, 1, 1, 1, 1])).toThrow('Duplicate card IDs not allowed');
    });

    it('should reject duplicate card IDs in joinGame', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      expect(() => manager.joinGame(room.id, 'player-2', [6, 6, 8, 9, 10])).toThrow('Duplicate card IDs not allowed');
    });

    it('should accept valid unique card IDs', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      expect(room.player1CardIds).toEqual(PLAYER1_CARDS);
    });
  });

  describe('game overwrite prevention (Fix 4.2)', () => {
    it('should reject creating a new game while in an active game', () => {
      manager.createGame('player-1', PLAYER1_CARDS);
      expect(() => manager.createGame('player-1', PLAYER2_CARDS)).toThrow('already in an active game');
    });

    it('should allow creating a game after previous game is removed', () => {
      manager.createGame('player-1', PLAYER1_CARDS);
      manager.removePlayer('player-1');
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      expect(room.player1Id).toBe('player-1');
    });

    it('should reject joining a game while in an active game', () => {
      const room1 = manager.createGame('player-1', PLAYER1_CARDS);
      manager.joinGame(room1.id, 'player-2', PLAYER2_CARDS);
      const room2 = manager.createGame('player-3', [11, 12, 13, 14, 15]);
      expect(() => manager.joinGame(room2.id, 'player-2', PLAYER2_CARDS)).toThrow('already in an active game');
    });
  });

  describe('cleanupStaleGames', () => {
    it('should remove games past timeout', () => {
      const room = manager.createGame('player-1', PLAYER1_CARDS);
      // Manually set lastActivity to past
      const gameRoom = manager.getGame(room.id)!;
      gameRoom.lastActivity = Date.now() - 31 * 60 * 1000; // 31 minutes ago
      const cleaned = manager.cleanupStaleGames();
      expect(cleaned).toBe(1);
      expect(manager.gameCount).toBe(0);
    });

    it('should not remove active games', () => {
      manager.createGame('player-1', PLAYER1_CARDS);
      const cleaned = manager.cleanupStaleGames();
      expect(cleaned).toBe(0);
      expect(manager.gameCount).toBe(1);
    });
  });
});
