import type { Card as CardType, Player } from '../types';
import { Card } from './Card';
import './Hand.css';

interface HandProps {
  cards: CardType[];
  owner: Player;
  selectedIndex?: number | null;
  faceDown?: boolean;
  onCardClick?: (index: number) => void;
  isCurrentPlayer?: boolean;
  label?: string;
}

export function Hand({ cards, owner, selectedIndex, faceDown, onCardClick, isCurrentPlayer, label }: HandProps) {
  return (
    <div className={`hand ${isCurrentPlayer ? 'hand--active' : ''}`} data-testid={`hand-${owner}`}>
      {label && <div className="hand__label">{label}</div>}
      <div className="hand__cards">
        {cards.map((card, i) => (
          <Card
            key={`${card.id}-${i}`}
            card={card}
            owner={owner}
            selected={selectedIndex === i}
            faceDown={faceDown}
            onClick={onCardClick ? () => onCardClick(i) : undefined}
            size="medium"
          />
        ))}
      </div>
      {cards.length === 0 && (
        <div className="hand__empty">No cards</div>
      )}
    </div>
  );
}
