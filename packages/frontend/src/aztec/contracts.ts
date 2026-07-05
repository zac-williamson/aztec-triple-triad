/**
 * Contract infrastructure — module-level cache and helpers for interacting
 * with Aztec contracts.
 *
 * PRIVATE to the PXE door: this module is imported ONLY by `pxe.ts` (the serial
 * queue) and the Lane-8 `testkit/api.ts` reader (which enqueues). `contractCache`
 * is deliberately NOT exported — handing out a raw contract instance lets a
 * caller `.simulate()/.send()` it outside the queue, the leak the single-door
 * refactor closes. Callers get values through `pxe.ts` named ops, never contracts.
 */

import { AZTEC_CONFIG } from './config';
import { getNftArtifact } from './noteImporter';

// Fees: every game tx is paid natively in Fee Juice by the sending account
// (funded during onboarding — bridge claim on devnet, manual bridge on
// testnet). Senders simply omit the `fee` option; the wallet defaults to
// the sender paying from its own Fee Juice balance. SponsoredFPC is BANNED
// (MASTER_PLAN ground rules).

const contractCache: {
  wallet: unknown | null;
  gameContract: any;
  nftContract: any;
  tokenContract: any;
  Fr: any;
  AztecAddress: any;
  Contract: any;
  loadContractArtifact: any;
} = {
  wallet: null,
  gameContract: null,
  nftContract: null,
  tokenContract: null,
  Fr: null,
  AztecAddress: null,
  Contract: null,
  loadContractArtifact: null,
};

export async function ensureContracts(wallet: unknown) {
  console.log(`[PXE-TRACE] ${Date.now()} ensureContracts called (cached=${contractCache.wallet === wallet && !!contractCache.gameContract})`);
  if (contractCache.wallet !== wallet) {
    contractCache.wallet = wallet;
    contractCache.gameContract = null;
    contractCache.nftContract = null;
    contractCache.tokenContract = null;
  }

  if (!contractCache.Fr) {
    const [{ AztecAddress }, { Contract }, { loadContractArtifact }, { Fr }] = await Promise.all([
      import('@aztec/aztec.js/addresses'),
      import('@aztec/aztec.js/contracts'),
      import('@aztec/aztec.js/abi'),
      import('@aztec/aztec.js/fields'),
    ]);
    contractCache.Fr = Fr;
    contractCache.AztecAddress = AztecAddress;
    contractCache.Contract = Contract;
    contractCache.loadContractArtifact = loadContractArtifact;
  }

  const { Fr, AztecAddress, Contract, loadContractArtifact } = contractCache;

  if (!contractCache.gameContract) {
    if (!AZTEC_CONFIG.gameContractAddress) throw new Error('gameContractAddress not configured');
    const gameAddr = AztecAddress.fromStringUnsafe(AZTEC_CONFIG.gameContractAddress);
    const gameResp = await fetch('/contracts/triple_triad_game-TripleTriadGame.json');
    if (!gameResp.ok) throw new Error('Failed to load game contract artifact');
    const gameArtifact = loadContractArtifact(await gameResp.json());
    console.log(`[PXE-TRACE] ${Date.now()} Contract.at(Game, ${gameAddr})`);
    contractCache.gameContract = await Contract.at(gameAddr, gameArtifact, wallet as never);
  }

  if (!contractCache.nftContract) {
    if (!AZTEC_CONFIG.nftContractAddress) throw new Error('nftContractAddress not configured');
    const nftAddr = AztecAddress.fromStringUnsafe(AZTEC_CONFIG.nftContractAddress);
    const nftArtifact = await getNftArtifact();
    console.log(`[PXE-TRACE] ${Date.now()} Contract.at(NFT, ${nftAddr})`);
    contractCache.nftContract = await Contract.at(nftAddr, nftArtifact, wallet as never);
  }

  if (!contractCache.tokenContract && AZTEC_CONFIG.tokenContractAddress) {
    const tokenAddr = AztecAddress.fromStringUnsafe(AZTEC_CONFIG.tokenContractAddress);
    const tokenResp = await fetch('/contracts/arena_token-ArenaToken.json');
    if (tokenResp.ok) {
      const tokenArtifact = loadContractArtifact(await tokenResp.json());
      contractCache.tokenContract = await Contract.at(tokenAddr, tokenArtifact, wallet as never);
    }
  }

  return { gameContract: contractCache.gameContract, nftContract: contractCache.nftContract, tokenContract: contractCache.tokenContract, Fr, AztecAddress };
}

/** Pre-warm contract cache so first game operation is fast. */
let warmupStarted = false;
let warmupPromise: Promise<void> | null = null;
export function warmupContracts(wallet: unknown): void {
  if (warmupStarted) return;
  warmupStarted = true;
  warmupPromise = ensureContracts(wallet).then(
    () => { console.log('[contracts] Contracts pre-warmed'); },
    (err) => {
      warmupStarted = false;
      warmupPromise = null;
      console.error('[contracts] Contract warmup failed:', err);
    },
  );
}

/** Wait for warmup to complete (no-op if already done or never started). */
export function waitForWarmup(): Promise<void> {
  return warmupPromise ?? Promise.resolve();
}
