import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import type { UseWebSocketReturn } from './useWebSocket';
import type { PersistedGameState, UseGameStorageReturn } from './useGameStorage';
import type { UseGameChannelReturn } from './useGameChannel';
import { useAztecContext } from '../aztec/AztecContext';
import { removeCards } from '../aztec/cardStore';
import { warmupPxe, pxe } from '../aztec/pxe';
import { AZTEC_CONFIG } from '../aztec/config';
import { requireWallet, requireAccountAddress } from '../aztec/walletGuards';
import { createGameOnChain, joinGameOnChain, secretsOf, type PrivateGame } from '../aztec/gameActions';
import { waitForNullifier } from '../aztec/gameChain';
import { handCommitOf, normalizeField, NULLIFIER_INDEX, parseRecord, sameRecord, type GameRecord } from '../aztec/privateGame';
import type { PeerPayload } from '../aztec/peerChannel';
import type { Screen } from '../types';

// --- On-chain lifecycle phase ---
export type OnChainPhase =
  | 'idle'                  // No game lifecycle in progress. Safe to create a new game.
  | 'creating'              // P1: create_game in flight (nonce → preview → send).
  | 'awaiting_join'         // P1: created and RECORD sent; waiting for the joiner's record.
  | 'awaiting_create'       // P2: creator's RECORD received; waiting for its `created` nullifier.
  | 'joining'               // P2: join_game in flight.
  | 'active'                // Both records committed and known. Game in progress.
  | 'settling'              // This player is sending settle_game / an abandonment tx.
  | 'awaiting_settlement';  // The other player is settling: waiting for SETTLED (or `done`).

export const VALID_TRANSITIONS: Record<OnChainPhase, OnChainPhase[]> = {
  idle:                 ['creating', 'awaiting_create'],
  creating:             ['awaiting_join', 'idle'],
  awaiting_join:        ['active', 'idle'],
  awaiting_create:      ['joining', 'idle'],
  joining:              ['active', 'awaiting_create', 'idle'],
  active:               ['settling', 'awaiting_settlement', 'idle'],
  // 'active': an abandonment claim stood down because the opponent came back.
  settling:             ['idle', 'active'],
  awaiting_settlement:  ['idle'],
};

/** Progress of this game's two commitments (the records). */
export type CommitStatus = 'idle' | 'generating' | 'ready' | 'error';

/** How long to wait for a commit's nullifier to show on the node. */
const NULLIFIER_WAIT_MS = 5 * 60_000;

export interface UseGameSessionParams {
  ws: UseWebSocketReturn;
  /** Current UI screen — the pipeline never starts during menu navigation. */
  screen: Screen;
  /** The 5 card IDs the player selected for this game, in the order they are committed. */
  cardIds: number[];
  channel: Pick<UseGameChannelReturn, 'gameKey' | 'roomId' | 'getGameKey' | 'sendPeer' | 'addPeerListener'>;
  storage: Pick<UseGameStorageReturn, 'mergeGame' | 'readGame'>;
}

export interface UseGameSessionReturn {
  /**
   * The game's `created` nullifier — the only public trace of its creation,
   * and nothing anyone without the game key can link to it. Null before.
   */
  onChainGameId: string | null;
  onChainError: string | null;
  /** 'ready' once both records are committed and known. */
  commitStatus: CommitStatus;
  /** Both hand commitments (from the records), once both are known, and the room they are for. */
  commits: { commit1: string; commit2: string; roomId: string | null } | null;
  /** This player's hand blinding factor (from compute_game_secrets). */
  blindingFactor: string | null;

  // Stable functions (identity never changes) — safe to close over in
  // async callbacks and to list in other hooks' useCallback deps.
  getPhase: () => OnChainPhase;
  transitionPhase: (to: OnChainPhase) => void;
  /** Resolves when the phase reaches 'active'; rejects after timeoutMs. */
  waitForActivePhase: (timeoutMs: number) => Promise<void>;
  /** Everything this player knows about the live game, once committed. */
  getGame: () => PrivateGame | null;
  /**
   * Record that the current game's on-chain lifecycle has run to completion —
   * settled (by either side), unwound, or cancelled — so the pipeline never
   * starts it again. Call before the final transition to 'idle'.
   */
  markLifecycleComplete: () => void;
  /** The player left the game: end its lifecycle here (its record stays in storage). */
  forceIdle: () => void;
  restoreFromSave: (saved: PersistedGameState) => void;
  resetForMenu: () => void;
}

