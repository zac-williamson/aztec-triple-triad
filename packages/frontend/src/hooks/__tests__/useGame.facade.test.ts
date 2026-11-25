/**
 * useGame's own logic, with its sub-hooks stubbed and real localStorage:
 *
 *   - the menu surfaces a game that still holds cards, and runs the recovery
 *     the player picks with that game's stored records;
 *   - leaving a game keeps its record whenever cards are at stake — it is the
 *     only way back to them — and is allowed once nothing of ours is in flight;
 *   - the chain view gets each side's hand commitment the right way round.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { normalizeField } from '../../aztec/privateGame';
import { P1_HAND, record } from '../../aztec/__tests__/privateGameFixtures';

const h = vi.hoisted(() => ({
  ws: {} as Record<string, any>,
  session: {} as Record<string, any>,
  play: {} as Record<string, any>,
  settlement: {} as Record<string, any>,
  channel: {} as Record<string, any>,
  inspectStuckGame: vi.fn(),
  recoverStuckGame: vi.fn(),
  contestClaim: vi.fn(),
  updateOwnedCards: vi.fn(),
  refreshOwnedCards: vi.fn(),
  refreshTokenBalance: vi.fn(),
}));

vi.mock('../useWebSocket', () => ({ useWebSocket: () => h.ws }));
vi.mock('../useGameChannel', () => ({ useGameChannel: () => h.channel }));
vi.mock('../useGameSession', async (orig) => {
  const actual = await orig<typeof import('../useGameSession')>();
  return { ...actual, useGameSession: () => h.session };
});
vi.mock('../useGamePlay', async (orig) => {
  const actual = await orig<typeof import('../useGamePlay')>();
  return { ...actual, useGamePlay: () => h.play };
});
vi.mock('../useGameSettlement', () => ({ useGameSettlement: () => h.settlement }));
vi.mock('../stuckGameCheck', () => ({ inspectStuckGame: h.inspectStuckGame, recoverStuckGame: h.recoverStuckGame }));
vi.mock('../../aztec/gameActions', () => ({ contestClaim: h.contestClaim }));
vi.mock('../../aztec/config', () => ({ AZTEC_CONFIG: { gameContractAddress: '0xGAME', enabled: true } }));
vi.mock('../../aztec/AztecContext', () => ({
  useAztecContext: () => ({
    wallet: {}, accountAddress: '0xME', nodeClient: { node: true }, isAvailable: true, ownedCardIds: [],
    updateOwnedCards: h.updateOwnedCards, refreshOwnedCards: h.refreshOwnedCards, refreshTokenBalance: h.refreshTokenBalance,
  }),
}));

import { useGame } from '../useGame';
import { useGameStorage } from '../useGameStorage';

const KEY = normalizeField(0x6a3en);
let phase = 'idle';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  phase = 'idle';
  Object.assign(h.ws, {
    connected: true, gameId: null, playerNumber: null, gameState: null, gameOver: null, lastMoveProof: null,
    matchmakingStatus: 'idle', opponentDisconnected: false, abandonmentWarning: null,
    leaveGame: vi.fn(), queueMatchmaking: vi.fn(), cancelMatchmaking: vi.fn(), ping: vi.fn(),
    notifyAbandonedGameSettled: vi.fn(),
  });
  Object.assign(h.channel, { resetForMenu: vi.fn(), restoreFromSave: vi.fn(), sendPeerFor: vi.fn() });
  Object.assign(h.session, {
    onChainGameId: null, onChainError: null, commitStatus: 'idle', commits: null, blindingFactor: null,
    getPhase: () => phase, forceIdle: vi.fn(() => { phase = 'idle'; }), restoreFromSave: vi.fn(), resetForMenu: vi.fn(),
  });
  Object.assign(h.play, {
    collectedMoveProofs: [], owedMoveProofs: 0, moveProofStatus: 'idle', canSettle: false,
    handlePlaceCard: vi.fn(), restoreFromSave: vi.fn(), resetForMenu: vi.fn(),
  });
  Object.assign(h.settlement, {
    settleTxStatus: 'idle', settleTxHash: null, opponentSettled: false, takenCardId: null,
    isClaimingAbandoned: false, abandonBarCountdown: null, abandonedDisputeCountdown: null,
    handleSettle: vi.fn(), handleAbandonedGame: vi.fn(), cancelAbandonedUi: vi.fn(), resetForMenu: vi.fn(),
  });
  h.inspectStuckGame.mockResolvedValue(null);
});

function storeStakedGame(id = 'room-1') {
  const { result } = renderHook(() => useGameStorage());
  result.current.saveGame({
    gameId: id, playerNumber: 1, selectedCardIds: P1_HAND, savedAt: Date.now(),
    gameKey: KEY, nonce: '0x28', record1: record(1), record2: record(2),
  });
  return result.current;
}

describe('the menu and a game that still holds cards', () => {
  it('surfaces it, and imports what already resolved into the collection', async () => {
    h.inspectStuckGame.mockImplementation(async (_s: unknown, _ctx: unknown, hooks: any) => {
      hooks.onImported({ importedCardIds: [7, 8], prizeUncertain: false });
      return { roomId: 'room-1', kind: 'claimable' };
    });
    const { result } = renderHook(() => useGame('ws://test'));

    await waitFor(() => expect(result.current.stuckGame).toEqual({ roomId: 'room-1', kind: 'claimable' }));
    expect(h.inspectStuckGame.mock.calls[0][1]).toEqual({ owner: '0xME', node: { node: true } });
    expect(h.updateOwnedCards).toHaveBeenCalled();
    expect(h.refreshTokenBalance).toHaveBeenCalled();
  });

  it('recovers with the stored game, then forgets it', async () => {
    const storage = storeStakedGame();
    h.inspectStuckGame.mockResolvedValueOnce({ roomId: 'room-1', kind: 'finalizable', claim: { claimNo: 1, claimSide: 2, claimBlock: 40 } });
    h.recoverStuckGame.mockResolvedValue({ importedCardIds: P1_HAND, prizeUncertain: false });
    const { result } = renderHook(() => useGame('ws://test'));
    await waitFor(() => expect(result.current.stuckGame?.kind).toBe('finalizable'));

    await act(async () => { await result.current.handleRecoverStuckGame(); });

    const [stuck, , game, ctx, deps] = h.recoverStuckGame.mock.calls[0];
    expect(stuck.kind).toBe('finalizable');
    expect(game).toMatchObject({ roomId: 'room-1', role: 1, gameKey: KEY, record1: record(1), record2: record(2) });
    expect(ctx).toEqual({ owner: '0xME', node: { node: true } });
    expect(deps.onUnwound).toBe(h.ws.notifyAbandonedGameSettled);
    expect(storage.readGame('room-1')).toBeNull();
    expect(result.current.stuckGame).toBeNull();
  });

  it('contests the standing claim with the stored records', async () => {
    storeStakedGame();
    const claim = { claimNo: 1, claimSide: 2, claimBlock: 40 };
    h.inspectStuckGame.mockResolvedValueOnce({ roomId: 'room-1', kind: 'contestable', claim, waitSeconds: 100 });
    const { result } = renderHook(() => useGame('ws://test'));
    await waitFor(() => expect(result.current.stuckGame?.kind).toBe('contestable'));

    await act(async () => { await result.current.handleContestClaim(); });

    expect(h.contestClaim).toHaveBeenCalledWith(expect.objectContaining({ roomId: 'room-1', role: 1 }), expect.anything(), claim);
  });

  it('a read failure leaves whatever we last knew', async () => {
    h.inspectStuckGame.mockRejectedValue(new Error('node down'));
    const { result } = renderHook(() => useGame('ws://test'));
    await new Promise(r => setTimeout(r, 10));
    expect(result.current.stuckGame).toBeNull();
  });
});

describe('leaving a game', () => {
  function inGame(over: Record<string, unknown> = {}) {
    Object.assign(h.ws, { gameId: 'room-1', playerNumber: 1, gameState: { status: 'playing' }, ...over });
  }

  it('is blocked mid-game, while a commit or the game itself is in flight', () => {
    inGame();
    phase = 'active';
    const { result } = renderHook(() => useGame('ws://test'));
    act(() => { result.current.setScreen('game'); });
    expect(result.current.canGoBack).toBe(false);
    act(() => { result.current.handleBackToMenu(); });
    expect(result.current.screen).toBe('game');
    expect(h.ws.leaveGame).not.toHaveBeenCalled();
  });

  it('is allowed once the game is over and no move proof is owed — and keeps the record', () => {
    const storage = storeStakedGame();
    inGame({ gameOver: { winner: 'player2' } });
    phase = 'active';
    const { result } = renderHook(() => useGame('ws://test'));
    act(() => { result.current.setScreen('game'); });
    expect(result.current.canGoBack).toBe(true);

    act(() => { result.current.handleBackToMenu(); });

    expect(result.current.screen).toBe('main-menu');
    expect(h.ws.leaveGame).toHaveBeenCalled();
    expect(h.session.forceIdle).toHaveBeenCalled();
    expect(storage.readGame('room-1')?.record1).toEqual(record(1));
    expect(storage.loadClaimable()?.gameId).toBe('room-1');
  });

  it('is blocked while we still owe the opponent a move proof', () => {
    inGame({ gameOver: { winner: 'player1' } });
    phase = 'active';
    h.play.owedMoveProofs = 1;
    const { result } = renderHook(() => useGame('ws://test'));
    act(() => { result.current.setScreen('game'); });
    expect(result.current.canGoBack).toBe(false);
  });

  it('a creator waiting for a joiner may leave (the menu then offers the cancel)', () => {
    inGame();
    phase = 'awaiting_join';
    const { result } = renderHook(() => useGame('ws://test'));
    act(() => { result.current.setScreen('game'); });
    expect(result.current.canGoBack).toBe(true);
  });
});

describe('the chain view', () => {
  it('maps the records\' commitments to "mine" and "theirs" by role', () => {
    h.session.commits = { commit1: '0xC1', commit2: '0xC2' };
    Object.assign(h.ws, { gameId: 'room-1', playerNumber: 2 });
    const { result } = renderHook(() => useGame('ws://test'));
    expect(result.current.myHandCommit).toBe('0xC2');
    expect(result.current.opponentHandCommit).toBe('0xC1');
  });
});
