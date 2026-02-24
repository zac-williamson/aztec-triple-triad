import { useState, useCallback, useRef } from 'react';
import type { HandProofData, MoveProofData, GameState, Card } from '../types';

/**
 * Proof generation status
 */
export type ProofStatus = 'idle' | 'generating' | 'ready' | 'error';

/**
 * Board state encoded as flat array for the circuit.
 * Each cell = [card_id, owner] where owner 0=empty, 1=player1, 2=player2.
 */
function encodeBoardState(board: GameState['board']): string[] {
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

/**
 * Compute a simple state hash for board state (matches circuit's hash_board_state).
 * This is a client-side approximation - the actual circuit uses Pedersen hash.
 */
function computeStateHash(
  board: string[],
  scores: [number, number],
  currentTurn: number,
): string {
  // In production, this would use the same Pedersen hash as the circuit.
  // For now, we create a deterministic string representation.
  const data = [...board, String(scores[0]), String(scores[1]), String(currentTurn)];
  return data.join(',');
}

export interface UseProofGenerationReturn {
  /** Current status of proof generation */
  handProofStatus: ProofStatus;
  moveProofStatus: ProofStatus;
  /** Generated hand proof */
  handProof: HandProofData | null;
  /** Generated move proofs (accumulated over the game) */
  moveProofs: MoveProofData[];
  /** Error message if proof generation failed */
  error: string | null;
  /** Generate a hand proof for the given cards */
  generateHandProof: (
    cardIds: number[],
    cardRanks: Array<{ top: number; right: number; bottom: number; left: number }>,
    playerAddress: string,
    gameId: string,
    playerSecret: string,
    nullifierSecrets: string[],
  ) => Promise<HandProofData | null>;
  /** Generate a move proof for placing a card */
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
  ) => Promise<MoveProofData | null>;
  /** Reset all proof state */
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
    ): Promise<HandProofData | null> => {
      setHandProofStatus('generating');
      setError(null);

      try {
        // Try to use the Noir proof generation infrastructure
        // In production, this would:
        // 1. Load the prove_hand circuit artifact
        // 2. Set up witnesses with the private inputs
        // 3. Generate the proof using bb.js (Barretenberg WASM)
        // 4. Return the serialized proof and public inputs

        let proofData: HandProofData;

        try {
          // Attempt to dynamically load and use the proof generation library
          const { generateProveHandProof } = await import('../aztec/proofWorker');
          proofData = await generateProveHandProof(
            cardIds,
            cardRanks,
            playerAddress,
            gameId,
            playerSecret,
            nullifierSecrets,
          );
        } catch {
          // Fallback: create a placeholder proof for WebSocket-only mode
          console.warn('[useProofGeneration] Proof generation unavailable, using placeholder');
          const cardCommit = computeCardCommitPlaceholder(
            playerSecret,
            playerAddress,
            gameId,
            cardIds,
            cardRanks,
            nullifierSecrets,
          );

          proofData = {
            proof: 'placeholder_hand_proof',
            publicInputs: [cardCommit, playerAddress, gameId],
            cardCommit,
            playerAddress,
            gameId,
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
    ): Promise<MoveProofData | null> => {
      // Queue proof generation to avoid overlapping operations
      const proofPromise = new Promise<MoveProofData | null>((resolve) => {
        proofQueueRef.current = proofQueueRef.current.then(async () => {
          setMoveProofStatus('generating');
          setError(null);

          try {
            const boardBeforeEncoded = encodeBoardState(boardBefore);
            const boardAfterEncoded = encodeBoardState(boardAfter);
            const turnBefore = currentPlayer;
            const startStateHash = computeStateHash(boardBeforeEncoded, scoresBefore, turnBefore);
            const nextTurn = currentPlayer === 1 ? 2 : 1;
            const endStateHash = computeStateHash(boardAfterEncoded, scoresAfter, nextTurn);

            let proofData: MoveProofData;

            try {
              const { generateGameMoveProof } = await import('../aztec/proofWorker');
              proofData = await generateGameMoveProof(
                cardId,
                row,
                col,
                currentPlayer,
                boardBeforeEncoded,
                boardAfterEncoded,
                scoresBefore,
                scoresAfter,
                cardCommit1,
                cardCommit2,
                gameEnded,
                winnerId,
              );
            } catch {
              // Fallback: placeholder proof
              console.warn('[useProofGeneration] Move proof generation unavailable, using placeholder');
              proofData = {
                proof: 'placeholder_move_proof',
                publicInputs: [
                  cardCommit1,
                  cardCommit2,
                  startStateHash,
                  endStateHash,
                  gameEnded ? '1' : '0',
                  String(winnerId),
                ],
                cardCommit1,
                cardCommit2,
                startStateHash,
                endStateHash,
                gameEnded,
                winnerId,
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
 * In production, this would use Pedersen hash matching the circuit.
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
    playerSecret,
    playerAddress,
    gameId,
    ...cardIds.map(String),
    ...cardRanks.flatMap((r) => [String(r.top), String(r.right), String(r.bottom), String(r.left)]),
    ...nullifierSecrets,
  ];
  // Simple deterministic hash for placeholder mode
  let hash = 0;
  const str = data.join(':');
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return '0x' + Math.abs(hash).toString(16).padStart(8, '0');
}
