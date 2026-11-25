import { describe, it, expect } from 'vitest';
import { GameManager } from '../src/GameManager.js';
import { generateGameId } from '../src/gameId.js';
import { MemoryGameStore } from '../src/store/MemoryGameStore.js';

// BN254 field modulus — room IDs are kept below it
const BN254_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

describe('room ID generation', () => {
  it('generates a 0x-prefixed hex string of 31 bytes', () => {
    expect(generateGameId()).toMatch(/^0x[0-9a-f]{62}$/);
  });

  it('is a valid BigInt (not a UUID)', () => {
    const id = generateGameId();
    expect(() => BigInt(id)).not.toThrow();
    expect(BigInt(id)).toBeGreaterThan(0n);
  });

  it('fits within BN254 field modulus', () => {
    for (let i = 0; i < 20; i++) {
      const value = BigInt(generateGameId());
      expect(value).toBeLessThan(BN254_MODULUS);
      expect(value).toBeGreaterThan(0n);
    }
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateGameId()));
    expect(ids.size).toBe(50);
  });

  it('is what a matched room is called', async () => {
    const manager = new GameManager(new MemoryGameStore());
    await manager.queuePlayer('p1');
    await manager.queuePlayer('p2');
    const match = await manager.tryMatch(new Set(['p1', 'p2']));
    const id = match!.room.id;
    expect(id).toMatch(/^0x[0-9a-f]{62}$/);
    expect((await manager.getGame(id))!.id).toBe(id);
  });
});
