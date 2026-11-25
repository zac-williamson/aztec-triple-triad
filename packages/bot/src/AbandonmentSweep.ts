/**
 * Brings the bot's cards back from games that will not resolve the ordinary
 * way: the opponent closed their tab, never settled, or this process died.
 *
 * Why this is not optional. The bot only ever JOINS games, and cancel_game is
 * creator-only — so a game that wedges keeps the bot's five committed cards
 * until somebody resolves it on-chain, and a private game's notes come back
 * only to whoever imports them. Left alone the loss is monotonic and silent:
 * the bot keeps playing until it cannot field a hand, then goes idle, which
 * looks exactly like a quiet night.
 *
 * A private game has no public state (docs/plan/PRIVATE_GAMES.md), so the
 * sweep reads where each game stands from its nullifiers, then takes the next
 * step the contract allows:
 *
 *   resolved      import our own notes from the tx that pushed `done`
 *   complete      settle it on its merits (a full transcript outranks any
 *                 claim), contesting an opponent's standing claim first
 *   incomplete    claim it as abandoned, taking the opponent's best open
 *                 card (walking away costs a card, §3.4), and once the claim
 *                 has stood its dispute window, finalize: our five back plus
 *                 that card, the rest to them
 *
 * Deliberately conservative:
 *  - The CHAIN decides, never the journal. Each pass re-reads the nullifiers.
 *  - Nothing younger than `minAgeMs` is touched: a finalize would pre-empt a
 *    slow winner's settlement, and that is their card, not ours.
 *  - One step per game per pass, through the same serialised PXE queue as
 *    play, and never while a game is live.
 */
import type { GameJournal, JournalRecord } from './GameJournal.js';
import type { BotChainLike, BotProofsLike } from './chainTypes.js';
import {
  abandonmentPosition,
  CLAIM_NUMBERS,
  hasContested,
  NULLIFIER_INDEX,
  parseGameChainState,
  RECORD_HAND,
  type ClaimNo,
  type GameChainState,
  type Resolution,
  type Side,
} from '../../frontend/src/aztec/privateGame.js';
import {
  buildClaimForfeitArgs,
  chooseForfeit,
  NO_FORFEIT,
  NO_FORFEIT_TERMS,
  OPEN_CARD_SLOTS,
  type ClaimForfeit,
  type ForfeitTerms,
} from '../../frontend/src/aztec/settlementArgs.js';
import type { OpenCardsPayload } from '../../frontend/src/aztec/localGame.js';
import {
  BOT_SIDE,
  blocksToTime,
  cardValue,
  checkTranscript,
  decideSweepStep,
  DISPUTE_SECONDS,
  normalizeMoveProof,
  transcriptSettles,
} from './protocol.js';
import {
  choosePrizeMove,
  describeResolution,
  findResolvingTx,
  importOwnNotes,
  settleGame,
  type BotGame,
  type SettlementDeps,
} from './settlement.js';
import type { FoundTx } from '../../frontend/src/aztec/gameChain.js';
import type { MoveProofData } from '../../frontend/src/types.js';

export { MIN_ABANDON_SECONDS } from './protocol.js';

export interface SweepStats {
  scanned: number;
  /** Games whose cards came back to the bot this process lifetime. */
  recovered: number;
  cardsRecovered: number;
  /** Steps taken on-chain. */
  settled: number;
  claimed: number;
  contested: number;
  finalized: number;
  failed: number;
  skipped: number;
  /**
   * Cards in journal entries the sweep cannot act on at all — the record is
   * missing what recovery needs. A number rather than a repeated log line,
   * because it is a permanent fact, not an event.
   */
  unrecoverable: number;
  lastError: string | null;
}

