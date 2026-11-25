import { useState, useCallback, useEffect, useRef } from 'react';
import type { UseWebSocketReturn } from './useWebSocket';
import type { OnChainPhase } from './useGameSession';
import type { UseGameChannelReturn } from './useGameChannel';
import type { UseGameStorageReturn } from './useGameStorage';
import { useAztecContext } from '../aztec/AztecContext';
import { requireWallet, requireAccountAddress } from '../aztec/walletGuards';
import { AZTEC_SETTLE_TX_TIMEOUT, MOVE_PROOF_WAIT_TIMEOUT, TOTAL_MOVES } from '../aztec/gameConstants';
import { DISPUTE_SECONDS } from '../aztec/settlementArgs';
import {
  announcedResolution,
  ClaimContestedError,
  claimAbandonment,
  contestClaim,
  discoverResolution,
  finalizeAbandonment,
  importDiscoveredResolution,
  importResolution,
  OpponentResumedError,
  planSettlement,
  readGameState,
  settleGame,
  type ActionContext,
  type ImportResult,
  type PrivateGame,
} from '../aztec/gameActions';
import { hasContested, orderTranscript, prizeOfMove, winnerOf, type Resolution, type Winner } from '../aztec/privateGame';

/**
 * How often a client in a live game checks for a claim against it. The
 * dispute window is DISPUTE_SECONDS (600 s), so this leaves ample time to
 * land a contest.
 */
export const CLAIM_WATCH_MS = 30_000;
import type { PeerPayload } from '../aztec/peerChannel';
import type { MoveProofData, Player } from '../types';

export type TxStatus = 'idle' | 'preparing' | 'proving' | 'sending' | 'confirmed' | 'error';

/** How often the non-settler looks for the resolving tx on its own. */
const RESOLUTION_POLL_MS = 20_000;
/** How long it keeps looking before leaving it to the menu's recovery. */
const RESOLUTION_POLL_MAX_MS = 30 * 60_000;

/**
 * The slice of useGameSession that settlement consumes. All functions are
 * identity-stable, so they are safe in useCallback dependency arrays.
 */
export interface SettlementSessionDeps {
  getPhase: () => OnChainPhase;
  transitionPhase: (to: OnChainPhase) => void;
  waitForActivePhase: (timeoutMs: number) => Promise<void>;
  /** Everything this player knows about the live game (records, key, nonce, hand). */
  getGame: () => PrivateGame | null;
  /** The game is over on-chain: never run its create/join pipeline again.
   *  Optional only so unit-test doubles may omit it; useGame always passes it. */
  markLifecycleComplete?: () => void;
}

/**
 * The slice of useGamePlay that settlement consumes. All functions are
 * identity-stable, so they are safe in useCallback dependency arrays.
 */
export interface SettlementPlayDeps {
  getMoveProofs: () => MoveProofData[];
  waitForMoveProofs: (timeoutMs: number) => Promise<void>;
  /** Reactive: both records known and all 9 move proofs collected (used to
   *  auto-settle a draw, where neither player is the winner). Optional so
   *  unit-test mocks that don't exercise the draw path can omit it. */
  canSettle?: boolean;
  /** Reactive: the result of the game this client ran (useGamePlay), once over. */
  gameOver?: { winner: Player | 'draw' } | null;
}

export interface UseGameSettlementParams {
  ws: Pick<UseWebSocketReturn, 'gameId' | 'playerNumber' | 'opponentDisconnected'>;
  session: SettlementSessionDeps;
  play: SettlementPlayDeps;
  channel: Pick<UseGameChannelReturn, 'sendPeer' | 'addPeerListener'>;
  storage: Pick<UseGameStorageReturn, 'mergeGame'>;
}

export interface UseGameSettlementReturn {
  // UI-rendered state
  settleTxStatus: TxStatus;
  settleTxHash: string | null;
  settleError: string | null;
  /** The other player settled (or the game resolved without us) and our notes are imported. */
  opponentSettled: boolean;
  /** Our card the winner took (0 on a draw, where nothing is taken). */
  takenCardId: number | null;
  isClaimingAbandoned: boolean;
  /** Seconds until the contract will accept a claim, while the claim flow waits; else null. */
  abandonBarCountdown: number | null;
  abandonedDisputeCountdown: number | null;

