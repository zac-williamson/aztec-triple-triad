import { useState, useCallback, useRef } from 'react';
import { AZTEC_CONFIG } from '../aztec/config';
import { toFr as toFrUtil, toHexString } from '../aztec/fieldUtils';
import { getNftArtifact } from '../aztec/noteImporter';
import { AZTEC_TX_TIMEOUT, AZTEC_SETTLE_TX_TIMEOUT, CARDS_PER_HAND, TOTAL_MOVES } from '../aztec/gameConstants';
import type { MoveProofData, HandProofData, PlaintextNoteData } from '../types';

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
  /** On-chain game ID (caller-derived poseidon2 hash) */
  onChainGameId: string | null;
  /** Game randomness committed during create/join (6 Fr hex strings) */
  gameRandomness: string[] | null;
  /** Blinding factor derived during create/join (hex string) */
  blindingFactor: string | null;
  /** Call create_game on the contract */
  createGameOnChain: (cardIds: number[]) => Promise<{ gameId: string; randomness: string[]; blindingFactor: string } | null>;
  /** Call join_game on the contract */
  joinGameOnChain: (onChainGameId: string, cardIds: number[]) => Promise<{ randomness: string[]; blindingFactor: string } | null>;
  /** Call process_game to settle the game on-chain. Returns txHash + opponent note data for relay. */
  settleGame: (params: SettleGameParams) => Promise<SettleResult | null>;
  /** Reset transaction state */
  resetTx: () => void;
  /** Restore state from persisted data (e.g., localStorage on resume) */
  restoreState: (onChainGameId: string, randomness: string[], blindingFactor?: string) => void;
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
  /** Caller's committed randomness (6 Fr hex strings) */
  callerRandomness: string[];
  /** Opponent's committed randomness (6 Fr hex strings) */
  opponentRandomness: string[];
}

