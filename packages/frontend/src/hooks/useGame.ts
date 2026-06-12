import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from './useWebSocket';
import { useProofGeneration } from './useProofGeneration';
import type { PlayerHandData } from './useProofGeneration';
import { useGameStorage, type PersistedGameState } from './useGameStorage';
import { useGameSession } from './useGameSession';
import { useAztecContext } from '../aztec/AztecContext';
import { importNotesFromTx, fetchTxEffectData } from '../aztec/noteImporter';
import { addCards, type StoredCard } from '../aztec/cardStore';
import txManager from '../aztec/txManager';
import { ensureContracts, contractCache } from '../aztec/contracts';
import { toFr as toFrUtil, toHexString, bytesToFrArray, base64ToFrArray, hexToFr } from '../aztec/fieldUtils';
import { AZTEC_TX_TIMEOUT, AZTEC_SETTLE_TX_TIMEOUT, CARDS_PER_HAND, TOTAL_MOVES, MOVE_PROOF_WAIT_TIMEOUT, HAND_PROOF_WAIT_TIMEOUT } from '../aztec/gameConstants';
import { requireWallet, requireAccountAddress } from '../aztec/walletGuards';
import type { Screen, GameState, Player, Card, HandProofData, MoveProofData, PlaintextNoteData } from '../types';

// Re-export types consumers need
export type TxStatus = 'idle' | 'preparing' | 'proving' | 'sending' | 'confirmed' | 'error';
export type ProofStatus = 'idle' | 'generating' | 'ready' | 'error';

