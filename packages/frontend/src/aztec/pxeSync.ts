import { PXE_SYNC_MAX_POLLS, PXE_SYNC_POLL_INTERVAL } from './gameConstants';

/**
 * Wait for PXE block sync to catch up to the node's latest block.
 * Ensures nullifiers from recent txs are processed so pop_notes won't select stale notes.
 */
export async function waitForPxeSync(wallet: unknown, nodeClient: unknown): Promise<void> {
  const w = wallet as any;
  const node = nodeClient as any;
  if (!w || !node) return;
  try {
    const targetBlock = await node.getBlockNumber();
    console.log(`[pxeSync] Waiting for PXE sync to block ${targetBlock}...`);
    for (let i = 0; i < PXE_SYNC_MAX_POLLS; i++) {
      const header = await w.getSyncedBlockHeader();
      const syncedBlock = Number(header.globalVariables?.blockNumber ?? 0);
      if (syncedBlock >= targetBlock) {
        console.log(`[pxeSync] PXE synced to block ${syncedBlock}`);
        return;
      }
      await new Promise(r => setTimeout(r, PXE_SYNC_POLL_INTERVAL));
    }
    console.warn('[pxeSync] PXE sync timeout — proceeding anyway');
  } catch (err) {
    console.warn('[pxeSync] PXE sync check failed:', err);
  }
}
