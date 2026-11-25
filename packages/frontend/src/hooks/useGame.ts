import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from './useWebSocket';
import type { ProofStatus } from './useProofGeneration';
import { useGameStorage, commitIsStale, toPrivateGame, type PersistedGameState } from './useGameStorage';
import { useGameChannel } from './useGameChannel';
import { useGameSession, type CommitStatus, type OnChainPhase } from './useGameSession';
import { useGamePlay } from './useGamePlay';
import { useGameSettlement, type TxStatus } from './useGameSettlement';
import { useUnloadGuard } from './useUnloadGuard';
import { useAztecContext } from '../aztec/AztecContext';
import type { Screen, MoveProofData, GameState, Player } from '../types';
import type { StuckGame, StuckGameKind } from '../aztec/stuckGame';
import { inspectStuckGame, recoverStuckGame } from './stuckGameCheck';
import { contestClaim } from '../aztec/gameActions';

export type { StuckGame, StuckGameKind } from '../aztec/stuckGame';

// Re-export types consumers need
export type { TxStatus, ProofStatus, CommitStatus };

// Re-export the on-chain phase machine and winner mapping so consumers and
// tests keep importing from useGame (they live in useGameSession/useGamePlay).
export { VALID_TRANSITIONS } from './useGameSession';
export type { OnChainPhase } from './useGameSession';
export { mapWinnerId } from './useGamePlay';

/** How often the menu looks at a stuck game again (a claim window closing, a settlement landing). */
const STUCK_RECHECK_MS = 60_000;

/**
 * Phases a player may walk away from: nothing of theirs is in flight that
 * needs this screen. That includes everything before a join: a creator who
 * leaves sends nothing more, or has the game cancelled by the menu once its
 * create lands (docs/plan/PRIVATE_GAMES.md §5.5).
 */
const LEAVABLE_PHASES: OnChainPhase[] = ['idle', 'settling', 'creating', 'awaiting_join', 'awaiting_create', 'awaiting_settlement'];

/** Stuck games the menu resolves by itself: nothing about them is the player's to decide. */
const AUTO_RECOVER_KINDS: StuckGameKind[] = ['cancellable', 'finalizable'];

export interface UseGameReturn {
  // Screen routing
  screen: Screen;
  setScreen: (s: Screen) => void;

  // WebSocket state (pass-through for components)
  ws: ReturnType<typeof useWebSocket>;

  // The game, as this client runs it (useGamePlay): the relay holds none of it
  /** Board, hands (the opponent's unseen cards face down), turn, scores, status, winner. */
  gameState: GameState | null;
  lastCaptures: { row: number; col: number }[];
  gameOver: { winner: Player | 'draw' } | null;
  /** This player's side in the game on screen. */
  playerNumber: 1 | 2 | null;
  /** The relay room of the game on screen. */
  roomId: string | null;
  /** Per card of our hand as shown: true when the opponent cannot see it. */
  myHandHidden: boolean[];
  /** The opponent's open cards are proven and shown. */
  opponentOpenKnown: boolean;
  /** The opponent sent a move or open cards that did not check out: the game cannot settle. */
  protocolError: string | null;
  /** A problem on our side (a proof that failed, a check that could not run). */
  playError: string | null;

  // On-chain + proof state
  /** The game's `created` nullifier, once known (its only public trace). */
  onChainGameId: string | null;
  /** Both players' commitments: 'ready' once both records are committed and known. */
  commitStatus: CommitStatus;
  moveProofStatus: ProofStatus;
  canSettle: boolean;
  settleTxStatus: TxStatus;
  onChainError: string | null;

  // Chain-view data (privacy panel)
  /** Our hand commitment (from our record), once committed. */
  myHandCommit: string | null;
  /** The opponent's hand commitment (from their record), once known. */
  opponentHandCommit: string | null;
  collectedMoveProofs: MoveProofData[];
  settleTxHash: string | null;

