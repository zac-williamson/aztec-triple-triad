import { useState, useCallback, useRef } from 'react';
import { AZTEC_CONFIG } from '../aztec/config';
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
    const nftResp = await fetch('/contracts/triple_triad_nft-TripleTriadNFT.json');
    if (!nftResp.ok) throw new Error('Failed to load NFT contract artifact');
    const nftArtifact = loadContractArtifact(await nftResp.json());
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
      const nonceValue = String(nonceResult);
      const nonceFr = (nonceValue.startsWith('0x') || nonceValue.startsWith('0X'))
        ? Fr.fromHexString(nonceValue)
        : new Fr(BigInt(nonceValue));
      console.log('[useGameContract] Current nonce:', nonceValue);

      // Preview game_id and randomness (derived in-circuit via simulate)
      const previewResult: any = await withRetry(
        () => nftContract.methods.preview_game_data(nonceFr).simulate({ from: senderAddr }),
        3, 'preview_game_data',
      );
      // previewResult is [game_id, randomness[0..5]] (7 values)
      const gameId = String(previewResult[0]);
      const randomnessHex = Array.from({ length: 6 }, (_, i) => {
        const raw = String(previewResult[i + 1]);
        return (raw.startsWith('0x') || raw.startsWith('0X')) ? raw : '0x' + BigInt(raw).toString(16);
      });
      console.log('[useGameContract] Preview game_id:', gameId, 'randomness:', randomnessHex);

      // Derive blinding factor (sequentially, after preview — avoids concurrent IDB access)
      const gameIdFrForBlinding = (gameId.startsWith('0x') || gameId.startsWith('0X'))
        ? Fr.fromHexString(gameId)
        : new Fr(BigInt(gameId));
      const blindingResult = await withRetry(
        () => nftContract.methods.compute_blinding_factor(gameIdFrForBlinding).simulate({ from: senderAddr }),
        3, 'compute_blinding_factor (create)',
      );
      const blindingRaw = String(blindingResult);
      const blindingHex = (blindingRaw.startsWith('0x') || blindingRaw.startsWith('0X'))
        ? blindingRaw
        : '0x' + BigInt(blindingRaw).toString(16);
      console.log('[useGameContract] Blinding factor derived:', blindingHex);

      // Send create_game tx (no game_id or randomness args -- derived in-circuit)
      await withRetry(
        () => gameContract.methods
          .create_game(cardIds.map((id: number) => new Fr(BigInt(id))))
          .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: 300 } }),
        3, 'create_game',
      );

      // Normalize gameId to hex
      const gameIdHex = (gameId.startsWith('0x') || gameId.startsWith('0X'))
        ? gameId
        : '0x' + BigInt(gameId).toString(16);

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
      const nonceValue = String(nonceResult);
      const nonceFr = (nonceValue.startsWith('0x') || nonceValue.startsWith('0X'))
        ? Fr.fromHexString(nonceValue)
        : new Fr(BigInt(nonceValue));

      // Preview randomness (derived in-circuit via simulate)
      const previewResult: any = await withRetry(
        () => nftContract.methods.preview_game_data(nonceFr).simulate({ from: senderAddr }),
        3, 'preview_game_data (join)',
      );
      const randomnessHex = Array.from({ length: 6 }, (_, i) => {
        const raw = String(previewResult[i + 1]);
        return (raw.startsWith('0x') || raw.startsWith('0X')) ? raw : '0x' + BigInt(raw).toString(16);
      });
      console.log('[useGameContract] Preview randomness for join:', randomnessHex);

      // Derive blinding factor (sequentially, after preview — avoids concurrent IDB access)
      const gameIdFrForBlinding = (chainGameId.startsWith('0x') || chainGameId.startsWith('0X'))
        ? Fr.fromHexString(chainGameId)
        : new Fr(BigInt(chainGameId));
      const blindingResult = await withRetry(
        () => nftContract.methods.compute_blinding_factor(gameIdFrForBlinding).simulate({ from: senderAddr }),
        3, 'compute_blinding_factor (join)',
      );
      const blindingRaw = String(blindingResult);
      const blindingHex = (blindingRaw.startsWith('0x') || blindingRaw.startsWith('0X'))
        ? blindingRaw
        : '0x' + BigInt(blindingRaw).toString(16);
      console.log('[useGameContract] Blinding factor derived (join):', blindingHex);

      // Send join_game tx (no randomness arg -- derived in-circuit)
      const gameIdFr = (chainGameId.startsWith('0x') || chainGameId.startsWith('0X'))
        ? Fr.fromHexString(chainGameId)
        : new Fr(BigInt(chainGameId));
      await withRetry(
        () => gameContract.methods
          .join_game(gameIdFr, cardIds.map((id: number) => new Fr(BigInt(id))))
          .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: 300 } }),
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

      console.log('[useGameContract] VK raw bytes: hand=', handVk.length, 'move=', moveVk.length);
      console.log('[useGameContract] VK fields: hand=', handVkFields.length, 'move=', moveVkFields.length);
      console.log('[useGameContract] VK first field: hand=', handVkFields[0]?.toString(), 'move=', moveVkFields[0]?.toString());

      // 3. Convert proofs
      const hp1Proof = base64ToFrArray(handProof1.proof);
      const hp1Inputs = handProof1.publicInputs.map(toFr);
      const hp2Proof = base64ToFrArray(handProof2.proof);
      const hp2Inputs = handProof2.publicInputs.map(toFr);

      console.log('[useGameContract] === DIAGNOSTIC: Hand proofs ===');
      console.log('  hp1 proof fields:', hp1Proof.length, '| hp1 inputs:', hp1Inputs.length);
      console.log('  hp2 proof fields:', hp2Proof.length, '| hp2 inputs:', hp2Inputs.length);
      console.log('  hp1 publicInputs (raw):', handProof1.publicInputs);
      console.log('  hp2 publicInputs (raw):', handProof2.publicInputs);
      console.log('  hp1 cardCommit:', handProof1.cardCommit);
      console.log('  hp2 cardCommit:', handProof2.cardCommit);

      // 9 move proofs — sort into a chain by start/end state hashes
      // Public inputs: [0] card_commit_1, [1] card_commit_2,
      //   [2] start_state_hash, [3] end_state_hash, [4] game_ended, [5] winner_id
      // Chain rule: proof[i].endStateHash == proof[i+1].startStateHash

      // Compute canonical initial state hash to find the first proof
      const { computeBoardStateHash } = await import('../aztec/proofWorker');
      const emptyBoard = Array(18).fill('0');
      const canonicalInitial = await computeBoardStateHash(emptyBoard, [5, 5], 1);

      // Build a map from startStateHash → proof for O(1) lookup
      const byStart = new Map<string, typeof moveProofs[0]>();
      for (const p of moveProofs) {
        byStart.set(p.startStateHash, p);
      }

      // Walk the chain starting from the canonical initial state
      const sorted: typeof moveProofs = [];
      let nextHash = canonicalInitial;
      for (let i = 0; i < 9; i++) {
        const p = byStart.get(nextHash);
        if (!p) {
          console.error(`[useGameContract] Proof chain broken at step ${i}. Looking for startStateHash:`, nextHash);
          console.error('[useGameContract] Available startStateHashes:', [...byStart.keys()]);
          throw new Error(`Proof chain broken at step ${i}: no proof with startStateHash matching previous endStateHash`);
        }
        sorted.push(p);
        nextHash = p.endStateHash;
      }

      console.log('[useGameContract] Move proofs sorted into chain successfully');
      console.log('[useGameContract] === DIAGNOSTIC: Move proof chain ===');
      for (let i = 0; i < 9; i++) {
        const m = sorted[i];
        console.log(`  move[${i}]: start=${m.startStateHash.slice(0, 18)}... end=${m.endStateHash.slice(0, 18)}... gameEnded=${m.gameEnded} winnerId=${m.winnerId}`);
        console.log(`    publicInputs[0..1] (card_commits): ${m.publicInputs[0]?.slice(0, 18)}..., ${m.publicInputs[1]?.slice(0, 18)}...`);
      }
      // Verify chain
      for (let i = 0; i < 8; i++) {
        const ok = sorted[i].endStateHash === sorted[i + 1].startStateHash;
        if (!ok) console.error(`  CHAIN BREAK at ${i} -> ${i+1}: end=${sorted[i].endStateHash} != start=${sorted[i+1].startStateHash}`);
      }
      // Verify card commits are consistent across all move proofs
      const allCC1 = sorted.map(m => m.publicInputs[0]);
      const allCC2 = sorted.map(m => m.publicInputs[1]);
      const cc1Consistent = allCC1.every(c => c === allCC1[0]);
      const cc2Consistent = allCC2.every(c => c === allCC2[0]);
      console.log(`[useGameContract] card_commit_1 consistent across moves: ${cc1Consistent} (${allCC1[0]?.slice(0, 18)}...)`);
      console.log(`[useGameContract] card_commit_2 consistent across moves: ${cc2Consistent} (${allCC2[0]?.slice(0, 18)}...)`);
      // Verify hand proof commits match move proof commits
      console.log(`[useGameContract] hand_proof_1 commit matches move card_commit_1: ${handProof1.publicInputs[0] === allCC1[0]}`);
      console.log(`[useGameContract] hand_proof_2 commit matches move card_commit_2: ${handProof2.publicInputs[0] === allCC2[0]}`);
      if (handProof1.publicInputs[0] !== allCC1[0]) {
        console.error('  MISMATCH hp1:', handProof1.publicInputs[0], '!= move cc1:', allCC1[0]);
      }
      if (handProof2.publicInputs[0] !== allCC2[0]) {
        console.error('  MISMATCH hp2:', handProof2.publicInputs[0], '!= move cc2:', allCC2[0]);
      }

      const mp: InstanceType<typeof Fr>[][] = [];
      const mi: InstanceType<typeof Fr>[][] = [];
      for (let i = 0; i < 9; i++) {
        const m = sorted[i];
        mp.push(base64ToFrArray(m.proof));
        mi.push(m.publicInputs.map(toFr));
      }

      console.log('[useGameContract] === DIAGNOSTIC: Final sizes ===');
      console.log('  hp1 proof fields:', hp1Proof.length, '| hp2 proof fields:', hp2Proof.length);
      console.log('  mp[0] proof fields:', mp[0].length, '| mi[0] inputs:', mi[0].length);
      for (let i = 0; i < 9; i++) {
        console.log(`  mp[${i}] fields: ${mp[i].length} | mi[${i}] inputs: ${mi[i].length}`);
      }

      setTxStatus('sending');

      // 4. Use cached contract for process_game
      const contract = contractCache.gameContract;
      if (!contract) throw new Error('Game contract not initialized');

      const senderAddr = accountAddress ? AztecAddress.fromString(accountAddress) : AztecAddress.ZERO;
      const opponent = AztecAddress.fromString(opponentAddress);

      // === PRE-FLIGHT: Query on-chain state to diagnose settle_game assertions ===
      console.log('[useGameContract] === PRE-FLIGHT: On-chain state check ===');
      console.log('  game_id:', gameId);
      console.log('  caller (senderAddr):', senderAddr.toString());
      console.log('  opponent:', opponent.toString());
      console.log('  cardToTransfer:', cardToTransfer);
      console.log('  callerCardIds:', callerCardIds);
      console.log('  opponentCardIds:', opponentCardIds);
      try {
        const [onChainStatus, onChainSettled, onChainCC1, onChainCC2, onChainP1, onChainP2] = await Promise.all([
          contract.methods.get_game_status(new Fr(BigInt(gameId))).simulate({ from: senderAddr }),
          contract.methods.is_game_settled(new Fr(BigInt(gameId))).simulate({ from: senderAddr }),
          contract.methods.get_game_card_commit_1(new Fr(BigInt(gameId))).simulate({ from: senderAddr }),
          contract.methods.get_game_card_commit_2(new Fr(BigInt(gameId))).simulate({ from: senderAddr }),
          contract.methods.get_game_player1(new Fr(BigInt(gameId))).simulate({ from: senderAddr }),
          contract.methods.get_game_player2(new Fr(BigInt(gameId))).simulate({ from: senderAddr }),
        ]);
        console.log('  on-chain game_status:', String(onChainStatus));
        console.log('  on-chain is_settled:', onChainSettled);
        console.log('  on-chain card_commit_1:', String(onChainCC1));
        console.log('  on-chain card_commit_2:', String(onChainCC2));
        console.log('  on-chain player1:', String(onChainP1));
        console.log('  on-chain player2:', String(onChainP2));

        // Compare proof card commits against on-chain values
        const proofCC1 = hp1Inputs[0]?.toString();
        const proofCC2 = hp2Inputs[0]?.toString();
        console.log('  proof card_commit_1:', proofCC1);
        console.log('  proof card_commit_2:', proofCC2);
        console.log('  cc1 MATCH:', proofCC1 === String(onChainCC1));
        console.log('  cc2 MATCH:', proofCC2 === String(onChainCC2));

        // Check winner/loser mapping
        const lastMoveInputs = mi[8];
        const winnerId = lastMoveInputs[5]?.toString();
        console.log('  winner_id from final move proof:', winnerId);
        console.log('  caller is player1:', senderAddr.toString() === String(onChainP1));
        console.log('  caller is player2:', senderAddr.toString() === String(onChainP2));
        if (String(winnerId) === '1' || String(winnerId) === '0x1') {
          console.log('  => winner should be player1. caller IS player1:', senderAddr.toString() === String(onChainP1));
        } else if (String(winnerId) === '2' || String(winnerId) === '0x2') {
          console.log('  => winner should be player2. caller IS player2:', senderAddr.toString() === String(onChainP2));
        } else {
          console.log('  => draw or unknown winner_id');
        }
      } catch (prefErr) {
        console.warn('[useGameContract] Pre-flight check failed (non-fatal):', prefErr);
      }

      // Pad card ID arrays to exactly 5 elements
      const padTo5 = (ids: number[]): InstanceType<typeof Fr>[] => {
        const padded = [...ids];
        while (padded.length < 5) padded.push(0);
        return padded.slice(0, 5).map(id => new Fr(BigInt(id)));
      };

      // Use committed randomness values (validated against on-chain player_state_hash)
      // Values may be decimal strings from Fr.toString() — handle both hex and decimal
      const safeToFr = (v: string) => {
        if (v.startsWith('0x') || v.startsWith('0X')) return Fr.fromHexString(v);
        return new Fr(BigInt(v));
      };
      const callerRandomness = callerRandomnessHex.map(safeToFr);
      const opponentRandomness = opponentRandomnessHex.map(safeToFr);

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
        .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: 600 } });

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
