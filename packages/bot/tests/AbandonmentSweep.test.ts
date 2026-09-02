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
  DISPUTE_SECONDS: 600,
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
    // FOUR, not three. The bot is always player 2, and the contract only
    // accepts an abandonment claim when it is the OTHER side's turn — an even
    // move count. A three-move fixture described a game the chain would always
    // refuse to let us claim.
    moveProofs: [PROOF, PROOF, PROOF, PROOF],
    committedAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function harness(status: number, over: Record<string, any> = {}) {
  const calls: string[] = [];
  const journal = new GameJournal(dir);
  // A successful claim moves the game to 5 (abandoned_claimed), and the sweep
  // re-reads the status before settling so that a CONTEST — which puts it back
  // to 2 — is noticed rather than spent a proof on. A mock that answers 2
  // forever would make every settle look contested.
  let claimed = false;
  const chain = {
    address: '0xbot',
    nodeClient: { getBlockNumber: async () => 100 },
    pxe: {
      readGameStatus: over.readGameStatus ?? (async () => (claimed ? 5 : status)),
      readAbandonmentInfo: async () => ({ status: claimed ? 5 : status, activeAt: Math.floor(Date.now()/1000) - 7200, claimAt: claimed ? Math.floor(Date.now()/1000) - 1200 : 0, claimPlayer: '0x0' }),
      sendClaimAbandonedGame: async () => { claimed = true; calls.push('claim'); return '0xclaimtx'; },
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

  it('recovers a full 9-move game whose winner never settled', async () => {
    // This used to be refused as "a normal settlement, not an abandonment",
    // which was right about the OLD contract: a claim capped at eight moves,
    // and settle_game binds the caller to the winning side. So when a winner
    // closed their tab on the result screen, both hands stayed locked with no
    // route out for anybody.
    //
    // The contract accepts n == 9 now. A finished game owes nobody a move, so
    // the turn rule does not apply and either side may claim; recovery is
    // per-player, so each gets back exactly its own stake.
    const h = harness(GAME_STATUS.active);
    h.journal.write(record({ moveProofs: Array(9).fill(PROOF) }));

    const stats = await h.sweep.run();

    expect(h.calls).toEqual(['claim', 'settle', 'import:1,2,3,4,5']);
    expect(stats.recovered).toBe(1);
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
    // Two status reads per game: once to see it is still active, and once
    // after the claim to check nobody contested it. Answering "active" both
    // times would read as a contest and skip the settle.
    let reads = 0;
    const h = harness(GAME_STATUS.active, {
      readGameStatus: async () => {
        await gate;
        reads += 1;
        return reads === 1 ? GAME_STATUS.active : 5;
      },
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
        pxe: { readGameStatus: async () => 2, readAbandonmentInfo: async () => ({ status: 2, activeAt: Math.floor(Date.now()/1000) - 7200, claimAt: 0, claimPlayer: '0x0' }) },
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

describe('yielding to live games', () => {
  /**
   * The sweep and gameplay share one serial PXE queue, and a recovery claim
   * holds it for minutes while it proves and mines. A player matched during a
   * pass would wait behind maintenance for an abandoned game — their opponent
   * never joins and the match dies at move zero. That is exactly what happened
   * in production: "player 1 confirmed on-chain — joining" and then eleven
   * minutes of nothing, because previewJoinGame sat behind the sweep.
   */
  function sweepWith(isBusy: () => boolean, records: number) {
    const logs: string[] = [];
    const scanned: string[] = [];
    const recs = Array.from({ length: records }, (_, i) => ({
      onChainGameId: `0x${i}`, relayGameId: 'g', botAddress: '0xbot', opponentAddress: '0xopp',
      botIsPlayer1: false, cardIds: [1, 2, 3, 4, 5], randomness: ['0x1'], blindingFactor: '0xb',
      opponentCardIds: [], myHandProof: null, opponentHandProof: null, moveProofs: [],
      committedAt: 0, updatedAt: 0,
    }));
    const sweep = new AbandonmentSweep({
      journal: {
        outstanding: () => recs, forget: () => {}, write: () => {}, read: () => recs[0],
        markSettled: () => {}, pruneSettled: () => 0,
      } as never,
      chain: {
        address: '0xbot', nodeClient: {},
        pxe: { readGameStatus: async (_a: string, id: string) => { scanned.push(id); return 2; } },
      } as never,
      proofs: {} as never,
      log: (m: string) => logs.push(m),
      minAgeMs: 0,
      isBusy,
    });
    return { sweep, logs, scanned };
  }

  it('does not start a pass while a game is live', async () => {
    const h = sweepWith(() => true, 3);
    await h.sweep.run();
    expect(h.scanned, 'nothing touched the PXE queue').toHaveLength(0);
    expect(h.logs.join(' ')).toMatch(/deferring to the next pass/);
  });

  it('runs normally when the bot is idle', async () => {
    const h = sweepWith(() => false, 3);
    await h.sweep.run();
    expect(h.scanned.length, 'every outstanding game is inspected').toBe(3);
  });

  it('stops mid-pass if a player gets matched', async () => {
    // A pass spans minutes of chain work; a match can land partway through.
    let busy = false;
    const h = sweepWith(() => busy, 4);
    const chain = (h.sweep as unknown as { deps: { chain: { pxe: { readGameStatus: unknown } } } }).deps.chain;
    chain.pxe.readGameStatus = async (_a: string, id: string) => {
      h.scanned.push(id);
      if (h.scanned.length === 2) busy = true;   // matched after the second
      return 2;
    };
    await h.sweep.run();
    expect(h.scanned.length, 'stopped rather than finishing the queue').toBeLessThan(4);
    expect(h.logs.join(' ')).toMatch(/a game started mid-pass/);
  });
});

describe('yielding between chain steps', () => {
  /**
   * Deferring only at the top of a pass is not enough. A recovery is claim →
   * dispute window → settle → import, and each chain step holds the shared PXE
   * queue for minutes. Production measured sixteen minutes from the bot
   * deciding to join to the join actually starting — while the join transaction
   * itself took forty-four seconds. It was queued behind a sweep, not stuck.
   */
  it('stops after the claim when a game starts, leaving settle for later', async () => {
    let busy = false;
    const logs: string[] = [];
    const steps: string[] = [];
    const rec = {
      onChainGameId: '0xaaa', relayGameId: 'g', botAddress: '0xbot', opponentAddress: '0xopp',
      botIsPlayer1: false, cardIds: [1, 2, 3, 4, 5], randomness: ['0x1'], blindingFactor: '0xb',
      opponentCardIds: [], myHandProof: { proof: 'p', publicInputs: [] },
      opponentHandProof: { proof: 'p', publicInputs: [] }, moveProofs: [],
      committedAt: 0, updatedAt: 0,
    };
    const sweep = new AbandonmentSweep({
      journal: {
        outstanding: () => [rec], forget: () => {}, write: () => {}, read: () => rec,
        markSettled: () => {}, pruneSettled: () => 0,
      } as never,
      chain: {
        address: '0xbot', nodeClient: {},
        pxe: {
          readGameStatus: async () => 2,
          readAbandonmentInfo: async () => ({ status: 2, activeAt: Math.floor(Date.now()/1000) - 7200, claimAt: Math.floor(Date.now()/1000) - 1200, claimPlayer: '0x0' }),
          sendClaimAbandonedGame: async () => {
            steps.push('claim');
            busy = true;          // a player is matched while the claim mines
            return '0x' + 'c'.repeat(64);
          },
          sendSettleAbandonedGame: async () => { steps.push('settle'); return '0xdead'; },
          importCardNotes: async () => [],
        },
      } as never,
      proofs: {
        verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
        dummyVerificationKey: async () => new Uint8Array([3]),
        proveDummy: async () => 'ZHVtbXk=',
      } as never,
      log: (m: string) => logs.push(m),
      minAgeMs: 0,
      isBusy: () => busy,
    });

    await sweep.run();

    expect(steps, 'claimed, but did not go on to settle').toEqual(['claim']);
    expect(logs.join(' ')).toMatch(/settle deferred/);
  });
});

describe('the card count after a recovery', () => {
  it('invalidates the cached card list so the recovery is visible', async () => {
    // `spendableCards` is the number an operator alerts on, and the bot caches
    // the list it comes from. Ten cards came back on production and the count
    // did not move — a stale count hides a real shortage just as easily.
    let invalidated = 0;
    let claimed = false;   // a claim moves the game to status 5
    const rec = {
      onChainGameId: '0xabc', relayGameId: 'g', botAddress: '0xbot', opponentAddress: '0xopp',
      botIsPlayer1: false, cardIds: [1, 2, 3, 4, 5], randomness: ['0x1'], blindingFactor: '0xb',
      opponentCardIds: [], myHandProof: { proof: 'p', publicInputs: [] },
      opponentHandProof: { proof: 'p', publicInputs: [] },
      moveProofs: Array(4).fill({ proof: 'p', publicInputs: [] }),
      committedAt: 0, updatedAt: 0,
    };
    const sweep = new AbandonmentSweep({
      journal: {
        outstanding: () => [rec], forget: () => {}, write: () => {}, read: () => rec,
        markSettled: () => {}, pruneSettled: () => 0,
      } as never,
      chain: {
        address: '0xbot', nodeClient: {},
        invalidateCards: () => { invalidated += 1; },
        pxe: {
          readGameStatus: async () => (claimed ? 5 : 2),
          readAbandonmentInfo: async () => ({ status: claimed ? 5 : 2, activeAt: Math.floor(Date.now()/1000) - 7200, claimAt: claimed ? Math.floor(Date.now()/1000) - 1200 : 0, claimPlayer: '0x0' }),
          sendClaimAbandonedGame: async () => { claimed = true; return '0x' + 'c'.repeat(64); },
          sendSettleAbandonedGame: async () => '0xdead',
          importCardNotes: async () => [1, 2, 3, 4, 5],
        },
      } as never,
      proofs: {
        verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
        dummyVerificationKey: async () => new Uint8Array([3]),
        proveDummy: async () => 'ZHVtbXk=',
      } as never,
      log: () => {},
      minAgeMs: 0,
    });
    await sweep.run();
    expect(sweep.stats.recovered).toBe(1);
    expect(invalidated, 'the cached count must be dropped after cards come back').toBe(1);
  });
});

describe('claims only when the chain would accept one', () => {
  /**
   * The claim is for an opponent who walked away, so the contract requires it
   * to be THEIR turn: player 1 takes the even turns, so a player-2 claimant
   * needs an even move count.
   *
   * Getting that wrong cost twice. First the sweep retried an odd count every
   * fifteen minutes for hours, spending a proof and a transaction on an
   * assertion that cannot pass. Then it gave up on odd counts entirely — also
   * wrong, because the contract needs the first n proofs to CHAIN and n to
   * have the right parity, not n to be the whole game; nothing on-chain
   * records how far the game got. The answer is the largest prefix with the
   * right parity, which is always available.
   *
   * Nobody is short-changed by the shorter n: settle_abandoned_game returns
   * only the caller's own stake and works per player, so parity decides who
   * may FILE the claim, not who gets what.
   */
  function sweepFor(moves: number, botIsPlayer1 = false) {
    const logs: string[] = [];
    const claims: string[] = [];
    const rec = {
      onChainGameId: '0xabc', relayGameId: 'g', botAddress: '0xbot', opponentAddress: '0xopp',
      botIsPlayer1, cardIds: [1, 2, 3, 4, 5], randomness: ['0x1'], blindingFactor: '0xb',
      opponentCardIds: [], myHandProof: { proof: 'p', publicInputs: [] },
      opponentHandProof: { proof: 'p', publicInputs: [] },
      moveProofs: Array(moves).fill({ proof: 'p', publicInputs: [] }),
      committedAt: 0, updatedAt: 0,
    };
    const sweep = new AbandonmentSweep({
      journal: {
        outstanding: () => [rec], forget: () => {}, write: () => {}, read: () => rec,
        markSettled: () => {}, pruneSettled: () => 0,
      } as never,
      chain: {
        address: '0xbot', nodeClient: {},
        pxe: {
          readGameStatus: async () => 2,
          readAbandonmentInfo: async () => ({ status: 2, activeAt: Math.floor(Date.now()/1000) - 7200, claimAt: Math.floor(Date.now()/1000) - 1200, claimPlayer: '0x0' }),
          sendClaimAbandonedGame: async () => { claims.push('claim'); return '0x' + 'c'.repeat(64); },
          sendSettleAbandonedGame: async () => '0xdead',
          importCardNotes: async () => [],
        },
      } as never,
      proofs: {
        verificationKeys: async () => ({ handVk: new Uint8Array([1]), moveVk: new Uint8Array([2]) }),
        dummyVerificationKey: async () => new Uint8Array([3]),
        proveDummy: async () => 'ZHVtbXk=',
      } as never,
      log: (m: string) => logs.push(m),
      minAgeMs: 0,
    });
    return { sweep, logs, claims };
  }

  it('claims a COMPLETE game whose winner never settled', async () => {
    // This used to be refused outright — "settled by its winner, not claimed" —
    // which was true of the old contract, and left both sides locked out when
    // the winner closed their tab on the result screen. The contract takes
    // n == 9 now: a finished game owes nobody a move, so either player may
    // claim, and each recovers only their own stake.
    const h = sweepFor(9);
    await h.sweep.run();
    expect(h.claims, 'a finished game nobody settled is exactly what this is for').toHaveLength(1);
    expect(h.logs.join(' ')).toMatch(/complete but never settled/);
    // Nine, not trimmed: parity is irrelevant once the game is over.
    expect(h.logs.join(' ')).not.toMatch(/claiming at the first/);
  });

  it('claims the largest even prefix when the count is odd', async () => {
    // 7 proofs as player 2: claiming at 7 is a certain revert, so claim at 6.
    // Giving up here is what left thirty cards locked across six games.
    const h = sweepFor(7);
    await h.sweep.run();
    expect(h.claims, 'an odd count is not a dead end').toHaveLength(1);
    expect(h.logs.join(' ')).toMatch(/claiming at the first 6/);
    expect(h.sweep.stats.unrecoverable).toBe(0);
  });

  it('claims at the full count when the parity already suits', async () => {
    const h = sweepFor(6);
    await h.sweep.run();
    expect(h.claims).toHaveLength(1);
    expect(h.logs.join(' ')).not.toMatch(/claiming at the first/);
  });

  it('as player 1, trims to an ODD prefix instead', async () => {
    const h = sweepFor(4, true);
    await h.sweep.run();
    expect(h.claims).toHaveLength(1);
    expect(h.logs.join(' ')).toMatch(/claiming at the first 3/);
  });

  it('cannot claim as player 1 before anyone has moved', async () => {
    // The one genuinely unclaimable case, and the contract says so: at zero
    // moves the first move is player 1's, so only player 2 may claim.
    const h = sweepFor(0, true);
    await h.sweep.run();
    expect(h.claims).toHaveLength(0);
    expect(h.logs.join(' ')).toMatch(/NOT CLAIMABLE BY US/);
  });

  it('still claims when it really is the opponent who left', async () => {
    const h = sweepFor(4);           // even: player 1 is next and absent
    await h.sweep.run();
    expect(h.claims).toEqual(['claim']);
  });
});
