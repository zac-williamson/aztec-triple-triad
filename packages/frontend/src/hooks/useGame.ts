import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from './useWebSocket';
import { useProofGeneration } from './useProofGeneration';
import type { PlayerHandData } from './useProofGeneration';
import { useGameStorage, type PersistedGameState } from './useGameStorage';
import { useAztecContext } from '../aztec/AztecContext';
import { importNotesFromTx } from '../aztec/noteImporter';
import { removeCards } from '../aztec/cardStore';
import txManager from '../aztec/txManager';
import { ensureContracts, contractCache, warmupContracts, waitForWarmup } from '../aztec/contracts';
import { AZTEC_CONFIG } from '../aztec/config';
import { toFr as toFrUtil, toHexString } from '../aztec/fieldUtils';
import { AZTEC_TX_TIMEOUT, AZTEC_SETTLE_TX_TIMEOUT, CARDS_PER_HAND, TOTAL_MOVES, MOVE_PROOF_WAIT_TIMEOUT, HAND_PROOF_WAIT_TIMEOUT } from '../aztec/gameConstants';
import type { Screen, GameState, Player, Card, HandProofData, MoveProofData, PlaintextNoteData } from '../types';

// Re-export types consumers need
export type TxStatus = 'idle' | 'preparing' | 'proving' | 'sending' | 'confirmed' | 'error';
export type ProofStatus = 'idle' | 'generating' | 'ready' | 'error';

/**
 * Map game winner to circuit winner_id value.
 * 0=not ended, 1=player1, 2=player2, 3=draw
 */
export function mapWinnerId(winner: Player | 'draw' | null): number {
  if (winner === null) return 0;
  if (winner === 'player1') return 1;
  if (winner === 'player2') return 2;
  return 3;
}

export interface UseGameReturn {
  // Screen routing
  screen: Screen;
  setScreen: (s: Screen) => void;

  // WebSocket state (pass-through for components)
  ws: ReturnType<typeof useWebSocket>;

  // On-chain + proof state (previously game.session.*)
  onChainGameId: string | null;
  handProofStatus: ProofStatus;
  moveProofStatus: ProofStatus;
  canSettle: boolean;
  settleTxStatus: TxStatus;
  onChainError: string | null;

  // Game state
  cardIds: number[];
  packResult: { location: string; cardIds: number[] } | null;
  hasGameInProgress: boolean;

  // Settlement info (for loser UX)
  opponentSettled: boolean;
  takenCardId: number | null;

  // Abandoned game
  isClaimingAbandoned: boolean;
  abandonedDisputeCountdown: number | null;
  canGoBack: boolean;

  // Actions
  handlePlay: () => void;
  handleCardPacks: () => void;
  handleHandSelected: (ids: number[]) => void;
  handleCancelMatchmaking: () => void;
  handlePackOpened: (location: string, result: { cardIds: number[]; txHash: string | null }) => void;
  handlePackOpenComplete: () => void;
  handlePlaceCard: (handIndex: number, row: number, col: number) => void;
  handleSettle: (selectedCardId: number) => void;
  handleBackToMenu: () => void;
}

/**
 * Remove exactly one copy of each ID in `toRemove` from `source`.
 */
function removeOneOfEach(source: number[], toRemove: number[]): number[] {
  const remaining = [...toRemove];
  return source.filter(id => {
    const idx = remaining.indexOf(id);
    if (idx !== -1) {
      remaining.splice(idx, 1);
      return false;
    }
    return true;
  });
}

// --- On-chain pipeline phase ---
type OnChainPhase = 'idle' | 'creating' | 'preparing' | 'awaiting_p1_tx' | 'joining' | 'done';

/**
 * Merged game hook — replaces useGameOrchestrator + useGameSession.
 *
 * Directly owns all on-chain state, proof state, and orchestration logic.
 * Async pipelines call contract methods then WS sends inline — no intermediate
 * state layer or cross-hook effect chains.
 */
