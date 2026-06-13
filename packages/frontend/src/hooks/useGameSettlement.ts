import { useState, useCallback, useEffect, useRef } from 'react';
import type { UseWebSocketReturn } from './useWebSocket';
import type { OnChainPhase, SettlementInfo } from './useGameSession';
import { useAztecContext } from '../aztec/AztecContext';
import { importNotesFromTx, fetchTxEffectData } from '../aztec/noteImporter';
import { addCards, type StoredCard } from '../aztec/cardStore';
import txManager from '../aztec/txManager';
import { ensureContracts, contractCache } from '../aztec/contracts';
import { toFr as toFrUtil, toHexString, bytesToFrArray, base64ToFrArray, hexToFr } from '../aztec/fieldUtils';
import { AZTEC_TX_TIMEOUT, AZTEC_SETTLE_TX_TIMEOUT, CARDS_PER_HAND, TOTAL_MOVES, MOVE_PROOF_WAIT_TIMEOUT, HAND_PROOF_WAIT_TIMEOUT } from '../aztec/gameConstants';
import { requireWallet, requireAccountAddress } from '../aztec/walletGuards';
import type { HandProofData, MoveProofData, PlaintextNoteData } from '../types';

export type TxStatus = 'idle' | 'preparing' | 'proving' | 'sending' | 'confirmed' | 'error';

/**
 * The slice of useGameSession that settlement consumes. All functions are
 * identity-stable, so they are safe in useCallback dependency arrays.
 */
