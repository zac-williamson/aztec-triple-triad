/**
 * Contract infrastructure — module-level cache and helpers for interacting
 * with Aztec contracts. Extracted from useGameSession to decouple from React.
 */

import { AZTEC_CONFIG } from './config';
import { getNftArtifact } from './noteImporter';

async function getSponsoredFee() {
  const [{ getContractInstanceFromInstantiationParams }, { SponsoredFPCContractArtifact }, { SPONSORED_FPC_SALT }, { SponsoredFeePaymentMethod }, { Fr }] = await Promise.all([
    import('@aztec/stdlib/contract'),
    import('@aztec/noir-contracts.js/SponsoredFPC'),
    import('@aztec/constants'),
    import('@aztec/aztec.js/fee'),
    import('@aztec/aztec.js/fields'),
  ]);
  const sponsoredFPC = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  return new SponsoredFeePaymentMethod(sponsoredFPC.address);
}

export const contractCache: {
  wallet: unknown | null;
  gameContract: any;
  nftContract: any;
  fee: any;
  Fr: any;
  AztecAddress: any;
  Contract: any;
  loadContractArtifact: any;
} = {
  wallet: null,
  gameContract: null,
  nftContract: null,
  fee: null,
  Fr: null,
  AztecAddress: null,
  Contract: null,
  loadContractArtifact: null,
};

export async function ensureContracts(wallet: unknown) {
  if (contractCache.wallet !== wallet) {
    contractCache.wallet = wallet;
    contractCache.gameContract = null;
    contractCache.nftContract = null;
    contractCache.fee = null;
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
    const gameAddr = AztecAddress.fromString(AZTEC_CONFIG.gameContractAddress);
    const gameResp = await fetch('/contracts/triple_triad_game-TripleTriadGame.json');
    if (!gameResp.ok) throw new Error('Failed to load game contract artifact');
    const gameArtifact = loadContractArtifact(await gameResp.json());
    contractCache.gameContract = await Contract.at(gameAddr, gameArtifact, wallet as never);
  }

  if (!contractCache.nftContract) {
    if (!AZTEC_CONFIG.nftContractAddress) throw new Error('nftContractAddress not configured');
    const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
    const nftArtifact = await getNftArtifact();
    contractCache.nftContract = await Contract.at(nftAddr, nftArtifact, wallet as never);
  }

  if (!contractCache.fee) {
    contractCache.fee = await getSponsoredFee();
  }

  return { gameContract: contractCache.gameContract, nftContract: contractCache.nftContract, fee: contractCache.fee, Fr, AztecAddress };
}

/** Pre-warm contract cache so first game operation is fast. */
let warmupStarted = false;
export function warmupContracts(wallet: unknown): void {
  if (warmupStarted) return;
  warmupStarted = true;
  ensureContracts(wallet).then(
    () => console.log('[contracts] Contracts pre-warmed'),
    (err) => {
      warmupStarted = false;
      console.error('[contracts] Contract warmup failed:', err);
    },
  );
}
