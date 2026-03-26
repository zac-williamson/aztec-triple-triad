interface TutorialPromptProps {
  onLearnToPlay: () => void;
  onSkip: () => void;
}

export function TutorialPrompt({ onLearnToPlay, onSkip }: TutorialPromptProps) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.65)',
    }}>
      <div className="parchment-dialog" style={{ maxWidth: 420, textAlign: 'center' }}>
        <div style={{
          width: 80, height: 80, borderRadius: '50%',
          margin: '0 auto 16px',
          background: 'radial-gradient(circle at 35% 35%, #C8904A, #7A4A18)',
          border: '3px solid rgba(30,12,3,0.9)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 36,
        }}>
          🐊
        </div>

        <div className="parchment-dialog__title" style={{ fontSize: 22 }}>
          First time here?
        </div>

        <p style={{
          fontFamily: "'Cinzel', serif", fontSize: 15, color: '#5a4a34',
          margin: '12px 0 20px', lineHeight: 1.5,
        }}>
          "So. A new soul wanders into my swamp. Let me show you the rules before I take your cards."
        </p>

        <p style={{
          fontFamily: "'Cinzel', serif", fontSize: 13, color: '#8a7a64',
          marginBottom: 24,
        }}>
          — Xochitl, Swamp Spirit
        </p>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button className="parchment-dialog__btn" onClick={onLearnToPlay}>
            Learn to Play
          </button>
          <button
            className="parchment-dialog__btn"
            style={{ background: 'rgba(90,74,52,0.3)' }}
            onClick={onSkip}
          >
            I Know the Rules
          </button>
        </div>
      </div>
    </div>
  );
}
