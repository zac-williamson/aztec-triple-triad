import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGameFlow } from './useGameFlow';
import type { GameState, HandProofData, MoveProofData } from '../types';

// Mock blinding factor derivation — returns a deterministic value
vi.mock('./deriveBlindingFactor', () => ({
  deriveBlindingFactor: vi.fn().mockResolvedValue('0xmock_blinding_factor'),
}));

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

// Mock computeCardCommitPoseidon2
vi.mock('../aztec/proofWorker', () => ({
  computeCardCommitPoseidon2: vi.fn().mockResolvedValue('0xmock_commit_hash'),
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

const MOCK_WALLET = { fake: 'wallet' };
const MOCK_ACCOUNT = '0x1234567890abcdef';

describe('useGameFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateHandProof.mockResolvedValue({
      proof: 'hand_proof',
      publicInputs: ['commit'],
      cardCommit: 'commit_hash',
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
      wallet: MOCK_WALLET,
      accountAddress: MOCK_ACCOUNT,
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
      wallet: MOCK_WALLET,
      accountAddress: MOCK_ACCOUNT,
    }));

    // The hand proof should be generated automatically when gameId and gameState are set
    await act(async () => {
      await new Promise(r => setTimeout(r, 10));
    });

    expect(mockGenerateHandProof).toHaveBeenCalledTimes(1);
    expect(mockGenerateHandProof).toHaveBeenCalledWith(
      [1, 2, 3, 4, 5],
      expect.any(String), // blinding factor
      '0xmock_commit_hash', // card commit hash from mocked computeCardCommitPoseidon2
    );
  });

  it('should collect move proofs from both players', () => {
    const { result } = renderHook(() => useGameFlow({
      gameId: 'game_1',
      playerNumber: 1,
      cardIds: [1, 2, 3, 4, 5],
      gameState: makeGameState(),
      wallet: MOCK_WALLET,
      accountAddress: MOCK_ACCOUNT,
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
      wallet: MOCK_WALLET,
      accountAddress: MOCK_ACCOUNT,
    }));

    const handProof: HandProofData = {
      proof: 'opp_hand',
      publicInputs: ['commit'],
      cardCommit: 'opp_commit',
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
        wallet: MOCK_WALLET,
        accountAddress: MOCK_ACCOUNT,
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
      proof: 'opp', publicInputs: [], cardCommit: 'c',
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
        wallet: MOCK_WALLET,
        accountAddress: MOCK_ACCOUNT,
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
      proof: 'opp', publicInputs: [], cardCommit: 'c',
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

  it('should NOT generate move proof when hand proofs are missing', async () => {
    // Set up a game with hand proof generated but NO opponent hand proof
    const { result } = renderHook(() => useGameFlow({
      gameId: '0x1234',
      playerNumber: 1,
      cardIds: [1, 2, 3, 4, 5],
      gameState: makeGameState(),
      wallet: MOCK_WALLET,
      accountAddress: MOCK_ACCOUNT,
    }));

    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    // My hand proof is generated but opponent's is null
    expect(result.current.myHandProof).not.toBeNull();
    expect(result.current.opponentHandProof).toBeNull();

    // Try to generate a move proof — should return null (guarded)
    let moveResult: any;
    await act(async () => {
      moveResult = await result.current.generateMoveProofForPlacement(
        1, 0, 0,
        makeBoard(),
        makeBoard(),
        [5, 5],
        [5, 5],
        false,
        0,
      );
    });

    expect(moveResult).toBeNull();
    // The mock should NOT have been called for move proof generation
    expect(mockGenerateMoveProof).not.toHaveBeenCalled();
  });

  it('should generate move proof only after both hand proofs exist', async () => {
    const { result } = renderHook(() => useGameFlow({
      gameId: '0x1234',
      playerNumber: 1,
      cardIds: [1, 2, 3, 4, 5],
      gameState: makeGameState(),
      wallet: MOCK_WALLET,
      accountAddress: MOCK_ACCOUNT,
    }));

    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    // Provide opponent hand proof
    const oppProof: HandProofData = {
      proof: 'opp',
      publicInputs: ['0xabc'],
      cardCommit: '0xabc',
    };

    act(() => {
      result.current.setOpponentHandProof(oppProof);
    });

    // Now both proofs exist — move proof generation should proceed
    expect(result.current.myHandProof).not.toBeNull();
    expect(result.current.opponentHandProof).not.toBeNull();
    expect(result.current.myCardCommit).not.toBeNull();
    expect(result.current.opponentCardCommit).not.toBeNull();
  });

  it('should deduplicate move proofs with same state hashes', () => {
    const { result } = renderHook(() => useGameFlow({
      gameId: '0x1234',
      playerNumber: 1,
      cardIds: [1, 2, 3, 4, 5],
      gameState: makeGameState(),
      wallet: MOCK_WALLET,
      accountAddress: MOCK_ACCOUNT,
    }));

    const moveProof: MoveProofData = {
      proof: 'move1',
      publicInputs: [],
      cardCommit1: 'c1',
      cardCommit2: 'c2',
      startStateHash: 'same_start',
      endStateHash: 'same_end',
      gameEnded: false,
      winnerId: 0,
    };

    act(() => {
      result.current.addMoveProof(moveProof);
      // Add the same proof again (simulating double-add from local + WebSocket)
      result.current.addMoveProof({ ...moveProof });
    });

    // Should only have 1 proof due to deduplication
    expect(result.current.collectedMoveProofs).toHaveLength(1);
  });

  it('should accumulate exactly 9 proofs for a full game', () => {
    const { result } = renderHook(() => useGameFlow({
      gameId: '0x1234',
      playerNumber: 1,
      cardIds: [1, 2, 3, 4, 5],
      gameState: makeGameState(),
      wallet: MOCK_WALLET,
      accountAddress: MOCK_ACCOUNT,
    }));

    act(() => {
      for (let i = 0; i < 9; i++) {
        result.current.addMoveProof({
          proof: `move_${i}`,
          publicInputs: [],
          cardCommit1: 'c1',
          cardCommit2: 'c2',
          startStateHash: `start_${i}`,
          endStateHash: `end_${i}`,
          gameEnded: i === 8,
          winnerId: i === 8 ? 1 : 0,
        });
      }
    });

    expect(result.current.collectedMoveProofs).toHaveLength(9);
  });

  it('should add proofs with different state hashes (no false dedup)', () => {
    const { result } = renderHook(() => useGameFlow({
      gameId: '0x1234',
      playerNumber: 1,
      cardIds: [1, 2, 3, 4, 5],
      gameState: makeGameState(),
      wallet: MOCK_WALLET,
      accountAddress: MOCK_ACCOUNT,
    }));

    act(() => {
      result.current.addMoveProof({
        proof: 'move_a', publicInputs: [], cardCommit1: 'c1', cardCommit2: 'c2',
        startStateHash: 'start_a', endStateHash: 'end_a', gameEnded: false, winnerId: 0,
      });
      result.current.addMoveProof({
        proof: 'move_b', publicInputs: [], cardCommit1: 'c1', cardCommit2: 'c2',
        startStateHash: 'start_b', endStateHash: 'end_b', gameEnded: false, winnerId: 0,
      });
    });

    // Both should be added since they have different state hashes
    expect(result.current.collectedMoveProofs).toHaveLength(2);
  });

  it('should NOT allow settle on a draw (no winner)', async () => {
    const playingState = makeGameState({ status: 'playing' });

    const { result, rerender } = renderHook(
      (props: { gameState: GameState }) => useGameFlow({
        gameId: 'game_1',
        playerNumber: 1,
        cardIds: [1, 2, 3, 4, 5],
        gameState: props.gameState,
        wallet: MOCK_WALLET,
        accountAddress: MOCK_ACCOUNT,
      }),
      { initialProps: { gameState: playingState } },
    );

    await act(async () => {
      await new Promise(r => setTimeout(r, 50));
    });

    // Transition to finished with draw
    const drawState = makeGameState({
      status: 'finished',
      winner: 'draw',
      player1Score: 5,
      player2Score: 5,
    });
    rerender({ gameState: drawState });

    const oppHandProof: HandProofData = {
      proof: 'opp', publicInputs: [], cardCommit: 'c',
    };

    act(() => {
      result.current.setOpponentHandProof(oppHandProof);
      for (let i = 0; i < 9; i++) {
        result.current.addMoveProof({
          proof: `move_${i}`, publicInputs: [], cardCommit1: 'c1', cardCommit2: 'c2',
          startStateHash: `s${i}`, endStateHash: `e${i}`, gameEnded: i === 8, winnerId: i === 8 ? 3 : 0,
        });
      }
    });

    // Draw means no winner can settle — canSettle should be false
    expect(result.current.canSettle).toBe(false);
  });

  it('should reset state cleanly', async () => {
    const { result } = renderHook(() => useGameFlow({
      gameId: 'game_1',
      playerNumber: 1,
      cardIds: [1, 2, 3, 4, 5],
      gameState: makeGameState(),
      wallet: MOCK_WALLET,
      accountAddress: MOCK_ACCOUNT,
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
