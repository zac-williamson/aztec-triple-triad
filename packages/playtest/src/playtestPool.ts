/**
 * The playtest account pool manifest (packages/playtest/.artifacts/
 * playtest-accounts.json): its entry shape, and which entries still belong to
 * the deployment under test. Shared by the provisioner
 * (scripts/provision-playtest-accounts.ts), which writes and re-provisions
 * entries, and the Playwright harness (packages/playtest/src/player.ts), which
 * claims them.
 *
 * An entry is only good for the deployment it was provisioned against: its
 * starter cards are notes in ONE NFT contract on ONE chain, and both move. The
 * testnet re-genesises (four times so far) and a redeploy on the same chain
 * replaces the NFT; either way an old entry's cards no longer exist where the
 * app looks for them, and a run that seeds one fails somewhere far from the
 * cause. So every entry is stamped with the chain's rollupVersion AND the NFT
 * address, and the harness claims only entries minted on the NFT under test.
 *
 * Pure (no fs, no SDK) so both sides and their tests can import it.
 */

export interface PoolEntry<Card = unknown> {
  index: number;
  address: string;
  /** THROWAWAY playtest-account keys (hex) — deterministic, browser-bound by design. */
  secret: string;
  salt: string;
  signingKey: string;
  /** Full StoredCard[] so the harness can seed the browser cardStore verbatim
   *  and re-import via import_note. */
  starterCards: Card[];
  /** Single-use flag: the harness flips this to true on claim. */
  used: boolean;
  /** rollupVersion of the chain this account was provisioned on. Entries
   *  without it predate the stamp and are from a chain long gone. */
  rollupVersion?: number;
  /** The NFT contract the starter cards were minted on. Entries without it
   *  predate the stamp (November 2026). */
  nftAddress?: string;
}

/** What an entry has to match to be usable. */
export interface Deployment {
  rollupVersion: number;
  nftAddress: string;
}

/**
 * - `current`: stamped for this chain AND this NFT.
 * - `other-deployment`: provably stale — another chain, another NFT on this
 *   chain, or no chain stamp at all. Safe to re-provision in place.
 * - `unstamped`: this chain, but provisioned before entries recorded their NFT,
 *   so it cannot be told apart from a previous deployment's. Re-provisioning is
 *   NOT safe: if its cards are on the current NFT, the starter mint was already
 *   claimed and fails.
 */
export type EntryStatus = 'current' | 'other-deployment' | 'unstamped';

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function entryStatus(
  entry: Pick<PoolEntry, 'rollupVersion' | 'nftAddress'>,
  deployment: Deployment,
): EntryStatus {
  if (entry.rollupVersion !== deployment.rollupVersion) return 'other-deployment';
  if (!entry.nftAddress) return 'unstamped';
  return sameAddress(entry.nftAddress, deployment.nftAddress) ? 'current' : 'other-deployment';
}

/**
 * Claim the next unused entry whose cards were minted on `nftAddress`: mark it
 * used (the pool is single-use) and return it. The caller persists the manifest.
 *
 * Matching the NFT alone is enough here: a deploy picks a random salt, so a
 * contract address never recurs across deployments, and an entry minted on the
 * NFT under test is on the chain under test. Throws, with the way out, when the
 * pool has nothing for this deployment.
 */
export function claimNext<E extends Pick<PoolEntry, 'index' | 'used' | 'nftAddress'>>(
  entries: E[],
  nftAddress: string,
): E {
  const entry = entries.find((e) => !e.used && !!e.nftAddress && sameAddress(e.nftAddress, nftAddress));
  if (entry) {
    entry.used = true;
    return entry;
  }
  const unusedElsewhere = entries.filter((e) => !e.used).length;
  const nextIndex = entries.reduce((max, e) => Math.max(max, e.index + 1), 0);
  throw new Error(
    `No unused playtest account for this deployment (NFT ${nftAddress}): ` +
      `${entries.length} in the pool, ${unusedElsewhere} unused but provisioned for another ` +
      `chain or NFT, so their cards do not exist here. Provision more:\n` +
      `  npx tsx scripts/provision-playtest-accounts.ts --start ${nextIndex} --count <N>`,
  );
}
