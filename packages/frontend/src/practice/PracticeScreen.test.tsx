/**
 * PracticeScreen presentation + the main-menu entry point. The game loop
 * itself is covered by usePractice.test.ts; here usePractice is mocked to
 * pin the screen's render branches (difficulty picker → game → end overlay)
 * and GameScreen3D is stubbed so no WebGL/R3F runs under jsdom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Stub the 3D game screen — we only assert it mounts, not how it renders.
vi.mock('../components3d/GameScreen3D', () => ({
  GameScreen3D: (props: any) => (
    <div data-testid="game-screen-3d" data-practice-mode={String(props.practiceMode)} />
  ),
}));

const mockPractice = {
  difficulty: 'greedy' as const,
  setDifficulty: vi.fn(),
  started: false,
  gameState: null as any,
  lastCaptures: [],
  gameOver: null as any,
  result: null as any,
  playerScore: 5,
  botScore: 5,
  isBotThinking: false,
  start: vi.fn(),
  handlePlaceCard: vi.fn(),
  playAgain: vi.fn(),
  changeDifficulty: vi.fn(),
};

vi.mock('./usePractice', () => ({
  usePractice: () => mockPractice,
}));

import { PracticeScreen } from './PracticeScreen';
import { MainMenu } from '../components/MainMenu';

function resetPractice(overrides: Partial<typeof mockPractice> = {}) {
  Object.assign(mockPractice, {
    difficulty: 'greedy', setDifficulty: vi.fn(), started: false,
    gameState: null, lastCaptures: [], gameOver: null, result: null,
    playerScore: 5, botScore: 5, isBotThinking: false,
    start: vi.fn(), handlePlaceCard: vi.fn(), playAgain: vi.fn(), changeDifficulty: vi.fn(),
  }, overrides);
}

const PLAYABLE_STATE = {
  board: Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ card: null, owner: null, originalOwner: null }))),
  player1Hand: [{ id: 1, name: 'A', ranks: { top: 1, right: 1, bottom: 1, left: 1 } }],
  player2Hand: [{ id: 2, name: 'B', ranks: { top: 1, right: 1, bottom: 1, left: 1 } }],
  currentTurn: 'player1' as const,
  player1Score: 5, player2Score: 5, status: 'playing' as const, winner: null,
};

describe('PracticeScreen difficulty selection', () => {
  beforeEach(() => resetPractice());

  it('shows the three difficulty tiers and a start button', () => {
    render(<PracticeScreen onExit={() => {}} />);
    expect(screen.getByTestId('practice-setup')).toBeTruthy();
    expect(screen.getByTestId('practice-tier-random')).toBeTruthy();
    expect(screen.getByTestId('practice-tier-greedy')).toBeTruthy();
    expect(screen.getByTestId('practice-tier-lookahead')).toBeTruthy();
    expect(screen.getByTestId('practice-start')).toBeTruthy();
  });

  it('selecting a tier calls setDifficulty; Start begins the match', () => {
    render(<PracticeScreen onExit={() => {}} />);
    fireEvent.click(screen.getByTestId('practice-tier-lookahead'));
    expect(mockPractice.setDifficulty).toHaveBeenCalledWith('lookahead');
    fireEvent.click(screen.getByTestId('practice-start'));
    expect(mockPractice.start).toHaveBeenCalled();
  });

  it('Back to Menu from the picker calls onExit', () => {
    const onExit = vi.fn();
    render(<PracticeScreen onExit={onExit} />);
    fireEvent.click(screen.getByText('Back to Menu'));
    expect(onExit).toHaveBeenCalled();
  });
});

describe('PracticeScreen live game', () => {
  beforeEach(() => resetPractice({ started: true, gameState: PLAYABLE_STATE }));

  it('mounts GameScreen3D in practice mode with no end overlay while playing', () => {
    render(<PracticeScreen onExit={() => {}} />);
    const screen3d = screen.getByTestId('game-screen-3d');
    expect(screen3d).toBeTruthy();
    expect(screen3d.getAttribute('data-practice-mode')).toBe('true');
    expect(screen.queryByTestId('practice-end')).toBeNull();
  });
});

describe('PracticeScreen end overlay', () => {
  it.each([
    ['win', 'You Win!'],
    ['loss', 'You Lose!'],
    ['draw', 'Draw!'],
  ] as const)('shows the %s result and wires the buttons', (result, text) => {
    const onExit = vi.fn();
    resetPractice({
      started: true,
      gameState: { ...PLAYABLE_STATE, status: 'finished', winner: result === 'win' ? 'player1' : result === 'loss' ? 'player2' : 'draw' },
      gameOver: { winner: result === 'win' ? 'player1' : result === 'loss' ? 'player2' : 'draw' },
      result,
      playerScore: 6, botScore: 4,
    });

    render(<PracticeScreen onExit={onExit} />);
    expect(screen.getByTestId('practice-end')).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getByText(/You 6 . 4 Bot/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('practice-play-again'));
    expect(mockPractice.playAgain).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('practice-change-difficulty'));
    expect(mockPractice.changeDifficulty).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Back to Menu'));
    expect(onExit).toHaveBeenCalled();
  });
});

describe('main-menu practice entry', () => {
  it('the Practice button calls onPractice', () => {
    const onPractice = vi.fn();
    render(
      <MainMenu
        connected aztecConnecting={false} aztecReady cardCount={0} tokenBalance={0}
        accountAddress={null} hasGameInProgress={false}
        stuckGame={null}
        isRecovering={false}
        onRecoverStuckGame={() => {}}
        onContestClaim={() => {}}
        onPlay={() => {}} onTutorial={() => {}} onPractice={onPractice} onCardPacks={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('Practice vs Bot'));
    expect(onPractice).toHaveBeenCalled();
  });
});
