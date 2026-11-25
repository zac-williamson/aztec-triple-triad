/**
 * The sweep is the only route back from a game that will not resolve the
 * ordinary way: the bot only joins, and cancel is creator-only. Every branch
 * here is "do five cards come back, or not" — and, just as much, "does the bot
 * leave alone what is not its to touch".
 *
 * The chain is a fake that knows one game's nullifiers; the journal is real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GameJournal, type JournalRecord } from '../src/GameJournal.js';
import { AbandonmentSweep } from '../src/AbandonmentSweep.js';
import { DISPUTE_SECONDS, MIN_ABANDON_SECONDS } from '../src/protocol.js';
import {
  BOT_HAND, F, GAME_KEY, N, NONCE, RECORD1, RECORD2, RESOLVING_TX, fakeChain, transcript,
} from './fakes.js';

// settle_game's argument list is the frontend's to build (and its own tests'
// to pin); here it only has to be built from the right game.
vi.mock('../../frontend/src/aztec/settlementArgs.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  buildSettleGameArgs: vi.fn(async (i: { gameKey: string; prizeMove: number }) => ['settle-args', i.gameKey, i.prizeMove]),
}));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sweep-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks(); });

const NOW = 10_000_000;
/** Block n lands at 1000 + 36n seconds on the fake chain. */
const T = (n: number) => 1000 + 36 * n;

