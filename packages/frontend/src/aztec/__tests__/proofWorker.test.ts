import { describe, it, expect } from 'vitest';
import { toFieldHex, bufToHex, numToField, hexToField } from '../proofWorker';
import { encodeBoardState } from '../../hooks/useProofGeneration';
import type { GameState } from '../../types';

describe('toFieldHex', () => {
  it('converts numbers to 0x-prefixed hex', () => {
    expect(toFieldHex(0)).toBe('0x0');
    expect(toFieldHex(1)).toBe('0x1');
    expect(toFieldHex(255)).toBe('0xff');
    expect(toFieldHex(256)).toBe('0x100');
  });

  it('passes through 0x-prefixed strings', () => {
    expect(toFieldHex('0xabc')).toBe('0xabc');
    expect(toFieldHex('0x0')).toBe('0x0');
    expect(toFieldHex('0xFF')).toBe('0xFF');
  });

  it('passes through 0X-prefixed strings', () => {
    expect(toFieldHex('0Xabc')).toBe('0Xabc');
  });

  it('adds 0x prefix to bare hex strings that are valid numeric', () => {
    // Bare numeric strings get converted via BigInt
    expect(toFieldHex('255')).toBe('0xff');
    expect(toFieldHex('0')).toBe('0x0');
  });

  it('converts bigints to hex', () => {
    expect(toFieldHex(0n)).toBe('0x0');
    expect(toFieldHex(255n)).toBe('0xff');
    expect(toFieldHex(256n)).toBe('0x100');
    // Large values that fit in BN254
    const large = 2n ** 200n;
    expect(toFieldHex(large)).toMatch(/^0x[0-9a-f]+$/);
  });

  it('throws on non-numeric strings like UUIDs', () => {
    expect(() => toFieldHex('d3a130b5-5455-4fe0-a1ad-169e2146fa15')).toThrow();
  });

  it('throws on the string "unknown"', () => {
    expect(() => toFieldHex('unknown')).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => toFieldHex('')).toThrow();
  });

  it('throws on random words', () => {
    expect(() => toFieldHex('hello')).toThrow();
    expect(() => toFieldHex('not_a_number')).toThrow();
  });
});

describe('bufToHex', () => {
  it('converts zero buffer to 0x-prefixed hex', () => {
    const buf = new Uint8Array(32);
    expect(bufToHex(buf)).toBe('0x' + '00'.repeat(32));
  });

  it('converts single-byte value', () => {
    const buf = new Uint8Array([0xff]);
    expect(bufToHex(buf)).toBe('0xff');
  });

  it('converts multi-byte value correctly', () => {
    const buf = new Uint8Array([0x01, 0x23, 0x45]);
    expect(bufToHex(buf)).toBe('0x012345');
  });

  it('preserves leading zeros', () => {
    const buf = new Uint8Array([0x00, 0x00, 0x01]);
    expect(bufToHex(buf)).toBe('0x000001');
  });
});

describe('numToField', () => {
  it('converts 0 to zero-filled 32-byte buffer', () => {
    const buf = numToField(0);
    expect(buf).toHaveLength(32);
    expect(buf.every(b => b === 0)).toBe(true);
  });

  it('converts 1 to buffer with last byte = 1', () => {
    const buf = numToField(1);
    expect(buf[31]).toBe(1);
    expect(buf[30]).toBe(0);
  });

  it('converts 256 correctly (big-endian)', () => {
    const buf = numToField(256);
    expect(buf[30]).toBe(1);
    expect(buf[31]).toBe(0);
  });

  it('converts bigint values', () => {
    const buf = numToField(0xabcdefn);
    expect(buf[29]).toBe(0xab);
    expect(buf[30]).toBe(0xcd);
    expect(buf[31]).toBe(0xef);
  });

  it('round-trips with bufToHex', () => {
    const value = 12345n;
    const buf = numToField(value);
    const hex = bufToHex(buf);
    expect(BigInt(hex)).toBe(value);
  });
});

describe('hexToField', () => {
  it('converts 0x-prefixed hex to 32-byte buffer', () => {
    const buf = hexToField('0x1');
    expect(buf).toHaveLength(32);
    expect(buf[31]).toBe(1);
    expect(buf[30]).toBe(0);
  });

  it('converts bare hex without 0x prefix', () => {
    const buf = hexToField('ff');
    expect(buf[31]).toBe(255);
  });

  it('handles large hex values', () => {
    const hex = '0x' + 'ab'.repeat(31);
    const buf = hexToField(hex);
    expect(buf).toHaveLength(32);
    // First byte should be 0 (only 31 bytes of data, padded to 32)
    expect(buf[0]).toBe(0);
    expect(buf[1]).toBe(0xab);
  });

  it('pads short hex to 32 bytes', () => {
    const buf = hexToField('0xff');
    expect(buf).toHaveLength(32);
    expect(buf[31]).toBe(0xff);
    // First 31 bytes should be 0
    for (let i = 0; i < 31; i++) {
      expect(buf[i]).toBe(0);
    }
  });

  it('round-trips with bufToHex for zero', () => {
    const buf = hexToField('0x0');
    const hex = bufToHex(buf);
    expect(BigInt(hex)).toBe(0n);
  });

  it('round-trips with numToField', () => {
    const original = numToField(42);
    const hex = bufToHex(original);
    const restored = hexToField(hex);
    expect(restored).toEqual(original);
  });
});

describe('encodeBoardState', () => {
  function makeEmptyBoard(): GameState['board'] {
    return Array(3).fill(null).map(() =>
      Array(3).fill(null).map(() => ({ card: null, owner: null }))
    );
  }

  it('produces exactly 18 elements for empty board', () => {
    const board = makeEmptyBoard();
    const encoded = encodeBoardState(board);
    expect(encoded).toHaveLength(18); // 9 cells * 2 (card_id + owner)
  });

  it('all elements are 0 for empty board', () => {
    const board = makeEmptyBoard();
    const encoded = encodeBoardState(board);
    expect(encoded.every(v => v === '0')).toBe(true);
  });

  it('encodes card IDs and owners correctly', () => {
    const board = makeEmptyBoard();
    // Place card 5 owned by player1 at [0][0]
    board[0][0] = {
      card: { id: 5, name: 'Test', ranks: { top: 1, right: 2, bottom: 3, left: 4 } },
      owner: 'player1',
    };
    // Place card 10 owned by player2 at [1][1]
    board[1][1] = {
      card: { id: 10, name: 'Test2', ranks: { top: 5, right: 6, bottom: 7, left: 8 } },
      owner: 'player2',
    };

    const encoded = encodeBoardState(board);

    // [0][0]: card_id=5, owner=1 (player1)
    expect(encoded[0]).toBe('5');
    expect(encoded[1]).toBe('1');

    // [0][1]: empty
    expect(encoded[2]).toBe('0');
    expect(encoded[3]).toBe('0');

    // [1][1]: card_id=10, owner=2 (player2)
    // Index: row 1, col 1 = cell index 4, so array index 8 (card), 9 (owner)
    expect(encoded[8]).toBe('10');
    expect(encoded[9]).toBe('2');
  });

  it('all elements are valid numeric strings', () => {
    const board = makeEmptyBoard();
    board[2][2] = {
      card: { id: 42, name: 'X', ranks: { top: 1, right: 1, bottom: 1, left: 1 } },
      owner: 'player2',
    };
    const encoded = encodeBoardState(board);
    for (const val of encoded) {
      expect(() => Number(val)).not.toThrow();
      expect(Number.isFinite(Number(val))).toBe(true);
    }
  });
});
