/**
 * pxe.ts named ops — the contract-call shape that moved OUT of the hook tests
 * when the callers migrated to the single door. These pin:
 *  - sends route through the queue AND carry base-fee headroom (the playtest
 *    gate fix) — the contract is resolved and invoked INSIDE the door;
 *  - reads return decimal-safe processed VALUES, never a contract;
 *  - imports inject one note per import_note;
 *  - `contractCache` is NOT exported — a raw contract cannot escape the door.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  enqueuePxe: vi.fn(),
  ensureContracts: vi.fn(),
  waitForWarmup: vi.fn(),
  gasSettingsWithHeadroom: vi.fn(),
}));

vi.mock('./txManager', () => ({ default: { enqueuePxe: h.enqueuePxe, runTx: vi.fn() } }));
vi.mock('./contracts', () => ({
  ensureContracts: h.ensureContracts,
  waitForWarmup: h.waitForWarmup,
  warmupContracts: vi.fn(),
}));
vi.mock('./feeSettings', () => ({ gasSettingsWithHeadroom: h.gasSettingsWithHeadroom }));
vi.mock('./fieldUtils', () => ({
  toFr: (_Fr: any, v: any) => v,
  toHexString: (v: any) => '0x' + String(v),
}));

import { pxe, setPxeWallet } from './pxe';

class FakeFr {
  constructor(public v: any) {}
  toString() { return String(this.v); }
}
const AztecAddress = { fromStringUnsafe: (s: string) => ({ __addr: s }) };
const sim = (result: any) => ({ simulate: vi.fn().mockResolvedValue({ result }) });

beforeEach(() => {
  vi.clearAllMocks();
  setPxeWallet({ id: 'wallet' });
  h.waitForWarmup.mockResolvedValue(undefined);
  h.enqueuePxe.mockImplementation((fn: () => Promise<unknown>) => fn()); // passthrough queue
  h.gasSettingsWithHeadroom.mockResolvedValue({ maxFeesPerGas: 'HEADROOM' });
});

describe('pxe send ops — enqueue + base-fee headroom, contract stays inside', () => {
  it('sendCreateGame enqueues and sends create_game with headroom fee', async () => {
    const send = vi.fn().mockResolvedValue({ receipt: { txHash: { toString: () => '0xTX' } } });
    const create_game = vi.fn(() => ({ send }));
    h.ensureContracts.mockResolvedValue({ gameContract: { methods: { create_game } }, Fr: FakeFr, AztecAddress });

    const txHash = await pxe.sendCreateGame('0xME', [1, 2, 3], { node: {}, timeoutMs: 123 });

    expect(h.enqueuePxe).toHaveBeenCalledTimes(1);
    expect(create_game).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      from: { __addr: '0xME' },
      fee: { gasSettings: { maxFeesPerGas: 'HEADROOM' } },
      // interval:15 — poll getTxReceipt every 15s, not the SDK's 1s default
      // (testnet txs mine in minutes; cuts receipt-poll request volume).
      wait: { timeout: 123, interval: 15 },
    }));
    expect(txHash).toBe('0xTX');
  });

  it('sendProcessGame spreads the ordered args into the game method with headroom', async () => {
    const send = vi.fn().mockResolvedValue({ receipt: { txHash: { toString: () => '0xPG' } } });
    const process_game = vi.fn(() => ({ send }));
    h.ensureContracts.mockResolvedValue({ gameContract: { methods: { process_game } }, Fr: FakeFr, AztecAddress });

    const txHash = await pxe.sendProcessGame('0xME', ['a', 'b', 'c'], { node: {}, timeoutMs: 9 });

    expect(process_game).toHaveBeenCalledWith('a', 'b', 'c');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ fee: { gasSettings: { maxFeesPerGas: 'HEADROOM' } } }));
    expect(txHash).toBe('0xPG');
  });

  it('throws (no silent null) when a send returns no txHash', async () => {
    const send = vi.fn().mockResolvedValue({ receipt: { txHash: null } });
    h.ensureContracts.mockResolvedValue({ gameContract: { methods: { create_game: () => ({ send }) } }, Fr: FakeFr, AztecAddress });
    await expect(pxe.sendCreateGame('0xME', [1], { node: {}, timeoutMs: 1 })).rejects.toThrow(/no txHash/);
  });
});

describe('pxe read/import ops — values out, notes in', () => {
  it('previewCreateGame returns processed values through the queue (no contract escapes)', async () => {
    h.ensureContracts.mockResolvedValue({
      gameContract: { methods: { get_game_status: () => sim(0) } },
      nftContract: { methods: {
        get_note_nonce: () => sim(5),
        preview_game_data: () => sim([100, 1, 2, 3, 4, 5, 6]),
        compute_blinding_factor: () => sim(99),
      } },
      Fr: FakeFr, AztecAddress,
    });

    const out = await pxe.previewCreateGame('0xME');

    expect(h.enqueuePxe).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      gameId: '0x100',
      randomness: ['0x1', '0x2', '0x3', '0x4', '0x5', '0x6'],
      blindingFactor: '0x99',
      status: 0,
    });
  });

  it('importCardNotes injects one note per import_note, enqueued', async () => {
    const importSim = vi.fn().mockResolvedValue(undefined);
    const import_note = vi.fn(() => ({ simulate: importSim }));
    h.ensureContracts.mockResolvedValue({ nftContract: { methods: { import_note } }, Fr: FakeFr, AztecAddress });

    const ids = await pxe.importCardNotes(
      '0xME', '0xTX',
      [{ tokenId: 1, randomness: '0xr1' }, { tokenId: 2, randomness: '0xr2' }],
      'T', { noteHashes: ['0xh'], firstNullifier: '0xn' },
    );

    expect(h.enqueuePxe).toHaveBeenCalledTimes(1);
    expect(import_note).toHaveBeenCalledTimes(2);
    expect(ids).toEqual([1, 2]);
  });
});

describe('contracts module — contractCache stays private', () => {
  it('does NOT export contractCache (raw contracts cannot escape the door)', async () => {
    // importActual bypasses the ./contracts mock above to inspect the real module.
    const real = await vi.importActual<typeof import('./contracts')>('./contracts');
    expect((real as Record<string, unknown>).contractCache).toBeUndefined();
    // ensureContracts remains the door's internal accessor (pxe.ts + testkit only).
    expect(typeof (real as Record<string, unknown>).ensureContracts).toBe('function');
  });
});
