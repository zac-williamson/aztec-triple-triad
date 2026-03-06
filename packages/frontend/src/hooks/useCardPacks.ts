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

export interface HuntResult {
  cardIds: number[];
  txHash: string | null;
}

export interface UseCardPacksReturn {
  cooldowns: Record<number, number>;
  txStatus: PackTxStatus;
  activeLocation: string | null;
  error: string | null;
  hunt: (location: LocationInfo) => Promise<HuntResult>;
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
    sdkCacheRef.current = { AztecAddress, paymentMethod, Fr };
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

  const hunt = useCallback(async (location: LocationInfo): Promise<HuntResult> => {
    if (!wallet || !accountAddress) throw new Error('Wallet not connected');

    setTxStatus('sending');
    setActiveLocation(location.name);
    setError(null);

    try {
      const { AztecAddress, paymentMethod, Fr } = await getSDK();
      const { AZTEC_CONFIG } = await import('../aztec/config');
      if (!AZTEC_CONFIG.nftContractAddress) throw new Error('NFT contract not configured');

      const nftContract = await loadNftContract(wallet, AztecAddress, AZTEC_CONFIG.nftContractAddress);
      const addr = AztecAddress.fromString(accountAddress);

      // Get current note nonce (deterministic counter for card generation)
      const nonceValue = await nftContract.methods
        .get_note_nonce(addr)
        .simulate({ from: addr });

      // Preview which card IDs will be generated (runs client-side via simulate)
      const previewResult = await nftContract.methods
        .preview_card_ids(nonceValue)
        .simulate({ from: addr });
      const cardIds: number[] = Array.from({ length: 10 }, (_, i) => Number(previewResult[i]));

      setTxStatus('confirming');

      // Call the location-specific method (no args — derives randomness deterministically)
      const methodFn = (nftContract.methods as any)[location.methodName];
      if (!methodFn) throw new Error(`Method ${location.methodName} not found on contract`);

      const receipt = await methodFn().send({
        from: addr,
        fee: { paymentMethod },
        wait: { timeout: 300 },
      });

      const txHash = receipt?.txHash?.toString() ?? null;

      // Import the 10 card notes (create_and_push_note skips tagging)
      if (txHash) {
        try {
          const randomnessResult = await nftContract.methods
            .compute_note_randomness(nonceValue, 10)
            .simulate({ from: addr });
          // Convert simulate results to Fr — may be Fr objects, BigInts, or decimal strings
          const toFr = (v: any) => {
            if (v instanceof Fr) return v;
            const s = v.toString();
            if (s.startsWith('0x') || s.startsWith('0X')) return Fr.fromHexString(s);
            return new Fr(BigInt(s));
          };
          const randomnessFrs: any[] = [];
          for (let i = 0; i < 10; i++) {
            randomnessFrs.push(toFr(randomnessResult[i]));
          }

          const { TxHash } = await import('@aztec/stdlib/tx');
          const hash = TxHash.fromString(txHash);
          let txEffect: any = null;
          for (let attempt = 0; attempt < 5; attempt++) {
            const nodeModule = await import('@aztec/aztec.js/node');
            const { AZTEC_CONFIG: cfg } = await import('../aztec/config');
            const nodeClient = nodeModule.createAztecNodeClient(cfg.pxeUrl);
            const txResult = await nodeClient.getTxEffect(hash);
            if (txResult?.data) { txEffect = txResult.data; break; }
            await new Promise(r => setTimeout(r, 3000));
          }

          if (txEffect) {
            const rawNoteHashes: any[] = txEffect.noteHashes ?? [];
            const uniqueNoteHashes: string[] = rawNoteHashes
              .map((h: any) => h.toString())
              .filter((h: string) => h !== '0' && h !== '0x0' && !/^0x0+$/.test(h));
            const firstNullifier: string = txEffect.nullifiers?.[0]?.toString() ?? '0';

            const paddedHashes = new Array(64).fill(new Fr(0n));
            for (let i = 0; i < uniqueNoteHashes.length && i < 64; i++) {
              paddedHashes[i] = toFr(uniqueNoteHashes[i]);
            }

            const txHashFr = toFr(txHash);
            const firstNullFr = toFr(firstNullifier);
            console.log(`[useCardPacks] Importing ${cardIds.length} card notes...`);
            for (let i = 0; i < 10; i++) {
              await nftContract.methods
                .import_note(
                  addr,
                  new Fr(BigInt(cardIds[i])),
                  randomnessFrs[i],
                  txHashFr,
                  paddedHashes,
                  uniqueNoteHashes.length,
                  firstNullFr,
                  addr,
                )
                .simulate({ from: addr });
            }
            console.log('[useCardPacks] All card notes imported successfully');
          }
        } catch (importErr) {
          console.warn('[useCardPacks] Failed to import card notes:', importErr);
        }
      }

      setTxStatus('done');

      // Refresh cooldowns after successful hunt
      await refreshCooldowns();

      return { cardIds, txHash };
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
