import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startPxeKeepSynced, PXE_KEEPSYNC_INTERVAL_MS } from './pxeKeepSynced';
import txManager from './txManager';

describe('pxeKeepSynced', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const flush = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  it('enqueues a sync each tick while the queue is idle', async () => {
    const resync = vi.fn(async () => null);
    const stop = startPxeKeepSynced(PXE_KEEPSYNC_INTERVAL_MS, resync);
    await flush(PXE_KEEPSYNC_INTERVAL_MS * 3 + 5);
    stop();
    expect(resync).toHaveBeenCalledTimes(3);
    // Runs THROUGH the serial queue (labelled + quiet).
    expect(resync).toHaveBeenCalledWith('keep-synced', true);
  });

  it('skips ticks while the PXE queue is busy — real ops sync themselves', async () => {
    const resync = vi.fn(async () => null);
    // Occupy the queue with a long-running op for two full tick windows.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const busy = txManager.enqueuePxe(() => gate);
    const stop = startPxeKeepSynced(PXE_KEEPSYNC_INTERVAL_MS, resync);
    await flush(PXE_KEEPSYNC_INTERVAL_MS * 2 + 5);
    expect(resync).not.toHaveBeenCalled();
    release();
    await busy;
    await flush(PXE_KEEPSYNC_INTERVAL_MS + 5);
    stop();
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('never overlaps its own syncs (a slow sync suppresses later ticks)', async () => {
    let release!: () => void;
    const slowSync = vi.fn(() => new Promise<null>((r) => { release = () => r(null); }));
    const stop = startPxeKeepSynced(PXE_KEEPSYNC_INTERVAL_MS, slowSync as never);
    await flush(PXE_KEEPSYNC_INTERVAL_MS * 3 + 5);
    expect(slowSync).toHaveBeenCalledTimes(1);
    release();
    stop();
  });

  it('stop() halts ticking and a failed sync never throws out of the timer', async () => {
    const resync = vi.fn(async () => { throw new Error('node unreachable'); });
    const stop = startPxeKeepSynced(PXE_KEEPSYNC_INTERVAL_MS, resync as never);
    await flush(PXE_KEEPSYNC_INTERVAL_MS + 5);
    expect(resync).toHaveBeenCalledTimes(1); // swallowed, no unhandled rejection
    stop();
    await flush(PXE_KEEPSYNC_INTERVAL_MS * 3);
    expect(resync).toHaveBeenCalledTimes(1); // no further ticks after stop
  });
});
