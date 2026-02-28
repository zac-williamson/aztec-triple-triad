import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useProofGeneration } from './useProofGeneration';
import type { PlayerHandData } from './useProofGeneration';
import type { GameState, Player, HandProofData, MoveProofData } from '../types';
import { deriveBlindingFactor } from './deriveBlindingFactor';

/**
 * Configuration for the game flow hook
 */
export interface GameFlowConfig {
  gameId: string | null;
  playerNumber: 1 | 2 | null;
  cardIds: number[];
  gameState: GameState | null;
  /** Aztec wallet instance (from useAztec) */
  wallet: unknown | null;
  /** Player's Aztec account address (hex string) */
  accountAddress: string | null;
}

/**
 * Return type for the useGameFlow hook
 */
export interface UseGameFlowReturn {
  /** Our generated hand proof */
  myHandProof: HandProofData | null;
  /** Opponent's hand proof (received via WebSocket) */
  opponentHandProof: HandProofData | null;
  /** All collected move proofs (ours + opponent's, in order) */
  collectedMoveProofs: MoveProofData[];
  /** Whether the current player can settle the game on-chain */
  canSettle: boolean;
  /** Our card commitment string */
  myCardCommit: string | null;
  /** Opponent's card commitment string */
  opponentCardCommit: string | null;
  /** Blinding factor used for proof generation */
  blindingFactor: string;
  /** Current proof generation status */
  handProofStatus: string;
  moveProofStatus: string;
  /** Set the opponent's hand proof (from WebSocket HAND_PROOF message) */
  setOpponentHandProof: (proof: HandProofData) => void;
  /** Add a move proof to the collection (from own generation or opponent relay) */
  addMoveProof: (proof: MoveProofData) => void;
  /** Generate a move proof for the given card placement */
  generateMoveProofForPlacement: (
    cardId: number,
    row: number,
    col: number,
    boardBefore: GameState['board'],
    boardAfter: GameState['board'],
    scoresBefore: [number, number],
    scoresAfter: [number, number],
    gameEnded: boolean,
    winnerId: number,
  ) => Promise<MoveProofData | null>;
  /** Reset all state */
  reset: () => void;
}

/**
 * Hook that orchestrates the full game flow with ZK proof generation.
 *
 * Handles:
 * - Auto-generating hand proof when a game starts
 * - Generating move proofs for each card placement
 * - Collecting all proofs (own + opponent's) for on-chain settlement
 * - Determining when the winner can settle the game
 */
