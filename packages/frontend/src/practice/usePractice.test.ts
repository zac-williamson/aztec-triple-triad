/**
 * Practice-mode hook — the tutorial's local loop generalized to an
 * unscripted full game vs chooseBotMove. Verifies the bot auto-plays,
 * the game runs to a real win/loss/draw with no chain/backend, and that a
 * fixed seed makes the whole match reproducible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePractice } from './usePractice';
import type { GameState } from '../types';

/** First empty cell, scanning row-major. */
function firstEmptyCell(gs: GameState): { row: number; col: number } {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (!gs.board[r][c].card) return { row: r, col: c };
    }
  }
  throw new Error('board full');
}

/** Let the pending bot move (setTimeout) run. */
async function flushBot() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}

/** Human plays handIndex 0 at the first empty cell, then the bot replies. */
async function playOneRound(result: { current: ReturnType<typeof usePractice> }) {
  const gs = result.current.gameState!;
  const cell = firstEmptyCell(gs);
  await act(async () => { result.current.handlePlaceCard(0, cell.row, cell.col); });
  await flushBot();
}

describe('usePractice', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts at difficulty selection with no game', () => {
    const { result } = renderHook(() => usePractice({ seed: 1, botDelayMs: 0 }));
    expect(result.current.started).toBe(false);
    expect(result.current.gameState).toBeNull();
    expect(result.current.difficulty).toBe('greedy');
  });

  it('start() deals two 5-card hands and the human (player1) moves first', () => {
    const { result } = renderHook(() => usePractice({ seed: 7, botDelayMs: 0 }));
    act(() => { result.current.start(); });

    const gs = result.current.gameState!;
    expect(result.current.started).toBe(true);
    expect(gs.player1Hand).toHaveLength(5);
    expect(gs.player2Hand).toHaveLength(5);
    expect(gs.currentTurn).toBe('player1');
    expect(gs.status).toBe('playing');
    // distinct cards across both hands
    const ids = [...gs.player1Hand, ...gs.player2Hand].map(c => c.id);
    expect(new Set(ids).size).toBe(10);
  });

  it('the bot auto-plays after the human move, returning the turn to the human', async () => {
    const { result } = renderHook(() => usePractice({ seed: 3, botDelayMs: 0 }));
    act(() => { result.current.setDifficulty('greedy'); result.current.start(); });

    const cell = firstEmptyCell(result.current.gameState!);
    await act(async () => { result.current.handlePlaceCard(0, cell.row, cell.col); });

    // Immediately after the human move it is the bot's turn and the board is locked.
    expect(result.current.gameState!.currentTurn).toBe('player2');
    expect(result.current.isBotThinking).toBe(true);

    await flushBot();

    // Bot has played; two cards on the board; control back to the human.
    const occupied = result.current.gameState!.board.flat().filter(c => c.card).length;
    expect(occupied).toBe(2);
    expect(result.current.gameState!.currentTurn).toBe('player1');
    expect(result.current.isBotThinking).toBe(false);
  });

  it('the human cannot move during the bot\'s turn', async () => {
    const { result } = renderHook(() => usePractice({ seed: 5, botDelayMs: 10 }));
    act(() => { result.current.start(); });

    const cell = firstEmptyCell(result.current.gameState!);
    await act(async () => { result.current.handlePlaceCard(0, cell.row, cell.col); });
    expect(result.current.isBotThinking).toBe(true);

    // Attempt a second human move while the bot timer is pending — ignored.
    const next = firstEmptyCell(result.current.gameState!);
    await act(async () => { result.current.handlePlaceCard(0, next.row, next.col); });
    expect(result.current.gameState!.board.flat().filter(c => c.card).length).toBe(1);
  });

  it('runs a full game to a real result with scores summing to 10', async () => {
    const { result } = renderHook(() => usePractice({ seed: 42, botDelayMs: 0 }));
    act(() => { result.current.start(); });

    // 5 human rounds fill the 9-cell board (human plays cells 1,3,5,7,9).
    for (let i = 0; i < 5 && !result.current.gameOver; i++) {
      await playOneRound(result);
    }

    expect(result.current.gameOver).not.toBeNull();
    expect(result.current.gameState!.status).toBe('finished');
    expect(['win', 'loss', 'draw']).toContain(result.current.result);
    // Triple Triad: controlled cards (board + remaining hand) always total 10.
    expect(result.current.playerScore + result.current.botScore).toBe(10);
  });

  it('is fully reproducible for a fixed seed (same deal + same bot play)', async () => {
    const runGame = async (seed: number) => {
      const { result } = renderHook(() => usePractice({ seed, botDelayMs: 0 }));
      act(() => { result.current.setDifficulty('lookahead'); result.current.start(); });
      for (let i = 0; i < 5 && !result.current.gameOver; i++) {
        await playOneRound(result);
      }
      return result.current.gameState!;
    };

    const a = await runGame(123);
    const b = await runGame(123);

    expect(b.player1Score).toBe(a.player1Score);
    expect(b.player2Score).toBe(a.player2Score);
    expect(b.winner).toBe(a.winner);
    // Identical board occupancy by id + owner.
    const flat = (gs: GameState) => gs.board.flat().map(c => `${c.card?.id ?? 0}:${c.owner ?? '-'}`).join(',');
    expect(flat(b)).toBe(flat(a));
  });

  it('different seeds can produce different games', async () => {
    const flat = (gs: GameState) => gs.board.flat().map(c => `${c.card?.id ?? 0}:${c.owner ?? '-'}`).join(',');
    const runGame = async (seed: number) => {
      const { result } = renderHook(() => usePractice({ seed, botDelayMs: 0 }));
      act(() => { result.current.start(); });
      for (let i = 0; i < 5 && !result.current.gameOver; i++) await playOneRound(result);
      return flat(result.current.gameState!);
    };
    // Two unrelated seeds: deals differ, so the boards differ.
    expect(await runGame(1)).not.toBe(await runGame(99999));
  });

  it('changeDifficulty returns to selection and clears the game', async () => {
    const { result } = renderHook(() => usePractice({ seed: 2, botDelayMs: 0 }));
    act(() => { result.current.start(); });
    expect(result.current.started).toBe(true);

    act(() => { result.current.changeDifficulty(); });
    expect(result.current.started).toBe(false);
    expect(result.current.gameState).toBeNull();
    expect(result.current.gameOver).toBeNull();
  });

  it('playAgain re-deals a fresh in-progress game', async () => {
    const { result } = renderHook(() => usePractice({ seed: 8, botDelayMs: 0 }));
    act(() => { result.current.start(); });
    for (let i = 0; i < 5 && !result.current.gameOver; i++) await playOneRound(result);
    expect(result.current.gameOver).not.toBeNull();

    act(() => { result.current.playAgain(); });
    expect(result.current.gameOver).toBeNull();
    expect(result.current.gameState!.status).toBe('playing');
    expect(result.current.gameState!.board.flat().filter(c => c.card).length).toBe(0);
  });
});