  // Actions
  /** Winner: settle, taking `selectedCardId` (a card the loser placed). 0 = default / draw. */
  handleSettle: (selectedCardId: number) => Promise<void>;
  /** Claim + finalize a present-but-idle (or disconnected) opponent's abandoned
   *  game. Wired to the "Claim abandoned game" button and the testkit; also
   *  auto-fired by the opponent-disconnected effect. Idempotent. */
  handleAbandonedGame: () => Promise<void>;

  // Stable functions for the facade
  cancelAbandonedUi: () => void;
  resetForMenu: () => void;
}

/**
 * Game settlement (docs/plan/PRIVATE_GAMES.md section 5.4):
 *
 *   - The winner (player 1 on a draw) sends PEER SETTLING, then settle_game
 *     with both records, the nine move proofs and the prize move, then PEER
 *     SETTLED {txHash}, then imports their own notes from the tx.
 *   - The other player imports their own notes from that tx — told by
 *     SETTLED, or finding it themselves from the game's `done` nullifier.
 *     Same import code for both: nothing is relayed about anybody's notes.
 *   - Abandonment: claim once the contract's bar has passed, wait out the
 *     dispute window, finalize (both hands back, no rewards), import.
 *
 * Every wait happens outside the PXE queue; only the txs and imports use it.
 */
