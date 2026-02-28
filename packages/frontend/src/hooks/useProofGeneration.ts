import { useState, useCallback, useRef } from 'react';
import type { HandProofData, MoveProofData, GameState } from '../types';
import type { PlayerHandData } from '../aztec/proofWorker';

export type { PlayerHandData };

/**
 * Proof generation status
 */
export type ProofStatus = 'idle' | 'generating' | 'ready' | 'error';

/**
 * Board state encoded as flat array for the circuit.
 * Each cell = [card_id, owner] where owner 0=empty, 1=player1, 2=player2.
 */
export function encodeBoardState(board: GameState['board']): string[] {
  const flat: string[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cell = board[r][c];
      flat.push(cell.card ? String(cell.card.id) : '0');
      flat.push(
        cell.owner === 'player1' ? '1' : cell.owner === 'player2' ? '2' : '0',
      );
    }
  }
  return flat;
}

export interface UseProofGenerationReturn {
  handProofStatus: ProofStatus;
  moveProofStatus: ProofStatus;
  handProof: HandProofData | null;
  moveProofs: MoveProofData[];
  error: string | null;
  generateHandProof: (
    cardIds: number[],
    blindingFactor: string,
    cardCommitHash: string,
  ) => Promise<HandProofData | null>;
  generateMoveProof: (
    cardId: number,
    row: number,
    col: number,
    currentPlayer: 1 | 2,
    boardBefore: GameState['board'],
    boardAfter: GameState['board'],
    scoresBefore: [number, number],
    scoresAfter: [number, number],
    cardCommit1: string,
    cardCommit2: string,
    gameEnded: boolean,
    winnerId: number,
    playerHandData: PlayerHandData,
  ) => Promise<MoveProofData | null>;
  reset: () => void;
}

/**
 * Hook for generating ZK proofs for game moves and hand ownership.
 */
export function useProofGeneration(): UseProofGenerationReturn {
  const [handProofStatus, setHandProofStatus] = useState<ProofStatus>('idle');
  const [moveProofStatus, setMoveProofStatus] = useState<ProofStatus>('idle');
  const [handProof, setHandProof] = useState<HandProofData | null>(null);
  const [moveProofs, setMoveProofs] = useState<MoveProofData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const proofQueueRef = useRef<Promise<void>>(Promise.resolve());

  const generateHandProof = useCallback(
    async (
      cardIds: number[],
      blindingFactor: string,
      cardCommitHash: string,
    ): Promise<HandProofData | null> => {
      setHandProofStatus('generating');
      setError(null);

      try {
        const { generateProveHandProof } = await import('../aztec/proofWorker');
        const proofData = await generateProveHandProof(
          cardIds, blindingFactor, cardCommitHash,
        );

        setHandProof(proofData);
        setHandProofStatus('ready');
        return proofData;
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        let message: string;
        if (rawMsg.includes('witness')) {
          message = 'Circuit witness generation failed. This usually means input values are invalid.';
        } else if (rawMsg.includes('memory') || rawMsg.includes('OOM')) {
          message = 'Out of memory. Try closing other browser tabs.';
        } else {
          message = `Hand proof generation failed: ${rawMsg}`;
        }
        console.error('[useProofGeneration] Hand proof error:', rawMsg);
        setError(message);
        setHandProofStatus('error');
        return null;
      }
    },
    [],
  );

  const generateMoveProof = useCallback(
    async (
      cardId: number,
      row: number,
      col: number,
      currentPlayer: 1 | 2,
      boardBefore: GameState['board'],
      boardAfter: GameState['board'],
      scoresBefore: [number, number],
      scoresAfter: [number, number],
      cardCommit1: string,
      cardCommit2: string,
      gameEnded: boolean,
      winnerId: number,
      playerHandData: PlayerHandData,
    ): Promise<MoveProofData | null> => {
      const proofPromise = new Promise<MoveProofData | null>((resolve) => {
        proofQueueRef.current = proofQueueRef.current.then(async () => {
          setMoveProofStatus('generating');
          setError(null);

          try {
            const boardBeforeEncoded = encodeBoardState(boardBefore);
            const boardAfterEncoded = encodeBoardState(boardAfter);

            const { generateGameMoveProof } = await import('../aztec/proofWorker');
            const proofData = await generateGameMoveProof(
              cardId, row, col, currentPlayer,
              boardBeforeEncoded, boardAfterEncoded,
              scoresBefore, scoresAfter,
              cardCommit1, cardCommit2,
              gameEnded, winnerId,
              playerHandData,
            );

            setMoveProofs((prev) => [...prev, proofData]);
            setMoveProofStatus('ready');
            resolve(proofData);
          } catch (err) {
            const rawMsg = err instanceof Error ? err.message : String(err);
            let message: string;
            if (rawMsg.includes('witness')) {
              message = 'Circuit witness generation failed. This usually means input values are invalid.';
            } else if (rawMsg.includes('memory') || rawMsg.includes('OOM')) {
              message = 'Out of memory. Try closing other browser tabs.';
            } else {
              message = `Move proof generation failed: ${rawMsg}`;
            }
            console.error('[useProofGeneration] Move proof error:', rawMsg);
            setError(message);
            setMoveProofStatus('error');
            resolve(null);
          }
        });
      });

      return proofPromise;
    },
    [],
  );

  const reset = useCallback(() => {
    setHandProofStatus('idle');
    setMoveProofStatus('idle');
    setHandProof(null);
    setMoveProofs([]);
    setError(null);
  }, []);

  return {
    handProofStatus,
    moveProofStatus,
    handProof,
    moveProofs,
    error,
    generateHandProof,
    generateMoveProof,
    reset,
  };
}
