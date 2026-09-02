import { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from './useWebSocket';
import type { ProofStatus } from './useProofGeneration';
import { useGameStorage, type PersistedGameState } from './useGameStorage';
import { useGameSession } from './useGameSession';
import { useGamePlay } from './useGamePlay';
import { useGameSettlement, type TxStatus } from './useGameSettlement';
import { useUnloadGuard } from './useUnloadGuard';
import { useAztecContext } from '../aztec/AztecContext';
import type { Screen, HandProofData, MoveProofData } from '../types';
import { TOTAL_MOVES } from '../aztec/gameConstants';

/** Chain time is in seconds; so is everything compared against it here. */
const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * A game that still holds this player's cards on-chain.
 *
 * `claimable` — fewer than nine moves, so the abandonment claim applies and we
 * can get the cards back from here.
 * `awaiting-winner` — the game finished but nobody settled it. The contract
 * offers no route out for anyone but the winner: claim_abandoned_game asserts
 * n <= 8, and settle_game binds the caller to the winning side. Worth telling
 * the player about; not worth offering them a button that cannot work.
 */
export interface StuckGame {
  onChainGameId: string;
  kind: StuckGameKind;
  /** Seconds until a claim becomes possible; only for 'too-soon'. */
  waitSeconds?: number;
}

export type StuckGameKind =
  /** Old enough, incomplete: the claim will work. */
  | 'claimable'
  /** Still holding cards, but the contract's abandonment bar has not passed. */
  | 'too-soon'
  /** Nine moves: only the winner can settle, so no action here would succeed. */
  | 'awaiting-winner'
  /** The opponent has claimed it and the dispute window is still open. */
  | 'contestable'
  /** Claimed, window closed: nothing left to do but let it complete. */
  | 'claimed-by-opponent';

/** Mirrors MIN_ABANDON_SECONDS in the game contract. */
const MIN_ABANDON_SECONDS = 3600;
/** Mirrors DISPUTE_SECONDS in the game contract. */
const DISPUTE_SECONDS = 600;

// Re-export types consumers need
export type { TxStatus, ProofStatus };

// Re-export the on-chain phase machine and winner mapping so consumers and
// tests keep importing from useGame (they live in useGameSession/useGamePlay).
export { VALID_TRANSITIONS } from './useGameSession';
export type { OnChainPhase } from './useGameSession';
export { mapWinnerId } from './useGamePlay';

export interface UseGameReturn {
  // Screen routing
  screen: Screen;
  setScreen: (s: Screen) => void;

  // WebSocket state (pass-through for components)
  ws: ReturnType<typeof useWebSocket>;

  // On-chain + proof state (previously game.session.*)
  onChainGameId: string | null;
  handProofStatus: ProofStatus;
  moveProofStatus: ProofStatus;
  canSettle: boolean;
  settleTxStatus: TxStatus;
  onChainError: string | null;

  // Chain-view data (privacy panel): live proofs + settlement tx hash
  myHandProof: HandProofData | null;
  opponentHandProof: HandProofData | null;
  collectedMoveProofs: MoveProofData[];
  settleTxHash: string | null;

  // Game state
  cardIds: number[];
  /** A game still holding this player's cards on-chain, if any. */
  stuckGame: StuckGame | null;
  isRecovering: boolean;
  handleRecoverStuckGame: () => Promise<void>;
  handleContestClaim: () => Promise<void>;
  packResult: { location: string; cardIds: number[] } | null;
  hasGameInProgress: boolean;

  // Settlement info (for loser UX)
  opponentSettled: boolean;
  takenCardId: number | null;

  // Abandoned game
  isClaimingAbandoned: boolean;
  abandonedDisputeCountdown: number | null;
  /** Claim a present-but-idle (or disconnected) opponent's abandoned game. */
  handleClaimAbandoned: () => void;
  canGoBack: boolean;

  // Actions
  handlePlay: () => void;
  handleCardPacks: () => void;
  handleHandSelected: (ids: number[]) => void;
  handleCancelMatchmaking: () => void;
  handlePackOpened: (location: string, result: { cardIds: number[]; txHash: string | null }) => void;
  handlePackOpenComplete: () => void;
  handlePlaceCard: (handIndex: number, row: number, col: number) => void;
  handleSettle: (selectedCardId: number) => void;
  handleBackToMenu: () => void;
}

/**
 * ## Ref vs State design (applies to all the game hooks)
 *
 * The game hooks use both React state (useState) and refs (useRef) for game
 * data. The split is intentional:
 *
 * **React state** — values that the UI needs to render:
 *   screen, cardIds, handProofStatus, moveProofStatus, settleTxStatus, etc.
 *   Changes trigger re-renders, which update the UI.
 *
 * **Refs** — values consumed by async closures or that must survive
 * navigation. Each hook documents its own refs in its header:
 *   useGameSession:    settlementInfoRef, onChainPhaseRef,
 *                      activePhaseResolveRef, ws-opponent mirror refs.
 *   useGamePlay:       cardIdsRef, moveProofsRef, myHandProofRef/
 *                      opponentHandProofRef, pendingMovesRef,
 *                      gameStateHistoryRef, proof-wait resolvers,
 *                      idempotency guards.
 *   useGameSettlement: noteImportProcessedRef, abandonedClaimStartedRef,
 *                      opponent-settle tracking refs.
 * Cross-hook access goes only through identity-stable accessor functions
 * (getPhase, getSettlementInfo, getMoveProofs, waitFor*…), never raw refs —
 * so callbacks like handleSettle stay memoized while always reading current
 * values (the stale-closure settle bug, see FUTURE_IMPROVEMENTS.md).
 *
 * The general rule: if a value is read inside a txManager.execute() callback
 * or needs to survive screen transitions, it's a ref. If the UI renders it,
 * it's state. Some values exist as both (e.g., useGamePlay's myHandProof is
 * state for the UI status indicator AND a ref for the settlement closure).
 */

/**
 * Facade composing the three game hooks — useGameSession (on-chain
 * lifecycle), useGamePlay (proof orchestration), useGameSettlement
 * (process_game + abandoned-game flows) — plus screen routing, matchmaking,
 * and localStorage game persistence. App.tsx and tests consume only this
 * hook's return value; the sub-hooks are wired here and nowhere else.
 */
export function useGame(wsUrl: string): UseGameReturn {
  const aztec = useAztecContext();
  const ws = useWebSocket(wsUrl);
  const storage = useGameStorage();

  // --- Screen + game state ---
  const [screen, setScreen] = useState<Screen>('main-menu');
  const [cardIds, setCardIds] = useState<number[]>([]);
  const [packResult, setPackResult] = useState<{ location: string; cardIds: number[] } | null>(null);
  const [hasGameInProgress, setHasGameInProgress] = useState(() => storage.hasGame());
  /**
   * A game that still holds this player's cards on-chain.
   *
   * Committing cards is the easy half; getting them back needs somebody to
   * settle or claim. If a player closes the tab mid-game their five cards stay
   * locked, and until now nothing in the app told them so or offered a way
   * out — the claim button lives on the game screen, which they can no longer
   * reach. The bot had exactly this problem and it cost thirty cards.
   */
  const [stuckGame, setStuckGame] = useState<StuckGame | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);

  // --- On-chain session: phase machine, create/join pipeline, settlement info ---
  const session = useGameSession({ ws, screen, cardIds });

  // --- Proof orchestration: hand/move proofs, move queue, board history ---
  const play = useGamePlay({ ws, cardIds, blindingFactor: session.blindingFactor });

  // --- Settlement: process_game, loser note import, abandoned-game flow ---
  const settlement = useGameSettlement({ ws, cardIds, session, play });

  // Look for cards stranded in an unfinished game whenever we are sitting on
  // the menu. Status 2 is ACTIVE: created, joined, and neither settled nor
  // claimed, which is exactly the state where cards are locked.
  useEffect(() => {
    if (screen !== 'main-menu' || !aztec.accountAddress) { return; }
    let cancelled = false;
    void (async () => {
      const saved = storage.loadGame();
      if (!saved?.onChainGameId) { if (!cancelled) setStuckGame(null); return; }
      try {
        const { pxe } = await import('../aztec/pxe');
        const info = await pxe.readAbandonmentInfo(aztec.accountAddress!, saved.onChainGameId);
        if (cancelled) return;

        // 5 = claimed as abandoned. Somebody has moved on our game.
        if (info.status === 5) {
          const mine = info.claimPlayer === aztec.accountAddress;
          const open = nowSeconds() - info.claimAt < DISPUTE_SECONDS;
          setStuckGame({
            onChainGameId: saved.onChainGameId,
            kind: !mine && open ? 'contestable' : 'claimed-by-opponent',
          });
          return;
        }
        if (info.status !== 2) { setStuckGame(null); return; }

        // A COMPLETE game is not claimable and never will be:
        // claim_abandoned_game requires the game to be unfinished for anyone
        // but the winner, and settle_game binds the caller to the winner.
        const moves = saved.collectedMoveProofs?.length ?? 0;
        if (moves >= TOTAL_MOVES) {
          setStuckGame({ onChainGameId: saved.onChainGameId, kind: 'awaiting-winner' });
          return;
        }

        // And the contract will not accept a claim before its own bar, so do
        // not offer one. Showing the wait is honest; a button that reverts is
        // not, and this file has already made that mistake once.
        const age = nowSeconds() - info.activeAt;
        setStuckGame(age >= MIN_ABANDON_SECONDS
          ? { onChainGameId: saved.onChainGameId, kind: 'claimable' }
          : {
              onChainGameId: saved.onChainGameId,
              kind: 'too-soon',
              waitSeconds: MIN_ABANDON_SECONDS - age,
            });
      } catch (err) {
        // A read failure must not invent a stuck game, nor hide a real one —
        // leave whatever we last knew and try again next time we are here.
        console.warn('[useGame] could not check for a stuck game:', err);
      }
    })();
    return () => { cancelled = true; };
    // `storage.loadGame`, not `storage`: depending on the hook's object
    // identity re-runs this on every render, and the setState inside it makes
    // that a loop.
  }, [screen, aztec.accountAddress, storage.loadGame]);

  /**
   * Get the cards back out of a game nobody finished.
   *
   * Restores the saved proofs into the session first — the claim needs both
   * hand proofs, the move proofs so far, and our blinding factor, and all of
   * those are on disk from when the game was live.
   */
  const handleRecoverStuckGame = useCallback(async () => {
    const saved = storage.loadGame();
    // Guarded, not merely hidden: a complete game cannot be claimed, so this
    // must refuse even if something else calls it.
    if (!saved || isRecovering || stuckGame?.kind !== 'claimable') return;
    setIsRecovering(true);
    try {
      setCardIds(saved.selectedCardIds);
      play.restoreFromSave(saved);
      session.restoreFromSave(saved);
      await settlement.handleAbandonedGame();
      setStuckGame(null);
    } catch (err) {
      console.error('[useGame] recovering the stuck game failed:', err);
    } finally {
      setIsRecovering(false);
    }
  }, [storage.loadGame, isRecovering, stuckGame?.kind, play.restoreFromSave,
      session.restoreFromSave, settlement.handleAbandonedGame]);

  /** Object to a standing claim: "I am still here." */
  const handleContestClaim = useCallback(async () => {
    if (stuckGame?.kind !== 'contestable' || !aztec.accountAddress || isRecovering) return;
    setIsRecovering(true);
    try {
      const { pxe } = await import('../aztec/pxe');
      const { AZTEC_TX_TIMEOUT } = await import('../aztec/gameConstants');
      await pxe.sendContestAbandonment(aztec.accountAddress, stuckGame.onChainGameId, {
        node: aztec.nodeClient,
        timeoutMs: AZTEC_TX_TIMEOUT,
      });
      setStuckGame(null);
    } catch (err) {
      console.error('[useGame] contesting the claim failed:', err);
    } finally {
      setIsRecovering(false);
    }
  }, [stuckGame, aztec.accountAddress, isRecovering]);

  // --- Effects ---

  // Persist game state to localStorage
  useEffect(() => {
    if (!ws.gameId || !ws.playerNumber || cardIds.length === 0) return;
    if (screen !== 'game' && screen !== 'finding-opponent') return;

    const persisted: PersistedGameState = {
      gameId: ws.gameId,
      playerNumber: ws.playerNumber,
      selectedCardIds: cardIds,
      savedAt: Date.now(),
    };
    if (session.onChainGameId) persisted.onChainGameId = session.onChainGameId;
    if (play.myHandProof) persisted.myHandProof = play.myHandProof;
    if (play.opponentHandProof) persisted.opponentHandProof = play.opponentHandProof;
    if (play.collectedMoveProofs.length > 0) persisted.collectedMoveProofs = play.collectedMoveProofs;
    if (ws.opponentAztecAddress) persisted.opponentAztecAddress = ws.opponentAztecAddress;
    if (ws.opponentOnChainGameId) persisted.opponentOnChainGameId = ws.opponentOnChainGameId;
    if (session.gameRandomness) persisted.gameRandomness = session.gameRandomness;
    if (session.blindingFactor) persisted.blindingFactor = session.blindingFactor;
    if (ws.opponentGameRandomness) persisted.opponentGameRandomness = ws.opponentGameRandomness;

    storage.saveGame(persisted);
    setHasGameInProgress(true);
  }, [
    ws.gameId, ws.playerNumber, cardIds, screen,
    session.onChainGameId, session.gameRandomness, session.blindingFactor,
    play.myHandProof, play.opponentHandProof, play.collectedMoveProofs,
    ws.opponentAztecAddress, ws.opponentOnChainGameId, ws.opponentGameRandomness,
    storage,
  ]);

  // Clear saved game on GAME_OVER
  useEffect(() => {
    if (ws.gameOver) {
      storage.clearGame();
      setHasGameInProgress(false);
    }
  }, [ws.gameOver, storage]);

  // Matchmaking: transition to game when match found
  useEffect(() => {
    if (ws.matchmakingStatus === 'matched' && screen === 'finding-opponent') {
      setScreen('game');
    }
  }, [ws.matchmakingStatus, screen]);

  // Matchmaking ping
  useEffect(() => {
    if (screen !== 'finding-opponent') return;
    const interval = setInterval(() => ws.ping(), 10000);
    return () => clearInterval(interval);
  }, [screen, ws.ping]);

  // Reset state on returning to menu
  useEffect(() => {
    if (screen === 'main-menu') {
      // Session state/refs (onChainPhaseRef deliberately survives — see
      // useGameSession.resetForMenu)
      session.resetForMenu();
      // Proof state, move queue, board history, proof-wait resolvers
      play.resetForMenu();
      // Settle tx state, loser-side tracking, note-import guard
      settlement.resetForMenu();
    }
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- User actions ---

  const handlePlay = useCallback(() => {
    const saved = storage.loadGame();
    if (saved) {
      setCardIds(saved.selectedCardIds);
      play.restoreFromSave(saved);
      session.restoreFromSave(saved);
      ws.queueMatchmaking(saved.selectedCardIds);
      setScreen('finding-opponent');
      return;
    }
    setScreen('card-selector');
  }, [storage, ws, play.restoreFromSave, session.restoreFromSave]);

  const handleCardPacks = useCallback(() => {
    setScreen('card-packs');
  }, []);

  const handleHandSelected = useCallback((ids: number[]) => {
    console.log('[useGame] handleHandSelected: selectedIds=', ids, 'ownedCards=', aztec.ownedCardIds);
    setCardIds(ids);
    ws.queueMatchmaking(ids);
    setScreen('finding-opponent');
  }, [ws, aztec.ownedCardIds]);

  const handleCancelMatchmaking = useCallback(() => {
    ws.cancelMatchmaking();
    setCardIds([]);
    storage.clearGame();
    setHasGameInProgress(false);
    setScreen('main-menu');
  }, [ws, storage]);

  const handlePackOpened = useCallback((location: string, result: { cardIds: number[]; txHash: string | null }) => {
    setPackResult({ location, cardIds: result.cardIds });
    setScreen('pack-opening');
  }, []);

  const handlePackOpenComplete = useCallback(() => {
    setPackResult(prev => {
      if (prev) {
        aztec.updateOwnedCards(cards => [...cards, ...prev.cardIds]);
      }
      return null;
    });
    // Refresh token balance after purchase (tokens were burned). Fire-and-forget;
    // serialized reads no longer throw from IDB, so a real failure surfaces.
    aztec.refreshTokenBalance();
    setScreen('card-packs');
  }, [aztec]);

  // canGoBack: winner can leave after picking a card (settlement runs in background via txManager).
  // Winner can leave once settlement started (txManager runs in background).
  // Loser must wait for NOTE_DATA (awaiting_settlement blocks navigation).
  const phase = session.getPhase();
  const canGoBack = screen === 'main-menu'
    || phase === 'settling'   // winner: settlement in progress, can leave
    || phase === 'idle';      // no lifecycle active

  // Closing the tab now costs somebody real cards — us if our own settlement is
  // in flight, the OPPONENT if we still owe them a move proof they need to
  // settle. See useUnloadGuard for why the last move is the dangerous one.
  useUnloadGuard(
    play.owedMoveProofs > 0
      || (['preparing', 'proving', 'sending'] as TxStatus[]).includes(settlement.settleTxStatus),
    play.owedMoveProofs > 0
      ? 'A move proof is still being sent. Leaving now prevents your opponent from settling the game.'
      : 'Your settlement transaction is still in flight. Leaving now may leave the game unsettled.',
  );

  const handleBackToMenu = useCallback(() => {
    const currentPhase = session.getPhase();
    if (currentPhase !== 'idle' && currentPhase !== 'settling') {
      console.log('[useGame] Back to menu blocked: game in-flight (phase:', currentPhase, ')');
      return;
    }

    ws.leaveGame();
    setCardIds([]);
    storage.clearGame();
    setHasGameInProgress(false);
    settlement.cancelAbandonedUi();
    setScreen('main-menu');
  }, [ws, storage, session.getPhase, settlement.cancelAbandonedUi]);

  return {
    screen, setScreen,
    ws,
    onChainGameId: session.onChainGameId,
    handProofStatus: play.handProofStatus,
    moveProofStatus: play.moveProofStatus,
    canSettle: play.canSettle,
    settleTxStatus: settlement.settleTxStatus,
    onChainError: session.onChainError,
    myHandProof: play.myHandProof,
    opponentHandProof: play.opponentHandProof,
    collectedMoveProofs: play.collectedMoveProofs,
    settleTxHash: settlement.settleTxHash,
    cardIds, packResult, hasGameInProgress,
    stuckGame, isRecovering, handleRecoverStuckGame, handleContestClaim,
    opponentSettled: settlement.opponentSettled,
    takenCardId: settlement.takenCardId,
    isClaimingAbandoned: settlement.isClaimingAbandoned,
    abandonedDisputeCountdown: settlement.abandonedDisputeCountdown,
    handleClaimAbandoned: settlement.handleAbandonedGame,
    canGoBack,
    handlePlay, handleCardPacks, handleHandSelected,
    handleCancelMatchmaking, handlePackOpened, handlePackOpenComplete,
    handlePlaceCard: play.handlePlaceCard,
    handleSettle: settlement.handleSettle,
    handleBackToMenu,
  };
}
