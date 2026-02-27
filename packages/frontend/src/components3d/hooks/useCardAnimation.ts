import { useState, useCallback } from 'react';
import type { Card, Player } from '../../types';

export interface FlyingCardState {
  card: Card;
  owner: Player;
  fromHandIndex: number;
  toRow: number;
  toCol: number;
  isOpponent: boolean;
  faceDown: boolean;
}

export function useCardAnimation() {
  const [flyingCard, setFlyingCard] = useState<FlyingCardState | null>(null);

  const startFlyAnimation = useCallback((state: FlyingCardState) => {
    setFlyingCard(state);
  }, []);

  const completeFlyAnimation = useCallback(() => {
    setFlyingCard(null);
  }, []);

  const isAnimatingCell = useCallback(
    (row: number, col: number) => {
      return flyingCard !== null && flyingCard.toRow === row && flyingCard.toCol === col;
    },
    [flyingCard],
  );

  return { flyingCard, startFlyAnimation, completeFlyAnimation, isAnimatingCell };
}
