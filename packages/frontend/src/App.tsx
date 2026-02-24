import { useState, useCallback } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAztec } from './hooks/useAztec';
import { useProofGeneration } from './hooks/useProofGeneration';
import { useGameContract } from './hooks/useGameContract';
import { Lobby } from './components/Lobby';
import { GameScreen } from './components/GameScreen';
import { WalletStatus } from './components/WalletStatus';
import type { Screen } from './types';
import './App.css';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';

export function App() {
  const [screen, setScreen] = useState<Screen>('lobby');
  const ws = useWebSocket(WS_URL);
  const aztec = useAztec();
  const proofs = useProofGeneration();
  const gameContract = useGameContract(aztec.wallet);

  const handleCreateGame = useCallback((cardIds: number[]) => {
    ws.createGame(cardIds);
    proofs.reset();
    setScreen('game');
  }, [ws, proofs]);

  const handleJoinGame = useCallback((gameId: string, cardIds: number[]) => {
    ws.joinGame(gameId, cardIds);
    proofs.reset();
    setScreen('game');
  }, [ws, proofs]);

  const handleBackToLobby = useCallback(() => {
    ws.disconnect();
    proofs.reset();
    gameContract.resetTx();
    setScreen('lobby');
  }, [ws, proofs, gameContract]);

  return (
    <div className="app">
      <div className="app__bg" />

      <WalletStatus
        status={aztec.status}
        address={aztec.accountAddress}
        onConnect={aztec.connect}
        onDisconnect={aztec.disconnect}
        error={aztec.error}
      />

      {screen === 'lobby' && (
        <Lobby
          connected={ws.connected}
          gameList={ws.gameList}
          error={ws.error}
          onCreateGame={handleCreateGame}
          onJoinGame={handleJoinGame}
          onRefreshList={ws.refreshGameList}
        />
      )}
      {screen === 'game' && ws.gameState && ws.playerNumber && ws.gameId && (
        <GameScreen
          gameState={ws.gameState}
          playerNumber={ws.playerNumber}
          gameId={ws.gameId}
          lastCaptures={ws.lastCaptures}
          gameOver={ws.gameOver}
          opponentDisconnected={ws.opponentDisconnected}
          onPlaceCard={ws.placeCard}
          onBackToLobby={handleBackToLobby}
          proofStatus={proofs.moveProofStatus}
          txStatus={gameContract.txStatus}
        />
      )}
      {screen === 'game' && !ws.gameState && (
        <div className="app__waiting">
          <div className="app__waiting-spinner" />
          <p>Waiting for opponent to join...</p>
          {ws.gameId && (
            <div className="app__game-id-display">
              <span>Share this Game ID:</span>
              <code>{ws.gameId}</code>
            </div>
          )}
          <button className="btn btn--ghost" onClick={handleBackToLobby}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
