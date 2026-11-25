import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GameJournal, type JournalRecord } from '../src/GameJournal.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'journal-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const F = (n: number) => '0x' + n.toString(16).padStart(64, '0');

function record(over: Partial<JournalRecord> = {}): JournalRecord {
  return {
    version: 2,
    relayGameId: 'room-1',
    keyPair: { privateJwk: { kty: 'EC', crv: 'P-256', d: 'secret' }, publicKey: 'cHVi' },
    opponentPublicKey: 'dGhlaXJz',
    gameKey: F(0x6a),
    nonce: F(16),
    cardIds: [1, 2, 3, 4, 5],
    record1: Array.from({ length: 9 }, (_, i) => F(0x100 + i)),
    record2: Array.from({ length: 9 }, (_, i) => F(0x200 + i)),
    moveProofs: [],
    outcome: null,
    prizeMove: null,
    phase: 'joined',
    committedAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

describe('GameJournal', () => {
  it('round-trips a record by its relay room id', () => {
    const j = new GameJournal(dir);
    j.write(record());
    expect(j.read('room-1')).toMatchObject({ relayGameId: 'room-1', cardIds: [1, 2, 3, 4, 5], gameKey: F(0x6a) });
  });

  it('keeps the transcript: both sides\' moves with their proofs, the open cards, and a refusal', () => {
    const j = new GameJournal(dir);
    const moves = [
      { moveNumber: 0, cardId: 180, slot: 1, row: 0, col: 0 },
      { moveNumber: 1, cardId: 3, slot: 2, row: 1, col: 1 },
    ];
    const proof = (i: number) => ({
      proof: 'cHJvb2Y=', publicInputs: Array.from({ length: 8 }, (_, k) => F(10 * i + k)),
      cardCommit1: F(1), cardCommit2: F(2), startStateHash: F(10 * i + 2), endStateHash: F(10 * i + 3),
      gameEnded: false, winnerId: 0, placedCardId: moves[i].cardId, placedSlot: moves[i].slot,
    });
    j.write(record({
      moveProofs: [proof(0), proof(1)],
      moves,
      opponentOpenCards: [12, 180, 7],
      ownOpenCards: { cards: [1, 2, 3], proof: 'b3Blbg==', publicInputs: [F(2), F(1), F(2), F(3)] },
      protocolError: 'their move 2: its proof does not verify',
    }));
    const back = j.read('room-1')!;
    expect(back.moves).toEqual(moves);
    expect(back.moveProofs.map(p => p.placedCardId)).toEqual([180, 3]);
    expect(back.opponentOpenCards).toEqual([12, 180, 7]);
    expect(back.ownOpenCards!.cards).toEqual([1, 2, 3]);
    expect(back.protocolError).toMatch(/does not verify/);
    // Still the sweep's until it is resolved.
    expect(j.outstanding()).toHaveLength(1);
  });

  it('keeps committedAt as written — age is what every recovery decision starts from', () => {
    const j = new GameJournal(dir);
    j.write(record({ committedAt: 1000 }));
    const first = j.read('room-1')!;
    j.write({ ...first, moveProofs: [] });
    expect(j.read('room-1')!.committedAt).toBe(1000);
  });

  it('lists outstanding games oldest first, and drops resolved ones', () => {
    const j = new GameJournal(dir);
    j.write(record({ relayGameId: 'new', committedAt: 2000 }));
    j.write(record({ relayGameId: 'old', committedAt: 1000 }));
    j.write(record({ relayGameId: 'done', committedAt: 500, resolution: 'settled', resolvedTxHash: F(1) }));
    expect(j.outstanding().map(r => r.relayGameId)).toEqual(['old', 'new']);
  });

  it('leaves records from the previous contracts on disk, but does not act on them', () => {
    // The old journal was keyed by a public on-chain game id. This code cannot
    // do anything with those games, and deleting the files would discard the
    // only note that cards were committed there.
    writeFileSync(join(dir, '0xabc.json'), JSON.stringify({
      onChainGameId: '0xabc', cardIds: [1, 2, 3, 4, 5], committedAt: 1, moveProofs: [],
    }));
    const j = new GameJournal(dir);
    expect(j.outstanding()).toHaveLength(0);
    expect(j.pruneResolved(0, Date.now() + 1e9)).toBe(0);
    expect(readdirSync(dir)).toContain('0xabc.json');
  });

  it('forgets a game', () => {
    const j = new GameJournal(dir);
    j.write(record());
    j.forget('room-1');
    expect(j.read('room-1')).toBeNull();
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
    expect(JSON.parse(readFileSync(join(dir, 'room-1.json'), 'utf-8')).relayGameId).toBe('room-1');
  });

  it('keeps a filesystem-safe name for an arbitrary room id', () => {
    const j = new GameJournal(dir);
    j.write(record({ relayGameId: '../../etc/passwd' }));
    expect(readdirSync(dir).every(f => !f.includes('/') && !f.startsWith('..'))).toBe(true);
    expect(j.read('../../etc/passwd')).not.toBeNull();
  });

  it('returns nothing for an unknown game', () => {
    expect(new GameJournal(dir).read('nope')).toBeNull();
  });
});

describe('resolved records are kept, not deleted', () => {
  /**
   * The record is the only surviving copy of what a failed import needs to be
   * retried by hand — the nonce our secrets derive from, and the records that
   * name our notes. Deleting it turns "a card we cannot see yet" into "a card
   * nobody can ever see".
   */
  it('marks a game resolved while keeping what an import needs', () => {
    const journal = new GameJournal(dir);
    journal.write(record({ relayGameId: 'aa' }));

    journal.markResolved('aa', 'settled', F(0x5e77));

    const kept = journal.read('aa');
    expect(kept, 'the record survives settlement').not.toBeNull();
    expect(kept!.resolution).toBe('settled');
    expect(kept!.resolvedTxHash).toBe(F(0x5e77));
    expect(kept!.nonce, 'the nonce is still there to re-derive our secrets').toBe(F(16));
    expect(kept!.record2).toHaveLength(9);
    // ...but the sweep must not chase it: resolved cards are not locked.
    expect(journal.outstanding().map(r => r.relayGameId)).not.toContain('aa');
  });

  it('prunes resolved records once they are old, so the journal stays a journal', () => {
    const journal = new GameJournal(dir);
    journal.write(record({ relayGameId: 'old' }));
    journal.write(record({ relayGameId: 'new' }));
    journal.markResolved('old', 'settled', F(1));
    journal.markResolved('new', 'unwound', F(2));

    const removed = journal.pruneResolved(30 * 60_000, Date.now() + 60 * 60_000);
    expect(removed).toBe(2);
    expect(journal.read('old')).toBeNull();
  });

  it('never prunes an unresolved record, however old', () => {
    const journal = new GameJournal(dir);
    journal.write(record({ relayGameId: 'locked' }));
    // Five cards are committed in this game. Age is not a reason to forget it.
    expect(journal.pruneResolved(1, Date.now() + 10 * 365 * 24 * 3600_000)).toBe(0);
    expect(journal.read('locked')).not.toBeNull();
  });
});
