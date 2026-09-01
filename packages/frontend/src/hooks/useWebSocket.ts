import { useState, useEffect, useRef, useCallback } from 'react';
import type { ClientMessage, ServerMessage, GameState, Player, GameListEntry, HandProofData, MoveProofData, PlaintextNoteData } from '../types';

/**
 * Present-but-idle abandonment warning, as surfaced to the UI. Mirrors the
 * server's GAME_ABANDONMENT_WARNING payload (minus the redundant gameId/type).
 * `idlePlayer` is the player whose turn it is and who has not moved; the OTHER
 * player may claim the game once `secondsUntilClaimable` reaches 0.
 */
export interface AbandonmentWarning {
  idlePlayer: Player;
  secondsIdle: number;
  secondsUntilClaimable: number;
}

const DEFAULT_WS_URL = 'ws://localhost:3001';
const SESSION_TOKEN_KEY = 'aztec_tt_ws_session_token';
const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1000;

export interface UseWebSocketReturn {
  connected: boolean;
  gameId: string | null;
  playerNumber: 1 | 2 | null;
  /** True when the matched opponent is the arena bot (disclosed, never hidden). */
  gameState: GameState | null;
  lastCaptures: { row: number; col: number }[];
  gameList: GameListEntry[];
  error: string | null;
  gameOver: { winner: Player | 'draw' } | null;
  opponentDisconnected: boolean;
  /** Live present-but-idle abandonment warning, or null when none is active. */
  abandonmentWarning: AbandonmentWarning | null;
  opponentHandProof: HandProofData | null;
  lastMoveProof: { moveProof: MoveProofData; handIndex: number; row: number; col: number } | null;
  opponentAztecAddress: string | null;
  opponentOnChainGameId: string | null;
  opponentCardIds: number[];
  // Note relay (offchain settlement delivery)
  incomingNoteData: { txHash: string; notes: PlaintextNoteData[] } | null;
  relayNoteData: (gameId: string, txHash: string, notes: PlaintextNoteData[]) => void;
  // Settlement lifecycle
  opponentSettling: { selectedCardId: number } | null;
  notifySettleStarted: (gameId: string, selectedCardId: number) => void;
  /** Report a mined settle_abandoned_game tx — the server releases both
   *  players' room bindings and replies with a standard GAME_OVER. Send
   *  only AFTER the tx is mined (QA-F3, docs/plan/LANE_4_BACKEND.md). */
  notifyAbandonedGameSettled: (gameId: string) => void;
  // On-chain tx lifecycle
  opponentTxConfirmed: boolean;
  notifyTxConfirmed: (gameId: string, txType: 'create_game' | 'join_game', txHash: string) => void;
  // Matchmaking
  matchmakingStatus: 'idle' | 'queued' | 'matched';
  queuePosition: number | null;
  createGame: (cardIds: number[]) => void;
  joinGame: (gameId: string, cardIds: number[]) => void;
  placeCard: (handIndex: number, row: number, col: number) => void;
  submitHandProof: (gameId: string, handProof: HandProofData) => void;
  submitMoveProof: (gameId: string, handIndex: number, row: number, col: number, moveProof: MoveProofData, moveNumber: number) => void;
  shareAztecInfo: (gameId: string, aztecAddress: string, onChainGameId?: string, gameRandomness?: string[]) => void;
  /** Send at GAME OVER only — earlier would let the opponent brute-force your hand. */
  shareBlinding: (gameId: string, blindingFactor: string) => void;
  opponentGameRandomness: string[] | null;
  /** The opponent's blinding factor, relayed at game over. Settlement cannot
   *  prove their card ids without it. */
  opponentBlinding: string | null;
  /**
   * Identity-stable read of the same value, for settlement callbacks.
   *
   * They capture their dependencies once and run minutes later, so reading the
   * field directly gave them the null it held when the callback was built — and
   * settlement failed on a message that had in fact arrived.
   */
  getOpponentBlinding: () => string | null;
  refreshGameList: () => void;
  leaveGame: () => void;
  disconnect: () => void;
  // Matchmaking actions
  queueMatchmaking: (cardIds: number[]) => void;
  cancelMatchmaking: () => void;
  ping: () => void;
  // Synchronous message listener — invoked in the WebSocket onmessage handler,
  // NOT deferred to a React render cycle. Use for bridging data into refs that
  // async functions (e.g. txManager execute callbacks) read between awaits.
  addMessageListener: (cb: (msg: ServerMessage) => void) => () => void;
}

