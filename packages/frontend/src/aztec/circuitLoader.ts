/**
 * Circuit artifact loader.
 *
 * Fetches compiled Noir circuit JSON artifacts from the public directory
 * and caches them in memory for reuse across proof generation calls.
 */

export interface CircuitArtifact {
  bytecode: string;
  abi: unknown;
  noir_version?: string;
  hash?: number;
}

let proveHandArtifact: CircuitArtifact | null = null;
let gameMoveArtifact: CircuitArtifact | null = null;
export async function loadProveHandCircuit(): Promise<CircuitArtifact> {
  if (!proveHandArtifact) {
    const resp = await fetch('/circuits/prove_hand.json');
    if (!resp.ok) {
      throw new Error(`Failed to load prove_hand circuit: ${resp.status} ${resp.statusText}`);
    }
    proveHandArtifact = await resp.json();
  }
  return proveHandArtifact!;
}

export async function loadGameMoveCircuit(): Promise<CircuitArtifact> {
  if (!gameMoveArtifact) {
    const resp = await fetch('/circuits/game_move.json');
    if (!resp.ok) {
      throw new Error(`Failed to load game_move circuit: ${resp.status} ${resp.statusText}`);
    }
    gameMoveArtifact = await resp.json();
  }
  return gameMoveArtifact!;
}

