/**
 * Deterministic arena-bot account derivation.
 *
 * Same reasoning as scripts/lib/playtestAccounts.ts: provisioning and the
 * running bot must derive byte-identical keys, so nothing here may use
 * Fr.random(). The provisioning script funds, deploys and mints cards for
 * bot[index]; the bot service later restores that exact account from the same
 * seed. A random key would fund one account and run as another.
 *
 * Index exists so the identity POOL is a config change rather than a rewrite.
 * With a single bot identity, every player after the first is head-of-line
 * blocked behind a ~10 minute game — worse than the queue wait the feature
 * exists to remove (docs/plan/BACKEND_OPPONENT.md §2b). Phase 1 runs index 0
 * only; nothing here assumes that.
 *
 * Keys are hex strings, not Fr/GrumpkinScalar objects, for the same
 * module-identity reason documented in playtestAccounts.ts.
 */
import { createHash } from 'crypto';

/** Bump the version suffix for a brand-new, disjoint set of bot identities. */
export const ARENA_BOT_SEED = 'axolotl-arena/arena-bot/v1';

/** Field modulus (BN254 Fr) — digests are reduced into it. */
const FIELD_MODULUS = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617',
);

function deriveField(seed: string, domain: string, index: number): string {
  const digest = createHash('sha256').update(`${seed}|${domain}|${index}`).digest('hex');
  const reduced = BigInt(`0x${digest}`) % FIELD_MODULUS;
  return `0x${reduced.toString(16).padStart(64, '0')}`;
}

export interface ArenaBotKeys {
  index: number;
  secret: string;
  salt: string;
  signingKey: string;
}

/** Derive bot identity `index`. Pure and stable across processes. */
export function arenaBotAccount(index: number, seed: string = ARENA_BOT_SEED): ArenaBotKeys {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`arenaBotAccount: index must be a non-negative integer, got ${index}`);
  }
  return {
    index,
    secret: deriveField(seed, 'secret', index),
    salt: deriveField(seed, 'salt', index),
    signingKey: deriveField(seed, 'signing', index),
  };
}
