import { describe, it, expect, vi } from 'vitest';
import { isTransientTestnetTxFailure, isPxeWedgedError, withReorgRetry, WEDGE_LAG_BLOCKS, type PxeSyncReport } from './pxe';

describe('isTransientTestnetTxFailure', () => {
  it('matches the v5-testnet reorg/prune failures', () => {
    expect(isTransientTestnetTxFailure(new Error('Transaction 0xabc was dropped. Reason: Tx dropped by P2P node'))).toBe(true);
    expect(isTransientTestnetTxFailure(new Error('Block header not found for the anchor'))).toBe(true);
    expect(isTransientTestnetTxFailure(new Error('anchor block was pruned'))).toBe(true);
  });

  it('does NOT match genuine (non-transient) failures', () => {
    // A real revert / assertion is a logic failure — retrying must NOT hide it.
    expect(isTransientTestnetTxFailure(new Error('Assertion failed: Game must be in active state'))).toBe(false);
    expect(isTransientTestnetTxFailure(new Error('reverted: reverted. Reason: unknown'))).toBe(false);
    expect(isTransientTestnetTxFailure(new Error('insufficient balance'))).toBe(false);
  });
});

/** A healthy resync: the anchor moved and sits at the tip. */
const healthyResync = (over: Partial<PxeSyncReport> = {}) =>
  vi.fn(async (): Promise<PxeSyncReport> => ({
    anchorBlock: 100, anchorHash: '0xfresh', tipBlock: 100, lag: 0, advanced: true, syncMs: 5, ...over,
  }));

describe('withReorgRetry', () => {
  it('resyncs the PXE then re-proves on a transient failure, and succeeds', async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('Tx dropped by P2P node');
      return 'txhash';
    });
    const resync = healthyResync();
    expect(await withReorgRetry('create_game', attempt, resync)).toBe('txhash');
    expect(attempt).toHaveBeenCalledTimes(2);
    // The resync runs BETWEEN attempts — that is the fix (no passive sleep).
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('surfaces a genuine failure immediately — never retries, never resyncs', async () => {
    const attempt = vi.fn(async () => { throw new Error('Assertion failed: not active'); });
    const resync = healthyResync();
    await expect(withReorgRetry('process_game', attempt, resync)).rejects.toThrow('Assertion failed');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(resync).not.toHaveBeenCalled();
  });

  it('gives up after the attempt cap on a persistent transient failure', async () => {
    const attempt = vi.fn(async () => { throw new Error('Tx dropped by P2P node'); });
    await expect(withReorgRetry('join_game', attempt, healthyResync())).rejects.toThrow('dropped by P2P');
    expect(attempt).toHaveBeenCalledTimes(3); // MAX_TX_ATTEMPTS
  });

  it('passes the happy path straight through (exactly one attempt, no resync)', async () => {
    const attempt = vi.fn(async () => 'ok');
    const resync = healthyResync();
    expect(await withReorgRetry('create_game', attempt, resync)).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(resync).not.toHaveBeenCalled();
  });

  it('fails fast with the wedge error when the resync cannot move a far-behind anchor', async () => {
    const attempt = vi.fn(async () => { throw new Error('Block hash 0x2151c7dc not found when querying world state'); });
    // Anchor unmoved AND lag over the threshold — the silently-wedged sync.
    const resync = healthyResync({ anchorBlock: 90, anchorHash: '0x2151c7dc', tipBlock: 90 + WEDGE_LAG_BLOCKS, lag: WEDGE_LAG_BLOCKS, advanced: false });
    const run = withReorgRetry('join_game', attempt, resync);
    await expect(run).rejects.toThrow('PXE chain-sync is wedged');
    await expect(run).rejects.toSatisfy(isPxeWedgedError);
    // No doomed second proof: one attempt, one diagnostic resync, out.
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying when the anchor is unmoved but NEAR the tip (healthy no-op sync)', async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('Tx dropped by P2P node');
      return 'txhash';
    });
    // advanced=false at lag 0 is normal (already at tip) — must not be a wedge.
    const resync = healthyResync({ advanced: false, lag: 0 });
    expect(await withReorgRetry('create_game', attempt, resync)).toBe('txhash');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('retries even when no wallet is bound yet (resync returns null)', async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('anchor block was pruned');
      return 'ok';
    });
    const resync = vi.fn(async () => null);
    expect(await withReorgRetry('create_game', attempt, resync)).toBe('ok');
  });
});
