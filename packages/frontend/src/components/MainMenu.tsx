import { useState } from 'react';
import './MainMenu.css';

interface MainMenuProps {
  connected: boolean;
  aztecConnecting: boolean;
  aztecReady: boolean;
  cardCount: number;
  hasGameInProgress: boolean;
  onPlay: () => void;
  onTutorial: () => void;
  onCardPacks: () => void;
}

export function MainMenu({
  connected,
  aztecConnecting,
  aztecReady,
  cardCount,
  hasGameInProgress,
  onPlay,
  onTutorial,
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
      </div>

      <div className="main-menu__buttons">
        <button
          className="main-menu__btn main-menu__btn--play"
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
          disabled
          title="Coming soon"
        >
          <span className="main-menu__btn-icon">&#128214;</span>
          Tutorial
          <span className="main-menu__btn-badge">Soon</span>
        </button>

        <button
          className="main-menu__btn main-menu__btn--packs"
          onClick={onCardPacks}
          disabled={!connected}
        >
          <span className="main-menu__btn-icon">&#127183;</span>
          Card Packs
        </button>
      </div>

      {aztecConnecting && (
        <p className="main-menu__card-status">Loading your cards from Aztec...</p>
      )}

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
