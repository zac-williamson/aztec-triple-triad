/**
 * Immediate (proofs-ready) move proofs — the joiner's path. Move-proof
 * generation is async/queued, so handlePlaceCard must hand it a DEEP CLONE of
 * the pre-move board captured at click time, never the live ws.gameState.board.
 *
 * The bug (playtest attempt-4): P2/the joiner moves with both hand proofs ready
 * and hit the immediate path, which passed the live board reference into the
 * async proof encoder. A later board update then changed what the proof
 * encoded → game_move "Card already placed" → P2 generated 0/4 proofs → the
 * winner never reached 9/9 → settlement timed out. This test mutates the live
 * board after the click and asserts the proof's boardBefore is unaffected.
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

// P2 (joiner) acts after P1's move 1: the board already has P1's card at (0,0).
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
    gameId: 'game-1',
    playerNumber: 2, // the joiner
    gameState,
    opponentGameRandomness: ['0x1', '0x2', '0x3', '0x4', '0x5', '0x6'],
    opponentHandProof: { proof: 'ohp', publicInputs: ['0xC2', '0x0'], cardCommit: '0xC2' },
    lastMoveProof: null,
    placeCard: vi.fn(),
    submitMoveProof: vi.fn(),
    submitHandProof: vi.fn(),
    ...overrides,
  } as unknown as UseWebSocketReturn;
}

describe('useGamePlay immediate (joiner) move proofs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateHandProof.mockResolvedValue({ proof: 'hp', publicInputs: ['0xC1', '0x0'], cardCommit: '0xC1' });
    generateMoveProof.mockResolvedValue({
      proof: 'mp', publicInputs: ['0xC1', '0xC2', '0xs', '0xe', '0', '0'],
      cardCommit1: '0xC1', cardCommit2: '0xC2', startStateHash: '0xs', endStateHash: '0xe',
      gameEnded: false, winnerId: 0,
    });
  });

  it('passes a cloned pre-move board that a later in-place board mutation cannot corrupt', async () => {
    const ws = makeWs(joinerPreMoveState());
    const submitMoveProof = ws.submitMoveProof as ReturnType<typeof vi.fn>;

    const { result } = renderHook(() => useGamePlay({ ws, cardIds: [10, 11, 12, 13, 14], blindingFactor: '0xBF' }));

    // Both hand proofs ready (opponent from ws, own auto-generated) → immediate path.
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    // P2 places card 10 at (1,1) — an empty cell.
    await act(async () => { await result.current.handlePlaceCard(0, 1, 1); });

    expect(generateMoveProof).toHaveBeenCalledTimes(1);
    const boardBefore = generateMoveProof.mock.calls[0][4] as Board;
    expect(boardBefore[1][1].card).toBeNull();      // pre-move: target empty
    expect(boardBefore[0][0].card?.id).toBe(1);     // P1's card present (chain link)

    // Simulate the async encoder lagging while the live board updates in place —
    // e.g. the backend echo / an animation touching ws.gameState.board.
    ws.gameState!.board[1][1] = { card: card(10), owner: 'player2', originalOwner: 'player2' };

    // The captured boardBefore is a clone — unaffected, so the proof still
    // encodes the empty pre-move cell (no "Card already placed").
    expect(boardBefore[1][1].card).toBeNull();

    expect(submitMoveProof).toHaveBeenCalledWith('game-1', 0, 1, 1, expect.anything(), 1);
  });
});