function record(over: Partial<JournalRecord> = {}): JournalRecord {
  return {
    version: 2,
    relayGameId: 'room-1',
    keyPair: { privateJwk: { kty: 'EC', d: 'bot' }, publicKey: 'Ym90' },
    opponentPublicKey: 'aHVtYW4=',
    gameKey: GAME_KEY,
    nonce: NONCE,
    cardIds: [...BOT_HAND],
    record1: RECORD1,
    record2: RECORD2,
    // Four moves: the human walked out mid-game.
    moveProofs: transcript({ winnerId: 2, moves: 4 }),
    outcome: null,
    prizeMove: null,
    phase: 'joined',
    committedAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function harness(over: { sweepOpts?: Record<string, unknown>; chain?: Record<string, unknown>; pxe?: Record<string, unknown> } = {}) {
  const f = fakeChain({ chain: over.chain, pxe: over.pxe });
  // The join landed in block 5; the chain is long past every bar unless a test says otherwise.
  f.state.hits.set(N.created, 4);
  f.state.hits.set(N.joined, 5);
  f.state.now = T(5) + 3600;
  const journal = new GameJournal(dir);
  const logs: string[] = [];
  const sweep = new AbandonmentSweep({
    journal, chain: f.chain as never,
    proofs: { moveVerificationKey: async () => new Uint8Array([9]) },
    log: m => logs.push(m), now: () => NOW, minAgeMs: 1_000,
    ...over.sweepOpts,
  });
  const steps = () => f.calls.map(c => c[0]).filter(n => ['claim', 'contest', 'finalize', 'settle', 'importCards'].includes(n));
  return { sweep, journal, f, logs, steps };
}

describe('AbandonmentSweep: games it must leave alone', () => {
  it('does NOT touch a game that is still young — it may simply be slow', async () => {
    const h = harness({ sweepOpts: { minAgeMs: 60 * 60_000 } });
    h.journal.write(record({ committedAt: NOW - 60_000 }));
    const stats = await h.sweep.run();
    expect(h.steps()).toEqual([]);
    expect(stats.skipped).toBe(1);
    expect(h.journal.outstanding()).toHaveLength(1);
  });

  it('forgets a game whose join never landed — nothing of ours was committed', async () => {
    const h = harness();
    h.f.state.hits.delete(N.joined);
    h.journal.write(record({ phase: 'joining' }));
    await h.sweep.run();
    expect(h.steps()).toEqual([]);
    expect(h.journal.read('room-1')).toBeNull();
  });

  it('never forgets a game it saw joined, even if the chain does not show the join', async () => {
    // A node behind the chain, or a record that does not match what we
    // committed: either way five cards may be at stake.
    const h = harness();
    h.f.state.hits.delete(N.joined);
    h.journal.write(record({ phase: 'joined' }));
    await h.sweep.run();
    expect(h.journal.read('room-1')).not.toBeNull();
    expect(h.logs.join('\n')).toMatch(/keeping it/);
  });

  it('marks a join that turned out to have landed as joined', async () => {
    const h = harness();
    h.journal.write(record({ phase: 'joining' }));
    await h.sweep.run();
    expect(h.journal.read('room-1')!.phase).toBe('joined');
  });

  it('leaves a game the live bot is still following up itself', async () => {
    const h = harness({ sweepOpts: { isTracking: (id: string) => id === 'room-1' } });
    h.journal.write(record());
    await h.sweep.run();
    expect(h.f.calls).toEqual([]);
  });
});

describe('AbandonmentSweep: a game somebody resolved', () => {
  it('finds the resolution by its done nullifier and takes our own cards back from it', async () => {
    // The human won, settled, and their SETTLED never reached us.
    const h = harness();
    h.f.resolveIn(44);
    h.f.state.released = { returns: [true, true, false, true, true], reward: true };
    h.journal.write(record({ moveProofs: transcript({ winnerId: 1 }), outcome: 'loss' }));

    const stats = await h.sweep.run();

    const [, txHash, notes] = h.f.called('importCards')[0];
    expect(txHash).toBe(RESOLVING_TX.txHash);
    expect(notes.map((n: { tokenId: number }) => n.tokenId)).toEqual([7, 8, 10, 11]);
    expect(h.f.called('importReward')).toHaveLength(1);
    expect(stats.recovered).toBe(1);
    expect(stats.cardsRecovered).toBe(4);
    // Resolved, so the next pass leaves it alone — but the record stays.
    expect(h.journal.outstanding()).toHaveLength(0);
    expect(h.journal.read('room-1')!.resolution).toBe('settled');
    expect(h.journal.read('room-1')!.resolvedTxHash).toBe(RESOLVING_TX.txHash);
  });

  it('records an unwind as such', async () => {
    const h = harness();
    h.f.resolveIn(44, [N.resolved(1)]);
    h.f.state.released = { returns: [true, true, true, true, true], reward: false };
    h.journal.write(record());
    await h.sweep.run();
    expect(h.journal.read('room-1')!.resolution).toBe('unwound');
    expect(h.f.called('importReward'), 'an unwind pays no reward').toHaveLength(0);
  });
});

describe('AbandonmentSweep: a game abandoned mid-play', () => {
  it('claims it once the chain is past the abandon bar, timed from the join', async () => {
    const h = harness();
    h.journal.write(record());
    const stats = await h.sweep.run();

    expect(h.steps()).toEqual(['claim']);
    const [, owner, ref, claim, opts] = h.f.called('claim')[0];
    expect(owner).toBe('0xbot');
    expect(ref).toEqual({ gameKey: GAME_KEY, record1: RECORD1, record2: RECORD2 });
    expect(claim).toEqual({ side: 2, claimNo: 1, clockBlock: 5 });
    // pxe.ts hands this to the SDK's wait, which counts seconds.
    expect(opts.timeoutMs).toBe(600);
    expect(stats.claimed).toBe(1);
    // The worklist can say the game is serving out its window.
    expect(h.journal.read('room-1')!.claimedAt).toBe(T(30));
  });

  it('waits when the chain is not yet past the bar — a claim then would revert', async () => {
    const h = harness();
    h.f.state.now = T(5) + MIN_ABANDON_SECONDS - 10;
    h.journal.write(record());
    const stats = await h.sweep.run();
    expect(h.steps()).toEqual([]);
    expect(stats.skipped).toBe(1);
    expect(h.logs.join('\n')).toMatch(/claim 1 opens in/);
  });

  it('finalizes its claim after the dispute window and takes all five back — nobody wins', async () => {
    const h = harness();
    h.f.state.hits.set(N.claimSlot(1), 30);
    h.f.state.hits.set(N.claim(1, 2), 30);
    h.f.state.now = T(30) + DISPUTE_SECONDS + 60;
    h.f.state.released = { returns: [true, true, true, true, true], reward: false };
    h.journal.write(record({ claimedAt: T(30) }));

    const stats = await h.sweep.run();

    expect(h.steps()).toEqual(['finalize', 'importCards']);
    expect(h.f.called('finalize')[0][3]).toEqual({ claimNo: 1, claimSide: 2, claimBlock: 30 });
    expect(h.f.called('importCards')[0][2].map((n: { tokenId: number }) => n.tokenId)).toEqual(BOT_HAND);
    expect(stats.finalized).toBe(1);
    expect(stats.cardsRecovered).toBe(5);
    expect(h.journal.read('room-1')!.resolution).toBe('unwound');
  });

  it('does not finalize inside the window', async () => {
    const h = harness();
    h.f.state.hits.set(N.claimSlot(1), 30);
    h.f.state.hits.set(N.claim(1, 2), 30);
    h.f.state.now = T(30) + 120;
    h.journal.write(record());
    await h.sweep.run();
    expect(h.steps()).toEqual([]);
    expect(h.logs.join('\n')).toMatch(/dispute window/);
  });

  it('finalizes the OPPONENT\'s claim once it has stood — it does not contest a game it cannot finish', async () => {
    const h = harness();
    h.f.state.hits.set(N.claimSlot(1), 30);
    h.f.state.hits.set(N.claim(1, 1), 30);
    h.f.state.now = T(30) + 120;
    h.journal.write(record());
    await h.sweep.run();
    expect(h.steps(), 'inside the window: no contest, just wait').toEqual([]);

    h.f.state.now = T(30) + DISPUTE_SECONDS + 60;
    await h.sweep.run();
    expect(h.f.called('finalize')[0][3]).toEqual({ claimNo: 1, claimSide: 1, claimBlock: 30 });
  });

  it('after its claim is contested, claims again from the contest\'s block', async () => {
    const h = harness();
    h.f.state.hits.set(N.claimSlot(1), 30);
    h.f.state.hits.set(N.claim(1, 2), 30);
    h.f.state.hits.set(N.contest(1), 31);
    h.f.state.hits.set(N.resolved(1), 31);
    h.f.state.hits.set(N.contestedBy(1), 31);
    h.f.state.now = T(31) + MIN_ABANDON_SECONDS + 60;
    h.journal.write(record());
    await h.sweep.run();
    expect(h.f.called('claim')[0][3]).toEqual({ side: 2, claimNo: 2, clockBlock: 31 });
  });
});

describe('AbandonmentSweep: a complete game nobody settled', () => {
  it('settles our win on its merits, taking the loser\'s card we value most', async () => {
    const h = harness();
    h.journal.write(record({ moveProofs: transcript({ winnerId: 2 }), outcome: 'win' }));

    const stats = await h.sweep.run();

    expect(h.steps()).toEqual(['settle', 'importCards']);
    const { buildSettleGameArgs } = await import('../../frontend/src/aztec/settlementArgs.js');
    const input = vi.mocked(buildSettleGameArgs).mock.calls[0][0];
    expect(input).toMatchObject({ gameKey: GAME_KEY, record1: RECORD1, record2: RECORD2, prizeMove: 4 });
    expect(input.moveProofs).toHaveLength(9);
    expect(h.f.called('settle')[0][2]).toEqual(['settle-args', GAME_KEY, 4]);
    // Our five, plus the legendary 247 the prize move names.
    expect(h.f.called('importCards')[0][2].map((n: { tokenId: number }) => n.tokenId)).toEqual([...BOT_HAND, 247]);
    expect(stats.settled).toBe(1);
    expect(h.journal.read('room-1')!.prizeMove).toBe(4);
  });

  it('settles a LOSS too, giving the absent winner the card they are owed by default', async () => {
    // Finalizing would keep our card — and take away a win the transcript
    // proves. A full game outranks a claim.
    const h = harness();
    h.f.state.released = { returns: [true, true, true, false, true], reward: true };
    h.journal.write(record({ moveProofs: transcript({ winnerId: 1 }), outcome: 'loss' }));
    await h.sweep.run();
    const { buildSettleGameArgs } = await import('../../frontend/src/aztec/settlementArgs.js');
    const { prizeMove } = vi.mocked(buildSettleGameArgs).mock.calls[0][0];
    expect(prizeMove % 2, 'one of OUR placed cards').toBe(1);
    expect(h.f.called('claim')).toHaveLength(0);
  });

  it('contests an opponent\'s standing claim first, then settles', async () => {
    const h = harness();
    h.f.state.hits.set(N.claimSlot(1), 30);
    h.f.state.hits.set(N.claim(1, 1), 30);
    h.f.state.now = T(30) + 60;
    h.journal.write(record({ moveProofs: transcript({ winnerId: 2 }), outcome: 'win' }));
    const stats = await h.sweep.run();
    expect(h.steps()).toEqual(['contest', 'settle', 'importCards']);
    expect(h.f.called('contest')[0][3]).toEqual({ side: 2, claimNo: 1, claimSide: 1, beforeClaimBlock: 29 });
    expect(stats.contested).toBe(1);
  });

  it('takes its cards from whatever resolved the game first if its settle loses the race', async () => {
    const h = harness({
      pxe: {
        sendSettleGame: async () => { h.f.resolveIn(41); throw new Error('Existing nullifier'); },
      },
    });
    h.journal.write(record({ moveProofs: transcript({ winnerId: 2 }), outcome: 'win' }));
    const stats = await h.sweep.run();
    expect(stats.failed).toBe(0);
    expect(stats.recovered).toBe(1);
    expect(h.journal.read('room-1')!.resolution).toBe('settled');
  });
});

describe('AbandonmentSweep bookkeeping', () => {
  it('keeps the record when a step FAILS, so the cards are not forgotten', async () => {
    const h = harness({ pxe: { sendClaimAbandonedGame: async () => { throw new Error('node down'); } } });
    h.journal.write(record());
    const stats = await h.sweep.run();
    expect(stats.failed).toBe(1);
    expect(stats.lastError).toMatch(/node down/);
    expect(h.journal.outstanding()).toHaveLength(1);
  });

  it('reports an entry it cannot act on once, then counts it instead', async () => {
    const h = harness();
    h.journal.write(record({ record2: RECORD2.slice(0, 3) }));
    await h.sweep.run();
    await h.sweep.run();
    const stats = await h.sweep.run();
    expect(stats.unrecoverable).toBe(5);
    expect(h.logs.filter(l => /UNRECOVERABLE/.test(l))).toHaveLength(1);
    expect(h.journal.read('room-1'), 'the record stays on disk').not.toBeNull();
  });

  it('does not run concurrently with itself', async () => {
    let release: () => void = () => {};
    const h = harness({
      pxe: { sendClaimAbandonedGame: () => new Promise<string>(r => { release = () => r(F(1)); }) },
    });
    h.journal.write(record());
    const first = h.sweep.run();
    await new Promise(r => setTimeout(r, 20));
    await h.sweep.run();
    release();
    await first;
    expect(h.f.called('nullifiers')).toHaveLength(1);
  });

  it('survives a corrupt journal entry without discarding it', async () => {
    const h = harness();
    writeFileSync(join(dir, 'corrupt.json'), '{ not json');
    h.journal.write(record());
    const stats = await h.sweep.run();
    expect(stats.claimed).toBe(1);
  });
});

describe('AbandonmentSweep yields to live games', () => {
  it('does not start a pass while a game is live', async () => {
    const h = harness({ sweepOpts: { isBusy: () => true } });
    h.journal.write(record());
    await h.sweep.run();
    expect(h.f.calls).toEqual([]);
  });

  it('stops mid-pass if a player gets matched', async () => {
    let busy = false;
    const h = harness({
      sweepOpts: { isBusy: () => busy },
      pxe: {
        sendClaimAbandonedGame: async (...a: any[]) => { busy = true; h.f.calls.push(['claim', ...a]); return F(1); },
      },
    });
    h.journal.write(record({ relayGameId: 'room-a', committedAt: 0 }));
    h.journal.write(record({ relayGameId: 'room-b', committedAt: 1 }));
    await h.sweep.run();
    expect(h.f.called('claim'), 'the second game waits for the next pass').toHaveLength(1);
  });

  it('stops between a contest and the settlement when a game starts', async () => {
    let busy = false;
    const h = harness({
      sweepOpts: { isBusy: () => busy },
      pxe: {
        sendContestAbandonment: async (...a: any[]) => { busy = true; h.f.calls.push(['contest', ...a]); return F(1); },
      },
    });
    h.f.state.hits.set(N.claimSlot(1), 30);
    h.f.state.hits.set(N.claim(1, 1), 30);
    h.f.state.now = T(30) + 60;
    h.journal.write(record({ moveProofs: transcript({ winnerId: 2 }), outcome: 'win' }));
    await h.sweep.run();
    expect(h.steps()).toEqual(['contest']);
  });
});
