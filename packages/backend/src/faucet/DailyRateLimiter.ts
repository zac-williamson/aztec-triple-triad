const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * In-memory per-key counter that resets each UTC day. Used for the faucet's
 * per-IP and global daily caps.
 *
 * `tryAcquire` reserves a slot (so callers can roll back a reservation with
 * `release` if the work it guarded fails), which makes the count correct under
 * concurrent in-flight requests — Node is single-threaded, so the synchronous
 * acquire/release pair cannot interleave even though the bridge call between
 * them awaits.
 *
 * Single-process by design: the hard treasury bound is the persistent
 * per-address claim store; these caps are a cost/DoS guard. If the backend is
 * ever scaled to multiple instances, back this with Redis (one shared counter).
 */
export class DailyRateLimiter {
  private counts = new Map<string, number>();
  private day = 0;

  constructor(
    private readonly limit: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Reserve a slot for `key`. Returns false (no reservation made) if at limit. */
  tryAcquire(key: string): boolean {
    this.rollIfNewDay();
    const current = this.counts.get(key) ?? 0;
    if (current >= this.limit) return false;
    this.counts.set(key, current + 1);
    return true;
  }

  /** Release a previously-acquired slot (no-op below zero). */
  release(key: string): void {
    this.rollIfNewDay();
    const current = this.counts.get(key) ?? 0;
    if (current > 0) this.counts.set(key, current - 1);
  }

  private rollIfNewDay(): void {
    const today = Math.floor(this.now() / DAY_MS);
    if (today !== this.day) {
      this.day = today;
      this.counts.clear();
    }
  }
}
