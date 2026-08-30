/**
 * Keep the local sandbox producing blocks while a test WAITS.
 *
 * v5's `aztec start --local-network` runs an automine sequencer that only builds
 * an L2 block on transaction activity. Anything measured in BLOCKS therefore
 * never advances while a test is idle — the abandoned-game dispute window is
 * five blocks, so `handleClaimAbandoned` sat there and gave up with
 * "dispute window did not open: only 0/5 blocks" against a chain that was
 * working perfectly.
 *
 * Testnet needs none of this: blocks arrive there whether or not we are doing
 * anything, which is why the gap only shows up locally.
 */
const MINE_INTERVAL_MS = 4_000;

export function startBlockNudge(nodeUrl: string, log: (m: string) => void = () => {}): () => void {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await fetch(nodeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'aztecDebug_mineBlock', params: [], id: 1 }),
      });
    } catch {
      // The node may be mid-restart, or this may not be a debug-enabled sandbox.
      // Either way a failed nudge is not worth failing a test over.
    }
  };

  const timer = setInterval(() => void tick(), MINE_INTERVAL_MS);
  timer.unref?.();
  log(`mining a block every ${MINE_INTERVAL_MS}ms so block-measured waits can elapse`);

  return () => { stopped = true; clearInterval(timer); };
}
