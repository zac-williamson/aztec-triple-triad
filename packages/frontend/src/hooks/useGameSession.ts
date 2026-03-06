import { useState, useCallback, useRef } from 'react';
import { useProofGeneration } from './useProofGeneration';
import type { PlayerHandData } from './useProofGeneration';
import type { GameState, HandProofData, MoveProofData, PlaintextNoteData } from '../types';
import { AZTEC_CONFIG } from '../aztec/config';
import { toFr as toFrUtil, toHexString } from '../aztec/fieldUtils';
import { getNftArtifact } from '../aztec/noteImporter';
import { AZTEC_TX_TIMEOUT, AZTEC_SETTLE_TX_TIMEOUT, CARDS_PER_HAND, TOTAL_MOVES } from '../aztec/gameConstants';

// Re-export types consumers need
export type TxStatus = 'idle' | 'preparing' | 'proving' | 'sending' | 'confirmed' | 'error';
export type ProofStatus = 'idle' | 'generating' | 'ready' | 'error';

export interface SettleGameParams {
  playerNumber: 1 | 2;
  opponentAddress: string;
  cardToTransfer: number;
  callerCardIds: number[];
  opponentCardIds: number[];
  opponentRandomness: string[];
}

export interface SettleResult {
  txHash: string;
  callerNotes: PlaintextNoteData[];
  opponentNotes: PlaintextNoteData[];
}

export interface UseGameSessionReturn {
  // --- On-chain state ---
  onChainGameId: string | null;
  gameRandomness: string[] | null;
  blindingFactor: string | null;
  isContractAvailable: boolean;
  settleTxStatus: TxStatus;
  settleTxHash: string | null;
  settleError: string | null;

  // --- Proof state ---
  myHandProof: HandProofData | null;
  opponentHandProof: HandProofData | null;
  collectedMoveProofs: MoveProofData[];
  canSettle: boolean;
  myCardCommit: string | null;
  opponentCardCommit: string | null;
  handProofStatus: ProofStatus;
  moveProofStatus: ProofStatus;

  // --- Actions ---
  createGameOnChain: (cardIds: number[]) => Promise<{ gameId: string; randomness: string[]; blindingFactor: string } | null>;
  joinGameOnChain: (onChainGameId: string, cardIds: number[]) => Promise<{ randomness: string[]; blindingFactor: string } | null>;
  settleGame: (params: SettleGameParams) => Promise<SettleResult | null>;
  setOpponentHandProof: (proof: HandProofData) => void;
  addMoveProof: (proof: MoveProofData) => void;
  generateHandProofFromState: (
    cardIds: number[],
    opponentGameRandomness: string[],
  ) => Promise<void>;
  generateMoveProofForPlacement: (
    cardId: number,
    row: number,
    col: number,
    playerNumber: 1 | 2,
    boardBefore: GameState['board'],
    boardAfter: GameState['board'],
    scoresBefore: [number, number],
    scoresAfter: [number, number],
    gameEnded: boolean,
    winnerId: number,
  ) => Promise<MoveProofData | null>;
  restoreState: (onChainGameId: string, randomness: string[], blindingFactor?: string) => void;
  reset: () => void;
}

// --- Contract infrastructure (module-level, shared across hook instances) ---

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

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, label = 'PXE op'): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('TransactionInactiveError') && attempt < maxRetries - 1) {
        console.warn(`[useGameSession] ${label} hit IDB error (attempt ${attempt + 1}/${maxRetries}), retrying...`);
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

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
  if (contractCache.wallet !== wallet) {
    contractCache.wallet = wallet;
    contractCache.gameContract = null;
    contractCache.nftContract = null;
    contractCache.fee = null;
  }

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

  if (!contractCache.nftContract && AZTEC_CONFIG.nftContractAddress) {
    const nftAddr = AztecAddress.fromString(AZTEC_CONFIG.nftContractAddress);
    const nftArtifact = await getNftArtifact();
    contractCache.nftContract = await withRetry(
      () => Contract.at(nftAddr, nftArtifact, wallet as never),
      3, 'Contract.at(nft)',
    );
  }

  if (!contractCache.fee) {
    contractCache.fee = await getSponsoredFee();
  }

  return { gameContract: contractCache.gameContract, nftContract: contractCache.nftContract, fee: contractCache.fee, Fr, AztecAddress };
}

