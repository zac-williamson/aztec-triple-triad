import { useState } from 'react';
import type { Card } from '../types';
import type { SettleTxStatus } from './GameScreen3D';
import './SettlementCardPicker.css';

interface SettlementCardPickerProps {
  opponentCards: Card[];
  onSelect: (cardId: number) => void;
  onCancel: () => void;
  settleTxStatus: SettleTxStatus;
  resultText?: string;
  resultScore?: string;
  onBackToLobby?: () => void;
}

export function SettlementCardPicker({
  opponentCards,
  onSelect,
  onCancel,
  settleTxStatus,
  resultText,
  resultScore,
  onBackToLobby,
}: SettlementCardPickerProps) {
  // Track local "card selected" state — covers the gap between clicking a card
  // and settleTxStatus changing from 'idle' (e.g. while waiting for 9th proof).
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const hasPickedCard = selectedId !== null || settleTxStatus !== 'idle';
  const isProcessing = hasPickedCard && settleTxStatus !== 'confirmed' && settleTxStatus !== 'error';
  const isSettled = settleTxStatus === 'confirmed';

  const handleSelect = (cardId: number) => {
    setSelectedId(cardId);
    onSelect(cardId);
  };

  return (
    <div className="settle-overlay">
      <div className="parchment-dialog settle-dialog">
        {/* Victory header */}
        {resultText && (
          <div className="parchment-dialog__title" style={{ fontSize: 28, fontWeight: 900 }}>
            {resultText}
          </div>
        )}
        {resultScore && (
          <div className="settle-score">{resultScore}</div>
        )}

        {!hasPickedCard && (
          <>
            <h3 className="settle-heading">Claim a Card</h3>
            <p className="settle-subtext">
              Select one of your opponent's cards to claim as your prize.
            </p>
          </>
        )}

        {isProcessing && (
          <div className="settle-status settle-status--processing">
            {settleTxStatus === 'idle' && 'Collecting move proofs...'}
            {settleTxStatus === 'preparing' && 'Preparing settlement...'}
            {settleTxStatus === 'proving' && 'Generating on-chain proof...'}
            {settleTxStatus === 'sending' && 'Sending transaction...'}
          </div>
        )}

        {isSettled && (
          <div className="settle-status settle-status--success">
            Settlement confirmed!
          </div>
        )}

        {settleTxStatus === 'error' && (
          <div className="settle-status settle-status--error">
            Settlement failed. You can try again from the lobby.
          </div>
        )}

        {/* Card grid */}
        {!hasPickedCard && (
          <div className="settle-card-grid">
            {opponentCards.map((card) => (
              <button
                key={card.id}
                disabled={isProcessing}
                onClick={() => handleSelect(card.id)}
                className="settle-card"
              >
                <div className="settle-card__id">#{card.id}</div>
                <div className="settle-card__name">{card.name}</div>
                <div className="settle-card__ranks">
                  {card.ranks.top}/{card.ranks.right}/{card.ranks.bottom}/{card.ranks.left}
                </div>
              </button>
            ))}
          </div>
        )}

        {!hasPickedCard && opponentCards.length === 0 && (
          <div className="settle-subtext">No opponent cards available.</div>
        )}

        {hasPickedCard && onBackToLobby && (
          <button className="parchment-dialog__btn" onClick={onBackToLobby}>
            Back to Lobby
          </button>
        )}

        {!hasPickedCard && (
          <button
            className="parchment-dialog__btn"
            onClick={onCancel}
            style={{ opacity: 0.7 }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
