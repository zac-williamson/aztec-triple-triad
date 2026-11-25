/**
 * The menu's side of unfinished games: walk the stored games, import whatever
 * already resolved (a loser who closed the tab before SETTLED gets their cards
 * here), drop commits that never landed, and run the recovery the player picks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeField } from '../../aztec/privateGame';
import { chainState, linksOf, P1_HAND, P2_HAND, record, transcript } from '../../aztec/__tests__/privateGameFixtures';

const h = vi.hoisted(() => ({
  readGameState: vi.fn(),
  importDiscoveredResolution: vi.fn(),
  importResolution: vi.fn(),
  cancelGame: vi.fn(),
  settleGame: vi.fn(),
  claimAbandonment: vi.fn(),
  finalizeAbandonment: vi.fn(),
  blockTimestamp: vi.fn(),
  chainNowSeconds: vi.fn(),
}));

vi.mock('../../aztec/gameActions', async (orig) => {
  const actual = await orig<typeof import('../../aztec/gameActions')>();
  return {
    ...actual,
    readGameState: h.readGameState,
    importDiscoveredResolution: h.importDiscoveredResolution,
    importResolution: h.importResolution,
    cancelGame: h.cancelGame,
    settleGame: h.settleGame,
    claimAbandonment: h.claimAbandonment,
    finalizeAbandonment: h.finalizeAbandonment,
  };
});
vi.mock('../../aztec/gameChain', () => ({ blockTimestamp: h.blockTimestamp }));
vi.mock('../../aztec/settlementArgs', async (orig) => {
  const actual = await orig<typeof import('../../aztec/settlementArgs')>();
  return { ...actual, chainNowSeconds: h.chainNowSeconds };
});
vi.mock('../../aztec/config', () => ({ AZTEC_CONFIG: { gameContractAddress: '0xGAME' } }));

import { gatherStuckGameFacts, inspectStuckGame, recoverStuckGame } from '../stuckGameCheck';
import { abandonmentPosition } from '../../aztec/privateGame';
import { toPrivateGame, type PersistedGameState } from '../useGameStorage';

const KEY = normalizeField(0x6a3en);
const ctx = { owner: '0xME', node: { node: true } };
const TX = '0x' + 'ab'.repeat(32);

function saved(over: Partial<PersistedGameState> = {}): PersistedGameState {
  return {
    gameId: 'room-1', playerNumber: 1, selectedCardIds: P1_HAND, savedAt: Date.now(),
    gameKey: KEY, nonce: '0x28', record1: record(1), record2: record(2), ...over,
  };
}

function withState(state: ReturnType<typeof chainState>) {
  return { nullifiers: [], state, position: abandonmentPosition(state) };
}

function storageOf(games: PersistedGameState[]) {
  return { listClaimable: vi.fn(() => games), clearGame: vi.fn(), mergeGame: vi.fn() };
}

const result = (over: Record<string, unknown> = {}) => ({
  txHash: TX, resolution: { kind: 'unwound' }, importedCardIds: P1_HAND, rewardImported: false,
  takenCardId: null, prizeUncertain: false, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.chainNowSeconds.mockResolvedValue(10_000);
  h.blockTimestamp.mockResolvedValue(1_000);
});

describe('inspectStuckGame', () => {
  it('imports a game that resolved while we were away, drops its record, and looks at the next', async () => {
    const done = saved({ gameId: 'old', playerNumber: 2, selectedCardIds: P2_HAND, moves: linksOf(transcript({ winner: 1 })), prizeMove: 3 });
    const pending = saved({ gameId: 'new', record2: undefined });
    h.readGameState
      .mockResolvedValueOnce(withState(chainState({ created: 1, seat2: 2, joined: 2, done: 9 })))
      .mockResolvedValueOnce(withState(chainState({ created: 20 })));
    h.importDiscoveredResolution.mockResolvedValue(result({ takenCardId: P2_HAND[1] }));
    const storage = storageOf([done, pending]);
    const onImported = vi.fn();

    const stuck = await inspectStuckGame(storage, ctx, { onImported });

    // The stored announcement is the fallback if the tx itself cannot be read.
    expect(h.importDiscoveredResolution).toHaveBeenCalledWith(toPrivateGame(done), ctx, expect.objectContaining({
      moveProofs: transcript({ winner: 1 }),
      fallback: { kind: 'settled', winner: 1, prize: { cardId: P2_HAND[1], slot: 1 } },
    }));
    expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ takenCardId: P2_HAND[1] }));
    expect(storage.clearGame).toHaveBeenCalledWith('old');
    expect(stuck).toEqual({ roomId: 'new', kind: 'cancellable' });
  });

  it('leaves alone a game the live session is still settling', async () => {
    const storage = storageOf([saved()]);
    expect(await inspectStuckGame(storage, ctx, { skip: id => id === 'room-1' })).toBeNull();
    expect(h.readGameState).not.toHaveBeenCalled();
  });

  it('drops a commit that never landed once nothing sent for it can still land — not before', async () => {
    h.readGameState.mockResolvedValue(withState(chainState({})));
    const fresh = storageOf([saved({ commitSentAt: Date.now() - 60_000 })]);
    expect(await inspectStuckGame(fresh, ctx)).toBeNull();
    expect(fresh.clearGame).not.toHaveBeenCalled();

    const stale = storageOf([saved({ commitSentAt: Date.now() - 3 * 60 * 60_000 })]);
    expect(await inspectStuckGame(stale, ctx)).toBeNull();
    expect(stale.clearGame).toHaveBeenCalledWith('room-1');
  });

  it('offers a claim once the bar has passed since the join', async () => {
    h.readGameState.mockResolvedValue(withState(chainState({ created: 1, seat2: 2, joined: 2 })));
    h.blockTimestamp.mockResolvedValue(10_000 - 600);
    expect(await inspectStuckGame(storageOf([saved()]), ctx)).toEqual({ roomId: 'room-1', kind: 'claimable' });
    expect(h.blockTimestamp).toHaveBeenCalledWith(ctx.node, 2);
  });
});

describe('gatherStuckGameFacts', () => {
  it('knows who settles from the transcript, and reads no clocks for a finished game', async () => {
    h.readGameState.mockResolvedValue(withState(chainState({ created: 1, seat2: 2, joined: 2 })));
    const s = saved({ moves: linksOf(transcript({ winner: 1 })) });
    const f = await gatherStuckGameFacts(s, toPrivateGame(s)!, ctx);
    expect(f.transcriptComplete).toBe(true);
    expect(f.weSettle).toBe(true);
    expect(h.chainNowSeconds).not.toHaveBeenCalled();

    const draw = saved({ playerNumber: 2, selectedCardIds: P2_HAND, moves: linksOf(transcript({ winner: 3 })) });
    expect((await gatherStuckGameFacts(draw, toPrivateGame(draw)!, ctx)).weSettle).toBe(false);
  });
});

describe('recoverStuckGame', () => {
  it('cancels a game nobody joined and tells the would-be joiner', async () => {
    const s = saved({ record2: undefined });
    h.cancelGame.mockResolvedValue(result({ resolution: { kind: 'cancelled' } }));
    const sendPeerFor = vi.fn(async () => true);

    const r = await recoverStuckGame({ roomId: 'room-1', kind: 'cancellable' }, s, toPrivateGame(s)!, ctx, { storage: storageOf([]), sendPeerFor });

    expect(h.cancelGame).toHaveBeenCalledWith(toPrivateGame(s), ctx);
    expect(sendPeerFor).toHaveBeenCalledWith('room-1', { kind: 'CANCELLED' });
    expect(r!.resolution).toEqual({ kind: 'cancelled' });
  });

  it('settles a finished game with the default prize, announcing it like the live game does', async () => {
    const s = saved({ playerNumber: 2, selectedCardIds: P2_HAND, moves: linksOf(transcript({ winner: 1 })) });
    h.settleGame.mockResolvedValue(TX);
    h.importResolution.mockResolvedValue(result({ resolution: { kind: 'settled', winner: 1 } }));
    const sendPeerFor = vi.fn(async () => true);
    const storage = storageOf([]);

    await recoverStuckGame({ roomId: 'room-1', kind: 'settleable' }, s, toPrivateGame(s)!, ctx, { storage, sendPeerFor });

    const prizeMove = h.settleGame.mock.calls[0][2].prizeMove as number;
    expect(prizeMove % 2, 'the prize is a card player 2 (the loser) placed').toBe(1);
    expect(sendPeerFor).toHaveBeenCalledWith('room-1', { kind: 'SETTLING', prizeMove });
    expect(sendPeerFor).toHaveBeenCalledWith('room-1', { kind: 'SETTLED', txHash: TX });
    expect(storage.mergeGame).toHaveBeenCalledWith('room-1', { prizeMove });
    expect(h.importResolution.mock.calls[0][2]).toMatchObject({ txHash: TX, resolution: { kind: 'settled', winner: 1 } });
  });

  it('claims and finalizes an abandoned game', async () => {
    const s = saved();
    h.claimAbandonment.mockResolvedValue({ claimNo: 1, claimSide: 1, claimBlock: 40 });
    h.finalizeAbandonment.mockResolvedValue(result());

    const r = await recoverStuckGame({ roomId: 'room-1', kind: 'claimable' }, s, toPrivateGame(s)!, ctx, { storage: storageOf([]) });

    expect(h.finalizeAbandonment).toHaveBeenCalledWith(toPrivateGame(s), ctx, { claimNo: 1, claimSide: 1, claimBlock: 40 });
    expect(r!.importedCardIds).toEqual(P1_HAND);
  });

  it('finalizes a lapsed claim, importing whatever resolved it if somebody beat us to it', async () => {
    const s = saved();
    const claim = { claimNo: 1 as const, claimSide: 2 as const, claimBlock: 40 };
    h.finalizeAbandonment.mockResolvedValue(null);
    h.importDiscoveredResolution.mockResolvedValue(result({ resolution: { kind: 'settled', winner: 'draw' } }));

    const r = await recoverStuckGame({ roomId: 'room-1', kind: 'finalizable', claim }, s, toPrivateGame(s)!, ctx, { storage: storageOf([]) });

    expect(h.finalizeAbandonment).toHaveBeenCalledWith(toPrivateGame(s), ctx, claim);
    expect(h.importDiscoveredResolution).toHaveBeenCalled();
    expect(r!.resolution).toEqual({ kind: 'settled', winner: 'draw' });
  });
});
