import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toFr, toHexString, bytesToFrArray, base64ToFrArray, hexToFr } from '../fieldUtils';

/**
 * Mock Fr class matching the interface expected by fieldUtils helpers.
 */
class MockFr {
  constructor(public value: bigint) {}
  static fromHexString(hex: string) {
    return new MockFr(BigInt(hex));
  }
  toString() {
    return this.value.toString();
  }
}

describe('toFr', () => {
  it('passes through an Fr instance unchanged', () => {
    const fr = new MockFr(42n);
    expect(toFr(MockFr, fr)).toBe(fr);
  });

  it('converts a hex string to Fr', () => {
    const result = toFr(MockFr, '0xff');
    expect(result).toBeInstanceOf(MockFr);
    expect(result.value).toBe(255n);
  });

  it('converts a 0X-prefixed hex string to Fr', () => {
    const result = toFr(MockFr, '0X1a');
    expect(result.value).toBe(26n);
  });

  it('converts a decimal string to Fr via BigInt', () => {
    const result = toFr(MockFr, '12345');
    expect(result).toBeInstanceOf(MockFr);
    expect(result.value).toBe(12345n);
  });

  it('converts a BigInt to Fr', () => {
    const result = toFr(MockFr, 999n);
    expect(result.value).toBe(999n);
  });
});

describe('toHexString', () => {
  it('converts a decimal string to 0x-prefixed hex', () => {
    expect(toHexString('255')).toBe('0xff');
  });

  it('passes through a hex string unchanged', () => {
    expect(toHexString('0xdeadbeef')).toBe('0xdeadbeef');
  });

  it('passes through 0X-prefixed hex unchanged', () => {
    expect(toHexString('0XABC')).toBe('0XABC');
  });

  it('converts a BigInt to hex', () => {
    expect(toHexString(256n)).toBe('0x100');
  });

  it('converts an Fr-like object with decimal toString', () => {
    const fr = new MockFr(16n);
    expect(toHexString(fr)).toBe('0x10');
  });
});

describe('bytesToFrArray', () => {
  it('converts 64 bytes into 2 Fr elements', () => {
    const bytes = new Uint8Array(64);
    bytes[31] = 1; // first chunk = 1
    bytes[63] = 2; // second chunk = 2
    const result = bytesToFrArray(MockFr, bytes);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(MockFr);
    expect(result[1]).toBeInstanceOf(MockFr);
    expect(result[0].value).toBe(1n);
    expect(result[1].value).toBe(2n);
  });

  it('returns empty array for empty bytes', () => {
    expect(bytesToFrArray(MockFr, new Uint8Array(0))).toEqual([]);
  });

  it('handles non-aligned length (pads last chunk)', () => {
    // 48 bytes = 1 full 32-byte chunk + 16 leftover bytes
    const bytes = new Uint8Array(48);
    bytes[31] = 0xff;
    bytes[47] = 0xab;
    const result = bytesToFrArray(MockFr, bytes);
    expect(result).toHaveLength(2);
    // Second element is from a 16-byte slice (bytes 32-47)
    expect(result[1]).toBeInstanceOf(MockFr);
  });
});

describe('base64ToFrArray', () => {
  it('round-trips known bytes through base64', () => {
    // 32 zero bytes followed by a byte with value 0x42
    const bytes = new Uint8Array(64);
    bytes[63] = 0x42;
    // Encode to base64
    const b64 = btoa(String.fromCharCode(...bytes));
    const result = base64ToFrArray(MockFr, b64);
    expect(result).toHaveLength(2);
    expect(result[0].value).toBe(0n);
    expect(result[1].value).toBe(0x42n);
  });

  it('returns empty for base64 of empty bytes', () => {
    const b64 = btoa('');
    expect(base64ToFrArray(MockFr, b64)).toEqual([]);
  });
});

describe('hexToFr', () => {
  it('converts a 0x-prefixed hex string', () => {
    const result = hexToFr(MockFr, '0xbeef');
    expect(result).toBeInstanceOf(MockFr);
    expect(result.value).toBe(0xbeefn);
  });

  it('auto-prefixes 0x when missing', () => {
    const result = hexToFr(MockFr, 'cafe');
    expect(result.value).toBe(0xcafen);
  });
});

describe('getFr', () => {
  it('returns a cached Fr class', async () => {
    // We can't easily mock the dynamic import in this test environment,
    // but we verify the function exists and is callable
    const { getFr } = await import('../fieldUtils');
    expect(typeof getFr).toBe('function');
  });
});
