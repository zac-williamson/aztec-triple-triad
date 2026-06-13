import { GameScreen3D } from '../components3d/GameScreen3D';
import { usePractice, type BotDifficulty } from './usePractice';
import './PracticeScreen.css';

interface PracticeScreenProps {
  onExit: () => void;
}

const DIFFICULTIES: { id: BotDifficulty; label: string; blurb: string }[] = [
  { id: 'random', label: 'Novice', blurb: 'Plays a random legal move. Good for learning the board.' },
  { id: 'greedy', label: 'Skilled', blurb: 'Grabs the most captures each turn and guards its edges.' },
  { id: 'lookahead', label: 'Master', blurb: 'Thinks a move ahead — weighs your best reply before committing.' },
];

export function PracticeScreen({ onExit }: PracticeScreenProps) {
  const practice = usePractice();

  // ── Difficulty selection ────────────────────────────────────────────────
  if (!practice.started) {
    return (
      <div className="practice-setup" data-testid="practice-setup">
        <div className="app__bg" />
        <div className="practice-setup__panel">
          <h1 className="practice-setup__title">Practice Match</h1>
          <p className="practice-setup__subtitle">
            Play a full game against the house bot. No chain, no stakes — just practice.
          </p>

          <div className="practice-setup__tiers">
            {DIFFICULTIES.map(d => (
              <button
                key={d.id}
                className={`practice-tier ${practice.difficulty === d.id ? 'practice-tier--active' : ''}`}
                onClick={() => practice.setDifficulty(d.id)}
                aria-pressed={practice.difficulty === d.id}
                data-testid={`practice-tier-${d.id}`}
              >
                <span className="practice-tier__label">{d.label}</span>
                <span className="practice-tier__blurb">{d.blurb}</span>
              </button>
            ))}
          </div>

          <div className="practice-setup__actions">
            <button className="parchment-dialog__btn" onClick={practice.start} data-testid="practice-start">
              Start Match
            </button>
            <button className="btn btn--ghost" onClick={onExit}>
              Back to Menu
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Live game ───────────────────────────────────────────────────────────
  if (!practice.gameState) return null;

  const resultText =
    practice.result === 'win' ? 'You Win!' :
    practice.result === 'loss' ? 'You Lose!' :
    practice.result === 'draw' ? 'Draw!' : '';

  return (
    <div style={{ position: 'fixed', inset: 0 }} data-testid="practice-game">
      <GameScreen3D
        gameState={practice.gameState}
        playerNumber={1}
        gameId="practice"
        lastCaptures={practice.lastCaptures}
        gameOver={practice.gameOver}
        opponentDisconnected={false}
        onPlaceCard={practice.handlePlaceCard}
        onBackToLobby={onExit}
        practiceMode
      />

      {practice.gameOver && (
        <div className="practice-end" data-testid="practice-end">
          <div className="parchment-dialog practice-end__dialog">
            <div className={`parchment-dialog__title practice-end__title practice-end__title--${practice.result}`}>
              {resultText}
            </div>
            <div className="practice-end__score">
              You {practice.playerScore} &ndash; {practice.botScore} Bot
            </div>
            <div className="practice-end__buttons">
              <button className="parchment-dialog__btn" onClick={practice.playAgain} data-testid="practice-play-again">
                Play Again
              </button>
              <button className="btn btn--ghost" onClick={practice.changeDifficulty} data-testid="practice-change-difficulty">
                Change Difficulty
              </button>
              <button className="btn btn--ghost" onClick={onExit}>
                Back to Menu
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
