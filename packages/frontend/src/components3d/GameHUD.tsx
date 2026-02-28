import { useState } from 'react';
import type { GameState, Player } from '../types';
import type { ProofStatusInfo, SettleTxStatus } from './GameScreen3D';
import { SettlementCardPicker } from './SettlementCardPicker';
import '../components/GameScreen.css';

interface GameHUDProps {
  gameState: GameState;
  playerNumber: 1 | 2;
  gameId: string;
  gameOver: { winner: Player | 'draw' } | null;
  opponentDisconnected: boolean;
  isMyTurn: boolean;
  isFinished: boolean;
  myPlayer: Player;
  myScore: number;
  opponentScore: number;
  onBackToLobby: () => void;
  aztecStatus?: string;
  proofStatus?: ProofStatusInfo;
  canSettle?: boolean;
  onSettle?: (selectedCardId: number) => void;
  settleTxStatus?: SettleTxStatus;
}

function getProofStatusLabel(status: string): string {
  switch (status) {
    case 'idle': return '';
    case 'generating': return 'Generating proof...';
    case 'ready': return 'Proof ready';
    case 'error': return 'Proof error';
    default: return '';
  }
}

function getSettleTxLabel(status: SettleTxStatus): string {
  switch (status) {
    case 'idle': return '';
    case 'preparing': return 'Preparing settlement...';
    case 'proving': return 'Proving on-chain...';
    case 'sending': return 'Sending transaction...';
    case 'confirmed': return 'Settlement confirmed!';
    case 'error': return 'Settlement failed';
    default: return '';
  }
}

export function GameHUD({
  gameState,
  playerNumber,
  gameId,
  gameOver,
  opponentDisconnected,
  isMyTurn,
  isFinished,
  myPlayer,
  myScore,
  opponentScore,
  onBackToLobby,
  aztecStatus,
  proofStatus,
  canSettle,
  onSettle,
  settleTxStatus = 'idle',
}: GameHUDProps) {
  const [showCardPicker, setShowCardPicker] = useState(false);

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

  const handleSettleClick = () => {
    setShowCardPicker(true);
  };

  const handleCardPicked = (cardId: number) => {
    setShowCardPicker(false);
    onSettle?.(cardId);
  };

  const opponentHand = playerNumber === 1 ? gameState.player2Hand : gameState.player1Hand;

  // Proof status display
  const handLabel = proofStatus ? getProofStatusLabel(proofStatus.hand) : '';
  const moveLabel = proofStatus ? getProofStatusLabel(proofStatus.move) : '';
  const settleLabel = getSettleTxLabel(settleTxStatus);
  const showProofStatus = handLabel || moveLabel || settleLabel;

  return (
    <div className="game-hud-overlay" style={{ pointerEvents: 'none' }}>
      {/* Top bar */}
      <div className="game-screen__top-bar" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10, pointerEvents: 'auto' }}>
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
        <div className="game-screen__alert" style={{ position: 'fixed', top: 40, left: 0, right: 0, zIndex: 10 }}>
          Opponent disconnected
        </div>
      )}

      {/* Proof status indicator */}
      {showProofStatus && (
        <div style={{
          position: 'fixed', top: 44, left: 12, zIndex: 10,
          background: 'rgba(0,0,0,0.7)', borderRadius: 6, padding: '4px 10px',
          fontSize: 11, color: '#aaf', fontFamily: 'monospace',
        }}>
          {handLabel && <div>{handLabel}</div>}
          {moveLabel && <div>{moveLabel}</div>}
          {settleLabel && <div>{settleLabel}</div>}
        </div>
      )}

      {/* Aztec connection indicator */}
      {aztecStatus && aztecStatus !== 'unsupported' && (
        <div style={{
          position: 'fixed', top: 6, left: 12, zIndex: 10,
          fontSize: 10, color: aztecStatus === 'connected' ? '#4f4' : '#ff4',
          fontFamily: 'monospace',
        }}>
          Aztec: {aztecStatus}
        </div>
      )}

      {/* Game Over Overlay */}
      {gameOver && !showCardPicker && (
        <div className={`game-screen__result ${getWinnerClass()}`} style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 20, pointerEvents: 'auto' }}>
          <div className="game-screen__result-text">{getWinnerText()}</div>
          <div className="game-screen__result-score">
            {myScore} - {opponentScore}
          </div>
          {canSettle && onSettle && settleTxStatus === 'idle' && (
            <button
              className="btn btn--ghost"
              onClick={handleSettleClick}
              style={{ marginTop: 12 }}
            >
              Settle on Chain
            </button>
          )}
          {settleTxStatus === 'confirmed' && (
            <div style={{ marginTop: 12, color: '#4f4', fontSize: 13 }}>
              Game settled on-chain!
            </div>
          )}
          <button className="btn btn--ghost" onClick={onBackToLobby} style={{ marginTop: 16 }}>
            Back to Lobby
          </button>
        </div>
      )}

      {/* Settlement card picker modal */}
      {showCardPicker && (
        <SettlementCardPicker
          opponentCards={opponentHand}
          onSelect={handleCardPicked}
          onCancel={() => setShowCardPicker(false)}
          settleTxStatus={settleTxStatus}
        />
      )}

      {/* Scores */}
      <div style={{ position: 'fixed', top: 50, right: 20, zIndex: 5 }}>
        <div className="game-screen__score game-screen__score--opponent">
          {opponentScore}
        </div>
      </div>
      <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 5 }}>
        <div className="game-screen__score game-screen__score--player">
          {myScore}
        </div>
      </div>

      {/* Hints */}
      {!isFinished && (
        <div style={{ position: 'fixed', bottom: 140, left: '50%', transform: 'translateX(-50%)', zIndex: 5 }}>
          {isMyTurn && (
            <div className="game-screen__hint">
              {gameState.player1Hand.length + gameState.player2Hand.length === 10
                ? 'Select a card from your hand'
                : 'Click an empty cell on the board'}
            </div>
          )}
          {!isMyTurn && (
            <div className="game-screen__hint">Waiting for opponent...</div>
          )}
        </div>
      )}
    </div>
  );
}
