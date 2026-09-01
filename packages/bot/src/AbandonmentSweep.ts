/**
 * Reclaims cards stranded in games that will never settle normally.
 *
 * Why this is not optional. The bot only ever JOINS games, and `cancel_game` is
 * creator-only — so when a game wedges (the opponent closes their tab mid-move,
 * a proof never arrives, the bot process dies) the bot has no way to release its
 * five committed cards. The loss is monotonic and silent: the bot keeps playing
 * until it cannot field a hand, then goes idle, correctly and quietly, which is
 * exactly why nobody notices. Measured on the sandbox: 25 cards per identity
 * stranded across five aborted runs.
 *
 * The recovery path is the contract's abandonment claim — a partial move chain
 * padded with dummy proofs, a dispute window, then settle. It needs the
 * transcript, which is why GameJournal persists it as the game unfolds.
 *
 * Deliberately conservative:
 *  - The CHAIN decides, never the journal. A record is only acted on if the game
 *    is genuinely still `active` on-chain.
 *  - It claims nothing it is not owed: `claimedCardId` is 0 (return the
 *    opponent's five cards) unless the opponent actually played, mirroring the
 *    browser's rule. Recovering our own stake is the goal; taking someone's card
 *    because their tab crashed is not.
 *  - One game at a time, through the same serialised proving queue as play.
 */
import type { GameJournal, GameRecord } from './GameJournal.js';
import type { BotChain } from './BotChain.js';
import type { BotProofs } from './BotProofs.js';

/** Mirrors the contract: 0 none, 1 created, 2 active, 3 settled, 4 cancelled, 5 abandoned_claimed. */
export const GAME_STATUS = {
  none: 0, created: 1, active: 2, settled: 3, cancelled: 4, abandoned_claimed: 5,
} as const;

export interface SweepStats {
  scanned: number;
  recovered: number;
  cardsRecovered: number;
  failed: number;
  skipped: number;
  /**
   * Cards locked in games that can never be recovered — the journal is missing
   * a hand proof the claim requires. A number rather than a repeated log line,
   * because it is a permanent fact, not an event.
   */
  unrecoverable: number;
  lastError: string | null;
}

export interface SweepDeps {
  journal: GameJournal;
  chain: BotChain;
  proofs: BotProofs;
  log?: (msg: string) => void;
  now?: () => number;
  /**
   * True while the bot is in a game.
   *
   * The sweep and live gameplay share ONE serial PXE queue, and a recovery
   * claim or settle holds it for minutes while it proves and mines. A player
   * who gets matched during a pass therefore waits behind maintenance for an
   * old game: their opponent never joins, and the match dies at move zero.
   * Recovery can always wait — a person watching a loading spinner cannot.
   */
  isBusy?: () => boolean;
  /** Minimum age before a game is considered abandoned rather than merely slow. */
  minAgeMs?: number;
  txTimeoutMs?: number;
}

/** How long a settled game's randomness is kept for manual recovery. */
export const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60_000;

export class AbandonmentSweep {
  /** Games already reported as permanently unrecoverable; reported once each. */
  private readonly reportedUnrecoverable = new Set<string>();

  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly minAgeMs: number;
  private readonly txTimeoutMs: number;
  private running = false;

  readonly stats: SweepStats = {
    scanned: 0, recovered: 0, cardsRecovered: 0, failed: 0, skipped: 0,
    unrecoverable: 0, lastError: null,
  };

