/**
 * Deterministic playtest-account key derivation — the SINGLE source of truth for
 * the pre-funded playtest pool. Imported by BOTH the provisioning script
 * (scripts/provision-playtest-accounts.ts) and the Playwright harness
 * (packages/playtest/src/player.ts).
 *
 * WHY DETERMINISTIC (never Fr.random()/GrumpkinScalar.random()): provisioning
 * and the harness must derive byte-identical accounts. The script funds, deploys,
 * and mints starter cards for account[index]; the harness then RESTORES that same
 * account by seeding its keys into localStorage. A random key would deploy one
 * account and try to restore a different one — onboarding would fall through to
 * the (now-removed) funding path and hang.
 *
 * Keys come from SHA-256(seed | domain | index). The plan's shorthand is
 * "sha256(seed‖index)", but one account needs THREE independent field elements
 * (secret, salt, signingKey), so each gets a distinct domain separator — one
 * digest could not yield three values. fromBufferReduce maps the 32-byte digest
 * into the field by modular reduction. This is a TEST-ACCOUNT derivation, not a
 * value-bearing key-management scheme: the seed is public and the pool is
 * single-use throwaway accounts on testnet.
 */
import { createHash } from 'crypto';

/**
 * Constant pool seed. Bump the version suffix to mint a brand-new, disjoint pool
 * (e.g. after a testnet redeploy) so freshly-derived accounts can never collide
 * with already-used ones from a previous pool.
 */
export const PLAYTEST_SEED = 'axolotl-arena/playtest-pool/v2';

/**
 * Keys are returned as HEX STRINGS, not Fr/GrumpkinScalar objects, on purpose.
 * Each value is already reduced into its field (< modulus), so every consumer
 * rebuilds it with ITS OWN top-level `Fr.fromHexString` / `GrumpkinScalar.
 * fromHexString` — the proven deploy-testnet.ts pattern. Passing Fr objects
 * across the module boundary is fragile: inside a heavy import graph (e.g. the
 * provisioning script, which also pulls @aztec/wallets/embedded) the SDK's
 * internal Fr class can be a different module instance than the one this file
 * built with, so `new Fr(thatFr)` fails its `instanceof BaseField` check
 * ("Type 'object' ... passed to BaseField ctor"). Hex sidesteps that entirely.
 */
export interface PlaytestAccountKeys {
  /** Account secret — Fr hex (reduced < modulus). */
  secret: string;
  /** Account deployment salt — Fr hex. */
  salt: string;
  /** Schnorr signing key — GrumpkinScalar/Fq hex. */
  signingKey: string;
}

/** SHA-256(PLAYTEST_SEED | domain | index) → 32-byte digest (Node Buffer). */
function digest(domain: string, index: number): Buffer {
  return createHash('sha256').update(`${PLAYTEST_SEED}|${domain}|${index}`).digest();
}

/**
 * Derive the keys for pool account `index` as canonical field-element hex. Async
 * because the @aztec field classes (used here only for the modular reduction)
 * are dynamically imported — matches the lazy-import convention in chain.ts /
 * connectToAztec.ts.
 */
export async function playtestAccount(index: number): Promise<PlaytestAccountKeys> {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`playtestAccount: index must be a non-negative integer, got ${index}`);
  }
  const [{ Fr }, { GrumpkinScalar }] = await Promise.all([
    import('@aztec/aztec.js/fields'),
    import('@aztec/foundation/curves/grumpkin'),
  ]);
  return {
    secret: Fr.fromBufferReduce(digest('secret', index)).toString(),
    salt: Fr.fromBufferReduce(digest('salt', index)).toString(),
    signingKey: GrumpkinScalar.fromBufferReduce(digest('signingKey', index)).toString(),
  };
}
