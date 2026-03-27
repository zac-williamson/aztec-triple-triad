import type { TutorialResult, TutorialPhase } from '../tutorial/useTutorial';
import type { TutorialScene } from '../tutorial/tutorialScript';
import type { Card } from '../types';

interface TutorialHUDProps {
  currentScene: TutorialScene | null;
  displayedText: string;
  isTyping: boolean;
  showContinueButton: boolean;
  tutorialResult: TutorialResult;
  isComplete: boolean;
  phase: TutorialPhase;
  gameOver: { winner: string } | null;
  /** Cards opponent placed on the board (for win card picker) */
  xochitlBoardCards: Card[];
  onContinue: () => void;
  onSkipTypewriter: () => void;
  onAdvanceDialogue: () => void;
  onSelectWinCard: (cardId: number) => void;
  onSkip: () => void;
  onPlayAgain: () => void;
  onExitToMenu: () => void;
  onStartTimmy: () => void;
}

const SPEAKERS = {
  xochitl: { name: 'Xochitl', emoji: '🐊', bg: 'radial-gradient(circle at 35% 35%, #C8904A, #7A4A18)' },
  timmy:   { name: 'Timmy',   emoji: '🧒', bg: 'radial-gradient(circle at 35% 35%, #6AB4E8, #2868A0)' },
} as const;

