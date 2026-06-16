import { useState } from 'react';
import { AztecProvider, useAztecContext } from './aztec/AztecContext';
import { useGame } from './hooks/useGame';
import { MenuScene } from './components3d/MenuScene';
import { MainMenu } from './components/MainMenu';
import { CardSelector } from './components/CardSelector';
import { FindingOpponent } from './components/FindingOpponent';
import { CardPacks } from './components/CardPacks';
import { PackOpening } from './components/PackOpening';
import { TutorialScreen } from './components/TutorialScreen';
import { TutorialPrompt } from './components/TutorialPrompt';
import { PracticeScreen } from './practice/PracticeScreen';
import { FundingPrompt } from './components/FundingPrompt';
import { FundingProgress } from './components/FundingProgress';
import { TxNotificationCenter } from './components/TxNotificationCenter';
import { GameScreen3D as GameScreen } from './components3d/GameScreen3D';
import { useTestkitBridge } from './testkit';
import { TESTKIT_ENABLED } from './testkit/enabled';
import './App.css';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';

function AppInner() {
  const aztec = useAztecContext();
  const game = useGame(WS_URL);
  useTestkitBridge(aztec, game); // no-op unless VITE_TESTKIT=1

  const [showTutorialPrompt, setShowTutorialPrompt] = useState(
    () => !localStorage.getItem('tutorial_seen'),
  );
  const [tutorialScreen, setTutorialScreen] = useState(false);
  const [practiceScreen, setPracticeScreen] = useState(false);

  const handleTutorial = () => {
    localStorage.setItem('tutorial_seen', 'true');
    setShowTutorialPrompt(false);
    setTutorialScreen(true);
  };

  const handleExitTutorial = () => {
    localStorage.setItem('tutorial_completed', 'true');
    setTutorialScreen(false);
  };

  const handlePromptSkip = () => {
    localStorage.setItem('tutorial_seen', 'true');
    setShowTutorialPrompt(false);
  };

  // Tutorial + practice are local, chainless screens that replace everything else.
  if (tutorialScreen) {
    return <TutorialScreen onExit={handleExitTutorial} />;
  }
  if (practiceScreen) {
    return <PracticeScreen onExit={() => setPracticeScreen(false)} />;
  }

  // The decorative menu 3D scene renders continuously on every menu screen.
  // Under the playtest harness (two headless tabs across a long multi-game
  // session) its WebGL context churn + render load degrades the page (context
  // loss, crawling PXE reads). The harness clicks DOM on menu screens and only
  // needs the game's 3D scene for projection, so suppress it in testkit mode.
  // Prod (no VITE_TESTKIT) is unaffected — TESTKIT_ENABLED is statically false.
  const showMenuScene = !TESTKIT_ENABLED && (game.screen === 'main-menu' || game.screen === 'card-selector'
    || game.screen === 'finding-opponent' || game.screen === 'card-packs' || game.screen === 'pack-opening');

  return (
    <div className="app">
      <div className="app__bg" />

      {showMenuScene && <MenuScene />}

      {aztec.status === 'deploying' && (
        <FundingProgress status={aztec.status} />
      )}

      {aztec.status === 'needs-funding' && aztec.accountAddress && (
        <FundingPrompt
          accountAddress={aztec.accountAddress}
          onConfirm={aztec.confirmFunded}
        />
      )}

      {showTutorialPrompt &&
        game.screen === 'main-menu' &&
        aztec.status !== 'needs-funding' &&
        aztec.status !== 'deploying' && (
          <TutorialPrompt onLearnToPlay={handleTutorial} onSkip={handlePromptSkip} />
        )}

      {game.screen === 'main-menu' && (
        <MainMenu
          connected={game.ws.connected}
          aztecConnecting={aztec.isConnecting}
          aztecReady={aztec.hasConnected}
          cardCount={aztec.ownedCardIds.length}
          tokenBalance={aztec.tokenBalance ?? 0}
          accountAddress={aztec.accountAddress}
          hasGameInProgress={game.hasGameInProgress}
          onPlay={game.handlePlay}
          onTutorial={handleTutorial}
          onPractice={() => setPracticeScreen(true)}
          onCardPacks={game.handleCardPacks}
        />
      )}

      {game.screen === 'card-selector' && (
        <CardSelector
          ownedCardIds={aztec.ownedCardIds}
          onConfirm={game.handleHandSelected}
          onBack={() => game.setScreen('main-menu')}
        />
      )}

      {game.screen === 'finding-opponent' && (
        <FindingOpponent
          queuePosition={game.ws.queuePosition}
          onCancel={game.handleCancelMatchmaking}
        />
      )}

      {game.screen === 'card-packs' && (
        <CardPacks
          ownedCardIds={aztec.ownedCardIds}
          tokenBalance={aztec.tokenBalance ?? 0}
          onPackOpened={game.handlePackOpened}
          onBack={() => game.setScreen('main-menu')}
        />
      )}

      {game.screen === 'pack-opening' && game.packResult && (
        <PackOpening
          location={game.packResult.location}
          cardIds={game.packResult.cardIds}
          onComplete={game.handlePackOpenComplete}
        />
      )}

      {game.screen === 'game' && game.ws.gameState && game.ws.playerNumber && game.ws.gameId && (
        <GameScreen
          gameState={game.ws.gameState}
          playerNumber={game.ws.playerNumber}
          gameId={game.ws.gameId}
          lastCaptures={game.ws.lastCaptures}
          gameOver={game.ws.gameOver}
          opponentDisconnected={game.ws.opponentDisconnected}
          onPlaceCard={game.handlePlaceCard}
          onBackToLobby={game.handleBackToMenu}
          aztecStatus={aztec.status}
          proofStatus={{
            hand: game.handProofStatus,
            move: game.moveProofStatus,
          }}
          canSettle={
            game.canSettle &&
            game.ws.gameState?.status === 'finished' &&
            game.ws.gameState?.winner === (game.ws.playerNumber === 1 ? 'player1' : 'player2')
          }
          onSettle={game.handleSettle}
          settleTxStatus={game.settleTxStatus}
          opponentSettled={game.opponentSettled}
          takenCardId={game.takenCardId}
          abandonmentWarning={game.ws.abandonmentWarning}
          isClaimingAbandoned={game.isClaimingAbandoned}
          abandonedDisputeCountdown={game.abandonedDisputeCountdown}
          onClaimAbandoned={game.handleClaimAbandoned}
          chainView={{
            onChainGameId: game.onChainGameId,
            myHandProof: game.myHandProof,
            opponentHandProof: game.opponentHandProof,
            moveProofs: game.collectedMoveProofs,
            settleTxHash: game.settleTxHash,
          }}
        />
      )}
      {game.screen === 'game' && !game.ws.gameState && (
        <div className="app__waiting">
          <div className="app__waiting-spinner" />
          <p>Finding opponent...</p>
          <button className="btn btn--ghost" onClick={game.handleBackToMenu}>
            Cancel
          </button>
        </div>
      )}
      <TxNotificationCenter account={aztec.accountAddress} />
    </div>
  );
}

export function App() {
  return (
    <AztecProvider>
      <AppInner />
    </AztecProvider>
  );
}