/**
 * On-chain session lifecycle (docs/plan/PRIVATE_GAMES.md section 5.2): the
 * OnChainPhase state machine and the create/join pipeline.
 *
 *   Creator: key exchange done → read nonce, preview record, send create_game
 *            (one queue item) → once `created` is on-chain, send RECORD →
 *            on the joiner's RECORD, check its `joined` nullifier → active.
 *   Joiner:  on the creator's RECORD, wait for its `created` nullifier →
 *            preview record, send join_game → send RECORD → active.
 *
 * Nothing about the opponent is learned but their record. Records, nonce and
 * key are persisted the moment they exist — the record BEFORE its tx is sent.
 *
 * Ref-vs-state split (see useGame.ts for the architecture rationale): the
 * phase and the game's facts live in refs read by async callbacks; the few
 * values the UI renders (commitments, blinding, errors) are also state.
 */
export function useGameSession({ ws, screen, cardIds, channel, storage }: UseGameSessionParams): UseGameSessionReturn {
  const aztec = useAztecContext();

  const [onChainGameId, setOnChainGameId] = useState<string | null>(null);
  const [onChainError, setOnChainError] = useState<string | null>(null);
  const [commitStatus, setCommitStatus] = useState<CommitStatus>('idle');
  const [record1, setRecord1] = useState<GameRecord | null>(null);
  const [record2, setRecord2] = useState<GameRecord | null>(null);
  const [blindingFactor, setBlindingFactor] = useState<string | null>(null);

  const isContractAvailable = aztec.wallet !== null && AZTEC_CONFIG.enabled && !!AZTEC_CONFIG.gameContractAddress;

  const onChainPhaseRef = useRef<OnChainPhase>('idle');
  const activePhaseResolveRef = useRef<(() => void) | null>(null);

  // The game's facts, for async callbacks. Not cleared by menu navigation:
  // settlement and recovery may run after the player leaves the game screen.
  const roomRef = useRef<string | null>(null);
  const roleRef = useRef<1 | 2 | null>(null);
  const handRef = useRef<number[]>([]);
  const gameKeyRef = useRef<string | null>(null);
  const nonceRef = useRef<string | null>(null);
  const record1Ref = useRef<GameRecord | null>(null);
  const record2Ref = useRef<GameRecord | null>(null);
  /** Our commit tx has been sent (its record persisted): never send another. */
  const commitSentRef = useRef(false);
  /** A joiner record that overtook our own create: accepted once it completes. */
  const pendingRecord2Ref = useRef<GameRecord | null>(null);

  // The ws game whose on-chain lifecycle has run to completion. A finished
  // lifecycle ends in 'idle' — which is also exactly where the pipeline below
  // STARTS one. So any later re-render on that same game (an abandonment
  // warning, a late MOVE) would restart it and commit five cards again.
  const lifecycleDoneForRef = useRef<string | null>(null);
  const wsGameIdRef = useRef(ws.gameId);
  wsGameIdRef.current = ws.gameId;
  const wsPlayerNumberRef = useRef(ws.playerNumber);
  wsPlayerNumberRef.current = ws.playerNumber;
  const storageRef = useRef(storage);
  storageRef.current = storage;
  const channelRef = useRef(channel);
  channelRef.current = channel;
  const aztecRef = useRef(aztec);
  aztecRef.current = aztec;

  // The room this session tracks first: a settlement finishing in the
  // background must not mark a NEW game, started meanwhile, as done.
  const markLifecycleComplete = useCallback((): void => {
    lifecycleDoneForRef.current = roomRef.current ?? wsGameIdRef.current;
  }, []);

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
    if (to === 'active' && activePhaseResolveRef.current) {
      activePhaseResolveRef.current();
      activePhaseResolveRef.current = null;
    }
  }, []);

  const forceIdle = useCallback((): void => {
    lifecycleDoneForRef.current = roomRef.current ?? wsGameIdRef.current;
    if (onChainPhaseRef.current !== 'idle') console.log(`[useGameSession] Phase: ${onChainPhaseRef.current} → idle (left the game)`);
    onChainPhaseRef.current = 'idle';
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

  const getGame = useCallback((): PrivateGame | null => {
    const room = roomRef.current;
    const role = roleRef.current;
    const gameKey = gameKeyRef.current;
    const nonce = nonceRef.current;
    const r1 = record1Ref.current;
    if (!room || !role || !gameKey || !r1 || handRef.current.length === 0) return null;
    // Our own commit must be known: the creator's record1, the joiner's record2.
    if (!nonce || (role === 2 && !record2Ref.current)) return null;
    return { roomId: room, role, hand: [...handRef.current], gameKey, nonce, record1: r1, record2: record2Ref.current };
  }, []);

  const ctx = useCallback(() => {
    const a = aztecRef.current;
    requireWallet(a.wallet);
    return { owner: requireAccountAddress(a.accountAddress), node: a.nodeClient };
  }, []);

  /** Has the player left this game (or did it end) while we were waiting on it? */
  const abandoned = useCallback((room: string): boolean =>
    lifecycleDoneForRef.current === room || (wsGameIdRef.current !== null && wsGameIdRef.current !== room), []);

  const fail = useCallback((what: string, err: unknown) => {
    console.error(`[useGameSession] ${what} failed:`, err);
    setOnChainError(err instanceof Error ? err.message : `${what} failed`);
    setCommitStatus('error');
  }, []);

  /** Forget the previous game's facts (it is over, or was never committed). */
  const resetGameRefs = useCallback(() => {
    commitSentRef.current = false;
    record1Ref.current = null;
    record2Ref.current = null;
    pendingRecord2Ref.current = null;
    nonceRef.current = null;
    gameKeyRef.current = null;
    roleRef.current = null;
    handRef.current = [];
    setRecord1(null);
    setRecord2(null);
    setBlindingFactor(null);
    setCommitStatus('idle');
    setOnChainGameId(null);
  }, []);

  /**
   * Make `room` the game this session tracks. A new room starts clean — but
   * only while no lifecycle is in flight: a settlement finishing in the
   * background still owns the refs of the game it is settling.
   */
  const ensureRoom = useCallback((room: string): boolean => {
    if (roomRef.current === room) return true;
    if (onChainPhaseRef.current !== 'idle') return false;
    resetGameRefs();
    roomRef.current = room;
    return true;
  }, [resetGameRefs]);

  /** Tell the opponent our committed record (idempotent: a resend is the same record). */
  const announceRecord = useCallback(async (room: string, record: GameRecord, txType: 'create_game' | 'join_game') => {
    await channelRef.current.sendPeer({ kind: 'RECORD', record });
    ws.notifyTxConfirmed(room, txType);
  }, [ws.notifyTxConfirmed]);

  /** Both records are committed and known: the game can be played and settled. */
  const becomeActive = useCallback(() => {
    if (record1Ref.current && record2Ref.current) {
      setCommitStatus('ready');
      transitionPhase('active');
    }
  }, [transitionPhase]);

  // --- Receiving the opponent's record ---
  const acceptRecord = useCallback(async (room: string, record: GameRecord) => {
    const role = roleRef.current ?? wsPlayerNumberRef.current ?? storageRef.current.readGame(room)?.playerNumber ?? null;
    if (!role) {
      console.warn('[useGameSession] a RECORD arrived before this player knew its role — kept in storage only');
      return;
    }
    if (role === 2) {
      if (!ensureRoom(room)) {
        console.warn('[useGameSession] a creator RECORD for another game arrived mid-lifecycle — kept in storage only');
        storageRef.current.mergeGame(room, { record1: record });
        return;
      }
      // The creator's record. Only one counts: the first.
      if (record1Ref.current && !sameRecord(record1Ref.current, record)) {
        console.warn('[useGameSession] ignored a second, different creator record');
        return;
      }
      record1Ref.current = record;
      storageRef.current.mergeGame(room, { record1: record });
      setRecord1(record);
      return;
    }
    // Creator: the joiner's record. Authenticate it by its `joined` nullifier.
    if (roomRef.current !== room) {
      storageRef.current.mergeGame(room, { record2: record });
      return;
    }
    if (record2Ref.current) {
      if (!sameRecord(record2Ref.current, record)) console.warn('[useGameSession] ignored a second, different joiner record');
      return;
    }
    const r1 = record1Ref.current;
    const gameKey = gameKeyRef.current;
    if (!r1 || !gameKey) {
      console.warn('[useGameSession] the joiner\'s RECORD arrived before our own create completed — holding it');
      storageRef.current.mergeGame(room, { record2: record });
      pendingRecord2Ref.current = record;
      return;
    }
    try {
      const { owner, node } = ctx();
      const nullifiers = await pxe.gameNullifiers(owner, gameKey, r1, record);
      await waitForNullifier(node, nullifiers[NULLIFIER_INDEX.joined], 'the joiner\'s commit', {
        maxMs: NULLIFIER_WAIT_MS,
        check: () => { if (abandoned(room)) throw new Error('left the game'); },
      });
      record2Ref.current = record;
      storageRef.current.mergeGame(room, { record2: record });
      setRecord2(record);
      becomeActive();
    } catch (err) {
      fail('Checking the joiner\'s commit', err);
    }
  }, [ctx, abandoned, fail, becomeActive, ensureRoom]);

  useEffect(() => {
    return channel.addPeerListener((payload: PeerPayload, room: string) => {
      if (payload.kind === 'RECORD') {
        void acceptRecord(room, payload.record);
      } else if (payload.kind === 'CANCELLED') {
        // Only meaningful to a joiner who has not joined: the creator took
        // their cards back before anyone could.
        if (roleRef.current === 2 || wsPlayerNumberRef.current === 2) {
          const phase = onChainPhaseRef.current;
          if (phase === 'idle' || phase === 'awaiting_create') {
            lifecycleDoneForRef.current = room;
            onChainPhaseRef.current = 'idle';
            setOnChainError('The other player cancelled the game before you joined.');
          }
        }
      }
    });
  }, [channel.addPeerListener, acceptRecord]);

  // Resend our record when the relay connection comes back: a RECORD sent
  // while the socket was down never left this tab, and the other side waits on it.
  const wasConnectedRef = useRef(ws.connected);
  useEffect(() => {
    const was = wasConnectedRef.current;
    wasConnectedRef.current = ws.connected;
    if (was || !ws.connected) return;
    const room = roomRef.current;
    const role = roleRef.current;
    if (!room || !role || abandoned(room)) return;
    const own = role === 1 ? record1Ref.current : record2Ref.current;
    if (!own || !commitSentRef.current) return;
    const phase = onChainPhaseRef.current;
    if (phase === 'awaiting_join' || phase === 'active') {
      void announceRecord(room, own, role === 1 ? 'create_game' : 'join_game').catch(err =>
        console.warn('[useGameSession] could not resend our record:', err));
    }
  }, [ws.connected, abandoned, announceRecord]);

  // --- Effects ---

  // Pre-warm contract cache via the PXE door (no raw-contract import here).
  useEffect(() => {
    if (aztec.wallet) warmupPxe();
  }, [aztec.wallet]);

  // The on-chain pipeline: create (player 1) or join (player 2).
  useEffect(() => {
    if (screen === 'main-menu') return; // Never start pipeline during navigation
    if (!ws.gameId || !ws.playerNumber) return;           // not matched into a room
    if (ws.gameId === lifecycleDoneForRef.current) return; // over on-chain: never again
    if (!isContractAvailable) return;
    const gameKey = channel.gameKey;
    if (!gameKey || channel.roomId !== ws.gameId) return; // the key exchange has not finished
    const room = ws.gameId;
    if (!ensureRoom(room)) return;                        // another game's lifecycle is still running
    if (commitSentRef.current) return;                    // our commit is out: never a second

    const role = ws.playerNumber;
    const phase = onChainPhaseRef.current;
    const hand = [...cardIds];
    if (hand.length !== 5) return;

    // P1: create the game.
    if (role === 1 && phase === 'idle') {
      roleRef.current = 1;
      handRef.current = hand;
      gameKeyRef.current = gameKey;
      transitionPhase('creating');
      setCommitStatus('generating');
      setOnChainError(null);
      let context: { owner: string; node: unknown };
      try { context = ctx(); } catch (err) { fail('Creating the game', err); transitionPhase('idle'); return; }

      createGameOnChain(context, {
        roomId: room,
        gameKey,
        hand,
        onPrepared: ({ nonce, record }) => {
          // Persisted BEFORE the send: whatever happens next, this tab knows
          // what it may have committed.
          commitSentRef.current = true;
          nonceRef.current = nonce;
          record1Ref.current = record;
          storageRef.current.mergeGame(room, {
            playerNumber: 1, selectedCardIds: hand, gameKey, nonce, record1: record, commitSentAt: Date.now(),
          });
        },
      }).then(async (result) => {
        setBlindingFactor(result.secrets.blinding);
        setOnChainGameId(result.nullifiers[NULLIFIER_INDEX.created]);
        setRecord1(result.record);
        removeCards(context.owner, hand);
        aztecRef.current.updateOwnedCards(prev => removeOneOfEach(prev, hand));
        transitionPhase('awaiting_join');
        console.log('[useGameSession] P1: create_game mined; announcing our record once it is on-chain');

        await waitForNullifier(context.node, result.nullifiers[NULLIFIER_INDEX.created], 'our created game', {
          maxMs: NULLIFIER_WAIT_MS,
          check: () => { if (abandoned(room)) throw new Error('left the game'); },
        });
        await announceRecord(room, result.record, 'create_game');
        // The joiner's record may have overtaken our own create.
        const early = pendingRecord2Ref.current;
        if (early) {
          pendingRecord2Ref.current = null;
          await acceptRecord(room, early);
        }
      }).catch(err => {
        // Ended on purpose (the player left): the record stays for the menu.
        if (abandoned(room)) { console.log('[useGameSession] creator pipeline stopped:', err); return; }
        fail('Creating the game', err);
        // Back to idle only if nothing was sent; a sent commit is never redone.
        if (!commitSentRef.current) transitionPhase('idle');
      });
      return;
    }

    // P2: join once the creator's record is here and its `created` nullifier is mined.
    if (role === 2 && phase === 'idle' && record1Ref.current) {
      const r1 = record1Ref.current;
      roleRef.current = 2;
      handRef.current = hand;
      gameKeyRef.current = gameKey;
      transitionPhase('awaiting_create');
      setCommitStatus('generating');
      setOnChainError(null);
      let context: { owner: string; node: unknown };
      try { context = ctx(); } catch (err) { fail('Joining the game', err); transitionPhase('idle'); return; }

      void (async () => {
        const nullifiers = await pxe.gameNullifiers(context.owner, gameKey, r1, null);
        setOnChainGameId(nullifiers[NULLIFIER_INDEX.created]);
        await waitForNullifier(context.node, nullifiers[NULLIFIER_INDEX.created], 'the creator\'s game', {
          maxMs: NULLIFIER_WAIT_MS,
          check: () => { if (abandoned(room)) throw new Error('left the game'); },
        });
        if (abandoned(room)) throw new Error('left the game');
        transitionPhase('joining');
        const result = await joinGameOnChain(context, {
          roomId: room,
          gameKey,
          hand,
          record1: r1,
          onPrepared: ({ nonce, record }) => {
            commitSentRef.current = true;
            nonceRef.current = nonce;
            record2Ref.current = record;
            storageRef.current.mergeGame(room, {
              playerNumber: 2, selectedCardIds: hand, gameKey, nonce, record1: r1, record2: record, commitSentAt: Date.now(),
            });
          },
        });
        setBlindingFactor(result.secrets.blinding);
        setRecord2(result.record);
        removeCards(context.owner, hand);
        aztecRef.current.updateOwnedCards(prev => removeOneOfEach(prev, hand));
        console.log('[useGameSession] P2: join_game mined; announcing our record');
        becomeActive();
        await announceRecord(room, result.record, 'join_game');
      })().catch(err => {
        // Ended on purpose (the player left, or the creator cancelled).
        if (abandoned(room)) { console.log('[useGameSession] joiner pipeline stopped:', err); return; }
        fail('Joining the game', err);
        if (!commitSentRef.current) transitionPhase('idle');
      });
    }
  }, [screen, ws.playerNumber, ws.gameId, isContractAvailable, cardIds,
      channel.gameKey, channel.roomId, record1, ctx, fail, abandoned, announceRecord, acceptRecord,
      becomeActive, transitionPhase, ensureRoom]);

  // --- Facade integration ---

  const restoreFromSave = useCallback((saved: PersistedGameState): void => {
    // Another game's blinding must not outlive the switch: ours is re-derived below.
    if (roomRef.current !== saved.gameId) setBlindingFactor(null);
    roomRef.current = saved.gameId;
    roleRef.current = saved.playerNumber;
    handRef.current = [...saved.selectedCardIds];
    if (saved.gameKey) gameKeyRef.current = normalizeField(saved.gameKey);
    if (saved.nonce) nonceRef.current = saved.nonce;
    const r1 = saved.record1 ? parseRecord(saved.record1) : null;
    const r2 = saved.record2 ? parseRecord(saved.record2) : null;
    record1Ref.current = r1;
    record2Ref.current = r2;
    setRecord1(r1);
    setRecord2(r2);
    const own = saved.playerNumber === 1 ? r1 : r2;
    commitSentRef.current = !!own && !!saved.nonce;
    if (!commitSentRef.current) return;
    // Our commit went out before the reload; pick the lifecycle up where it was.
    onChainPhaseRef.current = r1 && r2 ? 'active' : 'awaiting_join';
    if (r1 && r2) setCommitStatus('ready');
    if (saved.playerNumber === 1 && r1 && !r2) {
      // The joiner may never have received our record: say it again.
      void announceRecord(saved.gameId, r1, 'create_game').catch(err =>
        console.warn('[useGameSession] could not re-announce our record after a reload:', err));
    }
    if (saved.nonce && aztec.accountAddress) {
      const owner = aztec.accountAddress;
      void secretsOf({ nonce: saved.nonce }, { owner, node: aztec.nodeClient })
        .then(s => setBlindingFactor(s.blinding))
        .catch(err => console.warn('[useGameSession] could not re-derive our secrets:', err));
    }
  }, [aztec.accountAddress, aztec.nodeClient, announceRecord]);

  const resetForMenu = useCallback((): void => {
    // Note: onChainPhaseRef is NOT reset here — it is managed by the
    // lifecycle (settlement or forceIdle). Resetting it here races the
    // pipeline effect, which would re-fire with phase='idle' while ws.gameId
    // is still set (deferred leave) and commit a second hand.
    activePhaseResolveRef.current = null;
    if (onChainPhaseRef.current === 'idle') {
      resetGameRefs();
      roomRef.current = null;
    }
    setOnChainError(null);
  }, [resetGameRefs]);

  const commitRoom = roomRef.current;
  const commits = useMemo(
    () => (record1 && record2 ? { commit1: handCommitOf(record1), commit2: handCommitOf(record2), roomId: commitRoom } : null),
    [record1, record2, commitRoom],
  );

  return {
    onChainGameId,
    onChainError,
    commitStatus,
    commits,
    blindingFactor,
    getPhase,
    transitionPhase,
    waitForActivePhase,
    getGame,
    markLifecycleComplete,
    forceIdle,
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
