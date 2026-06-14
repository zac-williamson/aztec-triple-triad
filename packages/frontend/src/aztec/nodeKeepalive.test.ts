/**
 * Node keepalive — prevents the HTTP/2 idle-drop during the CPU-pinned proof
 * that dead-ended ~30% of deploy+mint onboardings with net::ERR_CONNECTION_RESET.
 * Pins: it pings periodically while proving, stops cleanly, never throws on a
 * failed ping, fires well under the observed idle-drop window, and is actually
 * wired into the wallet's proving phase.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startNodeKeepalive, NODE_KEEPALIVE_INTERVAL_MS } from './nodeKeepalive';

describe('startNodeKeepalive', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pings the node every interval to keep the connection warm, then stops', async () => {
    const getBlockNumber = vi.fn().mockResolvedValue(1);
    const stop = startNodeKeepalive({ getBlockNumber }, 1000);

    expect(getBlockNumber).not.toHaveBeenCalled(); // no immediate ping
    await vi.advanceTimersByTimeAsync(1000);
    expect(getBlockNumber).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(getBlockNumber).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(getBlockNumber).toHaveBeenCalledTimes(3); // no pings after stop
  });

  it('is best-effort: a failing ping never throws out of the timer', async () => {
    const getBlockNumber = vi.fn().mockRejectedValue(new Error('ERR_CONNECTION_RESET'));
    const stop = startNodeKeepalive({ getBlockNumber }, 1000);

    // Advancing fires the (rejecting) ping; the swallow keeps it from surfacing
    // as an unhandled rejection that would fail this test.
    await vi.advanceTimersByTimeAsync(2000);
    expect(getBlockNumber).toHaveBeenCalledTimes(2);
    stop();
  });

  it('tolerates a node missing getBlockNumber without throwing', async () => {
    const stop = startNodeKeepalive({}, 1000);
    expect(stop).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(2000); // optional-chaining no-op; must not throw
    stop();
  });

  it('default cadence is comfortably under the observed ~58s idle-drop', () => {
    expect(NODE_KEEPALIVE_INTERVAL_MS).toBeGreaterThan(0);
    expect(NODE_KEEPALIVE_INTERVAL_MS).toBeLessThan(58_000);
  });
});

describe('keepalive wiring', () => {
  it('wraps the proving phase of instrumentedWallet.sendTx', () => {
    const src = readFileSync(join(process.cwd(), 'src/aztec/instrumentedWallet.ts'), 'utf8');
    // Imported, started for the node, and stopped (in the finally) — removing the
    // keepalive from the proving window fails this guard.
    expect(src).toContain("from './nodeKeepalive'");
    expect(src).toContain('startNodeKeepalive(self.aztecNode)');
    expect(src).toContain('stopKeepalive()');
  });
});
