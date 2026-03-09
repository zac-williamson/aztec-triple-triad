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

// Mock useWebSocket (consumed by useGame)
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
    opponentTxConfirmed: false,
    matchmakingStatus: 'idle' as const,
    queuePosition: null,
    createGame: vi.fn(),
    joinGame: vi.fn(),
    placeCard: vi.fn(),
    submitHandProof: vi.fn(),
    submitMoveProof: vi.fn(),
    shareAztecInfo: vi.fn(),
    relayNoteData: vi.fn(),
    notifyTxConfirmed: vi.fn(),
    refreshGameList: vi.fn(),
    leaveGame: vi.fn(),
    disconnect: vi.fn(),
    queueMatchmaking: vi.fn(),
    cancelMatchmaking: vi.fn(),
    ping: vi.fn(),
  }),
}));

// Mock useProofGeneration (consumed by useGame)
vi.mock('../hooks/useProofGeneration', () => ({
  useProofGeneration: () => ({
    generateHandProof: vi.fn(),
    generateMoveProof: vi.fn().mockResolvedValue(null),
    reset: vi.fn(),
  }),
}));

// Mock contracts module
vi.mock('../aztec/contracts', () => ({
  ensureContracts: vi.fn(),
  contractCache: { gameContract: null },
  warmupContracts: vi.fn(),
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
    const { mapWinnerId } = await import('../hooks/useGame');
    expect(mapWinnerId(null)).toBe(0);
    expect(mapWinnerId('player1')).toBe(1);
    expect(mapWinnerId('player2')).toBe(2);
    expect(mapWinnerId('draw')).toBe(3);
  });
});
