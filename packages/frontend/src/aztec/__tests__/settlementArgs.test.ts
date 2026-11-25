import { describe, it, expect, vi } from 'vitest';
import { normalizeField } from '../privateGame';
import { record, stateHash, transcript } from './privateGameFixtures';

// The canonical initial hash is a pedersen hash in bb.js; the transcript
// fixtures start their chain at stateHash(0) instead.
vi.mock('../proofWorker', () => ({
  computeBoardStateHash: vi.fn(async () => stateHash(0)),
}));

import {
  assertForfeitTerms,
  buildClaimForfeitArgs,
  buildSettleGameArgs,
  chooseForfeit,
  MOVE_PUBLIC_INPUTS,
  NO_FORFEIT,
  NO_FORFEIT_TERMS,
  sortProofChain,
} from '../settlementArgs';

class FakeFr {
  constructor(public v: bigint) {}
  static fromHexString(s: string) { return new FakeFr(BigInt(s)); }
  toString() { return '0x' + this.v.toString(16); }
}

const link = (start: string, end: string) => ({ startStateHash: start, endStateHash: end });

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
 * `settle_game(game_key, record_1, record_2, move_vk, 9 x (proof, inputs[8]),
 * prize_move)` — one flat, order-critical list, rejected only on-chain (after
 * the recursive verification) when it is wrong.
 */
describe('buildSettleGameArgs', () => {
  const vk = new Uint8Array(64).map((_, i) => i);
  const inputs = (over: Partial<Parameters<typeof buildSettleGameArgs>[0]> = {}) => ({
    Fr: FakeFr,
    gameKey: normalizeField(0x6a3en),
    record1: record(1),
    record2: record(2),
    moveVk: vk,
    moveProofs: transcript({ winner: 1 }),
    prizeMove: 3,
    ...over,
  });

  it('lays out key, both records, the VK, nine chained (proof, inputs) pairs and the prize move', async () => {
    const t = transcript({ winner: 1 });
    const shuffled = [t[5], t[0], t[8], t[3], t[1], t[7], t[2], t[6], t[4]];
    const args = await buildSettleGameArgs(inputs({ moveProofs: shuffled })) as any[];

    expect(args).toHaveLength(1 + 2 + 1 + 18 + 1);
    expect(args[0].v).toBe(0x6a3en);
    expect(args[1].map((f: FakeFr) => f.v)).toEqual(record(1).map(v => BigInt(v)));
    expect(args[2].map((f: FakeFr) => f.v)).toEqual(record(2).map(v => BigInt(v)));
    expect(args[3]).toHaveLength(2); // 64 bytes of VK → 2 fields
    for (let i = 0; i < 9; i++) {
      const proofFields = args[4 + 2 * i] as FakeFr[];
      const inputFields = args[5 + 2 * i] as FakeFr[];
      // Chained into move order, whatever order they arrived in.
      expect(inputFields.map(f => f.v)).toEqual(t[i].publicInputs.map(v => BigInt(v)));
      expect(inputFields).toHaveLength(MOVE_PUBLIC_INPUTS);
      expect(proofFields.length).toBeGreaterThan(0);
    }
    expect(args[22].v).toBe(3n);
  });

  it('refuses a move proof with the old six public inputs', async () => {
    const t = transcript({ winner: 1 });
    t[4] = { ...t[4], publicInputs: t[4].publicInputs.slice(0, 6) };
    await expect(buildSettleGameArgs(inputs({ moveProofs: t }))).rejects.toThrow(/6 public inputs/);
  });

  it('refuses a prize move outside the board, and a record of the wrong length', async () => {
    await expect(buildSettleGameArgs(inputs({ prizeMove: 9 }))).rejects.toThrow(/prize_move/);
    await expect(buildSettleGameArgs(inputs({ prizeMove: -1 }))).rejects.toThrow(/prize_move/);
    await expect(buildSettleGameArgs(inputs({ record2: record(2).slice(0, 8) }))).rejects.toThrow(/9-field records/);
  });

  it('refuses a broken transcript locally rather than on-chain', async () => {
    const t = transcript({ winner: 1 });
    await expect(buildSettleGameArgs(inputs({ moveProofs: t.slice(0, 8) }))).rejects.toThrow(/Proof chain broken at step 8/);
  });
});

/**
 * Waiting out the dispute window on the CHAIN's clock, from the claim's block.
 *
 * A claim time of 0 means no time at all: as a timestamp it is 1970, the
 * elapsed window is astronomical and the wait returns at once — finalizing
 * early, reverting, and telling the player their recovery failed after they
 * paid for the proof.
 */
