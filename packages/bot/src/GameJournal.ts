/**
 * On-disk record of every game the bot has cards committed to.
 *
 * A private game leaves no public state (docs/plan/PRIVATE_GAMES.md): the chain
 * holds only nullifiers derived from a key the two players share, and the
 * bot's cards come back only as notes the bot itself rebuilds from secrets
 * only it holds. Everything needed to find the game again, settle it, unwind
 * it or import from it therefore lives here and nowhere else. A process that
 * crashes, restarts or is stopped mid-game would otherwise lose the only route
 * back to five committed cards — the bot cannot cancel (cancel is
 * creator-only, and the bot only ever joins).
 *
 * So the journal is written as the game unfolds, not at the end — starting
 * just BEFORE the join is sent, because a crash while that tx is in flight is
 * exactly when the cards may be committed without anything recording where.
 *
 * What it keeps is what recovery needs and nothing more about the opponent:
 * the relay room id, our key pair and their PUBLIC key (to re-derive the
 * channel), the game key, our note nonce (our secrets re-derive from it), our
 * own hand, both records, the transcript — both sides' moves with their proofs
 * (docs/plan/PRIVATE_GAMES.md section 6.4) — the open cards and the outcome. Of
 * the opponent that is only what the game itself showed: their opaque record,
 * the cards they placed and their three open cards. No address, no unplayed
 * card, no secret of theirs — they never reach the bot in the first place.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync, existsSync, renameSync } from 'fs';
import { join } from 'path';
import type { Outcome } from './protocol.js';

/** Records from the previous (public-state) contracts carry no version. */
export const JOURNAL_VERSION = 2;

export interface JournalProof {
  proof: string;
  publicInputs: string[];
  cardCommit1: string;
  cardCommit2: string;
  startStateHash: string;
  endStateHash: string;
  gameEnded: boolean;
  winnerId: number;
  placedCardId?: number;
  placedSlot?: number;
}

/** One move of the transcript: the card, its slot in the mover's committed hand, the cell. */
export interface JournalMove {
  moveNumber: number;
  cardId: number;
  slot: number;
  row: number;
  col: number;
}

/** Open cards and the proof that they are a hand's committed slots 0..2. */
export interface JournalOpenCards {
  cards: number[];
  proof: string;
  publicInputs: string[];
}

/** How a game was resolved on-chain, as far as our own notes go. */
export type JournalResolution = 'settled' | 'unwound' | 'forfeited';

export interface JournalRecord {
  version: typeof JOURNAL_VERSION;
  /**
   * The relay room id: the journal's key, and the associated data of every
   * PEER and MOVE payload, so a restarted bot can still open the game's channel.
   */
  relayGameId: string;
  /** Our ephemeral key pair for this game (private key as JWK). */
  keyPair: { privateJwk: JsonWebKey; publicKey: string };
  /** The opponent's ephemeral PUBLIC key — the other half of the derivation. */
  opponentPublicKey: string;
  /** The game's shared secret (field, hex): every on-chain nullifier hangs off it. */
  gameKey: string;
  /** Our note nonce before the commit: compute_game_secrets(nonce) re-derives our secrets. */
  nonce: string;
  /** Our hand, in committed order. */
  cardIds: number[];
  /** The creator's record and ours: nine opaque hashes each. */
  record1: string[];
  record2: string[];
  /**
   * The move proofs we hold — the transcript a settlement needs. In move
   * order (records from before the relay stopped running the game hold them
   * in any order; settlement chains them either way).
   */
  moveProofs: JournalProof[];
  /** The moves those proofs prove, in the same order: enough to rebuild the board. */
  moves?: JournalMove[];
  /** The opponent's open cards, once their proof checked out. */
  opponentOpenCards?: number[] | null;
  /**
   * The opponent's open cards WITH the proof that checked out: what an
   * abandonment claim takes one of their cards with. The cards are on the
   * table to the bot anyway; the proof reveals nothing more.
   */
  opponentOpenProof?: JournalOpenCards | null;
  /** Our own open cards as sent. */
  ownOpenCards?: JournalOpenCards | null;
  /**
   * Why the opponent's play was refused, if it was — without card details.
   * Such a game can never settle: the sweep claims it.
   */
  protocolError?: string | null;
  /** The game's result from our seat, once all nine moves are in. */
  outcome: Outcome | null;
  /** The prize move once known: ours if we settled, the winner's word otherwise. */
  prizeMove: number | null;
  /** 'joining' from just before the join is sent until it is known to have landed. */
  phase: 'joining' | 'joined';
  /** When we sent the join (ms): the age every recovery decision starts from. */
  committedAt: number;
  updatedAt: number;
  /** Set once the game is resolved on-chain AND our notes are imported from it. */
  resolution?: JournalResolution;
  resolvedTxHash?: string;
  /** Chain time (s) of the abandonment claim WE filed, for the worklist. */
  claimedAt?: number;
}

