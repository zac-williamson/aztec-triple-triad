import { AztecProvider, useAztecContext } from './aztec/AztecContext';
import { useGameOrchestrator } from './hooks/useGameOrchestrator';
import { MenuScene } from './components3d/MenuScene';
import { MainMenu } from './components/MainMenu';
import { CardSelector } from './components/CardSelector';
import { FindingOpponent } from './components/FindingOpponent';
import { CardPacks } from './components/CardPacks';
import { PackOpening } from './components/PackOpening';
import { GameScreen3D as GameScreen } from './components3d/GameScreen3D';
import './App.css';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';

function AppInner() {
  const aztec = useAztecContext();
  const game = useGameOrchestrator(WS_URL);

  const showMenuScene = game.screen === 'main-menu' || game.screen === 'card-selector'
    || game.screen === 'finding-opponent' || game.screen === 'card-packs' || game.screen === 'pack-opening';

  return (
    <div className="app">
      <div className="app__bg" />

      {showMenuScene && <MenuScene />}

      {game.screen === 'main-menu' && (
        <MainMenu
          connected={game.ws.connected}
          aztecConnecting={aztec.isConnecting}
          aztecReady={aztec.hasConnected}
          cardCount={aztec.ownedCardIds.length}
          hasGameInProgress={game.hasGameInProgress}
          onPlay={game.handlePlay}
          onTutorial={() => {}}
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
            hand: game.session.handProofStatus,
            move: game.session.moveProofStatus,
          }}
          canSettle={
            game.session.canSettle &&
            game.ws.gameState?.status === 'finished' &&
            game.ws.gameState?.winner === (game.ws.playerNumber === 1 ? 'player1' : 'player2')
          }
          onSettle={game.handleSettle}
          settleTxStatus={game.session.settleTxStatus}
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
