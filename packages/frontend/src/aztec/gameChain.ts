/**
 * Node reads for a private game (docs/plan/PRIVATE_GAMES.md sections 3.3, 5.4,
 * 5.5).
 *
 * A game has no public state: its progress is a set of siloed nullifiers that
 * only its players can compute (`pxe.gameNullifiers`, a PXE utility call).
 * Everything here asks the NODE about them — whether each exists, the block it
 * landed in, that block's time, the tx in it — so none of it touches the PXE or
 * IndexedDB and none of it needs the serial queue.
 */
import type { TxEffectData } from './noteImporter';
import {
  normalizeField,
  parseGameChainState,
  RECORD_REWARD,
  RECORD_RETURNS,
  type GameChainState,
  type GameRecord,
  type NullifierHit,
} from './privateGame';
import { CARDS_PER_HAND } from './gameConstants';

/** The slice of the Aztec node these reads use. */
export interface GameNode {
  findLeavesIndexes(
    referenceBlock: 'latest',
    treeId: number,
    leafValues: unknown[],
  ): Promise<({ l2BlockNumber: number | bigint } | undefined)[]>;
  getBlockData?(param: number): Promise<{ header: { globalVariables: { timestamp: bigint | number } } } | undefined>;
  getBlock(param: number, options?: { includeTransactions?: boolean }): Promise<unknown>;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Which of `nullifiers` (siloed) exist, and in which block each landed.
 * One node round trip for any number of them.
 */
export async function lookupNullifiers(node: unknown, nullifiers: string[]): Promise<(NullifierHit | null)[]> {
  const [{ Fr }, { MerkleTreeId }] = await Promise.all([
    import('@aztec-labs/aztec.js/fields'),
    import('@aztec-labs/stdlib/trees'),
  ]);
  const leaves = nullifiers.map(n => Fr.fromHexString(normalizeField(n)));
  const found = await (node as GameNode).findLeavesIndexes('latest', MerkleTreeId.NULLIFIER_TREE, leaves);
  if (found.length !== nullifiers.length) {
    throw new Error(`nullifier lookup returned ${found.length} results for ${nullifiers.length} nullifiers`);
  }
  return found.map(hit => (hit ? { blockNumber: Number(hit.l2BlockNumber) } : null));
}

/** The game's state, from the 21 nullifiers `game_nullifiers` computed. */
export async function readGameChainState(node: unknown, gameNullifiers: string[]): Promise<GameChainState> {
  return parseGameChainState(await lookupNullifiers(node, gameNullifiers));
}

/** A block's timestamp, in chain seconds — what the contract's clocks compare. */
export async function blockTimestamp(node: unknown, blockNumber: number): Promise<number> {
  const n = node as GameNode;
  const block = n.getBlockData
    ? await n.getBlockData(blockNumber)
    : (await n.getBlock(blockNumber)) as { header?: { globalVariables?: { timestamp?: bigint | number } } } | undefined;
  const ts = block?.header?.globalVariables?.timestamp;
  if (ts === undefined || ts === null) throw new Error(`block ${blockNumber} not found on the node`);
  return Number(ts);
}

/** A tx found by one of its nullifiers: its hash and the data import_note needs. */
export interface FoundTx extends TxEffectData {
  txHash: string;
}

interface BlockTxEffect {
  txHash: { toString(): string };
  noteHashes?: { toString(): string }[];
  nullifiers?: { toString(): string }[];
}

/**
 * The tx in block `blockNumber` that emitted `nullifier` — how a player finds
 * the tx that resolved their game when nobody told them (section 5.4 step 3):
 * look up `done`, then read that block's transactions.
 */
export async function findTxWithNullifier(node: unknown, blockNumber: number, nullifier: string): Promise<FoundTx | null> {
  const block = (await (node as GameNode).getBlock(blockNumber, { includeTransactions: true })) as
    | { body?: { txEffects?: BlockTxEffect[] } }
    | undefined;
  const target = normalizeField(nullifier);
  for (const effect of block?.body?.txEffects ?? []) {
    const nullifiers = (effect.nullifiers ?? []).map(n => normalizeField(n.toString()));
    if (!nullifiers.includes(target)) continue;
    const noteHashes = (effect.noteHashes ?? [])
      .map(h => h.toString())
      .filter(h => BigInt(h) !== 0n);
    return { txHash: effect.txHash.toString(), noteHashes, firstNullifier: nullifiers[0] };
  }
  return null;
}

export interface WaitOpts {
  pollMs?: number;
  maxMs?: number;
  /** Polled between lookups; throw from it to abandon the wait. */
  check?: () => void;
}

/**
 * Wait until `nullifier` exists. Bounded: a nullifier that never comes means
 * the other side committed something else (a different key or record), and
 * waiting on it forever would hide that.
 */
export async function waitForNullifier(node: unknown, nullifier: string, label: string, opts: WaitOpts = {}): Promise<NullifierHit> {
  const pollMs = opts.pollMs ?? 5_000;
  const maxMs = opts.maxMs ?? 10 * 60_000;
  const started = Date.now();
  for (;;) {
    opts.check?.();
    const [hit] = await lookupNullifiers(node, [nullifier]);
    if (hit) return hit;
    if (Date.now() - started >= maxMs) {
      throw new Error(`${label}: not on-chain after ${Math.round(maxMs / 1000)}s`);
    }
    await sleep(pollMs);
  }
}

// ─── Which prepared notes a tx released ─────────────────────────────────────

/** The protocol's note-hash siloing, injected so the search is testable. */
export interface NoteHasher {
  silo(contract: string, innerNoteHash: string): Promise<string>;
  nonce(firstNullifier: string, index: number): Promise<string>;
  unique(nonce: string, siloedNoteHash: string): Promise<string>;
}

/** MAX_NOTE_HASHES_PER_TX: a note's nonce may use any index below it. */
const MAX_NOTE_HASHES_PER_TX = 64;

/** The SDK's own implementations — the same ones the kernel's are checked against. */
export async function stdlibNoteHasher(): Promise<NoteHasher> {
  const [hash, { Fr }, { AztecAddress }] = await Promise.all([
    import('@aztec-labs/stdlib/hash'),
    import('@aztec-labs/aztec.js/fields'),
    import('@aztec-labs/aztec.js/addresses'),
  ]);
  const fr = (v: string) => Fr.fromHexString(normalizeField(v));
  return {
    silo: async (contract, inner) =>
      (await hash.siloNoteHash(AztecAddress.fromStringUnsafe(contract), fr(inner))).toString(),
    nonce: async (firstNullifier, index) => (await hash.computeNoteHashNonce(fr(firstNullifier), index)).toString(),
    unique: async (nonce, siloed) => (await hash.computeUniqueNoteHash(fr(nonce), fr(siloed))).toString(),
  };
}

/**
 * For each candidate `(contract, inner note hash)`, whether the tx contains it.
 *
 * A note pushed by `contract` lands in the tx as
 * `unique(nonce(first_nullifier, i), silo(contract, inner))` — the search
 * aztec-nr's own note discovery does (`attempt_note_nonce_discovery`), over
 * every index because the kernel may use any of them.
 */
export async function findReleasedNotes(
  txEffect: TxEffectData,
  candidates: { contract: string; inner: string }[],
  hasher?: NoteHasher,
): Promise<boolean[]> {
  const h = hasher ?? await stdlibNoteHasher();
  const inTx = new Set(txEffect.noteHashes.map(normalizeField));
  const nonces: string[] = [];
  for (let i = 0; i < MAX_NOTE_HASHES_PER_TX; i++) nonces.push(await h.nonce(txEffect.firstNullifier, i));
  const out: boolean[] = [];
  for (const c of candidates) {
    const siloed = await h.silo(c.contract, c.inner);
    let found = false;
    for (const nonce of nonces) {
      if (inTx.has(normalizeField(await h.unique(nonce, siloed)))) { found = true; break; }
    }
    out.push(found);
  }
  return out;
}

/**
 * Which of a player's own prepared notes — the five returns in their record
 * and their reward note — `txEffect` released. Ground truth about a
 * resolution nobody described: the returns are pushed by the NFT contract,
 * the reward by the token contract.
 */
export async function releasedPreparedNotes(
  txEffect: TxEffectData,
  ownRecord: GameRecord,
  addresses: { nft: string; token?: string },
  hasher?: NoteHasher,
): Promise<{ returns: boolean[]; reward: boolean }> {
  const candidates = Array.from({ length: CARDS_PER_HAND }, (_, i) => ({
    contract: addresses.nft,
    inner: ownRecord[RECORD_RETURNS + i],
  }));
  if (addresses.token) candidates.push({ contract: addresses.token, inner: ownRecord[RECORD_REWARD] });
  const found = await findReleasedNotes(txEffect, candidates, hasher);
  return { returns: found.slice(0, CARDS_PER_HAND), reward: addresses.token ? found[CARDS_PER_HAND] : false };
}
