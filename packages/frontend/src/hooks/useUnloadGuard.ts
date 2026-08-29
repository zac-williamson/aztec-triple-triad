import { useEffect } from 'react';

/**
 * Warn before the tab closes while leaving would cost somebody their cards.
 *
 * Two distinct situations, and the first is the non-obvious one:
 *
 * 1. **We owe the opponent a move proof.** The settlement transcript is shared
 *    — 2 hand proofs + 9 move proofs — and the winner cannot settle without
 *    every link. A player who closes the tab still owing one strands the
 *    WINNER's settlement, and both hands stay locked until the abandonment
 *    path resolves them. The exposure is worst at exactly the wrong moment: the
 *    final move's proof is generated AFTER the relay declares the game over, so
 *    the losing player is being asked to sit through a proof for a game they
 *    have already lost. That is precisely when someone closes the tab.
 *
 * 2. **Our own settlement is in flight.** Interrupting that leaves the game
 *    unsettled and our own five cards committed.
 *
 * A `beforeunload` prompt is the only lever the platform gives us here, and the
 * browser deliberately ignores custom text — so the message is for the tests and
 * for anyone reading this, not for the user. It cannot stop a determined close,
 * and it does nothing for a crash or a killed tab; it converts the common
 * accidental case into a deliberate one. The durable fix is the abandonment
 * claim, which exists precisely because this guarantee cannot be made in the
 * client.
 */
export function useUnloadGuard(active: boolean, reason: string): void {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy form, still required by some browsers to trigger the prompt.
      e.returnValue = reason;
      return reason;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active, reason]);
}
