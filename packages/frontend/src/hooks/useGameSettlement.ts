import { useState, useCallback, useEffect, useRef } from 'react';
import type { UseWebSocketReturn } from './useWebSocket';
import type { OnChainPhase, SettlementInfo } from './useGameSession';
import { useAztecContext } from '../aztec/AztecContext';
import { fetchTxEffectData } from '../aztec/noteImporter';
import { addCards, type StoredCard } from '../aztec/cardStore';
import txManager from '../aztec/txManager';
import { runPxeTx, pxe, type PxeOps } from '../aztec/pxe';
import { toFr as toFrUtil, toHexString, bytesToFrArray, base64ToFrArray, hexToFr } from '../aztec/fieldUtils';
import { AZTEC_TX_TIMEOUT, AZTEC_SETTLE_TX_TIMEOUT, CARDS_PER_HAND, TOTAL_MOVES, MOVE_PROOF_WAIT_TIMEOUT, HAND_PROOF_WAIT_TIMEOUT, GAME_TOKEN_REWARD } from '../aztec/gameConstants';
import { requireWallet, requireAccountAddress } from '../aztec/walletGuards';
import { padToHand, sortProofChain, computeCanonicalInitialHash } from '../aztec/settlementArgs';
import type { HandProofData, MoveProofData, PlaintextNoteData } from '../types';

/** Lazy-load the field/address SDK classes for building proof-tx arguments.
 *  (The contract instances stay inside pxe.ts; only these value types cross.) */
async function loadSdk(): Promise<{ Fr: any; AztecAddress: any }> {
  const [{ Fr }, { AztecAddress }] = await Promise.all([
    import('@aztec/aztec.js/fields'),
    import('@aztec/aztec.js/addresses'),
  ]);
  return { Fr, AztecAddress };
}

export type TxStatus = 'idle' | 'preparing' | 'proving' | 'sending' | 'confirmed' | 'error';

/**
 * The slice of useGameSession that settlement consumes. All functions are
 * identity-stable, so they are safe in useCallback dependency arrays.
 */
export interface SettlementSessionDeps {
  /**
   * Our blinding factor for this game. Settlement proves the card ids it mints
   * are the ones we committed, and this is the only value that binds them.
   *
   * A GETTER, not a value: everything in this interface is identity-stable so
   * it can sit in useCallback deps, and a plain field would be captured at the
   * render where it was still null — which is exactly what happened, and the
   * settlement failed with "No blinding factor for this game" against a session
   * that had one.
   */
  getBlindingFactor: () => string | null;
  getPhase: () => OnChainPhase;
  transitionPhase: (to: OnChainPhase) => void;
  waitForActivePhase: (timeoutMs: number) => Promise<void>;
  getSettlementInfo: () => SettlementInfo | null;
  backfillSettlementInfoFromWs: () => SettlementInfo | null;
  clearSettlementInfo: () => void;
}

/**
 * The slice of useGamePlay that settlement consumes. All functions are
 * identity-stable, so they are safe in useCallback dependency arrays.
 */
export interface SettlementPlayDeps {
  getMyHandProof: () => HandProofData | null;
  getOpponentHandProof: () => HandProofData | null;
  getMoveProofs: () => MoveProofData[];
  waitForHandProofs: (timeoutMs: number) => Promise<void>;
  waitForMoveProofs: (timeoutMs: number) => Promise<void>;
  /** Reactive: true once both hand proofs + all 9 move proofs are collected
   *  (used to auto-settle a draw, where neither player is the winner). Optional
   *  so unit-test mocks that don't exercise the draw path can omit it. */
  canSettle?: boolean;
}

export interface UseGameSettlementParams {
  ws: UseWebSocketReturn;
  /** The 5 card IDs the player selected for this game (loser-side taken-card detection). */
  cardIds: number[];
  session: SettlementSessionDeps;
  play: SettlementPlayDeps;
}

export interface UseGameSettlementReturn {
  // UI-rendered state
  settleTxStatus: TxStatus;
  settleTxHash: string | null;
  settleError: string | null;
  opponentSettled: boolean;
  takenCardId: number | null;
  isClaimingAbandoned: boolean;
  abandonedDisputeCountdown: number | null;

  // Actions
  handleSettle: (selectedCardId: number) => Promise<void>;
  /** Claim + settle a present-but-idle (or disconnected) opponent's abandoned
   *  game. Wired to the "Claim abandoned game" button and the testkit; also
   *  auto-fired by the opponent-disconnected effect. Idempotent. */
  handleAbandonedGame: () => Promise<void>;

  // Stable functions for the facade
  cancelAbandonedUi: () => void;
  resetForMenu: () => void;
}

/**
 * Game settlement: the winner's process_game flow (waits for active phase,
 * hand proofs, and all move proofs before proving + sending), loser-side
 * note import and opponent-settlement tracking, and the abandoned-game
 * claim/dispute/settle flow.
 *
 * Ref-vs-state split (see useGame.ts for the architecture rationale):
 *   noteImportProcessedRef:  Idempotency guard preventing duplicate imports.
 *   abandonedClaimStartedRef: Idempotency guard for the abandoned flow.
 *   opponentSettleTxIdRef,
 *   opponentSettleResolveRef: Loser-side tracking of the winner's settlement.
 */
