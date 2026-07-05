import { describe, it, expect, vi } from 'vitest';
import { isTransientTestnetTxFailure, withReorgRetry } from './pxe';

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

describe('withReorgRetry', () => {
  it('re-proves + resends on a transient failure, then succeeds', async () => {
    let calls = 0;
    const attempt = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('Tx dropped by P2P node');
      return 'txhash';
    });
    expect(await withReorgRetry('create_game', attempt, 0)).toBe('txhash');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('surfaces a genuine failure immediately — never retries it', async () => {
    const attempt = vi.fn(async () => { throw new Error('Assertion failed: not active'); });
    await expect(withReorgRetry('process_game', attempt, 0)).rejects.toThrow('Assertion failed');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt cap on a persistent transient failure', async () => {
    const attempt = vi.fn(async () => { throw new Error('Tx dropped by P2P node'); });
    await expect(withReorgRetry('join_game', attempt, 0)).rejects.toThrow('dropped by P2P');
    expect(attempt).toHaveBeenCalledTimes(3); // MAX_TX_ATTEMPTS
  });

  it('passes the happy path straight through (exactly one attempt)', async () => {
    const attempt = vi.fn(async () => 'ok');
    expect(await withReorgRetry('create_game', attempt, 0)).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
