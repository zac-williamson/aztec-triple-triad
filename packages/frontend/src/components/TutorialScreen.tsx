import { useState, useEffect, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { GameScreen3D } from '../components3d/GameScreen3D';
import { TutorialHUD } from '../components3d/TutorialHUD';
import { PackOpening } from './PackOpening';
import { SparkBurst } from '../components3d/SparkBurst';
import { useTutorial } from '../tutorial/useTutorial';
import { STARTER_CARD_IDS, STARTER_TOKEN_REWARD } from '../aztec/gameConstants';

interface TutorialScreenProps {
  onExit: () => void;
}

type RewardPhase = 'idle' | 'shudder' | 'explosion' | 'dialog';

function CoinExplosion() {
  return (
    <>
      <ambientLight intensity={0.5} />
      <SparkBurst position={[0, 0, 0]} color="#ffcc00" count={80} duration={1.4} />
      <SparkBurst position={[0.1, 0.1, -0.1]} color="#ffaa00" count={50} duration={1.1} />
      <SparkBurst position={[-0.1, -0.1, 0.1]} color="#ffffff" count={25} duration={0.9} />
    </>
  );
}

function TokenRewardScreen({ onContinue }: { onContinue: () => void }) {
  const [phase, setPhase] = useState<RewardPhase>('idle');

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('shudder'), 600);
    const t2 = setTimeout(() => setPhase('explosion'), 2200);
    const t3 = setTimeout(() => setPhase('dialog'), 3600);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column',
      background: 'rgba(10, 18, 10, 0.95)',
    }}>
      {/* Moneybag phases */}
      {(phase === 'idle' || phase === 'shudder') && (
        <div style={{
          fontSize: 120,
          lineHeight: 1,
          filter: 'drop-shadow(0 0 30px rgba(255, 204, 0, 0.4))',
          animation: phase === 'shudder' ? 'moneybag-shudder 1.6s ease-in-out forwards' : 'moneybag-idle 2s ease-in-out infinite',
        }}>
          💰
        </div>
      )}

      {/* Explosion */}
      {phase === 'explosion' && (
        <div style={{ position: 'absolute', width: 400, height: 400, pointerEvents: 'none' }}>
          <Canvas camera={{ position: [0, 0, 2], fov: 60 }}>
            <Suspense fallback={null}>
              <CoinExplosion />
            </Suspense>
          </Canvas>
        </div>
      )}

      {/* Dialog */}
      {phase === 'dialog' && (
        <div className="parchment-dialog" style={{
          maxWidth: 400, textAlign: 'center',
          animation: 'token-dialog-appear 0.4s ease-out',
        }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>💰</div>
          <div className="parchment-dialog__title" style={{ fontSize: 22 }}>
            {STARTER_TOKEN_REWARD} coins to get you started!
          </div>
          <p style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: '#5a4a34', margin: '12px 0 24px' }}>
            Use coins to buy card packs and grow your collection. You earn 20 coins every game you play.
          </p>
          <button className="parchment-dialog__btn" onClick={onContinue}>
            Start Playing
          </button>
        </div>
      )}

      {/* Inline keyframes */}
      <style>{`
        @keyframes moneybag-idle {
          0%, 100% { transform: scale(1) rotate(0deg); }
          50% { transform: scale(1.03) rotate(1deg); }
        }
        @keyframes moneybag-shudder {
          0% { transform: translate(0,0) scale(1); filter: brightness(1) drop-shadow(0 0 30px rgba(255,204,0,0.4)); }
          10% { transform: translate(-3px,0) scale(1.02); }
          20% { transform: translate(4px,0) scale(1.04); }
          30% { transform: translate(-5px,1px) scale(1.06); filter: brightness(1.1); }
          40% { transform: translate(6px,-1px) scale(1.08); }
          50% { transform: translate(-7px,0) scale(1.1); filter: brightness(1.3); }
          60% { transform: translate(8px,1px) scale(1.12); }
          70% { transform: translate(-8px,-1px) scale(1.14); filter: brightness(1.5); }
          80% { transform: translate(6px,0) scale(1.16); filter: brightness(1.8); }
          90% { transform: translate(-4px,0) scale(1.18); filter: brightness(2.2); }
          100% { transform: translate(0,0) scale(1.3); filter: brightness(3); opacity: 0; }
        }
        @keyframes token-dialog-appear {
          from { transform: scale(0.8); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

export function TutorialScreen({ onExit }: TutorialScreenProps) {
  const tutorial = useTutorial(onExit);
  const [showTokenReward, setShowTokenReward] = useState(false);

  // ── Token reward animation (shown after pack opening) ─────────────────
  if (showTokenReward) {
    return (
      <TokenRewardScreen onContinue={() => {
        localStorage.setItem('tutorial_completed', 'true');
        onExit();
      }} />
    );
  }

  // ── Starter pack opening ──────────────────────────────────────────────
  if (tutorial.phase === 'starter-pack') {
    return (
      <PackOpening
        location="Starter Pack"
        cardIds={STARTER_CARD_IDS}
        onComplete={() => setShowTokenReward(true)}
      />
    );
  }

  if (!tutorial.gameState) {
    return (
      <div style={{
        position: 'fixed', inset: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: '#0a1a0a',
      }}>
        <div style={{ color: '#c8a860', fontFamily: "'Cinzel', serif" }}>Loading tutorial...</div>
      </div>
    );
  }

  // Collect opponent's board cards for the win-card picker
  const xochitlBoardCards = tutorial.gameState.board.flat()
    .filter(cell => cell.card && cell.originalOwner === 'player2')
    .map(cell => cell.card!);

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <GameScreen3D
        gameState={tutorial.gameState}
        playerNumber={1}
        gameId="tutorial"
        lastCaptures={tutorial.lastCaptures}
        gameOver={tutorial.gameOver}
        opponentDisconnected={false}
        onPlaceCard={tutorial.handlePlaceCard}
        onBackToLobby={tutorial.handleSkip}
        tutorialHighlightCells={tutorial.tutorialHighlightCells}
        tutorialPulseHandIndex={tutorial.tutorialPulseHandIndex}
        xochitlRevealCount={tutorial.xochitlRevealCount}
      />

      <TutorialHUD
        currentScene={tutorial.currentScene}
        displayedText={tutorial.displayedText}
        isTyping={tutorial.isTyping}
        showContinueButton={tutorial.showContinueButton}
        tutorialResult={tutorial.tutorialResult}
        isComplete={tutorial.isComplete}
        phase={tutorial.phase}
        gameOver={tutorial.gameOver}
        xochitlBoardCards={xochitlBoardCards}
        onContinue={tutorial.handleContinue}
        onSkipTypewriter={tutorial.handleSkipTypewriter}
        onAdvanceDialogue={tutorial.handleAdvanceDialogue}
        onSelectWinCard={tutorial.handleSelectWinCard}
        onSkip={tutorial.handleSkip}
        onPlayAgain={tutorial.handlePlayAgain}
        onExitToMenu={tutorial.handleExitToMenu}
        onStartTimmy={tutorial.handleStartTimmy}
      />
    </div>
  );
}
