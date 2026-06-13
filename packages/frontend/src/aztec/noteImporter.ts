/**
 * Shared note import logic for the Aztec frontend.
 *
 * Notes created via create_and_push_note skip on-chain tagging, so the PXE
 * cannot auto-discover them. This utility fetches the TxEffect and calls
 * import_note for each note to add them to the PXE's note store.
 */

import { AZTEC_CONFIG } from './config';
import { toFr } from './fieldUtils';

/** Timeout for TxEffect fetch retries (ms between attempts) */
const TX_EFFECT_RETRY_DELAY = 3000;
/** Number of TxEffect fetch retry attempts */
const TX_EFFECT_MAX_RETRIES = 5;

export interface NoteToImport {
  tokenId: number;
  randomness: string;
}

/** Pre-fetched TxEffect data — avoids a network round-trip when replaying from localStorage */
export interface TxEffectData {
  noteHashes: string[];     // non-zero unique note hashes
  firstNullifier: string;   // first nullifier from the tx
}

/** Cached NFT artifact to avoid repeated fetch() calls */
let _cachedNftArtifact: any = null;

/** Cached NFT contract instance (keyed by wallet reference) */
let _contractCache: { wallet: unknown; contract: any } | null = null;

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

/**
 * Import notes from a transaction into the PXE.
 *
 * @param wallet - The EmbeddedWallet instance
 * @param nodeClient - The Aztec node client (unused if txEffectData provided)
 * @param accountAddress - The account address (hex string)
 * @param txHashStr - Transaction hash string
 * @param notes - Array of notes to import (tokenId + randomness)
 * @param label - Label for log messages
 * @param txEffectData - Pre-fetched TxEffect data (skips network fetch if provided)
 * @returns The imported token IDs, or empty array on failure
 */
export async function importNotesFromTx(
  wallet: unknown,
  nodeClient: unknown,
  accountAddress: string,
  txHashStr: string,
  notes: NoteToImport[],
  label: string,
  txEffectData?: TxEffectData,
): Promise<number[]> {
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');
  const { Fr } = await import('@aztec/aztec.js/fields');

  const myAddr = AztecAddress.fromString(accountAddress);

  // Reuse cached contract instance when wallet hasn't changed
  if (!_contractCache || _contractCache.wallet !== wallet) {
    const { Contract } = await import('@aztec/aztec.js/contracts');
    const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress!);
    const artifact = await getNftArtifact();
    _contractCache = {
      wallet,
      contract: await Contract.at(nftAddr, artifact, wallet as never),
    };
  }
  const nftContract = _contractCache.contract;

  // Use pre-fetched data or fetch from node
  const effectData = txEffectData ?? await fetchTxEffectData(nodeClient, txHashStr);
  if (!effectData) {
    console.error(`[noteImporter] ${label}: Could not get TxEffect for ${txHashStr}`);
    return [];
  }

  const { noteHashes: uniqueNoteHashes, firstNullifier } = effectData;
  console.log(`[noteImporter] ${label}: ${uniqueNoteHashes.length} note hashes, firstNullifier=${firstNullifier}`);

  // Build padded note hashes array
  const paddedHashes = new Array(64).fill(new Fr(0n));
  for (let i = 0; i < uniqueNoteHashes.length && i < 64; i++) {
    paddedHashes[i] = toFr(Fr, uniqueNoteHashes[i]);
  }
  const txHashFr = toFr(Fr, txHashStr);
  const firstNullFr = toFr(Fr, firstNullifier);

  // Import each note
  for (const note of notes) {
    try {
      await nftContract.methods
        .import_note(
          myAddr,
          new Fr(BigInt(note.tokenId)),
          toFr(Fr, note.randomness),
          txHashFr,
          paddedHashes,
          uniqueNoteHashes.length,
          firstNullFr,
          myAddr,
        )
        .simulate({ from: myAddr });
    } catch (e) {
      console.warn(`[noteImporter] ${label}: import_note failed for tokenId=${note.tokenId}: ${e}`);
    }
  }

  console.log(`[noteImporter] ${label}: Imported ${notes.length} notes`);
  return notes.map(n => n.tokenId);
}

