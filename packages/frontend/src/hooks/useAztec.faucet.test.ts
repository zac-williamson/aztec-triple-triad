/**
 * Testnet faucet onboarding branch (item I, Option B). When a faucet URL is
 * configured, `connect()` on a fresh testnet account requests a Fee Juice claim
 * from the backend and threads it into the combined deploy+mint, reaching
 * `connected` with zero manual steps. A faucet *request* failure degrades to
 * the manual `needs-funding` prompt rather than dead-ending.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  prepareConnection: vi.fn(),
  deployAndRegister: vi.fn(),
  requestFeeJuiceClaim: vi.fn(),
  runTx: vi.fn(),
}));

vi.mock('../aztec/connectToAztec', () => ({
  prepareConnection: h.prepareConnection,
  deployAndRegister: h.deployAndRegister,
}));
vi.mock('../aztec/requestFeeJuiceClaim', () => ({ requestFeeJuiceClaim: h.requestFeeJuiceClaim }));
vi.mock('../aztec/txManager', () => ({ default: { runTx: h.runTx } }));
vi.mock('../aztec/AztecContext', () => ({
  AZTEC_CONFIG: {
    enabled: true,
    pxeUrl: 'https://rpc.testnet.aztec-labs.com', // not localhost → testnet branch
    faucetUrl: 'https://faucet.example.com',
    storageKeys: { accountAddress: 'acc' },
  },
}));

import { useAztec } from './useAztec';

const CLAIM = { claimAmount: 1n, claimSecret: { __fr: '0xabc' }, messageLeafIndex: 0n };

describe('useAztec testnet faucet branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.prepareConnection.mockResolvedValue({ accountAddress: '0xACC', alreadyDeployed: false, node: {} });
    h.deployAndRegister.mockResolvedValue({ wallet: {}, node: {}, accountAddress: '0xACC', ownedCardIds: [1, 2, 3, 4, 5] });
    // txManager.runTx just runs the supplied execute() with a no-op setPhase.
    h.runTx.mockImplementation(async ({ execute }) => execute(vi.fn()));
  });

  it('requests a claim and reaches connected, threading the claim into deploy', async () => {
    h.requestFeeJuiceClaim.mockResolvedValue(CLAIM);

    const { result } = renderHook(() => useAztec());
    await act(async () => { await result.current.connect(); });

    expect(h.requestFeeJuiceClaim).toHaveBeenCalledWith('https://faucet.example.com', '0xACC');
    // The claim is consumed by the combined deploy+mint tx.
    expect(h.deployAndRegister).toHaveBeenCalledTimes(1);
    expect(h.deployAndRegister.mock.calls[0][1]).toMatchObject({ feeJuiceClaim: CLAIM });
    expect(result.current.status).toBe('connected');
    expect(result.current.ownedCardIds).toEqual([1, 2, 3, 4, 5]);
  });

  it('falls back to manual funding when the faucet request fails (no deploy attempted)', async () => {
    h.requestFeeJuiceClaim.mockRejectedValue(new Error('faucet 503'));

    const { result } = renderHook(() => useAztec());
    await act(async () => { await result.current.connect(); });

    expect(h.requestFeeJuiceClaim).toHaveBeenCalledTimes(1);
    expect(h.deployAndRegister).not.toHaveBeenCalled(); // no claim → no deploy
    expect(result.current.status).toBe('needs-funding');
  });

  it('without a faucet URL, a fresh testnet account goes straight to manual funding', async () => {
    h.requestFeeJuiceClaim.mockResolvedValue(CLAIM);
    // Temporarily blank the configured faucet URL.
    const ctx = await import('../aztec/AztecContext');
    const prev = ctx.AZTEC_CONFIG.faucetUrl;
    (ctx.AZTEC_CONFIG as { faucetUrl: string }).faucetUrl = '';
    try {
      const { result } = renderHook(() => useAztec());
      await act(async () => { await result.current.connect(); });
      expect(h.requestFeeJuiceClaim).not.toHaveBeenCalled();
      expect(result.current.status).toBe('needs-funding');
    } finally {
      (ctx.AZTEC_CONFIG as { faucetUrl: string }).faucetUrl = prev;
    }
  });
});
