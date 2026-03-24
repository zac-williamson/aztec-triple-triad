import { PXE_SYNC_MAX_POLLS, PXE_SYNC_POLL_INTERVAL } from './gameConstants';

/**
 * Wait for PXE block sync to catch up to the node's latest block.
 * Ensures nullifiers from recent txs are processed so pop_notes won't select stale notes.
 */
export async function waitForPxeSync(wallet: unknown, nodeClient: unknown): Promise<void> {
  if (!wallet || !nodeClient) throw new Error('waitForPxeSync called without wallet or nodeClient');

  const w = wallet as any;
  const node = nodeClient as any;

  const pxe = w.pxe;
  if (!pxe?.getSyncedBlockHeader) {
    throw new Error('PXE sync API (getSyncedBlockHeader) not available on wallet');
  }

  // getBlockNumber() returns the *next* block to be produced (tip + 1).
  // We need the PXE to have processed the latest *existing* block, so subtract 1.
  // Use getProvenBlockNumber() when available (returns last finalized), else fall back.
  let targetBlock: number;
  console.log(`[PXE-TRACE] ${Date.now()} pxeSync: getting target block number`);
  if (typeof node.getProvenBlockNumber === 'function') {
    targetBlock = await node.getProvenBlockNumber();
  } else {
    const nodeBlock = await node.getBlockNumber();
    targetBlock = Math.max(1, nodeBlock - 1);
  }

  // Check if PXE is already caught up before polling
  console.log(`[PXE-TRACE] ${Date.now()} pxe.getSyncedBlockHeader() target=${targetBlock}`);
  const header = await pxe.getSyncedBlockHeader();
  const currentBlock = Number(header.globalVariables?.blockNumber ?? 0);
  if (currentBlock >= targetBlock) {
    console.log(`[pxeSync] PXE already synced to block ${currentBlock} (target: ${targetBlock})`);
    return;
  }
  console.log(`[pxeSync] Waiting for PXE sync to block ${targetBlock} (currently at ${currentBlock})...`);

  for (let i = 0; i < PXE_SYNC_MAX_POLLS; i++) {
    console.log(`[PXE-TRACE] ${Date.now()} pxe.getSyncedBlockHeader() poll ${i}`);
    const h = await pxe.getSyncedBlockHeader();
    const syncedBlock = Number(h.globalVariables?.blockNumber ?? 0);
    if (syncedBlock >= targetBlock) {
      console.log(`[pxeSync] PXE synced to block ${syncedBlock}`);
      return;
    }
    await new Promise(r => setTimeout(r, PXE_SYNC_POLL_INTERVAL));
  }
  // Don't throw — the PXE may be stuck processing a complex block (e.g., settlement
  // with 10+ notes). The caller's .send() will trigger its own PXE sync internally
  // via proveTx → blockStateSynchronizer.sync(), which may succeed where our polling
  // failed (it uses a different sync path).
  const stuckBlock = Number((await pxe.getSyncedBlockHeader()).globalVariables?.blockNumber ?? 0);
  console.warn(`[pxeSync] PXE sync timed out: stuck at block ${stuckBlock}, target was ${targetBlock} (after ${PXE_SYNC_MAX_POLLS} polls). Proceeding anyway.`);
}