  // Game state
  cardIds: number[];
  /** A game still holding this player's cards on-chain, if any. */
  stuckGame: StuckGame | null;
  isRecovering: boolean;
  /** Act on the stuck game: cancel, settle, claim or finalize — whatever it allows. */
  handleRecoverStuckGame: () => Promise<void>;
  handleContestClaim: () => Promise<void>;
  packResult: { location: string; cardIds: number[] } | null;
  hasGameInProgress: boolean;

  // Settlement info (for loser UX)
  opponentSettled: boolean;
  takenCardId: number | null;

  // Abandoned game
  isClaimingAbandoned: boolean;
  /** Seconds until the contract will accept the claim, while it waits; else null. */
  abandonBarCountdown: number | null;
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
 *   screen, cardIds, commitStatus, moveProofStatus, settleTxStatus, etc.
 *   Changes trigger re-renders, which update the UI.
 *
 * **Refs** — values consumed by async closures or that must survive
 * navigation. Each hook documents its own refs in its header:
 *   useGameChannel:    the live channel, held inbound payloads.
 *   useGameSession:    the phase, the game's records/key/nonce, the
 *                      active-phase resolver.
 *   useGamePlay:       the committed hand, move proofs, the pending-move queue.
 *   useGameSettlement: settle/import guards, the resolution poll.
 * Cross-hook access goes only through identity-stable accessor functions
 * (getPhase, getGame, getMoveProofs, waitFor*…), never raw refs —
 * so callbacks like handleSettle stay memoized while always reading current
 * values (the stale-closure settle bug, see FUTURE_IMPROVEMENTS.md).
 */

/**
 * Facade composing the game hooks — useGameChannel (key exchange, sealed
 * peer payloads), useGameSession (on-chain lifecycle), useGamePlay (move
 * proofs), useGameSettlement (settle, import, abandonment) — plus screen
 * routing, matchmaking, the menu's recovery of unfinished games, and
 * localStorage persistence. App.tsx and tests consume only this hook's return
 * value; the sub-hooks are wired here and nowhere else.
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
   * settle, cancel or unwind — and every one of those needs this player's
   * stored records, so the menu is where a player who closed the tab finds
   * their way back.
   */
  const [stuckGame, setStuckGame] = useState<StuckGame | null>(null);
  const [isRecovering, setIsRecovering] = useState(false);

  // --- Key exchange and the sealed channel to the opponent ---
  const channel = useGameChannel({ ws, storage });

  // --- On-chain session: phase machine, create/join pipeline, records ---
  const session = useGameSession({ ws, screen, cardIds, channel, storage });

  // --- The game itself: our moves proven and sent, theirs checked and applied ---
  const play = useGamePlay({ ws, cardIds, blindingFactor: session.blindingFactor, commits: session.commits, channel, storage });

  // --- Settlement: settle, import, abandoned-game flow ---
  const settlement = useGameSettlement({ ws, session, play, channel, storage });

  const aztecRef = useRef(aztec);
  aztecRef.current = aztec;

