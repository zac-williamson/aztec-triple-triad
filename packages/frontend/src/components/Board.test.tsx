import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Board } from './Board';
import type { Board as BoardType, Card as CardType } from '../types';

function createEmptyBoard(): BoardType {
  return Array.from({ length: 3 }, () =>
    Array.from({ length: 3 }, () => ({ card: null, owner: null }))
  );
}

const testCard: CardType = {
  id: 1, name: 'Mudwalker', ranks: { top: 1, right: 4, bottom: 1, left: 5 },
};

describe('Board component', () => {
  it('should render 9 cells', () => {
    const board = createEmptyBoard();
    const { container } = render(<Board board={board} />);
    const cells = container.querySelectorAll('.board__cell');
    expect(cells).toHaveLength(9);
  });

  it('should render cards in cells', () => {
    const board = createEmptyBoard();
    board[0][0] = { card: testCard, owner: 'player1' };
    const { container } = render(<Board board={board} />);
    expect(container.querySelector('[data-testid="card-1"]')).toBeTruthy();
  });

  it('should show valid placements', () => {
    const board = createEmptyBoard();
    const validPlacements = [{ row: 0, col: 0 }, { row: 1, col: 1 }];
    const { container } = render(<Board board={board} validPlacements={validPlacements} />);
    const validCells = container.querySelectorAll('.board__cell--valid');
    expect(validCells).toHaveLength(2);
  });

  it('should handle cell clicks on valid cells', () => {
    const board = createEmptyBoard();
    const onCellClick = vi.fn();
    const validPlacements = [{ row: 0, col: 0 }];
    const { container } = render(
      <Board board={board} validPlacements={validPlacements} onCellClick={onCellClick} />
    );
    const cell = container.querySelector('[data-testid="cell-0-0"]');
    fireEvent.click(cell!);
    expect(onCellClick).toHaveBeenCalledWith(0, 0);
  });

  it('should not trigger click for invalid cells', () => {
    const board = createEmptyBoard();
    const onCellClick = vi.fn();
    const { container } = render(
      <Board board={board} validPlacements={[]} onCellClick={onCellClick} />
    );
    const cell = container.querySelector('[data-testid="cell-0-0"]');
    fireEvent.click(cell!);
    expect(onCellClick).not.toHaveBeenCalled();
  });

  it('should mark captured cells', () => {
    const board = createEmptyBoard();
    board[1][1] = { card: testCard, owner: 'player1' };
    const { container } = render(
      <Board board={board} capturedCells={[{ row: 1, col: 1 }]} />
    );
    expect(container.querySelector('.card--captured')).toBeTruthy();
  });
});
