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
  const gameContract = useGameContract(aztec.wallet, aztec.accountAddress);

  // Track previous gameState for board-before snapshots
  const prevGameStateRef = useRef<GameState | null>(null);

  // Opponent card IDs come from GAME_OVER message via ws.opponentCardIds

  // Queue of moves made before hand proofs were ready, so we can retroactively generate proofs
  const pendingMovesRef = useRef<Array<{
    cardId: number; handIndex: number; row: number; col: number;
    boardBefore: GameState['board']; boardAfter: GameState['board'];
    scoresBefore: [number, number]; scoresAfter: [number, number];
    gameEnded: boolean; winnerId: number;
  }>>([]);

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

  // 3b. Process queued moves once both hand proofs are available
  useEffect(() => {
    if (!gameFlow.myHandProof || !gameFlow.opponentHandProof) return;
    if (pendingMovesRef.current.length === 0) return;
    if (!ws.gameId) return;

    const pending = pendingMovesRef.current.splice(0);
    console.log(`[App] Processing ${pending.length} queued move(s) for deferred proof gen`);

    (async () => {
      for (const move of pending) {
        try {
          const moveProof = await gameFlow.generateMoveProofForPlacement(
            move.cardId, move.row, move.col,
            move.boardBefore, move.boardAfter,
            move.scoresBefore, move.scoresAfter,
            move.gameEnded, move.winnerId,
          );
          if (moveProof && ws.gameId) {
            ws.submitMoveProof(ws.gameId, move.handIndex, move.row, move.col, moveProof);
          }
        } catch (err) {
          console.warn('[App] Deferred move proof generation failed:', err);
        }
      }
    })();
  }, [gameFlow.myHandProof, gameFlow.opponentHandProof]); // eslint-disable-line react-hooks/exhaustive-deps

  // 4. Keep previous game state snapshot for proof generation
  useEffect(() => {
    prevGameStateRef.current = ws.gameState;
  }, [ws.gameState]);

  // 5. Share Aztec address with opponent when game starts and Aztec is connected
  const aztecInfoSharedRef = useRef(false);
  useEffect(() => {
    if (!ws.gameId || !ws.gameState || !aztec.accountAddress || aztecInfoSharedRef.current) return;
    if (ws.gameState.status !== 'playing') return;
    aztecInfoSharedRef.current = true;
    ws.shareAztecInfo(ws.gameId, aztec.accountAddress, gameContract.onChainGameId ?? undefined);
    console.log('[App] Shared Aztec address with opponent:', aztec.accountAddress);
  }, [ws.gameId, ws.gameState, aztec.accountAddress, gameContract.onChainGameId, ws]);

  // 6. Trigger on-chain game creation in background when game starts
  const onChainCreationStartedRef = useRef(false);
  useEffect(() => {
    if (!ws.gameId || !ws.gameState || !ws.playerNumber) return;
    if (ws.gameState.status !== 'playing') return;
    if (onChainCreationStartedRef.current) return;
    if (!gameContract.isAvailable) return;
    onChainCreationStartedRef.current = true;

    if (ws.playerNumber === 1) {
      gameContract.createGameOnChain(cardIds).then((chainId) => {
        if (chainId && ws.gameId && aztec.accountAddress) {
          ws.shareAztecInfo(ws.gameId, aztec.accountAddress, chainId);
          console.log('[App] On-chain game created, shared ID:', chainId);
        }
      });
    } else if (ws.playerNumber === 2 && ws.opponentOnChainGameId) {
      gameContract.joinGameOnChain(ws.opponentOnChainGameId, cardIds);
    }
  }, [ws.gameId, ws.gameState, ws.playerNumber, ws.opponentOnChainGameId, gameContract.isAvailable, cardIds, aztec.accountAddress, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  // 6b. Player 2: join on-chain game when we receive opponent's on-chain game ID later
  useEffect(() => {
    if (ws.playerNumber !== 2 || !ws.opponentOnChainGameId) return;
    if (gameContract.onChainGameId) return; // already joined
    if (!gameContract.isAvailable) return;
    gameContract.joinGameOnChain(ws.opponentOnChainGameId, cardIds);
  }, [ws.playerNumber, ws.opponentOnChainGameId, gameContract.onChainGameId, gameContract.isAvailable, cardIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset proof state on game start
  useEffect(() => {
    if (screen === 'lobby') {
      handProofSubmittedRef.current = false;
      pendingMovesRef.current = [];
      aztecInfoSharedRef.current = false;
      onChainCreationStartedRef.current = false;
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

    // Generate move proof in the background (or queue if hand proofs aren't ready yet)
    if (aztec.isAvailable && card) {
      try {
        const { placeCard: applyMove } = await import('@aztec-triple-triad/game-logic');
        const result = applyMove(ws.gameState, myPlayer, handIndex, row, col);
        const boardAfter = result.newState.board;
        const scoresBefore: [number, number] = [ws.gameState.player1Score, ws.gameState.player2Score];
        const scoresAfter: [number, number] = [result.newState.player1Score, result.newState.player2Score];
        const gameEnded = result.newState.status === 'finished';
        const winnerId = mapWinnerId(result.newState.winner);

        if (gameFlow.myHandProof && gameFlow.opponentHandProof) {
          // Hand proofs ready — generate proof immediately
          const moveProof = await gameFlow.generateMoveProofForPlacement(
            card.id, row, col,
            boardBefore, boardAfter,
            scoresBefore, scoresAfter,
            gameEnded, winnerId,
          );
          if (moveProof) {
            ws.submitMoveProof(ws.gameId, handIndex, row, col, moveProof);
          }
        } else {
          // Hand proofs not ready yet — queue for later
          console.log('[App] Hand proofs not ready, queuing move for deferred proof gen');
          pendingMovesRef.current.push({
            cardId: card.id, handIndex, row, col,
            boardBefore: JSON.parse(JSON.stringify(boardBefore)),
            boardAfter: JSON.parse(JSON.stringify(boardAfter)),
            scoresBefore, scoresAfter, gameEnded, winnerId,
          });
        }
      } catch (err) {
        console.warn('[App] Move proof generation failed, move still sent via WS:', err);
      }
    }
  }, [ws, aztec.isAvailable, gameFlow]);

  const handleSettle = useCallback(async (selectedCardId: number) => {
    if (!ws.gameId || !gameFlow.myHandProof || !gameFlow.opponentHandProof) {
      console.error('[App] Cannot settle: missing proofs');
      return;
    }

    // Determine on-chain game ID
    const chainGameId = gameContract.onChainGameId ?? ws.opponentOnChainGameId;
    if (!chainGameId) {
      console.error('[App] Cannot settle: no on-chain game ID');
      return;
    }

    // Determine opponent address
    const opponentAddr = ws.opponentAztecAddress;
    if (!opponentAddr) {
      console.error('[App] Cannot settle: no opponent Aztec address');
      return;
    }

    // Get opponent card IDs (from GAME_OVER message)
    const oppCardIds = ws.opponentCardIds;
    if (oppCardIds.length === 0) {
      console.error('[App] Cannot settle: no opponent card IDs available');
      return;
    }

    // Order proofs: handProof1 is always player 1's, handProof2 is always player 2's
    const handProof1 = ws.playerNumber === 1 ? gameFlow.myHandProof : gameFlow.opponentHandProof;
    const handProof2 = ws.playerNumber === 2 ? gameFlow.myHandProof : gameFlow.opponentHandProof;

    console.log('[App] Settling game on-chain:', {
      chainGameId,
      opponentAddr,
      selectedCardId,
      myCardIds: cardIds,
      oppCardIds,
      handProof1Commit: handProof1.cardCommit,
      handProof2Commit: handProof2.cardCommit,
      moveProofCount: gameFlow.collectedMoveProofs.length,
    });

    await gameContract.settleGame({
      onChainGameId: chainGameId,
      handProof1,
      handProof2,
      moveProofs: gameFlow.collectedMoveProofs,
      opponentAddress: opponentAddr,
      cardToTransfer: selectedCardId,
      callerCardIds: cardIds,
      opponentCardIds: oppCardIds,
    });
  }, [ws.gameId, ws.playerNumber, ws.opponentAztecAddress, ws.opponentOnChainGameId, ws.opponentCardIds, gameFlow, gameContract, cardIds]);

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
          ownedCardIds={aztec.ownedCardIds}
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
