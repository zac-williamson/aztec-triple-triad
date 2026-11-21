/**
 * The create/join pipeline must never restart on a game whose on-chain
 * lifecycle has finished.
 *
 * A finished lifecycle ends in 'idle', which is also where the pipeline starts
 * one. After an abandoned-game recovery the relay keeps updating the (dead)
 * game, and the browser showed the next re-render restarting it: player 2 built
 * a fresh join preview and shared its randomness with an opponent who had gone;
 * a player 1 claimant would have sent a second create_game, committing the five
 * cards it had just recovered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  runPxeTx: vi.fn(),
}));

vi.mock('../../aztec/AztecContext', () => ({
  useAztecContext: () => ({
    wallet: { fake: true },
    accountAddress: '0xPLAYER2',
    nodeClient: {},
    updateOwnedCards: vi.fn(),
  }),
}));
vi.mock('../../aztec/pxe', () => ({
  runPxeTx: h.runPxeTx,
  warmupPxe: vi.fn(),
}));
vi.mock('../../aztec/cardStore', () => ({ removeCards: vi.fn() }));
vi.mock('../../aztec/config', () => ({
  AZTEC_CONFIG: { enabled: true, gameContractAddress: '0xGAME', nftContractAddress: '0xNFT' },
}));

import { useGameSession } from '../useGameSession';

function ws(over: Record<string, unknown> = {}) {
  return {
    gameId: 'room-1',
    playerNumber: 2,
    gameState: { status: 'playing' },
    opponentOnChainGameId: '0xCHAIN',
    opponentTxConfirmed: false,
    opponentCardIds: [],
    opponentAztecAddress: '0xPLAYER1',
    opponentGameRandomness: null,
    shareAztecInfo: vi.fn(),
    notifyTxConfirmed: vi.fn(),
    addMessageListener: vi.fn(() => () => {}),
    ...over,
  } as never;
}

/** How many times the pipeline has started (P2: a join preview). */
const pipelineStarts = () => h.runPxeTx.mock.calls.filter(([o]) => o?.type === 'join_game').length;

beforeEach(() => {
  vi.clearAllMocks();
  // Never settles: the pipeline stays in 'preparing' until the test moves it.
  h.runPxeTx.mockImplementation(() => new Promise(() => {}));
});

describe('the on-chain pipeline and a finished game', () => {
  it('does not restart on a game marked complete, however often the relay updates it', () => {
    const { result, rerender } = renderHook(
      ({ socket }) => useGameSession({ ws: socket, screen: 'game', cardIds: [1, 2, 3, 4, 5] }),
      { initialProps: { socket: ws() } },
    );
    expect(pipelineStarts(), 'the pipeline starts for a live game').toBe(1);

    // The game's lifecycle finishes (here: an abandoned-game recovery) and
    // ends where every lifecycle ends, in 'idle'.
    act(() => {
      result.current.markLifecycleComplete();
      result.current.transitionPhase('idle');
    });

    // The relay keeps talking about the same, dead game.
    rerender({ socket: ws({ gameState: { status: 'playing' } }) });
    rerender({ socket: ws({ gameState: { status: 'finished' } }) });

    expect(pipelineStarts(), 'restarted on a finished game').toBe(1);
    expect(result.current.getPhase()).toBe('idle');
  });

  it('still starts the pipeline for the next game', () => {
    const { result, rerender } = renderHook(
      ({ socket }) => useGameSession({ ws: socket, screen: 'game', cardIds: [1, 2, 3, 4, 5] }),
      { initialProps: { socket: ws() } },
    );
    act(() => {
      result.current.markLifecycleComplete();
      result.current.transitionPhase('idle');
    });

    rerender({ socket: ws({ gameId: 'room-2', opponentOnChainGameId: '0xCHAIN2' }) });

    expect(pipelineStarts(), 'a new game must still get its on-chain setup').toBe(2);
  });
});
