/**
 * Node-side circuit artifact source.
 *
 * The proving stack (packages/frontend/src/aztec/proofWorker.ts) is already
 * environment-agnostic — its only browser assumption was circuitLoader fetching
 * `/circuits/<name>.json` over HTTP. Installing this source lets the bot prove
 * in Node with the SAME code the browser runs, which is what keeps bot proofs
 * genuinely identical to a player's rather than a parallel implementation that
 * can silently drift.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { CircuitArtifact, CircuitSource } from '../../frontend/src/aztec/circuitLoader.js';

/** Default: the repo's compiled circuit output. */
export const DEFAULT_CIRCUITS_DIR = resolve(
  import.meta.dirname ?? __dirname, '../../../circuits/target',
);

export function fileCircuitSource(dir: string = DEFAULT_CIRCUITS_DIR): CircuitSource {
  return async (name: string): Promise<CircuitArtifact> => {
    const path = resolve(dir, `${name}.json`);
    if (!existsSync(path)) {
      throw new Error(
        `Circuit artifact not found: ${path}. Compile the circuits first ` +
        `(cd circuits && nargo compile), or pass a different directory.`,
      );
    }
    return JSON.parse(readFileSync(path, 'utf-8')) as CircuitArtifact;
  };
}