export class GameJournal {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(relayGameId: string): string {
    // Relay ids are UUIDs; keep the filename filesystem-safe regardless.
    return join(this.dir, `${relayGameId.replace(/[^0-9a-zA-Z_-]/g, '_')}.json`);
  }

  /**
   * Written atomically. A half-written journal entry is worse than none: the
   * sweep would parse it and act on a truncated transcript.
   */
  write(rec: JournalRecord): void {
    const p = this.path(rec.relayGameId);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...rec, updatedAt: Date.now() }, null, 2));
    renameSync(tmp, p);
  }

  read(relayGameId: string): JournalRecord | null {
    const p = this.path(relayGameId);
    if (!existsSync(p)) return null;
    try {
      const rec = JSON.parse(readFileSync(p, 'utf-8')) as JournalRecord;
      return rec.version === JOURNAL_VERSION ? rec : null;
    } catch {
      return null;
    }
  }

  /**
   * Every game we still believe holds our cards: not yet resolved and
   * imported. Records written for the previous contracts are left on disk
   * untouched — this code cannot act on them, and deleting them would discard
   * the only note that cards were committed there.
   */
  outstanding(): JournalRecord[] {
    if (!existsSync(this.dir)) return [];
    const out: JournalRecord[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(readFileSync(join(this.dir, f), 'utf-8')) as JournalRecord;
        if (rec.version === JOURNAL_VERSION && !rec.resolution) out.push(rec);
      } catch {
        // A corrupt entry is not worth crashing the bot over, but it IS worth
        // leaving on disk: deleting it would silently discard the only record
        // that five cards are committed somewhere.
      }
    }
    return out.sort((a, b) => a.committedAt - b.committedAt);
  }

  /**
   * Mark a game resolved, keeping the record.
   *
   * Deleting it would be the obvious thing — resolved cards are not locked —
   * but the record is also the only surviving copy of what a failed import
   * needs to be retried by hand: the nonce our secrets derive from and the
   * records that name our notes. Forty cards were once lost exactly this way.
   */
  markResolved(relayGameId: string, resolution: JournalResolution, txHash: string): void {
    const rec = this.read(relayGameId);
    if (!rec) return;
    this.write({ ...rec, resolution, resolvedTxHash: txHash });
  }

  /**
   * Delete resolved records older than `maxAgeMs`, so the directory does not
   * grow without bound. Long enough that a failed import is still recoverable
   * by hand; short enough that this stays a journal rather than an archive.
   */
  pruneResolved(maxAgeMs: number, now = Date.now()): number {
    if (!existsSync(this.dir)) return 0;
    let removed = 0;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(readFileSync(join(this.dir, f), 'utf-8')) as JournalRecord;
        if (rec.version === JOURNAL_VERSION && rec.resolution && now - rec.updatedAt > maxAgeMs) {
          unlinkSync(join(this.dir, f));
          removed += 1;
        }
      } catch { /* leave anything unreadable alone */ }
    }
    return removed;
  }

  forget(relayGameId: string): void {
    const p = this.path(relayGameId);
    if (existsSync(p)) unlinkSync(p);
  }
}
