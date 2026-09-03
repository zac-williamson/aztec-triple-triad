import { describe, it, expect } from 'vitest';
import { padToHand, sortProofChain } from '../settlementArgs';

class FakeFr { constructor(public v: bigint) {} }

const link = (start: string, end: string) => ({ startStateHash: start, endStateHash: end });

describe('padToHand', () => {
  it('pads a short hand to five and converts to field elements', () => {
    const out = padToHand(FakeFr as any, [3, 7]) as any[];
    expect(out).toHaveLength(5);
    expect(out.map(f => f.v)).toEqual([3n, 7n, 0n, 0n, 0n]);
  });

  it('truncates anything longer than a hand', () => {
    expect(padToHand(FakeFr as any, [1, 2, 3, 4, 5, 6, 7])).toHaveLength(5);
  });
});

describe('sortProofChain', () => {
  it('orders proofs by chaining end hash to start hash', () => {
    const shuffled = [link('b', 'c'), link('a', 'b'), link('c', 'd')];
    const sorted = sortProofChain(shuffled, 3, 'a');
    expect(sorted.map(p => p.startStateHash)).toEqual(['a', 'b', 'c']);
  });

  it('throws at the exact step where the chain breaks', () => {
    // 'b'->'c' is missing, so step 1 cannot be satisfied.
    expect(() => sortProofChain([link('a', 'b'), link('c', 'd')], 3, 'a'))
      .toThrow('Proof chain broken at step 1');
  });

  it('throws rather than returning a short chain', () => {
    expect(() => sortProofChain([link('a', 'b')], 3, 'a')).toThrow(/step 1/);
  });

  it('rejects a chain that does not start at the canonical initial hash', () => {
    expect(() => sortProofChain([link('a', 'b'), link('b', 'c')], 2, 'WRONG'))
      .toThrow('Proof chain broken at step 0');
  });

  it('returns exactly `count` proofs even when given extras', () => {
    const chain = [link('a', 'b'), link('b', 'c'), link('c', 'd'), link('d', 'e')];
    expect(sortProofChain(chain, 2, 'a')).toHaveLength(2);
  });
});

/**
 * A COMPLETE transcript is a legal abandonment claim.
 *
 * It used to throw here, mirroring a contract that capped `num_valid_moves` at
 * 8. That cap made the single most recoverable situation unrecoverable: a game
 * that ran all nine moves and whose winner then vanished has a whole transcript
 * and a settlement that is provably owed, yet neither side could act — the
 * loser was refused, and the winner was gone. Ten cards locked forever.
 *
 * The contract now accepts 9 and skips its turn-parity check there, because a
 * finished game has nobody whose turn it is. This guard has to agree, or the
 * claim is refused in the browser before it ever reaches the chain.
 */
describe('buildClaimAbandonedArgs move-count guard', () => {
  const moves = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      proof: '', publicInputs: [], startStateHash: `${i}`, endStateHash: `${i + 1}`,
    }));

  /** Reach the guard and report only whether it let us past. */
  async function rejectsAt(n: number): Promise<boolean> {
    const { buildClaimAbandonedArgs } = await import('../settlementArgs');
    try {
      await buildClaimAbandonedArgs({
        Fr: FakeFr as any,
        onChainGameId: '0x1',
        callerIsPlayer1: true,
        handVk: new Uint8Array(), moveVk: new Uint8Array(), dummyVk: new Uint8Array(),
        handProof1: { proof: '', publicInputs: [] },
        handProof2: { proof: '', publicInputs: [] },
        validMoveProofs: moves(n),
        makeDummyProof: async () => '',
      } as any);
      return false;
    } catch (err) {
      // Only the guard's own message counts as a rejection; anything else means
      // we got PAST it and failed later on the fake Fr, which is a pass.
      return /valid move proofs/.test((err as Error).message);
    }
  }

  it('accepts a complete nine-move transcript', async () => {
    expect(await rejectsAt(9), 'a finished game is exactly what n == 9 is for').toBe(false);
  });

  it('still accepts a partial transcript', async () => {
    expect(await rejectsAt(4)).toBe(false);
  });

  it('accepts zero moves — someone who left before their first turn', async () => {
    expect(await rejectsAt(0)).toBe(false);
  });

  it('rejects more moves than a board can hold', async () => {
    expect(await rejectsAt(10)).toBe(true);
  });
});

/**
 * The dispute wait must refuse an unknown claim time.
 *
 * `claimAt` is 0 when the contract has no claim on record — which a reader
 * hits by reading before its own claim is visible at its anchor. Treated as a
 * timestamp that is 1970, so the elapsed window is astronomical and the wait
 * returns immediately: settle early, revert, and tell the player their
 * recovery failed after they paid for the proving.
 */
describe('waitForDisputeWindow', () => {
  const node = (chainSeconds: number) => ({
    getBlockNumber: async () => 1,
    getBlock: async () => ({ header: { globalVariables: { timestamp: chainSeconds } } }),
  });

  it('refuses a zero claim time instead of treating it as long ago', async () => {
    const { waitForDisputeWindow } = await import('../settlementArgs');
    await expect(waitForDisputeWindow(node(1_700_000) as any, 0))
      .rejects.toThrow(/No claim on record/);
  });

  it('returns once the window has elapsed in CHAIN time', async () => {
    const { waitForDisputeWindow, DISPUTE_SECONDS } = await import('../settlementArgs');
    await expect(waitForDisputeWindow(node(1_700_000 + DISPUTE_SECONDS) as any, 1_700_000))
      .resolves.toBeUndefined();
  });

  it('does not return early when the window is still open', async () => {
    const { waitForDisputeWindow } = await import('../settlementArgs');
    await expect(waitForDisputeWindow(node(1_700_100) as any, 1_700_000, { maxMs: 1, pollMs: 1 }))
      .rejects.toThrow(/Dispute window did not open/);
  });
});