/** Cached ArenaToken artifact + contract instance (keyed by wallet). */
let _cachedTokenArtifact: any = null;
let _tokenContractCache: { wallet: unknown; contract: any } | null = null;

async function getTokenArtifact(): Promise<any> {
  if (_cachedTokenArtifact) return _cachedTokenArtifact;
  const { loadContractArtifact } = await import('@aztec/aztec.js/abi');
  const resp = await fetch('/contracts/arena_token-ArenaToken.json');
  if (!resp.ok) throw new Error('Failed to load ArenaToken contract artifact');
  _cachedTokenArtifact = loadContractArtifact(await resp.json());
  return _cachedTokenArtifact;
}

/**
 * Import a settlement reward balance note (ArenaToken) into the recipient's PXE.
 *
 * The loser's +20 reward is minted by the WINNER's process_game tx via
 * mint_reward(loser, 20, loser_per_game_randomness) — a create_and_push note
 * the loser's passive block scan never discovers (see the loser-token finding).
 * Its randomness is derived deterministically from the recipient's OWN per-game
 * randomness, so the loser computes it via compute_reward_randomness and injects
 * the note with import_note — mirroring the NFT card flow.
 *
 * @param playerRandomness  the recipient's per-game randomness (6 Fr hex strings)
 * @returns true if the note was imported, false if TxEffect was unavailable
 */
export async function importTokenRewardNote(
  wallet: unknown,
  nodeClient: unknown,
  accountAddress: string,
  txHashStr: string,
  amount: number,
  playerRandomness: string[],
  txEffectData?: TxEffectData,
): Promise<boolean> {
  if (!AZTEC_CONFIG.tokenContractAddress) {
    console.warn('[noteImporter] token reward: no token contract configured');
    return false;
  }
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');
  const { Fr } = await import('@aztec/aztec.js/fields');
  const myAddr = AztecAddress.fromString(accountAddress);

  if (!_tokenContractCache || _tokenContractCache.wallet !== wallet) {
    const { Contract } = await import('@aztec/aztec.js/contracts');
    const tokenAddr = AztecAddress.fromString(AZTEC_CONFIG.tokenContractAddress);
    const artifact = await getTokenArtifact();
    _tokenContractCache = { wallet, contract: await Contract.at(tokenAddr, artifact, wallet as never) };
  }
  const tokenContract = _tokenContractCache.contract;

  const effectData = txEffectData ?? await fetchTxEffectData(nodeClient, txHashStr);
  if (!effectData) {
    console.error(`[noteImporter] token reward: could not get TxEffect for ${txHashStr}`);
    return false;
  }

  // The note's randomness is derived in-contract from the recipient's per-game
  // randomness; recompute it the same way to import the note.
  const { result: rewardRandomness } = await tokenContract.methods
    .compute_reward_randomness(playerRandomness.map((r) => toFr(Fr, r)))
    .simulate({ from: myAddr });

  const { noteHashes: uniqueNoteHashes, firstNullifier } = effectData;
  const paddedHashes = new Array(64).fill(new Fr(0n));
  for (let i = 0; i < uniqueNoteHashes.length && i < 64; i++) {
    paddedHashes[i] = toFr(Fr, uniqueNoteHashes[i]);
  }

  try {
    await tokenContract.methods
      .import_note(
        myAddr,
        BigInt(amount),
        toFr(Fr, rewardRandomness),
        toFr(Fr, txHashStr),
        paddedHashes,
        uniqueNoteHashes.length,
        toFr(Fr, firstNullifier),
        myAddr,
      )
      .simulate({ from: myAddr });
    console.log(`[noteImporter] token reward: imported +${amount} note from ${txHashStr}`);
    return true;
  } catch (e) {
    console.warn(`[noteImporter] token reward: import_note failed:`, e);
    return false;
  }
}
