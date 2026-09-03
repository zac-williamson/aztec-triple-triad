/**
 * The contract's rule for how many move proofs an abandonment claim may use.
 *
 * Its own module, with nothing but a constant behind it, because both claim
 * paths need it and one of them — the bot's sweep — runs in a test that mocks
 * settlementArgs wholesale to avoid pulling in the proving stack. A pure rule
 * living behind a mockable module is a rule that gets stubbed by accident.
 */
import { TOTAL_MOVES } from './gameConstants';

/**
 * How many move proofs a claim may actually use, given who is claiming.
 *
 * `claim_abandoned_game` refuses a claimant who is next to move — otherwise
 * you could walk away from your own turn and call the other player absent.
 * Moves are 0-indexed, so after n of them the next mover is player 1 when n is
 * even and player 2 when n is odd; a claimant therefore needs n ODD as player
 * 1 and n EVEN as player 2. Holding one proof too many for your parity is
 * normal — it just means the opponent moved last — and the fix is to claim on
 * the largest prefix that works, not to give up.
 *
 * A COMPLETE transcript (nine) is exempt: the contract skips the parity check
 * there, because a finished game has nobody whose turn it is.
 *
 * Returns -1 when no prefix is claimable, which happens only to player 1 with
 * no moves at all — the contract reserves the zero-move claim for player 2,
 * the side that did not fail to move.
 */
export function claimableMoveCount(held: number, callerIsPlayer1: boolean): number {
  if (held >= TOTAL_MOVES) return TOTAL_MOVES;
  const capped = Math.min(held, TOTAL_MOVES - 1);
  const wantOdd = callerIsPlayer1;
  return capped % 2 === (wantOdd ? 1 : 0) ? capped : capped - 1;
}
