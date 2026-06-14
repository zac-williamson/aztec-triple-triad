/**
 * Keep the Aztec node's HTTP/2 connection warm during the long, CPU-pinned
 * ClientIVC proof.
 *
 * `instrumentedWallet.sendTx`'s proving phase issues NO node requests for
 * 1–3 minutes (the browser is busy proving). The transport idle-drops the
 * connection, so the NEXT request — the actual tx send — fails with
 * `net::ERR_CONNECTION_RESET` / "Failed to fetch". This dead-ends ~30% of
 * deploy+mint onboardings (and full-game settlement, which proves the same way)
 * with no recovery.
 *
 * A periodic lightweight read keeps the socket from going idle. This is
 * PREVENTION, not a retry/reconnect after the fact — the connection never drops,
 * so there is nothing to mask.
 *
 * The heartbeat is best-effort: a missed/failed ping is NOT the transaction's
 * result. The real send still surfaces its own errors, so ping failures are
 * swallowed here and nothing about the tx is hidden.
 */

/** Method we poll — a cheap, side-effect-free node read. */
interface KeepaliveNode {
  getBlockNumber?: () => Promise<unknown>;
}

/**
 * Ping cadence. Comfortably under the observed ~58s idle-drop, with margin for
 * timer jitter while the proof pins the CPU (the `await pxe.proveTx` yields the
 * main thread to bb.js workers, so the interval still fires).
 */
export const NODE_KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Start pinging `node` every `intervalMs` to keep its connection warm. Returns a
 * stop function — ALWAYS call it (e.g. in a `finally`) once the idle proving
 * window is over, so the interval never leaks.
 */
export function startNodeKeepalive(
  node: KeepaliveNode | null | undefined,
  intervalMs: number = NODE_KEEPALIVE_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    // Fire-and-forget: the request's only job is to keep the HTTP/2 connection
    // active; its result is irrelevant and a failure must not escape the timer.
    try {
      void Promise.resolve(node?.getBlockNumber?.()).catch(() => {});
    } catch {
      /* node missing the method / synchronous throw — best-effort heartbeat */
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
