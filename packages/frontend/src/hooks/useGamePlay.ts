import { useState, useCallback, useEffect, useRef } from 'react';
import { useProofGeneration } from './useProofGeneration';
import type { PlayerHandData, ProofStatus } from './useProofGeneration';
import type { UseWebSocketReturn } from './useWebSocket';
import type { PersistedGameState } from './useGameStorage';
import { useAztecContext } from '../aztec/AztecContext';
import { TOTAL_MOVES } from '../aztec/gameConstants';
import type { GameState, Card, HandProofData, MoveProofData, Player } from '../types';

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

export interface UseGamePlayParams {
  ws: UseWebSocketReturn;
  /** The 5 card IDs the player selected for this game. */
  cardIds: number[];
  /** Session-derived blinding factor — proofs cannot generate without it. */
  blindingFactor: string | null;
}

export interface UseGamePlayReturn {
  // UI-rendered state
  myHandProof: HandProofData | null;
  opponentHandProof: HandProofData | null;
  collectedMoveProofs: MoveProofData[];
  handProofStatus: ProofStatus;
  moveProofStatus: ProofStatus;
  canSettle: boolean;

  // Actions
  handlePlaceCard: (handIndex: number, row: number, col: number) => Promise<void>;

  // Stable functions (identity never changes) — safe to close over in
  // async callbacks and to list in other hooks' useCallback deps.
  getMyHandProof: () => HandProofData | null;
  getOpponentHandProof: () => HandProofData | null;
  /** Snapshot copy of all move proofs collected so far. */
  getMoveProofs: () => MoveProofData[];
  /** Resolves when both hand proofs exist; rejects after timeoutMs. */
  waitForHandProofs: (timeoutMs: number) => Promise<void>;
  /** Resolves when all TOTAL_MOVES move proofs exist; rejects after timeoutMs. */
  waitForMoveProofs: (timeoutMs: number) => Promise<void>;
  restoreFromSave: (saved: PersistedGameState) => void;
  resetForMenu: () => void;
}

/**
 * Proof orchestration for an in-progress game: hand/move proof generation,
 * the pending-move queue (moves made before hand proofs are ready), board
 * state history for deferred proof generation, and proof exchange over
 * WebSocket.
 *
 * Ref-vs-state split (see useGame.ts for the architecture rationale):
 *   cardIdsRef:          Snapshot of card IDs for proof generation closures.
 *   moveProofsRef:       Always-current move proof array (avoids stale closure
 *                        in settlement's execute callback).
 *   myHandProofRef,
 *   opponentHandProofRef: Same pattern — latest proof values for settlement.
 *   pendingMovesRef:     Moves queued before hand proofs are ready, each with
 *                        the full pre-move state (board+hands+scores+turn)
 *                        captured at queue time for deferred proof generation.
 *   handProofSubmittedRef,
 *   handProofGeneratedRef: Idempotency guards preventing duplicate operations.
 *   moveProofsCompleteRef,
 *   handProofsCompleteRef: Promise resolvers for cross-concern synchronization
 *                        (registered by waitFor*, resolved by effects below).
 */