// Re-export the on-chain phase machine so consumers and tests keep
// importing from useGame (the state machine itself lives in useGameSession).
export { VALID_TRANSITIONS } from './useGameSession';
export type { OnChainPhase } from './useGameSession';

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
 * ## Ref vs State design
 *
 * This hook uses both React state (useState) and refs (useRef) for game data.
 * The split is intentional:
 *
 * **React state** — values that the UI needs to render:
 *   screen, cardIds, handProofStatus, moveProofStatus, settleTxStatus, etc.
 *   Changes trigger re-renders, which update the UI.
 *
 * **Refs** — values consumed by async closures or that must survive navigation:
 *   cardIdsRef:          Snapshot of card IDs for proof generation closures.
 *   moveProofsRef:       Always-current move proof array (avoids stale closure
 *                        in handleSettle's execute callback).
 *   myHandProofRef,
 *   opponentHandProofRef: Same pattern — latest proof values for settlement.
 *   pendingMovesRef:     Moves queued before hand proofs are ready.
 *   gameStateHistoryRef: Board snapshots indexed by move number, for deferred
 *                        proof generation after hand proofs arrive.
 *   handProofSubmittedRef,
 *   handProofGeneratedRef,
 *   noteImportProcessedRef: Idempotency guards preventing duplicate operations.
 *   moveProofsCompleteRef,
 *   handProofsCompleteRef: Promise resolvers for cross-concern synchronization.
 *
 * Session-owned refs (settlementInfoRef, onChainPhaseRef,
 * activePhaseResolveRef) are documented in useGameSession.ts and reached
 * through its stable accessor functions.
 *
 * The general rule: if a value is read inside a txManager.execute() callback
 * or needs to survive screen transitions, it's a ref. If the UI renders it,
 * it's state. Some values exist as both (e.g., myHandProof is state for the
 * UI status indicator AND a ref for the settlement closure).
 */

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

  // --- On-chain session: phase machine, create/join pipeline, settlement info ---
  const session = useGameSession({ ws, screen, cardIds });

  // --- Settlement tx state ---
  const [settleTxStatus, setSettleTxStatus] = useState<TxStatus>('idle');
  const [settleTxHash, setSettleTxHash] = useState<string | null>(null);
  const [settleError, setSettleError] = useState<string | null>(null);

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

  // Queue of moves made before hand proofs were ready
  const pendingMovesRef = useRef<Array<{
    card: Card; p1Hand: Card[]; p2Hand: Card[];
    handIndex: number; row: number; col: number;
    moveNumber: number;
  }>>([]);

  const addMoveProof = useCallback((proof: MoveProofData) => {
    setCollectedMoveProofs(prev => {
      const isDuplicate = prev.some(
        p => p.startStateHash === proof.startStateHash && p.endStateHash === proof.endStateHash,
      );
      if (isDuplicate) return prev;
      return [...prev, proof];
    });
  }, []);

  const generateHandProofFromState = useCallback(async (
    ids: number[],
    opponentGameRandomness: string[],
  ): Promise<void> => {
    const blindingFactor = session.blindingFactor;
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
  }, [session.blindingFactor, proofs.generateHandProof]);

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
      const blindingFactor = session.blindingFactor;
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
    [myHandProof, opponentHandProof, myCardCommit, opponentCardCommit, session.blindingFactor, proofs.generateMoveProof, addMoveProof],
  );

  // --- Effects ---

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
    if (!session.blindingFactor) {
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
  }, [ws.gameId, ws.gameState, cardIds, session.blindingFactor, ws.opponentGameRandomness, generateHandProofFromState]);

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
    if (session.onChainGameId) persisted.onChainGameId = session.onChainGameId;
    if (myHandProof) persisted.myHandProof = myHandProof;
    if (opponentHandProof) persisted.opponentHandProof = opponentHandProof;
    if (collectedMoveProofs.length > 0) persisted.collectedMoveProofs = collectedMoveProofs;
    if (ws.opponentAztecAddress) persisted.opponentAztecAddress = ws.opponentAztecAddress;
    if (ws.opponentOnChainGameId) persisted.opponentOnChainGameId = ws.opponentOnChainGameId;
    if (session.gameRandomness) persisted.gameRandomness = session.gameRandomness;
    if (session.blindingFactor) persisted.blindingFactor = session.blindingFactor;
    if (ws.opponentGameRandomness) persisted.opponentGameRandomness = ws.opponentGameRandomness;

    storage.saveGame(persisted);
    setHasGameInProgress(true);
  }, [
    ws.gameId, ws.playerNumber, cardIds, screen,
    session.onChainGameId, session.gameRandomness, session.blindingFactor,
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

  // Reset state on returning to menu
  useEffect(() => {
    if (screen === 'main-menu') {
      handProofSubmittedRef.current = false;
      pendingMovesRef.current = [];
      noteImportProcessedRef.current = null;
      handProofGeneratedRef.current = false;
      gameStateHistoryRef.current = new Map();
      moveProofsCompleteRef.current = null;
      handProofsCompleteRef.current = null;
      // Session state/refs (onChainPhaseRef deliberately survives — see
      // useGameSession.resetForMenu)
      session.resetForMenu();
      setSettleTxStatus('idle');
      setSettleTxHash(null);
      setSettleError(null);
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

  // Import notes helper — imports into PXE AND persists the tx-effect aux
  // data to localStorage so a fresh wallet can re-import on restart.
  // Mirrors the pattern in useCardPacks.ts (pack purchases) so settlement,
  // loser note-relay, and abandoned-game recovery all persist consistently.
  const importNotes = useCallback(async (
    txHashStr: string,
    notes: { tokenId: number; randomness: string }[],
    label: string,
  ) => {
    if (!aztec.wallet || !aztec.accountAddress || !aztec.nodeClient) return;
    const accountAddress = aztec.accountAddress;
    try {
      // Fetch TxEffect first so we can persist before (and reuse during) import.
      const txEffectData = await fetchTxEffectData(aztec.nodeClient, txHashStr);

      if (txEffectData) {
        const storedCards: StoredCard[] = notes.map((n) => ({
          cardId: n.tokenId,
          randomness: n.randomness,
          txHash: txHashStr,
          noteHashes: txEffectData.noteHashes,
          firstNullifier: txEffectData.firstNullifier,
        }));
        try {
          addCards(accountAddress, storedCards);
        } catch (persistErr) {
          console.error(`[useGame] ${label}: failed to persist cards to localStorage (continuing with PXE import):`, persistErr);
        }
      } else {
        console.warn(`[useGame] ${label}: TxEffect unavailable — cards will import to PXE but won't survive a refresh`);
      }

      const importedIds = await importNotesFromTx(
        aztec.wallet, aztec.nodeClient, accountAddress,
        txHashStr, notes, label,
        txEffectData ?? undefined,
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

    // Determine which card was taken by comparing returned cards vs original hand
    const returnedIds = new Set(notes.map(n => n.tokenId));
    const taken = cardIds.find(id => !returnedIds.has(id));
    setTakenCardId(taken ?? null);
    setOpponentSettled(true);

    (async () => {
      await importNotes(txHash, notes, 'Loser import');
      // Settlement mints 20 Arena Tokens to BOTH players (see game contract
      // main.nr:703-706). The loser's PXE may not have finished scanning
      // the settlement block's tagged logs, so poll a few times until the
      // balance reflects the reward.
      await aztec.refreshTokenBalance().catch(() => {});
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try { await aztec.refreshTokenBalance(); } catch {}
      }
    })();

    // Settlement complete on loser side — release the game lifecycle
    session.transitionPhase('idle');
  }, [ws.incomingNoteData, aztec.wallet, aztec.accountAddress, aztec.nodeClient, importNotes, cardIds, aztec.refreshTokenBalance, session.transitionPhase]);

  // Track opponent's settlement on the loser's side via txManager.
  // When the winner starts settling, the loser receives OPPONENT_SETTLING via WS.
  // This creates a txManager entry so onChainPhaseRef stays non-idle and the
  // "Back to Lobby" guard works correctly.
  const opponentSettleTxIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ws.opponentSettling) return;
    if (opponentSettleTxIdRef.current) return; // Already tracking

    session.transitionPhase('awaiting_settlement');
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
        session.transitionPhase('idle');
        // Wait for PXE to sync the block containing the settlement tx
        // before querying token balance (token notes use ONCHAIN_CONSTRAINED
        // delivery which requires PXE block sync to discover).
        await new Promise(r => setTimeout(r, 5000));
        aztec.refreshTokenBalance().catch(() => {});
      },
    });

    txId.catch(() => {
      // If something goes wrong, still release the game lifecycle
      session.transitionPhase('idle');
    });

    opponentSettleTxIdRef.current = 'tracking';
  }, [ws.opponentSettling, ws.gameId, session.transitionPhase]);

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
      session.restoreFromSave(saved);
      ws.queueMatchmaking(saved.selectedCardIds);
      setScreen('finding-opponent');
      return;
    }
    setScreen('card-selector');
  }, [storage, ws, addMoveProof, session.restoreFromSave]);

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
    // are read from the session's settlement info inside execute — that ref
    // persists across navigation.
    const capturedGameId = ws.gameId;
    const capturedPlayerNumber = ws.playerNumber;
    const w = requireWallet(aztec.wallet);
    const addr = requireAccountAddress(aztec.accountAddress);
    const capturedImportNotes = importNotes;
    const capturedRelayNoteData = (txHash: string, notes: PlaintextNoteData[]) =>
      ws.relayNoteData(capturedGameId, txHash, notes);
    const capturedNotifySettle = (gId: string, cardId: number) =>
      ws.notifySettleStarted(gId, cardId);

    // Don't transition to 'settling' yet — the on-chain pipeline may still be in
    // awaiting_join (P2 hasn't joined). Transitioning now would block the natural
    // awaiting_join → active transition. We transition inside execute after active.
    setSettleTxStatus('preparing');
    setSettleError(null);
    setSettleTxHash(null);

    txManager.runTx({
      type: 'settle_game',
      label: 'Settling game...',
      gameId: capturedGameId,

      execute: async (setPhase) => {
        // ── Wait for both players to be on-chain (phase: active) ──────
        if (session.getPhase() !== 'active') {
          console.log('[useGame] Game not yet active on-chain (phase:', session.getPhase(), ') — waiting...');
          setPhase('queued');
          await session.waitForActivePhase(AZTEC_SETTLE_TX_TIMEOUT * 1000);
          console.log('[useGame] Game active on-chain — proceeding with settlement');
        }

        // NOW transition to settling (from 'active', which is a valid transition)
        session.transitionPhase('settling');

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

        // ── Read pipeline-dependent values from persistent session ref ──
        const sInfo = session.getSettlementInfo();
        if (!sInfo) throw new Error('Settlement info not available (pipeline incomplete)');

        // Both players are on-chain (guaranteed by active phase wait above).
        const { fee, Fr, AztecAddress } = await ensureContracts(w);
        const liveOnChainGameId = sInfo.onChainGameId;

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

        // ── All waits complete — backfill from latest ws state ────
        // (race: OPPONENT_AZTEC_INFO / GAME_OVER arrived before the pipeline
        // seeded the settlement info — the session merges the latest ws
        // values, read via render-updated refs, into any still-empty field).
        session.backfillSettlementInfoFromWs();

        const capturedOpponentAddress = sInfo.opponentAddress;
        const capturedOpponentRandomness = sInfo.opponentRandomness;
        const capturedGameRandomness = sInfo.gameRandomness;
        const capturedCardIds = sInfo.callerCardIds;
        const capturedOpponentCardIds = sInfo.opponentCardIds;

        if (capturedCardIds.length === 0) throw new Error('No caller card IDs (settlement info incomplete)');
        if (capturedOpponentCardIds.length === 0) {
          console.error('[useGame] Settlement failed: opponentCardIds is empty.',
            { sInfo });
          throw new Error('No opponent card IDs (settlement info incomplete)');
        }
        if (!capturedOpponentAddress) {
          console.error('[useGame] Settlement failed: opponentAddress is empty.',
            'OPPONENT_AZTEC_INFO was not received via WS or ref.',
            { sInfo });
          throw new Error('No opponent address (OPPONENT_AZTEC_INFO not received)');
        }
        if (capturedOpponentRandomness.length === 0) {
          console.error('[useGame] Settlement failed: opponentRandomness is empty.', { sInfo });
          throw new Error('No opponent randomness (OPPONENT_AZTEC_INFO incomplete)');
        }

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

        const handVkFields = bytesToFrArray(Fr, handVk);
        const moveVkFields = bytesToFrArray(Fr, moveVk);
        const toFrArr = (b64: string) => base64ToFrArray(Fr, b64);
        const toFrHex = (hex: string) => hexToFr(Fr, hex);

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
          mp.push(toFrArr(m.proof));
          mi.push(m.publicInputs.map(toFrHex));
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
        const hp1ProofData = toFrArr(handProof1.proof);
        const hp1InputData = handProof1.publicInputs.map(toFrHex);
        const hp2ProofData = toFrArr(handProof2.proof);
        const hp2InputData = handProof2.publicInputs.map(toFrHex);

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
        return { hash, callerRandomness, opponentRandomness, capturedCardIds, capturedOpponentCardIds };
      },

      postEffects: async (result) => {
        const { hash, callerRandomness, opponentRandomness, capturedCardIds, capturedOpponentCardIds } = result;
        setSettleTxHash(hash);
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
        session.transitionPhase('idle');
        session.clearSettlementInfo();
      },
    }).catch((err) => {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      console.error('[useGame] settleGame error:', err);
      setSettleError(message);
      setSettleTxStatus('error');
      session.transitionPhase('idle');
      session.clearSettlementInfo();
    });
  }, [ws.gameId, ws.playerNumber,
      aztec.wallet, aztec.accountAddress, importNotes, ws.relayNoteData, ws.notifySettleStarted,
      session.getPhase, session.waitForActivePhase, session.transitionPhase,
      session.getSettlementInfo, session.backfillSettlementInfoFromWs, session.clearSettlementInfo]);

  // canGoBack: winner can leave after picking a card (settlement runs in background via txManager).
  // Winner can leave once settlement started (txManager runs in background).
  // Loser must wait for NOTE_DATA (awaiting_settlement blocks navigation).
  const phase = session.getPhase();
  const canGoBack = screen === 'main-menu'
    || phase === 'settling'   // winner: settlement in progress, can leave
    || phase === 'idle';      // no lifecycle active

  const handleBackToMenu = useCallback(() => {
    const currentPhase = session.getPhase();
    if (currentPhase !== 'idle' && currentPhase !== 'settling') {
      console.log('[useGame] Back to menu blocked: game in-flight (phase:', currentPhase, ')');
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
  }, [ws, storage, session.getPhase]);

  // --- Abandoned game handler ---
  const handleAbandonedGame = useCallback(async () => {
    if (abandonedClaimStartedRef.current) return;
    abandonedClaimStartedRef.current = true;
    session.transitionPhase('settling');
    setIsClaimingAbandoned(true);

    const w = requireWallet(aztec.wallet);
    const addr = requireAccountAddress(aztec.accountAddress);
    // Backfill from latest ws state (same init race as handleSettle)
    const sInfo = session.backfillSettlementInfoFromWs();
    const capturedPlayerNumber = ws.playerNumber;
    const validMoveProofs = [...moveProofsRef.current];

    if (!sInfo || !sInfo.onChainGameId || !sInfo.gameRandomness.length || !sInfo.opponentAddress) {
      console.error('[useGame] Cannot claim abandoned game: missing settlement info', { sInfo, wsOpponentAddr: ws.opponentAztecAddress });
      setIsClaimingAbandoned(false);
      abandonedClaimStartedRef.current = false;
      session.transitionPhase('idle');
      return;
    }
    if (sInfo.callerCardIds.length === 0) {
      console.error('[useGame] Cannot claim abandoned game: missing own card IDs');
      setIsClaimingAbandoned(false);
      abandonedClaimStartedRef.current = false;
      session.transitionPhase('idle');
      return;
    }

    const capturedCardIds = sInfo.callerCardIds;
    const capturedGameRandomness = sInfo.gameRandomness;
    const capturedOnChainGameId = sInfo.onChainGameId;
    const capturedOpponentAddress = sInfo.opponentAddress;
    const capturedOpponentCardIds = sInfo.opponentCardIds;

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

          const toFrArr = (b64: string) => base64ToFrArray(Fr, b64);
          const toFrHex = (hex: string) => hexToFr(Fr, hex);

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
            allProofs.push(toFrArr(m.proof));
            allInputs.push(m.publicInputs.map(toFrHex));
          }
          for (const d of dummyProofs) {
            allProofs.push(toFrArr(d.proof));
            allInputs.push(d.publicInputs.map(toFrHex));
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
              bytesToFrArray(Fr, handVk),
              bytesToFrArray(Fr, moveVk),
              bytesToFrArray(Fr, dummyVk),
              toFrArr(handProof1.proof), handProof1.publicInputs.map(toFrHex),
              toFrArr(handProof2.proof), handProof2.publicInputs.map(toFrHex),
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

          session.transitionPhase('idle');
          setIsClaimingAbandoned(false);
          setAbandonedDisputeCountdown(null);
        },
      });
    } catch (err) {
      console.error('[useGame] Abandoned game flow failed:', err);
      setIsClaimingAbandoned(false);
      setAbandonedDisputeCountdown(null);
      abandonedClaimStartedRef.current = false;
      session.transitionPhase('idle');
    }
  }, [ws, aztec.wallet, aztec.accountAddress, importNotes,
      session.transitionPhase, session.backfillSettlementInfoFromWs]);

  // Auto-trigger abandoned game flow when opponent disconnects
  useEffect(() => {
    if (!ws.opponentDisconnected) return;
    if (abandonedClaimStartedRef.current) return;
    if (session.getPhase() !== 'active' && session.getPhase() !== 'awaiting_join') return;
    if (moveProofsRef.current.length === 0) return;
    console.log('[useGame] Opponent disconnected with moves played, starting abandoned game flow...');
    handleAbandonedGame();
  }, [ws.opponentDisconnected, handleAbandonedGame, session.getPhase]);

  return {
    screen, setScreen,
    ws,
    onChainGameId: session.onChainGameId,
    handProofStatus,
    moveProofStatus,
    canSettle,
    settleTxStatus,
    onChainError: session.onChainError,
    cardIds, packResult, hasGameInProgress,
    opponentSettled, takenCardId,
    isClaimingAbandoned, abandonedDisputeCountdown, canGoBack,
    handlePlay, handleCardPacks, handleHandSelected,
    handleCancelMatchmaking, handlePackOpened, handlePackOpenComplete,
    handlePlaceCard, handleSettle, handleBackToMenu,
  };
}
