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

  forget(onChainGameId: string): void {
    const p = this.path(onChainGameId);
    if (existsSync(p)) unlinkSync(p);
  }
}
