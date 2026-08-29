/**
 * `owedMoveProofs` — moves we have played whose proof the OPPONENT has not
 * received yet.
 *
 * This is what arms the unload guard. The settlement transcript is shared, so a
 * player who closes the tab still owing a link strands the WINNER's settlement
 * and locks both hands until the abandonment path resolves them. The last move
 * is the dangerous one: its proof is generated AFTER the relay declares the game
 * over, so a losing player is being asked to sit through a proof for a game they
 * have already lost — exactly when someone closes the tab.
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
  computePlayerStateHash: vi.fn().mockResolvedValue('0xOPPSTATE'),
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
function joinerPreMoveState(): GameState {
  const board = emptyBoard();
  board[0][0] = { card: card(1), owner: 'player1', originalOwner: 'player1' };
  return {
    board,
    player1Hand: [card(2), card(3), card(4), card(5)],
    player2Hand: [card(10), card(11), card(12), card(13), card(14)],
    currentTurn: 'player2',
    player1Score: 6, player2Score: 4,
    status: 'playing', winner: null,
  };
}
function makeWs(gameState: GameState, overrides: Partial<UseWebSocketReturn> = {}): UseWebSocketReturn {
  return {
    gameId: 'game-1', playerNumber: 2, gameState,
    opponentGameRandomness: ['0x1', '0x2', '0x3', '0x4', '0x5', '0x6'],
    opponentHandProof: { proof: 'ohp', publicInputs: ['0xC2', '0x0'], cardCommit: '0xC2' },
    lastMoveProof: null,
    placeCard: vi.fn(), submitMoveProof: vi.fn(), submitHandProof: vi.fn(),
    ...overrides,
  } as unknown as UseWebSocketReturn;
}

describe('useGamePlay owedMoveProofs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateHandProof.mockResolvedValue({ proof: 'hp', publicInputs: ['0xC1', '0x0'], cardCommit: '0xC1' });
  });

  it('owes a proof while one is generating, and stops owing once it is sent', async () => {
    let release!: (v: unknown) => void;
    generateMoveProof.mockReturnValue(new Promise(r => { release = r; }));

    const ws = makeWs(joinerPreMoveState());
    const { result } = renderHook(() => useGamePlay({ ws, cardIds: [10, 11, 12, 13, 14], blindingFactor: '0xBF' }));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    expect(result.current.owedMoveProofs).toBe(0);

    // Play a card; the proof is still generating. Leaving NOW is the failure.
    let placed: Promise<unknown>;
    await act(async () => {
      placed = result.current.handlePlaceCard(0, 1, 1);
      // handlePlaceCard dynamically imports the rules engine before it can
      // reach the prover, so poll until the prover is actually entered rather
      // than guessing a tick count.
      for (let i = 0; i < 200 && generateMoveProof.mock.calls.length === 0; i++) {
        await new Promise(r => setTimeout(r, 5));
      }
    });
    expect(generateMoveProof).toHaveBeenCalledTimes(1);
    // The proof is generating and unsent: this is the window in which closing
    // the tab strands the winner.
    expect(result.current.owedMoveProofs).toBe(1);
    expect(ws.submitMoveProof).not.toHaveBeenCalled();

    await act(async () => {
      release({
        proof: 'mp', publicInputs: ['0xC1', '0xC2', '0xs', '0xe', '0', '0'],
        cardCommit1: '0xC1', cardCommit2: '0xC2', startStateHash: '0xs', endStateHash: '0xe',
        gameEnded: false, winnerId: 0,
      });
      await placed;
    });

    expect(ws.submitMoveProof).toHaveBeenCalledTimes(1);
    expect(result.current.owedMoveProofs).toBe(0);
  });

  it('stops owing even when proving FAILS', async () => {
    generateMoveProof.mockRejectedValue(new Error('prover exploded'));
    const ws = makeWs(joinerPreMoveState());
    const { result } = renderHook(() => useGamePlay({ ws, cardIds: [10, 11, 12, 13, 14], blindingFactor: '0xBF' }));
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    await act(async () => { await result.current.handlePlaceCard(0, 1, 1); });

    // The proof is not coming. Holding the guard up would only trap the player
    // in a tab that can no longer help anybody.
    expect(result.current.owedMoveProofs).toBe(0);
  });
});
