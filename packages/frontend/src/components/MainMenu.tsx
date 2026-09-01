import { useState } from 'react';
import type { StuckGame } from '../hooks/useGame';
import './MainMenu.css';

interface MainMenuProps {
  connected: boolean;
  aztecConnecting: boolean;
  aztecReady: boolean;
  cardCount: number;
  tokenBalance: number;
  accountAddress: string | null;
  hasGameInProgress: boolean;
  /** A game still holding this player's cards on-chain, if any. */
  stuckGame: StuckGame | null;
  isRecovering: boolean;
  onRecoverStuckGame: () => void;
  onContestClaim: () => void;
  onPlay: () => void;
  onTutorial: () => void;
  onPractice: () => void;
  onCardPacks: () => void;
}

export function MainMenu({
  connected,
  aztecConnecting,
  aztecReady,
  cardCount,
  tokenBalance,
  accountAddress,
  hasGameInProgress,
  stuckGame,
  isRecovering,
  onRecoverStuckGame,
  onContestClaim,
  onPlay,
  onTutorial,
  onPractice,
  onCardPacks,
}: MainMenuProps) {
  const [showNotEnoughCards, setShowNotEnoughCards] = useState(false);

  const canPlay = connected && aztecReady;

  const handlePlayClick = () => {
    if (cardCount < 5) {
      setShowNotEnoughCards(true);
    } else {
      onPlay();
    }
  };

  return (
    <div className="main-menu">
      <div className="main-menu__header">
        <h1 className="main-menu__title">Axalotl Arena</h1>
        <p className="main-menu__subtitle">Powered by Aztec Network</p>
        <div className={`main-menu__status ${connected ? 'main-menu__status--connected' : ''}`}>
          {connected ? 'Connected' : 'Connecting...'}
        </div>
        {connected && accountAddress && (
          <div style={{
            fontFamily: 'monospace',
            fontSize: 11,
            color: '#8a7a64',
            marginTop: 4,
            wordBreak: 'break-all',
            maxWidth: 400,
            textAlign: 'center',
          }}>
            {accountAddress}
          </div>
        )}
        {connected && (
          <div className="main-menu__token-balance" style={{
            fontFamily: "'Cinzel', serif",
            fontSize: 14,
            color: '#c8a860',
            marginTop: 8,
          }}>
            Arena Tokens: {tokenBalance} | Cards: {cardCount}
          </div>
        )}
      </div>

      <div className="main-menu__buttons">
        <button
          className="main-menu__btn main-menu__btn--play"
          data-testid="menu-play"
          onClick={handlePlayClick}
          disabled={!canPlay}
          title={!canPlay ? 'Connecting to server...' : undefined}
        >
          <span className="main-menu__btn-icon">&#9876;</span>
          {hasGameInProgress ? 'Resume' : 'Play'}
        </button>

        <button
          className="main-menu__btn main-menu__btn--tutorial"
          onClick={onTutorial}
        >
          <span className="main-menu__btn-icon">&#128214;</span>
          Tutorial
        </button>

        <button
          className="main-menu__btn main-menu__btn--practice"
          onClick={onPractice}
        >
          <span className="main-menu__btn-icon">&#129302;</span>
          Practice vs Bot
        </button>

        <button
          className="main-menu__btn main-menu__btn--packs"
          data-testid="menu-packs"
          onClick={onCardPacks}
          disabled={!connected}
        >
          <span className="main-menu__btn-icon">&#127183;</span>
          Buy Card Pack
        </button>
      </div>

      {aztecConnecting && (
        <p className="main-menu__card-status">Loading your cards from Aztec...</p>
      )}

      {/* Cards locked in a game nobody finished. Before this the only claim
          button lived on the game screen, so a player who closed the tab had
          no route back to their own cards. */}
      {stuckGame?.kind === 'claimable' && (
        <div className="main-menu__stuck" data-testid="stuck-game">
          <p className="main-menu__stuck-text">
            Five of your cards are still committed to an unfinished game.
          </p>
          <button
            className="main-menu__btn main-menu__btn--recover"
            data-testid="recover-stuck-game"
            onClick={onRecoverStuckGame}
            disabled={isRecovering || !connected}
          >
            {isRecovering ? 'Recovering your cards…' : 'Recover My Cards'}
          </button>
          <p className="main-menu__stuck-note">
            This proves the game was abandoned and returns your hand. It takes a
            few minutes and includes a short dispute window.
          </p>
        </div>
      )}

      {/* No button, because there is no action that would work: a finished game
          can only be settled by its winner. Saying so beats a button that
          spends a proof and a transaction to fail. */}
      {stuckGame?.kind === 'awaiting-winner' && (
        <div className="main-menu__stuck" data-testid="stuck-game-awaiting">
          <p className="main-menu__stuck-text">
            Your last game finished but was never settled, so its cards are still held.
          </p>
          <p className="main-menu__stuck-note">
            Only the winner can settle a completed game. If that was you, reopen
            it from Play; otherwise the cards are released when they do.
          </p>
        </div>
      )}

      {/* The contract will not accept a claim yet, so we do not offer one —
          we say how long. */}
      {stuckGame?.kind === 'too-soon' && (
        <div className="main-menu__stuck" data-testid="stuck-game-too-soon">
          <p className="main-menu__stuck-text">
            Five of your cards are committed to a game that has not finished.
          </p>
          <p className="main-menu__stuck-note">
            You can recover them if your opponent does not come back. That
            becomes available about {Math.max(1, Math.round((stuckGame.waitSeconds ?? 0) / 60))}
            {' '}minutes from now — the wait is what stops a claim being used to
            cut a live game short.
          </p>
        </div>
      )}

      {/* The other half of the dispute window: somebody has claimed our game
          as abandoned and we are here to say otherwise. */}
      {stuckGame?.kind === 'contestable' && (
        <div className="main-menu__stuck" data-testid="stuck-game-contestable">
          <p className="main-menu__stuck-text">
            Your opponent has claimed your last game was abandoned.
          </p>
          <button
            className="main-menu__btn main-menu__btn--recover"
            data-testid="contest-claim"
            onClick={onContestClaim}
            disabled={isRecovering || !connected}
          >
            {isRecovering ? 'Contesting…' : "I'm Still Here — Contest"}
          </button>
          <p className="main-menu__stuck-note">
            Contesting cancels their claim and puts the game back in play. You
            can do this once per game, so finish the game afterwards.
          </p>
        </div>
      )}

      {stuckGame?.kind === 'claimed-by-opponent' && (
        <div className="main-menu__stuck" data-testid="stuck-game-claimed">
          <p className="main-menu__stuck-text">
            Your last game was claimed as abandoned and the window to object has closed.
          </p>
          <p className="main-menu__stuck-note">
            Your own five cards are still yours to recover — they are returned
            per player, so nobody took them.
          </p>
        </div>
      )}

      {/* Both were `position: fixed; bottom: 16px; right: 16px`, so they sat on
          top of each other. One row that owns the corner; the buttons lay
          themselves out inside it. */}
      <div className="main-menu__utility-bar">
        <button
          className="main-menu__btn-clear"
          data-testid="repair-chain-sync"
          title="Rebuilds local chain-sync state (fixes 'PXE chain-sync is wedged' errors). Your account and cards are kept."
          onClick={async () => {
            const { repairChainSync } = await import('../aztec/connectToAztec');
            repairChainSync();
          }}
        >
          Repair Chain Sync
        </button>

        <button
          className="main-menu__btn-clear main-menu__btn-clear--destructive"
          data-testid="clear-all-state"
          title="Deletes this browser's account, keys and cards. There is no undo, and nothing is recoverable afterwards."
          onClick={async () => {
            const { clearAllState } = await import('../aztec/connectToAztec');
            clearAllState();
          }}
        >
          Clear All State
        </button>
      </div>

      {showNotEnoughCards && (
        <div className="main-menu__dialog-overlay" onClick={() => setShowNotEnoughCards(false)}>
          <div className="main-menu__dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="main-menu__dialog-title">Not Enough Cards</h3>
            <p className="main-menu__dialog-text">
              You need at least 5 cards to play. You currently have {cardCount}.
            </p>
            <p className="main-menu__dialog-text">
              Visit <strong>Card Packs</strong> to get more cards.
            </p>
            <button
              className="main-menu__btn main-menu__btn--play"
              onClick={() => setShowNotEnoughCards(false)}
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
