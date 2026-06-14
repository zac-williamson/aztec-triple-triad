/**
 * pxe.ts — the single PXE door. These pin the core invariant the directive
 * wants structurally guaranteed:
 *  - standalone `pxe.*` ops ENQUEUE on the serial queue (never a raw simulate);
 *  - `runPxeTx` ops run INLINE within the tx's single queue item (no re-enqueue,
 *    so atomicity / settlement-priority / postEffects ordering are preserved).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  enqueuePxe: vi.fn(),
  runTx: vi.fn(),
  simulate: vi.fn(),
  ensureContracts: vi.fn(),
  waitForWarmup: vi.fn(),
}));

vi.mock('./txManager', () => ({ default: { enqueuePxe: h.enqueuePxe, runTx: h.runTx } }));
vi.mock('./contracts', () => ({ ensureContracts: h.ensureContracts, waitForWarmup: h.waitForWarmup }));

import { pxe, setPxeWallet, runPxeTx } from './pxe';

describe('pxe — serial-queue door', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPxeWallet({ id: 'wallet' });
    h.waitForWarmup.mockResolvedValue(undefined);
    h.simulate.mockResolvedValue({ result: 7n });
    h.ensureContracts.mockResolvedValue({
      tokenContract: { methods: { get_balance: () => ({ simulate: h.simulate }) } },
      AztecAddress: { fromString: (s: string) => s },
    });
  });

  it('readTokenBalance enqueues the op and returns the decimal-safe bigint', async () => {
    h.enqueuePxe.mockImplementation((fn: () => Promise<unknown>) => fn()); // passthrough queue

    const balance = await pxe.readTokenBalance('0xACC');

    expect(h.enqueuePxe).toHaveBeenCalledTimes(1);
    expect(h.enqueuePxe).toHaveBeenCalledWith(expect.any(Function));
    expect(h.simulate).toHaveBeenCalledTimes(1);
    expect(balance).toBe(7n);
  });

  it('reads ONLY through the queue — a stub queue that drops the op never reaches simulate', async () => {
    h.enqueuePxe.mockImplementation(() => undefined); // queue that does not run the op

    await pxe.readTokenBalance('0xACC');

    expect(h.enqueuePxe).toHaveBeenCalled();
    expect(h.simulate).not.toHaveBeenCalled(); // the read is unreachable outside the queue
  });

  it('throws when no wallet is bound', async () => {
    h.enqueuePxe.mockImplementation((fn: () => Promise<unknown>) => fn());
    setPxeWallet(null);
    await expect(pxe.readTokenBalance('0xACC')).rejects.toThrow(/wallet not set/);
  });

  it('runPxeTx runs ops INLINE within the tx item (no re-enqueue)', async () => {
    h.runTx.mockImplementation(async ({ execute }: { execute: (sp: unknown) => unknown }) => execute(vi.fn()));

    const balance = await runPxeTx({
      type: 'create_game',
      label: 'test',
      execute: (ops) => ops.readTokenBalance('0xACC'),
    });

    expect(h.runTx).toHaveBeenCalledTimes(1);
    expect(h.enqueuePxe).not.toHaveBeenCalled(); // inline — would deadlock if it re-enqueued
    expect(h.simulate).toHaveBeenCalledTimes(1);
    expect(balance).toBe(7n);
  });
});
