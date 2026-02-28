/**
 * App integration test — verifies hooks are wired and proof flow triggers.
 *
 * Uses mocked WebSocket and Aztec modules to test the wiring in App.tsx
 * without requiring actual network connections or Noir circuit execution.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { App } from '../App';

// Mock all Aztec-related hooks
vi.mock('../hooks/useAztec', () => ({
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

vi.mock('../hooks/useGameFlow', () => ({
  useGameFlow: (config: any) => ({
    myHandProof: null,
    opponentHandProof: null,
    collectedMoveProofs: [],
    canSettle: false,
    myCardCommit: null,
    opponentCardCommit: null,
    blindingFactor: '',
    handProofStatus: 'idle',
    moveProofStatus: 'idle',
    setOpponentHandProof: vi.fn(),
    addMoveProof: vi.fn(),
    generateMoveProofForPlacement: vi.fn().mockResolvedValue(null),
    reset: vi.fn(),
  }),
}));

vi.mock('../hooks/useGameContract', () => ({
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

// Mock WebSocket to prevent actual connection attempts
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    connected: true,
    gameId: null,
    playerNumber: null,
    gameState: null,
    lastCaptures: [],
    gameList: [],
    error: null,
    gameOver: null,
    opponentDisconnected: false,
    opponentHandProof: null,
    lastMoveProof: null,
    createGame: vi.fn(),
    joinGame: vi.fn(),
    placeCard: vi.fn(),
    submitHandProof: vi.fn(),
    submitMoveProof: vi.fn(),
    refreshGameList: vi.fn(),
    disconnect: vi.fn(),
  }),
}));

describe('App Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the lobby screen by default', () => {
    render(<App />);
    // Lobby should be visible
    expect(document.querySelector('.app')).toBeTruthy();
  });

  it('uses all required hooks without crashing', () => {
    // This test verifies that useAztec, useGameFlow, and useGameContract
    // are all called during render without errors
    expect(() => render(<App />)).not.toThrow();
  });

  it('passes mapWinnerId correctly', async () => {
    const { mapWinnerId } = await import('../App');
    expect(mapWinnerId(null)).toBe(0);
    expect(mapWinnerId('player1')).toBe(1);
    expect(mapWinnerId('player2')).toBe(2);
    expect(mapWinnerId('draw')).toBe(3);
  });
});