  constructor(private readonly deps: SweepDeps) {
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => Date.now());
    // A game in progress looks exactly like an abandoned one from the journal's
    // point of view. Only age separates them, and claiming a LIVE game would be
    // both wrong and rejected ("It must be opponent's turn to claim").
    this.minAgeMs = deps.minAgeMs ?? 30 * 60_000;
    this.txTimeoutMs = deps.txTimeoutMs ?? 600_000;
  }

  /**
   * One pass over the journal. Safe to call repeatedly; never runs concurrently
   * with itself, because two claims on one game would waste an entire proving
   * run and the second would revert.
   */
  async run(): Promise<SweepStats> {
    if (this.running) return this.stats;
    this.running = true;
    try {
      // Settled records are kept so a failed import stays recoverable, but not
      // forever — a week is long enough to notice and act, short enough that
      // this stays a journal.
      const pruned = this.deps.journal.pruneSettled?.(SETTLED_RETENTION_MS) ?? 0;
      if (pruned) this.log(`sweep: pruned ${pruned} settled record(s)`);

      // Recomputed each pass: it is a property of the journal right now, not a
      // tally of how many times we have looked.
      this.stats.unrecoverable = 0;
      if (this.deps.isBusy?.()) {
        this.log('sweep: a game is live — deferring to the next pass');
        return this.stats;
      }

      const outstanding = this.deps.journal.outstanding();
      this.stats.scanned = outstanding.length;
      if (outstanding.length === 0) return this.stats;
      this.log(`sweep: ${outstanding.length} game(s) with cards committed`);

      for (const rec of outstanding) {
        // Re-check between games: a pass can span many minutes of chain work,
        // and a player may have been matched since it started.
        if (this.yieldToGame('a game started mid-pass — the rest waits')) break;
        try {
          await this.recoverOne(rec);
        } catch (err) {
          this.stats.failed += 1;
          this.stats.lastError = (err as Error).message;
          // Keep the record. A failed recovery is retried next pass; deleting it
          // would discard the only evidence that five cards are locked up.
          this.log(`sweep: ${short(rec.onChainGameId)} FAILED — ${(err as Error).message}`);
        }
      }
      return this.stats;
    } finally {
      this.running = false;
    }
  }

  /**
   * True if a game is live, in which case the sweep must get out of the way.
   * Logs once per yield so a deferred recovery is visible rather than silent.
   */
  private yieldToGame(what: string): boolean {
    if (!this.deps.isBusy?.()) return false;
    this.log(`sweep: a game is live — ${what}`);
    return true;
  }

  private async recoverOne(rec: GameRecord): Promise<void> {
    const id = short(rec.onChainGameId);
    const status = await this.deps.chain.pxe.readGameStatus(this.deps.chain.address, rec.onChainGameId);

    // Settled, cancelled or already claimed: the cards are not locked any more,
    // whatever the journal thinks. Drop the record.
    if (status === GAME_STATUS.settled || status === GAME_STATUS.cancelled) {
      this.log(`sweep: ${id} already resolved on-chain (status ${status}) — forgetting`);
      this.deps.journal.forget(rec.onChainGameId);
      return;
    }
    if (status === GAME_STATUS.abandoned_claimed) {
      // Claimed, but recovery is PER PLAYER now — the game only reaches
      // `settled` once BOTH sides have taken their stake back, and the absent
      // player may never return. So this status does not tell us whether WE
      // have recovered; only trying does.
      this.log(`sweep: ${id} already claimed; recovering our stake`);
      try {
        await this.settle(rec);
      } catch (err) {
        if (/Already recovered/i.test(String((err as Error).message))) {
          // Our cards are already back. Without this the record is kept and
          // retried on every pass, forever, against a game we are done with.
          this.log(`sweep: ${id} already recovered — forgetting`);
          this.deps.journal.forget(rec.onChainGameId);
          return;
        }
        throw err;
      }
      return;
    }
    if (status !== GAME_STATUS.active) {
      this.stats.skipped += 1;
      this.log(`sweep: ${id} status ${status} — nothing to recover`);
      this.deps.journal.forget(rec.onChainGameId);
      return;
    }

    const age = this.now() - rec.committedAt;
    if (age < this.minAgeMs) {
      this.stats.skipped += 1;
      this.log(`sweep: ${id} only ${Math.round(age / 60_000)}min old — may still be live, leaving it`);
      return;
    }

    if (!rec.blindingFactor) {
      this.stats.skipped += 1;
      // Journalled before blinding factors were recorded. Recovery must prove
      // the ids it re-mints, and this is the only value that binds them.
      this.log(`sweep: ${id} UNRECOVERABLE — no blinding factor in the journal`);
      return;
    }
    if (!rec.myHandProof || !rec.opponentHandProof) {
      this.stats.skipped += 1;
      this.stats.unrecoverable += rec.cardIds.length;
      // Not recoverable by us: the claim verifies BOTH hand proofs. This is a
      // PERMANENT condition, so say it once and then stop: re-deciding it every
      // fifteen minutes emitted a recurring alarm for a state that will never
      // change, which is how real signal gets tuned out. The record stays on
      // disk — it is the only evidence those cards are locked.
      if (!this.reportedUnrecoverable.has(id)) {
        this.reportedUnrecoverable.add(id);
        this.log(`sweep: ${id} UNRECOVERABLE — hand proofs missing from the journal ` +
                 `(${rec.cardIds.length} cards locked for good; not reported again)`);
      }
      return;
    }
    if (rec.moveProofs.length >= 9) {
      this.stats.skipped += 1;
      // A complete game is settled by its winner, not claimed. If the winner
      // never settles, the cards wait for them — there is no abandonment to
      // claim, because nobody abandoned anything.
      this.log(`sweep: ${id} complete (9 moves) — settled by its winner, not claimable`);
      return;
    }
    // ZERO move proofs is claimable: the opponent abandoned between our join and
    // their first move. The bot is always player 2, which is exactly who the
    // contract permits to make a zero-move claim.

    // Whose turn is it? The claim is for an opponent who walked away, so the
    // contract requires it to be THEIR turn: player 1 plays the even turns, so
    // a player-2 claimant needs an even move count. With an odd count the next
    // move is ours — nobody abandoned anything, we stalled — and the claim can
    // only ever fail:
    //
    //   sweep: 0x141176f6… abandoned (242min, 7/9 moves) — claiming
    //   sweep: 0x141176f6… FAILED — It must be opponent's turn to claim
    //
    // It retried that every fifteen minutes for hours, spending a proof and a
    // transaction each time on an assertion that cannot pass. Say it once.
    // An odd count is NOT a dead end, which is what this used to assume.
    //
    // The contract needs the first n move proofs to chain and n to have the
    // right parity. It does not need n to be the whole game — nothing on-chain
    // records how far the game actually got, because moves are off-chain. So
    // when the count has the wrong parity, claim the largest PREFIX that has
    // the right one.
    //
    // Nobody loses by the shorter n. `settle_abandoned_game` recovers only the
    // caller's OWN stake, proved with their own blinding factor, and does so
    // per player — each side gets its five cards back whenever it returns. The
    // parity rule decides who may FILE the claim, not who gets what. Refusing
    // to file left both sides locked out for nothing: six games, thirty cards.
    const held = Math.min(rec.moveProofs.length, 8);
    const wantOdd = rec.botIsPlayer1;   // p1 claims on p2's turn: odd n
    const n = (held % 2 === (wantOdd ? 1 : 0)) ? held : held - 1;
    if (n < 0) {
      // Only reachable as player 1 with no moves at all, which the contract
      // reserves for player 2 — we are the one who owes the first move.
      this.stats.skipped += 1;
      this.stats.unrecoverable += rec.cardIds.length;
      if (!this.reportedUnrecoverable.has(id)) {
        this.reportedUnrecoverable.add(id);
        this.log(`sweep: ${id} NOT CLAIMABLE BY US — no move has been made and we owe the ` +
                 `first one (${rec.cardIds.length} cards await the opponent's claim)`);
      }
      return;
    }

    const trimmed = n === rec.moveProofs.length
      ? rec
      : { ...rec, moveProofs: rec.moveProofs.slice(0, n) };
    this.log(`sweep: ${id} abandoned (${Math.round(age / 60_000)}min, ${rec.moveProofs.length}/9 moves)` +
      (n === rec.moveProofs.length ? '' : ` — claiming at the first ${n}, for the turn parity`) +
      ' — claiming');
    await this.claim(trimmed);
    // Between steps, not merely between games. A recovery is claim -> wait out
    // the dispute window -> settle -> import, and each chain step holds the
    // shared PXE queue for minutes. Checking only at the top of a pass left a
    // matched player waiting behind the whole sequence: production measured
    // sixteen minutes from "joining" to the join actually starting, while the
    // join transaction itself took forty-four seconds. The claim is already
    // on-chain, so stopping here is safe — the next pass resumes at settle.
    if (this.yieldToGame(`${short(rec.onChainGameId)} claimed; settle deferred`)) return;
    await this.settle(rec);
  }

  private async claim(rec: GameRecord): Promise<void> {
    const { buildClaimAbandonedArgs } = await import('../../frontend/src/aztec/settlementArgs.js');
    const { Fr } = await import('@aztec/aztec.js/fields');
    const { handVk, moveVk } = await this.deps.proofs.verificationKeys();
    const dummyVk = await this.deps.proofs.dummyVerificationKey();

    const args = await buildClaimAbandonedArgs({
      Fr,
      onChainGameId: rec.onChainGameId,
      callerIsPlayer1: rec.botIsPlayer1,
      handVk, moveVk, dummyVk,
      handProof1: (rec.botIsPlayer1 ? rec.myHandProof : rec.opponentHandProof)!,
      handProof2: (rec.botIsPlayer1 ? rec.opponentHandProof : rec.myHandProof)!,
      validMoveProofs: rec.moveProofs as any,
      makeDummyProof: () => this.deps.proofs.proveDummy(),
    });

    const tx = await this.deps.chain.pxe.sendClaimAbandonedGame(this.deps.chain.address, args, {
      node: this.deps.chain.nodeClient, timeoutMs: this.txTimeoutMs,
    });
    this.log(`sweep: ${short(rec.onChainGameId)} claimed ${String(tx).slice(0, 18)}…`);
  }

  private async importRecoveredCards(rec: GameRecord, txHash: string): Promise<void> {
    try {
      const { fetchTxEffectData } = await import('../../frontend/src/aztec/noteImporter.js');
      const txEffect = await fetchTxEffectData(this.deps.chain.nodeClient as any, txHash);
      if (!txEffect) {
        this.log(`sweep: WARNING no TxEffect for ${txHash.slice(0, 18)}… — ` +
                 `cards are on-chain but not yet visible to the PXE`);
        return;
      }
      // Our five, minted with caller_randomness[0..4]. There is no sixth card:
      // recovery no longer takes anything from the opponent.
      const notes = rec.cardIds.slice(0, 5).map((tokenId, i) => ({
        tokenId, randomness: rec.randomness[i],
      }));
      await this.deps.chain.pxe.importCardNotes(
        this.deps.chain.address, txHash, notes, 'abandoned-game recovery', txEffect,
      );
    } catch (err) {
      // Not fatal: the cards ARE ours on-chain, and a later sweep or a PXE
      // resync can still surface them. Loud, though — an unimported note looks
      // exactly like a failed recovery from the outside.
      this.log(`sweep: WARNING note import failed: ${(err as Error).message}`);
    }
  }

  private async settle(rec: GameRecord): Promise<void> {
    const { buildSettleAbandonedArgs, waitForDisputeWindow, DISPUTE_BLOCKS } =
      await import('../../frontend/src/aztec/settlementArgs.js');
    const { Fr } = await import('@aztec/aztec.js/fields');

    this.log(`sweep: waiting ${DISPUTE_BLOCKS} blocks for the dispute window`);
    await waitForDisputeWindow(this.deps.chain.nodeClient);
    // That wait is minutes long and touches only the node, so a game can start
    // during it. Settling now would seize the PXE queue for several more
    // minutes; the claim stands, so the next pass picks this up.
    if (this.yieldToGame('settle deferred after the dispute window')) return;

    // Recovery returns OUR stake and nothing else. It used to also take one of
    // the opponent's cards, from a list nothing verified — which meant naming
    // any card and having it minted to us. Nobody wins a card because an
    // opponent disconnected, and the absent player recovers their own five
    // whenever they come back.
    const args = await buildSettleAbandonedArgs({
      Fr,
      onChainGameId: rec.onChainGameId,
      myCardIds: rec.cardIds,
      myRandomness: rec.randomness,
      myBlinding: rec.blindingFactor!,
    });

    const tx = await this.deps.chain.pxe.sendSettleAbandonedGame(this.deps.chain.address, args, {
      node: this.deps.chain.nodeClient, timeoutMs: this.txTimeoutMs,
    });

    // The cards are ours on-chain but INVISIBLE until imported: settle_abandoned_game
    // re-mints them through create_and_push_note, which skips on-chain tagging, so
    // the PXE cannot discover them (CLAUDE.md ground rule 9). Without this the
    // sweep reports success while the bot's spendable count does not move — which
    // is exactly what the first chain run of this code did.
    await this.importRecoveredCards(rec, String(tx));

    this.stats.recovered += 1;
    this.stats.cardsRecovered += rec.cardIds.length;
    this.deps.journal.forget(rec.onChainGameId);
    this.log(
      `sweep: ${short(rec.onChainGameId)} RECOVERED ${rec.cardIds.length} card(s) ${String(tx).slice(0, 18)}…`,
    );
  }
}

/**
 * Re-import the notes settle_abandoned_game minted back to us.
 *
 * The contract mints our five cards with caller_randomness[0..4], and — when we
 * claimed one — the opponent's card with caller_randomness[5]. Note import is
 * best-effort per note and idempotent, so a partial failure is recoverable by
 * running the sweep again rather than fatal.
 */
function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}
