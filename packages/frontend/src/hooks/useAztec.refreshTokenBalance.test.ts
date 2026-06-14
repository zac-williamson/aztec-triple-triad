/**
 * Stage 1 of the PXE-queue-enforcement directive: refreshTokenBalance must read
 * `get_balance` THROUGH the serial PXE queue (txManager.enqueuePxe), never as a
 * raw `.simulate()`. It fires on a 15× connect poll and after every settlement,
 * so an unqueued read races queued PXE ops → IndexedDB TransactionInactiveError
 * (ground rule #6). These tests fail if the read is ever moved back outside the
 * queue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  runTx: vi.fn(),
  enqueuePxe: vi.fn(),
  simulate: vi.fn(),
  prepareConnection: vi.fn(),
  deployAndRegister: vi.fn(),
  waitForWarmup: vi.fn(),
}));

vi.mock('../aztec/txManager', () => ({ default: { runTx: h.runTx, enqueuePxe: h.enqueuePxe } }));
vi.mock('../aztec/connectToAztec', () => ({
  prepareConnection: h.prepareConnection,
  deployAndRegister: h.deployAndRegister,
}));
vi.mock('../aztec/contracts', () => ({
  waitForWarmup: h.waitForWarmup,
  // The raw contract cache the directive wants behind the queue (Stage 2). For
  // now we assert the ONE read that escaped it is routed through enqueuePxe.
  contractCache: {
    tokenContract: { methods: { get_balance: () => ({ simulate: h.simulate }) } },
    AztecAddress: { fromString: (s: string) => ({ toString: () => s }) },
  },
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
import txManager from '../aztec/txManager';

async function connectAndRefresh(refresh = true) {
  const view = renderHook(() => useAztec());
  await act(async () => { await view.result.current.connect(); });
  if (refresh) await act(async () => { await view.result.current.refreshTokenBalance(); });
  return view;
}

describe('useAztec refreshTokenBalance — PXE queue enforcement (Stage 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // alreadyDeployed path sets walletRef + accountAddress without a fund/deploy tx.
    h.prepareConnection.mockResolvedValue({ accountAddress: '0xACC', alreadyDeployed: true, node: {} });
    h.deployAndRegister.mockResolvedValue({ wallet: {}, node: {}, accountAddress: '0xACC', ownedCardIds: [] });
    h.runTx.mockImplementation(async ({ execute }: { execute: (p: unknown) => unknown }) => execute(vi.fn()));
    h.waitForWarmup.mockResolvedValue(undefined);
  });

  it('reads get_balance ONLY through the queue — a stubbed queue that drops the op never reaches simulate', async () => {
    // enqueuePxe that does NOT run the op: if the read were a raw simulate it
    // would still fire; routed through the queue it cannot.
    h.enqueuePxe.mockImplementation(() => undefined);

    await connectAndRefresh();

    expect(txManager.enqueuePxe).toHaveBeenCalled();   // the read was handed to the queue
    expect(h.simulate).not.toHaveBeenCalled();          // ...and never executed outside it
  });

  it('updates the balance when the queue runs the op', async () => {
    h.enqueuePxe.mockImplementation((fn: () => Promise<unknown>) => fn()); // passthrough queue
    h.simulate.mockResolvedValue({ result: 42n });

    const { result } = await connectAndRefresh();

    // simulate may run more than once (the connect poll also calls refresh);
    // what matters is it ran via the fn handed to enqueuePxe, and the balance set.
    expect(h.simulate).toHaveBeenCalled();
    expect(txManager.enqueuePxe).toHaveBeenCalledWith(expect.any(Function));
    expect(result.current.tokenBalance).toBe(42);
  });
});