export function useGame(wsUrl: string): UseGameReturn {
  const aztec = useAztecContext();
  const ws = useWebSocket(wsUrl);
  const proofs = useProofGeneration();
  const storage = useGameStorage();

  // --- Screen + game state ---
  const [screen, setScreen] = useState<Screen>('main-menu');
  const [cardIds, setCardIds] = useState<number[]>([]);
  const [packResult, setPackResult] = useState<{ location: string; cardIds: number[] } | null>(null);
  const [hasGameInProgress, setHasGameInProgress] = useState(() => storage.hasGame());

  // --- On-chain state (from useGameSession) ---
  const [onChainGameId, setOnChainGameId] = useState<string | null>(null);
  const [gameRandomness, setGameRandomness] = useState<string[] | null>(null);
  const [blindingFactor, setBlindingFactor] = useState<string | null>(null);
  const [settleTxStatus, setSettleTxStatus] = useState<TxStatus>('idle');
  const [settleTxHash, setSettleTxHash] = useState<string | null>(null);
  const [settleError, setSettleError] = useState<string | null>(null);
  const [onChainError, setOnChainError] = useState<string | null>(null);

  // --- Abandoned game state ---
  const [isClaimingAbandoned, setIsClaimingAbandoned] = useState(false);
  const [abandonedDisputeCountdown, setAbandonedDisputeCountdown] = useState<number | null>(null);
  const abandonedClaimStartedRef = useRef(false);

  // --- Opponent settlement tracking (for loser UX) ---
  const [opponentSettled, setOpponentSettled] = useState(false);
  const [takenCardId, setTakenCardId] = useState<number | null>(null);

  // --- Proof state ---
  const [myHandProof, setMyHandProof] = useState<HandProofData | null>(null);
  const [opponentHandProof, setOpponentHandProof] = useState<HandProofData | null>(null);
  const [collectedMoveProofs, setCollectedMoveProofs] = useState<MoveProofData[]>([]);
  const [handProofStatus, setHandProofStatus] = useState<ProofStatus>('idle');
  const [moveProofStatus, setMoveProofStatus] = useState<ProofStatus>('idle');

  const isContractAvailable = aztec.wallet !== null && AZTEC_CONFIG.enabled && !!AZTEC_CONFIG.gameContractAddress;

  // Derived
  const myCardCommit = myHandProof?.cardCommit ?? null;
  const opponentCardCommit = opponentHandProof?.cardCommit ?? null;
  const cardIdsRef = useRef<number[]>([]);
  const canSettle = myHandProof !== null && opponentHandProof !== null && collectedMoveProofs.length >= TOTAL_MOVES;

  // Ref to always access latest move proofs (avoids stale closure in handleSettle)
  const moveProofsRef = useRef(collectedMoveProofs);
  moveProofsRef.current = collectedMoveProofs;

  // Persistent ref for pipeline-dependent values that settle_game needs.
  // Populated by pipeline postEffects and WebSocket effects. NOT cleared
  // by handleBackToMenu or ws.leaveGame(), so settlement survives navigation.
  const settlementInfoRef = useRef<{
    onChainGameId: string;
    gameRandomness: string[];
    opponentAddress: string;
    opponentRandomness: string[];
  } | null>(null);

  // --- Refs ---
  // Idempotency guards (kept)
  const handProofSubmittedRef = useRef(false);
  const handProofGeneratedRef = useRef(false);
  const noteImportProcessedRef = useRef<string | null>(null);

  // Typed phase ref (replaces 4 boolean guards)
  const onChainPhaseRef = useRef<OnChainPhase>('idle');

  // Board state history — indexed by occupied cell count (move number)
  const gameStateHistoryRef = useRef<Map<number, {
    board: GameState['board'];
    scores: [number, number];
    currentTurn: 'player1' | 'player2';
  }>>(new Map());

  // Promise-based settlement wait (replaces busy-polling)
  const moveProofsCompleteRef = useRef<(() => void) | null>(null);

  // Refs for hand proofs (avoids stale closures in handleSettle)
  const myHandProofRef = useRef(myHandProof);
  myHandProofRef.current = myHandProof;
  const opponentHandProofRef = useRef(opponentHandProof);
  opponentHandProofRef.current = opponentHandProof;

  // Promise-based hand proof wait (same pattern as moveProofsCompleteRef)
  const handProofsCompleteRef = useRef<(() => void) | null>(null);

  // Guard: preview data already shared with opponent via WebSocket
  const previewSharedRef = useRef(false);

  // Promise-based wait for on-chain pipeline completion (prevents concurrent PXE access)
  const pipelineDoneResolveRef = useRef<(() => void) | null>(null);

  // Last settlement tx hash — persists across game resets so we can wait for
  // the PXE to process the block containing nullifiers before the next create_game
  const lastSettleTxHashRef = useRef<string | null>(null);

  // Queue of moves made before hand proofs were ready
  const pendingMovesRef = useRef<Array<{
    card: Card; p1Hand: Card[]; p2Hand: Card[];
    handIndex: number; row: number; col: number;
    moveNumber: number;
  }>>([]);

  // --- Helpers ---

  function requireWallet() {
    if (!aztec.wallet) throw new Error('wallet is not connected');
    return aztec.wallet;
  }

  function requireAccountAddress() {
    if (!aztec.accountAddress) throw new Error('accountAddress is not set');
    return aztec.accountAddress;
  }

  const addMoveProof = useCallback((proof: MoveProofData) => {
    setCollectedMoveProofs(prev => {
      const isDuplicate = prev.some(
        p => p.startStateHash === proof.startStateHash && p.endStateHash === proof.endStateHash,
      );
      if (isDuplicate) return prev;
      return [...prev, proof];
    });
  }, []);

  // --- Contract actions (inline, not cross-hook) ---

  const createGameOnChain = useCallback(async (ids: number[]): Promise<{ gameId: string; randomness: string[]; blindingFactor: string; txHash: string }> => {
    const w = requireWallet();
    const addr = requireAccountAddress();

    // Wait for warmup to complete before touching PXE — warmup runs
    // outside the txManager queue and its registerContract/Contract.at
    // calls race with ours on IDB if we don't wait.
    await waitForWarmup();
    const { gameContract, nftContract, fee, Fr, AztecAddress } = await ensureContracts(w);
    const senderAddr = AztecAddress.fromString(addr);

    console.log('[useGame] Starting create_game pipeline...');
    console.log(`[PXE-TRACE] ${Date.now()} nftContract.get_note_nonce(${senderAddr}).simulate()`);
    const { result: nonceResult } = await nftContract.methods.get_note_nonce(senderAddr).simulate({ from: senderAddr });
    const nonceFr = toFrUtil(Fr, nonceResult);
    console.log(`[PXE-TRACE] ${Date.now()} get_note_nonce COMPLETE result=${nonceFr.toString()}`);

    console.log(`[PXE-TRACE] ${Date.now()} nftContract.preview_game_data(${nonceFr}).simulate()`);
    const { result: previewResult }: any = await nftContract.methods.preview_game_data(nonceFr).simulate({ from: senderAddr });
    const gameId = String(previewResult[0]);
    const randomnessHex = Array.from({ length: 6 }, (_, i) => toHexString(previewResult[i + 1]));
    const gameIdFr = toFrUtil(Fr, gameId);
    console.log(`[PXE-TRACE] ${Date.now()} preview_game_data COMPLETE gameId=${toHexString(gameId).slice(0,20)}...`);

    console.log(`[PXE-TRACE] ${Date.now()} gameContract.get_game_status(${toHexString(gameId).slice(0,20)}...).simulate()`);
    const { result: statusResult } = await gameContract.methods.get_game_status(gameIdFr).simulate({ from: senderAddr });
    console.log(`[PXE-TRACE] ${Date.now()} get_game_status COMPLETE result=${statusResult}`);

    console.log(`[PXE-TRACE] ${Date.now()} nftContract.compute_blinding_factor(${toHexString(gameId).slice(0,20)}...).simulate()`);
    const { result: blindingResult } = await nftContract.methods.compute_blinding_factor(gameIdFr).simulate({ from: senderAddr });
    console.log(`[PXE-TRACE] ${Date.now()} compute_blinding_factor COMPLETE`);
    if (Number(statusResult) !== 0) {
      throw new Error(`Game ID already exists with status ${Number(statusResult)}, nonce may be stale`);
    }
    const blindingHex = toHexString(blindingResult);
    const gameIdHex = toHexString(gameId);

    setOnChainGameId(gameIdHex);
    setGameRandomness(randomnessHex);
    setBlindingFactor(blindingHex);

    console.log('game id hex = ', gameIdHex);
    console.log('game randomness = ', randomnessHex);
    console.log('game blinding factors = ', blindingHex);
    cardIdsRef.current = ids;
    console.log('chosen game ids = ', ids);
    console.log('[useGame] Game preview ready, ID:', gameIdHex, '— sending create_game tx...');

    // Diagnostic: check what notes the PXE thinks are available
    try {
      console.log(`[PXE-TRACE] ${Date.now()} nftContract.get_nfts_for_user(${senderAddr}, 0).simulate() [diagnostic]`);
      const { result: pxeCards } = await nftContract.methods.get_nfts_for_user(senderAddr, 0).simulate({ from: senderAddr });
      console.log(`[PXE-TRACE] ${Date.now()} get_nfts_for_user COMPLETE [diagnostic]`);
      // simulate() returns tuple as nested array: [fieldArray, hasMore]
      const page = pxeCards[0] ?? pxeCards;
      const cardList = Array.isArray(page) ? page.map((c: any) => Number(c)) : page;
      console.log('[useGame] PXE private cards before create_game:', cardList);
    } catch (e) {
      console.warn('[useGame] Could not query PXE private cards:', e);
    }

    console.log(`[PXE-TRACE] ${Date.now()} gameContract.create_game([${ids.join(',')}]).send(from=${senderAddr})`);
    const { receipt } = await gameContract.methods
      .create_game(ids.map((id: number) => new Fr(BigInt(id))))
      .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_TX_TIMEOUT } });
    const txHash = receipt?.txHash?.toString();
    if (!txHash) throw new Error('create_game tx returned no txHash');
    console.log(`[PXE-TRACE] ${Date.now()} create_game().send COMPLETE txHash=${txHash}`);

    // DIAGNOSTIC: dump TxEffect nullifiers from create_game so we can compare
    // with PXE's stored siloedNullifiers
    try {
      const nodeClient = aztec.nodeClient as any;
      if (nodeClient) {
        const { TxHash } = await import('@aztec/stdlib/tx');
        const hash = TxHash.fromString(txHash);
        const txResult = await nodeClient.getTxEffect(hash);
        if (txResult?.data) {
          const nullifiers = txResult.data.nullifiers ?? [];
          console.log(`[useGame] create_game TxEffect: ${nullifiers.length} nullifiers, block=${txResult.l2BlockNumber}`);
          nullifiers.forEach((n: any, i: number) => {
            console.log(`[useGame] create_game nullifier[${i}]: ${n.toString()}`);
          });
          const noteHashes = txResult.data.noteHashes ?? [];
          console.log(`[useGame] create_game TxEffect: ${noteHashes.length} noteHashes`);
          noteHashes.forEach((h: any, i: number) => {
            console.log(`[useGame] create_game noteHash[${i}]: ${h.toString()}`);
          });
        }
      }
    } catch (diagErr) {
      console.warn('[useGame] create_game diagnostic failed:', diagErr);
    }

    // Remove committed cards from localStorage after confirmed tx
    if (addr) removeCards(addr, ids);

    return { gameId: gameIdHex, randomness: randomnessHex, blindingFactor: blindingHex, txHash };
  }, [aztec.wallet, aztec.accountAddress]);

  const prepareJoinGame = useCallback(async (chainGameId: string, ids: number[]): Promise<{ randomness: string[]; blindingFactor: string }> => {
    const w = requireWallet();
    const addr = requireAccountAddress();

    console.log('[useGame] Preparing join_game preview...');
    const { nftContract, Fr, AztecAddress } = await ensureContracts(w);
    const senderAddr = AztecAddress.fromString(addr);
    const chainGameIdFr = toFrUtil(Fr, chainGameId);

    // PXE does not support concurrent simulate() calls (see IDB_TRANSACTION_ERROR_REPORT.md)
    const { result: nonceResult } = await nftContract.methods.get_note_nonce(senderAddr).simulate({ from: senderAddr });
    const { result: blindingResult } = await nftContract.methods.compute_blinding_factor(chainGameIdFr).simulate({ from: senderAddr });
    const nonceFr = toFrUtil(Fr, nonceResult);
    const blindingHex = toHexString(blindingResult);

    const { result: previewResult }: any = await nftContract.methods.preview_game_data(nonceFr).simulate({ from: senderAddr });
    const randomnessHex = Array.from({ length: 6 }, (_, i) => toHexString(previewResult[i + 1]));

    setOnChainGameId(chainGameId);
    setGameRandomness(randomnessHex);
    setBlindingFactor(blindingHex);
    cardIdsRef.current = ids;
    console.log('[useGame] Join preview ready (no tx sent yet)');

    return { randomness: randomnessHex, blindingFactor: blindingHex };
  }, [aztec.wallet, aztec.accountAddress]);

  const sendJoinGameTx = useCallback(async (chainGameId: string, ids: number[]): Promise<string> => {
    const w = requireWallet();
    const addr = requireAccountAddress();

    console.log('[useGame] Sending join_game tx...');
    const { gameContract, fee, Fr, AztecAddress } = await ensureContracts(w);
    const senderAddr = AztecAddress.fromString(addr);
    const chainGameIdFr = toFrUtil(Fr, chainGameId);

    const { receipt } = await gameContract.methods
      .join_game(chainGameIdFr, ids.map((id: number) => new Fr(BigInt(id))))
      .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_TX_TIMEOUT } });
    const txHash = receipt?.txHash?.toString();
    if (!txHash) throw new Error('join_game tx returned no txHash');
    console.log('[useGame] join_game tx mined, txHash:', txHash);

    // Remove committed cards from localStorage after confirmed tx
    if (addr) removeCards(addr, ids);

    return txHash;
  }, [aztec.wallet, aztec.accountAddress]);

  const generateHandProofFromState = useCallback(async (
    ids: number[],
    opponentGameRandomness: string[],
  ): Promise<void> => {
    if (!blindingFactor) throw new Error('Cannot generate hand proof: no blinding factor');
    cardIdsRef.current = ids;
    setHandProofStatus('generating');

    try {
      const { computeCardCommitPoseidon2, computePlayerStateHash } = await import('../aztec/proofWorker');
      const cardCommitHash = await computeCardCommitPoseidon2(ids, blindingFactor);
      const opponentPlayerStateHash = await computePlayerStateHash(opponentGameRandomness);
      const proof = await proofs.generateHandProof(
        ids, blindingFactor, cardCommitHash,
        opponentGameRandomness, opponentPlayerStateHash,
      );
      setMyHandProof(proof);
      setHandProofStatus('ready');
    } catch (err) {
      setHandProofStatus('error');
      throw err;
    }
  }, [blindingFactor, proofs.generateHandProof]);

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
    ): Promise<MoveProofData> => {
      if (!myHandProof || !opponentHandProof) throw new Error('Cannot generate move proof: hand proofs not ready');
      if (!myCardCommit || !opponentCardCommit) throw new Error('Cannot generate move proof: card commits missing');
      if (!blindingFactor) throw new Error('Cannot generate move proof: no blinding factor');

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
        setMoveProofStatus('error');
        throw err;
      }
    },
    [myHandProof, opponentHandProof, myCardCommit, opponentCardCommit, blindingFactor, proofs.generateMoveProof, addMoveProof],
  );

  // --- Effects ---

  // Pre-warm contract cache
  useEffect(() => {
    if (aztec.wallet) {
      console.log(`[PXE-TRACE] ${Date.now()} warmupContracts(wallet) [fire-and-forget]`);
      warmupContracts(aztec.wallet);
    }
  }, [aztec.wallet]);

  // Populate board state history from WS game state
  useEffect(() => {
    if (!ws.gameState) return;
    let occupied = 0;
    for (const row of ws.gameState.board) {
      for (const cell of row) {
        if (cell.card !== null) occupied++;
      }
    }
    if (!gameStateHistoryRef.current.has(occupied)) {
      gameStateHistoryRef.current.set(occupied, {
        board: structuredClone(ws.gameState.board),
        scores: [ws.gameState.player1Score, ws.gameState.player2Score],
        currentTurn: ws.gameState.currentTurn,
      });
    }
  }, [ws.gameState]);

  // Auto-submit hand proof when generated
  useEffect(() => {
    if (!myHandProof || !ws.gameId || handProofSubmittedRef.current) return;
    handProofSubmittedRef.current = true;
    ws.submitHandProof(ws.gameId, myHandProof);
  }, [myHandProof, ws.gameId, ws.submitHandProof]);

  // Receive opponent hand proof from WebSocket
  useEffect(() => {
    if (!ws.opponentHandProof) return;
    setOpponentHandProof(ws.opponentHandProof);
  }, [ws.opponentHandProof]);

  // Receive opponent move proof from WebSocket
  useEffect(() => {
    if (!ws.lastMoveProof) return;
    addMoveProof(ws.lastMoveProof.moveProof);
  }, [ws.lastMoveProof, addMoveProof]);

  // Auto-generate hand proof when blinding factor + opponent randomness are available
  useEffect(() => {
    if (handProofGeneratedRef.current) return;

    // Diagnostic logging — shows which preconditions are blocking proof generation
    if (!ws.gameId || !ws.gameState) {
      console.log('[useGame] Hand proof effect: waiting for gameId/gameState');
      return;
    }
    if (ws.gameState.status !== 'playing' && ws.gameState.status !== 'finished') {
      console.log('[useGame] Hand proof effect: game status is', ws.gameState.status, '(need playing/finished)');
      return;
    }
    if (cardIds.length !== 5) {
      console.log('[useGame] Hand proof effect: cardIds.length =', cardIds.length, '(need 5)');
      return;
    }
    if (!blindingFactor) {
      console.log('[useGame] Hand proof effect: blindingFactor not set yet');
      return;
    }
    if (!ws.opponentGameRandomness || ws.opponentGameRandomness.length !== 6) {
      console.log('[useGame] Hand proof effect: opponentGameRandomness not received yet (have:', ws.opponentGameRandomness?.length ?? 0, 'need 6)');
      return;
    }

    console.log('[useGame] Hand proof effect: all preconditions met — generating proof');
    handProofGeneratedRef.current = true;
    generateHandProofFromState(cardIds, ws.opponentGameRandomness).catch(err => {
      console.error('[useGame] Hand proof generation failed:', err);
      handProofGeneratedRef.current = false;
    });
  }, [ws.gameId, ws.gameState, cardIds, blindingFactor, ws.opponentGameRandomness, generateHandProofFromState]);

  // Resolve hand proof wait promise when both proofs are available
  useEffect(() => {
    if (myHandProof && opponentHandProof && handProofsCompleteRef.current) {
      console.log('[useGame] Both hand proofs ready — resolving settlement wait');
      handProofsCompleteRef.current();
      handProofsCompleteRef.current = null;
    }
  }, [myHandProof, opponentHandProof]);

  // Process queued moves once both hand proofs are available (bug #1 fix: use history snapshots)
  useEffect(() => {
    if (!myHandProof || !opponentHandProof) return;
    if (pendingMovesRef.current.length === 0 || !ws.gameId || !ws.playerNumber) return;

    const pending = pendingMovesRef.current.splice(0);
    console.log(`[useGame] Processing ${pending.length} queued move(s)`);

    (async () => {
      for (const move of pending) {
        try {
          // Look up the correct board state at dequeue time (bug #1 fix)
          const snapshot = gameStateHistoryRef.current.get(move.moveNumber);
          if (!snapshot) {
            console.warn(`[useGame] No board snapshot for move ${move.moveNumber}, skipping`);
            continue;
          }

          // Apply the move using the pure game logic function
          const { placeCard: applyMove } = await import('@axolotl-arena/game-logic');
          const myPlayer = ws.playerNumber === 1 ? 'player1' : 'player2';

          // Use hand snapshots captured at queue time (not the current
          // ws.gameState hands, which may have cards set to null since then).
          const syntheticState: GameState = {
            board: snapshot.board,
            player1Hand: move.p1Hand,
            player2Hand: move.p2Hand,
            currentTurn: snapshot.currentTurn,
            player1Score: snapshot.scores[0],
            player2Score: snapshot.scores[1],
            status: 'playing',
            winner: null,
          };

          const result = applyMove(syntheticState, myPlayer, move.handIndex, move.row, move.col);
          const boardAfter = result.newState.board;
          const scoresBefore: [number, number] = snapshot.scores;
          const scoresAfter: [number, number] = [result.newState.player1Score, result.newState.player2Score];
          const gameEnded = result.newState.status === 'finished';
          const winnerId = mapWinnerId(result.newState.winner);

          const moveProof = await generateMoveProofForPlacement(
            move.card.id, move.row, move.col, ws.playerNumber!,
            snapshot.board, boardAfter,
            scoresBefore, scoresAfter,
            gameEnded, winnerId,
          );
          if (moveProof && ws.gameId) {
            ws.submitMoveProof(ws.gameId, move.handIndex, move.row, move.col, moveProof, move.moveNumber);
          }
        } catch (err) {
          console.warn('[useGame] Deferred move proof failed:', err);
        }
      }
    })();
  }, [myHandProof, opponentHandProof]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve move proofs promise when all 9 arrive (bug #4 fix)
  useEffect(() => {
    if (collectedMoveProofs.length >= TOTAL_MOVES && moveProofsCompleteRef.current) {
      moveProofsCompleteRef.current();
      moveProofsCompleteRef.current = null;
    }
  }, [collectedMoveProofs.length]);

  // Persist game state to localStorage
  useEffect(() => {
    if (!ws.gameId || !ws.playerNumber || cardIds.length === 0) return;
    if (screen !== 'game' && screen !== 'finding-opponent') return;

    const persisted: PersistedGameState = {
      gameId: ws.gameId,
      playerNumber: ws.playerNumber,
      selectedCardIds: cardIds,
      savedAt: Date.now(),
    };
    if (onChainGameId) persisted.onChainGameId = onChainGameId;
    if (myHandProof) persisted.myHandProof = myHandProof;
    if (opponentHandProof) persisted.opponentHandProof = opponentHandProof;
    if (collectedMoveProofs.length > 0) persisted.collectedMoveProofs = collectedMoveProofs;
    if (ws.opponentAztecAddress) persisted.opponentAztecAddress = ws.opponentAztecAddress;
    if (ws.opponentOnChainGameId) persisted.opponentOnChainGameId = ws.opponentOnChainGameId;
    if (gameRandomness) persisted.gameRandomness = gameRandomness;
    if (blindingFactor) persisted.blindingFactor = blindingFactor;
    if (ws.opponentGameRandomness) persisted.opponentGameRandomness = ws.opponentGameRandomness;

    storage.saveGame(persisted);
    setHasGameInProgress(true);
  }, [
    ws.gameId, ws.playerNumber, cardIds, screen,
    onChainGameId, gameRandomness, blindingFactor,
    myHandProof, opponentHandProof, collectedMoveProofs,
    ws.opponentAztecAddress, ws.opponentOnChainGameId, ws.opponentGameRandomness,
    storage,
  ]);

  // Clear saved game on GAME_OVER
  useEffect(() => {
    if (ws.gameOver) {
      storage.clearGame();
      setHasGameInProgress(false);
    }
  }, [ws.gameOver, storage]);

  // Matchmaking: transition to game when match found
  useEffect(() => {
    if (ws.matchmakingStatus === 'matched' && screen === 'finding-opponent') {
      setScreen('game');
    }
  }, [ws.matchmakingStatus, screen]);

  // Matchmaking ping
  useEffect(() => {
    if (screen !== 'finding-opponent') return;
    const interval = setInterval(() => ws.ping(), 10000);
    return () => clearInterval(interval);
  }, [screen, ws.ping]);

  // Share preview data with opponent as soon as state is set (before tx mines).
  // This is a React effect, so it runs completely outside PXE's execution context —
  // no interference with IDB transactions. Both P1 and P2 set gameRandomness via
  // setState inside their respective pipeline functions; React flushes the update
  // at the next render boundary (including during await yields), so this effect
  // fires before the slow tx mining completes.
  useEffect(() => {
    if (previewSharedRef.current) return;
    if (!ws.gameId || !gameRandomness || !aztec.accountAddress) return;
    // P1 uses its own onChainGameId; P2 uses the opponent's
    const gameIdToShare = onChainGameId ?? ws.opponentOnChainGameId;
    if (!gameIdToShare) return;

    previewSharedRef.current = true;
    ws.shareAztecInfo(ws.gameId, aztec.accountAddress, gameIdToShare, gameRandomness);
    console.log('[useGame] Preview data shared with opponent (early, via effect)');
  }, [ws.gameId, gameRandomness, onChainGameId, ws.opponentOnChainGameId, aztec.accountAddress, ws.shareAztecInfo]);

  // Merge opponent info into settlementInfoRef synchronously when it arrives
  // via WebSocket. Uses addMessageListener (not useEffect) so the ref is
  // updated in the same event loop tick as the message — async functions in
  // txManager can read it immediately without yielding to React's render cycle.
  useEffect(() => {
    return ws.addMessageListener((msg) => {
      if (msg.type === 'OPPONENT_AZTEC_INFO' && settlementInfoRef.current) {
        if (msg.aztecAddress) {
          settlementInfoRef.current.opponentAddress = msg.aztecAddress;
        }
        if (msg.gameRandomness && msg.gameRandomness.length === 6) {
          settlementInfoRef.current.opponentRandomness = [...msg.gameRandomness];
        }
      }
    });
  }, [ws.addMessageListener]);

  // Consolidated on-chain pipeline (replaces 3 separate effects + dead fallback)
  useEffect(() => {
    if (screen === 'main-menu') return; // Never start pipeline during navigation
    if (!ws.gameId || !ws.gameState) return;
    if (ws.gameState.status !== 'playing' && ws.gameState.status !== 'finished') return;
    if (!isContractAvailable) return;

    const phase = onChainPhaseRef.current;

    // P1: create game — runs through txManager
    if (ws.playerNumber === 1 && phase === 'idle') {
      onChainPhaseRef.current = 'creating';
      const capturedGameId = ws.gameId!;
      const capturedAddr = aztec.accountAddress!;
      const capturedCardIds = [...cardIds];
      const capturedShareInfo = ws.shareAztecInfo;
      const capturedNotifyTx = ws.notifyTxConfirmed;

      if (lastSettleTxHashRef.current) {
        lastSettleTxHashRef.current = null;
      }

      txManager.runTx({
        type: 'create_game',
        label: 'Creating game...',
        gameId: capturedGameId,
        execute: async (setPhase) => {
          setPhase('simulating');
          const result = await createGameOnChain(capturedCardIds);
          return result;
        },
        postEffects: async (result) => {
          capturedShareInfo(capturedGameId, capturedAddr, result.gameId, result.randomness);
          aztec.updateOwnedCards(prev => removeOneOfEach(prev, capturedCardIds));
          capturedNotifyTx(capturedGameId, 'create_game', result.txHash);
          console.log('[useGame] P1: create_game mined, notified backend');
          // Seed settlementInfoRef with our own values (opponent values added
          // when OPPONENT_AZTEC_INFO arrives). This ref is NOT cleared by navigation.
          settlementInfoRef.current = {
            onChainGameId: result.gameId,
            gameRandomness: result.randomness,
            opponentAddress: '',
            opponentRandomness: [],
          };
          onChainPhaseRef.current = 'done';
          if (pipelineDoneResolveRef.current) { pipelineDoneResolveRef.current(); pipelineDoneResolveRef.current = null; }
        },
      }).catch(err => {
        console.error('[useGame] On-chain game creation failed:', err);
        setOnChainError(err instanceof Error ? err.message : 'Create game failed');
        onChainPhaseRef.current = 'idle';
      });
      return;
    }

    // P2 phase 1: prepare preview — runs through txManager PXE queue
    if (ws.playerNumber === 2 && phase === 'idle' && ws.opponentOnChainGameId) {
      onChainPhaseRef.current = 'preparing';
      const capturedGameId = ws.gameId!;
      const capturedAddr = aztec.accountAddress!;
      const capturedChainGameId = ws.opponentOnChainGameId!;
      const capturedCardIds = [...cardIds];
      const capturedShareInfo = ws.shareAztecInfo;

      if (lastSettleTxHashRef.current) {
        lastSettleTxHashRef.current = null;
      }

      txManager.runTx({
        type: 'join_game',
        label: 'Preparing to join...',
        gameId: capturedGameId,
        execute: async (setPhase) => {
          setPhase('simulating');
          const result = await prepareJoinGame(capturedChainGameId, capturedCardIds);
          return result;
        },
        postEffects: async (result) => {
          capturedShareInfo(capturedGameId, capturedAddr, capturedChainGameId, result.randomness);
          aztec.updateOwnedCards(prev => removeOneOfEach(prev, capturedCardIds));
          console.log('[useGame] P2: preview data shared, waiting for P1 tx confirmation...');
          // Seed settlementInfoRef for P2 (opponent values added when they arrive)
          settlementInfoRef.current = {
            onChainGameId: capturedChainGameId,
            gameRandomness: result.randomness,
            opponentAddress: '',
            opponentRandomness: [],
          };
          onChainPhaseRef.current = 'awaiting_p1_tx';
        },
      }).catch(err => {
        console.error('[useGame] P2 prepare failed:', err);
        setOnChainError(err instanceof Error ? err.message : 'Prepare join failed');
        onChainPhaseRef.current = 'idle';
      });
      return;
    }

    // P2 phase 2: join after P1 confirmed — runs through txManager
    if (ws.playerNumber === 2 && phase === 'awaiting_p1_tx' && ws.opponentTxConfirmed && onChainGameId) {
      onChainPhaseRef.current = 'joining';
      const capturedGameId = ws.gameId!;
      const capturedChainGameId = ws.opponentOnChainGameId!;
      const capturedCardIds = [...cardIds];
      const capturedNotifyTx = ws.notifyTxConfirmed;

      txManager.runTx({
        type: 'join_game',
        label: 'Joining game...',
        gameId: capturedGameId,
        execute: async (setPhase) => {
          setPhase('sending');
          const txHash = await sendJoinGameTx(capturedChainGameId, capturedCardIds);
          return txHash;
        },
        postEffects: async (txHash) => {
          capturedNotifyTx(capturedGameId, 'join_game', txHash);
          console.log('[useGame] P2: join_game mined, notified backend');
          onChainPhaseRef.current = 'done';
          if (pipelineDoneResolveRef.current) { pipelineDoneResolveRef.current(); pipelineDoneResolveRef.current = null; }
        },
      }).catch(err => {
        console.error('[useGame] P2 join_game tx failed:', err);
        setOnChainError(err instanceof Error ? err.message : 'Join game failed');
        onChainPhaseRef.current = 'awaiting_p1_tx';
      });
    }
  }, [screen, ws.playerNumber, ws.gameId, ws.gameState, ws.opponentOnChainGameId,
      ws.opponentTxConfirmed, isContractAvailable, onChainGameId, cardIds,
      createGameOnChain, prepareJoinGame, sendJoinGameTx,
      aztec.accountAddress, aztec.wallet, aztec.nodeClient, aztec.updateOwnedCards,
      ws.shareAztecInfo, ws.notifyTxConfirmed]);

  // Reset state on returning to menu
  useEffect(() => {
    if (screen === 'main-menu') {
      handProofSubmittedRef.current = false;
      pendingMovesRef.current = [];
      noteImportProcessedRef.current = null;
      handProofGeneratedRef.current = false;
      // Note: onChainPhaseRef is NOT reset here — it's managed by txManager
      // postEffects (settlement sets it to 'idle' when the game lifecycle ends).
      // Resetting it here causes a race: the pipeline effect re-fires with
      // phase='idle' while ws.gameId is still set (deferred leave), triggering
      // a spurious create_game.
      gameStateHistoryRef.current = new Map();
      moveProofsCompleteRef.current = null;
      handProofsCompleteRef.current = null;
      previewSharedRef.current = false;
      pipelineDoneResolveRef.current = null;
      // Reset session state
      setOnChainGameId(null);
      setGameRandomness(null);
      setBlindingFactor(null);
      setSettleTxStatus('idle');
      setSettleTxHash(null);
      setSettleError(null);
      setOnChainError(null);
      setMyHandProof(null);
      setOpponentHandProof(null);
      setCollectedMoveProofs([]);
      setHandProofStatus('idle');
      setMoveProofStatus('idle');
      setOpponentSettled(false);
      setTakenCardId(null);
      opponentSettleTxIdRef.current = null;
      opponentSettleResolveRef.current = null;
      cardIdsRef.current = [];
      proofs.reset();
    }
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Import notes helper
  const importNotes = useCallback(async (
    txHashStr: string,
    notes: { tokenId: number; randomness: string }[],
    label: string,
  ) => {
    if (!aztec.wallet || !aztec.accountAddress || !aztec.nodeClient) return;
    try {
      const importedIds = await importNotesFromTx(
        aztec.wallet, aztec.nodeClient, aztec.accountAddress,
        txHashStr, notes, label,
      );
      if (importedIds.length > 0) {
        aztec.updateOwnedCards(prev => [...prev, ...importedIds]);
      }
    } catch (err) {
      console.error(`[useGame] ${label}: Failed to import notes:`, err);
    }
  }, [aztec.wallet, aztec.accountAddress, aztec.nodeClient, aztec.updateOwnedCards]);

  // Import notes received from opponent via WebSocket
  useEffect(() => {
    if (!ws.incomingNoteData || !aztec.wallet || !aztec.accountAddress) return;
    const { txHash, notes } = ws.incomingNoteData;
    if (noteImportProcessedRef.current === txHash) return;
    noteImportProcessedRef.current = txHash;
    lastSettleTxHashRef.current = txHash;

    // Determine which card was taken by comparing returned cards vs original hand
    const returnedIds = new Set(notes.map(n => n.tokenId));
    const taken = cardIds.find(id => !returnedIds.has(id));
    setTakenCardId(taken ?? null);
    setOpponentSettled(true);

    importNotes(txHash, notes, 'Loser import');

    // Settlement complete on loser side — release the game lifecycle
    onChainPhaseRef.current = 'idle';
  }, [ws.incomingNoteData, aztec.wallet, aztec.accountAddress, aztec.nodeClient, importNotes, cardIds]);

  // Track opponent's settlement on the loser's side via txManager.
  // When the winner starts settling, the loser receives OPPONENT_SETTLING via WS.
  // This creates a txManager entry so onChainPhaseRef stays non-idle and the
  // "Back to Lobby" guard works correctly.
  const opponentSettleTxIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ws.opponentSettling) return;
    if (opponentSettleTxIdRef.current) return; // Already tracking

    setTakenCardId(ws.opponentSettling.selectedCardId);

    // Create a txManager entry for the opponent's settlement
    const txId = txManager.runTx({
      type: 'settle_game',
      label: 'Opponent is settling...',
      gameId: ws.gameId ?? undefined,
      execute: async () => {
        // The loser doesn't execute anything — just wait for NOTE_DATA
        await new Promise<void>((resolve) => {
          // Store the resolve so the incomingNoteData effect can call it
          opponentSettleResolveRef.current = resolve;
        });
        return 'opponent-settled';
      },
      postEffects: async () => {
        setOpponentSettled(true);
        onChainPhaseRef.current = 'idle';
        // Wait for PXE to sync the block containing the settlement tx
        // before querying token balance (token notes use ONCHAIN_CONSTRAINED
        // delivery which requires PXE block sync to discover).
        await new Promise(r => setTimeout(r, 5000));
        aztec.refreshTokenBalance().catch(() => {});
      },
    });

    txId.catch(() => {
      // If something goes wrong, still release the game lifecycle
      onChainPhaseRef.current = 'idle';
    });

    opponentSettleTxIdRef.current = 'tracking';
  }, [ws.opponentSettling, ws.gameId]);

  // Resolve the opponent's settlement wait when NOTE_DATA arrives
  const opponentSettleResolveRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!ws.incomingNoteData) return;
    if (opponentSettleResolveRef.current) {
      opponentSettleResolveRef.current();
      opponentSettleResolveRef.current = null;
    }
  }, [ws.incomingNoteData]);

  // --- User actions ---

  const handlePlay = useCallback(() => {
    const saved = storage.loadGame();
    if (saved) {
      setCardIds(saved.selectedCardIds);
      if (saved.opponentHandProof) setOpponentHandProof(saved.opponentHandProof);
      if (saved.collectedMoveProofs) {
        for (const mp of saved.collectedMoveProofs) addMoveProof(mp);
      }
      if (saved.onChainGameId && saved.gameRandomness) {
        setOnChainGameId(saved.onChainGameId);
        setGameRandomness(saved.gameRandomness);
        if (saved.blindingFactor) setBlindingFactor(saved.blindingFactor);
      }
      ws.queueMatchmaking(saved.selectedCardIds);
      setScreen('finding-opponent');
      return;
    }
    setScreen('card-selector');
  }, [storage, ws, addMoveProof]);

  const handleCardPacks = useCallback(() => {
    setScreen('card-packs');
  }, []);

  const handleHandSelected = useCallback((ids: number[]) => {
    console.log('[useGame] handleHandSelected: selectedIds=', ids, 'ownedCards=', aztec.ownedCardIds);
    setCardIds(ids);
    ws.queueMatchmaking(ids);
    setScreen('finding-opponent');
  }, [ws, aztec.ownedCardIds]);

  const handleCancelMatchmaking = useCallback(() => {
    ws.cancelMatchmaking();
    setCardIds([]);
    storage.clearGame();
    setHasGameInProgress(false);
    setScreen('main-menu');
  }, [ws, storage]);

  const handlePackOpened = useCallback((location: string, result: { cardIds: number[]; txHash: string | null }) => {
    setPackResult({ location, cardIds: result.cardIds });
    setScreen('pack-opening');
  }, []);

  const handlePackOpenComplete = useCallback(() => {
    setPackResult(prev => {
      if (prev) {
        aztec.updateOwnedCards(cards => [...cards, ...prev.cardIds]);
      }
      return null;
    });
    // Refresh token balance after purchase (tokens were burned)
    aztec.refreshTokenBalance().catch(() => {});
    setScreen('card-packs');
  }, [aztec]);

  const handlePlaceCard = useCallback(async (handIndex: number, row: number, col: number) => {
    if (!ws.gameState || !ws.playerNumber || !ws.gameId) return;

    const myHand = ws.playerNumber === 1 ? ws.gameState.player1Hand : ws.gameState.player2Hand;
    const card = myHand[handIndex];

    // Count occupied cells for move number
    let moveNumber = 0;
    for (const r of ws.gameState.board) {
      for (const cell of r) {
        if (cell.card !== null) moveNumber++;
      }
    }

    // Get the board snapshot at the current move number (from history)
    const boardBefore = gameStateHistoryRef.current.get(moveNumber)?.board ?? ws.gameState.board;

    ws.placeCard(handIndex, row, col);

    if (aztec.isAvailable && card) {
      try {
        const { placeCard: applyMove } = await import('@axolotl-arena/game-logic');
        const myPlayer = ws.playerNumber === 1 ? 'player1' : 'player2';
        const result = applyMove(ws.gameState, myPlayer, handIndex, row, col);
        const boardAfter = result.newState.board;
        const scoresBefore: [number, number] = [ws.gameState.player1Score, ws.gameState.player2Score];
        const scoresAfter: [number, number] = [result.newState.player1Score, result.newState.player2Score];
        const gameEnded = result.newState.status === 'finished';
        const winnerId = mapWinnerId(result.newState.winner);

        if (myHandProof && opponentHandProof) {
          const moveProof = await generateMoveProofForPlacement(
            card.id, row, col, ws.playerNumber,
            boardBefore, boardAfter,
            scoresBefore, scoresAfter,
            gameEnded, winnerId,
          );
          ws.submitMoveProof(ws.gameId, handIndex, row, col, moveProof, moveNumber);
        } else {
          pendingMovesRef.current.push({
            card,
            p1Hand: [...ws.gameState.player1Hand],
            p2Hand: [...ws.gameState.player2Hand],
            handIndex, row, col, moveNumber,
          });
        }
      } catch (err) {
        console.warn('[useGame] Move proof generation failed:', err);
      }
    }
  }, [ws, aztec.isAvailable, myHandProof, opponentHandProof, generateMoveProofForPlacement]);

  const handleSettle = useCallback(async (selectedCardId: number) => {
    if (!ws.gameId) throw new Error('No game ID for settlement');
    if (!ws.playerNumber) throw new Error('No player number for settlement');

    // Capture values available NOW (stable across navigation).
    // Pipeline-dependent values (opponent address, randomness, on-chain game ID)
    // are read from settlementInfoRef inside execute — that ref persists across navigation.
    const capturedGameId = ws.gameId;
    const capturedPlayerNumber = ws.playerNumber;
    const capturedOpponentCardIds = [...ws.opponentCardIds];
    const capturedCardIds = [...cardIds];
    const w = requireWallet();
    const addr = requireAccountAddress();
    const capturedImportNotes = importNotes;
    const capturedRelayNoteData = (txHash: string, notes: PlaintextNoteData[]) =>
      ws.relayNoteData(capturedGameId, txHash, notes);
    const capturedNotifySettle = (gId: string, cardId: number) =>
      ws.notifySettleStarted(gId, cardId);

    setSettleTxStatus('preparing');
    setSettleError(null);
    setSettleTxHash(null);

    txManager.runTx({
      type: 'settle_game',
      label: 'Settling game...',
      gameId: capturedGameId,

      execute: async (setPhase) => {
        // ── Wait for the on-chain pipeline (create_game/join_game) ──────
        // The priority queue ensures join_game runs before settle_game when
        // both are pending in the queue, preventing deadlocks.
        if (onChainPhaseRef.current !== 'done' && onChainPhaseRef.current !== 'idle') {
          console.log('[useGame] On-chain pipeline still running (phase:', onChainPhaseRef.current, ') — waiting...');
          setPhase('queued');
          await new Promise<void>((resolve, reject) => {
            if (onChainPhaseRef.current === 'done') { resolve(); return; }
            pipelineDoneResolveRef.current = resolve;
            setTimeout(() => {
              pipelineDoneResolveRef.current = null;
              reject(new Error(`Timed out waiting for on-chain pipeline (phase: ${onChainPhaseRef.current})`));
            }, AZTEC_SETTLE_TX_TIMEOUT);
          });
          console.log('[useGame] On-chain pipeline complete — proceeding with settlement');
        }

        // ── Wait for hand proofs ───────────────────────────────────────
        if (!myHandProofRef.current || !opponentHandProofRef.current) {
          console.log('[useGame] Hand proofs not ready yet — waiting (my:',
            !!myHandProofRef.current, 'opponent:', !!opponentHandProofRef.current, ')');
          setPhase('queued');
          await new Promise<void>((resolve, reject) => {
            if (myHandProofRef.current && opponentHandProofRef.current) { resolve(); return; }
            handProofsCompleteRef.current = resolve;
            setTimeout(() => {
              handProofsCompleteRef.current = null;
              reject(new Error(
                `Timed out waiting for hand proofs (${HAND_PROOF_WAIT_TIMEOUT / 1000}s). ` +
                `my: ${!!myHandProofRef.current}, opponent: ${!!opponentHandProofRef.current}`,
              ));
            }, HAND_PROOF_WAIT_TIMEOUT);
          });
          console.log('[useGame] Hand proofs now ready — proceeding with settlement');
        }

        const myProof = myHandProofRef.current;
        const oppProof = opponentHandProofRef.current;
        if (!myProof || !oppProof) throw new Error('Hand proofs not ready after wait');

        // ── Read pipeline-dependent values from persistent ref ──────────
        const sInfo = settlementInfoRef.current;
        if (!sInfo) throw new Error('Settlement info not available (pipeline incomplete)');

        // ── Verify game is active on-chain (status 2 = both joined) ────
        const { fee, Fr, AztecAddress } = await ensureContracts(w);
        const liveOnChainGameId = sInfo.onChainGameId;
        {
          const gameIdFr = toFrUtil(Fr, liveOnChainGameId);
          const senderForCheck = AztecAddress.fromString(addr);
          const { gameContract } = await ensureContracts(w);
          const { result: gameStatus } = await gameContract.methods
            .get_game_status(gameIdFr)
            .simulate({ from: senderForCheck });
          const status = Number(gameStatus);
          if (status !== 2) {
            console.log(`[useGame] Game status is ${status}, waiting for opponent to join on-chain...`);
            for (let poll = 0; poll < 60; poll++) {
              await new Promise(r => setTimeout(r, 2000));
              const { result: s } = await gameContract.methods
                .get_game_status(gameIdFr)
                .simulate({ from: senderForCheck });
              if (Number(s) === 2) {
                console.log('[useGame] Opponent join_game confirmed on-chain');
                break;
              }
              if (poll === 59) throw new Error('Timed out waiting for opponent to join game on-chain');
            }
          }
        }

        // ── Wait for all move proofs ───────────────────────────────────
        if (moveProofsRef.current.length < TOTAL_MOVES) {
          await new Promise<void>((resolve, reject) => {
            if (moveProofsRef.current.length >= TOTAL_MOVES) { resolve(); return; }
            moveProofsCompleteRef.current = resolve;
            setTimeout(() => {
              moveProofsCompleteRef.current = null;
              reject(new Error(`Timed out waiting for move proofs: have ${moveProofsRef.current.length}/${TOTAL_MOVES}`));
            }, MOVE_PROOF_WAIT_TIMEOUT);
          });
        }

        // ── All waits complete — read from persistent ref + closures ────
        const capturedOpponentAddress = sInfo.opponentAddress;
        const capturedOpponentRandomness = sInfo.opponentRandomness;
        const capturedGameRandomness = sInfo.gameRandomness;

        if (capturedOpponentCardIds.length === 0) throw new Error('No opponent card IDs');

        // Notify opponent NOW — settlement will actually proceed.
        // Uses captured function ref that binds to the game's WebSocket send().
        capturedNotifySettle(capturedGameId, selectedCardId);

        const capturedMoveProofs = [...moveProofsRef.current];

        setPhase('proving');

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

        const byStart = new Map<string, typeof capturedMoveProofs[0]>();
        for (const p of capturedMoveProofs) {
          byStart.set(p.startStateHash, p);
        }

        const sorted: typeof capturedMoveProofs = [];
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

        setPhase('sending');

        const contract = contractCache.gameContract;
        if (!contract) throw new Error('Game contract not initialized');

        const senderAddr = AztecAddress.fromString(addr);
        const opponent = AztecAddress.fromString(capturedOpponentAddress);

        const padTo5 = (ids: number[]): InstanceType<typeof Fr>[] => {
          const padded = [...ids];
          while (padded.length < CARDS_PER_HAND) padded.push(0);
          return padded.slice(0, CARDS_PER_HAND).map(id => new Fr(BigInt(id)));
        };

        const callerRandomness = capturedGameRandomness.map(v => toFrUtil(Fr, v));
        const opponentRandomness = capturedOpponentRandomness.map(v => toFrUtil(Fr, v));

        const handProof1 = capturedPlayerNumber === 1 ? myProof : oppProof;
        const handProof2 = capturedPlayerNumber === 2 ? myProof : oppProof;
        const hp1ProofData = base64ToFrArray(handProof1.proof);
        const hp1InputData = handProof1.publicInputs.map(hexToFr);
        const hp2ProofData = base64ToFrArray(handProof2.proof);
        const hp2InputData = handProof2.publicInputs.map(hexToFr);

        const { receipt } = await contract.methods
          .process_game(
            toFrUtil(Fr, liveOnChainGameId),
            handVkFields,
            moveVkFields,
            hp1ProofData, hp1InputData,
            hp2ProofData, hp2InputData,
            mp[0], mi[0], mp[1], mi[1], mp[2], mi[2],
            mp[3], mi[3], mp[4], mi[4], mp[5], mi[5],
            mp[6], mi[6], mp[7], mi[7], mp[8], mi[8],
            opponent,
            new Fr(BigInt(selectedCardId)),
            padTo5(capturedCardIds),
            padTo5(capturedOpponentCardIds),
            callerRandomness,
            opponentRandomness,
          )
          .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_SETTLE_TX_TIMEOUT } });

        const hash = receipt?.txHash?.toString();
        if (!hash) throw new Error('Settlement tx returned no txHash');
        return { hash, callerRandomness, opponentRandomness };
      },

      postEffects: async (result) => {
        const { hash, callerRandomness, opponentRandomness } = result;
        setSettleTxHash(hash);
        lastSettleTxHashRef.current = hash;
        setSettleTxStatus('confirmed');
        console.log('[useGame] Game settled on-chain, txHash:', hash);

        // Build note data
        const isWinnerLoser = selectedCardId !== 0;

        const callerNotes: PlaintextNoteData[] = [];
        for (let i = 0; i < capturedCardIds.length && i < 5; i++) {
          callerNotes.push({ tokenId: capturedCardIds[i], randomness: toHexString(callerRandomness[i]) });
        }
        if (isWinnerLoser) {
          callerNotes.push({ tokenId: selectedCardId, randomness: toHexString(callerRandomness[5]) });
        }

        const opponentNotes: PlaintextNoteData[] = [];
        if (isWinnerLoser) {
          let removed = false;
          for (let i = 0; i < capturedOpponentCardIds.length && i < 5; i++) {
            if (capturedOpponentCardIds[i] === selectedCardId && !removed) {
              removed = true;
            } else {
              opponentNotes.push({ tokenId: capturedOpponentCardIds[i], randomness: toHexString(opponentRandomness[i]) });
            }
          }
        } else {
          for (let i = 0; i < capturedOpponentCardIds.length && i < 5; i++) {
            opponentNotes.push({ tokenId: capturedOpponentCardIds[i], randomness: toHexString(opponentRandomness[i]) });
          }
        }

        capturedRelayNoteData(hash, opponentNotes);
        await capturedImportNotes(hash, callerNotes, 'Winner import');

        // Refresh token balance (settlement mints 20 Arena Tokens to winner).
        // Small delay to ensure PXE has synced the block with the token notes.
        await new Promise(r => setTimeout(r, 3000));
        aztec.refreshTokenBalance().catch(() => {});

        // Game's on-chain lifecycle is complete — mark idle so the pipeline
        // effect won't re-trigger a spurious create_game on navigation.
        onChainPhaseRef.current = 'idle';
        settlementInfoRef.current = null;
      },
    }).catch((err) => {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      console.error('[useGame] settleGame error:', err);
      setSettleError(message);
      setSettleTxStatus('error');
      onChainPhaseRef.current = 'idle';
      settlementInfoRef.current = null;
    });
  }, [ws.gameId, ws.playerNumber, ws.opponentCardIds, cardIds,
      aztec.wallet, aztec.accountAddress, importNotes, ws.relayNoteData, ws.notifySettleStarted]);

  // canGoBack: winner can leave after picking a card (settlement runs in background via txManager).
  // Loser must wait until their settlement flow completes (opponentSettled).
  // Before the game ends or before the winner picks a card, navigation is blocked
  // while on-chain lifecycle is active.
  const winnerSettleInitiated = settleTxStatus !== 'idle';
  const canGoBack = screen === 'main-menu'
    || winnerSettleInitiated
    || (onChainPhaseRef.current === 'idle' && !txManager.hasInFlightForGame(ws.gameId ?? ''));

  const handleBackToMenu = useCallback(() => {
    // Winner can leave once they've picked a card (settlement continues in txManager)
    const settleStarted = settleTxStatus !== 'idle';
    // Guard: block navigation while game is in-flight (unless winner has initiated settlement)
    if (!settleStarted && ws.gameId && (onChainPhaseRef.current !== 'idle' || txManager.hasInFlightForGame(ws.gameId))) {
      console.log('[useGame] Back to menu blocked: game in-flight');
      return;
    }

    ws.leaveGame();
    setCardIds([]);
    storage.clearGame();
    setHasGameInProgress(false);
    setIsClaimingAbandoned(false);
    setAbandonedDisputeCountdown(null);
    abandonedClaimStartedRef.current = false;
    setScreen('main-menu');
  }, [ws, storage]);

  // --- Abandoned game handler ---
  const handleAbandonedGame = useCallback(async () => {
    if (abandonedClaimStartedRef.current) return;
    abandonedClaimStartedRef.current = true;
    setIsClaimingAbandoned(true);

    const w = requireWallet();
    const addr = requireAccountAddress();
    const capturedCardIds = [...cardIds];
    const capturedGameRandomness = gameRandomness ? [...gameRandomness] : null;
    const capturedOnChainGameId = onChainGameId;
    const capturedOpponentAddress = ws.opponentAztecAddress;
    const capturedOpponentCardIds = ws.opponentCardIds ? [...ws.opponentCardIds] : [];
    const capturedPlayerNumber = ws.playerNumber;
    const validMoveProofs = [...moveProofsRef.current];

    if (!capturedOnChainGameId || !capturedGameRandomness || !capturedOpponentAddress) {
      console.error('[useGame] Cannot claim abandoned game: missing game data');
      setIsClaimingAbandoned(false);
      abandonedClaimStartedRef.current = false;
      return;
    }

    try {
      // Step 1: claim_abandoned_game
      await txManager.runTx<string>({
        type: 'claim_abandoned_game',
        label: 'Claiming abandoned game...',
        gameId: ws.gameId ?? undefined,
        execute: async (setPhase) => {
          setPhase('proving');

          const { loadProveHandCircuit, loadGameMoveCircuit, loadDummyMoveCircuit } = await import('../aztec/circuitLoader');
          const { UltraHonkBackend } = await import('@aztec/bb.js');
          const { getBarretenberg } = await import('../aztec/proofBackend');
          const { ensureContracts } = await import('../aztec/contracts');

          const [handArtifact, moveArtifact, dummyArtifact] = await Promise.all([
            loadProveHandCircuit(),
            loadGameMoveCircuit(),
            loadDummyMoveCircuit(),
          ]);

          const api = await getBarretenberg();
          const handBackend = new UltraHonkBackend(handArtifact.bytecode, api);
          const moveBackend = new UltraHonkBackend(moveArtifact.bytecode, api);
          const dummyBackend = new UltraHonkBackend(dummyArtifact.bytecode, api);

          const [handVk, moveVk, dummyVk] = await Promise.all([
            handBackend.getVerificationKey(),
            moveBackend.getVerificationKey(),
            dummyBackend.getVerificationKey(),
          ]);

          const { Fr, AztecAddress } = await ensureContracts(w);

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

          // Generate dummy proofs for padding
          const { Noir } = await import('@noir-lang/noir_js');
          const numValid = validMoveProofs.length;
          const dummyProofs: { proof: string; publicInputs: string[] }[] = [];
          for (let i = numValid; i < 9; i++) {
            const dummyNoir = new Noir(dummyArtifact as any);
            const { witness } = await dummyNoir.execute({
              card_commit_1: '0', card_commit_2: '0',
              start_state_hash: '0', end_state_hash: '0',
              game_ended: '0', winner_id: '0',
            });
            const proofData = await dummyBackend.generateProof(witness);
            const proofB64 = btoa(String.fromCharCode(...proofData.proof));
            dummyProofs.push({
              proof: proofB64,
              publicInputs: ['0x0', '0x0', '0x0', '0x0', '0x0', '0x0'],
            });
          }

          // Sort valid move proofs by chain order
          const { computeBoardStateHash } = await import('../aztec/proofWorker');
          const emptyBoard = Array(18).fill('0');
          const CARDS_PER_HAND = 5;
          const canonicalInitial = await computeBoardStateHash(emptyBoard, [CARDS_PER_HAND, CARDS_PER_HAND], 1);

          const byStart = new Map<string, typeof validMoveProofs[0]>();
          for (const p of validMoveProofs) byStart.set(p.startStateHash, p);

          const sorted: typeof validMoveProofs = [];
          let nextHash = canonicalInitial;
          for (let i = 0; i < numValid; i++) {
            const p = byStart.get(nextHash);
            if (!p) throw new Error(`Proof chain broken at step ${i}`);
            sorted.push(p);
            nextHash = p.endStateHash;
          }

          // Build all 9 proof+inputs arrays (sorted valid + dummy padding)
          const allProofs: InstanceType<typeof Fr>[][] = [];
          const allInputs: InstanceType<typeof Fr>[][] = [];
          for (const m of sorted) {
            allProofs.push(base64ToFrArray(m.proof));
            allInputs.push(m.publicInputs.map(hexToFr));
          }
          for (const d of dummyProofs) {
            allProofs.push(base64ToFrArray(d.proof));
            allInputs.push(d.publicInputs.map(hexToFr));
          }

          // Build hand proof data
          const myProof = myHandProofRef.current;
          const oppProof = opponentHandProofRef.current;
          if (!myProof || !oppProof) throw new Error('Hand proofs not ready');
          const handProof1 = capturedPlayerNumber === 1 ? myProof : oppProof;
          const handProof2 = capturedPlayerNumber === 2 ? myProof : oppProof;

          setPhase('sending');

          const contract = contractCache.gameContract;
          if (!contract) throw new Error('Game contract not initialized');

          const senderAddr = AztecAddress.fromString(addr);
          const { fee } = await ensureContracts(w);

          const { receipt } = await contract.methods
            .claim_abandoned_game(
              toFrUtil(Fr, capturedOnChainGameId),
              new Fr(BigInt(numValid)),
              capturedPlayerNumber === 1,
              bytesToFrArray(handVk),
              bytesToFrArray(moveVk),
              bytesToFrArray(dummyVk),
              base64ToFrArray(handProof1.proof), handProof1.publicInputs.map(hexToFr),
              base64ToFrArray(handProof2.proof), handProof2.publicInputs.map(hexToFr),
              allProofs[0], allInputs[0], allProofs[1], allInputs[1],
              allProofs[2], allInputs[2], allProofs[3], allInputs[3],
              allProofs[4], allInputs[4], allProofs[5], allInputs[5],
              allProofs[6], allInputs[6], allProofs[7], allInputs[7],
              allProofs[8], allInputs[8],
            )
            .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_TX_TIMEOUT } });

          return receipt?.txHash?.toString() ?? '';
        },
      });

      console.log('[useGame] claim_abandoned_game mined, waiting for dispute window...');

      // Step 2: Wait for dispute window (65 seconds to ensure 5 blocks)
      const DISPUTE_SECONDS = 65;
      setAbandonedDisputeCountdown(DISPUTE_SECONDS);
      for (let i = DISPUTE_SECONDS; i > 0; i--) {
        setAbandonedDisputeCountdown(i);
        await new Promise(r => setTimeout(r, 1000));
      }
      setAbandonedDisputeCountdown(0);

      // Step 3: settle_abandoned_game
      await txManager.runTx<{ hash: string; callerRandomness: any[] }>({
        type: 'settle_abandoned_game',
        label: 'Settling abandoned game...',
        gameId: ws.gameId ?? undefined,
        execute: async (setPhase) => {
          setPhase('sending');

          const { ensureContracts } = await import('../aztec/contracts');
          const { Fr, AztecAddress, fee } = await ensureContracts(w);

          const contract = contractCache.gameContract;
          if (!contract) throw new Error('Game contract not initialized');

          const senderAddr = AztecAddress.fromString(addr);
          const opponent = AztecAddress.fromString(capturedOpponentAddress);
          const callerRandomness = capturedGameRandomness!.map(v => toFrUtil(Fr, v));
          const padTo5 = (ids: number[]): InstanceType<typeof Fr>[] => {
            const padded = [...ids];
            while (padded.length < 5) padded.push(0);
            return padded.slice(0, 5).map(id => new Fr(BigInt(id)));
          };

          // Determine which card to claim (first opponent card placed on board, if any)
          // For now claim the first opponent card if any moves were played by opponent
          const numValid = validMoveProofs.length;
          const opponentPlayedCards = numValid >= 2; // Opponent played at least 1 card (move index 1)
          const claimedCardId = opponentPlayedCards && capturedOpponentCardIds.length > 0
            ? capturedOpponentCardIds[0]
            : 0;

          const { receipt } = await contract.methods
            .settle_abandoned_game(
              toFrUtil(Fr, capturedOnChainGameId!),
              padTo5(capturedCardIds),
              callerRandomness,
              padTo5(capturedOpponentCardIds),
              new Fr(BigInt(claimedCardId)),
              opponent,
            )
            .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_TX_TIMEOUT } });

          const hash = receipt?.txHash?.toString();
          if (!hash) throw new Error('Settlement tx returned no txHash');
          return { hash, callerRandomness };
        },
        postEffects: async (result) => {
          const { hash, callerRandomness } = result;
          console.log('[useGame] Abandoned game settled, txHash:', hash);

          // Import caller's returned cards
          const callerNotes: PlaintextNoteData[] = [];
          for (let i = 0; i < capturedCardIds.length && i < 5; i++) {
            callerNotes.push({ tokenId: capturedCardIds[i], randomness: toHexString(callerRandomness[i]) });
          }
          await importNotes(hash, callerNotes, 'Abandoned game recovery');

          // Refresh token balance (abandoned game settlement may mint tokens)
          aztec.refreshTokenBalance().catch(() => {});

          onChainPhaseRef.current = 'idle';
          setIsClaimingAbandoned(false);
          setAbandonedDisputeCountdown(null);
        },
      });
    } catch (err) {
      console.error('[useGame] Abandoned game flow failed:', err);
      setIsClaimingAbandoned(false);
      setAbandonedDisputeCountdown(null);
      abandonedClaimStartedRef.current = false;
      onChainPhaseRef.current = 'idle';
    }
  }, [ws, cardIds, gameRandomness, onChainGameId,
      aztec.wallet, aztec.accountAddress, importNotes]);

  // Auto-trigger abandoned game flow when opponent disconnects
  useEffect(() => {
    if (!ws.opponentDisconnected) return;
    if (abandonedClaimStartedRef.current) return;
    if (onChainPhaseRef.current !== 'done') return;
    if (moveProofsRef.current.length === 0) return;
    console.log('[useGame] Opponent disconnected with moves played, starting abandoned game flow...');
    handleAbandonedGame();
  }, [ws.opponentDisconnected, handleAbandonedGame]);

  return {
    screen, setScreen,
    ws,
    onChainGameId,
    handProofStatus,
    moveProofStatus,
    canSettle,
    settleTxStatus,
    onChainError,
    cardIds, packResult, hasGameInProgress,
    opponentSettled, takenCardId,
    isClaimingAbandoned, abandonedDisputeCountdown, canGoBack,
    handlePlay, handleCardPacks, handleHandSelected,
    handleCancelMatchmaking, handlePackOpened, handlePackOpenComplete,
    handlePlaceCard, handleSettle, handleBackToMenu,
  };
}
