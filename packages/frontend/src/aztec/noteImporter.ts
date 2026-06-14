/**
 * Node-side helpers for the note-import flow.
 *
 * Notes created via create_and_push_note skip on-chain tagging, so the PXE
 * cannot auto-discover them. Importing them needs the tx's effect data
 * (note hashes + first nullifier), which is read from the NODE here. The
 * actual `import_note` PXE calls live in the serial-queue door (`pxe.ts`,
 * `importCardNotes` / `importTokenRewardNote`) — this module only does the
 * node read + artifact fetch, neither of which touches the PXE/IndexedDB.
 */

/** Timeout for TxEffect fetch retries (ms between attempts) */
const TX_EFFECT_RETRY_DELAY = 3000;
/** Number of TxEffect fetch retry attempts */
const TX_EFFECT_MAX_RETRIES = 5;

export interface NoteToImport {
  tokenId: number;
  randomness: string;
}

/** Pre-fetched TxEffect data — the note hashes + first nullifier import_note needs */
export interface TxEffectData {
  noteHashes: string[];     // non-zero unique note hashes
  firstNullifier: string;   // first nullifier from the tx
}

/** Cached NFT artifact to avoid repeated fetch() calls */
let _cachedNftArtifact: any = null;

/** Load and cache the NFT contract artifact */
export async function getNftArtifact(): Promise<any> {
  if (_cachedNftArtifact) return _cachedNftArtifact;
  const { loadContractArtifact } = await import('@aztec/aztec.js/abi');
  const resp = await fetch('/contracts/triple_triad_nft-TripleTriadNFT.json');
  if (!resp.ok) throw new Error('Failed to load NFT contract artifact');
  _cachedNftArtifact = loadContractArtifact(await resp.json());
  return _cachedNftArtifact;
}

/**
 * Fetch TxEffect from the node with retries.
 * The tx may have just been mined, so we retry a few times.
 */
async function fetchTxEffect(nodeClient: any, txHashStr: string): Promise<any> {
  const { TxHash } = await import('@aztec/stdlib/tx');
  const hash = TxHash.fromString(txHashStr);

  for (let attempt = 0; attempt < TX_EFFECT_MAX_RETRIES; attempt++) {
    const txResult = await nodeClient.getTxEffect(hash);
    if (txResult?.data) return txResult.data;
    console.log(`[noteImporter] TxEffect not available yet (attempt ${attempt + 1}/${TX_EFFECT_MAX_RETRIES}), waiting...`);
    await new Promise(r => setTimeout(r, TX_EFFECT_RETRY_DELAY));
  }
  return null;
}

/**
 * Extract TxEffect data from the node for a given transaction.
 * Returns the noteHashes and firstNullifier needed for import_note.
 */
export async function fetchTxEffectData(
  nodeClient: unknown,
  txHashStr: string,
): Promise<TxEffectData | null> {
  const txEffect = await fetchTxEffect(nodeClient, txHashStr);
  if (!txEffect) return null;

  const rawNoteHashes: any[] = txEffect.noteHashes ?? [];
  const noteHashes: string[] = rawNoteHashes
    .map((h: any) => h.toString())
    .filter((h: string) => h !== '0' && h !== '0x0' && !/^0x0+$/.test(h));
  const firstNullifier: string = txEffect.nullifiers?.[0]?.toString() ?? '0';

  return { noteHashes, firstNullifier };
}
