import type { Card } from '../types';
import type { SettleTxStatus } from './GameScreen3D';

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
  const isProcessing = settleTxStatus !== 'idle' && settleTxStatus !== 'confirmed' && settleTxStatus !== 'error';
  const isSettled = settleTxStatus === 'confirmed';
  const hasPickedCard = settleTxStatus !== 'idle';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 30,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.75)', pointerEvents: 'auto',
    }}>
      <div style={{
        background: '#1a1a2e', border: '1px solid #333',
        borderRadius: 12, padding: 24, maxWidth: 500, width: '90%',
        textAlign: 'center',
      }}>
        {/* Victory header */}
        {resultText && (
          <div style={{ marginBottom: 8, color: '#4f4', fontSize: 22, fontWeight: 700 }}>
            {resultText}
          </div>
        )}
        {resultScore && (
          <div style={{ marginBottom: 12, color: '#aaa', fontSize: 16 }}>
            {resultScore}
          </div>
        )}

        {!hasPickedCard && (
          <>
            <h3 style={{ margin: '0 0 8px', color: '#fff', fontSize: 18 }}>
              Claim a Card
            </h3>
            <p style={{ margin: '0 0 16px', color: '#aaa', fontSize: 13 }}>
              Select one of your opponent's cards to claim as your prize.
            </p>
          </>
        )}

        {isProcessing && (
          <div style={{ margin: '16px 0', color: '#aaf', fontSize: 13 }}>
            {settleTxStatus === 'preparing' && 'Preparing settlement...'}
            {settleTxStatus === 'proving' && 'Generating on-chain proof...'}
            {settleTxStatus === 'sending' && 'Sending transaction...'}
          </div>
        )}

        {isSettled && (
          <div style={{ margin: '16px 0', color: '#4f4', fontSize: 14, fontWeight: 600 }}>
            Settlement confirmed!
          </div>
        )}

        {settleTxStatus === 'error' && (
          <div style={{ margin: '16px 0', color: '#f44', fontSize: 13 }}>
            Settlement failed. You can try again from the lobby.
          </div>
        )}

        {/* Card grid — only show when card hasn't been picked yet */}
        {!hasPickedCard && (
          <div style={{
            display: 'flex', gap: 12, justifyContent: 'center',
            flexWrap: 'wrap', marginBottom: 16,
          }}>
            {opponentCards.map((card) => (
              <button
                key={card.id}
                disabled={isProcessing}
                onClick={() => onSelect(card.id)}
                style={{
                  background: '#2a2a4e', border: '2px solid #555',
                  borderRadius: 8, padding: '12px 8px', cursor: isProcessing ? 'not-allowed' : 'pointer',
                  color: '#fff', minWidth: 80, textAlign: 'center',
                  opacity: isProcessing ? 0.5 : 1,
                  transition: 'border-color 0.15s',
                }}
                onMouseEnter={(e) => { if (!isProcessing) (e.target as HTMLElement).style.borderColor = '#88f'; }}
                onMouseLeave={(e) => { (e.target as HTMLElement).style.borderColor = '#555'; }}
              >
                <div style={{ fontSize: 11, color: '#aaa', marginBottom: 4 }}>#{card.id}</div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{card.name}</div>
                <div style={{ fontSize: 11, color: '#ccc', fontFamily: 'monospace' }}>
                  {card.ranks.top}/{card.ranks.right}/{card.ranks.bottom}/{card.ranks.left}
                </div>
              </button>
            ))}
          </div>
        )}

        {!hasPickedCard && opponentCards.length === 0 && (
          <div style={{ color: '#888', fontSize: 13, marginBottom: 16 }}>
            No opponent cards available.
          </div>
        )}

        {/* Back to Lobby: visible once settlement has started (or on error), or for cancel */}
        {hasPickedCard && onBackToLobby && (
          <button
            className="btn btn--ghost"
            onClick={onBackToLobby}
            style={{ marginTop: 12 }}
          >
            Back to Lobby
          </button>
        )}

        {/* Cancel only before a card is picked */}
        {!hasPickedCard && (
          <button
            className="btn btn--ghost btn--small"
            onClick={onCancel}
            style={{ marginTop: 8, opacity: 0.6 }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
