/**
 * Faucet types (item I, Option B). The faucet is the ONE Aztec-touching feature
 * in this otherwise Aztec-free relay, and it is kept at arm's length: the
 * service and HTTP route depend only on the interfaces here, never on the Aztec
 * SDK or `scripts/lib/feeJuiceBridge`. The real bridge is injected at the
 * composition root (see createTreasuryFaucet.ts), so the relay core builds and
 * tests with zero SDK surface.
 */

/**
 * A consumable Fee Juice claim, JSON-safe — this is the HTTP wire contract the
 * frontend (Lane 2) deserializes and feeds to `deployAndRegister({ feeJuiceClaim })`.
 * It mirrors the consumable fields of `scripts/lib/feeJuiceBridge.SerializedClaim`
 * (without the server-internal `status`/`bridgedAt` bookkeeping). The treasury
 * key is NEVER part of this shape and never leaves the server.
 */
export interface FaucetClaim {
  l2Address: string;
  /** Fee Juice amount bridged, as a decimal string (bigint-safe). */
  claimAmount: string;
  /** Claim secret (Fr hex) that authorizes consuming the claim. */
  claimSecret: string;
  /** Hash of the claim secret (Fr hex). */
  claimSecretHash: string;
  /** L1->L2 message hash (hex). */
  messageHash: string;
  /** Leaf index of the message in the L1->L2 tree, as a decimal string. */
  messageLeafIndex: string;
}

/** A claim already on record for an address, with its lifecycle status. */
export interface StoredFaucetClaim {
  claim: FaucetClaim;
  /** 'pending' until the account's deploy tx consumes it, then 'consumed'. */
  status: 'pending' | 'consumed';
}

/**
 * The injected seam between the (Aztec-free, unit-tested) FaucetService and the
 * real Fee Juice bridge + claim store. The production implementation lives in
 * createTreasuryFaucet.ts; tests supply a fake.
 */
export interface FaucetClaimBackend {
  /** Any claim already bridged for this (lowercased) address, or null. */
  getExistingClaim(l2Address: string): Promise<StoredFaucetClaim | null>;
  /** Bridge fresh Fee Juice for this address, persist it, return the claim. */
  bridgeClaim(l2Address: string): Promise<FaucetClaim>;
}

/**
 * Discriminated result. `status` is the exact HTTP status the route emits, so
 * the HTTP layer maps results without knowing any faucet internals.
 */
export type FaucetResult =
  | { ok: true; claim: FaucetClaim; reused: boolean }
  | { ok: false; status: 400 | 409 | 429 | 503; error: string };

export interface FaucetService {
  /** Issue (or reuse) a claim for `l2Address`, attributing rate limits to `ip`. */
  requestClaim(l2Address: string, ip: string): Promise<FaucetResult>;
}

export interface FaucetConfig {
  /** Max successful claims per client IP per UTC day. Default 5. */
  ipDailyLimit?: number;
  /** Max successful claims across all IPs per UTC day (treasury-drain cap). Default 200. */
  globalDailyLimit?: number;
  /** Injectable clock (ms since epoch) for deterministic day-window tests. */
  now?: () => number;
}
