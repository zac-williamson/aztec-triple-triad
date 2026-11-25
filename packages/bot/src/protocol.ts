/**
 * The bot's own decisions in the private-game protocol
 * (docs/plan/PRIVATE_GAMES.md): which card it wants as a prize, which PEER
 * payloads and move proofs it accepts, and what the recovery sweep does next
 * with a game it can no longer play.
 *
 * Pure: no chain, relay or prover. The protocol's shared core — records, the
 * nullifier layout, reading a transcript, which notes are a player's own, the
 * game model and the checks of the opponent's moves — is the frontend's
 * (privateGame.ts, localGame.ts, moveChecks.ts), imported rather than copied,
 * so the bot and a browser cannot disagree about it.
 */
import { getCardById } from '@axolotl-arena/game-logic';
import type { Rarity } from '@axolotl-arena/game-logic';
import {
  normalizeField,
  orderTranscript,
  RECORD_HAND,
  winnerOf,
  type AbandonmentPosition,
  type ClaimNo,
  type GameRecord,
  type Side,
  type Winner,
} from '../../frontend/src/aztec/privateGame.js';
import { DISPUTE_SECONDS, MIN_ABANDON_SECONDS } from '../../frontend/src/aztec/settlementArgs.js';
import { parsePeerPayload as parseOrThrow, type PeerPayload } from '../../frontend/src/aztec/peerChannel.js';
import type { MoveProofData } from '../../frontend/src/types.js';

export type { PeerPayload };

export { DISPUTE_SECONDS, MIN_ABANDON_SECONDS };

/** The bot only ever joins, so it is always player 2 — side 2 on-chain. */
export const BOT_SIDE: Side = 2;

/** A finished game from the bot's seat. */
export type Outcome = 'win' | 'loss' | 'draw';

/** A game's result (`player1` / `player2` / `draw`, as the board gives it) from the bot's seat. */
export function outcomeFor(winner: unknown, me: 'player1' | 'player2'): Outcome {
  if (winner === 'draw') return 'draw';
  return winner === me ? 'win' : 'loss';
}

/** An outcome as the transcript's winner (side 1, side 2, or a draw). */
export function winnerFromOutcome(outcome: Outcome): Winner {
  if (outcome === 'draw') return 'draw';
  return outcome === 'win' ? BOT_SIDE : (BOT_SIDE === 2 ? 1 : 2);
}

// ─── Prize choice ───────────────────────────────────────────────────────────

const RARITY_TIER: Record<Rarity, number> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4,
};

/**
 * How much the bot wants a card: rarer first, then stronger (the sum of its
 * four ranks, at most 40). One number, so the shared `defaultPrizeMove` can
 * rank by it; it breaks a tie with the earlier move.
 *
 * Rarity leads because the stock the bot is provisioned with is deliberately
 * weak and common, and a rare card is what a collection is short of; among
 * equally rare cards the stronger one is the better player.
 */
export function cardValue(cardId: number): number {
  const card = getCardById(cardId);
  if (!card) return 0;
  const tier = RARITY_TIER[card.rarity ?? 'common'] ?? 0;
  const ranks = card.ranks.top + card.ranks.right + card.ranks.bottom + card.ranks.left;
  return tier * 100 + ranks;
}

// ─── What arrives from the opponent ─────────────────────────────────────────

/**
 * Accept a decrypted PEER payload only if it is well formed — the browser's
 * own validation (peerChannel.ts), so both ends agree on what a payload is. It
 * came from the opponent: a malformed record, prize index or set of open cards
 * is dropped here rather than reaching a transaction or a check.
 */
export function parsePeerPayload(raw: unknown): PeerPayload | null {
  try { return parseOrThrow(raw); } catch { return null; }
}

/** A game_move proof carries eight public inputs (§4). */
export const MOVE_PUBLIC_INPUTS = 8;

/**
 * A move proof as the bot keeps it: every derived field read from the eight
 * public inputs, never from what anyone claimed about them, so a proof's chain
 * links and placed card are exactly what settlement will verify. Null for
 * anything that cannot be a game_move proof.
 */
export function normalizeMoveProof(raw: unknown): MoveProofData | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.proof !== 'string' || p.proof.length === 0) return null;
  if (!Array.isArray(p.publicInputs) || p.publicInputs.length !== MOVE_PUBLIC_INPUTS) return null;
  let inputs: string[];
  try { inputs = p.publicInputs.map(normalizeField); } catch { return null; }
  return {
    proof: p.proof,
    publicInputs: inputs,
    cardCommit1: inputs[0],
    cardCommit2: inputs[1],
    startStateHash: inputs[2],
    endStateHash: inputs[3],
    gameEnded: BigInt(inputs[4]) !== 0n,
    winnerId: Number(BigInt(inputs[5])),
    placedCardId: Number(BigInt(inputs[6])),
    placedSlot: Number(BigInt(inputs[7])),
  };
}

/**
 * The whole transcript, ordered and checked against THIS game's two records:
 * nine moves, one chain, every move bound to both committed hands, and the
 * ninth naming the result. Throws with the reason, because the alternative is
 * an on-chain revert after the expensive recursive verification.
 */
