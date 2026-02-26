import type { GameState, Player, Card } from '../types';
import { Hand } from '../components/Hand';
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
  myHand: Card[];
  opponentHand: Card[];
  myScore: number;
  opponentScore: number;
  selectedCardIndex: number | null;
  onCardClick: (index: number) => void;
  onBackToLobby: () => void;
}

// Force hand cards to display in a horizontal row
const handRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};

// Override the vertical card layout to horizontal
const handOverrideStyle = `
  .game-hud-overlay .hand__cards {
    flex-direction: row !important;
    gap: 6px !important;
  }
  .game-hud-overlay .hand {
    flex-direction: column !important;
    align-items: center !important;
    background: rgba(10, 15, 10, 0.7) !important;
    backdrop-filter: blur(8px) !important;
    border-radius: 12px !important;
    padding: 8px 12px !important;
    border: 1px solid rgba(123, 198, 126, 0.15) !important;
  }
  .game-hud-overlay .card--medium {
    transform: scale(0.75);
    margin: -4px;
  }
`;

export function GameHUD({
  gameState,
  playerNumber,
  gameId,
  gameOver,
  opponentDisconnected,
  isMyTurn,
  isFinished,
  myPlayer,
  myHand,
  opponentHand,
  myScore,
  opponentScore,
  selectedCardIndex,
  onCardClick,
  onBackToLobby,
}: GameHUDProps) {
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
    <div className="game-hud-overlay">
      <style>{handOverrideStyle}</style>

      {/* Top bar */}
      <div className="game-screen__top-bar" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 10 }}>
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

      {/* Game Over Overlay */}
      {gameOver && (
        <div className={`game-screen__result ${getWinnerClass()}`} style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 20 }}>
          <div className="game-screen__result-text">{getWinnerText()}</div>
          <div className="game-screen__result-score">
            {myScore} - {opponentScore}
          </div>
          <button className="btn btn--ghost" onClick={onBackToLobby} style={{ marginTop: 16 }}>
            Back to Lobby
          </button>
        </div>
      )}

      {/* Opponent hand - top center */}
      <div style={{ position: 'fixed', top: 44, left: '50%', transform: 'translateX(-50%)', zIndex: 5 }}>
        <div style={handRowStyle}>
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
      </div>

      {/* Player hand - bottom center */}
      <div style={{ position: 'fixed', bottom: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 5 }}>
        <div style={handRowStyle}>
          <Hand
            cards={myHand}
            owner={myPlayer}
            selectedIndex={selectedCardIndex}
            onCardClick={onCardClick}
            isCurrentPlayer={isMyTurn}
            label="You"
          />
          <div className="game-screen__score game-screen__score--player">
            {myScore}
          </div>
        </div>
      </div>

      {/* Hints */}
      {!isFinished && (
        <div style={{ position: 'fixed', bottom: 140, left: '50%', transform: 'translateX(-50%)', zIndex: 5 }}>
          {isMyTurn && selectedCardIndex === null && (
            <div className="game-screen__hint">Select a card from your hand</div>
          )}
          {isMyTurn && selectedCardIndex !== null && (
            <div className="game-screen__hint">Click an empty cell on the board to place your card</div>
          )}
          {!isMyTurn && (
            <div className="game-screen__hint">Waiting for opponent...</div>
          )}
        </div>
      )}
    </div>
  );
}