export function useGameFlow(config: GameFlowConfig): UseGameFlowReturn {
  const { gameId, playerNumber, cardIds, gameState, wallet, accountAddress } = config;
  const proofs = useProofGeneration();

  const [myHandProof, setMyHandProof] = useState<HandProofData | null>(null);
  const [opponentHandProof, setOpponentHandProof] = useState<HandProofData | null>(null);
  const [collectedMoveProofs, setCollectedMoveProofs] = useState<MoveProofData[]>([]);
  const [blindingFactor, setBlindingFactor] = useState<string>('');
  const handProofGenerated = useRef(false);
  const blindingDerivationStarted = useRef(false);

  // Derive blinding factor from NFT contract when wallet + game are ready
  useEffect(() => {
    if (!gameId || !playerNumber || !wallet || !accountAddress) return;
    if (blindingDerivationStarted.current) return;
    blindingDerivationStarted.current = true;

    deriveBlindingFactor(wallet, accountAddress, gameId, playerNumber)
      .then(bf => {
        console.log('[useGameFlow] Blinding factor derived:', bf);
        setBlindingFactor(bf);
      })
      .catch(err => {
        console.error('[useGameFlow] Failed to derive blinding factor:', err);
        blindingDerivationStarted.current = false;
      });
  }, [gameId, playerNumber, wallet, accountAddress]);

  // Card commits
  const myCardCommit = myHandProof?.cardCommit ?? null;
  const opponentCardCommit = opponentHandProof?.cardCommit ?? null;

  // Auto-generate hand proof when game starts and blinding factor is derived
  useEffect(() => {
    if (!gameId || !playerNumber || !gameState || handProofGenerated.current) return;
    if (gameState.status !== 'playing') return;
    if (cardIds.length !== 5) return;
    if (!blindingFactor) return;

    handProofGenerated.current = true;

    // Compute card commitment, then generate proof
    import('../aztec/proofWorker').then(async ({ computeCardCommitPoseidon2 }) => {
      const cardCommitHash = await computeCardCommitPoseidon2(cardIds, blindingFactor);
      const proof = await proofs.generateHandProof(cardIds, blindingFactor, cardCommitHash);
      if (proof) {
        setMyHandProof(proof);
      }
    });
  }, [gameId, playerNumber, gameState, cardIds, blindingFactor, proofs]);

  // Determine if the winner can settle
  const myPlayer: Player = playerNumber === 1 ? 'player1' : 'player2';
  const isWinner = gameState?.status === 'finished' && gameState.winner === myPlayer;
  const canSettle = isWinner &&
    myHandProof !== null &&
    opponentHandProof !== null &&
    collectedMoveProofs.length >= 9;

  const addMoveProof = useCallback((proof: MoveProofData) => {
    setCollectedMoveProofs(prev => {
      // Deduplicate: don't add if a proof with the same state hashes already exists
      const isDuplicate = prev.some(
        p => p.startStateHash === proof.startStateHash && p.endStateHash === proof.endStateHash,
      );
      if (isDuplicate) {
        console.log('[useGameFlow] Skipping duplicate move proof (same state hashes)');
        return prev;
      }
      return [...prev, proof];
    });
  }, []);

  // Build PlayerHandData for passing to move proof generation
  const playerHandData: PlayerHandData | null = useMemo(() => {
    if (!gameId || !playerNumber || cardIds.length !== 5) return null;
    if (!blindingFactor) return null;
    return {
      cardIds,
      blindingFactor,
    };
  }, [gameId, playerNumber, cardIds, blindingFactor]);

  const generateMoveProofForPlacement = useCallback(
    async (
      cardId: number,
      row: number,
      col: number,
      boardBefore: GameState['board'],
      boardAfter: GameState['board'],
      scoresBefore: [number, number],
      scoresAfter: [number, number],
      gameEnded: boolean,
      winnerId: number,
    ): Promise<MoveProofData | null> => {
      if (!playerNumber || !playerHandData) return null;

      // Guard: Do NOT generate move proofs until both hand proofs are exchanged.
      if (!myHandProof || !opponentHandProof) {
        console.warn('[useGameFlow] Cannot generate move proof: hand proofs not yet exchanged');
        return null;
      }

      if (!myCardCommit || !opponentCardCommit) {
        console.warn('[useGameFlow] Cannot generate move proof: card commits not available');
        return null;
      }

      // card_commit_1 is always player 1's commit, card_commit_2 is player 2's
      const commit1 = playerNumber === 1 ? myCardCommit : opponentCardCommit;
      const commit2 = playerNumber === 2 ? myCardCommit : opponentCardCommit;

      const proof = await proofs.generateMoveProof(
        cardId, row, col, playerNumber,
        boardBefore, boardAfter,
        scoresBefore, scoresAfter,
        commit1, commit2,
        gameEnded, winnerId,
        playerHandData,
      );

      if (proof) {
        addMoveProof(proof);
      }
      return proof;
    },
    [playerNumber, myHandProof, opponentHandProof, myCardCommit, opponentCardCommit, playerHandData, proofs, addMoveProof],
  );

  const reset = useCallback(() => {
    setMyHandProof(null);
    setOpponentHandProof(null);
    setCollectedMoveProofs([]);
    setBlindingFactor('');
    handProofGenerated.current = false;
    blindingDerivationStarted.current = false;
    proofs.reset();
  }, [proofs]);

  return {
    myHandProof,
    opponentHandProof,
    collectedMoveProofs,
    canSettle,
    myCardCommit,
    opponentCardCommit,
    blindingFactor,
    handProofStatus: proofs.handProofStatus,
    moveProofStatus: proofs.moveProofStatus,
    setOpponentHandProof,
    addMoveProof,
    generateMoveProofForPlacement,
    reset,
  };
}
