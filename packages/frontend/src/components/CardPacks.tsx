import { useCallback } from 'react';
import { useAztecContext } from '../aztec/AztecContext';
import { useCardPacks, type HuntResult } from '../hooks/useCardPacks';
import { CARD_PACK_COST } from '../aztec/gameConstants';
import './CardPacks.css';

interface CardPacksProps {
  ownedCardIds: number[];
  tokenBalance: number;
  onPackOpened: (location: string, result: HuntResult) => void;
  onBack: () => void;
}

export function CardPacks({ ownedCardIds, tokenBalance, onPackOpened, onBack }: CardPacksProps) {
  const { wallet, nodeClient, accountAddress } = useAztecContext();
  const packs = useCardPacks(wallet, nodeClient, accountAddress);

  const canAfford = tokenBalance >= CARD_PACK_COST;
  const isBusy = packs.txStatus === 'sending' || packs.txStatus === 'confirming';

  const handlePurchase = useCallback(async () => {
    try {
      const result = await packs.hunt({ id: 1, name: 'Card Pack', description: '', cooldownHours: 0 });
      onPackOpened('Card Pack', result);
    } catch {
      // Error handled internally by useCardPacks
    }
  }, [packs, onPackOpened]);

  return (
    <div className="card-packs">
      <button className="card-packs__back" onClick={onBack}>
        &#8592; Back
      </button>

      <h1 className="card-packs__title">Card Packs</h1>
      <p className="card-packs__subtitle">Purchase a pack of 10 random cards</p>

      <div style={{
        maxWidth: 400,
        margin: '24px auto',
        textAlign: 'center',
      }}>
        <div style={{
          fontFamily: "'Cinzel', serif",
          fontSize: 18,
          color: '#c8a860',
          marginBottom: 8,
        }}>
          Your Balance: {tokenBalance} Arena Tokens
        </div>
        <div style={{
          fontFamily: "'Cinzel', serif",
          fontSize: 14,
          color: '#5a4a34',
          marginBottom: 24,
        }}>
          Cost: {CARD_PACK_COST} Arena Tokens | You own {ownedCardIds.length} cards
        </div>

        <button
          className="card-packs__hunt-btn"
          onClick={handlePurchase}
          disabled={!canAfford || isBusy}
          style={{ width: '100%', padding: '14px 20px', fontSize: 16 }}
        >
          {isBusy ? 'Purchasing...' : !canAfford ? 'Not Enough Tokens' : 'Purchase Card Pack'}
        </button>
      </div>

      {packs.error && (
        <div className="card-packs__error">{packs.error}</div>
      )}

      {/* Full-screen purchase overlay */}
      {packs.activeLocation && (
        <div className="card-packs__hunt-overlay">
          <div className="parchment-dialog card-packs__hunt-dialog">
            <h2 className="card-packs__hunt-overlay-title">
              Purchasing Card Pack...
            </h2>
            <div className="card-packs__hunt-overlay-scene">
              <img
                className="card-packs__hunt-overlay-sprite"
                src="/ui-elements/swamp.gif"
                alt="Card pack purchase"
                draggable={false}
              />
              <div className="card-packs__hunt-overlay-fireflies">
                <div className="card-packs__hunt-firefly" />
                <div className="card-packs__hunt-firefly" />
                <div className="card-packs__hunt-firefly" />
              </div>
            </div>
            <p className="card-packs__hunt-overlay-status">
              {packs.txStatus === 'sending' ? 'Sending transaction to Aztec...' : 'Waiting for confirmation...'}
            </p>
            <div className="card-packs__spinner card-packs__spinner--large" />
          </div>
        </div>
      )}
    </div>
  );
}
