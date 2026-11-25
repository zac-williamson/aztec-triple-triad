import { useState, useCallback, useEffect, useRef } from 'react';
import { useProofGeneration } from './useProofGeneration';
import type { PlayerHandData, ProofStatus } from './useProofGeneration';
import type { UseWebSocketReturn } from './useWebSocket';
import type { PersistedGameState } from './useGameStorage';
import { useAztecContext } from '../aztec/AztecContext';
import { TOTAL_MOVES } from '../aztec/gameConstants';
import type { GameState, Card, MoveProofData, Player } from '../types';

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
  /** The 5 card IDs the player selected for this game, in COMMITTED order. */
  cardIds: number[];
  /** Our hand blinding factor (compute_game_secrets) — proofs cannot generate without it. */
  blindingFactor: string | null;
  /** Both hand commitments, from the two records, once both are known. */
  commits: { commit1: string; commit2: string } | null;
}

export interface UseGamePlayReturn {
  // UI-rendered state
  collectedMoveProofs: MoveProofData[];
  /** Moves played whose proof the opponent has not received yet. */
  owedMoveProofs: number;
  moveProofStatus: ProofStatus;
  /** Both records known and all nine move proofs collected. */
  canSettle: boolean;

  // Actions
  handlePlaceCard: (handIndex: number, row: number, col: number) => Promise<void>;

  // Stable functions (identity never changes) — safe to close over in
  // async callbacks and to list in other hooks' useCallback deps.
  /** Snapshot copy of all move proofs collected so far. */
  getMoveProofs: () => MoveProofData[];
  /** Resolves when all TOTAL_MOVES move proofs exist; rejects after timeoutMs. */
  waitForMoveProofs: (timeoutMs: number) => Promise<void>;
  restoreFromSave: (saved: PersistedGameState) => void;
  resetForMenu: () => void;
}

/**
 * Proof orchestration for an in-progress game: move proof generation, the
 * pending-move queue (moves made before both hand commitments are known),
 * and proof exchange over WebSocket.
 *
 * There are no hand proofs (docs/plan/PRIVATE_GAMES.md section 4): each
 * move proof binds both players' hand commitments, which come from the two
 * records committed on-chain, and publishes the placed card and its slot in
 * the mover's committed hand.
 *
 * Ref-vs-state split (see useGame.ts for the architecture rationale):
 *   cardIdsRef:          The committed hand, for proof generation closures.
 *   moveProofsRef:       Always-current move proof array (avoids stale closure
 *                        in settlement's callbacks).
 *   pendingMovesRef:     Moves queued before the commitments are known, each
 *                        with the full pre-move state (board+hands+scores+turn)
 *                        captured at queue time for deferred proof generation.
 *   moveProofsCompleteRef: Promise resolver for the settlement's wait.
 */
