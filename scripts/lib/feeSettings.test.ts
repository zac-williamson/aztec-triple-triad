/**
 * Unit tests for the L2 fee-headroom helper.
 *   npm run test:scripts
 */

import { describe, it, expect } from 'vitest';
import { FEE_HEADROOM_MULTIPLIER, headroomMaxFeesPerGas } from './feeSettings';

// Fake GasFees: records the scalar passed to mul() and returns a tagged value.
class FakeFees {
  constructor(public readonly base: number, public readonly scaled: number | null = null) {}
  mul(scalar: number | bigint) {
    return new FakeFees(this.base, this.base * Number(scalar));
  }
}

describe('feeSettings', () => {
  it('multiplier is the coordinated value (keep equal to lane-2)', () => {
    // Guards against silent divergence from packages/frontend/src/aztec/feeSettings.ts.
    expect(FEE_HEADROOM_MULTIPLIER).toBe(3);
  });

  it('headroomMaxFeesPerGas applies the multiplier to the current min fee', async () => {
    const node = { getCurrentMinFees: async () => new FakeFees(100) };
    const out = (await headroomMaxFeesPerGas(node as any)) as unknown as FakeFees;
    expect(out.scaled).toBe(100 * FEE_HEADROOM_MULTIPLIER); // 300 = real headroom over the 1.5x default
  });

  it('reads the CURRENT base fee each call (fresh per tx)', async () => {
    let calls = 0;
    const node = { getCurrentMinFees: async () => { calls++; return new FakeFees(10 * calls); } };
    const a = (await headroomMaxFeesPerGas(node as any)) as unknown as FakeFees;
    const b = (await headroomMaxFeesPerGas(node as any)) as unknown as FakeFees;
    expect(calls).toBe(2);
    expect(a.scaled).toBe(10 * FEE_HEADROOM_MULTIPLIER);
    expect(b.scaled).toBe(20 * FEE_HEADROOM_MULTIPLIER); // base fee can rise between txs
  });
});