export function useGameSettlement({ ws, session, play, channel, storage }: UseGameSettlementParams): UseGameSettlementReturn {
  const aztec = useAztecContext();

  // --- Settlement tx state ---
  const [settleTxStatus, setSettleTxStatus] = useState<TxStatus>('idle');
  const [settleTxHash, setSettleTxHash] = useState<string | null>(null);
  const [settleError, setSettleError] = useState<string | null>(null);

  // --- Abandoned game state ---
  const [isClaimingAbandoned, setIsClaimingAbandoned] = useState(false);
  const [abandonBarCountdown, setAbandonBarCountdown] = useState<number | null>(null);
  const [abandonedDisputeCountdown, setAbandonedDisputeCountdown] = useState<number | null>(null);
  const abandonedClaimStartedRef = useRef(false);
  const autoClaimFiredRef = useRef(false);

  // --- The other side's settlement (for the loser UX) ---
  const [opponentSettled, setOpponentSettled] = useState(false);
  const [takenCardId, setTakenCardId] = useState<number | null>(null);

  /** One settle per game from this tab. */
  const settleStartedRef = useRef(false);
  /** The resolution has been imported for this game: never twice. */
  const importedRef = useRef(false);
  const importingRef = useRef(false);
  /** The prize move the settler announced (null: a draw); undefined = not heard. */
  const announcedPrizeRef = useRef<number | null | undefined>(undefined);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const aztecRef = useRef(aztec);
  aztecRef.current = aztec;
  const storageRef = useRef(storage);
  storageRef.current = storage;
  const channelRef = useRef(channel);
  channelRef.current = channel;

  const ctx = useCallback((): ActionContext => {
    const a = aztecRef.current;
    requireWallet(a.wallet);
    return { owner: requireAccountAddress(a.accountAddress), node: a.nodeClient };
  }, []);

  /** Reflect an import in the UI: cards, tokens, and the record's state. */
  const applyImport = useCallback((game: PrivateGame, result: ImportResult) => {
    const a = aztecRef.current;
    if (result.importedCardIds.length > 0) a.updateOwnedCards(prev => [...prev, ...result.importedCardIds]);
    if (result.prizeUncertain) void a.refreshOwnedCards();
    void a.refreshTokenBalance();
    storageRef.current.mergeGame(game.roomId, { resolutionTxHash: result.txHash, importedAt: Date.now() });
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  /**
   * The other player's settlement (or anyone's resolution) is on-chain:
   * import our own notes from it. Idempotent.
   */
  const importTheirResolution = useCallback(async (txHash: string | null) => {
    if (importedRef.current || importingRef.current) return;
    const game = session.getGame();
    if (!game) return;
    importingRef.current = true;
    try {
      const context = ctx();
      const moveProofs = play.getMoveProofs();
      const announced = announcedResolution(moveProofs, announcedPrizeRef.current);
      let result: ImportResult;
      if (txHash) {
        // SETTLED: the settler says this tx is their settle_game.
        result = await importResolution(game, context, {
          txHash, resolution: announced, moveProofs, label: 'Opponent settlement',
        });
      } else {
        // Found from `done`: nobody said what it was — a settlement, or an
        // unwind of an abandoned game. The tx itself says; the announcement
        // is the fallback if it cannot be read.
        const discovered = await importDiscoveredResolution(game, context, { moveProofs, fallback: announced });
        if (!discovered) return; // not resolved yet
        result = discovered;
      }
      importedRef.current = true;
      stopPolling();
      applyImport(game, result);
      setTakenCardId(result.takenCardId ?? (isDraw(result.resolution) ? 0 : null));
      setOpponentSettled(true);
      session.markLifecycleComplete?.();
      const phase = session.getPhase();
      if (phase === 'awaiting_settlement' || phase === 'active' || phase === 'settling') session.transitionPhase('idle');
    } catch (err) {
      console.error('[useGameSettlement] importing the other side\'s settlement failed:', err);
    } finally {
      importingRef.current = false;
    }
  }, [ctx, session.getGame, session.getPhase, session.transitionPhase, session.markLifecycleComplete,
      play.getMoveProofs, applyImport, stopPolling]);

  /** Look for the resolving tx ourselves until it appears, it is imported, or we give up. */
  const startPolling = useCallback(() => {
    if (pollTimerRef.current || importedRef.current) return;
    const started = Date.now();
    const tick = async () => {
      pollTimerRef.current = null;
      if (importedRef.current) return;
      await importTheirResolution(null);
      if (importedRef.current) return;
      if (Date.now() - started > RESOLUTION_POLL_MAX_MS) {
        console.warn('[useGameSettlement] the game has not resolved on-chain; the menu will pick it up');
        return;
      }
      pollTimerRef.current = setTimeout(() => { void tick(); }, RESOLUTION_POLL_MS);
    };
    pollTimerRef.current = setTimeout(() => { void tick(); }, RESOLUTION_POLL_MS);
  }, [importTheirResolution]);

  // The settler's announcements.
  useEffect(() => {
    return channel.addPeerListener((payload: PeerPayload) => {
      if (payload.kind === 'SETTLING') {
        if (settleStartedRef.current) return; // we are settling ourselves: the chain decides
        announcedPrizeRef.current = payload.prizeMove;
        const game = session.getGame();
        if (game) storageRef.current.mergeGame(game.roomId, { prizeMove: payload.prizeMove });
        if (session.getPhase() === 'active') session.transitionPhase('awaiting_settlement');
        setTakenCardId(takenByAnnouncement(game, play.getMoveProofs(), payload.prizeMove));
        startPolling();
      } else if (payload.kind === 'SETTLED') {
        if (settleStartedRef.current) return;
        void importTheirResolution(payload.txHash);
      }
    });
  }, [channel.addPeerListener, session.getGame, session.getPhase, session.transitionPhase,
      play.getMoveProofs, startPolling, importTheirResolution]);

  // The game is over and we are not the settler: keep an eye on the chain
  // too, so a settler who never says SETTLED cannot leave our notes unimported.
  const gameOver = play.gameOver ?? null;
  useEffect(() => {
    if (!gameOver || !ws.playerNumber) return;
    const winner = gameOver.winner;
    const weSettle = winner === 'draw' ? ws.playerNumber === 1 : winner === (ws.playerNumber === 1 ? 'player1' : 'player2');
    if (!weSettle) startPolling();
  }, [gameOver, ws.playerNumber, startPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  const handleSettle = useCallback(async (selectedCardId: number) => {
    if (settleStartedRef.current) return;
    if (!ws.gameId) throw new Error('No game ID for settlement');
    settleStartedRef.current = true;
    setSettleTxStatus('preparing');
    setSettleError(null);
    setSettleTxHash(null);

    let game: PrivateGame | null = null;
    let context: ActionContext | null = null;
    let txHash: string | null = null;
    try {
      context = ctx();
      // Both records must be committed and known. Waited for OUT HERE, never
      // inside the PXE queue: the join it waits on may be queued behind it.
      if (session.getPhase() !== 'active') await session.waitForActivePhase(AZTEC_SETTLE_TX_TIMEOUT * 1000);
      // The ninth proof is generated after the board fills: when we made the
      // last move, ours may still be proving.
      await play.waitForMoveProofs(MOVE_PROOF_WAIT_TIMEOUT);
      game = session.getGame();
      if (!game?.record2) throw new Error('Settlement needs both records (the game is not joined)');
      const moveProofs = play.getMoveProofs();
      const plan = planSettlement(moveProofs, selectedCardId > 0 ? selectedCardId : null);
      const announced = plan.winner === 'draw' ? null : plan.prizeMove;

      session.transitionPhase('settling');
      storageRef.current.mergeGame(game.roomId, { prizeMove: announced });
      await channelRef.current.sendPeer({ kind: 'SETTLING', prizeMove: announced })
        .catch(err => console.warn('[useGameSettlement] could not announce the settlement:', err));

      txHash = await settleGame(game, context, {
        moveProofs,
        prizeMove: plan.prizeMove,
        onPhase: phase => setSettleTxStatus(phase),
      });
      setSettleTxHash(txHash);
      setSettleTxStatus('confirmed');
      storageRef.current.mergeGame(game.roomId, { resolutionTxHash: txHash });
      console.log('[useGameSettlement] Game settled on-chain, txHash:', txHash);
      await channelRef.current.sendPeer({ kind: 'SETTLED', txHash })
        .catch(err => console.warn('[useGameSettlement] could not tell the other player the settlement landed:', err));

      const resolution: Resolution = { kind: 'settled', winner: plan.winner, prize: plan.prize ?? undefined };
      const result = await importResolution(game, context, { txHash, resolution, moveProofs, label: 'Settlement' });
      importedRef.current = true;
      applyImport(game, result);
    } catch (err) {
      if (txHash && game) {
        // The settlement landed; only our import failed. The game IS settled —
        // the record stays un-imported and the menu retries the import.
        console.error('[useGameSettlement] settled, but importing our notes failed:', err);
      } else if (game && context && await settledElsewhere(game, context)) {
        // Somebody else's settlement won the race (both sides may settle).
        console.warn('[useGameSettlement] our settle failed but the game is settled — importing from that tx');
        setSettleTxStatus('confirmed');
        await importTheirResolution(null);
      } else {
        const message = err instanceof Error ? err.message : 'Transaction failed';
        console.error('[useGameSettlement] settleGame error:', err);
        setSettleError(message);
        setSettleTxStatus('error');
        settleStartedRef.current = false;
        if (session.getPhase() === 'settling') session.transitionPhase('idle');
        return;
      }
    }
    // The game's on-chain lifecycle is complete: mark it so the pipeline never
    // restarts it, then idle.
    session.markLifecycleComplete?.();
    if (session.getPhase() !== 'idle') session.transitionPhase('idle');
  }, [ws.gameId, ctx, session.getPhase, session.waitForActivePhase, session.transitionPhase,
      session.getGame, session.markLifecycleComplete, play.waitForMoveProofs, play.getMoveProofs,
      applyImport, importTheirResolution]);

  // Auto-settle a DRAW. Neither player is "the winner", so the win card-picker
  // never renders and nothing would otherwise call handleSettle. SINGLE
  // SETTLER: only player 1 sends settle_game; player 2 imports from it (the
  // same path a loser takes). A second settle would only revert on `done`.
  const drawSettleTriggeredRef = useRef(false);
  useEffect(() => {
    if (gameOver?.winner !== 'draw') { drawSettleTriggeredRef.current = false; return; }
    if (ws.playerNumber !== 1) return;              // single settler: only player 1
    if (drawSettleTriggeredRef.current) return;     // fire once per draw
    if (!play.canSettle) return;                    // need both records and the full transcript
    if (settleTxStatus !== 'idle') return;          // not already settling
    drawSettleTriggeredRef.current = true;
    console.log('[useGameSettlement] draw detected — auto-settling (player 1)');
    void handleSettle(0);
  }, [gameOver, ws.playerNumber, play.canSettle, settleTxStatus, handleSettle]);

  // --- Abandoned game handler ---
  const handleAbandonedGame = useCallback(async () => {
    if (abandonedClaimStartedRef.current) return;
    abandonedClaimStartedRef.current = true;
    // The phase moves to 'settling' only once the claim is filed: until then
    // the opponent may come back and the game must carry on as 'active'.
    setIsClaimingAbandoned(true);

    const resetUi = () => {
      setIsClaimingAbandoned(false);
      setAbandonBarCountdown(null);
      setAbandonedDisputeCountdown(null);
      abandonedClaimStartedRef.current = false;
    };

    const game = session.getGame();
    if (!game?.record2) {
      console.error('[useGameSettlement] Cannot claim an abandoned game: it is not joined (no record 2)');
      resetUi();
      return;
    }
    try {
      const context = ctx();
      const heldMoves = play.getMoveProofs().length;
      const claim = await claimAbandonment(game, context, {
        onBarProgress: secondsLeft => setAbandonBarCountdown(secondsLeft),
        // A new move proof means the idle player came back: claiming anyway
        // would call a live game abandoned.
        shouldStop: () => play.getMoveProofs().length > heldMoves,
      });
      setAbandonBarCountdown(null);

      if (claim.claimSide !== game.role) {
        // They claimed first, and we are here: that claim is false. Contest it.
        console.warn('[useGameSettlement] the other player has a claim standing — contesting it');
        await contestClaim(game, context, claim);
        resetUi();
        return;
      }

      session.transitionPhase('settling');
      setAbandonedDisputeCountdown(DISPUTE_SECONDS);
      const result = await finalizeAbandonment(game, context, claim, {
        onDisputeProgress: secondsLeft => setAbandonedDisputeCountdown(secondsLeft),
      });
      setAbandonedDisputeCountdown(0);
      if (result) {
        applyImport(game, result);
        importedRef.current = true;
      } else {
        // Resolved another way meanwhile — a settlement beats a claim.
        await importTheirResolution(null);
      }
      // The relay is not told: it never knew the result of anything. Each
      // player's binding goes when they leave (LEAVE_GAME) or by its sweep.
      session.markLifecycleComplete?.();
      session.transitionPhase('idle');
      resetUi();
    } catch (err) {
      resetUi();
      if (err instanceof OpponentResumedError) {
        // The game is live again: leave its phase alone and let it play on.
        console.log('[useGameSettlement] the opponent moved while the claim waited for the abandonment bar — claim cancelled');
        return;
      }
      if (err instanceof ClaimContestedError) {
        console.log('[useGameSettlement] our claim was contested — the game goes on');
        if (session.getPhase() === 'settling') session.transitionPhase('active');
        return;
      }
      console.error('[useGameSettlement] Abandoned game flow failed:', err);
      if (session.getPhase() === 'settling') session.transitionPhase('idle');
    }
  }, [ctx, session.getGame, session.transitionPhase,
      session.getPhase, session.markLifecycleComplete, play.getMoveProofs, applyImport, importTheirResolution]);

  // Auto-trigger the abandoned game flow when the opponent disconnects.
  //
  // Latched on its OWN ref, not on the in-flight guard: the in-flight guard is
  // cleared when a run ends, including when it failed, and this effect re-runs
  // whenever handleAbandonedGame's identity changes — so gating on it would
  // retry a persistently failing claim forever. Once per game is the right
  // number of automatic attempts; a player can still retry deliberately.
  useEffect(() => {
    if (!ws.opponentDisconnected) return;
    if (autoClaimFiredRef.current || abandonedClaimStartedRef.current) return;
    if (session.getPhase() !== 'active') return;
    if (gameOver) return; // a finished game settles; it is not abandoned
    console.log('[useGameSettlement] Opponent disconnected mid-game, starting the abandoned game flow...');
    autoClaimFiredRef.current = true;
    void handleAbandonedGame();
  }, [ws.opponentDisconnected, gameOver, handleAbandonedGame, session.getPhase]);

  // --- A claim against a player who is here is false: contest it ---
  //
  // Any player may claim once the abandonment bar has passed, even the one who
  // is stalling, and walking away costs a card (docs/plan/PRIVATE_GAMES.md
  // §3.4, §5.5). So a client in a live game watches the game's claims and
  // contests the opponent's as soon as it lands: this player is demonstrably
  // here. Our own claim flow contests a claim it finds, so the watch stands
  // aside while that runs; and each side contests once, so a spent contest
  // ends it.
  const claimWatchBusyRef = useRef(false);
  useEffect(() => {
    if (!ws.gameId) return;
    const timer = setInterval(() => {
      if (claimWatchBusyRef.current || abandonedClaimStartedRef.current) return;
      if (session.getPhase() !== 'active') return;
      const game = session.getGame();
      if (!game?.record2) return;
      claimWatchBusyRef.current = true;
      void (async () => {
        try {
          const context = ctx();
          const { state, position } = await readGameState(game, context);
          if (position.kind !== 'open-claim' || position.claimSide === game.role) return;
          if (hasContested(state, game.role)) return;
          console.warn(`[useGameSettlement] the other player filed claim ${position.claimNo} while we are here — contesting it`);
          await contestClaim(game, context, position);
        } catch (err) {
          console.warn('[useGameSettlement] watching for a claim against us failed (retrying):', err);
        } finally {
          claimWatchBusyRef.current = false;
        }
      })();
    }, CLAIM_WATCH_MS);
    return () => clearInterval(timer);
  }, [ws.gameId, ctx, session.getPhase, session.getGame]);

  // --- Facade integration ---

  const cancelAbandonedUi = useCallback((): void => {
    setIsClaimingAbandoned(false);
    setAbandonBarCountdown(null);
    setAbandonedDisputeCountdown(null);
    abandonedClaimStartedRef.current = false;
  }, []);

  const resetForMenu = useCallback((): void => {
    stopPolling();
    setSettleTxStatus('idle');
    setSettleTxHash(null);
    setSettleError(null);
    setOpponentSettled(false);
    setTakenCardId(null);
    settleStartedRef.current = false;
    importedRef.current = false;
    importingRef.current = false;
    announcedPrizeRef.current = undefined;
    // A new game gets a fresh automatic attempt; the latch is per-game.
    autoClaimFiredRef.current = false;
    abandonedClaimStartedRef.current = false;
  }, [stopPolling]);

  return {
    settleTxStatus,
    settleTxHash,
    settleError,
    opponentSettled,
    takenCardId,
    isClaimingAbandoned,
    abandonBarCountdown,
    abandonedDisputeCountdown,
    handleSettle,
    handleAbandonedGame,
    cancelAbandonedUi,
    resetForMenu,
  };
}

function isDraw(resolution: Resolution): boolean {
  return resolution.kind === 'settled' && resolution.winner === 'draw';
}

function transcriptWinner(moveProofs: MoveProofData[]): { ordered: MoveProofData[]; winner: Winner } | null {
  if (moveProofs.length < TOTAL_MOVES) return null;
  try {
    const ordered = orderTranscript(moveProofs);
    return { ordered, winner: winnerOf(ordered) };
  } catch {
    return null;
  }
}

/** Our card the announced prize move takes, for the loser's screen (0 on a draw). */
function takenByAnnouncement(game: PrivateGame | null, moveProofs: MoveProofData[], announced: number | null): number | null {
  if (announced === null) return 0;
  const t = transcriptWinner(moveProofs);
  if (!t || t.winner === 'draw' || !game || t.winner === game.role) return null;
  try {
    return prizeOfMove(t.ordered, t.winner, announced).cardId;
  } catch {
    return null;
  }
}

async function settledElsewhere(game: PrivateGame, context: ActionContext): Promise<boolean> {
  try {
    return (await discoverResolution(game, context)) !== null;
  } catch {
    return false;
  }
}
