import { describe, it, expect } from 'vitest';
import { GameManager } from '../src/GameManager.js';

// BN254 field modulus — game IDs must be less than this
const BN254_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const PLAYER1_CARDS = [1, 2, 3, 4, 5];
const PLAYER2_CARDS = [6, 7, 8, 9, 10];

describe('game ID generation', () => {
  it('generates a valid hex string with 0x prefix', () => {
    const manager = new GameManager();
    const room = manager.createGame('p1', PLAYER1_CARDS);
    expect(room.id).toMatch(/^0x[0-9a-f]+$/);
  });

  it('is a valid BigInt (not a UUID)', () => {
    const manager = new GameManager();
    const room = manager.createGame('p1', PLAYER1_CARDS);
    // This is the critical test — UUID strings like "d3a130b5-..." throw on BigInt()
    expect(() => BigInt(room.id)).not.toThrow();
    const value = BigInt(room.id);
    expect(value).toBeGreaterThan(0n);
  });

  it('fits within BN254 field modulus', () => {
    const manager = new GameManager();
    // Generate several to be sure
    for (let i = 0; i < 20; i++) {
      const room = manager.createGame(`player-${i}`, PLAYER1_CARDS);
      const value = BigInt(room.id);
      expect(value).toBeLessThan(BN254_MODULUS);
      expect(value).toBeGreaterThan(0n);
      // Clean up so player can create again
      manager.removePlayer(`player-${i}`);
    }
  });

  it('generates unique IDs', () => {
    const manager = new GameManager();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const room = manager.createGame(`player-${i}`, PLAYER1_CARDS);
      ids.add(room.id);
      manager.removePlayer(`player-${i}`);
    }
    expect(ids.size).toBe(50);
  });

  it('game ID works throughout full game lifecycle', () => {
    const manager = new GameManager();
    const room = manager.createGame('p1', PLAYER1_CARDS);
    const gameId = room.id;

    // Verify it's a valid field element
    expect(() => BigInt(gameId)).not.toThrow();

    // Join game with the hex game ID
    const joined = manager.joinGame(gameId, 'p2', PLAYER2_CARDS);
    expect(joined.id).toBe(gameId);
    expect(joined.state.status).toBe('playing');

    // Retrieve game by hex ID
    const retrieved = manager.getGame(gameId);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(gameId);
  });

  it('game ID is listed correctly', () => {
    const manager = new GameManager();
    const room = manager.createGame('p1', PLAYER1_CARDS);
    const list = manager.listGames();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(room.id);
    expect(() => BigInt(list[0].id)).not.toThrow();
  });
});
