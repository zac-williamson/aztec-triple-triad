import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAztec } from './hooks/useAztec';
import { useGameFlow } from './hooks/useGameFlow';
import { useGameContract } from './hooks/useGameContract';
import { Lobby } from './components/Lobby';
import { GameScreen3D as GameScreen } from './components3d/GameScreen3D';
import type { Screen, GameState } from './types';
import './App.css';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';

/**
 * Map game winner to circuit winner_id value.
 * 0=not ended, 1=player1, 2=player2, 3=draw
 */
export function mapWinnerId(winner: 'player1' | 'player2' | 'draw' | null): number {
  if (winner === null) return 0;
  if (winner === 'player1') return 1;
  if (winner === 'player2') return 2;
  return 3; // draw
}

export function App() {
  const [screen, setScreen] = useState<Screen>('lobby');
  const [cardIds, setCardIds] = useState<number[]>([]);
  const ws = useWebSocket(WS_URL);

  // Aztec hooks — auto-connect on mount
  const aztec = useAztec();
  const aztecConnectAttempted = useRef(false);
  useEffect(() => {
    if (aztec.status === 'disconnected' && !aztecConnectAttempted.current) {
      aztecConnectAttempted.current = true;
      aztec.connect();
    }
  }, [aztec.status, aztec.connect]);
  const gameFlow = useGameFlow({
    gameId: ws.gameId,
    playerNumber: ws.playerNumber,
    cardIds,
    gameState: ws.gameState,
    wallet: aztec.wallet,
    accountAddress: aztec.accountAddress,
  });
  const gameContract = useGameContract(aztec.wallet);

  // Track previous gameState for board-before snapshots
  const prevGameStateRef = useRef<GameState | null>(null);

  // --- Effects for proof flow ---

  // 1. Auto-submit hand proof when it's generated
  const handProofSubmittedRef = useRef(false);
  useEffect(() => {
    if (!gameFlow.myHandProof || !ws.gameId || handProofSubmittedRef.current) return;
    handProofSubmittedRef.current = true;
    ws.submitHandProof(ws.gameId, gameFlow.myHandProof);
  }, [gameFlow.myHandProof, ws.gameId, ws]);

  // 2. Receive opponent hand proof from WebSocket
  useEffect(() => {
    if (!ws.opponentHandProof) return;
    gameFlow.setOpponentHandProof(ws.opponentHandProof);
  }, [ws.opponentHandProof]); // eslint-disable-line react-hooks/exhaustive-deps

  // 3. Receive opponent move proof from WebSocket
  useEffect(() => {
    if (!ws.lastMoveProof) return;
    gameFlow.addMoveProof(ws.lastMoveProof.moveProof);
  }, [ws.lastMoveProof]); // eslint-disable-line react-hooks/exhaustive-deps

  // 4. Keep previous game state snapshot for proof generation
  useEffect(() => {
    // Update prevGameState AFTER render so we can capture board-before on next move
    prevGameStateRef.current = ws.gameState;
  }, [ws.gameState]);

  // Reset proof state on game start
  useEffect(() => {
    if (screen === 'lobby') {
      handProofSubmittedRef.current = false;
      gameFlow.reset();
    }
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateGame = useCallback((ids: number[]) => {
    setCardIds(ids);
    ws.createGame(ids);
    setScreen('game');
  }, [ws]);

  const handleJoinGame = useCallback((gameId: string, ids: number[]) => {
    setCardIds(ids);
    ws.joinGame(gameId, ids);
    setScreen('game');
  }, [ws]);

  const handlePlaceCard = useCallback(async (handIndex: number, row: number, col: number) => {
    if (!ws.gameState || !ws.playerNumber || !ws.gameId) return;

    const boardBefore = prevGameStateRef.current?.board ?? ws.gameState.board;
    const myPlayer = ws.playerNumber === 1 ? 'player1' : 'player2';
    const myHand = ws.playerNumber === 1 ? ws.gameState.player1Hand : ws.gameState.player2Hand;
    const card = myHand[handIndex];

    // Always send the move via WebSocket (server applies it immediately)
    ws.placeCard(handIndex, row, col);

    // If Aztec/proofs are available, generate a move proof in the background
    if (aztec.isAvailable && gameFlow.myHandProof && gameFlow.opponentHandProof && card) {
      // We need the board-after state. Since the server will send it back,
      // we use a local simulation to get it for proof gen.
      try {
        const { placeCard: applyMove } = await import('@aztec-triple-triad/game-logic');
        const result = applyMove(ws.gameState, myPlayer, handIndex, row, col);
        const boardAfter = result.newState.board;
        const scoresBefore: [number, number] = [ws.gameState.player1Score, ws.gameState.player2Score];
        const scoresAfter: [number, number] = [result.newState.player1Score, result.newState.player2Score];
        const gameEnded = result.newState.status === 'finished';
        const winnerId = mapWinnerId(result.newState.winner);

        const moveProof = await gameFlow.generateMoveProofForPlacement(
          card.id, row, col,
          boardBefore, boardAfter,
          scoresBefore, scoresAfter,
          gameEnded, winnerId,
        );

        if (moveProof) {
          ws.submitMoveProof(ws.gameId, handIndex, row, col, moveProof);
        }
      } catch (err) {
        console.warn('[App] Move proof generation failed, move still sent via WS:', err);
      }
    }
  }, [ws, aztec.isAvailable, gameFlow]);

  const handleSettle = useCallback(async (selectedCardId: number) => {
    if (!ws.gameId || !gameFlow.myHandProof || !gameFlow.opponentHandProof) return;

    const handProof1 = ws.playerNumber === 1 ? gameFlow.myHandProof : gameFlow.opponentHandProof;
    const handProof2 = ws.playerNumber === 2 ? gameFlow.myHandProof : gameFlow.opponentHandProof;

    // For settlement we need the opponent's address — this would come from the game state
    // For now use a placeholder since full settlement requires on-chain context
    const loserAddress = '0x0';

    await gameContract.settleGame(
      ws.gameId,
      handProof1,
      handProof2,
      gameFlow.collectedMoveProofs,
      loserAddress,
      selectedCardId,
      cardIds,
      [], // loser card IDs would be known from game state
    );
  }, [ws.gameId, ws.playerNumber, gameFlow, gameContract, cardIds]);

  const handleBackToLobby = useCallback(() => {
    ws.disconnect();
    gameFlow.reset();
    gameContract.resetTx();
    gameContract.resetLifecycle();
    setCardIds([]);
    setScreen('lobby');
  }, [ws, gameFlow, gameContract]);

  return (
    <div className="app">
      <div className="app__bg" />

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
          onPlaceCard={handlePlaceCard}
          onBackToLobby={handleBackToLobby}
          aztecStatus={aztec.status}
          proofStatus={{
            hand: gameFlow.handProofStatus,
            move: gameFlow.moveProofStatus,
          }}
          canSettle={gameFlow.canSettle}
          onSettle={handleSettle}
          settleTxStatus={gameContract.txStatus}
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
