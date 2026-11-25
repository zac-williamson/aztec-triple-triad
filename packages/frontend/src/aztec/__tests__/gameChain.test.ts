// @vitest-environment node
// bb.js (behind the SDK's poseidon2) needs Node's typed arrays, not jsdom's.
/**
 * Node reads for a private game: nullifier lookups (the only game state there
 * is), the block a nullifier landed in, that block's time, the tx that holds
 * a nullifier, and which of a player's prepared notes a tx released.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  blockTimestamp,
  findReleasedNotes,
  findTxWithNullifier,
  lookupNullifiers,
  readGameChainState,
  releasedPreparedNotes,
  waitForNullifier,
  type NoteHasher,
} from '../gameChain';
import { GAME_NULLIFIER_COUNT, normalizeField, NULLIFIER_INDEX } from '../privateGame';
import { record } from './privateGameFixtures';

const f = (n: number) => normalizeField(BigInt(n));

/** A node that knows some nullifiers, each in a block. */
function nodeWith(known: Record<string, number>, extra: Record<string, unknown> = {}) {
  return {
    findLeavesIndexes: vi.fn(async (_ref: string, treeId: number, leaves: { toString(): string }[]) => {
      expect(treeId).toBe(0); // MerkleTreeId.NULLIFIER_TREE
      return leaves.map(l => {
        const b = known[normalizeField(l.toString())];
        return b === undefined ? undefined : { data: 1n, l2BlockNumber: b, l2BlockHash: {} };
      });
    }),
    getBlock: vi.fn(),
    ...extra,
  };
}

describe('nullifier lookups', () => {
  it('asks the node once, in the nullifier tree at the latest block, and keeps the order', async () => {
    const node = nodeWith({ [f(7)]: 41, [f(9)]: 44 });
    const hits = await lookupNullifiers(node, [f(7), f(8), f(9)]);
    expect(hits).toEqual([{ blockNumber: 41 }, null, { blockNumber: 44 }]);
    expect(node.findLeavesIndexes).toHaveBeenCalledTimes(1);
    expect(node.findLeavesIndexes.mock.calls[0][0]).toBe('latest');
  });

  it('reads a whole game from its 21 nullifiers', async () => {
    const nullifiers = Array.from({ length: GAME_NULLIFIER_COUNT }, (_, i) => f(1000 + i));
    const node = nodeWith({
      [nullifiers[NULLIFIER_INDEX.created]]: 10,
      [nullifiers[NULLIFIER_INDEX.joined]]: 12,
      [nullifiers[NULLIFIER_INDEX.seat2]]: 12,
    });
    const state = await readGameChainState(node, nullifiers);
    expect(state.created).toEqual({ blockNumber: 10 });
    expect(state.joined).toEqual({ blockNumber: 12 });
    expect(state.done).toBeNull();
  });

  it('fails loudly on a node that answers for the wrong number of leaves', async () => {
    const node = { findLeavesIndexes: async () => [undefined], getBlock: vi.fn() };
    await expect(lookupNullifiers(node, [f(1), f(2)])).rejects.toThrow(/2 nullifiers/);
  });

  it('waits for a nullifier to land, and gives up at its bound', async () => {
    const known: Record<string, number> = {};
    const node = nodeWith(known);
    setTimeout(() => { known[f(5)] = 77; }, 15);
    await expect(waitForNullifier(node, f(5), 'created', { pollMs: 5, maxMs: 2000 })).resolves.toEqual({ blockNumber: 77 });
    await expect(waitForNullifier(node, f(6), 'never', { pollMs: 5, maxMs: 20 })).rejects.toThrow(/never: not on-chain/);
  });

  it('stops waiting when the caller says so', async () => {
    const node = nodeWith({});
    await expect(waitForNullifier(node, f(5), 'x', { pollMs: 5, check: () => { throw new Error('left the game'); } }))
      .rejects.toThrow('left the game');
  });
});

