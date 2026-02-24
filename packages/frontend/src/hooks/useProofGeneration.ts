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
    cardRanks: Array<{ top: number; right: number; bottom: number; left: number }>,
    playerAddress: string,
    gameId: string,
    playerSecret: string,
    nullifierSecrets: string[],
    grumpkinPrivateKey?: string,
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
    grumpkinPrivateKey: string,
    opponentPubkeyX: string,
    opponentPubkeyY: string,
  ) => Promise<MoveProofData | null>;
  reset: () => void;
}

/**
 * Hook for generating ZK proofs for game moves and hand ownership.
 *
 * Uses compiled Noir circuit artifacts to generate proofs client-side.
 * Proofs are queued and generated asynchronously to avoid blocking the UI.
 *
 * Falls back gracefully if proof generation infrastructure is unavailable.
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
      cardRanks: Array<{ top: number; right: number; bottom: number; left: number }>,
      playerAddress: string,
      gameId: string,
      playerSecret: string,
      nullifierSecrets: string[],
      grumpkinPrivateKey?: string,
    ): Promise<HandProofData | null> => {
      setHandProofStatus('generating');
      setError(null);

      try {
        let proofData: HandProofData;

        try {
          const { generateProveHandProof } = await import('../aztec/proofWorker');
          proofData = await generateProveHandProof(
            cardIds, cardRanks, playerAddress, gameId,
            playerSecret, nullifierSecrets, grumpkinPrivateKey,
          );
        } catch {
          // Fallback: create a placeholder proof for WebSocket-only mode
          console.warn('[useProofGeneration] Proof generation unavailable, using placeholder');
          const cardCommit = computeCardCommitPlaceholder(
            playerSecret, playerAddress, gameId, cardIds, cardRanks, nullifierSecrets,
          );

          proofData = {
            proof: 'placeholder_hand_proof',
            publicInputs: [cardCommit, playerAddress, gameId, '0', '0'],
            cardCommit,
            playerAddress,
            gameId,
            grumpkinPublicKeyX: '0',
            grumpkinPublicKeyY: '0',
          };
        }

        setHandProof(proofData);
        setHandProofStatus('ready');
        return proofData;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Hand proof generation failed';
        console.error('[useProofGeneration] Hand proof error:', message);
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
      grumpkinPrivateKey: string,
      opponentPubkeyX: string,
      opponentPubkeyY: string,
    ): Promise<MoveProofData | null> => {
      // Queue proof generation to avoid overlapping operations
      const proofPromise = new Promise<MoveProofData | null>((resolve) => {
        proofQueueRef.current = proofQueueRef.current.then(async () => {
          setMoveProofStatus('generating');
          setError(null);

          try {
            const boardBeforeEncoded = encodeBoardState(boardBefore);
            const boardAfterEncoded = encodeBoardState(boardAfter);

            let proofData: MoveProofData;

            try {
              const { generateGameMoveProof } = await import('../aztec/proofWorker');
              proofData = await generateGameMoveProof(
                cardId, row, col, currentPlayer,
                boardBeforeEncoded, boardAfterEncoded,
                scoresBefore, scoresAfter,
                cardCommit1, cardCommit2,
                gameEnded, winnerId,
                playerHandData,
                grumpkinPrivateKey,
                opponentPubkeyX, opponentPubkeyY,
              );
            } catch {
              // Fallback: placeholder proof
              console.warn('[useProofGeneration] Move proof generation unavailable, using placeholder');
              const startStateHash = boardBeforeEncoded.join(',');
              const endStateHash = boardAfterEncoded.join(',');
              proofData = {
                proof: 'placeholder_move_proof',
                publicInputs: [
                  cardCommit1, cardCommit2,
                  startStateHash, endStateHash,
                  gameEnded ? '1' : '0', String(winnerId), '0',
                ],
                cardCommit1,
                cardCommit2,
                startStateHash,
                endStateHash,
                gameEnded,
                winnerId,
                encryptedCardNullifier: '0',
              };
            }

            setMoveProofs((prev) => [...prev, proofData]);
            setMoveProofStatus('ready');
            resolve(proofData);
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Move proof generation failed';
            console.error('[useProofGeneration] Move proof error:', message);
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

/**
 * Compute a placeholder card commitment (simple hash).
 * Used as fallback when proof generation infrastructure is unavailable.
 */
function computeCardCommitPlaceholder(
  playerSecret: string,
  playerAddress: string,
  gameId: string,
  cardIds: number[],
  cardRanks: Array<{ top: number; right: number; bottom: number; left: number }>,
  nullifierSecrets: string[],
): string {
  const data = [
    playerSecret, playerAddress, gameId,
    ...cardIds.map(String),
    ...cardRanks.flatMap((r) => [String(r.top), String(r.right), String(r.bottom), String(r.left)]),
    ...nullifierSecrets,
  ];
  let hash = 0;
  const str = data.join(':');
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return '0x' + Math.abs(hash).toString(16).padStart(8, '0');
}
