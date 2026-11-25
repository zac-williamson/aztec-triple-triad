import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useProofGeneration } from './useProofGeneration';
import type { ProofStatus } from './useProofGeneration';
import type { UseWebSocketReturn } from './useWebSocket';
import type { InboundMove, PersistedGameState, UseGameStorageReturn } from './useGameStorage';
import { ChannelNotReadyError, type UseGameChannelReturn } from './useGameChannel';
import { TOTAL_MOVES } from '../aztec/gameConstants';
import { onProver } from '../aztec/proverQueue';
import { checkOpenCards, checkOpponentMove, type CheckResult, type ProofChecks } from '../aztec/moveChecks';
import {
  isOpenSlot,
  planOwnMove,
  replay,
  unplayedSlots,
  winnerIdOf,
  type GameMove,
  type LocalGameFacts,
  type OpenCardsPayload,
  type Replayed,
  type TranscriptMove,
} from '../aztec/localGame';
import { moverOf, type Side } from '../aztec/privateGame';
import type { PeerPayload } from '../aztec/peerChannel';
import type { GameState, MoveProofData, Player, ServerMessage } from '../types';

/**
 * Map game winner to circuit winner_id value.
 * 0=not ended, 1=player1, 2=player2, 3=draw
 */
export function mapWinnerId(winner: Player | 'draw' | null): number {
  return winnerIdOf(winner);
}

/** The production checks: state hashes and verification on bb.js, loaded on first use. */
const bbChecks: ProofChecks = {
  hashState: async (board, scores, turn, owners) =>
    (await import('../aztec/proofWorker')).computeBoardStateHash(board, scores, turn, owners),
  verifyMove: async (proof, publicInputs) =>
    (await import('../aztec/proofWorker')).verifyGameMoveProof(proof, publicInputs),
  verifyOpenCards: async (proof, publicInputs) =>
    (await import('../aztec/proofWorker')).verifyOpenCardsProof(proof, publicInputs),
  // Both keys come from the artifacts and take seconds: computed while the
  // commit txs run, not when the opponent's first move is waiting on them.
  prepare: async () => {
    const worker = await import('../aztec/proofWorker');
    await worker.circuitVerificationKey('game_move');
    await worker.circuitVerificationKey('prove_hand');
  },
};

export interface UseGamePlayParams {
  ws: Pick<UseWebSocketReturn, 'addMessageListener' | 'sendMove' | 'connected' | 'roomState'>;
  /** The 5 card IDs the player selected for this game, in COMMITTED order. */
  cardIds: number[];
  /** Our hand blinding factor (compute_game_secrets) — proofs cannot generate without it. */
  blindingFactor: string | null;
  /**
   * Both hand commitments, from the two records, once both are known — and
   * the room they belong to: nothing is proven or checked against another
   * game's commitments.
   */
  commits: { commit1: string; commit2: string; roomId?: string | null } | null;
  channel: Pick<UseGameChannelReturn, 'sealMove' | 'openMove' | 'sendPeer' | 'addPeerListener'>;
  storage: Pick<UseGameStorageReturn, 'mergeGame' | 'readGame'>;
  /** State hashing and proof verification. Tests inject fakes; the default is bb.js. */
  checks?: ProofChecks;
}

export interface UseGamePlayReturn {
  // The live game, as this client runs it
  /** The relay room of the game being played, and our side in it. */
  roomId: string | null;
  role: Side | null;
  /** Board, hands (the opponent's hidden cards face down), turn, scores, result. Null without a game. */
  gameState: GameState | null;
  /** Cells the last move captured (a new array only when a move lands). */
  lastCaptures: { row: number; col: number }[];
  gameOver: { winner: Player | 'draw' } | null;
  /** Our hand as shown: whether each card is one the opponent cannot see (committed slots 3-4). */
  myHandHidden: boolean[];
  /** The opponent's three open cards are proven and shown. */
  opponentOpenKnown: boolean;
  /**
   * The opponent sent something that does not check out (section 6.3). The
   * game can never settle; the honest player's way out is the abandonment claim.
   */
  protocolError: string | null;
  /** A problem on our side (our proof failed, a check could not run) — not the opponent's fault. */
  playError: string | null;

