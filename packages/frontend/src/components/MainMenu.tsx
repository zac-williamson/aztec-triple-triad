import './MainMenu.css';

interface MainMenuProps {
  connected: boolean;
  hasCards: boolean;
  onPlay: () => void;
  onTutorial: () => void;
  onCardPacks: () => void;
}

export function MainMenu({ connected, hasCards, onPlay, onTutorial, onCardPacks }: MainMenuProps) {
  const canPlay = connected && hasCards;

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
          onClick={onPlay}
          disabled={!canPlay}
          title={!canPlay ? (connected ? 'You need at least 5 cards to play' : 'Connecting to server...') : undefined}
        >
          <span className="main-menu__btn-icon">&#9876;</span>
          Play
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

      {connected && !hasCards && (
        <p className="main-menu__card-status">Loading your cards from Aztec...</p>
      )}
    </div>
  );
}
