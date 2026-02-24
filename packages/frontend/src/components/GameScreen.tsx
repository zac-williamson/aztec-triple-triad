import { useState, useEffect, useMemo } from 'react';
import type { GameState, Player } from '../types';
import { Board } from './Board';
import { Hand } from './Hand';
import './GameScreen.css';

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

export function GameScreen({
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

  // Get valid placements when a card is selected
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

  // Flash captures briefly
  useEffect(() => {
    if (lastCaptures.length > 0) {
      setCapturedCells(lastCaptures);
      const timer = setTimeout(() => setCapturedCells([]), 700);
      return () => clearTimeout(timer);
    }
  }, [lastCaptures]);

  // Reset selection when turn changes
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

  const getWinnerText = () => {
    if (!gameOver) return '';
    if (gameOver.winner === 'draw') return 'Draw!';
    if (gameOver.winner === myPlayer) return 'You Win!';
    return 'You Lose!';
  };

  const getWinnerClass = () => {
    if (!gameOver) return '';
    if (gameOver.winner === 'draw') return 'game-screen__result--draw';
    if (gameOver.winner === myPlayer) return 'game-screen__result--win';
    return 'game-screen__result--lose';
  };

  return (
    <div className="game-screen" data-testid="game-screen">
      <div className="game-screen__top-bar">
        <button className="btn btn--ghost btn--small" onClick={onBackToLobby}>
          &larr; Leave
        </button>
        <div className="game-screen__game-id">
          Game: {gameId.slice(0, 8)}
        </div>
        <div className={`game-screen__turn ${isMyTurn ? 'game-screen__turn--yours' : ''}`}>
          {isFinished ? 'Game Over' : isMyTurn ? 'Your Turn' : "Opponent's Turn"}
        </div>
      </div>

      {opponentDisconnected && (
        <div className="game-screen__alert">Opponent disconnected</div>
      )}

      {gameOver && (
        <div className={`game-screen__result ${getWinnerClass()}`}>
          <div className="game-screen__result-text">{getWinnerText()}</div>
          <div className="game-screen__result-score">
            {myScore} - {opponentScore}
          </div>
          <button className="btn btn--primary" onClick={onBackToLobby}>
            Back to Lobby
          </button>
        </div>
      )}

      <div className="game-screen__layout">
        <div className="game-screen__hand-area">
          <Hand
            cards={opponentHand}
            owner={playerNumber === 1 ? 'player2' : 'player1'}
            faceDown={!isFinished}
            label="Opponent"
          />
          <div className="game-screen__score game-screen__score--opponent">
            {opponentScore}
          </div>
        </div>

        <div className="game-screen__board-area">
          <Board
            board={gameState.board}
            validPlacements={validPlacements}
            capturedCells={capturedCells}
            onCellClick={handleCellClick}
          />
        </div>

        <div className="game-screen__hand-area">
          <Hand
            cards={myHand}
            owner={myPlayer}
            selectedIndex={selectedCardIndex}
            onCardClick={handleCardClick}
            isCurrentPlayer={isMyTurn}
            label="You"
          />
          <div className="game-screen__score game-screen__score--player">
            {myScore}
          </div>
        </div>
      </div>

      {!isFinished && isMyTurn && selectedCardIndex === null && (
        <div className="game-screen__hint">Select a card from your hand</div>
      )}
      {!isFinished && isMyTurn && selectedCardIndex !== null && (
        <div className="game-screen__hint">Click an empty cell to place your card</div>
      )}
      {!isFinished && !isMyTurn && (
        <div className="game-screen__hint">Waiting for opponent...</div>
      )}
    </div>
  );
}
