import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GameJournal, type GameRecord } from '../src/GameJournal.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'journal-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function record(over: Partial<GameRecord> = {}): GameRecord {
  return {
    onChainGameId: '0xabc', relayGameId: 'g1', botAddress: '0xbot', opponentAddress: '0xopp',
    botIsPlayer1: false, cardIds: [1, 2, 3, 4, 5], randomness: [], blindingFactor: '0xb1', opponentCardIds: [],
    myHandProof: null, opponentHandProof: null, moveProofs: [],
    committedAt: 1000, updatedAt: 1000, ...over,
  };
}

describe('GameJournal', () => {
  it('round-trips a record', () => {
    const j = new GameJournal(dir);
    j.write(record());
    expect(j.read('0xabc')).toMatchObject({ onChainGameId: '0xabc', cardIds: [1, 2, 3, 4, 5] });
  });

  it('preserves committedAt across updates', () => {
    const j = new GameJournal(dir);
    j.write(record({ committedAt: 1000 }));
    const first = j.read('0xabc')!;
    j.write({ ...first, moveProofs: [{ proof: 'p', publicInputs: [] }] });
    // The sweep decides abandonment by AGE, so a rewrite must not make an old
    // game look new — that would postpone recovery indefinitely.
    expect(j.read('0xabc')!.committedAt).toBe(1000);
  });

  it('lists outstanding games oldest first, and drops settled ones', () => {
    const j = new GameJournal(dir);
    j.write(record({ onChainGameId: '0xnew', committedAt: 2000 }));
    j.write(record({ onChainGameId: '0xold', committedAt: 1000 }));
    j.write(record({ onChainGameId: '0xdone', committedAt: 500, settled: true }));
    expect(j.outstanding().map(r => r.onChainGameId)).toEqual(['0xold', '0xnew']);
  });

  it('forgets a game', () => {
    const j = new GameJournal(dir);
    j.write(record());
    j.forget('0xabc');
    expect(j.read('0xabc')).toBeNull();
    expect(j.outstanding()).toHaveLength(0);
  });

  it('skips a corrupt entry but leaves it on disk', () => {
    const j = new GameJournal(dir);
    writeFileSync(join(dir, 'bad.json'), 'not json');
    j.write(record());
    expect(j.outstanding()).toHaveLength(1);
    // Deleting it would discard the only evidence that cards are locked.
    expect(readdirSync(dir)).toContain('bad.json');
  });

  it('leaves no temp file behind — a half-written entry is worse than none', () => {
    const j = new GameJournal(dir);
    j.write(record());
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(dir, '0xabc.json'), 'utf-8')).onChainGameId).toBe('0xabc');
  });

  it('keeps a filesystem-safe name for an arbitrary game id', () => {
    const j = new GameJournal(dir);
    j.write(record({ onChainGameId: '0x00/../etc' }));
    expect(readdirSync(dir).every(f => !f.includes('/'))).toBe(true);
    expect(j.read('0x00/../etc')).not.toBeNull();
  });

  it('returns nothing for an unknown game', () => {
    expect(new GameJournal(dir).read('0xnope')).toBeNull();
  });
});

describe('settled records are kept, not deleted', () => {
  /**
   * The record is the only surviving copy of a game's randomness, and that is
   * what recovering a returned card whose import failed requires. Deleting it
   * turns "a card we cannot see yet" into "a card nobody can ever see".
   */
  it('marks a game settled while keeping its randomness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-settled-'));
    const journal = new GameJournal(dir);
    const RAND = ['0xr0', '0xr1', '0xr2', '0xr3', '0xr4', '0xr5'];
    journal.write(record({ onChainGameId: '0xaa', randomness: RAND }));

    journal.markSettled('0xaa');

    const kept = journal.read('0xaa');
    expect(kept, 'the record survives settlement').not.toBeNull();
    expect(kept!.settled).toBe(true);
    expect(kept!.randomness, 'the randomness is still there to recover with').toEqual(RAND);
    // ...but the sweep must not chase it: settled cards are not locked.
    expect(journal.outstanding().map(r => r.onChainGameId)).not.toContain('0xaa');
  });

  it('prunes settled records once they are old, so the journal stays a journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-prune-'));
    const journal = new GameJournal(dir);
    journal.write(record({ onChainGameId: '0xold' }));
    journal.write(record({ onChainGameId: '0xnew' }));
    journal.markSettled('0xold');
    journal.markSettled('0xnew');

    // An hour later, with a 30-minute retention: only the old one goes, and
    // only because it is settled.
    const removed = journal.pruneSettled(30 * 60_000, Date.now() + 60 * 60_000);
    expect(removed).toBe(2);
    expect(journal.read('0xold')).toBeNull();
  });

  it('never prunes an unsettled record, however old', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-keep-'));
    const journal = new GameJournal(dir);
    journal.write(record({ onChainGameId: '0xlocked' }));
    // Five cards are committed in this game. Age is not a reason to forget it.
    expect(journal.pruneSettled(1, Date.now() + 10 * 365 * 24 * 3600_000)).toBe(0);
    expect(journal.read('0xlocked')).not.toBeNull();
  });
});
