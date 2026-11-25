import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock the config module
vi.mock('../../aztec/config', () => ({
  AZTEC_CONFIG: { gameContractAddress: '0xGAME_CONTRACT' },
}));

import { commitIsStale, hasStake, toPrivateGame, useGameStorage, type PersistedGameState } from '../useGameStorage';
import { normalizeField } from '../../aztec/privateGame';
import { record } from '../../aztec/__tests__/privateGameFixtures';
import type { MoveProofData } from '../../types';

const KEY = normalizeField(0x6a3en);

function makeSavedGame(overrides: Partial<PersistedGameState> = {}): PersistedGameState {
  return {
    gameId: 'game-1',
    playerNumber: 1,
    selectedCardIds: [1, 2, 3, 4, 5],
    savedAt: Date.now(),
    ...overrides,
  };
}

/** A game this player committed cards to (creator: its record 1 is out). */
function staked(overrides: Partial<PersistedGameState> = {}): PersistedGameState {
  return makeSavedGame({ gameKey: KEY, nonce: '0x28', record1: record(1), ...overrides });
}

const BOOK_KEY = 'aztec_tt_game_0xGAME_CONTRACT_games';
const proof = (n: number) => ({ startStateHash: `s${n}`, endStateHash: `e${n}` }) as MoveProofData;

beforeEach(() => {
  localStorage.clear();
});

