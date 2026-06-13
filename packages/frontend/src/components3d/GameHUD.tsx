import { useState } from 'react';
import type { GameState, Player, Card } from '../types';
import type { ProofStatusInfo, SettleTxStatus } from './GameScreen3D';
import { SettlementCardPicker } from './SettlementCardPicker';
import { ChainViewPanel, type ChainViewData } from './ChainViewPanel';
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
  opponentSettled?: boolean;
  takenCardId?: number | null;
  /** Data for the "you see / chain sees" privacy panel; omitting hides the toggle. */
  chainView?: ChainViewData;
  /**
   * Practice mode (local, no chain): suppress the settlement card-picker and
   * the on-chain result banner (Arena Tokens, "opponent settling"). The
   * practice screen renders its own end overlay instead.
   */
  practiceMode?: boolean;
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
  opponentSettled = false,
  takenCardId = null,
  chainView,
  practiceMode = false,
}: GameHUDProps) {
  const opponentPlayer: Player = myPlayer === 'player1' ? 'player2' : 'player1';
  const [chainViewOpen, setChainViewOpen] = useState(false);

  const myHand = playerNumber === 1 ? gameState.player1Hand : gameState.player2Hand;
  const opponentHand = playerNumber === 1 ? gameState.player2Hand : gameState.player1Hand;

  const getWinnerText = () => {
    if (!gameOver) return '';
    if (gameOver.winner === 'draw') return 'Draw!';
    if (gameOver.winner === myPlayer) return 'You Win!';
    return 'You Lose!';
  };

  const handleCardPicked = (cardId: number) => {
    onSettle?.(cardId);
  };

  // Collect opponent's cards from the board using originalOwner (never changes on capture).
  const opponentCardsForPicker: Card[] = [];
  for (const row of gameState.board) {
    for (const cell of row) {
      if (cell.card && cell.originalOwner === opponentPlayer) {
        opponentCardsForPicker.push(cell.card);
      }
    }
  }
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
        {chainView && (
          <button
            className="btn btn--ghost btn--small"
            onClick={() => setChainViewOpen(open => !open)}
            data-testid="chain-view-toggle"
            title="What can the blockchain see?"
            aria-pressed={chainViewOpen}
          >
            ◈ Chain view
          </button>
        )}
        <div className={`game-screen__turn ${isMyTurn ? 'game-screen__turn--yours' : ''}`}>
          {isFinished ? 'Game Over' : isMyTurn ? 'Your Turn' : "Opponent's Turn"}
        </div>
      </div>

      {chainViewOpen && chainView && (
        <ChainViewPanel
          data={chainView}
          myHand={myHand}
          opponentHandCount={opponentHand.length}
          onClose={() => setChainViewOpen(false)}
        />
      )}

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

      {/* Game Over: Winner sees card picker immediately, loser/draw sees result banner.
          Suppressed in practice mode — the practice screen owns its end overlay. */}
      {!practiceMode && gameOver && gameOver.winner === myPlayer && onSettle && (
        <SettlementCardPicker
          opponentCards={opponentCardsForPicker}
          onSelect={handleCardPicked}
          onCancel={onBackToLobby}
          settleTxStatus={settleTxStatus}
          resultText={getWinnerText()}
          resultScore={`${myScore} - ${opponentScore}`}
          onBackToLobby={onBackToLobby}
        />
      )}

      {!practiceMode && gameOver && gameOver.winner !== myPlayer && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div className="parchment-dialog" style={{ pointerEvents: 'auto', textAlign: 'center' }}>
            <div className="parchment-dialog__title" style={{ fontSize: 32, fontWeight: 900 }}>
              {getWinnerText()}
            </div>
            <div style={{ fontFamily: "'Cinzel', serif", fontSize: 20, color: '#5a4a34' }}>
              {myScore} - {opponentScore}
            </div>
            <div style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: '#2e6b1e', margin: '12px 0' }}>
              +20 Arena Tokens earned!
            </div>
            {gameOver.winner === 'draw' ? (
              <button className="parchment-dialog__btn" data-testid="back-to-lobby" onClick={onBackToLobby}>
                Back to Lobby
              </button>
            ) : !opponentSettled ? (
              <div style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: '#5a4a34', margin: '12px 0' }}>
                Opponent is selecting a card to take...
              </div>
            ) : (
              <>
                {takenCardId != null && takenCardId > 0 && (
                  <div style={{ fontFamily: "'Cinzel', serif", fontSize: 14, color: '#8a3020', margin: '8px 0' }}>
                    Your opponent took card #{takenCardId}
                  </div>
                )}
                <button className="parchment-dialog__btn" data-testid="back-to-lobby" onClick={onBackToLobby}>
                  Back to Lobby
                </button>
              </>
            )}
          </div>
        </div>
      )}

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
