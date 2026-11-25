import { useCallback, useMemo } from 'react';
import { AZTEC_CONFIG } from '../aztec/config';
import type { GameKeyPair } from '../aztec/gameKeys';
import type { PrivateGame } from '../aztec/gameActions';
import { normalizeField, parseRecord } from '../aztec/privateGame';
import type { MoveProofData } from '../types';

/**
 * What a player keeps about one game (docs/plan/PRIVATE_GAMES.md section 5).
 *
 * Everything here is THIS player's: their key pair, the shared game key, their
 * nonce, both records, their role and the transcript. Nothing about the
 * opponent beyond their public key and record is ever learned, so nothing
 * more is stored. The records and the game key are what every later action
 * needs — settle, import, cancel, claim, contest, finalize — and the only copy
 * is here, so a record outlives the game until its notes are imported.
 */
export interface PersistedGameState {
  /** The relay's room id. */
  gameId: string;
  /** This player's role: 1 created the game, 2 joined it. */
  playerNumber: 1 | 2;
  /** This player's five card ids, in the order they were committed. */
  selectedCardIds: number[];
  /** Timestamp of the last save (for staleness checks). */
  savedAt: number;
  /** This player's key pair for the game's key exchange (private half as JWK). */
  keyPair?: GameKeyPair;
  /** The opponent's public key, once received. */
  opponentPublicKey?: string;
  /** The game's shared secret (never sent anywhere). */
  gameKey?: string;
  /** This player's note nonce at commit: re-derives their secrets. */
  nonce?: string;
  /** The creator's record. */
  record1?: string[];
  /** The joiner's record. */
  record2?: string[];
  /**
   * When this player's commit tx was about to be sent. The record is written
   * BEFORE the send, so a tab that dies mid-send still knows what it may have
   * committed; the chain (the `created` / `joined` nullifier) says whether it did.
   */
  commitSentAt?: number;
  /** The move proofs collected so far — the transcript. */
  collectedMoveProofs?: MoveProofData[];
  /** The prize move a settlement named, once known (null: a draw). */
  prizeMove?: number | null;
  /** The tx that resolved the game, once known. */
  resolutionTxHash?: string;
  /** When this player's own notes from the resolution were imported. */
  importedAt?: number;
  /**
   * When the game ended, if it has.
   *
   * A finished game is not resumable, but it is still the ONLY copy of what
   * this player needs to get their cards back — so it is marked rather than
   * deleted. See loadClaimable().
   */
  finishedAt?: number;
}

/** A stored game, possibly before its role and hand were recorded. */
type StoredGame = Partial<PersistedGameState> & { gameId: string; savedAt: number };

interface GameBook {
  /** The room the player is in (or last played). */
  current: string | null;
  games: Record<string, StoredGame>;
}

const STORAGE_PREFIX = 'aztec_tt_game_';
const RESUME_TTL = 2 * 60 * 60 * 1000;
const EVIDENCE_TTL = 30 * 24 * 60 * 60 * 1000;
/** An unconfirmed commit is dropped only once no tx sent for it can still land. */
const UNCONFIRMED_COMMIT_TTL = 60 * 60 * 1000;

/**
 * Derive the localStorage key from the game contract address, so data from
 * different deployments never collides.
 */
function storageKey(suffix: string): string {
  const contractAddr = AZTEC_CONFIG.gameContractAddress || 'no-contract';
  return `${STORAGE_PREFIX}${contractAddr}_${suffix}`;
}

function isComplete(g: StoredGame | undefined | null): g is PersistedGameState {
  return !!g && (g.playerNumber === 1 || g.playerNumber === 2) && Array.isArray(g.selectedCardIds);
}

/** Whether this player may have committed cards to the game. */
export function hasStake(g: Partial<PersistedGameState>): boolean {
  const own = g.playerNumber === 1 ? g.record1 : g.playerNumber === 2 ? g.record2 : undefined;
  return !!own && !!g.gameKey && !!g.nonce;
}

/** Drop the transcript (and any field) a merge passes as undefined — merges never erase. */
function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Hook providing helpers to persist and restore games in localStorage, scoped
 * to the current game contract address.
 *
 * One record per relay room: starting a new game must never overwrite the
 * only copy of an older one that still holds cards.
 */