export interface SettlementSessionDeps {
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
    txHashStr: string,
    notes: { tokenId: number; randomness: string }[],
    label: string,
  ) => {
    if (!aztec.wallet || !aztec.accountAddress || !aztec.nodeClient) return;
    const accountAddress = aztec.accountAddress;
    try {
      // Fetch TxEffect first so we can persist before (and reuse during) import.
      const txEffectData = await fetchTxEffectData(aztec.nodeClient, txHashStr);

      if (txEffectData) {
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
      } else {
        console.warn(`[useGameSettlement] ${label}: TxEffect unavailable — cards will import to PXE but won't survive a refresh`);
      }

      const importedIds = await importNotesFromTx(
        aztec.wallet, aztec.nodeClient, accountAddress,
        txHashStr, notes, label,
        txEffectData ?? undefined,
      );
      if (importedIds.length > 0) {
        aztec.updateOwnedCards(prev => [...prev, ...importedIds]);
      }
    } catch (err) {
      console.error(`[useGameSettlement] ${label}: Failed to import notes:`, err);
    }
  }, [aztec.wallet, aztec.accountAddress, aztec.nodeClient, aztec.updateOwnedCards]);

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
      await importNotes(txHash, notes, 'Loser import');
      // Settlement mints 20 Arena Tokens to BOTH players (see game contract
      // main.nr:703-706). The loser's PXE may not have finished scanning
      // the settlement block's tagged logs, so poll a few times until the
      // balance reflects the reward.
      await aztec.refreshTokenBalance().catch(() => {});
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try { await aztec.refreshTokenBalance(); } catch {}
      }
    })();

    // Settlement complete on loser side — release the game lifecycle
    session.transitionPhase('idle');
  }, [ws.incomingNoteData, aztec.wallet, aztec.accountAddress, aztec.nodeClient, importNotes, cardIds, aztec.refreshTokenBalance, session.transitionPhase]);

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
        aztec.refreshTokenBalance().catch(() => {});
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
    const w = requireWallet(aztec.wallet);
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

    txManager.runTx({
      type: 'settle_game',
      label: 'Settling game...',
      gameId: capturedGameId,

      execute: async (setPhase) => {
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
        const { fee, Fr, AztecAddress } = await ensureContracts(w);
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

        // Notify opponent NOW — settlement will actually proceed.
        // Uses captured function ref that binds to the game's WebSocket send().
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

        const contract = contractCache.gameContract;
        if (!contract) throw new Error('Game contract not initialized');

        const senderAddr = AztecAddress.fromString(addr);
        const opponent = AztecAddress.fromString(capturedOpponentAddress);

        const callerRandomness = capturedGameRandomness.map(v => toFrUtil(Fr, v));
        const opponentRandomness = capturedOpponentRandomness.map(v => toFrUtil(Fr, v));

        const handProof1 = capturedPlayerNumber === 1 ? myProof : oppProof;
        const handProof2 = capturedPlayerNumber === 2 ? myProof : oppProof;
        const hp1ProofData = toFrArr(handProof1.proof);
        const hp1InputData = handProof1.publicInputs.map(toFrHex);
        const hp2ProofData = toFrArr(handProof2.proof);
        const hp2InputData = handProof2.publicInputs.map(toFrHex);

        const { receipt } = await contract.methods
          .process_game(
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
          )
          .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_SETTLE_TX_TIMEOUT } });

        const hash = receipt?.txHash?.toString();
        if (!hash) throw new Error('Settlement tx returned no txHash');
        return { hash, callerRandomness, opponentRandomness, capturedCardIds, capturedOpponentCardIds };
      },

      postEffects: async (result) => {
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
        await capturedImportNotes(hash, callerNotes, 'Winner import');

        // Refresh token balance (settlement mints 20 Arena Tokens to winner).
        // Small delay to ensure PXE has synced the block with the token notes.
        await new Promise(r => setTimeout(r, 3000));
        aztec.refreshTokenBalance().catch(() => {});

        // Game's on-chain lifecycle is complete — mark idle so the pipeline
        // effect won't re-trigger a spurious create_game on navigation.
        session.transitionPhase('idle');
        session.clearSettlementInfo();
      },
    }).catch((err) => {
      const message = err instanceof Error ? err.message : 'Transaction failed';
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

  // --- Abandoned game handler ---
  const handleAbandonedGame = useCallback(async () => {
    if (abandonedClaimStartedRef.current) return;
    abandonedClaimStartedRef.current = true;
    session.transitionPhase('settling');
    setIsClaimingAbandoned(true);

    const w = requireWallet(aztec.wallet);
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

    try {
      // Step 1: claim_abandoned_game
      await txManager.runTx<string>({
        type: 'claim_abandoned_game',
        label: 'Claiming abandoned game...',
        gameId: ws.gameId ?? undefined,
        execute: async (setPhase) => {
          setPhase('proving');

          const { loadProveHandCircuit, loadGameMoveCircuit, loadDummyMoveCircuit } = await import('../aztec/circuitLoader');
          const { UltraHonkBackend } = await import('@aztec/bb.js');
          const { getBarretenberg } = await import('../aztec/proofBackend');
          const { ensureContracts } = await import('../aztec/contracts');

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

          const { Fr, AztecAddress } = await ensureContracts(w);

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

          const contract = contractCache.gameContract;
          if (!contract) throw new Error('Game contract not initialized');

          const senderAddr = AztecAddress.fromString(addr);
          const { fee } = await ensureContracts(w);

          const { receipt } = await contract.methods
            .claim_abandoned_game(
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
            )
            .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_TX_TIMEOUT } });

          return receipt?.txHash?.toString() ?? '';
        },
      });

      console.log('[useGameSettlement] claim_abandoned_game mined, waiting for dispute window...');

      // Step 2: Wait for dispute window (65 seconds to ensure 5 blocks)
      const DISPUTE_SECONDS = 65;
      setAbandonedDisputeCountdown(DISPUTE_SECONDS);
      for (let i = DISPUTE_SECONDS; i > 0; i--) {
        setAbandonedDisputeCountdown(i);
        await new Promise(r => setTimeout(r, 1000));
      }
      setAbandonedDisputeCountdown(0);

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
      await txManager.runTx<{ hash: string; callerRandomness: any[] }>({
        type: 'settle_abandoned_game',
        label: 'Settling abandoned game...',
        gameId: ws.gameId ?? undefined,
        execute: async (setPhase) => {
          setPhase('sending');

          const { ensureContracts } = await import('../aztec/contracts');
          const { Fr, AztecAddress, fee } = await ensureContracts(w);

          const contract = contractCache.gameContract;
          if (!contract) throw new Error('Game contract not initialized');

          const senderAddr = AztecAddress.fromString(addr);
          const opponent = AztecAddress.fromString(capturedOpponentAddress);
          const callerRandomness = capturedGameRandomness!.map(v => toFrUtil(Fr, v));

          const { receipt } = await contract.methods
            .settle_abandoned_game(
              toFrUtil(Fr, capturedOnChainGameId!),
              padToHand(Fr, capturedCardIds),
              callerRandomness,
              padToHand(Fr, capturedOpponentCardIds),
              new Fr(BigInt(claimedCardId)),
              opponent,
            )
            .send({ from: senderAddr, fee: { paymentMethod: fee }, wait: { timeout: AZTEC_TX_TIMEOUT } });

          const hash = receipt?.txHash?.toString();
          if (!hash) throw new Error('Settlement tx returned no txHash');
          return { hash, callerRandomness };
        },
        postEffects: async (result) => {
          const { hash, callerRandomness } = result;
          console.log('[useGameSettlement] Abandoned game settled, txHash:', hash);

          // Import caller's returned cards
          const callerNotes: PlaintextNoteData[] = [];
          for (let i = 0; i < capturedCardIds.length && i < 5; i++) {
            callerNotes.push({ tokenId: capturedCardIds[i], randomness: toHexString(callerRandomness[i]) });
          }
          await importNotes(hash, callerNotes, 'Abandoned game recovery');

          // QA-F3: report the MINED settlement to the relay — the server
          // releases both players' room bindings on receipt and replies with
          // a standard GAME_OVER (inert here; ws.error from a benign
          // ERROR 'Game not found' after a >30-min flow has no UI consumer).
          if (capturedWsGameId) ws.notifyAbandonedGameSettled(capturedWsGameId);

          // Refresh token balance (abandoned game settlement may mint tokens)
          aztec.refreshTokenBalance().catch(() => {});

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
    cancelAbandonedUi,
    resetForMenu,
  };
}

/** Pad a card-ID list to a full hand (CARDS_PER_HAND) of Fr field elements. */
function padToHand<F>(Fr: new (v: bigint) => F, ids: number[]): F[] {
  const padded = [...ids];
  while (padded.length < CARDS_PER_HAND) padded.push(0);
  return padded.slice(0, CARDS_PER_HAND).map(id => new Fr(BigInt(id)));
}

/**
 * Order move proofs into the on-chain verification chain: proof i+1's start
 * state hash must equal proof i's end state hash, starting from the
 * canonical initial hash. Throws if any link is missing.
 */
function sortProofChain<P extends { startStateHash: string; endStateHash: string }>(
  proofs: P[],
  count: number,
  initialHash: string,
): P[] {
  const byStart = new Map<string, P>();
  for (const p of proofs) byStart.set(p.startStateHash, p);

  const sorted: P[] = [];
  let nextHash = initialHash;
  for (let i = 0; i < count; i++) {
    const p = byStart.get(nextHash);
    if (!p) throw new Error(`Proof chain broken at step ${i}`);
    sorted.push(p);
    nextHash = p.endStateHash;
  }
  return sorted;
}

/** Hash of the canonical initial game state: empty board, full hands, player 1 to move. */
async function computeCanonicalInitialHash(): Promise<string> {
  const { computeBoardStateHash } = await import('../aztec/proofWorker');
  const emptyBoard = Array(18).fill('0');
  return computeBoardStateHash(emptyBoard, [CARDS_PER_HAND, CARDS_PER_HAND], 1);
}
