import type { Board as BoardType, Player } from '../types';
import { Card } from './Card';
import './Board.css';

interface BoardProps {
  board: BoardType;
  validPlacements?: { row: number; col: number }[];
  capturedCells?: { row: number; col: number }[];
  onCellClick?: (row: number, col: number) => void;
}

export function Board({ board, validPlacements = [], capturedCells = [], onCellClick }: BoardProps) {
  const isValid = (row: number, col: number) =>
    validPlacements.some(p => p.row === row && p.col === col);
  const isCaptured = (row: number, col: number) =>
    capturedCells.some(p => p.row === row && p.col === col);

  return (
    <div className="board" data-testid="board">
      {board.map((row, r) => (
        <div key={r} className="board__row">
          {row.map((cell, c) => {
            const valid = isValid(r, c);
            const captured = isCaptured(r, c);
            return (
              <div
                key={`${r}-${c}`}
                className={`board__cell ${valid ? 'board__cell--valid' : ''} ${!cell.card && onCellClick ? 'board__cell--clickable' : ''}`}
                onClick={() => valid && onCellClick?.(r, c)}
                data-testid={`cell-${r}-${c}`}
              >
                {cell.card ? (
                  <Card
                    card={cell.card}
                    owner={cell.owner}
                    captured={captured}
                    size="large"
                  />
                ) : (
                  <div className="board__cell-empty">
                    {valid && <div className="board__cell-indicator" />}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