export function useGamePlay({ ws, cardIds, blindingFactor, commits }: UseGamePlayParams): UseGamePlayReturn {
  const aztec = useAztecContext();
  const proofs = useProofGeneration();

  // --- Proof state ---
  const [collectedMoveProofs, setCollectedMoveProofs] = useState<MoveProofData[]>([]);
  const [moveProofStatus, setMoveProofStatus] = useState<ProofStatus>('idle');
  /**
   * Moves we have PLAYED but whose proof the opponent has not received yet —
   * still generating, or queued until both hand commitments are known.
   *
   * This is the opponent's problem, not ours, which is exactly why it needs
   * tracking. The 9-link transcript is shared: if we close the tab while owing
   * a proof, the WINNER can never settle and both hands stay locked. The last
   * move is the dangerous one — its proof is generated AFTER the relay declares
   * the game over, i.e. precisely when a losing player closes the tab.
   */
  const [owedMoveProofs, setOwedMoveProofs] = useState(0);
  const owe = useCallback((n: number) => setOwedMoveProofs(v => Math.max(0, v + n)), []);

  // The committed hand: a move proof's `placed_slot` is the card's index in it.
  const cardIdsRef = useRef<number[]>(cardIds);
  cardIdsRef.current = cardIds;
  /** Everything a move proof needs from the session: both commitments and our blinding. */
  const proofsReady = commits !== null && blindingFactor !== null;
  const canSettle = commits !== null && collectedMoveProofs.length >= TOTAL_MOVES;

  // Ref to always access latest move proofs (avoids stale closure in settlement)
  const moveProofsRef = useRef(collectedMoveProofs);
  moveProofsRef.current = collectedMoveProofs;

  // Promise-based settlement wait (replaces busy-polling)
  const moveProofsCompleteRef = useRef<(() => void) | null>(null);

  // Queue of moves made before the commitments were known. Each entry captures the
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
      if (!commits) throw new Error('Cannot generate move proof: hand commitments not known yet');
      if (!blindingFactor) throw new Error('Cannot generate move proof: no blinding factor');

      // card_commit_1 / card_commit_2 are the creator's and the joiner's,
      // whoever is moving — exactly the records' hand commitments.
      const { commit1, commit2 } = commits;

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
    [commits, blindingFactor, proofs.generateMoveProof, addMoveProof],
  );

  // --- Effects ---

  // Receive opponent move proof from WebSocket
  useEffect(() => {
    if (!ws.lastMoveProof) return;
    addMoveProof(ws.lastMoveProof.moveProof);
  }, [ws.lastMoveProof, addMoveProof]);

  // Process queued moves once both commitments (and our blinding) are known.
  useEffect(() => {
    if (!proofsReady) return;
    if (pendingMovesRef.current.length === 0 || !ws.gameId || !ws.playerNumber) return;

    const pending = pendingMovesRef.current.splice(0);
    console.log(`[useGamePlay] Processing ${pending.length} queued move(s)`);

    // Captured BEFORE any awaiting. Reading ws.gameId after the proof comes
    // back drops it if the player has left the game meanwhile — and the proof
    // of the move that ENDED the game is exactly the one the winner needs to
    // settle. The bot had the same bug and it stranded five cards a side on
    // production: the winner sat at 8/9 for a proof that was never coming.
    const proofGameId = ws.gameId;

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
          if (moveProof && proofGameId) {
            ws.submitMoveProof(proofGameId, move.handIndex, move.row, move.col, moveProof, move.moveNumber);
          }
        } catch (err) {
          console.warn('[useGamePlay] Deferred move proof failed:', err);
        } finally {
          owe(-1);
        }
      }
    })();
  }, [proofsReady]); // eslint-disable-line react-hooks/exhaustive-deps

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

        if (proofsReady) {
          owe(+1);
          // Captured before awaiting, for the same reason as the deferred path
          // above: leaving the game while this proof generates must not discard
          // it, because the last move's proof is what lets the winner settle.
          const proofGameId = ws.gameId;
          try {
            const moveProof = await generateMoveProofForPlacement(
              card.id, row, col, ws.playerNumber,
              boardBefore, boardAfter,
              scoresBefore, scoresAfter,
              gameEnded, winnerId,
            );
            ws.submitMoveProof(proofGameId, handIndex, row, col, moveProof, moveNumber);
          } finally {
            // Cleared even on failure: the proof is not coming, so holding the
            // unload guard up forever would only trap the player in a tab that
            // can no longer help anybody.
            owe(-1);
          }
        } else {
          // Queue the full pre-move state (the board is already a deep clone)
          // so the deferred processor replays against the exact board, hands,
          // scores, and turn the player acted on — independent of later
          // ws.gameState changes. Original owners are re-derived from `board`.
          owe(+1);
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
  }, [ws, aztec.isAvailable, proofsReady, generateMoveProofForPlacement]);

  // --- Stable cross-hook accessors ---

  const getMoveProofs = useCallback((): MoveProofData[] => [...moveProofsRef.current], []);

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

  // The transcript comes back from the saved game; the commitments and our
  // blinding come back through the session.
  const restoreFromSave = useCallback((saved: PersistedGameState): void => {
    if (saved.collectedMoveProofs) {
      for (const mp of saved.collectedMoveProofs) addMoveProof(mp);
    }
  }, [addMoveProof]);

  const resetForMenu = useCallback((): void => {
    pendingMovesRef.current = [];
    moveProofsCompleteRef.current = null;
    setCollectedMoveProofs([]);
    setMoveProofStatus('idle');
    proofs.reset();
  }, [proofs.reset]);

  return {
    collectedMoveProofs,
    owedMoveProofs,
    moveProofStatus,
    canSettle,
    handlePlaceCard,
    getMoveProofs,
    waitForMoveProofs,
    restoreFromSave,
    resetForMenu,
  };
}
