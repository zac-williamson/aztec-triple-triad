/**
 * One line for the page's Barretenberg instance.
 *
 * Move proofs, the open-cards proof and the checks of the opponent's proofs
 * (state hashes, verification) all run on the one shared bb.js instance
 * (proofBackend.ts). They are queued here, in the order they are asked for, so
 * none overlaps another: our open cards are proven before a move queued after
 * them, and a check never interleaves with a proof in flight.
 *
 * Plain module state: every hook that proves or verifies shares the one line.
 */
let tail: Promise<unknown> = Promise.resolve();

/** Run `task` once everything queued before it has finished (whatever its outcome). */
export function onProver<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(task);
  tail = run.catch(() => undefined);
  return run;
}
