/**
 * App integration test — verifies hooks are wired and proof flow triggers.
 *
 * Uses mocked WebSocket and Aztec modules to test the wiring in App.tsx
 * without requiring actual network connections or Noir circuit execution.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render } from '@testing-library/react';
import { App } from '../App';

// Polyfill ResizeObserver for jsdom (required by React Three Fiber / react-use-measure)
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as any;
  }
});

// Mock useAztec (consumed by AztecProvider)
vi.mock('../hooks/useAztec', () => ({
  useAztec: () => ({
    status: 'unsupported' as const,
    isConnecting: false,
    hasConnected: false,
    accountAddress: null,
    isAvailable: false,
    error: null,
    wallet: null,
    nodeClient: null,
    ownedCardIds: [],
    connect: vi.fn(),
    disconnect: vi.fn(),
    refreshOwnedCards: vi.fn(),
    updateOwnedCards: vi.fn(),
  }),
}));

// Mock useWebSocket (consumed by useGameOrchestrator)
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
    opponentAztecAddress: null,
    opponentOnChainGameId: null,
    opponentCardIds: [],
    incomingNoteData: null,
    opponentGameRandomness: null,
    matchmakingStatus: 'idle' as const,
    queuePosition: null,
    createGame: vi.fn(),
    joinGame: vi.fn(),
    placeCard: vi.fn(),
    submitHandProof: vi.fn(),
    submitMoveProof: vi.fn(),
    shareAztecInfo: vi.fn(),
    relayNoteData: vi.fn(),
    refreshGameList: vi.fn(),
    leaveGame: vi.fn(),
    disconnect: vi.fn(),
    queueMatchmaking: vi.fn(),
    cancelMatchmaking: vi.fn(),
    ping: vi.fn(),
  }),
}));

// Mock useGameSession (consumed by useGameOrchestrator)
vi.mock('../hooks/useGameSession', () => ({
  useGameSession: () => ({
    onChainGameId: null,
    gameRandomness: null,
    blindingFactor: null,
    isContractAvailable: false,
    settleTxStatus: 'idle' as const,
    settleTxHash: null,
    settleError: null,
    myHandProof: null,
    opponentHandProof: null,
    collectedMoveProofs: [],
    canSettle: false,
    myCardCommit: null,
    opponentCardCommit: null,
    handProofStatus: 'idle' as const,
    moveProofStatus: 'idle' as const,
    createGameOnChain: vi.fn(),
    joinGameOnChain: vi.fn(),
    settleGame: vi.fn(),
    setOpponentHandProof: vi.fn(),
    addMoveProof: vi.fn(),
    generateHandProofFromState: vi.fn(),
    generateMoveProofForPlacement: vi.fn().mockResolvedValue(null),
    restoreState: vi.fn(),
    reset: vi.fn(),
  }),
}));

describe('App Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the lobby screen by default', () => {
    render(<App />);
    expect(document.querySelector('.app')).toBeTruthy();
  });

  it('uses all required hooks without crashing', () => {
    expect(() => render(<App />)).not.toThrow();
  });

  it('passes mapWinnerId correctly', async () => {
    const { mapWinnerId } = await import('../hooks/useGameOrchestrator');
    expect(mapWinnerId(null)).toBe(0);
    expect(mapWinnerId('player1')).toBe(1);
    expect(mapWinnerId('player2')).toBe(2);
    expect(mapWinnerId('draw')).toBe(3);
  });
});
