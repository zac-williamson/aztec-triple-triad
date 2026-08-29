import { describe, it, expect } from 'vitest';
import { arenaBotAccount, ARENA_BOT_SEED } from './lib/arenaBotAccount.js';

const FIELD_MODULUS = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

describe('arenaBotAccount', () => {
  it('is deterministic — provisioning and the bot must derive the same account', () => {
    expect(arenaBotAccount(0)).toEqual(arenaBotAccount(0));
  });

  it('gives each identity in the pool distinct keys', () => {
    const a = arenaBotAccount(0);
    const b = arenaBotAccount(1);
    expect(a.secret).not.toEqual(b.secret);
    expect(a.salt).not.toEqual(b.salt);
    expect(a.signingKey).not.toEqual(b.signingKey);
  });

  it('uses three independent domains — one digest cannot yield three fields', () => {
    const { secret, salt, signingKey } = arenaBotAccount(0);
    expect(new Set([secret, salt, signingKey]).size).toBe(3);
  });

  it('reduces every key into the field', () => {
    for (let i = 0; i < 8; i++) {
      const k = arenaBotAccount(i);
      for (const v of [k.secret, k.salt, k.signingKey]) {
        expect(v).toMatch(/^0x[0-9a-f]{64}$/);
        expect(BigInt(v) < FIELD_MODULUS).toBe(true);
      }
    }
  });

  it('changes every key when the seed is bumped', () => {
    const a = arenaBotAccount(0, ARENA_BOT_SEED);
    const b = arenaBotAccount(0, 'axolotl-arena/arena-bot/v2');
    expect(a.secret).not.toEqual(b.secret);
    expect(a.salt).not.toEqual(b.salt);
    expect(a.signingKey).not.toEqual(b.signingKey);
  });

  it('rejects a bad index rather than silently deriving something', () => {
    expect(() => arenaBotAccount(-1)).toThrow(/non-negative/);
    expect(() => arenaBotAccount(1.5)).toThrow(/integer/);
  });
});
