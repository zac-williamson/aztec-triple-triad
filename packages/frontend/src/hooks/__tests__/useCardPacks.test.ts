import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// --- Mock all heavy dependencies ---

const mockNftContract = {
  methods: {
    get_note_nonce: vi.fn(),
    preview_card_ids: vi.fn(),
    purchase_card_pack: vi.fn(),
    compute_note_randomness: vi.fn(),
  },
};

const mockRunTx = vi.fn();

vi.mock('../../aztec/txManager', () => ({
  default: { runTx: (...args: any[]) => mockRunTx(...args) },
}));

vi.mock('../../aztec/noteImporter', () => ({
  importNotesFromTx: vi.fn().mockResolvedValue(undefined),
  fetchTxEffectData: vi.fn().mockResolvedValue({
    noteHashes: ['0xnh1'],
    firstNullifier: '0xnull1',
  }),
  getNftArtifact: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../aztec/cardStore', () => ({
  addCards: vi.fn(),
}));

vi.mock('../../aztec/fieldUtils', () => ({
  toFr: (_Fr: any, v: any) => ({ toString: () => v.toString() }),
}));

vi.mock('../../aztec/gameConstants', () => ({
  AZTEC_TX_TIMEOUT: 300,
  CARDS_PER_PACK: 10,
}));

vi.mock('../../aztec/config', () => ({
  AZTEC_CONFIG: { nftContractAddress: '0xNFT' },
}));

// Mock Aztec SDK lazy imports
vi.mock('@aztec/aztec.js/addresses', () => ({
  AztecAddress: { fromString: (s: string) => s },
}));
vi.mock('@aztec/aztec.js/fields', () => {
  class MockFr {
    constructor(public value: any) {}
    toString() { return this.value.toString(); }
  }
  return { Fr: MockFr };
});
vi.mock('@aztec/aztec.js/contracts', () => ({
  Contract: {
    at: vi.fn().mockResolvedValue(mockNftContract),
  },
}));

import { useCardPacks, type LocationInfo } from '../useCardPacks';
import { addCards } from '../../aztec/cardStore';

const RIVER: LocationInfo = { id: 1, name: 'River', description: 'test', cooldownHours: 4 };

describe('useCardPacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
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

  it('hunt runs the full preview → purchase → import flow', async () => {
    const previewCardIds = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

    // Mock nft contract methods
    mockNftContract.methods.get_note_nonce.mockReturnValue({
      simulate: vi.fn().mockResolvedValue({ result: 42 }),
    });
    mockNftContract.methods.preview_card_ids.mockReturnValue({
      simulate: vi.fn().mockResolvedValue({ result: previewCardIds }),
    });
    const purchaseSend = vi.fn().mockResolvedValue({ receipt: { txHash: { toString: () => '0xTX_HASH' } } });
    mockNftContract.methods.purchase_card_pack.mockReturnValue({ send: purchaseSend });
    mockNftContract.methods.compute_note_randomness.mockReturnValue({
      simulate: vi.fn().mockResolvedValue({
        result: previewCardIds.map((_, i) => ({ toString: () => `0xrand${i}` })),
      }),
    });

    // Make txManager.runTx execute the callback directly
    mockRunTx.mockImplementation(async (opts: any) => {
      return opts.execute(() => {});
    });

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

    // SponsoredFPC is banned: the purchase is sent WITHOUT a fee option —
    // the sender pays natively in Fee Juice (wallet default).
    expect(purchaseSend).toHaveBeenCalledTimes(1);
    expect(purchaseSend.mock.calls[0][0]).not.toHaveProperty('fee');
    expect(purchaseSend.mock.calls[0][0]).toMatchObject({ from: '0xACCOUNT' });

    // Verify cards were persisted
    expect(addCards).toHaveBeenCalledWith(
      '0xACCOUNT',
      expect.arrayContaining([
        expect.objectContaining({ cardId: 10, txHash: '0xTX_HASH' }),
      ]),
    );
  });

  it('hunt sets error state on failure', async () => {
    mockRunTx.mockRejectedValue(new Error('Transaction reverted'));

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
    mockRunTx.mockResolvedValue({ cardIds: [1], txHash: null });

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
