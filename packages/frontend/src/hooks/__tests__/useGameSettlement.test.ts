/**
 * Settlement and abandonment in the live game (docs/plan/PRIVATE_GAMES.md 5.4):
 *
 *   - the winner sends SETTLING, settle_game, then SETTLED {txHash}, then
 *     imports their own notes; a draw is settled by player 1 alone;
 *   - the other player imports their own notes from that tx — told by SETTLED,
 *     or finding it from `done` when nobody tells them;
 *   - abandonment: claim (once the bar has passed) → dispute window →
 *     finalize → import; stands down if the opponent comes back.
 *
 * The chain actions are mocked; the transcript, the prize mapping and the
 * announcement reading are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { P1_HAND, P2_HAND, record, transcript } from '../../aztec/__tests__/privateGameFixtures';
import { normalizeField } from '../../aztec/privateGame';

const h = vi.hoisted(() => ({
  settleGame: vi.fn(),
  importResolution: vi.fn(),
  importDiscoveredResolution: vi.fn(),
  discoverResolution: vi.fn(),
  claimAbandonment: vi.fn(),
  finalizeAbandonment: vi.fn(),
  contestClaim: vi.fn(),
  readGameState: vi.fn(),
  updateOwnedCards: vi.fn(),
  refreshOwnedCards: vi.fn(),
  refreshTokenBalance: vi.fn(),
}));

vi.mock('../../aztec/AztecContext', () => ({
  useAztecContext: () => ({
    wallet: { fake: true },
    accountAddress: '0xME',
    nodeClient: { node: true },
    updateOwnedCards: h.updateOwnedCards,
    refreshOwnedCards: h.refreshOwnedCards,
    refreshTokenBalance: h.refreshTokenBalance,
  }),
}));
vi.mock('../../aztec/gameActions', async (orig) => {
  const actual = await orig<typeof import('../../aztec/gameActions')>();
  return {
    ...actual,
    settleGame: h.settleGame,
    importResolution: h.importResolution,
    importDiscoveredResolution: h.importDiscoveredResolution,
    discoverResolution: h.discoverResolution,
    claimAbandonment: h.claimAbandonment,
    finalizeAbandonment: h.finalizeAbandonment,
    contestClaim: h.contestClaim,
    readGameState: h.readGameState,
  };
});

import { CLAIM_WATCH_MS, useGameSettlement } from '../useGameSettlement';
import { abandonmentPosition } from '../../aztec/privateGame';
import { chainState } from '../../aztec/__tests__/privateGameFixtures';
import { ClaimContestedError, OpponentResumedError, type PrivateGame } from '../../aztec/gameActions';
import type { OnChainPhase } from '../useGameSession';
import type { PeerPayload } from '../../aztec/peerChannel';

const KEY = normalizeField(0x6a3en);
const TX = '0x' + 'ab'.repeat(32);
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

function setup(opts: { role?: 1 | 2; winner?: 1 | 2 | 3; phase?: OnChainPhase; gameOver?: { winner: 'player1' | 'player2' | 'draw' } | null } = {}) {
  const role = opts.role ?? 1;
  const game: PrivateGame = {
    roomId: 'room-1', role, hand: role === 1 ? P1_HAND : P2_HAND, gameKey: KEY, nonce: '0x28',
    record1: record(1), record2: record(2),
  };
  let phase: OnChainPhase = opts.phase ?? 'active';
  const session = {
    getPhase: () => phase,
    transitionPhase: vi.fn((to: OnChainPhase) => { phase = to; }),
    waitForActivePhase: vi.fn(async () => {}),
    getGame: () => game,
    markLifecycleComplete: vi.fn(),
  };
  const moveProofs = transcript({ winner: opts.winner ?? 1 });
  // The result comes from the client's own game (useGamePlay), not the relay.
  const play = {
    getMoveProofs: vi.fn(() => moveProofs), waitForMoveProofs: vi.fn(async () => {}), canSettle: true,
    gameOver: opts.gameOver ?? null,
  };
  const listeners = new Set<(p: PeerPayload, room: string) => void>();
  const channel = {
    sendPeer: vi.fn(async (_p: PeerPayload) => {}),
    addPeerListener: (cb: (p: PeerPayload, room: string) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  const storage = { mergeGame: vi.fn() };
  const ws = { gameId: 'room-1', playerNumber: role, opponentDisconnected: false };
  const hook = renderHook(
    ({ socket }) => useGameSettlement({ ws: socket as never, session, play, channel, storage }),
    { initialProps: { socket: ws } },
  );
  return {
    hook, game, session, play, channel, storage, ws, moveProofs,
    phase: () => phase,
    deliver: (p: PeerPayload) => listeners.forEach(cb => cb(p, 'room-1')),
  };
}

const importResult = (over: Record<string, unknown> = {}) => ({
  txHash: TX, resolution: { kind: 'settled', winner: 1 }, importedCardIds: [1, 2], rewardImported: true,
  takenCardId: null, prizeUncertain: false, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.settleGame.mockResolvedValue(TX);
  h.importResolution.mockResolvedValue(importResult());
  h.importDiscoveredResolution.mockResolvedValue(null);
  h.discoverResolution.mockResolvedValue(null);
});

describe('the winner settles', () => {
  it('announces SETTLING, settles, announces SETTLED, then imports its own notes', async () => {
    const t = setup({ role: 1, winner: 1 });
    const order: string[] = [];
    t.channel.sendPeer.mockImplementation(async (p: PeerPayload) => { order.push(p.kind); });
    h.settleGame.mockImplementation(async () => { order.push('settle_game'); return TX; });
    h.importResolution.mockImplementation(async () => { order.push('import'); return importResult({ importedCardIds: [11, 12, 13, 14, 15, 23] }); });

    await act(async () => { await t.hook.result.current.handleSettle(P2_HAND[2]); });

    expect(order).toEqual(['SETTLING', 'settle_game', 'SETTLED', 'import']);
    // P2_HAND[2] was placed at move 5 (player 2's third move).
    expect(t.channel.sendPeer).toHaveBeenNthCalledWith(1, { kind: 'SETTLING', prizeMove: 5 });
    expect(h.settleGame).toHaveBeenCalledWith(t.game, { owner: '0xME', node: { node: true } }, expect.objectContaining({
      moveProofs: t.moveProofs, prizeMove: 5,
    }));
    expect(t.channel.sendPeer).toHaveBeenNthCalledWith(2, { kind: 'SETTLED', txHash: TX });
    expect(h.importResolution).toHaveBeenCalledWith(t.game, expect.anything(), expect.objectContaining({
      txHash: TX, resolution: { kind: 'settled', winner: 1, prize: { cardId: P2_HAND[2], slot: 2 } },
    }));
    expect(t.storage.mergeGame).toHaveBeenCalledWith('room-1', { prizeMove: 5 });
    expect(h.updateOwnedCards).toHaveBeenCalled();
    expect(t.hook.result.current.settleTxStatus).toBe('confirmed');
    expect(t.hook.result.current.settleTxHash).toBe(TX);
    expect(t.session.markLifecycleComplete).toHaveBeenCalled();
    expect(t.phase()).toBe('idle');
  });

  it('refuses a prize the loser never placed, before anything is sent', async () => {
    const t = setup({ role: 1, winner: 1 });
    await act(async () => { await t.hook.result.current.handleSettle(P1_HAND[0]); });
    expect(h.settleGame).not.toHaveBeenCalled();
    expect(t.channel.sendPeer).not.toHaveBeenCalled();
    expect(t.hook.result.current.settleTxStatus).toBe('error');
    expect(t.hook.result.current.settleError).toMatch(/not placed by the loser/);
  });

  it('if another settlement won the race, imports from that one instead of failing', async () => {
    const t = setup({ role: 1, winner: 1 });
    h.settleGame.mockRejectedValue(new Error('Existing nullifier'));
    h.discoverResolution.mockResolvedValue({ txHash: TX, noteHashes: [], firstNullifier: '0x1' });
    h.importDiscoveredResolution.mockResolvedValue(importResult());

    await act(async () => { await t.hook.result.current.handleSettle(P2_HAND[0]); });

    expect(h.importDiscoveredResolution).toHaveBeenCalled();
    expect(t.hook.result.current.settleTxStatus).toBe('confirmed');
  });

  it('handleSettle keeps its identity across socket updates (callbacks read state late)', () => {
    const t = setup({ role: 1 });
    const first = t.hook.result.current.handleSettle;
    t.hook.rerender({ socket: { ...t.ws, gameId: 'room-1' } as never });
    t.hook.rerender({ socket: { ...t.ws, opponentDisconnected: true } as never });
    expect(t.hook.result.current.handleSettle).toBe(first);
  });
});

describe('a draw', () => {
  it('player 1 settles it alone, announcing no prize', async () => {
    const t = setup({ role: 1, winner: 3, gameOver: { winner: 'draw' } });
    await flush();
    expect(t.channel.sendPeer).toHaveBeenCalledWith({ kind: 'SETTLING', prizeMove: null });
    expect(h.settleGame.mock.calls[0][2]).toMatchObject({ prizeMove: 0 });
    expect(h.importResolution.mock.calls[0][2]).toMatchObject({ resolution: { kind: 'settled', winner: 'draw' } });
  });

  it('player 2 sends nothing and imports from player 1\'s settlement', async () => {
    const t = setup({ role: 2, winner: 3, gameOver: { winner: 'draw' } });
    await flush();
    expect(h.settleGame).not.toHaveBeenCalled();

    h.importResolution.mockResolvedValue(importResult({ resolution: { kind: 'settled', winner: 'draw' } }));
    await act(async () => { t.deliver({ kind: 'SETTLING', prizeMove: null }); });
    expect(t.hook.result.current.takenCardId).toBe(0);
    await act(async () => { t.deliver({ kind: 'SETTLED', txHash: TX }); });
    await flush();

    expect(h.importResolution.mock.calls[0][2]).toMatchObject({ txHash: TX, resolution: { kind: 'settled', winner: 'draw' } });
    expect(t.hook.result.current.opponentSettled).toBe(true);
    expect(t.hook.result.current.takenCardId).toBe(0);
  });
});

describe('the loser', () => {
  it('learns the taken card from SETTLING and imports its own notes on SETTLED', async () => {
    const t = setup({ role: 2, winner: 1, gameOver: { winner: 'player1' } });
    await act(async () => { t.deliver({ kind: 'SETTLING', prizeMove: 3 }); });

    expect(t.phase()).toBe('awaiting_settlement');
    expect(t.hook.result.current.takenCardId).toBe(P2_HAND[1]); // move 3 placed P2's slot 1
    expect(t.storage.mergeGame).toHaveBeenCalledWith('room-1', { prizeMove: 3 });

    h.importResolution.mockResolvedValue(importResult({ takenCardId: P2_HAND[1], importedCardIds: [21, 23, 24, 25] }));
    await act(async () => { t.deliver({ kind: 'SETTLED', txHash: TX }); });
    await flush();

    expect(h.importResolution).toHaveBeenCalledWith(t.game, expect.anything(), expect.objectContaining({
      txHash: TX,
      resolution: { kind: 'settled', winner: 1, prize: { cardId: P2_HAND[1], slot: 1 } },
    }));
    expect(h.updateOwnedCards).toHaveBeenCalled();
    expect(t.hook.result.current.opponentSettled).toBe(true);
    expect(t.hook.result.current.takenCardId).toBe(P2_HAND[1]);
    expect(t.session.markLifecycleComplete).toHaveBeenCalled();
    expect(t.phase()).toBe('idle');
  });

  it('imports once, however often SETTLED is replayed', async () => {
    const t = setup({ role: 2, winner: 1 });
    await act(async () => { t.deliver({ kind: 'SETTLED', txHash: TX }); });
    await flush();
    await act(async () => { t.deliver({ kind: 'SETTLED', txHash: TX }); });
    await flush();
    expect(h.importResolution).toHaveBeenCalledTimes(1);
  });

  it('finds the settlement on its own from `done` when nobody says SETTLED', async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ role: 2, winner: 1, gameOver: { winner: 'player1' } });
      h.importDiscoveredResolution
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(importResult({ takenCardId: P2_HAND[0] }));

      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
      expect(t.hook.result.current.opponentSettled).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

      expect(h.importDiscoveredResolution).toHaveBeenCalledTimes(2);
      expect(t.hook.result.current.opponentSettled).toBe(true);
      expect(t.hook.result.current.takenCardId).toBe(P2_HAND[0]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('abandonment (opponent idle)', () => {
  it('claims, waits out the window, finalizes and imports — the relay is told nothing', async () => {
    const t = setup({ role: 1 });
    h.claimAbandonment.mockResolvedValue({ claimNo: 1, claimSide: 1, claimBlock: 50 });
    h.finalizeAbandonment.mockImplementation(async (_g: unknown, _c: unknown, _claim: unknown, o: { onDisputeProgress: (s: number) => void }) => {
      o.onDisputeProgress(120);
      return importResult({ resolution: { kind: 'unwound' }, importedCardIds: P1_HAND });
    });

    await act(async () => { await t.hook.result.current.handleAbandonedGame(); });

    expect(h.claimAbandonment).toHaveBeenCalledWith(t.game, expect.anything(), expect.objectContaining({ shouldStop: expect.any(Function) }));
    expect(h.finalizeAbandonment).toHaveBeenCalledWith(t.game, expect.anything(), { claimNo: 1, claimSide: 1, claimBlock: 50 }, expect.anything());
    expect(h.updateOwnedCards).toHaveBeenCalled();
    expect(t.phase()).toBe('idle');
    expect(t.hook.result.current.isClaimingAbandoned).toBe(false);
  });

  it('stands down if the opponent moves while it waits — the game plays on', async () => {
    const t = setup({ role: 1 });
    h.claimAbandonment.mockRejectedValue(new OpponentResumedError());
    await act(async () => { await t.hook.result.current.handleAbandonedGame(); });
    expect(h.finalizeAbandonment).not.toHaveBeenCalled();
    expect(t.phase()).toBe('active');
  });

  it('a contested claim returns the game to play', async () => {
    const t = setup({ role: 1 });
    h.claimAbandonment.mockResolvedValue({ claimNo: 1, claimSide: 1, claimBlock: 50 });
    h.finalizeAbandonment.mockRejectedValue(new ClaimContestedError(1));
    await act(async () => { await t.hook.result.current.handleAbandonedGame(); });
    expect(t.phase()).toBe('active');
  });

  it('contests the other side\'s claim instead of filing its own', async () => {
    const t = setup({ role: 1 });
    h.claimAbandonment.mockResolvedValue({ claimNo: 1, claimSide: 2, claimBlock: 50 });
    await act(async () => { await t.hook.result.current.handleAbandonedGame(); });
    expect(h.contestClaim).toHaveBeenCalledWith(t.game, expect.anything(), { claimNo: 1, claimSide: 2, claimBlock: 50 });
    expect(h.finalizeAbandonment).not.toHaveBeenCalled();
  });

  it('is idempotent while a claim runs', async () => {
    const t = setup({ role: 1 });
    h.claimAbandonment.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      void t.hook.result.current.handleAbandonedGame();
      void t.hook.result.current.handleAbandonedGame();
    });
    expect(h.claimAbandonment).toHaveBeenCalledTimes(1);
  });

  it('fires automatically once when the opponent disconnects mid-game — not after game over', async () => {
    const t = setup({ role: 1 });
    h.claimAbandonment.mockRejectedValue(new Error('Too soon'));
    t.hook.rerender({ socket: { ...t.ws, opponentDisconnected: true } as never });
    await flush();
    t.hook.rerender({ socket: { ...t.ws, opponentDisconnected: true, gameId: 'room-1' } as never });
    await flush();
    expect(h.claimAbandonment).toHaveBeenCalledTimes(1);

    const over = setup({ role: 1, gameOver: { winner: 'player1' } });
    h.claimAbandonment.mockClear();
    over.hook.rerender({ socket: { ...over.ws, opponentDisconnected: true } as never });
    await flush();
    expect(h.claimAbandonment).not.toHaveBeenCalled();
  });
});

describe('a claim against a player who is here', () => {
  /** The game's state as readGameState returns it, from chain-state hits. */
  const stateWith = (hits: Parameters<typeof chainState>[0]) => {
    const state = chainState(hits);
    return { nullifiers: [], state, position: abandonmentPosition(state) };
  };
  const tick = async () => {
    await act(async () => { vi.advanceTimersByTime(CLAIM_WATCH_MS); });
    await flush();
  };

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('is contested as soon as it lands: walking away costs a card, and we did not walk away', async () => {
    const t = setup({ role: 1 });
    h.contestClaim.mockResolvedValue('0xCT');
    h.readGameState.mockResolvedValue(stateWith({ created: 3, seat2: 4, joined: 4, claimSlots: [40], claims: [[null, 40]] }));

    await tick();

    expect(h.contestClaim).toHaveBeenCalledTimes(1);
    expect(h.contestClaim).toHaveBeenCalledWith(t.game, expect.anything(), expect.objectContaining({ claimNo: 1, claimSide: 2, claimBlock: 40 }));
  });

  it('leaves our own claim alone, and stops once our one contest is spent', async () => {
    setup({ role: 1 });
    h.readGameState.mockResolvedValue(stateWith({ created: 3, seat2: 4, joined: 4, claimSlots: [40], claims: [[40, null]] }));
    await tick();
    expect(h.contestClaim).not.toHaveBeenCalled();

    // Their second claim, after we already contested their first: each side contests once.
    h.readGameState.mockResolvedValue(stateWith({
      created: 3, seat2: 4, joined: 4, claimSlots: [40, 90], claims: [[null, 40], [null, 90]],
      contests: [50], resolved: [50], contestedBy: [50, null],
    }));
    await tick();
    expect(h.contestClaim).not.toHaveBeenCalled();
  });

  it('only watches a live game', async () => {
    setup({ role: 1, phase: 'settling' });
    h.readGameState.mockResolvedValue(stateWith({ created: 3, seat2: 4, joined: 4, claimSlots: [40], claims: [[null, 40]] }));
    await tick();
    expect(h.readGameState).not.toHaveBeenCalled();
    expect(h.contestClaim).not.toHaveBeenCalled();
  });

  it('keeps watching after a failed read', async () => {
    setup({ role: 2 });
    h.contestClaim.mockResolvedValue('0xCT');
    h.readGameState.mockRejectedValueOnce(new Error('node unreachable'));
    await tick();
    h.readGameState.mockResolvedValue(stateWith({ created: 3, seat2: 4, joined: 4, claimSlots: [40], claims: [[40, null]] }));
    await tick();
    expect(h.contestClaim).toHaveBeenCalledTimes(1);
  });
});
