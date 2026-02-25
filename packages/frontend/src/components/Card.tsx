import { useState } from 'react';
import { type Card as CardType, type Player } from '../types';
import { formatRank, getCardRarity } from '../cards';
import './Card.css';

interface CardProps {
  card: CardType;
  owner?: Player | null;
  selected?: boolean;
  faceDown?: boolean;
  captured?: boolean;
  onClick?: () => void;
  size?: 'small' | 'medium' | 'large';
}

export function Card({ card, owner, selected, faceDown, captured, onClick, size = 'medium' }: CardProps) {
  const [imgError, setImgError] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const rarity = getCardRarity(card.id);
  const ownerClass = owner === 'player1' ? 'card--blue' : owner === 'player2' ? 'card--red' : '';
  const classes = [
    'card',
    `card--${size}`,
    `card--rarity-${rarity}`,
    ownerClass,
    selected ? 'card--selected' : '',
    faceDown ? 'card--facedown' : '',
    captured ? 'card--captured' : '',
    onClick ? 'card--clickable' : '',
  ].filter(Boolean).join(' ');

  if (faceDown) {
    return (
      <div className={classes} onClick={onClick}>
        <div className="card__back">
          <div className="card__back-pattern" />
        </div>
      </div>
    );
  }

  const cardLevel = Math.ceil(card.id / 10);
  const totalRanks = card.ranks.top + card.ranks.right + card.ranks.bottom + card.ranks.left;
  const imgSrc = `/cards/card-${card.id}.png`;

  return (
    <div
      className={classes}
      onClick={onClick}
      data-testid={`card-${card.id}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <div className="card__inner">
        <div className="card__rank card__rank--top">{formatRank(card.ranks.top)}</div>
        <div className="card__rank card__rank--right">{formatRank(card.ranks.right)}</div>
        <div className="card__rank card__rank--bottom">{formatRank(card.ranks.bottom)}</div>
        <div className="card__rank card__rank--left">{formatRank(card.ranks.left)}</div>
        <div className="card__art">
          {!imgError ? (
            <img
              className="card__art-image"
              src={imgSrc}
              alt={card.name}
              onError={() => setImgError(true)}
              draggable={false}
            />
          ) : (
            <div className={`card__art-placeholder card__art-level-${cardLevel}`}>
              <span className="card__art-power">{totalRanks}</span>
            </div>
          )}
        </div>
        <div className="card__name">{card.name}</div>
        {showTooltip && (
          <div className={`card__rarity-label card__rarity-label--${rarity}`}>
            {rarity.charAt(0).toUpperCase() + rarity.slice(1)}
          </div>
        )}
      </div>
    </div>
  );
}