export function checkTranscript(
  proofs: MoveProofData[],
  record1: GameRecord,
  record2: GameRecord,
): { ordered: MoveProofData[]; winner: Winner } {
  if (proofs.length < 9) throw new Error(`transcript incomplete: ${9 - proofs.length} move proof(s) missing`);
  const ordered = orderTranscript(proofs);
  if (ordered.length < 9) throw new Error(`transcript broken: only ${ordered.length} of ${proofs.length} proofs chain`);
  const hand1 = normalizeField(record1[RECORD_HAND]);
  const hand2 = normalizeField(record2[RECORD_HAND]);
  for (const [i, m] of ordered.entries()) {
    if (normalizeField(m.cardCommit1) !== hand1 || normalizeField(m.cardCommit2) !== hand2) {
      throw new Error(`move ${i} is not bound to this game's two hands`);
    }
  }
  return { ordered, winner: winnerOf(ordered) };
}

/** Whether `proofs` can settle the game (see checkTranscript). */
export function transcriptSettles(proofs: MoveProofData[], record1: GameRecord, record2: GameRecord): boolean {
  try { checkTranscript(proofs, record1, record2); return true; } catch { return false; }
}

// ─── The recovery sweep ─────────────────────────────────────────────────────

/** What the sweep does next with a game it can no longer play. */
export type SweepStep =
  /** Our join never landed (or not yet): nothing of ours is committed. */
  | { kind: 'not-joined' }
  /** Resolved on-chain: import our own notes from the resolving tx. */
  | { kind: 'resolved' }
  /**
   * A complete transcript: settle it on its merits — a full transcript
   * outranks any claim. Contest an opponent's standing claim first when we
   * still can, so their finalize cannot race the (slow) settlement.
   */
  | { kind: 'settle'; contest: { claimNo: ClaimNo; claimSide: Side; beforeClaimBlock: number } | null }
  | { kind: 'claim'; claimNo: ClaimNo; clockBlock: number }
  | { kind: 'finalize'; claimNo: ClaimNo; claimSide: Side; claimBlock: number }
  | { kind: 'wait'; reason: string };

export interface SweepInputs {
  position: AbandonmentPosition;
  /** We have already used our one contest. */
  contestedByUs: boolean;
  /** We hold a transcript that settles the game (see checkTranscript). */
  transcriptComplete: boolean;
  /** Chain time now: the latest block's timestamp, in seconds. */
  now: number;
  /** Timestamps of the blocks `blocksToTime(position)` names. */
  blockTime: (blockNumber: number) => number;
  /**
   * Slack against the proof's anchor lagging the latest block. The contract
   * compares its ANCHOR's time, which is a little behind `now`.
   */
  marginSeconds?: number;
}

/** The blocks whose timestamps decideSweepStep needs for `position`. */
export function blocksToTime(position: AbandonmentPosition): number[] {
  if (position.kind === 'can-claim') return [position.clockBlock];
  if (position.kind === 'open-claim') return [position.claimBlock, position.claimBlock - 1];
  return [];
}

const minutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));

/**
 * The next step for a joined game the bot is not playing any more.
 *
 * The contract's clocks, all in chain seconds (§3.4):
 *   - claim c may be filed MIN_ABANDON_SECONDS after its clock block (the
 *     join for claim 1, the previous contest after that);
 *   - a standing claim may be contested until DISPUTE_SECONDS after the block
 *     before it, and finalized by anyone from DISPUTE_SECONDS after its own.
 *
 * Settle beats a claim, so a complete transcript is settled regardless of the
 * claims around it: that is the result the game actually had. An incomplete
 * one is claimed and, once the window passes, finalized — both hands back,
 * nobody wins anything. The bot never contests just to keep a game it cannot
 * finish alive.
 */
export function decideSweepStep(i: SweepInputs): SweepStep {
  const margin = i.marginSeconds ?? 30;
  const p = i.position;
  if (p.kind === 'not-joined') return { kind: 'not-joined' };
  if (p.kind === 'done') return { kind: 'resolved' };

  if (i.transcriptComplete) {
    if (p.kind === 'open-claim' && p.claimSide !== BOT_SIDE && !i.contestedByUs) {
      const closesAt = i.blockTime(p.claimBlock - 1) + DISPUTE_SECONDS;
      if (i.now + 2 * margin < closesAt) {
        return {
          kind: 'settle',
          contest: { claimNo: p.claimNo, claimSide: p.claimSide, beforeClaimBlock: p.claimBlock - 1 },
        };
      }
    }
    return { kind: 'settle', contest: null };
  }

  if (p.kind === 'no-claims-left') {
    return { kind: 'wait', reason: 'every claim is used up and the transcript is incomplete' };
  }
  if (p.kind === 'can-claim') {
    const opensAt = i.blockTime(p.clockBlock) + MIN_ABANDON_SECONDS + margin;
    if (i.now >= opensAt) return { kind: 'claim', claimNo: p.claimNo, clockBlock: p.clockBlock };
    return { kind: 'wait', reason: `claim ${p.claimNo} opens in ~${minutes(opensAt - i.now)}min` };
  }
  // open-claim
  const finalizableAt = i.blockTime(p.claimBlock) + DISPUTE_SECONDS + margin;
  if (i.now >= finalizableAt) {
    return { kind: 'finalize', claimNo: p.claimNo, claimSide: p.claimSide, claimBlock: p.claimBlock };
  }
  const whose = p.claimSide === BOT_SIDE ? 'claimed' : 'opponent claimed';
  return { kind: 'wait', reason: `${whose} — dispute window, ~${minutes(finalizableAt - i.now)}min left` };
}
