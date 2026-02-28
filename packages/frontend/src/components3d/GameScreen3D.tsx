import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { GameState, Player, Card, Board } from '../types';
import { SwampScene } from './SwampScene';
import { GameHUD } from './GameHUD';
import { useCardAnimation } from './hooks/useCardAnimation';
import { useCaptureAnimation, type CaptureAnimationEntry } from './hooks/useCaptureAnimation';

export type ProofStatusInfo = {
  hand: string;
  move: string;
};

export type SettleTxStatus = 'idle' | 'preparing' | 'proving' | 'sending' | 'confirmed' | 'error';

interface GameScreenProps {
  gameState: GameState;
  playerNumber: 1 | 2;
  gameId: string;
  lastCaptures: { row: number; col: number }[];
  gameOver: { winner: Player | 'draw' } | null;
  opponentDisconnected: boolean;
  onPlaceCard: (handIndex: number, row: number, col: number) => void;
  onBackToLobby: () => void;
  aztecStatus?: string;
  proofStatus?: ProofStatusInfo;
  canSettle?: boolean;
  onSettle?: (selectedCardId: number) => void;
  settleTxStatus?: SettleTxStatus;
}

export function GameScreen3D({
  gameState,
  playerNumber,
  gameId,
  lastCaptures,
  gameOver,
  opponentDisconnected,
  onPlaceCard,
  onBackToLobby,
  aztecStatus,
  proofStatus,
  canSettle,
  onSettle,
  settleTxStatus,
}: GameScreenProps) {
  const [selectedCardIndex, setSelectedCardIndex] = useState<number | null>(null);
  const { flyingCard, startFlyAnimation, completeFlyAnimation, isAnimatingCell } = useCardAnimation();
  const {
    activeCaptureEntry,
    activeIndex: captureActiveIndex,
    isCascadeActive,
    startCascade,
    onCaptureAnimComplete,
    isCellCaptureAnimating,
    isCellCapturePending,
    queue: captureQueue,
  } = useCaptureAnimation();
  const prevBoardRef = useRef<Board | null>(null);
  const pendingCascadeRef = useRef<CaptureAnimationEntry[] | null>(null);

  const myPlayer: Player = playerNumber === 1 ? 'player1' : 'player2';
  const opponentPlayer: Player = playerNumber === 1 ? 'player2' : 'player1';
  const isMyTurn = gameState.currentTurn === myPlayer;
  const isFinished = gameState.status === 'finished';

  const myHand = playerNumber === 1 ? gameState.player1Hand : gameState.player2Hand;
  const opponentHand = playerNumber === 1 ? gameState.player2Hand : gameState.player1Hand;
  const myScore = playerNumber === 1 ? gameState.player1Score : gameState.player2Score;
  const opponentScore = playerNumber === 1 ? gameState.player2Score : gameState.player1Score;

  const validPlacements = useMemo(() => {
    if (selectedCardIndex === null || !isMyTurn || isFinished) return [];
    const placements: { row: number; col: number }[] = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        if (!gameState.board[r][c].card) {
          placements.push({ row: r, col: c });
        }
      }
    }
    return placements;
  }, [selectedCardIndex, isMyTurn, isFinished, gameState.board]);

  // Trigger capture cascade when captures arrive
  useEffect(() => {
    if (lastCaptures.length === 0) return;

    // The placer is the OPPOSITE of currentTurn (turn already flipped)
    const placer: Player = gameState.currentTurn === 'player1' ? 'player2' : 'player1';
    const placerIsMe = placer === myPlayer;

    const entries: CaptureAnimationEntry[] = lastCaptures.map(cap => ({
      row: cap.row,
      col: cap.col,
      card: gameState.board[cap.row][cap.col].card!,
      oldOwner: placerIsMe ? 'red' : 'blue',
      newOwner: placerIsMe ? 'blue' : 'red',
    }));

    if (flyingCard) {
      // Defer cascade until fly animation completes
      pendingCascadeRef.current = entries;
    } else {
      startCascade(entries);
    }
  }, [lastCaptures]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setSelectedCardIndex(null);
  }, [gameState.currentTurn]);

  // Detect opponent card placements for fly animation
  useEffect(() => {
    const prevBoard = prevBoardRef.current;
    prevBoardRef.current = gameState.board;

    if (!prevBoard) return;

    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const prev = prevBoard[r][c];
        const curr = gameState.board[r][c];
        if (!prev.card && curr.card && curr.owner === opponentPlayer) {
          const prevOpponentHand = playerNumber === 1
            ? gameState.player2Hand
            : gameState.player1Hand;
          const handIndex = Math.max(0, prevOpponentHand.length);

          startFlyAnimation({
            card: curr.card,
            owner: opponentPlayer,
            fromHandIndex: Math.min(handIndex, 4),
            toRow: r,
            toCol: c,
            isOpponent: true,
            faceDown: true,
          });
          return;
        }
      }
    }
  }, [gameState.board, opponentPlayer, playerNumber, startFlyAnimation]);

  // Wrap completeFlyAnimation to start pending cascade
  const handleFlyComplete = useCallback(() => {
    completeFlyAnimation();
    if (pendingCascadeRef.current) {
      startCascade(pendingCascadeRef.current);
      pendingCascadeRef.current = null;
    }
  }, [completeFlyAnimation, startCascade]);

  const handleCardClick = (index: number) => {
    if (!isMyTurn || isFinished) return;
    setSelectedCardIndex(selectedCardIndex === index ? null : index);
  };

  const handleDeselect = () => {
    setSelectedCardIndex(null);
  };

  const handleCellClick = (row: number, col: number) => {
    if (flyingCard || isCascadeActive) return;
    if (selectedCardIndex === null || !isMyTurn || isFinished) return;

    const card = myHand[selectedCardIndex];
    startFlyAnimation({
      card,
      owner: myPlayer,
      fromHandIndex: selectedCardIndex,
      toRow: row,
      toCol: col,
      isOpponent: false,
      faceDown: false,
    });

    onPlaceCard(selectedCardIndex, row, col);
    setSelectedCardIndex(null);
  };

  // Build getPendingCaptureOwner: shows old owner for cells awaiting animation
  const getPendingCaptureOwner = useCallback(
    (row: number, col: number): 'blue' | 'red' | undefined => {
      if (!isCellCapturePending(row, col)) return undefined;
      const entry = captureQueue.find(e => e.row === row && e.col === col);
      return entry?.oldOwner;
    },
    [isCellCapturePending, captureQueue],
  );

  // Prevent page scrolling when the game screen is mounted
  useEffect(() => {
    const prev = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prev;
      document.body.style.overflow = '';
    };
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', overflow: 'hidden' }} data-testid="game-screen">
      <SwampScene
        board={gameState.board}
        validPlacements={validPlacements}
        onCellClick={handleCellClick}
        myHand={myHand}
        opponentHand={opponentHand}
        myPlayer={myPlayer}
        selectedCardIndex={selectedCardIndex}
        isMyTurn={isMyTurn}
        isFinished={isFinished}
        onCardClick={handleCardClick}
        onDeselect={handleDeselect}
        flyingCard={flyingCard}
        onFlyComplete={handleFlyComplete}
        isAnimatingCell={isAnimatingCell}
        activeCaptureEntry={activeCaptureEntry}
        captureActiveIndex={captureActiveIndex}
        onCaptureAnimComplete={onCaptureAnimComplete}
        isCaptureAnimatingCell={isCellCaptureAnimating}
        getPendingCaptureOwner={getPendingCaptureOwner}
      />

      <GameHUD
        gameState={gameState}
        playerNumber={playerNumber}
        gameId={gameId}
        gameOver={gameOver}
        opponentDisconnected={opponentDisconnected}
        isMyTurn={isMyTurn}
        isFinished={isFinished}
        myPlayer={myPlayer}
        myScore={myScore}
        opponentScore={opponentScore}
        onBackToLobby={onBackToLobby}
        aztecStatus={aztecStatus}
        proofStatus={proofStatus}
        canSettle={canSettle}
        onSettle={onSettle}
        settleTxStatus={settleTxStatus}
      />
    </div>
  );
}
