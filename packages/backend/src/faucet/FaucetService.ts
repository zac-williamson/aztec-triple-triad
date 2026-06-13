import { DailyRateLimiter } from './DailyRateLimiter.js';
import type { FaucetClaimBackend, FaucetConfig, FaucetResult, FaucetService } from './types.js';

const L2_ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;
const GLOBAL_KEY = '__global__';
const DEFAULT_IP_DAILY_LIMIT = 5;
const DEFAULT_GLOBAL_DAILY_LIMIT = 200;

/**
 * The faucet's abuse-mitigation core (Aztec-free, fully unit-tested). All chain
 * work is delegated to the injected `backend`. Three independent caps bound
 * treasury spend:
 *
 *  1. One claim per L2 address — a pending claim is returned as-is (idempotent,
 *     no re-bridge, no budget spend); a consumed one is refused (already funded).
 *  2. Per-IP per day — soft cost/DoS guard.
 *  3. Global per day — hard backstop; total daily spend <= globalDailyLimit
 *     bridges (the "capped mint": the per-claim amount is fixed by the on-chain
 *     FeeAssetHandler, so capping the count caps the mint).
 *
 * Reservations are taken before the (awaiting) bridge and rolled back on
 * failure, so a Sepolia hiccup does not burn a user's allowance and a failed
 * claim never counts against the global cap.
 */
export function createFaucetService(backend: FaucetClaimBackend, config: FaucetConfig = {}): FaucetService {
  const now = config.now ?? (() => Date.now());
  const ipLimiter = new DailyRateLimiter(config.ipDailyLimit ?? DEFAULT_IP_DAILY_LIMIT, now);
  const globalLimiter = new DailyRateLimiter(config.globalDailyLimit ?? DEFAULT_GLOBAL_DAILY_LIMIT, now);
  // Addresses with a bridge in progress — prevents a double-click or a racing
  // retry from bridging (and double-charging the treasury) for one account.
  const inFlight = new Set<string>();

  async function requestClaim(rawAddress: string, ip: string): Promise<FaucetResult> {
    if (typeof rawAddress !== 'string' || !L2_ADDRESS_RE.test(rawAddress)) {
      return { ok: false, status: 400, error: 'invalid_address' };
    }
    // Lowercase so dedup matches the claim store, which keys by lowercased address.
    const l2Address = rawAddress.toLowerCase();

    if (inFlight.has(l2Address)) {
      return { ok: false, status: 409, error: 'claim_in_progress' };
    }
    inFlight.add(l2Address);
    try {
      const existing = await backend.getExistingClaim(l2Address);
      if (existing) {
        if (existing.status === 'consumed') {
          return { ok: false, status: 409, error: 'already_funded' };
        }
        // Pending — hand back the same claim. No re-bridge, no budget spent.
        return { ok: true, claim: existing.claim, reused: true };
      }

      // New bridge: reserve IP then global budget, rolling back on refusal.
      if (!ipLimiter.tryAcquire(ip)) {
        return { ok: false, status: 429, error: 'ip_rate_limited' };
      }
      if (!globalLimiter.tryAcquire(GLOBAL_KEY)) {
        ipLimiter.release(ip);
        return { ok: false, status: 429, error: 'global_rate_limited' };
      }

      try {
        const claim = await backend.bridgeClaim(l2Address);
        return { ok: true, claim, reused: false };
      } catch (err) {
        // Genuine bridge failure (e.g. Sepolia not propagating). Refund the
        // reservations and report it; the frontend falls back to manual bridge.
        ipLimiter.release(ip);
        globalLimiter.release(GLOBAL_KEY);
        console.error(`[faucet] bridge failed for ${l2Address.slice(0, 12)}...:`, (err as Error)?.message ?? err);
        return { ok: false, status: 503, error: 'bridge_failed' };
      }
    } finally {
      inFlight.delete(l2Address);
    }
  }

  return { requestClaim };
}
