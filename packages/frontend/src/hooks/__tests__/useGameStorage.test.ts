import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the config module
vi.mock('../../aztec/config', () => ({
  AZTEC_CONFIG: { gameContractAddress: '0xGAME_CONTRACT' },
}));

import { useGameStorage, type PersistedGameState } from '../useGameStorage';

function makeSavedGame(overrides: Partial<PersistedGameState> = {}): PersistedGameState {
  return {
    gameId: 'game-1',
    playerNumber: 1,
    selectedCardIds: [1, 2, 3, 4, 5],
    savedAt: Date.now(),
    ...overrides,
  };
}

const STORAGE_KEY = 'aztec_tt_game_0xGAME_CONTRACT_current_game';

beforeEach(() => {
  localStorage.clear();
});

describe('useGameStorage', () => {
  it('saveGame + loadGame round-trip', () => {
    const { result } = renderHook(() => useGameStorage());
    const state = makeSavedGame();

    result.current.saveGame(state);
    const loaded = result.current.loadGame();

    expect(loaded).toEqual(state);
  });

  it('loadGame returns null when empty', () => {
    const { result } = renderHook(() => useGameStorage());
    expect(result.current.loadGame()).toBeNull();
  });

  it('loadGame rejects stale saves (3 hours old) but does NOT delete them', () => {
    const { result } = renderHook(() => useGameStorage());
    const staleState = makeSavedGame({
      savedAt: Date.now() - 3 * 60 * 60 * 1000,
      onChainGameId: '0xabc',   // cards were staked, so the record still matters
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(staleState));
    expect(result.current.loadGame()).toBeNull();
    // It used to remove it. That is the bug: two hours is how long a game is
    // worth RESUMING, and nothing to do with how long the transcript is worth
    // keeping — a claim cannot even be attempted for an hour, and people come
    // back the next day. Deleting here destroys the only copy of the proofs.
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    expect(result.current.loadClaimable()).not.toBeNull();
  });

  describe('claim evidence outlives the game', () => {
    it('markFinished keeps the transcript but stops offering a resume', () => {
      const { result } = renderHook(() => useGameStorage());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(makeSavedGame({ onChainGameId: '0xabc' })));

      act(() => result.current.markFinished());

      expect(result.current.loadGame(), 'a finished game is not resumable').toBeNull();
      expect(result.current.hasGame()).toBe(false);
      const kept = result.current.loadClaimable();
      expect(kept, 'but the proofs are what a claim is built from').not.toBeNull();
      expect(kept!.onChainGameId).toBe('0xabc');
    });

    it('markFinished discards a game that never staked anything', () => {
      const { result } = renderHook(() => useGameStorage());
      const noStake = makeSavedGame();
      delete (noStake as any).onChainGameId;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(noStake));

      act(() => result.current.markFinished());
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('keeps evidence well past the resume window', () => {
      const { result } = renderHook(() => useGameStorage());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(makeSavedGame({
        onChainGameId: '0xabc',
        savedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,   // five days
      })));
      expect(result.current.loadGame()).toBeNull();
      expect(result.current.loadClaimable()).not.toBeNull();
    });

    it('lets it go after thirty days', () => {
      const { result } = renderHook(() => useGameStorage());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(makeSavedGame({
        onChainGameId: '0xabc',
        savedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      })));
      expect(result.current.loadClaimable()).toBeNull();
    });

    it('offers nothing to claim for a game with no on-chain id', () => {
      const { result } = renderHook(() => useGameStorage());
      const noStake = makeSavedGame();
      delete (noStake as any).onChainGameId;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(noStake));
      expect(result.current.loadClaimable()).toBeNull();
    });

    it('merges a proof that arrives after the player left the game screen', () => {
      // The main save effect only runs on the game screen. The proof most
      // likely to arrive outside it is the opponent's LAST one — proved in
      // their browser for seconds after the board fills, which is exactly when
      // a losing player clicks back to the menu.
      const { result } = renderHook(() => useGameStorage());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(makeSavedGame({
        onChainGameId: '0xabc',
        collectedMoveProofs: Array.from({ length: 8 }, (_, i) => ({
          proof: 'p', publicInputs: [], startStateHash: `s${i}`, endStateHash: `s${i + 1}`,
        })),
      } as any)));
      act(() => result.current.markFinished());

      act(() => result.current.mergeMoveProof({
        proof: 'p', publicInputs: [], startStateHash: 's8', endStateHash: 's9',
      } as any));

      expect(result.current.loadClaimable()!.collectedMoveProofs).toHaveLength(9);
    });

    it('ignores a proof it already holds', () => {
      const { result } = renderHook(() => useGameStorage());
      const one = { proof: 'p', publicInputs: [], startStateHash: 's0', endStateHash: 's1' };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(makeSavedGame({
        onChainGameId: '0xabc', collectedMoveProofs: [one],
      } as any)));

      act(() => result.current.mergeMoveProof(one as any));
      act(() => result.current.mergeMoveProof(one as any));

      expect(result.current.loadClaimable()!.collectedMoveProofs).toHaveLength(1);
    });

    it('does not start a record for a game that staked nothing', () => {
      const { result } = renderHook(() => useGameStorage());
      const noStake = makeSavedGame();
      delete (noStake as any).onChainGameId;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(noStake));

      act(() => result.current.mergeMoveProof({
        proof: 'p', publicInputs: [], startStateHash: 's0', endStateHash: 's1',
      } as any));

      expect(result.current.loadClaimable()).toBeNull();
    });

    it('a later save does not resurrect a finished game', () => {
      // The save effect rebuilds this record from live state whenever anything
      // changes — and a move proof arriving AFTER the game ended does exactly
      // that. Without the merge, the record would flip back to "in progress"
      // at the moment it stopped being one.
      const { result } = renderHook(() => useGameStorage());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(makeSavedGame({ onChainGameId: '0xabc' })));
      act(() => result.current.markFinished());

      act(() => result.current.saveGame(makeSavedGame({ onChainGameId: '0xabc' })));

      expect(result.current.loadGame(), 'still finished').toBeNull();
      expect(result.current.loadClaimable()).not.toBeNull();
    });
  });

  it('loadGame accepts fresh saves (1 hour old)', () => {
    const { result } = renderHook(() => useGameStorage());
    const freshState = makeSavedGame({
      savedAt: Date.now() - 1 * 60 * 60 * 1000,
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(freshState));
    expect(result.current.loadGame()).toEqual(freshState);
  });

  it('clearGame removes the key', () => {
    const { result } = renderHook(() => useGameStorage());
    result.current.saveGame(makeSavedGame());
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    result.current.clearGame();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('hasGame returns true when game is saved', () => {
    const { result } = renderHook(() => useGameStorage());
    result.current.saveGame(makeSavedGame());
    expect(result.current.hasGame()).toBe(true);
  });

  it('hasGame returns false when empty', () => {
    const { result } = renderHook(() => useGameStorage());
    expect(result.current.hasGame()).toBe(false);
  });

  it('hasGame returns false for stale saves', () => {
    const { result } = renderHook(() => useGameStorage());
    const staleState = makeSavedGame({
      savedAt: Date.now() - 3 * 60 * 60 * 1000,
      onChainGameId: '0xabc',   // cards were staked, so the record still matters
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(staleState));
    expect(result.current.hasGame()).toBe(false);
  });

  it('loadGame returns null for invalid JSON', () => {
    localStorage.setItem(STORAGE_KEY, 'not valid json {{{');
    const { result } = renderHook(() => useGameStorage());
    expect(result.current.loadGame()).toBeNull();
  });
});
