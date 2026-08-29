/**
 * Circuit artifact loader.
 *
 * Loads compiled Noir circuit JSON artifacts and caches them in memory for
 * reuse across proof generation calls.
 *
 * The SOURCE is pluggable because the arena bot proves in Node, where there is
 * no `/circuits/…` URL to fetch (docs/plan/BACKEND_OPPONENT.md phase 3). The
 * browser default is unchanged — a same-origin fetch of the public directory —
 * and a Node caller installs a file-reading source once at startup via
 * `setCircuitSource`. Everything downstream (proofWorker) is otherwise already
 * environment-agnostic, so this is the only browser assumption in the proving
 * path.
 */

export interface CircuitArtifact {
  bytecode: string;
  abi: unknown;
  noir_version?: string;
  hash?: number;
}

/** Resolves a circuit name (e.g. 'prove_hand') to its parsed artifact. */
export type CircuitSource = (name: string) => Promise<CircuitArtifact>;

const fetchFromPublicDir: CircuitSource = async (name: string) => {
  const resp = await fetch(`/circuits/${name}.json`);
  if (!resp.ok) {
    throw new Error(`Failed to load ${name} circuit: ${resp.status} ${resp.statusText}`);
  }
  return await resp.json() as CircuitArtifact;
};

let source: CircuitSource = fetchFromPublicDir;
const cache = new Map<string, CircuitArtifact>();

/**
 * Replace the artifact source (Node, tests). Clears the cache so a switch
 * cannot serve artifacts loaded by the previous source.
 */
export function setCircuitSource(next: CircuitSource): void {
  source = next;
  cache.clear();
}

/** Restore the browser default. Primarily for tests. */
export function resetCircuitSource(): void {
  source = fetchFromPublicDir;
  cache.clear();
}

async function load(name: string): Promise<CircuitArtifact> {
  const cached = cache.get(name);
  if (cached) return cached;
  const artifact = await source(name);
  cache.set(name, artifact);
  return artifact;
}

export const loadProveHandCircuit = (): Promise<CircuitArtifact> => load('prove_hand');
export const loadGameMoveCircuit = (): Promise<CircuitArtifact> => load('game_move');
export const loadDummyMoveCircuit = (): Promise<CircuitArtifact> => load('dummy_move');
