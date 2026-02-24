import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useAztec } from './hooks/useAztec';
import { useGameFlow } from './hooks/useGameFlow';
import { useGameContract } from './hooks/useGameContract';
import { Lobby } from './components/Lobby';
import { GameScreen } from './components/GameScreen';
import { WalletStatus } from './components/WalletStatus';
import type { Screen, GameState, MoveProofData, Card } from './types';
import './App.css';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3001';

export function App() {
  const [screen, setScreen] = useState<Screen>('lobby');
  const [selectedCardIds, setSelectedCardIds] = useState<number[]>([]);
  const ws = useWebSocket(WS_URL);
  const aztec = useAztec();
  const gameContract = useGameContract(aztec.wallet);

  const gameFlow = useGameFlow({
    gameId: ws.gameId,
    playerNumber: ws.playerNumber,
    cardIds: selectedCardIds,
    gameState: ws.gameState,
    accountAddress: aztec.accountAddress,
  });

  // Track previous board state for move proof generation
  const prevBoardRef = useRef<GameState['board'] | null>(null);
  const prevScoresRef = useRef<[number, number]>([5, 5]);

  // When opponent sends hand proof via WebSocket, store it in gameFlow
  useEffect(() => {
    if (ws.opponentHandProof) {
      gameFlow.setOpponentHandProof(ws.opponentHandProof);
    }
  }, [ws.opponentHandProof]); // eslint-disable-line react-hooks/exhaustive-deps

  // When our hand proof is ready, send it to opponent via WebSocket
  useEffect(() => {
    if (gameFlow.myHandProof && ws.gameId) {
      ws.submitHandProof(ws.gameId, gameFlow.myHandProof);
    }
  }, [gameFlow.myHandProof, ws.gameId]); // eslint-disable-line react-hooks/exhaustive-deps

  // When opponent sends a move proof, collect it
  useEffect(() => {
    if (ws.lastMoveProof) {
      gameFlow.addMoveProof(ws.lastMoveProof.moveProof);
    }
  }, [ws.lastMoveProof]); // eslint-disable-line react-hooks/exhaustive-deps

  // Store initial board state when game starts
  useEffect(() => {
    if (ws.gameState && ws.gameState.status === 'playing' && !prevBoardRef.current) {
      prevBoardRef.current = ws.gameState.board;
      prevScoresRef.current = [ws.gameState.player1Score, ws.gameState.player2Score];
    }
  }, [ws.gameState]);

  const handleCreateGame = useCallback((cardIds: number[]) => {
    setSelectedCardIds(cardIds);
    ws.createGame(cardIds);
    gameFlow.reset();
    gameContract.resetTx();
    setScreen('game');
  }, [ws, gameFlow, gameContract]);

  const handleJoinGame = useCallback((gameId: string, cardIds: number[]) => {
    setSelectedCardIds(cardIds);
    ws.joinGame(gameId, cardIds);
    gameFlow.reset();
    gameContract.resetTx();
    setScreen('game');
  }, [ws, gameFlow, gameContract]);

  const handlePlaceCard = useCallback(async (handIndex: number, row: number, col: number) => {
    if (!ws.gameState || !ws.playerNumber || !ws.gameId) return;

    // Capture current board state BEFORE the move
    const boardBefore = ws.gameState.board;
    const scoresBefore: [number, number] = [ws.gameState.player1Score, ws.gameState.player2Score];

    // Get the card being placed
    const myHand = ws.playerNumber === 1 ? ws.gameState.player1Hand : ws.gameState.player2Hand;
    const card: Card | undefined = myHand[handIndex];
    if (!card) return;

    // Send move via WebSocket with proof (SUBMIT_MOVE_PROOF)
    // The server processes the move and the opponent receives the proof
    // But first we need to compute what the board WILL look like after the move
    // Since the server handles game logic, we use placeholder proof generation
    // and then the server broadcasts the actual result

    // Send the move first (proof generated async)
    ws.placeCard(handIndex, row, col);

    // Store pre-move state for proof generation
    prevBoardRef.current = boardBefore;
    prevScoresRef.current = scoresBefore;
  }, [ws]);

  // Generate move proof after receiving updated state from server
  useEffect(() => {
    if (!ws.gameState || !prevBoardRef.current || !ws.playerNumber || !ws.gameId) return;

    const boardAfter = ws.gameState.board;
    const scoresAfter: [number, number] = [ws.gameState.player1Score, ws.gameState.player2Score];
    const boardBefore = prevBoardRef.current;
    const scoresBefore = prevScoresRef.current;

    // Detect if a move was just made by checking if board changed
    const boardChanged = JSON.stringify(boardBefore) !== JSON.stringify(boardAfter);
    if (!boardChanged) return;

    // Find which cell was just filled (new card placed)
    let placedCardId = 0;
    let placedRow = -1;
    let placedCol = -1;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        if (!boardBefore[r][c].card && boardAfter[r][c].card) {
          placedCardId = boardAfter[r][c].card!.id;
          placedRow = r;
          placedCol = c;
        }
      }
    }

    if (placedCardId === 0) {
      // Board changed but no new card - shouldn't happen
      prevBoardRef.current = boardAfter;
      prevScoresRef.current = scoresAfter;
      return;
    }

    // Determine who just played: the player whose turn it ISN'T now (since turn already flipped)
    const justPlayed = ws.gameState.currentTurn === 'player1' ? 2 : 1;

    // Only generate proof for OUR moves
    if (justPlayed === ws.playerNumber) {
      const gameEnded = ws.gameState.status === 'finished';
      const winnerId = ws.gameState.winner === 'player1' ? 1 : ws.gameState.winner === 'player2' ? 2 : 0;

      gameFlow.generateMoveProofForPlacement(
        placedCardId,
        placedRow,
        placedCol,
        boardBefore,
        boardAfter,
        scoresBefore,
        scoresAfter,
        gameEnded,
        winnerId,
      ).then(proof => {
        // After proof is generated, also send it to opponent via WebSocket
        if (proof && ws.gameId) {
          ws.submitMoveProof(ws.gameId, -1, placedRow, placedCol, proof);
        }
      });
    }

    // Update prev state for next move
    prevBoardRef.current = boardAfter;
    prevScoresRef.current = scoresAfter;
  }, [ws.gameState]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSettleGame = useCallback(async (selectedCardTokenId: number) => {
    if (!gameFlow.canSettle || !gameFlow.myHandProof || !gameFlow.opponentHandProof) return;

    // Determine loser address
    const loserAddress = gameFlow.opponentHandProof.playerAddress;

    await gameContract.settleGame(
      gameFlow.myHandProof,
      gameFlow.opponentHandProof,
      gameFlow.collectedMoveProofs,
      loserAddress,
      selectedCardTokenId,
    );
  }, [gameFlow, gameContract]);

  const handleBackToLobby = useCallback(() => {
    ws.disconnect();
    gameFlow.reset();
    gameContract.resetTx();
    setSelectedCardIds([]);
    prevBoardRef.current = null;
    prevScoresRef.current = [5, 5];
    setScreen('lobby');
  }, [ws, gameFlow, gameContract]);

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
          onPlaceCard={handlePlaceCard}
          onBackToLobby={handleBackToLobby}
          proofStatus={gameFlow.moveProofStatus}
          handProofStatus={gameFlow.handProofStatus}
          txStatus={gameContract.txStatus}
          canSettle={gameFlow.canSettle}
          onSettleGame={handleSettleGame}
          collectedProofCount={gameFlow.collectedMoveProofs.length}
          myHandProofReady={gameFlow.myHandProof !== null}
          opponentHandProofReady={gameFlow.opponentHandProof !== null}
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
