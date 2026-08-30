/**
 * Where an identity's PXE and wallet state lives on disk.
 *
 * MUST be per-identity. `EmbeddedWallet` defaults every wallet in a process
 * tree to the single directory `aztec-wallet-data`, and the store underneath it
 * is keyed only by L1 chain id and rollup address — so two identities, in two
 * processes, on the same chain resolve to the SAME LMDB store. LMDB does not
 * tolerate two writers: the second one wedges the store permanently with
 *
 *   Failed to commit transaction: New highest finalized index (1) must be
 *   higher than the current one (2)
 *
 * repeating on every sync, which is not obviously a store problem when you are
 * reading it in the middle of a game log. The bot pool is N processes (pxe.ts
 * binds its wallet in a module global), so this is not an edge case — it is the
 * normal deployment.
 *
 * The provisioner and the bot for a given index MUST agree on this path: the
 * provisioner mints into that store and the bot spends from it.
 *
 * The path also carries the ROLLUP VERSION. A sandbox redeploys the rollup at
 * the same L1 address every time, so the store's own key (chain id + rollup
 * address) repeats across chains — and a store full of notes from a dead chain
 * fails with "Read request is reading an unknown note hash", which reads like a
 * contract bug rather than a stale directory. Versioning the path makes a stale
 * store impossible instead of merely documented.
 */
import { resolve } from 'path';

export function identityDataDirectory(
  index: number,
  root = process.cwd(),
  rollupVersion?: number | string,
): string {
  const suffix = rollupVersion === undefined ? '' : `-rv${rollupVersion}`;
  return resolve(root, 'aztec-wallet-data', `identity-${index}${suffix}`);
}
