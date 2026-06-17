/**
 * App integration test — verifies hooks are wired and proof flow triggers.
 *
 * Uses mocked WebSocket and Aztec modules to test the wiring in App.tsx
 * without requiring actual network connections or Noir circuit execution.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../App';

// Mutable Aztec connection state so individual tests can drive the status the
// App routes on (deploying overlay, needs-funding manual-funding fallback).
const azt = vi.hoisted(() => ({ status: 'unsupported' as string, accountAddress: null as string | null }));

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
    status: azt.status,
    isConnecting: azt.status === 'deploying',
    hasConnected: azt.status === 'connected',
    accountAddress: azt.accountAddress,
    isAvailable: false,
    error: null,
    wallet: null,
    nodeClient: null,
    ownedCardIds: [],
    connect: vi.fn(),
    confirmFunded: vi.fn(),
    disconnect: vi.fn(),
    refreshOwnedCards: vi.fn(),
    updateOwnedCards: vi.fn(),
    tokenBalance: 0,
    refreshTokenBalance: vi.fn(),
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
    addMessageListener: vi.fn(() => () => {}),
    opponentSettling: null,
    notifySettleStarted: vi.fn(),
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
  waitForWarmup: vi.fn(),
}));

describe('App Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear(); // controls the new-player tutorial gate (tutorial_seen)
    azt.status = 'unsupported';
    azt.accountAddress = null;
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

  // While deploying, a RETURNING player (tutorial already seen) sees the
  // onboarding progress spinner; the manual FundingPrompt is the funding path on
  // a non-local network (the app never auto-funds).
  it('shows the onboarding progress screen while deploying (returning player)', () => {
    localStorage.setItem('tutorial_seen', 'true');
    azt.status = 'deploying';
    render(<App />);
    expect(screen.getByText('Getting You Set Up')).toBeTruthy();
    expect(screen.queryByText('Fund Your Account')).toBeNull();
    expect(screen.queryByText('First time here?')).toBeNull();
  });

  // A NEW player gets the tutorial prompt DURING deploying — so they play the
  // tutorial in parallel with the account-deploy + starter-card txs instead of
  // staring at the progress spinner (the bug this fixes).
  it('offers the tutorial to a new player while deploying (parallel onboarding)', () => {
    azt.status = 'deploying'; // localStorage cleared in beforeEach → new player
    render(<App />);
    expect(screen.getByText('First time here?')).toBeTruthy();
    expect(screen.queryByText('Getting You Set Up')).toBeNull();
  });

  it('shows the manual FundingPrompt when funding is needed', () => {
    azt.status = 'needs-funding';
    azt.accountAddress = '0xABCDEF';
    render(<App />);
    expect(screen.getByText('Fund Your Account')).toBeTruthy();
    expect(screen.queryByText('Getting You Set Up')).toBeNull();
  });
});