export interface SweepDeps {
  journal: Pick<GameJournal, 'outstanding' | 'read' | 'write' | 'forget' | 'markResolved'>
    & Partial<Pick<GameJournal, 'pruneResolved'>>;
  chain: BotChainLike;
  proofs: Pick<BotProofsLike, 'moveVerificationKey' | 'handVerificationKey' | 'proveOpenCards'>;
  log?: (msg: string) => void;
  now?: () => number;
  /**
   * True while the bot is in a game.
   *
   * The sweep and live gameplay share ONE serial PXE queue, and a settlement
   * holds it for minutes while it proves. A player who gets matched during a
   * pass would wait behind maintenance for an old game: their opponent never
   * joins, and the match dies at move zero. Recovery can always wait.
   */
  isBusy?: () => boolean;
  /** True for a game the live bot is still following up itself (its SETTLED is due). */
  isTracking?: (relayGameId: string) => boolean;
  /** Minimum age before a game is considered abandoned rather than merely slow. */
  minAgeMs?: number;
  /** A tx's wait, in ms. */
  txTimeoutMs?: number;
}

/** How long a resolved game's record is kept for manual recovery of a failed import. */
export const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * How long the sweep leaves a game alone before acting on it, when the caller
 * does not say (production passes its game timeout, also 30 min).
 *
 * Far past the contract's own eight-minute bar on purpose. A game the bot LOST
 * stays outstanding until the human winner settles; a claim does not block
 * that, but a FINALIZE ten minutes later would, and would take their win away.
 * Thirty minutes outlasts a game plus a settlement at their slowest.
 */
export const DEFAULT_SWEEP_MIN_AGE_MS = 30 * 60_000;

/** How long to wait for a resolution we just sent to show on the node. */
const RESOLUTION_WAIT_MS = 2 * 60_000;

export class AbandonmentSweep {
  /** Records already reported as unusable; reported once each. */
  private readonly reportedUnrecoverable = new Set<string>();

  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly minAgeMs: number;
  private readonly txTimeoutMs: number;
  private running = false;

  readonly stats: SweepStats = {
    scanned: 0, recovered: 0, cardsRecovered: 0, settled: 0, claimed: 0, contested: 0, finalized: 0,
    failed: 0, skipped: 0, unrecoverable: 0, lastError: null,
  };

  constructor(private readonly deps: SweepDeps) {
    this.log = deps.log ?? (() => {});
    this.now = deps.now ?? (() => Date.now());
    // A game in progress looks exactly like an abandoned one from the journal's
    // point of view; only age separates them.
    this.minAgeMs = deps.minAgeMs ?? DEFAULT_SWEEP_MIN_AGE_MS;
    this.txTimeoutMs = deps.txTimeoutMs ?? 600_000;
  }

