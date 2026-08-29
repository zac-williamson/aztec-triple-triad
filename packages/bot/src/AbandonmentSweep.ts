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
  lastError: string | null;
}

export interface SweepDeps {
  journal: GameJournal;
  chain: BotChain;
  proofs: BotProofs;
  log?: (msg: string) => void;
  now?: () => number;
  /** Minimum age before a game is considered abandoned rather than merely slow. */
  minAgeMs?: number;
  txTimeoutMs?: number;
}

export class AbandonmentSweep {
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly minAgeMs: number;
  private readonly txTimeoutMs: number;
  private running = false;

  readonly stats: SweepStats = {
    scanned: 0, recovered: 0, cardsRecovered: 0, failed: 0, skipped: 0, lastError: null,
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
      const outstanding = this.deps.journal.outstanding();
      this.stats.scanned = outstanding.length;
      if (outstanding.length === 0) return this.stats;
      this.log(`sweep: ${outstanding.length} game(s) with cards committed`);

      for (const rec of outstanding) {
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
      // Claimed but not settled — finish the job.
      this.log(`sweep: ${id} already claimed; settling`);
      await this.settle(rec);
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

    if (!rec.myHandProof || !rec.opponentHandProof) {
      this.stats.skipped += 1;
      // Not recoverable by us: the claim verifies BOTH hand proofs. Say so
      // rather than retrying forever in silence.
      this.log(`sweep: ${id} UNRECOVERABLE — hand proofs missing from the journal ` +
               `(${rec.cardIds.length} cards stay locked)`);
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

    this.log(`sweep: ${id} abandoned (${Math.round(age / 60_000)}min, ${rec.moveProofs.length}/9 moves) — claiming`);
    await this.claim(rec);
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

  private async importRecoveredCards(rec: GameRecord, txHash: string, claimedCardId: number): Promise<void> {
    try {
      const { fetchTxEffectData } = await import('../../frontend/src/aztec/noteImporter.js');
      const txEffect = await fetchTxEffectData(this.deps.chain.nodeClient as any, txHash);
      if (!txEffect) {
        this.log(`sweep: WARNING no TxEffect for ${txHash.slice(0, 18)}… — ` +
                 `cards are on-chain but not yet visible to the PXE`);
        return;
      }
      const notes = rec.cardIds.slice(0, 5).map((tokenId, i) => ({
        tokenId, randomness: rec.randomness[i],
      }));
      // caller_randomness[5] is the slot the contract uses for the claimed card.
      if (claimedCardId !== 0 && rec.randomness[5]) {
        notes.push({ tokenId: claimedCardId, randomness: rec.randomness[5] });
      }
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
    const { AztecAddress } = await import('@aztec/aztec.js/addresses');

    this.log(`sweep: waiting ${DISPUTE_BLOCKS} blocks for the dispute window`);
    await waitForDisputeWindow(this.deps.chain.nodeClient);

    // Take a card only if the opponent actually played one — same rule as the
    // browser. The point of the sweep is to get OUR stake back; an opponent
    // whose client crashed on move one has not forfeited anything.
    const opponentPlayed = rec.moveProofs.length >= 2;
    const claimedCardId = opponentPlayed && rec.opponentCardIds.length > 0 ? rec.opponentCardIds[0] : 0;

    if (!rec.opponentAddress) {
      throw new Error('cannot settle abandoned game: opponent address missing from the journal');
    }

    const args = await buildSettleAbandonedArgs({
      Fr, AztecAddress,
      onChainGameId: rec.onChainGameId,
      myCardIds: rec.cardIds,
      myRandomness: rec.randomness,
      opponentCardIds: rec.opponentCardIds,
      claimedCardId,
      opponentAddress: rec.opponentAddress,
    });

    const tx = await this.deps.chain.pxe.sendSettleAbandonedGame(this.deps.chain.address, args, {
      node: this.deps.chain.nodeClient, timeoutMs: this.txTimeoutMs,
    });

    // The cards are ours on-chain but INVISIBLE until imported: settle_abandoned_game
    // re-mints them through create_and_push_note, which skips on-chain tagging, so
    // the PXE cannot discover them (CLAUDE.md ground rule 9). Without this the
    // sweep reports success while the bot's spendable count does not move — which
    // is exactly what the first chain run of this code did.
    await this.importRecoveredCards(rec, String(tx), claimedCardId);

    this.stats.recovered += 1;
    this.stats.cardsRecovered += rec.cardIds.length;
    this.deps.journal.forget(rec.onChainGameId);
    this.log(
      `sweep: ${short(rec.onChainGameId)} RECOVERED ${rec.cardIds.length} card(s)` +
      `${claimedCardId ? ` + claimed card ${claimedCardId}` : ''} ${String(tx).slice(0, 18)}…`,
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
