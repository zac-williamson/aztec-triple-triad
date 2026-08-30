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

  // --- On-chain session: phase machine, create/join pipeline, settlement info ---
  const session = useGameSession({ ws, screen, cardIds });

  // --- Proof orchestration: hand/move proofs, move queue, board history ---
  const play = useGamePlay({ ws, cardIds, blindingFactor: session.blindingFactor });

  // --- Settlement: process_game, loser note import, abandoned-game flow ---
  const settlement = useGameSettlement({
    ws, cardIds, play,
    session: { ...session, blindingFactor: session.blindingFactor },
  });

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