  /**
   * One pass over the journal. Safe to call repeatedly; never runs concurrently
   * with itself, because two passes over one game would race each other's txs.
   */
  async run(): Promise<SweepStats> {
    if (this.running) return this.stats;
    this.running = true;
    try {
      // Resolved records are kept so a failed import stays recoverable by hand,
      // but not forever — a week is long enough to notice and act.
      const pruned = this.deps.journal.pruneResolved?.(SETTLED_RETENTION_MS) ?? 0;
      if (pruned) this.log(`sweep: pruned ${pruned} resolved record(s)`);

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
        if (this.deps.isTracking?.(rec.relayGameId)) {
          this.stats.skipped += 1;
          continue;
        }
        try {
          await this.recoverOne(rec);
        } catch (err) {
          this.stats.failed += 1;
          this.stats.lastError = (err as Error).message;
          // Keep the record. A failed step is retried next pass; deleting it
          // would discard the only evidence that five cards are locked up.
          this.log(`sweep: ${short(rec.relayGameId)} FAILED — ${(err as Error).message}`);
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

  private settlementDeps(): SettlementDeps {
    return {
      chain: this.deps.chain,
      // pxe.ts hands `timeoutMs` to the SDK's wait, which counts SECONDS.
      sendOpts: () => ({ node: this.deps.chain.nodeClient, timeoutMs: Math.ceil(this.txTimeoutMs / 1000) }),
      log: this.log,
    };
  }

  private async recoverOne(rec: JournalRecord): Promise<void> {
    const id = short(rec.relayGameId);
    const game = toBotGame(rec);
    if (!game) {
      this.stats.skipped += 1;
      this.stats.unrecoverable += rec.cardIds?.length ?? 5;
      if (!this.reportedUnrecoverable.has(rec.relayGameId)) {
        this.reportedUnrecoverable.add(rec.relayGameId);
        this.log(`sweep: ${id} UNRECOVERABLE — the journal entry is missing what recovery needs ` +
                 '(not reported again; the record stays on disk)');
      }
      return;
    }

    const { chain } = this.deps;
    const nullifiers = await chain.pxe.gameNullifiers(chain.address, game.gameKey, game.record1, game.record2);
    const state = parseGameChainState(await chain.lookupNullifiers(nullifiers));
    const position = abandonmentPosition(state);
    const age = this.now() - rec.committedAt;

    if (position.kind === 'not-joined') {
      this.stats.skipped += 1;
      if (rec.phase === 'joining' && age >= this.minAgeMs) {
        // We wrote the record just before sending the join, and the join never
        // landed: nothing of ours was ever committed.
        this.log(`sweep: ${id} our join never landed — nothing committed; forgetting`);
        this.deps.journal.forget(rec.relayGameId);
      } else if (rec.phase === 'joined') {
        // We saw the join mine, yet the chain does not know it. Never forget
        // this: it is either a node behind the chain or a record that does not
        // match what we committed, and either way five cards may be at stake.
        this.log(`sweep: ${id} journalled as joined, but the chain has no such join — keeping it`);
      }
      return;
    }
    if (rec.phase === 'joining') this.update(rec.relayGameId, { phase: 'joined' });

    if (age < this.minAgeMs) {
      this.stats.skipped += 1;
      this.log(`sweep: ${id} only ${Math.round(age / 60_000)}min old — may still be live, leaving it`);
      return;
    }

    const complete = transcriptSettles(game.moveProofs, game.record1, game.record2);
    const times = new Map<number, number>();
    let now = 0;
    if (position.kind !== 'done') {
      // The contract compares block TIMESTAMPS, against its anchor's — the
      // chain's clock, not ours. Block rate is not a clock either.
      now = await chain.chainNow();
      for (const b of blocksToTime(position)) times.set(b, await chain.blockTimestamp(b));
    }
    const step = decideSweepStep({
      position,
      contestedByUs: hasContested(state, BOT_SIDE),
      transcriptComplete: complete,
      now,
      blockTime: b => {
        const t = times.get(b);
        if (t === undefined) throw new Error(`no timestamp read for block ${b}`);
        return t;
      },
    });

    switch (step.kind) {
      case 'not-joined':
        return;
      case 'resolved': {
        const tx = await findResolvingTx(this.settlementDeps(), game);
        if (!tx) throw new Error('the game reads as resolved, but no tx carries its resolution');
        await this.importFrom(rec, game, tx, await this.finalizedClaimResolution(game, state));
        return;
      }
      case 'wait':
        this.stats.skipped += 1;
        this.log(`sweep: ${id} ${step.reason}`);
        return;
      case 'settle':
        await this.settle(rec, game, step.contest);
        return;
      case 'claim':
        await this.claim(rec, game, step.claimNo, step.clockBlock, nullifiers);
        return;
      case 'finalize':
        await this.finalize(rec, game, step.claimNo, step.claimSide, step.claimBlock);
        return;
    }
  }

  /**
   * Import our own notes from the tx that resolved the game, and close the
   * record. `resolution` is what the chain already says the tx was (a
   * finalized claim's terms); without it the tx itself is read.
   */
  private async importFrom(rec: JournalRecord, game: BotGame, tx: FoundTx, resolution?: Resolution): Promise<void> {
    const result = await importOwnNotes(this.settlementDeps(), game, tx, resolution);
    this.stats.recovered += 1;
    this.stats.cardsRecovered += Math.max(0, result.gainedCards);
    if (result.gainedCards < result.expectedCards) {
      this.log(`sweep: ${short(rec.relayGameId)} WARNING expected ${result.expectedCards} card(s) back, ` +
               `gained ${result.gainedCards} — the rest are ours on-chain but invisible`);
    }
    const kind = result.resolution.kind;
    this.deps.journal.markResolved(
      rec.relayGameId,
      kind === 'unwound' || kind === 'forfeited' ? kind : 'settled',
      result.txHash,
    );
    this.log(`sweep: ${short(rec.relayGameId)} ${describeResolution(result.resolution)} — ` +
             `took back ${result.gainedCards} card(s) ${short(result.txHash)}`);
  }

  /**
   * Settle a game whose whole transcript we hold. Its result stands whoever
   * presses the button: if we won, the prize is the loser's card we value
   * most; if we lost, the winner gets the card they would get by default —
   * the bot does not keep its best card by being the one settling.
   */
  private async settle(
    rec: JournalRecord,
    game: BotGame,
    contest: { claimNo: ClaimNo; claimSide: Side; beforeClaimBlock: number } | null,
  ): Promise<void> {
    const id = short(rec.relayGameId);
    const { chain } = this.deps;
    const deps = this.settlementDeps();
    const ref = { gameKey: game.gameKey, record1: game.record1, record2: game.record2 };
    if (contest) {
      // An opponent's claim is standing and a settlement takes minutes to
      // prove. Contesting is quick and restarts their clock, so their finalize
      // cannot race our settlement.
      await chain.pxe.sendContestAbandonment(chain.address, ref, { side: BOT_SIDE, ...contest }, deps.sendOpts());
      this.stats.contested += 1;
      this.log(`sweep: ${id} contested the opponent's claim ${contest.claimNo} — settling instead`);
      if (this.yieldToGame(`${id} contested; settlement deferred`)) return;
    }

    const { ordered, winner } = checkTranscript(game.moveProofs, game.record1, game.record2);
    const prizeMove = choosePrizeMove(ordered, winner);
    this.update(rec.relayGameId, { prizeMove });
    this.log(`sweep: ${id} settling a complete game (${winner === 'draw' ? 'draw' : `player ${winner} won`})`);
    try {
      await settleGame(deps, { ...game, prizeMove }, prizeMove, await this.deps.proofs.moveVerificationKey());
    } catch (err) {
      // A game resolves once. If something else got there first, our cards are
      // in THAT tx; the next pass imports them.
      const tx = await findResolvingTx(deps, game).catch(() => null);
      if (tx) {
        this.log(`sweep: ${id} resolved by another tx while we settled`);
        await this.importFrom(rec, game, tx);
        return;
      }
      throw err;
    }
    this.stats.settled += 1;
    if (this.yieldToGame(`${id} settled; import deferred`)) return;
    const tx = await findResolvingTx(deps, game, { waitMs: RESOLUTION_WAIT_MS });
    if (!tx) throw new Error('settled, but the settlement is not visible on the node yet — the next pass imports it');
    await this.importFrom(rec, { ...game, prizeMove }, tx);
  }

  /**
   * What our claim carries (docs/plan/PRIVATE_GAMES.md §3.4): the opponent's
   * checked open-cards proof, taking the open card the bot values most; or,
   * if they never sent theirs, our own, taking nothing.
   */
  private async claimForfeit(game: BotGame): Promise<ClaimForfeit> {
    const theirs = game.opponentOpen;
    if (theirs && theirs.cards.length === OPEN_CARD_SLOTS) {
      return { terms: chooseForfeit(theirs.cards, cardValue), proof: theirs.proof, publicInputs: theirs.publicInputs };
    }
    const own = game.ownOpen ?? await this.proveOwnOpenCards(game);
    return { terms: NO_FORFEIT_TERMS, proof: own.proof, publicInputs: own.publicInputs };
  }

  private async proveOwnOpenCards(game: BotGame): Promise<OpenCardsPayload> {
    const { chain } = this.deps;
    const secrets = await chain.pxe.computeGameSecrets(chain.address, game.nonce);
    return this.deps.proofs.proveOpenCards(game.cardIds, secrets.blinding, game.record2[RECORD_HAND]);
  }

  /**
   * A claim's terms, read off the chain: it pushed one of four terms
   * nullifiers (each open card, or nothing). The cards a claim against us
   * could take are our own first three; ours took from the opponent's.
   */
  private async claimTerms(game: BotGame, claimNo: ClaimNo, claimSide: Side): Promise<ForfeitTerms> {
    const { chain } = this.deps;
    const theirs = game.opponentOpen?.cards;
    const cards = claimSide !== BOT_SIDE
      ? game.cardIds.slice(0, OPEN_CARD_SLOTS)
      : theirs && theirs.length === OPEN_CARD_SLOTS ? [...theirs] : null;
    // Unknown cards hash to terms nobody pushed; "nothing taken" is still checked.
    const nullifiers = await chain.pxe.forfeitNullifiers(
      chain.address, game.gameKey, game.record1, claimNo, claimSide, cards ?? [0, 0, 0],
    );
    const found = (await chain.lookupNullifiers(nullifiers)).findIndex(Boolean);
    if (found < 0) throw new Error(`claim ${claimNo}: none of its possible terms is on-chain`);
    if (found === OPEN_CARD_SLOTS) return NO_FORFEIT_TERMS;
    return { slot: found, cardId: cards![found] };
  }

  /**
   * How a resolved game ended, when it ended by an abandonment claim: that
   * claim's terms. Undefined for a settlement or a cancel (the tx says).
   */
  private async finalizedClaimResolution(game: BotGame, state: GameChainState): Promise<Resolution | undefined> {
    for (const c of CLAIM_NUMBERS) {
      // Resolved without a contest: finalized.
      if (!state.resolved[c - 1] || state.contests[c - 1]) continue;
      const [bySide1, bySide2] = state.claims[c - 1];
      if (!bySide1 && !bySide2) continue;
      const claimSide: Side = bySide1 ? 1 : 2;
      try {
        return resolutionOf(claimSide, await this.claimTerms(game, c, claimSide));
      } catch (err) {
        this.log(`sweep: could not read claim ${c}'s terms (${(err as Error).message}) — reading the tx instead`);
        return undefined;
      }
    }
    return undefined;
  }

  /** Claim the game as abandoned. Finalized by a later pass, once the dispute window has passed. */
  private async claim(
    rec: JournalRecord,
    game: BotGame,
    claimNo: ClaimNo,
    clockBlock: number,
    nullifiers: string[],
  ): Promise<void> {
    const { chain } = this.deps;
    const deps = this.settlementDeps();
    const id = short(rec.relayGameId);
    const forfeit = await this.claimForfeit(game);
    const taking = forfeit.terms.slot === NO_FORFEIT ? 'taking nothing' : `taking their open card ${forfeit.terms.cardId}`;
    this.log(`sweep: ${id} abandoned (${rec.moveProofs.length}/9 moves) — filing claim ${claimNo}, ${taking}`);
    const { Fr } = await import('@aztec-labs/aztec.js/fields');
    await chain.pxe.sendClaimAbandonedGame(
      chain.address,
      { gameKey: game.gameKey, record1: game.record1, record2: game.record2 },
      { side: BOT_SIDE, claimNo, clockBlock },
      await buildClaimForfeitArgs(Fr, await this.deps.proofs.handVerificationKey(), forfeit),
      deps.sendOpts(),
    );
    this.stats.claimed += 1;
    // Put the claim's time in the journal, so the worklist can say the game is
    // serving out its window rather than looking untouched for ten minutes.
    let claimedAt = Math.floor(this.now() / 1000);
    try {
      const [hit] = await chain.lookupNullifiers([nullifiers[NULLIFIER_INDEX.claim(claimNo, BOT_SIDE)]]);
      if (hit) claimedAt = await chain.blockTimestamp(hit.blockNumber);
    } catch { /* bookkeeping must never fail a recovery in progress */ }
    this.update(rec.relayGameId, { claimedAt });
    this.log(`sweep: ${id} claim ${claimNo} filed — finalizable after the ${DISPUTE_SECONDS}s dispute window`);
  }

  /**
   * Finalize a claim that stood its window — anyone may — and take our cards
   * back: our five plus the card it took if the claim was ours, our other four
   * if it was theirs.
   */
  private async finalize(
    rec: JournalRecord,
    game: BotGame,
    claimNo: ClaimNo,
    claimSide: Side,
    claimBlock: number,
  ): Promise<void> {
    const { chain } = this.deps;
    const deps = this.settlementDeps();
    const id = short(rec.relayGameId);
    const terms = await this.claimTerms(game, claimNo, claimSide);
    this.log(`sweep: ${id} claim ${claimNo} stood its window — finalizing` +
             (terms.slot === NO_FORFEIT ? '' : ` (it took card ${terms.cardId})`));
    try {
      await chain.pxe.sendFinalizeAbandonedGame(
        chain.address,
        { gameKey: game.gameKey, record1: game.record1, record2: game.record2 },
        { claimNo, claimSide, claimBlock },
        terms,
        deps.sendOpts(),
      );
    } catch (err) {
      const tx = await findResolvingTx(deps, game).catch(() => null);
      if (tx) {
        this.log(`sweep: ${id} resolved by another tx while we finalized`);
        await this.importFrom(rec, game, tx);
        return;
      }
      throw err;
    }
    this.stats.finalized += 1;
    if (this.yieldToGame(`${id} finalized; import deferred`)) return;
    const tx = await findResolvingTx(deps, game, { waitMs: RESOLUTION_WAIT_MS });
    if (!tx) throw new Error('finalized, but the unwind is not visible on the node yet — the next pass imports it');
    await this.importFrom(rec, game, tx, resolutionOf(claimSide, terms));
  }

  /** Re-read and merge, so a field the bot wrote meanwhile is not lost. */
  private update(relayGameId: string, fields: Partial<JournalRecord>): void {
    try {
      const fresh = this.deps.journal.read(relayGameId);
      if (fresh) this.deps.journal.write({ ...fresh, ...fields });
    } catch { /* bookkeeping must never stop a recovery in progress */ }
  }
}

/** What finalizing a claim with these terms did to the game. */
function resolutionOf(claimSide: Side, terms: ForfeitTerms): Resolution {
  if (terms.slot === NO_FORFEIT) return { kind: 'unwound' };
  return { kind: 'forfeited', claimSide, card: { cardId: terms.cardId, slot: terms.slot } };
}

/** A journalled open-cards payload, if it is well formed. */
function openCardsOf(v: unknown): OpenCardsPayload | null {
  const o = v as { cards?: unknown; proof?: unknown; publicInputs?: unknown } | null | undefined;
  if (!o || !Array.isArray(o.cards) || typeof o.proof !== 'string' || !Array.isArray(o.publicInputs)) return null;
  if (!o.cards.every(c => Number.isInteger(c)) || !o.publicInputs.every(p => typeof p === 'string')) return null;
  return { cards: [...o.cards] as number[], proof: o.proof, publicInputs: [...o.publicInputs] as string[] };
}

/** The journal entry as settlement and import see it, or null if it is missing what they need. */
export function toBotGame(rec: JournalRecord): BotGame | null {
  const isFields = (v: unknown, n: number) => Array.isArray(v) && v.length === n && v.every(x => typeof x === 'string');
  if (typeof rec.gameKey !== 'string' || typeof rec.nonce !== 'string') return null;
  if (!isFields(rec.record1, 9) || !isFields(rec.record2, 9)) return null;
  if (!Array.isArray(rec.cardIds) || rec.cardIds.length !== 5) return null;
  const moveProofs = (rec.moveProofs ?? [])
    .map(normalizeMoveProof)
    .filter((p): p is MoveProofData => p !== null);
  return {
    gameKey: rec.gameKey,
    nonce: rec.nonce,
    cardIds: [...rec.cardIds],
    record1: [...rec.record1],
    record2: [...rec.record2],
    moveProofs,
    outcome: rec.outcome ?? null,
    prizeMove: rec.prizeMove ?? null,
    opponentOpen: openCardsOf(rec.opponentOpenProof),
    ownOpen: openCardsOf(rec.ownOpenCards),
  };
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}