describe('waitForDisputeWindow', () => {
  const node = (chainSeconds: number) => ({
    getBlockNumber: async () => 1,
    getBlock: async () => ({ header: { globalVariables: { timestamp: chainSeconds } } }),
  });

  it('refuses a zero claim time instead of treating it as long ago', async () => {
    const { waitForDisputeWindow } = await import('../settlementArgs');
    await expect(waitForDisputeWindow(node(1_700_000) as any, 0))
      .rejects.toThrow(/No time for the claim/);
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

describe('waitForAbandonBar', () => {
  const node = (chainSeconds: number) => ({
    getBlockNumber: async () => 1,
    getBlock: async () => ({ header: { globalVariables: { timestamp: chainSeconds } } }),
  });

  it('waits MIN_ABANDON_SECONDS of chain time from the clock block', async () => {
    const { waitForAbandonBar, MIN_ABANDON_SECONDS } = await import('../settlementArgs');
    await expect(waitForAbandonBar(node(1_000 + MIN_ABANDON_SECONDS) as any, 1_000)).resolves.toBeUndefined();
    const progress: number[] = [];
    await expect(waitForAbandonBar(node(1_100) as any, 1_000, { maxMs: 1, pollMs: 1, onProgress: s => progress.push(s) }))
      .rejects.toThrow(/abandonment bar did not pass/);
    expect(progress[0]).toBe(MIN_ABANDON_SECONDS - 100);
  });

  it('refuses a game with no clock time', async () => {
    const { waitForAbandonBar } = await import('../settlementArgs');
    await expect(waitForAbandonBar(node(5) as any, 0)).rejects.toThrow(/no clock time/);
  });
});

describe('the forfeit a claim carries', () => {
  const OPEN = [11, 12, 13];
  const inputs = (cards = OPEN) => [normalizeField(0x77n), ...cards.map(c => normalizeField(BigInt(c)))];
  const proof = Buffer.alloc(32 * 3).toString('base64');

  it('takes the open card the measure rates highest, the lowest slot on a tie', () => {
    const strength = (id: number) => ({ 11: 5, 12: 9, 13: 9 } as Record<number, number>)[id] ?? 0;
    expect(chooseForfeit(OPEN, strength)).toEqual({ slot: 1, cardId: 12 });
    expect(chooseForfeit(OPEN, () => 1)).toEqual({ slot: 0, cardId: 11 });
    expect(() => chooseForfeit([11, 12], () => 1)).toThrow(/3 open cards/);
  });

  it('terms must name the open card in their slot, or nothing', () => {
    assertForfeitTerms({ slot: 2, cardId: 13 }, OPEN);
    assertForfeitTerms(NO_FORFEIT_TERMS, null);
    expect(() => assertForfeitTerms({ slot: 2, cardId: 12 }, OPEN)).toThrow(/not the open card in slot 2/);
    expect(() => assertForfeitTerms({ slot: 3, cardId: 12 }, OPEN)).toThrow(/takes nothing names card 0/);
    expect(() => assertForfeitTerms({ slot: 4, cardId: 0 }, OPEN)).toThrow(/open card \(0\.\.2\) or none/);
    expect(() => assertForfeitTerms({ slot: 0, cardId: 11 }, null)).toThrow(/not the open card/);
  });

  it('builds [hand_vk, open_proof, open_inputs, forfeit_slot] from the proof that names the card', async () => {
    const args = await buildClaimForfeitArgs(FakeFr, new Uint8Array(32 * 2), {
      terms: { slot: 1, cardId: 12 }, proof, publicInputs: inputs(),
    }) as any[];
    expect(args).toHaveLength(4);
    expect(args[0]).toHaveLength(2);          // the VK, as fields
    expect(args[1]).toHaveLength(3);          // the proof, as fields
    expect(args[2].map((f: FakeFr) => f.v)).toEqual([0x77n, 11n, 12n, 13n]);
    expect(args[3].v).toBe(1n);
  });

  it('refuses terms the proof does not support, before anything is sent', async () => {
    await expect(buildClaimForfeitArgs(FakeFr, new Uint8Array(32), { terms: { slot: 0, cardId: 99 }, proof, publicInputs: inputs() }))
      .rejects.toThrow(/not the open card in slot 0/);
    await expect(buildClaimForfeitArgs(FakeFr, new Uint8Array(32), { terms: NO_FORFEIT_TERMS, proof, publicInputs: inputs().slice(0, 3) }))
      .rejects.toThrow(/4/);
    const none = await buildClaimForfeitArgs(FakeFr, new Uint8Array(32), { terms: NO_FORFEIT_TERMS, proof, publicInputs: inputs() }) as any[];
    expect(none[3].v).toBe(BigInt(NO_FORFEIT));
  });
});