export function useGameStorage() {
  const bookKey = useMemo(() => storageKey('games'), []);

  const readBook = useCallback((): GameBook => {
    try {
      const raw = localStorage.getItem(bookKey);
      if (!raw) return { current: null, games: {} };
      const parsed = JSON.parse(raw) as GameBook;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.games !== 'object') return { current: null, games: {} };
      return { current: parsed.current ?? null, games: parsed.games ?? {} };
    } catch {
      return { current: null, games: {} };
    }
  }, [bookKey]);

  const writeBook = useCallback((book: GameBook) => {
    try {
      localStorage.setItem(bookKey, JSON.stringify(book));
    } catch (e) {
      console.warn('[useGameStorage] Failed to save games:', e);
    }
  }, [bookKey]);

  /**
   * Save (or update) the current game. MERGES into the stored record: fields
   * other code wrote (the key pair at match time, the records at commit) are
   * kept, and `finishedAt` survives a save that does not mention it — a move
   * proof arriving after the game ended triggers exactly such a save.
   */
  const saveGame = useCallback((state: PersistedGameState) => {
    const book = readBook();
    const prior = book.games[state.gameId];
    book.games[state.gameId] = { ...(prior ?? {}), ...definedOnly(state), gameId: state.gameId };
    book.current = state.gameId;
    writeBook(book);
  }, [readBook, writeBook]);

  /** Merge fields into one game's record, creating it if needed. */
  const mergeGame = useCallback((gameId: string, fields: Partial<PersistedGameState>) => {
    const book = readBook();
    const prior: StoredGame = book.games[gameId] ?? { gameId, savedAt: Date.now() };
    book.games[gameId] = { ...prior, ...definedOnly(fields), gameId };
    writeBook(book);
  }, [readBook, writeBook]);

  /** One game's record exactly as stored (it may lack role and hand). */
  const readGame = useCallback((gameId: string): (Partial<PersistedGameState> & { gameId: string }) | null => {
    return readBook().games[gameId] ?? null;
  }, [readBook]);

  /**
   * Load a game that can be RESUMED (or null if none).
   *
   * Two hours is right for this question and only this one: the relay's game
   * is long gone by then, so "Resume" would lead nowhere. It is emphatically
   * NOT how long the record is worth keeping — see loadClaimable().
   */
  const loadGame = useCallback((): PersistedGameState | null => {
    const book = readBook();
    const g = book.current ? book.games[book.current] : undefined;
    if (!isComplete(g)) return null;
    if (g.finishedAt !== undefined) return null;   // over: nothing to resume
    if (Date.now() - g.savedAt > RESUME_TTL) return null;
    return g;
  }, [readBook]);

  /**
   * Every game whose record is still EVIDENCE: this player may have cards in
   * it, or notes from its resolution not yet imported. Oldest first.
   *
   * Thirty days is the retention — a "come back next week and get your
   * cards" window rather than a session. Records past it are dropped here.
   */
  const listClaimable = useCallback((): PersistedGameState[] => {
    const book = readBook();
    const now = Date.now();
    let pruned = false;
    const out: PersistedGameState[] = [];
    for (const [id, g] of Object.entries(book.games)) {
      if (now - g.savedAt > EVIDENCE_TTL) { delete book.games[id]; pruned = true; continue; }
      if (isComplete(g) && hasStake(g) && g.importedAt === undefined) out.push(g);
    }
    if (pruned) writeBook(book);
    return out.sort((a, b) => a.savedAt - b.savedAt);
  }, [readBook, writeBook]);

  /** The most urgent game with cards at stake (the oldest), or null. */
  const loadClaimable = useCallback((): PersistedGameState | null => {
    return listClaimable()[0] ?? null;
  }, [listClaimable]);

  /**
   * Add one move proof to the current game's record, wherever the player
   * happens to be. The main save effect only runs on the game screen, and the
   * proof most likely to arrive after the player left is the OPPONENT'S LAST
   * ONE. Deduped by startStateHash, so replaying the relay's buffer is
   * harmless.
   */
  const mergeMoveProof = useCallback((proof: MoveProofData) => {
    const book = readBook();
    const g = book.current ? book.games[book.current] : undefined;
    if (!g || !hasStake(g)) return;               // nothing was ever at stake
    const have = g.collectedMoveProofs ?? [];
    if (have.some(p => p.startStateHash === proof.startStateHash)) return;
    g.collectedMoveProofs = [...have, proof];
    writeBook(book);
  }, [readBook, writeBook]);

  /**
   * Mark the current game over WITHOUT discarding it. A game that never
   * staked anything has nothing to keep and is removed.
   */
  const markFinished = useCallback((at: number = Date.now()) => {
    const book = readBook();
    const id = book.current;
    if (!id || !book.games[id]) return;
    if (!hasStake(book.games[id])) delete book.games[id];
    else book.games[id] = { ...book.games[id], finishedAt: book.games[id].finishedAt ?? at };
    writeBook(book);
  }, [readBook, writeBook]);

  /** Remove a game's record (default: the current one). */
  const clearGame = useCallback((gameId?: string) => {
    const book = readBook();
    const id = gameId ?? book.current;
    if (!id) return;
    delete book.games[id];
    if (book.current === id) book.current = null;
    writeBook(book);
  }, [readBook, writeBook]);

  /**
   * Forget the current game for resuming purposes — the player left it — but
   * keep its record if it still holds cards.
   */
  const leaveCurrentGame = useCallback(() => {
    const book = readBook();
    const id = book.current;
    if (!id) return;
    if (!book.games[id] || !hasStake(book.games[id])) delete book.games[id];
    else book.games[id] = { ...book.games[id], finishedAt: book.games[id].finishedAt ?? Date.now() };
    book.current = null;
    writeBook(book);
  }, [readBook, writeBook]);

  /** Whether a resumable game exists. */
  const hasGame = useCallback((): boolean => loadGame() !== null, [loadGame]);

  return {
    saveGame, mergeGame, readGame, loadGame, loadClaimable, listClaimable,
    clearGame, leaveCurrentGame, hasGame, markFinished, mergeMoveProof,
  };
}

export type UseGameStorageReturn = ReturnType<typeof useGameStorage>;

/** Drop records of commits that never reached the chain, once nothing sent for them can still land. */
export function commitIsStale(g: Partial<PersistedGameState>, now = Date.now()): boolean {
  return now - (g.commitSentAt ?? g.savedAt ?? now) > UNCONFIRMED_COMMIT_TTL;
}

/** The game as the chain actions see it, or null if this player never committed to it. */
export function toPrivateGame(saved: PersistedGameState): PrivateGame | null {
  if (!hasStake(saved) || !saved.record1) return null;
  try {
    return {
      roomId: saved.gameId,
      role: saved.playerNumber,
      hand: [...saved.selectedCardIds],
      gameKey: normalizeField(saved.gameKey),
      nonce: normalizeField(saved.nonce),
      record1: parseRecord(saved.record1),
      record2: saved.record2 ? parseRecord(saved.record2) : null,
    };
  } catch (err) {
    console.warn(`[useGameStorage] game ${saved.gameId} has a malformed record:`, err);
    return null;
  }
}
