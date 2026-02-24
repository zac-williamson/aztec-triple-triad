import { useState, useEffect, useMemo } from 'react';
import type { GameState, Player, Card } from '../types';
import type { TxStatus } from '../hooks/useGameContract';
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
  proofStatus?: string;
  handProofStatus?: string;
  txStatus?: TxStatus;
  canSettle?: boolean;
  onSettleGame?: (cardTokenId: number) => void;
  collectedProofCount?: number;
  myHandProofReady?: boolean;
  opponentHandProofReady?: boolean;
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
  proofStatus,
  handProofStatus,
  txStatus,
  canSettle,
  onSettleGame,
  collectedProofCount = 0,
  myHandProofReady = false,
  opponentHandProofReady = false,
}: GameScreenProps) {
  const [selectedCardIndex, setSelectedCardIndex] = useState<number | null>(null);
  const [capturedCells, setCapturedCells] = useState<{ row: number; col: number }[]>([]);
  const [selectedClaimCard, setSelectedClaimCard] = useState<number | null>(null);

  const myPlayer: Player = playerNumber === 1 ? 'player1' : 'player2';
  const isMyTurn = gameState.currentTurn === myPlayer;
  const isFinished = gameState.status === 'finished';

  const myHand = playerNumber === 1 ? gameState.player1Hand : gameState.player2Hand;
  const opponentHand = playerNumber === 1 ? gameState.player2Hand : gameState.player1Hand;
  const myScore = playerNumber === 1 ? gameState.player1Score : gameState.player2Score;
  const opponentScore = playerNumber === 1 ? gameState.player2Score : gameState.player1Score;

  const isWinner = gameOver?.winner === myPlayer;

  // Get opponent's cards on the board (for winner to pick from)
  const opponentBoardCards: Card[] = useMemo(() => {
    if (!isWinner) return [];
    const cards: Card[] = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const cell = gameState.board[r][c];
        if (cell.card && cell.owner !== myPlayer) {
          cards.push(cell.card);
        }
      }
    }
    // Also include opponent's remaining hand cards
    for (const card of opponentHand) {
      if (card) cards.push(card);
    }
    return cards;
  }, [isWinner, gameState.board, myPlayer, opponentHand]);

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

  const handleSettleClick = () => {
    if (!canSettle || !onSettleGame || selectedClaimCard === null) return;
    onSettleGame(selectedClaimCard);
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

      {/* Proof status bar */}
      <div className="game-screen__proof-bar">
        <div className={`game-screen__proof-indicator ${myHandProofReady ? 'game-screen__proof-indicator--ready' : handProofStatus === 'generating' ? 'game-screen__proof-indicator--generating' : ''}`}>
          {handProofStatus === 'generating' && <span className="game-screen__proof-spinner" />}
          Your proof: {myHandProofReady ? 'Ready' : handProofStatus === 'generating' ? 'Generating...' : 'Pending'}
        </div>
        <div className={`game-screen__proof-indicator ${opponentHandProofReady ? 'game-screen__proof-indicator--ready' : ''}`}>
          Opponent proof: {opponentHandProofReady ? 'Ready' : 'Pending'}
        </div>
        <div className={`game-screen__proof-indicator ${collectedProofCount >= 9 ? 'game-screen__proof-indicator--ready' : proofStatus === 'generating' ? 'game-screen__proof-indicator--generating' : ''}`}>
          {proofStatus === 'generating' && <span className="game-screen__proof-spinner" />}
          Moves proven: {collectedProofCount}/9
        </div>
        <div className={`game-screen__proof-indicator ${(collectedProofCount + (myHandProofReady ? 1 : 0) + (opponentHandProofReady ? 1 : 0)) >= 11 ? 'game-screen__proof-indicator--ready' : ''}`}>
          Total: {collectedProofCount + (myHandProofReady ? 1 : 0) + (opponentHandProofReady ? 1 : 0)}/11
        </div>
      </div>

      {gameOver && (
        <div className={`game-screen__result ${getWinnerClass()}`}>
          <div className="game-screen__result-text">{getWinnerText()}</div>
          <div className="game-screen__result-score">
            {myScore} - {opponentScore}
          </div>

          {/* Card claim UI for winner */}
          {isWinner && opponentBoardCards.length > 0 && (
            <div className="game-screen__claim-section">
              <p className="game-screen__claim-label">Select a card to claim:</p>
              <div className="game-screen__claim-cards">
                {opponentBoardCards.map((card) => (
                  <button
                    key={card.id}
                    className={`game-screen__claim-card ${selectedClaimCard === card.id ? 'game-screen__claim-card--selected' : ''}`}
                    onClick={() => setSelectedClaimCard(card.id)}
                  >
                    <span className="game-screen__claim-card-name">{card.name}</span>
                    <span className="game-screen__claim-card-ranks">
                      {card.ranks.top}/{card.ranks.right}/{card.ranks.bottom}/{card.ranks.left}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Settlement button */}
          {isWinner && canSettle && (
            <button
              className="btn btn--primary game-screen__settle-btn"
              onClick={handleSettleClick}
              disabled={selectedClaimCard === null || txStatus === 'proving' || txStatus === 'sending'}
            >
              {txStatus === 'proving'
                ? 'Generating aggregate proof...'
                : txStatus === 'sending'
                  ? 'Submitting transaction...'
                  : 'Settle Game On-Chain'}
            </button>
          )}

          {isWinner && !canSettle && (
            <p className="game-screen__settle-info">
              Collecting proofs for on-chain settlement...
              ({collectedProofCount}/9 moves, {myHandProofReady ? 1 : 0}/1 your hand, {opponentHandProofReady ? 1 : 0}/1 opponent hand)
            </p>
          )}

          <button className="btn btn--ghost" onClick={onBackToLobby}>
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

      {/* Proof generation and transaction status indicators */}
      {handProofStatus === 'generating' && (
        <div className="game-screen__status-bar game-screen__status-bar--proof">
          <div className="game-screen__status-spinner" />
          Generating hand proof (proving card ownership)...
        </div>
      )}
      {proofStatus === 'generating' && (
        <div className="game-screen__status-bar game-screen__status-bar--proof">
          <div className="game-screen__status-spinner" />
          Generating move proof ({collectedProofCount + 1}/9)...
        </div>
      )}
      {txStatus && txStatus !== 'idle' && txStatus !== 'confirmed' && txStatus !== 'error' && (
        <div className="game-screen__status-bar game-screen__status-bar--tx">
          <div className="game-screen__status-spinner" />
          {txStatus === 'preparing' && 'Preparing transaction...'}
          {txStatus === 'proving' && 'Generating aggregate proof...'}
          {txStatus === 'sending' && 'Sending transaction...'}
        </div>
      )}
      {txStatus === 'confirmed' && (
        <div className="game-screen__status-bar game-screen__status-bar--success">
          Game settled on-chain!
        </div>
      )}
      {txStatus === 'error' && (
        <div className="game-screen__status-bar game-screen__status-bar--error">
          Settlement failed. You can try again or return to lobby.
        </div>
      )}
    </div>
  );
}
