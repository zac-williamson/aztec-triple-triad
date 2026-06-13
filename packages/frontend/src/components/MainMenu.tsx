import { useState } from 'react';
import './MainMenu.css';

interface MainMenuProps {
  connected: boolean;
  aztecConnecting: boolean;
  aztecReady: boolean;
  cardCount: number;
  tokenBalance: number;
  accountAddress: string | null;
  hasGameInProgress: boolean;
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

      <button
        className="main-menu__btn-clear"
        onClick={async () => {
          // Read stored IDB names BEFORE clearing localStorage
          const idbNames = JSON.parse(localStorage.getItem('aztec_idb_names') ?? '[]') as string[];
          localStorage.clear();
          sessionStorage.clear();

          // Delete known Aztec IndexedDB databases by name (works in Safari
          // which lacks indexedDB.databases())
          for (const name of idbNames) {
            indexedDB.deleteDatabase(name);
          }

          // Chrome/Firefox: enumerate and delete ALL IndexedDB databases
          if (typeof indexedDB.databases === 'function') {
            try {
              const dbs = await indexedDB.databases();
              for (const db of dbs) {
                if (db.name) indexedDB.deleteDatabase(db.name);
              }
            } catch { /* ignore */ }
          }

          window.location.reload();
        }}
      >
        Clear All State
      </button>

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
