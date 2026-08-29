/**
 * Contract artifact source — the contract-side twin of circuitLoader.
 *
 * The browser default fetches `/contracts/<file>.json` from the public
 * directory. The arena bot runs the same chain code in Node, where that URL does
 * not exist, so it installs a file-reading source once at startup
 * (docs/plan/BACKEND_OPPONENT.md phase 3).
 *
 * Centralised here because the three artifacts were being fetched from two
 * different modules (contracts.ts and noteImporter.ts), each with its own cache
 * and its own error string. One source, one cache, one place to override.
 */

/** Artifact file basenames, as emitted by `aztec compile` into target/. */
export const ARTIFACT_FILES = {
  game: 'triple_triad_game-TripleTriadGame',
  nft: 'triple_triad_nft-TripleTriadNFT',
  token: 'arena_token-ArenaToken',
} as const;

export type ArtifactName = keyof typeof ARTIFACT_FILES;

/** Resolves an artifact name to its parsed (not yet `loadContractArtifact`ed) JSON. */
export type ContractArtifactSource = (file: string) => Promise<unknown>;

const fetchFromPublicDir: ContractArtifactSource = async (file: string) => {
  const resp = await fetch(`/contracts/${file}.json`);
  if (!resp.ok) {
    throw new Error(`Failed to load contract artifact ${file}: ${resp.status} ${resp.statusText}`);
  }
  return await resp.json();
};

let source: ContractArtifactSource = fetchFromPublicDir;
const cache = new Map<string, unknown>();

/** Replace the artifact source (Node, tests). Clears the cache. */
export function setContractArtifactSource(next: ContractArtifactSource): void {
  source = next;
  cache.clear();
}

/** Restore the browser default. Primarily for tests. */
export function resetContractArtifactSource(): void {
  source = fetchFromPublicDir;
  cache.clear();
}

/** Load a raw artifact JSON by logical name, cached. */
export async function loadRawArtifact(name: ArtifactName): Promise<unknown> {
  const file = ARTIFACT_FILES[name];
  const cached = cache.get(file);
  if (cached) return cached;
  const artifact = await source(file);
  cache.set(file, artifact);
  return artifact;
}

/**
 * Register the three game contracts with a wallet so its PXE can decode their
 * notes. `Contract.at` alone is NOT enough — without registration, PXE sync
 * fails with "No artifact registered for contract class".
 *
 * Shared by the browser bootstrap (connectToAztec) and the arena bot, so both
 * register the same set the same way. Each contract is independent: a failure to
 * register one is logged and skipped rather than aborting the others, matching
 * the browser's original per-contract try/catch.
 */
export async function registerGameContracts(
  wallet: any,
  node: any,
  addresses: { nft?: string; game?: string; token?: string },
  log: (msg: string) => void = () => {},
): Promise<void> {
  const { AztecAddress } = await import('@aztec/aztec.js/addresses');
  const { loadContractArtifact } = await import('@aztec/aztec.js/abi');

  const entries: { name: ArtifactName; address?: string; alias: string }[] = [
    { name: 'nft', address: addresses.nft, alias: 'nft-contract' },
    { name: 'game', address: addresses.game, alias: 'game-contract' },
    { name: 'token', address: addresses.token, alias: 'token-contract' },
  ];

  for (const { name, address, alias } of entries) {
    if (!address) continue;
    const addr = AztecAddress.fromStringUnsafe(address);
    await wallet.registerSender(addr, alias);
    try {
      const instance = await node.getContract(addr);
      if (!instance) { log(`${name} contract not found on chain at ${address}`); continue; }
      await wallet.registerContract(instance, loadContractArtifact(await loadRawArtifact(name) as never));
      log(`${name} contract registered`);
    } catch (e) {
      log(`Failed to register ${name}: ${e}`);
    }
  }
}
