/**
 * GameHUD practiceMode: a local practice game has no settlement and no Arena
 * Tokens, so the on-chain game-over UI (settlement card-picker for a win,
 * "+20 Arena Tokens" result banner for a loss/draw) must be suppressed —
 * the practice screen renders its own end overlay instead.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GameHUD } from './GameHUD';
import type { GameState } from '../types';

function finishedState(winner: 'player1' | 'player2'): GameState {
  return {
    board: Array.from({ length: 3 }, () =>
      Array.from({ length: 3 }, () => ({ card: null, owner: null, originalOwner: null })),
    ),
    player1Hand: [],
    player2Hand: [],
    currentTurn: 'player1',
    player1Score: winner === 'player1' ? 6 : 4,
    player2Score: winner === 'player1' ? 4 : 6,
    status: 'finished',
    winner,
  };
}

const baseProps = {
  playerNumber: 1 as const,
  gameId: 'practice',
  opponentDisconnected: false,
  isMyTurn: false,
  isFinished: true,
  myPlayer: 'player1' as const,
  myScore: 6,
  opponentScore: 4,
  onBackToLobby: () => {},
};

describe('GameHUD practiceMode suppresses on-chain game-over UI', () => {
  it('loss banner ("Arena Tokens") shows without practiceMode, hidden with it', () => {
    const lost = finishedState('player2');
    const { rerender } = render(
      <GameHUD {...baseProps} gameState={lost} gameOver={{ winner: 'player2' }} myScore={4} opponentScore={6} />,
    );
    // Chain mode: the result banner with the token reward is shown.
    expect(screen.getByText(/Arena Tokens earned/)).toBeTruthy();

    rerender(
      <GameHUD {...baseProps} gameState={lost} gameOver={{ winner: 'player2' }} myScore={4} opponentScore={6} practiceMode />,
    );
    expect(screen.queryByText(/Arena Tokens earned/)).toBeNull();
    expect(screen.queryByText('You Lose!')).toBeNull();
  });

  it('winner settlement card-picker shows without practiceMode, hidden with it', () => {
    const won = finishedState('player1');
    // A winner with an onSettle handler normally sees the settlement card
    // picker, which renders the "You Win!" result text.
    const onSettle = () => {};
    const { rerender } = render(
      <GameHUD {...baseProps} gameState={won} gameOver={{ winner: 'player1' }} onSettle={onSettle} />,
    );
    expect(screen.getByText('You Win!')).toBeTruthy();

    rerender(
      <GameHUD {...baseProps} gameState={won} gameOver={{ winner: 'player1' }} onSettle={onSettle} practiceMode />,
    );
    expect(screen.queryByText('You Win!')).toBeNull();
  });
});
