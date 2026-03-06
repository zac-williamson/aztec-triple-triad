import { useCallback, useRef } from 'react';
import type { HandProofData, MoveProofData, GameState } from '../types';
import type { PlayerHandData } from '../aztec/proofWorker';

export type { PlayerHandData };

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
  generateHandProof: (
    cardIds: number[],
    blindingFactor: string,
    cardCommitHash: string,
    opponentRandomness: string[],
    opponentPlayerStateHash: string,
  ) => Promise<HandProofData>;
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
  ) => Promise<MoveProofData>;
  reset: () => void;
}

/**
 * Stateless proof generation hook.
 * Provides sequential move proof queuing (to avoid concurrent WASM usage)
 * but does NOT track proof state — callers own their proof collections.
 */
export function useProofGeneration(): UseProofGenerationReturn {
  const proofQueueRef = useRef<Promise<void>>(Promise.resolve());

  const generateHandProof = useCallback(
    async (
      cardIds: number[],
      blindingFactor: string,
      cardCommitHash: string,
      opponentRandomness: string[],
      opponentPlayerStateHash: string,
    ): Promise<HandProofData> => {
      const { generateProveHandProof } = await import('../aztec/proofWorker');
      return generateProveHandProof(
        cardIds, blindingFactor, cardCommitHash,
        opponentRandomness, opponentPlayerStateHash,
      );
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
    ): Promise<MoveProofData> => {
      return new Promise<MoveProofData>((resolve, reject) => {
        proofQueueRef.current = proofQueueRef.current.then(async () => {
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
            resolve(proofData);
          } catch (err) {
            reject(err);
          }
        });
      });
    },
    [],
  );

  const reset = useCallback(() => {
    proofQueueRef.current = Promise.resolve();
  }, []);

  return { generateHandProof, generateMoveProof, reset };
}
