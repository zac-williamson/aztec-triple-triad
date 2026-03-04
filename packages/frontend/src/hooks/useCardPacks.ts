import { useState, useCallback, useEffect, useRef } from 'react';

export interface LocationInfo {
  id: number;
  name: string;
  description: string;
  cooldownHours: number;
  methodName: string;
}

export const LOCATIONS: LocationInfo[] = [
  { id: 1, name: 'River', description: 'Shallow waters teeming with common axolotls', cooldownHours: 4, methodName: 'get_cards_from_river' },
  { id: 2, name: 'Forest', description: 'Dense canopy hiding uncommon species', cooldownHours: 8, methodName: 'get_cards_from_forest' },
  { id: 3, name: 'Beach', description: 'Tidal pools with rare coastal dwellers', cooldownHours: 12, methodName: 'get_cards_from_beach' },
  { id: 4, name: 'City', description: 'Urban waterways harbor exotic specimens', cooldownHours: 16, methodName: 'get_cards_from_city' },
  { id: 5, name: 'Dockyard', description: 'Deep harbor waters conceal legendary creatures', cooldownHours: 20, methodName: 'get_cards_from_dockyard' },
];

export type PackTxStatus = 'idle' | 'sending' | 'confirming' | 'done' | 'error';

export interface UseCardPacksReturn {
  cooldowns: Record<number, number>;
  txStatus: PackTxStatus;
  activeLocation: string | null;
  error: string | null;
  hunt: (location: LocationInfo) => Promise<number[]>;
  refreshCooldowns: () => Promise<void>;
}

async function loadNftContract(wallet: any, AztecAddress: any, configAddress: string) {
  const { loadContractArtifact } = await import('@aztec/aztec.js/abi');
  const { Contract } = await import('@aztec/aztec.js/contracts');
  const nftAddr = AztecAddress.fromString(configAddress);
  const resp = await fetch('/contracts/triple_triad_nft-TripleTriadNFT.json');
  const rawArtifact = await resp.json();
  const artifact = loadContractArtifact(rawArtifact);
  return Contract.at(nftAddr, artifact, wallet);
}

