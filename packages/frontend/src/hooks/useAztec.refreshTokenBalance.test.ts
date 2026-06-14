/**
 * PXE-queue enforcement (Stage 2): refreshTokenBalance must read the balance
 * through the pxe.ts door (pxe.readTokenBalance), never a raw contract simulate.
 * The queue guarantee itself is pinned in pxe.test.ts; this pins that useAztec
 * delegates to that door and binds the PXE wallet on connect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  runTx: vi.fn(),
  readTokenBalance: vi.fn(),
  setPxeWallet: vi.fn(),
  prepareConnection: vi.fn(),
  deployAndRegister: vi.fn(),
}));

vi.mock('../aztec/txManager', () => ({ default: { runTx: h.runTx } }));
vi.mock('../aztec/pxe', () => ({
  pxe: { readTokenBalance: h.readTokenBalance },
  setPxeWallet: h.setPxeWallet,
  runPxeTx: vi.fn(),
}));
vi.mock('../aztec/connectToAztec', () => ({
  prepareConnection: h.prepareConnection,
  deployAndRegister: h.deployAndRegister,
}));
vi.mock('../aztec/AztecContext', () => ({
  AZTEC_CONFIG: {
    enabled: true,
    pxeUrl: 'https://rpc.testnet.aztec-labs.com',
    tokenContractAddress: '0xtoken',
    faucetUrl: '',
    storageKeys: { accountAddress: 'acc' },
  },
}));

import { useAztec } from './useAztec';

const WALLET = { id: 'wallet' };

describe('useAztec refreshTokenBalance — reads via the PXE queue door (Stage 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.prepareConnection.mockResolvedValue({ accountAddress: '0xACC', alreadyDeployed: true, node: {} });
    h.deployAndRegister.mockResolvedValue({ wallet: WALLET, node: {}, accountAddress: '0xACC', ownedCardIds: [] });
    h.runTx.mockImplementation(async ({ execute }: { execute: (p: unknown) => unknown }) => execute(vi.fn()));
    h.readTokenBalance.mockResolvedValue(42n);
  });

  it('reads the balance through pxe.readTokenBalance (not a raw contract)', async () => {
    const view = renderHook(() => useAztec());
    await act(async () => { await view.result.current.connect(); });
    await act(async () => { await view.result.current.refreshTokenBalance(); });

    expect(h.readTokenBalance).toHaveBeenCalledWith('0xACC');
    expect(view.result.current.tokenBalance).toBe(42);
  });

  it('binds the PXE module to the wallet on connect', async () => {
    const view = renderHook(() => useAztec());
    await act(async () => { await view.result.current.connect(); });

    expect(h.setPxeWallet).toHaveBeenCalledWith(WALLET);
  });
});
