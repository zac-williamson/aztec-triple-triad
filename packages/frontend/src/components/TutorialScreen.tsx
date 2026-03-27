import { GameScreen3D } from '../components3d/GameScreen3D';
import { TutorialHUD } from '../components3d/TutorialHUD';
import { PackOpening } from './PackOpening';
import { useTutorial } from '../tutorial/useTutorial';
import { STARTER_CARD_IDS } from '../aztec/gameConstants';

interface TutorialScreenProps {
  onExit: () => void;
}

export function TutorialScreen({ onExit }: TutorialScreenProps) {
  const tutorial = useTutorial(onExit);

  // ── Starter pack opening ──────────────────────────────────────────────
  if (tutorial.phase === 'starter-pack') {
    return (
      <PackOpening
        location="Starter Pack"
        cardIds={STARTER_CARD_IDS}
        onComplete={() => {
          localStorage.setItem('tutorial_completed', 'true');
          onExit();
        }}
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
