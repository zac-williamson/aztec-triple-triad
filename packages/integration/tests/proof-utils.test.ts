import { describe, it, expect } from 'vitest';
import {
  serializeProof,
  deserializeProof,
  createHandProof,
  createMoveProof,
  uint8ArrayToBase64,
  base64ToUint8Array,
} from '../src/proof-utils.js';
import type { Proof } from '../src/types.js';

describe('uint8ArrayToBase64 / base64ToUint8Array', () => {
  it('round-trips correctly', () => {
    const original = new Uint8Array([0, 1, 2, 3, 255, 128, 64]);
    const base64 = uint8ArrayToBase64(original);
    const decoded = base64ToUint8Array(base64);
    expect(decoded).toEqual(original);
  });

  it('handles empty array', () => {
    const original = new Uint8Array([]);
    const base64 = uint8ArrayToBase64(original);
    const decoded = base64ToUint8Array(base64);
    expect(decoded).toEqual(original);
  });

  it('handles large array', () => {
    const original = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) original[i] = i % 256;
    const base64 = uint8ArrayToBase64(original);
    const decoded = base64ToUint8Array(base64);
    expect(decoded).toEqual(original);
  });
});

describe('serializeProof / deserializeProof', () => {
  it('round-trips a proof correctly', () => {
    const proof: Proof = {
      proof: new Uint8Array([10, 20, 30, 40, 50]),
      publicInputs: ['0xabc', '0xdef', '123'],
    };

    const serialized = serializeProof(proof);
    expect(typeof serialized.proof).toBe('string');
    expect(serialized.publicInputs).toEqual(proof.publicInputs);

    const deserialized = deserializeProof(serialized);
    expect(deserialized.proof).toEqual(proof.proof);
    expect(deserialized.publicInputs).toEqual(proof.publicInputs);
  });
});

describe('createHandProof', () => {
  it('creates a hand proof with correct metadata', () => {
    const proof: Proof = {
      proof: new Uint8Array([1, 2, 3]),
      publicInputs: ['0xcommit', '0xaddr', '42'],
    };

    const handProof = createHandProof(proof, '0xcommit', '0xaddr', '42');

    expect(handProof.type).toBe('hand');
    expect(handProof.cardCommit).toBe('0xcommit');
    expect(handProof.playerAddress).toBe('0xaddr');
    expect(handProof.gameId).toBe('42');
    expect(handProof.publicInputs).toEqual(['0xcommit', '0xaddr', '42']);
    expect(typeof handProof.proof).toBe('string'); // base64
  });
});

describe('createMoveProof', () => {
  it('creates a move proof with correct metadata', () => {
    const proof: Proof = {
      proof: new Uint8Array([4, 5, 6]),
      publicInputs: ['0xcc1', '0xcc2', '0xstart', '0xend', '0', '0'],
    };

    const moveProof = createMoveProof(
      proof,
      '0xcc1', '0xcc2',
      '0xstart', '0xend',
      false, 0,
    );

    expect(moveProof.type).toBe('move');
    expect(moveProof.cardCommit1).toBe('0xcc1');
    expect(moveProof.cardCommit2).toBe('0xcc2');
    expect(moveProof.startStateHash).toBe('0xstart');
    expect(moveProof.endStateHash).toBe('0xend');
    expect(moveProof.gameEnded).toBe(false);
    expect(moveProof.winnerId).toBe(0);
  });

  it('creates a move proof for a finished game', () => {
    const proof: Proof = {
      proof: new Uint8Array([7, 8, 9]),
      publicInputs: ['0xcc1', '0xcc2', '0xstart', '0xend', '1', '1'],
    };

    const moveProof = createMoveProof(
      proof,
      '0xcc1', '0xcc2',
      '0xstart', '0xend',
      true, 1,
    );

    expect(moveProof.gameEnded).toBe(true);
    expect(moveProof.winnerId).toBe(1);
  });
});
