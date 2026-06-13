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
import { FundingPrompt } from './components/FundingPrompt';
import { TxNotificationCenter } from './components/TxNotificationCenter';
import { GameScreen3D as GameScreen } from './components3d/GameScreen3D';
import './App.css';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';

function AppInner() {
  const aztec = useAztecContext();
  const game = useGame(WS_URL);

  const [showTutorialPrompt, setShowTutorialPrompt] = useState(
    () => !localStorage.getItem('tutorial_seen'),
  );
  const [tutorialScreen, setTutorialScreen] = useState(false);

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

  // Tutorial screen replaces all other screens
  if (tutorialScreen) {
    return <TutorialScreen onExit={handleExitTutorial} />;
  }

  const showMenuScene = game.screen === 'main-menu' || game.screen === 'card-selector'
    || game.screen === 'finding-opponent' || game.screen === 'card-packs' || game.screen === 'pack-opening';

  return (
    <div className="app">
      <div className="app__bg" />

      {showMenuScene && <MenuScene />}

      {aztec.status === 'needs-funding' && aztec.accountAddress && (
        <FundingPrompt
          accountAddress={aztec.accountAddress}
          onConfirm={aztec.confirmFunded}
        />
      )}

      {showTutorialPrompt && game.screen === 'main-menu' && aztec.status !== 'needs-funding' && (
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
