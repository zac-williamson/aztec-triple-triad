import { useState, useEffect, useMemo } from 'react';
import type { GameState, Player, Card } from '../types';
import { SwampScene } from './SwampScene';
import { GameHUD } from './GameHUD';

interface GameScreenProps {
  gameState: GameState;
  playerNumber: 1 | 2;
  gameId: string;
  lastCaptures: { row: number; col: number }[];
  gameOver: { winner: Player | 'draw' } | null;
  opponentDisconnected: boolean;
  onPlaceCard: (handIndex: number, row: number, col: number) => void;
  onBackToLobby: () => void;
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
}: GameScreenProps) {
  const [selectedCardIndex, setSelectedCardIndex] = useState<number | null>(null);
  const [capturedCells, setCapturedCells] = useState<{ row: number; col: number }[]>([]);

  const myPlayer: Player = playerNumber === 1 ? 'player1' : 'player2';
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

  useEffect(() => {
    if (lastCaptures.length > 0) {
      setCapturedCells(lastCaptures);
      const timer = setTimeout(() => setCapturedCells([]), 700);
      return () => clearTimeout(timer);
    }
  }, [lastCaptures]);

  useEffect(() => {
    setSelectedCardIndex(null);
  }, [gameState.currentTurn]);

  const handleCardClick = (index: number) => {
    if (!isMyTurn || isFinished) return;
    setSelectedCardIndex(selectedCardIndex === index ? null : index);
  };

  const handleCellClick = (row: number, col: number) => {
    if (selectedCardIndex === null || !isMyTurn || isFinished) return;
    onPlaceCard(selectedCardIndex, row, col);
    setSelectedCardIndex(null);
  };

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }} data-testid="game-screen">
      <SwampScene
        board={gameState.board}
        validPlacements={validPlacements}
        capturedCells={capturedCells}
        onCellClick={handleCellClick}
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
        myHand={myHand}
        opponentHand={opponentHand}
        myScore={myScore}
        opponentScore={opponentScore}
        selectedCardIndex={selectedCardIndex}
        onCardClick={handleCardClick}
        onBackToLobby={onBackToLobby}
      />
    </div>
  );
}
