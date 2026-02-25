import { useState, useCallback } from 'react';
import { AZTEC_CONFIG } from '../aztec/config';
import type { MoveProofData, HandProofData, OnChainGameStatus } from '../types';
import type { TxStatus as LifecycleTxStatus } from '../types';

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
  /** Current transaction status (for settlement) */
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
    loserCardIds: number[],
  ) => Promise<string | null>;
  /** Query owned NFT cards */
  queryOwnedCards: (accountAddress: string) => Promise<OwnedCard[]>;
  /** Reset transaction state */
  resetTx: () => void;
  /** Lifecycle tx status (create_game/join_game) */
  lifecycleTxStatus: LifecycleTxStatus;
  /** On-chain game status from backend */
  onChainStatus: OnChainGameStatus | null;
  /** Whether both txs are confirmed (on-chain settlement possible) */
  canSettleOnChain: boolean;
  /** Send create_game tx (simulated until Aztec sandbox available) */
  createGameOnChain: (gameId: string) => void;
  /** Send join_game tx (simulated until Aztec sandbox available) */
  joinGameOnChain: (gameId: string) => void;
  /** Handle ON_CHAIN_STATUS message from backend */
  handleOnChainStatus: (status: OnChainGameStatus) => void;
  /** Reset lifecycle state */
  resetLifecycle: () => void;
}

/**
 * Hook for interacting with Axolotl Arena smart contracts on Aztec.
 *
 * Provides functions to:
 * - Settle completed games on-chain (process_game with aggregate proof)
 * - Query NFT card ownership
 * - Handle sponsored fee payment
 */
export interface LifecycleCallbacks {
  onTxConfirmed?: (gameId: string, txType: 'create_game' | 'join_game', txHash: string) => void;
  onTxFailed?: (gameId: string, txType: 'create_game' | 'join_game', error: string) => void;
}

export function useGameContract(
  wallet: unknown | null,
  lifecycleCallbacks?: LifecycleCallbacks,
): UseGameContractReturn {
  const [txStatus, setTxStatus] = useState<TxStatus>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ownedCards, setOwnedCards] = useState<OwnedCard[]>([]);
  const [lifecycleTxStatus, setLifecycleTxStatus] = useState<LifecycleTxStatus>('idle');
  const [onChainStatus, setOnChainStatus] = useState<OnChainGameStatus | null>(null);

  const isAvailable = wallet !== null && AZTEC_CONFIG.enabled && !!AZTEC_CONFIG.gameContractAddress;

  const settleGame = useCallback(
    async (
      handProof1: HandProofData,
      handProof2: HandProofData,
      moveProofs: MoveProofData[],
      loserAddress: string,
      cardToTransfer: number,
      loserCardIds: number[] = [],
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

        // 3. Use pre-computed proof-as-fields and VK from recursive artifacts
        const proofFields = aggregateProof.proofAsFields;
        const vkFields = aggregateProof.vkAsFields;

        // 4. Call process_game with: aggregate_vk, aggregate_proof, aggregate_inputs, loser, card_to_transfer, loser_card_ids
        const loser = aztecAddr.AztecAddress.fromString(loserAddress);

        // Pad loser_card_ids to exactly 5 elements (contract expects [Field; 5])
        const paddedLoserCardIds = [...loserCardIds];
        while (paddedLoserCardIds.length < 5) {
          paddedLoserCardIds.push(0);
        }

        const feeMethod = new aztecFee.SponsoredFeePaymentMethod();
        const receipt = await contract.methods
          .process_game(
            vkFields,                         // aggregate_vk: [Field; 115]
            proofFields,                      // aggregate_proof: [Field; 500]
            aggregateProof.publicInputs,      // aggregate_inputs: [Field; 15]
            loser,                            // loser: AztecAddress
            cardToTransfer,                   // card_to_transfer: Field
            paddedLoserCardIds,               // loser_card_ids: [Field; 5]
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

  const canSettleOnChain = onChainStatus?.canSettle ?? false;

  const createGameOnChain = useCallback((gameId: string) => {
    setLifecycleTxStatus('sending');
    // Simulate tx lifecycle: sending -> mining -> confirmed
    // In production, call Game.create_game on Aztec
    setTimeout(() => {
      setLifecycleTxStatus('mining');
      setTimeout(() => {
        setLifecycleTxStatus('confirmed');
        const hash = '0x' + gameId.slice(2, 10) + 'create';
        lifecycleCallbacks?.onTxConfirmed?.(gameId, 'create_game', hash);
      }, 500);
    }, 200);
  }, [lifecycleCallbacks]);

  const joinGameOnChain = useCallback((gameId: string) => {
    setLifecycleTxStatus('sending');
    setTimeout(() => {
      setLifecycleTxStatus('mining');
      setTimeout(() => {
        setLifecycleTxStatus('confirmed');
        const hash = '0x' + gameId.slice(2, 10) + 'join';
        lifecycleCallbacks?.onTxConfirmed?.(gameId, 'join_game', hash);
      }, 500);
    }, 200);
  }, [lifecycleCallbacks]);

  const handleOnChainStatus = useCallback((status: OnChainGameStatus) => {
    setOnChainStatus(status);
  }, []);

  const resetLifecycle = useCallback(() => {
    setLifecycleTxStatus('idle');
    setOnChainStatus(null);
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
    lifecycleTxStatus,
    onChainStatus,
    canSettleOnChain,
    createGameOnChain,
    joinGameOnChain,
    handleOnChainStatus,
    resetLifecycle,
  };
}
