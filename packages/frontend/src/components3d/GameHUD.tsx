import type { GameState, Player } from '../types';
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

      {/* Game Over Overlay */}
      {gameOver && (
        <div className={`game-screen__result ${getWinnerClass()}`} style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 20, pointerEvents: 'auto' }}>
          <div className="game-screen__result-text">{getWinnerText()}</div>
          <div className="game-screen__result-score">
            {myScore} - {opponentScore}
          </div>
          <button className="btn btn--ghost" onClick={onBackToLobby} style={{ marginTop: 16 }}>
            Back to Lobby
          </button>
        </div>
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
