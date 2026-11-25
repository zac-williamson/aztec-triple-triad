import { useCallback } from 'react';
import type { MoveProofData, GameState } from '../types';
import type { PlayerHandData } from '../aztec/proofWorker';
import type { OpenCardsPayload } from '../aztec/localGame';
import { encodeBoardState, encodeOriginalOwners } from '../aztec/localGame';
import { onProver } from '../aztec/proverQueue';

export type { PlayerHandData };
// The circuit encodings live with the client's game model; re-exported here
// for the callers that have always found them in this module.
export { encodeBoardState, encodeOriginalOwners };

export type ProofStatus = 'idle' | 'generating' | 'ready' | 'error';

export interface UseProofGenerationReturn {
  /** `playerHandData.cardIds` is the mover's hand in COMMITTED order: the
   *  placed card's index in it is the proof's public `placed_slot`. */
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
  /** Prove our three open cards (the committed hand's slots 0..2) against our hand commitment. */
  generateOpenCardsProof: (hand: number[], blindingFactor: string, handCommit: string) => Promise<OpenCardsPayload>;
  reset: () => void;
}

/**
 * Stateless proof generation hook. Every proof goes through the page's one
 * prover line (proverQueue.ts), in the order asked for — no concurrent WASM
 * use — but this hook does NOT track proof state: callers own their proofs.
 */
export function useProofGeneration(): UseProofGenerationReturn {
  const generateMoveProof = useCallback(
    (
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
      // Encoded at call time: the boards are snapshots of the move as made,
      // whatever the live board does while this waits its turn.
      const boardBeforeEncoded = encodeBoardState(boardBefore);
      const boardAfterEncoded = encodeBoardState(boardAfter);
      // Original owners are publicly derivable from each board snapshot —
      // no chaining, no relay (the C2 round-2 fix).
      const originalOwnersBefore = encodeOriginalOwners(boardBefore);
      const originalOwnersAfter = encodeOriginalOwners(boardAfter);
      return onProver(async () => {
        const { generateGameMoveProof } = await import('../aztec/proofWorker');
        return generateGameMoveProof(
          cardId, row, col, currentPlayer,
          boardBeforeEncoded, boardAfterEncoded,
          scoresBefore, scoresAfter,
          cardCommit1, cardCommit2,
          gameEnded, winnerId,
          playerHandData,
          originalOwnersBefore, originalOwnersAfter,
        );
      });
    },
    [],
  );

  const generateOpenCardsProof = useCallback(
    (hand: number[], blindingFactor: string, handCommit: string): Promise<OpenCardsPayload> => {
      const committed = [...hand];
      return onProver(async () => {
        const worker = await import('../aztec/proofWorker');
        return worker.generateOpenCardsProof(committed, blindingFactor, handCommit);
      });
    },
    [],
  );

  // Nothing to reset: proofs already asked for finish on the shared line.
  const reset = useCallback(() => {}, []);

  return { generateMoveProof, generateOpenCardsProof, reset };
}