  // Proofs
  collectedMoveProofs: MoveProofData[];
  /** Moves played whose proof the opponent has not received yet. */
  owedMoveProofs: number;
  moveProofStatus: ProofStatus;
  /** Both records known and all nine moves, with their proofs, in the transcript. */
  canSettle: boolean;

  // Actions
  handlePlaceCard: (handIndex: number, row: number, col: number) => Promise<void>;

  // Stable functions (identity never changes) — safe to close over in
  // async callbacks and to list in other hooks' useCallback deps.
  /** The transcript's proofs, in move order. */
  getMoveProofs: () => MoveProofData[];
  /** Resolves when all TOTAL_MOVES moves are in the transcript; rejects after timeoutMs. */
  waitForMoveProofs: (timeoutMs: number) => Promise<void>;
  restoreFromSave: (saved: PersistedGameState) => void;
  resetForMenu: () => void;
}

/** One game as this client runs it. */
interface LiveGame {
  room: string;
  role: Side;
  ownHand: number[];
  /** The transcript: our moves as sent, theirs as checked, in order. */
  moves: TranscriptMove[];
  /** Our moves already on our board whose proof is not out yet (0 or 1 in practice). */
  pending: GameMove[];
  opponentOpen: number[] | null;
  protocolError: string | null;
  lastCaptures: { row: number; col: number }[];
}

function factsOf(g: LiveGame, withPending = true): LocalGameFacts {
  return { role: g.role, ownHand: g.ownHand, opponentOpen: g.opponentOpen, moves: withPending ? [...g.moves, ...g.pending] : g.moves };
}

function sameMove(a: GameMove, b: GameMove): boolean {
  return a.cardId === b.cardId && a.slot === b.slot && a.row === b.row && a.col === b.col;
}

