import { useState, useCallback, useEffect, useRef } from 'react';
import type { UseWebSocketReturn } from './useWebSocket';
import type { PersistedGameState } from './useGameStorage';
import { useAztecContext } from '../aztec/AztecContext';
import { removeCards } from '../aztec/cardStore';
import { runPxeTx, warmupPxe, type PxeOps } from '../aztec/pxe';
import { AZTEC_CONFIG } from '../aztec/config';
import { AZTEC_TX_TIMEOUT } from '../aztec/gameConstants';
import { requireWallet, requireAccountAddress } from '../aztec/walletGuards';
import type { Screen } from '../types';

// --- On-chain lifecycle phase ---
export type OnChainPhase =
  | 'idle'                  // No game lifecycle in progress. Safe to create a new game.
  | 'creating'              // P1: sending create_game tx via txManager.
  | 'awaiting_join'         // P1: create_game mined. Waiting for P2's join_game to mine.
  | 'preparing'             // P2: read-only PXE simulations before sending any tx.
  | 'awaiting_create'       // P2: preview data shared. Waiting for P1's create_game to confirm.
  | 'joining'               // P2: sending join_game tx via txManager.
  | 'active'                // Both players joined on-chain. Game in progress.
  | 'settling'              // Winner: actively sending process_game / claim_abandoned_game.
  | 'awaiting_settlement';  // Loser: waiting for opponent's settlement + NOTE_DATA.

export const VALID_TRANSITIONS: Record<OnChainPhase, OnChainPhase[]> = {
  idle:                 ['creating', 'preparing'],
  creating:             ['awaiting_join', 'idle'],
  awaiting_join:        ['active', 'idle'],
  preparing:            ['awaiting_create', 'idle'],
  awaiting_create:      ['joining', 'idle'],
  joining:              ['active', 'awaiting_create', 'idle'],
  active:               ['settling', 'awaiting_settlement', 'idle'],
  settling:             ['idle'],
  awaiting_settlement:  ['idle'],
};

/**
 * Pipeline-derived data that settle_game needs. Populated by pipeline
 * postEffects and WebSocket effects. NOT cleared by menu navigation or
 * ws.leaveGame(), so settlement survives leaving the game screen.
 */
export interface SettlementInfo {
  onChainGameId: string;
  gameRandomness: string[];
  opponentAddress: string;
  opponentRandomness: string[];
  callerCardIds: number[];
  opponentCardIds: number[];
}

export interface UseGameSessionParams {
  ws: UseWebSocketReturn;
  /** Current UI screen — the pipeline never starts during menu navigation. */
  screen: Screen;
  /** The 5 card IDs the player selected for this game. */
  cardIds: number[];
}

export interface UseGameSessionReturn {
  // UI-rendered state
  onChainGameId: string | null;
  gameRandomness: string[] | null;
  blindingFactor: string | null;
  onChainError: string | null;

  // Stable functions (identity never changes) — safe to close over in
  // async callbacks and to list in other hooks' useCallback deps.
  getPhase: () => OnChainPhase;
  transitionPhase: (to: OnChainPhase) => void;
  /** Resolves when the phase reaches 'active'; rejects after timeoutMs. */
  waitForActivePhase: (timeoutMs: number) => Promise<void>;
  getSettlementInfo: () => SettlementInfo | null;
  /** Identity-stable read of the blinding factor — see SettlementSessionDeps. */
  getBlindingFactor: () => string | null;
  /**
   * Merge the latest ws opponent state (address, randomness, card IDs) into
   * settlementInfo for any field still empty, then return it. Recovers from
   * the race where OPPONENT_AZTEC_INFO / GAME_OVER arrived before the
   * pipeline seeded the ref (see useGame.orchestration.test.ts bugs #1/#2).
   */
  backfillSettlementInfoFromWs: () => SettlementInfo | null;
  clearSettlementInfo: () => void;
  restoreFromSave: (saved: PersistedGameState) => void;
  resetForMenu: () => void;
}

