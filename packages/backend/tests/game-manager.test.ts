import { describe, it, expect, beforeEach } from 'vitest';
import { GameManager } from '../src/GameManager.js';
import { MemoryGameStore } from '../src/store/MemoryGameStore.js';

// Valid card IDs from the card database (Level 1 cards)
const PLAYER1_CARDS = [1, 2, 3, 4, 5];
const PLAYER2_CARDS = [6, 7, 8, 9, 10];

describe('GameManager', () => {
  let manager: GameManager;

  beforeEach(() => {
    manager = new GameManager(new MemoryGameStore());
  });

  describe('createGame', () => {
    it('should create a game and return a room', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      expect(room.id).toBeDefined();
      expect(room.player1Id).toBe('player-1');
      expect(room.player2Id).toBeNull();
      expect(room.player1CardIds).toEqual(PLAYER1_CARDS);
      expect(room.player2CardIds).toEqual([]);
    });

    it('should increment game count', async () => {
      expect(await manager.getGameCount()).toBe(0);
      await manager.createGame('player-1', PLAYER1_CARDS);
      expect(await manager.getGameCount()).toBe(1);
      await manager.createGame('player-2', PLAYER2_CARDS);
      expect(await manager.getGameCount()).toBe(2);
    });

    it('should throw if not exactly 5 cards', async () => {
      await expect(manager.createGame('p1', [1, 2, 3])).rejects.toThrow('Must provide exactly 5 card IDs');
      await expect(manager.createGame('p1', [1, 2, 3, 4, 5, 6])).rejects.toThrow('Must provide exactly 5 card IDs');
    });

    it('should throw if invalid card IDs', async () => {
      await expect(manager.createGame('p1', [999, 998, 997, 996, 995])).rejects.toThrow();
    });

    it('should track player to game mapping', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      expect(await manager.getPlayerGame('player-1')).toBe(room.id);
    });
  });

  describe('joinGame', () => {
    it('should allow a second player to join', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      const joined = await manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      expect(joined.player2Id).toBe('player-2');
      expect(joined.player2CardIds).toEqual(PLAYER2_CARDS);
      expect(joined.state).toBeDefined();
      expect(joined.state.status).toBe('playing');
    });

    it('should initialize game state with correct hands', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      const joined = await manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      expect(joined.state.player1Hand).toHaveLength(5);
      expect(joined.state.player2Hand).toHaveLength(5);
      expect(joined.state.currentTurn).toBe('player1');
    });

    it('should throw if game not found', async () => {
      await expect(manager.joinGame('nonexistent', 'p2', PLAYER2_CARDS)).rejects.toThrow('Game not found');
    });

    it('should throw if game is full', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      await manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      await expect(manager.joinGame(room.id, 'player-3', [11, 12, 13, 14, 15])).rejects.toThrow('Game is full');
    });

    it('should throw if player tries to join own game', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      await expect(manager.joinGame(room.id, 'player-1', PLAYER2_CARDS)).rejects.toThrow('Cannot join your own game');
    });

    it('should throw if not exactly 5 cards', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      await expect(manager.joinGame(room.id, 'player-2', [6, 7])).rejects.toThrow('Must provide exactly 5 card IDs');
    });

    it('should track player 2 to game mapping', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      await manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      expect(await manager.getPlayerGame('player-2')).toBe(room.id);
    });
  });

  describe('placeCard', () => {
    let gameId: string;

    beforeEach(async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      gameId = room.id;
      await manager.joinGame(gameId, 'player-2', PLAYER2_CARDS);
    });

    it('should place a card and return result', async () => {
      const result = await manager.placeCard(gameId, 'player-1', 0, 0, 0);
      expect(result.newState).toBeDefined();
      expect(result.newState.board[0][0].card).not.toBeNull();
      expect(result.newState.board[0][0].owner).toBe('player1');
      expect(result.captures).toBeDefined();
    });

    it('should switch turns after placement', async () => {
      const result = await manager.placeCard(gameId, 'player-1', 0, 0, 0);
      expect(result.newState.currentTurn).toBe('player2');
    });

    it('should update internal game state', async () => {
      await manager.placeCard(gameId, 'player-1', 0, 0, 0);
      const room = await manager.getGame(gameId);
      expect(room!.state.board[0][0].card).not.toBeNull();
    });

    it('should throw if wrong player tries to move', async () => {
      await expect(manager.placeCard(gameId, 'player-2', 0, 0, 0)).rejects.toThrow('Not your turn');
    });

    it('should throw if player not in game', async () => {
      await expect(manager.placeCard(gameId, 'player-3', 0, 0, 0)).rejects.toThrow('Player not in this game');
    });

    it('should throw if game not found', async () => {
      await expect(manager.placeCard('fake', 'player-1', 0, 0, 0)).rejects.toThrow('Game not found');
    });

    it('should throw if cell is occupied', async () => {
      await manager.placeCard(gameId, 'player-1', 0, 0, 0);
      await expect(manager.placeCard(gameId, 'player-2', 0, 0, 0)).rejects.toThrow();
    });

    it('should handle captures correctly', async () => {
      await manager.placeCard(gameId, 'player-1', 0, 1, 1);
      await manager.placeCard(gameId, 'player-2', 0, 0, 1);
      const room = await manager.getGame(gameId);
      expect(room!.state.board[1][1].card).not.toBeNull();
      expect(room!.state.board[0][1].card).not.toBeNull();
    });

    it('should play a full game to completion', async () => {
      const positions: [number, number][] = [
        [0, 0], [0, 1], [0, 2],
        [1, 0], [1, 1], [1, 2],
        [2, 0], [2, 1], [2, 2],
      ];

      for (let i = 0; i < 9; i++) {
        const player = i % 2 === 0 ? 'player-1' : 'player-2';
        const [row, col] = positions[i];
        const result = await manager.placeCard(gameId, player, 0, row, col);
        if (i === 8) {
          expect(result.newState.status).toBe('finished');
          expect(result.newState.winner).toBeDefined();
        }
      }
    });
  });

  describe('getPlayerRole', () => {
    it('should return player1 for game creator', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      expect(await manager.getPlayerRole(room.id, 'player-1')).toBe('player1');
    });

    it('should return player2 for joiner', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      await manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      expect(await manager.getPlayerRole(room.id, 'player-2')).toBe('player2');
    });

    it('should return null for unknown player', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      expect(await manager.getPlayerRole(room.id, 'player-3')).toBeNull();
    });

    it('should return null for unknown game', async () => {
      expect(await manager.getPlayerRole('fake', 'player-1')).toBeNull();
    });
  });

  describe('listGames', () => {
    it('should return empty list initially', async () => {
      expect(await manager.listGames()).toEqual([]);
    });

    it('should list waiting games', async () => {
      await manager.createGame('player-1', PLAYER1_CARDS);
      const list = await manager.listGames();
      expect(list).toHaveLength(1);
      expect(list[0].status).toBe('waiting');
      expect(list[0].player1Connected).toBe(true);
      expect(list[0].player2Connected).toBe(false);
    });

    it('should list playing games', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      await manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      const list = await manager.listGames();
      expect(list).toHaveLength(1);
      expect(list[0].status).toBe('playing');
      expect(list[0].player2Connected).toBe(true);
    });

    it('should list multiple games', async () => {
      await manager.createGame('player-1', PLAYER1_CARDS);
      await manager.createGame('player-2', PLAYER2_CARDS);
      expect(await manager.listGames()).toHaveLength(2);
    });
  });

  describe('removePlayer', () => {
    it('should remove game if creator leaves before game starts', async () => {
      await manager.createGame('player-1', PLAYER1_CARDS);
      const result = await manager.removePlayer('player-1');
      expect(result).toBeNull();
      expect(await manager.getGameCount()).toBe(0);
    });

    it('should notify when player leaves active game', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      await manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      const result = await manager.removePlayer('player-1');
      expect(result).not.toBeNull();
      expect(result!.gameId).toBe(room.id);
    });

    it('should return null for unknown player', async () => {
      expect(await manager.removePlayer('unknown')).toBeNull();
    });

    it('should clean up player-to-game mapping', async () => {
      await manager.createGame('player-1', PLAYER1_CARDS);
      await manager.removePlayer('player-1');
      expect(await manager.getPlayerGame('player-1')).toBeNull();
    });
  });

  describe('removeGame', () => {
    it('should remove game and clean up mappings', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      await manager.joinGame(room.id, 'player-2', PLAYER2_CARDS);
      await manager.removeGame(room.id);
      expect(await manager.getGameCount()).toBe(0);
      expect(await manager.getPlayerGame('player-1')).toBeNull();
      expect(await manager.getPlayerGame('player-2')).toBeNull();
    });
  });

  describe('duplicate card ID validation (Fix 4.1)', () => {
    it('should reject duplicate card IDs in createGame', async () => {
      await expect(manager.createGame('p1', [1, 1, 3, 4, 5])).rejects.toThrow('Duplicate card IDs not allowed');
    });

    it('should reject all-same card IDs in createGame', async () => {
      await expect(manager.createGame('p1', [1, 1, 1, 1, 1])).rejects.toThrow('Duplicate card IDs not allowed');
    });

    it('should reject duplicate card IDs in joinGame', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      await expect(manager.joinGame(room.id, 'player-2', [6, 6, 8, 9, 10])).rejects.toThrow('Duplicate card IDs not allowed');
    });

    it('should accept valid unique card IDs', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      expect(room.player1CardIds).toEqual(PLAYER1_CARDS);
    });
  });

  describe('game overwrite prevention (Fix 4.2)', () => {
    it('should reject creating a new game while in an active game', async () => {
      await manager.createGame('player-1', PLAYER1_CARDS);
      await expect(manager.createGame('player-1', PLAYER2_CARDS)).rejects.toThrow('already in an active game');
    });

    it('should allow creating a game after previous game is removed', async () => {
      await manager.createGame('player-1', PLAYER1_CARDS);
      await manager.removePlayer('player-1');
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      expect(room.player1Id).toBe('player-1');
    });

    it('should reject joining a game while in an active game', async () => {
      const room1 = await manager.createGame('player-1', PLAYER1_CARDS);
      await manager.joinGame(room1.id, 'player-2', PLAYER2_CARDS);
      const room2 = await manager.createGame('player-3', [11, 12, 13, 14, 15]);
      await expect(manager.joinGame(room2.id, 'player-2', PLAYER2_CARDS)).rejects.toThrow('already in an active game');
    });
  });

  describe('move nonce validation (V7 Fix 4.1)', () => {
    let gameId: string;

    beforeEach(async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      gameId = room.id;
      await manager.joinGame(gameId, 'player-2', PLAYER2_CARDS);
    });

    it('should accept moves with correct move number', async () => {
      const result = await manager.placeCard(gameId, 'player-1', 0, 0, 0, 0);
      expect(result.newState).toBeDefined();
      expect(result.newState.board[0][0].card).not.toBeNull();
    });

    it('should reject moves with wrong move number', async () => {
      await expect(manager.placeCard(gameId, 'player-1', 0, 0, 0, 1)).rejects.toThrow('Invalid move number: expected 0, got 1');
    });

    it('should increment expected move number after each move', async () => {
      await manager.placeCard(gameId, 'player-1', 0, 0, 0, 0);
      await manager.placeCard(gameId, 'player-2', 0, 0, 1, 1);
      await manager.placeCard(gameId, 'player-1', 0, 0, 2, 2);
      await expect(manager.placeCard(gameId, 'player-2', 0, 1, 0, 2)).rejects.toThrow('Invalid move number: expected 3, got 2');
      const result = await manager.placeCard(gameId, 'player-2', 0, 1, 0, 3);
      expect(result.newState).toBeDefined();
    });

    it('should prevent replay of previous move number', async () => {
      await manager.placeCard(gameId, 'player-1', 0, 0, 0, 0);
      await expect(manager.placeCard(gameId, 'player-2', 0, 0, 1, 0)).rejects.toThrow('Invalid move number: expected 1, got 0');
    });

    it('should allow moves without moveNumber for backward compatibility', async () => {
      const result = await manager.placeCard(gameId, 'player-1', 0, 0, 0);
      expect(result.newState).toBeDefined();
    });

    it('should track move numbers through a full game', async () => {
      const positions: [number, number][] = [
        [0, 0], [0, 1], [0, 2],
        [1, 0], [1, 1], [1, 2],
        [2, 0], [2, 1], [2, 2],
      ];
      for (let i = 0; i < 9; i++) {
        const player = i % 2 === 0 ? 'player-1' : 'player-2';
        const [row, col] = positions[i];
        const result = await manager.placeCard(gameId, player, 0, row, col, i);
        if (i === 8) {
          expect(result.newState.status).toBe('finished');
        }
      }
    });
  });

  describe('game lock (replaces processing flag)', () => {
    let gameId: string;

    beforeEach(async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      gameId = room.id;
      await manager.joinGame(gameId, 'player-2', PLAYER2_CARDS);
    });

    it('should initialize expectedMoveNumber to 0', async () => {
      const room = await manager.getGame(gameId);
      expect(room!.expectedMoveNumber).toBe(0);
    });

    it('should release lock after successful move', async () => {
      await manager.placeCard(gameId, 'player-1', 0, 0, 0);
      // A second move should succeed (lock released)
      await manager.placeCard(gameId, 'player-2', 0, 0, 1);
    });

    it('should release lock after failed move', async () => {
      try {
        await manager.placeCard(gameId, 'player-2', 0, 0, 0); // wrong turn
      } catch { /* expected */ }
      // Lock should be released, next valid move works
      await manager.placeCard(gameId, 'player-1', 0, 0, 0);
    });
  });

  describe('cleanupStaleGames', () => {
    it('should remove games past timeout', async () => {
      const room = await manager.createGame('player-1', PLAYER1_CARDS);
      // Manually set lastActivity to past
      const gameRoom = (await manager.getGame(room.id))!;
      gameRoom.lastActivity = Date.now() - 31 * 60 * 1000;
      // Write the modified room back to the store
      await (manager as any).store.setGame(room.id, gameRoom);
      const cleaned = await manager.cleanupStaleGames();
      expect(cleaned).toBe(1);
      expect(await manager.getGameCount()).toBe(0);
    });

    it('should not remove active games', async () => {
      await manager.createGame('player-1', PLAYER1_CARDS);
      const cleaned = await manager.cleanupStaleGames();
      expect(cleaned).toBe(0);
      expect(await manager.getGameCount()).toBe(1);
    });
  });
});
