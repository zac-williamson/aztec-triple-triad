import { useState, useCallback, useEffect, useRef } from 'react';
import { toFr as toFrUtil } from '../aztec/fieldUtils';
import { importNotesFromTx, fetchTxEffectData, getNftArtifact } from '../aztec/noteImporter';
import { addCards, type StoredCard } from '../aztec/cardStore';
import txManager from '../aztec/txManager';
import { AZTEC_TX_TIMEOUT, CARDS_PER_PACK } from '../aztec/gameConstants';

export interface LocationInfo {
  id: number;
  name: string;
  description: string;
  cooldownHours: number;
}

export const LOCATIONS: LocationInfo[] = [
  { id: 1, name: 'River', description: 'Shallow waters teeming with common axolotls', cooldownHours: 4 },
  { id: 2, name: 'Forest', description: 'Dense canopy hiding uncommon species', cooldownHours: 8 },
  { id: 3, name: 'Beach', description: 'Tidal pools with rare coastal dwellers', cooldownHours: 12 },
  { id: 4, name: 'City', description: 'Urban waterways harbor exotic specimens', cooldownHours: 16 },
  { id: 5, name: 'Dockyard', description: 'Deep harbor waters conceal legendary creatures', cooldownHours: 20 },
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

export function useCardPacks(
  wallet: unknown | null,
  nodeClient: unknown | null,
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

  const getNftContract = useCallback(async () => {
    const { AztecAddress } = await getSDK();
    const { Contract } = await import('@aztec/aztec.js/contracts');
    const { AZTEC_CONFIG } = await import('../aztec/config');
    if (!AZTEC_CONFIG.nftContractAddress) throw new Error('NFT contract not configured');
    const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
    const artifact = await getNftArtifact();
    return Contract.at(nftAddr, artifact, wallet as never);
  }, [wallet, getSDK]);

  // No cooldowns — card packs are purchased with Arena Tokens
  const refreshCooldowns = useCallback(async () => {}, []);

  const hunt = useCallback(async (location: LocationInfo): Promise<HuntResult> => {
    if (!wallet || !accountAddress) throw new Error('Wallet not connected');

    // Capture values upfront
    const capturedWallet = wallet;
    const capturedNodeClient = nodeClient;
    const capturedAccountAddress = accountAddress;

    setTxStatus('sending');
    setActiveLocation(location.name);
    setError(null);

    try {
      const result = await txManager.runTx<{ cardIds: number[]; txHash: string | null }>({
        type: 'purchase_card_pack',
        label: `Hunting at ${location.name}...`,

        execute: async (setPhase) => {
          setPhase('simulating');
          const { AztecAddress, paymentMethod, Fr } = await getSDK();
          const nftContract = await getNftContract();
          const addr = AztecAddress.fromString(capturedAccountAddress);

          const { result: nonceValue } = await nftContract.methods
            .get_note_nonce(addr)
            .simulate({ from: addr });

          const { result: previewResult } = await nftContract.methods
            .preview_card_ids(nonceValue)
            .simulate({ from: addr });
          const cardIds: number[] = Array.from({ length: CARDS_PER_PACK }, (_, i) => Number(previewResult[i]));

          setPhase('sending');
          const { receipt } = await nftContract.methods.purchase_card_pack().send({
            from: addr,
            fee: { paymentMethod },
            wait: { timeout: AZTEC_TX_TIMEOUT },
          });

          const txHash = receipt?.txHash?.toString() ?? null;

          // Import notes and persist to localStorage
          if (txHash && capturedNodeClient) {
            try {
              const { result: randomnessResult } = await nftContract.methods
                .compute_note_randomness(nonceValue, CARDS_PER_PACK)
                .simulate({ from: addr });
              const notes = cardIds.map((id, i) => ({
                tokenId: id,
                randomness: toFrUtil(Fr, randomnessResult[i]).toString(),
              }));

              // Fetch TxEffect data for localStorage persistence
              const txEffectData = await fetchTxEffectData(capturedNodeClient, txHash);
              if (txEffectData) {
                const storedCards: StoredCard[] = notes.map((n) => ({
                  cardId: n.tokenId,
                  randomness: n.randomness,
                  txHash,
                  noteHashes: txEffectData.noteHashes,
                  firstNullifier: txEffectData.firstNullifier,
                }));
                addCards(capturedAccountAddress, storedCards);
              }

              await importNotesFromTx(capturedWallet, capturedNodeClient, capturedAccountAddress, txHash, notes, 'Card pack', txEffectData ?? undefined);
            } catch (importErr) {
              console.warn('[useCardPacks] Failed to import card notes:', importErr);
            }
          }

          return { cardIds, txHash };
        },
      });

      setTxStatus('done');
      return result;
    } catch (err: any) {
      console.error('[useCardPacks] Hunt failed:', err);
      setTxStatus('error');
      setError(err.message || 'Transaction failed');
      throw err;
    } finally {
      setActiveLocation(null);
    }
  }, [wallet, nodeClient, accountAddress, getSDK, getNftContract]);

  return {
    cooldowns,
    txStatus,
    activeLocation,
    error,
    hunt,
    refreshCooldowns,
  };
}
