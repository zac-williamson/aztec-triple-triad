/**
 * Fetch every module settlement needs, BEFORE cards are at stake.
 *
 * Settlement pulls the SDK, the proving backend and the circuit loader in
 * through dynamic `import()`. Those resolve to hashed chunk files, and a deploy
 * replaces them — so a tab that was opened before the deploy asks for a chunk
 * that no longer exists and settlement dies with "Failed to fetch dynamically
 * imported module". The game is over by then, the wager is committed, and the
 * player's only route back to their cards is the hour-long abandonment claim.
 *
 * This is not hypothetical and it is not rare: it happened during this
 * session's own run, to a game that had just finished, because a Vercel deploy
 * landed between the last move and the settle. Every open tab is exposed for
 * as long as it stays open.
 *
 * `staleBuild.ts` DETECTS this and tells the player to reload. Detection is
 * not mitigation — by the time it fires the settlement has already failed.
 *
 * Once a module has been imported it lives in the tab's module registry, and a
 * deploy cannot take it away. So the fix is simply to import early: at the
 * point cards are committed, while nothing is yet at risk. The imports are the
 * ones settlement performs, listed here so the two cannot drift apart silently
 * — a settlement import missing from this list is a gap, not a bug in the
 * warming.
 *
 * Failures are swallowed on purpose. This is an optimisation of WHEN a module
 * loads, never a precondition for playing: if warming fails the game proceeds
 * exactly as before and settlement takes its chances, which is the behaviour
 * this replaces rather than a regression.
 */

let warmed: Promise<void> | null = null;

/** The dynamic imports on the settlement path. Keep in step with useGameSettlement. */
const SETTLEMENT_IMPORTS: Array<() => Promise<unknown>> = [
  () => import('./pxe'),
  () => import('./settlementArgs'),
  () => import('./claimParity'),
  () => import('./fieldUtils'),
  () => import('./proofWorker'),
  () => import('./proofBackend'),
  () => import('./circuitLoader'),
  () => import('./gameConstants'),
  () => import('@aztec/aztec.js/fields'),
  () => import('@aztec/aztec.js/addresses'),
  // The proving stack. These are the biggest chunks on the path and therefore
  // the ones most worth having in memory before a deploy can move them.
  () => import('@aztec/bb.js'),
  () => import('@noir-lang/noir_js'),
];

/**
 * Warm the settlement path. Idempotent: the first call does the work and every
 * later one returns the same promise, so calling it on each render is free.
 */
export function warmSettlementModules(): Promise<void> {
  if (warmed) return warmed;
  warmed = Promise.all(
    SETTLEMENT_IMPORTS.map(load =>
      load().catch(err => {
        // Worth saying, never worth throwing — see the note above.
        console.warn('[warmSettlementModules] could not preload a settlement module:', err);
      }),
    ),
  ).then(() => undefined);
  return warmed;
}

/** Test seam: forget that warming happened. */
export function resetSettlementWarmupForTests(): void {
  warmed = null;
}
