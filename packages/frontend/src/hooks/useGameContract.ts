import { useState, useCallback, useRef } from 'react';
import { AZTEC_CONFIG } from '../aztec/config';
import type { MoveProofData, HandProofData } from '../types';

/**
 * Transaction status for on-chain operations
 */
export type TxStatus = 'idle' | 'preparing' | 'proving' | 'sending' | 'confirmed' | 'error';

export interface UseGameContractReturn {
  /** Current transaction status (for settlement) */
  txStatus: TxStatus;
  /** Transaction hash if submitted */
  txHash: string | null;
  /** Error from contract interaction */
  error: string | null;
  /** Whether contract interaction is available */
  isAvailable: boolean;
  /** On-chain game ID (numeric counter from contract) */
  onChainGameId: string | null;
  /** Call create_game on the contract */
  createGameOnChain: (cardIds: number[]) => Promise<string | null>;
  /** Call join_game on the contract */
  joinGameOnChain: (onChainGameId: string, cardIds: number[]) => Promise<void>;
  /** Call process_game to settle the game on-chain */
  settleGame: (params: SettleGameParams) => Promise<string | null>;
  /** Reset transaction state */
  resetTx: () => void;
  /** Reset lifecycle state */
  resetLifecycle: () => void;
}

export interface SettleGameParams {
  onChainGameId: string;
  handProof1: HandProofData;
  handProof2: HandProofData;
  moveProofs: MoveProofData[];
  opponentAddress: string;
  cardToTransfer: number;
  callerCardIds: number[];
  opponentCardIds: number[];
}

/**
 * Get a SponsoredFeePaymentMethod instance.
 * Computes the SponsoredFPC address from its artifact + canonical salt.
 */
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