export function TutorialHUD({
  currentScene,
  displayedText,
  isTyping,
  showContinueButton,
  tutorialResult,
  isComplete,
  phase,
  gameOver,
  xochitlBoardCards,
  onContinue,
  onSkipTypewriter,
  onAdvanceDialogue,
  onSelectWinCard,
  onSkip,
  onPlayAgain,
  onExitToMenu,
  onStartTimmy,
}: TutorialHUDProps) {

  // ── Phase transition modal (between Xochitl and Timmy) ─────────────────
  if (phase === 'transition') {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.7)',
      }}>
        <div className="parchment-dialog" style={{ maxWidth: 460, textAlign: 'center' }}>
          <div className="parchment-dialog__title">Lesson Over</div>

          <div style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: '#5a4a34', lineHeight: 1.7, margin: '12px 0 20px' }}>
            <div>"You know the rules now. But knowing is not the same as winning."</div>
            <div>"There is a boy at the edge of the swamp. Timmy. He talks a lot."</div>
            <div>"He would be... good practice."</div>
          </div>

          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexDirection: 'column', alignItems: 'center' }}>
            <button className="parchment-dialog__btn" onClick={onStartTimmy}>
              Challenge Timmy
            </button>
            <button
              className="parchment-dialog__btn"
              style={{ background: 'rgba(90,74,52,0.3)' }}
              onClick={onExitToMenu}
            >
              Play a Real Game
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Summary modal (shown after phase 2 ends) ──────────────────────────
  if (isComplete) {
    const isTimmy = phase === 'timmy';
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.7)',
      }}>
        <div className="parchment-dialog" style={{ maxWidth: 440, textAlign: 'center' }}>
          <div className="parchment-dialog__title">Tutorial Complete</div>

          <div style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: '#5a4a34', lineHeight: 1.7, margin: '12px 0 20px' }}>
            {isTimmy ? (
              <>
                <div>"See? Even Timmy's legendary cards couldn't stop you."</div>
                <div>"You are ready for the real thing."</div>
              </>
            ) : (
              <>
                <div>"Nine cells. Five cards each. Alternate turns."</div>
                <div>"Place a card — if its touching rank beats its neighbour's matching rank, you capture it."</div>
                <div>"Fill the board. Count your colour. Most cards wins."</div>
                <div>"Winner takes one card. Loser learns."</div>
              </>
            )}
          </div>

          <p style={{ fontFamily: "'Cinzel', serif", fontSize: 13, color: '#8a7a64', marginBottom: 24 }}>
            "Now go find someone else to beat. The swamp has more players than you think."
          </p>

          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button className="parchment-dialog__btn" onClick={onExitToMenu}>
              Play a Real Game
            </button>
            <button
              className="parchment-dialog__btn"
              style={{ background: 'rgba(90,74,52,0.3)' }}
              onClick={onPlayAgain}
            >
              Play Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Win card picker ────────────────────────────────────────────────────
  if (tutorialResult === 'player_win' && gameOver) {
    const isTimmy = phase === 'timmy';
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.7)',
      }}>
        <div className="parchment-dialog" style={{ maxWidth: 480, textAlign: 'center' }}>
          <div className="parchment-dialog__title">You Win!</div>
          <p style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: '#5a4a34', marginBottom: 8 }}>
            {isTimmy
              ? '"What?! No way! My legendary cards...! Well... I guess they were just a boot and a cat."'
              : '"You counted well. Most newcomers forget the hand cards."'
            }
          </p>
          <p style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: '#5a4a34', marginBottom: 20 }}>
            {isTimmy
              ? '"Fine. Take one. But I want a rematch someday!"'
              : '"You win. Choose one of my cards."'
            }
          </p>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
            {xochitlBoardCards.map(card => (
              <button
                key={card.id}
                onClick={() => onSelectWinCard(card.id)}
                style={{
                  background: 'rgba(90,60,20,0.4)',
                  border: '2px solid rgba(180,140,60,0.5)',
                  borderRadius: 8,
                  padding: '8px 14px',
                  color: '#f8e6b2',
                  fontFamily: "'Cinzel', serif",
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                {card.name}
              </button>
            ))}
          </div>

          <p style={{ fontFamily: "'Cinzel', serif", fontSize: 12, color: '#8a7a64' }}>
            (Tutorial cards are not added to your collection — this is just for practice!)
          </p>
        </div>
      </div>
    );
  }

  // ── Loss / draw result ─────────────────────────────────────────────────
  if ((tutorialResult === 'xochitl_win' || tutorialResult === 'draw') && gameOver) {
    const isTimmy = phase === 'timmy';
    const title = tutorialResult === 'draw'
      ? 'Equal.'
      : isTimmy ? 'Timmy wins?!' : 'The board does not lie.';
    const body = tutorialResult === 'draw'
      ? '"In a draw, no cards are exchanged. The game simply... ends."'
      : isTimmy
        ? '"YES!! I won!! I mean — of course I won. My deck is legendary. ...Please don\'t tell Xochitl."'
        : '"You played well in places. But you hesitated too long in the middle. Do not be downcast. You learned today."';

    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.7)',
      }}>
        <div className="parchment-dialog" style={{ maxWidth: 440, textAlign: 'center' }}>
          <div className="parchment-dialog__title">{title}</div>
          <p style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: '#5a4a34', margin: '12px 0 24px' }}>
            {body}
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button className="parchment-dialog__btn" onClick={() => onSelectWinCard(0)}>
              Continue
            </button>
            <button
              className="parchment-dialog__btn"
              style={{ background: 'rgba(90,74,52,0.3)' }}
              onClick={onPlayAgain}
            >
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Dialogue panel ─────────────────────────────────────────────────────
  const speaker = SPEAKERS[currentScene?.speaker ?? 'xochitl'];

  return (
    <>
      {/* Skip button */}
      <button
        onClick={onSkip}
        style={{
          position: 'fixed', top: 8, right: 16, zIndex: 40,
          background: 'rgba(30,12,3,0.8)',
          border: '1px solid rgba(180,140,60,0.4)',
          borderRadius: 6,
          padding: '6px 14px',
          color: '#c8a860',
          fontFamily: "'Cinzel', serif",
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        Skip Tutorial
      </button>

      {/* Dialogue box */}
      {currentScene && (
        <div
          onClick={onAdvanceDialogue}
          style={{
            position: 'fixed', top: 48, left: '50%', transform: 'translateX(-50%)',
            width: 'min(700px, calc(100vw - 32px))',
            zIndex: 40,
            display: 'flex', alignItems: 'center', gap: 16,
            background: 'rgba(20,10,5,0.88)',
            border: '2px solid rgba(180,140,60,0.45)',
            borderRadius: 12,
            padding: '14px 20px',
            cursor: 'pointer',
          }}
        >
          {/* Speaker portrait */}
          <div style={{
            width: 56, height: 56, flexShrink: 0,
            borderRadius: '50%',
            background: speaker.bg,
            border: '2px solid rgba(30,12,3,0.9)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 28,
          }}>
            {speaker.emoji}
          </div>

          <div style={{ flex: 1 }}>
            <div style={{
              fontFamily: "'Cinzel', serif",
              fontSize: 12,
              color: '#c8a860',
              marginBottom: 4,
              letterSpacing: '0.08em',
            }}>
              {speaker.name}
            </div>
            <div style={{
              fontFamily: "'Cinzel', serif",
              fontSize: 15,
              color: '#f0deb8',
              lineHeight: 1.55,
              minHeight: 24,
            }}>
              {displayedText}
              {isTyping && <span style={{ opacity: 0.5 }}>▋</span>}
            </div>
          </div>

          {/* Continue / wait indicator */}
          <div style={{ flexShrink: 0, width: 32, textAlign: 'center' }}>
            {isTyping && (
              <span style={{ color: '#8a7a64', fontSize: 18 }}>…</span>
            )}
            {!isTyping && showContinueButton && (
              <button
                onClick={(e) => { e.stopPropagation(); onContinue(); }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#c8a860',
                  fontSize: 22,
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                ▶
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
