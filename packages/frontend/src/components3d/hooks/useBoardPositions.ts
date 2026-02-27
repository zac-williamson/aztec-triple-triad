import { useMemo } from 'react';
import { Vector3 } from 'three';

// Crate_02 model at CRATE_SCALE=0.006:
//   Perfect cube: 0.643m x 0.643m x 0.643m
// Grid spacing: 0.66m (crate width + small gap)
// Crate top at Y: 0.643m
const CELL_SIZE = 0.66;
const CRATE_TOP_Y = 0.643;
const BOARD_CENTER = new Vector3(0, CRATE_TOP_Y + 0.005, 0); // Just above crate top

export function useBoardPositions() {
  const positions = useMemo(() => {
    const grid: Vector3[][] = [];
    for (let row = 0; row < 3; row++) {
      grid[row] = [];
      for (let col = 0; col < 3; col++) {
        const x = (col - 1) * CELL_SIZE;
        const z = (row - 1) * CELL_SIZE;
        grid[row][col] = new Vector3(
          BOARD_CENTER.x + x,
          BOARD_CENTER.y,
          BOARD_CENTER.z + z
        );
      }
    }
    return grid;
  }, []);

  return { positions, cellSize: CELL_SIZE, boardCenter: BOARD_CENTER };
}
