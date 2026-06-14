/**
 * Faucet abstraction (item I). The backend bridges Fee Juice from its treasury
 * and returns the claim WRAPPED as `{ claim: {...}, reused }` (see backend
 * server.ts: `res.end(JSON.stringify({ claim, reused }))`). This module unwraps
 * `claim` into the `{ claimAmount, claimSecret, messageLeafIndex }` the
 * deploy-time claim consumes, and throws on any non-OK / incomplete response so
 * the caller can fall back to manual funding.
 *
 * NOTE: these tests previously asserted a FLAT body and so never caught that the
 * backend wraps the claim — which is exactly why in-app testnet funding silently
 * failed with "incomplete claim". They now use the REAL wrapped body; the
 * deserialize test below is red against a top-level read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Fr is dynamically imported inside the module; stub it to a recognizable value.
vi.mock('@aztec/aztec.js/fields', () => ({
  Fr: { fromHexString: vi.fn((h: string) => ({ __fr: h })) },
}));

import { requestFeeJuiceClaim } from './requestFeeJuiceClaim';
import { Fr } from '@aztec/aztec.js/fields';

const fromHexString = Fr.fromHexString as unknown as ReturnType<typeof vi.fn>;

function mockFetch(impl: (url: string, init: RequestInit) => Partial<Response> | Promise<Partial<Response>>) {
  const fn = vi.fn(impl);
  // @ts-expect-error - test stub
  globalThis.fetch = fn;
  return fn;
}

function okJson(body: unknown): Partial<Response> {
  return { ok: true, status: 200, json: async () => body };
}

/** The real backend success body: the claim wrapped under `claim`, plus `reused`. */
function wrapped(claim: Record<string, unknown>, reused = false) {
  return okJson({ claim, reused });
}

describe('requestFeeJuiceClaim', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => { vi.restoreAllMocks(); });

  // Regression guard: this is RED without the fix — a top-level read of a wrapped
  // body finds no claimAmount/claimSecret/messageLeafIndex and throws "incomplete
  // claim". It passes only when the module unwraps `body.claim`.
  it('POSTs the L2 address and deserializes the WRAPPED { claim, reused } body', async () => {
    const fetchFn = mockFetch(() =>
      wrapped({ claimAmount: '1000000000000000000', claimSecret: '0xabc', messageLeafIndex: '42' }, true),
    );

    const claim = await requestFeeJuiceClaim('https://faucet.example.com', '0xL2ADDR');

    // Right endpoint + payload.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://faucet.example.com/faucet');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ l2Address: '0xL2ADDR' });

    // String fields (from inside `claim`) become the right runtime types.
    expect(claim.claimAmount).toBe(1000000000000000000n);
    expect(claim.messageLeafIndex).toBe(42n);
    expect(fromHexString).toHaveBeenCalledWith('0xabc');
    expect(claim.claimSecret).toEqual({ __fr: '0xabc' });
  });

  it('strips a trailing slash from the faucet URL (no double slash)', async () => {
    const fetchFn = mockFetch(() => wrapped({ claimAmount: '1', claimSecret: '0x1', messageLeafIndex: '0' }));
    await requestFeeJuiceClaim('https://faucet.example.com/', '0xL2');
    expect(fetchFn.mock.calls[0][0]).toBe('https://faucet.example.com/faucet');
  });

  it('0x-prefixes a bare claim secret before parsing', async () => {
    mockFetch(() => wrapped({ claimAmount: '1', claimSecret: 'deadbeef', messageLeafIndex: '0' }));
    await requestFeeJuiceClaim('https://faucet.example.com', '0xL2');
    expect(fromHexString).toHaveBeenCalledWith('0xdeadbeef');
  });

  it('throws with status + detail when the faucet responds non-OK', async () => {
    mockFetch(() => ({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'rate limited' }));
    await expect(requestFeeJuiceClaim('https://faucet.example.com', '0xL2')).rejects.toThrow(/429.*rate limited/);
  });

  it('throws when the wrapped claim is incomplete (missing a field)', async () => {
    mockFetch(() => wrapped({ claimAmount: '1', messageLeafIndex: '0' })); // no claimSecret inside claim
    await expect(requestFeeJuiceClaim('https://faucet.example.com', '0xL2')).rejects.toThrow(/incomplete claim/);
  });

  it('rejects a legacy FLAT body — wrapped { claim } is the canonical contract', async () => {
    // A top-level claim (no `claim` wrapper) must NOT be accepted; this guards
    // against re-introducing the flat read that hid the bug.
    mockFetch(() => okJson({ claimAmount: '1', claimSecret: '0x1', messageLeafIndex: '0' }));
    await expect(requestFeeJuiceClaim('https://faucet.example.com', '0xL2')).rejects.toThrow(/incomplete claim/);
  });
});
