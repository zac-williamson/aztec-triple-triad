import { useCallback, useMemo } from 'react';
import { AZTEC_CONFIG } from '../aztec/config';
import type { HandProofData, MoveProofData } from '../types';

/**
 * Shape of the persisted game-in-progress data.
 * Keyed in localStorage under the game contract address so that
 * a fresh Aztec devnet deployment never collides with stale data.
 */
export interface PersistedGameState {
  /** WebSocket game ID */
  gameId: string;
  /** 1 or 2 */
  playerNumber: 1 | 2;
  /** The 5 card IDs the player selected for this game */
  selectedCardIds: number[];
  /** On-chain game ID (if created) */
  onChainGameId?: string;
  /** Our hand proof */
  myHandProof?: HandProofData;
  /** Opponent hand proof */
  opponentHandProof?: HandProofData;
  /** All collected move proofs so far */
  collectedMoveProofs?: MoveProofData[];
  /** Opponent Aztec address */
  opponentAztecAddress?: string;
  /** Opponent on-chain game ID */
  opponentOnChainGameId?: string;
  /** Our game randomness (6 Fr hex strings) */
  gameRandomness?: string[];
  /** Opponent's game randomness (6 Fr hex strings) */
  opponentGameRandomness?: string[];
  /** Blinding factor (hex string) */
  blindingFactor?: string;
  /** Timestamp when the game was saved (for staleness checks) */
  savedAt: number;
}

const STORAGE_PREFIX = 'aztec_tt_game_';

/**
 * Derive the localStorage key from the game contract address.
 * This ensures data from different devnet deployments never conflicts.
 */
function storageKey(suffix: string): string {
  const contractAddr = AZTEC_CONFIG.gameContractAddress || 'no-contract';
  return `${STORAGE_PREFIX}${contractAddr}_${suffix}`;
}

/**
 * Hook providing helpers to persist and restore game state in localStorage,
 * scoped to the current TripleTriadGame contract address.
 */
export function useGameStorage() {
  const gameKey = useMemo(() => storageKey('current_game'), []);

  /** Save (or update) the in-progress game. */
  const saveGame = useCallback(
    (state: PersistedGameState) => {
      try {
        localStorage.setItem(gameKey, JSON.stringify(state));
      } catch (e) {
        console.warn('[useGameStorage] Failed to save game:', e);
      }
    },
    [gameKey],
  );

  /** Load any previously saved game (or null if none). */
  const loadGame = useCallback((): PersistedGameState | null => {
    try {
      const raw = localStorage.getItem(gameKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedGameState;
      // Reject saves older than 2 hours — the WS game has certainly expired
      const TWO_HOURS = 2 * 60 * 60 * 1000;
      if (Date.now() - parsed.savedAt > TWO_HOURS) {
        localStorage.removeItem(gameKey);
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }, [gameKey]);

  /** Clear the saved game (on game end or explicit leave). */
  const clearGame = useCallback(() => {
    try {
      localStorage.removeItem(gameKey);
    } catch {
      // ignore
    }
  }, [gameKey]);

  /** Check whether a saved game exists without fully parsing it. */
  const hasGame = useCallback((): boolean => {
    return loadGame() !== null;
  }, [loadGame]);

  return { saveGame, loadGame, clearGame, hasGame };
}
