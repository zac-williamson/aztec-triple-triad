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
 * Hook for interacting with Axolotl Arena smart contracts on Aztec.
 *
 * Provides functions to:
 * - Settle completed games on-chain (process_game with aggregate proof)
 * - Query NFT card ownership
 * - Handle sponsored fee payment
 *
 * Falls back gracefully if contracts are not deployed or Aztec is unavailable.
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

        // Get the game contract instance
        const gameContractAddress = aztecAddr.AztecAddress.fromString(
          AZTEC_CONFIG.gameContractAddress,
        );

        // Prepare transaction parameters
        const _txParams = {
          handProof1,
          handProof2,
          moveProofs,
          loserAddress,
          cardToTransfer,
        };

        setTxStatus('proving');

        // Generate the aggregate proof from all hand + move proofs
        const { generateAggregateProof } = await import('../aztec/aggregateProof');
        const aggregateProof = await generateAggregateProof(
          handProof1, handProof2, moveProofs,
        );

        console.log('[useGameContract] Aggregate proof generated, publicInputs:', aggregateProof.publicInputs.length);

        setTxStatus('sending');

        // On-chain submission requires deployed contracts
        // When contract is deployed:
        // const contract = await Contract.at(gameContractAddress, GameContractArtifact, wallet);
        // const tx = contract.methods.process_game(
        //   aggregateProof.vkAsFields,
        //   aggregateProof.proof,
        //   aggregateProof.publicInputs,
        //   loserAddress,
        //   cardToTransfer,
        // );
        // const feeMethod = new aztecFee.SponsoredFeePaymentMethod(sponsoredFpcAddress);
        // const sentTx = await tx.send({ fee: { paymentMethod: feeMethod } });
        // const receipt = await sentTx.wait();

        // Acknowledge imports for type checking
        void aztecFee;
        void aztecContracts;
        void gameContractAddress;

        throw new Error(
          'Aggregate proof generated successfully but on-chain settlement requires contract deployment',
        );
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
        const aztecAddr = await import('@aztec/aztec.js/addresses');

        const _nftAddress = aztecAddr.AztecAddress.fromString(
          AZTEC_CONFIG.nftContractAddress,
        );
        const _ownerAddress = aztecAddr.AztecAddress.fromString(accountAddress);

        // In production:
        // const nftContract = await Contract.at(nftAddress, NFTContractArtifact, wallet);
        // const result = await nftContract.methods.get_private_cards(ownerAddress, 0).simulate();
        // Parse result into OwnedCard[]

        // Placeholder: return empty for now
        const cards: OwnedCard[] = [];
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
