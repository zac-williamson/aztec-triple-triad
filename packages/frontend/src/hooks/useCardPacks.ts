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
          const { txHash, offchainMessages } = await ops.sendPurchaseCardPack(capturedAccountAddress, {
            node: capturedNodeClient,
            timeoutMs: AZTEC_TX_TIMEOUT,
          });

          // Persist the cards first: the card store is what restores them after
          // a PXE wipe, so a receive that fails must not cost that record.
          if (capturedNodeClient) {
            try {
              const randomness = await ops.computeNoteRandomness(capturedAccountAddress, nonce, CARDS_PER_PACK);
              const txEffectData = await fetchTxEffectData(capturedNodeClient, txHash);
              if (txEffectData) {
                const storedCards: StoredCard[] = cardIds.map((id, i) => ({
                  cardId: id,
                  randomness: randomness[i],
                  txHash,
                  noteHashes: txEffectData.noteHashes,
                  firstNullifier: txEffectData.firstNullifier,
                }));
                addCards(capturedAccountAddress, storedCards);
              }
            } catch (storeErr) {
              console.warn('[useCardPacks] Failed to store the pack for restore:', storeErr);
            }
          }

          // Then deliver them: the pack's own offchain messages, one per card.
          try {
            await ops.receiveCardMessages(capturedAccountAddress, txHash, offchainMessages);
          } catch (receiveErr) {
            console.warn('[useCardPacks] Failed to receive the pack\'s cards:', receiveErr);
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