export function useGameContract(
  wallet: unknown | null,
  accountAddress: string | null,
): UseGameContractReturn {
  const [txStatus, setTxStatus] = useState<TxStatus>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onChainGameId, setOnChainGameId] = useState<string | null>(null);
  const creatingRef = useRef(false);

  const isAvailable = wallet !== null && AZTEC_CONFIG.enabled && !!AZTEC_CONFIG.gameContractAddress;

  /**
   * Call create_game on the TripleTriadGame contract.
   * Returns the on-chain game ID (from the game_id_counter before creation).
   */
  const createGameOnChain = useCallback(async (cardIds: number[]): Promise<string | null> => {
    if (!wallet || !AZTEC_CONFIG.gameContractAddress) return null;
    if (creatingRef.current) return null;
    creatingRef.current = true;

    try {
      console.log('[useGameContract] Creating on-chain game...');

      const [{ AztecAddress }, { Contract }, { loadContractArtifact }, { Fr }] = await Promise.all([
        import('@aztec/aztec.js/addresses'),
        import('@aztec/aztec.js/contracts'),
        import('@aztec/aztec.js/abi'),
        import('@aztec/aztec.js/fields'),
      ]);

      const gameAddr = AztecAddress.fromString(AZTEC_CONFIG.gameContractAddress);
      const resp = await fetch('/contracts/triple_triad_game-TripleTriadGame.json');
      if (!resp.ok) throw new Error('Failed to load game contract artifact');
      const rawArtifact = await resp.json();
      const artifact = loadContractArtifact(rawArtifact);
      const contract = await Contract.at(gameAddr, artifact, wallet as never);

      // Read the current game_id_counter BEFORE creation to know what ID will be assigned
      const senderAddr = accountAddress ? AztecAddress.fromString(accountAddress) : AztecAddress.ZERO;
      const counter = await contract.methods.get_game_id_counter().simulate({ from: senderAddr });
      const gameId = String(BigInt(counter));
      console.log('[useGameContract] Next on-chain game ID will be:', gameId);

      const fee = await getSponsoredFee();
      await contract.methods
        .create_game(cardIds.map(id => new Fr(BigInt(id))))
        .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: 300 } });

      setOnChainGameId(gameId);
      console.log('[useGameContract] On-chain game created, ID:', gameId);
      return gameId;
    } catch (err) {
      console.error('[useGameContract] createGameOnChain error:', err);
      return null;
    } finally {
      creatingRef.current = false;
    }
  }, [wallet, accountAddress]);

  /**
   * Call join_game on the TripleTriadGame contract.
   */
  const joinGameOnChain = useCallback(async (chainGameId: string, cardIds: number[]): Promise<void> => {
    if (!wallet || !AZTEC_CONFIG.gameContractAddress) return;

    try {
      console.log('[useGameContract] Joining on-chain game:', chainGameId);

      const [{ AztecAddress }, { Contract }, { loadContractArtifact }, { Fr }] = await Promise.all([
        import('@aztec/aztec.js/addresses'),
        import('@aztec/aztec.js/contracts'),
        import('@aztec/aztec.js/abi'),
        import('@aztec/aztec.js/fields'),
      ]);

      const gameAddr = AztecAddress.fromString(AZTEC_CONFIG.gameContractAddress);
      const resp = await fetch('/contracts/triple_triad_game-TripleTriadGame.json');
      if (!resp.ok) throw new Error('Failed to load game contract artifact');
      const rawArtifact = await resp.json();
      const artifact = loadContractArtifact(rawArtifact);
      const contract = await Contract.at(gameAddr, artifact, wallet as never);

      const senderAddr = accountAddress ? AztecAddress.fromString(accountAddress) : AztecAddress.ZERO;
      const fee = await getSponsoredFee();
      await contract.methods
        .join_game(new Fr(BigInt(chainGameId)), cardIds.map(id => new Fr(BigInt(id))))
        .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: 300 } });

      setOnChainGameId(chainGameId);
      console.log('[useGameContract] Joined on-chain game:', chainGameId);
    } catch (err) {
      console.error('[useGameContract] joinGameOnChain error:', err);
    }
  }, [wallet, accountAddress]);

  /**
   * Call process_game on the TripleTriadGame contract to settle a finished game.
   *
   * This verifies all 11 proofs (2 hand + 9 move), validates the proof chain,
   * and transfers an NFT card from the loser to the winner.
   */
  const settleGame = useCallback(async (params: SettleGameParams): Promise<string | null> => {
    const {
      onChainGameId: gameId,
      handProof1, handProof2,
      moveProofs,
      opponentAddress,
      cardToTransfer,
      callerCardIds,
      opponentCardIds,
    } = params;

    if (!wallet || !AZTEC_CONFIG.gameContractAddress) {
      setError('Aztec wallet or contract not available');
      return null;
    }
    if (moveProofs.length < 9) {
      setError(`Need 9 move proofs, have ${moveProofs.length}`);
      return null;
    }

    setTxStatus('preparing');
    setError(null);
    setTxHash(null);

    try {
      const [{ AztecAddress }, { Contract }, { loadContractArtifact }, { Fr }] = await Promise.all([
        import('@aztec/aztec.js/addresses'),
        import('@aztec/aztec.js/contracts'),
        import('@aztec/aztec.js/abi'),
        import('@aztec/aztec.js/fields'),
      ]);

      setTxStatus('proving');

      // 1. Load circuit artifacts and extract VKs
      const { loadProveHandCircuit, loadGameMoveCircuit } = await import('../aztec/circuitLoader');
      const { UltraHonkBackend } = await import('@aztec/bb.js');
      const { getBarretenberg } = await import('../aztec/proofBackend');

      const [handArtifact, moveArtifact] = await Promise.all([
        loadProveHandCircuit(),
        loadGameMoveCircuit(),
      ]);

      const api = await getBarretenberg();
      const handBackend = new UltraHonkBackend(handArtifact.bytecode, api);
      const moveBackend = new UltraHonkBackend(moveArtifact.bytecode, api);

      const [handVk, moveVk] = await Promise.all([
        handBackend.getVerificationKey(),
        moveBackend.getVerificationKey(),
      ]);

      // 2. Helper: convert base64 proof bytes to Fr[] (each 32 bytes = 1 field)
      function base64ToFrArray(b64: string): InstanceType<typeof Fr>[] {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const fields: InstanceType<typeof Fr>[] = [];
        for (let i = 0; i < bytes.length; i += 32) {
          const chunk = bytes.slice(i, i + 32);
          const hex = '0x' + Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join('');
          fields.push(Fr.fromHexString(hex));
        }
        return fields;
      }

      // Helper: convert VK Uint8Array to Fr[] (each 32 bytes = 1 field)
      function vkToFrArray(vk: Uint8Array): InstanceType<typeof Fr>[] {
        const fields: InstanceType<typeof Fr>[] = [];
        for (let i = 0; i < vk.length; i += 32) {
          const chunk = vk.slice(i, i + 32);
          const hex = '0x' + Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join('');
          fields.push(Fr.fromHexString(hex));
        }
        return fields;
      }

      // Helper: convert hex public input to Fr
      function toFr(hex: string): InstanceType<typeof Fr> {
        return Fr.fromHexString(hex.startsWith('0x') ? hex : '0x' + hex);
      }

      const handVkFields = vkToFrArray(handVk);
      const moveVkFields = vkToFrArray(moveVk);

      console.log('[useGameContract] VK fields: hand=', handVkFields.length, 'move=', moveVkFields.length);

      // 3. Convert proofs
      const hp1Proof = base64ToFrArray(handProof1.proof);
      const hp1Inputs = handProof1.publicInputs.map(toFr);
      const hp2Proof = base64ToFrArray(handProof2.proof);
      const hp2Inputs = handProof2.publicInputs.map(toFr);

      // 9 move proofs — each proof + 6 public inputs
      const mp: InstanceType<typeof Fr>[][] = [];
      const mi: InstanceType<typeof Fr>[][] = [];
      for (let i = 0; i < 9; i++) {
        const m = moveProofs[i];
        mp.push(base64ToFrArray(m.proof));
        mi.push(m.publicInputs.map(toFr));
      }

      console.log('[useGameContract] Proof conversion complete. hp1 proof fields:', hp1Proof.length,
        'hp1 inputs:', hp1Inputs.length, 'mp[0] proof fields:', mp[0].length, 'mi[0] inputs:', mi[0].length);

      setTxStatus('sending');

      // 4. Load contract and call process_game
      const gameContractAddr = AztecAddress.fromString(AZTEC_CONFIG.gameContractAddress);
      const resp = await fetch('/contracts/triple_triad_game-TripleTriadGame.json');
      if (!resp.ok) throw new Error('Failed to load game contract artifact');
      const rawArtifact = await resp.json();
      const artifact = loadContractArtifact(rawArtifact);
      const contract = await Contract.at(gameContractAddr, artifact, wallet as never);

      const senderAddr = accountAddress ? AztecAddress.fromString(accountAddress) : AztecAddress.ZERO;
      const opponent = AztecAddress.fromString(opponentAddress);
      const fee = await getSponsoredFee();

      // Pad card ID arrays to exactly 5 elements
      const padTo5 = (ids: number[]): InstanceType<typeof Fr>[] => {
        const padded = [...ids];
        while (padded.length < 5) padded.push(0);
        return padded.slice(0, 5).map(id => new Fr(BigInt(id)));
      };

      // process_game signature (from contract):
      // game_id, hand_vk, move_vk,
      // hand_proof_1, hand_proof_1_inputs,
      // hand_proof_2, hand_proof_2_inputs,
      // move_proof_1, move_inputs_1, ... move_proof_9, move_inputs_9,
      // opponent, card_to_transfer, caller_card_ids, opponent_card_ids
      const receipt = await contract.methods
        .process_game(
          new Fr(BigInt(gameId)),
          handVkFields,
          moveVkFields,
          hp1Proof, hp1Inputs,
          hp2Proof, hp2Inputs,
          mp[0], mi[0], mp[1], mi[1], mp[2], mi[2],
          mp[3], mi[3], mp[4], mi[4], mp[5], mi[5],
          mp[6], mi[6], mp[7], mi[7], mp[8], mi[8],
          opponent,
          new Fr(BigInt(cardToTransfer)),
          padTo5(callerCardIds),
          padTo5(opponentCardIds),
        )
        .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: 600 } });

      const hash = receipt.txHash?.toString() || 'confirmed';
      setTxHash(hash);
      setTxStatus('confirmed');
      console.log('[useGameContract] Game settled on-chain, txHash:', hash);

      // Log private cards for both players after settlement to verify transfer
      try {
        if (AZTEC_CONFIG.nftContractAddress) {
          const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
          const nftResp = await fetch('/contracts/triple_triad_nft-TripleTriadNFT.json');
          if (nftResp.ok) {
            const nftRaw = await nftResp.json();
            const nftArtifact = loadContractArtifact(nftRaw);
            const nftContract = await Contract.at(nftAddr, nftArtifact, wallet as never);

            const fetchCards = async (addr: InstanceType<typeof AztecAddress>, label: string) => {
              const cardIds: number[] = [];
              let page = 0;
              let hasMore = true;
              while (hasMore) {
                const result = await nftContract.methods.get_private_cards(addr, page).simulate({ from: addr });
                const ids = result[0] ?? result;
                hasMore = result[1] === true;
                for (const val of ids) {
                  const id = Number(BigInt(val));
                  if (id !== 0) cardIds.push(id);
                }
                page++;
              }
              console.log(`[useGameContract] ${label} (${addr.toString().slice(0, 10)}...) cards after settlement:`, cardIds);
            };

            await fetchCards(senderAddr, 'Winner');
            await fetchCards(opponent, 'Loser');
          }
        }
      } catch (logErr) {
        console.warn('[useGameContract] Failed to log post-settlement cards:', logErr);
      }

      return hash;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      console.error('[useGameContract] settleGame error:', err);
      setError(message);
      setTxStatus('error');
      return null;
    }
  }, [wallet, accountAddress]);

  const resetTx = useCallback(() => {
    setTxStatus('idle');
    setTxHash(null);
    setError(null);
  }, []);

  const resetLifecycle = useCallback(() => {
    setOnChainGameId(null);
    creatingRef.current = false;
  }, []);

  return {
    txStatus,
    txHash,
    error,
    isAvailable,
    onChainGameId,
    createGameOnChain,
    joinGameOnChain,
    settleGame,
    resetTx,
    resetLifecycle,
  };
}
