/**
 * The sweep is the ONLY route back from a wedged game: the bot only joins, and
 * cancel is creator-only. Every branch here is "do five cards come back, or
 * not", so the tests are about what it refuses to do as much as what it does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GameJournal, type GameRecord } from '../src/GameJournal.js';
import { AbandonmentSweep, GAME_STATUS } from '../src/AbandonmentSweep.js';

vi.mock('../../frontend/src/aztec/settlementArgs.js', () => ({
  buildClaimAbandonedArgs: vi.fn(async () => ['claim-args']),
  buildSettleAbandonedArgs: vi.fn(async () => ['settle-args']),
  waitForDisputeWindow: vi.fn(async () => {}),
  DISPUTE_BLOCKS: 5,
}));
vi.mock('../../frontend/src/aztec/noteImporter.js', () => ({
  fetchTxEffectData: vi.fn(async () => ({ noteHashes: ['0x1'], firstNullifier: '0x2' })),
}));
vi.mock('@aztec/aztec.js/fields', () => ({ Fr: class {} }));
vi.mock('@aztec/aztec.js/addresses', () => ({ AztecAddress: { fromStringUnsafe: (s: string) => s } }));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sweep-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks(); });

const PROOF = { proof: 'p', publicInputs: ['0x0'], startStateHash: 's', endStateHash: 'e' };

function record(over: Partial<GameRecord> = {}): GameRecord {
  return {
    onChainGameId: '0xgame1',
    relayGameId: 'g1',
    botAddress: '0xbot',
    opponentAddress: '0xopp',
    botIsPlayer1: false,
    cardIds: [1, 2, 3, 4, 5],
    randomness: ['0x1', '0x2', '0x3', '0x4', '0x5', '0x6'],
    blindingFactor: '0xb1',
    opponentCardIds: [10, 11, 12, 13, 14],
    myHandProof: { proof: 'h', publicInputs: ['0x1', '0x0'] },
    opponentHandProof: { proof: 'oh', publicInputs: ['0x2', '0x0'] },
    moveProofs: [PROOF, PROOF, PROOF],
    committedAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function harness(status: number, over: Record<string, any> = {}) {
  const calls: string[] = [];
  const journal = new GameJournal(dir);
  const chain = {
    address: '0xbot',
    nodeClient: { getBlockNumber: async () => 100 },
    pxe: {
      readGameStatus: over.readGameStatus ?? (async () => status),
      sendClaimAbandonedGame: async () => { calls.push('claim'); return '0xclaimtx'; },
      sendSettleAbandonedGame: async () => { calls.push('settle'); return '0xsettletx'; },
      importCardNotes: async (_o: string, _t: string, notes: any[]) => {
        calls.push(`import:${notes.map(n => n.tokenId).join(',')}`);
        return notes.map(n => n.tokenId);
      },
      ...over.pxe,
    },
  };
  const proofs = {
    verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
    dummyVerificationKey: async () => new Uint8Array([3]),
    proveDummy: async () => 'ZHVtbXk=',
  };
  const sweep = new AbandonmentSweep({
    journal, chain: chain as any, proofs: proofs as any,
    log: () => {}, now: () => 10_000_000, minAgeMs: 1_000, ...over.sweepOpts,
  });
  return { sweep, journal, calls, chain };
}

describe('AbandonmentSweep', () => {
  it('claims and settles a genuinely abandoned game, then forgets it', async () => {
    const h = harness(GAME_STATUS.active);
    h.journal.write(record());

    const stats = await h.sweep.run();

    // The import is not optional bookkeeping: settle_abandoned_game re-mints via
    // create_and_push_note, which the PXE cannot discover, so without it the
    // cards are ours on-chain and invisible in the wallet.
    expect(h.calls).toEqual(['claim', 'settle', 'import:1,2,3,4,5']);
    expect(stats.recovered).toBe(1);
    expect(stats.cardsRecovered).toBe(5);
    // Forgotten, or the next pass chases a game that is already resolved.
    expect(h.journal.outstanding()).toHaveLength(0);
  });

  it('does NOT touch a game that is still young — it may simply be slow', async () => {
    const h = harness(GAME_STATUS.active, { sweepOpts: { minAgeMs: 60 * 60_000 } });
    h.journal.write(record({ committedAt: 9_999_000 }));

    const stats = await h.sweep.run();

    // Claiming a LIVE game is both wrong and rejected on-chain.
    expect(h.calls).toEqual([]);
    expect(stats.skipped).toBe(1);
    expect(h.journal.outstanding()).toHaveLength(1);
  });

  it('forgets a game that settled normally without claiming anything', async () => {
    const h = harness(GAME_STATUS.settled);
    h.journal.write(record());

    await h.sweep.run();

    expect(h.calls).toEqual([]);
    expect(h.journal.outstanding()).toHaveLength(0);
  });

  it('finishes the job when a claim already landed but settle did not', async () => {
    const h = harness(GAME_STATUS.abandoned_claimed);
    h.journal.write(record());

    await h.sweep.run();

    // Re-claiming would revert; settling is what is actually outstanding.
    expect(h.calls).toEqual(['settle', 'import:1,2,3,4,5']);
  });

  it('keeps the record when recovery FAILS, so the cards are not forgotten', async () => {
    const h = harness(GAME_STATUS.active, {
      pxe: { sendClaimAbandonedGame: async () => { throw new Error('node down'); } },
    });
    h.journal.write(record());

    const stats = await h.sweep.run();

    expect(stats.failed).toBe(1);
    expect(stats.lastError).toMatch(/node down/);
    expect(h.journal.outstanding()).toHaveLength(1);
  });

  it('reports a transcript it cannot claim with, rather than retrying forever in silence', async () => {
    const h = harness(GAME_STATUS.active);
    h.journal.write(record({ myHandProof: null }));

    const stats = await h.sweep.run();

    expect(h.calls).toEqual([]);
    expect(stats.skipped).toBe(1);
  });

  it('claims a game abandoned before ANY move was played', async () => {
    const h = harness(GAME_STATUS.active);
    // The opponent vanished between our join and their first move. Refusing
    // this claim was leaving both hands locked with no route back at all.
    h.journal.write(record({ moveProofs: [] }));

    const stats = await h.sweep.run();

    expect(h.calls).toEqual(['claim', 'settle', 'import:1,2,3,4,5']);
    expect(stats.recovered).toBe(1);
    // Only our own five come back — nobody forfeits a card here either.
    const { buildSettleAbandonedArgs } = await import('../../frontend/src/aztec/settlementArgs.js');
    expect(vi.mocked(buildSettleAbandonedArgs).mock.calls[0][0])
      .toMatchObject({ myCardIds: [1, 2, 3, 4, 5] });
  });

  it('refuses a full 9-move chain — that is a normal settlement, not an abandonment', async () => {
    const h = harness(GAME_STATUS.active);
    h.journal.write(record({ moveProofs: Array(9).fill(PROOF) }));

    const stats = await h.sweep.run();

    expect(h.calls).toEqual([]);
    expect(stats.skipped).toBe(1);
  });

  it('never takes an opponent card, however much they played', async () => {
    const h = harness(GAME_STATUS.active);
    h.journal.write(record({ moveProofs: [PROOF, PROOF, PROOF, PROOF] }));

    await h.sweep.run();

    // Recovery returns OUR stake and nothing else. Taking one of the opponent's
    // cards meant naming it from a list nothing verified — any card, minted to
    // us. Nobody wins a card because an opponent disconnected.
    const { buildSettleAbandonedArgs } = await import('../../frontend/src/aztec/settlementArgs.js');
    const call = vi.mocked(buildSettleAbandonedArgs).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(call).not.toHaveProperty('claimedCardId');
    expect(call).not.toHaveProperty('opponentCardIds');
    expect(call).toMatchObject({ myCardIds: [1, 2, 3, 4, 5], myBlinding: '0xb1' });
    expect(h.calls).toEqual(['claim', 'settle', 'import:1,2,3,4,5']);
  });

  it('refuses a game journalled without a blinding factor', async () => {
    const h = harness(GAME_STATUS.active);
    h.journal.write(record({ blindingFactor: null }));

    const stats = await h.sweep.run();

    // Recovery must prove the ids it re-mints, and this is the only value that
    // binds them. Better to say so than to burn a claim that cannot settle.
    expect(h.calls).toEqual([]);
    expect(stats.skipped).toBe(1);
  });

  it('does not run concurrently with itself', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const h = harness(GAME_STATUS.active, {
      readGameStatus: async () => { await gate; return GAME_STATUS.active; },
    });
    h.journal.write(record());

    const first = h.sweep.run();
    // A second claim on the same game wastes a whole proving run and reverts.
    await h.sweep.run();
    expect(h.calls).toEqual([]);
    release();
    await first;
    expect(h.calls).toEqual(['claim', 'settle', 'import:1,2,3,4,5']);
  });

  it('survives a corrupt journal entry without discarding it', async () => {
    const h = harness(GAME_STATUS.active);
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    h.journal.write(record());

    await h.sweep.run();

    // The good one recovers; the corrupt file stays on disk, because deleting it
    // would silently throw away the only record that five cards are locked.
    expect(h.calls).toEqual(['claim', 'settle', 'import:1,2,3,4,5']);
    expect(readdirSync(dir)).toContain('broken.json');
  });
});

describe('AbandonmentSweep note import', () => {
  it('imports the claimed opponent card too, using randomness slot 5', async () => {
    const h = harness(GAME_STATUS.active);
    h.journal.write(record({ moveProofs: [PROOF, PROOF] }));   // opponent played

    await h.sweep.run();

    // The contract mints the claimed card with caller_randomness[5]; missing it
    // means winning the card on-chain and never receiving it.
    expect(h.calls).toContain('import:1,2,3,4,5');
  });

  it('still counts the recovery when the note import fails', async () => {
    const { fetchTxEffectData } = await import('../../frontend/src/aztec/noteImporter.js');
    vi.mocked(fetchTxEffectData).mockResolvedValueOnce(null as any);
    const h = harness(GAME_STATUS.active);
    h.journal.write(record());

    const stats = await h.sweep.run();

    // The settle landed: the cards ARE ours on-chain. A later sweep or resync
    // can surface them, so this is not a failed recovery.
    expect(stats.recovered).toBe(1);
    expect(h.calls).toEqual(['claim', 'settle']);
  });
});

describe('AbandonmentSweep with per-player recovery', () => {
  it('forgets a game whose stake it has already recovered', async () => {
    // Recovery is per player now, so a game sits at `abandoned_claimed` until
    // BOTH sides take their cards back — and the absent one may never return.
    // The status therefore cannot tell us whether WE are done; only trying can.
    const h = harness(GAME_STATUS.abandoned_claimed, {
      pxe: {
        sendSettleAbandonedGame: async () => {
          throw new Error('Assertion failed: Already recovered for this player');
        },
      },
    });
    h.journal.write(record());

    const stats = await h.sweep.run();

    // Kept, this record would be retried on every pass forever.
    expect(h.journal.outstanding()).toHaveLength(0);
    expect(stats.failed).toBe(0);
  });
});

describe('permanently unrecoverable games', () => {
  /**
   * A game whose journal is missing a hand proof can never be claimed — the
   * claim verifies both. That is a fact about the record, not an event, and it
   * was being announced every fifteen minutes forever. A recurring alarm for a
   * state that will never change is how real alarms get ignored.
   */
  function unrecoverableDeps() {
    const logs: string[] = [];
    const rec = {
      onChainGameId: '0xdead', relayGameId: 'g', botAddress: '0xbot', opponentAddress: '0xopp',
      botIsPlayer1: false, cardIds: [1, 2, 3, 4, 5], randomness: ['0x1'], blindingFactor: '0xb',
      opponentCardIds: [], myHandProof: { proof: 'p', publicInputs: [] },
      opponentHandProof: null,           // the missing half
      moveProofs: [], committedAt: 0, updatedAt: 0,
    };
    return { logs, rec };
  }

  it('reports an unrecoverable game once, then counts it instead', async () => {
    const { logs, rec } = unrecoverableDeps();
    const sweep = new AbandonmentSweep({
      journal: {
        outstanding: () => [rec], forget: () => {}, write: () => {}, read: () => rec,
        markSettled: () => {}, pruneSettled: () => 0,
      } as never,
      // 2 = active: the game really is outstanding, which is what gets the
      // sweep as far as inspecting the transcript.
      chain: {
        address: '0xbot', nodeClient: {},
        pxe: { readGameStatus: async () => 2 },
      } as never,
      proofs: {} as never,
      log: (m: string) => logs.push(m),
      minAgeMs: 0,
    });

    await sweep.run();
    await sweep.run();
    await sweep.run();

    const reports = logs.filter(l => l.includes('UNRECOVERABLE'));
    expect(reports, 'said once, not once per pass').toHaveLength(1);
    // The cards are still locked, and that stays visible as a number.
    expect(sweep.stats.unrecoverable).toBe(5);
  });
});