export function useGamePlay({ ws, cardIds, blindingFactor }: UseGamePlayParams): UseGamePlayReturn {
  const aztec = useAztecContext();
  const proofs = useProofGeneration();

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

  // Ref to always access latest move proofs (avoids stale closure in settlement)
  const moveProofsRef = useRef(collectedMoveProofs);
  moveProofsRef.current = collectedMoveProofs;

  // Idempotency guards (kept)
  const handProofSubmittedRef = useRef(false);
  const handProofGeneratedRef = useRef(false);

  // Promise-based settlement wait (replaces busy-polling)
  const moveProofsCompleteRef = useRef<(() => void) | null>(null);

  // Refs for hand proofs (avoids stale closures in settlement)
  const myHandProofRef = useRef(myHandProof);
  myHandProofRef.current = myHandProof;
  const opponentHandProofRef = useRef(opponentHandProof);
  opponentHandProofRef.current = opponentHandProof;

  // Promise-based hand proof wait (same pattern as moveProofsCompleteRef)
  const handProofsCompleteRef = useRef<(() => void) | null>(null);

  // Queue of moves made before hand proofs were ready. Each entry captures the
  // FULL pre-move game state (board + hands + scores + turn) at queue time, so
  // the deferred processor can replay the move against the exact board the
  // player acted on — no later board-state lookup (the snapshot-keying bug: a
  // count-keyed history map returned a board that already contained the queued
  // card under 4.3.1 broadcast timing → game_move "Card already placed"). The
  // per-cell original owners the C2 replay guard needs are derived from
  // `board` at proof time (publicly agreed — no chaining, no relay).
  const pendingMovesRef = useRef<Array<{
    card: Card;
    board: GameState['board']; p1Hand: Card[]; p2Hand: Card[];
    scores: [number, number]; currentTurn: 'player1' | 'player2';
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
      console.log('[useGamePlay] Hand proof effect: waiting for gameId/gameState');
      return;
    }
    if (ws.gameState.status !== 'playing' && ws.gameState.status !== 'finished') {
      console.log('[useGamePlay] Hand proof effect: game status is', ws.gameState.status, '(need playing/finished)');
      return;
    }
    if (cardIds.length !== 5) {
      console.log('[useGamePlay] Hand proof effect: cardIds.length =', cardIds.length, '(need 5)');
      return;
    }
    if (!blindingFactor) {
      console.log('[useGamePlay] Hand proof effect: blindingFactor not set yet');
      return;
    }
    if (!ws.opponentGameRandomness || ws.opponentGameRandomness.length !== 6) {
      console.log('[useGamePlay] Hand proof effect: opponentGameRandomness not received yet (have:', ws.opponentGameRandomness?.length ?? 0, 'need 6)');
      return;
    }

    console.log('[useGamePlay] Hand proof effect: all preconditions met — generating proof');
    handProofGeneratedRef.current = true;
    generateHandProofFromState(cardIds, ws.opponentGameRandomness).catch(err => {
      console.error('[useGamePlay] Hand proof generation failed:', err);
      handProofGeneratedRef.current = false;
    });
  }, [ws.gameId, ws.gameState, cardIds, blindingFactor, ws.opponentGameRandomness, generateHandProofFromState]);

  // Resolve hand proof wait promise when both proofs are available
  useEffect(() => {
    if (myHandProof && opponentHandProof && handProofsCompleteRef.current) {
      console.log('[useGamePlay] Both hand proofs ready — resolving settlement wait');
      handProofsCompleteRef.current();
      handProofsCompleteRef.current = null;
    }
  }, [myHandProof, opponentHandProof]);

  // Process queued moves once both hand proofs are available.
  useEffect(() => {
    if (!myHandProof || !opponentHandProof) return;
    if (pendingMovesRef.current.length === 0 || !ws.gameId || !ws.playerNumber) return;

    const pending = pendingMovesRef.current.splice(0);
    console.log(`[useGamePlay] Processing ${pending.length} queued move(s)`);

    (async () => {
      for (const move of pending) {
        try {
          // Apply the move using the pure game logic function
          const { placeCard: applyMove } = await import('@axolotl-arena/game-logic');
          const myPlayer = ws.playerNumber === 1 ? 'player1' : 'player2';

          // Replay against the FULL pre-move state captured at queue time —
          // the exact board the player acted on, which by construction does
          // NOT yet contain this card. (The old count-keyed history lookup
          // could return a board that already held it.)
          const syntheticState: GameState = {
            board: move.board,
            player1Hand: move.p1Hand,
            player2Hand: move.p2Hand,
            currentTurn: move.currentTurn,
            player1Score: move.scores[0],
            player2Score: move.scores[1],
            status: 'playing',
            winner: null,
          };

          const result = applyMove(syntheticState, myPlayer, move.handIndex, move.row, move.col);
          const boardAfter = result.newState.board;
          const scoresBefore: [number, number] = move.scores;
          const scoresAfter: [number, number] = [result.newState.player1Score, result.newState.player2Score];
          const gameEnded = result.newState.status === 'finished';
          const winnerId = mapWinnerId(result.newState.winner);

          const moveProof = await generateMoveProofForPlacement(
            move.card.id, move.row, move.col, ws.playerNumber!,
            move.board, boardAfter,
            scoresBefore, scoresAfter,
            gameEnded, winnerId,
          );
          if (moveProof && ws.gameId) {
            ws.submitMoveProof(ws.gameId, move.handIndex, move.row, move.col, moveProof, move.moveNumber);
          }
        } catch (err) {
          console.warn('[useGamePlay] Deferred move proof failed:', err);
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

  // --- User actions ---

  const handlePlaceCard = useCallback(async (handIndex: number, row: number, col: number) => {
    if (!ws.gameState || !ws.playerNumber || !ws.gameId) return;

    const myHand = ws.playerNumber === 1 ? ws.gameState.player1Hand : ws.gameState.player2Hand;
    const card = myHand[handIndex];

    // Move number = the global count of cards already on the board (both
    // players). ws.placeCard only sends to the backend; the local board
    // updates from broadcasts, so ws.gameState here IS the authoritative
    // pre-move board (the player acts on their turn, their card not yet on it).
    let moveNumber = 0;
    for (const r of ws.gameState.board) {
      for (const cell of r) {
        if (cell.card !== null) moveNumber++;
      }
    }

    // Capture the pre-move board as a DEEP CLONE at click time. Move-proof
    // generation is async/queued, so passing the live ws.gameState.board into
    // it lets a later board update change what the proof encodes → game_move
    // "Card already placed". (P1's early moves go through the deferred path,
    // which already clones at queue time; P2/the joiner moves with both hand
    // proofs ready and hits THIS immediate path — same bug, different player.)
    // Nothing below reads live ws.gameState.board.
    const preMoveState: GameState = { ...ws.gameState, board: structuredClone(ws.gameState.board) };
    const boardBefore = preMoveState.board;

    ws.placeCard(handIndex, row, col);

    if (aztec.isAvailable && card) {
      try {
        const { placeCard: applyMove } = await import('@axolotl-arena/game-logic');
        const myPlayer = ws.playerNumber === 1 ? 'player1' : 'player2';
        const result = applyMove(preMoveState, myPlayer, handIndex, row, col);
        const boardAfter = result.newState.board;
        const scoresBefore: [number, number] = [preMoveState.player1Score, preMoveState.player2Score];
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
          // Queue the full pre-move state (the board is already a deep clone)
          // so the deferred processor replays against the exact board, hands,
          // scores, and turn the player acted on — independent of later
          // ws.gameState changes. Original owners are re-derived from `board`.
          pendingMovesRef.current.push({
            card,
            board: preMoveState.board,
            p1Hand: [...preMoveState.player1Hand],
            p2Hand: [...preMoveState.player2Hand],
            scores: [preMoveState.player1Score, preMoveState.player2Score],
            currentTurn: preMoveState.currentTurn,
            handIndex, row, col, moveNumber,
          });
        }
      } catch (err) {
        console.warn('[useGamePlay] Move proof generation failed:', err);
      }
    }
  }, [ws, aztec.isAvailable, myHandProof, opponentHandProof, generateMoveProofForPlacement]);

  // --- Stable cross-hook accessors ---

  const getMyHandProof = useCallback((): HandProofData | null => myHandProofRef.current, []);
  const getOpponentHandProof = useCallback((): HandProofData | null => opponentHandProofRef.current, []);
  const getMoveProofs = useCallback((): MoveProofData[] => [...moveProofsRef.current], []);

  const waitForHandProofs = useCallback((timeoutMs: number): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      if (myHandProofRef.current && opponentHandProofRef.current) { resolve(); return; }
      handProofsCompleteRef.current = resolve;
      setTimeout(() => {
        handProofsCompleteRef.current = null;
        reject(new Error(
          `Timed out waiting for hand proofs (${timeoutMs / 1000}s). ` +
          `my: ${!!myHandProofRef.current}, opponent: ${!!opponentHandProofRef.current}`,
        ));
      }, timeoutMs);
    });
  }, []);

  const waitForMoveProofs = useCallback((timeoutMs: number): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      if (moveProofsRef.current.length >= TOTAL_MOVES) { resolve(); return; }
      moveProofsCompleteRef.current = resolve;
      setTimeout(() => {
        moveProofsCompleteRef.current = null;
        reject(new Error(`Timed out waiting for move proofs: have ${moveProofsRef.current.length}/${TOTAL_MOVES}`));
      }, timeoutMs);
    });
  }, []);

  // --- Facade integration ---

  // Restores the opponent's proofs only: myHandProof is intentionally NOT
  // restored — handProofGeneratedRef is fresh after a reload, so our own
  // hand proof regenerates from the saved card IDs + blinding factor.
  const restoreFromSave = useCallback((saved: PersistedGameState): void => {
    if (saved.opponentHandProof) setOpponentHandProof(saved.opponentHandProof);
    if (saved.collectedMoveProofs) {
      for (const mp of saved.collectedMoveProofs) addMoveProof(mp);
    }
  }, [addMoveProof]);

  const resetForMenu = useCallback((): void => {
    handProofSubmittedRef.current = false;
    pendingMovesRef.current = [];
    handProofGeneratedRef.current = false;
    moveProofsCompleteRef.current = null;
    handProofsCompleteRef.current = null;
    setMyHandProof(null);
    setOpponentHandProof(null);
    setCollectedMoveProofs([]);
    setHandProofStatus('idle');
    setMoveProofStatus('idle');
    cardIdsRef.current = [];
    proofs.reset();
  }, [proofs.reset]);

  return {
    myHandProof,
    opponentHandProof,
    collectedMoveProofs,
    handProofStatus,
    moveProofStatus,
    canSettle,
    handlePlaceCard,
    getMyHandProof,
    getOpponentHandProof,
    getMoveProofs,
    waitForHandProofs,
    waitForMoveProofs,
    restoreFromSave,
    resetForMenu,
  };
}
