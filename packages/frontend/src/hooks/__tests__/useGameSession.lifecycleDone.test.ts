/**
 * The create/join pipeline (docs/plan/PRIVATE_GAMES.md section 5.2), and the
 * rule that it never runs twice for one game.
 *
 *   Creator: key exchange done → create (nonce → preview → send, the record
 *            persisted BEFORE the send) → `created` on-chain → RECORD →
 *            joiner's RECORD authenticated by its `joined` nullifier → active.
 *   Joiner:  creator's RECORD → `created` on-chain → join → RECORD → active.
 *
 * A finished lifecycle ends in 'idle', which is also where the pipeline
 * starts; after an unwind the relay keeps updating the dead game, and
 * restarting there would commit a second hand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { GAME_NULLIFIER_COUNT, normalizeField, NULLIFIER_INDEX } from '../../aztec/privateGame';
import { record, secrets } from '../../aztec/__tests__/privateGameFixtures';

const h = vi.hoisted(() => ({
  createGameOnChain: vi.fn(),
  joinGameOnChain: vi.fn(),
  secretsOf: vi.fn(),
  waitForNullifier: vi.fn(),
  gameNullifiers: vi.fn(),
  removeCards: vi.fn(),
  updateOwnedCards: vi.fn(),
}));

vi.mock('../../aztec/AztecContext', () => ({
  useAztecContext: () => ({
    wallet: { fake: true },
    accountAddress: '0xME',
    nodeClient: { node: true },
    updateOwnedCards: h.updateOwnedCards,
  }),
}));
vi.mock('../../aztec/pxe', () => ({ warmupPxe: vi.fn(), pxe: { gameNullifiers: h.gameNullifiers } }));
vi.mock('../../aztec/cardStore', () => ({ removeCards: h.removeCards }));
vi.mock('../../aztec/config', () => ({
  AZTEC_CONFIG: { enabled: true, gameContractAddress: '0xGAME', nftContractAddress: '0xNFT' },
}));
vi.mock('../../aztec/gameActions', () => ({
  createGameOnChain: h.createGameOnChain,
  joinGameOnChain: h.joinGameOnChain,
  secretsOf: h.secretsOf,
}));
vi.mock('../../aztec/gameChain', () => ({ waitForNullifier: h.waitForNullifier }));

import { useGameSession } from '../useGameSession';
import type { PeerPayload } from '../../aztec/peerChannel';

const KEY = normalizeField(0x6a3en);
const HAND = [1, 2, 3, 4, 5];
const NULLIFIERS = Array.from({ length: GAME_NULLIFIER_COUNT }, (_, i) => normalizeField(BigInt(0x700 + i)));
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });

function makeChannel(gameKey: string | null, roomId: string | null = 'room-1') {
  const listeners = new Set<(p: PeerPayload, room: string) => void>();
  const addPeerListener = vi.fn((cb: (p: PeerPayload, room: string) => void) => { listeners.add(cb); return () => listeners.delete(cb); });
  const base = { getGameKey: () => gameKey, sendPeer: vi.fn(async () => {}), addPeerListener };
  return {
    channel: { ...base, gameKey, roomId },
    with: (key: string | null, room: string | null = roomId) => ({ ...base, gameKey: key, roomId: room }),
    deliver: (p: PeerPayload, room = 'room-1') => listeners.forEach(cb => cb(p, room)),
  };
}

function makeWs(over: Record<string, unknown> = {}) {
  return {
    gameId: 'room-1',
    playerNumber: 1,
    connected: true,
    roomState: null,
    notifyTxConfirmed: vi.fn(),
    ...over,
  } as never;
}

const storage = { mergeGame: vi.fn(), readGame: vi.fn(() => null) };

beforeEach(() => {
  vi.clearAllMocks();
  h.gameNullifiers.mockResolvedValue(NULLIFIERS);
  h.waitForNullifier.mockResolvedValue({ blockNumber: 5 });
  h.secretsOf.mockResolvedValue(secrets(1));
});

describe('creator pipeline', () => {
  it('a creator who leaves while the create is on its way tells nobody: no RECORD, no TX_CONFIRMED', async () => {
    let land!: () => void;
    h.createGameOnChain.mockImplementation(async (_ctx: unknown, opts: any) => {
      expect(opts.shouldSend(), 'still here at the send').toBe(true);
      opts.onPrepared({ nonce: '0x28', record: record(1) });
      await new Promise<void>(r => { land = r; });
      return { nonce: '0x28', record: record(1), secrets: secrets(1), nullifiers: NULLIFIERS, txHash: '0xC' };
    });
    const ch = makeChannel(KEY);
    const ws = makeWs();
    const { result } = renderHook(() => useGameSession({ ws, screen: 'game', cardIds: HAND, channel: ch.channel, storage }));
    await flush();
    expect(result.current.getPhase()).toBe('creating');

    // Leave (useGame.handleBackToMenu), then the create lands.
    act(() => { result.current.forceIdle(); });
    land();
    await flush();

    expect(ch.channel.sendPeer).not.toHaveBeenCalled();
    expect((ws as any).notifyTxConfirmed).not.toHaveBeenCalled();
    expect(result.current.getPhase(), 'the next game starts from idle').toBe('idle');
    // The committed cards are out of the collection until the menu's cancel returns them.
    expect(h.removeCards).toHaveBeenCalledWith('0xME', HAND);
  });

  it('a creator who left during the preview has nothing sent: the send asks first', async () => {
    let shouldSend: (() => boolean) | undefined;
    h.createGameOnChain.mockImplementation(async (_ctx: unknown, opts: any) => {
      shouldSend = opts.shouldSend;
      return new Promise(() => {});
    });
    const ch = makeChannel(KEY);
    const { result } = renderHook(() => useGameSession({ ws: makeWs(), screen: 'game', cardIds: HAND, channel: ch.channel, storage }));
    await flush();
    expect(shouldSend!()).toBe(true);
    act(() => { result.current.forceIdle(); });
    expect(shouldSend!()).toBe(false);
  });

  it('creates once the key exchange is done, persists the record before the send, then announces it', async () => {
    h.createGameOnChain.mockImplementation(async (_ctx: unknown, opts: any) => {
      opts.onPrepared({ nonce: '0x28', record: record(1) });
      return { nonce: '0x28', record: record(1), secrets: secrets(1), nullifiers: NULLIFIERS, txHash: '0xC' };
    });
    const ch = makeChannel(null);
    const ws = makeWs();
    const { result, rerender } = renderHook(
      ({ channel }) => useGameSession({ ws, screen: 'game', cardIds: HAND, channel, storage }),
      { initialProps: { channel: ch.channel } },
    );
    expect(h.createGameOnChain, 'no game key yet: nothing to create').not.toHaveBeenCalled();

    rerender({ channel: ch.with(KEY) });
    await flush();

    expect(h.createGameOnChain).toHaveBeenCalledTimes(1);
    expect(h.createGameOnChain.mock.calls[0][1]).toMatchObject({ roomId: 'room-1', gameKey: KEY, hand: HAND });
    expect(storage.mergeGame).toHaveBeenCalledWith('room-1', expect.objectContaining({
      playerNumber: 1, selectedCardIds: HAND, gameKey: KEY, nonce: '0x28', record1: record(1),
    }));
    // Announced only once `created` is visible on the node.
    expect(h.waitForNullifier.mock.calls[0][1]).toBe(NULLIFIERS[NULLIFIER_INDEX.created]);
    expect(ch.channel.sendPeer).toHaveBeenCalledWith({ kind: 'RECORD', record: record(1) });
    expect((ws as any).notifyTxConfirmed).toHaveBeenCalledWith('room-1', 'create_game');
    expect(h.removeCards).toHaveBeenCalledWith('0xME', HAND);
    expect(result.current.getPhase()).toBe('awaiting_join');
    expect(result.current.onChainGameId).toBe(NULLIFIERS[NULLIFIER_INDEX.created]);
    expect(result.current.blindingFactor).toBe(secrets(1).blinding);
    expect(result.current.commits).toBeNull();

    // The joiner's record: accepted once its `joined` nullifier is on-chain.
    await act(async () => { ch.deliver({ kind: 'RECORD', record: record(2) }); });
    await flush();

    expect(h.gameNullifiers).toHaveBeenCalledWith('0xME', KEY, record(1), record(2));
    expect(h.waitForNullifier.mock.calls[1][1]).toBe(NULLIFIERS[NULLIFIER_INDEX.joined]);
    expect(result.current.getPhase()).toBe('active');
    expect(result.current.commitStatus).toBe('ready');
    expect(result.current.commits).toEqual({ commit1: record(1)[1], commit2: record(2)[1], roomId: 'room-1' });
    expect(result.current.getGame()).toEqual({
      roomId: 'room-1', role: 1, hand: HAND, gameKey: KEY, nonce: '0x28', record1: record(1), record2: record(2),
      // Nobody has sent open cards yet: a claim now would take nothing.
      opponentOpen: null, ownOpen: null,
    });
  });

  it('a joiner record whose `joined` never appears is refused', async () => {
    h.createGameOnChain.mockImplementation(async (_c: unknown, opts: any) => {
      opts.onPrepared({ nonce: '0x28', record: record(1) });
      return { nonce: '0x28', record: record(1), secrets: secrets(1), nullifiers: NULLIFIERS, txHash: '0xC' };
    });
    const ch = makeChannel(KEY);
    const { result } = renderHook(() => useGameSession({ ws: makeWs(), screen: 'game', cardIds: HAND, channel: ch.channel, storage }));
    await flush();

    h.waitForNullifier.mockRejectedValueOnce(new Error('the joiner\'s commit: not on-chain after 300s'));
    await act(async () => { ch.deliver({ kind: 'RECORD', record: record(7) }); });
    await flush();

    expect(result.current.getPhase()).toBe('awaiting_join');
    expect(result.current.onChainError).toMatch(/not on-chain/);
    expect(result.current.commits).toBeNull();
  });

  it('never sends a second commit once one went out, even if the first failed', async () => {
    h.createGameOnChain.mockImplementation(async (_c: unknown, opts: any) => {
      opts.onPrepared({ nonce: '0x28', record: record(1) });
      throw new Error('tx timed out');
    });
    const ch = makeChannel(KEY);
    const { rerender, result } = renderHook(
      ({ ws }) => useGameSession({ ws, screen: 'game', cardIds: HAND, channel: ch.channel, storage }),
      { initialProps: { ws: makeWs() } },
    );
    await flush();
    rerender({ ws: makeWs({ roomState: { gameId: 'room-1', playerNumber: 1, movesMade: 9, opponentConnected: true } }) });
    await flush();

    expect(h.createGameOnChain).toHaveBeenCalledTimes(1);
    expect(result.current.commitStatus).toBe('error');
  });
});

describe('joiner pipeline', () => {
  it('joins once the creator\'s record is here and its `created` nullifier is mined', async () => {
    h.joinGameOnChain.mockImplementation(async (_c: unknown, opts: any) => {
      opts.onPrepared({ nonce: '0x30', record: record(2) });
      return { nonce: '0x30', record: record(2), secrets: secrets(2), nullifiers: NULLIFIERS, txHash: '0xJ' };
    });
    const ch = makeChannel(KEY);
    const ws = makeWs({ playerNumber: 2 });
    const { result } = renderHook(() => useGameSession({ ws, screen: 'game', cardIds: HAND, channel: ch.channel, storage }));
    await flush();
    expect(h.joinGameOnChain, 'nothing to join before the creator\'s record').not.toHaveBeenCalled();

    await act(async () => { ch.deliver({ kind: 'RECORD', record: record(1) }); });
    await flush();

    expect(h.gameNullifiers).toHaveBeenCalledWith('0xME', KEY, record(1), null);
    expect(h.waitForNullifier.mock.calls[0][1]).toBe(NULLIFIERS[NULLIFIER_INDEX.created]);
    expect(h.joinGameOnChain.mock.calls[0][1]).toMatchObject({ roomId: 'room-1', gameKey: KEY, hand: HAND, record1: record(1) });
    expect(storage.mergeGame).toHaveBeenCalledWith('room-1', expect.objectContaining({
      playerNumber: 2, nonce: '0x30', record1: record(1), record2: record(2),
    }));
    expect(ch.channel.sendPeer).toHaveBeenCalledWith({ kind: 'RECORD', record: record(2) });
    expect((ws as any).notifyTxConfirmed).toHaveBeenCalledWith('room-1', 'join_game');
    expect(result.current.getPhase()).toBe('active');
    expect(result.current.commits).toEqual({ commit1: record(1)[1], commit2: record(2)[1], roomId: 'room-1' });
  });

  it('stops when the creator cancels before the join', async () => {
    let releaseCreated!: () => void;
    h.waitForNullifier.mockImplementation((_n: unknown, _x: string, _l: string, o: { check?: () => void }) =>
      new Promise((resolve, reject) => { releaseCreated = () => { try { o.check?.(); resolve({ blockNumber: 1 }); } catch (e) { reject(e); } }; }));
    const ch = makeChannel(KEY);
    const { result } = renderHook(() => useGameSession({ ws: makeWs({ playerNumber: 2 }), screen: 'game', cardIds: HAND, channel: ch.channel, storage }));
    await act(async () => { ch.deliver({ kind: 'RECORD', record: record(1) }); });
    await flush();
    expect(result.current.getPhase()).toBe('awaiting_create');

    await act(async () => { ch.deliver({ kind: 'CANCELLED' }); });
    await act(async () => { releaseCreated(); });
    await flush();

    expect(h.joinGameOnChain).not.toHaveBeenCalled();
    expect(result.current.getPhase()).toBe('idle');
    expect(result.current.onChainError).toMatch(/cancelled/);
  });
});

describe('the on-chain pipeline and a finished game', () => {
  beforeEach(() => {
    // Never settles: the pipeline stays in 'creating' until the test moves it.
    h.createGameOnChain.mockImplementation(() => new Promise(() => {}));
  });

  it('does not restart on a game marked complete, however often the relay updates it', () => {
    const ch = makeChannel(KEY);
    const { result, rerender } = renderHook(
      ({ socket }) => useGameSession({ ws: socket, screen: 'game', cardIds: HAND, channel: ch.channel, storage }),
      { initialProps: { socket: makeWs() } },
    );
    expect(h.createGameOnChain, 'the pipeline starts for a live game').toHaveBeenCalledTimes(1);

    act(() => {
      result.current.markLifecycleComplete();
      result.current.transitionPhase('idle');
    });

    // The relay keeps updating the dead room (a resume's ROOM_STATE, a reconnect).
    rerender({ socket: makeWs({ roomState: { gameId: 'room-1', playerNumber: 1, movesMade: 9, opponentConnected: true } }) });
    rerender({ socket: makeWs({ connected: false }) });
    rerender({ socket: makeWs() });

    expect(h.createGameOnChain, 'restarted on a finished game').toHaveBeenCalledTimes(1);
    expect(result.current.getPhase()).toBe('idle');
  });

  it('still starts the pipeline for the next game', () => {
    const ch = makeChannel(KEY);
    const { result, rerender } = renderHook(
      ({ socket, channel }) => useGameSession({ ws: socket, screen: 'game', cardIds: HAND, channel, storage }),
      { initialProps: { socket: makeWs(), channel: ch.channel } },
    );
    act(() => {
      result.current.markLifecycleComplete();
      result.current.transitionPhase('idle');
    });

    rerender({ socket: makeWs({ gameId: 'room-2' }), channel: ch.with(normalizeField(0x77n), 'room-2') });

    expect(h.createGameOnChain, 'a new game must still get its on-chain setup').toHaveBeenCalledTimes(2);
    expect(h.createGameOnChain.mock.calls[1][1]).toMatchObject({ roomId: 'room-2' });
  });

  it('never uses a game key from another room', () => {
    const ch = makeChannel(KEY, 'room-old');
    renderHook(() => useGameSession({ ws: makeWs(), screen: 'game', cardIds: HAND, channel: ch.channel, storage }));
    expect(h.createGameOnChain).not.toHaveBeenCalled();
  });
});
