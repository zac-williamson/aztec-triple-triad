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
