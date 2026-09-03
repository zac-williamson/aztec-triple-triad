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
  /**
   * When the game ended, if it has.
   *
   * A finished game is not resumable, but it is still the ONLY copy of the
   * transcript this player can claim with — so it is marked rather than
   * deleted. See loadClaimable().
   */
  finishedAt?: number;
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
 * scoped to the current CardGame contract address.
 */
export function useGameStorage() {
  const gameKey = useMemo(() => storageKey('current_game'), []);

  /**
   * Save (or update) the game.
   *
   * `finishedAt` survives a save that does not mention it. The per-field save
   * effect in useGame rebuilds this record from live state on every change,
   * and a move proof arriving AFTER the game ended triggers exactly that —
   * so without this merge the record would silently revert to "in progress"
   * at the moment it stops being one.
   */
  const saveGame = useCallback(
    (state: PersistedGameState) => {
      try {
        let finishedAt = state.finishedAt;
        if (finishedAt === undefined) {
          const prior = localStorage.getItem(gameKey);
          if (prior) {
            try {
              const before = JSON.parse(prior) as PersistedGameState;
              // Only carry it across for the SAME game. Without that check a
              // NEW game inherits the last one's finished marker and is born
              // un-resumable: refresh mid-game and "Resume" is not offered.
              if (before.gameId === state.gameId) finishedAt = before.finishedAt;
            } catch { /* corrupt: ignore */ }
          }
        }
        localStorage.setItem(gameKey, JSON.stringify(finishedAt === undefined ? state : { ...state, finishedAt }));
      } catch (e) {
        console.warn('[useGameStorage] Failed to save game:', e);
      }
    },
    [gameKey],
  );

  /** The stored record exactly as written, with no policy applied. */
  const readRaw = useCallback((): PersistedGameState | null => {
    try {
      const raw = localStorage.getItem(gameKey);
      return raw ? (JSON.parse(raw) as PersistedGameState) : null;
    } catch {
      return null;
    }
  }, [gameKey]);

  /**
   * Load a game that can be RESUMED (or null if none).
   *
   * Two hours is right for this question and only this one: the relay's game
   * is long gone by then, so "Resume" would lead nowhere. It is emphatically
   * NOT how long the record is worth keeping — see loadClaimable().
   */
  const loadGame = useCallback((): PersistedGameState | null => {
    const parsed = readRaw();
    if (!parsed) return null;
    if (parsed.finishedAt !== undefined) return null;   // over: nothing to resume
    const TWO_HOURS = 2 * 60 * 60 * 1000;
    if (Date.now() - parsed.savedAt > TWO_HOURS) return null;
    return parsed;
  }, [readRaw]);

  /**
   * Load the record as CLAIM EVIDENCE, whether or not the game is resumable.
   *
   * This is the only copy a player has of their own transcript, and it is what
   * every recovery path reads. Two things used to destroy it at precisely the
   * moment it started to matter: GAME_OVER deleted it outright, and the resume
   * TTL above expired it after two hours — while a claim cannot even be
   * attempted for one hour (MIN_ABANDON_SECONDS) and, realistically, people
   * come back the next day. A player who lost and whose opponent then walked
   * away had no way to recover their cards at all.
   *
   * Thirty days is the retention, because that is a "come back next week and
   * get your cards" window rather than a session.
   */
  const loadClaimable = useCallback((): PersistedGameState | null => {
    const parsed = readRaw();
    if (!parsed) return null;
    if (!parsed.onChainGameId) return null;             // nothing was ever at stake
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - parsed.savedAt > THIRTY_DAYS) {
      try { localStorage.removeItem(gameKey); } catch { /* ignore */ }
      return null;
    }
    return parsed;
  }, [readRaw, gameKey]);

  /**
   * Add one move proof to the stored record, wherever the player happens to be.
   *
   * The main save effect only runs on the game screen, so a proof that arrives
   * after the player has clicked back to the menu is not persisted — and the
   * proof most likely to do that is the OPPONENT'S LAST ONE, which is proved
   * in their browser for several seconds after the board fills. A losing
   * player who leaves promptly would keep 8 of 9 and be unable to claim.
   *
   * Deduped by startStateHash, so replaying the relay's buffer is harmless.
   */
  const mergeMoveProof = useCallback((proof: MoveProofData) => {
    const rec = readRaw();
    if (!rec?.onChainGameId) return;               // nothing was ever at stake
    const have = rec.collectedMoveProofs ?? [];
    if (have.some(p => p.startStateHash === proof.startStateHash)) return;
    try {
      localStorage.setItem(gameKey, JSON.stringify({
        ...rec,
        collectedMoveProofs: [...have, proof],
      }));
    } catch { /* ignore */ }
  }, [readRaw, gameKey]);

  /**
   * Mark the game over WITHOUT discarding the transcript.
   *
   * A game with no on-chain id never staked anything, so there is nothing to
   * keep and it is removed as before.
   */
  const markFinished = useCallback((at: number = Date.now()) => {
    const parsed = readRaw();
    if (!parsed) return;
    try {
      if (!parsed.onChainGameId) localStorage.removeItem(gameKey);
      else localStorage.setItem(gameKey, JSON.stringify({ ...parsed, finishedAt: at }));
    } catch { /* ignore */ }
  }, [readRaw, gameKey]);

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

  return { saveGame, loadGame, loadClaimable, clearGame, hasGame, markFinished, mergeMoveProof };
}
