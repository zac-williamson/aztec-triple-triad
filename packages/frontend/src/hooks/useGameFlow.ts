import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useProofGeneration } from './useProofGeneration';
import type { PlayerHandData } from './useProofGeneration';
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
    secret = '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(key, secret);
  }
  // Ensure 0x prefix for stored values from older sessions
  if (!secret.startsWith('0x')) {
    secret = '0x' + secret;
    localStorage.setItem(key, secret);
  }
  return secret;
}

// Grumpkin scalar field order
const GRUMPKIN_ORDER = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

/**
 * Generate or retrieve a Grumpkin private key for ECDH.
 * Validates the key is within [1, GRUMPKIN_ORDER).
 */
function getOrCreateGrumpkinKey(gameId: string, playerNumber: number): string {
  const key = `tt_grumpkin_${gameId}_${playerNumber}`;
  let stored = localStorage.getItem(key);
  if (!stored) {
    stored = generateValidGrumpkinKey();
    localStorage.setItem(key, stored);
  }
  // Validate existing key is within scalar field range
  const keyBigInt = BigInt(stored);
  if (keyBigInt === 0n || keyBigInt >= GRUMPKIN_ORDER) {
    stored = generateValidGrumpkinKey();
    localStorage.setItem(key, stored);
  }
  return stored;
}

function generateValidGrumpkinKey(): string {
  let keyBigInt = 0n;
  // Generate until we get a valid key (almost always first try)
  while (keyBigInt === 0n || keyBigInt >= GRUMPKIN_ORDER) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    keyBigInt = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
    if (keyBigInt >= GRUMPKIN_ORDER) {
      keyBigInt = keyBigInt % GRUMPKIN_ORDER;
    }
  }
  return '0x' + keyBigInt.toString(16).padStart(64, '0');
}

/**
 * Generate nullifier secrets for each card.
 * All secrets are 0x-prefixed hex strings.
 */
function getOrCreateNullifierSecrets(gameId: string, playerNumber: number, count: number): string[] {
  const key = `tt_nullifiers_${gameId}_${playerNumber}`;
  let stored = localStorage.getItem(key);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length === count) {
        // Ensure all have 0x prefix (fix for older sessions)
        const fixed = parsed.map((s: string) => s.startsWith('0x') ? s : '0x' + s);
        if (fixed.some((s: string, i: number) => s !== parsed[i])) {
          localStorage.setItem(key, JSON.stringify(fixed));
        }
        return fixed;
      }
    } catch { /* regenerate */ }
  }
  const secrets: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    secrets.push('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
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

  const grumpkinPrivateKey = useMemo(() => {
    if (!gameId || !playerNumber) return '';
    return getOrCreateGrumpkinKey(gameId, playerNumber);
  }, [gameId, playerNumber]);

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

    // Derive a deterministic placeholder address from player secret if no wallet connected
    const address = accountAddress || ('0x' + playerNumber.toString().padStart(64, '0'));
    proofs.generateHandProof(
      cardIds,
      cardRanks,
      address,
      gameId,
      playerSecret,
      nullifierSecrets,
      grumpkinPrivateKey || undefined,
    ).then(proof => {
      if (proof) {
        setMyHandProof(proof);
      }
    });
  }, [gameId, playerNumber, gameState, cardIds, cardRanks, accountAddress, playerSecret, nullifierSecrets, grumpkinPrivateKey, proofs]);

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
    const address = accountAddress || ('0x' + playerNumber.toString().padStart(64, '0'));
    return {
      playerSecret,
      playerAddress: address,
      gameId,
      cardIds,
      cardRanks,
      nullifierSecrets,
    };
  }, [gameId, playerNumber, cardIds, cardRanks, accountAddress, playerSecret, nullifierSecrets]);

  // Extract opponent's Grumpkin public keys from their hand proof
  const opponentPubkeyX = opponentHandProof?.grumpkinPublicKeyX || '0';
  const opponentPubkeyY = opponentHandProof?.grumpkinPublicKeyY || '0';

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
      if (!playerNumber || !playerHandData || !grumpkinPrivateKey) return null;

      // card_commit_1 is always player 1's commit, card_commit_2 is player 2's
      const commit1 = playerNumber === 1 ? (myCardCommit || 'unknown') : (opponentCardCommit || 'unknown');
      const commit2 = playerNumber === 2 ? (myCardCommit || 'unknown') : (opponentCardCommit || 'unknown');

      const proof = await proofs.generateMoveProof(
        cardId, row, col, playerNumber,
        boardBefore, boardAfter,
        scoresBefore, scoresAfter,
        commit1, commit2,
        gameEnded, winnerId,
        playerHandData,
        grumpkinPrivateKey,
        opponentPubkeyX,
        opponentPubkeyY,
      );

      if (proof) {
        addMoveProof(proof);
      }
      return proof;
    },
    [playerNumber, myCardCommit, opponentCardCommit, playerHandData, grumpkinPrivateKey, opponentPubkeyX, opponentPubkeyY, proofs, addMoveProof],
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