export function useWebSocket(wsUrl?: string): UseWebSocketReturn {
  const url = wsUrl ?? DEFAULT_WS_URL;
  const messageListenersRef = useRef<Set<(msg: ServerMessage) => void>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const playerNumberRef = useRef<1 | 2 | null>(null);
  /** Mirrors gameId so leaveGame can read it without depending on the state. */
  const gameIdRef = useRef<string | null>(null);
  const intentionalCloseRef = useRef(false);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connected, setConnected] = useState(false);
  const [gameId, setGameId] = useState<string | null>(null);
  const [playerNumber, setPlayerNumber] = useState<1 | 2 | null>(null);
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [lastCaptures, setLastCaptures] = useState<{ row: number; col: number }[]>([]);
  const [gameList, setGameList] = useState<GameListEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [gameOver, setGameOver] = useState<{ winner: Player | 'draw' } | null>(null);
  const [opponentDisconnected, setOpponentDisconnected] = useState(false);
  const [abandonmentWarning, setAbandonmentWarning] = useState<AbandonmentWarning | null>(null);
  const [opponentHandProof, setOpponentHandProof] = useState<HandProofData | null>(null);
  const [lastMoveProof, setLastMoveProof] = useState<{ moveProof: MoveProofData; handIndex: number; row: number; col: number } | null>(null);
  const [opponentAztecAddress, setOpponentAztecAddress] = useState<string | null>(null);
  const [opponentOnChainGameId, setOpponentOnChainGameId] = useState<string | null>(null);
  const [opponentCardIds, setOpponentCardIds] = useState<number[]>([]);
  const [incomingNoteData, setIncomingNoteData] = useState<{ txHash: string; notes: PlaintextNoteData[] } | null>(null);
  const [opponentSettling, setOpponentSettling] = useState<{ selectedCardId: number } | null>(null);
  const [opponentGameRandomness, setOpponentGameRandomness] = useState<string[] | null>(null);
  const [opponentBlinding, setOpponentBlinding] = useState<string | null>(null);
  const opponentBlindingRef = useRef<string | null>(null);
  opponentBlindingRef.current = opponentBlinding;
  const getOpponentBlinding = useCallback((): string | null => opponentBlindingRef.current, []);
  const [opponentTxConfirmed, setOpponentTxConfirmed] = useState(false);
  const [matchmakingStatus, setMatchmakingStatus] = useState<'idle' | 'queued' | 'matched'>('idle');
  const [queuePosition, setQueuePosition] = useState<number | null>(null);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return; // Already connected or connecting
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send RESUME if we have a session token
      const sessionToken = localStorage.getItem(SESSION_TOKEN_KEY);
      if (sessionToken) {
        ws.send(JSON.stringify({ type: 'RESUME', sessionToken }));
      }
      // Don't set connected=true yet — wait for SESSION_ESTABLISHED
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;

      // Auto-reconnect unless intentionally closed
      if (!intentionalCloseRef.current) {
        const delay = reconnectDelayRef.current;
        reconnectDelayRef.current = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
      }
    };

    ws.onerror = () => {
      setError('Connection failed');
      // onclose will fire after onerror, triggering reconnect
    };

    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data) as ServerMessage;
      } catch {
        console.warn('[useWebSocket] Received malformed JSON, ignoring:', event.data);
        return;
      }
      switch (msg.type) {
        case 'SESSION_ESTABLISHED': {
          const se = msg as { sessionToken: string; playerId: string; resumed: boolean; gameId: string | null };
          localStorage.setItem(SESSION_TOKEN_KEY, se.sessionToken);
          setConnected(true);
          setError(null);
          // Reset reconnect backoff on successful connection
          reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
          // If resumed into a game, restore context
          if (se.resumed && se.gameId) {
            setGameId(se.gameId);
          }
          break;
        }
        case 'OPPONENT_RECONNECTED':
          setOpponentDisconnected(false);
          break;
        case 'GAME_CREATED':
          setGameId(msg.gameId);
          setPlayerNumber(msg.playerNumber);
          playerNumberRef.current = msg.playerNumber;
          setError(null);
          break;
        case 'GAME_JOINED':
          setGameId(msg.gameId);
          setPlayerNumber(msg.playerNumber);
          playerNumberRef.current = msg.playerNumber;
          setGameState(msg.gameState);
          setError(null);
          break;
        case 'GAME_START':
          setGameState(msg.gameState);
          break;
        case 'GAME_STATE':
          setGameState(msg.gameState);
          setLastCaptures(msg.captures);
          // A board update means someone moved — the idle clock resets.
          setAbandonmentWarning(null);
          break;
        case 'GAME_OVER':
          setGameState(msg.gameState);
          setGameOver({ winner: msg.winner });
          // Game ended — no further abandonment warning applies.
          setAbandonmentWarning(null);
          if (playerNumberRef.current) {
            const oppIds = playerNumberRef.current === 1 ? msg.player2CardIds : msg.player1CardIds;
            if (oppIds && oppIds.length > 0) setOpponentCardIds(oppIds);
          }
          break;
        case 'GAME_LIST':
          setGameList(msg.games);
          break;
        case 'OPPONENT_DISCONNECTED':
          setOpponentDisconnected(true);
          break;
        case 'GAME_ABANDONMENT_WARNING':
          setAbandonmentWarning({
            idlePlayer: msg.idlePlayer,
            secondsIdle: msg.secondsIdle,
            secondsUntilClaimable: msg.secondsUntilClaimable,
          });
          // The claimant (the NON-idle player) needs the abandoner's committed
          // hand to claim a card on-chain. Card ids are otherwise exchanged only
          // at GAME_OVER, which an abandonment never reaches — so adopt the idle
          // player's ids here. (Guarded so the idle player never overwrites its
          // own opponentCardIds with its own hand.)
          if (playerNumberRef.current && msg.idlePlayerCardIds?.length) {
            const myPlayer: Player = playerNumberRef.current === 1 ? 'player1' : 'player2';
            if (msg.idlePlayer !== myPlayer) setOpponentCardIds(msg.idlePlayerCardIds);
          }
          break;
        case 'HAND_PROOF':
          setOpponentHandProof(msg.handProof);
          break;
        case 'MOVE_PROVEN':
          setGameState(msg.gameState);
          setLastCaptures(msg.captures);
          // The opponent proved a move — the idle clock resets.
          setAbandonmentWarning(null);
          setLastMoveProof({
            moveProof: msg.moveProof,
            handIndex: msg.handIndex,
            row: msg.row,
            col: msg.col,
          });
          break;
        case 'OPPONENT_BLINDING':
          setOpponentBlinding(msg.blindingFactor);
          break;
        case 'OPPONENT_AZTEC_INFO':
          setOpponentAztecAddress(msg.aztecAddress);
          if (msg.onChainGameId) setOpponentOnChainGameId(msg.onChainGameId);
          if (msg.gameRandomness) setOpponentGameRandomness(msg.gameRandomness);
          break;
        case 'NOTE_DATA':
          setIncomingNoteData({ txHash: msg.txHash, notes: msg.notes });
          break;
        case 'OPPONENT_SETTLING':
          setOpponentSettling({ selectedCardId: msg.selectedCardId });
          break;
        case 'ON_CHAIN_STATUS': {
          const s = msg.status;
          const myRole = playerNumberRef.current;
          if (myRole === 2 && s.player1Tx === 'confirmed') {
            setOpponentTxConfirmed(true);
          } else if (myRole === 1 && s.player2Tx === 'confirmed') {
            setOpponentTxConfirmed(true);
          }
          break;
        }
        case 'MATCHMAKING_QUEUED':
          setMatchmakingStatus('queued');
          setQueuePosition(msg.position);
          break;
        case 'MATCH_FOUND':
          setMatchmakingStatus('matched');
          setQueuePosition(null);
          setGameId(msg.gameId);
          setPlayerNumber(msg.playerNumber);
          playerNumberRef.current = msg.playerNumber;
          setGameState(msg.gameState);
          // Disclosure: the server tells us when the opponent is the arena bot.
          // Defaults to false so a server that does not send it reads as human.
          setError(null);
          break;
        case 'MATCHMAKING_CANCELLED':
          setMatchmakingStatus('idle');
          setQueuePosition(null);
          break;
        case 'PONG':
          break;
        case 'ERROR':
          setError(msg.message);
          break;
      }
      // Invoke synchronous listeners (runs in the same event loop tick)
      for (const cb of messageListenersRef.current) cb(msg);
    };
  }, [url]);

  useEffect(() => {
    let cancelled = false;

    // Delay connection slightly to survive React StrictMode's
    // mount → unmount → remount cycle without wasting a connection.
    const timer = setTimeout(() => {
      if (cancelled) return;
      intentionalCloseRef.current = false;
      connect();
    }, 50);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      }
      wsRef.current = null;
    };
  }, [connect]);

  const createGame = useCallback((cardIds: number[]) => {
    setError(null);
    setGameOver(null);
    setOpponentDisconnected(false);
    setAbandonmentWarning(null);
    send({ type: 'CREATE_GAME', cardIds });
  }, [send]);

  const joinGame = useCallback((id: string, cardIds: number[]) => {
    setError(null);
    setGameOver(null);
    setOpponentDisconnected(false);
    setAbandonmentWarning(null);
    send({ type: 'JOIN_GAME', gameId: id, cardIds });
  }, [send]);

  const placeCard = useCallback((handIndex: number, row: number, col: number) => {
    if (!gameId) return;
    setError(null);
    // Derive global move number from board state (count occupied cells).
    // Server's expectedMoveNumber is a global counter for ALL moves (both players),
    // so each client must send the total move count, not a per-player count.
    let moveNumber = 0;
    if (gameState) {
      for (const row of gameState.board) {
        for (const cell of row) {
          if (cell.card !== null) moveNumber++;
        }
      }
    }
    send({ type: 'PLACE_CARD', gameId, handIndex, row, col, moveNumber });
  }, [send, gameId, gameState]);

  const refreshGameList = useCallback(() => {
    send({ type: 'LIST_GAMES' });
  }, [send]);

  const submitHandProof = useCallback((gId: string, handProof: HandProofData) => {
    setError(null);
    send({ type: 'SUBMIT_HAND_PROOF', gameId: gId, handProof });
  }, [send]);

  const shareAztecInfo = useCallback((gId: string, aztecAddress: string, onChainGameId?: string, gameRandomness?: string[]) => {
    send({ type: 'SHARE_AZTEC_INFO', gameId: gId, aztecAddress, onChainGameId, gameRandomness });
  }, [send]);

  const shareBlinding = useCallback((gId: string, blindingFactor: string) => {
    send({ type: 'SHARE_BLINDING', gameId: gId, blindingFactor });
  }, [send]);

  const submitMoveProof = useCallback((gId: string, handIndex: number, row: number, col: number, moveProof: MoveProofData, moveNumber: number) => {
    if (!gId) return;
    setError(null);
    send({ type: 'SUBMIT_MOVE_PROOF', gameId: gId, handIndex, row, col, moveNumber, moveProof });
  }, [send]);

  const relayNoteData = useCallback((gId: string, txHash: string, notes: PlaintextNoteData[]) => {
    send({ type: 'RELAY_NOTE_DATA', gameId: gId, txHash, notes });
  }, [send]);

  const notifySettleStarted = useCallback((gId: string, selectedCardId: number) => {
    send({ type: 'SETTLE_STARTED', gameId: gId, selectedCardId });
  }, [send]);

  const notifyAbandonedGameSettled = useCallback((gId: string) => {
    send({ type: 'ABANDONED_GAME_SETTLED', gameId: gId });
  }, [send]);

  const notifyTxConfirmed = useCallback((gId: string, txType: 'create_game' | 'join_game', txHash: string) => {
    send({ type: 'TX_CONFIRMED', gameId: gId, txType, txHash });
  }, [send]);

  const queueMatchmaking = useCallback((cardIds: number[]) => {
    setError(null);
    setGameOver(null);
    setOpponentDisconnected(false);
    setMatchmakingStatus('idle');
    setAbandonmentWarning(null);
    send({ type: 'QUEUE_MATCHMAKING', cardIds });
  }, [send]);

  const cancelMatchmaking = useCallback(() => {
    send({ type: 'CANCEL_MATCHMAKING' });
    setMatchmakingStatus('idle');
    setQueuePosition(null);
  }, [send]);

  const ping = useCallback(() => {
    send({ type: 'PING' });
  }, [send]);

  const addMessageListener = useCallback((cb: (msg: ServerMessage) => void) => {
    messageListenersRef.current.add(cb);
    return () => { messageListenersRef.current.delete(cb); };
  }, []);

  useEffect(() => { gameIdRef.current = gameId; }, [gameId]);

  /**
   * Reset all game-related state but keep the WebSocket connection open.
   *
   * Tells the relay too. It releases both players at GAME OVER, but a game
   * left before that — abandoned, or walked away from — keeps its binding
   * until the stale-game sweep, and every queue attempt until then is refused
   * with "You are already in an active game". The bot spent 22 minutes and 578
   * attempts in exactly that state; a player would simply be unable to start
   * another game. Only the sender is released — the game itself stays, because
   * its committed cards still need the abandonment claim.
   */
  const leaveGame = useCallback(() => {
    const leaving = gameIdRef.current;
    if (leaving) send({ type: 'LEAVE_GAME', gameId: leaving });
    setGameId(null);
    setPlayerNumber(null);
    setGameState(null);
    setLastCaptures([]);
    setGameOver(null);
    setError(null);
    setOpponentDisconnected(false);
    setAbandonmentWarning(null);
    setOpponentHandProof(null);
    setLastMoveProof(null);
    setOpponentAztecAddress(null);
    setOpponentOnChainGameId(null);
    setOpponentCardIds([]);
    setIncomingNoteData(null);
    setOpponentSettling(null);
    setOpponentGameRandomness(null);
    setOpponentTxConfirmed(false);
    setMatchmakingStatus('idle');
    setQueuePosition(null);
    playerNumberRef.current = null;
  }, []);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    localStorage.removeItem(SESSION_TOKEN_KEY);
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    wsRef.current?.close();
    leaveGame();
  }, [leaveGame]);

  return {
    connected,
    gameId,
    playerNumber,
    gameState,
    lastCaptures,
    gameList,
    error,
    gameOver,
    opponentDisconnected,
    abandonmentWarning,
    opponentHandProof,
    lastMoveProof,
    opponentAztecAddress,
    opponentOnChainGameId,
    opponentCardIds,
    incomingNoteData,
    opponentSettling,
    notifySettleStarted,
    notifyAbandonedGameSettled,
    opponentGameRandomness,
    opponentBlinding,
    getOpponentBlinding,
    opponentTxConfirmed,
    relayNoteData,
    notifyTxConfirmed,
    matchmakingStatus,
    queuePosition,
    createGame,
    joinGame,
    placeCard,
    submitHandProof,
    submitMoveProof,
    shareAztecInfo,
    shareBlinding,
    refreshGameList,
    leaveGame,
    disconnect,
    queueMatchmaking,
    cancelMatchmaking,
    ping,
    addMessageListener,
  };
}
