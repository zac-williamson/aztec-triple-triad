/**
 * Guards the wedge fix's core invariant: sendTx SYNCS THE PXE FIRST, before
 * any simulate/prove work (stock v5 EmbeddedWallet parity — its omission left
 * proofs anchored to stale blocks; see docs/history/V5_MIGRATION_REPORT.md).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@aztec/wallets/embedded', () => ({ EmbeddedWallet: class {} }));
vi.mock('@aztec/aztec.js/contracts', () => ({
  extractOffchainOutput: () => ({}),
  NO_WAIT: Symbol('NO_WAIT'),
}));
vi.mock('@aztec/wallet-sdk/base-wallet', () => ({ getGasLimits: () => ({ gasLimits: {}, teardownGasLimits: {} }) }));
vi.mock('@aztec/aztec.js/node', () => ({ waitForTx: vi.fn() }));
vi.mock('@aztec/aztec.js/authorization', () => ({ CallAuthorizationRequest: { fromFields: vi.fn() } }));
vi.mock('@aztec/stdlib/tx', () => ({
  collectOffchainEffects: () => [],
  TxStatus: { PROPOSED: 'proposed' },
}));
vi.mock('@aztec/stdlib/gas', () => ({ GasSettings: { from: (x: unknown) => x } }));

import { InstrumentedWallet } from './instrumentedWallet';

const header = (num: number, hash: string) => ({
  getBlockNumber: () => num,
  hash: () => hash,
});

function makeSelf(events: string[]) {
  const self = Object.create(InstrumentedWallet.prototype);
  return Object.assign(self, {
    pxe: {
      sync: vi.fn(async () => {
        events.push('sync.start');
        await Promise.resolve();
        events.push('sync.end');
      }),
      getSyncedBlockHeader: vi.fn(async () => header(100, '0xanchor')),
    },
    aztecNode: {
      getBlockNumber: vi.fn(async () => 101),
    },
    completeFeeOptions: vi.fn(async () => ({ gasSettings: {} })),
    simulateViaEntrypoint: vi.fn(async () => {
      events.push('simulate.start');
      throw new Error('STOP_AFTER_SIMULATE'); // end the test run here
    }),
  });
}

describe('InstrumentedWallet.sendTx sync-first invariant', () => {
  it('completes pxe.sync BEFORE the simulation starts', async () => {
    const events: string[] = [];
    const self = makeSelf(events);
    const payload = { calls: [{ name: 'join_game' }], authWitnesses: [] };

    await expect(
      InstrumentedWallet.prototype.sendTx.call(self, payload as never, { from: '0xme' } as never),
    ).rejects.toThrow('STOP_AFTER_SIMULATE');

    expect(events).toEqual(['sync.start', 'sync.end', 'simulate.start']);
    expect(self.pxe.sync).toHaveBeenCalledTimes(1);
  });

  it('syncPxeAndReport reports anchor/tip/lag and whether the anchor advanced', async () => {
    const self = Object.create(InstrumentedWallet.prototype);
    const headers = [header(95, '0xstale'), header(100, '0xfresh')];
    Object.assign(self, {
      pxe: {
        getSyncedBlockHeader: vi.fn(async () => headers.shift()),
        sync: vi.fn(async () => {}),
      },
      aztecNode: { getBlockNumber: vi.fn(async () => 102) },
    });

    const report = await InstrumentedWallet.prototype.syncPxeAndReport.call(self, 'test', true);
    expect(report.anchorBlock).toBe(100);
    expect(report.anchorHash).toBe('0xfresh');
    expect(report.tipBlock).toBe(102);
    expect(report.lag).toBe(2);
    expect(report.advanced).toBe(true); // 0xstale → 0xfresh
  });

  it('flags an unmoved anchor (advanced=false) — the wedge signature', async () => {
    const self = Object.create(InstrumentedWallet.prototype);
    Object.assign(self, {
      pxe: {
        getSyncedBlockHeader: vi.fn(async () => header(90, '0x2151c7dc')),
        sync: vi.fn(async () => {}),
      },
      aztecNode: { getBlockNumber: vi.fn(async () => 130) },
    });

    const report = await InstrumentedWallet.prototype.syncPxeAndReport.call(self, 'test', true);
    expect(report.advanced).toBe(false);
    expect(report.lag).toBe(40);
  });
});
