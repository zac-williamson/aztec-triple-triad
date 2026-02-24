import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Card } from './Card';
import type { Card as CardType } from '../types';

// We need @testing-library/react
// Let's use basic rendering approach if not available
const testCard: CardType = {
  id: 1,
  name: 'Mudwalker',
  ranks: { top: 1, right: 4, bottom: 1, left: 5 },
};

describe('Card component', () => {
  it('should render card name', () => {
    const { container } = render(<Card card={testCard} owner="player1" />);
    expect(container.querySelector('.card__name')?.textContent).toBe('Mudwalker');
  });

  it('should render rank values', () => {
    const { container } = render(<Card card={testCard} owner="player1" />);
    const ranks = container.querySelectorAll('.card__rank');
    expect(ranks).toHaveLength(4);
    expect(container.querySelector('.card__rank--top')?.textContent).toBe('1');
    expect(container.querySelector('.card__rank--right')?.textContent).toBe('4');
    expect(container.querySelector('.card__rank--bottom')?.textContent).toBe('1');
    expect(container.querySelector('.card__rank--left')?.textContent).toBe('5');
  });

  it('should apply blue class for player1', () => {
    const { container } = render(<Card card={testCard} owner="player1" />);
    expect(container.querySelector('.card--blue')).toBeTruthy();
  });

  it('should apply red class for player2', () => {
    const { container } = render(<Card card={testCard} owner="player2" />);
    expect(container.querySelector('.card--red')).toBeTruthy();
  });

  it('should apply selected class', () => {
    const { container } = render(<Card card={testCard} owner="player1" selected />);
    expect(container.querySelector('.card--selected')).toBeTruthy();
  });

  it('should render face down', () => {
    const { container } = render(<Card card={testCard} faceDown />);
    expect(container.querySelector('.card--facedown')).toBeTruthy();
    expect(container.querySelector('.card__back')).toBeTruthy();
    expect(container.querySelector('.card__name')).toBeNull();
  });

  it('should handle click events', () => {
    const onClick = vi.fn();
    const { container } = render(<Card card={testCard} owner="player1" onClick={onClick} />);
    fireEvent.click(container.querySelector('.card')!);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('should format rank 10 as A', () => {
    const aceCard: CardType = {
      id: 46, name: 'Rosita', ranks: { top: 3, right: 10, bottom: 2, left: 1 },
    };
    const { container } = render(<Card card={aceCard} owner="player1" />);
    expect(container.querySelector('.card__rank--right')?.textContent).toBe('A');
  });

  it('should apply size classes', () => {
    const { container: small } = render(<Card card={testCard} size="small" />);
    expect(small.querySelector('.card--small')).toBeTruthy();

    const { container: large } = render(<Card card={testCard} size="large" />);
    expect(large.querySelector('.card--large')).toBeTruthy();
  });
});
