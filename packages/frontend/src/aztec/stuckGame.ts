/**
 * What the menu may honestly offer for a game that still holds this player's
 * cards (or has notes for them it has not imported yet).
 *
 * Pure: the chain facts are gathered by the caller (useGame) and passed in.
 * Every offer here is one the contract will accept right now — a button that
 * reverts after its proof is worse than no button, and this app has shipped
 * that mistake more than once.
 */
import { DISPUTE_SECONDS, MIN_ABANDON_SECONDS } from './settlementArgs';
import { hasContested, type AbandonmentPosition, type GameChainState, type Side } from './privateGame';
import type { OpenClaim } from './gameActions';

/**
 * How long the player who does not settle (the loser; player 2 on a draw)
 * leaves the settlement to the one who does, before offering to settle
 * themselves. Either may — the contract does not care who — but two settles
 * racing each other waste a proof.
 */
export const SETTLE_GRACE_MS = 10 * 60 * 1000;

export type StuckGameKind =
  /** Nobody joined: cancel and take the cards back. */
  | 'cancellable'
  /** The full transcript is here: settle it (anyone may). */
  | 'settleable'
  /** The full transcript is here, and the winner may still be settling. */
  | 'awaiting-winner'
  /** Old enough, unfinished: claim it abandoned (then the dispute window, then finalize). */
  | 'claimable'
  /** Unfinished, but the contract's abandonment bar has not passed. */
  | 'too-soon'
  /** The other player claimed it abandoned and the dispute window is open. */
  | 'contestable'
  /** A claim stands and its window is still open: nothing to do but wait. */
  | 'claim-pending'
  /** A claim stands and its window has closed: anyone may finalize it (both hands back). */
  | 'finalizable';

export interface StuckGame {
  /** The relay room the stored game belongs to. */
  roomId: string;
  kind: StuckGameKind;
  /** Seconds until the next action becomes possible (waits only). */
  waitSeconds?: number;
  /** The standing claim, for contest / finalize / claim-pending. */
  claim?: OpenClaim;
}

export type StuckAssessment =
  /** The game resolved: import our notes from it, then forget it. */
  | { kind: 'resolved' }
  /** Our commit never reached the chain. */
  | { kind: 'not-committed' }
  /** Nothing to offer now (but the record stays). */
  | { kind: 'wait' }
  | Omit<StuckGame, 'roomId'>;

export interface StuckGameFacts {
  role: Side;
  /** We hold the joiner's record (the creator may never have received it). */
  record2Known: boolean;
  state: GameChainState;
  position: AbandonmentPosition;
  /** All nine move proofs are stored. */
  transcriptComplete: boolean;
  /** Per the transcript, this player is the one who settles (winner, or player 1 on a draw). */
  weSettle: boolean;
  /** When the game ended locally (ms), if it did. */
  finishedAt?: number;
  nowMs: number;
  /** The chain's current time (seconds). */
  chainNow: number;
  /** Time (chain seconds) of the claim clock's block, for `can-claim`. */
  clockAt?: number;
  /** Time (chain seconds) of the standing claim's block, for `open-claim`. */
  claimAt?: number;
}

export function assessStuckGame(f: StuckGameFacts): StuckAssessment {
  const { state } = f;
  if (state.done) return { kind: 'resolved' };

  const ourCommitLanded = f.role === 1 ? !!state.created : !!state.joined;
  if (!ourCommitLanded) return { kind: 'not-committed' };

  if (f.role === 1 && !state.seat2) return { kind: 'cancellable' };
  // Somebody joined, but this device never got their record: nothing here can
  // name the game's later nullifiers. The joiner can still return both hands.
  if (!f.record2Known) return { kind: 'wait' };

  // A full transcript outranks any claim: settlement only needs `done` free.
  if (f.transcriptComplete) {
    if (f.weSettle) return { kind: 'settleable' };
    const since = f.finishedAt !== undefined ? f.nowMs - f.finishedAt : 0;
    if (since >= SETTLE_GRACE_MS) return { kind: 'settleable' };
    return { kind: 'awaiting-winner', waitSeconds: Math.ceil((SETTLE_GRACE_MS - since) / 1000) };
  }

  const p = f.position;
  if (p.kind === 'open-claim') {
    const claim: OpenClaim = { claimNo: p.claimNo, claimSide: p.claimSide, claimBlock: p.claimBlock };
    if (f.claimAt === undefined) return { kind: 'wait' };
    const closesAt = f.claimAt + DISPUTE_SECONDS;
    if (f.chainNow >= closesAt) return { kind: 'finalizable', claim };
    const waitSeconds = closesAt - f.chainNow;
    if (p.claimSide !== f.role && !hasContested(state, f.role)) return { kind: 'contestable', claim, waitSeconds };
    return { kind: 'claim-pending', claim, waitSeconds };
  }
  if (p.kind === 'can-claim') {
    if (f.clockAt === undefined) return { kind: 'wait' };
    const opensAt = f.clockAt + MIN_ABANDON_SECONDS;
    if (f.chainNow >= opensAt) return { kind: 'claimable' };
    return { kind: 'too-soon', waitSeconds: opensAt - f.chainNow };
  }
  return { kind: 'wait' };
}
