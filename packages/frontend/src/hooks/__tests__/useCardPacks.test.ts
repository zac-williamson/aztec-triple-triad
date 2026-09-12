/**
 * useCardPacks orchestrates the pack purchase through the PXE door (`pxe.ts`):
 * preview → purchase send → note-randomness → import, all inside one runPxeTx
 * queue item. This pins the ORCHESTRATION (the hook calls the right ops with the
 * right args); the ops' own contract-call shape + fee headroom are pinned in
 * pxe.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const hoisted = vi.hoisted(() => {
  const previewCardPack = vi.fn();
  const sendPurchaseCardPack = vi.fn();
  const computeNoteRandomness = vi.fn();
  const importCardNotes = vi.fn();
  return {
    ops: { previewCardPack, sendPurchaseCardPack, computeNoteRandomness, importCardNotes },
    previewCardPack, sendPurchaseCardPack, computeNoteRandomness, importCardNotes,
    runPxeTx: vi.fn(),
    fetchTxEffectData: vi.fn(),
    addCards: vi.fn(),
  };
});

vi.mock('../../aztec/pxe', () => ({ runPxeTx: hoisted.runPxeTx }));
vi.mock('../../aztec/noteImporter', () => ({ fetchTxEffectData: hoisted.fetchTxEffectData }));
vi.mock('../../aztec/cardStore', () => ({ addCards: hoisted.addCards }));
vi.mock('../../aztec/gameConstants', () => ({ AZTEC_TX_TIMEOUT: 300, CARDS_PER_PACK: 10 }));

import { useCardPacks, type LocationInfo } from '../useCardPacks';

const RIVER: LocationInfo = { id: 1, name: 'River', description: 'test', cooldownHours: 4 };

describe('useCardPacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Default: runPxeTx runs the body inline with the op spies (the inline facade).
    hoisted.runPxeTx.mockImplementation(async (opts: any) => {
      const result = await opts.execute(hoisted.ops, () => {});
      if (opts.postEffects) await opts.postEffects(result, hoisted.ops);
      return result;
    });
  });

  it('starts in idle state', () => {
    const { result } = renderHook(() => useCardPacks(null, null, null));
    expect(result.current.txStatus).toBe('idle');
    expect(result.current.activeLocation).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('hunt throws when wallet is null', async () => {
    const { result } = renderHook(() => useCardPacks(null, null, null));
    await expect(
      act(async () => {
        await result.current.hunt(RIVER);
      }),
    ).rejects.toThrow('Wallet not connected');
  });

  it('hunt runs the full preview → purchase → import flow via pxe ops', async () => {
    const previewCardIds = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

    hoisted.previewCardPack.mockResolvedValue({ cardIds: previewCardIds, nonce: '0xNONCE' });
    hoisted.sendPurchaseCardPack.mockResolvedValue('0xTX_HASH');
    hoisted.computeNoteRandomness.mockResolvedValue(previewCardIds.map((_, i) => `0xrand${i}`));
    hoisted.importCardNotes.mockResolvedValue(previewCardIds);
    hoisted.fetchTxEffectData.mockResolvedValue({ noteHashes: ['0xnh1'], firstNullifier: '0xnull1' });

    const mockWallet = {};
    const mockNodeClient = {};
    const { result } = renderHook(() => useCardPacks(mockWallet, mockNodeClient, '0xACCOUNT'));

    let huntResult: any;
    await act(async () => {
      huntResult = await result.current.hunt(RIVER);
    });

    expect(huntResult.cardIds).toEqual(previewCardIds);
    expect(huntResult.txHash).toBe('0xTX_HASH');
    expect(result.current.txStatus).toBe('done');

    // The purchase goes through the named send op (not a raw contract). The fee
    // headroom the op applies is asserted in pxe.test.ts.
    expect(hoisted.sendPurchaseCardPack).toHaveBeenCalledWith('0xACCOUNT', { node: mockNodeClient, timeoutMs: 300 });
    // Note-randomness derived from the pre-purchase nonce.
    expect(hoisted.computeNoteRandomness).toHaveBeenCalledWith('0xACCOUNT', '0xNONCE', 10);

    // Cards persisted to localStorage with the tx-effect aux data...
    expect(hoisted.addCards).toHaveBeenCalledWith(
      '0xACCOUNT',
      expect.arrayContaining([
        expect.objectContaining({ cardId: 10, randomness: '0xrand0', txHash: '0xTX_HASH', noteHashes: ['0xnh1'], firstNullifier: '0xnull1' }),
      ]),
    );
    // ...and imported into the PXE via the named op.
    expect(hoisted.importCardNotes).toHaveBeenCalledWith(
      '0xACCOUNT', '0xTX_HASH',
      expect.arrayContaining([{ tokenId: 10, randomness: '0xrand0' }]),
      'Card pack',
      { noteHashes: ['0xnh1'], firstNullifier: '0xnull1' },
    );
  });

  it('hunt sets error state on failure', async () => {
    hoisted.runPxeTx.mockRejectedValue(new Error('Transaction reverted'));

    const { result } = renderHook(() => useCardPacks({}, {}, '0xACCOUNT'));

    let caught: Error | undefined;
    await act(async () => {
      try {
        await result.current.hunt(RIVER);
      } catch (e) {
        caught = e as Error;
      }
    });

    expect(caught?.message).toBe('Transaction reverted');
    expect(result.current.txStatus).toBe('error');
    expect(result.current.error).toBe('Transaction reverted');
  });

  it('hunt clears activeLocation after completion', async () => {
    hoisted.runPxeTx.mockResolvedValue({ cardIds: [1], txHash: '0xT' });

    const { result } = renderHook(() => useCardPacks({}, null, '0xACCOUNT'));

    await act(async () => {
      await result.current.hunt(RIVER);
    });

    expect(result.current.activeLocation).toBeNull();
  });

  it('refreshCooldowns is a no-op', async () => {
    const { result } = renderHook(() => useCardPacks(null, null, null));
    // Should not throw
    await act(async () => {
      await result.current.refreshCooldowns();
    });
    expect(result.current.cooldowns).toEqual({});
  });
});