function sameCards(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The game itself (docs/plan/PRIVATE_GAMES.md section 6): the relay is a
 * pipe, so this client keeps the board, hands, turn, scores and result.
 *
 *   - Our move: applied to our board at once, proven (once both records and
 *     our blinding are known), written to the transcript, then sent as a
 *     sealed MOVE.
 *   - Their move: kept as delivered (storage, so a reload loses nothing), then
 *     opened and checked in order — bounds, state hashes, public inputs, the
 *     proof (moveChecks.ts) — and only then applied. Anything that fails is
 *     refused and surfaced (`protocolError`).
 *   - Open cards: once both records are known we prove and send ours; theirs
 *     are checked against their record before their hand is shown.
 *   - Reconnects: the transcript is persisted as it grows; a ROOM_STATE says
 *     which of our moves the relay never got, and those go again.
 *
 * Ref-vs-state split (see useGame.ts for the architecture rationale):
 *   liveRef:      the game, for async work (mirrored into state for the UI).
 *   commitsRef / blindingRef / cardIdsRef: the session's facts, read late.
 *   inboundRef:   the serial chain checking what the opponent sent.
 */
export function useGamePlay({
  ws, cardIds, blindingFactor, commits, channel, storage, checks = bbChecks,
}: UseGamePlayParams): UseGamePlayReturn {
  const proofs = useProofGeneration();

  const [live, setLive] = useState<LiveGame | null>(null);
  const liveRef = useRef<LiveGame | null>(null);
  const [moveProofStatus, setMoveProofStatus] = useState<ProofStatus>('idle');
  const [playError, setPlayError] = useState<string | null>(null);

  const commitLive = useCallback((next: LiveGame | null) => {
    liveRef.current = next;
    setLive(next);
  }, []);

  const cardIdsRef = useRef(cardIds);
  cardIdsRef.current = cardIds;
  const commitsRef = useRef(commits);
  commitsRef.current = commits;
  /** The commitments, if they are this room's. */
  const commitsFor = useCallback((room: string) => {
    const cm = commitsRef.current;
    return cm && (cm.roomId === undefined || cm.roomId === room) ? cm : null;
  }, []);
  const blindingRef = useRef(blindingFactor);
  blindingRef.current = blindingFactor;
  const wsRef = useRef(ws);
  wsRef.current = ws;
  const channelRef = useRef(channel);
  channelRef.current = channel;
  const storageRef = useRef(storage);
  storageRef.current = storage;
  const checksRef = useRef(checks);
  checksRef.current = checks;

  const drainingRef = useRef(false);
  const inboundRef = useRef<Promise<void>>(Promise.resolve());
  /** The room whose open cards we have proven (or are proving) and sent. */
  const ownOpenSentRef = useRef<string | null>(null);
  const handledRoomStateRef = useRef<unknown>(null);
  const movesCompleteRef = useRef<(() => void) | null>(null);

  // --- Persistence ---

  /**
   * Write the transcript with one more link (and drop what the inbox held up
   * to it). While a game is live its transcript is the authority: `base` is
   * the live game's moves before this one.
   */
  const persistLink = useCallback((room: string, base: TranscriptMove[], link: TranscriptMove) => {
    const stored = storageRef.current.readGame(room);
    storageRef.current.mergeGame(room, {
      moves: [...base, link],
      inbox: (stored?.inbox ?? []).filter(e => e.moveNumber > link.moveNumber),
    });
  }, []);

  /** The opponent broke the protocol: the game can never settle. Remembered, so a reload still says so. */
  const refuse = useCallback((room: string, reason: string) => {
    console.error(`[useGamePlay] refused the opponent's payload: ${reason}`);
    storageRef.current.mergeGame(room, { protocolError: reason });
    const g = liveRef.current;
    if (g?.room === room) commitLive({ ...g, protocolError: reason });
  }, [commitLive]);

  // --- Sending ---

  const sendOwnMove = useCallback(async (room: string, link: TranscriptMove) => {
    try {
      const sealed = await channelRef.current.sealMove(room, {
        cardId: link.cardId, slot: link.slot, row: link.row, col: link.col,
        proof: link.proof.proof, publicInputs: link.proof.publicInputs,
      });
      wsRef.current.sendMove(room, link.moveNumber, sealed);
    } catch (err) {
      // It is in the transcript; ROOM_STATE after a reconnect sends it again.
      console.warn(`[useGamePlay] could not send move ${link.moveNumber}:`, err);
    }
  }, []);

  const sendOpenCards = useCallback(async (payload: OpenCardsPayload) => {
    try {
      await channelRef.current.sendPeer({ kind: 'OPEN_CARDS', ...payload });
    } catch (err) {
      console.warn('[useGamePlay] could not send our open cards:', err);
    }
  }, []);

  // --- Their moves and open cards ---

  const processInbound = useCallback(async () => {
    for (;;) {
      const g = liveRef.current;
      const cm = g ? commitsFor(g.room) : null;
      // Nothing can be checked before both records — both commitments — are known.
      if (!g || g.protocolError || !cm) return;
      const room = g.room;
      const stored = storageRef.current.readGame(room);
      const c = checksRef.current;

      // Their open cards, first: they decide how their hand is shown.
      const claim = stored?.openCardsClaim;
      if (claim && !(g.opponentOpen && sameCards(g.opponentOpen, claim.cards))) {
        if (g.opponentOpen) { refuse(room, 'the opponent sent a second, different set of open cards'); return; }
        const theirCommit = g.role === 1 ? cm.commit2 : cm.commit1;
        const result: CheckResult<number[]> = await onProver(() => checkOpenCards(factsOf(g, false), theirCommit, claim, c));
        if (!result.ok) {
          if (result.retryable) { setPlayError(`Could not check the opponent's open cards: ${result.reason}`); return; }
          refuse(room, `the opponent's open cards were rejected: ${result.reason}`);
          return;
        }
        storageRef.current.mergeGame(room, { opponentOpenCards: result.value });
        const cur = liveRef.current;
        if (cur?.room === room) commitLive({ ...cur, opponentOpen: result.value });
        continue;
      }

      const inbox: InboundMove[] = [...(stored?.inbox ?? [])].sort((a, b) => a.moveNumber - b.moveNumber);
      const entry = inbox.find(e => e.moveNumber <= g.moves.length);
      if (!entry) return; // nothing, or only moves beyond a gap: wait for the rest
      // Read again when dropping: more may have arrived while this one was opened.
      const dropEntry = () => storageRef.current.mergeGame(room, {
        inbox: (storageRef.current.readGame(room)?.inbox ?? [])
          .filter(e => !(e.moveNumber === entry.moveNumber && e.ciphertext === entry.ciphertext)),
      });

      let payload;
      try {
        payload = await channelRef.current.openMove(room, entry);
      } catch (err) {
        if (err instanceof ChannelNotReadyError) return; // the key exchange has not completed: later
        if (entry.moveNumber < g.moves.length) { dropEntry(); continue; } // a stale copy that does not open
        refuse(room, `the opponent's move ${entry.moveNumber} does not open (tampered, or sealed for another game)`);
        return;
      }

      if (entry.moveNumber < g.moves.length) {
        // Delivered again (the relay replays its inbox): fine if it is the same move.
        const have = g.moves[entry.moveNumber];
        if (sameMove(have, { ...payload, moveNumber: entry.moveNumber })) { dropEntry(); continue; }
        refuse(room, `the opponent sent two different moves numbered ${entry.moveNumber}`);
        return;
      }

      const result = await onProver(() => checkOpponentMove(factsOf(g, false), cm, entry.moveNumber, payload, c));
      if (!result.ok) {
        if (result.retryable) {
          // Says nothing about the move: it stays in the inbox, checked again on the next kick or reload.
          setPlayError(`Could not check the opponent's move: ${result.reason}`);
          return;
        }
        refuse(room, `the opponent's move ${entry.moveNumber} was rejected: ${result.reason}`);
        return;
      }
      const link = result.value;
      persistLink(room, g.moves, link);
      const cur = liveRef.current;
      if (cur?.room !== room) return;
      const after = replay({ ...factsOf(cur, false), moves: [...cur.moves, link] });
      setPlayError(null);
      commitLive({ ...cur, moves: [...cur.moves, link], lastCaptures: after.captures });
    }
  }, [persistLink, refuse, commitLive, commitsFor]);

  /** Ready the checks (verification keys) on the prover line, behind whatever is already there. */
  const prepareChecks = useCallback(() => {
    const prepare = checksRef.current.prepare;
    if (prepare) void onProver(prepare).catch(err => console.warn('[useGamePlay] could not prepare the proof checks:', err));
  }, []);

  /** Check whatever the opponent has sent, one item at a time, in order. */
  const kickInbound = useCallback(() => {
    inboundRef.current = inboundRef.current.then(processInbound).catch(err => {
      console.error('[useGamePlay] checking the opponent\'s payloads failed:', err);
    });
  }, [processInbound]);

  // --- Our moves ---

  /**
   * Prove and send our pending moves, in order, once both commitments and our
   * blinding are known. The proof is generated from the boards before and
   * after the move as the transcript has them — the same boards, scores and
   * hashes the opponent will rebuild.
   */
  const drainOwnMoves = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      for (;;) {
        const g = liveRef.current;
        const cm = g ? commitsFor(g.room) : null;
        const blinding = blindingRef.current;
        if (!g || g.pending.length === 0 || !cm || !blinding) return;
        const move = g.pending[0];
        const facts = factsOf(g, false);
        const before = replay(facts).state;
        const after = replay({ ...facts, moves: [...facts.moves, move] }).state;
        const ended = after.status === 'finished';
        setMoveProofStatus('generating');
        let proof: MoveProofData;
        try {
          proof = await proofs.generateMoveProof(
            move.cardId, move.row, move.col, g.role,
            before.board, after.board,
            [before.player1Score, before.player2Score],
            [after.player1Score, after.player2Score],
            cm.commit1, cm.commit2,
            ended, winnerIdOf(ended ? after.winner : null),
            { cardIds: g.ownHand, blindingFactor: blinding },
          );
        } catch (err) {
          // Nothing was sent: take the move back so the player can make it
          // again, rather than leave a card on a board nobody else will see.
          console.error('[useGamePlay] proving our move failed:', err);
          setMoveProofStatus('error');
          setPlayError(`Your move could not be proven (${message(err)}). Play it again.`);
          const cur = liveRef.current;
          if (cur?.room === g.room) commitLive({ ...cur, pending: cur.pending.slice(1), lastCaptures: [] });
          return;
        }
        setMoveProofStatus('ready');
        const link: TranscriptMove = { ...move, proof };
        // Written down BEFORE it is sent: a reload must know every move the
        // relay may have, to settle and to answer ROOM_STATE.
        persistLink(g.room, g.moves, link);
        const cur = liveRef.current;
        if (cur?.room === g.room) commitLive({ ...cur, moves: [...cur.moves, link], pending: cur.pending.slice(1) });
        await sendOwnMove(g.room, link);
        // Anything held for coming after this move can be checked now.
        kickInbound();
      }
    } finally {
      drainingRef.current = false;
    }
  }, [proofs.generateMoveProof, persistLink, sendOwnMove, commitLive, kickInbound, commitsFor]);

  const handlePlaceCard = useCallback(async (handIndex: number, row: number, col: number) => {
    const g = liveRef.current;
    if (!g || g.protocolError) return;
    const facts = factsOf(g);
    let move: GameMove;
    let after: Replayed;
    try {
      move = planOwnMove(facts, replay(facts), handIndex, row, col);
      after = replay({ ...facts, moves: [...facts.moves, move] });
    } catch (err) {
      console.warn('[useGamePlay] move refused:', message(err));
      return;
    }
    setPlayError(null);
    commitLive({ ...g, pending: [...g.pending, move], lastCaptures: after.captures });
    await drainOwnMoves();
  }, [commitLive, drainOwnMoves]);

  /** A MOVE from the relay: kept first (the relay delivers each once), then checked if its game is live. */
  const receiveMove = useCallback((room: string, entry: InboundMove) => {
    const isLive = liveRef.current?.room === room;
    const stored = storageRef.current.readGame(room);
    if (!isLive && !stored) {
      console.warn(`[useGamePlay] a MOVE for room ${room}, which this player has no record of — ignored`);
      return;
    }
    if (!Number.isInteger(entry.moveNumber) || entry.moveNumber < 0 || entry.moveNumber >= TOTAL_MOVES) return;
    const inbox = stored?.inbox ?? [];
    if (!inbox.some(e => e.moveNumber === entry.moveNumber && e.ciphertext === entry.ciphertext)) {
      storageRef.current.mergeGame(room, { inbox: [...inbox, entry] });
    }
    if (isLive) kickInbound();
  }, [kickInbound]);

  /** OPEN_CARDS from the opponent: kept, then checked against their record once it is known. */
  const receiveOpenCards = useCallback((room: string, payload: OpenCardsPayload) => {
    const g = liveRef.current;
    if (g?.room === room && g.opponentOpen) {
      if (!sameCards(g.opponentOpen, payload.cards)) refuse(room, 'the opponent sent a second, different set of open cards');
      return;
    }
    if (g?.room !== room && !storageRef.current.readGame(room)) return;
    storageRef.current.mergeGame(room, { openCardsClaim: { cards: payload.cards, proof: payload.proof, publicInputs: payload.publicInputs } });
    if (g?.room === room) kickInbound();
  }, [kickInbound, refuse]);

  /** MATCH_FOUND: a new game, our committed hand against five face-down cards. */
  const startGame = useCallback((room: string, role: 1 | 2) => {
    if (liveRef.current?.room === room) return;
    const hand = cardIdsRef.current;
    if (hand.length !== 5) {
      console.warn(`[useGamePlay] matched into ${room} without a 5-card hand — not starting a game`);
      return;
    }
    ownOpenSentRef.current = null;
    handledRoomStateRef.current = null;
    setMoveProofStatus('idle');
    setPlayError(null);
    commitLive({ room, role, ownHand: [...hand], moves: [], pending: [], opponentOpen: null, protocolError: null, lastCaptures: [] });
    prepareChecks();
  }, [commitLive, prepareChecks]);

  useEffect(() => {
    return ws.addMessageListener((msg: ServerMessage) => {
      if (msg.type === 'MATCH_FOUND') startGame(msg.gameId, msg.playerNumber);
      else if (msg.type === 'MOVE') receiveMove(msg.gameId, { moveNumber: msg.moveNumber, iv: msg.iv, ciphertext: msg.ciphertext });
    });
  }, [ws.addMessageListener, startGame, receiveMove]);

  useEffect(() => {
    return channel.addPeerListener((payload: PeerPayload, room: string) => {
      if (payload.kind === 'OPEN_CARDS') receiveOpenCards(room, payload);
    });
  }, [channel.addPeerListener, receiveOpenCards]);

  // --- Effects ---

  const liveRoom = live?.room ?? null;
  const liveCommits = commits && liveRoom && (commits.roomId === undefined || commits.roomId === liveRoom) ? commits : null;
  const proofsReady = liveCommits !== null && blindingFactor !== null;

  // Our open cards, once both records are known — before any move queued
  // behind them, so the opponent sees our hand before our first card lands.
  useEffect(() => {
    const g = liveRef.current;
    const cm = g ? commitsFor(g.room) : null;
    const blinding = blindingRef.current;
    if (!g || !cm || !blinding || ownOpenSentRef.current === g.room) return;
    const room = g.room;
    ownOpenSentRef.current = room;
    const stored = storageRef.current.readGame(room)?.ownOpenCards;
    if (stored) { void sendOpenCards(stored); return; }
    const ownCommit = g.role === 1 ? cm.commit1 : cm.commit2;
    proofs.generateOpenCardsProof(g.ownHand, blinding, ownCommit)
      .then(payload => {
        storageRef.current.mergeGame(room, { ownOpenCards: payload });
        if (liveRef.current?.room === room) return sendOpenCards(payload);
      })
      .catch(err => {
        console.error('[useGamePlay] proving our open cards failed:', err);
        if (ownOpenSentRef.current === room) ownOpenSentRef.current = null;
        setPlayError(`Your open cards could not be proven (${message(err)}).`);
      });
    // On the values, not just their presence: a blinding that arrives late
    // (re-derived after a resume) gets another go after a failed proof.
  }, [liveCommits, blindingFactor, liveRoom, proofs.generateOpenCardsProof, sendOpenCards, commitsFor]);

  // Moves made before both commitments were known go out now.
  useEffect(() => {
    if (proofsReady && (live?.pending.length ?? 0) > 0) void drainOwnMoves();
  }, [proofsReady, live?.pending.length, drainOwnMoves]);

  // Anything the opponent sent waits for both commitments (and a live game).
  useEffect(() => {
    if (liveCommits) kickInbound();
  }, [liveCommits, kickInbound]);

  // After a resume the relay says how many moves it holds: ours it is missing
  // never reached it, so they go again (theirs it holds come in its replay).
  useEffect(() => {
    const rs = ws.roomState;
    const g = liveRef.current;
    if (!rs || !g || rs.gameId !== g.room || handledRoomStateRef.current === rs) return;
    handledRoomStateRef.current = rs;
    for (const m of g.moves) {
      if (m.moveNumber >= rs.movesMade && moverOf(m.moveNumber) === g.role) void sendOwnMove(g.room, m);
    }
    if (rs.movesMade > g.moves.length + g.pending.length) {
      console.warn(`[useGamePlay] the relay holds ${rs.movesMade} moves, we have ${g.moves.length} — waiting for the rest`);
    }
    kickInbound();
  }, [ws.roomState, liveRoom, sendOwnMove, kickInbound]);

  // Back online: our open cards again (the other side drops a repeat), and
  // anything that arrived meanwhile.
  const wasConnectedRef = useRef(ws.connected);
  useEffect(() => {
    const was = wasConnectedRef.current;
    wasConnectedRef.current = ws.connected;
    if (was || !ws.connected) return;
    const g = liveRef.current;
    if (!g) return;
    const own = storageRef.current.readGame(g.room)?.ownOpenCards;
    if (own) void sendOpenCards(own);
    kickInbound();
  }, [ws.connected, sendOpenCards, kickInbound]);

  // Resolve the settlement's wait once the transcript is complete.
  const transcriptLength = live?.moves.length ?? 0;
  useEffect(() => {
    if (transcriptLength >= TOTAL_MOVES && movesCompleteRef.current) {
      movesCompleteRef.current();
      movesCompleteRef.current = null;
    }
  }, [transcriptLength]);

  // --- The view ---

  const view = useMemo((): Replayed | null => {
    if (!live) return null;
    try {
      return replay(factsOf(live));
    } catch (err) {
      console.error('[useGamePlay] the game does not replay:', err);
      return null;
    }
  }, [live]);

  const status = view?.state.status;
  const winner = view?.state.winner ?? null;
  const gameOver = useMemo(
    () => (status === 'finished' && winner ? { winner } : null),
    [status, winner],
  );
  const myHandHidden = useMemo(
    () => (view && live ? unplayedSlots(view, live.role).map(slot => !isOpenSlot(slot)) : []),
    [view, live],
  );
  const collectedMoveProofs = useMemo(() => live?.moves.map(m => m.proof) ?? [], [live?.moves]);

  // --- Stable cross-hook accessors ---

  const getMoveProofs = useCallback((): MoveProofData[] => liveRef.current?.moves.map(m => m.proof) ?? [], []);

  const waitForMoveProofs = useCallback((timeoutMs: number): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      if ((liveRef.current?.moves.length ?? 0) >= TOTAL_MOVES) { resolve(); return; }
      movesCompleteRef.current = resolve;
      setTimeout(() => {
        movesCompleteRef.current = null;
        reject(new Error(`Timed out waiting for move proofs: have ${liveRef.current?.moves.length ?? 0}/${TOTAL_MOVES}`));
      }, timeoutMs);
    });
  }, []);

  // --- Facade integration ---

  /** Rebuild the game from its stored transcript (a reload, then Resume). */
  const restoreFromSave = useCallback((saved: PersistedGameState): void => {
    const g: LiveGame = {
      room: saved.gameId,
      role: saved.playerNumber,
      ownHand: [...saved.selectedCardIds],
      moves: [...(saved.moves ?? [])],
      pending: [],
      opponentOpen: saved.opponentOpenCards ? [...saved.opponentOpenCards] : null,
      protocolError: saved.protocolError ?? null,
      lastCaptures: [],
    };
    try {
      replay(factsOf(g));
    } catch (err) {
      // Keep the part that does replay, so there is a board to show this on.
      g.protocolError = `the stored game does not replay (${message(err)})`;
      while (g.moves.length > 0) {
        g.moves = g.moves.slice(0, -1);
        try { replay(factsOf(g)); break; } catch { /* shorter still */ }
      }
    }
    ownOpenSentRef.current = null;
    handledRoomStateRef.current = null;
    setMoveProofStatus('idle');
    setPlayError(null);
    commitLive(g);
    prepareChecks();
    kickInbound();
  }, [commitLive, kickInbound, prepareChecks]);

  const resetForMenu = useCallback((): void => {
    movesCompleteRef.current = null;
    ownOpenSentRef.current = null;
    handledRoomStateRef.current = null;
    setMoveProofStatus('idle');
    setPlayError(null);
    commitLive(null);
    proofs.reset();
  }, [commitLive, proofs.reset]);

  return {
    roomId: live?.room ?? null,
    role: live?.role ?? null,
    gameState: view?.state ?? null,
    lastCaptures: live?.lastCaptures ?? NO_CAPTURES,
    gameOver,
    myHandHidden,
    opponentOpenKnown: !!live?.opponentOpen,
    protocolError: live?.protocolError ?? null,
    playError,
    collectedMoveProofs,
    owedMoveProofs: live?.pending.length ?? 0,
    moveProofStatus,
    // Nine checked moves prove a legal game, whatever arrived after them.
    canSettle: liveCommits !== null && (live?.moves.length ?? 0) >= TOTAL_MOVES,
    handlePlaceCard,
    getMoveProofs,
    waitForMoveProofs,
    restoreFromSave,
    resetForMenu,
  };
}

const NO_CAPTURES: { row: number; col: number }[] = [];
