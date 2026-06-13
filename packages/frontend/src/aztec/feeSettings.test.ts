/**
 * Fee headroom: maxFeesPerGas must be the CURRENT base fee scaled by the
 * canonical multiplier, so a tx survives a base-fee climb during proving.
 * Without the multiplier the value equals the bare base fee and the tx
 * rejects when the fee rises (the 4.3.1 playtest bug, harness assumption 15).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  FEE_HEADROOM_MULTIPLIER,
  maxFeesPerGasWithHeadroom,
  gasSettingsWithHeadroom,
  type BaseFeeNode,
} from './feeSettings';

/** Minimal GasFees stand-in: records the scalar passed to mul(). */
function fakeBaseFees(daGas: bigint, l2Gas: bigint) {
  return {
    feePerDaGas: daGas,
    feePerL2Gas: l2Gas,
    mul: vi.fn((scalar: number | bigint) => ({
      feePerDaGas: daGas * BigInt(scalar),
      feePerL2Gas: l2Gas * BigInt(scalar),
    })),
  };
}

function nodeReturning(base: ReturnType<typeof fakeBaseFees>): BaseFeeNode & { getCurrentMinFees: ReturnType<typeof vi.fn> } {
  return { getCurrentMinFees: vi.fn(async () => base as never) };
}

describe('fee headroom', () => {
  it('canonical multiplier is 3 (lane-1 deploy scripts must match)', () => {
    expect(FEE_HEADROOM_MULTIPLIER).toBe(3);
  });

  it('scales the current base fee by the headroom multiplier', async () => {
    const base = fakeBaseFees(100n, 200n);
    const node = nodeReturning(base);

    const max = await maxFeesPerGasWithHeadroom(node);

    // Reads the LIVE base fee every call (not a cached/stale value).
    expect(node.getCurrentMinFees).toHaveBeenCalledTimes(1);
    // Applies the headroom — NOT the bare base fee (which would be the bug).
    expect(base.mul).toHaveBeenCalledWith(FEE_HEADROOM_MULTIPLIER);
    expect(max.feePerL2Gas).toBe(200n * 3n); // 600n, > base 200n
    expect(max.feePerDaGas).toBe(100n * 3n);
  });

  it('gasSettingsWithHeadroom wraps maxFeesPerGas for the fee option', async () => {
    const node = nodeReturning(fakeBaseFees(1n, 21_600_000n)); // the observed-too-low L2 base
    const gasSettings = await gasSettingsWithHeadroom(node);

    expect(gasSettings).toEqual({ maxFeesPerGas: expect.anything() });
    // Headroom lifts it above the bare base fee that was rejected in the field.
    expect(gasSettings.maxFeesPerGas.feePerL2Gas).toBe(21_600_000n * 3n);
    expect(gasSettings.maxFeesPerGas.feePerL2Gas).toBeGreaterThan(21_600_000n);
  });
});