  // Look for a game that needs the player whenever they sit on the menu, and
  // keep looking while one is there: claim windows close, settlements land.
  const [stuckCheckTick, setStuckCheckTick] = useState(0);
  useEffect(() => {
    // Not before the wallet is connected: a restore knows the address from its
    // first phase, but the PXE door and the node are bound only as it ends —
    // and a look before that fails and is not retried for a minute.
    if (screen !== 'main-menu' || !aztec.accountAddress || !aztec.isAvailable) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      try {
        const next = await inspectStuckGame(storage, { owner: aztec.accountAddress!, node: aztec.nodeClient }, {
          // A settlement still running in the background owns its game.
          skip: roomId => session.getPhase() !== 'idle' && session.getGame()?.roomId === roomId,
          onImported: (result) => {
            const a = aztecRef.current;
            if (result.importedCardIds.length > 0) a.updateOwnedCards(prev => [...prev, ...result.importedCardIds]);
            if (result.prizeUncertain) void a.refreshOwnedCards();
            void a.refreshTokenBalance();
          },
        });
        if (!cancelled) setStuckGame(next);
      } catch (err) {
        // A read failure must not invent a stuck game, nor hide a real one —
        // leave whatever we last knew and try again shortly.
        console.warn('[useGame] could not check for a stuck game:', err);
      }
      if (!cancelled) timer = setTimeout(() => setStuckCheckTick(t => t + 1), STUCK_RECHECK_MS);
    })();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // `storage.listClaimable` etc. are stable; depending on the hook's object
    // would re-run this on every render, and the setState inside makes a loop.
  }, [screen, aztec.accountAddress, aztec.isAvailable, stuckCheckTick]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Act on a stuck game: whatever the chain allows for it right now. */
  const isRecoveringRef = useRef(false);
  const recoverGame = useCallback(async (stuck: StuckGame) => {
    if (isRecoveringRef.current || !aztec.accountAddress) return;
    const saved = storage.readGame(stuck.roomId) as PersistedGameState | null;
    const game = saved ? toPrivateGame(saved) : null;
    if (!saved || !game) return;
    isRecoveringRef.current = true;
    setIsRecovering(true);
    try {
      const result = await recoverStuckGame(stuck, saved, game, { owner: aztec.accountAddress, node: aztec.nodeClient }, {
        storage,
        sendPeerFor: channel.sendPeerFor,
      });
      if (result) {
        const a = aztecRef.current;
        if (result.importedCardIds.length > 0) a.updateOwnedCards(prev => [...prev, ...result.importedCardIds]);
        if (result.prizeUncertain) void a.refreshOwnedCards();
        void a.refreshTokenBalance();
        storage.clearGame(stuck.roomId);
      }
      setStuckGame(null);
      setStuckCheckTick(t => t + 1);
    } catch (err) {
      console.error('[useGame] recovering the stuck game failed:', err);
    } finally {
      isRecoveringRef.current = false;
      setIsRecovering(false);
    }
  }, [aztec.accountAddress, aztec.nodeClient, storage, channel.sendPeerFor]);

  const handleRecoverStuckGame = useCallback(async () => {
    if (stuckGame) await recoverGame(stuckGame);
  }, [stuckGame, recoverGame]);

  // What needs no decision is done without a click (docs/plan/PRIVATE_GAMES.md
  // §5.5): a game nobody joined is cancelled, and a claim whose window has
  // closed is finalized — whichever side of it this player is on. Once per
  // game (and claim) per page load: a failed send still costs a proof and a
  // fee, and the menu's button stays for a retry.
  const autoRecoveredRef = useRef(new Set<string>());
  useEffect(() => {
    if (!stuckGame || !AUTO_RECOVER_KINDS.includes(stuckGame.kind)) return;
    const key = `${stuckGame.roomId}|${stuckGame.kind}|${stuckGame.claim?.claimNo ?? ''}`;
    if (autoRecoveredRef.current.has(key)) return;
    autoRecoveredRef.current.add(key);
    console.log(`[useGame] ${stuckGame.kind === 'cancellable' ? 'cancelling a game nobody joined' : 'finalizing a claim whose window closed'} (${stuckGame.roomId})`);
    void recoverGame(stuckGame);
  }, [stuckGame, recoverGame]);

  /** Object to a standing claim: "I am still here." */
  const handleContestClaim = useCallback(async () => {
    const stuck = stuckGame;
    if (stuck?.kind !== 'contestable' || !stuck.claim || !aztec.accountAddress || isRecoveringRef.current) return;
    const saved = storage.readGame(stuck.roomId) as PersistedGameState | null;
    const game = saved ? toPrivateGame(saved) : null;
    if (!game) return;
    isRecoveringRef.current = true;
    setIsRecovering(true);
    try {
      await contestClaim(game, { owner: aztec.accountAddress, node: aztec.nodeClient }, stuck.claim);
      setStuckGame(null);
      setStuckCheckTick(t => t + 1);
    } catch (err) {
      console.error('[useGame] contesting the claim failed:', err);
    } finally {
      isRecoveringRef.current = false;
      setIsRecovering(false);
    }
  }, [stuckGame, aztec.accountAddress, aztec.nodeClient, storage]);

  // --- Effects ---

  // Persist the game. The records, key and nonce are written by the channel
  // and the session the moment they exist, and the transcript by useGamePlay
  // as it grows; this adds role and hand, MERGED into the same record.
  useEffect(() => {
    if (!ws.gameId || !ws.playerNumber || cardIds.length === 0) return;
    if (screen !== 'game' && screen !== 'finding-opponent') return;

    const persisted: PersistedGameState = {
      gameId: ws.gameId,
      playerNumber: ws.playerNumber,
      selectedCardIds: cardIds,
      savedAt: Date.now(),
    };
    storage.saveGame(persisted);
    setHasGameInProgress(true);
  }, [ws.gameId, ws.playerNumber, cardIds, screen, storage]);

  // Mark the game over — but KEEP the record: until this player's notes from
  // the resolution are imported it is the only way back to their cards.
  useEffect(() => {
    if (play.gameOver) {
      storage.markFinished();
      setHasGameInProgress(false);
    }
  }, [play.gameOver, storage]);

  // Matchmaking: transition to game when match found
  useEffect(() => {
    if (ws.matchmakingStatus === 'matched' && screen === 'finding-opponent') {
      setScreen('game');
    }
  }, [ws.matchmakingStatus, screen]);

  // Pull the settlement modules in as soon as a game opens.
  //
  // Settlement imports the SDK, the proving backend and the circuit loader
  // dynamically, and those resolve to hashed chunks that a deploy replaces —
  // so a tab opened before a deploy asks for a file that no longer exists and
  // settlement dies with "Failed to fetch dynamically imported module", with
  // the wager already committed. Importing here puts them in the tab's module
  // registry while nothing is at stake yet; a later deploy cannot take them back.
  useEffect(() => {
    if (screen !== 'game' && screen !== 'finding-opponent') return;
    void import('../aztec/warmSettlementModules').then(m => m.warmSettlementModules());
  }, [screen]);

  // Matchmaking ping
  useEffect(() => {
    if (screen !== 'finding-opponent') return;
    const interval = setInterval(() => ws.ping(), 10000);
    return () => clearInterval(interval);
  }, [screen, ws.ping]);

  // Reset state on returning to menu
  useEffect(() => {
    if (screen === 'main-menu') {
      channel.resetForMenu();
      // Session state/refs (onChainPhaseRef deliberately survives — see
      // useGameSession.resetForMenu)
      session.resetForMenu();
      // Proof state, move queue
      play.resetForMenu();
      // Settle tx state, loser-side tracking, the resolution poll
      settlement.resetForMenu();
    }
  }, [screen]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- User actions ---

  /**
   * Play — or, with a game in progress, Resume it: rebuilt from its stored
   * transcript (section 6.4), with the relay's room — the replayed moves were
   * kept as they arrived, and ROOM_STATE says which of ours it never got.
   * Never a new queue: that would open a new room, and the cards are committed
   * to this one.
   */
  const handlePlay = useCallback(() => {
    const saved = storage.loadGame();
    if (saved) {
      setCardIds(saved.selectedCardIds);
      channel.restoreFromSave(saved);
      session.restoreFromSave(saved);
      play.restoreFromSave(saved);
      if (ws.gameId !== saved.gameId) {
        console.warn(`[useGame] resuming ${saved.gameId}, which the relay does not report (it has ${ws.gameId ?? 'none'})`);
      }
      setScreen('game');
      return;
    }
    setScreen('card-selector');
  }, [storage, ws.gameId, channel.restoreFromSave, play.restoreFromSave, session.restoreFromSave]);

  const handleCardPacks = useCallback(() => {
    setScreen('card-packs');
  }, []);

  const handleHandSelected = useCallback((ids: number[]) => {
    console.log('[useGame] handleHandSelected: selectedIds=', ids, 'ownedCards=', aztec.ownedCardIds);
    setCardIds(ids);
    // The relay is told nothing about the hand: it only pairs us.
    ws.queueMatchmaking();
    setScreen('finding-opponent');
  }, [ws, aztec.ownedCardIds]);

  const handleCancelMatchmaking = useCallback(() => {
    ws.cancelMatchmaking();
    setCardIds([]);
    storage.leaveCurrentGame();
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

  // A player may leave once nothing of theirs that needs this screen is in
  // flight: no commit tx, and no move proof the opponent is waiting for. A
  // finished game can be left before its settlement — the record stays, and
  // the menu imports (or settles) it.
  // A game halted by a refused move (or open cards) can never settle: it may
  // be left too, and the menu offers its claim once the contract allows one.
  const phase = session.getPhase();
  const gameOverNothingOwed = (!!play.gameOver || !!play.protocolError) && play.owedMoveProofs === 0;
  const canLeave = LEAVABLE_PHASES.includes(phase) || (phase === 'active' && gameOverNothingOwed);
  const canGoBack = screen === 'main-menu' || canLeave;

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
    const leavable = LEAVABLE_PHASES.includes(currentPhase)
      || (currentPhase === 'active' && (!!play.gameOver || !!play.protocolError) && play.owedMoveProofs === 0);
    if (!leavable) {
      console.log('[useGame] Back to menu blocked: game in-flight (phase:', currentPhase, ')');
      return;
    }

    ws.leaveGame();
    setCardIds([]);
    // Keeps the record if it still holds cards: the menu needs it to get them back.
    storage.leaveCurrentGame();
    setHasGameInProgress(false);
    // A settlement in flight finishes on its own; anything else ends here.
    if (currentPhase !== 'settling') session.forceIdle();
    settlement.cancelAbandonedUi();
    setScreen('main-menu');
  }, [ws, storage, session.getPhase, session.forceIdle, settlement.cancelAbandonedUi, play.owedMoveProofs, play.gameOver,
      play.protocolError]);

  const myRole = play.role ?? ws.playerNumber;
  const commits = session.commits;
  return {
    screen, setScreen,
    ws,
    gameState: play.gameState,
    lastCaptures: play.lastCaptures,
    gameOver: play.gameOver,
    playerNumber: myRole,
    roomId: play.roomId ?? ws.gameId,
    myHandHidden: play.myHandHidden,
    opponentOpenKnown: play.opponentOpenKnown,
    protocolError: play.protocolError,
    playError: play.playError,
    onChainGameId: session.onChainGameId,
    commitStatus: session.commitStatus,
    moveProofStatus: play.moveProofStatus,
    canSettle: play.canSettle,
    settleTxStatus: settlement.settleTxStatus,
    onChainError: session.onChainError,
    myHandCommit: commits && myRole ? (myRole === 1 ? commits.commit1 : commits.commit2) : null,
    opponentHandCommit: commits && myRole ? (myRole === 1 ? commits.commit2 : commits.commit1) : null,
    collectedMoveProofs: play.collectedMoveProofs,
    settleTxHash: settlement.settleTxHash,
    cardIds, packResult, hasGameInProgress,
    stuckGame, isRecovering, handleRecoverStuckGame, handleContestClaim,
    opponentSettled: settlement.opponentSettled,
    takenCardId: settlement.takenCardId,
    isClaimingAbandoned: settlement.isClaimingAbandoned,
    abandonBarCountdown: settlement.abandonBarCountdown,
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
