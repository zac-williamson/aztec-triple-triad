/**
 * Placed-slot mask chaining (C2 replay fix). Each move's proof carries the
 * running (p1Placed, p2Placed) pair as before-masks; the mover advances its
 * own committed-hand slot bit, and the OPPONENT's bit is adopted from the
 * relayed after-masks (the opponent's committed slot is otherwise
 * underivable). This pins that a move's before-masks reflect BOTH the mover's
 * own prior moves AND the opponent's relayed masks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Board, Card, GameState } from '../types';

const generateMoveProof = vi.fn();
const generateHandProof = vi.fn();

vi.mock('./useProofGeneration', () => ({
  useProofGeneration: () => ({ generateHandProof, generateMoveProof, reset: vi.fn() }),
}));
vi.mock('../aztec/proofWorker', () => ({
  computeCardCommitPoseidon2: vi.fn().mockResolvedValue('0xCOMMIT'),
  computePlayerStateHash: vi.fn().mockResolvedValue('0xOPP'),
}));
vi.mock('../aztec/AztecContext', () => ({ useAztecContext: () => ({ isAvailable: true }) }));
vi.mock('../aztec/gameConstants', () => ({ TOTAL_MOVES: 9 }));

import { useGamePlay } from './useGamePlay';
import type { UseWebSocketReturn } from './useWebSocket';

function emptyBoard(): Board {
  return Array.from({ length: 3 }, () =>
    Array.from({ length: 3 }, () => ({ card: null, owner: null, originalOwner: null })),
  );
}
function card(id: number): Card {
  return { id, name: `c${id}`, ranks: { top: 5, right: 5, bottom: 5, left: 5 } };
}

// P2 (joiner) is the mover; committed hand ids = [10,11,12,13,14] (slots 0..4).
function p2State(board: Board, hand: Card[]): GameState {
  return {
    board, player1Hand: [card(1), card(2), card(3), card(4)], player2Hand: hand,
    currentTurn: 'player2', player1Score: 5, player2Score: 5,
    status: 'playing', winner: null,
  };
}

function makeWs(gameState: GameState, overrides: Partial<UseWebSocketReturn> = {}): UseWebSocketReturn {
  return {
    gameId: 'g', playerNumber: 2, gameState,
    opponentGameRandomness: ['0x1', '0x2', '0x3', '0x4', '0x5', '0x6'],
    opponentHandProof: { proof: 'ohp', publicInputs: ['0xC2', '0x0'], cardCommit: '0xC2' },
    lastMoveProof: null,
    placeCard: vi.fn(), submitMoveProof: vi.fn(), submitHandProof: vi.fn(),
    ...overrides,
  } as unknown as UseWebSocketReturn;
}

describe('useGamePlay placed-slot mask chaining', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateHandProof.mockResolvedValue({ proof: 'hp', publicInputs: ['0xC1', '0x0'], cardCommit: '0xC1' });
    // Each generated proof echoes the masks; after-masks aren't asserted here
    // (the proofWorker test covers them) — return a stable stub.
    generateMoveProof.mockResolvedValue({
      proof: 'mp', publicInputs: [], cardCommit1: '0xC1', cardCommit2: '0xC2',
      startStateHash: '0xs', endStateHash: '0xe', gameEnded: false, winnerId: 0,
      p1PlacedAfter: 0, p2PlacedAfter: 0,
    });
  });

  it('threads before-masks: own slot advances, opponent relayed masks are adopted', async () => {
    const cardIds = [10, 11, 12, 13, 14];

    const ws0 = makeWs(p2State(emptyBoard(), [card(10), card(11), card(12), card(13), card(14)]));
    const { result, rerender } = renderHook(
      ({ ws }) => useGamePlay({ ws, cardIds, blindingFactor: '0xBF' }),
      { initialProps: { ws: ws0 } },
    );
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    // Move A: P2 places card 10 (committed slot 0). First move → before-masks (0,0).
    await act(async () => { await result.current.handlePlaceCard(0, 0, 0); });
    expect(generateMoveProof).toHaveBeenCalledTimes(1);
    // before-masks are generateMoveProof args [13]=p1PlacedBefore, [14]=p2PlacedBefore
    expect(generateMoveProof.mock.calls[0][13]).toBe(0);
    expect(generateMoveProof.mock.calls[0][14]).toBe(0);

    // Opponent's move arrives with relayed after-masks: P1 placed slot 2 (bit 4),
    // and the pair already reflects P2's slot-0 (bit 1) from move A.
    const board1 = emptyBoard();
    board1[0][0] = { card: card(10), owner: 'player2', originalOwner: 'player2' };
    board1[1][1] = { card: card(3), owner: 'player1', originalOwner: 'player1' };
    const wsOpp = makeWs(p2State(board1, [card(11), card(12), card(13), card(14)]), {
      lastMoveProof: {
        moveProof: { proof: 'op', publicInputs: [], cardCommit1: '0xC1', cardCommit2: '0xC2',
          startStateHash: '0xa', endStateHash: '0xb', gameEnded: false, winnerId: 0,
          p1PlacedAfter: 4, p2PlacedAfter: 1 },
        handIndex: 0, row: 1, col: 1,
      },
    });
    await act(async () => { rerender({ ws: wsOpp }); await new Promise(r => setTimeout(r, 0)); });

    // Move B: P2 places card 11 (committed slot 1) at an empty cell. Its
    // before-masks must be (p1=4 adopted from the opponent, p2=1 from move A).
    await act(async () => { await result.current.handlePlaceCard(0, 0, 1); });
    expect(generateMoveProof).toHaveBeenCalledTimes(2);
    expect(generateMoveProof.mock.calls[1][13]).toBe(4); // p1: opponent's relayed mask
    expect(generateMoveProof.mock.calls[1][14]).toBe(1); // p2: our own slot-0 from move A
  });
});
