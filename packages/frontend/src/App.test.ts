import { describe, it, expect, vi } from 'vitest';

// Mock Aztec-dependent hooks to prevent Vite from resolving uninstalled @aztec/* packages
vi.mock('./hooks/useAztec', () => ({
  useAztec: () => ({
    status: 'unsupported' as const,
    accountAddress: null,
    isAvailable: false,
    error: null,
    wallet: null,
    nodeClient: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

vi.mock('./hooks/useGameContract', () => ({
  useGameContract: () => ({
    txStatus: 'idle' as const,
    txHash: null,
    error: null,
    ownedCards: [],
    isAvailable: false,
    settleGame: vi.fn(),
    queryOwnedCards: vi.fn().mockResolvedValue([]),
    resetTx: vi.fn(),
    lifecycleTxStatus: 'idle' as const,
    onChainStatus: null,
    canSettleOnChain: false,
    createGameOnChain: vi.fn(),
    joinGameOnChain: vi.fn(),
    handleOnChainStatus: vi.fn(),
    resetLifecycle: vi.fn(),
  }),
}));

import { mapWinnerId } from './App';

describe('mapWinnerId', () => {
  it('maps player1 winner to 1', () => {
    expect(mapWinnerId('player1')).toBe(1);
  });

  it('maps player2 winner to 2', () => {
    expect(mapWinnerId('player2')).toBe(2);
  });

  it('maps draw to 3', () => {
    expect(mapWinnerId('draw')).toBe(3);
  });

  it('maps null (ongoing game) to 0', () => {
    expect(mapWinnerId(null)).toBe(0);
  });

  it('matches circuit winner_id semantics (0=not ended, 1=p1, 2=p2, 3=draw)', () => {
    // These values MUST match circuits/game_move/src/main.nr winner_id assertions
    const mapping: [string | null, number][] = [
      [null, 0],
      ['player1', 1],
      ['player2', 2],
      ['draw', 3],
    ];

    for (const [winner, expected] of mapping) {
      expect(mapWinnerId(winner as any)).toBe(expected);
    }
  });
});