describe('useGameStorage', () => {
  it('saveGame + loadGame round-trip', () => {
    const { result } = renderHook(() => useGameStorage());
    const state = makeSavedGame();
    result.current.saveGame(state);
    expect(result.current.loadGame()).toEqual(state);
  });

  it('loadGame returns null when empty, and for invalid JSON', () => {
    const { result } = renderHook(() => useGameStorage());
    expect(result.current.loadGame()).toBeNull();
    localStorage.setItem(BOOK_KEY, '{not valid json');
    expect(result.current.loadGame()).toBeNull();
  });

  it('loadGame rejects stale saves (3 hours old) but does NOT delete them', () => {
    const { result } = renderHook(() => useGameStorage());
    result.current.saveGame(staked({ savedAt: Date.now() - 3 * 60 * 60 * 1000 }));
    expect(result.current.loadGame()).toBeNull();
    // Still evidence: the cards in it can still be recovered.
    expect(result.current.loadClaimable()?.gameId).toBe('game-1');
  });

  it('saveGame MERGES: fields written elsewhere (key pair, records) survive a later save', () => {
    const { result } = renderHook(() => useGameStorage());
    result.current.mergeGame('game-1', { gameKey: KEY, record1: record(1), nonce: '0x28' });
    result.current.saveGame(makeSavedGame({ collectedMoveProofs: [proof(1)] }));
    const g = result.current.readGame('game-1')!;
    expect(g.gameKey).toBe(KEY);
    expect(g.record1).toEqual(record(1));
    expect(g.collectedMoveProofs).toHaveLength(1);
  });

  it('mergeGame creates a record for a room it has not seen, and never erases with undefined', () => {
    const { result } = renderHook(() => useGameStorage());
    result.current.mergeGame('room-9', { opponentPublicKey: 'pk' });
    result.current.mergeGame('room-9', { opponentPublicKey: undefined, gameKey: KEY });
    expect(result.current.readGame('room-9')).toMatchObject({ gameId: 'room-9', opponentPublicKey: 'pk', gameKey: KEY });
  });

  describe('claim evidence outlives the game', () => {
    it('markFinished keeps a staked game but stops offering a resume', () => {
      const { result } = renderHook(() => useGameStorage());
      result.current.saveGame(staked());
      result.current.markFinished();
      expect(result.current.loadGame()).toBeNull();
      expect(result.current.loadClaimable()?.finishedAt).toBeDefined();
    });

    it('markFinished discards a game that never staked anything', () => {
      const { result } = renderHook(() => useGameStorage());
      result.current.saveGame(makeSavedGame());
      result.current.markFinished();
      expect(result.current.readGame('game-1')).toBeNull();
    });

    it('keeps evidence well past the resume window, and lets it go after thirty days', () => {
      const { result } = renderHook(() => useGameStorage());
      result.current.saveGame(staked({ savedAt: Date.now() - 7 * 24 * 60 * 60 * 1000 }));
      expect(result.current.loadClaimable()).not.toBeNull();
      result.current.saveGame(staked({ savedAt: Date.now() - 31 * 24 * 60 * 60 * 1000 }));
      expect(result.current.loadClaimable()).toBeNull();
      expect(result.current.readGame('game-1')).toBeNull();
    });

    it('offers nothing to claim for a game with no commit of ours, or one already imported', () => {
      const { result } = renderHook(() => useGameStorage());
      result.current.saveGame(makeSavedGame());
      expect(result.current.loadClaimable()).toBeNull();
      result.current.saveGame(staked({ gameId: 'game-2', importedAt: Date.now() }));
      expect(result.current.loadClaimable()).toBeNull();
    });

    it('a new game never overwrites an older game that still holds cards', () => {
      const { result } = renderHook(() => useGameStorage());
      result.current.saveGame(staked({ gameId: 'old', savedAt: Date.now() - 60_000 }));
      result.current.markFinished();
      result.current.saveGame(staked({ gameId: 'new' }));
      expect(result.current.listClaimable().map(g => g.gameId)).toEqual(['old', 'new']);
      expect(result.current.loadClaimable()?.gameId).toBe('old');
      expect(result.current.loadGame()?.gameId).toBe('new');
    });

    it('merges a proof that arrives after the player left the game screen', () => {
      const { result } = renderHook(() => useGameStorage());
      result.current.saveGame(staked({ collectedMoveProofs: [proof(1)] }));
      result.current.mergeMoveProof(proof(2));
      result.current.mergeMoveProof(proof(2)); // the relay replays its buffer: harmless
      expect(result.current.readGame('game-1')?.collectedMoveProofs).toHaveLength(2);
    });

    it('does not start a record for a game that staked nothing', () => {
      const { result } = renderHook(() => useGameStorage());
      result.current.saveGame(makeSavedGame());
      result.current.mergeMoveProof(proof(1));
      expect(result.current.readGame('game-1')?.collectedMoveProofs).toBeUndefined();
    });

    it('a NEW game is not born finished because the last one was', () => {
      const { result } = renderHook(() => useGameStorage());
      result.current.saveGame(staked({ gameId: 'a' }));
      result.current.markFinished();
      result.current.saveGame(staked({ gameId: 'b' }));
      expect(result.current.loadGame()?.gameId).toBe('b');
    });

    it('a later save does not resurrect a finished game', () => {
      const { result } = renderHook(() => useGameStorage());
      result.current.saveGame(staked());
      result.current.markFinished();
      result.current.saveGame(staked({ collectedMoveProofs: [proof(9)] }));
      expect(result.current.loadGame()).toBeNull();
      expect(result.current.readGame('game-1')?.finishedAt).toBeDefined();
    });

    it('leaving keeps a staked game for the menu, and drops one that staked nothing', () => {
      const { result } = renderHook(() => useGameStorage());
      result.current.saveGame(staked());
      result.current.leaveCurrentGame();
      expect(result.current.loadGame()).toBeNull();
      expect(result.current.loadClaimable()?.gameId).toBe('game-1');

      result.current.saveGame(makeSavedGame({ gameId: 'nothing' }));
      result.current.leaveCurrentGame();
      expect(result.current.readGame('nothing')).toBeNull();
    });
  });

  it('clearGame removes the record; hasGame reflects a resumable game', () => {
    const { result } = renderHook(() => useGameStorage());
    result.current.saveGame(makeSavedGame());
    expect(result.current.hasGame()).toBe(true);
    result.current.clearGame();
    expect(result.current.hasGame()).toBe(false);
    expect(result.current.readGame('game-1')).toBeNull();
  });

  it('hasGame returns false for stale saves', () => {
    const { result } = renderHook(() => useGameStorage());
    result.current.saveGame(makeSavedGame({ savedAt: Date.now() - 3 * 60 * 60 * 1000 }));
    expect(result.current.hasGame()).toBe(false);
  });
});

describe('what a stored game says', () => {
  it('a stake is our own committed record plus the key and nonce that name it', () => {
    expect(hasStake(staked())).toBe(true);
    expect(hasStake(staked({ playerNumber: 2 }))).toBe(false); // the joiner's own record is record 2
    expect(hasStake(staked({ playerNumber: 2, record2: record(2) }))).toBe(true);
    expect(hasStake(staked({ nonce: undefined }))).toBe(false);
  });

  it('becomes the chain actions\' game, or nothing when we never committed', () => {
    expect(toPrivateGame(staked({ record2: record(2) }))).toEqual({
      roomId: 'game-1', role: 1, hand: [1, 2, 3, 4, 5], gameKey: KEY, nonce: normalizeField(0x28n),
      record1: record(1), record2: record(2),
    });
    expect(toPrivateGame(makeSavedGame())).toBeNull();
    expect(toPrivateGame(staked({ record1: ['1', '2'] }))).toBeNull();
  });

  it('an unconfirmed commit is dropped only once nothing sent for it can still land', () => {
    const now = Date.now();
    expect(commitIsStale({ commitSentAt: now - 5 * 60_000 }, now)).toBe(false);
    expect(commitIsStale({ commitSentAt: now - 2 * 60 * 60_000 }, now)).toBe(true);
  });
});