// --- The hook ---

export function useGameSession(
  wallet: unknown | null,
  accountAddress: string | null,
): UseGameSessionReturn {
  // On-chain state
  const [onChainGameId, setOnChainGameId] = useState<string | null>(null);
  const [gameRandomness, setGameRandomness] = useState<string[] | null>(null);
  const [blindingFactor, setBlindingFactor] = useState<string | null>(null);
  const [settleTxStatus, setSettleTxStatus] = useState<TxStatus>('idle');
  const [settleTxHash, setSettleTxHash] = useState<string | null>(null);
  const [settleError, setSettleError] = useState<string | null>(null);
  const creatingRef = useRef(false);

  // Proof state
  const [myHandProof, setMyHandProof] = useState<HandProofData | null>(null);
  const [opponentHandProof, setOpponentHandProof] = useState<HandProofData | null>(null);
  const [collectedMoveProofs, setCollectedMoveProofs] = useState<MoveProofData[]>([]);
  const [handProofStatus, setHandProofStatus] = useState<ProofStatus>('idle');
  const [moveProofStatus, setMoveProofStatus] = useState<ProofStatus>('idle');
  const proofs = useProofGeneration();

  const isContractAvailable = wallet !== null && AZTEC_CONFIG.enabled && !!AZTEC_CONFIG.gameContractAddress;

  // Derived
  const myCardCommit = myHandProof?.cardCommit ?? null;
  const opponentCardCommit = opponentHandProof?.cardCommit ?? null;

  // Stash cardIds for move proof generation (set during create/join/generateHandProof)
  const cardIdsRef = useRef<number[]>([]);

  const canSettle = myHandProof !== null &&
    opponentHandProof !== null &&
    collectedMoveProofs.length >= TOTAL_MOVES;

  // --- On-chain actions ---

  const createGameOnChain = useCallback(async (cardIds: number[]): Promise<{ gameId: string; randomness: string[]; blindingFactor: string } | null> => {
    if (!wallet || !AZTEC_CONFIG.gameContractAddress) return null;
    if (creatingRef.current) return null;
    creatingRef.current = true;

    try {
      const { gameContract, nftContract, fee, Fr, AztecAddress } = await ensureContracts(wallet);
      const senderAddr = accountAddress ? AztecAddress.fromString(accountAddress) : AztecAddress.ZERO;

      const nonceResult = await withRetry(
        () => nftContract.methods.get_note_nonce(senderAddr).simulate({ from: senderAddr }),
        3, 'get_note_nonce',
      );
      const nonceFr = toFrUtil(Fr, nonceResult);

      const previewResult: any = await withRetry(
        () => nftContract.methods.preview_game_data(nonceFr).simulate({ from: senderAddr }),
        3, 'preview_game_data',
      );
      const gameId = String(previewResult[0]);
      const randomnessHex = Array.from({ length: 6 }, (_, i) => toHexString(previewResult[i + 1]));

      const blindingResult = await withRetry(
        () => nftContract.methods.compute_blinding_factor(toFrUtil(Fr, gameId)).simulate({ from: senderAddr }),
        3, 'compute_blinding_factor',
      );
      const blindingHex = toHexString(blindingResult);

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
      cardIdsRef.current = cardIds;
      console.log('[useGameSession] On-chain game created, ID:', gameIdHex);
      return { gameId: gameIdHex, randomness: randomnessHex, blindingFactor: blindingHex };
    } catch (err) {
      console.error('[useGameSession] createGameOnChain error:', err);
      return null;
    } finally {
      creatingRef.current = false;
    }
  }, [wallet, accountAddress]);

  const joinGameOnChain = useCallback(async (chainGameId: string, cardIds: number[]): Promise<{ randomness: string[]; blindingFactor: string } | null> => {
    if (!wallet || !AZTEC_CONFIG.gameContractAddress) return null;

    try {
      const { gameContract, nftContract, fee, Fr, AztecAddress } = await ensureContracts(wallet);
      const senderAddr = accountAddress ? AztecAddress.fromString(accountAddress) : AztecAddress.ZERO;

      const nonceResult = await withRetry(
        () => nftContract.methods.get_note_nonce(senderAddr).simulate({ from: senderAddr }),
        3, 'get_note_nonce (join)',
      );
      const nonceFr = toFrUtil(Fr, nonceResult);

      const previewResult: any = await withRetry(
        () => nftContract.methods.preview_game_data(nonceFr).simulate({ from: senderAddr }),
        3, 'preview_game_data (join)',
      );
      const randomnessHex = Array.from({ length: 6 }, (_, i) => toHexString(previewResult[i + 1]));

      const blindingResult = await withRetry(
        () => nftContract.methods.compute_blinding_factor(toFrUtil(Fr, chainGameId)).simulate({ from: senderAddr }),
        3, 'compute_blinding_factor (join)',
      );
      const blindingHex = toHexString(blindingResult);

      await withRetry(
        () => gameContract.methods
          .join_game(toFrUtil(Fr, chainGameId), cardIds.map((id: number) => new Fr(BigInt(id))))
          .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_TX_TIMEOUT } }),
        3, 'join_game',
      );

      setOnChainGameId(chainGameId);
      setGameRandomness(randomnessHex);
      setBlindingFactor(blindingHex);
      cardIdsRef.current = cardIds;
      console.log('[useGameSession] Joined on-chain game:', chainGameId);
      return { randomness: randomnessHex, blindingFactor: blindingHex };
    } catch (err) {
      console.error('[useGameSession] joinGameOnChain error:', err);
      return null;
    }
  }, [wallet, accountAddress]);

  // --- Proof actions ---

  const generateHandProofFromState = useCallback(async (
    cardIds: number[],
    opponentGameRandomness: string[],
  ): Promise<void> => {
    if (!blindingFactor) {
      console.warn('[useGameSession] Cannot generate hand proof: no blinding factor');
      return;
    }
    cardIdsRef.current = cardIds;
    setHandProofStatus('generating');

    try {
      const { computeCardCommitPoseidon2, computePlayerStateHash } = await import('../aztec/proofWorker');
      const cardCommitHash = await computeCardCommitPoseidon2(cardIds, blindingFactor);
      const opponentPlayerStateHash = await computePlayerStateHash(opponentGameRandomness);
      const proof = await proofs.generateHandProof(
        cardIds, blindingFactor, cardCommitHash,
        opponentGameRandomness, opponentPlayerStateHash,
      );
      setMyHandProof(proof);
      setHandProofStatus('ready');
    } catch (err) {
      console.error('[useGameSession] Hand proof generation failed:', err);
      setHandProofStatus('error');
    }
  }, [blindingFactor, proofs.generateHandProof]);

  const addMoveProof = useCallback((proof: MoveProofData) => {
    setCollectedMoveProofs(prev => {
      const isDuplicate = prev.some(
        p => p.startStateHash === proof.startStateHash && p.endStateHash === proof.endStateHash,
      );
      if (isDuplicate) return prev;
      return [...prev, proof];
    });
  }, []);

  const generateMoveProofForPlacement = useCallback(
    async (
      cardId: number,
      row: number,
      col: number,
      playerNumber: 1 | 2,
      boardBefore: GameState['board'],
      boardAfter: GameState['board'],
      scoresBefore: [number, number],
      scoresAfter: [number, number],
      gameEnded: boolean,
      winnerId: number,
    ): Promise<MoveProofData | null> => {
      if (!myHandProof || !opponentHandProof || !myCardCommit || !opponentCardCommit || !blindingFactor) {
        console.warn('[useGameSession] Cannot generate move proof: missing proofs or blinding factor');
        return null;
      }

      const commit1 = playerNumber === 1 ? myCardCommit : opponentCardCommit;
      const commit2 = playerNumber === 2 ? myCardCommit : opponentCardCommit;

      const handData: PlayerHandData = {
        cardIds: cardIdsRef.current,
        blindingFactor,
      };

      setMoveProofStatus('generating');
      try {
        const proof = await proofs.generateMoveProof(
          cardId, row, col, playerNumber,
          boardBefore, boardAfter,
          scoresBefore, scoresAfter,
          commit1, commit2,
          gameEnded, winnerId,
          handData,
        );
        addMoveProof(proof);
        setMoveProofStatus('ready');
        return proof;
      } catch (err) {
        console.error('[useGameSession] Move proof generation failed:', err);
        setMoveProofStatus('error');
        return null;
      }
    },
    [myHandProof, opponentHandProof, myCardCommit, opponentCardCommit, blindingFactor, proofs.generateMoveProof, addMoveProof],
  );

  // --- Settlement ---

  const settleGame = useCallback(async (params: SettleGameParams): Promise<SettleResult | null> => {
    const {
      playerNumber,
      opponentAddress,
      cardToTransfer,
      callerCardIds,
      opponentCardIds,
      opponentRandomness: opponentRandomnessHex,
    } = params;

    if (!wallet || !AZTEC_CONFIG.gameContractAddress || !onChainGameId || !myHandProof || !opponentHandProof || !gameRandomness) {
      setSettleError('Missing required state for settlement');
      return null;
    }
    if (collectedMoveProofs.length < TOTAL_MOVES) {
      setSettleError(`Need ${TOTAL_MOVES} move proofs, have ${collectedMoveProofs.length}`);
      return null;
    }

    setSettleTxStatus('preparing');
    setSettleError(null);
    setSettleTxHash(null);

    try {
      const { fee, Fr, AztecAddress } = await ensureContracts(wallet);

      setSettleTxStatus('proving');

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

      // Sort move proofs into chain
      const { computeBoardStateHash } = await import('../aztec/proofWorker');
      const emptyBoard = Array(18).fill('0');
      const canonicalInitial = await computeBoardStateHash(emptyBoard, [CARDS_PER_HAND, CARDS_PER_HAND], 1);

      const byStart = new Map<string, typeof collectedMoveProofs[0]>();
      for (const p of collectedMoveProofs) {
        byStart.set(p.startStateHash, p);
      }

      const sorted: typeof collectedMoveProofs = [];
      let nextHash = canonicalInitial;
      for (let i = 0; i < TOTAL_MOVES; i++) {
        const p = byStart.get(nextHash);
        if (!p) throw new Error(`Proof chain broken at step ${i}`);
        sorted.push(p);
        nextHash = p.endStateHash;
      }

      const mp: InstanceType<typeof Fr>[][] = [];
      const mi: InstanceType<typeof Fr>[][] = [];
      for (const m of sorted) {
        mp.push(base64ToFrArray(m.proof));
        mi.push(m.publicInputs.map(hexToFr));
      }

      setSettleTxStatus('sending');

      const contract = contractCache.gameContract;
      if (!contract) throw new Error('Game contract not initialized');

      const senderAddr = accountAddress ? AztecAddress.fromString(accountAddress) : AztecAddress.ZERO;
      const opponent = AztecAddress.fromString(opponentAddress);

      const padTo5 = (ids: number[]): InstanceType<typeof Fr>[] => {
        const padded = [...ids];
        while (padded.length < CARDS_PER_HAND) padded.push(0);
        return padded.slice(0, CARDS_PER_HAND).map(id => new Fr(BigInt(id)));
      };

      const callerRandomness = gameRandomness.map(v => toFrUtil(Fr, v));
      const opponentRandomness = opponentRandomnessHex.map(v => toFrUtil(Fr, v));

      // Order proofs: handProof1 is always player 1's, handProof2 is always player 2's
      const handProof1 = playerNumber === 1 ? myHandProof! : opponentHandProof!;
      const handProof2 = playerNumber === 2 ? myHandProof! : opponentHandProof!;
      const hp1ProofData = base64ToFrArray(handProof1.proof);
      const hp1InputData = handProof1.publicInputs.map(hexToFr);
      const hp2ProofData = base64ToFrArray(handProof2.proof);
      const hp2InputData = handProof2.publicInputs.map(hexToFr);

      const processGameCall = contract.methods
        .process_game(
          new Fr(BigInt(onChainGameId)),
          handVkFields,
          moveVkFields,
          hp1ProofData, hp1InputData,
          hp2ProofData, hp2InputData,
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

      try {
        await processGameCall.simulate({ from: senderAddr });
      } catch (simErr) {
        const simMsg = simErr instanceof Error ? simErr.message : String(simErr);
        throw new Error(`Simulation failed (tx would revert): ${simMsg}`);
      }

      const receipt = await processGameCall
        .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_SETTLE_TX_TIMEOUT } });

      const hash = (receipt as any).txHash?.toString() || 'unknown';
      setSettleTxHash(hash);
      setSettleTxStatus('confirmed');
      console.log('[useGameSession] Game settled on-chain, txHash:', hash);

      // Build note data
      const isWinnerLoser = cardToTransfer !== 0;

      const callerNotes: PlaintextNoteData[] = [];
      if (isWinnerLoser) {
        for (let i = 0; i < callerCardIds.length && i < 5; i++) {
          callerNotes.push({ tokenId: callerCardIds[i], randomness: callerRandomness[i].toString() });
        }
        callerNotes.push({ tokenId: cardToTransfer, randomness: callerRandomness[5].toString() });
      } else {
        for (let i = 0; i < callerCardIds.length && i < 5; i++) {
          callerNotes.push({ tokenId: callerCardIds[i], randomness: callerRandomness[i].toString() });
        }
      }

      const opponentNotes: PlaintextNoteData[] = [];
      if (isWinnerLoser) {
        for (let i = 0; i < opponentCardIds.length && i < 5; i++) {
          if (opponentCardIds[i] !== cardToTransfer) {
            opponentNotes.push({ tokenId: opponentCardIds[i], randomness: opponentRandomness[i].toString() });
          }
        }
      } else {
        for (let i = 0; i < opponentCardIds.length && i < 5; i++) {
          opponentNotes.push({ tokenId: opponentCardIds[i], randomness: opponentRandomness[i].toString() });
        }
      }

      return { txHash: hash, callerNotes, opponentNotes };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      console.error('[useGameSession] settleGame error:', err);
      setSettleError(message);
      setSettleTxStatus('error');
      return null;
    }
  }, [wallet, accountAddress, onChainGameId, myHandProof, opponentHandProof, collectedMoveProofs, gameRandomness]);

  // --- Lifecycle ---

  const restoreState = useCallback((restoredGameId: string, restoredRandomness: string[], restoredBlinding?: string) => {
    setOnChainGameId(restoredGameId);
    setGameRandomness(restoredRandomness);
    if (restoredBlinding) setBlindingFactor(restoredBlinding);
  }, []);

  const reset = useCallback(() => {
    setOnChainGameId(null);
    setGameRandomness(null);
    setBlindingFactor(null);
    setSettleTxStatus('idle');
    setSettleTxHash(null);
    setSettleError(null);
    creatingRef.current = false;
    setMyHandProof(null);
    setOpponentHandProof(null);
    setCollectedMoveProofs([]);
    setHandProofStatus('idle');
    setMoveProofStatus('idle');
    cardIdsRef.current = [];
    proofs.reset();
  }, [proofs.reset]);

  return {
    onChainGameId,
    gameRandomness,
    blindingFactor,
    isContractAvailable,
    settleTxStatus,
    settleTxHash,
    settleError,
    myHandProof,
    opponentHandProof,
    collectedMoveProofs,
    canSettle,
    myCardCommit,
    opponentCardCommit,
    handProofStatus,
    moveProofStatus,
    createGameOnChain,
    joinGameOnChain,
    settleGame,
    setOpponentHandProof,
    addMoveProof,
    generateHandProofFromState,
    generateMoveProofForPlacement,
    restoreState,
    reset,
  };
}
