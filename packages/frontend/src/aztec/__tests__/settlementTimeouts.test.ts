/**
 * The settler waits on proofs it does not generate, so these timeouts decide
 * whether a finished game settles or strands.
 *
 * A win has exactly one settler. If the winner gives up waiting, nobody else
 * steps in and both sides lose five cards to a watchdog. That happened on
 * production with a 30s move-proof timeout: "Timed out waiting for move
 * proofs: have 8/9".
 */
import { describe, it, expect } from 'vitest';
import {
  MOVE_PROOF_WAIT_TIMEOUT,
  HAND_PROOF_WAIT_TIMEOUT,
  MOVE_PROOF_POLL_INTERVAL,
} from '../gameConstants';

describe('settlement proof timeouts', () => {
  it('allows minutes for the final move proof, not seconds', () => {
    // The ninth proof is generated AFTER the game is declared over, by a party
    // that may be queued behind its own proving. Seconds is not a budget.
    expect(MOVE_PROOF_WAIT_TIMEOUT).toBeGreaterThanOrEqual(120_000);
  });

  it('is at least as patient as the hand-proof wait', () => {
    // Both wait on the opponent's client-side proving. The move wait being the
    // stricter of the two is what made it the one that failed.
    expect(MOVE_PROOF_WAIT_TIMEOUT).toBeGreaterThanOrEqual(HAND_PROOF_WAIT_TIMEOUT);
  });

  it('polls often enough to use the budget it has', () => {
    expect(MOVE_PROOF_POLL_INTERVAL).toBeLessThanOrEqual(2_000);
    expect(MOVE_PROOF_WAIT_TIMEOUT / MOVE_PROOF_POLL_INTERVAL).toBeGreaterThan(30);
  });
});
