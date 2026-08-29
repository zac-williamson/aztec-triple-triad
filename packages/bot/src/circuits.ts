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
import type { ContractArtifactSource } from '../../frontend/src/aztec/contractArtifacts.js';

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

/** Compiled contract artifacts, as emitted by `aztec compile`. */
export const DEFAULT_CONTRACTS_DIR = resolve(
  import.meta.dirname ?? __dirname, '../../contracts/target',
);

export function fileContractArtifactSource(dir: string = DEFAULT_CONTRACTS_DIR): ContractArtifactSource {
  return async (file: string): Promise<unknown> => {
    const path = resolve(dir, `${file}.json`);
    if (!existsSync(path)) {
      throw new Error(
        `Contract artifact not found: ${path}. Compile the contracts first ` +
        `(cd packages/contracts && aztec compile), or pass a different directory.`,
      );
    }
    return JSON.parse(readFileSync(path, 'utf-8'));
  };
}

/**
 * Point the shared frontend loaders at the filesystem. Call ONCE at bot startup,
 * before any chain op — after that the bot runs the same proving and contract
 * code the browser does, which is what keeps its games genuinely
 * indistinguishable from a player's rather than a parallel implementation.
 */
export async function installNodeArtifactSources(opts: {
  circuitsDir?: string;
  contractsDir?: string;
} = {}): Promise<void> {
  const { setCircuitSource } = await import('../../frontend/src/aztec/circuitLoader.js');
  const { setContractArtifactSource } = await import('../../frontend/src/aztec/contractArtifacts.js');
  setCircuitSource(fileCircuitSource(opts.circuitsDir));
  setContractArtifactSource(fileContractArtifactSource(opts.contractsDir));
}