export function useGameSettlement({ ws, cardIds, session, play }: UseGameSettlementParams): UseGameSettlementReturn {
  const aztec = useAztecContext();

  // --- Settlement tx state ---
  const [settleTxStatus, setSettleTxStatus] = useState<TxStatus>('idle');
  const [settleTxHash, setSettleTxHash] = useState<string | null>(null);
  const [settleError, setSettleError] = useState<string | null>(null);

  // --- Abandoned game state ---
  const [isClaimingAbandoned, setIsClaimingAbandoned] = useState(false);
  const [abandonedDisputeCountdown, setAbandonedDisputeCountdown] = useState<number | null>(null);
  const abandonedClaimStartedRef = useRef(false);

  // --- Opponent settlement tracking (for loser UX) ---
  const [opponentSettled, setOpponentSettled] = useState(false);
  const [takenCardId, setTakenCardId] = useState<number | null>(null);

  // Idempotency guard preventing duplicate note imports
  const noteImportProcessedRef = useRef<string | null>(null);

  // Import notes helper — imports into PXE AND persists the tx-effect aux
  // data to localStorage so a fresh wallet can re-import on restart.
  // Mirrors the pattern in useCardPacks.ts (pack purchases) so settlement,
  // loser note-relay, and abandoned-game recovery all persist consistently.
  const importNotes = useCallback(async (
    facade: PxeOps,
    txHashStr: string,
    notes: { tokenId: number; randomness: string }[],
    label: string,
  ) => {
    if (!aztec.accountAddress || !aztec.nodeClient) return;
    const accountAddress = aztec.accountAddress;
    try {
      // TxEffect is a NODE read (note hashes + first nullifier) — not a PXE op.
      // The actual import_note PXE calls run through `facade` (the serial queue
      // when called standalone, inline when inside a runPxeTx body).
      const txEffectData = await fetchTxEffectData(aztec.nodeClient, txHashStr);
      if (!txEffectData) {
        console.warn(`[useGameSettlement] ${label}: TxEffect unavailable — skipping import (would not survive a refresh)`);
        return;
      }

      const storedCards: StoredCard[] = notes.map((n) => ({
        cardId: n.tokenId,
        randomness: n.randomness,
        txHash: txHashStr,
        noteHashes: txEffectData.noteHashes,
        firstNullifier: txEffectData.firstNullifier,
      }));
      try {
        addCards(accountAddress, storedCards);
      } catch (persistErr) {
        console.error(`[useGameSettlement] ${label}: failed to persist cards to localStorage (continuing with PXE import):`, persistErr);
      }

      const importedIds = await facade.importCardNotes(accountAddress, txHashStr, notes, label, txEffectData);
      if (importedIds.length > 0) {
        aztec.updateOwnedCards(prev => [...prev, ...importedIds]);
      }
    } catch (err) {
      console.error(`[useGameSettlement] ${label}: Failed to import notes:`, err);
    }
  }, [aztec.accountAddress, aztec.nodeClient, aztec.updateOwnedCards]);

  // Import notes received from opponent via WebSocket
  useEffect(() => {
    if (!ws.incomingNoteData || !aztec.wallet || !aztec.accountAddress) return;
    const { txHash, notes } = ws.incomingNoteData;
    if (noteImportProcessedRef.current === txHash) return;
    noteImportProcessedRef.current = txHash;

    // Determine which card was taken by comparing returned cards vs original hand
    const returnedIds = new Set(notes.map(n => n.tokenId));
    const taken = cardIds.find(id => !returnedIds.has(id));
    setTakenCardId(taken ?? null);
    setOpponentSettled(true);

    (async () => {
      // Standalone (not inside a tx queue item) — enqueue via `pxe.*`.
      await importNotes(pxe, txHash, notes, 'Loser import');

      // Settlement mints +20 ArenaToken to the loser via mint_reward — a
      // create_and_push note the loser's passive block scan never discovers.
      // Import it explicitly (like the cards): its randomness is derived from
      // the loser's OWN per-game randomness, so recompute + import_note.
      const myRandomness = session.getSettlementInfo()?.gameRandomness;
      if (aztec.nodeClient && aztec.accountAddress && myRandomness && myRandomness.length === 6) {
        const tokenEffect = await fetchTxEffectData(aztec.nodeClient, txHash);
        if (tokenEffect) {
          await pxe.importTokenRewardNote(
            aztec.accountAddress, txHash, GAME_TOKEN_REWARD, myRandomness, tokenEffect,
          ).catch((e: unknown) => console.warn('[useGameSettlement] loser token reward import failed:', e));
        } else {
          console.warn('[useGameSettlement] loser token reward: TxEffect unavailable, skipping import');
        }
      } else {
        console.warn('[useGameSettlement] loser token reward: missing randomness/node, skipping import');
      }

      await aztec.refreshTokenBalance();
    })();

    // Settlement complete on loser side — release the game lifecycle
    session.transitionPhase('idle');
  }, [ws.incomingNoteData, aztec.wallet, aztec.accountAddress, aztec.nodeClient, importNotes, cardIds, aztec.refreshTokenBalance, session.transitionPhase, session.getSettlementInfo]);

  // Track opponent's settlement on the loser's side via txManager.
  // When the winner starts settling, the loser receives OPPONENT_SETTLING via WS.
  // This creates a txManager entry so onChainPhaseRef stays non-idle and the
  // "Back to Lobby" guard works correctly.
  const opponentSettleTxIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ws.opponentSettling) return;
    if (opponentSettleTxIdRef.current) return; // Already tracking

    session.transitionPhase('awaiting_settlement');
    setTakenCardId(ws.opponentSettling.selectedCardId);

    // Create a txManager entry for the opponent's settlement
    const txId = txManager.runTx({
      type: 'settle_game',
      label: 'Opponent is settling...',
      gameId: ws.gameId ?? undefined,
      execute: async () => {
        // The loser doesn't execute anything — just wait for NOTE_DATA
        await new Promise<void>((resolve) => {
          // Store the resolve so the incomingNoteData effect can call it
          opponentSettleResolveRef.current = resolve;
        });
        return 'opponent-settled';
      },
      postEffects: async () => {
        setOpponentSettled(true);
        session.transitionPhase('idle');
        // Wait for PXE to sync the block containing the settlement tx
        // before querying token balance (token notes use ONCHAIN_CONSTRAINED
        // delivery which requires PXE block sync to discover).
        await new Promise(r => setTimeout(r, 5000));
        aztec.refreshTokenBalance();
      },
    });

    txId.catch(() => {
      // If something goes wrong, still release the game lifecycle
      session.transitionPhase('idle');
    });

    opponentSettleTxIdRef.current = 'tracking';
  }, [ws.opponentSettling, ws.gameId, session.transitionPhase]);

  // Resolve the opponent's settlement wait when NOTE_DATA arrives
  const opponentSettleResolveRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!ws.incomingNoteData) return;
    if (opponentSettleResolveRef.current) {
      opponentSettleResolveRef.current();
      opponentSettleResolveRef.current = null;
    }
  }, [ws.incomingNoteData]);

  const handleSettle = useCallback(async (selectedCardId: number) => {
    if (!ws.gameId) throw new Error('No game ID for settlement');
    if (!ws.playerNumber) throw new Error('No player number for settlement');

    // Capture values available NOW (stable across navigation).
    // Pipeline-dependent values (opponent address, randomness, on-chain game ID)
    // are read from the session's settlement info inside execute — that ref
    // persists across navigation.
    const capturedGameId = ws.gameId;
    const capturedPlayerNumber = ws.playerNumber;
    requireWallet(aztec.wallet);
    const addr = requireAccountAddress(aztec.accountAddress);
    const capturedImportNotes = importNotes;
    const capturedRelayNoteData = (txHash: string, notes: PlaintextNoteData[]) =>
      ws.relayNoteData(capturedGameId, txHash, notes);
    const capturedNotifySettle = (gId: string, cardId: number) =>
      ws.notifySettleStarted(gId, cardId);

    // Don't transition to 'settling' yet — the on-chain pipeline may still be in
    // awaiting_join (P2 hasn't joined). Transitioning now would block the natural
    // awaiting_join → active transition. We transition inside execute after active.
    setSettleTxStatus('preparing');
    setSettleError(null);
    setSettleTxHash(null);

    runPxeTx({
      type: 'settle_game',
      label: 'Settling game...',
      gameId: capturedGameId,

      execute: async (ops, setPhase) => {
        // ── Wait for both players to be on-chain (phase: active) ──────
        if (session.getPhase() !== 'active') {
          console.log('[useGameSettlement] Game not yet active on-chain (phase:', session.getPhase(), ') — waiting...');
          setPhase('queued');
          await session.waitForActivePhase(AZTEC_SETTLE_TX_TIMEOUT * 1000);
          console.log('[useGameSettlement] Game active on-chain — proceeding with settlement');
        }

        // NOW transition to settling (from 'active', which is a valid transition)
        session.transitionPhase('settling');

        // ── Wait for hand proofs ───────────────────────────────────────
        if (!play.getMyHandProof() || !play.getOpponentHandProof()) {
          console.log('[useGameSettlement] Hand proofs not ready yet — waiting (my:',
            !!play.getMyHandProof(), 'opponent:', !!play.getOpponentHandProof(), ')');
          setPhase('queued');
          await play.waitForHandProofs(HAND_PROOF_WAIT_TIMEOUT);
          console.log('[useGameSettlement] Hand proofs now ready — proceeding with settlement');
        }

        const myProof = play.getMyHandProof();
        const oppProof = play.getOpponentHandProof();
        if (!myProof || !oppProof) throw new Error('Hand proofs not ready after wait');

        // ── Read pipeline-dependent values from persistent session ref ──
        const sInfo = session.getSettlementInfo();
        if (!sInfo) throw new Error('Settlement info not available (pipeline incomplete)');

        // Both players are on-chain (guaranteed by active phase wait above).
        const { Fr, AztecAddress } = await loadSdk();
        const liveOnChainGameId = sInfo.onChainGameId;

        // ── Wait for all move proofs ───────────────────────────────────
        await play.waitForMoveProofs(MOVE_PROOF_WAIT_TIMEOUT);

        // ── All waits complete — backfill from latest ws state ────
        // (race: OPPONENT_AZTEC_INFO / GAME_OVER arrived before the pipeline
        // seeded the settlement info — the session merges the latest ws
        // values, read via render-updated refs, into any still-empty field).
        session.backfillSettlementInfoFromWs();

        const capturedOpponentAddress = sInfo.opponentAddress;
        const capturedOpponentRandomness = sInfo.opponentRandomness;
        const capturedGameRandomness = sInfo.gameRandomness;
        const capturedCardIds = sInfo.callerCardIds;
        const capturedOpponentCardIds = sInfo.opponentCardIds;
        const capturedBlinding = session.getBlindingFactor();
        const capturedOpponentBlinding = ws.opponentBlinding;

        // Named individually: the contract rejects a wrong or missing factor as
        // an opaque "card ids do not match their commitment" after all the
        // proving work, and the two have completely different causes — ours is
        // a local pipeline failure, theirs is the opponent not having sent one.
        if (!capturedBlinding) throw new Error('No blinding factor for this game (settlement info incomplete)');
        if (!capturedOpponentBlinding) {
          throw new Error('Opponent has not shared their blinding factor yet — they send it at game over');
        }
        if (capturedCardIds.length === 0) throw new Error('No caller card IDs (settlement info incomplete)');
        if (capturedOpponentCardIds.length === 0) {
          console.error('[useGameSettlement] Settlement failed: opponentCardIds is empty.',
            { sInfo });
          throw new Error('No opponent card IDs (settlement info incomplete)');
        }
        if (!capturedOpponentAddress) {
          console.error('[useGameSettlement] Settlement failed: opponentAddress is empty.',
            'OPPONENT_AZTEC_INFO was not received via WS or ref.',
            { sInfo });
          throw new Error('No opponent address (OPPONENT_AZTEC_INFO not received)');
        }
        if (capturedOpponentRandomness.length === 0) {
          console.error('[useGameSettlement] Settlement failed: opponentRandomness is empty.', { sInfo });
          throw new Error('No opponent randomness (OPPONENT_AZTEC_INFO incomplete)');
        }

        // Notify the opponent NOW — settlement will actually proceed. Uses the
        // captured ref bound to the game's WebSocket send(). For a DRAW this is the
        // SETTLE_STARTED that engages the opponent's wait-for-relay path (the SAME
        // path the win-loser uses): only ONE player settles a draw; the other waits
        // for the relayed cards rather than sending a second, doomed transaction.
        capturedNotifySettle(capturedGameId, selectedCardId);

        const capturedMoveProofs = play.getMoveProofs();

        setPhase('proving');

        const { loadProveHandCircuit, loadGameMoveCircuit } = await import('../aztec/circuitLoader');
        const { UltraHonkBackend } = await import('@aztec/bb.js');
        const { getBarretenberg } = await import('../aztec/proofBackend');

        const [handArtifact, moveArtifact] = await Promise.all([
          loadProveHandCircuit(),
          loadGameMoveCircuit(),
        ]);

        const api = await getBarretenberg();
        const handBackend = new UltraHonkBackend(handArtifact.bytecode, api);
        const moveBackend = new UltraHonkBackend(moveArtifact.bytecode, api);

        const [handVk, moveVk] = await Promise.all([
          handBackend.getVerificationKey(),
          moveBackend.getVerificationKey(),
        ]);

        const handVkFields = bytesToFrArray(Fr, handVk);
        const moveVkFields = bytesToFrArray(Fr, moveVk);
        const toFrArr = (b64: string) => base64ToFrArray(Fr, b64);
        const toFrHex = (hex: string) => hexToFr(Fr, hex);

        // Sort move proofs into chain
        const sorted = sortProofChain(capturedMoveProofs, TOTAL_MOVES, await computeCanonicalInitialHash());

        const mp: InstanceType<typeof Fr>[][] = [];
        const mi: InstanceType<typeof Fr>[][] = [];
        for (const m of sorted) {
          mp.push(toFrArr(m.proof));
          mi.push(m.publicInputs.map(toFrHex));
        }

        setPhase('sending');

        const opponent = AztecAddress.fromStringUnsafe(capturedOpponentAddress);

        const callerRandomness = capturedGameRandomness.map(v => toFrUtil(Fr, v));
        const opponentRandomness = capturedOpponentRandomness.map(v => toFrUtil(Fr, v));

        const handProof1 = capturedPlayerNumber === 1 ? myProof : oppProof;
        const handProof2 = capturedPlayerNumber === 2 ? myProof : oppProof;
        const hp1ProofData = toFrArr(handProof1.proof);
        const hp1InputData = handProof1.publicInputs.map(toFrHex);
        const hp2ProofData = toFrArr(handProof2.proof);
        const hp2InputData = handProof2.publicInputs.map(toFrHex);

        // Ordered process_game arguments — the caller owns the proof transcript
        // + VK fields; the contract is resolved and invoked inside pxe.ts.
        const processArgs = [
          toFrUtil(Fr, liveOnChainGameId),
          handVkFields,
          moveVkFields,
          hp1ProofData, hp1InputData,
          hp2ProofData, hp2InputData,
          mp[0], mi[0], mp[1], mi[1], mp[2], mi[2],
          mp[3], mi[3], mp[4], mi[4], mp[5], mi[5],
          mp[6], mi[6], mp[7], mi[7], mp[8], mi[8],
          opponent,
          new Fr(BigInt(selectedCardId)),
          padToHand(Fr, capturedCardIds),
          padToHand(Fr, capturedOpponentCardIds),
          callerRandomness,
          opponentRandomness,
          // Blinding factors — the contract recomputes
          // poseidon2([card_ids, blinding]) and asserts it against the
          // commitment stored at create/join. Without them it would mint
          // whatever ids it was handed.
          toFrUtil(Fr, capturedBlinding),
          toFrUtil(Fr, capturedOpponentBlinding),
        ];
        const hash = await ops.sendProcessGame(addr, processArgs, { node: aztec.nodeClient, timeoutMs: AZTEC_SETTLE_TX_TIMEOUT });
        return { hash, callerRandomness, opponentRandomness, capturedCardIds, capturedOpponentCardIds };
      },

      postEffects: async (result, ops) => {
        const { hash, callerRandomness, opponentRandomness, capturedCardIds, capturedOpponentCardIds } = result;
        setSettleTxHash(hash);
        setSettleTxStatus('confirmed');
        console.log('[useGameSettlement] Game settled on-chain, txHash:', hash);

        // Build note data
        const isWinnerLoser = selectedCardId !== 0;

        const callerNotes: PlaintextNoteData[] = [];
        for (let i = 0; i < capturedCardIds.length && i < 5; i++) {
          callerNotes.push({ tokenId: capturedCardIds[i], randomness: toHexString(callerRandomness[i]) });
        }
        if (isWinnerLoser) {
          callerNotes.push({ tokenId: selectedCardId, randomness: toHexString(callerRandomness[5]) });
        }

        const opponentNotes: PlaintextNoteData[] = [];
        if (isWinnerLoser) {
          let removed = false;
          for (let i = 0; i < capturedOpponentCardIds.length && i < 5; i++) {
            if (capturedOpponentCardIds[i] === selectedCardId && !removed) {
              removed = true;
            } else {
              opponentNotes.push({ tokenId: capturedOpponentCardIds[i], randomness: toHexString(opponentRandomness[i]) });
            }
          }
        } else {
          for (let i = 0; i < capturedOpponentCardIds.length && i < 5; i++) {
            opponentNotes.push({ tokenId: capturedOpponentCardIds[i], randomness: toHexString(opponentRandomness[i]) });
          }
        }

        capturedRelayNoteData(hash, opponentNotes);
        // Winner import runs INLINE inside this tx's queue item (ops facade).
        await capturedImportNotes(ops, hash, callerNotes, 'Winner import');

        // Refresh token balance (settlement mints 20 Arena Tokens to winner).
        // Small delay to ensure PXE has synced the block with the token notes.
        await new Promise(r => setTimeout(r, 3000));
        aztec.refreshTokenBalance();

        // Game's on-chain lifecycle is complete — mark idle so the pipeline
        // effect won't re-trigger a spurious create_game on navigation.
        session.transitionPhase('idle');
        session.clearSettlementInfo();
      },
    }).catch((err) => {
      const message = err instanceof Error ? err.message : 'Transaction failed';
      // Only ONE player settles a draw (single-settler), so a failure here is a
      // genuine settle failure — never a benign "lost the race" revert. Surface it.
      console.error('[useGameSettlement] settleGame error:', err);
      setSettleError(message);
      setSettleTxStatus('error');
      session.transitionPhase('idle');
      session.clearSettlementInfo();
    });
  }, [ws.gameId, ws.playerNumber,
      aztec.wallet, aztec.accountAddress, importNotes, ws.relayNoteData, ws.notifySettleStarted,
      session.getPhase, session.waitForActivePhase, session.transitionPhase,
      session.getSettlementInfo, session.backfillSettlementInfoFromWs, session.clearSettlementInfo,
      play.getMyHandProof, play.getOpponentHandProof, play.waitForHandProofs,
      play.waitForMoveProofs, play.getMoveProofs]);

  // Auto-settle a DRAW. Neither player is "the winner", so the win card-picker
  // never renders and nothing would otherwise call handleSettle — leaving both
  // wagered hands stranded on-chain. SINGLE SETTLER (NOT both-attempt): the game
  // settles exactly once, so only PLAYER 1 sends process_game (winner_id=3 → both
  // hands re-minted, +20 tokens each) and relays player 2's cards; player 2 sends
  // NO transaction — it waits for the relay via the same path the win-loser uses
  // (SETTLE_STARTED → awaiting_settlement → NOTE_DATA import). A second
  // process_game would only revert on the already-settled game; we never send it.
  // Share our blinding factor the moment the game ends, whoever won.
  //
  // Settlement has to prove that the card ids it mints are the ones each player
  // committed, and the blinding factor is the only value that binds them. The
  // WINNER cannot settle without ours, so a loser who never sends it locks both
  // hands. Sent at game over and not a moment earlier: before that it would let
  // the opponent brute-force our hand from the on-chain commitment.
  const blindingSharedRef = useRef<string | null>(null);
  useEffect(() => {
    const gameId = ws.gameId;
    const blinding = session.getBlindingFactor();
    if (!ws.gameOver || !gameId || !blinding) return;
    if (blindingSharedRef.current === gameId) return;
    blindingSharedRef.current = gameId;
    ws.shareBlinding(gameId, blinding);
  }, [ws.gameOver, ws.gameId, session.getBlindingFactor, ws.shareBlinding]);

  const drawSettleTriggeredRef = useRef(false);
  useEffect(() => {
    if (ws.gameOver?.winner !== 'draw') { drawSettleTriggeredRef.current = false; return; }
    if (ws.playerNumber !== 1) return;              // single settler: only player 1 settles; player 2 waits for the relay
    if (drawSettleTriggeredRef.current) return;     // fire once per draw
    if (!play.canSettle) return;                    // need the full proof transcript
    if (settleTxStatus !== 'idle') return;          // not already settling
    drawSettleTriggeredRef.current = true;
    // The draw is declared OFF-CHAIN (relay) before the slower ON-CHAIN join
    // lands, so the game may still be 'joining'/'awaiting_join' here. handleSettle
    // runs its waitForActivePhase INSIDE the serial PXE queue — if we call it now
    // it grabs the queue slot and waits for the join, but the join is queued
    // BEHIND it and can never run → deadlock until the timeout. So wait for the
    // game to become 'active' OUT here (outside the queue) first, letting the join
    // run; only then enter handleSettle (whose own active-check then passes fast).
    if (session.getPhase() === 'active') {
      console.log('[useGameSettlement] draw detected — auto-settling (player 1, winner_id=3)');
      void handleSettle(0);
    } else {
      console.log('[useGameSettlement] draw detected — awaiting on-chain active, then auto-settling (player 1)');
      void session.waitForActivePhase(AZTEC_SETTLE_TX_TIMEOUT * 1000)
        .then(() => handleSettle(0))
        .catch((e) => {
          console.error('[useGameSettlement] draw auto-settle aborted — game never became active:', e);
          drawSettleTriggeredRef.current = false; // allow a retry if the phase recovers
        });
    }
  }, [ws.gameOver, ws.playerNumber, play.canSettle, settleTxStatus, handleSettle, session.getPhase, session.waitForActivePhase]);

  // --- Abandoned game handler ---
  const handleAbandonedGame = useCallback(async () => {
    if (abandonedClaimStartedRef.current) return;
    abandonedClaimStartedRef.current = true;
    session.transitionPhase('settling');
    setIsClaimingAbandoned(true);

    requireWallet(aztec.wallet);
    const addr = requireAccountAddress(aztec.accountAddress);
    // Backfill from latest ws state (same init race as handleSettle)
    const sInfo = session.backfillSettlementInfoFromWs();
    const capturedPlayerNumber = ws.playerNumber;
    const capturedWsGameId = ws.gameId;
    const validMoveProofs = play.getMoveProofs();

    if (!sInfo || !sInfo.onChainGameId || !sInfo.gameRandomness.length || !sInfo.opponentAddress) {
      console.error('[useGameSettlement] Cannot claim abandoned game: missing settlement info', { sInfo, wsOpponentAddr: ws.opponentAztecAddress });
      setIsClaimingAbandoned(false);
      abandonedClaimStartedRef.current = false;
      session.transitionPhase('idle');
      return;
    }
    if (sInfo.callerCardIds.length === 0) {
      console.error('[useGameSettlement] Cannot claim abandoned game: missing own card IDs');
      setIsClaimingAbandoned(false);
      abandonedClaimStartedRef.current = false;
      session.transitionPhase('idle');
      return;
    }

    const capturedCardIds = sInfo.callerCardIds;
    const capturedGameRandomness = sInfo.gameRandomness;
    const capturedOnChainGameId = sInfo.onChainGameId;
    const capturedOpponentAddress = sInfo.opponentAddress;
    const capturedOpponentCardIds = sInfo.opponentCardIds;
    // Recovery proves the ids it re-mints are the ones we committed; without
    // this the tx reverts after the whole claim and dispute wait.
    const capturedBlinding = session.getBlindingFactor();
    if (!capturedBlinding) {
      console.error('[useGameSettlement] cannot recover an abandoned game without our blinding factor');
      setIsClaimingAbandoned(false);
      session.transitionPhase('idle');
      return;
    }

    try {
      // Step 1: claim_abandoned_game
      await runPxeTx<string>({
        type: 'claim_abandoned_game',
        label: 'Claiming abandoned game...',
        gameId: ws.gameId ?? undefined,
        execute: async (ops, setPhase) => {
          setPhase('proving');

          const { loadProveHandCircuit, loadGameMoveCircuit, loadDummyMoveCircuit } = await import('../aztec/circuitLoader');
          const { UltraHonkBackend } = await import('@aztec/bb.js');
          const { getBarretenberg } = await import('../aztec/proofBackend');

          const [handArtifact, moveArtifact, dummyArtifact] = await Promise.all([
            loadProveHandCircuit(),
            loadGameMoveCircuit(),
            loadDummyMoveCircuit(),
          ]);

          const api = await getBarretenberg();
          const handBackend = new UltraHonkBackend(handArtifact.bytecode, api);
          const moveBackend = new UltraHonkBackend(moveArtifact.bytecode, api);
          const dummyBackend = new UltraHonkBackend(dummyArtifact.bytecode, api);

          const [handVk, moveVk, dummyVk] = await Promise.all([
            handBackend.getVerificationKey(),
            moveBackend.getVerificationKey(),
            dummyBackend.getVerificationKey(),
          ]);

          const { Fr } = await loadSdk();

          const toFrArr = (b64: string) => base64ToFrArray(Fr, b64);
          const toFrHex = (hex: string) => hexToFr(Fr, hex);

          // Generate dummy proofs for padding
          const { Noir } = await import('@noir-lang/noir_js');
          const numValid = validMoveProofs.length;
          const dummyProofs: { proof: string; publicInputs: string[] }[] = [];
          for (let i = numValid; i < 9; i++) {
            const dummyNoir = new Noir(dummyArtifact as any);
            const { witness } = await dummyNoir.execute({
              card_commit_1: '0', card_commit_2: '0',
              start_state_hash: '0', end_state_hash: '0',
              game_ended: '0', winner_id: '0',
            });
            const proofData = await dummyBackend.generateProof(witness);
            const proofB64 = btoa(String.fromCharCode(...proofData.proof));
            dummyProofs.push({
              proof: proofB64,
              publicInputs: ['0x0', '0x0', '0x0', '0x0', '0x0', '0x0'],
            });
          }

          // Sort valid move proofs by chain order
          const sorted = sortProofChain(validMoveProofs, numValid, await computeCanonicalInitialHash());

          // Build all 9 proof+inputs arrays (sorted valid + dummy padding)
          const allProofs: InstanceType<typeof Fr>[][] = [];
          const allInputs: InstanceType<typeof Fr>[][] = [];
          for (const m of sorted) {
            allProofs.push(toFrArr(m.proof));
            allInputs.push(m.publicInputs.map(toFrHex));
          }
          for (const d of dummyProofs) {
            allProofs.push(toFrArr(d.proof));
            allInputs.push(d.publicInputs.map(toFrHex));
          }

          // Build hand proof data
          const myProof = play.getMyHandProof();
          const oppProof = play.getOpponentHandProof();
          if (!myProof || !oppProof) throw new Error('Hand proofs not ready');
          const handProof1 = capturedPlayerNumber === 1 ? myProof : oppProof;
          const handProof2 = capturedPlayerNumber === 2 ? myProof : oppProof;

          setPhase('sending');

          const claimArgs = [
            toFrUtil(Fr, capturedOnChainGameId),
            new Fr(BigInt(numValid)),
            capturedPlayerNumber === 1,
            bytesToFrArray(Fr, handVk),
            bytesToFrArray(Fr, moveVk),
            bytesToFrArray(Fr, dummyVk),
            toFrArr(handProof1.proof), handProof1.publicInputs.map(toFrHex),
            toFrArr(handProof2.proof), handProof2.publicInputs.map(toFrHex),
            allProofs[0], allInputs[0], allProofs[1], allInputs[1],
            allProofs[2], allInputs[2], allProofs[3], allInputs[3],
            allProofs[4], allInputs[4], allProofs[5], allInputs[5],
            allProofs[6], allInputs[6], allProofs[7], allInputs[7],
            allProofs[8], allInputs[8],
          ];
          return ops.sendClaimAbandonedGame(addr, claimArgs, { node: aztec.nodeClient, timeoutMs: AZTEC_TX_TIMEOUT });
        },
      });

      console.log('[useGameSettlement] claim_abandoned_game mined, waiting for dispute window...');

      // Step 2: Wait the on-chain DISPUTE WINDOW. The contract
      // (settle_abandoned_game_public) requires
      //   settle_block - claim_block >= DISPUTE_BLOCKS (5).
      // A fixed wall-clock wait is WRONG: block time varies enormously (instant
      // sandbox vs ~40s/block on testnet), so the old fixed 65s only covered 5
      // blocks at ~13s/block and the settle REVERTED ("Dispute window not
      // elapsed") on real testnet. Poll the node's block height until 5 blocks
      // have elapsed since the claim, driving the UX countdown from the OBSERVED
      // block rate. `claimBaselineBlock` is read right after the claim mined, so
      // it is >= the contract's stored claim_block — we therefore never settle
      // EARLY (worst case ~1 extra block of wait). Fail LOUD if the window has
      // not opened within a sane ceiling (never settle early, never wait forever).
      const DISPUTE_BLOCKS = 5;
      const DISPUTE_MAX_MS = 20 * 60 * 1000; // ceiling — abort loudly, never infinite-wait (covers ~4min/block)
      const disputeNode = aztec.nodeClient as { getBlockNumber: () => Promise<number | bigint> };
      const claimBaselineBlock = Number(await disputeNode.getBlockNumber());
      const disputeStart = Date.now();
      let blocksElapsed = 0;
      setAbandonedDisputeCountdown(DISPUTE_BLOCKS * 40); // initial estimate (~40s/block), refined in-loop
      while (blocksElapsed < DISPUTE_BLOCKS) {
        if (Date.now() - disputeStart > DISPUTE_MAX_MS) {
          throw new Error(
            `Abandoned-game dispute window did not open: only ${blocksElapsed}/${DISPUTE_BLOCKS} blocks elapsed in ` +
            `${Math.round((Date.now() - disputeStart) / 1000)}s (claim baseline block ${claimBaselineBlock}). Aborting — ` +
            `refusing to settle before the on-chain window or to wait indefinitely.`,
          );
        }
        await new Promise(r => setTimeout(r, 3000));
        const current = Number(await Promise.resolve(disputeNode.getBlockNumber()).catch(() => claimBaselineBlock + blocksElapsed));
        blocksElapsed = Math.max(0, current - claimBaselineBlock);
        // Countdown estimate from the observed block rate (fallback ~40s/block).
        const elapsedS = (Date.now() - disputeStart) / 1000;
        const secPerBlock = blocksElapsed > 0 ? elapsedS / blocksElapsed : 40;
        setAbandonedDisputeCountdown(Math.ceil((DISPUTE_BLOCKS - blocksElapsed) * secPerBlock));
      }
      setAbandonedDisputeCountdown(0);
      console.log(`[useGameSettlement] dispute window elapsed (${blocksElapsed} blocks since claim) — settling`);

      // Determine which card to claim (first opponent card placed on board, if any)
      // For now claim the first opponent card if any moves were played by opponent
      const numValid = validMoveProofs.length;
      const opponentPlayedCards = numValid >= 2; // Opponent played at least 1 card (move index 1)
      const claimedCardId = opponentPlayedCards && capturedOpponentCardIds.length > 0
        ? capturedOpponentCardIds[0]
        : 0;

      // Parity with the normal settle flow: tell the (possibly offline)
      // opponent which card is being claimed — the relay buffers
      // OPPONENT_SETTLING for them (QA-F3, docs/plan/LANE_4_BACKEND.md).
      if (capturedWsGameId) ws.notifySettleStarted(capturedWsGameId, claimedCardId);

      // Step 3: settle_abandoned_game
      await runPxeTx<{ hash: string; callerRandomness: any[] }>({
        type: 'settle_abandoned_game',
        label: 'Settling abandoned game...',
        gameId: ws.gameId ?? undefined,
        execute: async (ops, setPhase) => {
          setPhase('sending');

          const { Fr, AztecAddress } = await loadSdk();
          const opponent = AztecAddress.fromStringUnsafe(capturedOpponentAddress);
          const callerRandomness = capturedGameRandomness!.map(v => toFrUtil(Fr, v));

          // Recovers ONLY our own five cards. The absent player's ids cannot be
          // verified — that needs their blinding factor and they are not here to
          // give it — so minting on their behalf meant minting whatever we
          // asserted. They recover their own stake when they come back.
          const settleArgs = [
            toFrUtil(Fr, capturedOnChainGameId!),
            padToHand(Fr, capturedCardIds),
            callerRandomness,
            toFrUtil(Fr, capturedBlinding),
          ];
          const hash = await ops.sendSettleAbandonedGame(addr, settleArgs, { node: aztec.nodeClient, timeoutMs: AZTEC_TX_TIMEOUT });
          return { hash, callerRandomness };
        },
        postEffects: async (result, ops) => {
          const { hash, callerRandomness } = result;
          console.log('[useGameSettlement] Abandoned game settled, txHash:', hash);

          // Import caller's returned cards (inline within this tx's queue item)
          const callerNotes: PlaintextNoteData[] = [];
          for (let i = 0; i < capturedCardIds.length && i < 5; i++) {
            callerNotes.push({ tokenId: capturedCardIds[i], randomness: toHexString(callerRandomness[i]) });
          }
          // The contract ALSO mints the CLAIMED opponent card privately to the
          // claimant (mint_single_card_private with caller_randomness[5]). Import
          // it so the claimant actually RECEIVES the won card — parity with the
          // normal settle's winner import (callerRandomness[5] there too). Without
          // this the claimed card is on-chain-owned but never lands in the wallet
          // (passive discovery is unreliable/too slow), so a claimed abandoned
          // game silently drops the prize.
          if (claimedCardId !== 0) {
            callerNotes.push({ tokenId: claimedCardId, randomness: toHexString(callerRandomness[5]) });
          }
          await importNotes(ops, hash, callerNotes, 'Abandoned game recovery');

          // QA-F3: report the MINED settlement to the relay — the server
          // releases both players' room bindings on receipt and replies with
          // a standard GAME_OVER (inert here; ws.error from a benign
          // ERROR 'Game not found' after a >30-min flow has no UI consumer).
          if (capturedWsGameId) ws.notifyAbandonedGameSettled(capturedWsGameId);

          // Refresh token balance (abandoned game settlement may mint tokens)
          aztec.refreshTokenBalance();

          session.transitionPhase('idle');
          setIsClaimingAbandoned(false);
          setAbandonedDisputeCountdown(null);
        },
      });
    } catch (err) {
      console.error('[useGameSettlement] Abandoned game flow failed:', err);
      setIsClaimingAbandoned(false);
      setAbandonedDisputeCountdown(null);
      abandonedClaimStartedRef.current = false;
      session.transitionPhase('idle');
    }
  }, [ws, aztec.wallet, aztec.accountAddress, importNotes,
      session.transitionPhase, session.backfillSettlementInfoFromWs,
      play.getMoveProofs, play.getMyHandProof, play.getOpponentHandProof]);

  // Auto-trigger abandoned game flow when opponent disconnects
  useEffect(() => {
    if (!ws.opponentDisconnected) return;
    if (abandonedClaimStartedRef.current) return;
    if (session.getPhase() !== 'active' && session.getPhase() !== 'awaiting_join') return;
    if (play.getMoveProofs().length === 0) return;
    console.log('[useGameSettlement] Opponent disconnected with moves played, starting abandoned game flow...');
    handleAbandonedGame();
  }, [ws.opponentDisconnected, handleAbandonedGame, session.getPhase, play.getMoveProofs]);

  // --- Facade integration ---

  const cancelAbandonedUi = useCallback((): void => {
    setIsClaimingAbandoned(false);
    setAbandonedDisputeCountdown(null);
    abandonedClaimStartedRef.current = false;
  }, []);

  const resetForMenu = useCallback((): void => {
    noteImportProcessedRef.current = null;
    setSettleTxStatus('idle');
    setSettleTxHash(null);
    setSettleError(null);
    setOpponentSettled(false);
    setTakenCardId(null);
    opponentSettleTxIdRef.current = null;
    opponentSettleResolveRef.current = null;
  }, []);

  return {
    settleTxStatus,
    settleTxHash,
    settleError,
    opponentSettled,
    takenCardId,
    isClaimingAbandoned,
    abandonedDisputeCountdown,
    handleSettle,
    handleAbandonedGame,
    cancelAbandonedUi,
    resetForMenu,
  };
}
