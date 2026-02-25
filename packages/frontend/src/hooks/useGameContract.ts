import { useState, useCallback } from 'react';
import { AZTEC_CONFIG } from '../aztec/config';
import type { MoveProofData, HandProofData } from '../types';

/**
 * Transaction status for on-chain operations
 */
export type TxStatus = 'idle' | 'preparing' | 'proving' | 'sending' | 'confirmed' | 'error';

/**
 * NFT card owned by the player
 */
export interface OwnedCard {
  tokenId: number;
  isPrivate: boolean;
}

export interface UseGameContractReturn {
  /** Current transaction status */
  txStatus: TxStatus;
  /** Transaction hash if submitted */
  txHash: string | null;
  /** Error from contract interaction */
  error: string | null;
  /** NFT cards owned by the connected account */
  ownedCards: OwnedCard[];
  /** Whether contract interaction is available */
  isAvailable: boolean;
  /** Call process_game to settle the game on-chain */
  settleGame: (
    handProof1: HandProofData,
    handProof2: HandProofData,
    moveProofs: MoveProofData[],
    loserAddress: string,
    cardToTransfer: number,
  ) => Promise<string | null>;
  /** Query owned NFT cards */
  queryOwnedCards: (accountAddress: string) => Promise<OwnedCard[]>;
  /** Reset transaction state */
  resetTx: () => void;
}

/**
 * Convert a base64-encoded proof back to an array of field hex strings.
 * Each field is 32 bytes (64 hex chars).
 */
