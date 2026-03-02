import { useState, useCallback, useRef } from 'react';
import { Card } from './Card';
import { getCardById } from '../cards';
import type { Card as CardType } from '../types';
import './CardSelector.css';

interface CardSelectorProps {
  ownedCardIds: number[];
  onConfirm: (ids: number[]) => void;
  onBack: () => void;
}

export function CardSelector({ ownedCardIds, onConfirm, onBack }: CardSelectorProps) {
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);

  // Group owned cards: count how many of each card the player owns
  const ownedCounts = new Map<number, number>();
  for (const id of ownedCardIds) {
    ownedCounts.set(id, (ownedCounts.get(id) || 0) + 1);
  }

  // Unique cards for display
  const uniqueCards: CardType[] = [];
  const seen = new Set<number>();
  for (const id of ownedCardIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const card = getCardById(id);
    if (card) uniqueCards.push(card);
  }

  // How many of a given card are currently selected
  const selectedCounts = (id: number) => selectedIds.filter(x => x === id).length;

  const toggleCard = useCallback((id: number) => {
    setSelectedIds(prev => {
      const currentlySelected = prev.filter(x => x === id).length;
      const owned = ownedCounts.get(id) || 0;
      if (currentlySelected > 0 && currentlySelected >= owned) {
        // Already selected max copies — remove one
        const idx = prev.lastIndexOf(id);
        return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      }
      if (currentlySelected > 0 && prev.length >= 5) {
        // Hand full — remove one copy instead
        const idx = prev.lastIndexOf(id);
        return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      }
      if (prev.length >= 5) return prev;
      // Add another copy
      return [...prev, id];
    });
  }, [ownedCounts]);

  const deselectSlot = useCallback((slotIndex: number) => {
    setSelectedIds(prev => [...prev.slice(0, slotIndex), ...prev.slice(slotIndex + 1)]);
  }, []);

  const handleConfirm = useCallback(() => {
    if (selectedIds.length === 5) {
      onConfirm(selectedIds);
    }
  }, [selectedIds, onConfirm]);

  // Determine grid columns for edge-aware scaling
  const getEdgeClasses = (index: number, total: number) => {
    const cols = 6;
    const col = index % cols;
    const row = Math.floor(index / cols);
    const totalRows = Math.ceil(total / cols);
    const classes: string[] = [];
    if (col === 0) classes.push('card-selector__grid-item--left-edge');
    if (col === cols - 1) classes.push('card-selector__grid-item--right-edge');
    if (row === 0) classes.push('card-selector__grid-item--top-edge');
    if (row === totalRows - 1) classes.push('card-selector__grid-item--bottom-edge');
    return classes.join(' ');
  };

  const selectedCards: (CardType | undefined)[] = selectedIds.map(id => getCardById(id));

  return (
    <div className="card-selector">
      <button className="card-selector__back" onClick={onBack}>
        &#8592; Back
      </button>

      {/* Left: Collection grid */}
      <div className="card-selector__collection">
        <h2 className="card-selector__collection-title">
          Your Collection ({ownedCardIds.length} cards)
        </h2>
        <div className="card-selector__grid" ref={gridRef}>
          {uniqueCards.map((card, idx) => {
            const owned = ownedCounts.get(card.id) || 1;
            const selected = selectedCounts(card.id);
            const allSelected = selected >= owned;
            return (
              <div
                key={card.id}
                className={[
                  'card-selector__grid-item',
                  selected > 0 ? 'card-selector__grid-item--selected' : '',
                  allSelected ? 'card-selector__grid-item--all-selected' : '',
                  getEdgeClasses(idx, uniqueCards.length),
                ].filter(Boolean).join(' ')}
                onClick={() => toggleCard(card.id)}
              >
                <Card card={card} size="small" />
                {owned > 1 && (
                  <span className="card-selector__count-badge">
                    {selected > 0 ? `${selected}/` : ''}x{owned}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: Selected hand */}
      <div className="card-selector__hand">
        <h2 className="card-selector__hand-title">Your Hand</h2>
        <div className="card-selector__slots">
          {Array.from({ length: 5 }).map((_, i) => {
            const card = selectedCards[i];
            if (card) {
              return (
                <div
                  key={`slot-${i}`}
                  className="card-selector__slot card-selector__slot--filled"
                  onClick={() => deselectSlot(i)}
                >
                  <Card card={card} size="medium" />
                </div>
              );
            }
            return (
              <div key={`empty-${i}`} className="card-selector__slot">
                {i + 1}
              </div>
            );
          })}
        </div>

        <button
          className="card-selector__play-btn"
          disabled={selectedIds.length !== 5}
          onClick={handleConfirm}
        >
          Play!
        </button>
        <div className="card-selector__count">
          {selectedIds.length}/5 cards selected
        </div>
      </div>
    </div>
  );
}
