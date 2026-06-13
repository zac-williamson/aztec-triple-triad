import { describe, it, expect } from 'vitest';
import { createTreasuryFaucet, createTreasuryFaucetFromEnv, type FeeJuiceBridgeModule } from '../../src/faucet/createTreasuryFaucet.js';

const ADDR = '0x' + 'a1'.repeat(32);
const TREASURY_KEY = '0x' + 'fe'.repeat(32);

/**
 * A fake bridge module mirroring scripts/lib/feeJuiceBridge's runtime surface,
 * backed by an in-memory store. No Aztec SDK, no L1, no filesystem.
 */
function makeFakeBridge(): FeeJuiceBridgeModule & { store: Record<string, any>; bridgeCalls: Array<{ l2Address: string; funderKey: string }>; nodeCreated: number } {
  const store: Record<string, any> = {};
  const self = {
    store,
    bridgeCalls: [] as Array<{ l2Address: string; funderKey: string }>,
    nodeCreated: 0,
    async bridgeFeeJuice(params: any) {
      self.bridgeCalls.push({ l2Address: params.l2Address, funderKey: params.funderKey });
      return {
        claimAmount: 1000n,
        claimSecret: { toString: () => '0x' + '11'.repeat(32) },
        claimSecretHash: { toString: () => '0x' + '22'.repeat(32) },
        messageHash: '0x' + '33'.repeat(32),
        messageLeafIndex: 7n,
      };
    },
    readFunderKey: () => TREASURY_KEY,
    claimStorePath: () => '/tmp/fake-claims.json',
    loadClaimStore: () => store,
    getStoredClaim: (s: Record<string, any>, a: string) => s[a.toLowerCase()],
    serializeClaim: (l2Address: string, claim: any, bridgedAt: string, status: 'pending' | 'consumed' = 'pending') => ({
      l2Address: l2Address.toLowerCase(),
      claimAmount: claim.claimAmount.toString(),
      claimSecret: claim.claimSecret.toString(),
      claimSecretHash: claim.claimSecretHash.toString(),
      messageHash: claim.messageHash,
      messageLeafIndex: claim.messageLeafIndex.toString(),
      status,
      bridgedAt,
    }),
    putStoredClaim: (_path: string, l2Address: string, record: any) => {
      store[l2Address.toLowerCase()] = record;
      return store;
    },
  };
  return self;
}

const fakeOpts = (bridge: FeeJuiceBridgeModule, nodeCounter?: { n: number }) => ({
  nodeUrl: 'http://node.example',
  l1RpcUrl: 'http://l1.example',
  loadBridgeModule: async () => bridge,
  loadNode: async () => { if (nodeCounter) nodeCounter.n++; return { fake: 'node' }; },
});

describe('createTreasuryFaucet', () => {
  it('bridges a fresh address, persists, and returns the consumable wire claim', async () => {
    const bridge = makeFakeBridge();
    const svc = await createTreasuryFaucet(fakeOpts(bridge));

    const r = await svc.requestClaim(ADDR, '1.1.1.1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reused).toBe(false);
      expect(r.claim).toEqual({
        l2Address: ADDR,
        claimAmount: '1000',
        claimSecret: '0x' + '11'.repeat(32),
        claimSecretHash: '0x' + '22'.repeat(32),
        messageHash: '0x' + '33'.repeat(32),
        messageLeafIndex: '7',
      });
    }
    expect(bridge.store[ADDR].status).toBe('pending');
  });

  it('reuses a persisted claim from the store on the second request (no re-bridge)', async () => {
    const bridge = makeFakeBridge();
    const svc = await createTreasuryFaucet(fakeOpts(bridge));

    await svc.requestClaim(ADDR, '1.1.1.1');
    const again = await svc.requestClaim(ADDR, '1.1.1.1');
    expect(again.ok && again.reused).toBe(true);
    expect(bridge.bridgeCalls).toHaveLength(1);
  });

  it('refuses an address whose claim is already consumed (409)', async () => {
    const bridge = makeFakeBridge();
    bridge.store[ADDR] = { ...bridge.serializeClaim(ADDR, { claimAmount: 1n, claimSecret: { toString: () => '0x0' }, claimSecretHash: { toString: () => '0x0' }, messageHash: '0x0', messageLeafIndex: 0n }, 'x', 'consumed') };
    const svc = await createTreasuryFaucet(fakeOpts(bridge));

    const r = await svc.requestClaim(ADDR, '1.1.1.1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    expect(bridge.bridgeCalls).toHaveLength(0);
  });

  it('passes the treasury key to the bridge but never exposes it in the result', async () => {
    const bridge = makeFakeBridge();
    const svc = await createTreasuryFaucet(fakeOpts(bridge));

    const r = await svc.requestClaim(ADDR, '1.1.1.1');
    expect(bridge.bridgeCalls[0].funderKey).toBe(TREASURY_KEY);
    expect(JSON.stringify(r)).not.toContain(TREASURY_KEY);
  });

  it('connects the Aztec node lazily — only when a real bridge happens', async () => {
    const bridge = makeFakeBridge();
    const counter = { n: 0 };
    const svc = await createTreasuryFaucet(fakeOpts(bridge, counter));

    expect(counter.n).toBe(0); // construction did not connect
    await svc.requestClaim(ADDR, '1.1.1.1');
    expect(counter.n).toBe(1);
    await svc.requestClaim(ADDR, '1.1.1.1'); // reused — no second connect
    expect(counter.n).toBe(1);
  });
});

describe('createTreasuryFaucetFromEnv', () => {
  it('throws when AZTEC_NODE_URL is missing', async () => {
    await expect(
      createTreasuryFaucetFromEnv({ FAUCET_L1_RPC_URL: 'http://l1' } as any, { loadBridgeModule: async () => makeFakeBridge(), loadNode: async () => ({}) }),
    ).rejects.toThrow(/AZTEC_NODE_URL/);
  });

  it('throws when the L1 RPC URL is missing', async () => {
    await expect(
      createTreasuryFaucetFromEnv({ AZTEC_NODE_URL: 'http://node' } as any, { loadBridgeModule: async () => makeFakeBridge(), loadNode: async () => ({}) }),
    ).rejects.toThrow(/FAUCET_L1_RPC_URL/);
  });

  it('reads rate limits from the env', async () => {
    const bridge = makeFakeBridge();
    const env = { AZTEC_NODE_URL: 'http://node', TESTNET_L1_RPC_URL: 'http://l1', FAUCET_GLOBAL_DAILY_LIMIT: '1' } as any;
    const svc = await createTreasuryFaucetFromEnv(env, { loadBridgeModule: async () => bridge, loadNode: async () => ({}) });

    expect((await svc.requestClaim('0x' + '1a'.repeat(32), '1.1.1.1')).ok).toBe(true);
    const over = await svc.requestClaim('0x' + '2b'.repeat(32), '2.2.2.2');
    expect(over.ok).toBe(false); // global cap of 1 hit
    if (!over.ok) expect(over.status).toBe(429);
  });
});
