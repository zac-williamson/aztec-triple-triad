import { useState, useCallback } from 'react';
import { fetchTxEffectData } from '../aztec/noteImporter';
import { addCards, type StoredCard } from '../aztec/cardStore';
import { runPxeTx } from '../aztec/pxe';
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
  const [cooldowns] = useState<Record<number, number>>({});
  const [txStatus, setTxStatus] = useState<PackTxStatus>('idle');
  const [activeLocation, setActiveLocation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // No cooldowns — card packs are purchased with Arena Tokens
  const refreshCooldowns = useCallback(async () => {}, []);

  const hunt = useCallback(async (location: LocationInfo): Promise<HuntResult> => {
    if (!wallet || !accountAddress) throw new Error('Wallet not connected');

    // Capture values upfront
    const capturedNodeClient = nodeClient;
    const capturedAccountAddress = accountAddress;

    setTxStatus('sending');
    setActiveLocation(location.name);
    setError(null);

    try {
      // Reads + send + import run INLINE as one serial PXE queue item.
      const result = await runPxeTx<HuntResult>({
        type: 'purchase_card_pack',
        label: `Hunting at ${location.name}...`,
        execute: async (ops, setPhase) => {
          setPhase('simulating');
          // Capture the note nonce BEFORE the purchase advances it.
          const { cardIds, nonce } = await ops.previewCardPack(capturedAccountAddress, CARDS_PER_PACK);

          setPhase('sending');
          // Fee Juice paid natively by the sender; the send op applies the shared
          // base-fee headroom so the tx survives a base-fee climb during proving.
          const txHash = await ops.sendPurchaseCardPack(capturedAccountAddress, {
            node: capturedNodeClient,
            timeoutMs: AZTEC_TX_TIMEOUT,
          });

          // Import the minted notes and persist them for re-import after a refresh.
          if (capturedNodeClient) {
            try {
              const randomness = await ops.computeNoteRandomness(capturedAccountAddress, nonce, CARDS_PER_PACK);
              const notes = cardIds.map((id, i) => ({ tokenId: id, randomness: randomness[i] }));

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
                await ops.importCardNotes(capturedAccountAddress, txHash, notes, 'Card pack', txEffectData);
              }
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
  }, [wallet, nodeClient, accountAddress]);

  return {
    cooldowns,
    txStatus,
    activeLocation,
    error,
    hunt,
    refreshCooldowns,
  };
}
