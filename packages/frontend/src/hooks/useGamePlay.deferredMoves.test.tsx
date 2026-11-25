/**
 * Deferred move processing must replay each queued move against the board the
 * player ACTUALLY acted on — captured at queue time — not a board derived from
 * the (later-advanced) ws.gameState.
 *
 * The bug (playtest, 4.3.1): the deferred processor rebuilt the board from a
 * move-count-keyed history map that, under 4.3.1 broadcast timing, returned a
 * board already containing the queued card → game_move rejected "Card already
 * placed" → the winner never reached 9/9 proofs → no settlement. This test
 * advances ws.gameState so the placed cell is OCCUPIED before the deferred
 * processor runs; the proof must still be generated against the empty
 * pre-move cell.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Board, Card, GameState } from '../types';

const generateMoveProof = vi.fn();

vi.mock('./useProofGeneration', () => ({
  useProofGeneration: () => ({ generateMoveProof, reset: vi.fn() }),
}));


vi.mock('../aztec/AztecContext', () => ({
  useAztecContext: () => ({ isAvailable: true }),
}));

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

function playingState(board: Board): GameState {
  return {
    board,
    player1Hand: [card(5), card(6), card(7), card(8), card(9)],
    player2Hand: [card(10), card(11), card(12), card(13), card(14)],
    currentTurn: 'player1',
    player1Score: 5,
    player2Score: 5,
    status: 'playing',
    winner: null,
  };
}

function makeWs(gameState: GameState, overrides: Partial<UseWebSocketReturn> = {}): UseWebSocketReturn {
  return {
    gameId: 'game-1',
    playerNumber: 1,
    gameState,
    lastMoveProof: null,
    placeCard: vi.fn(),
    submitMoveProof: vi.fn(),
    ...overrides,
  } as unknown as UseWebSocketReturn;
}

describe('useGamePlay deferred move processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateMoveProof.mockResolvedValue({
      proof: 'mp', publicInputs: ['0xC1', '0xC2', '0xs', '0xe', '0', '0'],
      cardCommit1: '0xC1', cardCommit2: '0xC2', startStateHash: '0xs', endStateHash: '0xe',
      gameEnded: false, winnerId: 0,
    });
  });

  it('replays a queued move against the queue-time board even after ws.gameState advances over the placed cell', async () => {
    const cardIds = [5, 6, 7, 8, 9];
    const blindingFactor = '0xBF';

    // 1. Commitments not known yet (the joiner's record has not arrived).
    const ws0 = makeWs(playingState(emptyBoard()));
    const submitMoveProof = ws0.submitMoveProof as ReturnType<typeof vi.fn>;

    const { result, rerender } = renderHook(
      ({ ws, commits }) => useGamePlay({ ws, cardIds, blindingFactor, commits }),
      { initialProps: { ws: ws0, commits: null as { commit1: string; commit2: string } | null } },
    );

    // 2. Player places card 5 at (2,2) on the empty board → queued (no proofs).
    await act(async () => { await result.current.handlePlaceCard(0, 2, 2); });
    expect(ws0.placeCard).toHaveBeenCalledWith(0, 2, 2);
    expect(submitMoveProof).not.toHaveBeenCalled(); // queued, not proven yet

    // 3. Backend echoes the move back: ws.gameState now HAS card 5 at (2,2).
    //    (This is the state the buggy history lookup would have reflected.)
    const advanced = emptyBoard();
    advanced[2][2] = { card: card(5), owner: 'player1', originalOwner: 'player1' };
    const ws1 = makeWs(playingState(advanced));
    await act(async () => { rerender({ ws: ws1, commits: null }); });

    // 4. Both records known → the deferred processor runs.
    const ws2 = makeWs(playingState(advanced), { submitMoveProof });
    await act(async () => {
      rerender({ ws: ws2, commits: { commit1: '0xC1', commit2: '0xC2' } });
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
    });

    // The deferred move was proven (winner can still reach 9/9) ...
    expect(generateMoveProof).toHaveBeenCalledTimes(1);
    expect(submitMoveProof).toHaveBeenCalledWith('game-1', 0, 2, 2, expect.anything(), 0);

    // ... against the EMPTY pre-move cell, not the advanced board that holds
    // card 5 at (2,2). boardBefore is generateMoveProof arg index 4.
    const boardBefore = generateMoveProof.mock.calls[0][4] as Board;
    expect(boardBefore[2][2].card).toBeNull();
    // boardAfter (arg 5) is where the card lands.
    const boardAfter = generateMoveProof.mock.calls[0][5] as Board;
    expect(boardAfter[2][2].card?.id).toBe(5);
  });
});