describe('blocks and transactions', () => {
  it('reads a block\'s timestamp from its header', async () => {
    const node = { getBlockData: async (n: number) => ({ header: { globalVariables: { timestamp: BigInt(1000 + n) } } }) };
    expect(await blockTimestamp(node, 5)).toBe(1005);
    await expect(blockTimestamp({ getBlockData: async () => undefined }, 5)).rejects.toThrow(/not found/);
  });

  it('finds the tx in a block that emitted a nullifier, with what import_note needs', async () => {
    const effect = (hash: string, nullifiers: number[], notes: number[]) => ({
      txHash: { toString: () => hash },
      nullifiers: nullifiers.map(n => ({ toString: () => f(n) })),
      noteHashes: notes.map(n => ({ toString: () => f(n) })),
    });
    const getBlock = vi.fn(async () => ({
      body: { txEffects: [effect('0xaaa', [1, 2], [3]), effect('0xbbb', [4, 5, 6], [7, 0, 8])] },
    }));
    const found = await findTxWithNullifier({ getBlock }, 90, f(5));
    expect(getBlock).toHaveBeenCalledWith(90, { includeTransactions: true });
    expect(found).toEqual({ txHash: '0xbbb', noteHashes: [f(7), f(8)], firstNullifier: f(4) });
    expect(await findTxWithNullifier({ getBlock }, 90, f(99))).toBeNull();
  });
});

describe('which prepared notes a tx released', () => {
  // A transparent stand-in for the protocol hashes: easy to reason about.
  const hasher: NoteHasher = {
    silo: async (contract, inner) => normalizeField(BigInt(contract) * 1000n + BigInt(inner)),
    nonce: async (first, i) => normalizeField(BigInt(first) + BigInt(i)),
    unique: async (nonce, siloed) => normalizeField(BigInt(nonce) * 7n + BigInt(siloed)),
  };
  const unique = async (contract: string, inner: string, first: string, i: number) =>
    hasher.unique(await hasher.nonce(first, i), await hasher.silo(contract, inner));

  it('finds a note under whichever index its nonce used', async () => {
    const first = f(500);
    const noteHashes = [await unique('0x2', f(11), first, 0), await unique('0x2', f(13), first, 37)];
    const found = await findReleasedNotes({ noteHashes, firstNullifier: first }, [
      { contract: '0x2', inner: f(11) },
      { contract: '0x2', inner: f(12) },
      { contract: '0x2', inner: f(13) },
      { contract: '0x3', inner: f(11) }, // right note, wrong contract
    ], hasher);
    expect(found).toEqual([true, false, true, false]);
  });

  it('reads a player\'s five returns (NFT) and their reward (token) off a tx', async () => {
    const own = record(4);
    const first = f(900);
    // Returns of slots 0, 1, 3, 4 and the reward: slot 2 was the prize.
    const noteHashes = await Promise.all([
      unique('0x2', own[2], first, 0), unique('0x2', own[3], first, 1),
      unique('0x2', own[5], first, 2), unique('0x2', own[6], first, 3),
      unique('0x3', own[8], first, 4),
    ]);
    const released = await releasedPreparedNotes({ noteHashes, firstNullifier: first }, own, { nft: '0x2', token: '0x3' }, hasher);
    expect(released).toEqual({ returns: [true, true, false, true, true], reward: true });
  });

  it('agrees with the SDK\'s own siloing and nonce hashes', async () => {
    // Plumbing check against the real implementation: Fr / address
    // conversions and argument order. Protocol-level correctness is the SDK's.
    const { siloNoteHash, computeNoteHashNonce, computeUniqueNoteHash } = await import('@aztec-labs/stdlib/hash');
    const { Fr } = await import('@aztec-labs/aztec.js/fields');
    const { AztecAddress } = await import('@aztec-labs/aztec.js/addresses');
    const nft = '0x' + '11'.repeat(32).slice(0, 62) + '01';
    const inner = Fr.fromHexString(f(4242));
    const first = Fr.fromHexString(f(777));
    const siloed = await siloNoteHash(AztecAddress.fromStringUnsafe(nft), inner);
    const uniqueHash = await computeUniqueNoteHash(await computeNoteHashNonce(first, 3), siloed);
    const found = await findReleasedNotes(
      { noteHashes: [f(1), uniqueHash.toString()], firstNullifier: first.toString() },
      [{ contract: nft, inner: f(4242) }, { contract: nft, inner: f(4243) }],
    );
    expect(found).toEqual([true, false]);
  }, 60_000);
});
