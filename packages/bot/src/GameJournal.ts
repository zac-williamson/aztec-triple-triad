/**
 * On-disk record of every game the bot has cards committed to.
 *
 * Without this the sweep cannot exist. Recovering an abandoned game needs the
 * transcript — both hand proofs and the partial move chain — and that lives only
 * in the bot's memory during play. A process that crashes, is restarted, or is
 * simply stopped between games loses it, and with it the ONLY route back to five
 * committed cards: the bot cannot cancel (cancel is creator-only, and the bot
 * only ever joins).
 *
 * So the journal is written as the game unfolds, not at the end — the crash we
 * are protecting against happens mid-game by definition. An entry is deleted
 * only once the game is observed settled on-chain, which makes an orphaned entry
 * the SIGNAL the sweep looks for rather than a leak.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync, existsSync, renameSync } from 'fs';
import { join } from 'path';

export interface JournalProof {
  proof: string;
  publicInputs: string[];
  startStateHash?: string;
  endStateHash?: string;
  cardCommit?: string;
}

export interface GameRecord {
  /** On-chain game id — the key the contract knows this game by. */
  onChainGameId: string;
  /** Relay game id, for correlating with logs. */
  relayGameId: string | null;
  botAddress: string;
  opponentAddress: string | null;
  botIsPlayer1: boolean;
  cardIds: number[];
  randomness: string[];
  /**
   * Our blinding factor for this game. Recovery has to prove the card ids it
   * re-mints are the ones we committed, and this is the only value that binds
   * them — without it the five cards cannot be recovered at all.
   */
  blindingFactor: string | null;
  opponentCardIds: number[];
  myHandProof: JournalProof | null;
  opponentHandProof: JournalProof | null;
  moveProofs: JournalProof[];
  committedAt: number;
  updatedAt: number;
  /** Set once we have seen it settled, so a stale file cannot resurrect it. */
  settled?: boolean;
}

export class GameJournal {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(onChainGameId: string): string {
    // Game ids are hex fields; keep the filename filesystem-safe regardless.
    return join(this.dir, `${onChainGameId.replace(/[^0-9a-zA-Zx]/g, '_')}.json`);
  }

  /**
   * Written atomically. A half-written journal entry is worse than none: the
   * sweep would parse it, act on a truncated proof chain, and burn a claim
   * attempt on a game it cannot actually recover.
   */
  write(rec: GameRecord): void {
    const p = this.path(rec.onChainGameId);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...rec, updatedAt: Date.now() }, null, 2));
    renameSync(tmp, p);
  }

  read(onChainGameId: string): GameRecord | null {
    const p = this.path(onChainGameId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as GameRecord;
    } catch {
      return null;
    }
  }

  /** Every game we still believe holds our cards. */
  outstanding(): GameRecord[] {
    if (!existsSync(this.dir)) return [];
    const out: GameRecord[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(readFileSync(join(this.dir, f), 'utf-8')) as GameRecord;
        if (!rec.settled) out.push(rec);
      } catch {
        // A corrupt entry is not worth crashing the bot over, but it IS worth
        // leaving on disk: deleting it would silently discard the only record
        // that five cards are committed somewhere.
      }
    }
    return out.sort((a, b) => a.committedAt - b.committedAt);
  }

  /**
   * Mark a game settled, keeping the record.
   *
   * Deleting it was the obvious thing and it is what we used to do — the entry
   * exists to mark cards as locked, and settled cards are not locked. But the
   * record is also the only surviving copy of the per-game randomness, which is
   * what an import of the returned cards needs. Once it is gone, a card that
   * failed to import can never be recovered by anybody: the randomness is
   * derivable only from the on-chain game id, and nothing else retains that.
   * Forty cards were lost exactly this way.
   */
  markSettled(onChainGameId: string): void {
    const rec = this.read(onChainGameId);
    if (!rec) return;
    this.write({ ...rec, settled: true });
  }

  /**
   * Delete settled records older than `maxAgeMs`, so the directory does not
   * grow without bound. Long enough that a failed import is still recoverable
   * by hand; short enough that this stays a journal rather than an archive.
   */
  pruneSettled(maxAgeMs: number, now = Date.now()): number {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(readFileSync(join(this.dir, f), 'utf-8')) as GameRecord;
        if (rec.settled && now - rec.updatedAt > maxAgeMs) {
          unlinkSync(join(this.dir, f));
          removed += 1;
        }
      } catch { /* leave anything unreadable alone */ }
    }
    return removed;
  }

  forget(onChainGameId: string): void {
    const p = this.path(onChainGameId);
    if (existsSync(p)) unlinkSync(p);
  }
}