export function useCardPacks(
  wallet: unknown | null,
  accountAddress: string | null,
): UseCardPacksReturn {
  const [cooldowns, setCooldowns] = useState<Record<number, number>>({});
  const [txStatus, setTxStatus] = useState<PackTxStatus>('idle');
  const [activeLocation, setActiveLocation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sdkCacheRef = useRef<any>(null);

  const getSDK = useCallback(async () => {
    if (sdkCacheRef.current) return sdkCacheRef.current;
    const [
      { AztecAddress },
      { SponsoredFeePaymentMethod },
      { getContractInstanceFromInstantiationParams },
      { SponsoredFPCContractArtifact },
      { SPONSORED_FPC_SALT },
      { Fr },
    ] = await Promise.all([
      import('@aztec/aztec.js/addresses'),
      import('@aztec/aztec.js/fee'),
      import('@aztec/stdlib/contract'),
      import('@aztec/noir-contracts.js/SponsoredFPC'),
      import('@aztec/constants'),
      import('@aztec/aztec.js/fields'),
    ]);
    const sponsoredFPC = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
      salt: new Fr(SPONSORED_FPC_SALT),
    });
    const paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address);
    sdkCacheRef.current = { AztecAddress, paymentMethod };
    return sdkCacheRef.current;
  }, []);

  const refreshCooldowns = useCallback(async () => {
    if (!wallet || !accountAddress) return;
    try {
      const { AztecAddress } = await getSDK();
      const { AZTEC_CONFIG } = await import('../aztec/config');
      if (!AZTEC_CONFIG.nftContractAddress) return;

      const nftContract = await loadNftContract(wallet, AztecAddress, AZTEC_CONFIG.nftContractAddress);
      const addr = AztecAddress.fromString(accountAddress);
      const newCooldowns: Record<number, number> = {};

      for (const loc of LOCATIONS) {
        try {
          const result = await nftContract.methods
            .get_player_cooldown(addr, loc.id)
            .simulate({ from: addr });
          const lastCallEpochSec = Number(result);
          if (lastCallEpochSec === 0) {
            newCooldowns[loc.id] = 0;
          } else {
            const cooldownEndMs = (lastCallEpochSec + loc.cooldownHours * 3600) * 1000;
            newCooldowns[loc.id] = cooldownEndMs;
          }
        } catch {
          newCooldowns[loc.id] = 0;
        }
      }

      setCooldowns(newCooldowns);
    } catch (err) {
      console.warn('[useCardPacks] Failed to refresh cooldowns:', err);
    }
  }, [wallet, accountAddress, getSDK]);

  // Auto-refresh cooldowns on mount and when wallet changes
  const refreshedRef = useRef(false);
  useEffect(() => {
    if (wallet && accountAddress && !refreshedRef.current) {
      refreshedRef.current = true;
      refreshCooldowns();
    }
  }, [wallet, accountAddress, refreshCooldowns]);

  const hunt = useCallback(async (location: LocationInfo): Promise<number[]> => {
    if (!wallet || !accountAddress) throw new Error('Wallet not connected');

    setTxStatus('sending');
    setActiveLocation(location.name);
    setError(null);

    try {
      const { AztecAddress, paymentMethod } = await getSDK();
      const { AZTEC_CONFIG } = await import('../aztec/config');
      if (!AZTEC_CONFIG.nftContractAddress) throw new Error('NFT contract not configured');

      const nftContract = await loadNftContract(wallet, AztecAddress, AZTEC_CONFIG.nftContractAddress);
      const addr = AztecAddress.fromString(accountAddress);

      // Get current counter
      const counter = await nftContract.methods
        .get_player_counter(addr)
        .simulate({ from: addr });

      setTxStatus('confirming');

      // Call the location-specific method
      const methodFn = (nftContract.methods as any)[location.methodName];
      if (!methodFn) throw new Error(`Method ${location.methodName} not found on contract`);

      // Retry logic for PXE tagging index conflicts.
      // The PXE's sender tagging store can hit "Cannot store index" errors when
      // pending entries from prior transactions haven't been finalized yet.
      // Each retry creates a fresh txRequest with a new nonce, avoiding the stale entry.
      const MAX_RETRIES = 3;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          await methodFn(counter).send({
            from: addr,
            fee: { paymentMethod },
            wait: { timeout: 300 },
          });
          break;
        } catch (retryErr: any) {
          const isTaggingConflict = retryErr.message?.includes('Cannot store index');
          if (isTaggingConflict && attempt < MAX_RETRIES - 1) {
            console.warn(
              `[useCardPacks] PXE tagging index conflict (attempt ${attempt + 1}/${MAX_RETRIES}), retrying...`,
            );
            // Force PXE block sync before retry so stale pending entries can be finalized/dropped
            try {
              await (wallet as any).pxe?.debug?.sync?.();
            } catch { /* sync is best-effort */ }
            await new Promise(r => setTimeout(r, 3000));
            continue;
          }
          throw retryErr;
        }
      }

      setTxStatus('done');

      // Refresh cooldowns after successful hunt
      await refreshCooldowns();

      // Return placeholder card IDs — the actual new card IDs
      // will be discovered by the useAztec hook's note scanning
      const cardIds = Array.from({ length: 10 }, (_, i) => Number(counter) + i + 1);
      return cardIds;
    } catch (err: any) {
      console.error('[useCardPacks] Hunt failed:', err);
      setTxStatus('error');
      setError(err.message || 'Transaction failed');
      throw err;
    } finally {
      setActiveLocation(null);
    }
  }, [wallet, accountAddress, getSDK, refreshCooldowns]);

  return {
    cooldowns,
    txStatus,
    activeLocation,
    error,
    hunt,
    refreshCooldowns,
  };
}
