import { useState, useEffect, useRef, useCallback } from 'react';
import type { ClientMessage, ServerMessage, Player, RoomState, SealedPeerMessage } from '../types';

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
  /** The relay room this player is in (MATCH_FOUND, or ROOM_STATE after a resume). */
  gameId: string | null;
  playerNumber: 1 | 2 | null;
  error: string | null;
  opponentDisconnected: boolean;
  /** Live present-but-idle abandonment warning, or null when none is active. */
  abandonmentWarning: AbandonmentWarning | null;
  /**
   * The relay's account of the room after a RESUME: how many moves it has
   * accepted. A new object per ROOM_STATE, so a consumer can act once per message.
   */
  roomState: RoomState | null;
  // On-chain tx lifecycle. No tx hash: the relay must not find the game's txs.
  opponentTxConfirmed: boolean;
  notifyTxConfirmed: (gameId: string, txType: 'create_game' | 'join_game') => void;
  /** Our half of the per-game key exchange: only the public key. */
  sendKeyExchange: (gameId: string, publicKey: string) => void;
  /** A player-to-player payload, already sealed with the channel key. */
  sendPeer: (gameId: string, sealed: SealedPeerMessage) => void;
  /** A move, already sealed: the relay sees its number and nothing else. */
  sendMove: (gameId: string, moveNumber: number, sealed: SealedPeerMessage) => void;
  // Matchmaking
  matchmakingStatus: 'idle' | 'queued' | 'matched';
  queuePosition: number | null;
  leaveGame: () => void;
  disconnect: () => void;
  /** Join the queue. No card ids: the relay never learns a hand. */
  queueMatchmaking: () => void;
  cancelMatchmaking: () => void;
  ping: () => void;
  // Synchronous message listener — invoked in the WebSocket onmessage handler,
  // NOT deferred to a React render cycle. Use for bridging data into refs that
  // async functions (e.g. txManager execute callbacks) read between awaits.
  // OPPONENT_KEY, PEER and MOVE reach the app only this way (useGameChannel,
  // useGamePlay): they are sealed, and no React state here holds them.
  addMessageListener: (cb: (msg: ServerMessage) => void) => () => void;
}

/**
 * The relay connection (docs/plan/PRIVATE_GAMES.md section 6).
 *
 * The relay runs no game: it pairs players, keeps rooms, buffers sealed
 * traffic for whoever is offline and times turns. Everything about the game
 * itself — the board, the hands, the result — lives in the client
 * (useGamePlay), built from moves this hook only forwards.
 */
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
  const [error, setError] = useState<string | null>(null);
  const [opponentDisconnected, setOpponentDisconnected] = useState(false);
  const [abandonmentWarning, setAbandonmentWarning] = useState<AbandonmentWarning | null>(null);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [opponentTxConfirmed, setOpponentTxConfirmed] = useState(false);
  const [matchmakingStatus, setMatchmakingStatus] = useState<'idle' | 'queued' | 'matched'>('idle');
  const [queuePosition, setQueuePosition] = useState<number | null>(null);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const enterRoom = useCallback((id: string, n: 1 | 2) => {
    setGameId(id);
    gameIdRef.current = id;
    setPlayerNumber(n);
    playerNumberRef.current = n;
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
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'SESSION_ESTABLISHED': {
          localStorage.setItem(SESSION_TOKEN_KEY, msg.sessionToken);
          setConnected(true);
          setError(null);
          // Reset reconnect backoff on successful connection
          reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
          // If resumed into a game, restore context (ROOM_STATE follows)
          if (msg.resumed && msg.gameId) {
            setGameId(msg.gameId);
            gameIdRef.current = msg.gameId;
          }
          break;
        }
        case 'ROOM_STATE':
          enterRoom(msg.gameId, msg.playerNumber);
          setOpponentDisconnected(!msg.opponentConnected);
          setRoomState({
            gameId: msg.gameId,
            playerNumber: msg.playerNumber,
            movesMade: msg.movesMade,
            opponentConnected: msg.opponentConnected,
          });
          break;
        case 'OPPONENT_RECONNECTED':
          setOpponentDisconnected(false);
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
          break;
        case 'MOVE':
          // The opponent moved: the idle clock restarts. The move itself is
          // sealed; useGamePlay opens, checks and applies it.
          setAbandonmentWarning(null);
          break;
        case 'OPPONENT_KEY':
        case 'PEER':
          // Handled by the game channel's listener (useGameChannel): the
          // payloads are sealed, and only it holds the keys.
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
          enterRoom(msg.gameId, msg.playerNumber);
          setRoomState(null);
          setOpponentDisconnected(false);
          setAbandonmentWarning(null);
          setOpponentTxConfirmed(false);
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
  }, [url, enterRoom]);

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

  const notifyTxConfirmed = useCallback((gId: string, txType: 'create_game' | 'join_game') => {
    send({ type: 'TX_CONFIRMED', gameId: gId, txType });
  }, [send]);

  const sendKeyExchange = useCallback((gId: string, publicKey: string) => {
    send({ type: 'KEY_EXCHANGE', gameId: gId, publicKey });
  }, [send]);

  const sendPeer = useCallback((gId: string, sealed: SealedPeerMessage) => {
    send({ type: 'PEER', gameId: gId, iv: sealed.iv, ciphertext: sealed.ciphertext });
  }, [send]);

  const sendMove = useCallback((gId: string, moveNumber: number, sealed: SealedPeerMessage) => {
    // We moved: whatever idle warning stood was about us, and is over.
    setAbandonmentWarning(null);
    send({ type: 'MOVE', gameId: gId, moveNumber, iv: sealed.iv, ciphertext: sealed.ciphertext });
  }, [send]);

  const queueMatchmaking = useCallback(() => {
    setError(null);
    setOpponentDisconnected(false);
    setMatchmakingStatus('idle');
    setAbandonmentWarning(null);
    send({ type: 'QUEUE_MATCHMAKING' });
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
   * Tells the relay too: a game left before its end keeps the player bound
   * until the stale-game sweep, and every queue attempt until then is refused
   * with "You are already in an active game". The bot spent 22 minutes and 578
   * attempts in exactly that state; a player would simply be unable to start
   * another game. Only the sender is released — the game itself stays, because
   * its committed cards may still need the abandonment claim.
   */
  const leaveGame = useCallback(() => {
    const leaving = gameIdRef.current;
    if (leaving) send({ type: 'LEAVE_GAME', gameId: leaving });
    setGameId(null);
    gameIdRef.current = null;
    setPlayerNumber(null);
    setError(null);
    setOpponentDisconnected(false);
    setAbandonmentWarning(null);
    setRoomState(null);
    setOpponentTxConfirmed(false);
    setMatchmakingStatus('idle');
    setQueuePosition(null);
    playerNumberRef.current = null;
  }, [send]);

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
    error,
    opponentDisconnected,
    abandonmentWarning,
    roomState,
    opponentTxConfirmed,
    notifyTxConfirmed,
    sendKeyExchange,
    sendPeer,
    sendMove,
    matchmakingStatus,
    queuePosition,
    leaveGame,
    disconnect,
    queueMatchmaking,
    cancelMatchmaking,
    ping,
    addMessageListener,
  };
}
