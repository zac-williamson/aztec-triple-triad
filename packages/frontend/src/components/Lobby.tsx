import { useState, useEffect } from 'react';
import type { GameListEntry } from '../types';
import { getRandomHandIds } from '../cards';
import './Lobby.css';

interface LobbyProps {
  connected: boolean;
  gameList: GameListEntry[];
  error: string | null;
  ownedCardIds: number[];
  onCreateGame: (cardIds: number[]) => void;
  onJoinGame: (gameId: string, cardIds: number[]) => void;
  onRefreshList: () => void;
}

export function Lobby({ connected, gameList, error, ownedCardIds, onCreateGame, onJoinGame, onRefreshList }: LobbyProps) {
  const [joinGameId, setJoinGameId] = useState('');

  useEffect(() => {
    if (connected) {
      onRefreshList();
      const interval = setInterval(onRefreshList, 5000);
      return () => clearInterval(interval);
    }
  }, [connected, onRefreshList]);

  const hasCards = ownedCardIds.length >= 5;

  const handleCreate = () => {
    const cardIds = getRandomHandIds(ownedCardIds, 5);
    onCreateGame(cardIds);
  };

  const handleJoin = (gameId: string) => {
    const cardIds = getRandomHandIds(ownedCardIds, 5);
    onJoinGame(gameId, cardIds);
  };

  const waitingGames = gameList.filter(g => g.status === 'waiting');

  return (
    <div className="lobby" data-testid="lobby">
      <div className="lobby__header">
        <h1 className="lobby__title">Axolotl Arena</h1>
        <p className="lobby__subtitle">Powered by Aztec Network</p>
        <div className={`lobby__status ${connected ? 'lobby__status--connected' : ''}`}>
          {connected ? 'Connected' : 'Connecting...'}
        </div>
      </div>

      {error && <div className="lobby__error">{error}</div>}

      <div className="lobby__actions">
        <button className="btn btn--primary" onClick={handleCreate} disabled={!connected || !hasCards}>
          Create Game
        </button>
        {!hasCards && connected && (
          <p className="lobby__card-status">Loading your cards from Aztec...</p>
        )}
      </div>

      <div className="lobby__games">
        <div className="lobby__games-header">
          <h2>Open Games</h2>
          <button className="btn btn--ghost" onClick={onRefreshList} disabled={!connected}>
            Refresh
          </button>
        </div>

        {waitingGames.length === 0 ? (
          <div className="lobby__no-games">No games available. Create one!</div>
        ) : (
          <div className="lobby__game-list">
            {waitingGames.map((game) => (
              <div key={game.id} className="lobby__game-item">
                <div className="lobby__game-id">{game.id.slice(0, 8)}...</div>
                <div className="lobby__game-status">Waiting for opponent</div>
                <button className="btn btn--secondary" onClick={() => handleJoin(game.id)} disabled={!hasCards}>
                  Join
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="lobby__join-direct">
        <h3>Join by Game ID</h3>
        <div className="lobby__join-form">
          <input
            type="text"
            className="input"
            placeholder="Enter game ID..."
            value={joinGameId}
            onChange={(e) => setJoinGameId(e.target.value)}
          />
          <button
            className="btn btn--secondary"
            onClick={() => handleJoin(joinGameId)}
            disabled={!connected || !joinGameId || !hasCards}
          >
            Join
          </button>
        </div>
      </div>
    </div>
  );
}
