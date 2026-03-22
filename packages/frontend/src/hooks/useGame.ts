import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from './useWebSocket';
import { useProofGeneration } from './useProofGeneration';
import type { PlayerHandData } from './useProofGeneration';
import { useGameStorage, type PersistedGameState } from './useGameStorage';
import { useAztecContext } from '../aztec/AztecContext';
import { importNotesFromTx } from '../aztec/noteImporter';
import { waitForPxeSync } from '../aztec/pxeSync';
import { ensureContracts, contractCache, warmupContracts } from '../aztec/contracts';
import { AZTEC_CONFIG } from '../aztec/config';
import { toFr as toFrUtil, toHexString } from '../aztec/fieldUtils';
import { AZTEC_TX_TIMEOUT, AZTEC_SETTLE_TX_TIMEOUT, CARDS_PER_HAND, TOTAL_MOVES, MOVE_PROOF_WAIT_TIMEOUT } from '../aztec/gameConstants';
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

    const { gameContract, nftContract, fee, Fr, AztecAddress } = await ensureContracts(w);
    const senderAddr = AztecAddress.fromString(addr);

    console.log('[useGame] Starting create_game pipeline...');
    const { result: nonceResult } = await nftContract.methods.get_note_nonce(senderAddr).simulate({ from: senderAddr });
    const nonceFr = toFrUtil(Fr, nonceResult);
    console.log('[useGame] Note nonce:', nonceFr.toString());

    const { result: previewResult }: any = await nftContract.methods.preview_game_data(nonceFr).simulate({ from: senderAddr });
    const gameId = String(previewResult[0]);
    const randomnessHex = Array.from({ length: 6 }, (_, i) => toHexString(previewResult[i + 1]));
    const gameIdFr = toFrUtil(Fr, gameId);

    const [{ result: statusResult }, { result: blindingResult }] = await Promise.all([
      gameContract.methods.get_game_status(gameIdFr).simulate({ from: senderAddr }),
      nftContract.methods.compute_blinding_factor(gameIdFr).simulate({ from: senderAddr }),
    ]);
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
      const { result: pxeCards } = await nftContract.methods.get_private_cards(senderAddr, 0).simulate({ from: senderAddr });
      // simulate() returns tuple as nested array: [fieldArray, hasMore]
      const page = pxeCards[0] ?? pxeCards;
      const cardList = Array.isArray(page) ? page.map((c: any) => Number(c)) : page;
      console.log('[useGame] PXE private cards before create_game:', cardList);
    } catch (e) {
      console.warn('[useGame] Could not query PXE private cards:', e);
    }

    const { receipt } = await gameContract.methods
      .create_game(ids.map((id: number) => new Fr(BigInt(id))))
      .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_TX_TIMEOUT } });
    const txHash = receipt?.txHash?.toString();
    if (!txHash) throw new Error('create_game tx returned no txHash');
    console.log('[useGame] create_game tx mined, txHash:', txHash);

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

    return { gameId: gameIdHex, randomness: randomnessHex, blindingFactor: blindingHex, txHash };
  }, [aztec.wallet, aztec.accountAddress]);

  const prepareJoinGame = useCallback(async (chainGameId: string, ids: number[]): Promise<{ randomness: string[]; blindingFactor: string }> => {
    const w = requireWallet();
    const addr = requireAccountAddress();

    console.log('[useGame] Preparing join_game preview...');
    const { nftContract, Fr, AztecAddress } = await ensureContracts(w);
    const senderAddr = AztecAddress.fromString(addr);
    const chainGameIdFr = toFrUtil(Fr, chainGameId);

    const [{ result: nonceResult }, { result: blindingResult }] = await Promise.all([
      nftContract.methods.get_note_nonce(senderAddr).simulate({ from: senderAddr }),
      nftContract.methods.compute_blinding_factor(chainGameIdFr).simulate({ from: senderAddr }),
    ]);
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
    if (aztec.wallet) warmupContracts(aztec.wallet);
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
    if (!ws.gameId || !ws.gameState) return;
    if (ws.gameState.status !== 'playing' && ws.gameState.status !== 'finished') return;
    if (cardIds.length !== 5) return;
    if (!blindingFactor) return;
    if (!ws.opponentGameRandomness || ws.opponentGameRandomness.length !== 6) return;

    handProofGeneratedRef.current = true;
    generateHandProofFromState(cardIds, ws.opponentGameRandomness).catch(err => {
      console.error('[useGame] Hand proof generation failed:', err);
      handProofGeneratedRef.current = false;
    });
  }, [ws.gameId, ws.gameState, cardIds, blindingFactor, ws.opponentGameRandomness, generateHandProofFromState]);

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
          const { placeCard: applyMove } = await import('@aztec-triple-triad/game-logic');
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

  // Consolidated on-chain pipeline (replaces 3 separate effects + dead fallback)
  useEffect(() => {
    if (!ws.gameId || !ws.gameState) return;
    if (ws.gameState.status !== 'playing' && ws.gameState.status !== 'finished') return;
    if (!isContractAvailable) return;

    const phase = onChainPhaseRef.current;

    // P1: create game
    if (ws.playerNumber === 1 && phase === 'idle') {
      onChainPhaseRef.current = 'creating';
      (async () => {
        // Ensure PXE has processed nullifiers from any previous game's settlement
        if (lastSettleTxHashRef.current) {
          console.log('[useGame] P1: syncing PXE before create_game (previous settle tx:', lastSettleTxHashRef.current, ')');
          await waitForPxeSync(aztec.wallet, aztec.nodeClient);
          lastSettleTxHashRef.current = null;
        }
        console.log('[useGame] P1: starting on-chain game creation...');
        console.log('[useGame] P1: ownedCards=', aztec.ownedCardIds, 'selectedCardIds=', cardIds);
        const result = await createGameOnChain(cardIds);
        ws.shareAztecInfo(ws.gameId!, aztec.accountAddress!, result.gameId, result.randomness);
        aztec.updateOwnedCards(prev => removeOneOfEach(prev, cardIds));
        ws.notifyTxConfirmed(ws.gameId!, 'create_game', result.txHash);
        console.log('[useGame] P1: create_game mined, notified backend');
        onChainPhaseRef.current = 'done';
      })().catch(err => {
        console.error('[useGame] On-chain game creation failed:', err);
        setOnChainError(err instanceof Error ? err.message : 'Create game failed');
        onChainPhaseRef.current = 'idle';
      });
      return;
    }

    // P2 phase 1: prepare preview
    if (ws.playerNumber === 2 && phase === 'idle' && ws.opponentOnChainGameId) {
      onChainPhaseRef.current = 'preparing';
      (async () => {
        // Ensure PXE has processed nullifiers from any previous game's settlement
        if (lastSettleTxHashRef.current) {
          console.log('[useGame] P2: syncing PXE before prepare (previous settle tx:', lastSettleTxHashRef.current, ')');
          await waitForPxeSync(aztec.wallet, aztec.nodeClient);
          lastSettleTxHashRef.current = null;
        }
        console.log('[useGame] P2: preparing join preview data...');
        const result = await prepareJoinGame(ws.opponentOnChainGameId!, cardIds);
        ws.shareAztecInfo(ws.gameId!, aztec.accountAddress!, ws.opponentOnChainGameId!, result.randomness);
        aztec.updateOwnedCards(prev => removeOneOfEach(prev, cardIds));
        console.log('[useGame] P2: preview data shared, waiting for P1 tx confirmation...');
        onChainPhaseRef.current = 'awaiting_p1_tx';
      })().catch(err => {
        console.error('[useGame] P2 prepare failed:', err);
        setOnChainError(err instanceof Error ? err.message : 'Prepare join failed');
        onChainPhaseRef.current = 'idle';
      });
      return;
    }

    // P2 phase 2: join after P1 confirmed
    if (ws.playerNumber === 2 && phase === 'awaiting_p1_tx' && ws.opponentTxConfirmed && onChainGameId) {
      onChainPhaseRef.current = 'joining';
      (async () => {
        console.log('[useGame] P2: P1 tx confirmed, syncing PXE then sending join_game...');
        await waitForPxeSync(aztec.wallet, aztec.nodeClient);
        const txHash = await sendJoinGameTx(ws.opponentOnChainGameId!, cardIds);
        ws.notifyTxConfirmed(ws.gameId!, 'join_game', txHash);
        console.log('[useGame] P2: join_game mined, notified backend');
        onChainPhaseRef.current = 'done';
      })().catch(err => {
        console.error('[useGame] P2 join_game tx failed:', err);
        setOnChainError(err instanceof Error ? err.message : 'Join game failed');
        onChainPhaseRef.current = 'awaiting_p1_tx';
      });
    }
  }, [ws.playerNumber, ws.gameId, ws.gameState, ws.opponentOnChainGameId,
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
      onChainPhaseRef.current = 'idle';
      gameStateHistoryRef.current = new Map();
      moveProofsCompleteRef.current = null;
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
    importNotes(txHash, notes, 'Loser import').then(() =>
      waitForPxeSync(aztec.wallet, aztec.nodeClient),
    );
  }, [ws.incomingNoteData, aztec.wallet, aztec.accountAddress, aztec.nodeClient, importNotes]);

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
        const { placeCard: applyMove } = await import('@aztec-triple-triad/game-logic');
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
    if (!myHandProof || !opponentHandProof) throw new Error('Hand proofs not ready');
    if (!ws.opponentAztecAddress) throw new Error('No opponent Aztec address');
    if (ws.opponentCardIds.length === 0) throw new Error('No opponent card IDs');
    if (!gameRandomness || gameRandomness.length !== 6) throw new Error('Game randomness not available');
    if (!ws.opponentGameRandomness || ws.opponentGameRandomness.length !== 6) throw new Error('Opponent randomness not available');
    if (!onChainGameId) throw new Error('No on-chain game ID for settlement');

    // Wait for all move proofs (bug #4 fix: promise-based, not busy-polling)
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

    // --- Settlement logic (from useGameSession.settleGame) ---
    const w = requireWallet();
    const addr = requireAccountAddress();

    setSettleTxStatus('preparing');
    setSettleError(null);
    setSettleTxHash(null);

    try {
      const { fee, Fr, AztecAddress } = await ensureContracts(w);

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

      const currentMoveProofs = moveProofsRef.current;
      const byStart = new Map<string, typeof currentMoveProofs[0]>();
      for (const p of currentMoveProofs) {
        byStart.set(p.startStateHash, p);
      }

      const sorted: typeof currentMoveProofs = [];
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

      const senderAddr = AztecAddress.fromString(addr);
      const opponent = AztecAddress.fromString(ws.opponentAztecAddress!);

      const padTo5 = (ids: number[]): InstanceType<typeof Fr>[] => {
        const padded = [...ids];
        while (padded.length < CARDS_PER_HAND) padded.push(0);
        return padded.slice(0, CARDS_PER_HAND).map(id => new Fr(BigInt(id)));
      };

      const callerRandomness = gameRandomness.map(v => toFrUtil(Fr, v));
      const opponentRandomness = ws.opponentGameRandomness!.map(v => toFrUtil(Fr, v));

      console.log('callerRandomness = ', callerRandomness);
      console.log('opponentRandomness = ', opponentRandomness);
      const handProof1 = ws.playerNumber === 1 ? myHandProof! : opponentHandProof!;
      const handProof2 = ws.playerNumber === 2 ? myHandProof! : opponentHandProof!;
      const hp1ProofData = base64ToFrArray(handProof1.proof);
      const hp1InputData = handProof1.publicInputs.map(hexToFr);
      const hp2ProofData = base64ToFrArray(handProof2.proof);
      const hp2InputData = handProof2.publicInputs.map(hexToFr);

      const { receipt } = await contract.methods
        .process_game(
          toFrUtil(Fr, onChainGameId),
          handVkFields,
          moveVkFields,
          hp1ProofData, hp1InputData,
          hp2ProofData, hp2InputData,
          mp[0], mi[0], mp[1], mi[1], mp[2], mi[2],
          mp[3], mi[3], mp[4], mi[4], mp[5], mi[5],
          mp[6], mi[6], mp[7], mi[7], mp[8], mi[8],
          opponent,
          new Fr(BigInt(selectedCardId)),
          padTo5(cardIds),
          padTo5(ws.opponentCardIds),
          callerRandomness,
          opponentRandomness,
        )
        .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_SETTLE_TX_TIMEOUT } });

      const hash = receipt?.txHash?.toString();
      if (!hash) throw new Error('Settlement tx returned no txHash');
      setSettleTxHash(hash);
      lastSettleTxHashRef.current = hash;
      setSettleTxStatus('confirmed');
      console.log('[useGame] Game settled on-chain, txHash:', hash);

      // Build note data
      const isWinnerLoser = selectedCardId !== 0;

      const callerNotes: PlaintextNoteData[] = [];
      for (let i = 0; i < cardIds.length && i < 5; i++) {
        callerNotes.push({ tokenId: cardIds[i], randomness: toHexString(callerRandomness[i]) });
      }
      if (isWinnerLoser) {
        callerNotes.push({ tokenId: selectedCardId, randomness: toHexString(callerRandomness[5]) });
      }

      const opponentNotes: PlaintextNoteData[] = [];
      if (isWinnerLoser) {
        let removed = false;
        for (let i = 0; i < ws.opponentCardIds.length && i < 5; i++) {
          if (ws.opponentCardIds[i] === selectedCardId && !removed) {
            removed = true;
          } else {
            opponentNotes.push({ tokenId: ws.opponentCardIds[i], randomness: toHexString(opponentRandomness[i]) });
          }
        }
      } else {
        for (let i = 0; i < ws.opponentCardIds.length && i < 5; i++) {
          opponentNotes.push({ tokenId: ws.opponentCardIds[i], randomness: toHexString(opponentRandomness[i]) });
        }
      }

      console.log('callerNotes = ', callerNotes);
      console.log('opponentNotes = ', opponentNotes);
      ws.relayNoteData(ws.gameId!, hash, opponentNotes);
      await importNotes(hash, callerNotes, 'Winner import');
      await waitForPxeSync(aztec.wallet, aztec.nodeClient);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      console.error('[useGame] settleGame error:', err);
      setSettleError(message);
      setSettleTxStatus('error');
      throw err;
    }
  }, [ws, cardIds, myHandProof, opponentHandProof, gameRandomness, onChainGameId,
      aztec.wallet, aztec.accountAddress, aztec.nodeClient, importNotes]);

  const handleBackToMenu = useCallback(() => {
    ws.leaveGame();
    setCardIds([]);
    storage.clearGame();
    setHasGameInProgress(false);
    setScreen('main-menu');
  }, [ws, storage]);

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
    handlePlay, handleCardPacks, handleHandSelected,
    handleCancelMatchmaking, handlePackOpened, handlePackOpenComplete,
    handlePlaceCard, handleSettle, handleBackToMenu,
  };
}
