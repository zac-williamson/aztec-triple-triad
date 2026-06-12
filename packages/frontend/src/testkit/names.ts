/**
 * Scene-graph object names — the 3D analog of data-testids. BoardCell3D and
 * PlayerHand3D tag their interaction meshes with these so the testkit can
 * resolve real rendered world positions without replicating layout math.
 * Dependency-free on purpose: importing this costs the app nothing.
 */
export const CELL_NAME = (row: number, col: number) => `testkit-cell-${row}-${col}`;
export const HAND_PLANE_NAME = 'testkit-hand-plane';
