import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGameFlow } from './useGameFlow';
import type { GameState, HandProofData, MoveProofData } from '../types';

// Mock proof generation
const mockGenerateHandProof = vi.fn();
const mockGenerateMoveProof = vi.fn();
const mockProofReset = vi.fn();

vi.mock('./useProofGeneration', () => ({
  useProofGeneration: () => ({
    handProofStatus: 'idle',
    moveProofStatus: 'idle',
    handProof: null,
    moveProofs: [],
    error: null,
    generateHandProof: mockGenerateHandProof,
    generateMoveProof: mockGenerateMoveProof,
    reset: mockProofReset,
  }),
}));

function makeBoard(): GameState['board'] {
  return Array(3).fill(null).map(() =>
    Array(3).fill(null).map(() => ({ card: null, owner: null }))
  );
}

function makeGameState(overrides?: Partial<GameState>): GameState {
  return {
    board: makeBoard(),
    player1Hand: [
      { id: 1, name: 'Mudwalker', ranks: { top: 1, right: 4, bottom: 1, left: 5 } },
      { id: 2, name: 'Blushy', ranks: { top: 5, right: 1, bottom: 1, left: 3 } },
      { id: 3, name: 'Snowdrop', ranks: { top: 1, right: 3, bottom: 3, left: 5 } },
      { id: 4, name: 'Sunny', ranks: { top: 6, right: 1, bottom: 1, left: 2 } },
      { id: 5, name: 'Inkwell', ranks: { top: 2, right: 3, bottom: 1, left: 5 } },
    ],
    player2Hand: [
      { id: 6, name: 'Stripes', ranks: { top: 2, right: 1, bottom: 4, left: 4 } },
      { id: 7, name: 'Barkeeper', ranks: { top: 1, right: 5, bottom: 4, left: 1 } },
      { id: 8, name: 'Dotty', ranks: { top: 3, right: 1, bottom: 5, left: 2 } },
      { id: 9, name: 'Penny', ranks: { top: 2, right: 1, bottom: 6, left: 1 } },
      { id: 10, name: 'Peaches', ranks: { top: 4, right: 3, bottom: 2, left: 4 } },
    ],
    currentTurn: 'player1',
    player1Score: 5,
    player2Score: 5,
    status: 'playing',
    winner: null,
    ...overrides,
  };
}

