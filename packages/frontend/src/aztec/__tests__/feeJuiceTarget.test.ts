/**
 * The funding target against what a game actually costs.
 *
 * These are not invented figures: they are the observed Fee Juice consumption
 * of eight throwaway accounts from real production runs, read off the FeeJuice
 * balances map (`scripts/fee-juice-used.ts`). The point of the test is that
 * nobody lowers the target back to a round number without confronting them.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_FEE_JUICE_TARGET } from '../fundingRoutes';

/** Worst case observed for onboarding + one game, including settlement. */
const ONBOARD_AND_SETTLED_GAME = 6_751_000_000_000_000_000n;
/** Onboarding + a game the player did not settle. */
const ONBOARD_AND_GAME = 4_343_000_000_000_000_000n;
/** Settling costs about this much on its own (the difference above). */
const SETTLEMENT = ONBOARD_AND_SETTLED_GAME - ONBOARD_AND_GAME;

describe('DEFAULT_FEE_JUICE_TARGET', () => {
  it('covers onboarding and a settled game at all', () => {
    // 1e18 did not. It would not have covered the account deployment.
    expect(DEFAULT_FEE_JUICE_TARGET).toBeGreaterThan(ONBOARD_AND_SETTLED_GAME);
  });

  it('leaves a player able to play several games before topping up', () => {
    // A game after onboarding is a create-or-join plus a settlement.
    const perGame = SETTLEMENT * 2n;
    const games = (DEFAULT_FEE_JUICE_TARGET - ONBOARD_AND_GAME) / perGame;
    expect(games).toBeGreaterThanOrEqual(5n);
  });

  it('keeps headroom for a busier fee market than the one we measured', () => {
    const needed = ONBOARD_AND_GAME + SETTLEMENT * 10n;   // onboarding + 5 settled games
    expect(DEFAULT_FEE_JUICE_TARGET).toBeGreaterThan(needed + needed / 2n);
  });
});
