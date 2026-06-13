import { describe, it, expect } from 'vitest';
import { createFaucetService } from '../../src/faucet/FaucetService.js';
import type { FaucetClaim, FaucetClaimBackend, StoredFaucetClaim } from '../../src/faucet/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ADDR_A = '0x' + 'a1'.repeat(32);
const ADDR_B = '0x' + 'b2'.repeat(32);
const ADDR_C = '0x' + 'c3'.repeat(32);

function claimFor(l2Address: string): FaucetClaim {
  return {
    l2Address,
    claimAmount: '1000000000',
    claimSecret: '0x' + '11'.repeat(32),
    claimSecretHash: '0x' + '22'.repeat(32),
    messageHash: '0x' + '33'.repeat(32),
    messageLeafIndex: '7',
  };
}

/** A controllable in-memory faucet backend (no Aztec, no network). */
class FakeBackend implements FaucetClaimBackend {
  bridgeCalls: string[] = [];
  store = new Map<string, StoredFaucetClaim>();
  throwOnce = false;
  /** When set, bridgeClaim awaits this gate before resolving (concurrency tests). */
  gate: Promise<void> | null = null;

  async getExistingClaim(l2Address: string): Promise<StoredFaucetClaim | null> {
    return this.store.get(l2Address) ?? null;
  }

  async bridgeClaim(l2Address: string): Promise<FaucetClaim> {
    this.bridgeCalls.push(l2Address);
    if (this.gate) await this.gate;
    if (this.throwOnce) {
      this.throwOnce = false;
      throw new Error('sepolia bridge failed');
    }
    const claim = claimFor(l2Address);
    this.store.set(l2Address, { claim, status: 'pending' });
    return claim;
  }
}

describe('FaucetService', () => {
  it('rejects a malformed L2 address with 400 and never bridges', async () => {
    const backend = new FakeBackend();
    const svc = createFaucetService(backend, { now: () => 0 });

    for (const bad of ['', 'nope', '0xdeadbeef', ADDR_A.slice(0, -2)]) {
      const r = await svc.requestClaim(bad, '1.1.1.1');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
    expect(backend.bridgeCalls).toEqual([]);
  });

  it('bridges a fresh address and returns a non-reused claim', async () => {
    const backend = new FakeBackend();
    const svc = createFaucetService(backend, { now: () => 0 });

    const r = await svc.requestClaim(ADDR_A, '1.1.1.1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reused).toBe(false);
      expect(r.claim.l2Address).toBe(ADDR_A);
    }
    expect(backend.bridgeCalls).toEqual([ADDR_A]);
  });

  it('lowercases the address before bridging (dedup parity with the claim store)', async () => {
    const backend = new FakeBackend();
    const svc = createFaucetService(backend, { now: () => 0 });
    const mixed = '0x' + 'AB'.repeat(32);

    await svc.requestClaim(mixed, '1.1.1.1');
    expect(backend.bridgeCalls).toEqual([mixed.toLowerCase()]);
  });

  it('returns the existing pending claim without re-bridging or spending IP budget', async () => {
    const backend = new FakeBackend();
    // Limit 2: enough for the first claim + one more distinct address. If reuse
    // wrongly spent budget, the first claim + reuse would exhaust it and the
    // distinct address below would be refused — so this isolates the behavior.
    const svc = createFaucetService(backend, { ipDailyLimit: 2, now: () => 0 });

    const first = await svc.requestClaim(ADDR_A, '1.1.1.1');
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.reused).toBe(false);

    // Same address again — reused, no second bridge, no budget consumed
    const again = await svc.requestClaim(ADDR_A, '1.1.1.1');
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.reused).toBe(true);
    expect(backend.bridgeCalls).toEqual([ADDR_A]);

    // A different address from the same IP is still allowed (budget untouched by reuse)
    const other = await svc.requestClaim(ADDR_B, '1.1.1.1');
    expect(other.ok).toBe(true);
  });

  it('refuses an already-consumed claim with 409', async () => {
    const backend = new FakeBackend();
    backend.store.set(ADDR_A, { claim: claimFor(ADDR_A), status: 'consumed' });
    const svc = createFaucetService(backend, { now: () => 0 });

    const r = await svc.requestClaim(ADDR_A, '1.1.1.1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect(backend.bridgeCalls).toEqual([]);
  });

  it('enforces the per-IP daily limit (429) while other IPs are unaffected', async () => {
    const backend = new FakeBackend();
    const svc = createFaucetService(backend, { ipDailyLimit: 2, globalDailyLimit: 1000, now: () => 0 });

    expect((await svc.requestClaim(ADDR_A, '1.1.1.1')).ok).toBe(true);
    expect((await svc.requestClaim(ADDR_B, '1.1.1.1')).ok).toBe(true);
    const third = await svc.requestClaim(ADDR_C, '1.1.1.1');
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.status).toBe(429);

    // Different IP has its own budget
    expect((await svc.requestClaim(ADDR_C, '2.2.2.2')).ok).toBe(true);
  });

  it('enforces the global daily cap (429) across all IPs — the treasury-drain backstop', async () => {
    const backend = new FakeBackend();
    const svc = createFaucetService(backend, { ipDailyLimit: 100, globalDailyLimit: 2, now: () => 0 });

    expect((await svc.requestClaim(ADDR_A, '1.1.1.1')).ok).toBe(true);
    expect((await svc.requestClaim(ADDR_B, '2.2.2.2')).ok).toBe(true);
    const over = await svc.requestClaim(ADDR_C, '3.3.3.3');
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.status).toBe(429);
  });

  it('surfaces a bridge failure as 503 without consuming budget (so a retry can succeed)', async () => {
    const backend = new FakeBackend();
    backend.throwOnce = true;
    const svc = createFaucetService(backend, { ipDailyLimit: 1, now: () => 0 });

    const failed = await svc.requestClaim(ADDR_A, '1.1.1.1');
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.status).toBe(503);

    // Budget not spent: same IP, bridge now healthy, succeeds
    const retry = await svc.requestClaim(ADDR_A, '1.1.1.1');
    expect(retry.ok).toBe(true);
    expect(backend.bridgeCalls).toEqual([ADDR_A, ADDR_A]);
  });

  it('guards against concurrent duplicate requests for the same address', async () => {
    const backend = new FakeBackend();
    let openGate!: () => void;
    backend.gate = new Promise<void>((resolve) => { openGate = resolve; });
    const svc = createFaucetService(backend, { now: () => 0 });

    const p1 = svc.requestClaim(ADDR_A, '1.1.1.1');
    // Let p1 enter the in-flight section before p2 starts.
    await Promise.resolve();
    const p2 = svc.requestClaim(ADDR_A, '1.1.1.1');

    const r2 = await p2; // p2 returns immediately — in-flight guard
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.status).toBe(409);

    openGate();
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(backend.bridgeCalls).toEqual([ADDR_A]); // only one real bridge
  });

  it('resets the per-IP budget after the day rolls over', async () => {
    const backend = new FakeBackend();
    let now = 0;
    const svc = createFaucetService(backend, { ipDailyLimit: 1, now: () => now });

    expect((await svc.requestClaim(ADDR_A, '1.1.1.1')).ok).toBe(true);
    const blocked = await svc.requestClaim(ADDR_B, '1.1.1.1');
    expect(blocked.ok).toBe(false);

    now += DAY_MS;
    expect((await svc.requestClaim(ADDR_C, '1.1.1.1')).ok).toBe(true);
  });
});
