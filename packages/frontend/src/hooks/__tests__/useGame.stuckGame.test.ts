/**
 * Cards committed to a game nobody finished.
 *
 * Committing is the easy half. Getting the cards back needs somebody to settle
 * or claim, and if a player closes the tab mid-game the only claim button in
 * the app is on the game screen — which they can no longer reach. Their five
 * cards stay locked with nothing telling them so. The bot had exactly this
 * problem and it cost thirty cards across six games.
 *
 * Status 2 is ACTIVE: created, joined, neither settled nor claimed. That is
 * the state, and the ONLY state, where cards are locked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  loadGameMock: vi.fn(),
  readInfoMock: vi.fn(),
  contestMock: vi.fn().mockResolvedValue('0xtx'),
  handleAbandonedGameMock: vi.fn().mockResolvedValue(undefined),
  restorePlayMock: vi.fn(),
  restoreSessionMock: vi.fn(),
}));

vi.mock('../useWebSocket', () => ({
  useWebSocket: () => ({
    connected: true, gameId: null, playerNumber: null, gameState: null,
    gameOver: null, matchmakingStatus: 'idle', opponentDisconnected: false,
    abandonmentWarning: null, lastCaptures: [], gameList: [], error: null,
    addMessageListener: () => () => {}, queueMatchmaking: vi.fn(),
    cancelMatchmaking: vi.fn(), leaveGame: vi.fn(), placeCard: vi.fn(),
    submitHandProof: vi.fn(), submitMoveProof: vi.fn(), shareAztecInfo: vi.fn(),
    shareBlinding: vi.fn(), relayNoteData: vi.fn(), notifyTxConfirmed: vi.fn(),
    notifyTxFailed: vi.fn(), notifySettleStarted: vi.fn(),
    notifyAbandonedSettled: vi.fn(), cancelGame: vi.fn(),
  }),
}));

vi.mock('../../aztec/AztecContext', () => ({
  useAztecContext: () => ({
    wallet: {}, accountAddress: '0xACCOUNT', nodeClient: {}, isAvailable: true,
    ownedCardIds: [], updateOwnedCards: vi.fn(), refreshTokenBalance: vi.fn(),
    status: 'connected', isConnecting: false, hasConnected: true, error: null,
    connect: vi.fn(), confirmFunded: vi.fn(), disconnect: vi.fn(),
    refreshOwnedCards: vi.fn(), tokenBalance: 0,
  }),
}));

// One stable object: the real hook returns useCallback-wrapped functions, and
// a fresh object per render would re-run every effect that depends on it.
const storageStub = {
  saveGame: vi.fn(), loadGame: hoisted.loadGameMock,
  clearGame: vi.fn(), hasGame: () => !!hoisted.loadGameMock(),
};
vi.mock('../useGameStorage', () => ({ useGameStorage: () => storageStub }));

vi.mock('../../aztec/pxe', () => ({
  pxe: {
    readAbandonmentInfo: hoisted.readInfoMock,
    sendContestAbandonment: hoisted.contestMock,
  },
  runPxeTx: vi.fn(), warmupPxe: vi.fn(),
}));

vi.mock('../useGamePlay', async (orig) => {
  const actual = await orig<typeof import('../useGamePlay')>();
  return { ...actual, useGamePlay: () => ({
    ...({} as any),
    handProofStatus: 'idle', moveProofStatus: 'idle', canSettle: false,
    myHandProof: null, opponentHandProof: null, collectedMoveProofs: [],
    handlePlaceCard: vi.fn(), restoreFromSave: hoisted.restorePlayMock,
    resetForMenu: vi.fn(), reset: vi.fn(),
  }) };
});

vi.mock('../useGameSession', async (orig) => {
  const actual = await orig<typeof import('../useGameSession')>();
  return { ...actual, useGameSession: () => ({
    onChainGameId: null, onChainError: null, blindingFactor: null,
    restoreFromSave: hoisted.restoreSessionMock, transitionPhase: vi.fn(),
    getBlindingFactor: () => null, resetForMenu: vi.fn(),
    getPhase: () => 'idle', phase: 'idle', settlementInfo: null,
    gameRandomness: null, opponentAztecAddress: null,
  }) };
});

vi.mock('../useGameSettlement', () => ({
  useGameSettlement: () => ({
    settleTxStatus: 'idle', settleTxHash: null, opponentSettled: false,
    takenCardId: null, isClaimingAbandoned: false, abandonedDisputeCountdown: null,
    handleAbandonedGame: hoisted.handleAbandonedGameMock,
    handleSettle: vi.fn(), resetForMenu: vi.fn(),
  }),
}));

const nowS = () => Math.floor(Date.now() / 1000);

const SAVED = {
  gameId: 'g1', playerNumber: 1 as const, selectedCardIds: [1, 2, 3, 4, 5],
  onChainGameId: '0xSTUCK',
};

describe('cards stranded in an unfinished game', () => {
  let useGame: typeof import('../useGame').useGame;

  beforeEach(async () => {
    vi.clearAllMocks();
    hoisted.loadGameMock.mockReturnValue(SAVED);
    hoisted.readInfoMock.mockResolvedValue({
      status: 2, activeAt: nowS() - 5400, claimAt: 0, claimPlayer: '0x0',
    });
    ({ useGame } = await import('../useGame'));
  });

  it('tells the player when a game is still holding their cards', async () => {
    const { result } = renderHook(() => useGame('ws://test'));
    await waitFor(() => expect(result.current.stuckGame)
      .toEqual({ onChainGameId: '0xSTUCK', kind: 'claimable' }));
  });

  it('does not offer to claim a game that is merely unsettled', async () => {
    // Nine moves means the game FINISHED. claim_abandoned_game asserts n <= 8
    // and settle_game binds the caller to the winner, so there is no action
    // here that would succeed — and a button that spends a proof and a
    // transaction to fail is the mistake the bot's sweep already made.
    hoisted.loadGameMock.mockReturnValue({
      ...SAVED, collectedMoveProofs: Array(9).fill({ proof: 'p', publicInputs: [] }),
    });
    hoisted.readInfoMock.mockResolvedValue({
      status: 2, activeAt: nowS() - 5400, claimAt: 0, claimPlayer: '0x0',
    });
    const { result } = renderHook(() => useGame('ws://test'));
    await waitFor(() => expect(result.current.stuckGame?.kind).toBe('awaiting-winner'));

    await act(async () => { await result.current.handleRecoverStuckGame(); });
    expect(hoisted.handleAbandonedGameMock, 'must not attempt a claim that cannot pass')
      .not.toHaveBeenCalled();
  });

  it('says nothing about a game that already settled', async () => {
    hoisted.readInfoMock.mockResolvedValue({
      status: 3, activeAt: nowS() - 5400, claimAt: 0, claimPlayer: '0x0',
    });   // 3 = SETTLED
    const { result } = renderHook(() => useGame('ws://test'));
    await waitFor(() => expect(hoisted.readInfoMock).toHaveBeenCalled());
    expect(result.current.stuckGame).toBeNull();
  });

  it('says nothing when there is no saved game at all', async () => {
    hoisted.loadGameMock.mockReturnValue(null);
    const { result } = renderHook(() => useGame('ws://test'));
    await waitFor(() => expect(result.current.stuckGame).toBeNull());
    expect(hoisted.readInfoMock).not.toHaveBeenCalled();
  });

  it('does not invent a stuck game when the chain read fails', async () => {
    hoisted.readInfoMock.mockRejectedValue(new Error('node unreachable'));
    const { result } = renderHook(() => useGame('ws://test'));
    await waitFor(() => expect(hoisted.readInfoMock).toHaveBeenCalled());
    expect(result.current.stuckGame).toBeNull();
  });

  it('shows the wait instead of a button the contract would reject', async () => {
    // The contract will not accept a claim inside MIN_ABANDON_SECONDS, so
    // offering one would revert. Saying how long is honest; a dead button is
    // the mistake this codebase has made three times.
    hoisted.readInfoMock.mockResolvedValue({
      status: 2, activeAt: nowS() - 600, claimAt: 0, claimPlayer: '0x0',
    });
    const { result } = renderHook(() => useGame('ws://test'));
    await waitFor(() => expect(result.current.stuckGame?.kind).toBe('too-soon'));
    expect(result.current.stuckGame?.waitSeconds).toBeGreaterThan(0);

    await act(async () => { await result.current.handleRecoverStuckGame(); });
    expect(hoisted.handleAbandonedGameMock).not.toHaveBeenCalled();
  });

  it('offers a contest while the opponent\'s claim is still open', async () => {
    hoisted.readInfoMock.mockResolvedValue({
      status: 5, activeAt: nowS() - 7200, claimAt: nowS() - 60, claimPlayer: '0xOPPONENT',
    });
    const { result } = renderHook(() => useGame('ws://test'));
    await waitFor(() => expect(result.current.stuckGame?.kind).toBe('contestable'));

    await act(async () => { await result.current.handleContestClaim(); });
    expect(hoisted.contestMock).toHaveBeenCalledWith('0xACCOUNT', '0xSTUCK');
  });

  it('does not offer a contest once the window has closed', async () => {
    hoisted.readInfoMock.mockResolvedValue({
      status: 5, activeAt: nowS() - 7200, claimAt: nowS() - 3600, claimPlayer: '0xOPPONENT',
    });
    const { result } = renderHook(() => useGame('ws://test'));
    await waitFor(() => expect(result.current.stuckGame?.kind).toBe('claimed-by-opponent'));
    await act(async () => { await result.current.handleContestClaim(); });
    expect(hoisted.contestMock).not.toHaveBeenCalled();
  });

  it('does not offer to contest our OWN claim', async () => {
    hoisted.readInfoMock.mockResolvedValue({
      status: 5, activeAt: nowS() - 7200, claimAt: nowS() - 60, claimPlayer: '0xACCOUNT',
    });
    const { result } = renderHook(() => useGame('ws://test'));
    await waitFor(() => expect(result.current.stuckGame?.kind).toBe('claimed-by-opponent'));
  });

  it('restores the saved proofs before claiming — the claim needs them', async () => {
    const { result } = renderHook(() => useGame('ws://test'));
    await waitFor(() => expect(result.current.stuckGame).not.toBeNull());

    await act(async () => { await result.current.handleRecoverStuckGame(); });

    // Both hand proofs, the move proofs so far and our blinding factor all
    // live in the save; without restoring them the claim cannot be built.
    expect(hoisted.restorePlayMock).toHaveBeenCalledWith(SAVED);
    expect(hoisted.restoreSessionMock).toHaveBeenCalledWith(SAVED);
    expect(hoisted.handleAbandonedGameMock).toHaveBeenCalled();
  });
});
