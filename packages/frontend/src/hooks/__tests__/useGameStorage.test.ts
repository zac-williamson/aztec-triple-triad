import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

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

  it('loadGame rejects stale saves (3 hours old)', () => {
    const { result } = renderHook(() => useGameStorage());
    const staleState = makeSavedGame({
      savedAt: Date.now() - 3 * 60 * 60 * 1000,
    });

    localStorage.setItem(STORAGE_KEY, JSON.stringify(staleState));
    expect(result.current.loadGame()).toBeNull();
    // Verify it removed the stale entry
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
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