function base64ProofToFields(b64: string): string[] {
  const binaryStr = atob(b64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  // Each field is 32 bytes
  const fieldCount = Math.floor(bytes.length / 32);
  const fields: string[] = [];
  for (let i = 0; i < fieldCount; i++) {
    const slice = bytes.slice(i * 32, (i + 1) * 32);
    const hex = '0x' + Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join('');
    fields.push(hex);
  }
  return fields;
}

/**
 * Hook for interacting with Axolotl Arena smart contracts on Aztec.
 *
 * Provides functions to:
 * - Settle completed games on-chain (process_game with aggregate proof)
 * - Query NFT card ownership
 * - Handle sponsored fee payment
 */
export function useGameContract(
  wallet: unknown | null,
): UseGameContractReturn {
  const [txStatus, setTxStatus] = useState<TxStatus>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownedCards, setOwnedCards] = useState<OwnedCard[]>([]);

  const isAvailable = wallet !== null && AZTEC_CONFIG.enabled && !!AZTEC_CONFIG.gameContractAddress;

  const settleGame = useCallback(
    async (
      handProof1: HandProofData,
      handProof2: HandProofData,
      moveProofs: MoveProofData[],
      loserAddress: string,
      cardToTransfer: number,
    ): Promise<string | null> => {
      if (!wallet || !AZTEC_CONFIG.gameContractAddress) {
        setError('Aztec wallet or contract not available');
        return null;
      }

      setTxStatus('preparing');
      setError(null);
      setTxHash(null);

      try {
        // Dynamically import Aztec SDK subpath modules
        const [aztecFee, aztecAddr, aztecContracts] = await Promise.all([
          import('@aztec/aztec.js/fee'),
          import('@aztec/aztec.js/addresses'),
          import('@aztec/aztec.js/contracts'),
        ]);

        const gameContractAddress = aztecAddr.AztecAddress.fromString(
          AZTEC_CONFIG.gameContractAddress,
        );

        setTxStatus('proving');

        // 1. Generate the aggregate proof from all hand + move proofs
        const { generateAggregateProof } = await import('../aztec/aggregateProof');
        const aggregateProof = await generateAggregateProof(
          handProof1, handProof2, moveProofs,
        );

        console.log('[useGameContract] Aggregate proof generated, publicInputs:', aggregateProof.publicInputs.length);

        setTxStatus('sending');

        // 2. Load the game contract artifact and get contract instance
        const gameArtifactResp = await fetch('/contracts/triple_triad_game-TripleTriadGame.json');
        if (!gameArtifactResp.ok) {
          throw new Error('Failed to load game contract artifact');
        }
        const gameArtifact = await gameArtifactResp.json();

        const contract = await aztecContracts.Contract.at(
          gameContractAddress,
          gameArtifact,
          wallet as never,
        );

        // 3. Decode aggregate proof and VK from base64/field arrays
        const proofFields = base64ProofToFields(aggregateProof.proof);
        const vkFields = aggregateProof.vkAsFields;

        // 4. Call process_game with: aggregate_vk, aggregate_proof, aggregate_inputs, loser, card_to_transfer
        const loser = aztecAddr.AztecAddress.fromString(loserAddress);

        const feeMethod = new aztecFee.SponsoredFeePaymentMethod();
        const receipt = await contract.methods
          .process_game(
            vkFields,                         // aggregate_vk: [Field; 115]
            proofFields,                      // aggregate_proof: [Field; 500]
            aggregateProof.publicInputs,      // aggregate_inputs: [Field; 15]
            loser,                            // loser: AztecAddress
            cardToTransfer,                   // card_to_transfer: Field
          )
          .send({ fee: feeMethod })
          .wait();

        const hash = receipt.txHash?.toString() || 'confirmed';
        setTxHash(hash);
        setTxStatus('confirmed');
        console.log('[useGameContract] Game settled on-chain, txHash:', hash);
        return hash;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Transaction failed';
        console.error('[useGameContract] settleGame error:', message);
        setError(message);
        setTxStatus('error');
        return null;
      }
    },
    [wallet],
  );

  const queryOwnedCards = useCallback(
    async (accountAddress: string): Promise<OwnedCard[]> => {
      if (!wallet || !AZTEC_CONFIG.nftContractAddress) {
        return [];
      }

      try {
        const [aztecAddr, aztecContracts] = await Promise.all([
          import('@aztec/aztec.js/addresses'),
          import('@aztec/aztec.js/contracts'),
        ]);

        const nftAddress = aztecAddr.AztecAddress.fromString(
          AZTEC_CONFIG.nftContractAddress,
        );
        const ownerAddress = aztecAddr.AztecAddress.fromString(accountAddress);

        // Load NFT contract artifact
        const nftArtifactResp = await fetch('/contracts/triple_triad_nft-TripleTriadNFT.json');
        if (!nftArtifactResp.ok) {
          console.warn('[useGameContract] NFT contract artifact not found, returning empty');
          return [];
        }
        const nftArtifact = await nftArtifactResp.json();

        const nftContract = await aztecContracts.Contract.at(
          nftAddress,
          nftArtifact,
          wallet as never,
        );

        // Query private cards using the utility function
        const result = await nftContract.methods
          .get_private_cards(ownerAddress, 0)
          .simulate();

        // result is [Field[MAX_NOTES_PER_PAGE], bool]
        const [cardFields, _hasMore] = result as [string[], boolean];
        const cards: OwnedCard[] = [];
        for (const field of cardFields) {
          const tokenId = Number(BigInt(field));
          if (tokenId > 0) {
            cards.push({ tokenId, isPrivate: true });
          }
        }

        // Also check public ownership for common card IDs (1-50)
        for (let id = 1; id <= 50; id++) {
          try {
            const owner = await nftContract.methods
              .public_owner_of(id)
              .simulate();
            if (owner && owner.toString() === accountAddress) {
              // Only add if not already in the private list
              if (!cards.find(c => c.tokenId === id)) {
                cards.push({ tokenId: id, isPrivate: false });
              }
            }
          } catch {
            // Card doesn't exist or query failed, skip
          }
        }

        setOwnedCards(cards);
        return cards;
      } catch (err) {
        console.error('[useGameContract] queryOwnedCards error:', err);
        return [];
      }
    },
    [wallet],
  );

  const resetTx = useCallback(() => {
    setTxStatus('idle');
    setTxHash(null);
    setError(null);
  }, []);

  return {
    txStatus,
    txHash,
    error,
    ownedCards,
    isAvailable,
    settleGame,
    queryOwnedCards,
    resetTx,
  };
}
