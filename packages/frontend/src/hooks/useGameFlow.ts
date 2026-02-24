import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useProofGeneration } from './useProofGeneration';
import { getCardById } from '../cards';
import type { GameState, Player, HandProofData, MoveProofData } from '../types';

/**
 * Configuration for the game flow hook
 */
export interface GameFlowConfig {
  gameId: string | null;
  playerNumber: 1 | 2 | null;
  cardIds: number[];
  gameState: GameState | null;
  /** Aztec account address (hex string) - used for proof generation */
  accountAddress?: string | null;
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
  /** Player secret used for proof generation */
  playerSecret: string;
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
 * Generate a deterministic player secret from game context.
 * In production, this would use a real random secret stored in localStorage.
 */
function getOrCreatePlayerSecret(gameId: string, playerNumber: number): string {
  const key = `tt_secret_${gameId}_${playerNumber}`;
  let secret = localStorage.getItem(key);
  if (!secret) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    secret = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(key, secret);
  }
  return secret;
}

/**
 * Generate nullifier secrets for each card.
 */
function getOrCreateNullifierSecrets(gameId: string, playerNumber: number, count: number): string[] {
  const key = `tt_nullifiers_${gameId}_${playerNumber}`;
  let stored = localStorage.getItem(key);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length === count) return parsed;
    } catch { /* regenerate */ }
  }
  const secrets: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    secrets.push(Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
  }
  localStorage.setItem(key, JSON.stringify(secrets));
  return secrets;
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
  const { gameId, playerNumber, cardIds, gameState, accountAddress } = config;
  const proofs = useProofGeneration();

  const [myHandProof, setMyHandProof] = useState<HandProofData | null>(null);
  const [opponentHandProof, setOpponentHandProof] = useState<HandProofData | null>(null);
  const [collectedMoveProofs, setCollectedMoveProofs] = useState<MoveProofData[]>([]);
  const handProofGenerated = useRef(false);

  // Compute player secret and nullifier secrets (stable across renders)
  const playerSecret = useMemo(() => {
    if (!gameId || !playerNumber) return '';
    return getOrCreatePlayerSecret(gameId, playerNumber);
  }, [gameId, playerNumber]);

  const nullifierSecrets = useMemo(() => {
    if (!gameId || !playerNumber) return [];
    return getOrCreateNullifierSecrets(gameId, playerNumber, cardIds.length);
  }, [gameId, playerNumber, cardIds.length]);

  // Get card ranks from the database
  const cardRanks = useMemo(() => {
    return cardIds.map(id => {
      const card = getCardById(id);
      return card ? card.ranks : { top: 1, right: 1, bottom: 1, left: 1 };
    });
  }, [cardIds]);

  // Card commits
  const myCardCommit = myHandProof?.cardCommit ?? null;
  const opponentCardCommit = opponentHandProof?.cardCommit ?? null;

  // Auto-generate hand proof when game starts
  useEffect(() => {
    if (!gameId || !playerNumber || !gameState || handProofGenerated.current) return;
    if (gameState.status !== 'playing') return;
    if (cardIds.length !== 5) return;

    handProofGenerated.current = true;

    const address = accountAddress || `player_${playerNumber}_address`;
    proofs.generateHandProof(
      cardIds,
      cardRanks,
      address,
      gameId,
      playerSecret,
      nullifierSecrets,
    ).then(proof => {
      if (proof) {
        setMyHandProof(proof);
      }
    });
  }, [gameId, playerNumber, gameState, cardIds, cardRanks, accountAddress, playerSecret, nullifierSecrets, proofs]);

  // Determine if the winner can settle
  const myPlayer: Player = playerNumber === 1 ? 'player1' : 'player2';
  const isWinner = gameState?.status === 'finished' && gameState.winner === myPlayer;
  const canSettle = isWinner &&
    myHandProof !== null &&
    opponentHandProof !== null &&
    collectedMoveProofs.length >= 9;

  const addMoveProof = useCallback((proof: MoveProofData) => {
    setCollectedMoveProofs(prev => [...prev, proof]);
  }, []);

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
      if (!playerNumber) return null;

      const commit1 = playerNumber === 1 ? (myCardCommit || 'unknown') : (opponentCardCommit || 'unknown');
      const commit2 = playerNumber === 2 ? (myCardCommit || 'unknown') : (opponentCardCommit || 'unknown');

      const proof = await proofs.generateMoveProof(
        cardId,
        row,
        col,
        playerNumber,
        boardBefore,
        boardAfter,
        scoresBefore,
        scoresAfter,
        commit1,
        commit2,
        gameEnded,
        winnerId,
      );

      if (proof) {
        addMoveProof(proof);
      }
      return proof;
    },
    [playerNumber, myCardCommit, opponentCardCommit, proofs, addMoveProof],
  );

  const reset = useCallback(() => {
    setMyHandProof(null);
    setOpponentHandProof(null);
    setCollectedMoveProofs([]);
    handProofGenerated.current = false;
    proofs.reset();
  }, [proofs]);

  return {
    myHandProof,
    opponentHandProof,
    collectedMoveProofs,
    canSettle,
    myCardCommit,
    opponentCardCommit,
    playerSecret,
    handProofStatus: proofs.handProofStatus,
    moveProofStatus: proofs.moveProofStatus,
    setOpponentHandProof,
    addMoveProof,
    generateMoveProofForPlacement,
    reset,
  };
}
