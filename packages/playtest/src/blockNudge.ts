/**
 * Keep the local network's CLOCK moving like a real network's while a test waits.
 *
 * v6's `aztec start --local-network` runs an automine sequencer: it builds an
 * L2 block only on tx activity, and every block it builds — on a tx, or on
 * `aztecDebug_mineBlock` — warps L1 to the NEXT L2 slot. So chain time moves
 * one slot per block (72s locally) and not at all between blocks.
 *
 * The game's abandonment clocks are chain SECONDS (MIN_ABANDON_SECONDS 480,
 * DISPUTE_SECONDS 600 — docs/plan/PRIVATE_GAMES.md section 3.4). With no empty
 * blocks they never elapse while a test waits. With one every four seconds —
 * this nudge's old pace, from when the dispute window was counted in BLOCKS —
 * chain time ran ~18x the wall clock: the eight-minute bar passed in under
 * half a minute and a ten-minute dispute window closed in about thirty
 * seconds, long before a returning player could contest a claim (measured:
 * claim to finalize in 47s of wall time).
 *
 * So one block per slot of wall time, which is what a real network produces:
 * the chain clock keeps pace with the wall clock (and runs a slot ahead of it
 * for every tx), and the windows take as long here as they do on testnet.
 *
 * Testnet needs none of this: blocks arrive there whether or not we are doing
 * anything, which is why the gap only shows up locally.
 */

/** The local network's L2 slot, if the node will not say (v6 `--local-network` default). */
const FALLBACK_SLOT_SECONDS = 72;

async function rpc(nodeUrl: string, method: string): Promise<unknown> {
  const res = await fetch(nodeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params: [], id: 1 }),
    signal: AbortSignal.timeout(10_000),
  });
  return ((await res.json()) as { result?: unknown }).result;
}

/** The node's L2 slot duration in seconds (`node_getL1Constants`). */
async function slotSeconds(nodeUrl: string): Promise<number | null> {
  try {
    const constants = await rpc(nodeUrl, 'node_getL1Constants') as { slotDuration?: number | string } | undefined;
    const slot = Number(constants?.slotDuration);
    return Number.isFinite(slot) && slot > 0 ? slot : null;
  } catch {
    return null;
  }
}

export function startBlockNudge(nodeUrl: string, log: (m: string) => void = () => {}): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const mine = async () => {
    try {
      await rpc(nodeUrl, 'aztecDebug_mineBlock');
    } catch {
      // The node may be mid-restart, or this may not be a debug-enabled sandbox.
      // Either way a failed nudge is not worth failing a test over.
    }
  };

  void (async () => {
    const slot = await slotSeconds(nodeUrl);
    if (stopped) return;
    const seconds = slot ?? FALLBACK_SLOT_SECONDS;
    timer = setInterval(() => void mine(), seconds * 1000);
    timer.unref?.();
    log(`mining a block every ${seconds}s (one per L2 slot${slot === null ? ', assumed' : ''}) ` +
      'so the chain clock keeps pace with the wall clock while tests wait');
  })();

  return () => { stopped = true; if (timer) clearInterval(timer); };
}