export interface SettleResult {
  txHash: string;
  callerNotes: PlaintextNoteData[];
  opponentNotes: PlaintextNoteData[];
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

/**
 * Retry wrapper for PXE operations that may fail with IndexedDB TransactionInactiveError.
 * The EmbeddedWallet's PXE uses IndexedDB internally, and background sync can cause
 * transient IDB transaction expiration. Retrying after a brief yield resolves this.
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, label = 'PXE op'): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('TransactionInactiveError') && attempt < maxRetries - 1) {
        console.warn(`[useGameContract] ${label} hit IDB error (attempt ${attempt + 1}/${maxRetries}), retrying...`);
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

/**
 * Cache for contract instances and fee method to avoid repeated Contract.at()
 * and dynamic imports, which cause IndexedDB transaction timeouts.
 */
const contractCache: {
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

async function ensureContracts(wallet: unknown) {
  // If wallet changed, invalidate cache
  if (contractCache.wallet !== wallet) {
    contractCache.wallet = wallet;
    contractCache.gameContract = null;
    contractCache.nftContract = null;
    contractCache.fee = null;
  }

  // Load SDK modules once
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

  // Cache game contract (retry on IDB errors)
  if (!contractCache.gameContract && AZTEC_CONFIG.gameContractAddress) {
    const gameAddr = AztecAddress.fromString(AZTEC_CONFIG.gameContractAddress);
    const gameResp = await fetch('/contracts/triple_triad_game-TripleTriadGame.json');
    if (!gameResp.ok) throw new Error('Failed to load game contract artifact');
    const gameArtifact = loadContractArtifact(await gameResp.json());
    contractCache.gameContract = await withRetry(
      () => Contract.at(gameAddr, gameArtifact, wallet as never),
      3, 'Contract.at(game)',
    );
  }

  // Cache NFT contract (retry on IDB errors)
  if (!contractCache.nftContract && AZTEC_CONFIG.nftContractAddress) {
    const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
    const nftArtifact = await getNftArtifact();
    contractCache.nftContract = await withRetry(
      () => Contract.at(nftAddr, nftArtifact, wallet as never),
      3, 'Contract.at(nft)',
    );
  }

  // Cache fee method
  if (!contractCache.fee) {
    contractCache.fee = await getSponsoredFee();
  }

  return {
    gameContract: contractCache.gameContract,
    nftContract: contractCache.nftContract,
    fee: contractCache.fee,
    Fr,
    AztecAddress,
  };
}

export function useGameContract(
  wallet: unknown | null,
  accountAddress: string | null,
): UseGameContractReturn {
  const [txStatus, setTxStatus] = useState<TxStatus>('idle');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onChainGameId, setOnChainGameId] = useState<string | null>(null);
  const [gameRandomness, setGameRandomness] = useState<string[] | null>(null);
  const [blindingFactor, setBlindingFactor] = useState<string | null>(null);
  const creatingRef = useRef(false);

  const isAvailable = wallet !== null && AZTEC_CONFIG.enabled && !!AZTEC_CONFIG.gameContractAddress;

  /**
   * Call create_game on the TripleTriadGame contract.
   * game_id and randomness are derived IN-CIRCUIT by the NFT contract.
   * We preview them via NFT.preview_game_data().simulate() before sending the tx.
   * Returns { gameId, randomness } or null on failure.
   */
  const createGameOnChain = useCallback(async (cardIds: number[]): Promise<{ gameId: string; randomness: string[]; blindingFactor: string } | null> => {
    if (!wallet || !AZTEC_CONFIG.gameContractAddress) return null;
    if (creatingRef.current) return null;
    creatingRef.current = true;

    try {
      console.log('[useGameContract] Creating on-chain game...');

      const { gameContract, nftContract, fee, Fr, AztecAddress } = await ensureContracts(wallet);
      const senderAddr = accountAddress ? AztecAddress.fromString(accountAddress) : AztecAddress.ZERO;

      // Get current note_nonce (retry on IDB errors)
      const nonceResult = await withRetry(
        () => nftContract.methods.get_note_nonce(senderAddr).simulate({ from: senderAddr }),
        3, 'get_note_nonce',
      );
      const nonceFr = toFrUtil(Fr, nonceResult);
      console.log('[useGameContract] Current nonce:', String(nonceResult));

      // Preview game_id and randomness (derived in-circuit via simulate)
      const previewResult: any = await withRetry(
        () => nftContract.methods.preview_game_data(nonceFr).simulate({ from: senderAddr }),
        3, 'preview_game_data',
      );
      const gameId = String(previewResult[0]);
      const randomnessHex = Array.from({ length: 6 }, (_, i) => toHexString(previewResult[i + 1]));
      console.log('[useGameContract] Preview game_id:', gameId, 'randomness:', randomnessHex);

      // Derive blinding factor (sequentially, after preview — avoids concurrent IDB access)
      const blindingResult = await withRetry(
        () => nftContract.methods.compute_blinding_factor(toFrUtil(Fr, gameId)).simulate({ from: senderAddr }),
        3, 'compute_blinding_factor (create)',
      );
      const blindingHex = toHexString(blindingResult);
      console.log('[useGameContract] Blinding factor derived:', blindingHex);

      // Send create_game tx (no game_id or randomness args -- derived in-circuit)
      await withRetry(
        () => gameContract.methods
          .create_game(cardIds.map((id: number) => new Fr(BigInt(id))))
          .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_TX_TIMEOUT } }),
        3, 'create_game',
      );

      const gameIdHex = toHexString(gameId);

      setOnChainGameId(gameIdHex);
      setGameRandomness(randomnessHex);
      setBlindingFactor(blindingHex);
      console.log('[useGameContract] On-chain game created, ID:', gameIdHex);
      return { gameId: gameIdHex, randomness: randomnessHex, blindingFactor: blindingHex };
    } catch (err) {
      console.error('[useGameContract] createGameOnChain error:', err);
      return null;
    } finally {
      creatingRef.current = false;
    }
  }, [wallet, accountAddress]);

  /**
   * Call join_game on the TripleTriadGame contract.
   * Randomness is derived IN-CIRCUIT by the NFT contract.
   * We preview it via NFT.preview_game_data().simulate() before sending the tx.
   * Returns { randomness } or null on failure.
   */
  const joinGameOnChain = useCallback(async (chainGameId: string, cardIds: number[]): Promise<{ randomness: string[]; blindingFactor: string } | null> => {
    if (!wallet || !AZTEC_CONFIG.gameContractAddress) return null;

    try {
      console.log('[useGameContract] Joining on-chain game:', chainGameId);

      const { gameContract, nftContract, fee, Fr, AztecAddress } = await ensureContracts(wallet);
      const senderAddr = accountAddress ? AztecAddress.fromString(accountAddress) : AztecAddress.ZERO;

      // Get current note_nonce to preview randomness
      const nonceResult = await withRetry(
        () => nftContract.methods.get_note_nonce(senderAddr).simulate({ from: senderAddr }),
        3, 'get_note_nonce (join)',
      );
      const nonceFr = toFrUtil(Fr, nonceResult);

      // Preview randomness (derived in-circuit via simulate)
      const previewResult: any = await withRetry(
        () => nftContract.methods.preview_game_data(nonceFr).simulate({ from: senderAddr }),
        3, 'preview_game_data (join)',
      );
      const randomnessHex = Array.from({ length: 6 }, (_, i) => toHexString(previewResult[i + 1]));
      console.log('[useGameContract] Preview randomness for join:', randomnessHex);

      // Derive blinding factor (sequentially, after preview — avoids concurrent IDB access)
      const blindingResult = await withRetry(
        () => nftContract.methods.compute_blinding_factor(toFrUtil(Fr, chainGameId)).simulate({ from: senderAddr }),
        3, 'compute_blinding_factor (join)',
      );
      const blindingHex = toHexString(blindingResult);
      console.log('[useGameContract] Blinding factor derived (join):', blindingHex);

      // Send join_game tx (no randomness arg -- derived in-circuit)
      await withRetry(
        () => gameContract.methods
          .join_game(toFrUtil(Fr, chainGameId), cardIds.map((id: number) => new Fr(BigInt(id))))
          .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_TX_TIMEOUT } }),
        3, 'join_game',
      );

      setOnChainGameId(chainGameId);
      setGameRandomness(randomnessHex);
      setBlindingFactor(blindingHex);
      console.log('[useGameContract] Joined on-chain game:', chainGameId);
      return { randomness: randomnessHex, blindingFactor: blindingHex };
    } catch (err) {
      console.error('[useGameContract] joinGameOnChain error:', err);
      return null;
    }
  }, [wallet, accountAddress]);

  /**
   * Call process_game on the TripleTriadGame contract to settle a finished game.
   *
   * This verifies all 11 proofs (2 hand + 9 move), validates the proof chain,
   * and transfers an NFT card from the loser to the winner.
   */
  const settleGame = useCallback(async (params: SettleGameParams): Promise<SettleResult | null> => {
    const {
      onChainGameId: gameId,
      handProof1, handProof2,
      moveProofs,
      opponentAddress,
      cardToTransfer,
      callerCardIds,
      opponentCardIds,
      callerRandomness: callerRandomnessHex,
      opponentRandomness: opponentRandomnessHex,
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
      const { fee, Fr, AztecAddress } = await ensureContracts(wallet);

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

      // Helper: convert raw bytes (base64 or Uint8Array) to Fr[] (each 32 bytes = 1 field)
      function bytesToFrArray(bytes: Uint8Array): InstanceType<typeof Fr>[] {
        const fields: InstanceType<typeof Fr>[] = [];
        for (let i = 0; i < bytes.length; i += 32) {
          const chunk = bytes.slice(i, i + 32);
          const hex = '0x' + Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join('');
          fields.push(Fr.fromHexString(hex));
        }
        return fields;
      }

      function base64ToFrArray(b64: string): InstanceType<typeof Fr>[] {
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytesToFrArray(bytes);
      }

      const hexToFr = (hex: string) => Fr.fromHexString(hex.startsWith('0x') ? hex : '0x' + hex);

      const handVkFields = bytesToFrArray(handVk);
      const moveVkFields = bytesToFrArray(moveVk);

      // 3. Convert proofs
      const hp1Proof = base64ToFrArray(handProof1.proof);
      const hp1Inputs = handProof1.publicInputs.map(hexToFr);
      const hp2Proof = base64ToFrArray(handProof2.proof);
      const hp2Inputs = handProof2.publicInputs.map(hexToFr);

      // Sort move proofs into chain by start/end state hashes
      const { computeBoardStateHash } = await import('../aztec/proofWorker');
      const emptyBoard = Array(18).fill('0');
      const canonicalInitial = await computeBoardStateHash(emptyBoard, [CARDS_PER_HAND, CARDS_PER_HAND], 1);

      const byStart = new Map<string, typeof moveProofs[0]>();
      for (const p of moveProofs) {
        byStart.set(p.startStateHash, p);
      }

      const sorted: typeof moveProofs = [];
      let nextHash = canonicalInitial;
      for (let i = 0; i < TOTAL_MOVES; i++) {
        const p = byStart.get(nextHash);
        if (!p) {
          throw new Error(`Proof chain broken at step ${i}: no proof with startStateHash matching previous endStateHash`);
        }
        sorted.push(p);
        nextHash = p.endStateHash;
      }
      console.log('[useGameContract] Move proofs sorted into chain');

      const mp: InstanceType<typeof Fr>[][] = [];
      const mi: InstanceType<typeof Fr>[][] = [];
      for (const m of sorted) {
        mp.push(base64ToFrArray(m.proof));
        mi.push(m.publicInputs.map(hexToFr));
      }

      setTxStatus('sending');

      const contract = contractCache.gameContract;
      if (!contract) throw new Error('Game contract not initialized');

      const senderAddr = accountAddress ? AztecAddress.fromString(accountAddress) : AztecAddress.ZERO;
      const opponent = AztecAddress.fromString(opponentAddress);

      const padTo5 = (ids: number[]): InstanceType<typeof Fr>[] => {
        const padded = [...ids];
        while (padded.length < CARDS_PER_HAND) padded.push(0);
        return padded.slice(0, CARDS_PER_HAND).map(id => new Fr(BigInt(id)));
      };

      const callerRandomness = callerRandomnessHex.map(v => toFrUtil(Fr, v));
      const opponentRandomness = opponentRandomnessHex.map(v => toFrUtil(Fr, v));

      // process_game signature (from contract):
      // game_id, hand_vk, move_vk,
      // hand_proof_1, hand_proof_1_inputs,
      // hand_proof_2, hand_proof_2_inputs,
      // move_proof_1, move_inputs_1, ... move_proof_9, move_inputs_9,
      // opponent, card_to_transfer, caller_card_ids, opponent_card_ids,
      // caller_randomness, opponent_randomness
      const processGameCall = contract.methods
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
          callerRandomness,
          opponentRandomness,
        );

      // Try simulate first to get detailed error before sending
      try {
        console.log('[useGameContract] Running simulate() to pre-check...');
        await processGameCall.simulate({ from: senderAddr });
        console.log('[useGameContract] simulate() succeeded — sending tx...');
      } catch (simErr) {
        console.error('[useGameContract] simulate() FAILED — this is the actual error:', simErr);
        // Re-throw with simulation error details
        const simMsg = simErr instanceof Error ? simErr.message : String(simErr);
        throw new Error(`Simulation failed (tx would revert): ${simMsg}`);
      }

      const receipt = await processGameCall
        .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_SETTLE_TX_TIMEOUT } });

      const hash = (receipt as any).txHash?.toString() || 'unknown';
      setTxHash(hash);
      setTxStatus('confirmed');
      console.log('[useGameContract] Game settled on-chain, txHash:', hash);

      // Log private cards for both players after settlement to verify transfer
      try {
        if (contractCache.nftContract) {
            const nftContract = contractCache.nftContract;

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
      } catch (logErr) {
        console.warn('[useGameContract] Failed to log post-settlement cards:', logErr);
      }

      // Build note data for both caller (winner) and opponent (loser).
      // IMPORTANT: The randomness mapping must mirror the Noir contract's logic exactly.
      // In the Noir contract, loser_rand[idx] = opponent_randomness[i] where i is the
      // ORIGINAL index into opponent_card_ids (skipping the transferred card).
      const isWinnerLoser = cardToTransfer !== 0;

      // Caller (winner) notes: 5 own cards + 1 transferred card
      const callerNotes: PlaintextNoteData[] = [];
      if (isWinnerLoser) {
        for (let i = 0; i < callerCardIds.length && i < 5; i++) {
          callerNotes.push({ tokenId: callerCardIds[i], randomness: callerRandomness[i].toString() });
        }
        callerNotes.push({ tokenId: cardToTransfer, randomness: callerRandomness[5].toString() });
      } else {
        // Draw: caller gets their 5 cards back
        for (let i = 0; i < callerCardIds.length && i < 5; i++) {
          callerNotes.push({ tokenId: callerCardIds[i], randomness: callerRandomness[i].toString() });
        }
      }

      // Opponent (loser) notes: mirror Noir's loop that skips the transferred card
      const opponentNotes: PlaintextNoteData[] = [];
      if (isWinnerLoser) {
        // Noir: for i in 0..5 { if opponent_card_ids[i] != card_to_transfer { loser_rand[idx] = opponent_randomness[i]; } }
        for (let i = 0; i < opponentCardIds.length && i < 5; i++) {
          if (opponentCardIds[i] !== cardToTransfer) {
            opponentNotes.push({ tokenId: opponentCardIds[i], randomness: opponentRandomness[i].toString() });
          }
        }
      } else {
        // Draw: opponent gets all 5 cards back
        for (let i = 0; i < opponentCardIds.length && i < 5; i++) {
          opponentNotes.push({ tokenId: opponentCardIds[i], randomness: opponentRandomness[i].toString() });
        }
      }

      return { txHash: hash, callerNotes, opponentNotes };
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

  const restoreState = useCallback((restoredGameId: string, restoredRandomness: string[], restoredBlinding?: string) => {
    setOnChainGameId(restoredGameId);
    setGameRandomness(restoredRandomness);
    if (restoredBlinding) setBlindingFactor(restoredBlinding);
  }, []);

  const resetLifecycle = useCallback(() => {
    setOnChainGameId(null);
    setGameRandomness(null);
    setBlindingFactor(null);
    creatingRef.current = false;
  }, []);

  return {
    txStatus,
    txHash,
    error,
    isAvailable,
    onChainGameId,
    gameRandomness,
    blindingFactor,
    createGameOnChain,
    joinGameOnChain,
    settleGame,
    resetTx,
    restoreState,
    resetLifecycle,
  };
}