/**
 * On-chain session lifecycle: the OnChainPhase state machine, the
 * create/join pipeline (P1 create_game, P2 prepare+join_game via txManager),
 * preview-data sharing, and settlementInfo seeding.
 *
 * Ref-vs-state split (see useGame.ts for the architecture rationale):
 *   onChainPhaseRef:     State machine for the on-chain lifecycle. Managed by
 *                        transitionPhase(). NOT reset on menu navigation to avoid
 *                        re-triggering spurious create_game.
 *   settlementInfoRef:   Pipeline-derived data (gameId, randomness, card IDs,
 *                        opponent address/randomness). Populated by pipeline
 *                        postEffects and WS listener. NOT cleared on navigation
 *                        — settlement may run after the user leaves the game screen.
 *   activePhaseResolveRef: Promise resolver for awaiting_join → active
 *                        (P1 waiting for P2 join).
 */
export function useGameSession({ ws, screen, cardIds }: UseGameSessionParams): UseGameSessionReturn {
  const aztec = useAztecContext();

  const [onChainGameId, setOnChainGameId] = useState<string | null>(null);
  const [gameRandomness, setGameRandomness] = useState<string[] | null>(null);
  const [blindingFactor, setBlindingFactor] = useState<string | null>(null);
  const [onChainError, setOnChainError] = useState<string | null>(null);

  const isContractAvailable = aztec.wallet !== null && AZTEC_CONFIG.enabled && !!AZTEC_CONFIG.gameContractAddress;

  // Typed phase ref (replaces 4 boolean guards)
  const onChainPhaseRef = useRef<OnChainPhase>('idle');

  // Promise resolver for awaiting_join → active transition (P1 waiting for P2 join)
  const activePhaseResolveRef = useRef<(() => void) | null>(null);

  // Persistent ref for pipeline-dependent values that settle_game needs.
  // Populated by pipeline postEffects and WebSocket effects. NOT cleared
  // by handleBackToMenu or ws.leaveGame(), so settlement survives navigation.
  const settlementInfoRef = useRef<SettlementInfo | null>(null);

  // Guard: preview data already shared with opponent via WebSocket
  const previewSharedRef = useRef(false);

  // Refs mirroring ws state that pipeline postEffects (seeding) and
  // backfillSettlementInfoFromWs read. The pipeline effect and the stable
  // backfill callback both close over a stale `ws` object from an earlier
  // render (their dependency arrays deliberately exclude these ws fields —
  // they'd re-fire the pipeline / re-create callbacks on every update,
  // breaking in-flight work). These refs are updated on every render so
  // those closures always read the current value regardless of staleness.
  const wsOpponentCardIdsRef = useRef(ws.opponentCardIds);
  wsOpponentCardIdsRef.current = ws.opponentCardIds;
  const wsOpponentAztecAddressRef = useRef(ws.opponentAztecAddress);
  wsOpponentAztecAddressRef.current = ws.opponentAztecAddress;
  const wsOpponentGameRandomnessRef = useRef(ws.opponentGameRandomness);
  wsOpponentGameRandomnessRef.current = ws.opponentGameRandomness;

  const transitionPhase = useCallback((to: OnChainPhase): void => {
    const from = onChainPhaseRef.current;
    if (from === to) return;
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      console.error(`[useGameSession] Invalid phase transition: ${from} → ${to}`);
      return;
    }
    console.log(`[useGameSession] Phase: ${from} → ${to}`);
    onChainPhaseRef.current = to;

    // Resolve any waiters on the 'active' phase
    if (to === 'active' && activePhaseResolveRef.current) {
      activePhaseResolveRef.current();
      activePhaseResolveRef.current = null;
    }
  }, []);

  const getPhase = useCallback((): OnChainPhase => onChainPhaseRef.current, []);

  const waitForActivePhase = useCallback((timeoutMs: number): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      if (onChainPhaseRef.current === 'active') { resolve(); return; }
      activePhaseResolveRef.current = resolve;
      setTimeout(() => {
        activePhaseResolveRef.current = null;
        reject(new Error(`Timed out waiting for game to become active (phase: ${onChainPhaseRef.current})`));
      }, timeoutMs);
    });
  }, []);

  const getSettlementInfo = useCallback((): SettlementInfo | null => settlementInfoRef.current, []);

  // Mirrors the state into a ref so the getter can stay identity-stable: a
  // settlement callback captured before the pipeline set it would otherwise read
  // null forever.
  const blindingFactorRef = useRef<string | null>(null);
  blindingFactorRef.current = blindingFactor;
  const getBlindingFactor = useCallback((): string | null => blindingFactorRef.current, []);

  const backfillSettlementInfoFromWs = useCallback((): SettlementInfo | null => {
    const sInfo = settlementInfoRef.current;
    if (!sInfo) return null;

    const liveWsOpponentAddress = wsOpponentAztecAddressRef.current;
    const liveWsOpponentRandomness = wsOpponentGameRandomnessRef.current;
    const liveWsOpponentCardIds = wsOpponentCardIdsRef.current;

    if (!sInfo.opponentAddress && liveWsOpponentAddress) {
      console.log('[useGameSession] Backfilling opponentAddress from ws state');
      sInfo.opponentAddress = liveWsOpponentAddress;
    }
    if (sInfo.opponentRandomness.length === 0 && liveWsOpponentRandomness?.length === 6) {
      console.log('[useGameSession] Backfilling opponentRandomness from ws state');
      sInfo.opponentRandomness = [...liveWsOpponentRandomness];
    }
    if (sInfo.opponentCardIds.length === 0 && liveWsOpponentCardIds.length > 0) {
      console.log('[useGameSession] Backfilling opponentCardIds from ws state');
      sInfo.opponentCardIds = [...liveWsOpponentCardIds];
    }
    return sInfo;
  }, []);

  const clearSettlementInfo = useCallback((): void => {
    settlementInfoRef.current = null;
  }, []);

  // --- Contract actions (inline, not cross-hook) ---

  const createGameOnChain = useCallback(async (ops: PxeOps, ids: number[]): Promise<{ gameId: string; randomness: string[]; blindingFactor: string; txHash: string }> => {
    requireWallet(aztec.wallet);
    const addr = requireAccountAddress(aztec.accountAddress);

    console.log('[useGameSession] Starting create_game pipeline...');
    const { gameId, randomness, blindingFactor, status } = await ops.previewCreateGame(addr);
    if (status !== 0) {
      throw new Error(`Game ID already exists with status ${status}, nonce may be stale`);
    }

    setOnChainGameId(gameId);
    setGameRandomness(randomness);
    setBlindingFactor(blindingFactor);
    console.log('[useGameSession] Game preview ready, ID:', gameId, '— sending create_game tx...');

    const txHash = await ops.sendCreateGame(addr, ids, { node: aztec.nodeClient, timeoutMs: AZTEC_TX_TIMEOUT });
    console.log('[useGameSession] create_game tx mined, txHash:', txHash);

    // DIAGNOSTIC: dump TxEffect nullifiers from create_game so we can compare
    // with PXE's stored siloedNullifiers. Node read — not a PXE op.
    try {
      const nodeClient = aztec.nodeClient as any;
      if (nodeClient) {
        const { TxHash } = await import('@aztec/stdlib/tx');
        const hash = TxHash.fromString(txHash);
        const txResult = await nodeClient.getTxEffect(hash);
        if (txResult?.data) {
          const nullifiers = txResult.data.nullifiers ?? [];
          console.log(`[useGameSession] create_game TxEffect: ${nullifiers.length} nullifiers, block=${txResult.l2BlockNumber}`);
          const noteHashes = txResult.data.noteHashes ?? [];
          console.log(`[useGameSession] create_game TxEffect: ${noteHashes.length} noteHashes`);
        }
      }
    } catch (diagErr) {
      console.warn('[useGameSession] create_game diagnostic failed:', diagErr);
    }

    // Remove committed cards from localStorage after confirmed tx
    if (addr) removeCards(addr, ids);

    return { gameId, randomness, blindingFactor, txHash };
  }, [aztec.wallet, aztec.accountAddress, aztec.nodeClient]);

  const prepareJoinGame = useCallback(async (ops: PxeOps, chainGameId: string): Promise<{ randomness: string[]; blindingFactor: string }> => {
    requireWallet(aztec.wallet);
    const addr = requireAccountAddress(aztec.accountAddress);

    console.log('[useGameSession] Preparing join_game preview...');
    const { randomness, blindingFactor } = await ops.previewJoinGame(addr, chainGameId);

    setOnChainGameId(chainGameId);
    setGameRandomness(randomness);
    setBlindingFactor(blindingFactor);
    console.log('[useGameSession] Join preview ready (no tx sent yet)');

    return { randomness, blindingFactor };
  }, [aztec.wallet, aztec.accountAddress]);

  const sendJoinGameTx = useCallback(async (ops: PxeOps, chainGameId: string, ids: number[]): Promise<string> => {
    requireWallet(aztec.wallet);
    const addr = requireAccountAddress(aztec.accountAddress);

    console.log('[useGameSession] Sending join_game tx...');
    const txHash = await ops.sendJoinGame(addr, chainGameId, ids, { node: aztec.nodeClient, timeoutMs: AZTEC_TX_TIMEOUT });
    console.log('[useGameSession] join_game tx mined, txHash:', txHash);

    // Remove committed cards from localStorage after confirmed tx
    if (addr) removeCards(addr, ids);

    return txHash;
  }, [aztec.wallet, aztec.accountAddress, aztec.nodeClient]);

  // --- Effects ---

  // Pre-warm contract cache via the PXE door (no raw-contract import here).
  useEffect(() => {
    if (aztec.wallet) warmupPxe();
  }, [aztec.wallet]);

  // Share preview data with opponent as soon as state is set (before tx mines).
  // This is a React effect, so it runs completely outside PXE's execution context —
  // no interference with IDB transactions. Both P1 and P2 set gameRandomness via
  // setState inside their respective pipeline functions; React flushes the update
  // at the next render boundary (including during await yields), so this effect
  // fires before the slow tx mining completes.
  useEffect(() => {
    if (previewSharedRef.current) return;
    if (!ws.gameId || !gameRandomness || !aztec.accountAddress) return;
    // P1 uses its own onChainGameId; P2 uses the opponent's
    const gameIdToShare = onChainGameId ?? ws.opponentOnChainGameId;
    if (!gameIdToShare) return;

    previewSharedRef.current = true;
    ws.shareAztecInfo(ws.gameId, aztec.accountAddress, gameIdToShare, gameRandomness);
    console.log('[useGameSession] Preview data shared with opponent (early, via effect)');
  }, [ws.gameId, gameRandomness, onChainGameId, ws.opponentOnChainGameId, aztec.accountAddress, ws.shareAztecInfo]);

  // Merge opponent info into settlementInfoRef synchronously when it arrives
  // via WebSocket. Uses addMessageListener (not useEffect) so the ref is
  // updated in the same event loop tick as the message — async functions in
  // txManager can read it immediately without yielding to React's render cycle.
  useEffect(() => {
    return ws.addMessageListener((msg) => {
      if (msg.type === 'OPPONENT_AZTEC_INFO' && settlementInfoRef.current) {
        if (msg.aztecAddress) {
          settlementInfoRef.current.opponentAddress = msg.aztecAddress;
        }
        if (msg.gameRandomness && msg.gameRandomness.length === 6) {
          settlementInfoRef.current.opponentRandomness = [...msg.gameRandomness];
        }
      }
      // Capture opponent card IDs from GAME_OVER into the persistent ref.
      // We identify "our" cards by matching against callerCardIds (already stored),
      // and the remaining set is the opponent's.
      if (msg.type === 'GAME_OVER' && settlementInfoRef.current) {
        const m = msg as any;
        const p1Ids: number[] = m.player1CardIds ?? [];
        const p2Ids: number[] = m.player2CardIds ?? [];
        const callerIds = settlementInfoRef.current.callerCardIds;
        // Match: if our caller cards are P1's cards, opponent is P2 (and vice versa)
        const callerIsP1 = callerIds.length > 0 && callerIds.every((id: number) => p1Ids.includes(id));
        const oppIds = callerIsP1 ? p2Ids : p1Ids;
        if (oppIds.length > 0) {
          settlementInfoRef.current.opponentCardIds = [...oppIds];
        }
      }
    });
  }, [ws.addMessageListener]);

  // P1: transition awaiting_join → active when P2's join_game tx is confirmed
  useEffect(() => {
    if (onChainPhaseRef.current === 'awaiting_join' && ws.opponentTxConfirmed) {
      transitionPhase('active');
    }
  }, [ws.opponentTxConfirmed, transitionPhase]);

  // Consolidated on-chain pipeline (replaces 3 separate effects + dead fallback)
  useEffect(() => {
    if (screen === 'main-menu') return; // Never start pipeline during navigation
    if (!ws.gameId || !ws.gameState) return;
    if (ws.gameState.status !== 'playing' && ws.gameState.status !== 'finished') return;
    if (!isContractAvailable) return;

    const phase = onChainPhaseRef.current;

    // P1: create game — runs through txManager
    if (ws.playerNumber === 1 && phase === 'idle') {
      transitionPhase('creating');
      const capturedGameId = ws.gameId!;
      const capturedAddr = aztec.accountAddress!;
      const capturedCardIds = [...cardIds];
      const capturedShareInfo = ws.shareAztecInfo;
      const capturedNotifyTx = ws.notifyTxConfirmed;

      runPxeTx({
        type: 'create_game',
        label: 'Creating game...',
        gameId: capturedGameId,
        execute: async (ops, setPhase) => {
          setPhase('simulating');
          return createGameOnChain(ops, capturedCardIds);
        },
        postEffects: async (result) => {
          capturedShareInfo(capturedGameId, capturedAddr, result.gameId, result.randomness);
          aztec.updateOwnedCards(prev => removeOneOfEach(prev, capturedCardIds));
          capturedNotifyTx(capturedGameId, 'create_game', result.txHash);
          console.log('[useGameSession] P1: create_game mined, notified backend');
          // Seed settlementInfoRef with our own values (opponent values added
          // when OPPONENT_AZTEC_INFO arrives). This ref is NOT cleared by navigation.
          // Read opponent values from refs (NOT `ws.*`) because the outer
          // useEffect closes over a stale `ws` object; the refs are updated
          // every render and always hold the latest values.
          settlementInfoRef.current = {
            onChainGameId: result.gameId,
            gameRandomness: result.randomness,
            opponentAddress: wsOpponentAztecAddressRef.current ?? '',
            opponentRandomness: wsOpponentGameRandomnessRef.current ? [...wsOpponentGameRandomnessRef.current] : [],
            callerCardIds: capturedCardIds,
            opponentCardIds: wsOpponentCardIdsRef.current.length > 0 ? [...wsOpponentCardIdsRef.current] : [],
          };
          transitionPhase('awaiting_join');
        },
      }).catch(err => {
        console.error('[useGameSession] On-chain game creation failed:', err);
        setOnChainError(err instanceof Error ? err.message : 'Create game failed');
        transitionPhase('idle');
      });
      return;
    }

    // P2 phase 1: prepare preview — runs through txManager PXE queue
    if (ws.playerNumber === 2 && phase === 'idle' && ws.opponentOnChainGameId) {
      transitionPhase('preparing');
      const capturedGameId = ws.gameId!;
      const capturedAddr = aztec.accountAddress!;
      const capturedChainGameId = ws.opponentOnChainGameId!;
      const capturedCardIds = [...cardIds];
      const capturedShareInfo = ws.shareAztecInfo;

      runPxeTx({
        type: 'join_game',
        label: 'Preparing to join...',
        gameId: capturedGameId,
        execute: async (ops, setPhase) => {
          setPhase('simulating');
          return prepareJoinGame(ops, capturedChainGameId);
        },
        postEffects: async (result) => {
          capturedShareInfo(capturedGameId, capturedAddr, capturedChainGameId, result.randomness);
          aztec.updateOwnedCards(prev => removeOneOfEach(prev, capturedCardIds));
          console.log('[useGameSession] P2: preview data shared, waiting for P1 tx confirmation...');
          // Seed settlementInfoRef for P2. Read opponent values from refs
          // (see P1 create_game above for why we can't use `ws.*` here).
          settlementInfoRef.current = {
            onChainGameId: capturedChainGameId,
            gameRandomness: result.randomness,
            opponentAddress: wsOpponentAztecAddressRef.current ?? '',
            opponentRandomness: wsOpponentGameRandomnessRef.current ? [...wsOpponentGameRandomnessRef.current] : [],
            callerCardIds: capturedCardIds,
            opponentCardIds: wsOpponentCardIdsRef.current.length > 0 ? [...wsOpponentCardIdsRef.current] : [],
          };
          transitionPhase('awaiting_create');
        },
      }).catch(err => {
        console.error('[useGameSession] P2 prepare failed:', err);
        setOnChainError(err instanceof Error ? err.message : 'Prepare join failed');
        transitionPhase('idle');
      });
      return;
    }

    // P2 phase 2: join after P1 confirmed — runs through txManager
    if (ws.playerNumber === 2 && phase === 'awaiting_create' && ws.opponentTxConfirmed && onChainGameId) {
      transitionPhase('joining');
      const capturedGameId = ws.gameId!;
      const capturedChainGameId = ws.opponentOnChainGameId!;
      const capturedCardIds = [...cardIds];
      const capturedNotifyTx = ws.notifyTxConfirmed;

      runPxeTx({
        type: 'join_game',
        label: 'Joining game...',
        gameId: capturedGameId,
        execute: async (ops, setPhase) => {
          setPhase('sending');
          return sendJoinGameTx(ops, capturedChainGameId, capturedCardIds);
        },
        postEffects: async (txHash) => {
          capturedNotifyTx(capturedGameId, 'join_game', txHash);
          console.log('[useGameSession] P2: join_game mined, notified backend');
          transitionPhase('active');
        },
      }).catch(err => {
        console.error('[useGameSession] P2 join_game tx failed:', err);
        setOnChainError(err instanceof Error ? err.message : 'Join game failed');
        transitionPhase('awaiting_create');
      });
    }
  }, [screen, ws.playerNumber, ws.gameId, ws.gameState, ws.opponentOnChainGameId,
      ws.opponentTxConfirmed, isContractAvailable, onChainGameId, cardIds,
      createGameOnChain, prepareJoinGame, sendJoinGameTx,
      aztec.accountAddress, aztec.wallet, aztec.nodeClient, aztec.updateOwnedCards,
      ws.shareAztecInfo, ws.notifyTxConfirmed, transitionPhase]);

  // --- Facade integration ---

  const restoreFromSave = useCallback((saved: PersistedGameState): void => {
    if (saved.onChainGameId && saved.gameRandomness) {
      setOnChainGameId(saved.onChainGameId);
      setGameRandomness(saved.gameRandomness);
      if (saved.blindingFactor) setBlindingFactor(saved.blindingFactor);
    }
  }, []);

  const resetForMenu = useCallback((): void => {
    // Note: onChainPhaseRef is NOT reset here — it's managed by txManager
    // postEffects (settlement sets it to 'idle' when the game lifecycle ends).
    // Resetting it here causes a race: the pipeline effect re-fires with
    // phase='idle' while ws.gameId is still set (deferred leave), triggering
    // a spurious create_game.
    previewSharedRef.current = false;
    activePhaseResolveRef.current = null;
    setOnChainGameId(null);
    setGameRandomness(null);
    setBlindingFactor(null);
    setOnChainError(null);
  }, []);

  return {
    onChainGameId,
    gameRandomness,
    blindingFactor,
    onChainError,
    getPhase,
    transitionPhase,
    waitForActivePhase,
    getSettlementInfo,
    getBlindingFactor,
    backfillSettlementInfoFromWs,
    clearSettlementInfo,
    restoreFromSave,
    resetForMenu,
  };
}

/**
 * Remove exactly one copy of each ID in `toRemove` from `source`.
 */
function removeOneOfEach(source: number[], toRemove: number[]): number[] {
  const remaining = [...toRemove];
  return source.filter(id => {
    const idx = remaining.indexOf(id);
    if (idx !== -1) {
      remaining.splice(idx, 1);
      return false;
    }
    return true;
  });
}