describe('useGameFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateHandProof.mockResolvedValue({
      proof: 'hand_proof',
      publicInputs: ['commit', 'addr', 'gid'],
      cardCommit: 'commit_hash',
      playerAddress: 'test_addr',
      gameId: 'game_1',
    } satisfies HandProofData);
    mockGenerateMoveProof.mockResolvedValue({
      proof: 'move_proof',
      publicInputs: ['c1', 'c2', 'sh', 'eh', '0', '0'],
      cardCommit1: 'commit1',
      cardCommit2: 'commit2',
      startStateHash: 'start',
      endStateHash: 'end',
      gameEnded: false,
      winnerId: 0,
    } satisfies MoveProofData);
  });

  it('should initialize with no proofs collected', () => {
    const { result } = renderHook(() => useGameFlow({
      gameId: null,
      playerNumber: null,
      cardIds: [1, 2, 3, 4, 5],
      gameState: null,
    }));

    expect(result.current.myHandProof).toBeNull();
    expect(result.current.opponentHandProof).toBeNull();
    expect(result.current.collectedMoveProofs).toEqual([]);
    expect(result.current.canSettle).toBe(false);
  });

  it('should generate hand proof when game starts', async () => {
    const { result } = renderHook(() => useGameFlow({
      gameId: 'game_1',
      playerNumber: 1,
      cardIds: [1, 2, 3, 4, 5],
      gameState: makeGameState(),
    }));

    // The hand proof should be generated automatically when gameId and gameState are set
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    expect(mockGenerateHandProof).toHaveBeenCalledTimes(1);
    expect(mockGenerateHandProof).toHaveBeenCalledWith(
      [1, 2, 3, 4, 5],
      expect.any(Array), // card ranks
      expect.any(String), // player address
      'game_1',
      expect.any(String), // player secret
      expect.any(Array), // nullifier secrets
      expect.any(String), // grumpkin private key
    );
  });

  it('should collect move proofs from both players', () => {
    const { result } = renderHook(() => useGameFlow({
      gameId: 'game_1',
      playerNumber: 1,
      cardIds: [1, 2, 3, 4, 5],
      gameState: makeGameState(),
    }));

    const moveProof: MoveProofData = {
      proof: 'move1',
      publicInputs: [],
      cardCommit1: 'c1',
      cardCommit2: 'c2',
      startStateHash: 's',
      endStateHash: 'e',
      gameEnded: false,
      winnerId: 0,
    };

    act(() => {
      result.current.addMoveProof(moveProof);
    });

    expect(result.current.collectedMoveProofs).toHaveLength(1);
    expect(result.current.collectedMoveProofs[0]).toBe(moveProof);
  });

  it('should set opponent hand proof', () => {
    const { result } = renderHook(() => useGameFlow({
      gameId: 'game_1',
      playerNumber: 1,
      cardIds: [1, 2, 3, 4, 5],
      gameState: makeGameState(),
    }));

    const handProof: HandProofData = {
      proof: 'opp_hand',
      publicInputs: ['commit', 'addr', 'gid'],
      cardCommit: 'opp_commit',
      playerAddress: 'opp_addr',
      gameId: 'game_1',
    };

    act(() => {
      result.current.setOpponentHandProof(handProof);
    });

    expect(result.current.opponentHandProof).toBe(handProof);
  });

  it('should determine canSettle when game is won and all proofs collected', async () => {
    // Start with a playing game so hand proof gets generated
    const playingState = makeGameState({ status: 'playing' });

    const { result, rerender } = renderHook(
      (props: { gameState: GameState }) => useGameFlow({
        gameId: 'game_1',
        playerNumber: 1,
        cardIds: [1, 2, 3, 4, 5],
        gameState: props.gameState,
      }),
      { initialProps: { gameState: playingState } },
    );

    // Wait for hand proof generation effect
    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    // Verify hand proof was generated
    expect(result.current.myHandProof).not.toBeNull();

    // Now transition to finished
    const finishedState = makeGameState({
      status: 'finished',
      winner: 'player1',
    });
    rerender({ gameState: finishedState });

    const oppHandProof: HandProofData = {
      proof: 'opp', publicInputs: [], cardCommit: 'c', playerAddress: 'a', gameId: 'g'
    };

    act(() => {
      result.current.setOpponentHandProof(oppHandProof);
      // Each move proof needs unique state hashes (deduplication checks these)
      for (let i = 0; i < 9; i++) {
        result.current.addMoveProof({
          proof: `move_${i}`, publicInputs: [], cardCommit1: 'c1', cardCommit2: 'c2',
          startStateHash: `s${i}`, endStateHash: `e${i}`, gameEnded: i === 8, winnerId: i === 8 ? 1 : 0,
        });
      }
    });

    // Winner (player1) should be able to settle
    expect(result.current.canSettle).toBe(true);
  });

  it('should NOT allow settle if player is the loser', async () => {
    // Start with playing game, then transition to finished
    const playingState = makeGameState({ status: 'playing' });

    const { result, rerender } = renderHook(
      (props: { gameState: GameState }) => useGameFlow({
        gameId: 'game_1',
        playerNumber: 1,
        cardIds: [1, 2, 3, 4, 5],
        gameState: props.gameState,
      }),
      { initialProps: { gameState: playingState } },
    );

    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    const finishedState = makeGameState({
      status: 'finished',
      winner: 'player2', // player1 lost
    });
    rerender({ gameState: finishedState });

    const oppHandProof: HandProofData = {
      proof: 'opp', publicInputs: [], cardCommit: 'c', playerAddress: 'a', gameId: 'g'
    };

    act(() => {
      result.current.setOpponentHandProof(oppHandProof);
      // Each move proof needs unique state hashes (deduplication checks these)
      for (let i = 0; i < 9; i++) {
        result.current.addMoveProof({
          proof: `move_${i}`, publicInputs: [], cardCommit1: 'c1', cardCommit2: 'c2',
          startStateHash: `s${i}`, endStateHash: `e${i}`, gameEnded: i === 8, winnerId: i === 8 ? 2 : 0,
        });
      }
    });

    // Loser cannot settle
    expect(result.current.canSettle).toBe(false);
  });

  it('should reset state cleanly', async () => {
    const { result } = renderHook(() => useGameFlow({
      gameId: 'game_1',
      playerNumber: 1,
      cardIds: [1, 2, 3, 4, 5],
      gameState: makeGameState(),
    }));

    const moveProof: MoveProofData = {
      proof: 'move', publicInputs: [], cardCommit1: 'c1', cardCommit2: 'c2',
      startStateHash: 's', endStateHash: 'e', gameEnded: false, winnerId: 0,
    };

    act(() => {
      result.current.addMoveProof(moveProof);
    });
    expect(result.current.collectedMoveProofs).toHaveLength(1);

    act(() => {
      result.current.reset();
    });
    expect(result.current.collectedMoveProofs).toEqual([]);
    expect(result.current.myHandProof).toBeNull();
    expect(result.current.opponentHandProof).toBeNull();
  });
});
