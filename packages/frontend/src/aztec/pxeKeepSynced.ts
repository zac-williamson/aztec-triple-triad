/**
 * Keep the PXE's fully-synced anchor fresh while the player IDLES.
 *
 * The embedded browser PXE has autoSync disabled: its anchor advances only
 * inside an explicit `pxe.sync()`, which wallet ops run as their first step.
 * So during any window with NO ops — a joiner waiting out the opponent's
 * create_game proof (~40s+), a player sitting in the lobby — the anchor ages
 * until the testnet prunes it, and the next proof is rejected ("Block hash …
 * not found … possibly a reorg"). Worse, once the anchor's block is pruned the
 * PXE's own sync silently aborts forever (the wedge).
 *
 * This scheduler is PREVENTION, mirroring nodeKeepalive's shape: on a cadence,
 * if (and only if) the serial PXE queue is idle, enqueue one sync op. While an
 * op runs the tick skips — the op syncs itself, and we never starve real work
 * or pile syncs behind a long proof.
 *
 * Best-effort: a failed tick is NOT anybody's transaction result; failures are
 * swallowed here and the real ops still surface their own errors.
 */

import txManager from './txManager';
import { resyncPxe, type PxeSyncReport } from './pxe';

/**
 * Tick cadence. The testnet prunes on the order of tens of seconds of anchor
 * age; 15s keeps worst-case anchor age ≈15–20s (tick + sync time) — inside the
 * prune window with margin — at a cost of a few RPCs per tick, far below the
 * 300/min/IP gateway cap (and zero while real ops keep the queue busy).
 */
export const PXE_KEEPSYNC_INTERVAL_MS = 15_000;

/**
 * Start the keep-synced loop. Returns a stop function — call it on disconnect/
 * unmount so the interval never leaks. `resync` is injectable for tests.
 */
export function startPxeKeepSynced(
  intervalMs: number = PXE_KEEPSYNC_INTERVAL_MS,
  resync: (label?: string, quiet?: boolean) => Promise<PxeSyncReport | null> = resyncPxe,
): () => void {
  let stopped = false;
  let inFlight = false;

  const timer = setInterval(() => {
    if (stopped || inFlight) return;
    // A queued/running op keeps the anchor fresh itself (ops sync first) —
    // only genuine idle needs us. This also self-limits: our own enqueued
    // sync makes the queue non-idle until it completes.
    if (!txManager.isPxeQueueIdle()) return;
    inFlight = true;
    void txManager
      .enqueuePxe(() => resync('keep-synced', /* quiet */ true))
      .catch(() => { /* best-effort — never surface a heartbeat failure */ })
      .finally(() => { inFlight = false; });
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
